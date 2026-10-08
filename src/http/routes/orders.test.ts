import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../../app.js';
import { createSessionToken } from '../../auth/session.js';
import { config } from '../../config.js';
import { skipWithoutDb } from '../../test/db.js';
import { orderWithLines, parcel, variantsIn } from '../../test/inventory.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';

/** The order read API through the real app. Numbers, phones and names are made up. */
describe('API: orders', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let server: Server;
  let base: string;
  let token: string;
  const id: Record<string, string> = {};

  const get = async (path: string, auth = true) => {
    const r = await fetch(`${base}/api/v1${path}`, { headers: auth ? { Authorization: `Bearer ${token}` } : {} });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const rows = async (query: string) => (await get(`/orders?${query}`)).body as { total: number; rows: Array<Record<string, unknown>> };
  const ids = async (query: string) => (await rows(query)).rows.map((r) => r['id']);

  before(async () => {
    s = await migratedWithStores();
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    const [variant] = await variantsIn(s.schema.sql, s.nur, 1);
    const lines = [{ variantId: variant!, qty: 2 }];
    id['delivered'] = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#O100', placedAt: new Date('2026-09-01T05:00:00Z'), phone: '+923000000111', city: 'Lahore', lines, totalPaisa: 500_000n });
    id['plain'] = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#O101', placedAt: new Date('2026-09-02T05:00:00Z'), city: ' karachi ', lines: [{ variantId: variant!, qty: 1 }] });
    id['organics'] = await orderWithLines(s.schema.sql, { storeId: s.organics, number: '#O200', placedAt: new Date('2026-09-05T05:00:00Z'), channel: 'pr', lines });
    await s.schema.sql`update customers set name = 'Test Customer' where phone_e164 = '+923000000111'`;
    await s.schema.sql`update orders set state = 'delivered', discount_codes = '{SAVE10}' where id = ${id['delivered']!}`;
    await s.schema.sql`update orders set state = 'placed', tags = '{"✅ Order Confirmed",PostEx}' where id = ${id['plain']!}`;
    const first = await parcel(s.schema.sql, { accountId: account!.id, orderId: id['delivered']!, events: [['0013', '2026-09-02T09:00:00Z']], bookedAt: new Date('2026-09-01T10:00:00Z') });
    id['second'] = await parcel(s.schema.sql, { accountId: account!.id, orderId: id['delivered']!, events: [['0005', '2026-09-04T12:00:00Z']], bookedAt: new Date('2026-09-02T10:00:00Z') });
    assert.ok(first);
    token = await createSessionToken({ email: config.auth.email, name: 'Owner', role: 'owner' });
    server = createApp({ sql: () => s.schema.sql, webhooks: () => null }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await s?.schema.drop();
  });

  it('refuses without a session', async () => {
    assert.equal((await get('/orders', false)).status, 401);
  });

  it('lists orders newest first with brand, customer, items, parcel count and the newest parcel', async () => {
    const all = await rows('');
    assert.equal(all.total, 3);
    assert.deepEqual(all.rows.map((r) => r['orderNumber']), ['#O200', '#O101', '#O100']);
    const o = all.rows.find((r) => r['id'] === id['delivered'])!;
    assert.deepEqual([o['store'], o['customerName'], o['city'], o['totalPaisa'], o['items'], o['state'], o['parcels']], ['nur', 'Test Customer', 'Lahore', '500000', 2, 'delivered', 2]);
    assert.deepEqual(o['discountCodes'], ['SAVE10']);
    const parcelOf = o['parcel'] as Record<string, unknown>;
    assert.deepEqual([parcelOf['id'], parcelOf['stage']], [id['second'], 'delivered'], 'the newest booking, in its own stage');
    const none = all.rows.find((r) => r['id'] === id['plain'])!;
    assert.deepEqual([none['parcels'], none['parcel'], none['phone']], [0, null, null]);
  });

  it('filters by state, brand, channel, flags, city, placing days and search, with a true total', async () => {
    assert.deepEqual(await ids('state=delivered'), [id['delivered']]);
    assert.deepEqual((await ids('state=delivered,placed')).sort(), [id['delivered'], id['plain']].sort());
    assert.equal((await rows('size=1')).total, 3, 'the total counts past the page');
    assert.deepEqual(await ids('store=organics'), [id['organics']]);
    assert.deepEqual(await ids('channel=pr'), [id['organics']]);
    assert.deepEqual((await ids('flag=no_parcel')).sort(), [id['plain'], id['organics']].sort());
    assert.deepEqual(await ids('flag=many_parcels'), [id['delivered']]);
    assert.deepEqual(await ids('flag=discounted'), [id['delivered']]);
    assert.deepEqual(await ids('city=Karachi'), [id['plain']], 'any spacing or case');
    assert.deepEqual(await ids('from=2026-09-02&to=2026-09-02'), [id['plain']]);
    assert.deepEqual(await ids('q=%23O100'), [id['delivered']], 'by order number');
    assert.deepEqual(await ids('q=test%20cust'), [id['delivered']], 'by customer name');
    assert.deepEqual(await ids('q=0300%200000111'), [id['delivered']], 'by phone, any shape');
    const tracking = String(((await rows('')).rows.find((r) => r['id'] === id['delivered'])!['parcel'] as Record<string, unknown>)['trackingNumber']);
    assert.deepEqual(await ids(`q=${tracking}`), [id['delivered']], 'by a parcel tracking number');
    assert.deepEqual(await ids('sort=total:desc&store=nur'), [id['delivered'], id['plain']]);
    assert.equal((await get('/orders?state=lost')).status, 400);
    const cities = (await get('/orders/cities')).body['cities'] as Array<{ city: string; orders: number }>;
    assert.equal(cities.length, 2);
  });

  it('shows each order its Shopify tags and filters by them, any case', async () => {
    const plain = (await rows('')).rows.find((r) => r['id'] === id['plain'])!;
    assert.deepEqual(plain['tags'], ['✅ Order Confirmed', 'PostEx']);
    assert.deepEqual(await ids('tag=postex'), [id['plain']]);
    assert.deepEqual(await ids('tag=nothing'), []);
    const tags = (await get('/orders/tags')).body['tags'] as Array<{ tag: string; orders: number }>;
    assert.deepEqual(tags.map((t) => [t.tag, t.orders]).sort(), [['PostEx', 1], ['✅ Order Confirmed', 1]].sort());
  });
});
