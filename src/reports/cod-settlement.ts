import { type Db, readPaisa } from '../db/repos/upsert.js';
import { type Paisa, sub } from '../lib/money.js';
import { type ReportFilter, ledgerWhere, prefix, todayInKarachi } from './filter.js';

/**
 * Where the COD on the parcels PostEx delivered in the period has gone, as of the period's last
 * day: paid out to us, kept by PostEx as its charges, or still held. Read per parcel from the COD
 * receivable (1100), so the three parts always add back to what was sold. A parcel counts by the
 * day of its live sale, the same day the cash ageing uses; one returned after delivery has no
 * live sale and drops out, and a PR package never had one.
 */
export interface CodSettlement {
  asOf: string;
  parcels: number;
  /** The COD on those parcels. */
  sold: Paisa;
  /** What PostEx has paid out on them. */
  received: Paisa;
  /** What PostEx kept: its charges and their tax. */
  charges: Paisa;
  /** Sold less received less charges: still with PostEx. */
  withPostex: Paisa;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const query = (db: Db, f: ReportFilter, asOf: string, explain = false) =>
  db<{ parcels: number; sold: string; received: string; held: string }[]>`
    ${prefix(db, explain)}
    with per as (
      select l.shipment_id,
             sum(l.debit_paisa - l.credit_paisa) as held,
             coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.origin_type = 'shipment_sale'), 0) as sold,
             coalesce(sum(l.credit_paisa - l.debit_paisa) filter (where l.origin_type = 'payout_line'), 0) as received
      from ledger_lines l
      where l.account_code = '1100' and l.shipment_id is not null and l.entry_date <= ${asOf}::date
        ${ledgerWhere(db, { store: f.store })}
      group by l.shipment_id
    )
    select count(*)::int as parcels, coalesce(sum(per.sold), 0)::text as sold,
           coalesce(sum(per.received), 0)::text as received, coalesce(sum(per.held), 0)::text as held
    from per
    join lateral (
      select min(e.entry_date) as day from journal_entries e
      where e.source_type = 'shipment_sale' and e.source_id = per.shipment_id::text and e.reversed_by is null and e.entry_date <= ${asOf}::date
    ) sale on true
    where sale.day is not null ${f.from ? db`and sale.day >= ${f.from}::date` : db``}
  `;

const asOfDay = (f: ReportFilter): string => {
  const asOf = f.to ?? todayInKarachi();
  if (!DAY.test(asOf)) throw new RangeError(`Not a calendar day: "${asOf}"`);
  return asOf;
};

export const codSettlement = async (db: Db, f: ReportFilter = {}): Promise<CodSettlement> => {
  const asOf = asOfDay(f);
  const [row] = await query(db, f, asOf);
  const sold = readPaisa(row?.sold ?? '0');
  const received = readPaisa(row?.received ?? '0');
  const withPostex = readPaisa(row?.held ?? '0');
  // Every other line on the receivable is a charge, so the parts add up by construction.
  return { asOf, parcels: row?.parcels ?? 0, sold, received, charges: sub(sub(sold, received), withPostex), withPostex };
};

export const explainCodSettlement = (db: Db, f: ReportFilter = {}) => query(db, f, asOfDay(f), true);
