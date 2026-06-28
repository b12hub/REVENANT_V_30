import { z } from 'zod';

const NormalizedUzPhoneSchema = z
  .string()
  .regex(/^998\d{9}$/, 'Phone must be exactly "998" followed by 9 digits.');

const P2P_MAX_AMOUNT_UZS = 50_000_000;
const AmountUzsSchema = z
  .number()
  .int('Amount must be a whole number of UZS.')
  .positive('Amount must be greater than zero.')
  .max(P2P_MAX_AMOUNT_UZS, `Amount exceeds the P2P ceiling of ${P2P_MAX_AMOUNT_UZS} UZS.`);

export const P2PTransferRequestSchema = z
  .object({
    phone: NormalizedUzPhoneSchema,
    amountUzs: AmountUzsSchema,
    rawRecipientText: z.string().max(256),
  })
  .strict();

export type P2PTransferRequestPayload = z.infer<typeof P2PTransferRequestSchema>;

export const P2PConfirmationClaimsSchema = z
  .object({
    sub: z.string().min(1), 
    phone: NormalizedUzPhoneSchema,
    amountUzs: AmountUzsSchema,
  })
  .passthrough(); 

export type P2PConfirmationClaims = z.infer<typeof P2PConfirmationClaimsSchema>;

export const RawP2PConfirmationSignalSchema = z
  .object({
    rawToken: z.string().min(1),
    telegramUserId: z.number().int(),
    pressedAtEpochMs: z.number().int().positive(),
  })
  .strict();

export type RawP2PConfirmationSignal = z.infer<typeof RawP2PConfirmationSignalSchema>;
