import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { postConsignmentSale, postPayoutLine, postShipmentAccounting } from '../domain/accounting.js';
import { classifyPrSend, detectPrSends, listPrSends } from '../domain/pr.js';
import { reconcileShipmentStock } from '../domain/stock.js';
import { paisa } from '../lib/money.js';
import { skipWithoutDb } from '../test/db.js';
import { addEvent, orderWithLines, parcel, testUser, variantsIn } from '../test/inventory.js';
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
    await parcelFor('ORGANICS', { store: 'organics', total: 1500, events: delivered('2026-09-12'), city: 'Karachi', code: 'inf10' });
    // INF10 is an influencer's code on Organics (typed lower-case at checkout); B used a code nobody owns.
    const [influencer] = await s.schema.sql<{ id: string }[]>`insert into influencers (handle, name) values ('test.creator', 'Test Creator') returning id`;
    id['influencer'] = influencer!.id;
    await s.schema.sql`insert into influencer_codes (influencer_id, store_id, discount_code) values (${influencer!.id}, ${s.organics}, 'INF10')`;
    await s.schema.sql`update orders set discount_codes = '{WELCOME5}' where id = ${id['B.order']!}`;
    // Agent Test confirmed A at the desk.
    const [agent] = await s.schema.sql<{ id: string }[]>`insert into users (email, name, role) values ('agent@example.com', 'Agent Test', 'agent') returning id`;
    id['agent'] = agent!.id;
    const [cf] = await s.schema.sql<{ id: string }[]>`
      insert into confirmations (order_id, state, source, agent_id, attempts, confirmed_at) values (${id['A.order']!}, 'confirmed', 'desk', ${agent!.id}, 1, '2026-09-01T06:00:00Z') returning id
    `;
    await s.schema.sql`insert into confirmation_attempts (confirmation_id, agent_id, channel, at, outcome) values (${cf!.id}, ${agent!.id}, 'call', '2026-09-01T06:00:00Z', 'confirmed')`;
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
    const creator = influencers.find((r) => r.key === `influencer:${id['influencer']}`);
    assert.deepEqual([creator?.label, creator?.revenue], ['Test Creator (@test.creator)', rs(1500)], 'the code resolves to its influencer, whatever its case');
    assert.deepEqual(
      [influencers.find((r) => r.key === 'code:welcome5')?.label, influencers.find((r) => r.key === 'code:welcome5')?.revenue],
      ['WELCOME5 (unassigned code)', rs(3200)],
    );
    assert.deepEqual((await drillBreakdown(s.schema.sql, 'influencer', `influencer:${id['influencer']}`)).shipmentIds, [id['ORGANICS']!]);

    const agents = await breakdown(s.schema.sql, 'agent');
    assert.deepEqual(agents.find((r) => r.key === id['agent'])?.label, 'Agent Test');
    assert.deepEqual([agents.find((r) => r.key === id['agent'])?.revenue, agents.find((r) => r.key === id['agent'])?.parcels], [rs(2750), 1]);
    assert.equal(agents.find((r) => r.key === '-')?.label, '(not confirmed at the desk)');
    assert.deepEqual((await drillBreakdown(s.schema.sql, 'agent', id['agent']!)).shipmentIds, [id['A']!]);

    const products = await productBreakdown(s.schema.sql, { store: 'nur' });
    // A and B delivered, two units each; the customer return delivered two and took them back.
    assert.deepEqual(products.rows.map((p) => [p.key, p.units, p.revenue, p.goods]), [[id['nurVariant'], 4, rs(5950), rs(1800)]]);
    assert.equal(products.revenue, (await deliveredRevenue(s.schema.sql, { store: 'nur' })).parcels, 'the rows add up to the ledger');
    const early = await productBreakdown(s.schema.sql, { store: 'nur', to: '2026-09-04' });
    assert.deepEqual(early.rows.map((p) => [p.units, p.revenue]), [[4, rs(4550)]], 'before the return: A and the customer return');
    assert.deepEqual(
      (await drillProductBreakdown(s.schema.sql, id['nurVariant']!, { store: 'nur' })).orderIds.sort(),
      [id['A.order']!, id['B.order']!, id['CUSTOMER_RETURN.order']!].sort(),
    );
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

