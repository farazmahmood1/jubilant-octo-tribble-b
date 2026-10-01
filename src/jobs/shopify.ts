import { config, isShopifyStoreReady } from '../config.js';
import type { Sql } from '../db.js';
import { upsertAddress, upsertCustomer } from '../db/repos/customers.js';
import { getCursor, setCursor } from '../db/repos/cursors.js';
import { type OrderUpsertResult, upsertOrder } from '../db/repos/orders.js';
import { upsertProduct } from '../db/repos/products.js';
import { listOpenReviewItems, openReviewItem, resolveReviewItem } from '../db/repos/review.js';
import { atomically } from '../db/repos/upsert.js';
import { upsertVariant } from '../db/repos/variants.js';
import { shopifyClient } from '../integrations/shopify/client.js';
import {
  type Connection,
  type ShopifyLineNode,
  type ShopifyOrderNode,
  type ShopifyProductNode,
  type ShopifyVariantNode,
  mapOrder,
  mapProduct,
} from '../integrations/shopify/mapper.js';
import {
  ORDERS_QUERY,
  ORDER_LINES_QUERY,
  ORDER_QUERY,
  PAGE_SIZE,
  PRODUCTS_QUERY,
  PRODUCT_VARIANTS_QUERY,
} from '../integrations/shopify/queries.js';
import type { Logger } from '../logger.js';
import type { JobDefinition, JobStats } from './runner.js';

export const CATALOGUE_JOB = 'shopify:catalogue';
export const ORDERS_JOB = 'shopify:orders';
/** Review-queue kind for an order the sync fetched but could not store. */
export const SKIPPED_ORDER = 'shopify_order_skipped';

/** The one thing the syncs need from Shopify; the real client in production, a fake in tests. */
export type GraphqlFn = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;

export interface StoreTarget {
  key: string;
  id: string;
  graphql: GraphqlFn;
}

export interface SyncDeps {
  sql: Sql;
  logger: Logger;
  stores: StoreTarget[];
  signal?: AbortSignal;
  now?: () => Date;
}

/** Re-read this much before the saved cursor, so an order updated in the same instant as the last one saved is not missed. */
export const CURSOR_OVERLAP_MS = 10 * 60 * 1000;
/** What the Orders API returns without the `read_all_orders` scope; older history is a CSV import (Step 16). */
export const INITIAL_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export interface Counts {
  fetched: number;
  inserted: number;
  updated: number;
  changed: number;
  skipped: number;
  [extra: string]: number;
}

export const emptyCounts = (): Counts => ({ fetched: 0, inserted: 0, updated: 0, changed: 0, skipped: 0 });

/** Totals plus a `<store>.<counter>` breakdown, in the flat shape sync_runs.stats holds. */
export const flatten = (perStore: Map<string, Counts>): JobStats => {
  const stats: JobStats = {};
  for (const [store, counts] of perStore) {
    for (const [key, value] of Object.entries(counts)) {
      stats[key] = (Number(stats[key]) || 0) + value;
      stats[`${store}.${key}`] = value;
    }
  }
  return stats;
};

const bump = (counts: Counts, key: string, by = 1): void => {
  counts[key] = (counts[key] ?? 0) + by;
};

/** Collects every remaining page of a nested list (variants, line items) past the first 100. */
const restOf = async <T>(
  graphql: GraphqlFn,
  query: string,
  id: string,
  first: Connection<T>,
  pick: (data: Record<string, unknown>) => Connection<T> | undefined,
): Promise<T[]> => {
  const all = [...first.nodes];
  let pageInfo = first.pageInfo;
  while (pageInfo.hasNextPage) {
    const page = pick(await graphql<Record<string, unknown>>(query, { id, after: pageInfo.endCursor }));
    if (!page) break;
    all.push(...page.nodes);
    pageInfo = page.pageInfo;
  }
  return all;
};

