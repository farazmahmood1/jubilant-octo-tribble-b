import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';

import { recomputeOrderState } from '../db/repos/order-state.js';
import { syncPostex } from '../jobs/postex.js';
import type { Logger } from '../logger.js';
import { skipWithoutDb } from '../test/db.js';
import { orderWithLines, parcel, testUser, variantsIn } from '../test/inventory.js';
import { SPIKE, fakePostex, syntheticParcels } from '../test/postex-fake.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { postShipmentAccounting } from './accounting.js';
import { addPost, classifyPrSend, createPrSend, detectPrSends, listPosts, listPrSends } from './pr.js';
import { reconcileShipmentStock } from './stock.js';

describe('PR detection over the spike-sized history', { skip: skipWithoutDb }, () => {
  it('finds exactly the 54 zero-COD parcels, as suggestions; a second run adds nothing; a person\'s decision is never overridden', async (t) => {
    const s = await migratedWithStores();
    t.after(() => s.schema.drop());
    const actor = await testUser(s.schema.sql);
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    // The spike's 1,073 parcels, 54 of them with zero COD (PR, gifts or replacements), spread through the history.
    const parcels = syntheticParcels(SPIKE).map((p, i) => (i % 19 === 7 && i < 19 * 54 ? { ...p, invoicePayment: 0 } : p));
    assert.equal(parcels.filter((p) => p['invoicePayment'] === 0).length, 54);
    await syncPostex({
      sql: s.schema.sql,
      logger: pino({ level: 'silent' }) as unknown as Logger,
      accounts: [{ key: 'nur', id: account!.id, source: fakePostex(parcels) }],
      historyFrom: '2026-05-01',
      now: () => new Date('2026-09-20T06:00:00Z'),
    });

    const first = await detectPrSends(s.schema.sql);
    assert.deepEqual(first, { tagged: 0, fullDiscount: 0, zeroCod: 54 });
    const suggested = await listPrSends(s.schema.sql, { status: 'suggested' });
    assert.equal(suggested.length, 54);
    assert.ok(suggested.every((r) => r.detectedBy === 'zero_cod' && r.classification === null), 'suggested, never assumed to be PR');
    const [pr] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from shipments where shipment_is_pr(id)`;
    assert.equal(pr?.n, 0, 'nothing is PR until a person says so');

    // A person classifies: two PR, one replacement, one "not PR".
    const decisions = ['pr', 'pr', 'replacement', 'not_pr'] as const;
    for (const [i, classification] of decisions.entries()) await classifyPrSend(s.schema.sql, { sendId: suggested[i]!.id, classification, actorId: actor });
    const snapshot = async () => s.schema.sql`select id, classification, decided_by, updated_at from pr_sends order by id`;
    const before = await snapshot();
    assert.deepEqual(await detectPrSends(s.schema.sql), { tagged: 0, fullDiscount: 0, zeroCod: 0 }, 'idempotent');
    assert.deepEqual(await snapshot(), before, 'no row touched, decided or not');
    assert.equal((await listPrSends(s.schema.sql, { status: 'suggested' })).length, 50);
    const [nowPr] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from shipments where shipment_is_pr(id)`;
    assert.equal(nowPr?.n, 2);
  });
});

