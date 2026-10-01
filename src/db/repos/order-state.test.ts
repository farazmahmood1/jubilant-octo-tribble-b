import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';

import { syncPostex } from '../../jobs/postex.js';
import type { Logger } from '../../logger.js';
import { skipWithoutDb } from '../../test/db.js';
import { addEvent, orderWithLines, parcel } from '../../test/inventory.js';
import { SPIKE, fakePostex, syntheticParcels } from '../../test/postex-fake.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';
import { DEFAULT_CONFIRMATION_TAGS, confirmationFromTags, recomputeOrderState, tagWords } from './order-state.js';

describe('confirmation from the Shopify tags NUR by Juggun uses', () => {
  const read = (...tags: string[]) => confirmationFromTags(tags, DEFAULT_CONFIRMATION_TAGS);

  it('compares tags by their words: emoji, case and spacing do not matter', () => {
    assert.equal(tagWords('✅ Order Confirmed'), 'order confirmed');
    assert.equal(tagWords('⚠ NO WhatsApp'), 'no whatsapp');
    assert.equal(tagWords(' Order  Canceled! '), 'order canceled');
  });

  it('maps each tag the team uses to a desk outcome, decisions first', () => {
    assert.equal(read('✅ Order Confirmed', 'PostEx'), 'confirmed');
    assert.equal(read('❌ Order Canceled', 'Quoli Influenced Order'), 'cancelled');
    assert.equal(read('⚠ Confirmation Pending'), 'pending');
    assert.equal(read('didnt answer the call'), 'no_answer');
    assert.equal(read('call not attended'), 'no_answer');
    assert.equal(read('didnt confirm'), 'no_answer');
    assert.equal(read('number off'), 'unreachable');
    assert.equal(read('⚠ No Phone'), 'unreachable');
    assert.equal(read('⚠ NO WhatsApp'), 'unreachable');
    // A later decision wins over an earlier call outcome left on the order.
    assert.equal(read('didnt answer the call', '✅ Order Confirmed'), 'confirmed');
    assert.equal(read('✅ Order Confirmed', '❌ Order Canceled'), 'cancelled');
  });

  it('near misses: tags that say nothing about confirmation', () => {
    assert.equal(read('PostEx', 'Quoli Influenced Order', 'by call', 'location issue', 'releasit_cod_form'), null);
    assert.equal(read('Order Confirmed Later'), null, 'whole tag only, not a prefix');
  });
});

