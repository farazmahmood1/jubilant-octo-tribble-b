import type { Db } from '../db/repos/upsert.js';
import { endOfKarachiDay, formatKarachi, startOfKarachiDate } from '../lib/time.js';

/**
 * What every report is filtered by. Days are Karachi calendar days, inclusive, as journal entries
 * are dated (rule 4). A store narrows ledger figures to lines carrying that brand; lines entered
 * for both brands (an opening balance with no store) appear only in the unfiltered view.
 */
export interface ReportFilter {
  /** First day, inclusive. */
  from?: string;
  /** Last day, inclusive. */
  to?: string;
  store?: 'nur' | 'organics';
}

export type Fragment = ReturnType<Db>;

/** `explain (format json)` in front of a report's query, for the plan checks; empty otherwise. */
export const prefix = (db: Db, explain: boolean): Fragment => (explain ? db`explain (format json)` : db``);

/** Ledger lines in the filter's days and store. `alias` is the ledger_lines alias. */
export const ledgerWhere = (db: Db, f: ReportFilter, alias = 'l'): Fragment => db`
  ${f.from ? db`and ${db(alias)}.entry_date >= ${f.from}::date` : db``}
  ${f.to ? db`and ${db(alias)}.entry_date <= ${f.to}::date` : db``}
  ${f.store ? db`and ${db(alias)}.store_id = (select id from stores where key = ${f.store})` : db``}
`;

/** Parcels booked in the filter's days (Karachi), on the store's PostEx accounts. `alias` is the shipments alias. */
export const bookedWhere = (db: Db, f: ReportFilter, alias = 's'): Fragment => db`
  ${f.from ? db`and ${db(alias)}.booked_at >= ${startOfKarachiDate(f.from)}` : db``}
  ${f.to ? db`and ${db(alias)}.booked_at <= ${endOfKarachiDay(f.to)}` : db``}
  ${f.store ? db`and ${db(alias)}.postex_account_id in (select id from postex_accounts where store_id = (select id from stores where key = ${f.store}))` : db``}
`;

export const todayInKarachi = (): string => formatKarachi(new Date()).slice(0, 10);

/** A share as numerator, denominator and the rate; null rate when there is nothing to divide. */
export interface Rate {
  count: number;
  of: number;
  rate: number | null;
}

export const rate = (count: number, of: number): Rate => ({ count, of, rate: of === 0 ? null : count / of });
