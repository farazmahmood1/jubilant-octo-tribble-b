import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';

import { createApp } from '../../app.js';
import { createSessionToken } from '../../auth/session.js';
import { config } from '../../config.js';
import { recomputeOrderState } from '../../db/repos/order-state.js';
import { scanReconciliation } from '../../jobs/reconciliation.js';
import type { Logger } from '../../logger.js';
import { skipWithoutDb } from '../../test/db.js';
import { orderWithLines, variantsIn } from '../../test/inventory.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';
import { type ShopifyGateway, withoutPhones } from './confirmations.js';

/** The Confirmations routes through the real app, against a scratch schema and a fake Shopify. Phones are made up. */
describe('API: Confirmations', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let server: Server;
  let base: string;
  let token: string;
  let orderId: string;
  const written: Array<{ store: string; add: string[]; remove: string[] }> = [];
  let refreshed = 0;
  let shopifyDown = false;

  const shopify: ShopifyGateway = {
    writeTags: async (store, _id, add, remove) => {
      if (shopifyDown) throw new Error('Shopify is unreachable');
      written.push({ store, add, remove });
    },
    events: async () => {
      if (shopifyDown) throw new Error('Shopify is unreachable');
      return [{ createdAt: '2026-09-01T06:00:00Z', action: 'placed', message: 'Customer placed this order on Online Store.', appTitle: null, attributeToApp: false }];
    },
    refreshOrder: async () => {
      if (shopifyDown) throw new Error('Shopify is unreachable');
    },
    refreshRecent: async () => {
      if (shopifyDown) throw new Error('Shopify is unreachable');
      refreshed++;
    },
  };

  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  before(async () => {
    s = await migratedWithStores();
    const [variant] = await variantsIn(s.schema.sql, s.nur, 1);
    orderId = await orderWithLines(s.schema.sql, {
      storeId: s.nur,
      number: '#5001',
      placedAt: new Date(Date.now() - 2 * 3_600_000),
      phone: '+923000000801',
      city: 'Lahore',
      lines: [{ variantId: variant!, qty: 1 }],
    });
    await recomputeOrderState(s.schema.sql, orderId);
    token = await createSessionToken({ email: config.auth.email, name: 'Owner', role: 'owner' });
    server = createApp({ sql: () => s.schema.sql, webhooks: () => null, confirmations: { shopify, writeTags: true } }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await s?.schema.drop();
  });

  it('refuses every route without a session', async () => {
    for (const path of ['/confirmations/queue', `/confirmations/orders/${orderId}`, '/confirmations/history?phone=03000000801', '/confirmations/alerts']) {
      assert.equal((await call('GET', path, undefined, false)).status, 401, path);
    }
    assert.equal((await call('PUT', `/confirmations/orders/${orderId}/tags`, { add: ['by call'] }, false)).status, 401);
    assert.equal((await call('POST', '/confirmations/refresh', {}, false)).status, 401);
  });

  it('serves the new orders with their tags, and one order with its history and Shopify timeline', async () => {
    const { status, body } = await call('GET', '/confirmations/queue?pageSize=10');
    assert.equal(status, 200);
    const rows = body['rows'] as Array<Record<string, unknown>>;
    assert.equal(body['total'], 1);
    assert.deepEqual([rows[0]!['orderNumber'], rows[0]!['tags'], rows[0]!['phone'], rows[0]!['whatsappUrl']], ['#5001', [], '+923000000801', 'https://wa.me/923000000801']);
    assert.equal((await call('GET', '/confirmations/queue?view=bogus')).status, 400);

    const one = await call('GET', `/confirmations/orders/${orderId}`);
    assert.equal((one.body['order'] as Record<string, unknown>)['orderNumber'], '#5001');
    assert.equal((one.body['history'] as Record<string, unknown>)['phone'], '+923000000801');
    assert.deepEqual((one.body['timeline'] as Array<Record<string, unknown>>).map((e) => e['text']), ['Customer placed this order on Online Store.']);
    assert.deepEqual(one.body['shopify'], { error: null, tagEditing: true });
    assert.equal((await call('GET', '/confirmations/orders/999999')).status, 404);
    assert.equal((await call('GET', '/confirmations/history?phone=not-a-number')).status, 400);
  });

  it('changes tags in Shopify as the signed-in user; the order leaves the new list', async () => {
    const saved = await call('PUT', `/confirmations/orders/${orderId}/tags`, { add: ['✅ Order Confirmed'] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body['tags'], ['✅ Order Confirmed']);
    assert.deepEqual(written, [{ store: 'nur', add: ['✅ Order Confirmed'], remove: [] }]);
    assert.equal(((await call('GET', '/confirmations/queue')).body['total']), 0, 'tagged: no longer new');
    assert.equal(((await call('GET', '/confirmations/queue?view=all&tag=Order%20Confirmed')).body['total']), 1);

    const [audit] = await s.schema.sql<{ email: string }[]>`
      select u.email from audit_log a join users u on u.id = a.actor_id where a.action = 'shopify.tags' and a.entity_id = ${orderId}
    `;
    assert.equal(audit?.email, config.auth.email.toLowerCase());

    assert.equal((await call('PUT', `/confirmations/orders/${orderId}/tags`, {})).status, 400, 'nothing named');
    assert.equal((await call('PUT', `/confirmations/orders/${orderId}/tags`, { add: ['VIP'] })).status, 400);
  });

  it('Shopify down: the change is refused with 502 and the order still opens, as last synced', async () => {
    shopifyDown = true;
    try {
      const refused = await call('PUT', `/confirmations/orders/${orderId}/tags`, { add: ['by call'] });
      assert.equal(refused.status, 502);
      const one = await call('GET', `/confirmations/orders/${orderId}`);
      assert.equal(one.status, 200);
      assert.match(String((one.body['shopify'] as Record<string, unknown>)['error']), /unreachable/);
      assert.equal((await call('POST', '/confirmations/refresh', {})).status, 502);
    } finally {
      shopifyDown = false;
    }
    assert.equal((await call('POST', '/confirmations/refresh', {})).status, 200);
    assert.equal(refreshed, 1);
  });

  it('lists the alerts the scan raised', async () => {
    await scanReconciliation({ sql: s.schema.sql, logger: pino({ level: 'silent' }) as unknown as Logger, now: () => new Date(Date.now() + 25 * 3_600_000) });
    const { body } = await call('GET', '/confirmations/alerts');
    const alerts = body['alerts'] as Array<Record<string, unknown>>;
    assert.deepEqual(alerts.map((a) => [a['kind'], a['orderId'], a['store']]), [['confirmed_not_booked', orderId, 'nur']]);
  });

  it('with tag writing switched off, a change is refused before Shopify is called', async () => {
    const off = createApp({ sql: () => s.schema.sql, webhooks: () => null, confirmations: { shopify, writeTags: false } }).listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${(off.address() as AddressInfo).port}/api/v1/confirmations/orders/${orderId}/tags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ add: ['by call'] }),
      });
      assert.equal(response.status, 409);
      assert.equal(written.length, 1);
    } finally {
      off.close();
    }
  });

  it('the accountant role gets no phone number or contact link (1.9)', () => {
    const row = { orderId: '1', phone: '+923000000801', whatsappUrl: 'https://wa.me/923000000801', callUrl: 'tel:+923000000801' };
    assert.deepEqual(withoutPhones(row, 'accountant'), { orderId: '1', phone: null, whatsappUrl: null, callUrl: null });
    assert.deepEqual(withoutPhones(row, 'agent'), row);
  });
});
