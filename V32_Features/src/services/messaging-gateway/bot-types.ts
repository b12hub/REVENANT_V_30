/**
 * bot-types.ts
 *
 * Canonical type definitions for the REVENANT v32 Messaging Gateway
 * (Feature F9: WhatsApp Business & Telegram Rich Bot UX).
 *
 * Architectural principle — "Complete Channel Abstraction":
 * ------------------------------------------------------------
 * The banking core must never branch on which messaging channel originated
 * an interaction. Every inbound webhook is normalized into a
 * `BotInteractionEvent` before it crosses into business logic, and every
 * outbound UI is described as an abstract `PresentationLayout` before it
 * crosses into a channel-specific renderer. Nothing in this file references
 * a Telegram or Meta wire format directly — that knowledge is confined to
 * `inbound-gateway.ts` and the (not-yet-built) outbound renderers.
 */

// ---------------------------------------------------------------------------
// Channel identity
// ---------------------------------------------------------------------------

/** The set of supported presentation surfaces. */
export type ChannelType = 'TELEGRAM' | 'WHATSAPP';

// ---------------------------------------------------------------------------
// Inbound interaction model
// ---------------------------------------------------------------------------

/** Coarse classification of what kind of inbound interaction occurred. */
export type BotInteractionEventType = 'MESSAGE' | 'BUTTON_CLICK' | 'COMMAND';

/**
 * Authentication state of the resolved identity at the time the event was
 * normalized. Computed during inbound gateway processing; every downstream
 * handler MUST inspect this before any privileged action is taken.
 *
 *  - AUTHENTICATED:   platform identifier resolved to an active, verified binding.
 *  - UNAUTHENTICATED: no binding exists for this platform identifier at all.
 *  - EXPIRED_SESSION: a binding existed but its verification window has lapsed.
 */
export type IdentityResolutionState = 'AUTHENTICATED' | 'UNAUTHENTICATED' | 'EXPIRED_SESSION';

/**
 * The platform-agnostic action payload.
 *
 * `actionId` is a stable, internal vocabulary string (e.g. 'FREEZE_CARD',
 * 'VIEW_BALANCE') — never a raw platform callback string.
 *
 * `metadata` carries only non-sensitive, UI-scoped variables (a display
 * label, a pagination cursor, etc.) — never account numbers, workflow IDs,
 * or other privileged identifiers. Privileged identifiers travel exclusively
 * through the `OpaqueCallbackRegistry` (see callback-registry.ts) and arrive
 * here, if at all, already exchanged for `opaqueToken`.
 */
