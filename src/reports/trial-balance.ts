import { type Db, readPaisa } from '../db/repos/upsert.js';
import { type Paisa, add, sub, sum } from '../lib/money.js';
import { type ReportFilter, ledgerWhere, prefix } from './filter.js';

/**
 * Trial balance over a period: each account's balance before it, its debits and credits in it,
 * and its balance at the end. Total debits equal total credits in every column, or the ledger is
 * broken (the database refuses an unbalanced entry, so it is not).
 */
export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  opening: Paisa;
  debit: Paisa;
  credit: Paisa;
  closing: Paisa;
}

const query = (db: Db, f: ReportFilter, explain = false) =>
  db<{ code: string; name: string; type: string; opening: string; debit: string; credit: string }[]>`
    ${prefix(db, explain)}
    select l.account_code as code, l.account_name as name, l.account_type as type,
           coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where ${f.from ? db`l.entry_date < ${f.from}::date` : db`false`}), 0)::text as opening,
           coalesce(sum(l.debit_paisa) filter (where ${f.from ? db`l.entry_date >= ${f.from}::date` : db`true`}), 0)::text as debit,
           coalesce(sum(l.credit_paisa) filter (where ${f.from ? db`l.entry_date >= ${f.from}::date` : db`true`}), 0)::text as credit
    from ledger_lines l
    where true ${ledgerWhere(db, { ...f, from: undefined })}
    group by l.account_code, l.account_name, l.account_type
    order by l.account_code
  `;

export const trialBalanceReport = async (db: Db, f: ReportFilter = {}): Promise<{ rows: TrialBalanceRow[]; debit: Paisa; credit: Paisa }> => {
  const rows = (await query(db, f)).map((r) => {
    const opening = readPaisa(r.opening);
    const debit = readPaisa(r.debit);
    const credit = readPaisa(r.credit);
    return { code: r.code, name: r.name, type: r.type, opening, debit, credit, closing: sub(add(opening, debit), credit) };
  });
  return { rows, debit: sum(rows.map((r) => r.debit)), credit: sum(rows.map((r) => r.credit)) };
};

export const explainTrialBalance = (db: Db, f: ReportFilter = {}) => query(db, f, true);

export const drillTrialBalance = async (db: Db, f: ReportFilter, code: string): Promise<{ entryIds: string[] }> => {
  const rows = await db<{ entry_id: string }[]>`
    select distinct l.entry_id from ledger_lines l where l.account_code = ${code} ${ledgerWhere(db, f)} order by l.entry_id
  `;
  return { entryIds: rows.map((r) => r.entry_id) };
};
