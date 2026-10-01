import { createApp } from './app.js';
import { config, isShopifyStoreReady } from './config.js';
import { closeDb, db } from './db.js';
import { migrate } from './db/migrate.js';
import { seed } from './db/seed.js';
import { logger } from './logger.js';

/**
 * Brings the schema up to date and registers the configured stores and PostEx accounts before
 * any request is served. Both steps are idempotent and lock-protected, so the web service and
 * the worker can run this at the same time. A refusal (an applied migration was edited) stops
 * the process: serving on a schema that does not match the code is worse than not serving.
 */
const prepareDatabase = async (): Promise<void> => {
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

try {
  await prepareDatabase();
} catch (error) {
  logger.fatal({ err: error }, 'Database preparation failed; not starting');
  await closeDb().catch(() => {});
  process.exit(1);
}

const server = createApp().listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      env: config.env,
      database: config.databaseUrl ? 'configured' : 'not configured',
      shopifyStores: config.shopify.stores.map((s) => `${s.key}:${isShopifyStoreReady(s) ? 'ready' : 'incomplete'}`),
      postexAccounts: config.postex.accounts.map((a) => a.key),
      postexWrites: config.postex.allowWrites ? 'ENABLED' : 'disabled',
    },
    'Backend started',
  );

  if (config.shopify.stores.length < 2) logger.warn('Only one Shopify store configured; the second store is still missing');
  if (config.postex.accounts.length < 2) logger.warn('Only one PostEx account configured; the second account is still missing');
  if (!config.databaseUrl) logger.warn('DATABASE_URL is not set; /ready will report the database as unconfigured');
});

const shutdown = (signal: string) => {
  logger.info({ signal }, 'Shutting down');
  const timer = setTimeout(() => {
    logger.error('Forced exit after 10s');
    process.exit(1);
  }, 10_000).unref();

  server.close(async (error) => {
    if (error) logger.error({ err: error }, 'Error while closing the server');
    await closeDb().catch((err: unknown) => logger.error({ err }, 'Error while closing the database'));
    clearTimeout(timer);
    process.exit(error ? 1 : 0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'Unhandled promise rejection'));
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});
