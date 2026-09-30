import { createApp } from './app.js';
import { config, isShopifyStoreReady } from './config.js';
import { closeDb } from './db.js';
import { logger } from './logger.js';

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