export interface InteractionPayload {
  /** Canonical, internal action identifier. Stable across all channels. */
  readonly actionId: string;
  /** Free-text body for MESSAGE/COMMAND-type events; absent for button clicks. */
  readonly text?: string;
  /** Opaque callback token, present when this interaction came from a rendered button. */
  readonly opaqueToken?: string;
  /** Non-sensitive UI-scoped key/value pairs. Never PII or system identifiers. */
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

/**
 * Per-conversation session pointer. The gateway itself is stateless; this is
 * a read reference into externally-owned session state, not state owned here.
 */
export interface SessionState {
  readonly sessionId: string;
  readonly state: IdentityResolutionState;
  /** The cryptographic or biological verification method used to clear this session. */
  readonly authFactorLevel?: 'PRE_AUTH' | 'OTP_VERIFIED' | 'BIOMETRIC_F7';
  /** ISO-8601 timestamp of last verified activity, when known. */
  readonly lastVerifiedAt?: string;
}

/**
 * The canonical, channel-agnostic representation of any inbound interaction.
 * Every webhook handler in `inbound-gateway.ts` terminates by producing
 * exactly one of these. The banking core depends on this shape only.
 */
export interface BotInteractionEvent {
  /** Unique, generated tracking ID for this specific event (tracing/audit). */
  readonly eventId: string;
  /** Originating channel — informational only; must not gate business logic. */
  readonly channel: ChannelType;
  /** Coarse interaction classification. */
  readonly eventType: BotInteractionEventType;
  /** ISO-8601 receipt timestamp at the edge. */
  readonly receivedAt: string;
  /**
   * Verified internal customer ID, resolved via the Identity Binding Cache.
   * `null` whenever the platform identifier did not resolve to an active,
   * verified binding — callers MUST treat this as "not authenticated" and
   * MUST NOT fall back to `platformConversationRef` for authorization.
   */
  readonly customerId: string | null;
  /** Conversation/session pointer and its resolution state. */
  readonly session: SessionState;
  /** The normalized action/content payload. */
  readonly interaction: InteractionPayload;
  /**
   * Raw platform identifier (phone number, chat ID, etc.), retained ONLY for
   * audit/correlation and for addressing the response back to the right
   * conversation. Must never be used as an authorization key.
   */
  readonly platformConversationRef: string;
}

// ---------------------------------------------------------------------------
// Outbound presentation model
// ---------------------------------------------------------------------------

/** A single selectable action surfaced to the user (a "button"). */
export interface PresentationAction {
  /** Internal canonical action ID (mirrors InteractionPayload.actionId on click). */
  readonly actionId: string;
  /** Localized, human-visible label. */
  readonly label: string;
  /**
   * Opaque token reference for high-risk actions (see callback-registry.ts).
   * When present, channel renderers MUST embed only this token — never any
   * underlying workflow/account identifier — in the outbound button payload.
   */
  readonly opaqueToken?: string;
  /** Visual emphasis hint; renderers may ignore if unsupported. */
  readonly style?: 'PRIMARY' | 'SECONDARY' | 'DESTRUCTIVE';
}

/**
 * A logical grouping of actions. Channel renderers decide HOW to lay these
 * out (inline keyboard rows, WhatsApp quick-reply buttons, a WhatsApp
 * interactive list message, etc.) based on `ChannelCapabilities` — the
 * layout description itself stays declarative here.
 *
 * `buttons` models flat, row-style actions (quick replies / inline keyboard
 * rows). `options` models multi-choice selections intended for list-style
 * widgets (e.g. WhatsApp interactive lists, Telegram inline matrices with
 * many entries). A layout may populate either, both, or neither per group,
 * letting the renderer decide the best concrete mapping for its channel.
 */
export interface ActionGroup {
  /** Optional section heading, used by list-capable renderers. */
  readonly heading?: string;
  /** Flat row-style buttons. */
  readonly buttons?: readonly PresentationAction[];
  /** Multi-choice options for list/menu-style widgets. */
  readonly options?: readonly PresentationAction[];
}

/**
 * Abstract, channel-agnostic UI description. Produced by the UX/orchestration
 * layer and handed to a channel-specific renderer, which reshapes it
 * according to `ChannelCapabilities` (e.g. collapsing to WhatsApp's 3-button
 * quick-reply ceiling, or splitting overflow into a list view).
 */
export interface PresentationLayout {
  /** Localized title/header text. */
  readonly title: string;
  /** Localized body text blocks, rendered in order. */
  readonly textBlocks: readonly string[];
  /** Declarative action groups; renderer chooses the concrete widget mapping. */
  readonly actionGroups: readonly ActionGroup[];
  /** BCP-47 locale this layout was localized for. */
  readonly locale: string;
}

// ---------------------------------------------------------------------------
// Channel capability constraints
// ---------------------------------------------------------------------------

/**
 * Immutable, per-channel rendering constraints. Renderers consult this
 * before reshaping a `PresentationLayout`; it is the single source of truth
 * for vendor limits and must not be duplicated or hardcoded elsewhere.
 */
export interface ChannelCapabilities {
  readonly channel: ChannelType;
  /** Hard ceiling on title length, in characters. */
  readonly maxTitleLength: number;
  /** Hard ceiling on a single text block's length, in characters. */
  readonly maxTextBlockLength: number;
  /** Hard ceiling on flat row buttons per message (WhatsApp's absolute limit is 3). */
  readonly maxFlatButtons: number;
  /** Hard ceiling on a single button's text label (Meta limits this strictly). */
  readonly maxButtonLabelLength: number;
  /** Hard ceiling on options within a single list/menu construct. */
  readonly maxListOptions: number;
  /** Whether this channel supports a native multi-row list-picker widget. */
  readonly supportsListPayload: boolean;
  /** Whether this channel supports an inline matrix (multi-column) keyboard. */
  readonly supportsInlineMatrix: boolean;
}

/**
 * Frozen capability table — the only authoritative constraint set. Renderer
 * logic should branch on these flags/limits rather than re-deriving vendor
 * constraints inline (e.g. avoid `channel === 'WHATSAPP'` checks when a
 * capability field already expresses the same constraint).
 */
export const CHANNEL_CAPABILITIES: Readonly<Record<ChannelType, ChannelCapabilities>> = Object.freeze({
  WHATSAPP: Object.freeze({
    channel: 'WHATSAPP',
    maxTitleLength: 60,
    maxTextBlockLength: 1024,
    maxFlatButtons: 3, // Absolute platform ceiling on quick-reply buttons.
    maxButtonLabelLength: 20, // Strict Meta layout restriction.
    maxListOptions: 10,
    supportsListPayload: true,
    supportsInlineMatrix: false,
  }),
  TELEGRAM: Object.freeze({
    channel: 'TELEGRAM',
    maxTitleLength: 256,
    maxTextBlockLength: 4096,
    maxFlatButtons: 8,
    maxButtonLabelLength: 64, // Standard visual breaks buffer.
    maxListOptions: 100,
    supportsListPayload: false,
    supportsInlineMatrix: true,
  }),
});