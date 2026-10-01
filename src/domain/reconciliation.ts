import { daysBetweenKarachi } from '../lib/time.js';
import type { Paisa } from '../lib/money.js';
import { POSTEX_STATUS_CODES } from '../integrations/postex/mapper.js';
import type { ConfirmationState } from './order-state.js';

/**
 * The five parcel reconciliation rules (BUILD-PLAN Step 9, proposal 6.6 step 6), as pure
 * predicates over one parcel, its order and its history, and the desk's two order rules below. Each returns a finding or null; the scan job turns
 * findings into `reconciliation_items` and closes items whose finding has gone.
 *
 * | Rule                       | Flags when                                                                 | Does NOT flag                                                        |
 * |----------------------------|----------------------------------------------------------------------------|----------------------------------------------------------------------|
 * | unmatched_shipment         | the parcel has no order                                                    | a parcel linked by any method, manual included                       |
 * | cod_mismatch               | the parcel's COD differs from what the order says the courier should collect | a prepaid order with zero COD; a parcel whose COD PostEx did not report |
 * | possible_duplicate_booking | another live parcel exists for the same order (or, unmatched, the same ref) | a re-send after the first parcel was cancelled or came back          |
 * | stuck_in_transit           | an open parcel has had no status change for `stuckDays` Karachi days or more | a parcel that moved within the window; any delivered, returned or cancelled parcel |
 * | postex_unknown_status      | the history carries a code CLAUDE.md does not list                          | a history of listed codes only                                      |
 */

