import { postShipmentAccounting } from '../../domain/accounting.js';
import { StockError, reconcileShipmentStock, returnParcelStockToWarehouse } from '../../domain/stock.js';
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

export interface UnlinkResult {
  shipmentId: string;
  /** The order the parcel no longer belongs to. */
  orderId: string;
  orderNumber: string;
  stockMoves: number;
  postingActions: Record<string, string>;
}

/**
 * A person says a parcel is linked to the wrong order. One transaction, the mirror of a link:
 * the units the parcel carried go back to the warehouse, the order is released and its state
 * recomputed, the sale and cost of goods the link caused are reversed (the postings re-derive
 * from a parcel with no order), the order is recorded as ruled out for this parcel so the
 * matcher does not pick it again, and the parcel is back in the queue as unmatched. Audited with
 * the actor and the note. Either all of it happens or none of it does.
 *
 * Refused for a parcel that is not linked, and for one already checked in: a person decided where
 * those units went, and an unlink must not quietly overrule them.
 */
export const unlinkShipmentFromOrder = async (db: Db, input: { shipmentId: string; actorId: string; note: string }): Promise<UnlinkResult> =>
  atomically(db, async (tx) => {
    const [parcel] = await tx<{ tracking_number: string; order_id: string | null; store_id: string | null; account: string; order_ref_number: string | null; order_number: string | null }[]>`
      select s.tracking_number, s.order_id, a.store_id, a.key as account, s.order_ref_number, o.order_number
      from shipments s join postex_accounts a on a.id = s.postex_account_id left join orders o on o.id = s.order_id
      where s.id = ${input.shipmentId}
      for update of s
    `;
    if (!parcel) throw new LinkError(404, `Shipment ${input.shipmentId} not found`);
    if (!parcel.order_id || !parcel.order_number) throw new LinkError(409, `Parcel ${parcel.tracking_number} is not linked to an order`);
    const orderId = parcel.order_id;

    const [audit] = await tx<{ id: string }[]>`
      insert into audit_log (actor_id, action, entity, entity_id, before, after)
      values (${input.actorId}, 'shipment.unlink', 'shipments', ${input.shipmentId}, ${tx.json({ orderId, orderNumber: parcel.order_number })},
              ${tx.json({ orderId: null, note: input.note })})
      returning id
    `;
    let stockMoves: number;
    try {
      stockMoves = await returnParcelStockToWarehouse(tx, { shipmentId: input.shipmentId, refId: audit!.id, actorId: input.actorId, at: new Date() });
    } catch (error) {
      // A rule the request broke, not a server fault; the transaction rolls back with it.
      if (error instanceof StockError) throw new LinkError(409, error.message);
      throw error;
    }

    await tx`
      update shipments
      set order_id = null, match_method = null, match_confidence = null,
          ruled_out_order_ids = array_append(ruled_out_order_ids, ${orderId}::text),
          stock_pending = true, accounting_pending = true
      where id = ${input.shipmentId}
    `;
    // A weak match no longer exists to check, so its item closes.
    await resolveOpenReviewItem(tx, `match_suggested:${input.shipmentId}`, input.note, input.actorId);
    // The parcel is unmatched again and must be in the queue. A person already closed its earlier
    // unmatched item (by linking), and a decided item is not reopened by `openReviewItem`, so
    // this opens a fresh one directly.
    await tx`
      insert into reconciliation_items (kind, dedupe_key, store_id, shipment_id, severity, detail)
      values ('unmatched_shipment', ${`unmatched_shipment:${input.shipmentId}`}, ${parcel.store_id}, ${input.shipmentId}, 'warning',
              ${tx.json({ account: parcel.account, trackingNumber: parcel.tracking_number, orderRefNumber: parcel.order_ref_number, reason: 'unlinked_by_hand', unlinkedFrom: parcel.order_number })})
      on conflict (dedupe_key) where status = 'open' do nothing
    `;
    await recomputeOrderState(tx, orderId);
    const posting = await postShipmentAccounting(tx, input.shipmentId);
    return { shipmentId: input.shipmentId, orderId, orderNumber: parcel.order_number, stockMoves, postingActions: posting.actions };
  });

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
 * Only an unmatched parcel can be linked. To move a parcel to another order, unlink it first
 * (`unlinkShipmentFromOrder`): re-pointing it directly would leave its stock moves describing
 * the old order's lines.
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
