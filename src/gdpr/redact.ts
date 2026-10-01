import type { Sql } from '../db.js';
import { atomically } from '../db/repos/upsert.js';
import { maskPii } from '../lib/pii.js';
import { normalizePk } from '../lib/phone.js';

/**
 * GDPR redaction (Shopify's mandatory `customers/redact` and `shop/redact` webhooks).
 *
 * Personal data is scrubbed everywhere it is stored: the typed columns (name, phone, street
 * address, postcode, the parcel's phone) and the raw payloads kept for replay (`orders.raw`,
 * `shipments.raw`, `webhook_events.payload`), which hold the same data in Shopify's and PostEx's
 * own shapes. Rows are not deleted: orders, their money and their history stay, minus the person. City, province and country are kept; on their own they
 * identify nobody and the return-rate reports depend on them.
 *
 * Every redaction is one transaction and writes an `audit_log` row (CLAUDE.md rule 8).
 */

export interface RedactionResult {
  customers: number;
  orders: number;
  shipments: number;
  webhookEvents: number;
}

type Scope = { customerIds: string[]; shopifyOrderIds: string[] } | 'all';

/** Re-masks raw JSON in batches, so a whole shop's history is never held in memory at once. */
const maskRows = async (tx: Sql, table: 'orders' | 'webhook_events' | 'shipments', column: 'raw' | 'payload', ids: string[]): Promise<void> => {
  const BATCH = 200;
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const rows = await tx<{ id: string; doc: unknown }[]>`
      select id, ${tx(column)} as doc from ${tx(table)} where id = any(${slice}::bigint[])
    `;
    for (const row of rows) {
      if (row.doc === null) continue;
      await tx`update ${tx(table)} set ${tx(column)} = ${tx.json(maskPii(row.doc) as never)} where id = ${row.id}`;
    }
  }
};

const redact = async (sql: Sql, storeId: string, scope: Scope, action: string, detail: Record<string, unknown>): Promise<RedactionResult> =>
  atomically(sql, async (tx) => {
    const all = scope === 'all';
    const customerIds = all
      ? (await tx<{ id: string }[]>`select id from customers where store_id = ${storeId}`).map((r) => r.id)
      : scope.customerIds;
    const orderRows = all
      ? await tx<{ id: string; shopify_order_id: string | null }[]>`select id, shopify_order_id::text from orders where store_id = ${storeId}`
      : await tx<{ id: string; shopify_order_id: string | null }[]>`
          select id, shopify_order_id::text from orders
          where store_id = ${storeId}
            and (customer_id = any(${customerIds}::bigint[]) or shopify_order_id::text = any(${scope.shopifyOrderIds}::text[]))
        `;
    const orderIds = orderRows.map((r) => r.id);
    const shopifyOrderIds = orderRows.flatMap((r) => (r.shopify_order_id ? [r.shopify_order_id] : []));

    // This store's PostEx parcels for these orders, and any not yet matched to an order that
    // carry the same phone. A GDPR request is per shop, so the other brand's parcels are untouched.
    // Found before the phones are cleared below.
    const shipmentRows = all
      ? await tx<{ id: string }[]>`
          select s.id from shipments s join postex_accounts a on a.id = s.postex_account_id where a.store_id = ${storeId}
        `
      : await tx<{ id: string }[]>`
          select id from shipments
          where postex_account_id in (select id from postex_accounts where store_id = ${storeId})
            and (order_id = any(${orderIds}::bigint[])
                 or customer_phone in (select phone_e164 from customers where id = any(${customerIds}::bigint[]) and phone_e164 is not null))
        `;
    const shipmentIds = shipmentRows.map((r) => r.id);
    await tx`update shipments set customer_phone = null where id = any(${shipmentIds}::bigint[])`;
    await maskRows(tx, 'shipments', 'raw', shipmentIds);

    await tx`
      update customers
      set name = null, phone_e164 = null, external_key = 'redacted:' || id, redacted_at = now()
      where id = any(${customerIds}::bigint[])
    `;
    await tx`
      update addresses set line1 = null, line2 = null, postal = null
      where customer_id = any(${customerIds}::bigint[])
    `;
    await maskRows(tx, 'orders', 'raw', orderIds);

    // Webhook payloads about these orders or this customer, in Shopify's REST shape.
    const shopifyCustomerIds = (
      await tx<{ id: string }[]>`
        select shopify_customer_id::text as id from customers where id = any(${customerIds}::bigint[]) and shopify_customer_id is not null
      `
    ).map((r) => r.id);
    const events = all
      ? await tx<{ id: string }[]>`select id from webhook_events where store_id = ${storeId}`
      : await tx<{ id: string }[]>`
          select id from webhook_events
          where store_id = ${storeId}
            and (payload->>'id' = any(${shopifyOrderIds}::text[])
                 or payload->>'order_id' = any(${shopifyOrderIds}::text[])
                 or payload->'customer'->>'id' = any(${shopifyCustomerIds}::text[]))
        `;
    await maskRows(tx, 'webhook_events', 'payload', events.map((e) => e.id));

    const result = { customers: customerIds.length, orders: orderIds.length, shipments: shipmentIds.length, webhookEvents: events.length };
    await tx`
      insert into audit_log (actor_id, action, entity, entity_id, after)
      values (null, ${action}, 'store', ${storeId}, ${tx.json({ ...detail, ...result } as never)})
    `;
    return result;
  });

export interface CustomerRedactRequest {
  /** Shopify's numeric customer id, if the customer had an account. */
  shopifyCustomerId: string | null;
  phone: string | null;
  /** `orders_to_redact` from the webhook. */
  shopifyOrderIds: string[];
}

/**
 * Forgets one customer of one store: their customer rows (matched by Shopify id, by phone for
 * guests, and through the orders Shopify lists) and every order of theirs.
 */
export const redactCustomer = async (sql: Sql, storeId: string, request: CustomerRedactRequest): Promise<RedactionResult> => {
  const phone = normalizePk(request.phone);
  const rows = await sql<{ id: string }[]>`
    select id from customers
    where store_id = ${storeId}
      and (shopify_customer_id::text = ${request.shopifyCustomerId ?? ''}
           or (${phone}::text is not null and phone_e164 = ${phone})
           or id in (select customer_id from orders where store_id = ${storeId} and shopify_order_id::text = any(${request.shopifyOrderIds}::text[])))
  `;
  return redact(
    sql,
    storeId,
    { customerIds: rows.map((r) => r.id), shopifyOrderIds: request.shopifyOrderIds },
    'gdpr.customers_redact',
    { shopifyCustomerId: request.shopifyCustomerId, ordersRequested: request.shopifyOrderIds.length },
  );
};

/** Forgets every customer of a store, as Shopify asks 48 hours after the app is uninstalled. */
export const redactShop = async (sql: Sql, storeId: string): Promise<RedactionResult> =>
  redact(sql, storeId, 'all', 'gdpr.shop_redact', {});
