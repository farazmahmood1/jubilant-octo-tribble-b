import type { Sql } from '../db.js';
import { recomputeOrderState } from '../db/repos/order-state.js';
import { logger } from '../logger.js';
import { postShipmentAccounting } from './accounting.js';
import { type PushResult, pushStockToShopify } from './shopify-stock.js';
import { reconcileShipmentStock } from './stock.js';

/**
 * Brings parcels whose facts changed up to date now, rather than on the next PostEx sync: a
 * Shopify webhook edited an order (its total, its lines), a cost arrived, a parcel was linked. The
 * same steps as the sync, in the same order (stock, then the order's state, then money, since
 * COGS is the cost of the units the stock pass moved), and as idempotent, so running here and in
 * the sync at once changes nothing twice. Bounded per call; the sync does whatever is left.
 */
export const settlePendingShipments = async (sql: Sql, limit = 25): Promise<{ stock: number; postings: number }> => {
  let stock = 0;
  let postings = 0;
  const moving = await sql<{ id: string }[]>`select id from shipments where stock_pending and order_id is not null order by id limit ${limit}`;
  for (const { id } of moving) {
    const result = await reconcileShipmentStock(sql, id);
    stock += result.moves;
    if (result.orderId) await recomputeOrderState(sql, result.orderId);
  }
  const money = await sql<{ id: string }[]>`select id from shipments where accounting_pending order by id limit ${limit}`;
  for (const { id } of money) {
    await postShipmentAccounting(sql, id);
    postings++;
  }
  return { stock, postings };
};

/**
 * What follows any change in the platform or from Shopify, before the answer is sent: the parcels
 * it touched are settled, and stock it moved is pushed to Shopify. Never fails the action that
 * called it; whatever it could not finish is picked up by the scheduled jobs.
 */
export const afterChange = async (sql: Sql, what: string): Promise<{ shopifyStock: PushResult | null }> => {
  try {
    await settlePendingShipments(sql);
  } catch (error) {
    logger.warn({ after: what, err: error }, 'Settling changed parcels failed; the next sync will');
  }
  try {
    return { shopifyStock: await pushStockToShopify(sql, { limit: 50 }) };
  } catch (error) {
    logger.warn({ after: what, err: error }, 'Pushing stock to Shopify failed; shopify:stock-push will retry');
    return { shopifyStock: null };
  }
};
