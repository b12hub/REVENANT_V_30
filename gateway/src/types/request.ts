// src/types/request.ts
//
// Centralizes the FastifyRequest type augmentations so the TypeScript
// compiler recognizes these custom properties globally across the entire
// gateway, regardless of file import order.

import type { TenantContext } from './tenant';
import type { TraceContext } from '../middleware/tracePropagation';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    tenantContext?: TenantContext;
    traceContext?: TraceContext;
    redactedText?: string;
  }
}