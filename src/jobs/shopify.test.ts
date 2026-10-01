import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';

import { getCursor } from '../db/repos/cursors.js';
import type { Logger } from '../logger.js';
import { skipWithoutDb } from '../test/db.js';
import { line, order, product, variant, fakeShopify, type FakeShopify } from '../test/shopify-fake.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { jobs } from './registry.js';
import { JobRunner } from './runner.js';
import { CATALOGUE_JOB, CURSOR_OVERLAP_MS, ORDERS_JOB, type SyncDeps, configuredStores, syncCatalogue, syncOrders } from './shopify.js';

const silent = pino({ level: 'silent' }) as unknown as Logger;
const NOW = new Date('2026-10-01T00:00:00Z');

const deps = (s: Stores, nur: FakeShopify, organics?: FakeShopify, extra: Partial<SyncDeps> = {}): SyncDeps => ({
  sql: s.schema.sql,
  logger: silent,
  now: () => NOW,
  stores: [
    { key: 'nur', id: s.nur, graphql: nur.graphql },
    ...(organics ? [{ key: 'organics', id: s.organics, graphql: organics.graphql }] : []),
  ],
  ...extra,
});

const count = async (s: Stores, table: 'orders' | 'products' | 'variants' | 'order_lines' | 'customers', storeId?: string) => {
  const [row] = storeId
    ? await s.schema.sql<{ n: number }[]>`select count(*)::int as n from ${s.schema.sql(table)} where store_id = ${storeId}`
    : await s.schema.sql<{ n: number }[]>`select count(*)::int as n from ${s.schema.sql(table)}`;
  return row?.n ?? 0;
};

describe('the job registry', () => {
  it('registers both Shopify jobs under the names the brief uses', () => {
    const names = jobs.map((j) => j.name);
    assert.ok(names.includes('shopify:catalogue') && names.includes('shopify:orders'));
  });
});

