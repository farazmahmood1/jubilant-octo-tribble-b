import { tagWords } from '../db/repos/confirmations.js';
import type { Db } from '../db/repos/upsert.js';
import { normalizePk } from '../lib/phone.js';
import { callLink, whatsappLink } from './confirmation.js';
import { BOOKED_TAG, STATUS_TAG_WORDS, statusTagsFor } from './order-tags.js';
import type { OrderState } from './order-state.js';

/**
 * The Confirmations page (Step 11): the new orders nobody has tagged yet, one order with its
 * Shopify tags, and the customer's history by phone across both brands. Whatever the team decides
 * is a Shopify tag (see `order-tags.ts`); this file only reads.
 */

/** A tag's words in SQL, as `tagWords` makes them: emoji, symbols and spacing dropped. */
const TAG_WORDS_SQL = `trim(regexp_replace(lower(t), '[^[:alnum:]]+', ' ', 'g'))`;

// ---- The queue ----

/** new: no status tag yet, the default; all: every order not booked, whatever its tags say. */
export const QUEUE_VIEWS = ['new', 'all'] as const;
export type QueueView = (typeof QUEUE_VIEWS)[number];

export interface QueueFilter {
  store?: 'nur' | 'organics';
  view: QueueView;
  /** Only orders carrying this tag, in any spelling. */
  tag?: string;
  /** An order number, or a phone number in any shape the customer typed it. */
  search?: string;
  page: number;
  pageSize: number;
}

export interface QueueRow {
  orderId: string;
  store: string;
  orderNumber: string;
  placedAt: Date;
  totalPaisa: string;
  items: string;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  tags: string[];
  /** The customer's other orders, both brands, by phone. */
  history: { delivered: number; returned: number };
  whatsappUrl: string | null;
  callUrl: string | null;
}

const contactLinks = (phone: string | null): { whatsappUrl: string | null; callUrl: string | null } =>
  phone ? { whatsappUrl: whatsappLink(phone), callUrl: callLink(phone) } : { whatsappUrl: null, callUrl: null };

/**
 * Online orders still waiting to be booked: not cancelled in Shopify, no PostEx parcel, and no
 * `PostEx` tag (the booking app tags the order at once; the parcel sync can come later). Newest
 * first, as Shopify lists them.
 */
export const deskQueue = async (db: Db, f: QueueFilter): Promise<{ rows: QueueRow[]; total: number }> => {
  const phone = f.search ? normalizePk(f.search) : null;
  const like = f.search ? `%${f.search.trim().replace(/[%_\\]/g, '\\$&')}%` : null;
  const words = db.unsafe(TAG_WORDS_SQL);
  const rows = await db<
    {
      order_id: string; store: string; order_number: string; placed_at: Date; total: string; items: string | null;
      customer_name: string | null; phone: string | null; city: string | null; tags: string[];
      delivered: number; returned: number; total_rows: number;
    }[]
  >`
    select o.id as order_id, st.key as store, o.order_number, o.placed_at, o.total_paisa::text as total, o.tags,
           (select string_agg(ol.qty || ' × ' || ol.title, ', ' order by ol.id) from order_lines ol where ol.order_id = o.id and ol.qty > 0) as items,
           cu.name as customer_name, cu.phone_e164 as phone, ad.city,
           coalesce(h.delivered, 0) as delivered, coalesce(h.returned, 0) as returned,
           count(*) over ()::int as total_rows
    from orders o
    join stores st on st.id = o.store_id
    left join customers cu on cu.id = o.customer_id
    left join addresses ad on ad.id = o.shipping_address_id
    left join lateral (
      select count(*) filter (where p.status_code = '0005')::int as delivered,
             count(*) filter (where p.status_code in ('0040', '0006'))::int as returned
      from (${parcelsOfPhone(db, db`cu.phone_e164`)}) p
      where cu.phone_e164 is not null and p.order_id is distinct from o.id and not shipment_is_pr(p.id)
    ) h on true
    where o.channel = 'online' and o.cancelled_at is null
      and not exists (select 1 from shipments s where s.order_id = o.id)
      and not exists (select 1 from unnest(o.tags) t where ${words} = ${tagWords(BOOKED_TAG)})
      ${f.view === 'new' ? db`and not exists (select 1 from unnest(o.tags) t where ${words} = any(${[...STATUS_TAG_WORDS]}::text[]))` : db``}
      ${f.tag ? db`and exists (select 1 from unnest(o.tags) t where ${words} = ${tagWords(f.tag)})` : db``}
      ${f.store ? db`and st.key = ${f.store}` : db``}
      ${f.search ? db`and (o.order_number ilike ${like} ${phone ? db`or cu.phone_e164 = ${phone}` : db``})` : db``}
    order by o.placed_at desc, o.id desc
    limit ${f.pageSize} offset ${(f.page - 1) * f.pageSize}
  `;
  return {
    total: rows[0]?.total_rows ?? 0,
    rows: rows.map((r) => ({
      orderId: r.order_id,
      store: r.store,
      orderNumber: r.order_number,
      placedAt: r.placed_at,
      totalPaisa: r.total,
      items: r.items ?? '',
      customerName: r.customer_name,
      phone: r.phone,
      city: r.city,
      tags: r.tags,
      history: { delivered: r.delivered, returned: r.returned },
      ...contactLinks(r.phone),
    })),
  };
};

