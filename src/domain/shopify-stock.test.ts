import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { skipWithoutDb } from '../test/db.js';
import { orderWithLines, parcel, testUser, variantsIn } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { settlePendingShipments } from './settle.js';
import type { InventoryChange } from './shopify-returns.js';
import { type ShopifyStockItem, type StockPushGateway, pushStockToShopify } from './shopify-stock.js';
import { locationId, recordAdjustment, recordMove } from './stock.js';

/**
 * Stock changes made in the platform reach Shopify's available stock once each, only for the
 * warehouse, never for parcels or opening stock, and a refusal is kept and retried. Shopify is a
 * fake that remembers every adjustment and honours idempotency keys. Names are made up.
 */

const fakeShopify = (items: (variant: string) => ShopifyStockItem | null = (v) => ({ inventoryItemGid: `gid://shopify/InventoryItem/${v}`, tracked: true, locationGids: ['gid://shopify/Location/1'] })) => {
  const adjusts: Array<{ reason: string; key: string; changes: InventoryChange[] }> = [];
  const seen = new Set<string>();
  let refusal: string | null = null;
  const gateway: StockPushGateway = {
    item: async (_store, variant) => items(variant),
    adjust: async (_store, input) => {
      if (refusal) throw new Error(refusal);
      if (seen.has(input.key)) return;
      seen.add(input.key);
      adjusts.push({ reason: input.reason, key: input.key, changes: input.changes });
    },
  };
  return { gateway, adjusts, refuse: (m: string | null) => (refusal = m) };
};

