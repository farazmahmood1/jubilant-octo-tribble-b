import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { postShipmentAccounting } from '../domain/accounting.js';
import { reconcileShipmentStock } from '../domain/stock.js';
import { skipWithoutDb } from '../test/db.js';
import { orderWithLines, parcel, variantsIn } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { profitPerParcel, recentOrders } from './index.js';

describe('recent orders', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let account: string;
  let variant: string;

  const order = async (number: string, o: { day: string; store?: 'nur' | 'organics'; state: string; events?: Array<[string, string]>; channel?: 'online' | 'pr' }) => {
    const storeId = o.store === 'organics' ? s.organics : s.nur;
    const id = await orderWithLines(s.schema.sql, {
      storeId,
      number,
      placedAt: new Date(`${o.day}T05:00:00Z`),
      totalPaisa: 250_000n,
      lines: [{ variantId: variant, qty: 2 }],
      ...(o.channel ? { channel: o.channel } : {}),
    });
    await s.schema.sql`update orders set state = ${o.state} where id = ${id}`;
    if (o.events) {
      const shipmentId = await parcel(s.schema.sql, { accountId: account, orderId: id, events: o.events });
      await s.schema.sql`update shipments set cod_amount_paisa = 250000 where id = ${shipmentId}`;
      await reconcileShipmentStock(s.schema.sql, shipmentId);
      await postShipmentAccounting(s.schema.sql, shipmentId);
      return { id, shipmentId };
    }
    return { id, shipmentId: null };
  };

  let delivered: { id: string; shipmentId: string | null };

  before(async () => {
    s = await migratedWithStores();
    const [a] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    account = a!.id;
    [variant] = (await variantsIn(s.schema.sql, s.nur, 1)) as [string];
    await s.schema.sql`insert into product_costs (variant_id, unit_cost_paisa, effective_from, source) values (${variant}, '40000', '2026-01-01', 'manual')`;
    delivered = await order('#1', { day: '2026-09-01', state: 'delivered', events: [['0005', '2026-09-03T10:00:00Z']] });
    await order('#2', { day: '2026-09-02', state: 'in_transit', events: [['0008', '2026-09-03T10:00:00Z']] });
    await order('#3', { day: '2026-09-03', state: 'placed' });
    await order('#4', { day: '2026-09-04', state: 'pr', channel: 'pr' });
    // The other brand, to see the brand filter leave it out.
    await order('#5', { day: '2026-09-05', state: 'placed', store: 'organics' });
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('lists the newest online orders first, never a PR package, as many as asked for', async () => {
    const rows = await recentOrders(s.schema.sql, {}, { limit: 3 });
    assert.deepEqual(rows.map((r) => r.orderNumber), ['#5', '#3', '#2']);
    assert.deepEqual(await recentOrders(s.schema.sql, { store: 'nur' }, { limit: 10 }).then((r) => r.map((x) => x.orderNumber)), ['#3', '#2', '#1']);
  });

  it('gives a delivered order the profit the profit-per-parcel report gives its parcel, and no profit before that', async () => {
    const rows = await recentOrders(s.schema.sql, { store: 'nur' }, { limit: 10 });
    const report = (await profitPerParcel(s.schema.sql, {})).rows.find((r) => r.shipmentId === delivered.shipmentId);
    assert.ok(report, 'the delivered parcel has ledger lines');
    assert.equal(rows.find((r) => r.orderNumber === '#1')!.profit, report.profit.toString());
    // In transit and not yet booked: the journal holds half the picture, so there is no number.
    assert.equal(rows.find((r) => r.orderNumber === '#2')!.profit, null);
    assert.equal(rows.find((r) => r.orderNumber === '#3')!.profit, null);
  });

  it('describes the order, and leaves customers out for a role that may not see them', async () => {
    const [row] = await recentOrders(s.schema.sql, { store: 'nur' }, { limit: 1 });
    assert.equal(row!.units, 2);
    assert.equal(row!.otherProducts, 0);
    assert.equal(row!.totalPaisa, '250000');
    assert.equal(row!.parcelId, null);
    const [hidden] = await recentOrders(s.schema.sql, { store: 'nur' }, { limit: 1, customers: false });
    assert.equal(hidden!.customerName, null);
  });
});