describe('shopify:catalogue', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let nur: FakeShopify;
  let organics: FakeShopify;

  before(async () => {
    s = await migratedWithStores();
    // 5 NUR products over 3 pages, one with 103 variants (past the first 100); Organics has no SKUs yet.
    const many = Array.from({ length: 103 }, (_, i) => variant(1000 + i, `NBJ-BIG-${i}`));
    nur = fakeShopify({
      products: [product(1, [variant(11, 'NBJ-1')]), product(2, many), product(3, [variant(31, 'NBJ-3')]), product(4, [variant(41, 'NBJ-4')]), product(5, [variant(51, null)])],
    });
    organics = fakeShopify({ products: [product(1, [variant(11, null), variant(12, null)]), product(6, [variant(61, '  ')])] });
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('syncs both stores, every page, and every variant past the first 100', async () => {
    const stats = await syncCatalogue(deps(s, nur, organics));
    assert.equal(stats['nur.fetched'], 5);
    assert.equal(stats['organics.fetched'], 2);
    assert.equal(stats['fetched'], 7);
    assert.equal(stats['inserted'], 7);
    assert.equal(stats['skipped'], 0);
    assert.equal(await count(s, 'products', s.nur), 5);
    assert.equal(await count(s, 'variants', s.nur), 1 + 103 + 1 + 1 + 1);
    assert.ok(nur.calls.some((c) => c.operation === 'ProductVariants'), 'the 101st variant came from the follow-up query');
  });

  it('reports the unmapped-SKU count per store instead of failing', async () => {
    const stats = await syncCatalogue(deps(s, nur, organics));
    assert.equal(stats['nur.unmappedSkus'], 1);
    assert.equal(stats['organics.unmappedSkus'], 3, 'a blank SKU counts as unmapped');
    assert.equal(stats['unmappedSkus'], 4);
  });

  it('a second run inserts zero rows and changes nothing', async () => {
    const stats = await syncCatalogue(deps(s, nur, organics));
    assert.equal(stats['inserted'], 0);
    assert.equal(stats['updated'], 7);
    assert.equal(stats['changed'], 0);
  });

  it('skips a variant whose SKU is already used in the store, and syncs the rest', async () => {
    nur.products.push(product(7, [variant(71, 'NBJ-1'), variant(72, 'NBJ-7')]));
    const stats = await syncCatalogue(deps(s, nur));
    assert.equal(stats['nur.skipped'], 1);
    assert.equal(stats['nur.inserted'], 1);
    const [row] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from variants where sku = 'NBJ-7'`;
    assert.equal(row?.n, 1);
  });

  it('marks a product and its variants deleted when Shopify no longer has them, and stops counting them as unmapped', async () => {
    const removed = nur.products.findIndex((p) => p.id === 'gid://shopify/Product/5');
    const [gone] = nur.products.splice(removed, 1);
    const stats = await syncCatalogue(deps(s, nur));
    assert.equal(stats['nur.deletedProducts'], 1);
    assert.equal(stats['nur.deletedVariants'], 1);
    assert.equal(stats['nur.unmappedSkus'], 0, 'product 5 held the only SKU-less NUR variant');
    const [row] = await s.schema.sql<{ deleted: boolean }[]>`select deleted_at is not null as deleted from products where store_id = ${s.nur} and shopify_product_id = 5`;
    assert.equal(row?.deleted, true, 'kept, but marked: order lines may refer to it');

    nur.products.push(gone!);
    const back = await syncCatalogue(deps(s, nur));
    assert.equal(back['nur.deletedProducts'], 0);
    const [again] = await s.schema.sql<{ deleted: boolean }[]>`select deleted_at is not null as deleted from products where store_id = ${s.nur} and shopify_product_id = 5`;
    assert.equal(again?.deleted, false, 'a product that comes back is live again');
  });

  it('marks nothing deleted when the scan is cut short', async () => {
    const controller = new AbortController();
    controller.abort();
    const stats = await syncCatalogue({ ...deps(s, nur), signal: controller.signal });
    assert.equal(stats['nur.deletedProducts'], undefined);
    const [row] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from products where store_id = ${s.nur} and deleted_at is not null`;
    assert.equal(row?.n, 0);
  });
});

describe("shopify:catalogue reads Shopify's cost per item and stock levels", { skip: skipWithoutDb }, () => {
  let s: Stores;
  let nur: FakeShopify;
  const variantId = async (shopifyId: number) =>
    (await s.schema.sql<{ id: string }[]>`select id from variants where shopify_variant_id = ${shopifyId}`)[0]!.id;
  const costs = async (shopifyId: number) =>
    (await s.schema.sql<{ cost: string; from: string; note: string | null }[]>`
      select unit_cost_paisa::text as cost, effective_from::text as from, note from product_costs where variant_id = ${await variantId(shopifyId)} order by id
    `).map((r) => [r.cost, r.from, r.note]);

  before(async () => {
    s = await migratedWithStores();
    nur = fakeShopify({ products: [product(1, [variant(11, 'NBJ-1'), variant(12, 'NBJ-2')]), product(2, [variant(21, 'NBJ-3')])] });
    nur.inventory.set(11, { cost: '450.00', onHand: 883, available: 76, committed: 807 });
    nur.inventory.set(12, { cost: null, onHand: 5, available: 5, committed: 0 });
    nur.inventory.set(21, { cost: '0.00', onHand: 0, available: 0, committed: 0 });
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('adds a first cost back to the start of the synced history, and keeps every level', async () => {
    const stats = await syncCatalogue(deps(s, nur));
    assert.deepEqual([stats['costsAdded'], stats['noCost']], [1, 2], 'an empty or zero cost is no cost');
    assert.deepEqual(await costs(11), [['45000', '2026-01-01', 'shopify:cost_per_item']]);
    const [level] = await s.schema.sql`select location_name, on_hand, available, committed from shopify_stock_levels where variant_id = ${await variantId(11)}`;
    assert.deepEqual(level, { location_name: 'Shop location', on_hand: 883, available: 76, committed: 807 });
  });

  it('a second run with the same costs adds no cost row; a changed cost takes effect today', async () => {
    await syncCatalogue(deps(s, nur));
    assert.equal((await costs(11)).length, 1);
    nur.inventory.set(11, { cost: '480.00', onHand: 880, available: 70, committed: 810 });
    const stats = await syncCatalogue(deps(s, nur));
    assert.equal(stats['costsChanged'], 1);
    assert.deepEqual(await costs(11), [['45000', '2026-01-01', 'shopify:cost_per_item'], ['48000', '2026-10-01', 'shopify:cost_per_item']]);
    const [level] = await s.schema.sql`select on_hand from shopify_stock_levels where variant_id = ${await variantId(11)}`;
    assert.equal(level?.['on_hand'], 880, 'levels are the latest reading');
  });

  it("does not take Shopify's first cost back over a cost a person already entered", async () => {
    await s.schema.sql`insert into product_costs (variant_id, unit_cost_paisa, effective_from, source) values (${await variantId(12)}, '30000', '2026-03-01', 'manual')`;
    nur.inventory.set(12, { cost: '310.00', onHand: 5, available: 5, committed: 0 });
    await syncCatalogue(deps(s, nur));
    assert.deepEqual(await costs(12), [['30000', '2026-03-01', null], ['31000', '2026-10-01', 'shopify:cost_per_item']]);
  });

  it('closes the cost_missing items a new cost answers, and marks the parcels that carried the variant for re-posting', async () => {
    const id = await variantId(21);
    await s.schema.sql`
      insert into reconciliation_items (kind, dedupe_key, detail) values
        ('cost_missing', ${`cost_missing:${id}:2026-09-01`}, ${s.schema.sql.json({ variantId: id, needCostOn: '2026-09-01' })})
    `;
    nur.inventory.set(21, { cost: '200.00', onHand: 0, available: 0, committed: 0 });
    await syncCatalogue(deps(s, nur));
    const [item] = await s.schema.sql`select status, note from reconciliation_items where dedupe_key = ${`cost_missing:${id}:2026-09-01`}`;
    assert.deepEqual(item, { status: 'resolved', note: 'Cost imported from Shopify, effective 2026-01-01' });
  });
});

describe('shopify:orders', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let nur: FakeShopify;
  let organics: FakeShopify;

  before(async () => {
    s = await migratedWithStores();
    // Hours apart, so the 10-minute overlap re-reads only the newest order on the next run.
    nur = fakeShopify({
      orders: [
        order(1001, '2026-09-20T01:00:00Z'),
        order(1002, '2026-09-20T03:00:00Z', { lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: Array.from({ length: 101 }, (_, i) => line(20_000 + i, null, 1, '10.00')) } }),
        order(1003, '2026-09-20T05:00:00Z', { tags: ['PR'] }),
        order(1004, '2026-09-20T07:00:00Z', { note: 'Order has been shipped via PostEx with Tracking 20000000000462' }),
        order(1005, '2026-09-20T09:00:00Z'),
        order(900, '2026-07-01T09:00:00Z'), // older than 60 days before NOW: outside the window
      ],
    });
    organics = fakeShopify({ orders: [order(1001, '2026-09-21T10:00:00Z')] });
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('first run: reads the last 60 days of both stores, every page, and saves each cursor', async () => {
    const stats = await syncOrders(deps(s, nur, organics));
    assert.equal(stats['nur.fetched'], 5, 'the order from July is outside the 60-day window');
    assert.equal(stats['organics.fetched'], 1);
    assert.equal(stats['inserted'], 6);
    assert.equal(stats['skipped'], 0);
    assert.equal(await count(s, 'orders', s.nur), 5);
    assert.equal(await count(s, 'orders', s.organics), 1, 'the same order number in the other store is its own order');

    const firstQuery = nur.calls.find((c) => c.operation === 'Orders')?.variables['query'];
    assert.equal(firstQuery, "updated_at:>='2026-08-02T00:00:00.000Z'");
    assert.equal(await getCursor(s.schema.sql, ORDERS_JOB, 'nur'), '2026-09-20T09:00:00Z');
    assert.equal(await getCursor(s.schema.sql, ORDERS_JOB, 'organics'), '2026-09-21T10:00:00Z');
  });

  it('stores raw, every line (past the first 100), and PR from the PR tag', async () => {
    const [big] = await s.schema.sql<{ lines: number; has_raw: boolean }[]>`
      select (select count(*)::int from order_lines l where l.order_id = o.id) as lines, raw is not null as has_raw
      from orders o where store_id = ${s.nur} and order_number = '#1002'
    `;
    assert.deepEqual(big, { lines: 101, has_raw: true });
    const [pr] = await s.schema.sql<{ channel: string }[]>`select channel from orders where store_id = ${s.nur} and order_number = '#1003'`;
    assert.equal(pr?.channel, 'pr');
  });

  it('keeps the PostEx tracking number the booking app wrote in the note, and not the note itself', async () => {
    const rows = await s.schema.sql<{ order_number: string; tracking: string[] }[]>`
      select order_number, postex_tracking_numbers as tracking from orders where store_id = ${s.nur} and order_number in ('#1003', '#1004') order by order_number
    `;
    assert.deepEqual(rows.map((r) => [r.order_number, r.tracking]), [['#1003', []], ['#1004', ['20000000000462']]]);
    const [columns] = await s.schema.sql`select count(*)::int as n from information_schema.columns where table_schema = ${s.schema.name} and table_name = 'orders' and column_name = 'note'`;
    assert.equal(columns?.['n'], 0);
  });

  it('writes each stored order\'s derived state, and logs it once', async () => {
    const [unset] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from orders where state is null`;
    assert.equal(unset?.n, 0);
    const [pr] = await s.schema.sql<{ state: string }[]>`select state from orders where store_id = ${s.nur} and order_number = '#1003'`;
    assert.equal(pr?.state, 'pr');
    const [logs] = await s.schema.sql<{ orders: number; rows: number }[]>`select count(*)::int as rows, count(distinct order_id)::int as orders from order_state_log`;
    assert.equal(logs?.rows, logs?.orders);
  });

  it('a second run inserts zero rows: it re-reads only from the cursor, and changes nothing', async () => {
    const callsBefore = nur.calls.length;
    const stats = await syncOrders(deps(s, nur, organics));
    assert.equal(stats['inserted'], 0);
    assert.equal(stats['nur.fetched'], 1, 'only the order inside the 10-minute overlap');
    assert.equal(stats['changed'], 0);
    const query = nur.calls.slice(callsBefore).find((c) => c.operation === 'Orders')?.variables['query'];
    assert.equal(query, `updated_at:>='${new Date(Date.parse('2026-09-20T09:00:00Z') - CURSOR_OVERLAP_MS).toISOString()}'`);
  });

  it('picks up an order Shopify updated since, as one changed update', async () => {
    const edited = nur.orders.find((o) => o.name === '#1004')!;
    edited.updatedAt = '2026-09-22T12:00:00Z';
    edited.displayFinancialStatus = 'PAID';
    const stats = await syncOrders(deps(s, nur));
    assert.equal(stats['nur.inserted'], 0);
    assert.equal(stats['nur.changed'], 1);
    assert.equal(await getCursor(s.schema.sql, ORDERS_JOB, 'nur'), '2026-09-22T12:00:00Z');
  });

  it('counts lines whose variant is not in the catalogue as unmapped, and links those that are', async () => {
    await syncCatalogue(deps(s, fakeShopify({ products: [product(1, [variant(21, 'NBJ-21')])] })));
    nur.orders.push(order(1006, '2026-09-23T10:00:00Z', { lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [line(61, 21), line(62, 999)] } }));
    const stats = await syncOrders(deps(s, nur));
    assert.equal(stats['nur.unmappedLines'], 1);
    const lines = await s.schema.sql<{ line_key: string; linked: boolean }[]>`
      select line_key, variant_id is not null as linked from order_lines where line_key in ('shopify:61', 'shopify:62') order by line_key
    `;
    assert.deepEqual(lines.map((l) => [l.line_key, l.linked]), [['shopify:61', true], ['shopify:62', false]]);
  });

  it('skips an order it cannot map, and stores the others', async () => {
    nur.orders.push(
      order(1007, '2026-09-24T10:00:00Z', { totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } } }),
      order(1008, '2026-09-24T11:00:00Z'),
    );
    const stats = await syncOrders(deps(s, nur));
    assert.equal(stats['nur.skipped'], 1);
    assert.equal(stats['nur.inserted'], 1);
    const [item] = await s.schema.sql<{ kind: string; detail: Record<string, unknown> }[]>`
      select kind, detail from reconciliation_items where status = 'open'
    `;
    assert.equal(item?.kind, 'shopify_order_skipped');
    assert.equal(item?.detail['orderNumber'], '#1007');
    assert.doesNotMatch(JSON.stringify(item?.detail), /0300|Test Customer|House/, 'the queued item holds no customer data');
  });
});

describe('shopify:orders interrupted mid-run', { skip: skipWithoutDb }, () => {
  let s: Stores;

  before(async () => {
    s = await migratedWithStores();
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('resumes from the cursor after a failure, without duplicates', async () => {
    const nur = fakeShopify({
      orders: Array.from({ length: 6 }, (_, i) => order(2000 + i, `2026-09-2${i}T10:00:00Z`)),
    });
    // Pages of 2: page 1 is stored, the call for page 2 fails.
    nur.failOnce('Orders', 2);

    await assert.rejects(syncOrders(deps(s, nur)), /simulated network failure/);
    assert.equal(await count(s, 'orders'), 2);
    assert.equal(await getCursor(s.schema.sql, ORDERS_JOB, 'nur'), '2026-09-21T10:00:00Z');

    const resumed = await syncOrders(deps(s, nur));
    const resumeQuery = nur.calls.filter((c) => c.operation === 'Orders').at(-3)?.variables['query'];
    assert.equal(resumeQuery, `updated_at:>='${new Date(Date.parse('2026-09-21T10:00:00Z') - CURSOR_OVERLAP_MS).toISOString()}'`);
    assert.equal(resumed['inserted'], 4, 'the four orders the first run never reached');
    assert.equal(resumed['updated'], 1, 'the last stored order, re-read inside the overlap');
    assert.equal(await count(s, 'orders'), 6);
    const [dupes] = await s.schema.sql<{ n: number }[]>`
      select count(*)::int as n from (select shopify_order_id from orders group by store_id, shopify_order_id having count(*) > 1) d
    `;
    assert.equal(dupes?.n, 0);
  });

  it('stops between pages when the worker shuts down, keeping the cursor for next time', async () => {
    const s2 = await migratedWithStores();
    try {
      const nur = fakeShopify({ orders: Array.from({ length: 6 }, (_, i) => order(3000 + i, `2026-09-1${i}T10:00:00Z`)) });
      const controller = new AbortController();
      const original = nur.graphql;
      nur.graphql = (async (query: string, variables: Record<string, unknown>) => {
        const result = await original(query, variables);
        controller.abort();
        return result;
      }) as typeof nur.graphql;

      const stats = await syncOrders(deps(s2, nur, undefined, { signal: controller.signal }));
      assert.equal(stats['nur.fetched'], 2, 'one page, then stopped');
      assert.equal(await getCursor(s2.schema.sql, ORDERS_JOB, 'nur'), '2026-09-11T10:00:00Z');
    } finally {
      await s2.schema.drop();
    }
  });
});

describe('with no store credentials', { skip: skipWithoutDb }, () => {
  it('fails with the reason instead of succeeding with nothing synced', async (t) => {
    const s = await migratedWithStores();
    t.after(() => s.schema.drop());
    // Tests run without Shopify credentials, which is exactly the misconfigured case.
    await assert.rejects(configuredStores(s.schema.sql), /No Shopify store is ready to sync/);
  });
});

describe('through the job runner', { skip: skipWithoutDb }, () => {
  let s: Stores;

  before(async () => {
    s = await migratedWithStores();
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('records fetched, inserted, updated and skipped in sync_runs, and a failed run when Shopify fails', async () => {
    const nur = fakeShopify({ orders: [order(4001, '2026-09-25T10:00:00Z')], products: [product(1, [variant(1, null)])] });
    const runner = new JobRunner(s.schema.sql, silent)
      .register({ name: CATALOGUE_JOB, schedule: { everyMs: 60_000 }, handler: () => syncCatalogue(deps(s, nur)) })
      .register({ name: ORDERS_JOB, schedule: { everyMs: 60_000 }, handler: () => syncOrders(deps(s, nur)) });

    assert.equal((await runner.runJobOnce(CATALOGUE_JOB)).status, 'succeeded');
    const first = await runner.runJobOnce(ORDERS_JOB);
    const second = await runner.runJobOnce(ORDERS_JOB);
    for (const key of ['fetched', 'inserted', 'updated', 'skipped']) assert.ok(key in first.stats, key);
    assert.deepEqual([first.stats['inserted'], second.stats['inserted']], [1, 0]);

    nur.failOnce('Orders', 3);
    const failed = await runner.runJobOnce(ORDERS_JOB);
    assert.equal(failed.status, 'failed');
    const rows = await s.schema.sql<{ job: string; status: string }[]>`select job, status from sync_runs order by id`;
    assert.deepEqual(rows.map((r) => `${r.job}:${r.status}`), [
      'shopify:catalogue:succeeded',
      'shopify:orders:succeeded',
      'shopify:orders:succeeded',
      'shopify:orders:failed',
    ]);
  });
});
