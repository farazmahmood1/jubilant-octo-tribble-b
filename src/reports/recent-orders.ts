import type { Db } from '../db/repos/upsert.js';
import { type ReportFilter, placedWhere } from './filter.js';

/**
 * The latest online orders with what each one made. The profit is the one the profit-per-parcel
 * report gives a parcel (sales revenue less the goods, PostEx's charges with their tax, marketing
 * and write-off), added up over the order's parcels, from the journal.
 *
 * It is given only for an order whose outcome is settled, delivered or returned: the sale and the
 * cost of the goods post on delivery, so before then the journal holds a half of the picture and a
 * number would mislead. Every other order has `profit: null`.
 */
export interface RecentOrder {
  orderId: string;
  orderNumber: string;
  store: string;
  placedAt: Date;
  /** Null when the caller may not see customers. */
  customerName: string | null;
  city: string | null;
  /** The first item, and how many other items the order has. */
  product: string | null;
  otherProducts: number;
  units: number;
  totalPaisa: string;
  state: string | null;
  /** The newest parcel, for opening it. */
  parcelId: string | null;
  profit: string | null;
}

/** The outcomes after which the books hold the whole picture of an order. */
export const SETTLED = ['delivered', 'returned_received'];
const COSTS = ['5000', '6000', '6010', '6020', '6100', '6200'];

/**
 * What each of these orders made, by order id: the profit-per-parcel figure added up over the
 * order's parcels. Only orders given are looked at; one with nothing posted is absent.
 */
export const orderProfits = async (db: Db, orderIds: readonly string[]): Promise<Map<string, string>> => {
  const profits = new Map<string, string>();
  if (orderIds.length === 0) return profits;
  const rows = await db<{ order_id: string; profit: string }[]>`
    select s.order_id::text, (
             coalesce(sum(l.credit_paisa - l.debit_paisa) filter (where l.account_code = '4000'), 0)
             - coalesce(sum(l.debit_paisa - l.credit_paisa) filter (where l.account_code = any(${COSTS}::text[])), 0)
           )::text as profit
    from shipments s
    join ledger_lines l on l.shipment_id = s.id and l.account_type in ('income', 'expense')
    where s.order_id = any(${orderIds}::bigint[])
    group by s.order_id
  `;
  for (const r of rows) profits.set(r.order_id, r.profit);
  return profits;
};

export const recentOrders = async (db: Db, f: Pick<ReportFilter, 'store'> = {}, options: { limit?: number; customers?: boolean } = {}): Promise<RecentOrder[]> => {
  const orders = await db<
    {
      id: string; order_number: string; store: string; placed_at: Date; customer_name: string | null; city: string | null; product: string | null;
      product_count: number; units: number; total: string; state: string | null; parcel_id: string | null;
    }[]
  >`
    select o.id::text, o.order_number, st.key as store, o.placed_at, c.name as customer_name, ad.city,
           (select l.title from order_lines l where l.order_id = o.id and l.qty > 0 order by l.id limit 1) as product,
           (select count(*)::int from order_lines l where l.order_id = o.id and l.qty > 0) as product_count,
           (select coalesce(sum(l.qty), 0)::int from order_lines l where l.order_id = o.id) as units,
           o.total_paisa::text as total, o.state, p.id::text as parcel_id
    from orders o
    join stores st on st.id = o.store_id
    left join customers c on c.id = o.customer_id
    left join addresses ad on ad.id = o.shipping_address_id
    left join lateral (select s.id from shipments s where s.order_id = o.id order by s.booked_at desc nulls last, s.id desc limit 1) p on true
    where o.channel = 'online' and o.state is distinct from 'pr' ${placedWhere(db, f)}
    order by o.placed_at desc, o.id desc
    limit ${options.limit ?? 5}
  `;
  const profits = await orderProfits(db, orders.filter((o) => o.state && SETTLED.includes(o.state)).map((o) => o.id));
  return orders.map((o) => ({
    orderId: o.id,
    orderNumber: o.order_number,
    store: o.store,
    placedAt: o.placed_at,
    customerName: options.customers === false ? null : o.customer_name,
    city: o.city,
    product: o.product,
    otherProducts: Math.max(0, o.product_count - 1),
    units: o.units,
    totalPaisa: o.total,
    state: o.state,
    parcelId: o.parcel_id,
    profit: profits.get(o.id) ?? null,
  }));
};
