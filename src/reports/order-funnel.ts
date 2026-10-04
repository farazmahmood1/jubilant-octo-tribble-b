import type { Db } from '../db/repos/upsert.js';
import { type ReportFilter, placedWhere, prefix } from './filter.js';

/**
 * The order funnel: of the orders placed in the period, how many got as far as each step. Each
 * count is "reached this step or beyond", so every step is a subset of the one before it and
 * the gaps between them are where orders dropped off.
 *
 * Read from the stored order state (rule 7) and from whether a parcel exists, not re-derived:
 * - confirmed: the desk confirmed it, or a parcel was booked anyway
 * - booked: a parcel exists in PostEx, whatever became of it afterwards
 * - in transit: the parcel has moved (in transit, an attempt was made, delivered, or on its way back)
 * - delivered / returned: PostEx's final outcome. A parcel on its way back is not returned until it
 *   arrives, as in the return rate.
 *
 * Online orders only: PR packages and consignment sales never went through the confirmation desk.
 */
export interface OrderFunnel {
  placed: number;
  confirmed: number;
  booked: number;
  inTransit: number;
  delivered: number;
  returned: number;
}

export const orderFunnelQuery = (db: Db, f: ReportFilter, explain = false) =>
  db<{ placed: number; confirmed: number; booked: number; in_transit: number; delivered: number; returned: number }[]>`
    ${prefix(db, explain)}
    with cohort as (
      select o.state, exists (select 1 from shipments s where s.order_id = o.id) as has_parcel
      from orders o
      where o.channel = 'online' and o.state is distinct from 'pr' ${placedWhere(db, f)}
    )
    select count(*)::int as placed,
           count(*) filter (where has_parcel or state in ('confirmed', 'ready_to_book'))::int as confirmed,
           count(*) filter (where has_parcel)::int as booked,
           count(*) filter (where state in ('in_transit', 'failed', 'delivered', 'returning', 'returned_received'))::int as in_transit,
           count(*) filter (where state = 'delivered')::int as delivered,
           count(*) filter (where state = 'returned_received')::int as returned
    from cohort
  `;

export const orderFunnel = async (db: Db, f: ReportFilter = {}): Promise<OrderFunnel> => {
  const [r] = await orderFunnelQuery(db, f);
  return { placed: r!.placed, confirmed: r!.confirmed, booked: r!.booked, inTransit: r!.in_transit, delivered: r!.delivered, returned: r!.returned };
};

export const explainOrderFunnel = (db: Db, f: ReportFilter = {}) => orderFunnelQuery(db, f, true);
