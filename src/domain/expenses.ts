import type { Sql } from '../db.js';
import { type Db, atomically, big, readPaisa } from '../db/repos/upsert.js';
import { type Paisa, ZERO, add } from '../lib/money.js';
import { formatKarachi } from '../lib/time.js';
import { type AccountKey, PeriodClosedError, postEntry, reverseEntry } from './accounting.js';

/**
 * The business's own running costs (proposal 6.5: "your expenses (ads, salaries, rent,
 * packaging)"), the part of the P&L no sync can know. Each expense is one journal entry:
 *
 * | Expense                     | Debit                          | Credit          |
 * |-----------------------------|--------------------------------|-----------------|
 * | Paid from the bank          | the category's expense account | Bank (1000)     |
 * | Paid in cash                | the category's expense account | Cash (1010)     |
 * | Voided (entered by mistake) | reverses that entry, on the day it is voided                     |
 *
 * Stock bought from a vendor is not an expense here: it goes through Purchase, where the goods
 * receipt puts it into Inventory and it becomes cost of goods sold only when it is delivered.
 */

export const EXPENSE_CATEGORIES = ['advertising', 'salaries', 'rent', 'packaging', 'utilities', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const CATEGORY_ACCOUNT: Record<ExpenseCategory, AccountKey> = {
  advertising: 'advertising',
  salaries: 'salaries',
  rent: 'rent',
  packaging: 'packaging',
  utilities: 'utilities',
  other: 'general',
};

export class ExpenseError extends Error {
  readonly status: 404 | 409;
  constructor(message: string, status: 404 | 409 = 409) {
    super(message);
    this.name = 'ExpenseError';
    this.status = status;
  }
}

export interface ExpenseInput {
  spentOn: string;
  category: ExpenseCategory;
  store: 'nur' | 'organics' | null;
  amount: Paisa;
  paidFrom: 'bank' | 'cash';
  payee: string | null;
  note: string | null;
  actorId: string;
}

const asConflict = (error: unknown): never => {
  if (error instanceof PeriodClosedError) throw new ExpenseError(`${error.message}. Date it in an open month instead.`);
  throw error;
};

/** Records an expense and posts it, in one transaction, audited with the person (rule 8). */
export const recordExpense = async (sql: Sql, input: ExpenseInput): Promise<{ id: string; entryId: string }> =>
  atomically(sql, async (tx) => {
    const storeId = input.store ? ((await tx<{ id: string }[]>`select id from stores where key = ${input.store}`)[0]?.id ?? null) : null;
    if (input.store && !storeId) throw new ExpenseError(`Store ${input.store} is not set up`, 404);
    const [row] = await tx<{ id: string }[]>`
      insert into expenses (spent_on, category, store_id, amount_paisa, paid_from, payee, note, created_by)
      values (${input.spentOn}, ${input.category}, ${storeId}, ${big(input.amount)}, ${input.paidFrom}, ${input.payee}, ${input.note}, ${input.actorId})
      returning id
    `;
    const posted = await postEntry(tx, {
      date: input.spentOn,
      memo: `Expense: ${input.category}${input.payee ? `, ${input.payee}` : ''}`,
      source: { type: 'expense', id: row!.id },
      lines: [
        { account: CATEGORY_ACCOUNT[input.category], debit: input.amount, storeId },
        { account: input.paidFrom, credit: input.amount, storeId },
      ],
      postedBy: input.actorId,
    }).catch(asConflict);
    await tx`
      insert into audit_log (actor_id, action, entity, entity_id, after)
      values (${input.actorId}, 'expense.create', 'expenses', ${row!.id},
              ${tx.json({ spentOn: input.spentOn, category: input.category, store: input.store, amountPaisa: input.amount.toString(), paidFrom: input.paidFrom })})
    `;
    return { id: row!.id, entryId: posted!.id };
  });

/** Voids an expense entered by mistake: its entry is reversed today, the row stays with who and why. */
export const voidExpense = async (sql: Sql, input: { id: string; reason: string; actorId: string }): Promise<void> =>
  atomically(sql, async (tx) => {
    const [row] = await tx<{ voided_at: Date | null }[]>`select voided_at from expenses where id = ${input.id} for update`;
    if (!row) throw new ExpenseError(`Expense ${input.id} not found`, 404);
    if (row.voided_at) throw new ExpenseError('This expense is already voided');
    const [entry] = await tx<{ id: string }[]>`
      select id from journal_entries where source_type = 'expense' and source_id = ${input.id} and reversed_by is null
    `;
    if (entry) {
      await reverseEntry(tx, entry.id, { date: formatKarachi(new Date()).slice(0, 10), memo: `Expense voided: ${input.reason}`, postedBy: input.actorId }).catch(asConflict);
    }
    await tx`update expenses set voided_at = now(), voided_by = ${input.actorId}, void_reason = ${input.reason} where id = ${input.id}`;
    await tx`
      insert into audit_log (actor_id, action, entity, entity_id, after)
      values (${input.actorId}, 'expense.void', 'expenses', ${input.id}, ${tx.json({ reason: input.reason })})
    `;
  });

export interface ExpenseRow {
  id: string;
  spentOn: string;
  category: ExpenseCategory;
  store: 'nur' | 'organics' | null;
  amount: Paisa;
  paidFrom: 'bank' | 'cash';
  payee: string | null;
  note: string | null;
  createdBy: string;
  createdAt: Date;
  voided: { at: Date; by: string; reason: string | null } | null;
  entryId: string | null;
}

export interface ExpenseFilter {
  from?: string;
  to?: string;
  store?: 'nur' | 'organics';
  category?: ExpenseCategory;
  includeVoided?: boolean;
}

/** Expenses newest first, with the totals of the live ones per category. */
export const listExpenses = async (db: Db, f: ExpenseFilter = {}): Promise<{ rows: ExpenseRow[]; total: Paisa; byCategory: Record<ExpenseCategory, Paisa> }> => {
  const rows = await db<
    {
      id: string; spent_on: string; category: ExpenseCategory; store: 'nur' | 'organics' | null; amount: string; paid_from: 'bank' | 'cash'; payee: string | null;
      note: string | null; created_by: string; created_at: Date; voided_at: Date | null; voided_by: string | null; void_reason: string | null; entry_id: string | null;
    }[]
  >`
    select e.id, e.spent_on::text, e.category, st.key as store, e.amount_paisa::text as amount, e.paid_from, e.payee, e.note,
           cu.name as created_by, e.created_at, e.voided_at, vu.name as voided_by, e.void_reason,
           (select j.id::text from journal_entries j where j.source_type = 'expense' and j.source_id = e.id::text order by j.id limit 1) as entry_id
    from expenses e
    left join stores st on st.id = e.store_id
    join users cu on cu.id = e.created_by
    left join users vu on vu.id = e.voided_by
    where true
      ${f.from ? db`and e.spent_on >= ${f.from}::date` : db``}
      ${f.to ? db`and e.spent_on <= ${f.to}::date` : db``}
      ${f.store ? db`and st.key = ${f.store}` : db``}
      ${f.category ? db`and e.category = ${f.category}` : db``}
      ${f.includeVoided ? db`` : db`and e.voided_at is null`}
    order by e.spent_on desc, e.id desc
    limit 1000
  `;
  const mapped: ExpenseRow[] = rows.map((r) => ({
    id: r.id,
    spentOn: r.spent_on,
    category: r.category,
    store: r.store,
    amount: readPaisa(r.amount),
    paidFrom: r.paid_from,
    payee: r.payee,
    note: r.note,
    createdBy: r.created_by,
    createdAt: r.created_at,
    voided: r.voided_at ? { at: r.voided_at, by: r.voided_by ?? '', reason: r.void_reason } : null,
    entryId: r.entry_id,
  }));
  const byCategory = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c, ZERO])) as Record<ExpenseCategory, Paisa>;
  let total = ZERO;
  for (const r of mapped) {
    if (r.voided) continue;
    byCategory[r.category] = add(byCategory[r.category], r.amount);
    total = add(total, r.amount);
  }
  return { rows: mapped, total, byCategory };
};
