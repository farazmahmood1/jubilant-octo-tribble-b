import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { damagedRegister } from '../db/repos/damaged.js';
import { listParcels } from '../db/repos/parcels.js';
import { paisa } from '../lib/money.js';
import { pnl } from '../reports/pnl.js';
import { skipWithoutDb } from '../test/db.js';
import { addEvent, orderWithLines, parcel, testUser, variantsIn } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { listExpenses, recordExpense, voidExpense, ExpenseError } from './expenses.js';
import {
  type InventoryChange,
  ReturnsActionError,
  type ShopifyOrderFacts,
  type ShopifyReturnsGateway,
  cancelShopifyOrderForReturn,
  orderFactsFrom,
  syncCheckInToShopify,
  writebacksToRecheck,
} from './shopify-returns.js';
import { StockError, checkInReturn, locationId, reconcileShipmentStock, recordCount, returnsAwaitingCheckIn, returnsComingBack } from './stock.js';

/**
 * Return check-ins carried to Shopify, warehouse counts entered as what was found, the damaged
 * register, and expenses. Shopify is a fake that keeps each order's lines (committed, restocked)
 * the way Shopify does, changes them on a cancel, remembers every call, and can be told to refuse.
 * Names are made up.
 */

interface Calls {
  cancels: Array<{ store: string; order: string; note: string; restock: boolean }>;
  adjusts: Array<{ store: string; reason: string; key: string; changes: InventoryChange[] }>;
}

interface FakeLine {
  variantId: string;
  quantity: number;
  committed: number;
  restocked: number;
}

const fakeShopify = (options: { adjustDelayMs?: number } = {}) => {
  const orders = new Map<string, ShopifyOrderFacts>();
  const calls: Calls = { cancels: [], adjusts: [] };
  const seenKeys = new Set<string>();
  let refuseAdjust: string | null = null;
  const gateway: ShopifyReturnsGateway = {
    order: async (_store, id) => structuredClone(orders.get(id) ?? null),
    cancel: async (store, id, input) => {
      calls.cancels.push({ store, order: id, note: input.staffNote, restock: input.restock });
      const o = orders.get(id)!;
      // Cancelling releases what was committed: back to available with restock, gone without.
      orders.set(id, { ...o, cancelled: true, lines: o.lines.map((l) => ({ ...l, restocked: l.restocked + (input.restock ? l.committed : 0), committed: 0 })) });
    },
    adjust: async (store, input) => {
      if (options.adjustDelayMs) await new Promise((r) => setTimeout(r, options.adjustDelayMs));
      if (refuseAdjust) throw new Error(refuseAdjust);
      // Shopify's idempotency: the same key does the change once.
      if (seenKeys.has(input.key)) return;
      seenKeys.add(input.key);
      calls.adjusts.push({ store, reason: input.reason, key: input.key, changes: input.changes });
    },
  };
  return {
    gateway,
    calls,
    set: (id: string, facts: { cancelled?: boolean; fulfillment?: string; lines: FakeLine[] }) =>
      orders.set(id, {
        name: `#${id}`,
        cancelled: facts.cancelled ?? false,
        fulfillment: facts.fulfillment ?? 'UNFULFILLED',
        locationGid: null,
        lines: facts.lines.map((l) => ({ ...l, inventoryItemGid: `gid://shopify/InventoryItem/${l.variantId}` })),
      }),
    refuse: (message: string | null) => {
      refuseAdjust = message;
    },
  };
};

