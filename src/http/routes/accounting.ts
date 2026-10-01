import { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import {
  ACCOUNT_CODES,
  type AccountKey,
  AccountingError,
  BALANCE_SHEET_KEYS,
  accountLedger,
  closePeriod,
  listPeriods,
  openingBalances,
  postOpeningBalances,
  trialBalance,
} from '../../domain/accounting.js';
import { paisa } from '../../lib/money.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { parse } from '../validate.js';

/**
 * Accounting screens (Step 10): the trial balance and the ledger behind each figure, month close,
 * and the opening balances. Amounts travel as integer paisa in decimal strings (rule 3: JSON has
 * no bigint, and a float would round). Every change is audited with the signed-in user.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PAISA = /^-?\d{1,18}$/;
const store = z.enum(['nur', 'organics']).optional();
const tbQuery = z.object({ to: z.string().regex(DAY).optional(), store });
const ledgerParams = z.object({ code: z.string().regex(/^\d{4}$/) });
const ledgerQuery = z.object({ to: z.string().regex(DAY).optional(), store, limit: z.coerce.number().int().min(1).max(1000).default(200) });
const periodParams = z.object({ year: z.coerce.number().int().min(2000).max(2100), month: z.coerce.number().int().min(1).max(12) });
const opening = z.object({
  date: z.string().regex(DAY),
  lines: z
    .array(
      z.object({
        code: z.string().regex(/^\d{4}$/),
        balancePaisa: z.string().regex(PAISA, 'integer paisa as a string'),
        store,
      }),
    )
    .max(100),
});

const byCode = new Map<string, AccountKey>(Object.entries(ACCOUNT_CODES).map(([key, code]) => [code, key as AccountKey]));
const asText = <T extends { debit: bigint; credit: bigint }>(row: T) => ({ ...row, debit: row.debit.toString(), credit: row.credit.toString() });

export const accountingRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  const storeId = async (key: 'nur' | 'organics' | undefined): Promise<string | undefined> => {
    if (!key) return undefined;
    const [row] = await requireSql(getSql)<{ id: string }[]>`select id from stores where key = ${key}`;
    if (!row) throw new HttpError(404, `Store ${key} is not set up`);
    return row.id;
  };

  router.get('/accounting/trial-balance', async (req, res) => {
    const sql = requireSql(getSql);
    const query = parse(tbQuery, req.query);
    const id = await storeId(query.store);
    const tb = await trialBalance(sql, { ...(query.to ? { to: query.to } : {}), ...(id ? { storeId: id } : {}) });
    res.json({
      rows: tb.rows.map((r) => ({ ...asText(r), balance: r.balance.toString() })),
      debit: tb.debit.toString(),
      credit: tb.credit.toString(),
      balanced: tb.debit === tb.credit,
    });
  });

  router.get('/accounting/accounts/:code/lines', async (req, res) => {
    const sql = requireSql(getSql);
    const { code } = parse(ledgerParams, req.params);
    const query = parse(ledgerQuery, req.query);
    const id = await storeId(query.store);
    const lines = await accountLedger(sql, code, { limit: query.limit, ...(query.to ? { to: query.to } : {}), ...(id ? { storeId: id } : {}) });
    res.json({ lines: lines.map(asText) });
  });

  router.get('/accounting/periods', async (_req, res) => {
    res.json({ periods: await listPeriods(requireSql(getSql)) });
  });

  router.post('/accounting/periods/:year/:month/close', async (req, res) => {
    const sql = requireSql(getSql);
    const { year, month } = parse(periodParams, req.params);
    try {
      await closePeriod(sql, { year, month, actorId: await actorId(sql, sessionUser(req)) });
    } catch (error) {
      if (error instanceof AccountingError) throw new HttpError(409, error.message);
      throw error;
    }
    res.json({ year, month, status: 'closed' });
  });

  router.get('/accounting/opening-balances', async (_req, res) => {
    const sql = requireSql(getSql);
    const current = await openingBalances(sql);
    const stores = await sql<{ id: string; key: string }[]>`select id, key from stores`;
    res.json({
      accounts: BALANCE_SHEET_KEYS.map((key) => ({ key, code: ACCOUNT_CODES[key] })),
      opening: current
        ? {
            date: current.date,
            lines: current.lines.map((l) => ({
              code: ACCOUNT_CODES[l.account],
              balancePaisa: l.balance.toString(),
              store: stores.find((s) => s.id === l.storeId)?.key ?? null,
            })),
          }
        : null,
    });
  });

  router.put('/accounting/opening-balances', async (req, res) => {
    const sql = requireSql(getSql);
    const body = parse(opening, req.body);
    const lines = [];
    for (const line of body.lines) {
      const account = byCode.get(line.code);
      if (!account || !BALANCE_SHEET_KEYS.includes(account)) throw new HttpError(400, `Account ${line.code} is not a balance-sheet account`);
      lines.push({ account, balance: paisa(BigInt(line.balancePaisa)), storeId: (await storeId(line.store)) ?? null });
    }
    try {
      const result = await postOpeningBalances(sql, { date: body.date, lines, actorId: await actorId(sql, sessionUser(req)) });
      res.json(result ?? { id: null, replaced: false });
    } catch (error) {
      if (error instanceof AccountingError) throw new HttpError(409, error.message);
      throw error;
    }
  });

  return router;
};
