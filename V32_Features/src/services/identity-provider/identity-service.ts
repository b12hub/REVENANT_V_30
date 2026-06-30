// identity-service.ts
//
// The Hot Path. Synchronous, low-latency, no Temporal involvement at all —
// this is the service a VLAN calls directly (P2P before disbursement,
// Credit before signature acceptance, anything gated by BiometricSecurityLevel)
// and needs an answer in milliseconds, not after a durable workflow's
// suspend/resume cycle. That's the architectural line between this file
// and enrollment-workflow.ts: enrollment can durably wait minutes for a
// customer to record three samples; verification cannot durably wait at
// all — the caller is blocked on this returning.

import { createHmac, randomUUID } from 'node:crypto';
import {
  LIVENESS_REJECTION_FLOOR,
  SIMILARITY_THRESHOLD_BY_LEVEL,
  type VectorEmbedding,
  type VoiceVerificationRequest,
  type VoiceVerificationResponse,
  type SignedIdentityContext,
  type BiometricSecurityLevel,
} from './biometric-types.js';

// ---------------------------------------------------------------------------
// Injected dependencies — interfaces only, real implementations swapped in
// later. Same DI-for-testability discipline as every other VLAN in this
// build: VoiceIdentityProvider depends on these shapes, never on a
// concrete ML model or database client directly.
// ---------------------------------------------------------------------------

export interface EmbeddingExtractor {
  extractEmbedding(audioFrame: Buffer): Promise<VectorEmbedding>;
}

export interface LivenessDetector {
  /**
   * Returns a confidence score in [0, 1] that this audio is a live human
   * speaking in real time — NOT a replay of a recording, and not a
   * text-to-speech or voice-conversion synthesis of the target's voice.
   * This is a fundamentally different signal from voiceprint similarity:
   * a well-executed clone is SPECIFICALLY engineered to score high on
   * similarity (that's the entire point of cloning a target's voice) — it
   * provides no defense on its own. Liveness detection instead targets
   * artifacts similarity can't see: vocoder spectral fingerprints,
   * unnaturally low micro-variation between phonemes, channel degradation
   * patterns consistent with a replayed recording rather than a live mic
   * capture. Keeping these as two SEPARATE sequential gates — rather than
   * blending them into one weighted score — matters specifically because a
   * combined score would let a very high similarity (a good clone) and a
   * mediocre liveness score numerically average out to a passing result.
   * A hard liveness veto, evaluated independently and first, prevents that
   * kind of score laundering.
   */
  scoreLiveness(audioFrame: Buffer): Promise<number>;
}

export interface EnrolledVoiceprintStore {
  /** Returns null if this customer has never completed enrollment — see NoEnrolledVoiceprint in biometric-types.ts. */
  getEnrolledVoiceprint(customerId: string): Promise<VectorEmbedding | null>;
}

export interface VoiceIdentityProviderDependencies {
  readonly embeddingExtractor: EmbeddingExtractor;
  readonly livenessDetector: LivenessDetector;
  readonly voiceprintStore: EnrolledVoiceprintStore;
  /** Pre-encoded once at service startup from a Vault-resolved secret, same rationale as every other signing key in this build. */
  readonly identityContextSigningKey: Uint8Array;
}

// ---------------------------------------------------------------------------
// Mock implementations — runnable out of the box, clearly labeled as mocks,
// swappable behind the interfaces above with zero change to
// VoiceIdentityProvider itself.
// ---------------------------------------------------------------------------

export class MockEmbeddingExtractor implements EmbeddingExtractor {
  async extractEmbedding(audioFrame: Buffer): Promise<VectorEmbedding> {
    // Deterministic-from-input mock, not random — a real model is
    // deterministic given the same audio, and a mock that varies run-to-run
    // for the same input would make this class's own behavior harder to
    // reason about during integration testing of the CALLER, not just of
    // this mock. Derives 256 pseudo-dimensions from a simple rolling hash
    // of the audio bytes — not a real embedding space, just stable.
    const DIMENSIONS = 256;
    const vector = new Float32Array(DIMENSIONS);
    let seed = audioFrame.length === 0 ? 1 : audioFrame.length;
    for (let i = 0; i < audioFrame.length; i++) {
      seed = (seed * 31 + audioFrame[i]!) >>> 0;
    }
    for (let i = 0; i < DIMENSIONS; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      vector[i] = (seed % 2000) / 1000 - 1; // roughly [-1, 1]
    }
    return vector;
  }
}

export class MockLivenessDetector implements LivenessDetector {
  async scoreLiveness(audioFrame: Buffer): Promise<number> {
    // Mock heuristic: longer, non-trivial audio scores higher — stands in
    // for a real model without claiming to detect anything real. Always
    // returns a value, never a fixed constant, so callers exercising this
    // mock see varied (if not real) liveness outcomes.
    if (audioFrame.length < 1024) return 0.4; // too short to be a plausible live utterance
    return 0.95;
  }
}

export class InMemoryVoiceprintStore implements EnrolledVoiceprintStore {
  private readonly enrolled = new Map<string, VectorEmbedding>();

  /** Test/demo seeding helper — not part of the EnrolledVoiceprintStore interface. */
  seed(customerId: string, voiceprint: VectorEmbedding): void {
    this.enrolled.set(customerId, voiceprint);
  }

  async getEnrolledVoiceprint(customerId: string): Promise<VectorEmbedding | null> {
    return this.enrolled.get(customerId) ?? null;
  }
}

// ---------------------------------------------------------------------------
// The Hot Path service itself
// ---------------------------------------------------------------------------

