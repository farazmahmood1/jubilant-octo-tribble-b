import { normalizePk } from '../../lib/phone.js';
import { endOfKarachiDay, startOfKarachiDate } from '../../lib/time.js';
import type { OrderChannel } from './orders.js';
import { STAGE_SQL, type Stage } from './parcels.js';
import type { Db } from './upsert.js';

/**
 * The read model for the Orders screen: every stored order with its brand, customer, parcel and
 * state. The state is read as the recompute wrote it (rule 7), never derived again here. Nothing
 * here writes.
 */

export const ORDER_STATES = ['placed', 'confirmed', 'ready_to_book', 'booked', 'in_transit', 'delivered', 'failed', 'returning', 'returned_received', 'cancelled', 'pr'] as const;
export type OrderState = (typeof ORDER_STATES)[number];
export const ORDER_CHANNELS = ['online', 'consignment', 'pr'] as const satisfies readonly OrderChannel[];
export const ORDER_FLAGS = ['no_parcel', 'many_parcels', 'discounted'] as const;
export type OrderFlag = (typeof ORDER_FLAGS)[number];
export const ORDER_SORTS = ['placedAt', 'total', 'items'] as const;

export interface OrderFilter {
  search?: string;
  states?: OrderState[];
  stores?: Array<'nur' | 'organics'>;
  channels?: OrderChannel[];
  flags?: OrderFlag[];
  cities?: string[];
  /** Carrying any of these Shopify tags, matched without regard to case or spacing. */
  tags?: string[];
  /** Placed on these Karachi days, inclusive. */
  from?: string | null;
  to?: string | null;
  sort?: { key: (typeof ORDER_SORTS)[number]; dir: 'asc' | 'desc' } | null;
  page: number;
  pageSize: number;
}

export interface OrderListRow {
  id: string;
  orderNumber: string;
  store: 'nur' | 'organics' | null;
  placedAt: Date;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  totalPaisa: string;
  state: OrderState | null;
  financialStatus: string | null;
  channel: OrderChannel;
  items: number;
  discountCodes: string[];
  /** The order's Shopify tags, as Shopify spells them. */
  tags: string[];
  parcels: number;
  /** The newest parcel booked for the order, if any. */
  parcel: { id: string; trackingNumber: string; stage: Stage } | null;
}

const SORT_SQL: Record<(typeof ORDER_SORTS)[number], string> = {
  placedAt: 'o.placed_at',
  total: 'o.total_paisa',
  items: 'items',
};

/** The filter's conditions over orders `o` (with `st`, `c` and `ad` joined). */
const conditions = (db: Db, f: OrderFilter) => {
  const search = f.search?.trim() ?? '';
  const like = `%${search.replace(/[%_\\]/g, '\\$&')}%`;
  const phone = search ? normalizePk(search) : null;
  const flag = (name: OrderFlag) => f.flags?.includes(name) ?? false;
  return db`
    ${search
      ? db`and (o.order_number ilike ${like} or c.name ilike ${like} ${phone ? db`or c.phone_e164 = ${phone}` : db``}
              or exists (select 1 from shipments s where s.order_id = o.id and s.tracking_number ilike ${like}))`
      : db``}
    ${f.states?.length ? db`and o.state = any(${f.states}::text[])` : db``}
    ${f.stores?.length ? db`and st.key = any(${f.stores}::text[])` : db``}
    ${f.channels?.length ? db`and o.channel = any(${f.channels}::text[])` : db``}
    ${f.cities?.length ? db`and lower(trim(ad.city)) = any(${f.cities.map((c) => c.trim().toLowerCase())}::text[])` : db``}
    ${f.tags?.length ? db`and exists (select 1 from unnest(o.tags) t where lower(trim(t)) = any(${f.tags.map((t) => t.trim().toLowerCase())}::text[]))` : db``}
    ${f.from ? db`and o.placed_at >= ${startOfKarachiDate(f.from)}` : db``}
    ${f.to ? db`and o.placed_at <= ${endOfKarachiDay(f.to)}` : db``}
    ${flag('no_parcel') ? db`and not exists (select 1 from shipments s where s.order_id = o.id)` : db``}
    ${flag('many_parcels') ? db`and (select count(*) from shipments s where s.order_id = o.id) > 1` : db``}
    ${flag('discounted') ? db`and (o.discount_paisa > 0 or cardinality(o.discount_codes) > 0)` : db``}
  `;
};

