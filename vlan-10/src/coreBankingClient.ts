import type { CoreBankingClient, CoreBankingExecutionRequest, CoreBankingExecutionResult } from './types';

class LedgerError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export class MockCoreBankingClient implements CoreBankingClient {
  /**
   * Reserve funds in the sender’s account.
   * Throws { code: 'INSUFFICIENT_FUNDS' } or { code: 'ACCOUNT_CLOSED' }.
   */
  async executeP2PTransfer(request: CoreBankingExecutionRequest): Promise<CoreBankingExecutionResult> {
    // Simulate balance check logic using the masked account or other available data
    if (request.recipientMaskedAccount.includes('9999')) {
      throw new LedgerError(`Insufficient funds for account ${request.recipientMaskedAccount}`, 'INSUFFICIENT_FUNDS');
    }

    if (request.recipientMaskedAccount.includes('0000')) {
      throw new LedgerError(`Account closed: ${request.recipientMaskedAccount}`, 'ACCOUNT_CLOSED');
    }

    // Mock successful execution
    return {
      transactionId: `tx-${Date.now()}`,
      providerReference: `bank-ref-${request.idempotencyKey.slice(0, 8)}`,
    };
  }

  async executeTransfer(params: { transferId: string }): Promise<void> {
    // Final debit/credit – mock always succeeds
    console.log(`[CoreBanking] Executed transfer ${params.transferId}`);
  }

  async releaseFunds(params: { transferId: string }): Promise<void> {
    // Compensation – release hold
    console.log(`[CoreBanking] Released hold for transfer ${params.transferId}`);
  }
}