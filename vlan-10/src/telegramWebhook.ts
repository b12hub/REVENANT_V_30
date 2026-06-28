import { Request, Response, Router } from 'express';
import { Client as TemporalClient } from '@temporalio/client';
import { confirmP2PSignal } from './workflows';
/**
 * Creates an Express router that handles the Telegram callback webhook.
 * The JWT is decoded only to extract the workflowId – signature verification
 * is intentionally left to a gateway (API Gateway or Telegram Bot API).
 */
export function createTelegramWebhookRouter(temporalClient: TemporalClient): Router {
  const router = Router();

  router.post('/telegram/confirm', async (req: Request, res: Response) => {
    try {
      const { callback_data } = req.body;

      if (!callback_data || typeof callback_data !== 'string') {
        return res.status(400).json({ error: 'Missing callback_data' });
      }

      // Verify prefix matches the contract established in Phase 2 Activities
      if (!callback_data.startsWith('CONFIRM_P2P|')) {
        return res.status(400).json({ error: 'Invalid callback action payload format' });
      }

      // Isolate the raw JWT string from the action prefix
      const rawToken = callback_data.split('|')[1];
      if (!rawToken) {
        return res.status(400).json({ error: 'Malformed callback token wrapper' });
      }

      // Extract the workflowId securely for routing execution
      const payload = unsafeJwtDecode(rawToken);
      const workflowId = payload.sub;

      if (!workflowId) {
        return res.status(400).json({ error: 'No workflowId in token subject' });
      }

      // Signal the running workflow with the isolated token (Activities handle the validation)
      const handle = temporalClient.workflow.getHandle(workflowId);
      await handle.signal(confirmP2PSignal, { rawToken });

      return res.json({ status: 'CONFIRMATION_RECEIVED' });
    } catch (err) {
      console.error('Telegram webhook processing failure:', err instanceof Error ? err.message : err);
      return res.status(500).json({ error: 'Internal server error processing callback' });
    }
  });

  return router;
}

/**
 * Decode the payload of a JWT without verifying the signature.
 * This is acceptable only for routing purposes; the workflow itself will
 * validate the token cryptographically before acting.
 */
function unsafeJwtDecode(token: string): { sub?: string } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
  return JSON.parse(payload);
}