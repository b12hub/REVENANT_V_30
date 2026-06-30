/**
 * inbound-gateway.ts
 *
 * Edge-facing ingestion point for Feature F9 (WhatsApp Business & Telegram
 * Rich Bot UX). Implements "Zero-Trust Webhook Security": no payload is
 * trusted, no platform identifier is treated as an authorization credential
 * on its own, and every inbound webhook — regardless of origin — exits this
 * module as a single canonical `BotInteractionEvent`.
 */

import {
  type BotInteractionEvent,
  type BotInteractionEventType,
  type ChannelType,
  type InteractionPayload,
  type SessionState,
} from './bot-types.js';

// ---------------------------------------------------------------------------
// Identity Binding Cache (mock)
// ---------------------------------------------------------------------------

/**
 * A verified mapping from a platform conversation reference (phone number /
 * chat ID) to an internal customer record and an active session. The cache
 * is the ONLY component permitted to assert that `customerId` is verified.
 */
export interface IdentityBindingRecord {
  readonly customerId: string;
  readonly sessionId: string;
  readonly verifiedAt: string;
  /** ISO-8601 expiry; bindings past this are surfaced as an expired session. */
  readonly expiresAt: string;
  /** The cryptographic or biological verification method used to clear this session. */
  readonly authFactorLevel: 'PRE_AUTH' | 'OTP_VERIFIED' | 'BIOMETRIC_F7';
}
/** Discriminated lookup result — keeps "expired" distinguishable from "never bound". */
export type IdentityLookupResult =
  | { readonly status: 'ACTIVE'; readonly record: IdentityBindingRecord }
  | { readonly status: 'EXPIRED' }
  | { readonly status: 'NOT_FOUND' };

/**
 * Mock Identity Binding Cache. In production this is backed by a
 * low-latency, encrypted-at-rest store populated by an out-of-band,
 * channel-specific onboarding/auth flow (OTP-bound phone verification for
 * WhatsApp; Telegram login-widget or deep-link binding for Telegram). This
 * stub exposes only the read contract the gateway needs.
 */
export class IdentityBindingCache {
  private readonly bindings = new Map<string, IdentityBindingRecord>();

  /** Test/bootstrap seam only — not part of the production write path. */
  public seed(platformConversationRef: string, record: IdentityBindingRecord): void {
    this.bindings.set(platformConversationRef, record);
  }

  public async resolve(platformConversationRef: string): Promise<IdentityLookupResult> {
    const record = this.bindings.get(platformConversationRef);
    if (!record) {
      return { status: 'NOT_FOUND' };
    }
    if (new Date(record.expiresAt).getTime() <= Date.now()) {
      return { status: 'EXPIRED' };
    }
    return { status: 'ACTIVE', record };
  }
}

// ---------------------------------------------------------------------------
// Raw payload shapes (intentionally minimal & untrusted)
// ---------------------------------------------------------------------------

/**
 * These interfaces describe only what we read off the wire for
 * normalization. They are deliberately narrow — this module must not become
 * a dumping ground for vendor schema knowledge; everything past
 * `handleWebhook` only ever sees a `BotInteractionEvent`.
 */
interface TelegramUpdateLike {
  readonly message?: {
    readonly chat?: { readonly id?: number | string };
    readonly text?: string;
  };
  readonly callback_query?: {
    readonly data?: string;
    readonly message?: { readonly chat?: { readonly id?: number | string } };
    readonly from?: { readonly id?: number | string };
  };
}

