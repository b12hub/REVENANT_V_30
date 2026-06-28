// src/types/trace.ts
export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: string;
  sampled: boolean;
}