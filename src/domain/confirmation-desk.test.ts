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
import { DeskError, agentPerformance, customerHistory, deskOrder, deskQueue, recordAttempt } from './confirmation-desk.js';

/** Made-up numbers in the +92 300 000 xxxx range; nothing here is customer data. */
const PHONE = '+923000000101';
const OTHER_PHONE = '+923000000202';

describe('Confirmation Desk', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let agent: string;
  let second: string;
  let account: string;
  let organicsAccount: string;
  let variant: string;
  let n = 0;
  const logger = pino({ level: 'silent' }) as unknown as Logger;

  before(async () => {
    s = await migratedWithStores();
    agent = await testUser(s.schema.sql, 'agent.one@example.com');
    second = await testUser(s.schema.sql, 'agent.two@example.com');
    await s.schema.sql`update users set name = 'Agent One' where id = ${agent}`;
    await s.schema.sql`update users set name = 'Agent Two' where id = ${second}`;
    const [a] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    const [b] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('organics', 'Organics', ${s.organics}) returning id`;
    account = a!.id;
    organicsAccount = b!.id;
    variant = (await variantsIn(s.schema.sql, s.nur, 1))[0]!;
  });

  after(async () => {
    await s?.schema.drop();
  });

  /** A new online order, with its confirmation created as the Shopify sync creates it. */
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
  /** A parcel for an order, with history steps, and the order state recomputed as the sync does. */
  const book = async (orderId: string, events: Array<[string, string]> = [], organics = false) => {
    const id = await parcel(s.schema.sql, { accountId: organics ? organicsAccount : account, orderId, events });
    await recomputeOrderState(s.schema.sql, orderId);
    return id;
  };
  const confirmation = async (orderId: string) =>
    (await s.schema.sql<{ state: string; attempts: number; next_attempt_at: Date | null; source: string }[]>`
      select state, attempts, next_attempt_at, source from confirmations where order_id = ${orderId}
    `)[0]!;
  const orderState = async (orderId: string) => (await s.schema.sql<{ state: string }[]>`select state from orders where id = ${orderId}`)[0]!.state;
  const attempt = (orderId: string, outcome: Parameters<typeof recordAttempt>[1]['outcome'], at: string, extra: Partial<Parameters<typeof recordAttempt>[1]> = {}) =>
    recordAttempt(s.schema.sql, { orderId, agentId: agent, channel: outcome === 'rescheduled' ? null : 'call', outcome, at: new Date(at), ...extra });

  it('NO ANSWER reschedules on a controllable clock; the third unanswered attempt escalates to unreachable', async () => {
    const id = await newOrder({ phone: '+923000000301' });
    assert.deepEqual(await confirmation(id), { state: 'pending', attempts: 0, next_attempt_at: new Date('2026-09-01T06:00:00Z'), source: 'none' });

    const t0 = '2026-09-01T06:00:00Z';
    const first = await attempt(id, 'no_answer', t0);
    assert.deepEqual([first.confirmation.state, first.confirmation.attempts, first.orderState], ['no_answer', 1, 'placed']);
    assert.equal((await confirmation(id)).next_attempt_at?.toISOString(), '2026-09-01T07:00:00.000Z');

    // The queue's "due now" moves with the clock it is given.
    const due = async (now: string) => (await deskQueue(s.schema.sql, { dueOnly: true, page: 1, pageSize: 50, now: new Date(now) })).rows.map((r) => r.orderId);
    assert.ok(!(await due('2026-09-01T06:30:00Z')).includes(id), 'not due 30 minutes later');
    assert.ok((await due('2026-09-01T07:01:00Z')).includes(id), 'due after an hour');

    await attempt(id, 'no_answer', '2026-09-01T07:01:00Z');
    assert.equal((await confirmation(id)).next_attempt_at?.toISOString(), '2026-09-01T10:01:00.000Z', 'then three hours');
    const third = await attempt(id, 'no_answer', '2026-09-01T10:02:00Z');
    assert.deepEqual([third.confirmation.state, third.confirmation.attempts, third.confirmation.nextAttemptAt], ['unreachable', 3, null]);
    assert.deepEqual(await confirmation(id), { state: 'unreachable', attempts: 3, next_attempt_at: null, source: 'desk' });
    assert.ok(!(await due('2026-09-09T00:00:00Z')).includes(id), 'out of the open queue');
    const unreachable = await deskQueue(s.schema.sql, { states: ['unreachable'], page: 1, pageSize: 50, now: new Date('2026-09-02T00:00:00Z') });
    assert.ok(unreachable.rows.some((r) => r.orderId === id && r.outcomeReason === 'No answer after 3 attempts'));

    // A follow-up gives it one more try at the agent's time; it does not count as a contact.
    const follow = await attempt(id, 'rescheduled', '2026-09-02T05:00:00Z', { followUpAt: new Date('2026-09-02T09:00:00Z') });
    assert.deepEqual([follow.confirmation.state, follow.confirmation.attempts], ['no_answer', 3]);
  });

  it('a desk confirmation makes the order ready to book; a later cancellation cancels it; the order state follows', async () => {
    const id = await newOrder({ phone: '+923000000302' });
    const confirmed = await attempt(id, 'confirmed', '2026-09-01T06:10:00Z');
    assert.deepEqual([confirmed.confirmation.state, confirmed.orderState], ['confirmed', 'ready_to_book']);
    const cancelled = await attempt(id, 'cancelled', '2026-09-01T09:00:00Z', { reason: 'Ordered twice' });
    assert.deepEqual([cancelled.confirmation.state, cancelled.orderState], ['cancelled', 'cancelled']);
    const [log] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from order_state_log where order_id = ${id}`;
    assert.ok(log!.n >= 3, 'placed, ready to book, cancelled: every transition logged');
  });

  it('EVERY OUTCOME is audited with the agent who recorded it', async () => {
    const id = await newOrder({ phone: '+923000000303' });
    await attempt(id, 'no_answer', '2026-09-01T06:00:00Z');
    await attempt(id, 'callback', '2026-09-01T07:00:00Z', { followUpAt: new Date('2026-09-01T12:00:00Z'), agentId: second });
    await attempt(id, 'rescheduled', '2026-09-01T08:00:00Z', { followUpAt: new Date('2026-09-01T13:00:00Z') });
    await attempt(id, 'changed', '2026-09-01T12:05:00Z', { reason: 'One unit, not two', channel: 'whatsapp' });
    const rows = await s.schema.sql<{ action: string; actor_id: string; after: Record<string, unknown> }[]>`
      select action, actor_id, after from audit_log where entity = 'orders' and entity_id = ${id} order by id
    `;
    assert.deepEqual(
      rows.map((r) => [r.action, r.actor_id]),
      [['confirmation.no_answer', agent], ['confirmation.callback', second], ['confirmation.rescheduled', agent], ['confirmation.changed', agent]],
    );
    assert.deepEqual([rows[3]!.after['state'], rows[3]!.after['reason'], rows[3]!.after['channel']], ['changed', 'One unit, not two', 'whatsapp']);
    const attempts = await s.schema.sql<{ n: number }[]>`
      select count(*)::int as n from confirmation_attempts a join confirmations c on c.id = a.confirmation_id where c.order_id = ${id}
    `;
    assert.equal(attempts[0]!.n, rows.length, 'one audit row per attempt');
  });

  it('refuses nonsense, writing nothing: a no-answer after a decision, a PR order, a Shopify-cancelled order, a cancellation without a reason', async () => {
    const id = await newOrder({ phone: '+923000000304' });
    await attempt(id, 'confirmed', '2026-09-01T06:00:00Z');
    const before = (await s.schema.sql<{ n: number }[]>`select count(*)::int as n from audit_log`)[0]!.n;
    await assert.rejects(attempt(id, 'no_answer', '2026-09-01T07:00:00Z'), /already decided \(confirmed\)/);
    await assert.rejects(attempt(id, 'cancelled', '2026-09-01T07:00:00Z'), /Say why the customer cancelled/);
    await assert.rejects(attempt(id, 'callback', '2026-09-01T07:00:00Z'), /needs a time/);
    await assert.rejects(attempt(id, 'rescheduled', '2026-09-01T07:00:00Z', { followUpAt: new Date('2026-09-01T06:00:00Z') }), /must be in the future/);
    const pr = await newOrder({ channel: 'pr', phone: '+923000000305' });
    await assert.rejects(attempt(pr, 'confirmed', '2026-09-01T07:00:00Z'), /pr order is not confirmed by the desk/);
    const gone = await newOrder({ phone: '+923000000306' });
    await s.schema.sql`update orders set cancelled_at = now() where id = ${gone}`;
    await assert.rejects(attempt(gone, 'confirmed', '2026-09-01T07:00:00Z'), (e: unknown) => e instanceof DeskError && /cancelled in Shopify/.test(e.message));
    await assert.rejects(attempt('999999', 'confirmed', '2026-09-01T07:00:00Z'), (e: unknown) => e instanceof DeskError && e.status === 404);
    assert.equal((await s.schema.sql<{ n: number }[]>`select count(*)::int as n from audit_log`)[0]!.n, before);
    const [noRow] = await s.schema.sql`select 1 from confirmations where order_id = ${pr}`;
    assert.equal(noRow, undefined, 'PR orders have no confirmation');
  });

  it('HISTORY by phone_e164 across both brands: delivered vs refused, and the return rate of the city', async () => {
    // The same customer on both brands, plus someone else in the same city.
    const delivered = await newOrder({ store: 'organics', phone: PHONE, city: 'Multan' });
    await book(delivered, [['0005', '2026-09-03T10:00:00Z']], true);
    const refused = await newOrder({ phone: PHONE, city: 'Multan' });
    await book(refused, [['0013', '2026-09-03T10:00:00Z'], ['0040', '2026-09-04T10:00:00Z'], ['0006', '2026-09-08T10:00:00Z']]);
    const cancelled = await newOrder({ phone: PHONE, city: 'Multan' });
    await attempt(cancelled, 'cancelled', '2026-09-01T07:00:00Z', { reason: 'Changed mind' });
    const neighbour = await newOrder({ phone: OTHER_PHONE, city: ' multan ' });
    await book(neighbour, [['0005', '2026-09-03T10:00:00Z']]);
    const current = await newOrder({ phone: PHONE, city: 'Multan' });

    // Typed the local way: the lookup normalises it to +92… first.
    const history = (await customerHistory(s.schema.sql, '0300-0000101', { city: 'Multan', excludeOrderId: current }))!;
    assert.equal(history.phone, PHONE);
    assert.deepEqual(new Set(history.orders.map((o) => o.store)), new Set(['nur', 'organics']), 'both brands');
    assert.ok(!history.orders.some((o) => o.orderId === current || o.orderId === neighbour));
    assert.deepEqual([history.counts.delivered, history.counts.refused, history.counts.cancelled], [1, 1, 1]);
    assert.equal(history.deliveryRate, 0.5);
    // Multan: the customer's delivered and refused parcels, and the neighbour's delivered one.
    assert.deepEqual(history.city, { name: 'Multan', delivered: 2, returned: 1, returnRate: 1 / 3 });
    assert.equal(await customerHistory(s.schema.sql, '042-1234567'), null, 'a landline is not a key');

    const desk = (await deskOrder(s.schema.sql, current))!;
    assert.equal(desk.phone, PHONE);
    assert.match(String(desk.whatsappUrl), /^https:\/\/wa\.me\/923000000101\?text=/);
    assert.match(decodeURIComponent(String(desk.whatsappUrl).split('text=')[1]!), /order #D\d+ from NUR by Juggun: 2 × Item 0\. Total Rs 2,500, cash on delivery to Multan/);
    assert.equal(desk.callUrl, `tel:${PHONE}`);
    const queued = (await deskQueue(s.schema.sql, { search: '0300 0000101', page: 1, pageSize: 50, now: new Date('2026-09-10T00:00:00Z') })).rows.find((r) => r.orderId === current)!;
    assert.deepEqual(queued.history, { delivered: 1, returned: 1 }, 'the queue row carries the same counts');
  });

  it('the queue: open orders only, not booked, filtered by brand and search, paginated with a total', async () => {
    const now = new Date('2026-09-10T00:00:00Z');
    const a = await newOrder({ phone: '+923000000401' });
    const b = await newOrder({ store: 'organics', phone: '+923000000402' });
    const booked = await newOrder({ phone: '+923000000403' });
    await book(booked);
    const all = await deskQueue(s.schema.sql, { page: 1, pageSize: 500, now });
    const ids = all.rows.map((r) => r.orderId);
    assert.ok(ids.includes(a) && ids.includes(b));
    assert.ok(!ids.includes(booked), 'a booked order is not the desk\'s any more');
    assert.equal(all.total, all.rows.length);
    const organics = await deskQueue(s.schema.sql, { store: 'organics', page: 1, pageSize: 500, now });
    assert.ok(organics.rows.every((r) => r.store === 'organics') && organics.rows.some((r) => r.orderId === b));
    const page = await deskQueue(s.schema.sql, { page: 2, pageSize: 1, now });
    assert.equal(page.rows.length, 1);
    assert.equal(page.total, all.total);
    const [number] = await s.schema.sql<{ order_number: string }[]>`select order_number from orders where id = ${a}`;
    assert.deepEqual((await deskQueue(s.schema.sql, { search: number!.order_number, page: 1, pageSize: 5, now })).rows.map((r) => r.orderId), [a]);
  });

  it('agent performance: contacts, decisions, the confirmation rate, speed to first contact and what their confirmations became', async () => {
    const placed = new Date('2026-09-20T05:00:00Z');
    const good = await newOrder({ phone: '+923000000501', placedAt: placed });
    await attempt(good, 'confirmed', '2026-09-20T05:20:00Z', { agentId: second });
    await book(good, [['0005', '2026-09-22T10:00:00Z']]);
    const bad = await newOrder({ phone: '+923000000502', placedAt: placed });
    await attempt(bad, 'no_answer', '2026-09-20T05:40:00Z', { agentId: second });
    await attempt(bad, 'confirmed', '2026-09-20T07:00:00Z', { agentId: second });
    await book(bad, [['0013', '2026-09-22T10:00:00Z'], ['0040', '2026-09-23T10:00:00Z']]);
    const lost = await newOrder({ phone: '+923000000503', placedAt: placed });
    await attempt(lost, 'cancelled', '2026-09-20T06:00:00Z', { agentId: second, reason: 'Too expensive' });

    const [row] = (await agentPerformance(s.schema.sql, { from: '2026-09-20', to: '2026-09-20' })).filter((r) => r.agentId === second);
    assert.deepEqual(
      [row!.name, row!.contacts, row!.ordersWorked, row!.confirmed, row!.cancelled, row!.noAnswer],
      ['Agent Two', 4, 3, 2, 1, 1],
    );
    assert.equal(row!.confirmationRate, 2 / 3);
    // First contacts 20, 40 and 60 minutes after placing: the median is 40.
    assert.equal(row!.medianMinutesToFirstContact, 40);
    assert.deepEqual(row!.outcomes, { delivered: 1, returned: 1, returnRate: 0.5 });
    assert.deepEqual(await agentPerformance(s.schema.sql, { from: '2026-09-21', to: '2026-09-21' }), [], 'nothing on a day with no attempts');
  });

  it('ALERTS: confirmed but not booked after 24 hours, cleared by booking; cancelled but booked, cleared when PostEx cancels', async () => {
    const scan = (now: string) => scanReconciliation({ sql: s.schema.sql, logger, now: () => new Date(now) });
    const open = async (kind: string, orderId: string) =>
      (await s.schema.sql<{ id: string; detail: Record<string, unknown>; severity: string }[]>`
        select id, detail, severity from reconciliation_items where kind = ${kind} and order_id = ${orderId} and status = 'open'
      `)[0];

    const waiting = await newOrder({ phone: '+923000000601', placedAt: new Date('2026-09-25T05:00:00Z') });
    await attempt(waiting, 'confirmed', '2026-09-25T06:00:00Z');
    await scan('2026-09-26T05:59:00Z');
    assert.equal(await open('confirmed_not_booked', waiting), undefined, '23 hours 59 minutes: not yet');
    await scan('2026-09-26T06:00:00Z');
    const item = await open('confirmed_not_booked', waiting);
    assert.deepEqual([item?.detail['hoursWaiting'], item?.detail['confirmedAt']], [24, '2026-09-25T06:00:00.000Z']);
    await book(waiting);
    await scan('2026-09-26T07:00:00Z');
    assert.equal(await open('confirmed_not_booked', waiting), undefined, 'booking clears it');
    const [closed] = await s.schema.sql`select status, resolved_by from reconciliation_items where kind = 'confirmed_not_booked' and order_id = ${waiting}`;
    assert.deepEqual([closed?.['status'], closed?.['resolved_by']], ['resolved', null]);

    // On hold in Shopify: deliberately not booked, so no alert.
    const held = await newOrder({ phone: '+923000000602', placedAt: new Date('2026-09-25T05:00:00Z') });
    await s.schema.sql`update orders set fulfillment_status = 'on_hold' where id = ${held}`;
    await attempt(held, 'confirmed', '2026-09-25T06:00:00Z');
    await scan('2026-09-27T06:00:00Z');
    assert.equal(await open('confirmed_not_booked', held), undefined);

    // Confirmed by a Shopify tag (S7): dated by when the system first saw the order confirmed.
    const tagged = await newOrder({ phone: '+923000000603', placedAt: new Date(), tags: ['✅ Order Confirmed'] });
    assert.equal((await confirmation(tagged)).source, 'shopify_tags');
    await scan(new Date(Date.now() + 23 * 3_600_000).toISOString());
    assert.equal(await open('confirmed_not_booked', tagged), undefined);
    await scan(new Date(Date.now() + 25 * 3_600_000).toISOString());
    assert.ok(await open('confirmed_not_booked', tagged));

    // Cancelled at the desk after the parcel was booked.
    const late = await newOrder({ phone: '+923000000604' });
    await attempt(late, 'confirmed', '2026-09-01T06:00:00Z');
    const parcelId = await book(late, [['0008', '2026-09-02T10:00:00Z']]);
    await attempt(late, 'cancelled', '2026-09-02T11:00:00Z', { reason: 'No longer needed' });
    await scan('2026-09-02T12:00:00Z');
    const cbb = await open('cancelled_but_booked', late);
    assert.deepEqual([cbb?.detail['cancelledBy'], cbb?.severity], ['desk', 'warning']);
    await addEvent(s.schema.sql, parcelId, '0002', '2026-09-02T13:00:00Z');
    await scan('2026-09-02T14:00:00Z');
    assert.equal(await open('cancelled_but_booked', late), undefined, 'cancelled in PostEx too: nothing left to do');

    // Cancelled in Shopify, delivered anyway: an error.
    const shopify = await newOrder({ phone: '+923000000605' });
    await book(shopify, [['0005', '2026-09-03T10:00:00Z']]);
    await s.schema.sql`update orders set cancelled_at = '2026-09-02T10:00:00Z' where id = ${shopify}`;
    await scan('2026-09-04T00:00:00Z');
    const delivered = await open('cancelled_but_booked', shopify);
    assert.deepEqual([delivered?.detail['cancelledBy'], delivered?.severity], ['shopify', 'error']);

    // Running the scan twice changes nothing.
    const count = async () => (await s.schema.sql<{ n: number }[]>`select count(*)::int as n from reconciliation_items`)[0]!.n;
    const before = await count();
    await scan('2026-09-04T00:00:00Z');
    assert.equal(await count(), before);
  });

  it('GDPR redaction clears what agents typed, and leaves the attempts', async () => {
    const id = await newOrder({ phone: '+923000000701' });
    await attempt(id, 'changed', '2026-09-01T06:00:00Z', { reason: 'New address: House 1, Street 2', note: 'Customer said deliver after 5pm' });
    await assert.rejects(s.schema.sql`update confirmation_attempts set outcome = 'confirmed'`, /append-only/);
    await assert.rejects(s.schema.sql`delete from confirmation_attempts`, /append-only/);
    await redactCustomer(s.schema.sql, s.nur, { shopifyCustomerId: null, phone: '+923000000701', shopifyOrderIds: [] });
    const [row] = await s.schema.sql<{ reason: string | null; note: string | null; outcome: string }[]>`
      select a.reason, a.note, a.outcome from confirmation_attempts a join confirmations c on c.id = a.confirmation_id where c.order_id = ${id}
    `;
    assert.deepEqual(row, { reason: null, note: null, outcome: 'changed' });
  });
});
