// src/server.ts
//
// Process entrypoint: builds the app, starts listening, wires up graceful
// shutdown. This is the only file in the three parts that's allowed to
// call process.exit or bind a port.

import { buildApp } from './app';
import { RedisPool, loadRedisConfigFromEnv } from './redis/client';
import { initializeAllVlanClients, closeAllVlanClients } from './grpc/dispatch';
import type { IngressRequest } from './schemas/ingress.schema';
import type { TenantRegistryData } from './types/tenant';

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function fetchTenantSecretStub(
  tenantId: string,
): Promise<{ secret: string; registry: TenantRegistryData; vaultTokenRef: string }> {
  // Placeholder — real implementation resolves this tenant's secret and
  // registry record from Vault + the tenant registry table. Left as an
  // explicit stub rather than faked-realistic code, since pretending this
  // works without the actual Vault client wired in would be worse than
  // an honest gap.
  throw new Error(`fetchTenantSecretStub not implemented — cannot resolve tenant ${tenantId}.`);
}

async function classifyIntentStub(_request: IngressRequest): Promise<string> {
  // Placeholder — real implementation calls the upstream classification
  // service. Same honesty note as above.
  throw new Error('classifyIntentStub not implemented.');
}

async function main(): Promise<void> {
  const redisConfig = loadRedisConfigFromEnv();
  const redisPool = new RedisPool(redisConfig);

  // gRPC clients are constructed eagerly at boot, not lazily on first
  // request — a missing VLAN_*_GRPC_ADDR environment variable should fail
  // the process at startup, not surface as a mysterious 502 on whichever
  // VLAN happens to receive the first real request after deploy.
  initializeAllVlanClients();

  const app = buildApp({
    redisPool,
    fetchTenantSecret: fetchTenantSecretStub,
    classifyIntent: classifyIntentStub,
  });

  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  await app.listen({ host: '0.0.0.0', port });

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'Shutdown signal received, draining gracefully');

    const forceExitTimer = setTimeout(() => {
      app.log.error('Graceful shutdown exceeded timeout — forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      // Order matters: stop accepting new work and drain in-flight HTTP
      // requests FIRST. Only once Fastify has finished draining do we tear
      // down the resources those in-flight requests might still be using —
      // closing Redis/gRPC first would fail requests that were already
      // legitimately in progress.
      await app.close();
      await redisPool.disconnect();
      closeAllVlanClients();

      clearTimeout(forceExitTimer);
      app.log.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      clearTimeout(forceExitTimer);
      app.log.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fatal error during server startup:', err);
  process.exit(1);
});