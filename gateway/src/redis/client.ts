// src/redis/client.ts
//
// Redis connectivity for the Gateway's hot path (rate limiting, short-lived
// caching). Built on ioredis.
//
// Terminology note worth being precise about: ioredis does not implement
// "connection pooling" in the sense a SQL client does (one physical
// connection per logical Redis instance, multiplexed via command
// pipelining — that's how Redis clients normally work, and adding a pool on
// top of a single Redis instance buys nothing). What this file actually
// implements is a small pool of N independent ioredis clients, round-robined
// across — which is the real, useful version of "pooling" for a
// high-throughput rate-limiting hot path: it spreads command queuing across
// multiple TCP connections instead of funneling everything through one.

import Redis, { RedisOptions } from 'ioredis';

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  tls: boolean;
  poolSize: number;
  maxRetriesPerRequest: number;
  connectTimeoutMs: number;
}

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// Console-backed default so this module is usable standalone before a real
// structured logger is wired up in a later part of the build.
const consoleLogger: Logger = {
  info: (message, meta) => console.info(`[redis] ${message}`, meta ?? {}),
  warn: (message, meta) => console.warn(`[redis] ${message}`, meta ?? {}),
  error: (message, meta) => console.error(`[redis] ${message}`, meta ?? {}),
};

/**
 * Reads Redis configuration from environment variables with safe defaults.
 * Throws at startup rather than at first use if required values are missing
 * or malformed — failing fast during boot beats failing silently mid-request.
 */
export function loadRedisConfigFromEnv(): RedisConfig {
  const host = process.env.REDIS_HOST;
  const portRaw = process.env.REDIS_PORT ?? '6379';
  const poolSizeRaw = process.env.REDIS_POOL_SIZE ?? '4';

  if (!host) {
    throw new Error('REDIS_HOST is required and was not set.');
  }

  const port = Number.parseInt(portRaw, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`REDIS_PORT must be a valid port number, got "${portRaw}".`);
  }

  const poolSize = Number.parseInt(poolSizeRaw, 10);
  if (!Number.isInteger(poolSize) || poolSize < 1) {
    throw new Error(`REDIS_POOL_SIZE must be a positive integer, got "${poolSizeRaw}".`);
  }

  return {
    host,
    port,
    password: process.env.REDIS_PASSWORD,
    tls: process.env.REDIS_TLS === 'true',
    poolSize,
    maxRetriesPerRequest: Number.parseInt(process.env.REDIS_MAX_RETRIES_PER_REQUEST ?? '3', 10),
    connectTimeoutMs: Number.parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS ?? '10000', 10),
  };
}

/**
 * Exponential backoff with a hard ceiling. Returning `null` from ioredis's
 * retryStrategy tells it to stop retrying entirely — we deliberately never
 * do that here, because for a rate-limiter/cache dependency, "keep trying
 * forever at a bounded interval" is the right failure posture: the Gateway
 * should degrade (e.g. fail-open on rate limiting) rather than treat a
 * transient Redis blip as fatal to the process.
 */
function buildRetryStrategy(): (attempt: number) => number {
  const baseDelayMs = 200;
  const maxDelayMs = 10_000;
  return (attempt: number): number => {
    const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    return delay;
  };
}

export class RedisPool {
  private readonly clients: Redis[];
  private cursor = 0;
  private readonly logger: Logger;

  constructor(config: RedisConfig, logger: Logger = consoleLogger) {
    this.logger = logger;
    this.clients = Array.from({ length: config.poolSize }, (_, index) =>
      this.createClient(config, index),
    );
  }

  private createClient(config: RedisConfig, index: number): Redis {
    const options: RedisOptions = {
      host: config.host,
      port: config.port,
      password: config.password,
      tls: config.tls ? {} : undefined,
      maxRetriesPerRequest: config.maxRetriesPerRequest,
      connectTimeout: config.connectTimeoutMs,
      retryStrategy: buildRetryStrategy(),
      // Reconnect on READONLY errors too — relevant if this ever points at
      // a Redis replica that gets promoted/demoted during a failover.
      reconnectOnError: (err: Error): boolean => err.message.includes('READONLY'),
    };

    const client = new Redis(options);
    this.attachListeners(client, index);
    return client;
  }

  private attachListeners(client: Redis, index: number): void {
    client.on('connect', () => {
      this.logger.info('Redis client connected', { poolIndex: index });
    });

    client.on('ready', () => {
      this.logger.info('Redis client ready', { poolIndex: index });
    });

    client.on('error', (err: Error) => {
      this.logger.error('Redis client error', { poolIndex: index, error: err.message });
    });

    client.on('reconnecting', (delayMs: number) => {
      this.logger.warn('Redis client reconnecting', { poolIndex: index, delayMs });
    });

    client.on('close', () => {
      this.logger.warn('Redis client connection closed', { poolIndex: index });
    });

    client.on('end', () => {
      this.logger.warn('Redis client connection ended permanently', { poolIndex: index });
    });
  }

  /** Round-robin client selection — spreads load evenly across the pool. */
  public getClient(): Redis {
    const client = this.clients[this.cursor];
    this.cursor = (this.cursor + 1) % this.clients.length;
    return client;
  }

  /** Returns true only if every client in the pool responds to PING. */
  public async healthCheck(): Promise<boolean> {
    try {
      const results = await Promise.all(this.clients.map((client) => client.ping()));
      return results.every((result) => result === 'PONG');
    } catch {
      return false;
    }
  }

  /** Graceful shutdown — call from a SIGTERM/SIGINT handler before exit. */
  public async disconnect(): Promise<void> {
    await Promise.all(
      this.clients.map(async (client, index) => {
        try {
          await client.quit();
        } catch (err) {
          this.logger.warn('Error during graceful Redis disconnect, forcing close', {
            poolIndex: index,
            error: err instanceof Error ? err.message : String(err),
          });
          client.disconnect();
        }
      }),
    );
  }
}