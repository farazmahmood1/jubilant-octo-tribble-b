import { type Db, readPaisa } from '../db/repos/upsert.js';
import { type Paisa, sum } from '../lib/money.js';
import { type ReportFilter, ledgerWhere, prefix, todayInKarachi } from './filter.js';

/**
 * Cash with PostEx: the COD receivable (1100) still open per parcel at the end of the period,
 * from the ledger: COD on delivery, less PostEx's charges, less what it has paid out. Aged by
 * Karachi days since delivery (the sale's date), the overdue view the proposal asks for (§6.6).
 * A parcel with no live sale (never delivered, returned, or a PR package) can only carry
 * charges, so its balance is money owed to PostEx; it is kept in its own `no_sale` bucket rather
 * than netted silently against cash awaited.
 */
export const BUCKETS = ['0-7', '8-14', '15-30', '31+', 'no_sale'] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface CashBucket {
  bucket: Bucket;
  parcels: number;
  amount: Paisa;
}

export interface CashAwaitingPayout {
  asOf: string;
  buckets: CashBucket[];
  /** Positive balances: COD collected and not yet paid out. */
  awaiting: Paisa;
  /** Negative balances: charges on parcels with no COD to deduct them from. */
  owedToPostex: Paisa;
}

const balances = (db: Db, f: ReportFilter, asOf: string) => db`
  with bal as (
    select l.shipment_id, sum(l.debit_paisa - l.credit_paisa) as amount
    from ledger_lines l
    where l.account_code = '1100' and l.shipment_id is not null and l.entry_date <= ${asOf}::date
      ${ledgerWhere(db, { store: f.store })}
    group by l.shipment_id
    having sum(l.debit_paisa - l.credit_paisa) <> 0
  )
  select bal.shipment_id, bal.amount,
         case
           when sale.day is null then 'no_sale'
           when ${asOf}::date - sale.day <= 7 then '0-7'
           when ${asOf}::date - sale.day <= 14 then '8-14'
           when ${asOf}::date - sale.day <= 30 then '15-30'
           else '31+'
         end as bucket
  from bal
  left join lateral (
    select min(e.entry_date) as day from journal_entries e
    where e.source_type = 'shipment_sale' and e.source_id = bal.shipment_id::text and e.reversed_by is null and e.entry_date <= ${asOf}::date
  ) sale on true
`;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const query = (db: Db, f: ReportFilter, asOf: string, explain = false) =>
  db<{ bucket: Bucket; parcels: number; amount: string; positive: string; negative: string }[]>`
    ${prefix(db, explain)}
    select b.bucket, count(*)::int as parcels, sum(b.amount)::text as amount,
           coalesce(sum(b.amount) filter (where b.amount > 0), 0)::text as positive,
           coalesce(sum(b.amount) filter (where b.amount < 0), 0)::text as negative
    from (${balances(db, f, asOf)}) b
    group by b.bucket
  `;

const asOfDay = (f: ReportFilter): string => {
  const asOf = f.to ?? todayInKarachi();
  if (!DAY.test(asOf)) throw new RangeError(`Not a calendar day: "${asOf}"`);
  return asOf;
};

export const cashAwaitingPayout = async (db: Db, f: ReportFilter = {}): Promise<CashAwaitingPayout> => {
  const asOf = asOfDay(f);
  const rows = await query(db, f, asOf);
  const buckets = BUCKETS.map((bucket) => {
    const row = rows.find((r) => r.bucket === bucket);
    return { bucket, parcels: row?.parcels ?? 0, amount: readPaisa(row?.amount ?? '0') };
  });
  return {
    asOf,
    buckets,
    awaiting: sum(rows.map((r) => readPaisa(r.positive))),
    owedToPostex: sum(rows.map((r) => readPaisa(r.negative))),
  };
};

export const explainCashAwaitingPayout = (db: Db, f: ReportFilter = {}) => query(db, f, asOfDay(f), true);

/** The parcels in one ageing bucket, oldest balance first. */
export const drillCashAwaitingPayout = async (db: Db, f: ReportFilter, bucket: Bucket): Promise<{ shipmentIds: string[] }> => {
  const rows = await db<{ shipment_id: string }[]>`
    select b.shipment_id::text from (${balances(db, f, asOfDay(f))}) b where b.bucket = ${bucket} order by b.shipment_id
  `;
  return { shipmentIds: rows.map((r) => r.shipment_id) };
};