describe('orders.state written from the derived state', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let accountId: string;
  let n = 0;

  before(async () => {
    s = await migratedWithStores();
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    accountId = account!.id;
  });

  after(async () => {
    await s?.schema.drop();
  });

  const newOrder = async (tags: string[] = []) => {
    const id = await orderWithLines(s.schema.sql, { storeId: s.nur, number: `#77${n++}`, placedAt: new Date('2026-09-01T05:00:00Z'), lines: [] });
    await s.schema.sql`update orders set tags = ${tags}::text[] where id = ${id}`;
    return id;
  };
  const log = async (orderId: string) =>
    (await s.schema.sql<{ from_state: string | null; to_state: string }[]>`select from_state, to_state from order_state_log where order_id = ${orderId} order by id`).map(
      (r) => `${r.from_state ?? '∅'}→${r.to_state}`,
    );

  it('follows the order from placed through its parcel to delivered, logging each change once', async () => {
    const orderId = await newOrder();
    assert.equal((await recomputeOrderState(s.schema.sql, orderId)).to, 'placed');
    assert.equal((await recomputeOrderState(s.schema.sql, orderId)).changed, false, 'a second recompute writes nothing');

    await s.schema.sql`update orders set tags = ${['PostEx', '✅ Order Confirmed']}::text[] where id = ${orderId}`;
    assert.equal((await recomputeOrderState(s.schema.sql, orderId)).to, 'ready_to_book');
    const shipmentId = await parcel(s.schema.sql, { accountId, orderId, events: [['0013', '2026-09-02T09:00:00Z']] });
    assert.equal((await recomputeOrderState(s.schema.sql, orderId)).to, 'failed');
    await addEvent(s.schema.sql, shipmentId, '0005', '2026-09-03T09:00:00Z');
    await recomputeOrderState(s.schema.sql, orderId);

    const [row] = await s.schema.sql`select state from orders where id = ${orderId}`;
    assert.equal(row?.['state'], 'delivered');
    assert.deepEqual(await log(orderId), ['∅→placed', 'placed→ready_to_book', 'ready_to_book→failed', 'failed→delivered']);
  });

  it("reads the team's tags (S7), hold from Shopify's fulfillment status, and cancellation from Shopify", async () => {
    const held = await newOrder(['✅ Order Confirmed']);
    await s.schema.sql`update orders set fulfillment_status = 'on_hold' where id = ${held}`;
    assert.equal((await recomputeOrderState(s.schema.sql, held)).to, 'confirmed', 'confirmed but on hold: not ready to book');
    assert.equal((await recomputeOrderState(s.schema.sql, await newOrder(['❌ Order Canceled', 'Quoli Influenced Order']))).to, 'cancelled');
    const noAnswer = await newOrder(['didnt answer the call', 'PostEx']);
    assert.equal((await recomputeOrderState(s.schema.sql, noAnswer)).to, 'placed');
    const [logged] = await s.schema.sql`select cause from order_state_log where order_id = ${noAnswer}`;
    assert.equal(logged?.['cause'], 'Placed; confirmation is no answer');
    const cancelled = await newOrder();
    await s.schema.sql`update orders set cancelled_at = now() where id = ${cancelled}`;
    assert.equal((await recomputeOrderState(s.schema.sql, cancelled)).to, 'cancelled');
  });

  it('follows the most recently booked parcel when an order was sent twice', async () => {
    const orderId = await newOrder(['Order Confirmed']);
    await parcel(s.schema.sql, { accountId, orderId, bookedAt: new Date('2026-09-01T10:00:00Z'), events: [['0040', '2026-09-03T09:00:00Z'], ['0006', '2026-09-05T09:00:00Z']] });
    await parcel(s.schema.sql, { accountId, orderId, bookedAt: new Date('2026-09-06T10:00:00Z'), events: [['0005', '2026-09-08T09:00:00Z']] });
    assert.equal((await recomputeOrderState(s.schema.sql, orderId)).to, 'delivered');
  });

  it('postex:sync writes the state of every matched order; a re-run logs nothing new', async (t) => {
    const fresh = await migratedWithStores();
    t.after(() => fresh.schema.drop());
    const [account] = await fresh.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${fresh.nur}) returning id`;
    const spec = { ...SPIKE, total: 60, delivered: 40, returned: 12, forwardFeeRupees: 9_000, returnFeeRupees: 3_000 };
    const parcels = syntheticParcels(spec);
    for (const p of parcels) {
      await orderWithLines(fresh.schema.sql, { storeId: fresh.nur, number: String(p['orderRefNumber']), placedAt: new Date(`${String(p['transactionDate']).slice(0, 10)}T03:00:00Z`), lines: [] });
    }
    const deps = (now: Date) => ({ sql: fresh.schema.sql, logger: pino({ level: 'silent' }) as unknown as Logger, accounts: [{ key: 'nur', id: account!.id, source: fakePostex(parcels) }], now: () => now, historyFrom: '2026-05-01' });
    const first = await syncPostex(deps(new Date('2026-09-20T06:00:00Z')));
    assert.equal(first['orderStates'], spec.total);
    const states = await fresh.schema.sql<{ state: string; n: number }[]>`select state, count(*)::int as n from orders group by state order by state`;
    const counts = Object.fromEntries(states.map((r) => [r.state, r.n]));
    assert.equal(counts['delivered'], spec.delivered);
    assert.equal(counts['returned_received'], spec.returned);

    const logged = async () => (await fresh.schema.sql<{ n: number }[]>`select count(*)::int as n from order_state_log`)[0]!.n;
    const before = await logged();
    const second = await syncPostex(deps(new Date('2026-09-20T06:20:00Z')));
    assert.equal(second['orderStates'], 0);
    assert.equal(await logged(), before);
  });
});
