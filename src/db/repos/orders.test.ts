import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { type Paisa, fromRupeeString } from '../../lib/money.js';
import { skipWithoutDb } from '../../test/db.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';
import { addressFingerprint, customerKey, findCustomer, upsertAddress, upsertCustomer } from './customers.js';
import { type OrderInput, findOrder, findOrderByShopifyId, upsertOrder } from './orders.js';
import { tally } from './upsert.js';

const rs = (rupees: string): Paisa => fromRupeeString(rupees);

describe('customerKey', () => {
  it('prefers the Shopify id, then the phone, then the order', () => {
    assert.equal(customerKey({ shopifyCustomerId: 42n, phone: '03001234567', shopifyOrderId: 9n }), 'shopify:42');
    assert.equal(customerKey({ shopifyCustomerId: null, phone: '0300-1234567', shopifyOrderId: 9n }), 'phone:+923001234567');
    assert.equal(customerKey({ shopifyCustomerId: null, phone: '[masked]', shopifyOrderId: 9n }), 'order:9');
    assert.equal(customerKey({ shopifyCustomerId: null, phone: null, shopifyOrderId: null }), null);
  });

  it('fingerprints addresses ignoring case and spacing', () => {
    const a = { line1: 'House 1,  Street 2', line2: null, city: 'Lahore', province: 'Punjab', postal: null, country: 'PK' };
    assert.equal(addressFingerprint(a), addressFingerprint({ ...a, line1: ' house 1, street 2 ', city: 'LAHORE' }));
    assert.notEqual(addressFingerprint(a), addressFingerprint({ ...a, line1: 'House 2, Street 2' }));
  });
});

