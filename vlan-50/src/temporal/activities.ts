// src/temporal/activities.ts

import { createHmac } from 'node:crypto';
import { ApplicationFailure } from '@temporalio/activity';
import * as QRCode from 'qrcode';
import type {
  MerchantActivityDependencies,
  MerchantVerificationResult,
  PosWebhookHttpRequest,
} from '../types.js';

// ---------------------------------------------------------------------------
// Alias resolution — ported from Block 3.6's resolveMerchantAlias, with the
// in-memory object-key scan replaced by a DB lookup. Structured alias is
// tried first and preferred; free-text fallback only runs if no structured
// alias was supplied, exactly mirroring the old node's own preference order.
// ---------------------------------------------------------------------------

const AMOUNT_MAX_UZS = 50_000_000; // reusing this platform's established ceiling; no separate merchant-specific limit has been established elsewhere

export interface MerchantActivities {
  verifyMerchantAndAmount(input: {
    merchantAlias?: string;
    rawTicketText?: string;
    amountUzs: number;
  }): Promise<MerchantVerificationResult>;
  generateCheckoutQr(input: { merchantId: string; amountUzs: number; traceId: string }): Promise<{
    imageBuffer: Buffer;
    mimeType: string;
  }>;
  buildAndSignPosNotification(input: {
    canonicalMerchantId: string;
    traceId: string;
    amountUzs: number;
  }): Promise<{ url: string; body: Record<string, unknown>; signatureHex: string }>;
  firePosWebhook(input: {
    url: string;
    body: Record<string, unknown>;
    signatureHex: string;
  }): Promise<void>;
  notifyCustomerPaymentConfirmed(input: { telegramChatId: string; traceId: string; amountUzs: number }): Promise<void>;
}

export function createMerchantActivities(deps: MerchantActivityDependencies): MerchantActivities {
  return {
    async verifyMerchantAndAmount(input): Promise<MerchantVerificationResult> {
      let record;
      try {
        if (input.merchantAlias) {
          record = await deps.registryStore.findByAlias(input.merchantAlias.toLowerCase());
        } else if (input.rawTicketText) {
          record = await deps.registryStore.findByFreeText(input.rawTicketText);
        } else {
          record = null;
        }
      } catch (err) {
        // Genuine transport/DB failure — throws, per the established
        // lesson: a returned failure object here would look like a
        // successful Activity execution to Temporal and silently skip
        // the retry policy configured in workflows.ts.
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'Merchant registry lookup failed.',
          type: 'PROVIDER_UNAVAILABLE',
          nonRetryable: false,
        });
      }

      const amountValid = Number.isFinite(input.amountUzs) && input.amountUzs > 0 && input.amountUzs <= AMOUNT_MAX_UZS;

      const errors: string[] = [];
      if (!record) {
        errors.push('MERCHANT_NOT_FOUND');
      } else if (record.status !== 'ACTIVE') {
        errors.push(`MERCHANT_${record.status}`);
      }
      if (!amountValid) {
        errors.push('INVALID_CHECKOUT_AMOUNT');
      }

      if (errors.length > 0 || !record) {
        return { outcome: 'INVALID', reason: errors.join(', ') };
      }

      return { outcome: 'VERIFIED', record, amountUzs: input.amountUzs };
    },

    async generateCheckoutQr(input): Promise<{ imageBuffer: Buffer; mimeType: string }> {
      // Self-hosted, in-process generation — requirement #1, satisfied by
      // construction: there is no network call here AT ALL to fail or to
      // depend on a third party for, unlike the old api.qrserver.com call.
      const checkoutUrl = `https://checkout.revenant.bank.uz/pay?merchant=${encodeURIComponent(
        input.merchantId,
      )}&amount=${input.amountUzs}&trace=${encodeURIComponent(input.traceId)}`;

      try {
        const imageBuffer = await QRCode.toBuffer(checkoutUrl, {
          type: 'png',
          width: 250, // matches the old node's requested 250x250 size
          errorCorrectionLevel: 'M',
        });
        return { imageBuffer, mimeType: 'image/png' };
      } catch (err) {
        // QR encoding can genuinely fail (e.g. a URL exceeding the format's
        // capacity at the chosen error-correction level) — this is a
        // deterministic, definitive failure for a given input, not a
        // transient one worth retrying with the same arguments.
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'QR code generation failed.',
          type: 'VALIDATION_ERROR',
          nonRetryable: true,
        });
      }
    },

    async buildAndSignPosNotification(input): Promise<{ url: string; body: Record<string, unknown>; signatureHex: string }> {
      // Re-fetched by canonical ID, fresh, immediately before signing —
      // deliberately NOT reusing the record from verifyMerchantAndAmount
      // earlier in the workflow. Same "don't trust a carried-forward
      // snapshot, fetch fresh near the point of use" principle this
      // platform has applied consistently (the Callback Rehydration
      // Protocol, Credit's re-validation step) — here protecting against
      // a webhook secret or endpoint that rotated in the window between
      // QR generation and the customer actually paying.
      let record;
      try {
        record = await deps.registryStore.findByCanonicalId(input.canonicalMerchantId);
      } catch (err) {
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'Merchant registry re-lookup failed.',
          type: 'PROVIDER_UNAVAILABLE',
          nonRetryable: false,
        });
      }

      if (!record) {
        // The merchant existed at validation time but doesn't now — a
        // genuine, if rare, definitive configuration problem. Not worth
        // retrying against the same (now-absent) record.
        throw ApplicationFailure.create({
          message: `Merchant ${input.canonicalMerchantId} not found at notification-build time.`,
          type: 'CONFIGURATION_ERROR',
          nonRetryable: true,
        });
      }

      const body: Record<string, unknown> = {
        trace_id: input.traceId,
        amount: input.amountUzs,
        status: 'SUCCESS',
        timestamp: new Date().toISOString(),
      };

      // Real HMAC-SHA256, per requirement #3 — directly replacing the old
      // nested-FNV-1a construction. See the conversational note above for
      // why that construction wasn't actually cryptographically sound
      // despite incorporating the secret.
      const signatureHex = createHmac('sha256', record.sharedSecret).update(JSON.stringify(body)).digest('hex');

      return { url: record.webhookEndpoint, body, signatureHex };
    },

    async firePosWebhook(input): Promise<void> {
      const request: PosWebhookHttpRequest = {
        url: input.url,
        headers: {
          'X-Revenant-Signature': input.signatureHex,
          'Content-Type': 'application/json',
        },
        body: input.body,
        timeoutMs: 8000, // matches the old node's configured timeout exactly
      };

      try {
        await deps.webhookClient.send(request);
      } catch (err) {
        // Throws, not caught-and-returned — Temporal's retry policy
        // (workflows.ts, moderate/exponential per requirement #4) is what
        // decides whether and how to try again.
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'POS webhook delivery failed.',
          type: 'PROVIDER_UNAVAILABLE',
          nonRetryable: false,
        });
      }
    },

    async notifyCustomerPaymentConfirmed(input): Promise<void> {
      try {
        await deps.customerNotifier.sendPaymentConfirmation(input);
      } catch (err) {
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'Customer payment-confirmation notice failed to send.',
          type: 'PROVIDER_UNAVAILABLE',
          nonRetryable: false,
        });
      }
    },
  };
}