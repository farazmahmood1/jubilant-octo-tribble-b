import { type Db, readPaisa } from '../db/repos/upsert.js';
import type { Paisa } from '../lib/money.js';
import { type ReportFilter, ledgerWhere, prefix } from './filter.js';

/**
 * Delivered revenue: the Sales revenue account (4000), which only the shipment-delivered handler
 * and consignment sales post to (BUILD-PLAN 1.6). A parcel placed, confirmed, booked or in
 * transit has no line here; a parcel delivered and then returned has its sale and the reversal,
 * which net to zero. PR parcels never post a sale.
 */
export interface DeliveredRevenue {
  /** From parcels delivered by PostEx. */
  parcels: Paisa;
  /** From partners' consignment sales. */
  consignment: Paisa;
  total: Paisa;
  /** Parcels whose sale is live in the period (net revenue above zero). */
  parcelCount: number;
}

const query = (db: Db, f: ReportFilter, explain = false) => db<{ parcels: string; consignment: string; total: string; parcel_count: number }[]>`
  ${prefix(db, explain)}
  with lines as (
    select l.origin_type, l.shipment_id, l.credit_paisa - l.debit_paisa as amount
    from ledger_lines l
    where l.account_code = '4000' ${ledgerWhere(db, f)}
  )
  select coalesce(sum(amount) filter (where origin_type = 'shipment_sale'), 0)::text as parcels,
         coalesce(sum(amount) filter (where origin_type = 'consignment_sale'), 0)::text as consignment,
         coalesce(sum(amount), 0)::text as total,
         (select count(*)::int from (select shipment_id from lines where shipment_id is not null group by shipment_id having sum(amount) > 0) p) as parcel_count
  from lines
`;

export const deliveredRevenue = async (db: Db, f: ReportFilter = {}): Promise<DeliveredRevenue> => {
  const [row] = await query(db, f);
  return { parcels: readPaisa(row!.parcels), consignment: readPaisa(row!.consignment), total: readPaisa(row!.total), parcelCount: row!.parcel_count };
};

export const explainDeliveredRevenue = (db: Db, f: ReportFilter = {}) => query(db, f, true);

/** The parcels and consignment sales behind the figure, and every journal entry it sums. */
export const drillDeliveredRevenue = async (db: Db, f: ReportFilter = {}): Promise<{ shipmentIds: string[]; consignmentSaleIds: string[]; entryIds: string[] }> => {
  const rows = await db<{ shipment_id: string | null; origin_type: string; origin_id: string; entry_id: string }[]>`
    select l.shipment_id, l.origin_type, l.origin_id, l.entry_id from ledger_lines l
    where l.account_code = '4000' ${ledgerWhere(db, f)}
    order by l.entry_id
  `;
  const unique = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => x !== null))];
  return {
    shipmentIds: unique(rows.map((r) => r.shipment_id)),
    consignmentSaleIds: unique(rows.filter((r) => r.origin_type === 'consignment_sale').map((r) => r.origin_id)),
    entryIds: unique(rows.map((r) => r.entry_id)),
  };
};
