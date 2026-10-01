import type { Sql } from '../db.js';
import { insertEvents, refreshDerived } from '../db/repos/shipments.js';

/**
 * Catalogue, order and parcel rows for stock and matching tests. Names and numbers are made up;
 * nothing here is customer data.
 */

/** One product with `count` variants in a store. Returns the variant ids. */
export const variantsIn = async (sql: Sql, storeId: string, count: number, shopifyBase = 9_000): Promise<string[]> => {
  const [product] = await sql<{ id: string }[]>`
    insert into products (store_id, shopify_product_id, title, status) values (${storeId}, ${shopifyBase}, 'Test serum', 'active') returning id
  `;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const [row] = await sql<{ id: string }[]>`
      insert into variants (store_id, product_id, shopify_variant_id, sku, title)
      values (${storeId}, ${product!.id}, ${shopifyBase + 1 + i}, ${`TEST-${shopifyBase}-${i}`}, ${`Size ${i}`}) returning id
    `;
    ids.push(row!.id);
  }
  return ids;
};

export interface TestOrder {
  storeId: string;
  number: string;
  placedAt: Date;
  totalPaisa?: bigint;
  channel?: 'online' | 'pr';
  /** For the matcher's fallbacks: the shipping city and the customer's phone. */
  city?: string;
  phone?: string;
  /** variant id (null for a custom line) and quantity. */
  lines: Array<{ variantId: string | null; qty: number }>;
}

let shopifyOrderId = 7_000_000;

export const orderWithLines = async (sql: Sql, order: TestOrder): Promise<string> => {
  const total = (order.totalPaisa ?? 250_000n).toString();
  let customerId: string | null = null;
  let addressId: string | null = null;
  if (order.city || order.phone) {
    const [customer] = await sql<{ id: string }[]>`
      insert into customers (store_id, external_key, phone_e164) values (${order.storeId}, ${`order:${order.number}`}, ${order.phone ?? null}) returning id
    `;
    const [address] = await sql<{ id: string }[]>`
      insert into addresses (customer_id, fingerprint, city) values (${customer!.id}, ${order.number}, ${order.city ?? null}) returning id
    `;
    customerId = customer!.id;
    addressId = address!.id;
  }
  const [row] = await sql<{ id: string }[]>`
    insert into orders (store_id, shopify_order_id, order_number, placed_at, customer_id, shipping_address_id, subtotal_paisa, total_paisa, channel)
    values (${order.storeId}, ${String(shopifyOrderId++)}, ${order.number}, ${order.placedAt}, ${customerId}, ${addressId}, ${total}, ${total}, ${order.channel ?? 'online'})
    returning id
  `;
  for (const [i, line] of order.lines.entries()) {
    await sql`
      insert into order_lines (order_id, line_key, variant_id, title, qty, unit_price_paisa, total_paisa)
      values (${row!.id}, ${`line:${i}`}, ${line.variantId}, ${`Item ${i}`}, ${line.qty}, '100000', '100000')
    `;
  }
  return row!.id;
};

let tracking = 1;

/** A parcel linked to an order (or not), with history steps given as [code, ISO time]. */
export const parcel = async (
  sql: Sql,
  input: { accountId: string; orderId: string | null; bookedAt?: Date; events?: Array<[string, string]> },
): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
    insert into shipments (postex_account_id, tracking_number, order_id, match_method, match_confidence, booked_at)
    values (${input.accountId}, ${`T${String(tracking++).padStart(10, '0')}`}, ${input.orderId},
            ${input.orderId ? 'manual' : null}, ${input.orderId ? 1 : null}, ${input.bookedAt ?? new Date('2026-09-01T10:00:00Z')})
    returning id
  `;
  for (const [code, at] of input.events ?? []) await addEvent(sql, row!.id, code, at);
  return row!.id;
};

/** Adds one history step and refreshes the derived status, as the sync does. Duplicates are skipped. */
export const addEvent = async (sql: Sql, shipmentId: string, code: string, at: string): Promise<void> => {
  await insertEvents(sql, shipmentId, [{ code, message: `Step ${code}`, occurredAt: new Date(at), known: true }]);
  await refreshDerived(sql, shipmentId);
};

export const testUser = async (sql: Sql, email = 'ops@example.com'): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`insert into users (email, name, role) values (${email}, 'Ops tester', 'operations') returning id`;
  return row!.id;
};
