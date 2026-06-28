import { Worker } from '@temporalio/worker';
import { createP2PActivities } from './activities';

class MockIdempotencyStore {
  async check(key: string) { return null; }
  async save(key: string, result: any) {}
}
class MockTelegramNotifier {
  async sendConfirmationRequest(params: any) { console.log('Mock Telegram Notification Dispatched', params); }
}
import { HttpCbuClient } from './cbuClient';
import { MockCoreBankingClient } from './coreBankingClient';

import type { P2PActivityDependencies } from './types';


/**
 * Create and run a Temporal Worker that polls the `p2p-transfer-queue`.
 * All external clients and stores are instantiated here and injected
 * into the activity dependencies.
 */
async function main() {
  // ----- Concrete dependencies -----
  const cbuClient = new HttpCbuClient();
  const coreBankingClient = new MockCoreBankingClient();

  // Compose into a single dependencies object matching the Activities' context
  const dependencies: P2PActivityDependencies = {
    cbuClient,
    coreBankingClient,
    idempotencyStore: new MockIdempotencyStore() as any,
    telegramNotifier: new MockTelegramNotifier() as any,
    confirmationSecretKey: Buffer.from(process.env.JWT_SECRET || 'dev-secret-key-revenant-32-bytes-long'),
    confirmationTtlMinutes: 5,
  };

  const worker = await Worker.create({
    workflowsPath: require.resolve('./workflows'),
    activities: createP2PActivities(dependencies),
    taskQueue: 'p2p-transfer-queue',
  });

  // ----- Register Shutdown Listeners BEFORE Blocking Run Engine -----
  // This ensures signals are trapped while the async loop is active.
  const handleShutdown = async (signal: string) => {
    console.log(`Received ${signal}. Draining worker connections gracefully...`);
    try {
      await worker.shutdown();
      console.log('Worker context drained completely. Exiting clean.');
      process.exit(0);
    } catch (shutdownError) {
      console.error('Error encountered during explicit worker drain:', shutdownError);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void handleShutdown('SIGTERM'));
  process.on('SIGINT', () => void handleShutdown('SIGINT'));

  console.log('Starting P2P Transfer Worker...');
  await worker.run();
}

main().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});