import { prDetectJob } from '../domain/pr.js';
import { postexJob } from './postex.js';
import { payoutsJob } from './postex-payouts.js';
import { reconciliationJob } from './reconciliation.js';
import type { JobDefinition } from './runner.js';
import { shopifyJobs } from './shopify.js';
import { catchupJob } from './shopify-catchup.js';

/**
 * Every background job the worker runs. Sync jobs are added here by the tasks that build them;
 * the heartbeat proves the scheduler, the lock and sync_runs end to end on its own.
 */
export const jobs: JobDefinition[] = [
  {
    name: 'system.heartbeat',
    // Hourly: often enough to see the worker is alive, rare enough not to keep Neon awake (risk R3).
    schedule: { everyMs: 60 * 60 * 1000, alignToClock: true },
    handler: async ({ sql }) => {
      const startedAt = Date.now();
      await sql`select 1`;
      return { databaseMs: Date.now() - startedAt };
    },
  },
  ...shopifyJobs,
  catchupJob,
  postexJob,
  payoutsJob,
  reconciliationJob,
  prDetectJob,
];
