import { type Db, readPaisa } from '../db/repos/upsert.js';
import type { Paisa } from '../lib/money.js';
import { type ReportFilter, placedWhere, prefix } from './filter.js';

/**
 * Sales: what customers ordered on Shopify in the period, by the day each order was placed, before
 * anything is delivered or returned. Cancelled orders and PR packages are left out. Close to
 * Shopify's own "Total sales" for orders placed in the period, and always more than delivered
 * revenue, which only counts once PostEx delivers.
 */
export interface Sales {
  orders: number;
  /** Order totals: items after discounts, plus shipping and tax. */
  total: Paisa;
  /** Items before discounts, the way Shopify's "Gross sales" reads. */
  gross: Paisa;
  discounts: Paisa;
  shipping: Paisa;
}

const query = (db: Db, f: ReportFilter, explain = false) =>
  db<{ orders: number; total: string; gross: string; discounts: string; shipping: string }[]>`
    ${prefix(db, explain)}
    select count(*)::int as orders,
           coalesce(sum(o.total_paisa), 0)::text as total,
           coalesce(sum(o.subtotal_paisa + o.discount_paisa), 0)::text as gross,
           coalesce(sum(o.discount_paisa), 0)::text as discounts,
           coalesce(sum(o.shipping_paisa), 0)::text as shipping
    from orders o
    where o.cancelled_at is null and o.state is distinct from 'pr' ${placedWhere(db, f)}
  `;

export const sales = async (db: Db, f: ReportFilter = {}): Promise<Sales> => {
  const [r] = await query(db, f);
  return { orders: r!.orders, total: readPaisa(r!.total), gross: readPaisa(r!.gross), discounts: readPaisa(r!.discounts), shipping: readPaisa(r!.shipping) };
};

export const explainSales = (db: Db, f: ReportFilter = {}) => query(db, f, true);
