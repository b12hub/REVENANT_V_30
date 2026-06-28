// src/temporal/activities.ts

import { ApplicationFailure } from '@temporalio/activity';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import {
  type CreditActivityDependencies,
  type CreditEligibilityResult,
  type CreditBureauProfile,
} from '../types.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// checkEligibility — the merged, reusable Activity requirement #3 calls
// for by name. Combines Block 4.5 (bureau lookup) and Block 4.6 (threshold
// decision) into ONE Activity deliberately: re-checking thresholds without
// re-pulling bureau data would miss a customer who got blacklisted in the
// interim; re-pulling data without re-applying thresholds is pointless.
// Calling this twice (initial + post-signal) is what "re-validate, don't
// duplicate the logic" actually means in practice.
// ---------------------------------------------------------------------------

const AUTO_REJECT_SCORE_CEILING = 600;
const AUTO_REJECT_DBR_FLOOR = 50;
const AUTO_APPROVE_MAX_AMOUNT_UZS = 5_000_000;
const AUTO_APPROVE_MIN_SCORE = 700;
const AUTO_APPROVE_DBR_CEILING = 40;

function evaluateThresholds(
  profile: CreditBureauProfile,
  requestedAmountUzs: number,
): CreditEligibilityResult {
  // Order preserved EXACTLY from Block 4.6's own explicit comment:
  // AUTO_REJECT evaluated first, unconditionally, so no approve-side
  // threshold can ever mask a disqualifying factor.
  if (
    profile.creditScore < AUTO_REJECT_SCORE_CEILING ||
    profile.dbr > AUTO_REJECT_DBR_FLOOR ||
    profile.fraudFlag ||
    profile.blacklistStatus
  ) {
    const triggers: string[] = [];
    if (profile.creditScore < AUTO_REJECT_SCORE_CEILING) triggers.push('CREDIT_SCORE_BELOW_600');
    if (profile.dbr > AUTO_REJECT_DBR_FLOOR) triggers.push('DBR_ABOVE_50');
    if (profile.fraudFlag) triggers.push('FRAUD_FLAG_TRUE');
    if (profile.blacklistStatus) triggers.push('BLACKLIST_STATUS_TRUE');
    return { status: 'AUTO_REJECT', reason: triggers.join(', '), profile };
  }

  if (
    requestedAmountUzs <= AUTO_APPROVE_MAX_AMOUNT_UZS &&
    profile.creditScore >= AUTO_APPROVE_MIN_SCORE &&
    profile.dbr < AUTO_APPROVE_DBR_CEILING
  ) {
    return { status: 'AUTO_APPROVE', reason: 'PASSED_AUTO_APPROVE_THRESHOLDS', profile };
  }

  const reasons: string[] = [];
  if (requestedAmountUzs > AUTO_APPROVE_MAX_AMOUNT_UZS) reasons.push('AMOUNT_ABOVE_5M_OR_INVALID');
  if (profile.creditScore < AUTO_APPROVE_MIN_SCORE) reasons.push('SCORE_BELOW_700');
  if (profile.dbr >= AUTO_APPROVE_DBR_CEILING) reasons.push('DBR_AT_OR_ABOVE_40');
  return {
    status: 'REQUIRES_HITL',
    reason: reasons.length > 0 ? reasons.join(', ') : 'BORDERLINE_PROFILE',
    profile,
  };
}

// ---------------------------------------------------------------------------
// Signature token claims schema — validated AFTER jose has already proven
// the signature itself is genuine. Same division of labor established for
// P2P: cryptographic validity is jose's job; claim-shape validity is this
// schema's job.
// ---------------------------------------------------------------------------

const SignatureClaimsSchema = z
  .object({
    sub: z.string().min(1),
    customerId: z.string().min(1),
    amountUzs: z.number().int().positive(),
  })
  .passthrough();

export interface CreditActivities {
  checkEligibility(input: { customerEmail: string; requestedAmountUzs: number }): Promise<CreditEligibilityResult>;
  resolveDisbursementAccount(customerId: string): Promise<string>;
  issueSignatureToken(input: {
    workflowId: string;
    customerId: string;
    amountUzs: number;
  }): Promise<{ signedToken: string }>;
  dispatchSignatureRequest(input: {
    workflowId: string;
    telegramChatId: string;
    amountUzs: number;
    signedToken: string;
  }): Promise<void>;
  dispatchHitlPendingNotice(input: { workflowId: string; telegramChatId: string }): Promise<void>;
  verifySignatureToken(
    rawToken: string,
    expectedWorkflowId: string,
  ): Promise<{ customerId: string; amountUzs: number }>;
  executeDisbursement(input: {
    traceId: string;
    customerId: string;
    creditAccountId: string;
    amountUzs: number;
  }): Promise<{ transactionId: string; providerReference: string }>;
}

/**
 * Signature TTL: 24 hours, reusing the EXACT constant this platform's own
 * Callback Rehydration Protocol already established for SIGN_LOAN
 * specifically ("contract consideration period, but still bounded") —
 * not a fresh choice made for this file in isolation.
 */
