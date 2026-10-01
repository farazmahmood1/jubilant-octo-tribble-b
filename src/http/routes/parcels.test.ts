import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../../app.js';
import { createSessionToken } from '../../auth/session.js';
import { config } from '../../config.js';
import { skipWithoutDb } from '../../test/db.js';
import { orderWithLines, parcel, testUser, variantsIn } from '../../test/inventory.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';

/** The parcel read API through the real app. Tracking numbers, phones and names are made up. */
describe('API: parcels', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let server: Server;
  let base: string;
  let token: string;
  const id: Record<string, string> = {};

  const get = async (path: string, auth = true) => {
    const r = await fetch(`${base}/api/v1${path}`, { headers: auth ? { Authorization: `Bearer ${token}` } : {} });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const rows = async (query: string) => (await get(`/parcels?${query}`)).body as { total: number; rows: Array<Record<string, unknown>> };

  before(async () => {
    s = await migratedWithStores();
    const [nur] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    const [org] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('organics', 'Organics', ${s.organics}) returning id`;
    const [variant] = await variantsIn(s.schema.sql, s.nur, 1);
    const orderId = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#P100', placedAt: new Date('2026-09-01T05:00:00Z'), phone: '+923000000111', city: 'Lahore', lines: [{ variantId: variant!, qty: 2 }] });
    const make = async (key: string, account: string, order: string | null, events: Array<[string, string]>, extra: { city?: string; cod?: number; phone?: string; booked?: string } = {}) => {
      id[key] = await parcel(s.schema.sql, { accountId: account, orderId: order, events, bookedAt: new Date(extra.booked ?? '2026-09-01T10:00:00Z') });
      await s.schema.sql`update shipments set city = ${extra.city ?? 'Lahore'}, cod_amount_paisa = ${String((extra.cod ?? 2500) * 100)}, customer_phone = ${extra.phone ?? null} where id = ${id[key]!}`;
    };
    await make('delivered', nur!.id, orderId, [['0013', '2026-09-02T09:00:00Z'], ['0005', '2026-09-04T12:00:00Z']], { phone: '+923000000111' });
    await make('returned', nur!.id, null, [['0013', '2026-09-02T09:00:00Z'], ['0040', '2026-09-03T09:00:00Z'], ['0006', '2026-09-08T09:00:00Z']], { city: ' karachi ' });
    await make('unknown', org!.id, null, [['0099', '2026-09-02T09:00:00Z']], { cod: 0, city: 'Multan', booked: '2026-09-05T10:00:00Z' });
    await make('booked', org!.id, null, [], { booked: '2026-09-06T10:00:00Z' });
    await s.schema.sql`insert into shipment_charges (shipment_id, kind, amount_paisa) values (${id['delivered']!}, 'forward', 20000), (${id['delivered']!}, 'forward_tax', 3200)`;
    const [payout] = await s.schema.sql<{ id: string }[]>`insert into cod_payouts (postex_account_id, cpr_number, paid_at, amount_paisa) values (${nur!.id}, 'CPR-77', '2026-09-10T07:00:00Z', 226800) returning id`;
    await s.schema.sql`insert into payout_lines (cod_payout_id, shipment_id, amount_paisa) values (${payout!.id}, ${id['delivered']!}, 226800)`;
    const actor = await testUser(s.schema.sql);
    await s.schema.sql`insert into return_check_ins (shipment_id, outcome, actor_id, checked_in_at) values (${id['returned']!}, 'restocked', ${actor}, '2026-09-09T06:00:00Z')`;
    token = await createSessionToken({ email: config.auth.email, name: 'Owner', role: 'owner' });
    server = createApp({ sql: () => s.schema.sql, webhooks: () => null }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await s?.schema.drop();
  });

  it('refuses without a session', async () => {
    assert.equal((await get('/parcels', false)).status, 401);
    assert.equal((await get(`/parcels/${id['delivered']}`, false)).status, 401);
  });

  it('lists parcels with their stage, days in transit and brand; an unknown code is in transit', async () => {
    const all = await rows('');
    assert.equal(all.total, 4);
    const by = (key: string) => all.rows.find((r) => r['id'] === id[key])!;
    assert.deepEqual([by('delivered')['stage'], by('delivered')['daysInTransit'], by('delivered')['orderNumber'], by('delivered')['store']], ['delivered', 3, '#P100', 'nur']);
    assert.deepEqual([by('returned')['stage'], by('returned')['checkedIn']], ['returned', 'restocked']);
    assert.deepEqual([by('unknown')['stage'], by('unknown')['statusCode']], ['in_transit', '0099']);
    assert.equal(by('booked')['stage'], 'booked');
    assert.equal(all.rows[0]!['id'], id['booked'], 'newest booking first by default');
  });

  it('filters by stage, city (any spacing or case), brand, flags, booking days and search, with a true total', async () => {
    assert.deepEqual((await rows('stage=delivered,returned')).rows.map((r) => r['id']).sort(), [id['delivered'], id['returned']].sort());
    assert.equal((await rows('stage=delivered,returned&size=1')).total, 2, 'the total counts past the page');
    assert.deepEqual((await rows('city=Karachi')).rows.map((r) => r['id']), [id['returned']]);
    assert.deepEqual((await rows('store=organics&flag=zero_cod')).rows.map((r) => r['id']), [id['unknown']]);
    assert.deepEqual((await rows('flag=checked_in')).rows.map((r) => r['id']), [id['returned']]);
    assert.deepEqual((await rows('flag=unmatched&from=2026-09-05&to=2026-09-05')).rows.map((r) => r['id']), [id['unknown']]);
    assert.deepEqual((await rows('q=%23P100')).rows.map((r) => r['id']), [id['delivered']], 'by order number');
    assert.deepEqual((await rows('q=0300%200000111')).rows.map((r) => r['id']), [id['delivered']], 'by phone, any shape');
    const tracking = String((await rows('stage=booked')).rows[0]!['trackingNumber']);
    assert.deepEqual((await rows(`q=${tracking}`)).rows.map((r) => r['id']), [id['booked']]);
    assert.deepEqual((await rows('sort=days:desc&stage=delivered,returned')).rows.map((r) => r['id']), [id['returned'], id['delivered']], '7 days, then 3');
    assert.equal((await get('/parcels?stage=lost')).status, 400);
    const cities = (await get('/parcels/cities')).body['cities'] as Array<{ city: string; parcels: number }>;
    assert.deepEqual(cities[0], { city: 'Lahore', parcels: 2 });
  });

  it('one parcel: its timeline in order, the order beside it, its charges, payout and check-in', async () => {
    const { body } = await get(`/parcels/${id['delivered']}`);
    const p = body['parcel'] as Record<string, unknown>;
    assert.deepEqual((p['events'] as Array<{ code: string }>).map((e) => e.code), ['0013', '0005']);
    assert.deepEqual((p['charges'] as Array<{ kind: string; amountPaisa: string }>).map((c) => [c.kind, c.amountPaisa]), [['forward', '20000'], ['forward_tax', '3200']]);
    assert.deepEqual(p['payouts'], [{ cprNumber: 'CPR-77', paidAt: '2026-09-10T07:00:00.000Z', amountPaisa: '226800' }]);
    const order = p['order'] as Record<string, unknown>;
    assert.deepEqual([order['number'], (order['lines'] as unknown[]).length, order['city']], ['#P100', 1, 'Lahore']);
    assert.equal(p['customerPhone'], '+923000000111');
    const returned = (await get(`/parcels/${id['returned']}`)).body['parcel'] as Record<string, unknown>;
    assert.deepEqual([(returned['checkIn'] as Record<string, unknown>)['outcome'], returned['order']], ['restocked', null]);
    assert.equal((await get('/parcels/999999')).status, 404);
  });
});