describe('product breakdown: each parcel\'s ledger lines split across its items, exactly', { skip: skipWithoutDb }, () => {
  it('rows add up to the parcels\' revenue and COGS in the ledger for any filter, shipping and discounts included', async (t) => {
    const s = await migratedWithStores();
    t.after(() => s.schema.drop());
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    const [serum, cream] = await variantsIn(s.schema.sql, s.nur, 2);
    await s.schema.sql`insert into product_costs (variant_id, unit_cost_paisa, effective_from, source) values (${serum!}, '40000', '2026-01-01', 'manual'), (${cream!}, '25000', '2026-01-01', 'manual')`;

    /** Lines are [variant or null, qty, line total in rupees]; the order total adds shipping on top. */
    const deliveredOrder = async (number: string, total: number, lines: Array<[string | null, number, number]>, events: Array<[string, string]>) => {
      const orderId = await orderWithLines(s.schema.sql, {
        storeId: s.nur,
        number,
        placedAt: new Date('2026-09-01T05:00:00Z'),
        totalPaisa: BigInt(total) * 100n,
        lines: lines.map(([variantId, qty]) => ({ variantId, qty })),
      });
      for (const [i, [, , rupees]] of lines.entries()) {
        await s.schema.sql`update order_lines set total_paisa = ${String(rupees * 100)} where order_id = ${orderId} and line_key = ${`line:${i}`}`;
      }
      const shipmentId = await parcel(s.schema.sql, { accountId: account!.id, orderId, events });
      await s.schema.sql`update shipments set cod_amount_paisa = ${String(total * 100)} where id = ${shipmentId}`;
      await reconcileShipmentStock(s.schema.sql, shipmentId);
      await postShipmentAccounting(s.schema.sql, shipmentId);
      return shipmentId;
    };

    // Rs 2,000 of serum and Rs 1,000 of cream, plus Rs 200 shipping: revenue 3,200 splits 2,133.33 / 1,066.67.
    await deliveredOrder('#P1', 3200, [[serum!, 2, 2000], [cream!, 1, 1000]], [['0005', '2026-09-03T10:00:00Z']]);
    // A custom item nobody linked to a product.
    await deliveredOrder('#P2', 1500, [[serum!, 1, 1000], [null, 1, 500]], [['0005', '2026-09-04T10:00:00Z']]);
    // Delivered in September, returned in October.
    await deliveredOrder('#P3', 999, [[cream!, 3, 999]], [['0005', '2026-09-20T10:00:00Z'], ['0040', '2026-10-02T10:00:00Z']]);

    const all = await productBreakdown(s.schema.sql);
    const row = (key: string) => all.rows.find((r) => r.key === key)!;
    assert.deepEqual([row(serum!).units, row(serum!).revenue, row(serum!).goods], [3, paisa(313_333n), rs(1200)]);
    assert.deepEqual([row(cream!).units, row(cream!).revenue, row(cream!).goods], [1, paisa(106_667n), rs(250)], 'the return took its three units back out');
    assert.deepEqual([row('unmapped').units, row('unmapped').revenue, row('unmapped').title], [1, rs(500), '(items not linked to a product)']);

    for (const filter of [{}, { to: '2026-09-30' }, { from: '2026-10-01' }, { from: '2026-09-04', to: '2026-09-04' }, { store: 'organics' as const }]) {
      const report = await productBreakdown(s.schema.sql, filter);
      const ledger = await deliveredRevenue(s.schema.sql, filter);
      assert.equal(report.revenue, ledger.parcels, `ledger revenue ${JSON.stringify(filter)}`);
      assert.equal(report.rows.reduce((total, r) => total + r.revenue, 0n), report.revenue, `rows add up ${JSON.stringify(filter)}`);
      assert.equal(report.rows.reduce((total, r) => total + r.goods, 0n), report.goods, `goods add up ${JSON.stringify(filter)}`);
      const [cogs] = await s.schema.sql<{ v: string }[]>`
        select coalesce(sum(debit_paisa - credit_paisa), 0)::text as v from ledger_lines l where l.account_code = '5000' and l.origin_type = 'shipment_cogs'
          ${filter.from ? s.schema.sql`and l.entry_date >= ${filter.from}::date` : s.schema.sql``} ${filter.to ? s.schema.sql`and l.entry_date <= ${filter.to}::date` : s.schema.sql``}
          ${filter.store ? s.schema.sql`and l.store_id = (select id from stores where key = ${filter.store})` : s.schema.sql``}
      `;
      assert.equal(report.goods, BigInt(cogs!.v), `ledger COGS ${JSON.stringify(filter)}`);
    }
    const october = await productBreakdown(s.schema.sql, { from: '2026-10-01' });
    assert.deepEqual(october.rows.map((r) => [r.key, r.units, r.revenue]), [[cream!, -3, rs(-999)]], 'the return lands in October');
  });
});

