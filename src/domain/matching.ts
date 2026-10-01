/**
 * Which Shopify order a PostEx parcel belongs to. Pure: candidates are passed in, nothing is
 * read or written, and the same input always gives the same answer.
 *
 * Decision table. Strategies run top to bottom; the first one that finds any candidate decides,
 * and a strategy that finds two or more decides "no match" rather than picking one.
 *
 * | # | Applies when                                   | A candidate qualifies when                                          | Result             | confidence |
 * |---|------------------------------------------------|---------------------------------------------------------------------|--------------------|------------|
 * | 0 | the PostEx account has no store                | —                                                                   | null, `account_has_no_store` |  |
 * | ½ | the parcel has a tracking number               | same store, and the order's note names that tracking number (written by the booking app) | `tracking_note` | 1.0 |
 * | 1 | the parcel's ref parses as an order number     | same store, same order number (`#1234` = `1234` = `NBJ-1234`)       | `order_ref`        | 1.0        |
 * |   |   …with a prefix this store does not use       | —                                                                   | null, `foreign_ref_prefix`   |  |
 * |   |   …but no order in the store has that number   | —                                                                   | null, `order_ref_not_found`  |  |
 * | 2 | no usable ref; COD > 0, city and booking date  | same store, same COD to the paisa, same city, placed 0–N Karachi days before booking | `cod_city_window` | 0.8 |
 * | 3 | no usable ref; phone and booking date          | same store, same normalised phone, placed 0–N Karachi days before booking | `phone_window` | 0.6     |
 * |   | two or more qualify at the deciding strategy   | —                                                                   | null, `ambiguous` (ids listed) |  |
 * |   | nothing qualifies anywhere                     | —                                                                   | null, `no_candidate_matched` |  |
 *
 * Why a ref that parses but is not found stops there instead of falling back: it almost always
 * means the order exists but is not loaded yet (older than the 60-day window). Falling back to
 * amount and city would then link the parcel to a different customer's order.
 *
 * Why the tracking note comes first: the booking app writes the parcel's own tracking number on
 * the order when it books it, so it is the parcel naming its order, not a resemblance. It also
 * settles parcels whose reference was typed wrong. When no order names the parcel, matching
 * carries on down the table as before.
 *
 * Why a foreign prefix stops: `JO-1234` on the NUR account names a Juggun's Organics order.
 * Matching it on amount or phone inside NUR would be exactly the cross-store leak this guards.
 */
import type { Paisa } from '../lib/money.js';
import { normalizePk } from '../lib/phone.js';
import { daysBetweenKarachi } from '../lib/time.js';

export type MatchMethod = 'tracking_note' | 'order_ref' | 'cod_city_window' | 'phone_window';

export const CONFIDENCE: Record<MatchMethod, number> = {
  tracking_note: 1,
  order_ref: 1,
  cod_city_window: 0.8,
  phone_window: 0.6,
};

export interface Match {
  orderId: string;
  method: MatchMethod;
  confidence: number;
}

export type NoMatchReason =
  | 'account_has_no_store'
  | 'foreign_ref_prefix'
  | 'order_ref_not_found'
  | 'ambiguous'
  | 'no_candidate_matched';

export interface MatchExplanation {
  match: Match | null;
  reason: NoMatchReason | null;
  /** The orders that tied, when `reason` is `ambiguous`. */
  tiedOrderIds: string[];
}

/** The parts of a mapped PostEx shipment that matching reads. */
export interface ShipmentForMatching {
  trackingNumber?: string | null;
  orderRefNumber: string | null;
  codAmount: Paisa | null;
  city: string | null;
  customerPhone: string | null;
  bookedAt: Date | null;
}

/** A Shopify order that could own the parcel. */
export interface OrderCandidate {
  id: string;
  storeId: string;
  /** Shopify's order name, e.g. `#1234`. */
  name: string;
  /** What the courier should collect, in paisa. */
  codAmount: Paisa;
  city: string | null;
  phone: string | null;
  placedAt: Date;
  /** PostEx tracking numbers written on the order's note by the booking app. */
  trackingNumbers?: readonly string[];
}

