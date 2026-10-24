import { PARCEL_STAGES, type ParcelStage } from '../../domain/order-state.js';
import { normalizePk } from '../../lib/phone.js';
import { endOfKarachiDay, startOfKarachiDate } from '../../lib/time.js';
import type { Db } from './upsert.js';

/**
 * Read models for the parcel screens: the list (proposal 6.6's search and filters), one parcel
 * with everything about it, and the returns register. Nothing here writes.
 *
 * A parcel's **stage** is `shipments.stage`, derived from its whole history by the same replay as
 * its order's state (order-state.ts `parcelStage`) and written with its status by the sync
 * (rule 7). It is not the latest code: after a return starts PostEx keeps sending movement codes
 * (0039, 0037, 0035, 0032), and the parcel is `returning` through all of them.
 *
 * | Stage       | Decided by                                          |
 * |-------------|-----------------------------------------------------|
 * | `booked`    | no movement yet                                     |
 * | `in_transit`| any movement, before an attempt or an outcome       |
 * | `attempted` | `0013`, the latest deciding step                    |
 * | `delivered` | `0005`                                              |
 * | `returning` | `0040`, and every movement after it until `0006`    |
 * | `returned`  | `0006`                                              |
 * | `cancelled` | `0002`                                              |
 *
 * A parcel stored before the column existed has no stage until the next sync fills it; until
 * then its latest code stands in, as it used to.
 */

export const STAGES = PARCEL_STAGES;
export type Stage = ParcelStage;
/**
 * `not_checked_in`: coming back or back, nobody has checked it in. `needs_shopify`: checked in,
 * but Shopify's stock is not settled yet (its latest attempt failed or waits on the open order, or
 * none was made): the returns queue keeps it until Shopify agrees.
 */
export const PARCEL_FLAGS = ['unmatched', 'zero_cod', 'pr', 'not_checked_in', 'checked_in', 'needs_shopify'] as const;
export type ParcelFlag = (typeof PARCEL_FLAGS)[number];
export const PARCEL_SORTS = ['bookedAt', 'statusUpdatedAt', 'cod', 'days'] as const;

export const STAGE_SQL = `coalesce(s.stage, case s.status_code
  when '0005' then 'delivered' when '0013' then 'attempted' when '0040' then 'returning'
  when '0006' then 'returned' when '0002' then 'cancelled'
  else case when s.status_code is null then 'booked' else 'in_transit' end end)`;

/**
 * Karachi days from booking to the outcome (the history's last step), or to now while it is
 * still out.
 */
export const DAYS_SQL = `case when s.booked_at is null then null else greatest(0,
  ((case when coalesce(s.stage in ('delivered', 'returned', 'cancelled'), s.status_code in ('0005', '0006', '0002'))
         then coalesce((select max(e.occurred_at) from shipment_events e where e.shipment_id = s.id), s.status_updated_at, now())
         else now() end at time zone 'Asia/Karachi')::date
   - (s.booked_at at time zone 'Asia/Karachi')::date)) end`;

export interface ParcelFilter {
  search?: string;
  stages?: Stage[];
  cities?: string[];
  stores?: Array<'nur' | 'organics'>;
  flags?: ParcelFlag[];
  /** Booked on these Karachi days, inclusive. */
  from?: string | null;
  to?: string | null;
  sort?: { key: (typeof PARCEL_SORTS)[number]; dir: 'asc' | 'desc' } | null;
  page: number;
  pageSize: number;
}

export interface ParcelRow {
  id: string;
  trackingNumber: string;
  account: string;
  store: string | null;
  stage: Stage;
  statusCode: string | null;
  statusMessage: string | null;
  city: string | null;
  codPaisa: string | null;
  bookedAt: Date | null;
  statusUpdatedAt: Date | null;
  daysInTransit: number | null;
  attempts: number;
  lastFailureReason: string | null;
  orderId: string | null;
  orderNumber: string | null;
  orderRef: string | null;
  pr: boolean;
  checkedIn: 'restocked' | 'damaged' | 'mixed' | null;
  /** For a checked-in parcel, the latest attempt to carry the check-in to Shopify. */
  /**
   * The latest attempt to carry the check-in to Shopify. `pending`: the order is still open there
   * with returned units committed to it (`cancellable`: a person may cancel it from here).
   */
  shopifySync: { outcome: 'done' | 'skipped' | 'failed' | 'pending'; message: string; cancellable: boolean } | null;
}

