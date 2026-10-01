import { canonicalOrder } from '../../domain/order-state.js';
import {
  POSTEX_STATUS_CODES,
  type Shipment,
  type ShipmentCharge,
  type ShipmentEvent,
  failureReason,
} from '../../integrations/postex/mapper.js';
import { type Db, type UpsertResult, big, toUpsertResult } from './upsert.js';

/** PostEx codes after which a parcel's outcome is settled (delivered, returned, cancelled). */
export const TERMINAL_CODES = ['0005', '0006', '0002'] as const;

/** Flags the derived refresh recomputes from stored events; the rest come from the payload. */
const DERIVED_FLAGS = new Set(['no_status_history', 'unknown_status']);

/**
 * Upserts the parcel fields of one PostEx payload, keyed on (account, tracking number).
 *
 * A field the payload leaves empty keeps its stored value: list rows are sparser than detail
 * responses and must not erase what an earlier detail call found. Status, attempts and failure
 * reason are not written here at all; `refreshDerived` computes them from the stored events.
 * `raw` is replaced only by a payload that carries history, so it always holds the fullest copy.
 * History flags (no history, unknown status) are not taken from the payload either: they describe
 * the stored events, and a sparse list row would otherwise flip them back and forth.
 */
export const upsertShipment = async (
  db: Db,
  postexAccountId: string,
  shipment: Shipment,
  raw: unknown,
  hasHistory: boolean,
): Promise<UpsertResult> => {
  const [row] = await db<{ id: string; inserted: boolean; changed: boolean }[]>`
    with prev as (
      select to_jsonb(s) - 'updated_at' - 'last_synced_at' as doc from shipments s
      where postex_account_id = ${postexAccountId} and tracking_number = ${shipment.trackingNumber}
    )
    insert into shipments (
      postex_account_id, tracking_number, order_ref_number, status_label, booked_at, delivered_at,
      status_updated_at, cod_amount_paisa, city, customer_phone, items, flags, raw
    )
    values (
      ${postexAccountId}, ${shipment.trackingNumber}, ${shipment.orderRefNumber}, ${shipment.statusLabel},
      ${shipment.bookedAt}, ${shipment.deliveredAt}, ${shipment.statusUpdatedAt}, ${big(shipment.codAmount)},
      ${shipment.city}, ${shipment.customerPhone}, ${shipment.items}, ${shipment.flags.filter((f) => !DERIVED_FLAGS.has(f))}::text[],
      ${db.json(raw as never)}
    )
    on conflict (postex_account_id, tracking_number) do update set
      order_ref_number  = coalesce(excluded.order_ref_number, shipments.order_ref_number),
      status_label      = coalesce(excluded.status_label, shipments.status_label),
      booked_at         = coalesce(excluded.booked_at, shipments.booked_at),
      delivered_at      = coalesce(excluded.delivered_at, shipments.delivered_at),
      status_updated_at = coalesce(excluded.status_updated_at, shipments.status_updated_at),
      cod_amount_paisa  = coalesce(excluded.cod_amount_paisa, shipments.cod_amount_paisa),
      city              = coalesce(excluded.city, shipments.city),
      customer_phone    = coalesce(excluded.customer_phone, shipments.customer_phone),
      items             = coalesce(excluded.items, shipments.items),
      flags             = array(select distinct f from unnest(shipments.flags || excluded.flags) f order by f),
      raw               = case when ${hasHistory} then excluded.raw else coalesce(shipments.raw, excluded.raw) end
    returning id, (xmax = 0) as inserted,
      (select doc from prev) is distinct from (to_jsonb(shipments) - 'updated_at' - 'last_synced_at') as changed
  `;
  return toUpsertResult(row);
};

/** Inserts history steps; the unique (shipment, code, time) key silently skips ones already stored. Returns how many were new. */
export const insertEvents = async (db: Db, shipmentId: string, events: ShipmentEvent[]): Promise<number> => {
  if (events.length === 0) return 0;
  const rows = events.map((e) => ({
    shipment_id: shipmentId,
    code: e.code,
    message: e.message,
    occurred_at: e.occurredAt,
    raw: db.json({ code: e.code, message: e.message, occurredAt: e.occurredAt?.toISOString() ?? null } as never),
  }));
  const inserted = await db`insert into shipment_events ${db(rows)} on conflict do nothing returning id`;
  return inserted.length;
};

