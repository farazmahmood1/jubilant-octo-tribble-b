import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { fromRupeeString } from '../../lib/money.js';
import { parsePostexLocal } from '../../lib/time.js';
import { skipWithoutDb } from '../../test/db.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';
import { findProduct, upsertProduct } from './products.js';
import { tally } from './upsert.js';
import { addProductCost, costAt, findVariant, listUnmappedVariants, upsertVariant } from './variants.js';

describe('products and variants', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let nurProduct: string;
  let organicsProduct: string;

  before(async () => {
    s = await migratedWithStores();
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('upserting the same product twice: 1 insert, then 0 inserts and 1 update that changes nothing', async () => {
    const input = { storeId: s.nur, shopifyProductId: 7_000_000_001n, title: 'Face Serum', brand: 'NUR', status: 'ACTIVE' };
    const first = await upsertProduct(s.schema.sql, input);
    const second = await upsertProduct(s.schema.sql, input);

    assert.deepEqual(tally([first]), { inserted: 1, updated: 0, changed: 1 });
    assert.deepEqual(tally([second]), { inserted: 0, updated: 1, changed: 0 });
    assert.equal(second.id, first.id);
    nurProduct = first.id;

    const stored = await findProduct(s.schema.sql, s.nur, 7_000_000_001n);
    assert.equal(stored?.status, 'active', 'Shopify statuses are stored lowercased');
  });

  it('reports a real change as changed', async () => {
    const result = await upsertProduct(s.schema.sql, { storeId: s.nur, shopifyProductId: 7_000_000_001n, title: 'Face Serum 30ml', brand: 'NUR', status: 'ACTIVE' });
    assert.deepEqual({ action: result.action, changed: result.changed }, { action: 'updated', changed: true });
  });

  it('keeps the same Shopify product id in two stores as two products', async () => {
    const result = await upsertProduct(s.schema.sql, { storeId: s.organics, shopifyProductId: 7_000_000_001n, title: 'Neem Soap', brand: null, status: 'ACTIVE' });
    assert.equal(result.action, 'inserted');
    assert.notEqual(result.id, nurProduct);
    organicsProduct = result.id;
  });

  it('stores Shopify ids beyond 2^53 exactly', async () => {
    const huge = 9_007_199_254_740_993n;
    await upsertProduct(s.schema.sql, { storeId: s.nur, shopifyProductId: huge, title: 'Huge id', brand: null, status: 'DRAFT' });
    assert.equal((await findProduct(s.schema.sql, s.nur, huge))?.shopifyProductId, huge);
  });

  it('upserting the same variant twice: 1 insert, then 1 update that changes nothing', async () => {
    const input = { storeId: s.nur, productId: nurProduct, shopifyVariantId: 8_000_000_001n, sku: 'NBJ-SER-30', title: '30ml', barcode: null };
    const results = [await upsertVariant(s.schema.sql, input), await upsertVariant(s.schema.sql, input)];
    assert.deepEqual(results.map((r) => [r.action, r.changed]), [['inserted', true], ['updated', false]]);
  });

  it('allows many variants without a SKU, and stores a blank SKU as null', async () => {
    for (const [id, sku] of [[8_100_000_001n, null], [8_100_000_002n, ''], [8_100_000_003n, '   ']] as const) {
      await upsertVariant(s.schema.sql, { storeId: s.organics, productId: organicsProduct, shopifyVariantId: id, sku, title: 'Bar', barcode: '' });
    }
    const unmapped = await listUnmappedVariants(s.schema.sql, s.organics);
    assert.equal(unmapped.length, 3);
    assert.ok(unmapped.every((v) => v.sku === null && v.barcode === null));
  });

  it('rejects a SKU reused within one store, at the database', async () => {
    await assert.rejects(
      upsertVariant(s.schema.sql, { storeId: s.nur, productId: nurProduct, shopifyVariantId: 8_000_000_002n, sku: 'NBJ-SER-30', title: 'dup', barcode: null }),
      /variants_store_sku_key/,
    );
  });

  it('allows the same SKU in the other store', async () => {
    const result = await upsertVariant(s.schema.sql, { storeId: s.organics, productId: organicsProduct, shopifyVariantId: 8_000_000_009n, sku: 'NBJ-SER-30', title: 'same sku', barcode: null });
    assert.equal(result.action, 'inserted');
  });

  it('refuses a variant whose product belongs to the other store, at the database', async () => {
    await assert.rejects(
      upsertVariant(s.schema.sql, { storeId: s.organics, productId: nurProduct, shopifyVariantId: 8_000_000_010n, sku: null, title: 'wrong store', barcode: null }),
      /violates foreign key constraint/,
    );
  });

  it('enforces the composite uniques in SQL, not only in the repo', async () => {
    await assert.rejects(
      s.schema.sql`insert into products (store_id, shopify_product_id, title, status) values (${s.nur}, 7000000001, 'dup', 'active')`,
      /products_store_id_shopify_product_id_key/,
    );
    await assert.rejects(
      s.schema.sql`insert into variants (store_id, product_id, shopify_variant_id, title) values (${s.nur}, ${nurProduct}, 8000000001, 'dup')`,
      /variants_store_id_shopify_variant_id_key/,
    );
  });
});

describe('product_costs', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let variant: string;

  before(async () => {
    s = await migratedWithStores();
    const product = await upsertProduct(s.schema.sql, { storeId: s.nur, shopifyProductId: 1n, title: 'Serum', brand: null, status: 'active' });
    variant = (await upsertVariant(s.schema.sql, { storeId: s.nur, productId: product.id, shopifyVariantId: 1n, sku: 'SER', title: '30ml', barcode: null })).id;
    // Cost history: 800 from 1 May, 950 from 1 July, a same-day correction on 1 July to 900.
    for (const [rupees, from] of [['800', '2026-05-01'], ['950', '2026-07-01'], ['900', '2026-07-01']] as const) {
      await addProductCost(s.schema.sql, { variantId: variant, unitCost: fromRupeeString(rupees), effectiveFrom: from, source: 'import' });
    }
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('returns the cost in force at a date, not the latest', async () => {
    const cases: Array<[string, bigint | null]> = [
      ['2026-04-30 23:59:00', null],
      ['2026-05-01 00:00:00', 80_000n],
      ['2026-06-30 23:59:59', 80_000n],
      ['2026-07-01 00:00:00', 90_000n],
      ['2026-09-30 12:00:00', 90_000n],
    ];
    for (const [karachi, expected] of cases) {
      assert.equal(await costAt(s.schema.sql, variant, parsePostexLocal(karachi)), expected, karachi);
    }
  });

  it('uses the Karachi date: 20:00 UTC on 30 June is already 1 July in Karachi', async () => {
    assert.equal(await costAt(s.schema.sql, variant, new Date('2026-06-30T20:00:00Z')), 90_000n);
    assert.equal(await costAt(s.schema.sql, variant, new Date('2026-06-30T18:59:59Z')), 80_000n);
  });

  it('is append-only: costs cannot be edited or deleted', async () => {
    await assert.rejects(s.schema.sql`update product_costs set unit_cost_paisa = 1`, /append-only: UPDATE/);
    await assert.rejects(s.schema.sql`delete from product_costs`, /append-only: DELETE/);
  });

  it('rejects a negative cost and a malformed date', async () => {
    await assert.rejects(addProductCost(s.schema.sql, { variantId: variant, unitCost: fromRupeeString('-1'), effectiveFrom: '2026-08-01', source: 'manual' }), /check constraint/);
    await assert.rejects(addProductCost(s.schema.sql, { variantId: variant, unitCost: fromRupeeString('1'), effectiveFrom: '01/08/2026', source: 'manual' }), RangeError);
  });

  it('reads a variant back by its store and Shopify id', async () => {
    assert.equal((await findVariant(s.schema.sql, s.nur, 1n))?.id, variant);
    assert.equal(await findVariant(s.schema.sql, s.organics, 1n), null);
  });
});
