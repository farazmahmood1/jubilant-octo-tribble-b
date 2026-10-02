import { MoneyError, type Paisa, fromNumber, fromRupeeString } from '../../lib/money.js';
import { normalizePk } from '../../lib/phone.js';
import { parsePostexLocal } from '../../lib/time.js';

/**
 * PostEx JSON → plain domain objects. Pure: no database, no HTTP, and the same input always
 * gives a deeply equal output.
 *
 * Data problems are flagged on the shipment rather than thrown, because one odd parcel must not
 * stop a sync of a thousand. The only thing that throws is a parcel with no tracking number,
 * which cannot be stored or looked up at all.
 */

/** The history codes that drive behaviour (CLAUDE.md). Anything else is kept and flagged. */
export const POSTEX_STATUS_CODES = {
  '0002': 'cancelled_by_merchant',
  '0005': 'delivered',
  '0006': 'returned_to_merchant',
  '0008': 'under_review',
  '0013': 'attempt_made',
  '0040': 'return_initiated',
} as const;

export type KnownStatusCode = keyof typeof POSTEX_STATUS_CODES;

/** Reasons PostEx gives on a `0013` attempt: refused, customer not available, incomplete address, wants to open. */
export type FailureReason = 'RFD' | 'CNA' | 'ICA' | 'OPN';

export type ShipmentFlag =
  | 'unknown_status'
  | 'no_status_history'
  | 'invalid_date'
  | 'invalid_amount';

export interface Shipment {
  trackingNumber: string;
  orderRefNumber: string | null;
  /** Code of the latest history step, kept even when we do not recognise it. */
  statusCode: string | null;
  statusMessage: string | null;
  /** PostEx's own label. Differs between endpoints ("Return" vs "Returned"), so never matched on. */
  statusLabel: string | null;
  bookedAt: Date | null;
  deliveredAt: Date | null;
  statusUpdatedAt: Date | null;
  codAmount: Paisa | null;
  city: string | null;
  /** Normalised `+92…`, or null when missing, masked or not a mobile. */
  customerPhone: string | null;
  items: number | null;
  attemptsCount: number;
  /** The reason on the most recent failed attempt: one of the four codes, else PostEx's text. */
  lastFailureReason: FailureReason | string | null;
  flags: ShipmentFlag[];
}

export interface ShipmentEvent {
  code: string;
  message: string;
  occurredAt: Date | null;
  known: boolean;
}

export type ChargeKind = 'forward' | 'forward_tax' | 'reversal' | 'reversal_tax';

export interface ShipmentCharge {
  kind: ChargeKind;
  amount: Paisa;
}

export interface Payout {
  trackingNumber: string;
  orderRefNumber: string | null;
  settled: boolean;
  settledAt: Date | null;
  /** The CPR (payment receipt) number the parcel was paid out under. */
  cprNumber: string | null;
  paidAt: Date | null;
  flags: Extract<ShipmentFlag, 'invalid_date'>[];
}

export class PostexMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PostexMappingError';
  }
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/** List and bulk endpoints wrap each parcel as `{ trackingNumber, trackingResponse }`; detail returns it bare. */
const unwrap = (raw: unknown): Raw => {
  if (!isObject(raw)) throw new PostexMappingError('PostEx parcel is not an object');
  return isObject(raw['trackingResponse']) ? raw['trackingResponse'] : raw;
};

const text = (value: unknown): string | null => {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const trackingNumberOf = (parcel: Raw): string => {
  const tracking = text(parcel['trackingNumber']);
  if (!tracking) throw new PostexMappingError('PostEx parcel has no trackingNumber');
  return tracking;
};

/** An ISO timestamp that states its own offset, as the live API sends: `2026-06-21T20:38:46.000+0500`. */
const WITH_OFFSET = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):?(\d{2}))$/;

/**
 * PostEx sends both shapes: offset-less Karachi wall time, and (on the live API's booking, pickup and
 * delivery fields) an explicit offset. A stated offset is honoured as written; anything else is read
 * as Karachi wall time. An impossible date or clock throws either way.
 */
const readPostexTime = (raw: string): Date => {
  const m = WITH_OFFSET.exec(raw);
  if (!m) return parsePostexLocal(raw);
  const [, day, clock, ms = '0', sign, hh = '00', mm = '00'] = m;
  parsePostexLocal(`${day} ${clock}.${ms}`); // rejects 2026-02-30 and 25:00:00
  const offsetMs = sign ? (sign === '-' ? -1 : 1) * (Number(hh) * 60 + Number(mm)) * 60_000 : 0;
  return new Date(Date.parse(`${day}T${clock}.${ms.padEnd(3, '0')}Z`) - offsetMs);
};

/** Absent or blank is null; present but unreadable is null plus a flag, never a guess. */
const date = (value: unknown, flags: Set<ShipmentFlag>): Date | null => {
  const raw = text(value);
  if (raw === null) return null;
  try {
    return readPostexTime(raw);
  } catch {
    flags.add('invalid_date');
    return null;
  }
};

/** PostEx sends amounts as numbers today; a numeric string is accepted too in case that changes. */
const money = (value: unknown, flags: Set<ShipmentFlag>): Paisa | null => {
  if (value === null || value === undefined || value === '') return null;
  try {
    if (typeof value === 'number') return fromNumber(value);
    if (typeof value === 'string') return fromRupeeString(value);
  } catch (error) {
    if (!(error instanceof MoneyError)) throw error;
  }
  flags.add('invalid_amount');
  return null;
};

