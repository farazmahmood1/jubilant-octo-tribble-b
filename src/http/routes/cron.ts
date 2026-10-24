import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import { config } from '../../config.js';
import { runDueSyncs } from '../../jobs/status.js';
import { logger } from '../../logger.js';
import { type SqlProvider, requireSql } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { summary } from './sync.js';

/**
 * The scheduler for a host with no worker process (Vercel): Vercel Cron, or any service that can
 * call a URL on a timer with a header, asks this route to run the syncs that are due. It is
 * outside the signed-in API and guarded by its own secret instead.
 */

const sameSecret = (given: string, expected: string): boolean => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * `GET|POST /internal/cron`: runs every job that is due, for Vercel Cron or any scheduler that can
 * send `Authorization: Bearer <CRON_SECRET>`. Refused (404) when no secret is configured, so the
 * route does not exist on a deploy that has not chosen to use it.
 */
export const cronRouter = (getSql: SqlProvider): Router => {
  const router = Router();
  const tick = async (authorization: string | undefined) => {
    const secret = config.sync.cronSecret;
    if (!secret) throw new HttpError(404, 'Not found');
    if (!authorization?.startsWith('Bearer ') || !sameSecret(authorization.slice(7), secret)) throw new HttpError(401, 'Invalid cron secret');
    return runDueSyncs(requireSql(getSql), logger.child({ component: 'cron' }), { budgetMs: config.sync.cronBudgetMs });
  };
  router.get('/internal/cron', async (req, res) => {
    res.json({ ran: summary(await tick(req.headers.authorization)) });
  });
  router.post('/internal/cron', async (req, res) => {
    res.json({ ran: summary(await tick(req.headers.authorization)) });
  });
  return router;
};
