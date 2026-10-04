import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { postShipmentAccounting } from '../../domain/accounting.js';
import { reconcileShipmentStock } from '../../domain/stock.js';
import { profitPerParcel } from '../../reports/index.js';
import { skipWithoutDb } from '../../test/db.js';
import { orderWithLines, parcel, testUser, variantsIn } from '../../test/inventory.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';
import { orderDetail } from './order-detail.js';

describe('order detail', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let delivered: string;
  let shipmentId: string;
  let moving: string;

  const all = { contact: true, books: true };

  before(async () => {
    s = await migratedWithStores();
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    const [variant] = (await variantsIn(s.schema.sql, s.nur, 1)) as [string];
    await s.schema.sql`insert into product_costs (variant_id, unit_cost_paisa, effective_from, source) values (${variant}, '40000', '2026-01-01', 'manual')`;

    delivered = await orderWithLines(s.schema.sql, {
      storeId: s.nur,
      number: '#D1',
      placedAt: new Date('2026-09-01T05:00:00Z'),
      totalPaisa: 250_000n,
      city: 'Lahore',
      phone: '+923001234567',
      lines: [{ variantId: variant, qty: 2 }],
    });
    await s.schema.sql`update orders set state = 'delivered', discount_codes = '{GLOW10}', tags = '{vip}', financial_status = 'pending' where id = ${delivered}`;
    await s.schema.sql`update customers set name = 'Test Customer' where id = (select customer_id from orders where id = ${delivered})`;
    await s.schema.sql`update addresses set line1 = '12 Test Road', province = 'Punjab', postal = '54000' where id = (select shipping_address_id from orders where id = ${delivered})`;
    const [influencer] = await s.schema.sql<{ id: string }[]>`insert into influencers (handle, name) values ('test.creator', 'Test Creator') returning id`;
    await s.schema.sql`insert into influencer_codes (influencer_id, store_id, discount_code) values (${influencer!.id}, ${s.nur}, 'glow10')`;
    await s.schema.sql`insert into order_state_log (order_id, from_state, to_state, cause) values (${delivered}, null, 'placed', 'Placed; not yet confirmed'), (${delivered}, 'placed', 'delivered', 'Delivered')`;
    shipmentId = await parcel(s.schema.sql, { accountId: account!.id, orderId: delivered, events: [['0013', '2026-09-02T10:00:00Z'], ['0005', '2026-09-03T10:00:00Z']] });
    await s.schema.sql`update shipments set cod_amount_paisa = 250000 where id = ${shipmentId}`;
    await s.schema.sql`insert into shipment_charges (shipment_id, kind, amount_paisa) values (${shipmentId}, 'forward', 20000)`;
    await reconcileShipmentStock(s.schema.sql, shipmentId);
    await postShipmentAccounting(s.schema.sql, shipmentId);

    const agent = await testUser(s.schema.sql);
    const [cf] = await s.schema.sql<{ id: string }[]>`
      insert into confirmations (order_id, state, source, agent_id, attempts, confirmed_at, last_attempt_at)
      values (${delivered}, 'confirmed', 'desk', ${agent}, 1, '2026-09-01T07:00:00Z', '2026-09-01T07:00:00Z') returning id
    `;
    await s.schema.sql`insert into confirmation_attempts (confirmation_id, agent_id, channel, at, outcome, note) values (${cf!.id}, ${agent}, 'call', '2026-09-01T07:00:00Z', 'confirmed', 'Asked for evening delivery')`;

    moving = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#M1', placedAt: new Date('2026-09-02T05:00:00Z'), lines: [{ variantId: variant, qty: 1 }] });
    await s.schema.sql`update orders set state = 'in_transit' where id = ${moving}`;
    await parcel(s.schema.sql, { accountId: account!.id, orderId: moving, events: [['0008', '2026-09-03T10:00:00Z']] });
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('gives the whole order: items, money, customer, confirmation, parcel and history', async () => {
    const d = (await orderDetail(s.schema.sql, delivered, all))!;
    assert.equal(d.orderNumber, '#D1');
    assert.equal(d.store, 'nur');
    assert.equal(d.state, 'delivered');
    assert.deepEqual(d.tags, ['vip']);
    assert.deepEqual(d.discountCodes, ['GLOW10']);
    assert.equal(d.financialStatus, 'pending');
    assert.equal(d.money.totalPaisa, '250000');
    assert.equal(d.lines.length, 1);
    assert.equal(d.lines[0]!.qty, 2);
    assert.equal(d.customer.name, 'Test Customer');
    assert.equal(d.customer.phone, '+923001234567');
    assert.deepEqual(d.customer.address, { line1: '12 Test Road', line2: null, city: 'Lahore', province: 'Punjab', postal: '54000', country: null });
    assert.equal(d.confirmation?.state, 'confirmed');
    assert.equal(d.confirmation?.attempts, 1);
    assert.equal(d.attempts.length, 1);
    assert.equal(d.attempts[0]!.note, 'Asked for evening delivery');
    assert.equal(d.parcels.length, 1);
    assert.equal(d.parcels[0]!.stage, 'delivered');
    assert.equal(d.parcels[0]!.codPaisa, '250000');
    assert.equal(d.parcels[0]!.attempts, 1);
    assert.deepEqual(d.history.map((h) => [h.from, h.to]), [[null, 'placed'], ['placed', 'delivered']]);
  });

  it('attributes the order to the influencer whose code it used, in any case', async () => {
    const d = (await orderDetail(s.schema.sql, delivered, all))!;
    assert.deepEqual(d.influencer, { name: 'Test Creator', handle: 'test.creator' });
    assert.equal((await orderDetail(s.schema.sql, moving, all))!.influencer, null);
  });

  it('gives a delivered order the profit the profit-per-parcel report gives its parcel, with its charges', async () => {
    const d = (await orderDetail(s.schema.sql, delivered, all))!;
    const report = (await profitPerParcel(s.schema.sql, {})).rows.find((r) => r.shipmentId === shipmentId);
    assert.ok(report);
    assert.equal(d.profitPaisa, report.profit.toString());
    assert.deepEqual(d.parcels[0]!.charges, [{ kind: 'forward', amountPaisa: '20000' }]);
    assert.deepEqual(d.parcels[0]!.payouts, []);
  });

  it('keeps contact details from a caller who may not see them, and the books from one who may not read them', async () => {
    const d = (await orderDetail(s.schema.sql, delivered, { contact: false, books: false }))!;
    assert.equal(d.customer.phone, null);
    // The city and province say where; the street is a contact detail.
    assert.deepEqual(d.customer.address, { line1: null, line2: null, city: 'Lahore', province: 'Punjab', postal: null, country: null });
    assert.equal(d.customer.name, 'Test Customer');
    assert.equal(d.books, false);
    assert.equal(d.profitPaisa, null);
    assert.equal(d.parcels[0]!.charges, null);
    assert.equal(d.parcels[0]!.payouts, null);
  });

  it('gives no profit before the order is settled, and an order with nothing yet has empty lists, not errors', async () => {
    const d = (await orderDetail(s.schema.sql, moving, all))!;
    assert.equal(d.profitPaisa, null);
    assert.equal(d.confirmation, null);
    assert.deepEqual(d.attempts, []);
    assert.deepEqual(d.history, []);
    assert.equal(d.parcels[0]!.stage, 'in_transit');
  });

  it('is null for an order that does not exist', async () => {
    assert.equal(await orderDetail(s.schema.sql, '999999', all), null);
  });
});