const SIGNATURE_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export function createCreditActivities(deps: CreditActivityDependencies): CreditActivities {
  return {
    async checkEligibility(input): Promise<CreditEligibilityResult> {
      const identityKey = input.customerEmail.trim().toLowerCase();
      let bureauData;
      try {
        bureauData = await deps.bureauClient.lookupByIdentity(identityKey);
      } catch (err) {
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'Credit bureau lookup failed.',
          type: 'PROVIDER_UNAVAILABLE',
          nonRetryable: false,
        });
      }

      const profile: CreditBureauProfile = { ...bureauData, identityKey };
      return evaluateThresholds(profile, input.requestedAmountUzs);
    },

    async resolveDisbursementAccount(customerId): Promise<string> {
      try {
        return await deps.accountDirectory.resolveCreditDisbursementAccount(customerId);
      } catch (err) {
        // If the directory explicitly throws a 'NOT_FOUND' code, it's a definitive data problem.
        // Otherwise, it might be a transient database timeout, which we SHOULD allow Temporal to retry.
        const code = (err as { code?: string } | undefined)?.code;
        if (code === 'NOT_FOUND') {
          throw ApplicationFailure.create({
            message: `No disbursement account on file for customer ${customerId}.`,
            type: 'CONFIGURATION_ERROR',
            nonRetryable: true,
          });
        }

        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'Account directory lookup failed.',
          type: 'PROVIDER_UNAVAILABLE',
          nonRetryable: false, // Allow Temporal to retry transient DB errors
        });
      }
    },

    async issueSignatureToken(input): Promise<{ signedToken: string }> {
      const jwt = await new SignJWT({
        customerId: input.customerId,
        amountUzs: input.amountUzs,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(input.workflowId)
        .setIssuedAt()
        .setExpirationTime(`${SIGNATURE_TOKEN_TTL_SECONDS}s`)
        .sign(deps.signatureSecretKey);

      return { signedToken: `SIGN_LOAN|${jwt}` };
    },

    async dispatchSignatureRequest(input): Promise<void> {
      try {
        await deps.notifier.sendSignatureRequest(
          { workflowId: input.workflowId, telegramChatId: input.telegramChatId, amountUzs: input.amountUzs },
          input.signedToken,
        );
      } catch (err) {
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'Failed to dispatch signature request.',
          type: 'PROVIDER_UNAVAILABLE',
          nonRetryable: false,
        });
      }
    },

    async dispatchHitlPendingNotice(input): Promise<void> {
      try {
        await deps.notifier.sendHitlPendingNotice(input);
      } catch (err) {
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'Failed to dispatch HITL pending notice.',
          type: 'PROVIDER_UNAVAILABLE',
          nonRetryable: false,
        });
      }
    },

    async verifySignatureToken(rawToken, expectedWorkflowId): Promise<{ customerId: string; amountUzs: number }> {
      // Strip the "SIGN_LOAN|" prefix the same way Block 5.0 did, before
      // handing the remainder to jose — the prefix is a callback-routing
      // marker, not part of the JWT itself.
      const jwtPortion = rawToken.startsWith('SIGN_LOAN|') ? rawToken.slice('SIGN_LOAN|'.length) : rawToken;

      let verifiedClaims: unknown;
      try {
        const { payload } = await jwtVerify(jwtPortion, deps.signatureSecretKey);
        verifiedClaims = payload;
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) {
          // This IS the TTL enforcement the old flow never had at all —
          // not a tightening of an existing check, a wholly new one.
          throw ApplicationFailure.create({
            message: 'Signature token has expired.',
            type: 'CALLBACK_VERIFICATION_FAILED',
            nonRetryable: true,
          });
        }
        throw ApplicationFailure.create({
          message: 'Signature token is invalid or has been tampered with.',
          type: 'CALLBACK_VERIFICATION_FAILED',
          nonRetryable: true,
        });
      }

      const parsed = SignatureClaimsSchema.safeParse(verifiedClaims);
      if (!parsed.success) {
        throw ApplicationFailure.create({
          message: 'Signature token claims do not match the expected shape.',
          type: 'CALLBACK_VERIFICATION_FAILED',
          nonRetryable: true,
        });
      }

      if (parsed.data.sub !== expectedWorkflowId) {
        throw ApplicationFailure.create({
          message: 'Signature token subject does not match this credit application.',
          type: 'CALLBACK_VERIFICATION_FAILED',
          nonRetryable: true,
        });
      }

      return { customerId: parsed.data.customerId, amountUzs: parsed.data.amountUzs };
    },

    async executeDisbursement(input): Promise<{ transactionId: string; providerReference: string }> {
      // Per the explicit "lessons learned" rule: a transport/network
      // failure here is NEVER caught and returned as a failure object —
      // it propagates as a thrown ApplicationFailure, which is the only
      // way Temporal's retry policy (configured in workflows.ts, capped
      // at maximumAttempts: 2 per requirement #4) actually triggers.
      // There is no try/catch around the call below for that exact reason.
      const result = await deps.coreBankingClient.executeDisbursement({
        traceId: input.traceId,
        customerId: input.customerId,
        creditAccountId: input.creditAccountId,
        amountUzs: input.amountUzs,
      });
      return result;
    },
  };
}