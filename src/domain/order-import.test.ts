import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { type OrderInput, upsertOrder } from '../db/repos/orders.js';
import { paisa } from '../lib/money.js';
import { skipWithoutDb } from '../test/db.js';
import { addEvent, parcel, testUser, variantsIn } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { commitOrderImport, dryRunOrderImport, parseExport, parseShopifyTime } from './order-import.js';

/** A Shopify order export in its own column names (a subset, in Shopify's order). Names, phones and addresses are made up. */
const HEADER =
  'Name,Email,Financial Status,Fulfillment Status,Subtotal,Shipping,Taxes,Total,Discount Code,Discount Amount,Created at,' +
  'Lineitem quantity,Lineitem name,Lineitem price,Lineitem sku,Shipping Name,Shipping Address1,Shipping City,Shipping Phone,Notes,Cancelled at,Id,Tags,Lineitem discount';

interface Row {
  name: string;
  id?: string;
  created?: string;
  total?: string;
  subtotal?: string;
  qty?: string;
  item?: string;
  price?: string;
  sku?: string;
  tags?: string;
  notes?: string;
  first?: boolean;
}

const row = (r: Row): string => {
  const first = r.first !== false;
  const cells = [
    r.name,
    first ? 'masked@example.com' : '',
    first ? 'pending' : '',
    first ? 'unfulfilled' : '',
    first ? (r.subtotal ?? r.total ?? '2500.00') : '',
    first ? '0.00' : '',
    first ? '0.00' : '',
    first ? (r.total ?? '2500.00') : '',
    '',
    first ? '0.00' : '',
    first ? (r.created ?? '2026-04-02 14:05:00 +0500') : '',
    r.qty ?? '1',
    r.item ?? 'Vitamin C Serum - 30 ml',
    r.price ?? '2500.00',
    r.sku ?? 'NBJ-SERUM-30',
    first ? 'Test Customer' : '',
    first ? 'House 0, Test Street' : '',
    first ? 'Lahore' : '',
    first ? '0300 0000901' : '',
    first ? (r.notes ?? '') : '',
    '',
    first ? (r.id ?? '') : '',
    first ? (r.tags ?? '') : '',
    '0.00',
  ];
  return cells.map((c) => (/[",\n]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(',');
};
const file = (...rows: string[]) => [HEADER, ...rows].join('\n') + '\n';

describe('reading a Shopify order export', () => {
  it('reads Shopify\'s timestamps, with or without an offset (without one: Karachi)', () => {
    assert.equal(parseShopifyTime('2026-04-02 14:05:00 +0500')?.toISOString(), '2026-04-02T09:05:00.000Z');
    assert.equal(parseShopifyTime('2026-04-02 14:05:00')?.toISOString(), '2026-04-02T09:05:00.000Z');
    assert.equal(parseShopifyTime('2026-02-30 10:00:00 +0500'), null);
    assert.equal(parseShopifyTime('02/04/2026'), null);
  });

  it('groups line rows under their order, and sets aside a whole order for any malformed row, with the row number', () => {
    const parsed = parseExport(
      file(
        row({ name: '#1001', id: '5001', total: '3700.00', subtotal: '3700.00', price: '2500.00' }),
        row({ name: '#1001', first: false, item: 'Cream', price: '1200.00', sku: 'NBJ-CREAM-50' }),
        row({ name: '#1002', id: '', total: '900.00' }),
        row({ name: '#1003', id: '5003', total: 'abc', subtotal: '900.00' }),
        row({ name: '#1004', id: '5004', created: 'yesterday' }),
        row({ name: '#1005', id: '5005' }),
        row({ name: '#1005', first: false, qty: 'two' }),
        row({ name: '', id: '5006' }),
        row({ name: '#1007', id: '5007', tags: 'Influencer, PR', notes: 'Order has been booked. Tracking Number: 24000000123' }),
      ),
    );
    assert.deepEqual(parsed.fileErrors, []);
    assert.deepEqual(
      parsed.problems.map((p) => [p.row, p.orderNumber, p.reason]),
      [
        [4, '#1002', 'Id (the Shopify order id) is empty'],
        [5, '#1003', 'Total "abc" is not an amount'],
        [6, '#1004', 'Created at "yesterday" is not a date and time'],
        [8, '#1005', 'Lineitem quantity "two" is not a whole number'],
        [9, null, 'Name (the order number) is empty'],
      ],
    );
    assert.deepEqual(parsed.orders.map((o) => o.orderNumber), ['#1001', '#1007'], 'the rest are still read');
    assert.equal(parsed.malformedOrders, 4);
    const first = parsed.orders[0]!;
    assert.deepEqual([first.rows, first.input.lines.length, first.input.total, first.input.source], [[2, 3], 2, paisa(370_000n), 'csv_import']);
    assert.deepEqual(first.customer, { name: 'Test Customer', phone: '0300 0000901' });
    const pr = parsed.orders[1]!;
    assert.deepEqual([pr.input.channel, pr.input.postexTrackingNumbers], ['pr', ['24000000123']]);
    assert.deepEqual(parseExport('Name,Total\n#1,5\n').fileErrors, ['Not a Shopify order export: missing columns Id, Created at, Lineitem quantity, Lineitem name, Lineitem price']);
  });
});

describe('importing order history', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let actor: string;
  let account: string;
  let serum: string;

  before(async () => {
    s = await migratedWithStores();
    actor = await testUser(s.schema.sql);
    const [a] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    account = a!.id;
    [serum] = (await variantsIn(s.schema.sql, s.nur, 1)) as [string];
    await s.schema.sql`update variants set sku = 'NBJ-SERUM-30' where id = ${serum}`;
  });

  after(async () => {
    await s?.schema.drop();
  });

  const apiOrder = (shopifyOrderId: bigint, orderNumber: string, total: bigint): OrderInput => ({
    storeId: s.nur,
    shopifyOrderId,
    orderNumber,
    placedAt: new Date('2026-08-20T09:00:00Z'),
    customerId: null,
    shippingAddressId: null,
    financialStatus: 'paid',
    fulfillmentStatus: null,
    subtotal: paisa(total),
    discount: paisa(0n),
    shipping: paisa(0n),
    tax: paisa(0n),
    total: paisa(total),
    channel: 'online',
    cancelledAt: null,
    cancelReason: null,
    tags: [],
    discountCodes: [],
    source: 'api',
    raw: { id: String(shopifyOrderId) },
    lines: [{ lineKey: `shopify:${shopifyOrderId}1`, variantId: serum, sku: 'NBJ-SERUM-30', title: 'Serum', qty: 2, unitPrice: paisa(total / 2n), discount: paisa(0n), total: paisa(total) }],
  });
  const orders = async (number: string) =>
    s.schema.sql<{ id: string; source: string; total_paisa: string; lines: number }[]>`
      select o.id, o.source, o.total_paisa::text, (select count(*)::int from order_lines l where l.order_id = o.id) as lines
      from orders o where o.store_id = ${s.nur} and o.order_number = ${number}
    `;
  const counts = async () =>
    (await s.schema.sql<Record<string, number>[]>`
      select (select count(*)::int from orders) as orders, (select count(*)::int from order_lines) as lines, (select count(*)::int from customers) as customers,
             (select count(*)::int from order_csv_imports) as runs, (select count(*)::int from audit_log) as audits
    `)[0]!;

  it('AN ORDER IN BOTH: one row, the API\'s, whichever arrives first; the dry run writes nothing', async () => {
    await upsertOrder(s.schema.sql, apiOrder(9001n, '#9001', 500_000n));
    const csv = file(row({ name: '#9001', id: '9001', total: '4000.00' }), row({ name: '#9002', id: '9002', total: '2500.00' }));

    const before = await counts();
    const dry = await dryRunOrderImport(s.schema.sql, 'nur', csv);
    assert.deepEqual(await counts(), before, 'the dry run wrote nothing');
    assert.deepEqual(dry.orders, { valid: 2, malformed: 0, new: 1, previouslyImported: 0, fromApi: 1, conflicting: 0 });

    const result = await commitOrderImport(s.schema.sql, { store: 'nur', fileName: 'nur-orders-2026.csv', csv, actorId: actor });
    assert.deepEqual([result.inserted, result.updated, result.orders.fromApi], [1, 0, 1]);
    const kept = [...(await orders('#9001'))];
    assert.deepEqual(kept.map((o) => [o.source, o.total_paisa, o.lines]), [['api', '500000', 1]], 'the API row is untouched');
    const imported = await orders('#9002');
    assert.deepEqual([imported.length, imported[0]!.source, imported[0]!.total_paisa], [1, 'csv_import', '250000']);
    const [line] = await s.schema.sql<{ variant_id: string | null; line_key: string }[]>`select variant_id, line_key from order_lines where order_id = ${imported[0]!.id}`;
    assert.deepEqual(line, { variant_id: serum, line_key: 'line:1' }, 'the SKU found its product');

    // The API sync meets the imported order later: still one row, now the API's, its lines replacing the file's.
    await upsertOrder(s.schema.sql, apiOrder(9002n, '#9002', 260_000n));
    const after = await orders('#9002');
    assert.deepEqual([after.length, after[0]!.id, after[0]!.source, after[0]!.total_paisa], [1, imported[0]!.id, 'api', '260000']);
    const keys = await s.schema.sql<{ line_key: string }[]>`select line_key from order_lines where order_id = ${imported[0]!.id}`;
    assert.deepEqual(keys.map((k) => k.line_key), ['shopify:90021']);

    // And the file again changes nothing: both orders are the API's now.
    const again = await commitOrderImport(s.schema.sql, { store: 'nur', fileName: 'nur-orders-2026.csv', csv, actorId: actor });
    assert.deepEqual([again.inserted, again.updated, again.orders.fromApi], [0, 0, 2]);
    assert.equal((await orders('#9002'))[0]!.total_paisa, '260000');
  });

  it('MALFORMED ROWS are reported by row number and the run goes on; a re-run of the same file changes nothing', async () => {
    const csv = file(
      row({ name: '#8001', id: '8001' }),
      row({ name: '#8002', id: '8002', total: '12,34.5', subtotal: '2500.00' }),
      row({ name: '#8003', id: '8003' }),
      row({ name: '#8003', first: false, price: '' }),
      row({ name: '#8004', id: '8004' }),
      row({ name: '#9001', id: '7777' }),
    );
    const result = await commitOrderImport(s.schema.sql, { store: 'nur', fileName: 'mixed.csv', csv, actorId: actor });
    assert.deepEqual(
      result.problems.map((p) => [p.row, p.reason]),
      [
        [3, 'Total "12,34.5" is not an amount'],
        [5, 'Lineitem price is empty'],
        [7, '#9001 is already order 9001 in this store, a different Shopify order'],
      ],
    );
    assert.deepEqual([result.inserted, result.orders.malformed, result.orders.conflicting], [2, 2, 1]);
    assert.equal((await orders('#8001')).length, 1);
    assert.equal((await orders('#8004')).length, 1);
    assert.equal((await orders('#8003')).length, 0, 'a half-read order is never stored');

    const before = await counts();
    const again = await commitOrderImport(s.schema.sql, { store: 'nur', fileName: 'mixed.csv', csv, actorId: actor });
    assert.deepEqual([again.inserted, again.updated, again.unchanged], [0, 0, 2]);
    const afterRun = await counts();
    assert.deepEqual({ ...afterRun, runs: before.runs, audits: before.audits }, before, 'no order, line or customer added');
    assert.equal(afterRun['runs'], before['runs']! + 1, 'the run itself is recorded');
  });

  it('IMPORTED HISTORY MATCHES pre-window PostEx parcels through the matcher, and their stock and state follow', async () => {
    // A parcel booked in April, long before the API window, waiting with no order.
    const shipmentId = await parcel(s.schema.sql, { accountId: account, orderId: null, bookedAt: new Date('2026-04-03T07:00:00Z'), events: [['0005', '2026-04-05T10:00:00Z']] });
    await s.schema.sql`update shipments set order_ref_number = '#7001', cod_amount_paisa = 250000 where id = ${shipmentId}`;
    await addEvent(s.schema.sql, shipmentId, '0005', '2026-04-05T10:00:00Z');

    const result = await commitOrderImport(s.schema.sql, {
      store: 'nur',
      fileName: 'april.csv',
      csv: file(row({ name: '#7001', id: '7001', created: '2026-04-02 14:05:00 +0500', qty: '1' })),
      actorId: actor,
    });
    assert.equal(result.parcelsMatched, 1);
    const [linked] = await s.schema.sql<{ order_id: string | null; match_method: string | null }[]>`select order_id, match_method from shipments where id = ${shipmentId}`;
    const order = (await orders('#7001'))[0]!;
    assert.deepEqual(linked, { order_id: order.id, match_method: 'order_ref' });
    const [state] = await s.schema.sql<{ state: string }[]>`select state from orders where id = ${order.id}`;
    assert.equal(state?.state, 'delivered');
    const [moved] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from stock_moves where shipment_id = ${shipmentId}`;
    assert.ok(moved!.n > 0, 'the parcel\'s stock moved once it had an order');
  });
});