/**
 * Every product and variant of each store. The catalogue is small, so each run reads all of it:
 * no cursor, nothing to resume. A variant the database refuses (most likely a SKU used twice in
 * one store) is counted as skipped and logged, and the rest of the catalogue still syncs.
 *
 * After a complete scan, products and variants Shopify no longer returned are marked deleted
 * (they cannot be removed: order lines refer to them). A scan cut short marks nothing, since
 * "not seen" would then only mean "not reached".
 */
export const syncCatalogue = async (deps: SyncDeps): Promise<JobStats> => {
  const perStore = new Map<string, Counts>();
  for (const store of deps.stores) {
    const counts = emptyCounts();
    perStore.set(store.key, counts);
    const seenProducts: string[] = [];
    const seenVariants: string[] = [];
    let complete = true;
    let after: string | null = null;
    do {
      if (deps.signal?.aborted) {
        complete = false;
        break;
      }
      const data: { products: Connection<ShopifyProductNode> } = await store.graphql(PRODUCTS_QUERY, { first: PAGE_SIZE, after });
      for (const node of data.products.nodes) {
        const variants = await restOf<ShopifyVariantNode>(store.graphql, PRODUCT_VARIANTS_QUERY, node.id, node.variants, (d) =>
          (d['product'] as { variants?: Connection<ShopifyVariantNode> } | null)?.variants,
        );
        const mapped = mapProduct(node, variants);
        counts.fetched++;
        seenProducts.push(String(mapped.product.shopifyProductId));
        const product = await upsertProduct(deps.sql, { storeId: store.id, ...mapped.product });
        counts[product.action]++;
        if (product.changed) counts.changed++;
        for (const variant of mapped.variants) {
          seenVariants.push(String(variant.shopifyVariantId));
          try {
            const result = await upsertVariant(deps.sql, { storeId: store.id, productId: product.id, ...variant });
            if (result.changed) counts.changed++;
          } catch (error) {
            counts.skipped++;
            deps.logger.warn({ store: store.key, shopifyVariantId: String(variant.shopifyVariantId), sku: variant.sku, err: error }, 'Variant skipped');
          }
        }
      }
      after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    } while (after);

    if (complete) {
      const products = await deps.sql`
        update products set deleted_at = now()
        where store_id = ${store.id} and deleted_at is null and not (shopify_product_id::text = any(${seenProducts}::text[]))
        returning id
      `;
      const variants = await deps.sql`
        update variants set deleted_at = now()
        where store_id = ${store.id} and deleted_at is null and not (shopify_variant_id::text = any(${seenVariants}::text[]))
        returning id
      `;
      counts['deletedProducts'] = products.length;
      counts['deletedVariants'] = variants.length;
    }

    const [row] = await deps.sql<{ n: number }[]>`
      select count(*)::int as n from variants where store_id = ${store.id} and sku is null and deleted_at is null
    `;
    counts['unmappedSkus'] = row?.n ?? 0;
  }
  return flatten(perStore);
};

/** Shopify variant id → our variant id, for linking order lines. Deleted variants still link: old orders used them. */
export const loadVariantIds = async (sql: Sql, storeId: string): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  for (const row of await sql<{ id: string; shopify_variant_id: string }[]>`
    select id, shopify_variant_id::text from variants where store_id = ${storeId}
  `) {
    map.set(row.shopify_variant_id, row.id);
  }
  return map;
};

const skippedKey = (store: StoreTarget, orderGid: string): string => `${SKIPPED_ORDER}:${store.id}:${orderGid}`;

const ERROR_DETAIL_LENGTH = 500;

/**
 * Stores one Shopify order node: customer, address, order and lines in one transaction, with
 * the node as `raw`. Every path an order arrives by (bulk sync, webhook, retry, catch-up) ends
 * here, so they cannot drift apart.
 *
 * Never throws. An order that cannot be stored is counted as skipped, logged by name only, and
 * queued for review with the error, so it is retried and, failing that, seen by a person. An
 * order stored successfully closes any open review item about it.
 */
