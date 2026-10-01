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
  entriesBeforeOpening,
  inventoryCheck,
  karachiDay,
  listPeriods,
  openingBalances,
  postOpeningBalances,
  trialBalance,
} from '../../domain/accounting.js';
import { paisa } from '../../lib/money.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { ID, parse } from '../validate.js';

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
const checkQuery = z.object({ asAt: z.string().regex(DAY).optional() });
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

const entryParams = z.object({ id: z.string().regex(ID) });
const pageQuery = z.object({ page: z.coerce.number().int().min(1).max(1_000_000).default(1), size: z.coerce.number().int().min(1).max(200).default(25) });
const invoicesQuery = pageQuery.extend({ store, voided: z.enum(['true', 'false']).optional() });
const paymentsQuery = pageQuery.extend({ direction: z.enum(['in', 'out']).optional() });

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

  /**
   * One journal entry whole: why it was posted, every line of it, whether it was reversed or is a
   * reversal, and whether its month is closed. The last step of any drill-through.
   */
  router.get('/accounting/entries/:id', async (req, res) => {
    const sql = requireSql(getSql);
    const { id } = parse(entryParams, req.params);
    const [entry] = await sql<
      { id: string; date: string; memo: string; source_type: string; source_id: string; posted_at: Date; posted_by: string | null; reverses_id: string | null; reversed_by: string | null; closed_at: Date | null }[]
    >`
      select e.id, e.entry_date::text as date, e.memo, e.source_type, e.source_id, e.posted_at, u.name as posted_by,
             e.reverses_id::text, e.reversed_by::text, p.closed_at
      from journal_entries e
      left join users u on u.id = e.posted_by
      left join fiscal_periods p on p.year = extract(year from e.entry_date) and p.month = extract(month from e.entry_date) and p.status = 'closed'
      where e.id = ${id}
    `;
    if (!entry) throw new HttpError(404, `Journal entry ${id} not found`);
    const lines = await sql<
      { id: string; code: string; name: string; debit: string; credit: string; store: string | null; partner_type: string | null; partner_id: string | null; partner: string | null; memo: string | null }[]
    >`
      select l.id::text, a.code, a.name, l.debit_paisa::text as debit, l.credit_paisa::text as credit, st.key as store, l.partner_type, l.partner_id::text,
             case l.partner_type
               when 'postex_account' then (select pa.label from postex_accounts pa where pa.id = l.partner_id)
               when 'retail_partner' then (select rp.name from retail_partners rp where rp.id = l.partner_id)
               when 'vendor' then (select v.name from vendors v where v.id = l.partner_id)
             end as partner,
             l.memo
      from journal_lines l join accounts a on a.id = l.account_id left join stores st on st.id = l.store_id
      where l.entry_id = ${id} order by l.id
    `;
    res.json({
      entry: {
        id: entry.id,
        date: entry.date,
        memo: entry.memo,
        sourceType: entry.source_type,
        sourceId: entry.source_id,
        postedAt: entry.posted_at,
        postedBy: entry.posted_by,
        reversesId: entry.reverses_id,
        reversedBy: entry.reversed_by,
        periodClosedAt: entry.closed_at,
        lines: lines.map((l) => ({ id: l.id, code: l.code, name: l.name, debit: l.debit, credit: l.credit, store: l.store, partnerType: l.partner_type, partnerId: l.partner_id, partner: l.partner, memo: l.memo })),
      },
    });
  });

  /** Sales invoices to retail partners (one per brand per imported sales sheet), newest first. */
  router.get('/accounting/invoices', async (req, res) => {
    const sql = requireSql(getSql);
    const q = parse(invoicesQuery, req.query);
    const offset = (q.page - 1) * q.size;
    const filter = sql`
      ${q.store ? sql`and st.key = ${q.store}` : sql``}
      ${q.voided === 'true' ? sql`and i.voided_at is not null` : q.voided === 'false' ? sql`and i.voided_at is null` : sql``}
    `;
    const [count] = await sql<{ n: number }[]>`
      select count(*)::int as n from invoices i join stores st on st.id = i.store_id where true ${filter}
    `;
    const rows = await sql<
      { id: string; number: string; partner_id: string; partner: string; store: string; store_id: string; issued_on: string; total: string; voided_at: Date | null; import_id: string | null }[]
    >`
      select i.id::text, i.number, i.partner_id::text, rp.name as partner, st.key as store, i.store_id::text, i.issued_on::text,
             i.total_paisa::text as total, i.voided_at, i.import_id::text
      from invoices i join retail_partners rp on rp.id = i.partner_id join stores st on st.id = i.store_id
      where true ${filter}
      order by i.issued_on desc, i.id desc
      limit ${q.size} offset ${offset}
    `;
    res.json({
      total: count!.n,
      page: q.page,
      pageSize: q.size,
      rows: rows.map((r) => ({
        id: r.id,
        number: r.number,
        partnerId: r.partner_id,
        partner: r.partner,
        store: r.store,
        issuedOn: r.issued_on,
        total: r.total,
        voidedAt: r.voided_at,
        // The sales this invoice booked carry its import and brand in their source id.
        drill: r.import_id ? { originType: 'consignment_sale', originIdPrefix: `${r.import_id}:${r.store_id}:` } : null,
      })),
    });
  });

  /**
   * Money paid and received, newest first: what we paid vendors against their bills, and what
   * PostEx paid out for delivered COD parcels. (Payments from retail partners are not recorded yet.)
   */
  router.get('/accounting/payments', async (req, res) => {
    const sql = requireSql(getSql);
    const q = parse(paymentsQuery, req.query);
    const offset = (q.page - 1) * q.size;
    const all = sql`
      select 'vendor_payment' as kind, vp.id::text as id, 'out' as direction, v.name as counterparty, vb.bill_number as document,
             vp.amount_paisa::text as amount, vp.paid_on::text as paid_on, vp.method, vp.reference,
             'vendor_payment' as origin_type, vp.id::text as origin_id, null::text as payout_id
      from vendor_payments vp join vendors v on v.id = vp.vendor_id join vendor_bills vb on vb.id = vp.bill_id
      union all
      select 'postex_payout', p.id::text, 'in', a.label, p.cpr_number,
             p.amount_paisa::text, ((coalesce(p.paid_at, p.created_at)) at time zone 'Asia/Karachi')::date::text, null, p.cpr_number,
             'payout_line', null, p.id::text
      from cod_payouts p join postex_accounts a on a.id = p.postex_account_id
    `;
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from (${all}) t ${q.direction ? sql`where t.direction = ${q.direction}` : sql``}`;
    const rows = await sql<
      { kind: string; id: string; direction: 'in' | 'out'; counterparty: string; document: string | null; amount: string; paid_on: string; method: string | null; reference: string | null; origin_type: string; origin_id: string | null; payout_id: string | null }[]
    >`
      select * from (${all}) t ${q.direction ? sql`where t.direction = ${q.direction}` : sql``}
      order by t.paid_on desc, t.id desc limit ${q.size} offset ${offset}
    `;
    res.json({
      total: count!.n,
      page: q.page,
      pageSize: q.size,
      rows: rows.map((r) => ({
        kind: r.kind,
        id: r.id,
        direction: r.direction,
        counterparty: r.counterparty,
        document: r.document,
        amount: r.amount,
        paidOn: r.paid_on,
        method: r.method,
        reference: r.reference,
        drill: r.payout_id ? { payoutId: r.payout_id } : { originType: r.origin_type, originId: r.origin_id },
      })),
    });
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

  /** Inventory account vs units × cost, as at a day (default today): the opening stock check. */
  router.get('/accounting/inventory-check', async (req, res) => {
    const sql = requireSql(getSql);
    const { asAt } = parse(checkQuery, req.query);
    let check;
    try {
      check = await inventoryCheck(sql, asAt ?? karachiDay(new Date()));
    } catch (error) {
      if (error instanceof RangeError) throw new HttpError(400, error.message);
      throw error;
    }
    res.json({ ...check, stockValue: check.stockValue.toString(), ledgerValue: check.ledgerValue.toString(), difference: check.difference.toString(), agrees: check.difference === 0n });
  });

  router.get('/accounting/opening-balances', async (_req, res) => {
    const sql = requireSql(getSql);
    const current = await openingBalances(sql);
    const stores = await sql<{ id: string; key: string }[]>`select id, key from stores`;
    res.json({
      // Non-zero means history the client's balances already include would be counted twice.
      entriesBeforeOpening: await entriesBeforeOpening(sql),
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
