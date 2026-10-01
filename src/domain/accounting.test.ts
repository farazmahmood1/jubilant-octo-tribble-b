import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';

import { syncPayouts } from '../jobs/postex-payouts.js';
import { syncPostex } from '../jobs/postex.js';
import { type Paisa, paisa } from '../lib/money.js';
import type { Logger } from '../logger.js';
import { skipWithoutDb } from '../test/db.js';
import { addEvent, orderWithLines, parcel, testUser, variantsIn } from '../test/inventory.js';
import { SPIKE, fakePostex, syntheticParcels } from '../test/postex-fake.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import {
  AccountingError,
  type Line,
  PeriodClosedError,
  closePeriod,
  cogsLines,
  consignmentSaleLines,
  forwardChargeLines,
  partnerPaymentLines,
  payoutLines,
  postConsignmentSale,
  postEntry,
  postPartnerPayment,
  postShipmentAccounting,
  postVendorBill,
  postVendorPayment,
  replayAccounting,
  returnChargeLines,
  reverseEntry,
  saleLines,
  trialBalance,
  vendorBillLines,
  vendorPaymentLines,
  writeOffLines,
} from './accounting.js';
import { checkInReturn, reconcileShipmentStock } from './stock.js';

const p = (rupees: number): Paisa => paisa(BigInt(rupees) * 100n);
/** `Dr 1100 2750.00`-style strings, sorted: the exact pairs an entry carries. */
const pairs = (lines: readonly Line[]): string[] => {
  const codes: Record<string, string> = {
    bank: '1000', codReceivable: '1100', customerReceivable: '1150', partnerReceivable: '1200', inventory: '1300', inputTax: '1400',
    payable: '2000', salesTaxPayable: '2100', revenue: '4000', cogs: '5000', deliveryExpense: '6000', returnExpense: '6010',
    postexTax: '6020', marketing: '6100', writeOff: '6200', general: '6900',
  };
  return lines.map((l) => (l.debit ? `Dr ${codes[l.account]} ${l.debit}` : `Cr ${codes[l.account]} ${l.credit}`)).sort();
};