describe('PR classified by a person: out of revenue, the return rate and delivery success', { skip: skipWithoutDb }, () => {
  it('two zero-COD parcels on ordinary orders count until a person classifies them as PR, then neither does', async (t) => {
    const s = await migratedWithStores();
    t.after(() => s.schema.drop());
    const actor = await testUser(s.schema.sql);
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    const [variant] = await variantsIn(s.schema.sql, s.nur, 1);
    await s.schema.sql`insert into product_costs (variant_id, unit_cost_paisa, effective_from, source) values (${variant!}, '45000', '2026-01-01', 'manual')`;
    const sale = async (number: string, cod: number, events: Array<[string, string]>) => {
      const orderId = await orderWithLines(s.schema.sql, { storeId: s.nur, number, placedAt: new Date('2026-09-01T05:00:00Z'), totalPaisa: BigInt(cod) * 100n, lines: [{ variantId: variant!, qty: 1 }] });
      const shipmentId = await parcel(s.schema.sql, { accountId: account!.id, orderId, events });
      await s.schema.sql`update shipments set cod_amount_paisa = ${String(cod * 100)} where id = ${shipmentId}`;
      await reconcileShipmentStock(s.schema.sql, shipmentId);
      await postShipmentAccounting(s.schema.sql, shipmentId);
      return shipmentId;
    };
    await sale('#S1', 2500, [['0005', '2026-09-03T10:00:00Z']]);
    await sale('#S2', 2000, [['0013', '2026-09-02T10:00:00Z'], ['0040', '2026-09-03T10:00:00Z'], ['0006', '2026-09-06T10:00:00Z']]);
    // A PR package sent as an order with a price, COD waived: delivered. Another refused at the door.
    const delivered = await sale('#PR1', 0, [['0005', '2026-09-04T10:00:00Z']]);
    const refused = await sale('#PR2', 0, [['0013', '2026-09-04T10:00:00Z'], ['0040', '2026-09-05T10:00:00Z'], ['0006', '2026-09-08T10:00:00Z']]);
    await s.schema.sql`update orders set total_paisa = 300000 where order_number in ('#PR1', '#PR2')`;
    for (const id of [delivered, refused]) await postShipmentAccounting(s.schema.sql, id);

    const figures = async () => ({
      revenue: (await deliveredRevenue(s.schema.sql)).parcels,
      returnRate: await returnRate(s.schema.sql),
      success: (await deliverySuccess(s.schema.sql)).success,
      revenueParcels: (await drillDeliveredRevenue(s.schema.sql)).shipmentIds,
    });
    const before = await figures();
    assert.deepEqual([before.returnRate.of, before.success.of], [4, 4], 'unclassified, they count like any parcel');
    assert.ok(before.revenueParcels.includes(delivered), 'the zero-COD parcel on a priced order is a sale until classified');

    await detectPrSends(s.schema.sql);
    const suggestions = await listPrSends(s.schema.sql, { status: 'suggested' });
    assert.equal(suggestions.length, 2);
    for (const send of suggestions) await classifyPrSend(s.schema.sql, { sendId: send.id, classification: 'pr', actorId: actor });

    const after = await figures();
    assert.equal(after.revenue, rs(2500), 'revenue: the one real sale');
    const [net] = await s.schema.sql<{ v: string }[]>`select coalesce(sum(credit_paisa - debit_paisa), 0)::text as v from ledger_lines where account_code = '4000' and shipment_id = ${delivered}`;
    assert.equal(net?.v, '0', 'its earlier sale is reversed: it nets to nothing');
    assert.deepEqual(after.returnRate, { count: 1, of: 2, rate: 0.5 }, 'return rate: the refused PR package is not a lost sale');
    assert.deepEqual([after.success.count, after.success.of], [1, 2], 'delivery success: the PR parcels are out');
    assert.ok(!(await drillReturnRate(s.schema.sql)).shipmentIds.includes(refused));
  });
});