export const listOrders = async (db: Db, f: OrderFilter): Promise<{ rows: OrderListRow[]; total: number }> => {
  const sort = f.sort ?? { key: 'placedAt', dir: 'desc' };
  const rows = await db<{
    id: string; order_number: string; store: 'nur' | 'organics' | null; placed_at: Date; customer_name: string | null; phone: string | null; city: string | null;
    total: string; state: OrderState | null; financial_status: string | null; channel: OrderChannel; items: number; discount_codes: string[]; tags: string[]; parcels: number;
    parcel_id: string | null; tracking_number: string | null; parcel_stage: Stage | null;
  }[]>`
    select o.id, o.order_number, st.key as store, o.placed_at, c.name as customer_name, c.phone_e164 as phone, ad.city,
           o.total_paisa::text as total, o.state, o.financial_status, o.channel, o.discount_codes, o.tags,
           (select coalesce(sum(l.qty), 0)::int from order_lines l where l.order_id = o.id) as items,
           (select count(*)::int from shipments s where s.order_id = o.id) as parcels,
           p.id as parcel_id, p.tracking_number, p.stage as parcel_stage
    from orders o
    join stores st on st.id = o.store_id
    left join customers c on c.id = o.customer_id
    left join addresses ad on ad.id = o.shipping_address_id
    left join lateral (
      select s.id, s.tracking_number, ${db.unsafe(STAGE_SQL)} as stage
      from shipments s where s.order_id = o.id order by s.booked_at desc nulls last, s.id desc limit 1
    ) p on true
    where true ${conditions(db, f)}
    order by ${db.unsafe(SORT_SQL[sort.key])} ${db.unsafe(sort.dir === 'asc' ? 'asc' : 'desc')} nulls last, o.id desc
    limit ${f.pageSize} offset ${(f.page - 1) * f.pageSize}
  `;
  const [count] = await db<{ n: number }[]>`
    select count(*)::int as n
    from orders o
    join stores st on st.id = o.store_id
    left join customers c on c.id = o.customer_id
    left join addresses ad on ad.id = o.shipping_address_id
    where true ${conditions(db, f)}
  `;
  return {
    total: count!.n,
    rows: rows.map((r) => ({
      id: r.id,
      orderNumber: r.order_number,
      store: r.store,
      placedAt: r.placed_at,
      customerName: r.customer_name,
      phone: r.phone,
      city: r.city,
      totalPaisa: r.total,
      state: r.state,
      financialStatus: r.financial_status,
      channel: r.channel,
      items: r.items,
      discountCodes: r.discount_codes,
      tags: r.tags,
      parcels: r.parcels,
      parcel: r.parcel_id && r.tracking_number && r.parcel_stage ? { id: r.parcel_id, trackingNumber: r.tracking_number, stage: r.parcel_stage } : null,
    })),
  };
};

/** Cities orders ship to, most orders first, for the city filter. */
export const orderCities = async (db: Db): Promise<Array<{ city: string; orders: number }>> => {
  const rows = await db<{ city: string; orders: number }[]>`
    select min(trim(ad.city)) as city, count(*)::int as orders
    from orders o join addresses ad on ad.id = o.shipping_address_id
    where ad.city is not null and trim(ad.city) <> ''
    group by lower(trim(ad.city)) order by count(*) desc, 1 limit 100
  `;
  return [...rows];
};

/** Every Shopify tag on stored orders, most orders first, for the tag filter. */
export const orderTags = async (db: Db): Promise<Array<{ tag: string; orders: number }>> => {
  const rows = await db<{ tag: string; orders: number }[]>`
    select min(trim(t)) as tag, count(distinct o.id)::int as orders
    from orders o cross join lateral unnest(o.tags) t
    where trim(t) <> ''
    group by lower(trim(t)) order by count(distinct o.id) desc, 1 limit 200
  `;
  return [...rows];
};
