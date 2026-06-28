import { ApplicationFailure } from '@temporalio/activity';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import {
  type P2PActivityDependencies,
  type CbuAccountResolution,
  type ConfirmationPromptRequest,
} from './types';
import { P2PConfirmationClaimsSchema } from './schemas/p2p.schema';

const INJECTION_PATTERN = /ignore|override|system|developer|cmd|exec|must|should/gi;
const HARD_NAME_LIMIT = 50;

function sanitizeAccountHolderName(rawName: string): string {
  const stripped = rawName
    .replace(INJECTION_PATTERN, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[<>{}[\]`]/g, '')
    .trim();
  return stripped.slice(0, HARD_NAME_LIMIT);
}

export interface P2PActivities {
  resolveCbuPhoneToAccount(phone: string): Promise<CbuAccountResolution>;
  sanitizeRecipientName(rawName: string): Promise<string>;
  dispatchConfirmationPrompt(
    request: ConfirmationPromptRequest,
  ): Promise<{ signedCallbackData: string }>;
  verifyConfirmationCallback(
    rawToken: string,
    expectedWorkflowId: string,
  ): Promise<{ phone: string; amountUzs: number }>;
  checkIdempotency(idempotencyKey: string): Promise<{ isDuplicate: boolean; existingTransactionId?: string }>;
  executeTransfer(input: {
    idempotencyKey: string;
    senderCustomerId: string;
    recipientMaskedAccount: string;
    amountUzs: number;
  }): Promise<{ transactionId: string; providerReference: string }>;
}

export function createP2PActivities(deps: P2PActivityDependencies): P2PActivities {
  return {
    async resolveCbuPhoneToAccount(phone: string): Promise<CbuAccountResolution> {
      try {
        return await deps.cbuClient.resolvePhoneToAccount(phone);
      } catch (err) {
        const code = (err as { code?: string } | undefined)?.code;
        if (code === 'PHONE_NOT_REGISTERED') {
          throw ApplicationFailure.create({
            message: `Phone ${phone} is not registered.`,
            type: 'PHONE_NOT_REGISTERED',
            nonRetryable: true,
          });
        }
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'CBU phone resolution failed.',
          type: 'PROVIDER_TIMEOUT',
          nonRetryable: false,
        });
      }
    },

    async sanitizeRecipientName(rawName: string): Promise<string> {
      return sanitizeAccountHolderName(rawName);
    },

    async dispatchConfirmationPrompt(
      request: ConfirmationPromptRequest,
    ): Promise<{ signedCallbackData: string }> {
      const expiresInSeconds = deps.confirmationTtlMinutes * 60;

      const jwt = await new SignJWT({
        phone: request.phone,
        amountUzs: request.amountUzs,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(request.workflowId)
        .setIssuedAt()
        .setExpirationTime(`${expiresInSeconds}s`)
        .sign(deps.confirmationSecretKey);

      const signedCallbackData = `CONFIRM_P2P|${jwt}`;

      try {
        await deps.telegramNotifier.sendConfirmationPrompt(request, signedCallbackData);
      } catch (err) {
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'Failed to dispatch Telegram prompt.',
          type: 'PROVIDER_UNAVAILABLE',
          nonRetryable: false, 
        });
      }

      return { signedCallbackData };
    },

    async verifyConfirmationCallback(
      rawToken: string,
      expectedWorkflowId: string,
    ): Promise<{ phone: string; amountUzs: number }> {
      let verifiedClaims: unknown;

      try {
        const { payload } = await jwtVerify(rawToken, deps.confirmationSecretKey);
        verifiedClaims = payload;
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) {
          throw ApplicationFailure.create({
            message: 'Confirmation token has expired.',
            type: 'CALLBACK_VERIFICATION_FAILED',
            nonRetryable: true, 
          });
        }
        throw ApplicationFailure.create({
          message: 'Confirmation token signature is invalid.',
          type: 'CALLBACK_VERIFICATION_FAILED',
          nonRetryable: true, 
        });
      }

      const parsed = P2PConfirmationClaimsSchema.safeParse(verifiedClaims);
      if (!parsed.success) {
        throw ApplicationFailure.create({
          message: 'Confirmation token claims do not match the expected shape.',
          type: 'CALLBACK_VERIFICATION_FAILED',
          nonRetryable: true,
        });
      }

      if (parsed.data.sub !== expectedWorkflowId) {
        throw ApplicationFailure.create({
          message: 'Confirmation token subject does not match this transfer.',
          type: 'CALLBACK_VERIFICATION_FAILED',
          nonRetryable: true,
        });
      }

      return { phone: parsed.data.phone, amountUzs: parsed.data.amountUzs };
    },

    async checkIdempotency(
      idempotencyKey: string,
    ): Promise<{ isDuplicate: boolean; existingTransactionId?: string }> {
      try {
        const result = await deps.idempotencyStore.checkAndReserve(idempotencyKey);
        return { isDuplicate: result.isDuplicate, existingTransactionId: result.existingTransactionId };
      } catch (err) {
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'Idempotency check failed.',
          type: 'PROVIDER_TIMEOUT',
          nonRetryable: false, 
        });
      }
    },

    async executeTransfer(input): Promise<{ transactionId: string; providerReference: string }> {
      try {
        const result = await deps.coreBankingClient.executeP2PTransfer({
          idempotencyKey: input.idempotencyKey,
          senderCustomerId: input.senderCustomerId,
          recipientMaskedAccount: input.recipientMaskedAccount,
          amountUzs: input.amountUzs,
        });
        return result;
      } catch (err) {
        const code = (err as { code?: string } | undefined)?.code;
        if (code === 'INSUFFICIENT_FUNDS' || code === 'ACCOUNT_CLOSED') {
          throw ApplicationFailure.create({
            message: err instanceof Error ? err.message : 'Transfer execution definitively failed.',
            type: 'LEDGER_FAILURE',
            nonRetryable: true,
          });
        }
        throw ApplicationFailure.create({
          message: err instanceof Error ? err.message : 'Transfer execution failed.',
          type: 'PROVIDER_TIMEOUT',
          nonRetryable: false,
        });
      }
    },
  };
}
