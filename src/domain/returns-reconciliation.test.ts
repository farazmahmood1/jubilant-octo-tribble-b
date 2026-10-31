import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';

import { returnsReconciliation } from '../db/repos/returns-reconciliation.js';
import { syncOrders } from '../jobs/shopify.js';
import type { Logger } from '../logger.js';
import { skipWithoutDb } from '../test/db.js';
import { parcel, testUser } from '../test/inventory.js';
import { fakeShopify, line, order } from '../test/shopify-fake.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { type ReturnFacts, returnIssues } from './returns-reconciliation.js';
import { syncCheckInToShopify } from './shopify-returns.js';
import { checkInReturn, reconcileShipmentStock } from './stock.js';

/**
 * The returns reconciliation: Shopify's refunds and returns imported with each order, once, and
 * every return compared across PostEx, the platform and Shopify. Data is synthetic.
 */

const silent = pino({ level: 'silent' }) as unknown as Logger;
const NOW = new Date('2026-10-20T00:00:00Z');
const money = (amount: string) => ({ shopMoney: { amount, currencyCode: 'PKR' } });

const facts = (over: Partial<ReturnFacts>): ReturnFacts => ({
  orderId: '1',
  orderNumber: '#1',
  store: 'nur',
  placedAt: new Date('2026-10-02T00:00:00Z'),
  beforeImport: false,
  shipmentId: '5',
  trackingNumber: 'T1',
  stage: 'returned',
  returnedAt: new Date('2026-10-10T00:00:00Z'),
  checkIn: null,
  checkedInAt: null,
  restock: null,
  shopify: { cancelled: false, financialStatus: 'pending', fulfillmentStatus: 'unfulfilled', returnStatus: 'NO_RETURN', refundedPaisa: '0', unitsRestocked: 0, unitsNotRestocked: 0, unitsReturned: 0, returns: [] },
  ...over,
});
const kinds = (f: ReturnFacts) => returnIssues(f, NOW).map((i) => `${i.kind}:${i.severity}`);

describe('returnIssues', () => {
  it('a parcel back for days and not checked in is flagged; one back today is not', () => {
    assert.ok(kinds(facts({})).includes('not_checked_in:warning'));
    assert.ok(!kinds(facts({ returnedAt: new Date('2026-10-19T12:00:00Z') })).includes('not_checked_in:warning'));
  });

  it('a PostEx return Shopify knows nothing about is only information until it is checked in, then the open order needs a decision', () => {
    assert.deepEqual(kinds(facts({ stage: 'returning', returnedAt: null })), ['shopify_order_still_open:info']);
    assert.deepEqual(kinds(facts({ checkIn: 'restocked', restock: { outcome: 'pending', message: 'still open', ahead: 0, notFound: false } })), ['shopify_order_still_open:warning']);
    assert.deepEqual(kinds(facts({ checkIn: 'restocked', restock: { outcome: 'done', message: 'added', ahead: 0, notFound: false } })), [], 'settled: nothing to say');
  });

  it('a Shopify return with no PostEx return is flagged, and only noted for an order placed before the PostEx history', () => {
    const delivered = facts({ stage: 'delivered', returnedAt: null, shopify: { ...facts({}).shopify!, unitsReturned: 1, returns: [{ name: '#1-R1', status: 'OPEN' }] } });
    assert.deepEqual(kinds(delivered), ['shopify_return_not_in_postex:warning']);
    assert.deepEqual(kinds({ ...delivered, shipmentId: null, stage: null, beforeImport: true }), ['shopify_return_not_in_postex:info']);
    assert.deepEqual(kinds({ ...delivered, shopify: { ...delivered.shopify!, unitsReturned: 0, returns: [{ name: '#1-R1', status: 'CANCELED' }] } }), [], 'a cancelled return request is no return');
  });

  it('an order Shopify no longer has, a restock Shopify refused, and Shopify ahead of the shelf are each named', () => {
    assert.deepEqual(kinds(facts({ checkIn: 'restocked', restock: { outcome: 'failed', message: 'not found', ahead: 0, notFound: true } })), ['shopify_order_missing:error']);
    assert.deepEqual(kinds(facts({ checkIn: 'restocked', restock: { outcome: 'failed', message: 'no permission', ahead: 0, notFound: false } })), ['shopify_stock_not_updated:warning']);
    assert.deepEqual(kinds(facts({ checkIn: 'damaged', restock: { outcome: 'skipped', message: '', ahead: 2, notFound: false } })), ['shopify_restocked_twice:error']);
  });

  it('a cancelled order whose parcel PostEx delivered is an error; one whose parcel is on its way back is fine', () => {
    const cancelled = { ...facts({}).shopify!, cancelled: true };
    assert.deepEqual(kinds(facts({ stage: 'delivered', returnedAt: null, shopify: cancelled })), ['cancelled_parcel_still_out:error']);
    assert.deepEqual(kinds(facts({ stage: 'returning', returnedAt: null, shopify: cancelled })), []);
  });
});

