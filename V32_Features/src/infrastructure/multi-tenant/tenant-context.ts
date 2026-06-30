// tenant-context.ts
//
// The Node.js-process-side tenant context primitive. This file is safe to
// import from: the API Gateway, the Temporal workflow CLIENT (the process
// that calls client.workflow.start() — a plain Node process, not workflow
// code itself), and Temporal ACTIVITIES (which also execute in plain
// Node.js worker processes, not the sandboxed workflow runtime).
//
// THIS FILE MUST NEVER BE IMPORTED FROM WORKFLOW CODE. It imports
// `node:async_hooks`, which the Temporal workflow sandbox does not provide
// — attempting to bundle this module into a workflow would fail. See
// temporal-interceptors.ts for the deliberately separate, sandbox-safe
// mechanism used on the workflow side, and the comment there explaining
// exactly why it can't reuse this file.

import { AsyncLocalStorage } from 'node:async_hooks';

export type Environment = 'production' | 'sandbox';

/**
 * The strength of the customer's authentication for THIS session — a
 * session-level property. Deliberately distinct from F7's
 * BiometricSecurityLevel, which is the bar a specific ACTION requires
 * (e.g. "this disbursement needs TRANSACTIONAL-grade auth"). Those are two
 * different axes that happen to share a similar shape: one describes what
 * the customer currently HAS, the other describes what an action NEEDS. A
 * future ABAC/governance check compares the two; this file just carries
 * the former as inert context data.
 */
export type AuthFactorLevel = 'PRE_AUTH' | 'OTP_VERIFIED' | 'BIOMETRIC_F7';

export interface TenantContext {
  readonly tenantId: string;
  readonly traceId: string;
  readonly environment: Environment;
  readonly authFactorLevel: AuthFactorLevel;
}

// ---------------------------------------------------------------------------
// Tenant identifier validation. This is the SINGLE source of truth for
// "what characters are we ever willing to interpolate into a Postgres
// schema name" — reused by tenant-db-client.ts immediately before SQL
// construction, not trusted as already-validated just because it passed
// through here once.
//
// Constraint derivation, not an arbitrary choice: Postgres identifiers are
// silently truncated beyond NAMEDATALEN-1 = 63 bytes. The actual schema
// name this platform constructs is `tenant_${tenantId}` (7 chars of
// prefix) — so tenantId itself is capped at 56 characters to guarantee
// the FULL schema name never approaches truncation, which could otherwise
// cause two distinct, long tenant IDs to silently collide on the same
// physical schema.
// ---------------------------------------------------------------------------

const MAX_TENANT_ID_LENGTH = 56;
const TENANT_ID_PATTERN = /^[a-z][a-z0-9_]{0,55}$/;

export function isValidTenantIdentifier(candidate: string): boolean {
  return candidate.length <= MAX_TENANT_ID_LENGTH && TENANT_ID_PATTERN.test(candidate);
}

// ---------------------------------------------------------------------------
// Errors — two distinct failure modes, deliberately not collapsed into
// one. "No context was ever established" and "a context exists but its
// content is unsafe to use" are different bugs with different causes;
// conflating them would make debugging a production incident harder, the
// same specific-error-code discipline this codebase has applied
// everywhere else (UNKNOWN_PROVIDER vs CONFIGURATION_ERROR vs
// PROVIDER_UNAVAILABLE, etc.).
// ---------------------------------------------------------------------------

export class MissingTenantContextError extends Error {
  constructor() {
    super(
      'getTenantContext() was called outside of any established tenant context. ' +
        'This is a fail-closed guard: there is no "default" or "public" schema fallback ' +
        'in this platform. Every code path that touches tenant data MUST run inside ' +
        'runWithTenantContext(). If you are seeing this in a legitimate non-tenant-scoped ' +
        'code path (a health check, a platform-level cron), use tryGetTenantContext() instead ' +
        'and handle the null case explicitly — do not work around this error.',
    );
    this.name = 'MissingTenantContextError';
  }
}

export class InvalidTenantIdentifierError extends Error {
  constructor(rawTenantId: string) {
    super(
      `Tenant identifier "${rawTenantId}" failed validation (must match ${TENANT_ID_PATTERN} ` +
        `and be at most ${MAX_TENANT_ID_LENGTH} characters). Refusing to establish a tenant ` +
        `context with an unsafe identifier — this is a security boundary, not a formatting nicety.`,
    );
    this.name = 'InvalidTenantIdentifierError';
  }
}

// ---------------------------------------------------------------------------
// The AsyncLocalStorage singleton. Exported directly per the explicit
// requirement — but `getTenantContext()` / `runWithTenantContext()` below
// are the API every consumer should actually use. Reaching for the raw
// instance's own `.getStore()`/`.run()` directly would bypass the
// fail-closed error and the identifier validation both provide.
// ---------------------------------------------------------------------------

export const tenantContext = new AsyncLocalStorage<TenantContext>();

/**
 * Runs `fn` with `context` bound for the duration of its async execution
 * tree (including every awaited call inside it, transitively). The
 * context object is frozen before being stored — defense against a buggy
 * or compromised downstream module mutating `context.tenantId` mid-flight
 * to pivot into another tenant's data while still "inside" what looks
 * like a validly-established context.
 */
export async function runWithTenantContext<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
  if (!isValidTenantIdentifier(context.tenantId)) {
    throw new InvalidTenantIdentifierError(context.tenantId);
  }

  const frozenContext = Object.freeze({ ...context });
  return tenantContext.run(frozenContext, fn);
}

/**
 * The fail-closed accessor. Throws if called outside any established
 * context — this is the entire security property of this file. There is
 * deliberately no overload, no optional second argument, no "or return a
 * default" behavior. A missing context is always a bug, never a
 * legitimate runtime state for tenant-scoped code.
 */
export function getTenantContext(): TenantContext {
  const context = tenantContext.getStore();
  if (!context) {
    throw new MissingTenantContextError();
  }
  return context;
}

/**
 * The deliberately separate, loudly-named escape hatch for the narrow set
 * of legitimate non-tenant-scoped code paths (health checks, platform-level
 * observability/logging middleware that wants to enrich a log line IF a
 * tenant happens to be active, without crashing if not). Business logic
 * and ANY data-access code must use getTenantContext() instead — this
 * function existing at all is not permission to use it casually.
 */
export function tryGetTenantContext(): TenantContext | null {
  return tenantContext.getStore() ?? null;
}