import { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import { EXPENSE_CATEGORIES, ExpenseError, listExpenses, recordExpense, voidExpense } from '../../domain/expenses.js';
import { paisa } from '../../lib/money.js';
import { endOfKarachiDay } from '../../lib/time.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { ID, parse } from '../validate.js';

/**
 * Expenses (proposal 6.5): the running costs the P&L subtracts after cost of goods and PostEx's
 * charges. Amounts travel as integer paisa in decimal strings (rule 3). Recording or voiding one
 * is audited with the signed-in user.
 */

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    try {
      endOfKarachiDay(d);
      return true;
    } catch {
      return false;
    }
  }, 'not a real date');
const text = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

const expense = z.object({
  spentOn: day,
  category: z.enum(EXPENSE_CATEGORIES),
  store: z.enum(['nur', 'organics']).nullish().transform((v) => v ?? null),
  amountPaisa: z
    .string()
    .regex(/^\d{1,15}$/, 'an amount in paisa, as digits')
    .refine((v) => BigInt(v) > 0n, 'must be more than zero')
    .transform((v) => paisa(BigInt(v))),
  paidFrom: z.enum(['bank', 'cash']),
  payee: text(120),
  note: text(2000),
});
const listQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  store: z.enum(['nur', 'organics']).optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  voided: z.enum(['true', 'false']).optional(),
});
const voidBody = z.object({ reason: z.string().trim().min(1).max(500) });

const asHttp = (error: unknown): never => {
  if (error instanceof ExpenseError) throw new HttpError(error.status, error.message);
  throw error;
};

const today = (): string => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);

export const expensesRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  router.get('/accounting/expenses', async (req, res) => {
    const q = parse(listQuery, req.query);
    const result = await listExpenses(requireSql(getSql), {
      ...(q.from ? { from: q.from } : {}),
      ...(q.to ? { to: q.to } : {}),
      ...(q.store ? { store: q.store } : {}),
      ...(q.category ? { category: q.category } : {}),
      includeVoided: q.voided === 'true',
    });
    res.json({
      rows: result.rows.map((r) => ({ ...r, amount: r.amount.toString() })),
      total: result.total.toString(),
      byCategory: Object.fromEntries(Object.entries(result.byCategory).map(([k, v]) => [k, v.toString()])),
    });
  });

  router.post('/accounting/expenses', async (req, res) => {
    const sql = requireSql(getSql);
    const body = parse(expense, req.body);
    if (body.spentOn > today()) throw new HttpError(400, 'spentOn: an expense cannot be dated in the future');
    const result = await recordExpense(sql, { ...body, amount: body.amountPaisa, actorId: await actorId(sql, sessionUser(req)) }).catch(asHttp);
    res.status(201).json(result);
  });

  router.post('/accounting/expenses/:id/void', async (req, res) => {
    const sql = requireSql(getSql);
    const { id } = parse(z.object({ id: z.string().regex(ID) }), req.params);
    const { reason } = parse(voidBody, req.body);
    await voidExpense(sql, { id, reason, actorId: await actorId(sql, sessionUser(req)) }).catch(asHttp);
    res.json({ voided: true });
  });

  return router;
};
