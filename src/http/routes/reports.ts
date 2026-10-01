import { Router } from 'express';
import { z } from 'zod';

import { endOfKarachiDay } from '../../lib/time.js';
import { DIMENSIONS, breakdown, drillBreakdown, drillProductBreakdown, productBreakdown } from '../../reports/index.js';
import type { ReportFilter } from '../../reports/index.js';
import { type SqlProvider, requireSql } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { parse } from '../validate.js';

/**
 * The Step 14 breakdowns, read-only: by brand, month, city, partner, influencer or agent, and by
 * product. Amounts are integer paisa in strings. Each row's `key` drills down to its parcels and
 * journal entries.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const filterQuery = z.object({
  from: z.string().regex(DAY).optional(),
  to: z.string().regex(DAY).optional(),
  store: z.enum(['nur', 'organics']).optional(),
});
const dimensionParams = z.object({ dimension: z.enum(DIMENSIONS) });
const drillQuery = filterQuery.extend({ key: z.string().min(1).max(80) });

const filterOf = (q: z.infer<typeof filterQuery>): ReportFilter => {
  for (const day of [q.from, q.to]) {
    if (!day) continue;
    try {
      endOfKarachiDay(day);
    } catch {
      throw new HttpError(400, `${day} is not a real date`);
    }
  }
  return { ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}), ...(q.store ? { store: q.store } : {}) };
};

const strings = <T extends object>(row: T): Record<string, unknown> =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));

export const reportsRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  router.get('/reports/breakdowns/:dimension', async (req, res) => {
    const { dimension } = parse(dimensionParams, req.params);
    const rows = await breakdown(requireSql(getSql), dimension, filterOf(parse(filterQuery, req.query)));
    res.json({ dimension, rows: rows.map(strings) });
  });

  router.get('/reports/breakdowns/:dimension/drill', async (req, res) => {
    const { dimension } = parse(dimensionParams, req.params);
    const q = parse(drillQuery, req.query);
    res.json(await drillBreakdown(requireSql(getSql), dimension, q.key, filterOf(q)));
  });

  router.get('/reports/products', async (req, res) => {
    const report = await productBreakdown(requireSql(getSql), filterOf(parse(filterQuery, req.query)));
    res.json({ revenue: report.revenue.toString(), goods: report.goods.toString(), rows: report.rows.map(strings) });
  });

  router.get('/reports/products/drill', async (req, res) => {
    const q = parse(drillQuery, req.query);
    res.json(await drillProductBreakdown(requireSql(getSql), q.key, filterOf(q)));
  });

  return router;
};
