import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';

import { getCursor } from '../db/repos/cursors.js';
import { listOpenReviewItems } from '../db/repos/review.js';
import type { Logger } from '../logger.js';
import { skipWithoutDb } from '../test/db.js';
import { type FakeShopify, fakeShopify, order } from '../test/shopify-fake.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { jobs } from './registry.js';
import { CATCHUP_JOB, catchUp } from './shopify-catchup.js';
import { ORDERS_JOB, SKIPPED_ORDER, type SyncDeps, syncOrders } from './shopify.js';

const silent = pino({ level: 'silent' }) as unknown as Logger;
const NOW = new Date('2026-10-01T12:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

const deps = (s: Stores, fake: FakeShopify): SyncDeps => ({
  sql: s.schema.sql,
  logger: silent,
  now: () => NOW,
  stores: [{ key: 'nur', id: s.nur, graphql: fake.graphql }],
});

const financialStatus = async (s: Stores, shopifyId: number) => {
  const [row] = await s.schema.sql<{ status: string }[]>`select financial_status as status from orders where shopify_order_id = ${shopifyId}`;
  return row?.status;
};

describe('shopify:catchup', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let fake: FakeShopify;

  before(async () => {
    s = await migratedWithStores();
    fake = fakeShopify({ orders: [order(1, minutesAgo(600)), order(2, minutesAgo(300)), order(3, minutesAgo(30))] });
    await syncOrders(deps(s, fake));
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('is registered to run every 15 minutes', () => {
    assert.equal(jobs.find((j) => j.name === CATCHUP_JOB)?.schedule.everyMs, 15 * 60 * 1000);
  });

  it('recovers a deliberately dropped webhook: an order changed in Shopify with no delivery', async () => {
    // Order 2 is paid in Shopify; the orders/updated webhook never arrives.
    const target = fake.orders.find((o) => o.name === '#2')!;
    target.displayFinancialStatus = 'PAID';
    target.updatedAt = minutesAgo(20);
    assert.equal(await financialStatus(s, 2), 'pending', 'before: our copy is stale');
    const cursorBefore = await getCursor(s.schema.sql, ORDERS_JOB, 'nur');

    const stats = await catchUp(deps(s, fake));

    assert.equal(await financialStatus(s, 2), 'paid');
    assert.equal(stats['nur.changed'], 1);
    assert.equal(await getCursor(s.schema.sql, ORDERS_JOB, 'nur'), cursorBefore, 'the catch-up leaves the cursor alone');
  });

  it('re-reads only the last two hours', async () => {
    const stats = await catchUp(deps(s, fake));
    assert.equal(stats['nur.fetched'], 2, 'orders 2 and 3; order 1 is ten hours old');
  });

  it('processes a webhook event that was stored but never processed', async () => {
    const target = fake.orders.find((o) => o.name === '#1')!;
    target.displayFinancialStatus = 'PAID';
    // Order 1 is outside the window, so only the stuck webhook can bring the change in.
    await s.schema.sql`
      insert into webhook_events (store_id, topic, shopify_event_id, payload, received_at)
      values (${s.nur}, 'orders/updated', 'evt-stuck', ${s.schema.sql.json({ id: 1, admin_graphql_api_id: 'gid://shopify/Order/1' })}, now() - interval '10 minutes')
    `;
    const stats = await catchUp(deps(s, fake));
    assert.equal(stats['webhooksRetried'], 1);
    assert.equal(await financialStatus(s, 1), 'paid');
    const [event] = await s.schema.sql<{ processed: boolean }[]>`select processed_at is not null as processed from webhook_events where shopify_event_id = 'evt-stuck'`;
    assert.equal(event?.processed, true);
  });

  it('leaves a just-received unprocessed event to its own processing', async () => {
    await s.schema.sql`
      insert into webhook_events (store_id, topic, shopify_event_id, payload)
      values (${s.nur}, 'orders/updated', 'evt-fresh', ${s.schema.sql.json({ id: 3 })})
    `;
    assert.equal((await catchUp(deps(s, fake)))['webhooksRetried'], 0);
  });

  it('retries a skipped order from the review queue and resolves it once it stores', async () => {
    // An order Shopify reports in USD cannot be stored: it is skipped and queued.
    fake.orders.push(order(4, minutesAgo(10), { totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } } }));
    await syncOrders(deps(s, fake));
    const queued = await listOpenReviewItems(s.schema.sql, SKIPPED_ORDER, s.nur);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.detail['orderNumber'], '#4');
    assert.match(String(queued[0]?.detail['error']), /USD/);

    // Fixed in Shopify, but with an old updatedAt, so only the retry (not the window) reaches it.
    const target = fake.orders.find((o) => o.name === '#4')!;
    target.totalPriceSet = { shopMoney: { amount: '1250.00', currencyCode: 'PKR' } };
    target.updatedAt = minutesAgo(1_000);
    const stats = await catchUp(deps(s, fake));

    assert.equal(stats['retry.retried'], 1);
    assert.equal(stats['retry.recovered'], 1);
    assert.deepEqual(await listOpenReviewItems(s.schema.sql, SKIPPED_ORDER, s.nur), []);
    const [stored] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from orders where shopify_order_id = 4`;
    assert.equal(stored?.n, 1);
  });

  it('closes a queued order that Shopify no longer has', async () => {
    fake.orders.push(order(5, minutesAgo(5), { totalPriceSet: { shopMoney: { amount: '1.00', currencyCode: 'USD' } } }));
    await syncOrders(deps(s, fake));
    assert.equal((await listOpenReviewItems(s.schema.sql, SKIPPED_ORDER, s.nur)).length, 1);
    fake.orders.splice(fake.orders.findIndex((o) => o.name === '#5'), 1);

    await catchUp(deps(s, fake));
    const [closed] = await s.schema.sql<{ status: string; note: string }[]>`
      select status, note from reconciliation_items where kind = ${SKIPPED_ORDER} and detail->>'orderNumber' = '#5'
    `;
    assert.deepEqual(closed, { status: 'resolved', note: 'Order no longer exists in Shopify' });
  });
});
