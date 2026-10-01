import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../../app.js';
import { createSessionToken } from '../../auth/session.js';
import { config } from '../../config.js';
import { openReviewItem } from '../../db/repos/review.js';
import { locationId, reconcileShipmentStock } from '../../domain/stock.js';
import { skipWithoutDb } from '../../test/db.js';
import { orderWithLines, parcel, variantsIn } from '../../test/inventory.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';

/**
 * The reconciliation, stock and settings routes through the real app, signed in as the
 * environment's single user, against a scratch schema.
 */
describe('API: reconciliation queue, stock and settings', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let server: Server;
  let base: string;
  let token: string;
  let accountId: string;
  let variant: string;

  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const unmatchedItem = async (ref: string) => {
    const shipmentId = await parcel(s.schema.sql, { accountId, orderId: null, events: [['0005', '2026-09-03T10:00:00Z']] });
    await s.schema.sql`update shipments set order_ref_number = ${ref} where id = ${shipmentId}`;
    const id = await openReviewItem(s.schema.sql, {
      kind: 'unmatched_shipment',
      dedupeKey: `unmatched_shipment:${shipmentId}`,
      storeId: s.nur,
      shipmentId,
      detail: { reason: 'order_ref_not_found' },
    });
    return { shipmentId, itemId: id! };
  };

  before(async () => {
    s = await migratedWithStores();
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    accountId = account!.id;
    [variant] = (await variantsIn(s.schema.sql, s.nur, 1)) as [string];
    token = await createSessionToken({ email: config.auth.email, name: 'Owner', role: 'owner' });
    server = createApp({ sql: () => s.schema.sql, webhooks: () => null }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await s?.schema.drop();
  });

  it('refuses every route without a session', async () => {
    for (const [method, path] of [['GET', '/reconciliation/items'], ['GET', '/stock/returns-awaiting'], ['PUT', '/settings/matching']] as const) {
      assert.equal((await call(method, path, undefined, false)).status, 401, path);
    }
  });

  it('lists open items with order and tracking numbers, and no customer details', async () => {
    const { itemId } = await unmatchedItem('#4001');
    const { status, body } = await call('GET', '/reconciliation/items?kind=unmatched_shipment');
    assert.equal(status, 200);
    const item = (body['items'] as Array<Record<string, unknown>>).find((i) => i['id'] === itemId);
    assert.ok(item?.['trackingNumber']);
    assert.equal(item?.['storeKey'], 'nur');
    assert.doesNotMatch(JSON.stringify(body), /\+92|customer_phone|address/);
    assert.equal((await call('GET', '/reconciliation/items?limit=0')).status, 400);
  });

  it('resolves and ignores with a note, audits the user, and refuses a second decision', async () => {
    const a = await unmatchedItem('#4002');
    const b = await unmatchedItem('#4003');
    assert.equal((await call('POST', `/reconciliation/items/${a.itemId}/resolve`, {})).status, 400, 'a note is required');
    assert.equal((await call('POST', `/reconciliation/items/${a.itemId}/resolve`, { note: 'Sample parcel, no order' })).status, 200);
    assert.equal((await call('POST', `/reconciliation/items/${b.itemId}/ignore`, { note: 'Test booking' })).status, 200);
    assert.equal((await call('POST', `/reconciliation/items/${a.itemId}/ignore`, { note: 'again' })).status, 409);

    const audits = await s.schema.sql<{ action: string; email: string }[]>`
      select a.action, u.email from audit_log a join users u on u.id = a.actor_id
      where a.entity = 'reconciliation_items' and a.entity_id in (${a.itemId}, ${b.itemId}) order by a.id
    `;
    assert.deepEqual(audits.map((r) => [r.action, r.email]), [['review.resolve', config.auth.email], ['review.ignore', config.auth.email]]);
  });

  it('links a parcel to an order: the shipment, the item, stock, order state and audit change together', async () => {
    const { shipmentId, itemId } = await unmatchedItem('#40O4');
    const orderId = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#4004', placedAt: new Date('2026-09-01T05:00:00Z'), lines: [{ variantId: variant, qty: 2 }] });

    const candidates = await call('GET', `/reconciliation/items/${itemId}/candidates`);
    assert.ok((candidates.body['candidates'] as Array<{ orderNumber: string }>).some((c) => c.orderNumber === '#4004'));

    const { status, body } = await call('POST', `/reconciliation/items/${itemId}/link`, { orderNumber: '4004', note: 'Typo on the airway bill' });
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual([body['orderId'], body['closedItems'], body['stockMoves']], [orderId, 1, 2]);

    const [shipment] = await s.schema.sql`select order_id, match_method, stock_pending from shipments where id = ${shipmentId}`;
    assert.deepEqual(shipment, { order_id: orderId, match_method: 'manual', stock_pending: false });
    const [item] = await s.schema.sql`select status, note from reconciliation_items where id = ${itemId}`;
    assert.deepEqual(item, { status: 'resolved', note: 'Typo on the airway bill' });
    const [order] = await s.schema.sql`select state from orders where id = ${orderId}`;
    assert.equal(order?.['state'], 'delivered');
    const [audit] = await s.schema.sql`select after->>'orderNumber' as n from audit_log where action = 'shipment.link' and entity_id = ${shipmentId}`;
    assert.equal(audit?.['n'], '#4004');

    assert.equal((await call('POST', `/reconciliation/items/${itemId}/link`, { orderId })).status, 409, 'already linked');
  });

  it('a link that fails changes nothing: another brand\'s order is refused and the item stays open', async () => {
    const { shipmentId, itemId } = await unmatchedItem('#4005');
    const foreign = await orderWithLines(s.schema.sql, { storeId: s.organics, number: '#4005', placedAt: new Date('2026-09-01T05:00:00Z'), lines: [] });
    const { status } = await call('POST', `/reconciliation/items/${itemId}/link`, { orderId: foreign });
    assert.equal(status, 409);
    const [shipment] = await s.schema.sql`select order_id from shipments where id = ${shipmentId}`;
    assert.equal(shipment?.['order_id'], null);
    const [item] = await s.schema.sql`select status from reconciliation_items where id = ${itemId}`;
    assert.equal(item?.['status'], 'open');
    assert.equal((await call('POST', `/reconciliation/items/${itemId}/link`, { orderNumber: '#999999' })).status, 404);
  });

  it('returns alert, check-in, quants and an adjustment through the stock routes', async () => {
    const orderId = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#4100', placedAt: new Date('2026-09-01T05:00:00Z'), lines: [{ variantId: variant, qty: 1 }] });
    const returned = await parcel(s.schema.sql, { accountId, orderId, events: [['0040', '2026-09-03T09:00:00Z'], ['0006', '2026-09-06T09:00:00Z']] });
    await reconcileShipmentStock(s.schema.sql, returned);

    const awaiting = await call('GET', '/stock/returns-awaiting');
    assert.ok((awaiting.body['returns'] as Array<{ shipmentId: string }>).some((r) => r.shipmentId === returned));
    assert.equal((await call('POST', `/stock/returns/${returned}/check-in`, { outcome: 'lost' })).status, 400);
    assert.equal((await call('POST', `/stock/returns/${returned}/check-in`, { outcome: 'restocked' })).status, 200);
    assert.equal((await call('POST', `/stock/returns/${returned}/check-in`, { outcome: 'restocked' })).status, 409, 'once only');
    const after = await call('GET', '/stock/returns-awaiting');
    assert.ok(!(after.body['returns'] as Array<{ shipmentId: string }>).some((r) => r.shipmentId === returned));

    const warehouse = await locationId(s.schema.sql, 'warehouse');
    const quantity = async () => {
      const { body } = await call('GET', '/stock/quants?location=warehouse');
      return (body['quants'] as Array<{ variant_id: string; qty: number }>).find((q) => q.variant_id === variant)?.qty ?? 0;
    };
    const before = await quantity();
    const created = await call('POST', '/stock/adjustments', { locationId: warehouse, reason: 'opening_stock', lines: [{ variantId: variant, delta: 40 }] });
    assert.equal(created.status, 201);
    assert.equal(await quantity(), before + 40);
    const transit = await locationId(s.schema.sql, 'in_transit');
    assert.equal((await call('POST', '/stock/adjustments', { locationId: transit, reason: 'count', lines: [{ variantId: variant, delta: 1 }] })).status, 409);
    assert.equal((await call('POST', '/stock/adjustments', { locationId: warehouse, reason: 'count', lines: [{ variantId: variant, delta: 1.5 }] })).status, 400);
    const found = await call('GET', '/stock/variants?search=TEST');
    assert.ok((found.body['variants'] as Array<{ id: string }>).some((v) => v.id === variant));
  });

  it('stores the matching prefixes, normalised and audited, and the summary reports them', async () => {
    const put = await call('PUT', '/settings/matching', { refPrefixes: { nur: ['nbj'], organics: [] } });
    assert.equal(put.status, 200);
    assert.deepEqual((await call('GET', '/settings/matching')).body['matching'], { refPrefixes: { nur: ['NBJ'], organics: [] }, windowDays: 3 });
    assert.equal((await call('PUT', '/settings/matching', { refPrefixes: { nur: ['NBJ-1'] } })).status, 400);
    const [audit] = await s.schema.sql`select after from audit_log where action = 'settings.update' and entity_id = 'matching'`;
    assert.deepEqual(audit?.['after'], { refPrefixes: { nur: ['NBJ'], organics: [] }, windowDays: 3 });

    const summary = await call('GET', '/reconciliation/summary');
    assert.equal(summary.status, 200);
    assert.ok((summary.body['matching'] as Array<{ account: string }>).some((m) => m.account === 'nur'));
  });
});
