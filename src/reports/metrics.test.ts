import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { recomputeOrderState } from '../db/repos/order-state.js';
import { skipWithoutDb } from '../test/db.js';
import { addEvent, orderWithLines, parcel, variantsIn } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { deliverySuccess } from './delivery-success.js';
import { orderFunnel } from './order-funnel.js';
import { outcomeCounts } from './parcel-outcomes.js';
import { returnRate } from './return-rate.js';
import { returnRateBy } from './return-rate-by.js';
import { sales } from './sales.js';

/**
 * The dashboard's order and return figures, on one small September: what each counts, and that
 * they stay put when something happens to an order later (a return checked in, the order then
 * cancelled in Shopify). Data is synthetic.
 */
describe('dashboard order and return figures', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let account: string;
  let variant: string;
  const SEPT = { from: '2026-09-01', to: '2026-09-30' };
  const ids: Record<string, { orderId: string; shipmentId?: string }> = {};

  before(async () => {
    s = await migratedWithStores();
    [variant] = (await variantsIn(s.schema.sql, s.nur, 1)) as [string];
    const [row] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    account = row!.id;
    const placed = new Date('2026-09-05T06:00:00Z');
    const make = async (key: string, total: bigint, events: Array<[string, string]> | null, cancelledAt: Date | null = null) => {
      const orderId = await orderWithLines(s.schema.sql, { storeId: s.nur, number: `#M-${key}`, placedAt: placed, totalPaisa: total, lines: [{ variantId: variant, qty: 1 }] });
      if (cancelledAt) await s.schema.sql`update orders set cancelled_at = ${cancelledAt} where id = ${orderId}`;
      const shipmentId = events ? await parcel(s.schema.sql, { accountId: account, orderId, bookedAt: new Date('2026-09-06T08:00:00Z'), events }) : undefined;
      if (shipmentId) await s.schema.sql`update shipments set cod_amount_paisa = ${total.toString()} where id = ${shipmentId}`;
      await recomputeOrderState(s.schema.sql, orderId);
      ids[key] = { orderId, ...(shipmentId ? { shipmentId } : {}) };
    };
    await make('delivered', 300_000n, [['0005', '2026-09-08T10:00:00Z']]);
    // On its way back: the latest code is a movement after 0040.
    await make('returning', 200_000n, [['0013', '2026-09-08T10:00:00Z'], ['0040', '2026-09-09T10:00:00Z'], ['0037', '2026-09-10T10:00:00Z'], ['0032', '2026-09-11T10:00:00Z']]);
    await make('returned', 250_000n, [['0013', '2026-09-08T10:00:00Z'], ['0040', '2026-09-09T10:00:00Z'], ['0006', '2026-09-12T10:00:00Z']]);
    await make('in-flight', 150_000n, [['0001', '2026-09-07T10:00:00Z']]);
    // Cancelled before anything shipped.
    await make('cancelled', 400_000n, null, new Date('2026-09-05T09:00:00Z'));
    await make('placed', 100_000n, null);
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('Sales counts every order placed except those cancelled before shipping; those are counted apart', async () => {
    const figure = await sales(s.schema.sql, SEPT);
    assert.equal(figure.orders, 5);
    assert.equal(figure.total, 1_000_000n, '3,000 + 2,000 + 2,500 + 1,500 + 1,000 rupees');
    assert.deepEqual(figure.cancelled, { orders: 1, total: 400_000n });
  });

  it('a return counts from the moment PostEx starts it, whatever movement code came last; the rate and its counts agree', async () => {
    const counts = await outcomeCounts(s.schema.sql, SEPT);
    assert.deepEqual([counts.booked, counts.delivered, counts.returned, counts.returnedBack, counts.returning, counts.inFlight], [4, 1, 2, 1, 1, 1]);
    assert.equal(counts.returnedValue, '450000', 'the COD the two returned parcels were sent to collect');
    const rate = await returnRate(s.schema.sql, SEPT);
    assert.deepEqual([rate.count, rate.of], [2, 3]);
    assert.deepEqual((await deliverySuccess(s.schema.sql, SEPT)).success, { count: 1, of: 3, rate: 1 / 3 });
    const byMonth = await returnRateBy(s.schema.sql, SEPT, 'month');
    assert.deepEqual(byMonth.map((r) => [r.key, r.returned, r.of]), [['2026-09', 2, 3]], 'the breakdown adds up to the headline');
    const funnel = await orderFunnel(s.schema.sql, SEPT);
    assert.equal(funnel.returned, 2, 'the funnel counts returns the same way');
  });

  it('nothing moves when a returned order is later cancelled in Shopify, or its parcel arrives back', async () => {
    const before = { sales: await sales(s.schema.sql, SEPT), counts: await outcomeCounts(s.schema.sql, SEPT) };
    await s.schema.sql`update orders set cancelled_at = now() where id = ${ids['returned']!.orderId}`;
    await recomputeOrderState(s.schema.sql, ids['returned']!.orderId);
    await addEvent(s.schema.sql, ids['returning']!.shipmentId!, '0006', '2026-09-13T10:00:00Z');
    const after = { sales: await sales(s.schema.sql, SEPT), counts: await outcomeCounts(s.schema.sql, SEPT) };
    assert.deepEqual([after.sales.orders, after.sales.total, after.sales.cancelled.orders], [before.sales.orders, before.sales.total, 1]);
    assert.deepEqual([after.counts.returned, after.counts.returnedBack, after.counts.returning], [2, 2, 0], 'still two returns; both are back now');
  });
});