describe('PR sends in the books', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let actor: string;
  let account: string;
  let variant: string;
  let influencer: string;
  let n = 0;

  before(async () => {
    s = await migratedWithStores();
    actor = await testUser(s.schema.sql);
    const [a] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    account = a!.id;
    [variant] = (await variantsIn(s.schema.sql, s.nur, 1)) as [string];
    await s.schema.sql`insert into product_costs (variant_id, unit_cost_paisa, effective_from, source) values (${variant}, '45000', '2026-01-01', 'manual')`;
    const [i] = await s.schema.sql<{ id: string }[]>`insert into influencers (handle, name) values ('test.creator', 'Test Creator') returning id`;
    influencer = i!.id;
  });

  after(async () => {
    await s?.schema.drop();
  });

  const account6100 = async (shipmentId: string) =>
    BigInt((await s.schema.sql<{ v: string }[]>`select coalesce(sum(debit_paisa - credit_paisa), 0)::text as v from ledger_lines where account_code = '6100' and shipment_id = ${shipmentId}`)[0]!.v);
  const live = async (shipmentId: string, type: string) =>
    (await s.schema.sql<{ code: string }[]>`
      select a.code from journal_entries e join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
      where e.source_type = ${type} and e.source_id = ${shipmentId} and e.reversed_by is null and l.debit_paisa > 0
    `).map((r) => r.code);
  const quant = async (key: string) =>
    (await s.schema.sql<{ q: number }[]>`select coalesce(sum(q.qty), 0)::int as q from stock_quants q join locations l on l.id = q.location_id where l.key = ${key} and q.variant_id = ${variant}`)[0]!.q;

  /** An order zero-priced in Shopify, its zero-COD parcel delivered, settled as the sync settles it. */
  const freeParcel = async (tags: string[] = []) => {
    const orderId = await orderWithLines(s.schema.sql, { storeId: s.nur, number: `#PR${++n}`, placedAt: new Date('2026-09-01T05:00:00Z'), totalPaisa: 0n, lines: [{ variantId: variant, qty: 2 }] });
    await s.schema.sql`update orders set subtotal_paisa = 500000, tags = ${tags}::text[] where id = ${orderId}`;
    if (tags.includes('PR')) await s.schema.sql`update orders set channel = 'pr' where id = ${orderId}`;
    const shipmentId = await parcel(s.schema.sql, { accountId: account, orderId, events: [['0005', '2026-09-03T10:00:00Z']] });
    await s.schema.sql`update shipments set cod_amount_paisa = 0 where id = ${shipmentId}`;
    await s.schema.sql`insert into shipment_charges (shipment_id, kind, amount_paisa) values (${shipmentId}, 'forward', 20000)`;
    await reconcileShipmentStock(s.schema.sql, shipmentId);
    await postShipmentAccounting(s.schema.sql, shipmentId);
    await recomputeOrderState(s.schema.sql, orderId);
    return { orderId, shipmentId };
  };

  it('detects a PR-tagged order as PR, and a zero-priced one as a suggestion only', async () => {
    const tagged = await freeParcel(['PR']);
    const free = await freeParcel();
    const stats = await detectPrSends(s.schema.sql);
    assert.deepEqual(stats, { tagged: 1, fullDiscount: 1, zeroCod: 0 }, 'the parcels are covered by their orders');
    const rows = await listPrSends(s.schema.sql);
    assert.equal(rows.find((r) => r.orderId === tagged.orderId)?.classification, 'pr');
    assert.equal(rows.find((r) => r.orderId === free.orderId)?.classification, null);
    await assert.rejects(
      classifyPrSend(s.schema.sql, { sendId: rows.find((r) => r.orderId === tagged.orderId)!.id, classification: 'gift', actorId: actor }),
      /tagged PR in Shopify/,
    );
  });

  it('CLASSIFIED PR: goods and PostEx charges become marketing, there is no sale, the order is PR; changing one\'s mind undoes it', async () => {
    const { orderId, shipmentId } = await freeParcel();
    await detectPrSends(s.schema.sql);
    const send = (await listPrSends(s.schema.sql)).find((r) => r.orderId === orderId)!;
    // Before a decision it is an ordinary zero-priced sale: COGS, delivery expense.
    assert.deepEqual(await live(shipmentId, 'shipment_cogs'), ['5000']);
    assert.deepEqual(await live(shipmentId, 'shipment_forward_charge'), ['6000']);

    await classifyPrSend(s.schema.sql, { sendId: send.id, classification: 'pr', influencerId: influencer, actorId: actor });
    assert.deepEqual(await live(shipmentId, 'shipment_cogs'), ['6100'], 'goods to marketing');
    assert.deepEqual(await live(shipmentId, 'shipment_forward_charge'), ['6100'], 'charges to marketing');
    assert.deepEqual(await live(shipmentId, 'shipment_sale'), [], 'no sale');
    assert.equal(await account6100(shipmentId), 90_000n + 20_000n);
    assert.equal((await s.schema.sql<{ state: string }[]>`select state from orders where id = ${orderId}`)[0]!.state, 'pr');
    const marketingUnits = await quant('marketing');
    assert.ok(marketingUnits >= 2, 'its units are in marketing, not with a customer');
    const row = (await listPrSends(s.schema.sql, { status: 'pr' })).find((r) => r.id === send.id)!;
    assert.deepEqual([row.influencer, row.marketing, row.decidedBy], ['Test Creator', 110_000n, 'Ops tester']);

    await classifyPrSend(s.schema.sql, { sendId: send.id, classification: 'replacement', actorId: actor });
    assert.deepEqual(await live(shipmentId, 'shipment_cogs'), ['5000'], 'a replacement is a cost of sales, not marketing');
    assert.equal(await quant('marketing'), marketingUnits - 2);
    const audit = await s.schema.sql<{ after: { from: string; to: string } }[]>`select after from audit_log where action = 'pr_send.classify' and entity_id = ${send.id} order by id`;
    assert.deepEqual(audit.map((a) => [a.after.from, a.after.to]), [[null, 'pr'], ['pr', 'replacement']]);
  });

  it('a send entered by hand with its goods: warehouse → marketing, expensed at cost; posts are recorded once', async () => {
    await s.schema.sql`
      insert into stock_moves (variant_id, qty, from_location_id, to_location_id, reason, ref_type, ref_id, occurred_at)
      select ${variant}, 10, (select id from locations where key = 'adjustment'), (select id from locations where key = 'warehouse'), 'test stock', 'test', 'pr-stock', '2026-08-01T00:00:00Z'
    `;
    const warehouse = await quant('warehouse');
    const id = await createPrSend(s.schema.sql, { influencerId: influencer, sentAt: new Date('2026-09-10T06:00:00Z'), lines: [{ variantId: variant, qty: 3 }], actorId: actor });
    assert.equal(await quant('warehouse'), warehouse - 3);
    const [cost] = await s.schema.sql<{ v: string }[]>`
      select sum(l.debit_paisa)::text as v from journal_entries e join journal_lines l on l.entry_id = e.id join accounts a on a.id = l.account_id
      where e.source_type = 'pr_send' and e.source_id like ${`${id}:%`} and a.code = '6100'
    `;
    assert.equal(cost?.v, '135000', '3 units at Rs 450 to marketing');
    await assert.rejects(createPrSend(s.schema.sql, { influencerId: influencer, sentAt: new Date(), actorId: actor }), /Say what was sent/);

    const postId = await addPost(s.schema.sql, { influencerId: influencer, url: 'https://example.com/reel/1', kind: 'reel', postedAt: new Date('2026-09-12T10:00:00Z'), prSendId: id, actorId: actor });
    assert.ok(postId);
    await assert.rejects(addPost(s.schema.sql, { influencerId: influencer, url: 'https://example.com/reel/1', kind: 'reel', postedAt: new Date(), actorId: actor }), /already recorded/);
    assert.equal((await listPosts(s.schema.sql, influencer)).length, 1);
  });
});
