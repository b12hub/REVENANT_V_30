// src/middleware/circuitBreaker.ts
//
// Recommended Fastify hook stage: `onRequest` — runs before body parsing,
// before auth, before everything. If the region is down, we want to reject
// in the cheapest possible way, before spending any cycles on work that's
// going to be thrown away anyway.
//
// Local-cache design note: this caches exactly ONE key (region status).
// `lru-cache` exists to manage eviction across *many* keys under memory
// pressure — pulling it in for a single cached value is a dependency with
// no job to do. A plain module-scoped variable with a timestamp is the
// simplest correct tool here, not a corner cut.

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

export type RegionStatus = 'HEALTHY' | 'OPEN';

const REGION_STATUS_KEY = 'revenant:region:status';
const LOCAL_CACHE_TTL_MS = 250;

interface CacheEntry {
  status: RegionStatus;
  cachedAt: number;
}

/**
 * Parses whatever string Redis returns into a known RegionStatus, defaulting
 * unrecognized/missing values to OPEN rather than HEALTHY. This is the one
 * place in this file that fails CLOSED rather than open — a malformed or
 * unexpected value in the status key itself is a signal something's wrong
 * with the upstream writer, not a reason to assume the region is fine.
 */
function parseRegionStatus(raw: string | null): RegionStatus {
  return raw === 'HEALTHY' ? 'HEALTHY' : 'OPEN';
}

export function createCircuitBreakerHook(
  redisClient: Redis,
  logger: { warn: (msg: string, meta?: Record<string, unknown>) => void } = console,
) {
  let cache: CacheEntry | null = null;

  return async function circuitBreakerHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const now = Date.now();

    // Hot path: cache hit. No Redis round-trip, no await on anything real —
    // this is the branch that has to clear in well under 5ms, and it does,
    // because it's just a timestamp comparison and a property read.
    if (cache !== null && now - cache.cachedAt < LOCAL_CACHE_TTL_MS) {
      if (cache.status === 'OPEN') {
        reply.code(503).send({
          error: 'REGION_CIRCUIT_OPEN',
          message: 'This region is currently unavailable. Retry shortly or via regional failover.',
        });
        return;
      }
      return; // HEALTHY — fall through to the next hook.
    }

    // Cache miss or expired — refresh from Redis. At sustained traffic this
    // runs at most 4 times per second total, regardless of request volume,
    // because every request in between serves from the cache above.
    try {
      const raw = await redisClient.get(REGION_STATUS_KEY);
      const status = parseRegionStatus(raw);
      cache = { status, cachedAt: now };

      if (status === 'OPEN') {
        reply.code(503).send({
          error: 'REGION_CIRCUIT_OPEN',
          message: 'This region is currently unavailable. Retry shortly or via regional failover.',
        });
        return;
      }
      return;
    } catch (err) {
      // Redis itself being unreachable does NOT mean the banking region is
      // down — those are two different infrastructure layers. Failing
      // closed here would mean a transient Redis blip takes down ALL
      // traffic, which is a strictly worse outcome than briefly serving
      // requests with stale-but-probably-still-correct status info.
      logger.warn('Circuit breaker Redis read failed; falling back', {
        error: err instanceof Error ? err.message : String(err),
      });

      if (cache !== null) {
        // Serve the stale value rather than guessing — "last known good,
        // even if a bit old" beats "assume healthy with zero information."
        if (cache.status === 'OPEN') {
          reply.code(503).send({
            error: 'REGION_CIRCUIT_OPEN',
            message: 'This region is currently unavailable. Retry shortly or via regional failover.',
          });
          return;
        }
        return;
      }

      // True cold start with Redis simultaneously down: no prior data to
      // fall back on at all. Fail open rather than reject every request on
      // a brand-new process's very first cache miss.
      return;
    }
  };
}