const historyOf = (parcel: Raw): Raw[] => {
  const history = parcel['transactionStatusHistory'];
  return Array.isArray(history) ? history.filter(isObject) : [];
};

// The live API names these transactionStatusMessageCode / transactionStatusMessage (types.ts);
// the short names in CLAUDE.md are accepted too, so either spelling maps the same.
const eventCode = (step: Raw): string | null => text(step['transactionStatusMessageCode'] ?? step['code']);
const eventMessage = (step: Raw): string => text(step['transactionStatusMessage'] ?? step['message']) ?? '';

const isKnown = (code: string): code is KnownStatusCode => Object.hasOwn(POSTEX_STATUS_CODES, code);

/** Oldest first; steps with no readable time keep their original order after those with one. */
const byTime = (a: ShipmentEvent, b: ShipmentEvent, ia: number, ib: number): number => {
  const ta = a.occurredAt?.getTime();
  const tb = b.occurredAt?.getTime();
  if (ta !== undefined && tb !== undefined && ta !== tb) return ta - tb;
  if (ta === undefined && tb !== undefined) return 1;
  if (tb === undefined && ta !== undefined) return -1;
  return ia - ib;
};

const eventsWithFlags = (parcel: Raw, flags: Set<ShipmentFlag>): ShipmentEvent[] => {
  const events = historyOf(parcel).flatMap((step): ShipmentEvent[] => {
    const code = eventCode(step);
    if (!code) return [];
    return [{ code, message: eventMessage(step), occurredAt: date(step['updatedAt'], flags), known: isKnown(code) }];
  });
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => byTime(a.event, b.event, a.index, b.index))
    .map(({ event }) => event);
};

/** Every history step, oldest first. Unknown codes are kept with `known: false`. */
export const toShipmentEvents = (raw: unknown): ShipmentEvent[] => {
  const parcel = unwrap(raw);
  trackingNumberOf(parcel);
  return eventsWithFlags(parcel, new Set());
};

const FAILURE_REASON = /\b(RFD|CNA|ICA|OPN)\b/;

/** The reason on a `0013` attempt message: one of the four codes, else PostEx's own text. */
export const failureReason = (message: string): FailureReason | string | null =>
  (FAILURE_REASON.exec(message)?.[1] as FailureReason | undefined) ?? (message || null);

export const toShipment = (raw: unknown): Shipment => {
  const parcel = unwrap(raw);
  const flags = new Set<ShipmentFlag>();
  const events = eventsWithFlags(parcel, flags);
  const latest = events.at(-1);
  const attempts = events.filter((e) => e.code === '0013');
  const lastAttempt = attempts.at(-1);

  if (events.length === 0) flags.add('no_status_history');
  if (latest && !latest.known) flags.add('unknown_status');
  // Charges are mapped separately, but an unreadable one is still this parcel's problem.
  for (const field of ['transactionFee', 'transactionTax', 'reversalFee', 'reversalTax']) money(parcel[field], flags);

  const items = parcel['items'];
  return {
    trackingNumber: trackingNumberOf(parcel),
    orderRefNumber: text(parcel['orderRefNumber']),
    statusCode: latest?.code ?? null,
    statusMessage: latest?.message || null,
    statusLabel: text(parcel['transactionStatus']),
    bookedAt: date(parcel['transactionDate'], flags),
    deliveredAt: date(parcel['orderDeliveryDate'], flags),
    statusUpdatedAt: date(parcel['statusUpdatedAt'], flags),
    codAmount: money(parcel['invoicePayment'], flags),
    city: text(parcel['cityName']),
    customerPhone: normalizePk(parcel['customerPhone']),
    items: typeof items === 'number' && Number.isInteger(items) ? items : null,
    attemptsCount: attempts.length,
    lastFailureReason: lastAttempt
      ? failureReason(lastAttempt.message)
      : null,
    flags: [...flags].sort(),
  };
};

const CHARGE_FIELDS: ReadonlyArray<[ChargeKind, string]> = [
  ['forward', 'transactionFee'],
  ['forward_tax', 'transactionTax'],
  ['reversal', 'reversalFee'],
  ['reversal_tax', 'reversalTax'],
];

/**
 * The PostEx charges actually levied on a parcel. A missing, null or zero field means that
 * charge was not made (PostEx sends 0 for "not applicable"), so it is left out rather than
 * stored as a zero charge. An unreadable amount is left out here and flagged by `toShipment`.
 */
export const toCharges = (raw: unknown): ShipmentCharge[] => {
  const parcel = unwrap(raw);
  trackingNumberOf(parcel);
  const ignored = new Set<ShipmentFlag>();
  return CHARGE_FIELDS.flatMap(([kind, field]): ShipmentCharge[] => {
    const amount = money(parcel[field], ignored);
    return amount === null || amount === 0n ? [] : [{ kind, amount }];
  });
};

/** A payment-status response. `settle` is PostEx's flag; `cpr1`/`cpr1Date` identify the payout. */
export const toPayout = (raw: unknown): Payout => {
  if (!isObject(raw)) throw new PostexMappingError('PostEx payment status is not an object');
  const flags = new Set<ShipmentFlag>();
  const settledAt = date(raw['settlementDate'], flags);
  const paidAt = date(raw['cpr1Date'], flags);
  return {
    trackingNumber: trackingNumberOf(raw),
    orderRefNumber: text(raw['orderRefNumber']),
    settled: raw['settle'] === true,
    settledAt,
    cprNumber: text(raw['cpr1']),
    paidAt,
    flags: flags.has('invalid_date') ? ['invalid_date'] : [],
  };
};