describe('orderFactsFrom', () => {
  const node = (over: Partial<Parameters<typeof orderFactsFrom>[0]> = {}): Parameters<typeof orderFactsFrom>[0] => ({
    name: '#1',
    cancelledAt: null,
    displayFulfillmentStatus: 'UNFULFILLED',
    fulfillments: [],
    lineItems: { nodes: [{ id: 'gid://shopify/LineItem/1', quantity: 2, unfulfilledQuantity: 2, variant: { id: 'gid://shopify/ProductVariant/77', inventoryItem: { id: 'gid://shopify/InventoryItem/9' } } }] },
    refunds: [],
    returns: { nodes: [] },
    ...over,
  });

  it('an open, unfulfilled order commits its units and has restocked none', () => {
    assert.deepEqual(orderFactsFrom(node()).lines, [{ variantId: '77', inventoryItemGid: 'gid://shopify/InventoryItem/9', quantity: 2, committed: 2, restocked: 0 }]);
  });

  it('a cancelled order commits nothing even though Shopify still reports it unfulfilled; its restock comes from the cancel refund', () => {
    const facts = orderFactsFrom(
      node({ cancelledAt: '2026-10-23T12:00:31Z', refunds: [{ refundLineItems: { nodes: [{ quantity: 2, restocked: true, restockType: 'CANCEL', lineItem: { id: 'gid://shopify/LineItem/1' } }] } }] }),
    );
    assert.deepEqual([facts.cancelled, facts.lines[0]!.committed, facts.lines[0]!.restocked], [true, 0, 2]);
    const unrestocked = orderFactsFrom(node({ cancelledAt: '2026-10-23T12:00:31Z', refunds: [{ refundLineItems: { nodes: [{ quantity: 2, restocked: false, restockType: 'NO_RESTOCK', lineItem: { id: 'gid://shopify/LineItem/1' } }] } }] }));
    assert.equal(unrestocked.lines[0]!.restocked, 0, 'cancelled without restock: the units are gone from Shopify');
  });

  it('counts a unit restocked from a return once, whether Shopify shows it on the refund, the disposition, or both', () => {
    const disposed = { nodes: [{ reverseFulfillmentOrders: { nodes: [{ lineItems: { nodes: [{ fulfillmentLineItem: { lineItem: { id: 'gid://shopify/LineItem/1' } }, dispositions: [{ type: 'RESTOCKED', quantity: 1 }] }] } }] } }] };
    const refund = [{ refundLineItems: { nodes: [{ quantity: 1, restocked: true, restockType: 'RETURN', lineItem: { id: 'gid://shopify/LineItem/1' } }] } }];
    assert.equal(orderFactsFrom(node({ returns: disposed })).lines[0]!.restocked, 1);
    assert.equal(orderFactsFrom(node({ refunds: refund })).lines[0]!.restocked, 1);
    assert.equal(orderFactsFrom(node({ returns: disposed, refunds: refund })).lines[0]!.restocked, 1);
  });
});

