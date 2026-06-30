/**
 * voice-orchestrator.ts
 *
 * The central event‑driven engine that processes live audio frames,
 * coordinates ASR → LLM → TTS streaming, enforces barge‑in, and
 * delegates durable transactions to Temporal.
 *
 * Architecture notes:
 * - Uses an internal state machine (IVRSessionState) to decide
 *   whether to process new audio or cancel playback.
 * - Barge‑in is implemented via AbortController: when VAD detects
 *   speech during playback, the controller is aborted, causing all
 *   in‑flight async iterators (LLM, TTS) to throw/cancel immediately.
 * - Language switching is gated by confidence scores; switching only
 *   occurs when the alternative language’s confidence exceeds a high
 *   threshold to avoid flapping.
 * - The Temporal boundary is a fire‑and‑forget call to the provided
 *   TemporalTrigger; the orchestrator does not block on banking
 *   execution.
 */

import { EventEmitter } from 'events';
import type {
  AudioFrame,
  AsrTranscript,
  ConversationContext,
  SignedIdentityContext,
  LanguageCode,
  ExtractedIntent,
  TemporalTrigger,
  StreamingASRClient,
  IVRSessionState,
  LlmStreamToken,
} from './ivr-types.js';
import { LANGUAGE_SWITCH_CONFIDENCE_THRESHOLD } from './ivr-types.js';

// ---------------------------------------------------------------------------
// Helper: Simple VAD using RMS energy (for demonstration)
// ---------------------------------------------------------------------------

/**
 * Emits `speechStart` when audio energy crosses a threshold,
 * and `speechEnd` after a configurable silence duration.
 */
class EnergyVAD extends EventEmitter {
  private readonly energyThreshold: number;
  private readonly silenceFrames: number;
  private frameCount: number = 0;
  private speechActive: boolean = false;

  constructor(energyThreshold = 1000, silenceFrames = 15) {
    super();
    this.energyThreshold = energyThreshold;
    this.silenceFrames = silenceFrames;
  }

  /** Process a single audio frame. */
  processFrame(frame: AudioFrame): void {
    const energy = this.calculateRMS(frame.data);
    if (energy > this.energyThreshold && !this.speechActive) {
      this.speechActive = true;
      this.frameCount = 0;
      this.emit('speechStart');
    } else if (energy <= this.energyThreshold && this.speechActive) {
      this.frameCount++;
      if (this.frameCount > this.silenceFrames) {
        this.speechActive = false;
        this.frameCount = 0;
        this.emit('speechEnd');
      }
    }
  }

  private calculateRMS(data: Uint8Array): number {
    // Assumes 16-bit PCM stored as little-endian bytes
    let sum = 0;
    for (let i = 0; i < data.length - 1; i += 2) {
      const sample = (data[i + 1] << 8) | data[i];
      sum += sample * sample;
    }
    return Math.sqrt(sum / (data.length / 2));
  }
}

// ---------------------------------------------------------------------------
// VoiceOrchestrator
// ---------------------------------------------------------------------------

export class VoiceOrchestrator {
  private state: IVRSessionState = <IVRSessionState>'IDLE';
  private context: ConversationContext;
  private abortController: AbortController | null = null;
  private vad: EnergyVAD;
  private asrClient: StreamingASRClient;
  private temporalTrigger: TemporalTrigger;
  private sessionId: string;
  // Safely hold reference to the active, live engine stream
  private activeRecognition: ReturnType<StreamingASRClient['startRecognition']> | null = null;

  constructor(
    identity: SignedIdentityContext,
    sessionId: string,
    asrClient: StreamingASRClient,
    temporalTrigger: TemporalTrigger
  ) {
    this.sessionId = sessionId;
    this.temporalTrigger = temporalTrigger;
    this.asrClient = asrClient;
    this.vad = new EnergyVAD();
    this.context = {
      activeLanguage: 'uz-UZ',               // default to Uzbek
      languageConfidence: { 'uz-UZ': 1.0, 'ru-RU': 0.0 },
      history: [],
      identity,
    };

    this.setupVADListeners();
  }