describe('customers and orders', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let customer: string;
  let address: string;

  before(async () => {
    s = await migratedWithStores();
  });

  after(async () => {
    await s?.schema.drop();
  });

  const order = (overrides: Partial<OrderInput> = {}): OrderInput => ({
    storeId: s.nur,
    shopifyOrderId: 5_000_000_001n,
    orderNumber: '#1001',
    placedAt: new Date('2026-06-24T06:00:00Z'),
    customerId: customer,
    shippingAddressId: address,
    financialStatus: 'pending',
    fulfillmentStatus: 'unfulfilled',
    subtotal: rs('2500'),
    discount: rs('0'),
    shipping: rs('250'),
    tax: rs('0'),
    total: rs('2750'),
    channel: 'online',
    cancelledAt: null,
    cancelReason: null,
    tags: ['COD'],
    discountCodes: [],
    source: 'api',
    raw: { id: 'gid://shopify/Order/5000000001', name: '#1001' },
    lines: [
      { lineKey: 'shopify:1', variantId: null, sku: 'NBJ-SER-30', title: 'Face Serum', qty: 1, unitPrice: rs('1500'), discount: rs('0'), total: rs('1500') },
      { lineKey: 'shopify:2', variantId: null, sku: 'NBJ-SOAP', title: 'Soap', qty: 2, unitPrice: rs('500'), discount: rs('0'), total: rs('1000') },
    ],
    ...overrides,
  });

  it('upserts a guest customer by phone, once, and normalises the phone', async () => {
    const input = { storeId: s.nur, shopifyCustomerId: null, name: 'Test Customer', phone: '0300 1234567', shopifyOrderId: 5_000_000_001n };
    const results = [await upsertCustomer(s.schema.sql, input), await upsertCustomer(s.schema.sql, input)];
    assert.deepEqual(results.map((r) => r && [r.action, r.changed]), [['inserted', true], ['updated', false]]);
    customer = results[0]!.id;
    const row = await findCustomer(s.schema.sql, customer);
    assert.equal(row?.phoneE164, '+923001234567');
    assert.equal(row?.externalKey, 'phone:+923001234567');
  });

  it('cannot key a customer with no Shopify id, phone or order', async () => {
    assert.equal(await upsertCustomer(s.schema.sql, { storeId: s.nur, shopifyCustomerId: null, name: 'x', phone: null, shopifyOrderId: null }), null);
  });

  it('stores an address once however many orders use it', async () => {
    const a = { line1: 'House 1', line2: null, city: 'Lahore', province: 'Punjab', postal: null, country: 'PK' };
    const first = await upsertAddress(s.schema.sql, customer, a);
    const again = await upsertAddress(s.schema.sql, customer, { ...a, city: ' lahore ' });
    assert.equal(first.action, 'inserted');
    assert.deepEqual([again.id, again.action, again.changed], [first.id, 'updated', false]);
    address = first.id;
  });

  it('upserting the same order twice: 1 insert, then 0 inserts and 1 update that changes nothing', async () => {
    const first = await upsertOrder(s.schema.sql, order());
    const second = await upsertOrder(s.schema.sql, order());

    assert.deepEqual(tally([first]), { inserted: 1, updated: 0, changed: 1 });
    assert.deepEqual(tally([second]), { inserted: 0, updated: 1, changed: 0 });
    assert.deepEqual(first.lines, { inserted: 2, updated: 0, changed: 2, removed: 0 });
    assert.deepEqual(second.lines, { inserted: 0, updated: 2, changed: 0, removed: 0 });
  });

  it('round-trips every money column exactly as Paisa', async () => {
    const stored = await findOrderByShopifyId(s.schema.sql, s.nur, 5_000_000_001n);
    assert.equal(stored?.total, 275_000n);
    assert.equal(stored?.shipping, 25_000n);
    assert.deepEqual(stored?.lines.map((l) => [l.lineKey, l.qty, l.total]), [['shopify:1', 1, 150_000n], ['shopify:2', 2, 100_000n]]);
    assert.equal(stored?.state, null, 'the upsert never sets state');
  });

  it('replaces lines: an edit that drops a line removes it and counts the change', async () => {
    const edited = order({ lines: [order().lines[0]!], subtotal: rs('1500'), total: rs('1750') });
    const result = await upsertOrder(s.schema.sql, edited);
    assert.deepEqual([result.action, result.changed], ['updated', true]);
    assert.deepEqual(result.lines, { inserted: 0, updated: 1, changed: 0, removed: 1 });
    const stored = await findOrderByShopifyId(s.schema.sql, s.nur, 5_000_000_001n);
    assert.deepEqual(stored?.lines.map((l) => l.lineKey), ['shopify:1']);
  });

  it('a change only in the lines still marks the order changed', async () => {
    const qtyEdit = order({ lines: [{ ...order().lines[0]!, qty: 3, total: rs('4500') }], subtotal: rs('1500'), total: rs('1750') });
    const result = await upsertOrder(s.schema.sql, qtyEdit);
    assert.equal(result.changed, true);
    assert.equal(result.lines.changed, 1);
  });

  it('keeps the same Shopify order id and number in two stores as two orders', async () => {
    const organicsCustomer = await upsertCustomer(s.schema.sql, { storeId: s.organics, shopifyCustomerId: 77n, name: 'B', phone: null, shopifyOrderId: null });
    const result = await upsertOrder(s.schema.sql, order({ storeId: s.organics, customerId: organicsCustomer!.id, shippingAddressId: null }));
    assert.equal(result.action, 'inserted');
  });

  it('refuses an order that points at the other store\'s customer, at the database', async () => {
    await assert.rejects(
      upsertOrder(s.schema.sql, order({ storeId: s.organics, shopifyOrderId: 5_000_000_002n, orderNumber: '#1002', shippingAddressId: null })),
      /violates foreign key constraint/,
    );
  });

  it('enforces the composite uniques in SQL, not only in the repo', async () => {
    const insert = (shopifyId: string, number: string) => s.schema.sql`
      insert into orders (store_id, shopify_order_id, order_number, placed_at, subtotal_paisa, total_paisa, channel)
      values (${s.nur}, ${shopifyId}, ${number}, now(), 0, 0, 'online')
    `;
    await assert.rejects(insert('5000000001', '#9999'), /orders_store_id_shopify_order_id_key/);
    await assert.rejects(insert('5000000999', '#1001'), /orders_store_id_order_number_key/);
  });

  it('keys a consignment sale, which has no Shopify id, by its order number', async () => {
    const consignment = order({
      shopifyOrderId: null,
      orderNumber: 'CONS-2026-07-01',
      channel: 'consignment',
      source: 'consignment',
      customerId: null,
      shippingAddressId: null,
      raw: null,
      lines: [{ lineKey: 'line:1', variantId: null, sku: 'NBJ-SOAP', title: 'Soap', qty: 12, unitPrice: rs('400'), discount: rs('0'), total: rs('4800') }],
    });
    const results = [await upsertOrder(s.schema.sql, consignment), await upsertOrder(s.schema.sql, consignment)];
    assert.deepEqual(results.map((r) => [r.action, r.changed]), [['inserted', true], ['updated', false]]);
    assert.equal((await findOrder(s.schema.sql, results[0]!.id))?.lines[0]?.qty, 12);
  });

  it('rejects inconsistent rows at the database', async () => {
    // Thunks, run one at a time: each attempt must fail on its own rule, not race the others.
    const cases: Array<[string, () => Promise<unknown>]> = [
      ['API order without a Shopify id', () => upsertOrder(s.schema.sql, order({ shopifyOrderId: null, orderNumber: '#5000' }))],
      ['consignment source on an online order', () => upsertOrder(s.schema.sql, order({ shopifyOrderId: null, orderNumber: 'C-1', source: 'consignment' }))],
      ['negative total', () => upsertOrder(s.schema.sql, order({ shopifyOrderId: 5_000_000_100n, orderNumber: '#5100', total: rs('-1') }))],
      ['unknown channel', () => upsertOrder(s.schema.sql, order({ shopifyOrderId: 5_000_000_101n, orderNumber: '#5101', channel: 'wholesale' as never }))],
    ];
    for (const [label, attempt] of cases) await assert.rejects(attempt(), /check constraint/, label);
  });

  it('rolls back the whole order when a line is invalid', async () => {
    const bad = order({
      shopifyOrderId: 5_000_000_200n,
      orderNumber: '#5200',
      lines: [order().lines[0]!, { ...order().lines[1]!, qty: -1 }],
    });
    await assert.rejects(upsertOrder(s.schema.sql, bad), /check constraint/);
    assert.equal(await findOrderByShopifyId(s.schema.sql, s.nur, 5_000_000_200n), null);
  });

  it('works inside a caller\'s transaction, rolling back with it', async () => {
    await assert.rejects(
      s.schema.sql.begin(async (tx) => {
        await upsertOrder(tx as never, order({ shopifyOrderId: 5_000_000_300n, orderNumber: '#5300' }));
        throw new Error('caller failed later');
      }),
      /caller failed later/,
    );
    assert.equal(await findOrderByShopifyId(s.schema.sql, s.nur, 5_000_000_300n), null);
  });

  it('keeps order_state_log append-only', async () => {
    const [row] = await s.schema.sql<{ id: string }[]>`select id from orders limit 1`;
    await s.schema.sql`insert into order_state_log (order_id, to_state, cause) values (${row!.id}, 'placed', 'test')`;
    await assert.rejects(s.schema.sql`update order_state_log set cause = 'x'`, /append-only/);
  });

  it('dedupes webhook events per store at the database', async () => {
    const insert = (storeId: string) =>
      s.schema.sql`insert into webhook_events (store_id, topic, shopify_event_id, payload) values (${storeId}, 'orders/create', 'evt-1', '{}')`;
    await insert(s.nur);
    await insert(s.organics);
    await assert.rejects(insert(s.nur), /webhook_events_store_id_shopify_event_id_key/);
  });
});
