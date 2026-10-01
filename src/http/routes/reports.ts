import { Router } from 'express';
import { z } from 'zod';

import { endOfKarachiDay } from '../../lib/time.js';
import {
  DIMENSIONS,
  breakdown,
  cashAwaitingPayout,
  deliveredRevenue,
  deliverySuccess,
  netProfit,
  profitPerParcel,
  returnRate,
  returnRateBy,
  drillBreakdown,
  drillProductBreakdown,
  ledgerLinesPage,
  monthBounds,
  partnerLedger,
  pnl,
  productBreakdown,
  trialBalanceReport,
} from '../../reports/index.js';
import { todayInKarachi } from '../../reports/filter.js';
import type { ReportFilter } from '../../reports/index.js';
import { type SqlProvider, requireSql } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { ID, parse } from '../validate.js';

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

const pnlQuery = filterQuery.extend({ byMonth: z.enum(['true', 'false']).optional() });
const linesQuery = filterQuery.extend({
  account: z.string().regex(/^\d{4}$/).optional(),
  partnerType: z.enum(['postex_account', 'retail_partner', 'vendor']).optional(),
  partnerId: z.string().regex(ID).optional(),
  originType: z.string().regex(/^[a-z_]+$/).max(40).optional(),
  originId: z.string().max(80).optional(),
  originIdPrefix: z.string().max(80).optional(),
  payoutId: z.string().regex(ID).optional(),
  entryId: z.string().regex(ID).optional(),
  /** A month as `YYYY-MM`: the same as from and to its first and last day. */
  month: z.string().optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  size: z.coerce.number().int().min(1).max(200).default(50),
});

const returnRateQuery = filterQuery.extend({ by: z.enum(['city', 'month']).default('city') });

/** Bigints (paisa) as decimal strings, everywhere in a response. */
const json = (value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v)]));
  return value;
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

  /**
   * The dashboard's headline figures for one period and brand, each from the same report function
   * its own screen uses, so a tile and the report behind it cannot disagree. Cash with PostEx is as
   * of the period's last day (today, when the period is open-ended).
   */
  router.get('/reports/dashboard', async (req, res) => {
    const sql = requireSql(getSql);
    const f = filterOf(parse(filterQuery, req.query));
    const asOf = f.to ?? todayInKarachi();
    const [revenue, profit, returns, delivery, cash, perParcel] = await Promise.all([
      deliveredRevenue(sql, f),
      netProfit(sql, f),
      returnRate(sql, f),
      deliverySuccess(sql, f),
      cashAwaitingPayout(sql, { ...f, to: asOf }),
      profitPerParcel(sql, f),
    ]);
    res.json(
      json({
        period: { from: f.from ?? null, to: f.to ?? null, asOf, store: f.store ?? null },
        deliveredRevenue: revenue,
        profit,
        returnRate: returns,
        deliverySuccess: delivery,
        cash,
        // The per-parcel rows are the report's own screen; the tile needs only the totals.
        profitPerParcel: { parcels: perParcel.parcels, total: perParcel.total, average: perParcel.average },
      }),
    );
  });

  /** Return rate by delivery city or by booking month, same definition as the headline rate. */
  router.get('/reports/return-rate', async (req, res) => {
    const q = parse(returnRateQuery, req.query);
    res.json({ by: q.by, rows: await returnRateBy(requireSql(getSql), filterOf(q), q.by) });
  });

  /** Profit and loss over a period, optionally one column per month. */
  router.get('/reports/pnl', async (req, res) => {
    const q = parse(pnlQuery, req.query);
    const report = await pnl(requireSql(getSql), filterOf(q), { byMonth: q.byMonth === 'true' });
    res.json({ rows: report.rows.map(strings), income: report.income.toString(), expenses: report.expenses.toString(), netProfit: report.netProfit.toString() });
  });

  /** Trial balance over a period: opening, movement and closing per account. */
  router.get('/reports/trial-balance', async (req, res) => {
    const report = await trialBalanceReport(requireSql(getSql), filterOf(parse(filterQuery, req.query)));
    res.json({ rows: report.rows.map(strings), debit: report.debit.toString(), credit: report.credit.toString(), balanced: report.debit === report.credit });
  });

  router.get('/reports/partner-ledger', async (req, res) => {
    const rows = await partnerLedger(requireSql(getSql), filterOf(parse(filterQuery, req.query)));
    res.json({ rows: rows.map(strings) });
  });

  /**
   * The journal lines behind any figure, a page at a time. Name what the figure is (an account, a
   * partner, a document, a month) and the lines come back with totals over all of them; with an
   * account they are a general ledger with a running balance.
   */
  router.get('/reports/lines', async (req, res) => {
    const q = parse(linesQuery, req.query);
    let base = filterOf(q);
    if (q.month) {
      const bounds = monthBounds(q.month);
      if (!bounds) throw new HttpError(400, `${q.month} is not a month as YYYY-MM`);
      // A month inside a wider range is that month, not the range.
      base = { ...base, from: bounds.from > (base.from ?? '') ? bounds.from : (base.from ?? bounds.from), to: bounds.to < (base.to ?? '9999-12-31') ? bounds.to : (base.to ?? bounds.to) };
    }
    const result = await ledgerLinesPage(
      requireSql(getSql),
      {
        ...base,
        ...(q.account ? { account: q.account } : {}),
        ...(q.partnerType ? { partnerType: q.partnerType } : {}),
        ...(q.partnerId ? { partnerId: q.partnerId } : {}),
        ...(q.originType ? { originType: q.originType } : {}),
        ...(q.originId ? { originId: q.originId } : {}),
        ...(q.originIdPrefix ? { originIdPrefix: q.originIdPrefix } : {}),
        ...(q.payoutId ? { payoutId: q.payoutId } : {}),
        ...(q.entryId ? { entryId: q.entryId } : {}),
      },
      { page: q.page, pageSize: q.size },
    );
    res.json({
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      debit: result.debit.toString(),
      credit: result.credit.toString(),
      opening: result.opening?.toString() ?? null,
      closing: result.closing?.toString() ?? null,
      lines: result.lines.map(strings),
    });
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
