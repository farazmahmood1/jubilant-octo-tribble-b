import { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import { config } from '../../config.js';
import type { Sql } from '../../db.js';
import { QUEUE_VIEWS, customerHistory, deskOrder, deskQueue } from '../../domain/confirmation-desk.js';
import { STATUS_TAGS, type ShopifyEvent, TagError, type TagWriter, editOrderTags, orderTimeline } from '../../domain/order-tags.js';
import { shopifyClient } from '../../integrations/shopify/client.js';
import { ORDER_EVENTS_QUERY } from '../../integrations/shopify/queries.js';
import { configuredStores, emptyCounts, resyncOrder, syncOrders } from '../../jobs/shopify.js';
import { logger } from '../../logger.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { ID, parse } from '../validate.js';

/**
 * The Confirmations page (Step 11): new orders nobody has tagged yet, one order with its Shopify
 * tags and Shopify's timeline, changing those tags (in Shopify, then here), the customer's history
 * across both brands, and the two alerts.
 *
 * Shopify is the record of where an order stands. Its webhooks are the fast path for changes made
 * there; opening an order, and the page's sync button, read Shopify directly as well, so what is on
 * screen never waits for a webhook or the next scheduled sync.
 *
 * Phone numbers are customer PII. The accountant role never sees them (1.9); that is enforced
 * here, in what the API sends, not in the screen.
 */

const store = z.enum(['nur', 'organics']);
const tag = z.string().trim().min(1).max(80);
const queueQuery = z.object({
  store: store.optional(),
  view: z.enum(QUEUE_VIEWS).default('new'),
  tag: tag.optional(),
  search: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const orderParams = z.object({ orderId: z.string().regex(ID) });
const tagChange = z
  .object({ add: z.array(tag).max(20).default([]), remove: z.array(tag).max(20).default([]) })
  .refine((c) => c.add.length + c.remove.length > 0, { message: 'name a tag to add or remove' });
const historyQuery = z.object({ phone: z.string().trim().min(7).max(30), city: z.string().trim().max(80).optional() });

/** How far back the sync button reads: every order still likely to be waiting for its tag. */
const REFRESH_WINDOW_MS = 3 * 24 * 3_600_000;

/** Whether a role may see customers' phone numbers. */
const seesPhones = (role: string): boolean => role !== 'accountant';

export const withoutPhones = <T extends { phone: string | null; whatsappUrl: string | null; callUrl: string | null }>(row: T, role: string): T =>
  seesPhones(role) ? row : { ...row, phone: null, whatsappUrl: null, callUrl: null };

const asHttp = (error: unknown): never => {
  if (error instanceof TagError) throw new HttpError(error.status, error.message);
  throw error;
};

/** The order in Shopify's admin, where it is booked with PostEx. */
const adminUrl = (store: string, shopifyOrderId: string | null): string | null => {
  const shop = config.shopify.stores.find((s) => s.key === store)?.shop;
  return shop && shopifyOrderId ? `https://admin.shopify.com/store/${shop}/orders/${shopifyOrderId}` : null;
};

const message = (error: unknown): string => (error instanceof Error ? error.message : 'Shopify did not answer');

/** Everything the page asks of Shopify; tests pass their own, the default calls the real stores. */
export interface ShopifyGateway {
  writeTags: TagWriter;
  events: (store: string, shopifyOrderId: string) => Promise<ShopifyEvent[]>;
  /** Reads one order back from Shopify into the database, as a webhook would. */
  refreshOrder: (sql: Sql, orderId: string) => Promise<void>;
  /** Reads every order updated in Shopify since then. */
  refreshRecent: (sql: Sql, since: Date) => Promise<void>;
}

const liveShopify: ShopifyGateway = {
  writeTags: (store, shopifyOrderId, add, remove) => shopifyClient(store).setOrderTags(shopifyOrderId, add, remove),
  events: async (store, shopifyOrderId) => {
    const data = await shopifyClient(store).graphql<{ order: { events: { nodes: ShopifyEvent[] } } | null }>(ORDER_EVENTS_QUERY, {
      id: `gid://shopify/Order/${shopifyOrderId}`,
    });
    return data.order?.events.nodes ?? [];
  },
  refreshOrder: async (sql, orderId) => {
    const [order] = await sql<{ store_id: string; shopify_order_id: string | null }[]>`
      select store_id, shopify_order_id::text from orders where id = ${orderId}
    `;
    if (!order?.shopify_order_id) return;
    const target = (await configuredStores(sql)).find((s) => s.id === order.store_id);
    if (target) await resyncOrder({ sql, logger }, target, `gid://shopify/Order/${order.shopify_order_id}`, emptyCounts());
  },
  refreshRecent: async (sql, since) => {
    await syncOrders({ sql, logger, stores: await configuredStores(sql) }, { since, saveCursor: false });
  },
};

export interface ConfirmationsOptions {
  shopify?: ShopifyGateway;
  /** Whether tags may be written to Shopify; off unless `SHOPIFY_WRITE_CONFIRMATION_TAGS` is true. */
  writeTags?: boolean;
}

export const confirmationsRouter = (getSql: SqlProvider, options: ConfirmationsOptions = {}): Router => {
  const shopify = options.shopify ?? liveShopify;
  const writeTags = () => options.writeTags ?? config.shopify.writeConfirmationTags;
  const router = Router();

  router.get('/confirmations/queue', async (req, res) => {
    const sql = requireSql(getSql);
    const q = parse(queueQuery, req.query);
    const { role } = sessionUser(req);
    const result = await deskQueue(sql, {
      ...(q.store ? { store: q.store } : {}),
      view: q.view,
      ...(q.tag ? { tag: q.tag } : {}),
      ...(q.search ? { search: q.search } : {}),
      page: q.page,
      pageSize: q.pageSize,
    });
    res.json({ total: result.total, page: q.page, pageSize: q.pageSize, rows: result.rows.map((r) => withoutPhones(r, role)), statusTags: STATUS_TAGS });
  });

  /** Reads the last few days of orders from Shopify now, instead of waiting for the next sync. */
  router.post('/confirmations/refresh', async (_req, res) => {
    const sql = requireSql(getSql);
    try {
      await shopify.refreshRecent(sql, new Date(Date.now() - REFRESH_WINDOW_MS));
    } catch (error) {
      throw new HttpError(502, `Could not read Shopify: ${message(error)}`);
    }
    res.json({ refreshed: true });
  });

  /**
   * One order: read back from Shopify first, then its lines, tags, the customer's history and the
   * timeline. Shopify being unreachable still shows the order as last synced, and says so.
   */
  router.get('/confirmations/orders/:orderId', async (req, res) => {
    const sql = requireSql(getSql);
    const { orderId } = parse(orderParams, req.params);
    const [known] = await sql<{ store: string; shopify_order_id: string | null }[]>`
      select st.key as store, o.shopify_order_id::text from orders o join stores st on st.id = o.store_id where o.id = ${orderId}
    `;
    if (!known) throw new HttpError(404, `Order ${orderId} not found`);

    const [refreshed, events] = await Promise.allSettled([
      shopify.refreshOrder(sql, orderId),
      known.shopify_order_id ? shopify.events(known.store, known.shopify_order_id) : Promise.resolve([]),
    ]);
    const failure = [refreshed, events].find((r) => r.status === 'rejected');
    if (failure) logger.warn({ orderId, err: failure.reason }, 'Order not read from Shopify; showing it as last synced');

    const order = (await deskOrder(sql, orderId))!;
    const { role } = sessionUser(req);
    const history = order.phone && seesPhones(role) ? await customerHistory(sql, order.phone, { city: order.city, excludeOrderId: orderId }) : null;
    res.json({
      order: { ...withoutPhones(order, role), shopifyUrl: adminUrl(order.store, order.shopifyOrderId) },
      history,
      timeline: await orderTimeline(sql, orderId, events.status === 'fulfilled' ? events.value : []),
      shopify: { error: failure ? message(failure.reason) : null, tagEditing: writeTags() },
    });
  });

  /** Adds and removes status tags, in Shopify first; audited with whoever made the change. */
  router.put('/confirmations/orders/:orderId/tags', async (req, res) => {
    const sql = requireSql(getSql);
    const { orderId } = parse(orderParams, req.params);
    const body = parse(tagChange, req.body);
    if (!writeTags()) throw new HttpError(409, 'Changing Shopify tags is switched off on this server (SHOPIFY_WRITE_CONFIRMATION_TAGS)');
    const result = await editOrderTags(sql, {
      orderId,
      actorId: await actorId(sql, sessionUser(req)),
      add: body.add,
      remove: body.remove,
      write: shopify.writeTags,
      refresh: (id) => shopify.refreshOrder(sql, id),
    }).catch(asHttp);
    res.json(result);
  });

  /** History by phone, typed in any shape; matched on the normalised number across both brands. */
  router.get('/confirmations/history', async (req, res) => {
    const sql = requireSql(getSql);
    const q = parse(historyQuery, req.query);
    if (!seesPhones(sessionUser(req).role)) throw new HttpError(403, 'Customer phone numbers are not available to this role');
    const history = await customerHistory(sql, q.phone, { city: q.city ?? null });
    if (!history) throw new HttpError(400, 'phone: not a Pakistani mobile number');
    res.json({ history });
  });

  /** The two alerts, open, oldest first. The scan raises and clears them hourly. */
  router.get('/confirmations/alerts', async (_req, res) => {
    const sql = requireSql(getSql);
    const rows = await sql<{ id: string; kind: string; severity: string; order_id: string | null; store: string | null; detail: Record<string, unknown>; created_at: Date }[]>`
      select r.id, r.kind, r.severity, r.order_id, st.key as store, r.detail, r.created_at
      from reconciliation_items r left join stores st on st.id = r.store_id
      where r.status = 'open' and r.kind in ('confirmed_not_booked', 'cancelled_but_booked')
      order by r.created_at, r.id
    `;
    res.json({
      alerts: rows.map((r) => ({ id: r.id, kind: r.kind, severity: r.severity, orderId: r.order_id, store: r.store, detail: r.detail, openedAt: r.created_at })),
    });
  });

  return router;
};
