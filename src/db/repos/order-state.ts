import { type OrderState, explain } from '../../domain/order-state.js';
import { POSTEX_STATUS_CODES, type ShipmentEvent } from '../../integrations/postex/mapper.js';
import { recomputeConfirmation } from './confirmations.js';
import { type Db, atomically } from './upsert.js';

// The tag rules moved beside the confirmation they feed; existing importers keep this path.
export { type ConfirmationTags, DEFAULT_CONFIRMATION_TAGS, confirmationFromTags, tagWords } from './confirmations.js';

/**
 * Writes the derived order state (T06) to `orders.state`, and every change to
 * `order_state_log` with the reason (Step 7, rule 7). Nothing else writes `orders.state`.
 *
 * The confirmation is the order's `confirmations` row, recomputed here first: the desk's
 * attempts, or before the desk's first attempt the Shopify tags the team used (3.2 note S7). "On
 * hold" comes from Shopify's own fulfillment status (the team's "Mark as on hold"), not from a
 * tag. A confirmed order on hold is `confirmed` but not ready to book.
 *
 * An order with several parcels (a re-send after a return) follows its most recently booked one:
 * that is where its goods and money are now.
 */

export interface StateChange {
  orderId: string;
  from: OrderState | null;
  to: OrderState;
  changed: boolean;
}

/** Recomputes one order's state and logs it if it moved. Safe to call any number of times. */
export const recomputeOrderState = async (db: Db, orderId: string): Promise<StateChange> =>
  atomically(db, async (tx) => {
    const [order] = await tx<{ state: OrderState | null; channel: 'online' | 'consignment' | 'pr'; cancelled_at: Date | null; fulfillment_status: string | null }[]>`
      select state, case when order_is_pr(id) then 'pr' else channel end as channel, cancelled_at, fulfillment_status from orders where id = ${orderId} for update
    `;
    if (!order) throw new Error(`Order ${orderId} not found`);
    const [parcel] = await tx<{ id: string; tracking_number: string }[]>`
      select id, tracking_number from shipments where order_id = ${orderId}
      order by booked_at desc nulls last, id desc limit 1
    `;
    const stored = parcel
      ? await tx<{ code: string; message: string; occurred_at: Date | null }[]>`
          select code, message, occurred_at from shipment_events where shipment_id = ${parcel.id}
        `
      : [];
    const events: ShipmentEvent[] = stored.map((e) => ({ code: e.code, message: e.message, occurredAt: e.occurred_at, known: Object.hasOwn(POSTEX_STATUS_CODES, e.code) }));

    const confirmation = await recomputeConfirmation(tx, orderId);
    const confirmationState = confirmation && confirmation.source !== 'none' ? confirmation.state : null;

    const explanation = explain({
      order: { channel: order.channel, cancelledAt: order.cancelled_at, onHold: order.fulfillment_status === 'on_hold' },
      shipment: parcel ? { trackingNumber: parcel.tracking_number } : null,
      events,
      confirmation: confirmationState ? { state: confirmationState } : null,
    });

    if (explanation.state === order.state) return { orderId, from: order.state, to: explanation.state, changed: false };
    await tx`update orders set state = ${explanation.state} where id = ${orderId}`;
    await tx`
      insert into order_state_log (order_id, from_state, to_state, cause)
      values (${orderId}, ${order.state}, ${explanation.state}, ${explanation.reason})
    `;
    return { orderId, from: order.state, to: explanation.state, changed: true };
  });