export const RULE_KINDS = ['unmatched_shipment', 'cod_mismatch', 'possible_duplicate_booking', 'stuck_in_transit', 'postex_unknown_status'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export interface ParcelFacts {
  id: string;
  accountKey: string;
  trackingNumber: string;
  orderRefNumber: string | null;
  orderId: string | null;
  codAmount: Paisa | null;
  statusCode: string | null;
  bookedAt: Date | null;
  /** When PostEx last changed the parcel's status; falls back to booking for a parcel with no history. */
  statusUpdatedAt: Date | null;
}

export interface OrderFacts {
  id: string;
  orderNumber: string;
  totalPaisa: Paisa;
  /** Shopify's financial status, lowercased. `paid` means nothing is left to collect on delivery. */
  financialStatus: string | null;
  channel: 'online' | 'consignment' | 'pr';
}

export interface EventFacts {
  code: string;
}

/** Another parcel for the same order, or with the same reference when unmatched. */
export interface SiblingFacts {
  id: string;
  trackingNumber: string;
  statusCode: string | null;
}

export interface Finding {
  kind: RuleKind | 'confirmed_not_booked' | 'cancelled_but_booked';
  /** What the item is about. Two findings with the same key are the same problem. */
  dedupeKey: string;
  severity: 'info' | 'warning' | 'error';
  detail: Record<string, unknown>;
}

export interface RuleInput {
  parcel: ParcelFacts;
  order: OrderFacts | null;
  events: readonly EventFacts[];
  siblings: readonly SiblingFacts[];
  now: Date;
  stuckDays: number;
}

/** Delivered, returned, cancelled: the outcome is settled (as `TERMINAL_CODES` in the shipments repo). */
const TERMINAL: ReadonlySet<string> = new Set(['0005', '0006', '0002']);
/** A parcel that is cancelled, returning or returned is out of the race; a re-send is expected. */
const SETTLED_AWAY: ReadonlySet<string> = new Set(['0002', '0040', '0006']);

export const unmatchedParcel = ({ parcel }: RuleInput): Finding | null =>
  parcel.orderId !== null
    ? null
    : {
        kind: 'unmatched_shipment',
        dedupeKey: `unmatched_shipment:${parcel.id}`,
        severity: 'warning',
        detail: { account: parcel.accountKey, trackingNumber: parcel.trackingNumber, orderRefNumber: parcel.orderRefNumber },
      };

/**
 * What the courier should collect: nothing on a paid order, the order total otherwise. PR orders
 * are left out entirely; their COD is zero by design and they are classified by a person (S16).
 */
export const expectedCod = (order: OrderFacts): Paisa => (order.financialStatus === 'paid' ? (0n as Paisa) : order.totalPaisa);

export const codMismatch = ({ parcel, order }: RuleInput): Finding | null => {
  if (!order || order.channel === 'pr' || parcel.codAmount === null) return null;
  const expected = expectedCod(order);
  if (parcel.codAmount === expected) return null;
  return {
    kind: 'cod_mismatch',
    dedupeKey: `cod_mismatch:${parcel.id}`,
    severity: 'warning',
    detail: {
      account: parcel.accountKey,
      trackingNumber: parcel.trackingNumber,
      orderNumber: order.orderNumber,
      // Strings: JSON has no bigint, and a float would break the paisa rule.
      codPaisa: parcel.codAmount.toString(),
      expectedPaisa: expected.toString(),
      differencePaisa: (parcel.codAmount - expected).toString(),
      zeroCod: parcel.codAmount === 0n,
    },
  };
};

export const duplicateBooking = ({ parcel, order, siblings }: RuleInput): Finding | null => {
  if (parcel.statusCode !== null && SETTLED_AWAY.has(parcel.statusCode)) return null;
  const live = siblings.filter((s) => s.id !== parcel.id && !(s.statusCode !== null && SETTLED_AWAY.has(s.statusCode)));
  if (live.length === 0) return null;
  const all = [parcel.id, ...live.map((s) => s.id)].sort((a, b) => Number(a) - Number(b));
  // One item per group, whichever parcel of it is evaluated.
  const group = order ? `order:${order.id}` : `ref:${parcel.accountKey}:${(parcel.orderRefNumber ?? '').trim().toUpperCase()}`;
  return {
    kind: 'possible_duplicate_booking',
    dedupeKey: `possible_duplicate_booking:${group}`,
    severity: 'warning',
    detail: {
      account: parcel.accountKey,
      orderNumber: order?.orderNumber ?? parcel.orderRefNumber,
      shipmentIds: all,
      trackingNumbers: [parcel.trackingNumber, ...live.map((s) => s.trackingNumber)].sort(),
    },
  };
};

export const stuckInTransit = ({ parcel, now, stuckDays }: RuleInput): Finding | null => {
  if (parcel.statusCode !== null && TERMINAL.has(parcel.statusCode)) return null;
  const since = parcel.statusUpdatedAt ?? parcel.bookedAt;
  if (!since) return null;
  const days = daysBetweenKarachi(since, now);
  if (days < stuckDays) return null;
  return {
    kind: 'stuck_in_transit',
    dedupeKey: `stuck_in_transit:${parcel.id}`,
    severity: 'warning',
    detail: { account: parcel.accountKey, trackingNumber: parcel.trackingNumber, statusCode: parcel.statusCode, since: since.toISOString(), days },
  };
};

/**
 * One finding per unknown code, not per parcel: every open parcel carries the booking and
 * transit codes CLAUDE.md does not list yet, and a person decides once what a code means.
 */
export const unknownStatus = ({ parcel, events }: RuleInput): Finding[] =>
  [...new Set(events.map((e) => e.code).filter((code) => !Object.hasOwn(POSTEX_STATUS_CODES, code)))].sort().map((code) => ({
    kind: 'postex_unknown_status' as const,
    dedupeKey: `postex_unknown_status:${code}`,
    severity: 'info' as const,
    detail: { code, exampleTrackingNumber: parcel.trackingNumber, account: parcel.accountKey },
  }));

/** Every finding for one parcel, in rule order. */
export const evaluate = (input: RuleInput): Finding[] =>
  [unmatchedParcel(input), codMismatch(input), duplicateBooking(input), stuckInTransit(input), ...unknownStatus(input)].filter(
    (f): f is Finding => f !== null,
  );

// ---- Order rules: the Confirmation Desk's two alerts (Step 11) ----

/**
 * | Rule                 | Flags when                                                                                  | Does NOT flag                                                       |
 * |----------------------|---------------------------------------------------------------------------------------------|---------------------------------------------------------------------|
 * | confirmed_not_booked | confirmed (or changed) `confirmedNotBookedHours` or more ago, and no parcel booked           | an order on hold in Shopify; one placed before the lookback window  |
 * | cancelled_but_booked | cancelled in Shopify or at the desk, and a parcel is still out (not cancelled, returning or returned) | a parcel PostEx cancelled, or one already on its way back           |
 */
export const ORDER_RULE_KINDS = ['confirmed_not_booked', 'cancelled_but_booked'] as const;
export type OrderRuleKind = (typeof ORDER_RULE_KINDS)[number];

export interface OrderAlertFacts {
  id: string;
  orderNumber: string;
  placedAt: Date;
  confirmation: ConfirmationState | null;
  /** When the desk confirmed it; for a tag confirmation, when the system first saw it confirmed. */
  confirmedAt: Date | null;
  cancelledInShopify: boolean;
  onHold: boolean;
  parcels: ReadonlyArray<{ id: string; trackingNumber: string; statusCode: string | null }>;
}

export interface OrderRuleInput {
  order: OrderAlertFacts;
  now: Date;
  confirmedNotBookedHours: number;
  lookbackDays: number;
}

/** A parcel the customer is not getting back to us on its own: neither cancelled, returning nor returned. */
const STILL_OUT = (code: string | null) => code === null || !SETTLED_AWAY.has(code);

export const confirmedNotBooked = ({ order, now, confirmedNotBookedHours, lookbackDays }: OrderRuleInput): Finding | null => {
  if (order.confirmation !== 'confirmed' && order.confirmation !== 'changed') return null;
  if (order.cancelledInShopify || order.onHold || order.parcels.length > 0 || !order.confirmedAt) return null;
  if (now.getTime() - order.placedAt.getTime() > lookbackDays * 86_400_000) return null;
  const hours = Math.floor((now.getTime() - order.confirmedAt.getTime()) / 3_600_000);
  if (hours < confirmedNotBookedHours) return null;
  return {
    kind: 'confirmed_not_booked',
    dedupeKey: `confirmed_not_booked:${order.id}`,
    severity: 'warning',
    detail: { orderNumber: order.orderNumber, confirmedAt: order.confirmedAt.toISOString(), hoursWaiting: hours },
  };
};

export const cancelledButBooked = ({ order }: OrderRuleInput): Finding | null => {
  const by = order.cancelledInShopify ? 'shopify' : order.confirmation === 'cancelled' ? 'desk' : null;
  if (!by) return null;
  const out = order.parcels.filter((p) => STILL_OUT(p.statusCode));
  if (out.length === 0) return null;
  return {
    kind: 'cancelled_but_booked',
    dedupeKey: `cancelled_but_booked:${order.id}`,
    // Delivered to a customer who had cancelled: money and stock have already moved.
    severity: out.some((p) => p.statusCode === '0005') ? 'error' : 'warning',
    detail: {
      orderNumber: order.orderNumber,
      cancelledBy: by,
      trackingNumbers: out.map((p) => p.trackingNumber).sort(),
      statusCodes: out.map((p) => p.statusCode),
    },
  };
};

export const evaluateOrder = (input: OrderRuleInput): Finding[] =>
  [confirmedNotBooked(input), cancelledButBooked(input)].filter((f): f is Finding => f !== null);
