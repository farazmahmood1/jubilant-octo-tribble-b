import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { importShopifyCost } from '../db/repos/shopify-inventory.js';
import { recomputeOrderState } from '../db/repos/order-state.js';
import { type Paisa, paisa } from '../lib/money.js';
import { skipWithoutDb } from '../test/db.js';
import { addEvent, orderWithLines, parcel, testUser, variantsIn } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { inventoryCheck, postShipmentAccounting, trialBalance } from './accounting.js';
import {
  DEFAULT_PURCHASING,
  allowance,
  cancelPurchaseOrder,
  cancelRequest,
  compareQuotes,
  createPurchaseOrder,
  createQuotation,
  createRequest,
  createVendor,
  listBills,
  listPurchaseOrders,
  listRequests,
  listVendors,
  movingAverageCost,
  orderStatus,
  payBill,
  purchaseOrderDetail,
  receiveGoods,
  recordBill,
  reorderQty,
  reorderSuggestions,
  threeWayMatch,
} from './purchasing.js';
import { reconcileShipmentStock } from './stock.js';

const rs = (rupees: number): Paisa => paisa(BigInt(Math.round(rupees * 100)));

describe('purchasing rules', () => {
  it('a receipt costs the product at the moving average of what is held and what arrived', () => {
    assert.equal(movingAverageCost(0, rs(400), 10, rs(500)), rs(500), 'nothing held: the order price');
    assert.equal(movingAverageCost(5, null, 10, rs(500)), rs(500), 'no cost yet: the order price');
    assert.equal(movingAverageCost(10, rs(400), 10, rs(500)), rs(450));
    assert.equal(movingAverageCost(-3, rs(400), 10, rs(500)), rs(500), 'sold before the count: the order price');
    // (2 × 100 + 1 × 101) / 3 = 100.333… paisa → 100; (1 × 100 + 1 × 101) / 2 = 100.5 → 101 (half up).
    assert.equal(movingAverageCost(2, paisa(100n), 1, paisa(101n)), paisa(100n));
    assert.equal(movingAverageCost(1, paisa(100n), 1, paisa(101n)), paisa(101n));
  });

  it('the tolerance is the larger of the percentage and the floor', () => {
    assert.equal(allowance(rs(1000), DEFAULT_PURCHASING), rs(100), '2% is Rs 20; the Rs 100 floor wins');
    assert.equal(allowance(rs(20_000), DEFAULT_PURCHASING), rs(400));
    assert.equal(allowance(rs(20_000), { tolerancePercent: 2.5, toleranceAbsolutePaisa: 0 }), rs(500), 'fractional percentages are exact');
  });

  it('the three-way match names each line that fails, and why', () => {
    const line = { poLineId: '1', title: 'Serum · 30 ml', unitCost: rs(400), received: 4, billedQty: 0, billedValue: rs(0), qty: 4, value: rs(1700) };
    assert.deepEqual(threeWayMatch([line], DEFAULT_PURCHASING), []);
    assert.deepEqual(threeWayMatch([{ ...line, value: rs(1720) }], DEFAULT_PURCHASING), [
      "Serum · 30 ml: Rs 1,720 billed for 4 units received at the order's Rs 400 (Rs 1,600): over by Rs 120, more than the Rs 100 tolerance",
    ]);
    assert.deepEqual(threeWayMatch([{ ...line, qty: 5, value: rs(2000) }], DEFAULT_PURCHASING), ['Serum · 30 ml: 5 units billed, but only 4 received']);
    assert.deepEqual(threeWayMatch([{ ...line, billedQty: 3, billedValue: rs(1200), qty: 2 }], DEFAULT_PURCHASING), [
      'Serum · 30 ml: 5 units billed (3 on earlier bills), but only 4 received',
    ]);
  });

  it('reorders enough for the lead time and cover at the delivered rate, less shelf and orders', () => {
    const base = { variantId: '1', delivered: 30, windowDays: 30, warehouse: 10, onOrder: 5, leadTimeDays: 7, coverDays: 30 };
    assert.equal(reorderQty(base), 22, '37 needed, 15 there');
    assert.equal(reorderQty({ ...base, delivered: 0 }), 0);
    assert.equal(reorderQty({ ...base, warehouse: 100 }), 0);
    assert.equal(reorderQty({ ...base, warehouse: -4 }), 32, 'a negative shelf counts as empty');
  });

  it('an order\'s status is read from its documents', () => {
    const o = { cancelled: false, ordered: 10, received: 0, billed: 0, billTotal: rs(0), paid: rs(0) };
    assert.equal(orderStatus(o), 'ordered');
    assert.equal(orderStatus({ ...o, received: 4 }), 'partially_received');
    assert.equal(orderStatus({ ...o, received: 10 }), 'received');
    assert.equal(orderStatus({ ...o, received: 10, billed: 10, billTotal: rs(4000) }), 'billed');
    assert.equal(orderStatus({ ...o, received: 10, billed: 10, billTotal: rs(4000), paid: rs(4000) }), 'paid');
    assert.equal(orderStatus({ ...o, cancelled: true }), 'cancelled');
  });
});

