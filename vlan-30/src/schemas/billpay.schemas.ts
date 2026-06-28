// src/schemas/billpay.schema.ts
//
// The proto3-empty-string fix, applied precisely — see the conversational
// note for which fields get it and, just as importantly, which don't.

import { z } from 'zod';
import { randomUUID } from 'node:crypto';

/**
 * Proto3 has no wire-level distinction between "field explicitly set to
 * its zero value" and "field never set" — both deserialize identically.
 * For a string field, the zero value is "". So a caller that never set
 * trace_id at all produces the exact same JS value (`""`) as a caller who
 * (incorrectly) set it to an empty string on purpose.
 *
 * `.min(1)` alone would reject BOTH of those as a validation failure. For
 * trace_id specifically, that's wrong — "caller didn't supply one" is the
 * NORMAL case (most callers won't generate their own), and there's a
 * perfectly good default (generate one). This helper treats the proto3
 * zero-value as "not provided" and substitutes a default, rather than
 * treating wire-level absence as a client error.
 */
function optionalProtoString(generateDefault: () => string) {
  return z.string().transform((value) => (value === '' ? generateDefault() : value));
}

/**
 * provider_code, identifier, tenant_id, customer_id deliberately do NOT
 * get this treatment. An empty provider_code isn't "the caller didn't
 * specify a default provider" — there IS no default provider. Same logic
 * for identifier (no default account/phone/INN), tenant_id, and
 * customer_id (no default bank, no default customer). For these four,
 * proto3's empty-string zero-value really does mean "this request is
 * malformed," and `.min(1)` is correctly doing exactly the job it looks
 * like it's doing.
 */
const RequiredNonEmptyString = (fieldName: string) =>
  z.string().min(1, `${fieldName} is required and must not be empty.`);

const BILLPAY_MAX_AMOUNT_UZS = 50_000_000; // carried forward from this platform's established P2P ceiling — bill-pay has no documented separate ceiling of its own, so reusing the known-safe one rather than inventing an unbounded default

export const BillPayRequestSchema = z
  .object({
    traceId: optionalProtoString(randomUUID),
    tenantId: RequiredNonEmptyString('tenantId'),
    customerId: RequiredNonEmptyString('customerId'),
    providerCode: RequiredNonEmptyString('providerCode'),
    identifier: RequiredNonEmptyString('identifier'),
    amountUzs: z
      .number()
      .int('amountUzs must be a whole number.')
      // Note: int64's proto3 zero-value is 0, and 0 is correctly rejected
      // by .positive() below on its own merits — no special-casing needed
      // here the way string fields required above. A genuinely-zero
      // amount and an unset amount are the same wrong thing for a bill
      // payment: there's nothing to pay.
      .positive('amountUzs must be greater than zero.')
      .max(BILLPAY_MAX_AMOUNT_UZS, `amountUzs exceeds the platform ceiling of ${BILLPAY_MAX_AMOUNT_UZS} UZS.`),
  })
  .strict();

export type ValidatedBillPayRequest = z.infer<typeof BillPayRequestSchema>;

export function formatValidationIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}