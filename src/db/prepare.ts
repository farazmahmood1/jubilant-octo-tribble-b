import { config } from '../config.js';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

/**
 * Brings the schema up to date and registers the configured stores and PostEx accounts before
 * a process does any work. Both steps are idempotent and lock-protected, so the web service and
 * the worker can run this at the same time. A refusal (an applied migration was edited) throws:
 * running on a schema that does not match the code is worse than not running.
 */
export const prepareDatabase = async (): Promise<void> => {
  const sql = db();
  if (!sql) return;
  if (!config.migrateOnBoot) {
    logger.info('DB_MIGRATE_ON_BOOT is false; skipping migrations and seeding');
    return;
  }
  const applied = await migrate(sql);
  const seeded = await seed(sql);
  logger.info({ migrationsApplied: applied.map((m) => m.file), seeded }, 'Database ready');
};
