import { closeDb, db } from './db.js';
import { prepareDatabase } from './db/prepare.js';
import { jobs } from './jobs/registry.js';
import { JobRunner } from './jobs/runner.js';
import { logger } from './logger.js';

/**
 * The background worker: Shopify and PostEx syncs, reconciliation, alerts. It serves no HTTP;
 * the web service does that. Both may start at once: migrations and job runs are lock-protected.
 */
const sql = db();
if (!sql) {
  logger.fatal('DATABASE_URL is not set; the worker has nothing to do without a database');
  process.exit(1);
}

try {
  await prepareDatabase();
} catch (error) {
  logger.fatal({ err: error }, 'Database preparation failed; not starting');
  await closeDb().catch(() => {});
  process.exit(1);
}

const runner = new JobRunner(sql, logger.child({ component: 'worker' }));
for (const job of jobs) runner.register(job);
runner.start();

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Worker shutting down; letting running jobs finish');
  await runner.stop();
  await closeDb().catch((err: unknown) => logger.error({ err }, 'Error while closing the database'));
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
// A job's own errors are caught by the runner; these are bugs outside any job. Log them and keep
// the scheduler alive rather than dropping every other job.
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection in worker'));
