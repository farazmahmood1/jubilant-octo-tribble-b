import { type Db, readPaisa } from '../db/repos/upsert.js';
import { type Paisa, mul, ratio, sub, sum } from '../lib/money.js';
import { type ReportFilter, ledgerWhere, prefix } from './filter.js';

/**
 * What each parcel made, from its own ledger lines in the period: revenue, less the goods (COGS,
 * or marketing for a PR parcel), PostEx's charges with their tax, and any write-off. A returned
 * parcel shows its reversed sale (zero revenue) and the charges it still cost.
 */
export interface ParcelProfit {
  shipmentId: string;
  trackingNumber: string;
  orderNumber: string | null;
  store: string | null;
  revenue: Paisa;
  goods: Paisa;
  postexCharges: Paisa;
  marketing: Paisa;
  writeOff: Paisa;
  profit: Paisa;
}

export interface ProfitPerParcel {
  rows: ParcelProfit[];
  parcels: number;
  total: Paisa;
  /** Total ÷ parcels, rounded half-up to the paisa. */
  average: Paisa | null;
}

const query = (db: Db, f: ReportFilter, explain = false) =>
  db<{ shipment_id: string; tracking_number: string; order_number: string | null; store: string | null; revenue: string; goods: string; charges: string; marketing: string; write_off: string }[]>`
    ${prefix(db, explain)}
    select l.shipment_id::text, s.tracking_number, o.order_number, st.key as store,
           coalesce(sum(l.credit_paisa - l.debit_paisa) filter (where l.account_code = '4000'), 0)::text as revenue,
           coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_code = '5000'), 0)::text as goods,
           coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_code in ('6000', '6010', '6020')), 0)::text as charges,
           coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_code = '6100'), 0)::text as marketing,
           coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_code = '6200'), 0)::text as write_off
    from ledger_lines l
    join shipments s on s.id = l.shipment_id
    left join orders o on o.id = s.order_id
    left join stores st on st.id = l.store_id
    where l.shipment_id is not null and l.account_type in ('income', 'expense') ${ledgerWhere(db, f)}
    group by l.shipment_id, s.tracking_number, o.order_number, st.key
    order by l.shipment_id
  `;

export const profitPerParcel = async (db: Db, f: ReportFilter = {}): Promise<ProfitPerParcel> => {
  const rows = (await query(db, f)).map((r) => {
    const revenue = readPaisa(r.revenue);
    const goods = readPaisa(r.goods);
    const postexCharges = readPaisa(r.charges);
    const marketing = readPaisa(r.marketing);
    const writeOff = readPaisa(r.write_off);
    return {
      shipmentId: r.shipment_id,
      trackingNumber: r.tracking_number,
      orderNumber: r.order_number,
      store: r.store,
      revenue,
      goods,
      postexCharges,
      marketing,
      writeOff,
      profit: sub(sub(sub(sub(revenue, goods), postexCharges), marketing), writeOff),
    };
  });
  const total = sum(rows.map((r) => r.profit));
  return {
    rows,
    parcels: rows.length,
    total,
    average: rows.length === 0 ? null : mul(total, ratio(1n, BigInt(rows.length)), 'half-up'),
  };
};

export const explainProfitPerParcel = (db: Db, f: ReportFilter = {}) => query(db, f, true);

/** The journal entries behind one parcel's figures. */
export const drillProfitPerParcel = async (db: Db, f: ReportFilter, shipmentId: string): Promise<{ entryIds: string[] }> => {
  const rows = await db<{ entry_id: string }[]>`
    select distinct l.entry_id from ledger_lines l
    where l.shipment_id = ${shipmentId} and l.account_type in ('income', 'expense') ${ledgerWhere(db, f)}
    order by l.entry_id
  `;
  return { entryIds: rows.map((r) => r.entry_id) };
};
