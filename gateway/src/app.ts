// src/app.ts
//
// Builds and configures the Fastify instance WITHOUT starting it listening
// — kept separate from server.ts specifically so integration tests can
// build a fully-wired app and inject requests without binding a real port.

import Fastify, { type FastifyInstance } from 'fastify';
import { IngressSchema, type IngressRequest } from './schemas/ingress.schema';
import { RedisPool } from './redis/client';
import { createCircuitBreakerHook } from './middleware/circuitBreaker';
import { TenantSecretCache, createAuthTenantHook } from './middleware/authTenant';
import { createRateLimiterHook } from './middleware/rateLimiter';
import { piiRedactionHook } from './middleware/piiRedaction';
import { tracePropagationHook } from './middleware/tracePropagation';
import { dispatchToVlan } from './grpc/dispatch';
import type { TenantRegistryData } from './types/tenant';

export interface AppDependencies {
  redisPool: RedisPool;
  fetchTenantSecret: (
    tenantId: string,
  ) => Promise<{ secret: string; registry: TenantRegistryData; vaultTokenRef: string }>;
  /** Classifier is an external dependency injected here, not implemented in this file. */
  classifyIntent: (request: IngressRequest) => Promise<string>;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      // Defense-in-depth redaction at the pino serializer level. The
      // application-level PII redaction in piiRedactionHook is the real,
      // intentional logging path (see the dedicated log line in the
      // /ingress handler below) — this `redact` config exists so that ANY
      // other code path that accidentally logs a full request object
      // (an uncaught-error serializer, a misplaced debug log added later)
      // still cannot leak raw PII or tenant secrets into log output. Two
      // independent layers, not one relying on the other.
      redact: {
        paths: ['req.body', 'req.headers.authorization', 'req.headers["x-tenant-signature"]'],
        censor: '[REDACTED]',
      },
    },
  });

  // Raw-body capture: registered BEFORE any route, applies to the JSON
  // content type globally. Stores the untouched buffer on request.rawBody
  // (consumed by authTenant.ts for HMAC verification) and ALSO performs the
  // actual JSON.parse this app needs — one parser doing both jobs, so the
  // raw bytes and the parsed object are guaranteed to correspond to the
  // exact same request, not two independent re-reads of the body stream.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      request.rawBody = body;
      try {
        const parsed = body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
        done(null, parsed);
      } catch (err) {
        done(err instanceof Error ? err : new Error('Invalid JSON body'), undefined);
      }
    },
  );

  const tenantSecretCache = new TenantSecretCache(deps.fetchTenantSecret);
  const circuitBreakerHook = createCircuitBreakerHook(deps.redisPool.getClient());
  const authTenantHook = createAuthTenantHook(tenantSecretCache);
  const rateLimiterHook = createRateLimiterHook(deps.redisPool.getClient());

  // onRequest — Tracing, then Circuit Breaker. See the header note above
  // this response for why this order, not the literal Tenant-first order,
  // is the one that's actually correct given what each hook depends on.
  app.addHook('onRequest', tracePropagationHook);
  app.addHook('onRequest', circuitBreakerHook);

  // preValidation — Tenant Auth (needs rawBody, already captured by the
  // content-type parser by this point), then explicit Zod validation.
  app.addHook('preValidation', authTenantHook);
  app.addHook('preValidation', async (request, reply) => {
    const result = IngressSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: 'VALIDATION_ERROR',
        trace_id: request.traceContext?.traceId,
        issues: result.error.issues,
      });
      return reply;
    }
    // Replace the loosely-typed parsed body with the Zod-narrowed,
    // strictly-typed value — every hook running after this point can rely
    // on request.body actually matching IngressRequest, not just "JSON
    // that happened to parse."
    request.body = result.data;
  });

  // preHandler — Rate Limiter (needs tenantContext, set above), then PII
  // Redaction (needs the validated body, also set above).
  app.addHook('preHandler', rateLimiterHook);
  app.addHook('preHandler', piiRedactionHook);

  app.post<{ Body: IngressRequest }>('/ingress', async (request, reply) => {
    // The dedicated, intentional audit-log line for this request — logs
    // the REDACTED text, never request.body directly. This is the layer
    // that's supposed to carry real visibility; the pino `redact` config
    // above is the safety net behind it, not a substitute for it.
    request.log.info(
      {
        trace_id: request.traceContext?.traceId,
        tenant_id: request.tenantContext?.registry.tenant_id,
        redacted_text: request.redactedText,
      },
      'ingress request received',
    );

    const intent = await deps.classifyIntent(request.body);
    const outcome = await dispatchToVlan(request, intent);

    switch (outcome.kind) {
      case 'SUCCESS':
        reply.code(200).send(outcome.result);
        return;
      case 'DEADLINE_EXCEEDED':
        reply.code(504).send({
          error: 'DOWNSTREAM_TIMEOUT',
          vlan: outcome.vlanTarget,
          timeout_ms: outcome.timeoutMs,
        });
        return;
      case 'GRPC_ERROR':
        reply.code(502).send({
          error: 'DOWNSTREAM_ERROR',
          vlan: outcome.vlanTarget,
          grpc_status_code: outcome.grpcStatusCode,
        });
        return;
    }
  });

  return app;
}