// src/middleware/piiRedaction.ts
//
// Recommended Fastify hook stage: `preHandler` — must run AFTER Zod schema
// validation has produced a typed, narrowed `IngressRequest` body. Running
// this any earlier means working against an unvalidated, untyped body.
//
// Deliberate design choice: this NEVER overwrites `request.body`. The
// original text (e.g. a recipient's real phone number for an actual P2P
// transfer) is exactly the data downstream business logic legitimately
// needs in unredacted form — masking it in place would silently break
// transaction processing, not just logging. Redaction output goes into a
// separate `request.redactedText` field, used only for logs/SIEM/forensic
// trails, leaving the real request body completely untouched.

import type { FastifyRequest } from 'fastify';
import type { IngressRequest } from '../schemas/ingress.schema';
import '../types/request'; // Import the global augmentations

// Order is deliberate: most specific/longest pattern first. A 16-digit PAN
// must be fully consumed before the looser phone pattern ever sees it, or
// a card number gets partially mis-tagged as a phone number.

// 16 digits, with an optional space or hyphen permitted after any digit —
// covers grouped ("4111 1111 1111 1111"), hyphenated, and ungrouped forms
// in one pattern rather than several alternatives.
const PAN_PATTERN = /\b(?:\d[ -]?){15}\d\b/g;

// Uzbek national format first (matches this project's own established
// "+998 (90) 123-45-67" convention exactly), generic international as a
// fallback for any other format that shows up in free text.
const UZ_PHONE_PATTERN = /\+?998[\s.-]?\(?\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}\b/g;
const GENERIC_PHONE_PATTERN = /\+?\d{1,3}?[\s.-]?\(?\d{2,4}\)?(?:[\s.-]?\d{2,4}){2,3}\b/g;

// Uzbek biometric passport format: two Latin letters followed by 7 digits
// (e.g. "AA1234567"). Both patterns below use bounded quantifiers only —
// no nested unbounded repetition — so none of these are vulnerable to
// catastrophic backtracking on adversarial input.
const UZ_PASSPORT_PATTERN = /\b[A-Za-z]{2}\d{7}\b/g;

function redactPan(text: string): string {
  return text.replace(PAN_PATTERN, (match) => {
    const digitsOnly = match.replace(/\D/g, '');
    const last4 = digitsOnly.slice(-4);
    return `[PAN_REDACTED:${last4}]`;
  });
}

function redactPhones(text: string): string {
  return text.replace(UZ_PHONE_PATTERN, '[PHONE_REDACTED]').replace(GENERIC_PHONE_PATTERN, '[PHONE_REDACTED]');
}

function redactPassports(text: string): string {
  return text.replace(UZ_PASSPORT_PATTERN, '[PASSPORT_REDACTED]');
}

/**
 * Pure function, exported separately from the hook itself so it's directly
 * unit-testable without constructing a Fastify request object.
 */
export function redactPii(rawText: string): string {
  // Bracketed tags rather than asterisk-masking deliberately: a tag like
  // "[PAN_REDACTED:1111]" can't be ambiguously re-matched by a later pass
  // (e.g. mistaken for a phone number), and it's directly greppable in log
  // tooling/SIEM queries — "count PAN exposure events" becomes a literal
  // string search instead of a regex reconstruction exercise.
  return redactPassports(redactPhones(redactPan(rawText)));
}

export async function piiRedactionHook(
  request: FastifyRequest<{ Body: IngressRequest }>,
): Promise<void> {
  const { payload } = request.body;

  if (payload.type !== 'TEXT') {
    // VOICE payloads carry only an audio_ref at this stage — there is no
    // text to redact yet (transcription, if any, happens downstream).
    return;
  }

  request.redactedText = redactPii(payload.text);
}