interface WhatsAppWebhookLike {
  readonly entry?: ReadonlyArray<{
    readonly changes?: ReadonlyArray<{
      readonly value?: {
        readonly messages?: ReadonlyArray<{
          readonly from?: string;
          readonly text?: { readonly body?: string };
          readonly button?: { readonly payload?: string; readonly text?: string };
          readonly interactive?: {
            readonly button_reply?: { readonly id?: string; readonly title?: string };
            readonly list_reply?: { readonly id?: string; readonly title?: string };
          };
        }>;
      };
    }>;
  }>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when an inbound payload fails structural signature verification. */
export class WebhookSignatureError extends Error {
  public constructor(channel: ChannelType, detail: string) {
    super(`Webhook signature verification failed for channel=${channel}: ${detail}`);
    this.name = 'WebhookSignatureError';
  }
}

/** Raised when a payload cannot be normalized into any known interaction shape. */
export class UnrecognizedPayloadError extends Error {
  public constructor(channel: ChannelType) {
    super(`Unable to normalize inbound payload for channel=${channel}`);
    this.name = 'UnrecognizedPayloadError';
  }
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

/**
 * Dependencies are injected so this class stays unit-testable and so the
 * production wiring (real HMAC verification, real cache backend) can be
 * swapped in without touching normalization logic.
 */
export interface UnifiedMessagingGatewayDeps {
  readonly identityCache: IdentityBindingCache;
  /** Monotonic/random ID generator, injected for testability. */
  readonly generateEventId: () => string;
  readonly now: () => Date;
}

/**
 * `UnifiedMessagingGateway` is the single ingestion seam for all inbound
 * channel webhooks. It enforces, in strict order:
 *
 *  1. Structural signature verification (per-vendor framing, never skipped).
 *  2. Channel-specific payload normalization into an `InteractionPayload`.
 *  3. Identity resolution against the Identity Binding Cache — platform
 *     identifiers are NEVER treated as authorization on their own.
 *
 * The banking core consumes only the resulting `BotInteractionEvent` and
 * therefore never branches on `channel`.
 */
export class UnifiedMessagingGateway {
  private readonly deps: UnifiedMessagingGatewayDeps;

  public constructor(deps: UnifiedMessagingGatewayDeps) {
    this.deps = deps;
  }

  /**
   * Single public entry point for all edge webhooks. Resolves to a
   * `BotInteractionEvent` even for unauthenticated traffic — with
   * `customerId: null` and `session.state !== 'AUTHENTICATED'` — so
   * downstream orchestration can deterministically route to an
   * onboarding/re-auth flow rather than branching on thrown exceptions for
   * the "unknown user" case.
   *
   * Throws only for payloads that fail signature verification or cannot be
   * structurally normalized at all (i.e. not a recoverable business case).
   */
  public async handleWebhook(
    channel: ChannelType,
    rawPayload: Record<string, unknown>,
    signatureHeader?: string,
  ): Promise<BotInteractionEvent> {
    this.verifySignature(channel, rawPayload, signatureHeader);

    const normalized = this.normalizePayload(channel, rawPayload);
    const { customerId, sessionState } = await this.resolveSession(normalized.platformConversationRef);

    const eventType: BotInteractionEventType = this.classifyEvent(normalized.interaction);

    return {
      eventId: this.deps.generateEventId(),
      channel,
      eventType,
      receivedAt: this.deps.now().toISOString(),
      customerId,
      session: sessionState,
      interaction: normalized.interaction,
      platformConversationRef: normalized.platformConversationRef,
    };
  }

  // -- Signature verification -------------------------------------------

  /**
   * Structural verification seam. A production implementation must perform
   * full cryptographic verification before this method returns:
   *
   *  - WHATSAPP: validate the `X-Hub-Signature-256` header as an
   *    HMAC-SHA256 over the raw request body using the Meta App Secret,
   *    compared in constant time.
   *  - TELEGRAM: validate the `X-Telegram-Bot-Api-Secret-Token` header
   *    against the secret configured via `setWebhook`, compared in
   *    constant time.
   *
   * Verification is isolated behind this single method so the real crypto
   * can be dropped in without touching normalization logic, and so a
   * missing/failed check can never silently fall through to normalization.
   */
  private verifySignature(
    channel: ChannelType,
    rawPayload: Record<string, unknown>,
    signatureHeader?: string,
  ): void {
    if (!signatureHeader || signatureHeader.trim().length === 0) {
      throw new WebhookSignatureError(channel, 'missing signature header');
    }
    if (Object.keys(rawPayload).length === 0) {
      throw new WebhookSignatureError(channel, 'empty payload body');
    }
    // Production: branch here only on which constant-time HMAC / secret-token
    // comparison to run — never on how to interpret the payload contents.
  }

  // -- Classification ------------------------------------------------------

  private classifyEvent(interaction: InteractionPayload): BotInteractionEventType {
    if (interaction.opaqueToken) {
      return 'BUTTON_CLICK';
    }
    if (interaction.text?.startsWith('/')) {
      return 'COMMAND';
    }
    return 'MESSAGE';
  }

  // -- Normalization ------------------------------------------------------

  private normalizePayload(
    channel: ChannelType,
    rawPayload: Record<string, unknown>,
  ): { interaction: InteractionPayload; platformConversationRef: string } {
    if (channel === 'TELEGRAM') {
      return this.normalizeTelegram(rawPayload as unknown as TelegramUpdateLike);
    }
    return this.normalizeWhatsApp(rawPayload as unknown as WhatsAppWebhookLike);
  }

