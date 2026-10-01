import { createHmac, timingSafeEqual } from 'node:crypto';

import { config, isShopifyStoreReady } from '../config.js';
import type { Sql } from '../db.js';
import { openReviewItem } from '../db/repos/review.js';
import { redactCustomer, redactShop } from '../gdpr/redact.js';
import { shopifyClient } from '../integrations/shopify/client.js';
import { type StoreTarget, emptyCounts, resyncOrder } from '../jobs/shopify.js';
import { maskPii } from '../lib/pii.js';
import type { Logger } from '../logger.js';

/** The topics the app subscribes to. The last three are Shopify's mandatory GDPR webhooks. */
export const WEBHOOK_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'fulfillments/create',
  'fulfillments/update',
  'refunds/create',
  'customers/data_request',
  'customers/redact',
  'shop/redact',
] as const;

export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export const isWebhookTopic = (topic: string): topic is WebhookTopic => (WEBHOOK_TOPICS as readonly string[]).includes(topic);

export interface WebhookStore extends StoreTarget {
  shopDomain: string;
  /** The app's client secret: Shopify signs every webhook with it. */
  secret: string;
}

export interface WebhookDeps {
  sql: Sql;
  logger: Logger;
  /** The store a delivery is from, by its `X-Shopify-Shop-Domain`; null if unknown or unverifiable. */
  resolveStore: (shopDomain: string) => Promise<WebhookStore | null>;
  /** Runs processing after the response is sent. Tests pass one they can await. */
  defer?: (work: () => Promise<void>) => void;
}

/**
 * Shopify's signature: base64 HMAC-SHA256 of the exact bytes received, keyed with the app's
 * client secret. It must be computed over the raw body: JSON parsed and re-serialised is not
 * byte-identical, which is why the webhook route parses nothing before this check.
 */