export interface MatchOptions {
  /** The store linked to the parcel's PostEx account; null when the account has none. */
  storeId: string | null;
  /** How many Karachi calendar days before booking an order may have been placed. Default 3. */
  windowDays?: number;
  /** Order-name prefixes this store's team types on parcels, e.g. `['NBJ']`. Case-insensitive. */
  refPrefixes?: readonly string[];
}

export const DEFAULT_WINDOW_DAYS = 3;

interface ParsedRef {
  prefix: string | null;
  number: string;
}

// `#1234`, `1234`, `NBJ-1234`, `nbj 1234`, `NBJ#1234`, `#NBJ-1234`. Leading zeros do not count.
const ORDER_REF = /^#?\s*(?:([a-z]{1,6})[\s#-]*)?(\d{1,12})$/i;

export const parseOrderRef = (ref: string | null): ParsedRef | null => {
  const match = ORDER_REF.exec(ref?.trim() ?? '');
  if (!match?.[2]) return null;
  return { prefix: match[1]?.toUpperCase() ?? null, number: match[2].replace(/^0+(?=\d)/, '') };
};

const sameCity = (a: string | null, b: string | null): boolean => {
  const norm = (city: string | null) => city?.trim().toLowerCase().replace(/\s+/g, ' ') ?? '';
  return norm(a) !== '' && norm(a) === norm(b);
};

/** Placed on the booking's Karachi day or up to `windowDays` before it; never after. */
const inWindow = (placedAt: Date, bookedAt: Date, windowDays: number): boolean => {
  const days = daysBetweenKarachi(placedAt, bookedAt);
  return days >= 0 && days <= windowDays;
};

const decide = (method: MatchMethod, qualifying: OrderCandidate[]): MatchExplanation | null => {
  if (qualifying.length === 0) return null;
  if (qualifying.length > 1) {
    return { match: null, reason: 'ambiguous', tiedOrderIds: qualifying.map((c) => c.id).sort() };
  }
  const [only] = qualifying as [OrderCandidate];
  return { match: { orderId: only.id, method, confidence: CONFIDENCE[method] }, reason: null, tiedOrderIds: [] };
};

const noMatch = (reason: NoMatchReason): MatchExplanation => ({ match: null, reason, tiedOrderIds: [] });

/** The match and, when there is none, why. Use this where the reason is shown or queued. */
export const explainMatch = (
  shipment: ShipmentForMatching,
  candidates: readonly OrderCandidate[],
  options: MatchOptions,
): MatchExplanation => {
  if (options.storeId === null) return noMatch('account_has_no_store');
  // Every strategy sees only this store's orders: the cross-store guard is here, once.
  const store = candidates.filter((c) => c.storeId === options.storeId);
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;

  const tracking = shipment.trackingNumber?.trim();
  if (tracking) {
    const named = decide('tracking_note', store.filter((c) => c.trackingNumbers?.includes(tracking)));
    if (named) return named;
  }

  const ref = parseOrderRef(shipment.orderRefNumber);
  if (ref) {
    const allowed = (options.refPrefixes ?? []).map((p) => p.toUpperCase());
    if (ref.prefix && !allowed.includes(ref.prefix)) return noMatch('foreign_ref_prefix');
    const byRef = store.filter((c) => parseOrderRef(c.name)?.number === ref.number);
    return decide('order_ref', byRef) ?? noMatch('order_ref_not_found');
  }

  const { bookedAt, codAmount } = shipment;
  if (bookedAt && codAmount !== null && codAmount > 0n) {
    const byCod = store.filter(
      (c) => c.codAmount === codAmount && sameCity(c.city, shipment.city) && inWindow(c.placedAt, bookedAt, windowDays),
    );
    const decided = decide('cod_city_window', byCod);
    if (decided) return decided;
  }

  const phone = normalizePk(shipment.customerPhone);
  if (bookedAt && phone) {
    const byPhone = store.filter((c) => normalizePk(c.phone) === phone && inWindow(c.placedAt, bookedAt, windowDays));
    const decided = decide('phone_window', byPhone);
    if (decided) return decided;
  }

  return noMatch('no_candidate_matched');
};

/** The order a parcel belongs to, or null when no strategy gives exactly one answer. */
export const matchShipment = (
  shipment: ShipmentForMatching,
  candidates: readonly OrderCandidate[],
  options: MatchOptions,
): Match | null => explainMatch(shipment, candidates, options).match;
