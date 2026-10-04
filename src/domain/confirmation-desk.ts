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
      select count(*) filter (where o2.state = 'delivered')::int as delivered,
             count(*) filter (where o2.state in ('returning', 'returned_received'))::int as returned
      from customers c2 join orders o2 on o2.customer_id = c2.id
      where cu.phone_e164 is not null and c2.phone_e164 = cu.phone_e164 and o2.id <> o.id
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
  counts: {
    orders: number;
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

const IN_FLIGHT: readonly OrderState[] = ['booked', 'in_transit', 'failed'];
const AWAITING: readonly OrderState[] = ['placed', 'confirmed', 'ready_to_book'];

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
  const delivered = count(['delivered']);
  const refused = count(['returning', 'returned_received']);
  let city: CustomerHistory['city'] = null;
  if (opts.city?.trim()) {
    const [row] = await db<{ delivered: number; returned: number }[]>`
      select count(*) filter (where o.state = 'delivered')::int as delivered,
             count(*) filter (where o.state in ('returning', 'returned_received'))::int as returned
      from addresses ad join orders o on o.shipping_address_id = ad.id
      where lower(trim(ad.city)) = lower(trim(${opts.city})) and ad.city is not null and o.channel = 'online'
    `;
    const settled = row!.delivered + row!.returned;
    city = { name: opts.city.trim(), delivered: row!.delivered, returned: row!.returned, returnRate: settled === 0 ? null : row!.returned / settled };
  }
  return {
    phone,
    orders: orders.map((o) => ({ orderId: o.order_id, store: o.store, orderNumber: o.order_number, placedAt: o.placed_at, totalPaisa: o.total, state: o.state, channel: o.channel, city: o.city })),
    counts: {
      orders: orders.length,
      delivered,
      refused,
      cancelled: count(['cancelled']),
      inFlight: count(IN_FLIGHT),
      awaiting: count(AWAITING),
    },
    deliveryRate: delivered + refused === 0 ? null : delivered / (delivered + refused),
    city,
  };
};

