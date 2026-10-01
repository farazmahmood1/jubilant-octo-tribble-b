import { type Db, readPaisa } from '../db/repos/upsert.js';
import { type Paisa, sub, sum } from '../lib/money.js';
import { type ReportFilter, ledgerWhere, prefix } from './filter.js';

/**
 * Profit and loss: every income and expense account over the period, from the ledger only.
 * Income is shown as credits less debits, expenses as debits less credits, so both read as
 * positive in the normal case. With `byMonth`, one row per account per Karachi month.
 */
export interface PnlRow {
  month: string | null;
  code: string;
  name: string;
  type: 'income' | 'expense';
  amount: Paisa;
}

export interface Pnl {
  rows: PnlRow[];
  income: Paisa;
  expenses: Paisa;
  netProfit: Paisa;
}

const query = (db: Db, f: ReportFilter, byMonth: boolean, explain = false) =>
  db<{ month: string | null; code: string; name: string; type: 'income' | 'expense'; amount: string }[]>`
    ${prefix(db, explain)}
    select ${byMonth ? db`to_char(l.entry_date, 'YYYY-MM')` : db`null::text`} as month, l.account_code as code, l.account_name as name,
           l.account_type as type,
           (case when l.account_type = 'income' then sum(l.credit_paisa - l.debit_paisa) else sum(l.debit_paisa - l.credit_paisa) end)::text as amount
    from ledger_lines l
    where l.account_type in ('income', 'expense') ${ledgerWhere(db, f)}
    group by 1, l.account_code, l.account_name, l.account_type
    order by 1 nulls first, l.account_code
  `;

export const pnl = async (db: Db, f: ReportFilter = {}, options: { byMonth?: boolean } = {}): Promise<Pnl> => {
  const rows = (await query(db, f, options.byMonth ?? false)).map((r) => ({ ...r, amount: readPaisa(r.amount) }));
  const income = sum(rows.filter((r) => r.type === 'income').map((r) => r.amount));
  const expenses = sum(rows.filter((r) => r.type === 'expense').map((r) => r.amount));
  return { rows, income, expenses, netProfit: sub(income, expenses) };
};

export const explainPnl = (db: Db, f: ReportFilter = {}) => query(db, f, true, true);

/** Net profit, the headline figure: the P&L's bottom line, nothing computed separately. */
export const netProfit = async (db: Db, f: ReportFilter = {}): Promise<{ income: Paisa; expenses: Paisa; netProfit: Paisa }> => {
  const { income, expenses, netProfit: net } = await pnl(db, f);
  return { income, expenses, netProfit: net };
};

/** The journal entries behind one P&L line. */
export const drillPnl = async (db: Db, f: ReportFilter, code: string, month?: string): Promise<{ entryIds: string[] }> => {
  const rows = await db<{ entry_id: string }[]>`
    select distinct l.entry_id from ledger_lines l
    where l.account_code = ${code} ${ledgerWhere(db, f)} ${month ? db`and to_char(l.entry_date, 'YYYY-MM') = ${month}` : db``}
    order by l.entry_id
  `;
  return { entryIds: rows.map((r) => r.entry_id) };
};
