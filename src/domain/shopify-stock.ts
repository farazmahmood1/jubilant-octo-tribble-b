import type { Sql } from '../db.js';
import { openReviewItem, resolveOpenReviewItem } from '../db/repos/review.js';
import { type Db, atomically } from '../db/repos/upsert.js';
import { shopifyClient } from '../integrations/shopify/client.js';
import type { JobDefinition, JobStats } from '../jobs/runner.js';
import { SYNC_EVERY_MS } from '../jobs/runner.js';
import { logger } from '../logger.js';
import { type InventoryChange, friendly } from './shopify-returns.js';
import { locationId } from './stock.js';

/**
 * Stock changes made in the platform, carried to Shopify's available stock at once, so the
 * storefront never sells what is not on the shelf. Which moves, and why only these:
 *
 * | Move (ref_type)                | Made by                                   | In Shopify                     |
 * |--------------------------------|-------------------------------------------|--------------------------------|
 * | `stock_adjustment`             | an adjustment or a count (not opening)    | the same difference            |
 * | `gr_line`                      | goods received from a vendor              | + the units received           |
 * | `consignment_transfer_line`    | stock sent to, or back from, a partner    | − out, + back                  |
 * | `pr_send_line`                 | a PR send handed over outside Shopify     | − the units sent               |
 *
 * Only moves into or out of the main warehouse count: that is the stock Shopify sells from.
 * Parcels and returns are not pushed: Shopify moves those itself through the order (and the
 * returns write-back). Opening stock is not pushed either: it was read from Shopify, or is a first
 * count of what Shopify already holds.
 *
 * Each move is pushed once: a row in `shopify_stock_pushes` per move, Shopify's own idempotency key
 * per move, and a per-move advisory lock, so a retry, a double click or the job and a request at
 * once never change Shopify twice. A product Shopify does not track stock for is skipped, never
 * failed; a refusal is `failed`, queued for review, and retried by `shopify:stock-push`.
 */

export const PUSHED_MOVES = ['stock_adjustment', 'gr_line', 'consignment_transfer_line', 'pr_send_line'] as const;

/** Shopify's adjustment reason for each of the platform's move reasons; anything else is a correction. */
const SHOPIFY_REASON: Record<string, string> = {
  count: 'cycle_count_available',
  correction: 'correction',
  damage: 'damaged',
  loss: 'shrinkage',
  goods_receipt: 'received',
  consignment_out: 'movement_created',
  consignment_back: 'movement_received',
  pr_send: 'promotion',
  pr_send_undone: 'correction',
};

export interface ShopifyStockItem {
  inventoryItemGid: string;
  tracked: boolean;
  /** Locations Shopify stocks the item at. */
  locationGids: string[];
}

/** The calls a push makes. The default calls the real stores; tests pass their own. */
export interface StockPushGateway {
  item(store: string, shopifyVariantId: string): Promise<ShopifyStockItem | null>;
  adjust(store: string, input: { reason: string; key: string; reference: string; changes: InventoryChange[] }): Promise<void>;
}

export const liveStockGateway: StockPushGateway = {
  item: async (store, shopifyVariantId) => {
    const data = await shopifyClient(store).graphql<{
      productVariant: { inventoryItem: { id: string; tracked: boolean; inventoryLevels: { nodes: Array<{ location: { id: string } }> } } | null } | null;
    }>(
      `query StockItem($id: ID!) { productVariant(id: $id) { inventoryItem { id tracked inventoryLevels(first: 10) { nodes { location { id } } } } } }`,
      { id: `gid://shopify/ProductVariant/${shopifyVariantId}` },
    );
    const item = data.productVariant?.inventoryItem;
    return item ? { inventoryItemGid: item.id, tracked: item.tracked, locationGids: item.inventoryLevels.nodes.map((n) => n.location.id) } : null;
  },
  adjust: async (store, input) => {
    const data = await shopifyClient(store).graphql<{ inventoryAdjustQuantities: { userErrors: Array<{ message: string }> } }>(
      `mutation StockAdjust($input: InventoryAdjustQuantitiesInput!, $key: String!) {
        inventoryAdjustQuantities(input: $input) @idempotent(key: $key) { userErrors { field message } }
      }`,
      {
        key: input.key,
        input: {
          reason: input.reason,
          name: 'available',
          referenceDocumentUri: input.reference,
          changes: input.changes.map((c) => ({ delta: c.delta, inventoryItemId: c.inventoryItemGid, locationId: c.locationGid, changeFromQuantity: null })),
        },
      },
    );
    const errors = data.inventoryAdjustQuantities.userErrors;
    if (errors.length > 0) throw new Error(errors.map((e) => e.message).join('; '));
  },
};

interface Candidate {
  id: string;
  qty: number;
  reason: string;
  inbound: boolean;
  variant_id: string;
  shopify_variant: string;
  store: string;
  store_id: string;
  title: string;
}

export interface PushResult {
  pushed: number;
  skipped: number;
  failed: number;
}

const failedKey = (moveId: string) => `shopify_stock_push_failed:${moveId}`;

/** Where Shopify keeps the variant: the location our last reading saw the most of, if Shopify still stocks it there. */
const locationFor = async (db: Db, variantId: string, item: ShopifyStockItem): Promise<string | null> => {
  const [row] = await db<{ location_gid: string }[]>`
    select location_gid from shopify_stock_levels where variant_id = ${variantId} and location_gid = any(${item.locationGids}::text[])
    order by on_hand desc, location_gid limit 1
  `;
  return row?.location_gid ?? item.locationGids[0] ?? null;
};

