import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { skipWithoutDb } from '../test/db.js';
import { orderWithLines, parcel, testUser, variantsIn } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { inventoryCheck } from './accounting.js';
import { openingStockFromShopify, shopifyStockComparison } from './opening-stock.js';
import { StockError, reconcileShipmentStock } from './stock.js';

describe("opening stock from Shopify's figures", { skip: skipWithoutDb }, () => {
  let s: Stores;
  let serum: string;
  let toner: string;
  let actor: string;

  before(async () => {
    s = await migratedWithStores();
    actor = await testUser(s.schema.sql);
    [serum, toner] = (await variantsIn(s.schema.sql, s.nur, 2)) as [string, string];
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    // Shopify: 20 serums on hand, 5 committed (3 on an order not booked yet, 2 on a parcel that already left), 15 available.
    await s.schema.sql`
      insert into shopify_stock_levels (variant_id, store_id, location_gid, location_name, on_hand, available, committed, read_at) values
        (${serum}, ${s.nur}, 'gid://shopify/Location/1', 'Shop location', 20, 15, 5, now()),
        (${toner}, ${s.nur}, 'gid://shopify/Location/1', 'Shop location', 4, 4, 0, now())
    `;
    await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#5001', placedAt: new Date('2026-09-02T05:00:00Z'), lines: [{ variantId: serum, qty: 3 }] });
    const shipped = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#5002', placedAt: new Date('2026-09-02T05:00:00Z'), lines: [{ variantId: serum, qty: 2 }] });
    const parcelId = await parcel(s.schema.sql, { accountId: account!.id, orderId: shipped, bookedAt: new Date('2026-09-02T10:00:00Z') });
    await reconcileShipmentStock(s.schema.sql, parcelId);
  });

  after(async () => {
    await s?.schema.drop();
  });

  it("estimates the shelf as available + committed to unbooked orders, since Shopify's on hand still counts shipped parcels", async () => {
    const rows = await shopifyStockComparison(s.schema.sql, 'nur');
    const row = rows.find((r) => r.variantId === serum)!;
    assert.deepEqual(
      [row.onHand, row.available, row.committed, row.committedUnbooked, row.estimate, row.warehouse, row.difference],
      [20, 15, 5, 3, 18, -2, 20],
    );
    assert.equal(rows.find((r) => r.variantId === toner)?.difference, 4);
  });

  it('records the count dated at the cut-over day so our warehouse today equals the estimate; once only', async () => {
    const result = await openingStockFromShopify(s.schema.sql, { asAt: '2026-08-31', actorId: actor, storeKey: 'nur' });
    assert.deepEqual([result?.lines, result?.units], [2, 24]);
    const after = await shopifyStockComparison(s.schema.sql, 'nur');
    assert.deepEqual(after.map((r) => r.difference), [0, 0], 'warehouse today = estimate');
    // On the cut-over day, before the parcel left, the warehouse held 20 serums and 4 toners.
    const check = await inventoryCheck(s.schema.sql, '2026-08-31');
    assert.equal(check.units, 24);
    const [move] = await s.schema.sql`
      select occurred_at from stock_moves where ref_type = 'stock_adjustment' and variant_id = ${serum}
    `;
    assert.equal((move?.['occurred_at'] as Date).toISOString(), '2026-08-31T18:59:59.999Z');
    await assert.rejects(openingStockFromShopify(s.schema.sql, { asAt: '2026-08-31', actorId: actor, storeKey: 'nur' }), (e: unknown) => e instanceof StockError && /already taken from Shopify/.test(e.message));
  });
});