describe('posting rules: the exact debit and credit pairs (Step 10 table)', () => {
  const base = { storeId: '1', postexAccountId: '7' };

  it('delivered sale: COD receivable / revenue net of tax and tax payable', () => {
    assert.deepEqual(pairs(saleLines({ ...base, codAmount: p(2750), orderTotal: p(2750), orderTax: p(250) })), ['Cr 2100 25000', 'Cr 4000 250000', 'Dr 1100 275000']);
  });

  it('delivered sale on a prepaid order: the customer receivable carries what PostEx did not collect', () => {
    assert.deepEqual(pairs(saleLines({ ...base, codAmount: p(0), orderTotal: p(2000), orderTax: p(0) })), ['Cr 4000 200000', 'Dr 1150 200000']);
    // COD above the order total (a cod_mismatch item): the difference is credited to the customer.
    assert.deepEqual(pairs(saleLines({ ...base, codAmount: p(2100), orderTotal: p(2000), orderTax: p(0) })), ['Cr 1150 10000', 'Cr 4000 200000', 'Dr 1100 210000']);
  });

  it('COGS on delivery: COGS / inventory; a PR parcel goes to marketing (S10)', () => {
    assert.deepEqual(pairs(cogsLines({ storeId: '1', cost: p(900), pr: false })), ['Cr 1300 90000', 'Dr 5000 90000']);
    assert.deepEqual(pairs(cogsLines({ storeId: '1', cost: p(900), pr: true })), ['Cr 1300 90000', 'Dr 6100 90000']);
  });

  it('PostEx forward and return charges: expense and the 16% tax expensed (S13 default) / COD receivable', () => {
    const charge = { ...base, fee: p(200), tax: p(32), pr: false, claimTax: false };
    assert.deepEqual(pairs(forwardChargeLines(charge)), ['Cr 1100 23200', 'Dr 6000 20000', 'Dr 6020 3200']);
    assert.deepEqual(pairs(returnChargeLines(charge)), ['Cr 1100 23200', 'Dr 6010 20000', 'Dr 6020 3200']);
    // Claimed as input tax once the accountant says so; on a PR parcel the fee is marketing (S12).
    assert.deepEqual(pairs(forwardChargeLines({ ...charge, claimTax: true })), ['Cr 1100 23200', 'Dr 1400 3200', 'Dr 6000 20000']);
    assert.deepEqual(pairs(forwardChargeLines({ ...charge, pr: true })), ['Cr 1100 23200', 'Dr 6100 20000', 'Dr 6100 3200']);
  });

  it('COD payout: bank / COD receivable', () => {
    assert.deepEqual(pairs(payoutLines({ ...base, amount: p(2518) })), ['Cr 1100 251800', 'Dr 1000 251800']);
  });

  it('damaged return: write-off / inventory', () => {
    assert.deepEqual(pairs(writeOffLines({ storeId: '1', cost: p(450) })), ['Cr 1300 45000', 'Dr 6200 45000']);
  });

  it('vendor bill and payment: inventory, expense, input tax / payable; payable / bank', () => {
    assert.deepEqual(pairs(vendorBillLines({ vendorId: '3', inventory: p(10_000), expense: p(500), tax: p(1600) })), [
      'Cr 2000 1210000', 'Dr 1300 1000000', 'Dr 1400 160000', 'Dr 6900 50000',
    ]);
    assert.deepEqual(pairs(vendorPaymentLines({ vendorId: '3', amount: p(12_100) })), ['Cr 1000 1210000', 'Dr 2000 1210000']);
  });

  it('consignment sale and partner payment: partner receivable / revenue, tax; bank / partner receivable', () => {
    assert.deepEqual(pairs(consignmentSaleLines({ partnerId: '5', storeId: '1', net: p(5000), tax: p(0), cost: p(2000) })), ['Cr 4000 500000', 'Dr 1200 500000']);
    assert.deepEqual(pairs(partnerPaymentLines({ partnerId: '5', amount: p(5000) })), ['Cr 1200 500000', 'Dr 1000 500000']);
  });
});

