import { z } from 'zod';

export const ChannelSchema = z.enum(['TELEGRAM', 'VOICE', 'WEB', 'API']);
export type Channel = z.infer<typeof ChannelSchema>;

const TextPayloadSchema = z
  .object({
    type: z.literal('TEXT'),
    text: z.string().min(1).max(4096),
  })
  .strict();

const VoicePayloadSchema = z
  .object({
    type: z.literal('VOICE'),
    audio_ref: z.string().min(1).max(512),
    duration_ms: z.number().int().positive().max(600_000),
    mime_type: z.string().min(1).max(128),
  })
  .strict();

export const IngressPayloadSchema = z.discriminatedUnion('type', [
  TextPayloadSchema,
  VoicePayloadSchema,
]);
export type IngressPayload = z.infer<typeof IngressPayloadSchema>;

const TraceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'trace_id may contain only alphanumerics, hyphens, and underscores');

const CustomerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, 'customer_id contains unsupported characters');

const SessionIdSchema = z.string().min(1).max(128);

const IdempotencyKeySchema = z.string().uuid();

export const IngressSchema = z
  .object({
    trace_id: TraceIdSchema.optional(),
    customer_id: CustomerIdSchema,
    session_id: SessionIdSchema,
    channel: ChannelSchema,
    idempotency_key: IdempotencyKeySchema,
    client_timestamp_utc: z.string().datetime().optional(),
    payload: IngressPayloadSchema,
  })
  .strict();

export type IngressRequest = z.infer<typeof IngressSchema>;