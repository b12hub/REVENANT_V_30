// =============================================================================
// REVENANT V31 — F5
// schedule-cron.ts — registers a Temporal Schedule that replaces the n8n
// "Schedule Trigger" node (`triggerAtHour: 9`). Run once to (re)create it.
//
// Not one of the three required deliverables — included for completeness.
// =============================================================================

import { Connection, ScheduleClient } from '@temporalio/client';
import { DailyNudgeCronWorkflow } from './workflows';
import { TASK_QUEUE } from './worker';

async function main() {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const scheduleClient = new ScheduleClient({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });

  await scheduleClient.create({
    scheduleId: 'revenant-f5-daily-nudges',
    spec: {
      // Every day at 09:00, matching the legacy `triggerAtHour: 9` cron.
      calendars: [{ hour: 9, minute: 0 }],
    },
    action: {
      type: 'startWorkflow',
      workflowType: DailyNudgeCronWorkflow,
      args: [{}],
      taskQueue: TASK_QUEUE,
      workflowId: 'revenant-f5-daily-nudges-run',
    },
    policies: {
      // Each day's cursor-paginated cron should fully drain (via
      // continueAsNew) before the next day's run starts.
      overlap: 'SKIP',
    },
  });

  console.log('Registered Temporal Schedule: revenant-f5-daily-nudges');
  await connection.close();
}

main().catch((err) => {
  console.error('Failed to register schedule:', err);
  process.exit(1);
});