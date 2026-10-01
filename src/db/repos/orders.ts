import type { Paisa } from '../../lib/money.js';
import { type Db, type UpsertResult, atomically, big, readBigint, readPaisa, toUpsertResult } from './upsert.js';

export type OrderChannel = 'online' | 'consignment' | 'pr';
export type OrderSource = 'api' | 'csv_import' | 'consignment';

export interface OrderLineInput {
  /** `shopify:<line item id>` or, for consignment, `line:<n>`. */
  lineKey: string;
  variantId: string | null;
  sku: string | null;
  title: string;
  qty: number;
  unitPrice: Paisa;
  discount: Paisa;
  total: Paisa;
}

export interface OrderInput {
  storeId: string;
  /** Null only for consignment sales. */
  shopifyOrderId: bigint | null;
  orderNumber: string;
  placedAt: Date;
  customerId: string | null;
  shippingAddressId: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  subtotal: Paisa;
  discount: Paisa;
  shipping: Paisa;
  tax: Paisa;
  total: Paisa;
  channel: OrderChannel;
  cancelledAt: Date | null;
  cancelReason: string | null;
  tags: string[];
  discountCodes: string[];
  /** Tracking numbers the booking app wrote on the order (0008); none for consignment sales. */
  postexTrackingNumbers?: string[];
  source: OrderSource;
  raw: unknown;
  lines: OrderLineInput[];
}

export interface OrderLineRow {
  id: string;
  lineKey: string;
  variantId: string | null;
  sku: string | null;
  title: string;
  qty: number;
  unitPrice: Paisa;
  discount: Paisa;
  total: Paisa;
}

export interface OrderRow {
  id: string;
  storeId: string;
  shopifyOrderId: bigint | null;
  orderNumber: string;
  placedAt: Date;
  customerId: string | null;
  shippingAddressId: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  subtotal: Paisa;
  discount: Paisa;
  shipping: Paisa;
  tax: Paisa;
  total: Paisa;
  channel: OrderChannel;
  cancelledAt: Date | null;
  cancelReason: string | null;
  tags: string[];
  discountCodes: string[];
  source: OrderSource;
  /** Written only by the state recompute; null until it has run. */
  state: string | null;
  lines: OrderLineRow[];
}

export interface OrderUpsertResult extends UpsertResult {
  lines: { inserted: number; updated: number; changed: number; removed: number };
}

type Returned = { id: string; inserted: boolean; changed: boolean };

const upsertHeader = async (db: Db, input: OrderInput): Promise<UpsertResult> => {
  const values = {
    store_id: input.storeId,
    shopify_order_id: big(input.shopifyOrderId),
    order_number: input.orderNumber,
    placed_at: input.placedAt,
    customer_id: input.customerId,
    shipping_address_id: input.shippingAddressId,
    financial_status: input.financialStatus,
    fulfillment_status: input.fulfillmentStatus,
    subtotal_paisa: big(input.subtotal),
    discount_paisa: big(input.discount),
    shipping_paisa: big(input.shipping),
    tax_paisa: big(input.tax),
    total_paisa: big(input.total),
    channel: input.channel,
    cancelled_at: input.cancelledAt,
    cancel_reason: input.cancelReason,
    tags: input.tags,
    discount_codes: input.discountCodes,
    postex_tracking_numbers: input.postexTrackingNumbers ?? [],
    source: input.source,
    raw: input.raw === undefined || input.raw === null ? null : db.json(input.raw as never),
  };
  // A Shopify order is identified by its Shopify id; a consignment sale, which has none, by its
  // order number. Either way the key includes the store.
  const key = input.shopifyOrderId === null ? db`(store_id, order_number)` : db`(store_id, shopify_order_id)`;
  const prevWhere =
    input.shopifyOrderId === null
      ? db`store_id = ${input.storeId} and order_number = ${input.orderNumber}`
      : db`store_id = ${input.storeId} and shopify_order_id = ${big(input.shopifyOrderId)}`;
  const updatable = Object.keys(values).filter((c) => c !== 'store_id' && c !== 'shopify_order_id');

  const [row] = await db<Returned[]>`
    with prev as (select to_jsonb(o) - 'updated_at' as doc from orders o where ${prevWhere})
    insert into orders ${db(values)}
    on conflict ${key} do update set ${db.unsafe(updatable.map((c) => `${c} = excluded.${c}`).join(', '))}
    returning id, (xmax = 0) as inserted, (select doc from prev) is distinct from (to_jsonb(orders) - 'updated_at') as changed
  `;
  return toUpsertResult(row);
};

