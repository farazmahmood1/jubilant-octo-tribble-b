import pino from 'pino';

import { config } from './config.js';

/**
 * Credentials must never reach the logs: the PostEx token can book real shipments and the
 * Shopify secret can read the whole store.
 */
const redact = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers.token',
    'req.headers["x-shopify-access-token"]',
    '*.token',
    '*.accessToken',
    '*.clientSecret',
    '*.client_secret',
    '*.access_token',
    '*.password',
    'config.postex.accounts',
  ],
  censor: '[redacted]',
};

export const logger = pino({
  level: config.logLevel,
  redact,
  base: { service: 'nur-platform-backend' },
  ...(config.isProduction || process.env.VERCEL
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' } } }),
});

export type Logger = typeof logger;