  /**
   * Primary entry point: continuously consumes audio frames from the source
   * and manages the entire IVR lifecycle.  Returns when the call ends.
   */
  async startCall(audioStream: AsyncIterable<AudioFrame>): Promise<void> {
    this.state = <IVRSessionState>'IDLE';
    console.log(`[Orchestrator] Session ${this.sessionId} started`);

    try {
      for await (const frame of audioStream) {
        this.vad.processFrame(frame);

        // Only feed audio to ASR when we are actively listening or idle
        if (this.state === 'IDLE' || this.state === 'LISTENING_TO_USER') {
          if (this.activeRecognition) {
            this.activeRecognition.sendAudio(frame);
          }
        }
      }
    } catch (err) {
      console.error('Audio stream error:', err);
    } finally {
      this.state = <IVRSessionState>'TERMINATED';
    }
  }

  // -----------------------------------------------------------------------
  // VAD event handlers: core barge‑in logic
  // -----------------------------------------------------------------------

  private setupVADListeners(): void {
    this.vad.on('speechStart', () => {
      if (this.state === 'SPEAKING_TO_USER') {
        // Barge‑in: user started talking while the bot was speaking.
        console.log('[Orchestrator] Barge-in detected – cancelling playback');
        this.cancelPlayback();
        this.state = <IVRSessionState>'LISTENING_TO_USER';
        // Immediately start a new recognition session for the interrupting speech.
        this.listenForSpeech();
      } else if (this.state === 'IDLE') {
        this.state = <IVRSessionState>'LISTENING_TO_USER';
        this.listenForSpeech();
      }
    });

    this.vad.on('speechEnd', () => {
      // No special action – ASR finalisation will handle the transition.
    });
  }

