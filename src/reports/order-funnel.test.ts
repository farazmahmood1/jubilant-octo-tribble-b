import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { skipWithoutDb } from '../test/db.js';
import { orderWithLines, parcel } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { orderFunnel } from './index.js';

describe('order funnel', { skip: skipWithoutDb }, () => {
  let s: Stores;

  /** An order placed on `day` in the stored `state`, with a parcel when `booked`. */
  const order = async (key: string, o: { store?: 'nur' | 'organics'; day?: string; state: string; booked?: boolean; channel?: 'online' | 'pr' | 'consignment' }) => {
    const store = o.store === 'organics' ? s.organics : s.nur;
    const id = await orderWithLines(s.schema.sql, {
      storeId: store,
      number: `#${key}`,
      placedAt: new Date(`${o.day ?? '2026-09-10'}T05:00:00Z`),
      lines: [],
      channel: o.channel === 'pr' ? 'pr' : 'online',
    });
    await s.schema.sql`update orders set state = ${o.state} where id = ${id}`;
    if (o.channel === 'consignment') await s.schema.sql`update orders set channel = 'consignment', source = 'consignment', shopify_order_id = null where id = ${id}`;
    if (o.booked) {
      const [account] = await s.schema.sql<{ id: string }[]>`
        insert into postex_accounts (key, label, store_id) values (${`acc-${key}`}, ${key}, ${store}) returning id
      `;
      await parcel(s.schema.sql, { accountId: account!.id, orderId: id });
    }
  };

  before(async () => {
    s = await migratedWithStores();
    // Nine online orders, each one step further than the last, and two that fell out early.
    await order('placed', { state: 'placed' });
    await order('cancelled', { state: 'cancelled' });
    await order('confirmed', { state: 'confirmed' });
    await order('ready', { state: 'ready_to_book' });
    await order('booked', { state: 'booked', booked: true });
    await order('moving', { state: 'in_transit', booked: true });
    await order('failed', { state: 'failed', booked: true });
    await order('delivered', { state: 'delivered', booked: true, store: 'organics' });
    await order('returning', { state: 'returning', booked: true });
    await order('returned', { state: 'returned_received', booked: true });
    // A parcel PostEx cancelled was still booked; it never moved.
    await order('parcel-cancelled', { state: 'cancelled', booked: true });
    // Outside the cohort: another month, a PR package and a partner's consignment sale.
    await order('august', { state: 'delivered', booked: true, day: '2026-08-10' });
    await order('pr', { state: 'pr', channel: 'pr' });
    await order('consignment', { state: 'delivered', channel: 'consignment' });
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('counts how far each online order placed in the period got, each step a subset of the one before', async () => {
    const funnel = await orderFunnel(s.schema.sql, { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(funnel, {
      placed: 11,
      // Confirmed or ready to book, plus everything with a parcel (7: booked, moving, failed, delivered, returning, returned, parcel-cancelled).
      confirmed: 9,
      booked: 7,
      // Moving, failed, delivered, returning and returned: the cancelled parcel never moved.
      inTransit: 5,
      delivered: 1,
      // A parcel still on its way back is not returned yet.
      returned: 1,
    });
    assert.ok(funnel.placed >= funnel.confirmed && funnel.confirmed >= funnel.booked && funnel.booked >= funnel.inTransit);
    assert.ok(funnel.inTransit >= funnel.delivered + funnel.returned);
  });

  it('narrows to a brand and to the days orders were placed', async () => {
    assert.deepEqual(await orderFunnel(s.schema.sql, { from: '2026-09-01', to: '2026-09-30', store: 'organics' }), { placed: 1, confirmed: 1, booked: 1, inTransit: 1, delivered: 1, returned: 0 });
    assert.equal((await orderFunnel(s.schema.sql, { from: '2026-08-01', to: '2026-08-31' })).placed, 1);
    assert.equal((await orderFunnel(s.schema.sql, {})).placed, 12, 'no days: every online order, still not the PR or consignment ones');
    assert.deepEqual(await orderFunnel(s.schema.sql, { from: '2026-07-01', to: '2026-07-31' }), { placed: 0, confirmed: 0, booked: 0, inTransit: 0, delivered: 0, returned: 0 });
  });
});
