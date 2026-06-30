/**
 * activities.ts
 * * Defines the contract for activities executed by the IVR workflow.
 */

import type { ExtractedIntent, SignedIdentityContext } from './ivr-types.js';

export interface AuthorizationResult {
  success: boolean;
  transactionToken?: string;
  errorReason?: string;
}

export interface Activities {
  /**
   * Evaluates the intent, validates the biometric identity claims,
   * and dispatches the execution to the appropriate backend Trunk (P2P or Bill-Pay).
   */
  authorizeAndExecuteTransaction(
    sessionId: string,
    intent: ExtractedIntent,
    identity: SignedIdentityContext
  ): Promise<AuthorizationResult>;
}

// Mock implementation for local testing
export async function authorizeAndExecuteTransaction(
  sessionId: string,
  intent: ExtractedIntent,
  identity: SignedIdentityContext
): Promise<AuthorizationResult> {
  console.log(`[Activity] Authorizing ${intent.intentName} for user ${identity.customerId}`);

  // Simulate network delay to Core Banking
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Mock a successful transaction
  return {
    success: true,
    transactionToken: `TXN-${Date.now()}`
  };
}