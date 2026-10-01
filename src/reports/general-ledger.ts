import { type Db, readPaisa } from '../db/repos/upsert.js';
import { type Paisa, add } from '../lib/money.js';
import { type ReportFilter, ledgerWhere, prefix } from './filter.js';

/**
 * General ledger for one account: the balance brought forward, then every line in the period in
 * date order with the running balance (debit less credit). Each line names its entry, which is
 * the drill-down.
 */
export interface GeneralLedgerLine {
  lineId: string;
  entryId: string;
  date: string;
  memo: string;
  originType: string;
  originId: string;
  shipmentId: string | null;
  debit: Paisa;
  credit: Paisa;
  balance: Paisa;
}

export interface GeneralLedger {
  code: string;
  opening: Paisa;
  lines: GeneralLedgerLine[];
  closing: Paisa;
}

const query = (db: Db, code: string, f: ReportFilter, explain = false) =>
  db<{ line_id: string; entry_id: string; date: string; memo: string; origin_type: string; origin_id: string; shipment_id: string | null; debit: string; credit: string; running: string }[]>`
    ${prefix(db, explain)}
    select l.line_id, l.entry_id, l.entry_date::text as date, l.memo, l.origin_type, l.origin_id, l.shipment_id::text,
           l.debit_paisa::text as debit, l.credit_paisa::text as credit,
           sum(l.debit_paisa - l.credit_paisa) over (order by l.entry_date, l.entry_id, l.line_id)::text as running
    from ledger_lines l
    where l.account_code = ${code} ${ledgerWhere(db, f)}
    order by l.entry_date, l.entry_id, l.line_id
  `;

export const generalLedger = async (db: Db, code: string, f: ReportFilter = {}): Promise<GeneralLedger> => {
  const [brought] = f.from
    ? await db<{ balance: string }[]>`
        select coalesce(sum(l.debit_paisa - l.credit_paisa), 0)::text as balance from ledger_lines l
        where l.account_code = ${code} and l.entry_date < ${f.from}::date ${ledgerWhere(db, { store: f.store })}
      `
    : [{ balance: '0' }];
  const opening = readPaisa(brought!.balance);
  const lines = (await query(db, code, f)).map((r) => ({
    lineId: r.line_id,
    entryId: r.entry_id,
    date: r.date,
    memo: r.memo,
    originType: r.origin_type,
    originId: r.origin_id,
    shipmentId: r.shipment_id,
    debit: readPaisa(r.debit),
    credit: readPaisa(r.credit),
    balance: add(opening, readPaisa(r.running)),
  }));
  return { code, opening, lines, closing: lines.at(-1)?.balance ?? opening };
};

export const explainGeneralLedger = (db: Db, code: string, f: ReportFilter = {}) => query(db, code, f, true);