const SORT_SQL: Record<(typeof PARCEL_SORTS)[number], string> = {
  bookedAt: 'p.booked_at',
  statusUpdatedAt: 'p.status_updated_at',
  cod: 'p.cod_sort',
  days: 'p.days',
};

/** The filter's conditions over shipments `s` (with `a`, `st`, `o` joined); stages apply outside. */
const conditions = (db: Db, f: ParcelFilter) => {
  const search = f.search?.trim() ?? '';
  const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
  const phone = search ? normalizePk(search) : null;
  const flag = (name: ParcelFlag) => f.flags?.includes(name) ?? false;
  return db`
    ${search ? db`and (s.tracking_number ilike ${like} or s.order_ref_number ilike ${like} or o.order_number ilike ${like} ${phone ? db`or s.customer_phone = ${phone}` : db``})` : db``}
    ${f.cities?.length ? db`and lower(trim(s.city)) = any(${f.cities.map((c) => c.trim().toLowerCase())}::text[])` : db``}
    ${f.stores?.length ? db`and st.key = any(${f.stores}::text[])` : db``}
    ${f.from ? db`and s.booked_at >= ${startOfKarachiDate(f.from)}` : db``}
    ${f.to ? db`and s.booked_at <= ${endOfKarachiDay(f.to)}` : db``}
    ${flag('unmatched') ? db`and s.order_id is null` : db``}
    ${flag('zero_cod') ? db`and s.cod_amount_paisa = 0` : db``}
    ${flag('pr') ? db`and shipment_is_pr(s.id)` : db``}
    ${flag('not_checked_in') ? db`and ${db.unsafe(STAGE_SQL)} in ('returning', 'returned') and not exists (select 1 from return_check_ins c where c.shipment_id = s.id)` : db``}
    ${flag('checked_in') ? db`and exists (select 1 from return_check_ins c where c.shipment_id = s.id)` : db``}
    ${flag('needs_shopify')
      ? db`and exists (
          select 1 from return_check_ins c
          left join lateral (select wb.outcome from shopify_writebacks wb where wb.check_in_id = c.id order by wb.at desc, wb.id desc limit 1) w on true
          where c.shipment_id = s.id and s.order_id is not null and (w.outcome is null or w.outcome in ('failed', 'pending')))`
      : db``}
  `;
};

const stageWhere = (db: Db, f: ParcelFilter) => (f.stages?.length ? db`where p.stage = any(${f.stages}::text[])` : db``);

