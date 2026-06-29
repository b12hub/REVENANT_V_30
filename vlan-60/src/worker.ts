// =============================================================================
// REVENANT V31 — F5
// worker.ts — bootstraps a Temporal Worker that polls a task queue and
// executes both Workflows and Activities defined in this service.
//
// Not one of the three required deliverables, but included so the service is
// runnable end-to-end. Safe to delete if you wire Workflows/Activities into
// an existing multi-service Worker instead.
// =============================================================================

import { Worker } from '@temporalio/worker';
import * as activities from './activities';

export const TASK_QUEUE = 'revenant-f5-nudges';

async function run() {
  const worker = await Worker.create({
    workflowsPath: require.resolve('./workflows'),
    activities,
    taskQueue: TASK_QUEUE,
    // Tune per Activity group's expected concurrency. The LLM and Telegram
    // activities are network-bound, not CPU-bound, so a generous slot count
    // is safe even on modest hardware.
    maxConcurrentActivityTaskExecutions: 50,
  });

  await worker.run();
}

run().catch((err) => {
  console.error('REVENANT F5 worker failed to start:', err);
  process.exit(1);
});