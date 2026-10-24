import { Router } from 'express';
import { z } from 'zod';

import { runDueSyncs, syncStatus } from '../../jobs/status.js';
import type { RunResult } from '../../jobs/runner.js';
import { logger } from '../../logger.js';
import { type SqlProvider, requireSql } from '../middleware/database.js';
import { parse } from '../validate.js';

/**
 * Keeping the platform's copy of Shopify and PostEx current where no worker runs (Vercel): the
 * dashboard asks for the due syncs while someone has it open, and a cron does when nobody has.
 * Where the worker does run (Render, `npm run dev`), these find nothing due and return at once.
 */

/** A dashboard waits this long for its syncs; anything left resumes on the next call. */
const DASHBOARD_BUDGET_MS = 50_000;

const runBody = z.object({ now: z.boolean().optional() });

export const summary = (results: RunResult[]) =>
  results.map((r) => ({ job: r.job, status: r.status, durationMs: r.durationMs, ...(r.error ? { error: r.error } : {}) }));

/** Signed in: how fresh the data is, and asking for the due syncs (or all of them, `now`). */
export const syncRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  router.get('/sync/status', async (_req, res) => {
    res.json(await syncStatus(requireSql(getSql)));
  });

  router.post('/sync/run', async (req, res) => {
    const sql = requireSql(getSql);
    const body = parse(runBody, req.body ?? {});
    const results = await runDueSyncs(sql, logger.child({ component: 'sync-on-request' }), { budgetMs: DASHBOARD_BUDGET_MS, ...(body.now ? { now: true } : {}) });
    res.json({ ran: summary(results), status: await syncStatus(sql) });
  });

  return router;
};
