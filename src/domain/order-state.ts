/**
 * One state per order, derived from three streams that never write to each other: the Shopify
 * order, the confirmation desk, and the PostEx parcel with its history. Pure and total: any
 * input gives a state, nothing throws, and the same input always gives the same answer.
 *
 * Decision order (the first rule that applies decides):
 *
 * | # | When                                                  | State                | Decided by          |
 * |---|-------------------------------------------------------|----------------------|---------------------|
 * | 1 | order channel is `pr`                                 | `pr`                 | the order           |
 * | 2 | order channel is `consignment`                        | `delivered`          | the order           |
 * | 3 | a parcel exists                                       | parcel rules below   | the deciding event  |
 * | 4 | no parcel; Shopify cancelled, or the desk cancelled   | `cancelled`          | order / confirmation|
 * | 5 | no parcel; desk confirmed (or changed), order on hold | `confirmed`          | confirmation        |
 * | 6 | no parcel; desk confirmed (or changed)                | `ready_to_book`      | confirmation        |
 * | 7 | no parcel; anything else                              | `placed`             | the order           |
 *
 * Parcel rules. History is replayed in timestamp order (ties broken by lifecycle rank, then
 * code), starting from `booked`; the last event that moves the state decides it:
 *
 * | Code / event        | Moves to            | Note                                                  |
 * |---------------------|---------------------|-------------------------------------------------------|
 * | `0013` attempt      | `failed`            | not final: a later attempt can still deliver          |
 * | `0005` delivered    | `delivered`         | wins over an earlier `0040`: PostEx does deliver after initiating a return |
 * | `0040` return init. | `returning`         |                                                       |
 * | `0006` returned     | `returned_received` | PostEx's receipt; the warehouse check-in is a stock event, not a state |
 * | `0002` cancelled    | `cancelled`         | cancelled by the merchant inside PostEx               |
 * | `0008` / unknown    | `in_transit` if still `booked`, otherwise no change | unknown codes are also reported as an anomaly |
 *
 * A parcel always outranks a cancellation: if Shopify or the desk cancelled but a parcel was
 * booked anyway, the state follows the parcel (that is where the stock and the money are) and
 * `cancelled_but_booked` is reported for a person to act on.
 */
import type { Shipment, ShipmentEvent } from '../integrations/postex/mapper.js';
import { POSTEX_STATUS_CODES } from '../integrations/postex/mapper.js';

export const ORDER_STATES = [
  'placed',
  'confirmed',
  'ready_to_book',
  'booked',
  'in_transit',
  'delivered',
  'failed',
  'returning',
  'returned_received',
  'cancelled',
  'pr',
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

export type ConfirmationState = 'pending' | 'confirmed' | 'no_answer' | 'changed' | 'cancelled' | 'unreachable';

export interface OrderInput {
  channel: 'online' | 'consignment' | 'pr';
  cancelledAt: Date | null;
  /** Shopify fulfillment hold: confirmed but not to be booked yet. */
  onHold?: boolean;
}

export interface OrderStateInput {
  order: OrderInput;
  shipment: Pick<Shipment, 'trackingNumber'> | null;
  events: readonly ShipmentEvent[];
  confirmation: { state: ConfirmationState } | null;
}

export type Anomaly = 'cancelled_but_booked' | 'unknown_status' | 'undated_event';

export type DecidedBy =
  | { kind: 'order'; detail: 'channel_pr' | 'channel_consignment' | 'cancelled_in_shopify' | 'awaiting_confirmation' }
  | { kind: 'confirmation'; state: ConfirmationState }
  | { kind: 'shipment'; trackingNumber: string }
  | { kind: 'event'; trackingNumber: string; code: string; message: string; occurredAt: Date | null };

export interface StateExplanation {
  state: OrderState;
  /** One sentence for the UI. */
  reason: string;
  decidedBy: DecidedBy;
  anomalies: Anomaly[];
}

type Step = { to: OrderState; always: boolean };

/** What each code does to the parcel state. `always: false` only advances a parcel still at `booked`. */
const STEP: Record<string, Step> = {
  '0013': { to: 'failed', always: true },
  '0005': { to: 'delivered', always: true },
  '0040': { to: 'returning', always: true },
  '0006': { to: 'returned_received', always: true },
  '0002': { to: 'cancelled', always: true },
  '0008': { to: 'in_transit', always: false },
};
const UNKNOWN_STEP: Step = { to: 'in_transit', always: false };

/** Breaks timestamp ties so that, e.g., a return initiated and a delivery at the same second end delivered. */
const LIFECYCLE_RANK: Record<string, number> = { '0008': 1, '0013': 2, '0040': 3, '0005': 4, '0006': 5, '0002': 6 };

const timeOf = (event: ShipmentEvent): number | null => {
  const time = event.occurredAt?.getTime();
  return time === undefined || Number.isNaN(time) ? null : time;
};

/**
 * The canonical replay order: by time, undated last, then lifecycle rank, then code and message.
 * Every key is part of the event itself, so arrival order can never change the outcome.
 */
export const canonicalOrder = (events: readonly ShipmentEvent[]): ShipmentEvent[] =>
  [...events].sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta !== tb) {
      if (ta === null) return 1;
      if (tb === null) return -1;
      return ta - tb;
    }
    const rank = (LIFECYCLE_RANK[a.code] ?? 0) - (LIFECYCLE_RANK[b.code] ?? 0);
    if (rank !== 0) return rank;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
  });

const describeEvent = (event: ShipmentEvent): string => {
  const when = event.occurredAt && timeOf(event) !== null ? ` at ${event.occurredAt.toISOString()}` : '';
  return `PostEx ${event.code} "${event.message}"${when}`;
};