const recordPush = async (db: Db, c: Candidate, outcome: 'done' | 'skipped' | 'failed', message: string): Promise<void> => {
  await db`
    insert into shopify_stock_pushes (stock_move_id, store_id, outcome, delta, message)
    values (${c.id}, ${c.store_id}, ${outcome}, ${c.inbound ? c.qty : -c.qty}, ${message})
    on conflict (stock_move_id) do update
      set outcome = excluded.outcome, message = excluded.message, attempts = shopify_stock_pushes.attempts + 1, last_at = now()
  `;
};

/** Pushes one move, if no one else is pushing it and it has not been settled since it was picked. */
const pushOne = async (sql: Sql, gateway: StockPushGateway, c: Candidate): Promise<'done' | 'skipped' | 'failed' | 'busy'> =>
  atomically(sql, async (tx) => {
    const [lock] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(hashtextextended(${`nur.shopify-stock-push:${c.id}`}, 0)) as ok`;
    if (!lock?.ok) return 'busy';
    const [settled] = await tx`select 1 from shopify_stock_pushes where stock_move_id = ${c.id} and outcome in ('done', 'skipped')`;
    if (settled) return 'busy';
    const delta = c.inbound ? c.qty : -c.qty;
    try {
      const item = await gateway.item(c.store, c.shopify_variant);
      if (!item) {
        await recordPush(tx, c, 'skipped', 'Shopify no longer has this product, so there is no stock to change there.');
        return 'skipped';
      }
      if (!item.tracked) {
        await recordPush(tx, c, 'skipped', 'Shopify does not track stock for this product (Track quantity is off), so its stock there was left alone.');
        return 'skipped';
      }
      const location = await locationFor(tx, c.variant_id, item);
      if (!location) throw new Error('Shopify stocks this product at no location');
      await gateway.adjust(c.store, {
        reason: SHOPIFY_REASON[c.reason] ?? 'correction',
        key: `nur-stock-move-${c.id}`,
        reference: `logistics://monixys/stock-move/${c.id}`,
        changes: [{ inventoryItemGid: item.inventoryItemGid, locationGid: location, delta }],
      });
      await recordPush(tx, c, 'done', `${delta > 0 ? '+' : ''}${delta} available in Shopify.`);
      await resolveOpenReviewItem(tx, failedKey(c.id), 'Pushed to Shopify on a later attempt');
      return 'done';
    } catch (error) {
      const message = friendly(error);
      logger.warn({ stockMoveId: c.id, store: c.store, err: message }, 'Stock change not carried to Shopify');
      await recordPush(tx, c, 'failed', message);
      await openReviewItem(tx, {
        kind: 'shopify_stock_push_failed',
        dedupeKey: failedKey(c.id),
        storeId: c.store_id,
        detail: { stockMoveId: c.id, variantId: c.variant_id, product: c.title, delta, error: message.slice(0, 500) },
      });
      return 'failed';
    }
  });

/**
 * Pushes every stock move Shopify has not been told about yet (new, or failed before), oldest
 * first. Called right after an action that moves stock, so Shopify changes at once, and by
 * `shopify:stock-push` for anything a request could not finish. Never throws for a Shopify refusal.
 */
export const pushStockToShopify = async (sql: Sql, options: { gateway?: StockPushGateway; limit?: number; signal?: AbortSignal } = {}): Promise<PushResult> => {
  const gateway = options.gateway ?? liveStockGateway;
  const warehouse = await locationId(sql, 'warehouse');
  const candidates = await sql<Candidate[]>`
    select m.id, m.qty, m.reason, (m.to_location_id = ${warehouse}) as inbound, v.id as variant_id, v.shopify_variant_id::text as shopify_variant,
           st.key as store, st.id as store_id, p.title || ' · ' || v.title as title
    from stock_moves m
    join variants v on v.id = m.variant_id
    join products p on p.id = v.product_id
    join stores st on st.id = v.store_id
    where m.ref_type = any(${[...PUSHED_MOVES]}::text[])
      and ${warehouse} in (m.from_location_id, m.to_location_id)
      and not (m.ref_type = 'stock_adjustment' and m.reason = 'opening_stock')
      and not exists (select 1 from shopify_stock_pushes x where x.stock_move_id = m.id and x.outcome in ('done', 'skipped'))
      -- A refusal is tried again later each time, at most hourly, so a lasting one does not hammer Shopify.
      and not exists (
        select 1 from shopify_stock_pushes x
        where x.stock_move_id = m.id and x.outcome = 'failed' and x.last_at > now() - least(x.attempts * 2, 60) * interval '1 minute'
      )
    order by m.id
    limit ${options.limit ?? 200}
  `;
  const result: PushResult = { pushed: 0, skipped: 0, failed: 0 };
  for (const c of candidates) {
    if (options.signal?.aborted) break;
    const outcome = await pushOne(sql, gateway, c);
    if (outcome === 'done') result.pushed++;
    else if (outcome === 'skipped') result.skipped++;
    else if (outcome === 'failed') result.failed++;
  }
  return result;
};

export const STOCK_PUSH_JOB = 'shopify:stock-push';

export const stockPushJob: JobDefinition = {
  name: STOCK_PUSH_JOB,
  schedule: { everyMs: SYNC_EVERY_MS, alignToClock: true },
  handler: async ({ sql, signal }): Promise<JobStats> => ({ ...(await pushStockToShopify(sql, { signal })) }),
};