/**
 * Upserts each charge PostEx reports, keyed on (shipment, kind). A kind PostEx stops reporting
 * is left as stored rather than deleted: a charge disappearing is something to look at, not to
 * erase silently.
 */
export const upsertCharges = async (db: Db, shipmentId: string, charges: ShipmentCharge[]): Promise<{ inserted: number; changed: number }> => {
  const totals = { inserted: 0, changed: 0 };
  for (const charge of charges) {
    const [row] = await db<{ inserted: boolean; changed: boolean }[]>`
      with prev as (select amount_paisa from shipment_charges where shipment_id = ${shipmentId} and kind = ${charge.kind})
      insert into shipment_charges (shipment_id, kind, amount_paisa) values (${shipmentId}, ${charge.kind}, ${big(charge.amount)})
      on conflict (shipment_id, kind) do update set amount_paisa = excluded.amount_paisa
      returning (xmax = 0) as inserted, (select amount_paisa from prev) is distinct from shipment_charges.amount_paisa as changed
    `;
    if (row?.inserted) totals.inserted++;
    if (row?.changed) totals.changed++;
  }
  return totals;
};

/**
 * Recomputes a parcel's status, attempt count, last failure reason and history flags from every
 * event stored for it, replayed in the same canonical order the order state machine uses. Returns
 * whether anything changed; a change also marks the parcel's stock for the stock pass.
 */
export const refreshDerived = async (db: Db, shipmentId: string): Promise<boolean> => {
  const stored = await db<{ code: string; message: string; occurred_at: Date | null }[]>`
    select code, message, occurred_at from shipment_events where shipment_id = ${shipmentId}
  `;
  const [current] = await db<{ flags: string[] }[]>`select flags from shipments where id = ${shipmentId}`;
  const events: ShipmentEvent[] = stored.map((e) => ({
    code: e.code,
    message: e.message,
    occurredAt: e.occurred_at,
    known: Object.hasOwn(POSTEX_STATUS_CODES, e.code),
  }));
  const ordered = canonicalOrder(events);
  const latest = ordered.at(-1) ?? null;
  const attempts = ordered.filter((e) => e.code === '0013');
  const lastAttempt = attempts.at(-1);
  const flags = [
    ...new Set([
      ...(current?.flags ?? []).filter((f) => !DERIVED_FLAGS.has(f)),
      ...(events.length === 0 ? ['no_status_history'] : []),
      ...(latest && !latest.known ? ['unknown_status'] : []),
    ]),
  ].sort();

  const updated = await db`
    update shipments set
      status_code = ${latest?.code ?? null},
      status_message = ${latest?.message ?? null},
      attempts_count = ${attempts.length},
      last_failure_reason = ${lastAttempt ? failureReason(lastAttempt.message) : null},
      flags = ${flags}::text[],
      stock_pending = true
    where id = ${shipmentId}
      and (status_code, status_message, attempts_count, last_failure_reason, flags) is distinct from
          (${latest?.code ?? null}::text, ${latest?.message ?? null}::text, ${attempts.length}::int,
           ${lastAttempt ? failureReason(lastAttempt.message) : null}::text, ${flags}::text[])
    returning id
  `;
  return updated.length > 0;
};

/** Matched parcels whose stock the stock pass has not yet brought in line, oldest first. */
export const stockPending = async (db: Db, postexAccountId: string): Promise<string[]> => {
  const rows = await db<{ id: string }[]>`
    select id from shipments where postex_account_id = ${postexAccountId} and stock_pending and order_id is not null order by id
  `;
  return rows.map((r) => r.id);
};

export const markSynced = async (db: Db, shipmentIds: string[], at: Date): Promise<void> => {
  if (shipmentIds.length === 0) return;
  await db`update shipments set last_synced_at = ${at} where id = any(${shipmentIds}::bigint[])`;
};

export interface RefreshTiers {
  /** Out for delivery or with a failed attempt: the outcome may change within the hour. */
  activeMs: number;
  /** Everything else not yet terminal. */
  defaultMs: number;
  /** Booked this long ago and still not terminal: checked once a day. */
  staleAfterMs: number;
  /** Delivered, returned or cancelled this recently: re-read daily for late fee corrections. */
  terminalWatchMs: number;
  dailyMs: number;
}