export const listParcels = async (db: Db, f: ParcelFilter): Promise<{ rows: ParcelRow[]; total: number }> => {
  const sort = f.sort ?? { key: 'bookedAt', dir: 'desc' };
  const rows = await db<{
    id: string; tracking_number: string; account: string; store: string | null; stage: Stage; status_code: string | null; status_message: string | null;
    city: string | null; cod: string | null; booked_at: Date | null; status_updated_at: Date | null; days: number | null; attempts_count: number;
    last_failure_reason: string | null; order_id: string | null; order_number: string | null; order_ref_number: string | null; pr: boolean;
    checked_in: 'restocked' | 'damaged' | 'mixed' | null; sync_outcome: 'done' | 'skipped' | 'failed' | 'pending' | null; sync_message: string | null; sync_cancellable: boolean | null;
  }[]>`
    select * from (
      select s.id, s.tracking_number, a.key as account, st.key as store, ${db.unsafe(STAGE_SQL)} as stage, s.status_code, s.status_message,
             s.city, s.cod_amount_paisa::text as cod, s.cod_amount_paisa as cod_sort, s.booked_at, s.status_updated_at, ${db.unsafe(DAYS_SQL)} as days,
             s.attempts_count, s.last_failure_reason, s.order_id, o.order_number, s.order_ref_number, shipment_is_pr(s.id) as pr,
             (select c.outcome from return_check_ins c where c.shipment_id = s.id) as checked_in,
             w.outcome as sync_outcome, w.detail->>'message' as sync_message, (w.detail->>'cancellable')::boolean as sync_cancellable
      from shipments s
      left join lateral (
        select wb.outcome, wb.detail from shopify_writebacks wb join return_check_ins c on c.id = wb.check_in_id
        where c.shipment_id = s.id order by wb.at desc, wb.id desc limit 1
      ) w on true
      join postex_accounts a on a.id = s.postex_account_id
      left join stores st on st.id = a.store_id
      left join orders o on o.id = s.order_id
      where true ${conditions(db, f)}
    ) p
    ${stageWhere(db, f)}
    order by ${db.unsafe(SORT_SQL[sort.key])} ${db.unsafe(sort.dir === 'asc' ? 'asc' : 'desc')} nulls last, p.id desc
    limit ${f.pageSize} offset ${(f.page - 1) * f.pageSize}
  `;
  const [count] = await db<{ n: number }[]>`
    select count(*)::int as n from (
      select ${db.unsafe(STAGE_SQL)} as stage
      from shipments s
      join postex_accounts a on a.id = s.postex_account_id
      left join stores st on st.id = a.store_id
      left join orders o on o.id = s.order_id
      where true ${conditions(db, f)}
    ) p
    ${stageWhere(db, f)}
  `;
  return {
    total: count!.n,
    rows: rows.map((r) => ({
      id: r.id,
      trackingNumber: r.tracking_number,
      account: r.account,
      store: r.store,
      stage: r.stage,
      statusCode: r.status_code,
      statusMessage: r.status_message,
      city: r.city,
      codPaisa: r.cod,
      bookedAt: r.booked_at,
      statusUpdatedAt: r.status_updated_at,
      daysInTransit: r.days,
      attempts: r.attempts_count,
      lastFailureReason: r.last_failure_reason,
      orderId: r.order_id,
      orderNumber: r.order_number,
      orderRef: r.order_ref_number,
      pr: r.pr,
      checkedIn: r.checked_in,
      shopifySync: r.sync_outcome ? { outcome: r.sync_outcome, message: r.sync_message ?? '', cancellable: r.sync_cancellable === true } : null,
    })),
  };
};

/** Cities parcels went to, most parcels first, for the city filter. */
export const parcelCities = async (db: Db): Promise<Array<{ city: string; parcels: number }>> => {
  const rows = await db<{ city: string; parcels: number }[]>`
    select min(trim(city)) as city, count(*)::int as parcels from shipments where city is not null and trim(city) <> ''
    group by lower(trim(city)) order by count(*) desc, 1 limit 100
  `;
  return [...rows];
};

export interface ParcelDetail extends ParcelRow {
  statusLabel: string | null;
  customerPhone: string | null;
  deliveredAt: Date | null;
  lastSyncedAt: Date | null;
  matchMethod: string | null;
  events: Array<{ code: string; message: string; occurredAt: Date | null }>;
  charges: Array<{ kind: string; amountPaisa: string }>;
  payouts: Array<{ cprNumber: string; paidAt: Date | null; amountPaisa: string }>;
  checkIn: { outcome: 'restocked' | 'damaged' | 'mixed'; at: Date; by: string; note: string | null; lines: Array<{ variantId: string; title: string; restocked: number; damaged: number }> } | null;
  /** The units the parcel carried out of the warehouse, per product: what a check-in accounts for. */
  units: ParcelUnit[];
  order: {
    id: string;
    number: string;
    store: string;
    placedAt: Date;
    totalPaisa: string;
    state: string | null;
    financialStatus: string | null;
    customerName: string | null;
    city: string | null;
    lines: Array<{ title: string; sku: string | null; qty: number; totalPaisa: string }>;
  } | null;
  openItems: Array<{ id: string; kind: string; severity: string; detail: Record<string, unknown> }>;
}

