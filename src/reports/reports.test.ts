import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { postConsignmentSale, postPayoutLine, postShipmentAccounting } from '../domain/accounting.js';
import { reconcileShipmentStock } from '../domain/stock.js';
import { paisa } from '../lib/money.js';
import { skipWithoutDb } from '../test/db.js';
import { addEvent, orderWithLines, parcel, variantsIn } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import {
  REPORT_PLANS,
  breakdown,
  cashAwaitingPayout,
  deliveredRevenue,
  deliverySuccess,
  drillBreakdown,
  drillCashAwaitingPayout,
  drillDeliveredRevenue,
  drillDeliverySuccess,
  drillPartnerLedger,
  drillPnl,
  drillProductBreakdown,
  drillProfitPerParcel,
  drillReturnRate,
  drillTrialBalance,
  generalLedger,
  netProfit,
  partnerLedger,
  pnl,
  productBreakdown,
  profitPerParcel,
  returnRate,
  trialBalanceReport,
} from './index.js';

const rs = (rupees: number) => paisa(BigInt(rupees) * 100n);

describe('reports over one mixed dataset', { skip: skipWithoutDb }, () => {
  let s: Stores;
  const id: Record<string, string> = {};

  /** One order and its parcel, settled the way the sync settles it: stock, then the journal. */
  const parcelFor = async (
    key: string,
    o: { store?: 'nur' | 'organics'; total: number; channel?: 'online' | 'pr'; events: Array<[string, string]>; later?: Array<[string, string]>; city?: string; charges?: Array<[string, number]>; code?: string },
  ) => {
    const store = o.store === 'organics' ? s.organics : s.nur;
    const orderId = await orderWithLines(s.schema.sql, {
      storeId: store,
      number: `#${key}`,
      placedAt: new Date('2026-09-01T05:00:00Z'),
      totalPaisa: BigInt(o.total) * 100n,
      channel: o.channel ?? 'online',
      lines: [{ variantId: id[o.store === 'organics' ? 'organicsVariant' : 'nurVariant']!, qty: 2 }],
    });
    if (o.code) await s.schema.sql`update orders set discount_codes = ${[o.code]}::text[] where id = ${orderId}`;
    const shipmentId = await parcel(s.schema.sql, { accountId: id[o.store === 'organics' ? 'organicsAccount' : 'nurAccount']!, orderId, events: o.events });
    await s.schema.sql`update shipments set cod_amount_paisa = ${String(o.total * 100)}, city = ${o.city ?? 'Lahore'} where id = ${shipmentId}`;
    for (const [kind, rupees] of o.charges ?? []) {
      await s.schema.sql`insert into shipment_charges (shipment_id, kind, amount_paisa) values (${shipmentId}, ${kind}, ${String(rupees * 100)})`;
    }
    await reconcileShipmentStock(s.schema.sql, shipmentId);
    await postShipmentAccounting(s.schema.sql, shipmentId);
    // Steps that arrive on a later sync, as a customer's return after delivery does.
    if (o.later) {
      for (const [code, at] of o.later) await addEvent(s.schema.sql, shipmentId, code, at);
      await reconcileShipmentStock(s.schema.sql, shipmentId);
      await postShipmentAccounting(s.schema.sql, shipmentId);
    }
    id[key] = shipmentId;
    id[`${key}.order`] = orderId;
  };

  before(async () => {
    s = await migratedWithStores();
    const [nur] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR PostEx', ${s.nur}) returning id`;
    const [organics] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('organics', 'Organics PostEx', ${s.organics}) returning id`;
    id['nurAccount'] = nur!.id;
    id['organicsAccount'] = organics!.id;
    id['nurVariant'] = (await variantsIn(s.schema.sql, s.nur, 1))[0]!;
    id['organicsVariant'] = (await variantsIn(s.schema.sql, s.organics, 1, 9_500))[0]!;
    for (const v of [id['nurVariant'], id['organicsVariant']]) {
      await s.schema.sql`insert into product_costs (variant_id, unit_cost_paisa, effective_from, source) values (${v!}, '45000', '2026-01-01', 'manual')`;
    }

    const delivered = (day: string): Array<[string, string]> => [['0005', `${day}T10:00:00Z`]];
    await parcelFor('A', { total: 2750, events: delivered('2026-09-03'), charges: [['forward', 200], ['forward_tax', 32]] });
    await parcelFor('B', { total: 3200, events: delivered('2026-09-05'), charges: [['forward', 200], ['forward_tax', 32]] });
    await parcelFor('IN_TRANSIT', { total: 4100, events: [['0008', '2026-09-03T10:00:00Z']] });
    await parcelFor('REFUSED', { total: 2000, events: [['0013', '2026-09-02T09:00:00Z'], ['0040', '2026-09-03T09:00:00Z'], ['0006', '2026-09-07T09:00:00Z']], charges: [['reversal', 150], ['reversal_tax', 24]] });
    await parcelFor('PR_DELIVERED', { total: 0, channel: 'pr', events: delivered('2026-09-04'), charges: [['forward', 200]] });
    await parcelFor('PR_RETURNED', { total: 0, channel: 'pr', events: [['0040', '2026-09-03T09:00:00Z'], ['0006', '2026-09-06T09:00:00Z']] });
    await parcelFor('CUSTOMER_RETURN', { total: 1800, events: delivered('2026-09-03'), later: [['0040', '2026-09-08T09:00:00Z'], ['0006', '2026-09-10T09:00:00Z']] });
    await parcelFor('ORGANICS', { store: 'organics', total: 1500, events: delivered('2026-09-12'), city: 'Karachi', code: 'INF10' });
    // Placed and confirmed, never booked: no parcel at all.
    id['PLACED.order'] = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#PLACED', placedAt: new Date('2026-09-02T05:00:00Z'), totalPaisa: 990_000n, lines: [] });

    // PostEx pays out A: COD less its charges.
    const [payout] = await s.schema.sql<{ id: string }[]>`
      insert into cod_payouts (postex_account_id, cpr_number, paid_at, amount_paisa) values (${id['nurAccount']!}, 'CPR-1', '2026-09-10T07:00:00Z', 251800) returning id
    `;
    const [line] = await s.schema.sql<{ id: string }[]>`insert into payout_lines (cod_payout_id, shipment_id, amount_paisa) values (${payout!.id}, ${id['A']!}, 251800) returning id`;
    await postPayoutLine(s.schema.sql, line!.id);

    const [partner] = await s.schema.sql<{ id: string }[]>`insert into retail_partners (name, city) values ('Test Grocer', 'Lahore') returning id`;
    id['partner'] = partner!.id;
    await postConsignmentSale(s.schema.sql, { saleId: 'CS-1', partnerId: partner!.id, storeId: s.nur, net: rs(5000), tax: rs(0), cost: rs(2000), date: '2026-09-15' });
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('revenue counts delivered parcels only: placed and in-transit orders contribute zero', async () => {
    const revenue = await deliveredRevenue(s.schema.sql);
    // A 2,750 + B 3,200 + Organics 1,500; the customer return nets to zero; PR never sells.
    assert.equal(revenue.parcels, rs(7450));
    assert.equal(revenue.consignment, rs(5000));
    assert.equal(revenue.total, rs(12_450));
    assert.equal(revenue.parcelCount, 3);
    const drill = await drillDeliveredRevenue(s.schema.sql);
    for (const absent of ['IN_TRANSIT', 'REFUSED', 'PR_DELIVERED', 'PR_RETURNED']) assert.ok(!drill.shipmentIds.includes(id[absent]!), absent);
    assert.deepEqual(drill.consignmentSaleIds, ['CS-1']);
    // The placed order's Rs 9,900 and the in-transit Rs 4,100 are nowhere in the revenue entries.
    const [behind] = await s.schema.sql<{ n: number }[]>`
      select count(*)::int as n from ledger_lines where account_code = '4000' and shipment_id = ${id['IN_TRANSIT']!}
    `;
    assert.equal(behind?.n, 0);
    assert.equal((await deliveredRevenue(s.schema.sql, { store: 'organics' })).total, rs(1500));
    assert.equal((await deliveredRevenue(s.schema.sql, { to: '2026-09-04' })).parcels, rs(4550), 'A and the customer return (not yet reversed by then)');
  });

  it('PR parcels are excluded from sales and from the return rate', async () => {
    const drill = await drillDeliveredRevenue(s.schema.sql);
    assert.ok(!drill.shipmentIds.includes(id['PR_DELIVERED']!));
    const rr = await returnRate(s.schema.sql);
    // Delivered A, B, Organics; returned: refused and customer return. The PR return is not counted.
    assert.deepEqual(rr, { count: 2, of: 5, rate: 0.4 });
    assert.deepEqual((await drillReturnRate(s.schema.sql)).shipmentIds.sort(), [id['REFUSED']!, id['CUSTOMER_RETURN']!].sort());
    const ds = await deliverySuccess(s.schema.sql);
    assert.deepEqual([ds.counts.booked, ds.success.count, ds.success.of, ds.firstAttempt.rate], [6, 3, 5, 1]);
    assert.deepEqual((await drillDeliverySuccess(s.schema.sql, {}, 'in_flight')).shipmentIds, [id['IN_TRANSIT']!]);
  });

  it('report totals tie to the ledger: P&L revenue equals the revenue account, and the breakdowns add up to the P&L', async () => {
    const report = await pnl(s.schema.sql);
    const [ledger] = await s.schema.sql<{ revenue: string; income: string; expenses: string }[]>`
      select (select coalesce(sum(l.credit_paisa - l.debit_paisa), 0) from journal_lines l join accounts a on a.id = l.account_id where a.code = '4000')::text as revenue,
             (select coalesce(sum(l.credit_paisa - l.debit_paisa), 0) from journal_lines l join accounts a on a.id = l.account_id where a.type = 'income')::text as income,
             (select coalesce(sum(l.debit_paisa - l.credit_paisa), 0) from journal_lines l join accounts a on a.id = l.account_id where a.type = 'expense')::text as expenses
    `;
    assert.equal(report.rows.find((r) => r.code === '4000')?.amount, BigInt(ledger!.revenue));
    assert.equal(report.income, BigInt(ledger!.income));
    assert.equal(report.expenses, BigInt(ledger!.expenses));
    assert.equal((await deliveredRevenue(s.schema.sql)).total, BigInt(ledger!.revenue), 'delivered revenue is the revenue account');
    assert.equal((await netProfit(s.schema.sql)).netProfit, report.netProfit);

    for (const dimension of ['store', 'month', 'city', 'influencer', 'agent'] as const) {
      const rows = await breakdown(s.schema.sql, dimension);
      assert.equal(rows.reduce((t, r) => t + r.revenue, 0n), report.income, `${dimension} revenue`);
      assert.equal(rows.reduce((t, r) => t + r.profit, 0n), report.netProfit, `${dimension} profit`);
    }
    const byMonth = await pnl(s.schema.sql, {}, { byMonth: true });
    assert.equal(byMonth.netProfit, report.netProfit);
    assert.ok((await drillPnl(s.schema.sql, {}, '4000')).entryIds.length >= 4);
  });

  it('breaks down by brand, city, partner and influencer code, each with its drill-down', async () => {
    const stores = await breakdown(s.schema.sql, 'store');
    assert.deepEqual(stores.map((r) => [r.key, r.revenue]), [['nur', rs(10_950)], ['organics', rs(1500)]]);
    const cities = await breakdown(s.schema.sql, 'city');
    assert.equal(cities.find((r) => r.key === 'karachi')?.revenue, rs(1500));
    const partners = await breakdown(s.schema.sql, 'partner');
    assert.deepEqual(partners.map((r) => [r.key, r.label, r.revenue, r.goods]), [[id['partner'], 'Test Grocer', rs(5000), rs(2000)]]);
    const influencers = await breakdown(s.schema.sql, 'influencer');
    assert.equal(influencers.find((r) => r.key === 'inf10')?.revenue, rs(1500));
    assert.deepEqual((await drillBreakdown(s.schema.sql, 'influencer', 'inf10')).shipmentIds, [id['ORGANICS']!]);
    assert.deepEqual((await breakdown(s.schema.sql, 'agent')).map((r) => r.label), ['(not recorded)']);

    const products = await productBreakdown(s.schema.sql, { store: 'nur' });
    assert.deepEqual(products.map((p) => [p.units, p.goodsCost]), [[4, rs(1800)]], 'A and B, two units each at Rs 450');
    assert.deepEqual((await drillProductBreakdown(s.schema.sql, id['nurVariant']!)).orderIds.sort(), [id['A.order']!, id['B.order']!].sort());
  });

  it('cash awaiting payout, aged by days since delivery, with charges on parcels with no sale kept apart', async () => {
    const cash = await cashAwaitingPayout(s.schema.sql, { to: '2026-09-20' });
    const bucket = (b: string) => cash.buckets.find((x) => x.bucket === b)!;
    // B: 3,200 − 232, delivered 15 days before. Organics: 1,500, 8 days. A was paid out in full.
    assert.deepEqual([bucket('15-30').parcels, bucket('15-30').amount], [1, rs(2968)]);
    assert.deepEqual([bucket('8-14').parcels, bucket('8-14').amount], [1, rs(1500)]);
    // The refused parcel's return charge (174) and the PR parcel's forward charge (200): owed to PostEx.
    assert.deepEqual([bucket('no_sale').parcels, bucket('no_sale').amount], [2, paisa(-37_400n)]);
    assert.deepEqual([cash.awaiting, cash.owedToPostex], [rs(4468), paisa(-37_400n)]);
    assert.deepEqual((await drillCashAwaitingPayout(s.schema.sql, { to: '2026-09-20' }, '15-30')).shipmentIds, [id['B']!]);
    // Before PostEx paid A, A was still awaited; the customer return was already reversed (09-08).
    assert.equal((await cashAwaitingPayout(s.schema.sql, { to: '2026-09-09' })).awaiting, rs(2518 + 2968));
    assert.equal((await cashAwaitingPayout(s.schema.sql, { to: '2026-09-07' })).awaiting, rs(2518 + 2968 + 1800));
  });

  it('profit per parcel from its own lines: revenue less goods, PostEx charges and write-offs', async () => {
    const report = await profitPerParcel(s.schema.sql);
    const row = (key: string) => report.rows.find((r) => r.shipmentId === id[key])!;
    assert.deepEqual([row('A').revenue, row('A').goods, row('A').postexCharges, row('A').profit], [rs(2750), rs(900), rs(232), rs(1618)]);
    assert.deepEqual([row('CUSTOMER_RETURN').revenue, row('CUSTOMER_RETURN').goods, row('CUSTOMER_RETURN').profit], [rs(0), rs(0), rs(0)]);
    assert.deepEqual([row('REFUSED').revenue, row('REFUSED').profit], [rs(0), rs(-174)]);
    assert.deepEqual([row('PR_DELIVERED').marketing, row('PR_DELIVERED').profit], [rs(1100), rs(-1100)]);
    assert.equal(report.total, report.rows.reduce((t, r) => t + r.profit, 0n));
    assert.ok((await drillProfitPerParcel(s.schema.sql, {}, id['A']!)).entryIds.length === 3, 'sale, COGS and forward charge');
  });

  it('trial balance, general ledger and partner ledger agree with each other', async () => {
    const tb = await trialBalanceReport(s.schema.sql, { from: '2026-09-06' });
    assert.equal(tb.debit, tb.credit);
    const receivable = tb.rows.find((r) => r.code === '1100')!;
    const gl = await generalLedger(s.schema.sql, '1100', { from: '2026-09-06' });
    assert.deepEqual([gl.opening, gl.closing], [receivable.opening, receivable.closing]);
    const partners = await partnerLedger(s.schema.sql);
    const postex = partners.filter((p) => p.partnerType === 'postex_account').reduce((t, p) => t + p.closing, 0n);
    const full = (await trialBalanceReport(s.schema.sql)).rows.find((r) => r.code === '1100')!;
    assert.equal(postex, full.closing, 'the PostEx accounts owe exactly the COD receivable');
    assert.equal(partners.find((p) => p.partnerType === 'retail_partner')?.closing, rs(5000));
    assert.ok((await drillPartnerLedger(s.schema.sql, {}, { type: 'retail_partner', id: id['partner']! })).entryIds.length === 1);
    assert.ok((await drillTrialBalance(s.schema.sql, {}, '4000')).entryIds.length >= 4);
  });

  it('EXPLAIN: every report plans, uses the indexes it declares, and never seq-scans a ledger or parcel table', async () => {
    const big = new Set(['journal_lines', 'journal_entries', 'shipments', 'orders', 'order_lines', 'payout_lines', 'stock_moves', 'product_costs']);
    const filter = { from: '2026-09-01', to: '2026-09-30', store: 'nur' as const };
    for (const [name, { plan, needs }] of Object.entries(REPORT_PLANS)) {
      const nodes: Array<Record<string, unknown>> = [];
      await s.schema.sql.begin(async (tx) => {
        // Tiny test tables make a sequential scan the cheapest plan; forbidding it shows whether an index path exists.
        await tx`set local enable_seqscan = off`;
        const [row] = (await plan(tx as never, filter)) as Array<{ 'QUERY PLAN': unknown }>;
        const walk = (node: unknown): void => {
          if (Array.isArray(node)) return node.forEach(walk);
          if (node && typeof node === 'object') {
            nodes.push(node as Record<string, unknown>);
            Object.values(node).forEach(walk);
          }
        };
        walk(row!['QUERY PLAN']);
      });
      const seq = nodes.filter((n) => n['Node Type'] === 'Seq Scan' && big.has(String(n['Relation Name']))).map((n) => n['Relation Name']);
      assert.deepEqual(seq, [], `${name} seq-scans ${seq.join(', ')}`);
      const used = new Set(nodes.map((n) => n['Index Name']).filter((x): x is string => typeof x === 'string'));
      assert.ok(used.size > 0, `${name} uses an index`);
      for (const index of needs) assert.ok(used.has(index), `${name} needs ${index}; its plan used ${[...used].sort().join(', ')}`);
    }
  });
});