export const verifyShopifyHmac = (rawBody: Buffer, header: string | undefined, secret: string): boolean => {
  if (!header || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(header, 'base64');
  return received.length === expected.length && timingSafeEqual(received, expected);
};

export const signShopifyBody = (rawBody: Buffer | string, secret: string): string =>
  createHmac('sha256', secret).update(rawBody).digest('base64');

interface EventRow {
  id: string;
  topic: string;
  payload: Record<string, unknown>;
  processed_at: Date | null;
}

const orderGid = (payload: Record<string, unknown>, field: 'id' | 'order_id'): string | null => {
  if (field === 'id' && typeof payload['admin_graphql_api_id'] === 'string') return payload['admin_graphql_api_id'];
  const id = payload[field];
  return typeof id === 'number' || typeof id === 'string' ? `gid://shopify/Order/${id}` : null;
};

const stringIds = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/**
 * Acts on one stored webhook event and marks it processed. Order, fulfillment and refund events
 * re-fetch the order through GraphQL and store it the same way the sync does. GDPR events redact
 * or queue a data request for a person. Throws on failure, leaving the event unprocessed for the
 * catch-up job to retry.
 */
export const processWebhookEvent = async (deps: Pick<WebhookDeps, 'sql' | 'logger'>, store: StoreTarget, eventId: string): Promise<void> => {
  const [event] = await deps.sql<EventRow[]>`select id, topic, payload, processed_at from webhook_events where id = ${eventId}`;
  if (!event || event.processed_at) return;
  const { topic, payload } = event;
  const log = deps.logger.child({ store: store.key, topic, webhookEventId: event.id });

  if (topic.startsWith('orders/') || topic.startsWith('fulfillments/') || topic === 'refunds/create') {
    const gid = orderGid(payload, topic.startsWith('orders/') ? 'id' : 'order_id');
    if (gid) {
      const counts = emptyCounts();
      const found = await resyncOrder(deps, store, gid, counts);
      log.info({ found, skipped: counts.skipped }, 'Webhook processed');
    }
  } else if (topic === 'customers/redact') {
    const customer = (payload['customer'] ?? {}) as Record<string, unknown>;
    const result = await redactCustomer(deps.sql, store.id, {
      shopifyCustomerId: customer['id'] === undefined || customer['id'] === null ? null : String(customer['id']),
      phone: typeof customer['phone'] === 'string' ? customer['phone'] : null,
      shopifyOrderIds: stringIds(payload['orders_to_redact']),
    });
    log.info(result, 'Customer redacted');
  } else if (topic === 'shop/redact') {
    log.info(await redactShop(deps.sql, store.id), 'Shop redacted');
  } else if (topic === 'customers/data_request') {
    // Answering means sending the store owner what we hold within 30 days: a person's task.
    const request = (payload['data_request'] ?? {}) as Record<string, unknown>;
    const customer = (payload['customer'] ?? {}) as Record<string, unknown>;
    await openReviewItem(deps.sql, {
      kind: 'gdpr_data_request',
      dedupeKey: `gdpr_data_request:${store.id}:${String(request['id'] ?? event.id)}`,
      storeId: store.id,
      severity: 'error',
      detail: { shopifyCustomerId: customer['id'] ?? null, ordersRequested: stringIds(payload['orders_requested']), webhookEventId: event.id },
    });
    await deps.sql`
      insert into audit_log (actor_id, action, entity, entity_id, after)
      values (null, 'gdpr.customers_data_request', 'store', ${store.id}, ${deps.sql.json({ webhookEventId: event.id } as never)})
    `;
    log.info('GDPR data request queued for review');
  }

  // GDPR payloads carry the customer's email and phone themselves; keep only what the audit needs.
  const keep = topic.startsWith('customers/') || topic === 'shop/redact' ? deps.sql.json(maskPii(payload) as never) : deps.sql.json(payload as never);
  await deps.sql`update webhook_events set processed_at = now(), payload = ${keep} where id = ${event.id}`;
};

/** Events received but never processed (the process died, or Shopify was down), oldest first. */
export const processPendingWebhooks = async (
  deps: Pick<WebhookDeps, 'sql' | 'logger'>,
  stores: StoreTarget[],
  olderThanMs: number,
  signal?: AbortSignal,
): Promise<{ retried: number; failed: number }> => {
  const ids = stores.map((s) => s.id);
  const pending = await deps.sql<{ id: string; store_id: string }[]>`
    select id, store_id from webhook_events
    where processed_at is null and store_id = any(${ids}::bigint[]) and received_at < now() - ${`${olderThanMs} milliseconds`}::interval
    order by received_at
  `;
  let retried = 0;
  let failed = 0;
  for (const row of pending) {
    if (signal?.aborted) break;
    const store = stores.find((s) => s.id === row.store_id);
    if (!store) continue;
    try {
      await processWebhookEvent(deps, store, row.id);
      retried++;
    } catch (error) {
      failed++;
      deps.logger.warn({ store: store.key, webhookEventId: row.id, err: error }, 'Webhook retry failed');
    }
  }
  return { retried, failed };
};

/**
 * Production store lookup: a configured store whose `<shop>.myshopify.com` matches, with a client
 * secret to verify against. A store on an old static-token app has no secret here, so its
 * deliveries cannot be verified and are refused.
 */
export const configuredWebhookStore = async (sql: Sql, shopDomain: string): Promise<WebhookStore | null> => {
  const store = config.shopify.stores.find((s) => `${s.shop}.myshopify.com` === shopDomain.toLowerCase());
  if (!store?.clientSecret || !isShopifyStoreReady(store)) return null;
  const [row] = await sql<{ id: string }[]>`select id from stores where key = ${store.key}`;
  if (!row) return null;
  const client = shopifyClient(store.key);
  return {
    key: store.key,
    id: row.id,
    shopDomain,
    secret: store.clientSecret,
    graphql: (query, variables) => client.graphql(query, variables),
  };
};
