import type { Db } from '../db/repos/upsert.js';
import { type ReportFilter, bookedWhere, prefix } from './filter.js';

/**
 * Return rate grouped by delivery city, or by the month the parcel was booked (Karachi). The same
 * population and the same definition as the headline return rate: returned ÷ (delivered +
 * returned) over parcels booked in the period, PR parcels excluded, parcels still out left out of
 * the denominator. A group with no final outcome yet has no rate and is not listed.
 */
export type ReturnRateGroup = 'city' | 'month';

export interface ReturnRateRow {
  key: string;
  label: string;
  delivered: number;
  returned: number;
  /** Parcels with a final delivered-or-returned outcome: the rate's denominator. */
  of: number;
  /** Returned ÷ of; never null here, because a group with nothing final is not listed. */
  rate: number;
}

const query = (db: Db, f: ReportFilter, by: ReturnRateGroup, explain = false) => {
  const key = by === 'city' ? db`coalesce(lower(trim(s.city)), '-')` : db`to_char(s.booked_at at time zone 'Asia/Karachi', 'YYYY-MM')`;
  const label = by === 'city' ? db`coalesce(min(trim(s.city)), '(no city)')` : db`to_char(s.booked_at at time zone 'Asia/Karachi', 'YYYY-MM')`;
  return db<{ key: string; label: string; delivered: number; returned: number }[]>`
    ${prefix(db, explain)}
    select ${key} as key, ${label} as label,
           count(*) filter (where s.status_code = '0005')::int as delivered,
           count(*) filter (where s.status_code = '0006')::int as returned
    from shipments s
    where not shipment_is_pr(s.id) and s.booked_at is not null ${bookedWhere(db, f)}
    group by 1
    having count(*) filter (where s.status_code in ('0005', '0006')) > 0
    order by (count(*) filter (where s.status_code in ('0005', '0006'))) desc, 1
    limit 200
  `;
};

export const returnRateBy = async (db: Db, f: ReportFilter, by: ReturnRateGroup): Promise<ReturnRateRow[]> =>
  (await query(db, f, by)).map((r) => {
    const of = r.delivered + r.returned;
    return { key: r.key, label: r.label, delivered: r.delivered, returned: r.returned, of, rate: r.returned / of };
  });

export const explainReturnRateBy = (db: Db, f: ReportFilter = {}) => query(db, f, 'city', true);
