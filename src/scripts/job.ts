/**
 * Runs one background job once, now, and exits.
 * Run with: npm run job -- <name>        (npm run job with no name lists the jobs)
 *
 * Exit codes: 0 succeeded, 1 failed, 2 unknown job or bad usage, 3 skipped because the job is
 * already running in another process.
 */
import { closeDb, db } from '../db.js';
import { jobs } from '../jobs/registry.js';
import { JobRunner, UnknownJobError, exitCodeFor } from '../jobs/runner.js';
import { logger } from '../logger.js';

const run = async (name: string | undefined): Promise<number> => {
  const sql = db();
  if (!sql) {
    console.error('DATABASE_URL is not set');
    return 2;
  }
  const runner = new JobRunner(sql, logger);
  for (const job of jobs) runner.register(job);

  if (!name) {
    console.error(`Usage: npm run job -- <name>\nJobs: ${runner.names.join(', ')}`);
    return 2;
  }

  try {
    const result = await runner.runJobOnce(name);
    const detail = result.error ? ` — ${result.error}` : '';
    console.log(`${result.job} (${result.accountRef}): ${result.status} in ${result.durationMs} ms ${JSON.stringify(result.stats)}${detail}`);
    return exitCodeFor(result);
  } catch (error) {
    if (error instanceof UnknownJobError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
};

run(process.argv[2])
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
    process.exit();
  });
