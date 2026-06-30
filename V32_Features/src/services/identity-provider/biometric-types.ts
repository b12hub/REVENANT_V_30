// biometric-types.ts

// ---------------------------------------------------------------------------
// 1. Vector embedding
// ---------------------------------------------------------------------------

/**
 * Float32Array, not number[]. Two reasons, both real: speaker-embedding
 * models conventionally emit float32 output (matching that dtype avoids a
 * silent precision-widening copy at the model/service boundary), and a
 * typed array gives the cosine-similarity loop in identity-service.ts
 * predictable, contiguous memory access — meaningful on a path explicitly
 * scoped as "low-latency."
 */
export type VectorEmbedding = Float32Array;

// ---------------------------------------------------------------------------
// 2. Closed-state sets — string-literal unions, not TS `enum`. See the
//    conversational note above for why: every other status type in this
//    codebase (P2P, Credit, Bill-Pay, Merchant outcomes) uses this shape,
//    and introducing `enum` here would be the one inconsistent pattern in
//    an otherwise uniform codebase. A `const` object is provided alongside
//    each union for runtime iteration (e.g. validating a wire value),
//    since a bare union type has no runtime representation to check against.
// ---------------------------------------------------------------------------

export const ENROLLMENT_STATES = ['AWAITING_SAMPLES', 'PROCESSING', 'ENROLLED', 'FAILED'] as const;
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

export const BIOMETRIC_SECURITY_LEVELS = ['CONVERSATIONAL', 'TRANSACTIONAL', 'HIGH_RISK'] as const;
export type BiometricSecurityLevel = (typeof BIOMETRIC_SECURITY_LEVELS)[number];

/**
 * The similarity bar required PER requested security level. This is the
 * direct generalization of what used to be a single hardcoded liveness
 * check inline in the original monolith's Voice Processor node — instead
 * of one fixed bar for everything, the caller (a P2P transfer, a balance
 * inquiry, a casual chat) declares what grade of assurance the ACTION
 * needs, and this service enforces that specific bar, not a one-size-fits-all
 * one.
 *
 * Deliberately exported as a single source of truth here rather than left
 * as magic numbers scattered across identity-service.ts — the same
 * "centralize thresholds as named constants" discipline applied to every
 * other VLAN's decision/validation logic in this build.
 */
export const SIMILARITY_THRESHOLD_BY_LEVEL: Readonly<Record<BiometricSecurityLevel, number>> = {
  CONVERSATIONAL: 0.75,
  TRANSACTIONAL: 0.85,
  HIGH_RISK: 0.92,
};

/**
 * The liveness floor is intentionally NOT graduated by security level the
 * way similarity is. Liveness detection answers a binary question — "is
 * this a live human speaking right now, or a replay/synthetic signal" —
 * not a confidence spectrum that should be more lenient for low-stakes
 * requests. A synthetic voice is a synthetic voice regardless of whether
 * the caller only needed CONVERSATIONAL-grade auth; there's no legitimate
 * reason to let a cloned voice through just because the stakes were low.
 */
export const LIVENESS_REJECTION_FLOOR = 0.9;

// ---------------------------------------------------------------------------
// 3. Hot Path request / response
// ---------------------------------------------------------------------------

export interface VoiceVerificationRequest {
  readonly traceId: string;
  readonly customerId: string;
  readonly audioFrame: Buffer;
  readonly requestedSecurityLevel: BiometricSecurityLevel;
}

interface VerificationOutcomeBase {
  readonly traceId: string;
  readonly customerId: string;
}

/**
 * Liveness failed — checked and returned BEFORE this service ever attempts
 * a similarity comparison or even looks up whether the customer has an
 * enrolled voiceprint. See the conversational note above for the
 * enumeration-resistance reasoning behind that ordering.
 */
export interface LivenessRejected extends VerificationOutcomeBase {
  readonly outcome: 'LIVENESS_REJECTED';
  readonly livenessScore: number;
}

/**
 * Distinct from a failed MATCH — this customer has no enrolled voiceprint
 * to compare against at all. A calling system should route this to an
 * enrollment flow, not retry verification.
 */
export interface NoEnrolledVoiceprint extends VerificationOutcomeBase {
  readonly outcome: 'NO_ENROLLED_VOICEPRINT';
}

export interface SimilarityRejected extends VerificationOutcomeBase {
  readonly outcome: 'SIMILARITY_REJECTED';
  readonly achievedSimilarity: number;
  readonly requiredThreshold: number;
  readonly requestedSecurityLevel: BiometricSecurityLevel;
}

export interface VerificationMatched extends VerificationOutcomeBase {
  readonly outcome: 'MATCHED';
  readonly identityContext: SignedIdentityContext;
}

/**
 * "Interfaces for VoiceVerificationRequest and VoiceVerificationResponse"
 * — implemented as a discriminated union, not a single flat interface.
 * See the conversational note above for why: four genuinely distinct
 * outcomes need different handling downstream, and collapsing them into
 * optional fields on one shape is the exact pattern this codebase has
 * avoided everywhere else.
 */
export type VoiceVerificationResponse =
  | LivenessRejected
  | NoEnrolledVoiceprint
  | SimilarityRejected
  | VerificationMatched;

export function assertVerificationUnreachable(value: never): never {
  throw new Error(`Unreachable voice verification outcome: ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// 4. Signed Identity Context
// ---------------------------------------------------------------------------

/**
 * Modeled as a flat object with its own `signature` field — a detached
 * HMAC over the other fields' canonical serialization — rather than a
 * single opaque compact-JWT string. This is a deliberate divergence from
 * this project's established `jose` SignJWT pattern (used for P2P's
 * CONFIRM_P2P and Credit's SIGN_LOAN tokens): those are BEARER tokens
 * handed to an external party (a customer's Telegram client) and need to
 * travel as one opaque string. This context is consumed entirely
 * INTERNALLY, by other REVENANT services that want to inspect
 * `authStrength` and `expiresAt` directly without a decode step first. If
 * a standard bearer-token wire format is ever needed instead, swapping
 * this for `jose`'s SignJWT is a small, contained change to
 * identity-service.ts's signing method — it doesn't require touching this
 * interface's conceptual shape, which a consuming service should be able
 * to treat as opaque-but-introspectable either way.
 
 */
/**
 * Biometric Session Claims payload embedded inside the SignedIdentityContext.
 * This structure keeps our biometric data safely mapped inside the global
 * identity verification standards established in F6.
 */
export interface BiometricSessionClaims {
  readonly authStrength: BiometricSecurityLevel;
  readonly issuedAt: string;  // ISO 8601 timestamp
  readonly expiresAt: string; // ISO 8601 timestamp
  readonly sessionId: string;
  readonly [key: string]: unknown; // Satisfies the Record<string, unknown> constraint
}

/**
 * Core Identity bundle signed by the authentication gateway.
 * Fully synchronized with the voice-gateway pipeline type contracts.
 */
export interface SignedIdentityContext {
  readonly customerId: string;
  readonly sessionClaims: BiometricSessionClaims;
  readonly signature: string; // hex-encoded HMAC-SHA256 over canonical JSON serialization
}