describe('Shopify refunds and returns, reconciled', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let account: string;
  let actor: string;

  before(async () => {
    s = await migratedWithStores();
    const [row] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    account = row!.id;
    actor = await testUser(s.schema.sql);
  });

  after(async () => {
    await s?.schema.drop();
  });

  // A cancelled order whose items Shopify restocked, and a delivered order the customer returned through Shopify.
  const cancelled = order(501, '2026-10-05T10:00:00Z', {
    cancelledAt: '2026-10-05T10:00:00Z',
    displayFinancialStatus: 'VOIDED',
    lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [line(5010, null, 2)] },
    refunds: [{ id: 'gid://shopify/Refund/9001', createdAt: '2026-10-05T10:00:00Z', totalRefundedSet: money('0.0'), refundLineItems: { nodes: [{ quantity: 2, restockType: 'CANCEL', restocked: true, lineItem: { id: 'gid://shopify/LineItem/5010' }, subtotalSet: money('2000.0') }] } }],
  });
  const returnedInShopify = order(502, '2026-10-06T10:00:00Z', {
    displayFulfillmentStatus: 'FULFILLED',
    returnStatus: 'IN_PROGRESS',
    totalRefundedSet: money('1000.0'),
    lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [line(5020, null, 1)] },
    refunds: [{ id: 'gid://shopify/Refund/9002', createdAt: '2026-10-07T10:00:00Z', totalRefundedSet: money('1000.0'), refundLineItems: { nodes: [{ quantity: 1, restockType: 'RETURN', restocked: true, lineItem: { id: 'gid://shopify/LineItem/5020' }, subtotalSet: money('1000.0') }] } }],
    returns: { nodes: [{ id: 'gid://shopify/Return/77', name: '#502-R1', status: 'OPEN', createdAt: '2026-10-07T09:00:00Z', closedAt: null, returnLineItems: { nodes: [{ quantity: 1, returnReason: 'DEFECTIVE', fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/5020' } } }] } }] },
  });

  it('imports refunds, their restock flags and returns with the order; syncing again duplicates nothing', async () => {
    const shop = fakeShopify({ orders: [cancelled, returnedInShopify] });
    const deps = { sql: s.schema.sql, logger: silent, now: () => NOW, stores: [{ key: 'nur', id: s.nur, graphql: shop.graphql }] };
    await syncOrders(deps, { since: new Date('2026-10-01T00:00:00Z') });
    await syncOrders(deps, { since: new Date('2026-10-01T00:00:00Z') });
    const refunds = await s.schema.sql<{ order_number: string; restock_type: string; restocked: boolean; qty: number }[]>`
      select o.order_number, rl.restock_type, rl.restocked, rl.qty from shopify_refunds r join shopify_refund_lines rl on rl.refund_id = r.id join orders o on o.id = r.order_id order by o.order_number
    `;
    assert.deepEqual(refunds.map((r) => [r.order_number, r.restock_type, r.restocked, r.qty]), [['#501', 'CANCEL', true, 2], ['#502', 'RETURN', true, 1]]);
    const [ret] = await s.schema.sql<{ status: string; lines: Array<{ qty: number; reason: string }> }[]>`select status, lines from shopify_returns`;
    assert.deepEqual([ret!.status, ret!.lines[0]!.qty, ret!.lines[0]!.reason], ['OPEN', 1, 'DEFECTIVE']);
    const [o] = await s.schema.sql<{ refunded_paisa: string; return_status: string }[]>`select refunded_paisa::text, return_status from orders where order_number = '#502'`;
    assert.deepEqual([o!.refunded_paisa, o!.return_status], ['100000', 'IN_PROGRESS']);
    const [total] = await s.schema.sql<{ n: number }[]>`select ((select count(*) from shopify_refunds) + (select count(*) from shopify_returns))::int as n`;
    assert.equal(total!.n, 3, 'two refunds and one return, however many times it syncs');
  });

  it('lists a Shopify return with no PostEx return, a PostEx return Shopify does not know, and a record Shopify no longer has', async () => {
    const [o502] = await s.schema.sql<{ id: string }[]>`select id from orders where order_number = '#502'`;
    await parcel(s.schema.sql, { accountId: account, orderId: o502!.id, events: [['0005', '2026-10-06T12:00:00Z']] });

    const [o501] = await s.schema.sql<{ id: string }[]>`select id from orders where order_number = '#501'`;
    const back = await parcel(s.schema.sql, { accountId: account, orderId: o501!.id, events: [['0013', '2026-10-06T09:00:00Z'], ['0040', '2026-10-07T09:00:00Z'], ['0032', '2026-10-08T09:00:00Z']] });
    await reconcileShipmentStock(s.schema.sql, back);
    const unknown = await parcel(s.schema.sql, { accountId: account, orderId: null, events: [['0040', '2026-10-07T09:00:00Z'], ['0006', '2026-10-09T09:00:00Z']] });

    const report = await returnsReconciliation(s.schema.sql, { onlyIssues: false }, NOW);
    const row = (pred: (r: (typeof report.rows)[number]) => boolean) => report.rows.find(pred);
    assert.deepEqual(row((r) => r.orderNumber === '#502')?.issues.map((i) => i.kind), ['shopify_return_not_in_postex'], 'Scenario A: returned in Shopify, delivered by PostEx');
    assert.equal(row((r) => r.shipmentId === back)?.stage, 'returning', 'a return on its way back is listed, whatever its latest code');
    assert.deepEqual(row((r) => r.shipmentId === unknown)?.issues.map((i) => i.kind), ['parcel_without_order', 'not_checked_in']);

    // Scenario B: a check-in whose order Shopify no longer has is kept, and named.
    await checkInReturn(s.schema.sql, back, 'restocked', actor);
    const [c] = await s.schema.sql<{ id: string }[]>`select id from return_check_ins where shipment_id = ${back}`;
    const gone = { order: async () => null, cancel: async () => {}, adjust: async () => {}, createReturn: async () => {}, dispose: async () => {}, closeReturn: async () => {} };
    await syncCheckInToShopify(s.schema.sql, { checkInId: c!.id, actorId: actor, gateway: gone });
    const after = await returnsReconciliation(s.schema.sql, {}, NOW);
    assert.deepEqual(after.rows.find((r) => r.shipmentId === back)?.issues.map((i) => i.kind), ['shopify_order_missing']);
    const [kept] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from orders where id = ${o501!.id}`;
    assert.equal(kept!.n, 1, 'nothing is deleted for being missing in Shopify');
    assert.ok(after.counts['shopify_order_missing']! >= 1);
  });
});
