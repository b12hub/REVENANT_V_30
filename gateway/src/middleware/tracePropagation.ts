// src/middleware/tracePropagation.ts
//
// Recommended Fastify hook stage: `onRequest` — alongside/immediately after
// the circuit breaker, and before everything else, so every subsequent log
// line and error in this request's lifecycle can carry a trace ID from the
// start.
//
// Honesty note on the OpenTelemetry integration: this hook does two things,
// not one, deliberately. It (1) sets an OTel SpanContext as the active
// context via `context.with()`, which lets any OTel-auto-instrumented
// library (an instrumented gRPC client, for instance) pick up the trace
// automatically — and (2) ALSO attaches the plain trace-id/span-id strings
// directly onto `request.traceContext` for explicit, manual propagation.
// The second mechanism is the one this hook actually guarantees. Whether
// AsyncLocalStorage-based context correctly survives every hop through
// Fastify's hook chain into a downstream gRPC call depends on instrumentation
// wiring this file can't fully control from here — for something where
// "did the trace ID actually make it downstream" needs to be a guarantee,
// not a hope, manual propagation via `request.traceContext` is the
// mechanism to actually rely on. Treat the OTel context-setting as a bonus
// for instrumented libraries, not as the load-bearing propagation path.

import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { context, trace, TraceFlags, type SpanContext } from '@opentelemetry/api';

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: string; // raw 2-hex-char flags, as received or generated
  sampled: boolean;
}

import '../types/request'; // Import the global augmentations

const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ALL_ZERO_TRACE_ID = '0'.repeat(32);
const ALL_ZERO_SPAN_ID = '0'.repeat(16);

function generateTraceId(): string {
  return randomBytes(16).toString('hex'); // 128 bits = 32 hex chars
}

function generateSpanId(): string {
  return randomBytes(8).toString('hex'); // 64 bits = 16 hex chars
}

/**
 * Parses an incoming `traceparent` header per the W3C Trace Context spec.
 * Returns null for anything invalid — including the spec-mandated invalid
 * cases (version 0xff, all-zero trace-id, all-zero parent-id) — rather
 * than null only for a malformed string. An all-zero trace-id is not a
 * different kind of valid trace; the spec is explicit that it's invalid.
 */
function parseTraceparent(header: string): TraceContext | null {
  const match = TRACEPARENT_PATTERN.exec(header.trim());
  if (!match) return null;

  const [, version, traceId, spanId, flags] = match;

  if (version.toLowerCase() === 'ff') return null;
  if (traceId.toLowerCase() === ALL_ZERO_TRACE_ID) return null;
  if (spanId.toLowerCase() === ALL_ZERO_SPAN_ID) return null;

  const flagsByte = Number.parseInt(flags, 16);
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    traceFlags: flags.toLowerCase(),
    sampled: (flagsByte & 0x01) === 1,
  };
}

function generateTraceContext(): TraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    traceFlags: '01',
    sampled: true,
  };
}

export async function tracePropagationHook(request: FastifyRequest): Promise<void> {
  const headerValue = request.headers['traceparent'];
  const parsed = typeof headerValue === 'string' ? parseTraceparent(headerValue) : null;

  // On a continued trace, the incoming span becomes this request's PARENT —
  // this request gets its own new span-id while keeping the same trace-id,
  // which is correct W3C Trace Context semantics (each hop mints a new
  // span, not a copy of the one it received).
  const resolved: TraceContext = parsed
    ? { ...parsed, spanId: generateSpanId() }
    : generateTraceContext();

  request.traceContext = resolved;

  const spanContext: SpanContext = {
    traceId: resolved.traceId,
    spanId: resolved.spanId,
    traceFlags: resolved.sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: parsed !== null,
  };

  const ctxWithSpan = trace.setSpanContext(context.active(), spanContext);
  // Synchronous extent only, per the honesty note above — this benefits any
  // OTel-instrumented code called directly within this tick, but
  // `request.traceContext` above remains the propagation mechanism this
  // file actually guarantees for gRPC metadata construction downstream.
  context.with(ctxWithSpan, () => undefined);
}