export const storeOrderNode = async (
  deps: Pick<SyncDeps, 'sql' | 'logger'>,
  store: StoreTarget,
  node: ShopifyOrderNode,
  variantIds: Map<string, string>,
  counts: Counts,
): Promise<OrderUpsertResult | null> => {
  counts.fetched++;
  try {
    const lines = await restOf<ShopifyLineNode>(store.graphql, ORDER_LINES_QUERY, node.id, node.lineItems, (d) =>
      (d['order'] as { lineItems?: Connection<ShopifyLineNode> } | null)?.lineItems,
    );
    const mapped = mapOrder(node, lines);
    const result = await atomically(deps.sql, async (tx) => {
      const customer = await upsertCustomer(tx, { storeId: store.id, ...mapped.customer, shopifyOrderId: mapped.order.shopifyOrderId });
      const address = customer && mapped.address ? await upsertAddress(tx, customer.id, mapped.address) : null;
      const { updatedAt: _updatedAt, ...order } = mapped.order;
      return upsertOrder(tx, {
        storeId: store.id,
        ...order,
        customerId: customer?.id ?? null,
        shippingAddressId: address?.id ?? null,
        source: 'api',
        raw: node,
        lines: mapped.lines.map(({ shopifyVariantId, ...line }) => {
          // A line with no Shopify variant (a custom item) is not unmapped: there is nothing to map it to.
          const variantId = shopifyVariantId === null ? null : (variantIds.get(String(shopifyVariantId)) ?? null);
          if (shopifyVariantId !== null && variantId === null) bump(counts, 'unmappedLines');
          return { ...line, variantId };
        }),
      });
    });
    counts[result.action]++;
    if (result.changed) counts.changed++;
    const [open] = await deps.sql<{ id: string }[]>`
      select id from reconciliation_items where dedupe_key = ${skippedKey(store, node.id)} and status = 'open'
    `;
    if (open) {
      await resolveReviewItem(deps.sql, open.id, 'Stored on a later sync');
      bump(counts, 'recovered');
    }
    return result;
  } catch (error) {
    counts.skipped++;
    const message = error instanceof Error ? error.message : String(error);
    deps.logger.warn({ store: store.key, order: node.name, err: error }, 'Order skipped; queued for review');
    await openReviewItem(deps.sql, {
      kind: SKIPPED_ORDER,
      dedupeKey: skippedKey(store, node.id),
      storeId: store.id,
      detail: { shopifyOrderGid: node.id, orderNumber: node.name, error: message.slice(0, ERROR_DETAIL_LENGTH) },
    }).catch((err: unknown) => deps.logger.error({ store: store.key, order: node.name, err }, 'Could not queue skipped order'));
    return null;
  }
};

/** Fetches one order by gid and stores it. Returns false when Shopify no longer has it. */
export const resyncOrder = async (
  deps: Pick<SyncDeps, 'sql' | 'logger'>,
  store: StoreTarget,
  orderGid: string,
  counts: Counts,
  variantIds?: Map<string, string>,
): Promise<boolean> => {
  const data = await store.graphql<{ order: ShopifyOrderNode | null }>(ORDER_QUERY, { id: orderGid });
  if (!data.order) return false;
  await storeOrderNode(deps, store, data.order, variantIds ?? (await loadVariantIds(deps.sql, store.id)), counts);
  return true;
};

export interface OrderWindow {
  /** Read orders updated from this instant instead of from the saved cursor. */
  since?: Date;
  /** Move the saved cursor as pages are stored. Default true; the catch-up leaves it alone. */
  saveCursor?: boolean;
}

/**
 * Orders updated since the store's cursor, oldest update first. After each page is stored the
 * cursor moves to that page's newest `updatedAt`, so a run that dies, or is stopped, resumes from
 * the last finished page; re-reading a few orders is harmless because every write is an upsert.
 *
 * An order that fails is skipped and queued for review (see `storeOrderNode`), and the cursor
 * still moves past it, so one bad order cannot stall the store. The catch-up job retries it.
 */