const IDENTITY_CONTEXT_TTL_MS = 5 * 60 * 1000; // 5 minutes — short by design: a signed identity context is meant to authorize the ONE action immediately following verification, not to linger as a reusable bearer credential. A short TTL minimizes the window in which a leaked/captured context could be replayed for something else.

export class VoiceIdentityProvider {
  constructor(private readonly deps: VoiceIdentityProviderDependencies) {}

  async verifyIdentity(request: VoiceVerificationRequest): Promise<VoiceVerificationResponse> {
    // ---------------------------------------------------------------------
    // GATE 1 — Liveness. Evaluated FIRST, unconditionally, against the raw
    // audio directly — before embedding extraction, before any voiceprint
    // store lookup. A request that fails here never reaches a point where
    // this service even reveals whether the given customerId has an
    // enrollment on file at all, which matters for the reason explained in
    // the conversational note above this file.
    // ---------------------------------------------------------------------
    const livenessScore = await this.deps.livenessDetector.scoreLiveness(request.audioFrame);

    if (livenessScore < LIVENESS_REJECTION_FLOOR) {
      return {
        outcome: 'LIVENESS_REJECTED',
        traceId: request.traceId,
        customerId: request.customerId,
        livenessScore,
      };
    }

    // ---------------------------------------------------------------------
    // GATE 2 — Enrollment existence. Only checked now, after liveness has
    // already passed.
    // ---------------------------------------------------------------------
    const enrolledVoiceprint = await this.deps.voiceprintStore.getEnrolledVoiceprint(request.customerId);
    if (!enrolledVoiceprint) {
      return { outcome: 'NO_ENROLLED_VOICEPRINT', traceId: request.traceId, customerId: request.customerId };
    }

    // ---------------------------------------------------------------------
    // GATE 3 — Similarity, against the bar for the SPECIFIC security level
    // this request asked for. Deliberately NOT a "best level achieved"
    // computation that silently downgrades — see the conversational note
    // above for why a silent downgrade is a real footgun here: the caller
    // (e.g. a P2P transfer requesting HIGH_RISK) is relying on getting
    // back either a token honestly asserting HIGH_RISK strength, or an
    // outright rejection — never a token quietly asserting a lower
    // strength than what was asked for, which a caller might not even
    // think to re-check before trusting it.
    // ---------------------------------------------------------------------
    const candidateEmbedding = await this.deps.embeddingExtractor.extractEmbedding(request.audioFrame);
    const similarity = this.calculateCosineSimilarity(candidateEmbedding, enrolledVoiceprint);
    const requiredThreshold = SIMILARITY_THRESHOLD_BY_LEVEL[request.requestedSecurityLevel];

    if (similarity < requiredThreshold) {
      return {
        outcome: 'SIMILARITY_REJECTED',
        traceId: request.traceId,
        customerId: request.customerId,
        achievedSimilarity: similarity,
        requiredThreshold,
        requestedSecurityLevel: request.requestedSecurityLevel,
      };
    }

    const identityContext = this.issueSignedIdentityContext(request.customerId, request.requestedSecurityLevel);
    return { outcome: 'MATCHED', traceId: request.traceId, customerId: request.customerId, identityContext };
  }

  /**
   * Standard cosine similarity: dot(a, b) / (||a|| * ||b||).
   *
   * No constant-time comparison anywhere in this method, and that's
   * deliberate — see the conversational note above this file for why:
   * this loop runs a fixed number of iterations (the embedding
   * dimensionality, a public model parameter, not a secret) regardless of
   * the actual vector values. There's no secret-dependent early-exit
   * branching here for a timing side-channel to exploit, unlike an HMAC or
   * signature comparison.
   */
  private calculateCosineSimilarity(vecA: Float32Array, vecB: Float32Array): number {
    if (vecA.length !== vecB.length) {
      // A dimensionality mismatch means the candidate embedding and the
      // enrolled one came from different model versions — a real,
      // serious configuration error, never something to silently
      // truncate or zero-pad around. Truncating would produce a
      // meaningless similarity score that could accidentally exceed a
      // threshold by coincidence; failing loudly is the only safe option.
      throw new Error(
        `Embedding dimensionality mismatch: candidate has ${vecA.length} dimensions, enrolled voiceprint has ${vecB.length}. This indicates a model-version mismatch between enrollment and verification, not a normal runtime condition.`,
      );
    }

    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < vecA.length; i++) {
      const a = vecA[i]!;
      const b = vecB[i]!;
      dotProduct += a * b;
      magnitudeA += a * a;
      magnitudeB += b * b;
    }

    const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
    if (denominator === 0) {
      // A zero-magnitude vector should never come out of a real embedding
      // model, but defensively: a zero vector cannot meaningfully match
      // anything, so this resolves to "no similarity" rather than
      // dividing by zero into NaN/Infinity, which could otherwise compare
      // unpredictably against a threshold.
      return 0;
    }

    return dotProduct / denominator;
  }

  private issueSignedIdentityContext(
    customerId: string,
    authStrength: BiometricSecurityLevel,
  ): SignedIdentityContext {
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + IDENTITY_CONTEXT_TTL_MS);
    const sessionId = randomUUID();

    const sessionClaims = {
      authStrength,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      sessionId,
    };

    // Explicit field order array serialization ensures cryptographic signature stability
    // without relying on runtime object engine key preservation quirks.
    const canonicalPayload = JSON.stringify([
      customerId,
      sessionClaims.authStrength,
      sessionClaims.issuedAt,
      sessionClaims.expiresAt,
      sessionClaims.sessionId,
    ]);

    const signature = createHmac('sha256', this.deps.identityContextSigningKey)
      .update(canonicalPayload)
      .digest('hex');

    return {
      customerId,
      sessionClaims,
      signature,
    };
  }
}