// ---- One order ----

export interface DeskOrder {
  orderId: string;
  store: string;
  shopifyOrderId: string | null;
  orderNumber: string;
  placedAt: Date;
  totalPaisa: string;
  state: OrderState | null;
  cancelledInShopify: boolean;
  /** A PostEx parcel, or the `PostEx` tag the booking app adds. */
  booked: boolean;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  lines: Array<{ title: string; sku: string | null; qty: number; totalPaisa: string }>;
  tags: string[];
  /** The tags the page offers for this order's store. */
  statusTags: readonly string[];
  whatsappUrl: string | null;
  callUrl: string | null;
}

export const deskOrder = async (db: Db, orderId: string): Promise<DeskOrder | null> => {
  const [o] = await db<
    {
      store: string; shopify_order_id: string | null; order_number: string; placed_at: Date; total: string; state: OrderState | null;
      cancelled_at: Date | null; booked: boolean; tags: string[]; customer_name: string | null; phone: string | null; city: string | null;
    }[]
  >`
    select st.key as store, o.shopify_order_id::text, o.order_number, o.placed_at, o.total_paisa::text as total, o.state, o.cancelled_at, o.tags,
           exists (select 1 from shipments s where s.order_id = o.id) as booked,
           cu.name as customer_name, cu.phone_e164 as phone, ad.city
    from orders o join stores st on st.id = o.store_id
    left join customers cu on cu.id = o.customer_id
    left join addresses ad on ad.id = o.shipping_address_id
    where o.id = ${orderId}
  `;
  if (!o) return null;
  const lines = await db<{ title: string; sku: string | null; qty: number; total: string }[]>`
    select title, sku, qty, total_paisa::text as total from order_lines where order_id = ${orderId} and qty > 0 order by id
  `;
  return {
    orderId,
    store: o.store,
    shopifyOrderId: o.shopify_order_id,
    orderNumber: o.order_number,
    placedAt: o.placed_at,
    totalPaisa: o.total,
    state: o.state,
    cancelledInShopify: o.cancelled_at !== null,
    booked: o.booked || o.tags.some((t) => tagWords(t) === tagWords(BOOKED_TAG)),
    customerName: o.customer_name,
    phone: o.phone,
    city: o.city,
    lines: lines.map((l) => ({ title: l.title, sku: l.sku, qty: l.qty, totalPaisa: l.total })),
    tags: o.tags,
    statusTags: statusTagsFor(o.store),
    ...contactLinks(o.phone),
  };
};

// ---- Customer history ----

export interface CustomerHistory {
  phone: string;
  orders: Array<{ orderId: string; store: string; orderNumber: string; placedAt: Date; totalPaisa: string; state: OrderState | null; channel: string; city: string | null }>;
  /**
   * PostEx parcels to this number with no Shopify order: booked by hand, or older than the orders
   * the platform holds. They are still this customer's deliveries and refusals.
   */
  parcels: Array<{ shipmentId: string; trackingNumber: string; account: string; bookedAt: Date | null; codPaisa: string | null; statusCode: string | null; outcome: ParcelOutcome; city: string | null }>;
  counts: {
    orders: number;
    /** Parcels with no Shopify order; their outcomes are in delivered and refused below. */
    parcelsWithoutOrder: number;
    delivered: number;
    /** Sent back to us: refused at the door, or returned after delivery. */
    refused: number;
    cancelled: number;
    /** Booked and not settled yet. */
    inFlight: number;
    /** Placed or confirmed, not booked yet. */
    awaiting: number;
  };
  /** Delivered out of delivered and refused; null with no outcome yet. */
  deliveryRate: number | null;
  /** Parcels to the city, both brands: how many came back. PR packages are left out. */
  city: { name: string; delivered: number; returned: number; returnRate: number | null } | null;
}

const AWAITING: readonly OrderState[] = ['placed', 'confirmed', 'ready_to_book'];

export type ParcelOutcome = 'delivered' | 'refused' | 'cancelled' | 'in_flight';

/** What a parcel's PostEx status says happened, for the history: settled one way, or still out. */
export const parcelOutcome = (code: string | null): ParcelOutcome =>
  code === '0005' ? 'delivered' : code === '0040' || code === '0006' ? 'refused' : code === '0002' ? 'cancelled' : 'in_flight';

/**
 * Every parcel sent to a phone number: the ones PostEx holds the number on, and the ones of orders
 * placed with it (PostEx's copy of the number is sometimes typed differently). `phone` is a value
 * or a column of the outer query.
 */