export const syncOrders = async (deps: SyncDeps, window: OrderWindow = {}): Promise<JobStats> => {
  const now = deps.now ?? (() => new Date());
  const saveCursor = window.saveCursor ?? true;
  const perStore = new Map<string, Counts>();

  for (const store of deps.stores) {
    const counts = emptyCounts();
    counts['unmappedLines'] = 0;
    perStore.set(store.key, counts);

    let since = window.since;
    if (!since) {
      const saved = await getCursor(deps.sql, ORDERS_JOB, store.key);
      since = saved ? new Date(new Date(saved).getTime() - CURSOR_OVERLAP_MS) : new Date(now().getTime() - INITIAL_WINDOW_MS);
    }
    const query = `updated_at:>='${since.toISOString()}'`;
    const variantIds = await loadVariantIds(deps.sql, store.id);

    let after: string | null = null;
    do {
      if (deps.signal?.aborted) break;
      const data: { orders: Connection<ShopifyOrderNode> } = await store.graphql(ORDERS_QUERY, { first: PAGE_SIZE, after, query });
      let newest: string | null = null;
      for (const node of data.orders.nodes) {
        await storeOrderNode(deps, store, node, variantIds, counts);
        if (!newest || node.updatedAt > newest) newest = node.updatedAt;
      }
      if (newest && saveCursor) await setCursor(deps.sql, ORDERS_JOB, store.key, newest);
      after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
    } while (after);
  }
  return flatten(perStore);
};

/** Retries every open skipped-order item: re-fetches the order and stores it, which resolves the item. */
export const retrySkippedOrders = async (deps: SyncDeps, perStore: Map<string, Counts>): Promise<void> => {
  for (const store of deps.stores) {
    const counts = perStore.get(store.key) ?? emptyCounts();
    perStore.set(store.key, counts);
    const items = await listOpenReviewItems(deps.sql, SKIPPED_ORDER, store.id);
    if (items.length === 0) continue;
    const variantIds = await loadVariantIds(deps.sql, store.id);
    for (const item of items) {
      if (deps.signal?.aborted) return;
      const gid = String(item.detail['shopifyOrderGid'] ?? '');
      bump(counts, 'retried');
      const found = await resyncOrder(deps, store, gid, counts, variantIds);
      if (!found) await resolveReviewItem(deps.sql, item.id, 'Order no longer exists in Shopify');
    }
  }
};

/**
 * The configured stores that have credentials, paired with their row in `stores`. None at all is
 * an error, not an empty success: a sync that quietly syncs nothing hides a broken deploy.
 */
export const configuredStores = async (sql: Sql): Promise<StoreTarget[]> => {
  const ready = config.shopify.stores.filter(isShopifyStoreReady);
  const rows = await sql<{ id: string; key: string }[]>`select id, key from stores where key = any(${ready.map((s) => s.key)}::text[])`;
  const targets = ready.flatMap((store): StoreTarget[] => {
    const row = rows.find((r) => r.key === store.key);
    if (!row) return [];
    const client = shopifyClient(store.key);
    return [{ key: store.key, id: row.id, graphql: (query, variables) => client.graphql(query, variables) }];
  });
  if (targets.length === 0) {
    throw new Error('No Shopify store is ready to sync: set its client ID and secret, and seed the stores table');
  }
  return targets;
};

export const shopifyJobs: JobDefinition[] = [
  {
    name: CATALOGUE_JOB,
    schedule: { everyMs: 60 * 60 * 1000 },
    handler: async ({ sql, logger, signal }) => syncCatalogue({ sql, logger, signal, stores: await configuredStores(sql) }),
  },
  {
    name: ORDERS_JOB,
    // Webhooks are the fast path and shopify:catchup the 15-minute safety net, so the full cursor
    // walk only needs to run hourly.
    schedule: { everyMs: 60 * 60 * 1000 },
    handler: async ({ sql, logger, signal }) => syncOrders({ sql, logger, signal, stores: await configuredStores(sql) }),
  },
];
