// src/middleware/rateLimiter.ts
//
// Recommended Fastify hook stage: `preHandler`, registered AFTER
// authTenant.ts's preValidation hook — so `request.tenantContext` is
// already populated (or definitively absent, if auth failed/was skipped)
// by the time this runs.
//
// Multi-tenancy correctness fix on the literal spec: keying purely by
// `customer:{customer_id}` is wrong in a multi-tenant gateway. Each tenant
// owns its own customer-numbering scheme (see ingress.schema.ts's comment
// on CustomerIdSchema) — Bank A's customer "12345" and Bank B's customer
// "12345" are different people who would otherwise share one rate-limit
// bucket. The key is tenant-scoped: `customer:{tenant_id}:{customer_id}`.
// The anonymous `ip:{ip}` key deliberately stays global, NOT tenant-scoped
// — the same physical IP hammering multiple tenants' webhook endpoints is
// still one abuse source worth catching across all of them together.

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import type { IngressRequest } from '../schemas/ingress.schema';
import '../types/request'; // Import the global augmentations

const POINTS_PER_WINDOW = 100;
const WINDOW_DURATION_SECONDS = 60;
const BLOCK_DURATION_SECONDS = 5 * 60;

export function createRateLimiterHook(redisClient: Redis) {
  // One fixed client for the limiter's lifetime, not pulled round-robin
  // from a pool per call — rate-limiter-flexible binds storeClient at
  // construction and the actual counters live in Redis itself (shared
  // state), so connection identity doesn't affect correctness, only
  // unnecessary churn would be avoided by not re-resolving it per request.
  const limiter = new RateLimiterRedis({
    storeClient: redisClient,
    keyPrefix: 'rl',
    points: POINTS_PER_WINDOW,
    duration: WINDOW_DURATION_SECONDS,
    blockDuration: BLOCK_DURATION_SECONDS,
  });

  function resolveKey(request: FastifyRequest<{ Body: IngressRequest }>): string {
    if (request.tenantContext) {
      const tenantId = request.tenantContext.registry.tenant_id;
      const customerId = request.body?.customer_id;
      if (customerId) {
        return `customer:${tenantId}:${customerId}`;
      }
    }
    return `ip:${request.ip}`;
  }

  return async function rateLimiterHook(
    request: FastifyRequest<{ Body: IngressRequest }>,
    reply: FastifyReply,
  ): Promise<void> {
    const key = resolveKey(request);

    try {
      await limiter.consume(key);
    } catch (err) {
      if (err instanceof RateLimiterRes) {
        // Genuine rate-limit rejection — this is the intended 429 path.
        reply
          .code(429)
          .header('Retry-After', Math.ceil(err.msBeforeNext / 1000).toString())
          .send({
            error: 'RATE_LIMIT_EXCEEDED',
            retryAfterMs: err.msBeforeNext,
          });
        return;
      }

      // Anything else here is an infrastructure failure (Redis unreachable,
      // etc.), not a rate-limit decision. Same philosophy as the circuit
      // breaker: a Redis blip should not block all banking traffic. Log and
      // fail open rather than reject every request because the rate
      // limiter's own backend hiccuped.
      request.log?.warn?.(
        { error: err instanceof Error ? err.message : String(err) },
        'Rate limiter backend error; failing open',
      );
      return;
    }
  };
}