export interface ParcelUnit {
  variantId: string;
  title: string;
  sku: string | null;
  qty: number;
}

/**
 * The units a parcel took out of the warehouse when it was booked, per product, from its own
 * booking moves. Not the order's lines: those can change afterwards (Shopify sets a cancelled
 * order's quantities to zero), while the parcel's contents do not.
 */
export const parcelUnits = async (db: Db, shipmentId: string): Promise<ParcelUnit[]> => {
  const rows = await db<{ variant_id: string; title: string; sku: string | null; qty: number }[]>`
    select m.variant_id, p.title || ' · ' || v.title as title, v.sku, sum(m.qty)::int as qty
    from stock_moves m join variants v on v.id = m.variant_id join products p on p.id = v.product_id
    where m.shipment_id = ${shipmentId} and m.ref_type = 'shipment' and m.reason = 'booked'
    group by m.variant_id, p.title, v.title, v.sku
    order by m.variant_id
  `;
  return rows.map((r) => ({ variantId: r.variant_id, title: r.title.replace(/ · Default Title$/, ''), sku: r.sku, qty: r.qty }));
};

export const parcelDetail = async (db: Db, id: string): Promise<ParcelDetail | null> => {
  const [s] = await db<{
    id: string; tracking_number: string; account: string; store: string | null; stage: Stage; status_code: string | null; status_message: string | null;
    status_label: string | null; city: string | null; cod: string | null; booked_at: Date | null; delivered_at: Date | null; status_updated_at: Date | null;
    last_synced_at: Date | null; days: number | null; attempts_count: number; last_failure_reason: string | null; order_id: string | null;
    order_number: string | null; order_ref_number: string | null; match_method: string | null; customer_phone: string | null; pr: boolean;
  }[]>`
    select s.id, s.tracking_number, a.key as account, st.key as store, ${db.unsafe(STAGE_SQL)} as stage, s.status_code, s.status_message, s.status_label,
           s.city, s.cod_amount_paisa::text as cod, s.booked_at, s.delivered_at, s.status_updated_at, s.last_synced_at, ${db.unsafe(DAYS_SQL)} as days,
           s.attempts_count, s.last_failure_reason, s.order_id, o.order_number, s.order_ref_number, s.match_method, s.customer_phone, shipment_is_pr(s.id) as pr
    from shipments s join postex_accounts a on a.id = s.postex_account_id left join stores st on st.id = a.store_id left join orders o on o.id = s.order_id
    where s.id = ${id}
  `;
  if (!s) return null;
  const events = await db<{ code: string; message: string; occurred_at: Date | null }[]>`
    select code, message, occurred_at from shipment_events where shipment_id = ${id} order by occurred_at nulls last, id
  `;
  const charges = await db<{ kind: string; amount: string }[]>`select kind, amount_paisa::text as amount from shipment_charges where shipment_id = ${id} order by kind`;
  const payouts = await db<{ cpr_number: string; paid_at: Date | null; amount: string }[]>`
    select p.cpr_number, p.paid_at, l.amount_paisa::text as amount from payout_lines l join cod_payouts p on p.id = l.cod_payout_id where l.shipment_id = ${id} order by p.paid_at
  `;
  const [checkIn] = await db<{ id: string; outcome: 'restocked' | 'damaged' | 'mixed'; checked_in_at: Date; by: string; note: string | null }[]>`
    select c.id, c.outcome, c.checked_in_at, u.name as by, c.note from return_check_ins c join users u on u.id = c.actor_id where c.shipment_id = ${id}
  `;
  const [sync] = await db<{ outcome: 'done' | 'skipped' | 'failed' | 'pending'; message: string | null; cancellable: boolean | null }[]>`
    select wb.outcome, wb.detail->>'message' as message, (wb.detail->>'cancellable')::boolean as cancellable from shopify_writebacks wb join return_check_ins c on c.id = wb.check_in_id
    where c.shipment_id = ${id} order by wb.at desc, wb.id desc limit 1
  `;
  // What the check-in put where, per product, as the ledger recorded it.
  const checkInLines = checkIn
    ? await db<{ variant_id: string; title: string; restocked: number; damaged: number }[]>`
        select m.variant_id, p.title || ' · ' || v.title as title,
               coalesce(sum(m.qty) filter (where l.key = 'warehouse'), 0)::int as restocked,
               coalesce(sum(m.qty) filter (where l.key = 'damaged'), 0)::int as damaged
        from stock_moves m join locations l on l.id = m.to_location_id join variants v on v.id = m.variant_id join products p on p.id = v.product_id
        where m.ref_type = 'return_check_in' and m.ref_id = ${checkIn.id}
        group by m.variant_id, p.title, v.title order by m.variant_id
      `
    : [];
  const units = await parcelUnits(db, id);
  let order: ParcelDetail['order'] = null;
  if (s.order_id) {
    const [o] = await db<{ id: string; order_number: string; store: string; placed_at: Date; total: string; state: string | null; financial_status: string | null; customer_name: string | null; city: string | null }[]>`
      select o.id, o.order_number, st.key as store, o.placed_at, o.total_paisa::text as total, o.state, o.financial_status, c.name as customer_name, ad.city
      from orders o join stores st on st.id = o.store_id left join customers c on c.id = o.customer_id left join addresses ad on ad.id = o.shipping_address_id
      where o.id = ${s.order_id}
    `;
    const lines = await db<{ title: string; sku: string | null; qty: number; total: string }[]>`
      select title, sku, qty, total_paisa::text as total from order_lines where order_id = ${s.order_id} and qty > 0 order by id
    `;
    if (o) {
      order = {
        id: o.id,
        number: o.order_number,
        store: o.store,
        placedAt: o.placed_at,
        totalPaisa: o.total,
        state: o.state,
        financialStatus: o.financial_status,
        customerName: o.customer_name,
        city: o.city,
        lines: lines.map((l) => ({ title: l.title, sku: l.sku, qty: l.qty, totalPaisa: l.total })),
      };
    }
  }
  const items = await db<{ id: string; kind: string; severity: string; detail: Record<string, unknown> }[]>`
    select id, kind, severity, detail from reconciliation_items where status = 'open' and (shipment_id = ${id} or (order_id is not null and order_id = ${s.order_id}))
    order by created_at
  `;
  return {
    id: s.id,
    trackingNumber: s.tracking_number,
    account: s.account,
    store: s.store,
    stage: s.stage,
    statusCode: s.status_code,
    statusMessage: s.status_message,
    statusLabel: s.status_label,
    city: s.city,
    codPaisa: s.cod,
    bookedAt: s.booked_at,
    deliveredAt: s.delivered_at,
    statusUpdatedAt: s.status_updated_at,
    lastSyncedAt: s.last_synced_at,
    daysInTransit: s.days,
    attempts: s.attempts_count,
    lastFailureReason: s.last_failure_reason,
    orderId: s.order_id,
    orderNumber: s.order_number,
    orderRef: s.order_ref_number,
    matchMethod: s.match_method,
    customerPhone: s.customer_phone,
    pr: s.pr,
    checkedIn: checkIn?.outcome ?? null,
    shopifySync: sync ? { outcome: sync.outcome, message: sync.message ?? '', cancellable: sync.cancellable === true } : null,
    events: events.map((e) => ({ code: e.code, message: e.message, occurredAt: e.occurred_at })),
    charges: charges.map((c) => ({ kind: c.kind, amountPaisa: c.amount })),
    payouts: payouts.map((p) => ({ cprNumber: p.cpr_number, paidAt: p.paid_at, amountPaisa: p.amount })),
    checkIn: checkIn
      ? {
          outcome: checkIn.outcome,
          at: checkIn.checked_in_at,
          by: checkIn.by,
          note: checkIn.note,
          lines: checkInLines.map((l) => ({ variantId: l.variant_id, title: l.title, restocked: l.restocked, damaged: l.damaged })),
        }
      : null,
    units,
    order,
    openItems: items.map((i) => ({ id: i.id, kind: i.kind, severity: i.severity, detail: i.detail })),
  };
};