describe('the journal in the database', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let accountId: string;
  let variants: string[];
  let actor: string;
  let n = 0;

  before(async () => {
    s = await migratedWithStores();
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    accountId = account!.id;
    variants = await variantsIn(s.schema.sql, s.nur, 2);
    for (const [i, v] of variants.entries()) {
      await s.schema.sql`insert into product_costs (variant_id, unit_cost_paisa, effective_from, source) values (${v}, ${String(45_000 + i * 10_000)}, '2026-01-01', 'manual')`;
    }
    actor = await testUser(s.schema.sql);
  });

  after(async () => {
    await s?.schema.drop();
  });

  /** The live (or every) entry for a source, as `Dr code amount` pairs. */
  const entryPairs = async (sourceType: string, sourceId: string, live = true) => {
    const rows = await s.schema.sql<{ side: string }[]>`
      select case when l.debit_paisa > 0 then 'Dr ' || a.code || ' ' || l.debit_paisa else 'Cr ' || a.code || ' ' || l.credit_paisa end as side
      from journal_entries e join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
      where e.source_type = ${sourceType} and e.source_id = ${sourceId} ${live ? s.schema.sql`and e.reversed_by is null` : s.schema.sql``}
    `;
    return rows.map((r) => r.side).sort();
  };
  const reversalsOf = async (sourceType: string, sourceId: string) => {
    const [row] = await s.schema.sql<{ n: number }[]>`
      select count(*)::int as n from journal_entries o join journal_entries r on r.reverses_id = o.id
      where o.source_type = ${sourceType} and o.source_id = ${sourceId}
    `;
    return row!.n;
  };
  const entries = async () => (await s.schema.sql<{ n: number }[]>`select count(*)::int as n from journal_entries`)[0]!.n;

  const order = (opts: { total?: number; tax?: number; channel?: 'online' | 'pr'; lines?: Array<{ variantId: string; qty: number }> } = {}) =>
    orderWithLines(s.schema.sql, {
      storeId: s.nur,
      number: `#88${n++}`,
      placedAt: new Date('2026-09-01T05:00:00Z'),
      totalPaisa: BigInt(opts.total ?? 2750) * 100n,
      channel: opts.channel ?? 'online',
      lines: opts.lines ?? [{ variantId: variants[0]!, qty: 2 }],
    }).then(async (id) => {
      if (opts.tax) await s.schema.sql`update orders set tax_paisa = ${String(opts.tax * 100)} where id = ${id}`;
      return id;
    });

  const charge = (shipmentId: string, kind: string, rupees: number) =>
    s.schema.sql`
      insert into shipment_charges (shipment_id, kind, amount_paisa) values (${shipmentId}, ${kind}, ${String(rupees * 100)})
      on conflict (shipment_id, kind) do update set amount_paisa = excluded.amount_paisa
    `;

  /** What the sync does for a parcel: stock first, then the postings. */
  const settleParcel = async (shipmentId: string) => {
    await reconcileShipmentStock(s.schema.sql, shipmentId);
    return postShipmentAccounting(s.schema.sql, shipmentId);
  };

  const newParcel = async (orderId: string | null, events: Array<[string, string]>) => {
    const id = await parcel(s.schema.sql, { accountId, orderId, events });
    await s.schema.sql`update shipments set cod_amount_paisa = (select total_paisa from orders where id = ${orderId}) where id = ${id} and ${orderId}::bigint is not null`;
    return id;
  };

  it('a database constraint, not the application, rejects an unbalanced entry', async () => {
    const [cash] = await s.schema.sql<{ id: string }[]>`select id from accounts where code = '1000'`;
    const [revenue] = await s.schema.sql<{ id: string }[]>`select id from accounts where code = '4000'`;
    const raw = (credit: number, lines = 2) =>
      s.schema.sql.begin(async (tx) => {
        const [e] = await tx<{ id: string }[]>`insert into journal_entries (entry_date, memo, source_type, source_id) values ('2026-09-10', 'raw', 'test', ${String(n++)}) returning id`;
        await tx`insert into journal_lines (entry_id, account_id, debit_paisa) values (${e!.id}, ${cash!.id}, 10000)`;
        if (lines > 1) await tx`insert into journal_lines (entry_id, account_id, credit_paisa) values (${e!.id}, ${revenue!.id}, ${credit})`;
      });
    await assert.rejects(raw(9999), /does not balance: 2 lines, debits 10000 paisa, credits 9999 paisa/);
    await assert.rejects(raw(0, 1), /does not balance: 1 lines/);
    await assert.rejects(
      s.schema.sql`insert into journal_entries (entry_date, memo, source_type, source_id) values ('2026-09-10', 'empty', 'test', 'empty')`,
      /does not balance: 0 lines/,
    );
    await raw(10000);
    // A line added later to an entry that balanced is checked too.
    const [balanced] = await s.schema.sql<{ id: string }[]>`select id from journal_entries where memo = 'raw' order by id desc limit 1`;
    await assert.rejects(
      s.schema.sql`insert into journal_lines (entry_id, account_id, debit_paisa) values (${balanced!.id}, ${cash!.id}, 1)`,
      /does not balance: 3 lines, debits 10001 paisa, credits 10000 paisa/,
    );
    // Nothing half-posted survived the rejected ones.
    const [orphans] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from journal_entries e where not exists (select 1 from journal_lines l where l.entry_id = e.id)`;
    assert.equal(orphans?.n, 0);
    // A line is a debit or a credit, never both or neither.
    await assert.rejects(
      s.schema.sql.begin(async (tx) => {
        const [e] = await tx<{ id: string }[]>`insert into journal_entries (entry_date, memo, source_type, source_id) values ('2026-09-10', 'raw', 'test', 'both') returning id`;
        await tx`insert into journal_lines (entry_id, account_id, debit_paisa, credit_paisa) values (${e!.id}, ${cash!.id}, 100, 100)`;
      }),
      /check constraint/,
    );
  });

  it('entries are immutable: lines never change, an entry can only be marked reversed, once', async () => {
    const posted = await postEntry(s.schema.sql, { date: '2026-09-11', memo: 'test', source: { type: 'test', id: 'immutable' }, lines: payoutLines({ storeId: s.nur, postexAccountId: accountId, amount: p(10) }) });
    await assert.rejects(s.schema.sql`update journal_lines set debit_paisa = 1 where entry_id = ${posted!.id}`, /append-only/);
    await assert.rejects(s.schema.sql`delete from journal_lines where entry_id = ${posted!.id}`, /append-only/);
    await assert.rejects(s.schema.sql`update journal_entries set memo = 'edited' where id = ${posted!.id}`, /append-only/);
    const reversal = await reverseEntry(s.schema.sql, posted!.id, { date: '2026-09-12', memo: 'Typo' });
    assert.deepEqual(await entryPairs('reversal', posted!.id), ['Cr 1000 1000', 'Dr 1100 1000']);
    await assert.rejects(s.schema.sql`update journal_entries set reversed_by = ${reversal} where id = ${posted!.id}`, /append-only/);
    await assert.rejects(reverseEntry(s.schema.sql, posted!.id, { date: '2026-09-12', memo: 'again' }), AccountingError);
    // Posting the same source again is a no-op while it is live; after the reversal it posts anew.
    assert.equal((await postEntry(s.schema.sql, { date: '2026-09-12', memo: 'again', source: { type: 'test', id: 'immutable' }, lines: payoutLines({ storeId: s.nur, postexAccountId: accountId, amount: p(11) }) }))?.created, true);
  });

  it('delivered: sale, COGS of the units that left, and the forward charge, each exactly once', async () => {
    const orderId = await order({ total: 2750, tax: 250 });
    const id = await newParcel(orderId, [['0005', '2026-09-03T10:00:00Z']]);
    await charge(id, 'forward', 200);
    await charge(id, 'forward_tax', 32);
    await settleParcel(id);
    assert.deepEqual(await entryPairs('shipment_sale', id), ['Cr 2100 25000', 'Cr 4000 250000', 'Dr 1100 275000']);
    assert.deepEqual(await entryPairs('shipment_cogs', id), ['Cr 1300 90000', 'Dr 5000 90000'], '2 units at Rs 450');
    assert.deepEqual(await entryPairs('shipment_forward_charge', id), ['Cr 1100 23200', 'Dr 6000 20000', 'Dr 6020 3200']);
    const [sale] = await s.schema.sql`select entry_date::text as d from journal_entries where source_type = 'shipment_sale' and source_id = ${id}`;
    assert.equal(sale?.['d'], '2026-09-03', 'recognised on the delivery day, in Karachi');

    const before = await entries();
    const again = await postShipmentAccounting(s.schema.sql, id);
    assert.deepEqual(again.actions, { sale: 'unchanged', cogs: 'unchanged', forwardCharge: 'unchanged', returnCharge: 'none' });
    assert.equal(await entries(), before);
  });

  it('RETURNED AFTER DELIVERY: revenue and COGS are reversed, both PostEx charges are kept', async () => {
    const orderId = await order({ total: 3200, tax: 0, lines: [{ variantId: variants[1]!, qty: 1 }] });
    const id = await newParcel(orderId, [['0005', '2026-09-03T10:00:00Z']]);
    await charge(id, 'forward', 200);
    await charge(id, 'forward_tax', 32);
    await settleParcel(id);
    assert.deepEqual(await entryPairs('shipment_sale', id), ['Cr 4000 320000', 'Dr 1100 320000']);

    // The customer sends it back: PostEx starts the return, charges for it, and returns it.
    await addEvent(s.schema.sql, id, '0040', '2026-09-06T09:00:00Z');
    await addEvent(s.schema.sql, id, '0006', '2026-09-09T09:00:00Z');
    await charge(id, 'reversal', 150);
    await charge(id, 'reversal_tax', 24);
    await settleParcel(id);

    assert.deepEqual(await entryPairs('shipment_sale', id), [], 'no live sale');
    assert.deepEqual(await entryPairs('shipment_cogs', id), [], 'no live COGS');
    assert.equal(await reversalsOf('shipment_sale', id), 1);
    assert.equal(await reversalsOf('shipment_cogs', id), 1);
    const [sale] = await s.schema.sql<{ id: string }[]>`select id from journal_entries where source_type = 'shipment_sale' and source_id = ${id}`;
    assert.deepEqual(await entryPairs('reversal', sale!.id), ['Cr 1100 320000', 'Dr 4000 320000'], 'the sale exactly mirrored');
    const [cogs] = await s.schema.sql<{ id: string }[]>`select id from journal_entries where source_type = 'shipment_cogs' and source_id = ${id}`;
    assert.deepEqual(await entryPairs('reversal', cogs!.id), ['Cr 5000 55000', 'Dr 1300 55000'], 'the goods back in inventory');
    const [reversalDate] = await s.schema.sql`select entry_date::text as d from journal_entries where reverses_id = ${sale!.id}`;
    assert.equal(reversalDate?.['d'], '2026-09-06', 'dated by the return, not the sale');

    // Both charges stay: this is what the client's sheet gets wrong.
    assert.deepEqual(await entryPairs('shipment_forward_charge', id), ['Cr 1100 23200', 'Dr 6000 20000', 'Dr 6020 3200']);
    assert.deepEqual(await entryPairs('shipment_return_charge', id), ['Cr 1100 17400', 'Dr 6010 15000', 'Dr 6020 2400']);
    const [returnCharge] = await s.schema.sql`select entry_date::text as d from journal_entries where source_type = 'shipment_return_charge' and source_id = ${id}`;
    assert.equal(returnCharge?.['d'], '2026-09-06');
    const tb = await trialBalance(s.schema.sql, { storeId: s.nur });
    assert.equal(tb.debit, tb.credit);
  });

  it('refused and never delivered (S11): no revenue or COGS is ever posted, only the charges', async () => {
    const orderId = await order();
    const id = await newParcel(orderId, [['0013', '2026-09-02T09:00:00Z'], ['0040', '2026-09-03T09:00:00Z'], ['0006', '2026-09-07T09:00:00Z']]);
    await charge(id, 'reversal', 150);
    await charge(id, 'reversal_tax', 24);
    await settleParcel(id);
    const [any] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from journal_entries where source_type in ('shipment_sale', 'shipment_cogs') and source_id = ${id}`;
    assert.equal(any?.n, 0);
    assert.deepEqual(await entryPairs('shipment_return_charge', id), ['Cr 1100 17400', 'Dr 6010 15000', 'Dr 6020 2400']);
  });

  it('a damaged check-in writes off the cost of what came back', async () => {
    const orderId = await order({ lines: [{ variantId: variants[0]!, qty: 1 }] });
    const id = await newParcel(orderId, [['0040', '2026-09-03T09:00:00Z'], ['0006', '2026-09-07T09:00:00Z']]);
    await settleParcel(id);
    await checkInReturn(s.schema.sql, id, 'damaged', actor);
    await postShipmentAccounting(s.schema.sql, id);
    assert.deepEqual(await entryPairs('shipment_write_off', id), ['Cr 1300 45000', 'Dr 6200 45000']);
  });

  it('a PR parcel delivered: no sale; its goods and its charges are marketing (S10, S12)', async () => {
    const orderId = await order({ total: 0, channel: 'pr', lines: [{ variantId: variants[0]!, qty: 1 }] });
    const id = await newParcel(orderId, [['0005', '2026-09-03T10:00:00Z']]);
    await charge(id, 'forward', 200);
    await settleParcel(id);
    assert.deepEqual(await entryPairs('shipment_sale', id), []);
    assert.deepEqual(await entryPairs('shipment_cogs', id), ['Cr 1300 45000', 'Dr 6100 45000']);
    assert.deepEqual(await entryPairs('shipment_forward_charge', id), ['Cr 1100 20000', 'Dr 6100 20000']);
  });

  it('a fee PostEx corrects later: the old charge entry is reversed and the new one posted', async () => {
    const orderId = await order();
    const id = await newParcel(orderId, [['0005', '2026-09-03T10:00:00Z']]);
    await charge(id, 'forward', 200);
    await settleParcel(id);
    await charge(id, 'forward', 180);
    const result = await postShipmentAccounting(s.schema.sql, id);
    assert.equal(result.actions['forwardCharge'], 'reposted');
    assert.deepEqual(await entryPairs('shipment_forward_charge', id), ['Cr 1100 18000', 'Dr 6000 18000']);
    assert.equal(await reversalsOf('shipment_forward_charge', id), 1);
  });

  it('a missing cost queues the variant and holds COGS back; it posts once the cost exists', async () => {
    const [extra] = await variantsIn(s.schema.sql, s.nur, 1, 9_500);
    const orderId = await order({ lines: [{ variantId: extra!, qty: 3 }] });
    const id = await newParcel(orderId, [['0005', '2026-09-03T10:00:00Z']]);
    const first = await settleParcel(id);
    assert.equal(first.actions['cogs'], 'cost_missing');
    assert.deepEqual(await entryPairs('shipment_cogs', id), []);
    const [item] = await s.schema.sql`select detail from reconciliation_items where kind = 'cost_missing' and status = 'open'`;
    assert.equal((item?.['detail'] as Record<string, unknown>)['variantId'], extra);
    await s.schema.sql`insert into product_costs (variant_id, unit_cost_paisa, effective_from, source) values (${extra!}, '30000', '2026-08-01', 'manual')`;
    await postShipmentAccounting(s.schema.sql, id);
    assert.deepEqual(await entryPairs('shipment_cogs', id), ['Cr 1300 90000', 'Dr 5000 90000']);
  });

  it('the other posting functions write their exact pairs, once', async () => {
    await postVendorBill(s.schema.sql, { billId: 'VB-1', vendorId: '3', inventory: p(10_000), expense: p(0), tax: p(1600), date: '2026-09-15' });
    await postVendorPayment(s.schema.sql, { paymentId: 'VP-1', vendorId: '3', amount: p(11_600), date: '2026-09-16' });
    await postConsignmentSale(s.schema.sql, { saleId: 'CS-1', partnerId: '5', storeId: s.nur, net: p(5000), tax: p(0), cost: p(2000), date: '2026-09-17' });
    await postPartnerPayment(s.schema.sql, { paymentId: 'PP-1', partnerId: '5', storeId: s.nur, amount: p(5000), date: '2026-09-18' });
    assert.deepEqual(await entryPairs('vendor_bill', 'VB-1'), ['Cr 2000 1160000', 'Dr 1300 1000000', 'Dr 1400 160000']);
    assert.deepEqual(await entryPairs('vendor_payment', 'VP-1'), ['Cr 1000 1160000', 'Dr 2000 1160000']);
    assert.deepEqual(await entryPairs('consignment_sale', 'CS-1'), ['Cr 4000 500000', 'Dr 1200 500000']);
    assert.deepEqual(await entryPairs('consignment_cogs', 'CS-1'), ['Cr 1300 200000', 'Dr 5000 200000']);
    assert.deepEqual(await entryPairs('partner_payment', 'PP-1'), ['Cr 1200 500000', 'Dr 1000 500000']);
    const before = await entries();
    await postVendorBill(s.schema.sql, { billId: 'VB-1', vendorId: '3', inventory: p(10_000), expense: p(0), tax: p(1600), date: '2026-09-15' });
    assert.equal(await entries(), before);
  });

  it('posting into a closed period fails with a clear error; syncs roll forward to the next open month', async () => {
    await assert.rejects(closePeriod(s.schema.sql, { year: 2026, month: 8, actorId: actor, now: new Date('2026-09-04T10:00:00Z') }), /can be closed from 2026-09-05, not before/);
    await closePeriod(s.schema.sql, { year: 2026, month: 8, actorId: actor, now: new Date('2026-09-05T10:00:00Z') });
    await assert.rejects(closePeriod(s.schema.sql, { year: 2026, month: 8, actorId: actor, now: new Date('2026-09-06T10:00:00Z') }), /already closed/);

    const late = { date: '2026-08-30', memo: 'late', source: { type: 'test', id: 'late' }, lines: payoutLines({ storeId: s.nur, postexAccountId: accountId, amount: p(10) }) };
    await assert.rejects(postEntry(s.schema.sql, late), (error: unknown) => {
      assert.ok(error instanceof PeriodClosedError);
      assert.match(error.message, /Period 2026-08 is closed \(since 2026-09-05\): an entry dated 2026-08-30 cannot be posted; date it in the next open period/);
      return true;
    });
    // The database enforces it too, for anything that bypasses postEntry.
    await assert.rejects(s.schema.sql`insert into journal_entries (entry_date, memo, source_type, source_id) values ('2026-08-01', 'x', 'test', 'raw-closed')`, /Period 2026-08 is closed/);

    const rolled = await postEntry(s.schema.sql, { ...late, rollForward: true });
    assert.equal(rolled?.date, '2026-09-01');
    const [memo] = await s.schema.sql`select memo from journal_entries where id = ${rolled!.id}`;
    assert.match(String(memo?.['memo']), /event dated 2026-08-30, period closed/);

    await assert.rejects(s.schema.sql`update fiscal_periods set status = 'open', closed_at = null where year = 2026 and month = 8`, /cannot be reopened/);
    const [audit] = await s.schema.sql`select actor_id from audit_log where action = 'accounting.close_period' and entity_id = '2026-08'`;
    assert.equal(audit?.['actor_id'], actor);
  });
});

