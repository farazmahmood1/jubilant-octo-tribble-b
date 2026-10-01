import { postShipmentAccounting } from '../../domain/accounting.js';
import { reconcileShipmentStock } from '../../domain/stock.js';
import { recomputeOrderState } from './order-state.js';
import { resolveOpenReviewItem } from './review.js';
import { type Db, atomically } from './upsert.js';

export class LinkError extends Error {
  readonly status: 404 | 409;

  constructor(status: 404 | 409, message: string) {
    super(message);
    this.name = 'LinkError';
    this.status = status;
  }
}

export interface LinkResult {
  shipmentId: string;
  orderId: string;
  orderNumber: string;
  closedItems: number;
  stockMoves: number;
}

/**
 * A person links a parcel to an order. One transaction: the link, closing the parcel's
 * `unmatched_shipment` and `match_suggested` items, the audit row, the parcel's stock, the
 * order's state and its postings (the sale, if it was delivered). Either all of it happens or none of it does.
 *
 * Only an unmatched parcel can be linked. Re-pointing a linked parcel would leave its stock
 * moves describing the old order's lines; that needs an unlink with reversing moves, which is
 * not built yet.
 */
export const linkShipmentToOrder = async (db: Db, input: { shipmentId: string; orderId: string; actorId: string; note?: string }): Promise<LinkResult> =>
  atomically(db, async (tx) => {
    const [parcel] = await tx<{ tracking_number: string; order_id: string | null; store_id: string | null; account: string }[]>`
      select s.tracking_number, s.order_id, a.store_id, a.key as account
      from shipments s join postex_accounts a on a.id = s.postex_account_id
      where s.id = ${input.shipmentId}
      for update of s
    `;
    if (!parcel) throw new LinkError(404, `Shipment ${input.shipmentId} not found`);
    if (parcel.order_id) throw new LinkError(409, `Parcel ${parcel.tracking_number} is already linked to an order`);
    const [order] = await tx<{ order_number: string; store_id: string }[]>`select order_number, store_id from orders where id = ${input.orderId}`;
    if (!order) throw new LinkError(404, `Order ${input.orderId} not found`);
    // Rule 9: a parcel of one brand's PostEx account never belongs to the other brand's order.
    if (parcel.store_id !== order.store_id) {
      throw new LinkError(409, `Order ${order.order_number} belongs to another store than PostEx account "${parcel.account}"`);
    }

    await tx`
      update shipments set order_id = ${input.orderId}, match_method = 'manual', match_confidence = 1, stock_pending = true, accounting_pending = true
      where id = ${input.shipmentId}
    `;
    const note = input.note?.trim() || `Linked by hand to ${order.order_number}`;
    let closedItems = 0;
    for (const key of [`unmatched_shipment:${input.shipmentId}`, `match_suggested:${input.shipmentId}`]) {
      if (await resolveOpenReviewItem(tx, key, note, input.actorId)) closedItems++;
    }
    await tx`
      insert into audit_log (actor_id, action, entity, entity_id, before, after)
      values (${input.actorId}, 'shipment.link', 'shipments', ${input.shipmentId}, ${tx.json({ orderId: null })},
              ${tx.json({ orderId: input.orderId, orderNumber: order.order_number, note })})
    `;
    const stock = await reconcileShipmentStock(tx, input.shipmentId);
    await recomputeOrderState(tx, input.orderId);
    await postShipmentAccounting(tx, input.shipmentId);
    return { shipmentId: input.shipmentId, orderId: input.orderId, orderNumber: order.order_number, closedItems, stockMoves: stock.moves };
  });