  /**
   * Telegram: `callback_query.data` and free-text `message.text` are both
   * normalized here. By convention, `callback_query.data` is ALWAYS an
   * opaque token minted by `OpaqueCallbackRegistry` — never a raw
   * action+arguments string — so it is passed through untouched as
   * `opaqueToken` rather than parsed.
   */
  private normalizeTelegram(
    update: TelegramUpdateLike,
  ): { interaction: InteractionPayload; platformConversationRef: string } {
    const callback = update.callback_query;
    if (callback) {
      const chatId = callback.message?.chat?.id ?? callback.from?.id;
      if (chatId === undefined || !callback.data) {
        throw new UnrecognizedPayloadError('TELEGRAM');
      }
      return {
        platformConversationRef: String(chatId),
        interaction: {
          actionId: 'BUTTON_CLICK',
          opaqueToken: callback.data,
          metadata: {},
        },
      };
    }

    const chatId = update.message?.chat?.id;
    if (chatId !== undefined) {
      const text = update.message?.text ?? '';
      const command = text.startsWith('/') ? (text.split(' ')[0] ?? '').replace('/', '').toUpperCase() : null;
      return {
        platformConversationRef: String(chatId),
        interaction: {
          actionId: command ?? 'FREE_TEXT',
          text,
          metadata: {},
        },
      };
    }

    throw new UnrecognizedPayloadError('TELEGRAM');
  }

  /**
   * WhatsApp: interactive `button_reply` / `list_reply` IDs and legacy
   * `button.payload` values are, by the same convention as Telegram,
   * ALWAYS opaque tokens minted by `OpaqueCallbackRegistry` — never raw
   * workflow identifiers — so they pass through untouched as `opaqueToken`.
   */
  private normalizeWhatsApp(
    webhook: WhatsAppWebhookLike,
  ): { interaction: InteractionPayload; platformConversationRef: string } {
    const message = webhook.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message?.from) {
      throw new UnrecognizedPayloadError('WHATSAPP');
    }

    const interactiveReply = message.interactive?.button_reply ?? message.interactive?.list_reply;
    if (interactiveReply?.id) {
      return {
        platformConversationRef: message.from,
        interaction: {
          actionId: 'BUTTON_CLICK',
          opaqueToken: interactiveReply.id,
          metadata: interactiveReply.title ? { label: interactiveReply.title } : {},
        },
      };
    }

    if (message.button?.payload) {
      return {
        platformConversationRef: message.from,
        interaction: {
          actionId: 'BUTTON_CLICK',
          opaqueToken: message.button.payload,
          metadata: message.button.text ? { label: message.button.text } : {},
        },
      };
    }

    if (message.text?.body !== undefined) {
      return {
        platformConversationRef: message.from,
        interaction: {
          actionId: 'FREE_TEXT',
          text: message.text.body,
          metadata: {},
        },
      };
    }

    throw new UnrecognizedPayloadError('WHATSAPP');
  }

  // -- Identity resolution --------------------------------------------------

  /**
   * Resolves a raw platform identifier against the Identity Binding Cache.
   * A cache miss or expired binding is NOT an error — it is a valid,
   * expected outcome that downstream orchestration routes to an
   * onboarding/re-auth flow. The gateway never authorizes on the platform
   * identifier itself.
   */
  private async resolveSession(
    platformConversationRef: string,
  ): Promise<{ customerId: string | null; sessionState: SessionState }> {
    const lookup = await this.deps.identityCache.resolve(platformConversationRef);

    switch (lookup.status) {
      case 'ACTIVE':
        return {
          customerId: lookup.record.customerId,
          sessionState: {
            sessionId: lookup.record.sessionId,
            state: 'AUTHENTICATED',
            authFactorLevel: lookup.record.authFactorLevel,
            lastVerifiedAt: lookup.record.verifiedAt,
          },
        };
      case 'EXPIRED':
        return {
          customerId: null,
          sessionState: {
            sessionId: `expired:${platformConversationRef}`,
            state: 'EXPIRED_SESSION',
            authFactorLevel: 'PRE_AUTH',
          },
        };
      case 'NOT_FOUND':
        return {
          customerId: null,
          sessionState: {
            sessionId: `unbound:${platformConversationRef}`,
            state: 'UNAUTHENTICATED',
            authFactorLevel: 'PRE_AUTH',
          },
        };
    }
  }
}