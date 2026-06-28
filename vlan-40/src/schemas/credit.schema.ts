// src/schemas/credit.schema.ts
//
// gRPC int64 coercion lesson applied: requested_amount_uzs is int64 on the
// wire, which @grpc/proto-loader hands to Node as a STRING to avoid
// precision loss above Number.MAX_SAFE_INTEGER. `.coerce.number()` runs
// BEFORE `.int()`/`.positive()` for exactly this reason — applying those
// validators to a raw string would fail every request, not just malformed
// ones, since a string never satisfies `.int()` on its own.

import { z } from 'zod';
import { randomUUID } from 'node:crypto';

function optionalProtoString(generateDefault: () => string) {
  return z.string().transform((value) => (value === '' ? generateDefault() : value));
}

const RequiredNonEmptyString = (fieldName: string) =>
  z.string().min(1, `${fieldName} is required and must not be empty.`);

const CREDIT_MAX_AMOUNT_UZS = 50_000_000; // reusing this platform's established P2P ceiling — no separate credit-specific ceiling has been established elsewhere

export const CreditApplicationRequestSchema = z
  .object({
    traceId: optionalProtoString(randomUUID),
    tenantId: RequiredNonEmptyString('tenantId'),
    // customerId is REQUIRED with no fallback — direct fix for the old
    // flow's 'CUST-001' / 'UNKNOWN_CUST_ID' placeholder defaults.
    customerId: RequiredNonEmptyString('customerId'),
    // customerEmail may legitimately be empty — see types.ts's
    // CreditBureauClient comment: an unknown identity resolves to a
    // fail-closed UNKNOWN_PROFILE (guaranteed AUTO_REJECT), which is a
    // correct business outcome, not a malformed request.
    customerEmail: z.string().trim().toLowerCase().default(''),
    requestedAmountUzs: z.coerce
      .number()
      .int('requestedAmountUzs must be a whole number of UZS.')
      .positive('requestedAmountUzs must be greater than zero.')
      .max(CREDIT_MAX_AMOUNT_UZS, `requestedAmountUzs exceeds the platform ceiling of ${CREDIT_MAX_AMOUNT_UZS} UZS.`),
  })
  .strict();

export type ValidatedCreditApplicationRequest = z.infer<typeof CreditApplicationRequestSchema>;

export function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}