describe('purchasing in the database', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let actor: string;
  let account: string;
  let vendor: string;
  let serum: string;
  let cream: string;
  let n = 0;

  before(async () => {
    s = await migratedWithStores();
    actor = await testUser(s.schema.sql);
    const [a] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    account = a!.id;
    [serum, cream] = (await variantsIn(s.schema.sql, s.nur, 2)) as [string, string];
    vendor = await createVendor(s.schema.sql, { name: 'Test Labs', leadTimeDays: 10, paymentTermsDays: 30 }, actor);
  });

  after(async () => {
    await s?.schema.drop();
  });

  const order = (lines: Array<{ variantId: string; qty: number; unitCost: Paisa }>, orderedOn = '2026-09-01') =>
    createPurchaseOrder(s.schema.sql, { vendorId: vendor, store: 'nur', orderedOn, lines, actorId: actor });
  const lineIds = async (poId: string) => (await purchaseOrderDetail(s.schema.sql, poId))!.lines.map((l) => l.id);
  const warehouse = async (variantId: string) =>
    (await s.schema.sql<{ qty: number }[]>`select coalesce(sum(q.qty), 0)::int as qty from stock_quants q join locations l on l.id = q.location_id where q.variant_id = ${variantId} and l.key = 'warehouse'`)[0]!.qty;
  const balance = async (code: string) =>
    BigInt((await s.schema.sql<{ v: string }[]>`select coalesce(sum(l.debit_paisa - l.credit_paisa), 0)::text as v from journal_lines l join accounts a on a.id = l.account_id where a.code = ${code}`)[0]!.v);
  /** A delivered sale of one product, settled as the sync settles it. Returns the parcel. */
  const sell = async (variantId: string, qty: number, placedAt: string, events: Array<[string, string]>) => {
    const orderId = await orderWithLines(s.schema.sql, { storeId: s.nur, number: `#P${++n}`, placedAt: new Date(placedAt), totalPaisa: 300_000n, lines: [{ variantId, qty }] });
    const shipmentId = await parcel(s.schema.sql, { accountId: account, orderId, events, bookedAt: new Date(placedAt) });
    await s.schema.sql`update shipments set cod_amount_paisa = 300000 where id = ${shipmentId}`;
    await reconcileShipmentStock(s.schema.sql, shipmentId);
    await postShipmentAccounting(s.schema.sql, shipmentId);
    await recomputeOrderState(s.schema.sql, orderId);
    return { orderId, shipmentId };
  };

  it('PARTIAL RECEIPTS: each moves supplier → warehouse, values it into Inventory, and nothing beyond what is outstanding', async () => {
    const po = await order([{ variantId: serum, qty: 10, unitCost: rs(400) }, { variantId: cream, qty: 5, unitCost: rs(250) }]);
    assert.match(po.number, /^PO-\d{5}$/);
    const [serumLine, creamLine] = (await lineIds(po.id)) as [string, string];

    const first = await receiveGoods(s.schema.sql, { poId: po.id, receivedAt: new Date('2026-09-03T06:00:00Z'), lines: [{ poLineId: serumLine, qty: 4 }], actorId: actor });
    assert.equal(first.value, rs(1600));
    assert.equal((await listPurchaseOrders(s.schema.sql)).find((o) => o.id === po.id)?.status, 'partially_received');
    assert.equal(await warehouse(serum), 4);

    await receiveGoods(s.schema.sql, {
      poId: po.id,
      receivedAt: new Date('2026-09-05T06:00:00Z'),
      lines: [{ poLineId: serumLine, qty: 6 }, { poLineId: creamLine, qty: 5 }],
      actorId: actor,
    });
    await assert.rejects(
      receiveGoods(s.schema.sql, { poId: po.id, receivedAt: new Date('2026-09-06T06:00:00Z'), lines: [{ poLineId: serumLine, qty: 1 }], actorId: actor }),
      /receiving 1, but only 0 of 10 ordered are still to come/,
    );
    const detail = (await purchaseOrderDetail(s.schema.sql, po.id))!;
    assert.equal(detail.status, 'received');
    assert.deepEqual(detail.lines.map((l) => [l.qty, l.received]), [[10, 10], [5, 5]]);
    assert.equal(detail.receipts.length, 2);
    assert.deepEqual([await warehouse(serum), await warehouse(cream)], [10, 5]);

    const moves = await s.schema.sql<{ n: number }[]>`
      select count(*)::int as n from stock_moves m join locations f on f.id = m.from_location_id join locations t on t.id = m.to_location_id
      where f.key = 'supplier' and t.key = 'warehouse' and m.ref_type = 'gr_line'
    `;
    assert.equal(moves[0]!.n, 3, 'one move per received line');
    assert.equal(await balance('1300'), rs(5250), 'Rs 4,000 of serum and Rs 1,250 of cream in Inventory');
    assert.equal(await balance('2050'), -rs(5250), 'owed but not yet billed');
    assert.equal((await inventoryCheck(s.schema.sql, '2026-09-30')).difference, 0n, 'units × cost equals the Inventory account');
    await assert.rejects(cancelPurchaseOrder(s.schema.sql, po.id, actor), /cannot be cancelled/);
  });

  it('A BILL EXCEEDING THE RECEIPT beyond tolerance is refused with a clear error, writing nothing; within it, the difference is variance', async () => {
    const po = await order([{ variantId: serum, qty: 10, unitCost: rs(400) }]);
    const [line] = (await lineIds(po.id)) as [string];
    await receiveGoods(s.schema.sql, { poId: po.id, receivedAt: new Date('2026-09-10T06:00:00Z'), lines: [{ poLineId: line, qty: 4 }], actorId: actor });
    const before = (await s.schema.sql<{ n: number }[]>`select count(*)::int as n from journal_entries`)[0]!.n;

    const bill = (qty: number, unitPrice: number, number = `INV-${++n}`) =>
      recordBill(s.schema.sql, { poId: po.id, billNumber: number, billDate: '2026-09-11', tax: rs(0), lines: [{ poLineId: line, qty, unitPrice: rs(unitPrice) }], actorId: actor });
    await assert.rejects(bill(10, 400), /does not match PO-\d{5}: Test serum · Size 0: 10 units billed, but only 4 received/);
    await assert.rejects(
      bill(4, 430),
      /Rs 1,720 billed for 4 units received at the order's Rs 400 \(Rs 1,600\): over by Rs 120, more than the Rs 100 tolerance/,
    );
    assert.equal((await s.schema.sql<{ n: number }[]>`select count(*)::int as n from vendor_bills where po_id = ${po.id}`)[0]!.n, 0);
    assert.equal((await s.schema.sql<{ n: number }[]>`select count(*)::int as n from journal_entries`)[0]!.n, before);

    const variance = await balance('5010');
    const grni = await balance('2050');
    const ok = await bill(4, 420, 'INV-OK');
    assert.equal(ok.total, rs(1680));
    assert.equal((await balance('5010')) - variance, rs(80), 'Rs 80 over the order price: purchase price variance');
    assert.equal((await balance('2050')) - grni, rs(1600), 'the receipt\'s Rs 1,600 cleared');
    await assert.rejects(bill(1, 400, 'inv-ok'), /already recorded/, 'the same vendor invoice twice, any case');
    // The rest of the order arrives and is billed on a second bill.
    await receiveGoods(s.schema.sql, { poId: po.id, receivedAt: new Date('2026-09-12T06:00:00Z'), lines: [{ poLineId: line, qty: 6 }], actorId: actor });
    await bill(6, 400, 'INV-REST');
    assert.equal((await purchaseOrderDetail(s.schema.sql, po.id))!.status, 'billed');
  });

  it('THE COST A RECEIPT WRITES is the cost a later delivered order\'s COGS uses; a second receipt averages it', async () => {
    const [fresh] = await variantsIn(s.schema.sql, s.nur, 1, 9_700);
    const po = await order([{ variantId: fresh!, qty: 20, unitCost: rs(300) }]);
    const [line] = (await lineIds(po.id)) as [string];
    const first = await receiveGoods(s.schema.sql, { poId: po.id, receivedAt: new Date('2026-09-02T06:00:00Z'), lines: [{ poLineId: line, qty: 10 }], actorId: actor });
    assert.equal(first.lines[0]!.cost, rs(300));
    const [written] = await s.schema.sql<{ unit_cost_paisa: string; effective_from: string; source: string }[]>`
      select unit_cost_paisa::text, effective_from::text, source from product_costs where variant_id = ${fresh!}
    `;
    assert.deepEqual(written, { unit_cost_paisa: '30000', effective_from: '2026-09-02', source: 'goods_receipt' });

    const sold = await sell(fresh!, 2, '2026-09-04T05:00:00Z', [['0005', '2026-09-06T10:00:00Z']]);
    const cogs = async (shipmentId: string) =>
      (await s.schema.sql<{ v: string }[]>`
        select l.debit_paisa::text as v from journal_entries e join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
        where e.source_type = 'shipment_cogs' and e.source_id = ${shipmentId} and e.reversed_by is null and a.code = '5000'
      `)[0]?.v;
    assert.equal(await cogs(sold.shipmentId), String(rs(600)), '2 units at the receipt\'s Rs 300');

    // 8 held at Rs 300, 10 more at Rs 390: (2,400 + 3,900) / 18 = Rs 350.
    const second = await receiveGoods(s.schema.sql, { poId: po.id, receivedAt: new Date('2026-09-08T06:00:00Z'), lines: [{ poLineId: line, qty: 10 }], actorId: actor });
    assert.equal(second.lines[0]!.cost, rs(300), 'the order price is the order price');
    const po2 = await order([{ variantId: fresh!, qty: 10, unitCost: rs(390) }], '2026-09-08');
    const [line2] = (await lineIds(po2.id)) as [string];
    const third = await receiveGoods(s.schema.sql, { poId: po2.id, receivedAt: new Date('2026-09-09T06:00:00Z'), lines: [{ poLineId: line2, qty: 10 }], actorId: actor });
    // 18 held at Rs 300 + 10 at Rs 390 = Rs 8,300 for 28 units: Rs 332.142… → Rs 332.14.
    assert.equal(third.lines[0]!.cost, paisa(33_214n));
    const later = await sell(fresh!, 1, '2026-09-10T05:00:00Z', [['0005', '2026-09-12T10:00:00Z']]);
    assert.equal(await cogs(later.shipmentId), '33214', 'the order after the receipt uses the averaged cost');
    const earlier = await cogs(sold.shipmentId);
    assert.equal(earlier, String(rs(600)), 'an order before it keeps the cost of its own date');

    // A stale "Cost per item" in Shopify no longer overwrites what was paid.
    assert.equal(await importShopifyCost(s.schema.sql, fresh!, rs(999), '2026-09-15'), 'purchased');
  });

  it('PAYMENT: partial, never more than outstanding, and blocked when the bill no longer matches', async () => {
    const po = await order([{ variantId: cream, qty: 10, unitCost: rs(250) }]);
    const [line] = (await lineIds(po.id)) as [string];
    await receiveGoods(s.schema.sql, { poId: po.id, receivedAt: new Date('2026-09-14T06:00:00Z'), lines: [{ poLineId: line, qty: 10 }], actorId: actor });
    const { billId, total } = await recordBill(s.schema.sql, {
      poId: po.id,
      billNumber: 'INV-PAY',
      billDate: '2026-09-15',
      tax: rs(400),
      lines: [{ poLineId: line, qty: 10, unitPrice: rs(255) }],
      charges: [{ description: 'Freight', amount: rs(150) }],
      actorId: actor,
    });
    assert.equal(total, rs(3100), 'Rs 2,550 goods, Rs 150 freight, Rs 400 tax');
    const bills = await listBills(s.schema.sql, { unpaidOnly: true, today: '2026-10-20' });
    const row = bills.find((b) => b.id === billId)!;
    assert.deepEqual([row.dueOn, row.overdue], ['2026-10-15', true], 'due by the vendor\'s 30-day terms');

    const first = await payBill(s.schema.sql, { billId, amount: rs(1000), paidOn: '2026-09-20', method: 'bank_transfer', reference: 'TT-1', actorId: actor });
    assert.equal(first.outstanding, rs(2100));
    await assert.rejects(payBill(s.schema.sql, { billId, amount: rs(2200), paidOn: '2026-09-21', method: 'cash', actorId: actor }), /Rs 2,100 outstanding; Rs 2,200 is more/);

    // The tolerance is tightened after the bill: Rs 50 over on Rs 2,500 is now too much.
    await s.schema.sql`insert into app_settings (key, value) values ('purchasing', ${s.schema.sql.json({ tolerancePercent: 0, toleranceAbsolutePaisa: 1000 })})`;
    await assert.rejects(payBill(s.schema.sql, { billId, amount: rs(100), paidOn: '2026-09-21', method: 'cash', actorId: actor }), /Payment blocked: bill INV-PAY no longer matches PO-\d{5}/);
    await s.schema.sql`delete from app_settings where key = 'purchasing'`;
    await payBill(s.schema.sql, { billId, amount: rs(2100), paidOn: '2026-09-22', method: 'cash', actorId: actor });
    assert.equal((await purchaseOrderDetail(s.schema.sql, po.id))!.status, 'paid');

    const vendorRow = (await listVendors(s.schema.sql)).find((v) => v.id === vendor)!;
    const payable = (await s.schema.sql<{ v: string }[]>`
      select coalesce(sum(l.credit_paisa - l.debit_paisa), 0)::text as v from journal_lines l join accounts a on a.id = l.account_id
      where a.code = '2000' and l.partner_type = 'vendor' and l.partner_id = ${vendor}
    `)[0]!.v;
    assert.equal(vendorRow.payable, BigInt(payable));
    const tb = await trialBalance(s.schema.sql, { storeId: s.nur });
    assert.equal(tb.debit, tb.credit, 'every purchasing entry carries the brand, so the brand\'s trial balance balances');
    const actions = await s.schema.sql<{ action: string }[]>`select distinct action from audit_log where actor_id = ${actor} and action like any(array['vendor%', 'purchase%', 'goods%'])`;
    assert.deepEqual(actions.map((a) => a.action).sort(), ['goods_receipt.create', 'purchase_order.create', 'vendor.create', 'vendor_bill.create', 'vendor_payment.create']);
  });

  it('requests and quotations: compared cheapest first, ordered from a quotation, cancelled with a reason', async () => {
    const request = await createRequest(s.schema.sql, { variantId: cream, qty: 50, reason: 'Eid stock', actorId: actor });
    const other = await createVendor(s.schema.sql, { name: 'Second Supplier' }, actor);
    await assert.rejects(createVendor(s.schema.sql, { name: ' test labs ' }, actor), /already exists/);
    await createQuotation(s.schema.sql, { vendorId: vendor, receivedOn: '2026-09-01', validUntil: '2026-09-10', lines: [{ variantId: cream, qty: 50, unitPrice: rs(240), requestId: request }], actorId: actor });
    const cheaper = await createQuotation(s.schema.sql, { vendorId: other, receivedOn: '2026-09-02', lines: [{ variantId: cream, qty: 50, unitPrice: rs(230), requestId: request }], actorId: actor });
    const quotes = await compareQuotes(s.schema.sql, cream, '2026-09-20');
    assert.deepEqual(quotes.map((q) => [q.vendor, q.unitPrice, q.expired]), [['Second Supplier', rs(230), false], ['Test Labs', rs(240), true]]);
    assert.equal((await listRequests(s.schema.sql)).find((r) => r.id === request)?.status, 'quoted');

    const po = await createPurchaseOrder(s.schema.sql, { vendorId: other, store: 'nur', quotationId: cheaper, orderedOn: '2026-09-03', actorId: actor });
    const detail = (await purchaseOrderDetail(s.schema.sql, po.id))!;
    assert.deepEqual(detail.lines.map((l) => [l.qty, l.unitCost]), [[50, rs(230)]], 'lines from the quotation');
    assert.equal((await listRequests(s.schema.sql, { includeClosed: true })).find((r) => r.id === request)?.status, 'ordered');
    await assert.rejects(cancelRequest(s.schema.sql, request, actor), /cancel the order instead/);
    await assert.rejects(createPurchaseOrder(s.schema.sql, { vendorId: vendor, store: 'nur', quotationId: cheaper, orderedOn: '2026-09-03', actorId: actor }), /another vendor/);
    const [organicsVariant] = await variantsIn(s.schema.sql, s.organics, 1, 9_800);
    await assert.rejects(order([{ variantId: organicsVariant!, qty: 1, unitCost: rs(1) }]), /another brand's: one order per brand/);
    await cancelPurchaseOrder(s.schema.sql, po.id, actor);
    assert.equal((await listPurchaseOrders(s.schema.sql)).find((o) => o.id === po.id)?.status, 'cancelled');
    await cancelRequest(s.schema.sql, request, actor);
    assert.equal((await listRequests(s.schema.sql, { includeClosed: true })).find((r) => r.id === request)?.status, 'cancelled');
    await assert.rejects(s.schema.sql`update po_lines set qty = 1`, /append-only/);
    await assert.rejects(s.schema.sql`update purchase_orders set note = 'x' where id = ${po.id}`, /can only be cancelled, once/);
  });

  it('REORDER: velocity counts delivered units only; placed and in-transit orders do not inflate it', async () => {
    const [product] = await variantsIn(s.schema.sql, s.nur, 1, 9_900);
    const po = await order([{ variantId: product!, qty: 40, unitCost: rs(200) }]);
    const [line] = (await lineIds(po.id)) as [string];
    await receiveGoods(s.schema.sql, { poId: po.id, receivedAt: new Date('2026-09-01T06:00:00Z'), lines: [{ poLineId: line, qty: 40 }], actorId: actor });
    // 3 parcels delivered in the window, 2 units each; one came back from the customer.
    for (const day of ['05', '12', '20']) await sell(product!, 2, `2026-09-${day}T05:00:00Z`, [['0005', `2026-09-${day}T12:00:00Z`]]);
    const returned = await sell(product!, 2, '2026-09-21T05:00:00Z', [['0005', '2026-09-22T12:00:00Z']]);
    await addEvent(s.schema.sql, returned.shipmentId, '0040', '2026-09-25T09:00:00Z');
    await reconcileShipmentStock(s.schema.sql, returned.shipmentId);

    const now = new Date('2026-09-30T12:00:00Z');
    const suggest = async () => (await reorderSuggestions(s.schema.sql, { now, store: 'nur' })).find((r) => r.variantId === product)!;
    const before = await suggest();
    assert.deepEqual([before.delivered, before.windowDays, before.warehouse], [6, 30, 32], '8 delivered less 2 returned; 40 received less 8 sent');
    assert.equal(before.leadTimeDays, 10, 'the vendor\'s lead time');
    // 6 units a month over 10 + 30 days needs 8; 32 on the shelf.
    assert.equal(before.suggestedQty, 0);
    assert.equal(before.daysOfCover, 160);

    // Ten orders placed and not booked, five booked and on their way: none of them sold yet.
    for (let i = 0; i < 10; i++) {
      await orderWithLines(s.schema.sql, { storeId: s.nur, number: `#PLACED${i}`, placedAt: new Date('2026-09-28T05:00:00Z'), lines: [{ variantId: product!, qty: 3 }] });
    }
    for (let i = 0; i < 5; i++) await sell(product!, 2, '2026-09-27T05:00:00Z', [['0008', '2026-09-28T10:00:00Z']]);
    const after = await suggest();
    assert.deepEqual([after.delivered, after.dailyVelocity], [before.delivered, before.dailyVelocity], 'velocity unchanged by 30 placed and 10 in-transit units');
    assert.equal(after.warehouse, 22, 'the booked parcels did leave the shelf');

    // Over 14 days (from 17 Sep): the 20 and 22 Sep deliveries, less the return.
    assert.equal((await reorderSuggestions(s.schema.sql, { now, store: 'nur', windowDays: 14 })).find((r) => r.variantId === product)!.delivered, 2);
    // Covering 400 days: 6 a month over 410 days is 82; 22 on the shelf, then 10 more on order.
    const long = async () => (await reorderSuggestions(s.schema.sql, { now, store: 'nur', coverDays: 400 })).find((r) => r.variantId === product)!;
    assert.equal((await long()).suggestedQty, 60);
    await order([{ variantId: product!, qty: 10, unitCost: rs(210) }], '2026-09-29');
    const withOrder = await long();
    assert.deepEqual([withOrder.onOrder, withOrder.suggestedQty, withOrder.lastVendor?.unitCost], [10, 50, rs(210)]);
  });
});
