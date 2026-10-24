import { STAGE_SQL } from '../db/repos/parcels.js';
import type { Db } from '../db/repos/upsert.js';
import { type ReportFilter, bookedWhere, prefix } from './filter.js';

/**
 * The parcel population the return-rate and delivery-success reports share: parcels booked in
 * the period on the store's PostEx accounts, **PR parcels excluded** (`shipment_is_pr`: the
 * order is tagged PR, or a person classified the parcel as PR; a refused PR package is not a
 * lost sale). Outcomes are the parcel's stage, from its whole PostEx history (not its latest
 * code, which keeps moving on the way back):
 * - delivered: `delivered` (0005);
 * - returned: the delivery failed and PostEx is bringing it back (`returning`: 0040 and every
 *   movement after it) or has (`returned`: 0006). Both are lost sales; the counts say how many
 *   of them are back with us yet;
 * - cancelled: `cancelled` (0002);
 * - in flight: anything else.
 */
export type Outcome = 'delivered' | 'returned' | 'cancelled' | 'in_flight';

export const outcomeSql = `case ${STAGE_SQL} when 'delivered' then 'delivered' when 'returning' then 'returned' when 'returned' then 'returned' when 'cancelled' then 'cancelled' else 'in_flight' end`;

export interface OutcomeCounts {
  booked: number;
  delivered: number;
  /** Returned to us or on the way back: the two below added together. */
  returned: number;
  /** Of those, handed back to us by PostEx (0006). */
  returnedBack: number;
  /** Of those, still on the way back. */
  returning: number;
  cancelled: number;
  inFlight: number;
  /** Delivered with no failed attempt (0013) on the way. */
  deliveredFirstAttempt: number;
  /** The COD the returned parcels were sent to collect, integer paisa as a string: what came back unsold. */
  returnedValue: string;
}

export const outcomeQuery = (db: Db, f: ReportFilter, explain = false) =>
  db<{ booked: number; delivered: number; returned_back: number; returning: number; cancelled: number; in_flight: number; first_attempt: number; returned_value: string }[]>`
    ${prefix(db, explain)}
    select count(*)::int as booked,
           count(*) filter (where p.stage = 'delivered')::int as delivered,
           count(*) filter (where p.stage = 'returned')::int as returned_back,
           count(*) filter (where p.stage = 'returning')::int as returning,
           count(*) filter (where p.stage = 'cancelled')::int as cancelled,
           count(*) filter (where p.stage not in ('delivered', 'returned', 'returning', 'cancelled'))::int as in_flight,
           count(*) filter (where p.stage = 'delivered' and p.attempts_count = 0)::int as first_attempt,
           coalesce(sum(p.cod_amount_paisa) filter (where p.stage in ('returned', 'returning')), 0)::text as returned_value
    from (
      select ${db.unsafe(STAGE_SQL)} as stage, s.attempts_count, s.cod_amount_paisa
      from shipments s
      where not shipment_is_pr(s.id) ${bookedWhere(db, f)}
    ) p
  `;

export const outcomeCounts = async (db: Db, f: ReportFilter): Promise<OutcomeCounts> => {
  const [r] = await outcomeQuery(db, f);
  return {
    booked: r!.booked,
    delivered: r!.delivered,
    returned: r!.returned_back + r!.returning,
    returnedBack: r!.returned_back,
    returning: r!.returning,
    cancelled: r!.cancelled,
    inFlight: r!.in_flight,
    deliveredFirstAttempt: r!.first_attempt,
    returnedValue: r!.returned_value,
  };
};

/** The parcels with one outcome: the drill-down of both reports. */
export const parcelsWithOutcome = async (db: Db, f: ReportFilter, outcome: Outcome): Promise<{ shipmentIds: string[] }> => {
  const rows = await db<{ id: string }[]>`
    select s.id from shipments s
    where not shipment_is_pr(s.id) and ${db.unsafe(outcomeSql)} = ${outcome} ${bookedWhere(db, f)}
    order by s.id
  `;
  return { shipmentIds: rows.map((r) => r.id) };
};
