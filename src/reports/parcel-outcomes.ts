import type { Db } from '../db/repos/upsert.js';
import { type ReportFilter, bookedWhere, prefix } from './filter.js';

/**
 * The parcel population the return-rate and delivery-success reports share: parcels booked in
 * the period on the store's PostEx accounts, **PR parcels excluded** (their order is channel
 * `pr`: a refused PR package is not a lost sale). Outcomes are the derived status codes:
 * delivered 0005, returned to the merchant 0006, cancelled 0002; anything else is in flight.
 */
export type Outcome = 'delivered' | 'returned' | 'cancelled' | 'in_flight';

export const outcomeSql = `case s.status_code when '0005' then 'delivered' when '0006' then 'returned' when '0002' then 'cancelled' else 'in_flight' end`;

export interface OutcomeCounts {
  booked: number;
  delivered: number;
  returned: number;
  cancelled: number;
  inFlight: number;
  /** Delivered with no failed attempt (0013) on the way. */
  deliveredFirstAttempt: number;
}

export const outcomeQuery = (db: Db, f: ReportFilter, explain = false) =>
  db<{ booked: number; delivered: number; returned: number; cancelled: number; in_flight: number; first_attempt: number }[]>`
    ${prefix(db, explain)}
    select count(*)::int as booked,
           count(*) filter (where s.status_code = '0005')::int as delivered,
           count(*) filter (where s.status_code = '0006')::int as returned,
           count(*) filter (where s.status_code = '0002')::int as cancelled,
           count(*) filter (where s.status_code is null or s.status_code not in ('0005', '0006', '0002'))::int as in_flight,
           count(*) filter (where s.status_code = '0005' and s.attempts_count = 0)::int as first_attempt
    from shipments s
    left join orders o on o.id = s.order_id
    where o.channel is distinct from 'pr' ${bookedWhere(db, f)}
  `;

export const outcomeCounts = async (db: Db, f: ReportFilter): Promise<OutcomeCounts> => {
  const [r] = await outcomeQuery(db, f);
  return { booked: r!.booked, delivered: r!.delivered, returned: r!.returned, cancelled: r!.cancelled, inFlight: r!.in_flight, deliveredFirstAttempt: r!.first_attempt };
};

/** The parcels with one outcome: the drill-down of both reports. */
export const parcelsWithOutcome = async (db: Db, f: ReportFilter, outcome: Outcome): Promise<{ shipmentIds: string[] }> => {
  const rows = await db<{ id: string }[]>`
    select s.id from shipments s left join orders o on o.id = s.order_id
    where o.channel is distinct from 'pr' and ${db.unsafe(outcomeSql)} = ${outcome} ${bookedWhere(db, f)}
    order by s.id
  `;
  return { shipmentIds: rows.map((r) => r.id) };
};
