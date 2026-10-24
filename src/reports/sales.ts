import { type Db, readPaisa } from '../db/repos/upsert.js';
import type { Paisa } from '../lib/money.js';
import { type ReportFilter, placedWhere, prefix } from './filter.js';

/**
 * Sales: what customers ordered on Shopify in the period, by the day each order was placed, before
 * anything is delivered or returned. Nothing here is money collected: a COD order only becomes
 * revenue when PostEx delivers it.
 *
 * Which orders count is read from the order's derived state, never from Shopify's cancel flag
 * alone, so the figure for a past period does not move when something happens to an order later:
 * - **Left out:** PR packages, and orders cancelled before anything was shipped (in Shopify or at
 *   the desk, state `cancelled`; also a parcel PostEx cancelled before pickup). These are
 *   `cancelled`, reported apart.
 * - **Kept:** an order whose parcel was booked, even if the order was cancelled in Shopify
 *   afterwards (a refused COD parcel is often cancelled there once it is back). Its parcel decides
 *   its state, and its outcome shows under returns, not as a cancellation.
 *
 * Close to Shopify's own "Total sales" for orders placed in the period, and always more than
 * delivered revenue.
 */
export interface Sales {
  orders: number;
  /** Order totals: items after discounts, plus shipping and tax. */
  total: Paisa;
  /** Items before discounts, the way Shopify's "Gross sales" reads. */
  gross: Paisa;
  discounts: Paisa;
  shipping: Paisa;
  /** Orders placed in the period and cancelled before anything shipped, and what they were worth. */
  cancelled: { orders: number; total: Paisa };
}

/** An order's state, or what it would be from Shopify alone for an order the recompute has not reached yet. */
const STATE = `coalesce(o.state, case when o.cancelled_at is null then 'placed' else 'cancelled' end)`;

const query = (db: Db, f: ReportFilter, explain = false) =>
  db<{ orders: number; total: string; gross: string; discounts: string; shipping: string; cancelled: number; cancelled_total: string }[]>`
    ${prefix(db, explain)}
    select count(*) filter (where s.counted)::int as orders,
           coalesce(sum(o.total_paisa) filter (where s.counted), 0)::text as total,
           coalesce(sum(o.subtotal_paisa + o.discount_paisa) filter (where s.counted), 0)::text as gross,
           coalesce(sum(o.discount_paisa) filter (where s.counted), 0)::text as discounts,
           coalesce(sum(o.shipping_paisa) filter (where s.counted), 0)::text as shipping,
           count(*) filter (where s.state = 'cancelled')::int as cancelled,
           coalesce(sum(o.total_paisa) filter (where s.state = 'cancelled'), 0)::text as cancelled_total
    from orders o
    cross join lateral (select ${db.unsafe(STATE)} as state, ${db.unsafe(STATE)} not in ('cancelled', 'pr') as counted) s
    where o.channel <> 'consignment' ${placedWhere(db, f)}
  `;

export const sales = async (db: Db, f: ReportFilter = {}): Promise<Sales> => {
  const [r] = await query(db, f);
  return {
    orders: r!.orders,
    total: readPaisa(r!.total),
    gross: readPaisa(r!.gross),
    discounts: readPaisa(r!.discounts),
    shipping: readPaisa(r!.shipping),
    cancelled: { orders: r!.cancelled, total: readPaisa(r!.cancelled_total) },
  };
};

export const explainSales = (db: Db, f: ReportFilter = {}) => query(db, f, true);