  private cancelPlayback(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  // -----------------------------------------------------------------------
  // Speech recognition & language switching
  // -----------------------------------------------------------------------

  /**
   * Starts an ASR recognition cycle, processes transcripts,
   * and triggers LLM + TTS when a final utterance is received.
   */
  private async listenForSpeech(): Promise<void> {
    const abortController = new AbortController();
    this.abortController = abortController;
    const { signal } = abortController;

    const recognition = this.asrClient.startRecognition(
      this.context.activeLanguage,
      () => this.vad.emit('speechStart'),   // forward to VAD if needed
      () => this.vad.emit('speechEnd')
    );

    try {
      for await (const transcript of recognition.transcriptIterable) {
        if (signal.aborted) break;

        // --- Language switching logic ---
        this.updateLanguageConfidence(transcript);

        if (transcript.isFinal) {
          this.state = <IVRSessionState>'IDLE';  // processing the utterance
          this.handleFinalTranscript(transcript, signal);
          return; // one utterance per listen cycle
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        console.error('ASR stream error:', err);
      }}
    finally {
      recognition.close();
      this.activeRecognition = null;
      this.abortController = null;
    }
  }

  private updateLanguageConfidence(transcript: AsrTranscript): void {
    if (transcript.language) {
      const current = this.context.languageConfidence;
      current[transcript.language] =
        Math.max(current[transcript.language], transcript.confidence);
      const otherLang: LanguageCode =
        transcript.language === 'uz-UZ' ? 'ru-RU' : 'uz-UZ';
      if (
        current[otherLang] >= LANGUAGE_SWITCH_CONFIDENCE_THRESHOLD &&
        this.context.activeLanguage !== otherLang
      ) {
        console.log(`[Orchestrator] Language switched to ${otherLang}`);
        this.context.activeLanguage = otherLang;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Intent extraction, LLM/TTS streaming, and Temporal dispatch
  // -----------------------------------------------------------------------

  private async handleFinalTranscript(
    transcript: AsrTranscript,
    signal: AbortSignal
  ): Promise<void> {
    const userText = transcript.text;
    this.addUtterance('user', userText, transcript.language ?? this.context.activeLanguage);

    // --- Detect banking intent (simplified regex for demonstration) ---
    const intent = this.extractIntent(userText);

    if (intent) {
      this.context.pendingIntent = intent;

     // --- Decoupled Temporal execution ---
      this.state = <IVRSessionState>'DISPATCHING_TRUNK';
      try {
        const result = await this.temporalTrigger.executeTransaction({
          intent,
          identity: this.context.identity,
          callSessionId: this.sessionId,
        });

        // Play the dynamic response generated by the Core Temporal Worker
        await this.speakResponse(result.ttsMessageToPlay, signal);
      } catch (err) {
        console.error('Temporal trigger failed:', err);
        await this.speakResponse('Kechirasiz, xatolik yuz berdi. (Sorry, an error occurred.)', signal);
      }
    } else {
      // General conversation: stream through LLM
      const llmTokens = this.generateLLMResponse(userText, signal);
      await this.streamLLMToTTS(llmTokens, signal);
    }
  }

  /**
   * Simple intent extraction using keywords.
   * In production this would call a dedicated NLU microservice.
   */
  private extractIntent(text: string): ExtractedIntent | null {
    const lower = text.toLowerCase();
    if (lower.includes('pay') || lower.includes('to\'lov') || lower.includes('платеж')) {
      return {
        intentName: 'PAY_BILL',
        entities: { amount: '100000', biller: 'COMMUNAL' },
        confidence: 0.95,
        rawText: text,
      };
    }
    if (lower.includes('transfer') || lower.includes('o\'tkaz') || lower.includes('перевод')) {
      return {
        intentName: 'P2P_TRANSFER',
        entities: { amount: '50000', target: '998901234567' },
        confidence: 0.9,
        rawText: text,
      };
    }
    return null;
  }

  private addUtterance(role: 'user' | 'bot', text: string, language: LanguageCode): void {
    this.context.history.push({
      role,
      text,
      language,
      timestamp: Date.now(),
    });
  }

  // -----------------------------------------------------------------------
  // LLM → TTS streaming with barge‑in awareness
  // -----------------------------------------------------------------------

  /**
   * Simulates streaming LLM token generation.
   * Each token is emitted after a short delay; if the signal is aborted,
   * the generator stops immediately.
   */
  private async *generateLLMResponse(
    prompt: string,
    signal: AbortSignal
  ): AsyncGenerator<LlmStreamToken, void, undefined> {
    // Mock response: a series of tokens
    const words = ['Assalomu', ' alaykum', ' qanday', ' yordam', ' bera', ' olaman?'];
    for (const word of words) {
      if (signal.aborted) {
        console.log('[LLM] Aborted mid‑generation');
        return;
      }
      await sleep(50); // simulate compute
      yield { token: word };
    }
  }

  /**
   * Feeds LLM tokens into TTS and begins playback.
   * If the abort signal is triggered, playback stops.
   */
  private async streamLLMToTTS(
    tokenStream: AsyncGenerator<LlmStreamToken, void, undefined>,
    signal: AbortSignal
  ): Promise<void> {
    this.state = <IVRSessionState>'SPEAKING_TO_USER';
    console.log('[Orchestrator] Starting TTS playback');

    try {
      // In reality, we would push each token to a streaming TTS engine
      // and play back the resulting audio frames.
      for await (const token of tokenStream) {
        if (signal.aborted) {
          console.log('[TTS] Playback cancelled');
          break;
        }
        // Simulate audio output
        this.addUtterance('bot', token.token, this.context.activeLanguage);
        await sleep(30); // simulate playback time
      }
    } catch (err) {
      if (!signal.aborted) console.error('TTS stream error:', err);
    } finally {
      this.state = <IVRSessionState>'IDLE';
    }
  }

  /**
   * Synthesises a static response (no streaming) and plays it.
   */
  private async speakResponse(text: string, signal: AbortSignal): Promise<void> {
    this.state = <IVRSessionState>'SPEAKING_TO_USER';
    this.addUtterance('bot', text, this.context.activeLanguage);
    console.log('[Orchestrator] Speaking:', text);
    // Simulate audio duration
    await sleep(1000);
    if (signal.aborted) {
      console.log('[Orchestrator] Response interrupted');
    }
    this.state = <IVRSessionState>'IDLE';
  }
}

// Utility: promisified setTimeout
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}