describe('stock changes pushed to Shopify', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let variants: string[];
  let actor: string;
  let warehouse: string;
  const shopifyId = async (variant: string) => (await s.schema.sql<{ id: string }[]>`select shopify_variant_id::text as id from variants where id = ${variant}`)[0]!.id;
  const push = (gateway: StockPushGateway) => pushStockToShopify(s.schema.sql, { gateway });
  const pushRow = async (moveRef: string) =>
    (await s.schema.sql<{ outcome: string; delta: number; attempts: number }[]>`
      select p.outcome, p.delta, p.attempts from shopify_stock_pushes p join stock_moves m on m.id = p.stock_move_id where m.ref_id = ${moveRef}
    `)[0];

  before(async () => {
    s = await migratedWithStores();
    variants = await variantsIn(s.schema.sql, s.nur, 3);
    actor = await testUser(s.schema.sql);
    warehouse = await locationId(s.schema.sql, 'warehouse');
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('an adjustment or count at the warehouse changes Shopify by the same difference, once, with Shopify\'s reason', async () => {
    const shop = fakeShopify();
    await recordAdjustment(s.schema.sql, { locationId: warehouse, reason: 'correction', actorId: actor, lines: [{ variantId: variants[0]!, delta: 3 }] });
    await recordAdjustment(s.schema.sql, { locationId: warehouse, reason: 'count', actorId: actor, lines: [{ variantId: variants[0]!, delta: -1 }] });
    assert.deepEqual(await push(shop.gateway), { pushed: 2, skipped: 0, failed: 0 });
    assert.deepEqual(
      shop.adjusts.map((a) => [a.reason, a.changes[0]!.delta, a.changes[0]!.inventoryItemGid]),
      [['correction', 3, `gid://shopify/InventoryItem/${await shopifyId(variants[0]!)}`], ['cycle_count_available', -1, `gid://shopify/InventoryItem/${await shopifyId(variants[0]!)}`]],
    );
    assert.deepEqual(await push(shop.gateway), { pushed: 0, skipped: 0, failed: 0 }, 'a second run pushes nothing');
    assert.equal(shop.adjusts.length, 2);
  });

  it('moves out of the warehouse are negative; parcels, opening stock and other locations are never pushed', async () => {
    const shop = fakeShopify();
    // Any location but the warehouse: what Shopify sells from is the warehouse alone.
    const partner = await locationId(s.schema.sql, 'damaged');
    await recordMove(s.schema.sql, { variantId: variants[1]!, qty: 4, from: warehouse, to: partner, reason: 'consignment_out', refType: 'consignment_transfer_line', refId: 'ct-1', actorId: actor, occurredAt: new Date() });
    await recordAdjustment(s.schema.sql, { locationId: warehouse, reason: 'opening_stock', actorId: actor, lines: [{ variantId: variants[1]!, delta: 10 }] });
    await recordAdjustment(s.schema.sql, { locationId: partner, reason: 'correction', actorId: actor, lines: [{ variantId: variants[1]!, delta: 2 }] });
    const inTransit = await locationId(s.schema.sql, 'in_transit');
    await recordMove(s.schema.sql, { variantId: variants[1]!, qty: 1, from: warehouse, to: inTransit, reason: 'booked', refType: 'shipment', refId: 'test-parcel', occurredAt: new Date() });
    await push(shop.gateway);
    assert.deepEqual(shop.adjusts.map((a) => [a.reason, a.changes[0]!.delta]), [['movement_created', -4]]);
    assert.equal((await pushRow('ct-1'))?.delta, -4);
  });

  it('a product Shopify does not track, or no longer has, is skipped rather than failed', async () => {
    const untracked = await shopifyId(variants[2]!);
    const shop = fakeShopify((v) => (v === untracked ? { inventoryItemGid: 'gid://shopify/InventoryItem/x', tracked: false, locationGids: [] } : null));
    await recordMove(s.schema.sql, { variantId: variants[2]!, qty: 2, from: await locationId(s.schema.sql, 'supplier'), to: warehouse, reason: 'goods_receipt', refType: 'gr_line', refId: 'gr-1', actorId: actor, occurredAt: new Date() });
    assert.deepEqual(await push(shop.gateway), { pushed: 0, skipped: 1, failed: 0 });
    assert.equal((await pushRow('gr-1'))?.outcome, 'skipped');
    assert.equal(shop.adjusts.length, 0);
  });

  it('a refusal is kept and queued for review, waits before it is tried again, and once Shopify answers is pushed once and the item closed', async () => {
    const shop = fakeShopify();
    await recordMove(s.schema.sql, { variantId: variants[0]!, qty: 5, from: await locationId(s.schema.sql, 'supplier'), to: warehouse, reason: 'goods_receipt', refType: 'gr_line', refId: 'gr-2', actorId: actor, occurredAt: new Date() });
    shop.refuse('Access denied for inventoryAdjustQuantities field. Required access: `write_inventory`');
    assert.deepEqual(await push(shop.gateway), { pushed: 0, skipped: 0, failed: 1 });
    const open = async () => (await s.schema.sql<{ n: number }[]>`select count(*)::int as n from reconciliation_items where kind = 'shopify_stock_push_failed' and status = 'open'`)[0]!.n;
    assert.equal(await open(), 1);
    shop.refuse(null);
    assert.deepEqual(await push(shop.gateway), { pushed: 0, skipped: 0, failed: 0 }, 'not retried straight away');
    await s.schema.sql`update shopify_stock_pushes set last_at = now() - interval '1 hour' where outcome = 'failed'`;
    assert.deepEqual(await push(shop.gateway), { pushed: 1, skipped: 0, failed: 0 });
    assert.deepEqual([(await pushRow('gr-2'))?.outcome, (await pushRow('gr-2'))?.attempts], ['done', 2]);
    assert.equal(await open(), 0);
    assert.deepEqual(shop.adjusts.map((a) => [a.reason, a.changes[0]!.delta]), [['received', 5]]);
  });

  it('two pushes at once change Shopify once', async () => {
    const shop = fakeShopify();
    await recordAdjustment(s.schema.sql, { locationId: warehouse, reason: 'loss', actorId: actor, lines: [{ variantId: variants[0]!, delta: -2 }] });
    const [a, b] = await Promise.all([push(shop.gateway), push(shop.gateway)]);
    assert.equal(a.pushed + b.pushed, 1);
    assert.deepEqual(shop.adjusts.map((x) => [x.reason, x.changes[0]!.delta]), [['shrinkage', -2]]);
  });

  it('settles parcels whose facts changed: their postings are brought in line now', async () => {
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    const orderId = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#S1', placedAt: new Date('2026-09-01T06:00:00Z'), lines: [{ variantId: variants[0]!, qty: 1 }] });
    const shipmentId = await parcel(s.schema.sql, { accountId: account!.id, orderId, events: [['0005', '2026-09-03T09:00:00Z']] });
    await s.schema.sql`update shipments set stock_pending = true, accounting_pending = true where id = ${shipmentId}`;
    const result = await settlePendingShipments(s.schema.sql);
    assert.ok(result.postings >= 1);
    const [flags] = await s.schema.sql<{ stock_pending: boolean; accounting_pending: boolean }[]>`select stock_pending, accounting_pending from shipments where id = ${shipmentId}`;
    assert.deepEqual([flags!.stock_pending, flags!.accounting_pending], [false, false]);
    const [sale] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from journal_entries where source_type = 'shipment_sale' and source_id = ${shipmentId}`;
    assert.equal(sale!.n, 1, 'the delivered sale is posted without waiting for the PostEx sync');
  });
});
