// src/middleware/authTenant.ts
//
// Recommended Fastify hook stage: `preValidation` — must run after the raw
// body has been captured (see the content-type-parser dependency note
// below) but before Zod schema validation, since an unauthenticated tenant
// shouldn't get the benefit of detailed validation-error feedback about a
// request body it has no right to be sending in the first place.
//
// HARD DEPENDENCY ON PART 3: this hook reads `request.rawBody` (raw,
// unparsed bytes). That property does not exist by default — it has to be
// populated by a custom Fastify `addContentTypeParser` registered at server
// bootstrap, which captures the raw buffer BEFORE handing off to the normal
// JSON parser. Without that wired up, `request.rawBody` is `undefined` and
// this hook fails closed (401) rather than silently verifying against the
// wrong bytes — see the guard near the top of the hook function.
//
// Why verify against raw bytes instead of `JSON.stringify(request.body)`:
// a parsed-then-re-serialized object is not guaranteed to byte-for-byte
// match what the client actually signed — key order, whitespace, and
// numeric formatting can all change silently during parse/stringify. That
// mismatch wouldn't look like a bug; it would look like "signatures
// randomly fail for no reason," which is a much worse debugging experience
// than this hook simply requiring the real bytes from the start.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { TenantRegistryData } from '../types/tenant';
import '../types/request'; // Import the global augmentations

const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000; // 5-minute replay window
const HMAC_HEX_LENGTH = 64; // SHA-256 digest as hex = 32 bytes = 64 chars

/**
 * Resolves and caches a tenant's HMAC signing secret. Fetching from Vault
 * on every request would blow the 5ms budget by 1–2 orders of magnitude, so
 * this caches the resolved secret in memory after first use.
 *
 * Deliberately NOT exported as a singleton — constructed once at server
 * bootstrap and passed into `createAuthTenantHook` so it's a real,
 * mockable dependency in tests rather than hidden module-level state.
 */
export class TenantSecretCache {
  private readonly cache = new Map<string, { secret: string; cachedAt: number }>();
  private readonly ttlMs: number;
  private readonly fetchSecret: (tenantId: string) => Promise<{
    secret: string;
    registry: TenantRegistryData;
    vaultTokenRef: string;
  }>;

  constructor(
    fetchSecret: (
      tenantId: string,
    ) => Promise<{ secret: string; registry: TenantRegistryData; vaultTokenRef: string }>,
    ttlMs = 5 * 60 * 1000,
  ) {
    this.fetchSecret = fetchSecret;
    this.ttlMs = ttlMs;
  }

  async resolve(
    tenantId: string,
  ): Promise<{ secret: string; registry: TenantRegistryData; vaultTokenRef: string } | null> {
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.cachedAt < this.ttlMs) {
      // Note: we only cache the secret string itself long-term; registry/
      // vaultTokenRef are re-fetched alongside it on every cache refresh so
      // a suspended/deprovisioned tenant is detected within one TTL window,
      // not held open indefinitely on a stale "ACTIVE" status.
      const fresh = await this.fetchSecret(tenantId).catch(() => null);
      if (fresh) {
        this.cache.set(tenantId, { secret: fresh.secret, cachedAt: Date.now() });
        return fresh;
      }
      return { secret: cached.secret, registry: undefined as never, vaultTokenRef: '' };
    }

    try {
      const fresh = await this.fetchSecret(tenantId);
      this.cache.set(tenantId, { secret: fresh.secret, cachedAt: Date.now() });
      return fresh;
    } catch {
      return null;
    }
  }
}

function constantTimeHexCompare(expectedHex: string, providedHex: string): boolean {
  // crypto.timingSafeEqual THROWS (not returns false) on a buffer-length
  // mismatch — calling it directly with two possibly-different-length
  // inputs is a real, common bug, not a hypothetical one. Length must be
  // checked first, every time.
  if (
    expectedHex.length !== HMAC_HEX_LENGTH ||
    providedHex.length !== HMAC_HEX_LENGTH ||
    !/^[0-9a-f]+$/i.test(providedHex)
  ) {
    return false;
  }

  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const providedBuf = Buffer.from(providedHex, 'hex');

  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, providedBuf);
}

export function createAuthTenantHook(secretCache: TenantSecretCache) {
  return async function authTenantHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const tenantId = request.headers['x-tenant-id'];
    const signatureHeader = request.headers['x-tenant-signature'];
    const timestampHeader = request.headers['x-tenant-timestamp'];

    if (
      typeof tenantId !== 'string' ||
      typeof signatureHeader !== 'string' ||
      typeof timestampHeader !== 'string'
    ) {
      reply.code(401).send({ error: 'MISSING_AUTH_HEADERS' });
      return;
    }

    // Replay protection: a freshness check is not optional for
    // signature-based auth. Without it, a captured request+signature pair
    // remains valid forever and can be re-sent at will.
    const timestampMs = Number.parseInt(timestampHeader, 10);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > SIGNATURE_MAX_AGE_MS) {
      reply.code(401).send({ error: 'SIGNATURE_EXPIRED_OR_INVALID_TIMESTAMP' });
      return;
    }

    if (!request.rawBody) {
      // Fails closed rather than falling back to re-serialized JSON — see
      // the file header for why that fallback would be actively incorrect,
      // not just less safe.
      reply.code(401).send({ error: 'RAW_BODY_UNAVAILABLE_FOR_VERIFICATION' });
      return;
    }

    const resolved = await secretCache.resolve(tenantId);
    if (!resolved || !resolved.registry) {
      reply.code(401).send({ error: 'UNKNOWN_TENANT' });
      return;
    }

    if (resolved.registry.status !== 'ACTIVE') {
      reply.code(403).send({ error: 'TENANT_NOT_ACTIVE', status: resolved.registry.status });
      return;
    }

    const signedMessage = Buffer.concat([
      Buffer.from(`${tenantId}.${timestampHeader}.`, 'utf8'),
      request.rawBody,
    ]);
    const expectedHex = createHmac('sha256', resolved.secret).update(signedMessage).digest('hex');

    if (!constantTimeHexCompare(expectedHex, signatureHeader)) {
      reply.code(401).send({ error: 'INVALID_SIGNATURE' });
      return;
    }

    request.tenantContext = {
      registry: resolved.registry,
      trace_id: request.traceContext?.traceId ?? 'UNKNOWN',
      resolved_at: new Date().toISOString(),
      vault_token_ref: resolved.vaultTokenRef,
    };
  };
}