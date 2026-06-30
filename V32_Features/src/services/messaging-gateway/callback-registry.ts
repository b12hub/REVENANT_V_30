/**
 * callback-registry.ts
 *
 * Enterprise-Grade Opaque Callback Registry for Feature F9.
 *
 * ARCHITECTURAL RATIONALE (DATA SOVEREIGNTY & COMPLIANCE):
 * ---------------------------------------------------------------------------
 * When rendering interactive UI elements (like "Confirm Freeze Card" buttons)
 * inside third-party messaging networks (WhatsApp, Telegram), the payload
 * attached to the button routes through external, non-sovereign servers.
 *
 * If a payload contains raw system identifiers (e.g., {"workflow":"wf_123",
 * "card":"4411..."}), we leak internal topology and potentially PII into Meta
 * or Telegram's databases, violating data residency and banking secrecy laws.
 *
 * This registry implements the "Ephemeral Reference Pattern". It tokenizes
 * high-risk UI variables into unpredictable, short-lived, opaque strings
 * (e.g., `cb_3f1a9b2d`). The external network only ever sees the token.
 * When the user clicks the button, the webhook returns the token, which is
 * evaluated and exchanged back into actionable system identifiers entirely
 * within the bank's secure perimeter.
 */

import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export interface RegisterActionInput {
  readonly workflowId: string;
  readonly signalName: string;
  readonly customerId: string;
  readonly payload: Record<string, unknown>;
  /** Optional time-to-live in seconds. Defaults to 3600 (1 hour). */
  readonly ttlSeconds?: number;
}

export interface ResolvedActionOutcome {
  readonly workflowId: string;
  readonly signalName: string;
  readonly customerId: string;
  readonly payload: Record<string, unknown>;
}

interface InternalCallbackRecord {
  readonly workflowId: string;
  readonly signalName: string;
  readonly customerId: string;
  readonly payload: Record<string, unknown>;
  readonly expiresAtMs: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InvalidTokenError extends Error {
  public constructor(token: string) {
    super(`Token structural validation failed: ${token}`);
    this.name = 'InvalidTokenError';
  }
}

export class TokenNotFoundError extends Error {
  public constructor() {
    super('Callback token not found or already consumed.');
    this.name = 'TokenNotFoundError';
  }
}

export class TokenExpiredError extends Error {
  public constructor() {
    super('Callback token has expired and cannot be executed.');
    this.name = 'TokenExpiredError';
  }
}

// ---------------------------------------------------------------------------
// Registry Implementation
// ---------------------------------------------------------------------------

export class OpaqueCallbackRegistry {
  // In production, this Map is replaced by a distributed, encrypted-at-rest
  // cache (like Redis) with native TTL expiration capabilities.
  private readonly store = new Map<string, InternalCallbackRecord>();
  private readonly DEFAULT_TTL_SECONDS = 3600;

  /**
   * Generates a secure, randomized token mapping to the internal payload.
   * The returned token is safe to embed in external UI payloads.
   */
  public async registerAction(input: RegisterActionInput): Promise<string> {
    // Mint an un-guessable 16-byte hex token with a prefix for traceability
    const token = `cb_${randomBytes(16).toString('hex')}`;

    const ttl = input.ttlSeconds ?? this.DEFAULT_TTL_SECONDS;
    const expiresAtMs = Date.now() + (ttl * 1000);

    this.store.set(token, {
      workflowId: input.workflowId,
      signalName: input.signalName,
      customerId: input.customerId,
      payload: input.payload,
      expiresAtMs,
    });

    return token;
  }

  /**
   * Evaluates a token originating from an external webhook, verifying structural
   * integrity and expiration before returning the operational variables.
   */
  public async resolveToken(token: string): Promise<ResolvedActionOutcome> {
    // 1. Structural validation (prevent directory traversal or malformed lookups)
    if (!token || typeof token !== 'string' || !token.startsWith('cb_')) {
      throw new InvalidTokenError(token);
    }

    // 2. Retrieval
    const record = this.store.get(token);
    if (!record) {
      throw new TokenNotFoundError();
    }

    // 3. Expiration enforcement
    if (Date.now() > record.expiresAtMs) {
      this.store.delete(token); // Eager cleanup
      throw new TokenExpiredError();
    }

    // 4. Consume (Single-use enforcement for high-risk actions)
    // In a strict banking context, state transitions triggered by buttons
    // should be idempotent, but enforcing single-use tokens at the edge
    // prevents replay attacks on the Temporal orchestrator.
    this.store.delete(token);

    return {
      workflowId: record.workflowId,
      signalName: record.signalName,
      customerId: record.customerId,
      payload: record.payload,
    };
  }
}