const parcelsOfPhone = (db: Db, phone: ReturnType<Db>) => db`
  select s.id, s.order_id, s.status_code from shipments s where s.customer_phone = ${phone}
  union
  select s.id, s.order_id, s.status_code from shipments s
  join orders o3 on o3.id = s.order_id join customers c3 on c3.id = o3.customer_id
  where c3.phone_e164 = ${phone}
`;

/**
 * Every order placed with a phone number, on either brand: the history lookup keys on
 * `customers.phone_e164`, the normalised `+92…` number (1.9), so a guest who typed the number
 * differently on each order is still one customer. `city` is the city to rate, usually the
 * order being confirmed; `excludeOrderId` leaves that order out of the counts.
 */
export const customerHistory = async (db: Db, rawPhone: string, opts: { city?: string | null; excludeOrderId?: string } = {}): Promise<CustomerHistory | null> => {
  const phone = normalizePk(rawPhone);
  if (!phone) return null;
  const orders = await db<{ order_id: string; store: string; order_number: string; placed_at: Date; total: string; state: OrderState | null; channel: string; city: string | null }[]>`
    select o.id as order_id, st.key as store, o.order_number, o.placed_at, o.total_paisa::text as total, o.state, o.channel, ad.city
    from customers c
    join orders o on o.customer_id = c.id
    join stores st on st.id = o.store_id
    left join addresses ad on ad.id = o.shipping_address_id
    where c.phone_e164 = ${phone} ${opts.excludeOrderId ? db`and o.id <> ${opts.excludeOrderId}` : db``}
    order by o.placed_at desc, o.id desc
    limit 200
  `;
  const count = (states: readonly (OrderState | null)[]) => orders.filter((o) => o.channel === 'online' && states.includes(o.state)).length;
  // Outcomes come from the parcels, so a delivery or a refusal counts whether or not its PostEx
  // parcel was ever linked to a Shopify order. PR packages are not the customer's to refuse.
  const parcels = await db<{ id: string; order_id: string | null; tracking_number: string; account: string; booked_at: Date | null; cod: string | null; status_code: string | null; city: string | null }[]>`
    select s.id, s.order_id, s.tracking_number, a.key as account, s.booked_at, s.cod_amount_paisa::text as cod, s.status_code, s.city
    from (${parcelsOfPhone(db, db`${phone}`)}) p
    join shipments s on s.id = p.id join postex_accounts a on a.id = s.postex_account_id
    where not shipment_is_pr(s.id) ${opts.excludeOrderId ? db`and s.order_id is distinct from ${opts.excludeOrderId}` : db``}
    order by s.booked_at desc nulls last, s.id desc
  `;
  const outcomes = parcels.map((p) => parcelOutcome(p.status_code));
  const delivered = outcomes.filter((o) => o === 'delivered').length;
  const refused = outcomes.filter((o) => o === 'refused').length;
  const unlinked = parcels.filter((p) => p.order_id === null);
  let city: CustomerHistory['city'] = null;
  if (opts.city?.trim()) {
    // Every parcel to the city, by PostEx's city or the order's address, unmatched parcels too.
    const [row] = await db<{ delivered: number; returned: number }[]>`
      select count(*) filter (where s.status_code = '0005')::int as delivered,
             count(*) filter (where s.status_code in ('0040', '0006'))::int as returned
      from shipments s
      left join orders o on o.id = s.order_id left join addresses ad on ad.id = o.shipping_address_id
      where (lower(trim(ad.city)) = lower(trim(${opts.city})) or lower(trim(s.city)) = lower(trim(${opts.city})))
        and coalesce(o.channel, 'online') = 'online' and not shipment_is_pr(s.id)
    `;
    const settled = row!.delivered + row!.returned;
    city = { name: opts.city.trim(), delivered: row!.delivered, returned: row!.returned, returnRate: settled === 0 ? null : row!.returned / settled };
  }
  return {
    phone,
    orders: orders.map((o) => ({ orderId: o.order_id, store: o.store, orderNumber: o.order_number, placedAt: o.placed_at, totalPaisa: o.total, state: o.state, channel: o.channel, city: o.city })),
    parcels: unlinked.map((p) => ({
      shipmentId: p.id,
      trackingNumber: p.tracking_number,
      account: p.account,
      bookedAt: p.booked_at,
      codPaisa: p.cod,
      statusCode: p.status_code,
      outcome: parcelOutcome(p.status_code),
      city: p.city,
    })),
    counts: {
      orders: orders.length,
      parcelsWithoutOrder: unlinked.length,
      delivered,
      refused,
      cancelled: count(['cancelled']),
      inFlight: outcomes.filter((o) => o === 'in_flight').length,
      awaiting: count(AWAITING),
    },
    deliveryRate: delivered + refused === 0 ? null : delivered / (delivered + refused),
    city,
  };
};