const upsertLine = async (db: Db, orderId: string, line: OrderLineInput): Promise<UpsertResult> => {
  const [row] = await db<Returned[]>`
    with prev as (
      select to_jsonb(l) - 'updated_at' as doc from order_lines l where order_id = ${orderId} and line_key = ${line.lineKey}
    )
    insert into order_lines (order_id, line_key, variant_id, sku, title, qty, unit_price_paisa, discount_paisa, total_paisa)
    values (${orderId}, ${line.lineKey}, ${line.variantId}, ${line.sku}, ${line.title}, ${line.qty},
            ${big(line.unitPrice)}, ${big(line.discount)}, ${big(line.total)})
    on conflict (order_id, line_key) do update
      set variant_id = excluded.variant_id, sku = excluded.sku, title = excluded.title, qty = excluded.qty,
          unit_price_paisa = excluded.unit_price_paisa, discount_paisa = excluded.discount_paisa,
          total_paisa = excluded.total_paisa
    returning id, (xmax = 0) as inserted, (select doc from prev) is distinct from (to_jsonb(order_lines) - 'updated_at') as changed
  `;
  return toUpsertResult(row);
};

/**
 * Upserts an order with its lines, atomically. Lines Shopify no longer has are removed, so the
 * stored lines always equal the payload's. `changed` is true when the order or any line changed.
 * The order's `state` is never touched here: only the state recompute writes it (1.10).
 */
export const upsertOrder = async (db: Db, input: OrderInput): Promise<OrderUpsertResult> =>
  atomically(db, async (tx) => {
    const header = await upsertHeader(tx, input);
    const lines = { inserted: 0, updated: 0, changed: 0, removed: 0 };
    for (const line of input.lines) {
      const result = await upsertLine(tx, header.id, line);
      lines[result.action]++;
      if (result.changed) lines.changed++;
    }
    const keys = input.lines.map((l) => l.lineKey);
    const removed = await tx`
      delete from order_lines where order_id = ${header.id} and not (line_key = any(${keys}::text[]))
      returning id
    `;
    lines.removed = removed.length;
    return { ...header, changed: header.changed || lines.changed > 0 || lines.removed > 0, lines };
  });

interface RawOrder {
  id: string;
  store_id: string;
  shopify_order_id: string | null;
  order_number: string;
  placed_at: Date;
  customer_id: string | null;
  shipping_address_id: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  subtotal_paisa: string;
  discount_paisa: string;
  shipping_paisa: string;
  tax_paisa: string;
  total_paisa: string;
  channel: OrderChannel;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  tags: string[];
  discount_codes: string[];
  source: OrderSource;
  state: string | null;
}

interface RawLine {
  id: string;
  line_key: string;
  variant_id: string | null;
  sku: string | null;
  title: string;
  qty: number;
  unit_price_paisa: string;
  discount_paisa: string;
  total_paisa: string;
}

export const findOrder = async (db: Db, id: string): Promise<OrderRow | null> => {
  const [o] = await db<RawOrder[]>`
    select id, store_id, shopify_order_id::text, order_number, placed_at, customer_id, shipping_address_id,
           financial_status, fulfillment_status, subtotal_paisa::text, discount_paisa::text, shipping_paisa::text,
           tax_paisa::text, total_paisa::text, channel, cancelled_at, cancel_reason, tags, discount_codes, source, state
    from orders where id = ${id}
  `;
  if (!o) return null;
  const lines = await db<RawLine[]>`
    select id, line_key, variant_id, sku, title, qty, unit_price_paisa::text, discount_paisa::text, total_paisa::text
    from order_lines where order_id = ${id} order by line_key
  `;
  return {
    id: o.id,
    storeId: o.store_id,
    shopifyOrderId: o.shopify_order_id === null ? null : readBigint(o.shopify_order_id),
    orderNumber: o.order_number,
    placedAt: o.placed_at,
    customerId: o.customer_id,
    shippingAddressId: o.shipping_address_id,
    financialStatus: o.financial_status,
    fulfillmentStatus: o.fulfillment_status,
    subtotal: readPaisa(o.subtotal_paisa),
    discount: readPaisa(o.discount_paisa),
    shipping: readPaisa(o.shipping_paisa),
    tax: readPaisa(o.tax_paisa),
    total: readPaisa(o.total_paisa),
    channel: o.channel,
    cancelledAt: o.cancelled_at,
    cancelReason: o.cancel_reason,
    tags: o.tags,
    discountCodes: o.discount_codes,
    source: o.source,
    state: o.state,
    lines: lines.map((l) => ({
      id: l.id,
      lineKey: l.line_key,
      variantId: l.variant_id,
      sku: l.sku,
      title: l.title,
      qty: l.qty,
      unitPrice: readPaisa(l.unit_price_paisa),
      discount: readPaisa(l.discount_paisa),
      total: readPaisa(l.total_paisa),
    })),
  };
};

export const findOrderByShopifyId = async (db: Db, storeId: string, shopifyOrderId: bigint): Promise<OrderRow | null> => {
  const [row] = await db<{ id: string }[]>`select id from orders where store_id = ${storeId} and shopify_order_id = ${big(shopifyOrderId)}`;
  return row ? findOrder(db, row.id) : null;
};