export const DEFAULT_TIERS: RefreshTiers = {
  activeMs: 5 * 60 * 1000,
  defaultMs: 15 * 60 * 1000,
  staleAfterMs: 30 * 24 * 60 * 60 * 1000,
  terminalWatchMs: 7 * 24 * 60 * 60 * 1000,
  dailyMs: 24 * 60 * 60 * 1000,
};

/**
 * Parcels of one account whose detail is due for a refresh at `now`, by tier:
 * - never synced: now;
 * - out for delivery, or attempted (`0013`): every 5 minutes;
 * - booked over 30 days ago and still open: daily (stale);
 * - other open parcels: every 15 minutes;
 * - delivered, returned or cancelled in the last 7 days: daily, for late fee corrections;
 * - older terminal parcels: never.
 */
export const dueForRefresh = async (
  db: Db,
  postexAccountId: string,
  now: Date,
  tiers: RefreshTiers = DEFAULT_TIERS,
): Promise<Array<{ id: string; trackingNumber: string }>> => {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const rows = await db<{ id: string; tracking_number: string }[]>`
    select id, tracking_number from shipments
    where postex_account_id = ${postexAccountId}
      and (
        last_synced_at is null
        or (
          status_code = any(${[...TERMINAL_CODES]}::text[])
          and coalesce(status_updated_at, delivered_at, updated_at) > ${ago(tiers.terminalWatchMs)}
          and last_synced_at <= ${ago(tiers.dailyMs)}
        )
        or (
          (status_code is null or not (status_code = any(${[...TERMINAL_CODES]}::text[])))
          and last_synced_at <= case
            when status_code = '0013' or status_label ilike '%out for delivery%' then ${ago(tiers.activeMs)}::timestamptz
            when booked_at < ${ago(tiers.staleAfterMs)} then ${ago(tiers.dailyMs)}::timestamptz
            else ${ago(tiers.defaultMs)}::timestamptz
          end
        )
      )
    order by last_synced_at nulls first, id
  `;
  return rows.map((r) => ({ id: r.id, trackingNumber: r.tracking_number }));
};

/**
 * Open parcels out for delivery or with a failed attempt, across the given accounts: the ones
 * the 5-minute refresh tier exists for. Zero lets the sync drop back to every 15 minutes.
 */
export const activeParcels = async (db: Db, postexAccountIds: string[]): Promise<number> => {
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n from shipments
    where postex_account_id = any(${postexAccountIds}::bigint[])
      and (status_code is null or not (status_code = any(${[...TERMINAL_CODES]}::text[])))
      and (status_code = '0013' or status_label ilike '%out for delivery%')
  `;
  return row?.n ?? 0;
};

export interface PostexTotals {
  account: string;
  parcels: number;
  delivered: number;
  returned: number;
  forwardFee: bigint;
  forwardTax: bigint;
  reversalFee: bigint;
  reversalTax: bigint;
}

/**
 * Per-account totals for parcels booked between two Karachi dates (inclusive), to reconcile
 * against PostEx's own figures. Delivered and returned go by the derived status code (`0005`,
 * `0006`); fees and their 16% tax are kept apart so either reading of "charges" can be compared.
 */
export const postexTotals = async (db: Db, from: string, to: string): Promise<PostexTotals[]> => {
  const inWindow = db`(s.booked_at at time zone 'Asia/Karachi')::date between ${from}::date and ${to}::date`;
  const parcels = await db<{ account: string; parcels: number; delivered: number; returned: number }[]>`
    select a.key as account, count(*)::int as parcels,
      count(*) filter (where s.status_code = '0005')::int as delivered,
      count(*) filter (where s.status_code = '0006')::int as returned
    from shipments s join postex_accounts a on a.id = s.postex_account_id
    where ${inWindow}
    group by a.key order by a.key
  `;
  const charges = await db<{ account: string; kind: string; total: string }[]>`
    select a.key as account, c.kind, sum(c.amount_paisa)::text as total
    from shipment_charges c
    join shipments s on s.id = c.shipment_id
    join postex_accounts a on a.id = s.postex_account_id
    where ${inWindow}
    group by a.key, c.kind
  `;
  const charge = (account: string, kind: string): bigint =>
    BigInt(charges.find((c) => c.account === account && c.kind === kind)?.total ?? '0');
  return parcels.map((p) => ({
    ...p,
    forwardFee: charge(p.account, 'forward'),
    forwardTax: charge(p.account, 'forward_tax'),
    reversalFee: charge(p.account, 'reversal'),
    reversalTax: charge(p.account, 'reversal_tax'),
  }));
};
