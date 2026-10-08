import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';

import { recomputeOrderState } from '../db/repos/order-state.js';
import { redactCustomer } from '../gdpr/redact.js';
import { scanReconciliation } from '../jobs/reconciliation.js';
import type { Logger } from '../logger.js';
import { skipWithoutDb } from '../test/db.js';
import { addEvent, orderWithLines, parcel, testUser, variantsIn } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { customerHistory, deskOrder, deskQueue } from './confirmation-desk.js';
import { type TagWriter, editOrderTags, orderTimeline } from './order-tags.js';

/** Made-up numbers in the +92 300 000 xxxx range; nothing here is customer data. */
const PHONE = '+923000000101';
const OTHER_PHONE = '+923000000202';

describe('Confirmations page', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let agent: string;
  let account: string;
  let organicsAccount: string;
  let variant: string;
  let n = 0;
  const logger = pino({ level: 'silent' }) as unknown as Logger;

  before(async () => {
    s = await migratedWithStores();
    agent = await testUser(s.schema.sql, 'agent.one@example.com');
    await s.schema.sql`update users set name = 'Agent One' where id = ${agent}`;
    const [a] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    const [b] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('organics', 'Organics', ${s.organics}) returning id`;
    account = a!.id;
    organicsAccount = b!.id;
    variant = (await variantsIn(s.schema.sql, s.nur, 1))[0]!;
  });

  after(async () => {
    await s?.schema.drop();
  });

  /** A new online order with the tags Shopify gave it, and its state recomputed as the sync does. */
  const newOrder = async (o: { store?: 'nur' | 'organics'; phone?: string; city?: string; placedAt?: Date; tags?: string[]; channel?: 'online' | 'pr' } = {}) => {
    const id = await orderWithLines(s.schema.sql, {
      storeId: o.store === 'organics' ? s.organics : s.nur,
      number: `#D${++n}`,
      placedAt: o.placedAt ?? new Date('2026-09-01T06:00:00Z'),
      phone: o.phone ?? PHONE,
      city: o.city ?? 'Lahore',
      channel: o.channel ?? 'online',
      lines: [{ variantId: variant, qty: 2 }],
    });
    if (o.tags) await s.schema.sql`update orders set tags = ${o.tags}::text[] where id = ${id}`;
    await recomputeOrderState(s.schema.sql, id);
    return id;
  };
  const book = async (orderId: string, events: Array<[string, string]> = [], organics = false) => {
    const id = await parcel(s.schema.sql, { accountId: organics ? organicsAccount : account, orderId, events });
    await recomputeOrderState(s.schema.sql, orderId);
    return id;
  };
  const tagsOf = async (orderId: string) => (await s.schema.sql<{ tags: string[] }[]>`select tags from orders where id = ${orderId}`)[0]!.tags;
  const orderState = async (orderId: string) => (await s.schema.sql<{ state: string }[]>`select state from orders where id = ${orderId}`)[0]!.state;
  const confirmation = async (orderId: string) =>
    (await s.schema.sql<{ state: string; source: string }[]>`select state, source from confirmations where order_id = ${orderId}`)[0]!;

  /** A Shopify that records what it was asked, and can be told to refuse. */
  const fakeShopify = () => {
    const calls: Array<{ store: string; id: string; add: string[]; remove: string[] }> = [];
    let refuse: string | null = null;
    const write: TagWriter = async (store, id, add, remove) => {
      if (refuse) throw new Error(refuse);
      calls.push({ store, id, add, remove });
    };
    return { calls, write, refuseWith: (message: string | null) => void (refuse = message) };
  };

  it('the queue: NEW is every order not booked with no status tag; other apps\' tags do not count', async () => {
    const fresh = await newOrder({ phone: '+923000000401' });
    const marketing = await newOrder({ phone: '+923000000402', tags: ['Quoli Influenced Order', '⚠ Subscription Required'] });
    const pending = await newOrder({ phone: '+923000000403', tags: ['⚠ Confirmation Pending'] });
    const noAnswer = await newOrder({ phone: '+923000000404', tags: ['didnt answer the call'] });
    const confirmed = await newOrder({ store: 'organics', phone: '+923000000405', tags: ['COD-Confirmed'] });
    const postexTagged = await newOrder({ phone: '+923000000406', tags: ['PostEx', '✅ Order Confirmed'] });
    const booked = await newOrder({ phone: '+923000000407' });
    await book(booked);
    const cancelledInShopify = await newOrder({ phone: '+923000000408' });
    await s.schema.sql`update orders set cancelled_at = now() where id = ${cancelledInShopify}`;

    const ids = async (f: Partial<Parameters<typeof deskQueue>[1]>) =>
      (await deskQueue(s.schema.sql, { view: 'new', page: 1, pageSize: 500, ...f })).rows.map((r) => r.orderId);

    const fresh_ = await ids({});
    assert.ok(fresh_.includes(fresh) && fresh_.includes(marketing), 'untagged, or tagged only by other apps');
    for (const id of [pending, noAnswer, confirmed, postexTagged, booked, cancelledInShopify]) assert.ok(!fresh_.includes(id));

    const all = await ids({ view: 'all' });
    assert.ok([fresh, marketing, pending, noAnswer, confirmed].every((id) => all.includes(id)));
    assert.ok(![postexTagged, booked, cancelledInShopify].some((id) => all.includes(id)), 'booked (parcel or PostEx tag) or cancelled: gone');

    assert.deepEqual(await ids({ view: 'all', tag: 'Didnt answer the call' }), [noAnswer], 'a tag filter, in any spelling');
    assert.deepEqual(await ids({ view: 'all', store: 'organics' }), [confirmed]);

    const row = (await deskQueue(s.schema.sql, { view: 'all', tag: 'didnt answer the call', page: 1, pageSize: 5 })).rows[0]!;
    assert.deepEqual(row.tags, ['didnt answer the call']);
    const page = await deskQueue(s.schema.sql, { view: 'all', page: 2, pageSize: 1 });
    assert.equal(page.rows.length, 1);
    assert.equal(page.total, all.length);
  });

  it('TAGS: added and removed in Shopify first, then here, audited, and the order state follows', async () => {
    const shopify = fakeShopify();
    const id = await newOrder({ phone: '+923000000501', tags: ['⚠ Confirmation Pending', 'Quoli Influenced Order'] });
    assert.equal(await orderState(id), 'placed');

    const result = await editOrderTags(s.schema.sql, { orderId: id, actorId: agent, add: ['order confirmed'], remove: ['Confirmation Pending'], write: shopify.write });
    assert.deepEqual([result.status, result.add, result.remove], ['written', ['✅ Order Confirmed'], ['⚠ Confirmation Pending']], 'Shopify\'s spelling, whatever was typed');
    assert.equal(shopify.calls.length, 1);
    assert.equal(shopify.calls[0]!.store, 'nur');
    assert.deepEqual(await tagsOf(id), ['Quoli Influenced Order', '✅ Order Confirmed'], 'other apps\' tags untouched');
    assert.deepEqual(await confirmation(id), { state: 'confirmed', source: 'shopify_tags' });
    assert.equal(await orderState(id), 'ready_to_book');

    const [audit] = await s.schema.sql<{ actor_id: string; after: Record<string, unknown> }[]>`
      select actor_id::text, after from audit_log where action = 'shopify.tags' and entity_id = ${id}
    `;
    assert.deepEqual([audit?.actor_id, audit?.after], [agent, { add: ['✅ Order Confirmed'], remove: ['⚠ Confirmation Pending'] }]);

    const again = await editOrderTags(s.schema.sql, { orderId: id, actorId: agent, add: ['✅ Order Confirmed'], remove: [], write: shopify.write });
    assert.equal(again.status, 'unchanged');
    assert.equal(shopify.calls.length, 1, 'nothing to say: Shopify is not called');
  });

  it('TAGS: refuses what is not a status tag, and a Shopify refusal changes nothing here', async () => {
    const shopify = fakeShopify();
    const id = await newOrder({ phone: '+923000000502', tags: ['Loox - Review Request Email'] });
    await assert.rejects(editOrderTags(s.schema.sql, { orderId: id, actorId: agent, add: ['VIP'], remove: [], write: shopify.write }), /not one of this store's status tags/);
    await assert.rejects(editOrderTags(s.schema.sql, { orderId: id, actorId: agent, add: [], remove: ['Loox - Review Request Email'], write: shopify.write }), /not a status tag/);
    await assert.rejects(editOrderTags(s.schema.sql, { orderId: id, actorId: agent, add: ['COD-Confirmed'], remove: [], write: shopify.write }), /not one of this store's/, 'an Organics tag on a NUR order');

    shopify.refuseWith('Access denied for tagsAdd field. Required access: `write_orders`');
    await assert.rejects(editOrderTags(s.schema.sql, { orderId: id, actorId: agent, add: ['number off'], remove: [], write: shopify.write }), /write_orders/);
    assert.deepEqual(await tagsOf(id), ['Loox - Review Request Email']);
    const [failed] = await s.schema.sql`select 1 from audit_log where action = 'shopify.tags.failed' and entity_id = ${id}`;
    assert.ok(failed, 'the refusal is audited');

    const pr = await newOrder({ phone: '+923000000503', channel: 'pr' });
    await assert.rejects(editOrderTags(s.schema.sql, { orderId: pr, actorId: agent, add: ['by call'], remove: [], write: shopify.write }), /pr order/);
  });

  it('TIMELINE: Shopify\'s events, as text, with the tag changes made here, newest first', async () => {
    const shopify = fakeShopify();
    const id = await newOrder({ phone: '+923000000504' });
    await editOrderTags(s.schema.sql, { orderId: id, actorId: agent, add: ['by call'], remove: [], write: shopify.write });
    const timeline = await orderTimeline(s.schema.sql, id, [
      { createdAt: '2026-09-01T06:00:00Z', action: 'placed', message: 'Customer placed this order on Online Store.', appTitle: null, attributeToApp: false },
      { createdAt: '2026-09-01T06:01:00Z', action: 'tax_finalization_capture_started', message: 'Order#X tax', appTitle: null, attributeToApp: false },
      { createdAt: '2026-09-01T09:00:00Z', action: 'note_created', message: 'PostEx added a note to <a href="https://x">#64670</a> &amp; more.', appTitle: 'PostEx', attributeToApp: true },
    ]);
    assert.deepEqual(
      timeline.map((e) => [e.source, e.who, e.text]),
      [
        ['platform', 'Agent One', 'Tags added by call'],
        ['shopify', 'PostEx', 'PostEx added a note to #64670 & more.'],
        ['shopify', null, 'Customer placed this order on Online Store.'],
      ],
    );
  });

  it('HISTORY by phone_e164 across both brands: delivered vs refused, and the return rate of the city', async () => {
    // The same customer on both brands, plus someone else in the same city.
    const delivered = await newOrder({ store: 'organics', phone: PHONE, city: 'Multan' });
    await book(delivered, [['0005', '2026-09-03T10:00:00Z']], true);
    const refused = await newOrder({ phone: PHONE, city: 'Multan' });
    await book(refused, [['0013', '2026-09-03T10:00:00Z'], ['0040', '2026-09-04T10:00:00Z'], ['0006', '2026-09-08T10:00:00Z']]);
    await newOrder({ phone: PHONE, city: 'Multan', tags: ['❌ Order Canceled'] });
    const neighbour = await newOrder({ phone: OTHER_PHONE, city: ' multan ' });
    await book(neighbour, [['0005', '2026-09-03T10:00:00Z']]);
    // Booked by hand in PostEx, with no Shopify order: still this customer's refusal, and Multan's.
    const byHand = await parcel(s.schema.sql, { accountId: account, orderId: null, events: [['0013', '2026-07-03T10:00:00Z'], ['0006', '2026-07-09T10:00:00Z']] });
    await s.schema.sql`update shipments set customer_phone = ${PHONE}, city = 'MULTAN' where id = ${byHand}`;
    const current = await newOrder({ phone: PHONE, city: 'Multan' });

    // Typed the local way: the lookup normalises it to +92… first.
    const history = (await customerHistory(s.schema.sql, '0300-0000101', { city: 'Multan', excludeOrderId: current }))!;
    assert.equal(history.phone, PHONE);
    assert.deepEqual(new Set(history.orders.map((o) => o.store)), new Set(['nur', 'organics']), 'both brands');
    assert.ok(!history.orders.some((o) => o.orderId === current || o.orderId === neighbour));
    assert.deepEqual([history.counts.delivered, history.counts.refused, history.counts.cancelled], [1, 2, 1]);
    assert.deepEqual(history.parcels.map((p) => [p.shipmentId, p.outcome]), [[byHand, 'refused']], 'the parcel with no order is listed');
    assert.equal(history.counts.parcelsWithoutOrder, 1);
    assert.equal(history.deliveryRate, 1 / 3);
    // Multan: the customer's delivered and two refused parcels, and the neighbour's delivered one.
    assert.deepEqual(history.city, { name: 'Multan', delivered: 2, returned: 2, returnRate: 0.5 });
    assert.equal(await customerHistory(s.schema.sql, '042-1234567'), null, 'a landline is not a key');

    const desk = (await deskOrder(s.schema.sql, current))!;
    assert.deepEqual([desk.phone, desk.whatsappUrl, desk.callUrl], [PHONE, 'https://wa.me/923000000101', `tel:${PHONE}`]);
    assert.ok(desk.statusTags.includes('didnt answer the call') && !desk.statusTags.includes('COD-Confirmed'), 'NUR\'s own tags');
    const queued = (await deskQueue(s.schema.sql, { view: 'new', search: '0300 0000101', page: 1, pageSize: 50 })).rows.find((r) => r.orderId === current)!;
    assert.deepEqual(queued.history, { delivered: 1, returned: 2 }, 'the queue row carries the same counts');
  });

  it('ALERTS from tags: confirmed but not booked after 24 hours, cleared by booking; cancelled but booked, cleared when PostEx cancels', async () => {
    const scan = (now: Date) => scanReconciliation({ sql: s.schema.sql, logger, now: () => now });
    const hours = (h: number) => new Date(Date.now() + h * 3_600_000);
    const open = async (kind: string, orderId: string) =>
      (await s.schema.sql<{ id: string; severity: string }[]>`
        select id, severity from reconciliation_items where kind = ${kind} and order_id = ${orderId} and status = 'open'
      `)[0];

    // Confirmed by a tag: dated by when the system first saw the order confirmed.
    const tagged = await newOrder({ phone: '+923000000603', placedAt: new Date(), tags: ['✅ Order Confirmed'] });
    await scan(hours(23));
    assert.equal(await open('confirmed_not_booked', tagged), undefined);
    await scan(hours(25));
    assert.ok(await open('confirmed_not_booked', tagged));
    await book(tagged);
    await scan(hours(26));
    assert.equal(await open('confirmed_not_booked', tagged), undefined, 'booking clears it');

    // On hold in Shopify: deliberately not booked, so no alert.
    const held = await newOrder({ phone: '+923000000602', placedAt: new Date(), tags: ['✅ Order Confirmed'] });
    await s.schema.sql`update orders set fulfillment_status = 'on_hold' where id = ${held}`;
    await recomputeOrderState(s.schema.sql, held);
    await scan(hours(48));
    assert.equal(await open('confirmed_not_booked', held), undefined);

    // Tagged cancelled after the parcel was booked.
    const late = await newOrder({ phone: '+923000000604', tags: ['✅ Order Confirmed'] });
    const parcelId = await book(late, [['0008', '2026-09-02T10:00:00Z']]);
    await editOrderTags(s.schema.sql, { orderId: late, actorId: agent, add: ['❌ Order Canceled'], remove: ['✅ Order Confirmed'], write: fakeShopify().write });
    await scan(hours(1));
    assert.equal((await open('cancelled_but_booked', late))?.severity, 'warning');
    await addEvent(s.schema.sql, parcelId, '0002', '2026-09-02T13:00:00Z');
    await scan(hours(2));
    assert.equal(await open('cancelled_but_booked', late), undefined, 'cancelled in PostEx too: nothing left to do');
  });

  it('GDPR redaction still clears what agents typed on the old desk\'s attempts', async () => {
    const id = await newOrder({ phone: '+923000000701' });
    const [cf] = await s.schema.sql<{ id: string }[]>`select id from confirmations where order_id = ${id}`;
    await s.schema.sql`
      insert into confirmation_attempts (confirmation_id, agent_id, channel, at, outcome, reason, note)
      values (${cf!.id}, ${agent}, 'call', '2026-09-01T07:00:00Z', 'changed', 'New address: House 1, Street 2', 'Deliver after 5pm')
    `;
    await redactCustomer(s.schema.sql, s.nur, { shopifyCustomerId: null, phone: '+923000000701', shopifyOrderIds: [] });
    const [row] = await s.schema.sql<{ reason: string | null; note: string | null; outcome: string }[]>`
      select reason, note, outcome from confirmation_attempts where confirmation_id = ${cf!.id}
    `;
    assert.deepEqual(row, { reason: null, note: null, outcome: 'changed' });
  });
});