/** One step of a parcel's replayed history that moved its state. */
export interface ParcelStep {
  from: OrderState;
  to: OrderState;
  event: ShipmentEvent;
}

/**
 * Every state change a parcel's history makes, in canonical order, starting from `booked`. The
 * state rules and the posting rules both read this, so they cannot disagree about what happened
 * or when.
 */
export const parcelTimeline = (events: readonly ShipmentEvent[]): ParcelStep[] => {
  const steps: ParcelStep[] = [];
  let state: OrderState = 'booked';
  for (const event of canonicalOrder(events)) {
    const known = Object.hasOwn(POSTEX_STATUS_CODES, event.code);
    const step = (known ? STEP[event.code] : undefined) ?? UNKNOWN_STEP;
    if (step.always || state === 'booked') {
      steps.push({ from: state, to: step.to, event });
      state = step.to;
    }
  }
  return steps;
};

/** A stretch of a parcel's history during which it stood delivered. */
export interface DeliveryEpisode {
  deliveredBy: ShipmentEvent;
  /** The step that took it out of delivered (a customer return); null while it still stands. */
  endedBy: ShipmentEvent | null;
}

/**
 * Each time the history delivered the parcel and, if it did, what undid it. Almost every parcel
 * has none or one; a parcel returned and delivered again has two. A repeated `0005` while
 * already delivered continues the same episode.
 */
export const deliveryEpisodes = (events: readonly ShipmentEvent[]): DeliveryEpisode[] => {
  const episodes: DeliveryEpisode[] = [];
  for (const step of parcelTimeline(events)) {
    const open = episodes.at(-1);
    if (step.to === 'delivered' && step.from !== 'delivered') episodes.push({ deliveredBy: step.event, endedBy: null });
    else if (step.from === 'delivered' && step.to !== 'delivered' && open && !open.endedBy) open.endedBy = step.event;
  }
  return episodes;
};

const parcelExplanation = (trackingNumber: string, events: readonly ShipmentEvent[]): StateExplanation => {
  const anomalies = new Set<Anomaly>();
  for (const event of events) {
    if (timeOf(event) === null) anomalies.add('undated_event');
    if (!Object.hasOwn(POSTEX_STATUS_CODES, event.code)) anomalies.add('unknown_status');
  }
  const last = parcelTimeline(events).at(-1);
  const state: OrderState = last?.to ?? 'booked';
  const decider: ShipmentEvent | null = last?.event ?? null;

  if (!decider) {
    return {
      state,
      reason: `Parcel ${trackingNumber} is booked in PostEx with no movement yet`,
      decidedBy: { kind: 'shipment', trackingNumber },
      anomalies: [...anomalies].sort(),
    };
  }
  return {
    state,
    reason: `${describeEvent(decider)} on parcel ${trackingNumber}`,
    decidedBy: { kind: 'event', trackingNumber, code: decider.code, message: decider.message, occurredAt: decider.occurredAt },
    anomalies: [...anomalies].sort(),
  };
};

const CONFIRMED: ReadonlySet<ConfirmationState> = new Set(['confirmed', 'changed']);

/** The state and why: the specific event, confirmation or order field that decided it. */
export const explain = (input: OrderStateInput): StateExplanation => {
  const { order, shipment, confirmation } = input;
  const events = Array.isArray(input.events) ? input.events : [];

  if (order.channel === 'pr') {
    return { state: 'pr', reason: 'PR package: stock leaves as marketing, never as a sale', decidedBy: { kind: 'order', detail: 'channel_pr' }, anomalies: [] };
  }
  if (order.channel === 'consignment') {
    return { state: 'delivered', reason: 'Consignment sale reported by a retail partner', decidedBy: { kind: 'order', detail: 'channel_consignment' }, anomalies: [] };
  }

  const cancelledInShopify = order.cancelledAt !== null;
  const cancelledByDesk = confirmation?.state === 'cancelled';

  if (shipment) {
    const parcel = parcelExplanation(shipment.trackingNumber, events);
    if ((cancelledInShopify || cancelledByDesk) && parcel.state !== 'cancelled') {
      parcel.anomalies = [...new Set<Anomaly>([...parcel.anomalies, 'cancelled_but_booked'])].sort();
      parcel.reason += `, although the order was cancelled ${cancelledInShopify ? 'in Shopify' : 'at confirmation'}`;
    }
    return parcel;
  }

  if (cancelledInShopify) {
    return { state: 'cancelled', reason: 'Cancelled in Shopify before a parcel was booked', decidedBy: { kind: 'order', detail: 'cancelled_in_shopify' }, anomalies: [] };
  }
  if (confirmation && cancelledByDesk) {
    return { state: 'cancelled', reason: 'Customer cancelled when the desk called', decidedBy: { kind: 'confirmation', state: confirmation.state }, anomalies: [] };
  }
  if (confirmation && CONFIRMED.has(confirmation.state)) {
    return order.onHold
      ? { state: 'confirmed', reason: 'Confirmed by the customer; on hold in Shopify, so not ready to book', decidedBy: { kind: 'confirmation', state: confirmation.state }, anomalies: [] }
      : { state: 'ready_to_book', reason: 'Confirmed by the customer; waiting to be booked in PostEx', decidedBy: { kind: 'confirmation', state: confirmation.state }, anomalies: [] };
  }
  return {
    state: 'placed',
    reason: confirmation ? `Placed; confirmation is ${confirmation.state.replace('_', ' ')}` : 'Placed; not yet confirmed',
    decidedBy: confirmation ? { kind: 'confirmation', state: confirmation.state } : { kind: 'order', detail: 'awaiting_confirmation' },
    anomalies: [],
  };
};

export const deriveOrderState = (input: OrderStateInput): OrderState => explain(input).state;
