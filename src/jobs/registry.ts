import type { JobDefinition } from './runner.js';

/**
 * Every background job the worker runs. Sync jobs are added here by the tasks that build them;
 * until then the worker runs only the heartbeat, which proves the scheduler, the lock and
 * sync_runs end to end.
 */
export const jobs: JobDefinition[] = [
  {
    name: 'system.heartbeat',
    // Hourly: often enough to see the worker is alive, rare enough not to keep Neon awake (risk R3).
    schedule: { everyMs: 60 * 60 * 1000 },
    handler: async ({ sql }) => {
      const startedAt = Date.now();
      await sql`select 1`;
      return { databaseMs: Date.now() - startedAt };
    },
  },
];