describe('returns, counts and expenses', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let variants: string[];
  let account: string;
  let actor: string;
  let n = 0;

  before(async () => {
    s = await migratedWithStores();
    variants = await variantsIn(s.schema.sql, s.nur, 3);
    const [row] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    account = row!.id;
    actor = await testUser(s.schema.sql);
    for (const v of variants) {
      await s.schema.sql`
        insert into shopify_stock_levels (variant_id, store_id, location_gid, location_name, on_hand, available, committed, read_at)
        values (${v}, ${s.nur}, 'gid://shopify/Location/1', 'Warehouse', 10, 8, 2, now())
      `;
    }
  });

  after(async () => {
    await s?.schema.drop();
  });

  const shopifyVariant = async (i = 0) => (await s.schema.sql<{ id: string }[]>`select shopify_variant_id::text as id from variants where id = ${variants[i]!}`)[0]!.id;

  /** An order whose parcel PostEx brought back; checked in unless `checkIn` is null. Returns the ids. */
  const returned = async (
    outcome: 'restocked' | 'damaged' | 'mixed' | null,
    qty = 2,
    opts: { lines?: Array<{ variant: number; qty: number }>; split?: Array<{ variant: number; restocked: number; damaged: number }>; events?: Array<[string, string]> } = {},
  ) => {
    const lines = opts.lines ?? [{ variant: 0, qty }];
    const orderId = await orderWithLines(s.schema.sql, { storeId: s.nur, number: `#R${++n}`, placedAt: new Date('2026-09-01T06:00:00Z'), lines: lines.map((l) => ({ variantId: variants[l.variant]!, qty: l.qty })) });
    const shipmentId = await parcel(s.schema.sql, { accountId: account, orderId, events: opts.events ?? [['0013', '2026-09-02T09:00:00Z'], ['0039', '2026-09-02T20:00:00Z'], ['0040', '2026-09-03T09:00:00Z'], ['0032', '2026-09-07T09:00:00Z'], ['0006', '2026-09-08T09:00:00Z']] });
    await reconcileShipmentStock(s.schema.sql, shipmentId);
    if (outcome) {
      const split = opts.split?.map((l) => ({ variantId: variants[l.variant]!, restocked: l.restocked, damaged: l.damaged }));
      await checkInReturn(s.schema.sql, shipmentId, outcome, actor, undefined, split);
    }
    const [row] = await s.schema.sql<{ check_in: string | null; shopify: string }[]>`
      select (select c.id from return_check_ins c where c.shipment_id = sh.id) as check_in, o.shopify_order_id::text as shopify
      from shipments sh join orders o on o.id = sh.order_id where sh.id = ${shipmentId}
    `;
    return { checkInId: row!.check_in!, shopifyId: row!.shopify, shipmentId, orderId };
  };
  const sync = (checkInId: string, gateway: ShopifyReturnsGateway, extra: { force?: boolean; quiet?: boolean } = {}) => syncCheckInToShopify(s.schema.sql, { checkInId, actorId: actor, gateway, ...extra });

  it('STAGE: a parcel on the return leg (latest code 0032) is returning, can be checked in early, and is counted as coming back', async () => {
    const { shipmentId } = await returned(null, 1, { events: [['0013', '2026-09-02T09:00:00Z'], ['0040', '2026-09-03T09:00:00Z'], ['0037', '2026-09-04T09:00:00Z'], ['0032', '2026-09-05T09:00:00Z']] });
    const [p] = await s.schema.sql<{ stage: string; status_code: string }[]>`select stage, status_code from shipments where id = ${shipmentId}`;
    assert.deepEqual([p!.stage, p!.status_code], ['returning', '0032'], 'the latest code is a movement; the stage says returning');
    assert.ok((await returnsComingBack(s.schema.sql)) >= 1);
    assert.ok(!(await returnsAwaitingCheckIn(s.schema.sql)).some((r) => r.shipmentId === shipmentId), 'not handed back yet');
    await checkInReturn(s.schema.sql, shipmentId, 'restocked', actor);
    await assert.rejects(checkInReturn(s.schema.sql, shipmentId, 'restocked', actor), /already checked in/, 'a second click is refused and changes nothing');
    const delivered = await returned(null, 1, { events: [['0005', '2026-09-02T09:00:00Z']] });
    await assert.rejects(checkInReturn(s.schema.sql, delivered.shipmentId, 'restocked', actor), /not being returned/);
  });

  it('RESTOCK NEVER CANCELS: an order still open in Shopify is left open, nothing is added, and the return waits on the order', async () => {
    const shop = fakeShopify();
    const { checkInId, shopifyId } = await returned('restocked', 2);
    shop.set(shopifyId, { lines: [{ variantId: await shopifyVariant(), quantity: 2, committed: 2, restocked: 0 }] });
    const state = await sync(checkInId, shop.gateway);
    assert.deepEqual([state.outcome, state.action, state.cancellable], ['pending', 'none', true]);
    assert.match(state.message, /still open in Shopify/);
    assert.equal(shop.calls.cancels.length, 0, 'restocking did not cancel the order');
    assert.equal(shop.calls.adjusts.length, 0, 'committed units are not added, or the cancel would count them twice');
  });

  it('RESTOCK, fulfilled order: adds the units once; a second click, a retry and two at once add nothing more', async () => {
    const shop = fakeShopify({ adjustDelayMs: 30 });
    const { checkInId, shopifyId } = await returned('restocked', 3);
    shop.set(shopifyId, { fulfillment: 'FULFILLED', lines: [{ variantId: await shopifyVariant(), quantity: 3, committed: 0, restocked: 0 }] });
    const [a, b] = await Promise.all([sync(checkInId, shop.gateway), sync(checkInId, shop.gateway)]);
    assert.deepEqual([a.outcome, b.outcome], ['done', 'done']);
    assert.deepEqual(shop.calls.adjusts.map((x) => [x.reason, x.changes]), [
      ['restock', [{ inventoryItemGid: `gid://shopify/InventoryItem/${await shopifyVariant()}`, locationGid: 'gid://shopify/Location/1', delta: 3 }]],
    ]);
    const again = await sync(checkInId, shop.gateway, { force: true });
    assert.equal(again.outcome, 'done');
    assert.match(again.message, /already been added back/);
    assert.equal(shop.calls.adjusts.length, 1, 'never added twice');
  });

  it('RESTOCK, order already cancelled in Shopify WITH restock: nothing added; WITHOUT restock: the units are added back', async () => {
    const shop = fakeShopify();
    const withRestock = await returned('restocked', 2);
    shop.set(withRestock.shopifyId, { cancelled: true, lines: [{ variantId: await shopifyVariant(), quantity: 2, committed: 0, restocked: 2 }] });
    const skipped = await sync(withRestock.checkInId, shop.gateway);
    assert.equal(skipped.outcome, 'skipped');
    assert.match(skipped.message, /already restocked 2 units itself/);
    assert.equal(shop.calls.adjusts.length, 0);

    const without = await returned('restocked', 2);
    shop.set(without.shopifyId, { cancelled: true, lines: [{ variantId: await shopifyVariant(), quantity: 2, committed: 0, restocked: 0 }] });
    const added = await sync(without.checkInId, shop.gateway);
    assert.deepEqual([added.outcome, added.action], ['done', 'restock']);
    assert.deepEqual(shop.calls.adjusts.map((x) => x.changes[0]!.delta), [2]);
  });

  it('CANCEL IN SHOPIFY is its own action: restocks for a restocked return, then the return is settled with nothing added; a second cancel is refused', async () => {
    const shop = fakeShopify();
    const { checkInId, shopifyId, orderId } = await returned('restocked', 2);
    shop.set(shopifyId, { lines: [{ variantId: await shopifyVariant(), quantity: 2, committed: 2, restocked: 0 }] });
    assert.equal((await sync(checkInId, shop.gateway)).outcome, 'pending');
    const after = await cancelShopifyOrderForReturn(s.schema.sql, { checkInId, actorId: actor, gateway: shop.gateway });
    assert.deepEqual(shop.calls.cancels.map((c) => c.restock), [true]);
    assert.equal(after.outcome, 'skipped', 'Shopify restocked them on cancelling');
    assert.equal(shop.calls.adjusts.length, 0, 'and nothing was added on top');
    await assert.rejects(cancelShopifyOrderForReturn(s.schema.sql, { checkInId, actorId: actor, gateway: shop.gateway }), (e: unknown) => e instanceof ReturnsActionError && /already cancelled/.test(e.message));
    const [audit] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'shopify.order_cancel' and entity_id = ${orderId}`;
    assert.equal(audit!.n, 1, 'the cancel is audited');
  });

  it('CANCEL for a damaged return does not restock; a fulfilled order cannot be cancelled from here', async () => {
    const shop = fakeShopify();
    const damaged = await returned('damaged', 1);
    shop.set(damaged.shopifyId, { lines: [{ variantId: await shopifyVariant(), quantity: 1, committed: 1, restocked: 0 }] });
    assert.equal((await sync(damaged.checkInId, shop.gateway)).outcome, 'pending', 'the damaged unit is still committed to the open order');
    await cancelShopifyOrderForReturn(s.schema.sql, { checkInId: damaged.checkInId, actorId: actor, gateway: shop.gateway });
    assert.deepEqual(shop.calls.cancels.map((c) => c.restock), [false]);

    const fulfilled = await returned('restocked', 1);
    shop.set(fulfilled.shopifyId, { fulfillment: 'FULFILLED', lines: [{ variantId: await shopifyVariant(), quantity: 1, committed: 0, restocked: 0 }] });
    await assert.rejects(cancelShopifyOrderForReturn(s.schema.sql, { checkInId: fulfilled.checkInId, actorId: actor, gateway: shop.gateway }), /nothing committed/);
    assert.equal(shop.calls.cancels.length, 1);
  });

  it('PARTIAL: a split check-in shelves and damages per product; Shopify gets only the restocked units; the damaged register lists only the damaged one', async () => {
    const shop = fakeShopify();
    const { checkInId, shopifyId, shipmentId } = await returned('mixed', 0, { lines: [{ variant: 0, qty: 2 }, { variant: 1, qty: 1 }], split: [{ variant: 0, restocked: 1, damaged: 1 }, { variant: 1, restocked: 1, damaged: 0 }] });
    const moves = await s.schema.sql<{ variant_id: string; to: string; qty: number }[]>`
      select m.variant_id, l.key as to, m.qty from stock_moves m join locations l on l.id = m.to_location_id
      where m.ref_type = 'return_check_in' and m.ref_id = ${checkInId} order by m.variant_id, l.key
    `;
    assert.deepEqual(moves.map((m) => [m.variant_id, m.to, m.qty]), [[variants[0], 'damaged', 1], [variants[0], 'warehouse', 1], [variants[1], 'warehouse', 1]]);
    assert.equal((await reconcileShipmentStock(s.schema.sql, shipmentId)).moves, 0, 'a re-run moves nothing');

    shop.set(shopifyId, { fulfillment: 'FULFILLED', lines: [{ variantId: await shopifyVariant(0), quantity: 2, committed: 0, restocked: 0 }, { variantId: await shopifyVariant(1), quantity: 1, committed: 0, restocked: 0 }] });
    const state = await sync(checkInId, shop.gateway);
    assert.equal(state.outcome, 'done');
    assert.deepEqual(shop.calls.adjusts.map((a) => a.changes[0]!.delta), [1, 1], 'one of each product, not the damaged unit');
    const register = await damagedRegister(s.schema.sql, {}, { phones: false });
    assert.deepEqual(register.rows.find((r) => r.shipmentId === shipmentId)?.items.map((i) => [i.variantId, i.qty]), [[variants[0], 1]]);

    const other = await returned(null, 2);
    await assert.rejects(checkInReturn(s.schema.sql, other.shipmentId, 'mixed', actor, undefined, [{ variantId: variants[0]!, restocked: 1, damaged: 0 }]), /must add up to 2/);
    await assert.rejects(checkInReturn(s.schema.sql, other.shipmentId, 'mixed', actor, undefined, [{ variantId: variants[0]!, restocked: 2, damaged: 0 }]), /check the parcel in as restocked/);
  });

  it('SHOPIFY FAILS: the attempt is failed, never done; a retry once Shopify answers adds the units once; every attempt is kept', async () => {
    const shop = fakeShopify();
    const { checkInId, shopifyId } = await returned('restocked', 2);
    shop.set(shopifyId, { fulfillment: 'FULFILLED', lines: [{ variantId: await shopifyVariant(), quantity: 2, committed: 0, restocked: 0 }] });
    shop.refuse('Access denied for inventoryAdjustQuantities field. Required access: `write_inventory`');
    const failed = await sync(checkInId, shop.gateway);
    assert.equal(failed.outcome, 'failed');
    assert.match(failed.error!, /permission/);
    assert.ok((await writebacksToRecheck(s.schema.sql, -1)).includes(checkInId), 'the background re-check picks it up');
    shop.refuse(null);
    const retried = await sync(checkInId, shop.gateway, { force: true });
    assert.deepEqual([retried.outcome, retried.action], ['done', 'restock']);
    assert.equal(shop.calls.adjusts.length, 1);
    const rows = await s.schema.sql<{ outcome: string }[]>`select outcome from shopify_writebacks where check_in_id = ${checkInId} order by id`;
    assert.deepEqual(rows.map((r) => r.outcome), ['failed', 'done']);
  });

  it('RE-CHECK: an unchanged pending return records no new attempt; once the order is cancelled in Shopify it settles', async () => {
    const shop = fakeShopify();
    const { checkInId, shopifyId } = await returned('restocked', 1);
    shop.set(shopifyId, { lines: [{ variantId: await shopifyVariant(), quantity: 1, committed: 1, restocked: 0 }] });
    await sync(checkInId, shop.gateway);
    await sync(checkInId, shop.gateway, { quiet: true });
    const count = async () => (await s.schema.sql<{ n: number }[]>`select count(*)::int as n from shopify_writebacks where check_in_id = ${checkInId}`)[0]!.n;
    assert.equal(await count(), 1, 'nothing new to say, nothing written');
    assert.ok(!(await writebacksToRecheck(s.schema.sql, 60_000)).includes(checkInId), 'and it is not asked again straight away');
    shop.set(shopifyId, { cancelled: true, lines: [{ variantId: await shopifyVariant(), quantity: 1, committed: 0, restocked: 1 }] });
    assert.equal((await sync(checkInId, shop.gateway, { quiet: true })).outcome, 'skipped');
    assert.equal(await count(), 2);
  });

  it('QUEUE: a completed return leaves the waiting list but keeps its history; switched off: skipped unless forced', async () => {
    const shop = fakeShopify();
    const { shipmentId, checkInId, shopifyId } = await returned('restocked', 1);
    assert.ok(!(await returnsAwaitingCheckIn(s.schema.sql)).some((r) => r.shipmentId === shipmentId));
    const listed = await listParcels(s.schema.sql, { flags: ['checked_in'], page: 1, pageSize: 200 });
    assert.equal(listed.rows.find((r) => r.id === shipmentId)?.checkedIn, 'restocked', 'still in the register, as checked in');

    await s.schema.sql`insert into app_settings (key, value) values ('shopify', '{"returnsWriteback": false}') on conflict (key) do update set value = excluded.value`;
    shop.set(shopifyId, { fulfillment: 'FULFILLED', lines: [{ variantId: await shopifyVariant(), quantity: 1, committed: 0, restocked: 0 }] });
    const skipped = await sync(checkInId, shop.gateway);
    assert.equal(skipped.outcome, 'skipped');
    assert.match(skipped.message, /switched off/);
    assert.equal((await sync(checkInId, shop.gateway, { force: true })).outcome, 'done');
    await s.schema.sql`delete from app_settings where key = 'shopify'`;
    await addEvent(s.schema.sql, shipmentId, '0035', '2026-09-09T09:00:00Z');
    assert.equal((await listParcels(s.schema.sql, { flags: ['checked_in'], page: 1, pageSize: 200 })).rows.find((r) => r.id === shipmentId)?.checkedIn, 'restocked');
  });

  it('DAMAGED REGISTER: lists each damaged return with its items, units and dates', async () => {
    const { shipmentId } = await returned('damaged', 4);
    const register = await damagedRegister(s.schema.sql, {}, { phones: false });
    const row = register.rows.find((r) => r.shipmentId === shipmentId)!;
    assert.equal(row.units, 4);
    assert.deepEqual(row.items.map((i) => [i.variantId, i.qty]), [[variants[0], 4]]);
    assert.ok(row.refusedAt && row.returnedAt && row.damagedAt, 'the dates on its way back');
    assert.equal(row.phone, null, 'no phone for a role that may not see one');
    assert.ok(register.units >= 4);
  });

  it('COUNT: entered as what was found; the difference to the ledger is what moves, and an opening count is taken once', async () => {
    const warehouse = await locationId(s.schema.sql, 'warehouse');
    const shelf = async (v: string) =>
      Number((await s.schema.sql<{ qty: string }[]>`select coalesce(sum(qty), 0)::text as qty from stock_quants where variant_id = ${v} and location_id = ${warehouse}`)[0]!.qty);
    const before = await shelf(variants[1]!);
    const opening = await recordCount(s.schema.sql, { reason: 'opening_stock', actorId: actor, at: new Date('2026-06-30T18:59:59Z'), lines: [{ variantId: variants[1]!, counted: 40 }, { variantId: variants[2]!, counted: 0 }] });
    assert.equal(await shelf(variants[1]!), 40);
    assert.deepEqual([opening.lines, opening.units], [before === 0 ? 1 : 2, 40 - before], 'a product that already agrees moves nothing');
    await assert.rejects(recordCount(s.schema.sql, { reason: 'opening_stock', actorId: actor, lines: [{ variantId: variants[1]!, counted: 41 }] }), StockError);
    const recount = await recordCount(s.schema.sql, { reason: 'count', actorId: actor, lines: [{ variantId: variants[1]!, counted: 37 }] });
    assert.deepEqual([recount.lines, recount.units, await shelf(variants[1]!)], [1, -3, 37]);
    const same = await recordCount(s.schema.sql, { reason: 'count', actorId: actor, lines: [{ variantId: variants[1]!, counted: 37 }] });
    assert.equal(same.adjustmentId, null, 'nothing differs, nothing recorded');
  });

  it('EXPENSES: post to the category account against bank or cash, show in the P&L, and a void reverses them', async () => {
    const ads = await recordExpense(s.schema.sql, {
      spentOn: '2026-09-10', category: 'advertising', store: 'nur', amount: paisa(1_500_000n), paidFrom: 'bank', payee: 'Ads platform', note: null, actorId: actor,
    });
    await recordExpense(s.schema.sql, { spentOn: '2026-09-12', category: 'rent', store: null, amount: paisa(5_000_000n), paidFrom: 'cash', payee: null, note: null, actorId: actor });
    const lines = await s.schema.sql<{ code: string; debit: string; credit: string }[]>`
      select a.code, l.debit_paisa::text as debit, l.credit_paisa::text as credit from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = ${ads.entryId} order by a.code
    `;
    assert.deepEqual(lines.map((l) => [l.code, l.debit, l.credit]), [['1000', '0', '1500000'], ['6300', '1500000', '0']]);
    const september = await pnl(s.schema.sql, { from: '2026-09-01', to: '2026-09-30' });
    const amount = (code: string) => september.rows.find((r) => r.code === code)?.amount;
    assert.deepEqual([amount('6300'), amount('6320')], [paisa(1_500_000n), paisa(5_000_000n)]);
    assert.equal((await pnl(s.schema.sql, { from: '2026-09-01', to: '2026-09-30', store: 'nur' })).rows.find((r) => r.code === '6320'), undefined, 'a both-brands expense shows only in the combined P&L');

    const listed = await listExpenses(s.schema.sql, { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual([listed.total, listed.byCategory.advertising], [paisa(6_500_000n), paisa(1_500_000n)]);

    await voidExpense(s.schema.sql, { id: ads.id, reason: 'entered twice', actorId: actor });
    await assert.rejects(voidExpense(s.schema.sql, { id: ads.id, reason: 'again', actorId: actor }), ExpenseError);
    const after = await pnl(s.schema.sql, {});
    assert.equal(after.rows.find((r) => r.code === '6300')?.amount ?? paisa(0n), paisa(0n), 'voided: the reversal cancels it');
    assert.equal((await listExpenses(s.schema.sql, {})).rows.some((r) => r.id === ads.id), false, 'hidden unless voided ones are asked for');
    assert.equal((await listExpenses(s.schema.sql, { includeVoided: true })).rows.find((r) => r.id === ads.id)?.voided?.reason, 'entered twice');

    await s.schema.sql`insert into fiscal_periods (year, month, status, closed_at, closed_by) values (2026, 8, 'closed', now(), ${actor})`;
    await assert.rejects(
      recordExpense(s.schema.sql, { spentOn: '2026-08-20', category: 'packaging', store: 'nur', amount: paisa(100_000n), paidFrom: 'bank', payee: null, note: null, actorId: actor }),
      (error: unknown) => error instanceof ExpenseError && /open month/.test(error.message),
    );
  });
});