describe('trial balance after a replay of a few hundred mixed events', { skip: skipWithoutDb }, () => {
  it('sums to zero, every entry balances, COD receivable ties to PostEx (S14), and a second replay posts nothing', async (t) => {
    const s = await migratedWithStores();
    t.after(() => s.schema.drop());
    const logger = pino({ level: 'silent' }) as unknown as Logger;
    const actor = await testUser(s.schema.sql);
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    const variants = await variantsIn(s.schema.sql, s.nur, 3);
    for (const [i, v] of variants.entries()) {
      await s.schema.sql`insert into product_costs (variant_id, unit_cost_paisa, effective_from, source) values (${v}, ${String(40_000 + i * 5_000)}, '2026-01-01', 'manual')`;
    }

    // 300 parcels: delivered, refused and returned, open; one order in ten PR, one in seven prepaid with tax.
    const spec = { ...SPIKE, total: 300, delivered: 240, returned: 35, forwardFeeRupees: 57_000, returnFeeRupees: 8_400 };
    const parcels = syntheticParcels(spec);
    for (const [i, parcelRow] of parcels.entries()) {
      const id = await orderWithLines(s.schema.sql, {
        storeId: s.nur,
        number: String(parcelRow['orderRefNumber']),
        placedAt: new Date(`${String(parcelRow['transactionDate']).slice(0, 10)}T03:00:00Z`),
        totalPaisa: BigInt(String(parcelRow['invoicePayment'])) * 100n,
        channel: i % 10 === 9 ? 'pr' : 'online',
        lines: [{ variantId: variants[i % 3]!, qty: 1 + (i % 2) }],
      });
      if (i % 7 === 0) await s.schema.sql`update orders set tax_paisa = 10000 where id = ${id}`;
    }
    // A few delivered parcels are later returned by the customer.
    const returnedLater = [3, 50, 120].map((i) => String(parcels[i]!['trackingNumber']));
    const fake = fakePostex(parcels);
    const deps = { sql: s.schema.sql, logger, accounts: [{ key: 'nur', id: account!.id, source: fake }], historyFrom: '2026-05-01' };
    await syncPostex({ ...deps, now: () => new Date('2026-09-20T06:00:00Z') });
    fake.parcels = fake.parcels.map((row) =>
      returnedLater.includes(String(row['trackingNumber']))
        ? { ...row, transactionStatusHistory: [...(row['transactionStatusHistory'] as unknown[]), { transactionStatusMessage: 'Return initiated', transactionStatusMessageCode: '0040', updatedAt: '2026-09-21 10:00:00' }] }
        : row,
    );
    await syncPostex({ ...deps, now: () => new Date('2026-09-21T09:00:00Z'), tiers: { activeMs: 0, defaultMs: 0, staleAfterMs: 1e12, terminalWatchMs: 1e12, dailyMs: 0 } });
    await syncPayouts({ ...deps, batch: 1000 });

    // Check-ins (some damaged), and the events with no sync: bills, payments, consignment.
    const returned = await s.schema.sql<{ id: string }[]>`select id from shipments where status_code = '0006' order by id limit 20`;
    for (const [i, row] of returned.entries()) {
      await checkInReturn(s.schema.sql, row.id, i % 4 === 0 ? 'damaged' : 'restocked', actor);
      await postShipmentAccounting(s.schema.sql, row.id);
    }
    for (let i = 0; i < 20; i++) {
      await postVendorBill(s.schema.sql, { billId: `VB-${i}`, vendorId: String(1 + (i % 3)), inventory: p(20_000 + i), expense: p(i % 2 ? 750 : 0), tax: p(3_200), date: `2026-09-${String(1 + i).padStart(2, '0')}` });
      if (i % 2) await postVendorPayment(s.schema.sql, { paymentId: `VP-${i}`, vendorId: String(1 + (i % 3)), amount: p(23_200 + i), date: `2026-09-${String(2 + i).padStart(2, '0')}` });
      await postConsignmentSale(s.schema.sql, { saleId: `CS-${i}`, partnerId: '1', storeId: s.nur, net: p(4_000 + i * 10), tax: p(i % 3 ? 0 : 640), cost: p(1_800), date: `2026-09-${String(1 + i).padStart(2, '0')}` });
      if (i % 3 === 0) await postPartnerPayment(s.schema.sql, { paymentId: `PP-${i}`, partnerId: '1', storeId: s.nur, amount: p(4_000), date: `2026-09-${String(3 + i).padStart(2, '0')}` });
    }

    const [counts] = await s.schema.sql<{ entries: number; reversals: number }[]>`
      select count(*)::int as entries, count(*) filter (where source_type = 'reversal')::int as reversals from journal_entries
    `;
    assert.ok(counts!.entries >= 600, `a few hundred events: ${counts!.entries} entries`);
    assert.ok(counts!.reversals >= 6, 'the customer returns reversed their sale and COGS');

    const tb = await trialBalance(s.schema.sql);
    assert.equal(tb.debit, tb.credit, 'the trial balance sums to zero');
    const [unbalanced] = await s.schema.sql<{ n: number }[]>`
      select count(*)::int as n from (select entry_id from journal_lines group by entry_id having sum(debit_paisa) <> sum(credit_paisa)) x
    `;
    assert.equal(unbalanced?.n, 0);

    // S14: COD receivable = COD of parcels whose sale is live − PostEx charges − payouts, exactly.
    const [tie] = await s.schema.sql<{ ledger: string; expected: string }[]>`
      select
        (select coalesce(sum(l.debit_paisa - l.credit_paisa), 0) from journal_lines l join accounts a on a.id = l.account_id where a.code = '1100')::text as ledger,
        ((select coalesce(sum(s.cod_amount_paisa), 0) from shipments s
           where exists (select 1 from journal_entries e where e.source_type = 'shipment_sale' and e.source_id = s.id::text and e.reversed_by is null))
         - (select coalesce(sum(amount_paisa), 0) from shipment_charges)
         - (select coalesce(sum(amount_paisa), 0) from payout_lines))::text as expected
    `;
    assert.equal(tie?.ledger, tie?.expected);

    const before = counts!.entries;
    const replay = await replayAccounting(s.schema.sql);
    assert.deepEqual([replay.postings, replay.payoutLines], [0, 0]);
    const [afterReplay] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from journal_entries`;
    assert.equal(afterReplay?.n, before);
  });
});
