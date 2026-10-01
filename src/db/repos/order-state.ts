import { type ConfirmationState, type OrderState, explain } from '../../domain/order-state.js';
import { POSTEX_STATUS_CODES, type ShipmentEvent } from '../../integrations/postex/mapper.js';
import { type Db, atomically } from './upsert.js';

/**
 * Writes the derived order state (T06) to `orders.state`, and every change to
 * `order_state_log` with the reason (Step 7, rule 7). Nothing else writes `orders.state`.
 *
 * Inputs, until the Confirmation Desk exists (3.2 note S7): the confirmation comes from the
 * Shopify tags the team already uses, read through the `confirmation_tags` setting, and "on
 * hold" from Shopify's own fulfillment status (the team's "Mark as on hold"), not from a tag. A
 * confirmed order on hold is `confirmed` but not ready to book.
 *
 * An order with several parcels (a re-send after a return) follows its most recently booked one:
 * that is where its goods and money are now.
 */

/**
 * `app_settings` key `confirmation_tags`: which Shopify tags mean which desk outcome. Tags are
 * compared by their words only, so `✅ Order Confirmed`, `order confirmed` and
 * `Order  Confirmed!` are the same tag.
 */
export interface ConfirmationTags {
  confirmed: string[];
  cancelled: string[];
  pending: string[];
  noAnswer: string[];
  unreachable: string[];
}

/**
 * The tags both teams use today (Shopify admin, October 2026). Juggun's Organics also has the
 * `COD-Confirmed` / `COD-Needs-Review` pair, which NUR by Juggun does not.
 */
export const DEFAULT_CONFIRMATION_TAGS: ConfirmationTags = {
  confirmed: ['Order Confirmed', 'COD-Confirmed'],
  cancelled: ['Order Canceled', 'Order Cancelled'],
  pending: ['Confirmation Pending', 'COD-Needs-Review'],
  noAnswer: ['didnt answer the call', 'call not attended', 'didnt confirm'],
  unreachable: ['number off', 'No Phone', 'NO WhatsApp'],
};

const confirmationTags = async (db: Db): Promise<ConfirmationTags> => {
  const [row] = await db<{ value: Partial<ConfirmationTags> }[]>`select value from app_settings where key = 'confirmation_tags'`;
  return { ...DEFAULT_CONFIRMATION_TAGS, ...(row?.value ?? {}) };
};

/** A tag's words, lowercased: emoji, symbols and spacing are how a tag looks, not what it says. */
export const tagWords = (tag: string): string =>
  tag
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const hasTag = (tags: readonly string[], wanted: readonly string[]): boolean => {
  const present = new Set(tags.map(tagWords));
  return wanted.some((w) => present.has(tagWords(w)));
};

/**
 * The desk outcome the tags say, strongest first: a cancellation or a confirmation is a decision;
 * the call outcomes only say why there is none yet. Null when no tag speaks to it.
 */
export const confirmationFromTags = (orderTags: readonly string[], map: ConfirmationTags): ConfirmationState | null => {
  if (hasTag(orderTags, map.cancelled)) return 'cancelled';
  if (hasTag(orderTags, map.confirmed)) return 'confirmed';
  if (hasTag(orderTags, map.unreachable)) return 'unreachable';
  if (hasTag(orderTags, map.noAnswer)) return 'no_answer';
  if (hasTag(orderTags, map.pending)) return 'pending';
  return null;
};

export interface StateChange {
  orderId: string;
  from: OrderState | null;
  to: OrderState;
  changed: boolean;
}

/** Recomputes one order's state and logs it if it moved. Safe to call any number of times. */
export const recomputeOrderState = async (db: Db, orderId: string): Promise<StateChange> =>
  atomically(db, async (tx) => {
    const [order] = await tx<{ state: OrderState | null; channel: 'online' | 'consignment' | 'pr'; cancelled_at: Date | null; tags: string[]; fulfillment_status: string | null }[]>`
      select state, channel, cancelled_at, tags, fulfillment_status from orders where id = ${orderId} for update
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

    const confirmationState = confirmationFromTags(order.tags, await confirmationTags(tx));

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
