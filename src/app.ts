import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';

import { config } from './config.js';
import { type Sql, db } from './db.js';
import { errorHandler, notFound } from './http/middleware/errors.js';
import { createApiRouter } from './http/routes/index.js';
import { healthRouter } from './http/routes/health.js';
import { shopifyWebhookRouter } from './http/routes/shopify-webhooks.js';
import { logger } from './logger.js';
import { type WebhookDeps, configuredWebhookStore } from './webhooks/shopify.js';

export interface AppOptions {
  /** Overrides the webhook dependencies; tests use it to point at a scratch database and a fake Shopify. */
  webhooks?: () => WebhookDeps | null;
  /** Overrides the database the API routes use; tests point it at a scratch schema. */
  sql?: () => Sql | null | undefined;
}

const defaultWebhookDeps = (): WebhookDeps | null => {
  const sql = db();
  if (!sql) return null;
  return { sql, logger, resolveStore: (shopDomain) => configuredWebhookStore(sql, shopDomain) };
};

export const createApp = (options: AppOptions = {}): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin }));
  // Before express.json(): Shopify signs the raw bytes, and a parsed body can never be verified.
  // The webhook router mounts its own raw parser on its one route.
  app.use(shopifyWebhookRouter(options.webhooks ?? defaultWebhookDeps));
  app.use(express.json({ limit: '1mb' }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' || req.url === '/ready' },
    }),
  );

  app.use(healthRouter);
  app.use('/api/v1', createApiRouter(options.sql ?? db));

  app.use(notFound);
  app.use(errorHandler);

  return app;
};
