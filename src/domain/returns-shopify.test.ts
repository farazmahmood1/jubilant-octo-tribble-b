import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { damagedRegister } from '../db/repos/damaged.js';
import { paisa } from '../lib/money.js';
import { pnl } from '../reports/pnl.js';
import { skipWithoutDb } from '../test/db.js';
import { orderWithLines, parcel, testUser, variantsIn } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { listExpenses, recordExpense, voidExpense, ExpenseError } from './expenses.js';
import { type InventoryChange, type ShopifyOrderFacts, type ShopifyReturnsGateway, syncCheckInToShopify } from './shopify-returns.js';
import { StockError, checkInReturn, locationId, reconcileShipmentStock, recordCount } from './stock.js';

/**
 * Return check-ins carried to Shopify, warehouse counts entered as what was found, the damaged
 * register, and expenses. Shopify is a fake that remembers every call; names are made up.
 */

interface Calls {
  cancels: Array<{ store: string; order: string; note: string }>;
  adjusts: Array<{ store: string; reason: string; key: string; changes: InventoryChange[] }>;
}

/** A Shopify holding each order's state, which a cancel changes, and which can be told to refuse. */
const fakeShopify = () => {
  const orders = new Map<string, ShopifyOrderFacts>();
  const calls: Calls = { cancels: [], adjusts: [] };
  let refuseAdjust: string | null = null;
  const gateway: ShopifyReturnsGateway = {
    order: async (_store, id) => orders.get(id) ?? null,
    cancel: async (store, id, note) => {
      calls.cancels.push({ store, order: id, note });
      const o = orders.get(id)!;
      orders.set(id, { ...o, cancelled: true });
    },
    inventoryItems: async (_store, ids) => new Map(ids.map((id) => [id, `gid://shopify/InventoryItem/${id}`])),
    adjust: async (store, input) => {
      if (refuseAdjust) throw new Error(refuseAdjust);
      calls.adjusts.push({ store, reason: input.reason, key: input.key, changes: input.changes });
    },
  };
  return {
    gateway,
    calls,
    set: (id: string, facts: Partial<ShopifyOrderFacts>) => orders.set(id, { name: `#${id}`, cancelled: false, fulfillment: 'UNFULFILLED', locationGid: null, ...facts }),
    refuse: (message: string | null) => {
      refuseAdjust = message;
    },
  };
};

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

  /** An order whose parcel PostEx brought back, checked in; returns the check-in and Shopify order ids. */
  const returned = async (outcome: 'restocked' | 'damaged', qty = 2) => {
    const orderId = await orderWithLines(s.schema.sql, { storeId: s.nur, number: `#R${++n}`, placedAt: new Date('2026-09-01T06:00:00Z'), lines: [{ variantId: variants[0]!, qty }] });
    const shipmentId = await parcel(s.schema.sql, { accountId: account, orderId, events: [['0013', '2026-09-02T09:00:00Z'], ['0040', '2026-09-03T09:00:00Z'], ['0006', '2026-09-08T09:00:00Z']] });
    await reconcileShipmentStock(s.schema.sql, shipmentId);
    await checkInReturn(s.schema.sql, shipmentId, outcome, actor);
    const [row] = await s.schema.sql<{ check_in: string; shopify: string }[]>`
      select c.id as check_in, o.shopify_order_id::text as shopify from return_check_ins c join shipments sh on sh.id = c.shipment_id join orders o on o.id = sh.order_id
      where c.shipment_id = ${shipmentId}
    `;
    return { checkInId: row!.check_in, shopifyId: row!.shopify, shipmentId };
  };
  const shopifyVariant = async () => (await s.schema.sql<{ id: string }[]>`select shopify_variant_id::text as id from variants where id = ${variants[0]!}`)[0]!.id;

  it('RESTOCKED, order open in Shopify: cancels it with its items restocked, once; a second call asks nothing', async () => {
    const shop = fakeShopify();
    const { checkInId, shopifyId } = await returned('restocked');
    shop.set(shopifyId, {});
    const first = await syncCheckInToShopify(s.schema.sql, { checkInId, actorId: actor, gateway: shop.gateway });
    assert.deepEqual([first.outcome, first.action], ['done', 'cancel_restock']);
    assert.equal(shop.calls.cancels.length, 1);
    assert.match(shop.calls.cancels[0]!.note, /checked in as restocked/);
    assert.equal(shop.calls.adjusts.length, 0, 'cancelling with restock is the whole change');
    const again = await syncCheckInToShopify(s.schema.sql, { checkInId, actorId: actor, gateway: shop.gateway });
    assert.equal(again.outcome, 'done');
    assert.equal(shop.calls.cancels.length, 1, 'not cancelled twice');
  });

  it('RESTOCKED, order fulfilled in Shopify: puts the units back on available at the stock location', async () => {
    const shop = fakeShopify();
    const { checkInId, shopifyId } = await returned('restocked', 3);
    shop.set(shopifyId, { fulfillment: 'FULFILLED' });
    const result = await syncCheckInToShopify(s.schema.sql, { checkInId, actorId: actor, gateway: shop.gateway });
    assert.deepEqual([result.outcome, result.action], ['done', 'restock']);
    assert.equal(shop.calls.cancels.length, 0);
    assert.deepEqual(shop.calls.adjusts.map((a) => [a.reason, a.changes]), [
      ['restock', [{ inventoryItemGid: `gid://shopify/InventoryItem/${await shopifyVariant()}`, locationGid: 'gid://shopify/Location/1', delta: 3 }]],
    ]);
    assert.match(shop.calls.adjusts[0]!.key, new RegExp(`check-in-${checkInId}-restock$`), 'an idempotency key per check-in and step');
  });

  it('DAMAGED, order open: cancels with restock, then takes the units off as damaged; a refusal is kept and the retry does only what is left', async () => {
    const shop = fakeShopify();
    const { checkInId, shopifyId } = await returned('damaged', 2);
    shop.set(shopifyId, {});
    shop.refuse('Access denied for inventoryAdjustQuantities field. Required access: `write_inventory`');
    const failed = await syncCheckInToShopify(s.schema.sql, { checkInId, actorId: actor, gateway: shop.gateway });
    assert.equal(failed.outcome, 'failed');
    assert.match(failed.error!, /permission/);
    assert.equal(shop.calls.cancels.length, 1, 'the cancel went through before the refusal');

    shop.refuse(null);
    const retried = await syncCheckInToShopify(s.schema.sql, { checkInId, actorId: actor, gateway: shop.gateway, force: true });
    assert.deepEqual([retried.outcome, retried.action], ['done', 'write_off']);
    assert.equal(shop.calls.cancels.length, 1, 'the order is not cancelled again');
    assert.deepEqual(shop.calls.adjusts.map((a) => [a.reason, a.changes.map((c) => c.delta)]), [['damaged', [-2]]]);
    const rows = await s.schema.sql<{ outcome: string }[]>`select outcome from shopify_writebacks where check_in_id = ${checkInId} order by id`;
    assert.deepEqual(rows.map((r) => r.outcome), ['failed', 'done'], 'every attempt is kept');
  });

  it('DAMAGED, order fulfilled: nothing to change in Shopify; already cancelled: skipped; switched off: skipped unless forced', async () => {
    const shop = fakeShopify();
    const fulfilled = await returned('damaged');
    shop.set(fulfilled.shopifyId, { fulfillment: 'FULFILLED' });
    assert.deepEqual(
      (({ outcome, action }) => [outcome, action])(await syncCheckInToShopify(s.schema.sql, { checkInId: fulfilled.checkInId, actorId: actor, gateway: shop.gateway })),
      ['done', 'none'],
    );

    const cancelled = await returned('restocked');
    shop.set(cancelled.shopifyId, { cancelled: true });
    assert.equal((await syncCheckInToShopify(s.schema.sql, { checkInId: cancelled.checkInId, actorId: actor, gateway: shop.gateway })).outcome, 'skipped');

    await s.schema.sql`insert into app_settings (key, value) values ('shopify', '{"returnsWriteback": false}') on conflict (key) do update set value = excluded.value`;
    const off = await returned('restocked');
    shop.set(off.shopifyId, {});
    const skipped = await syncCheckInToShopify(s.schema.sql, { checkInId: off.checkInId, actorId: actor, gateway: shop.gateway });
    assert.equal(skipped.outcome, 'skipped');
    assert.match(skipped.message, /switched off/);
    assert.equal((await syncCheckInToShopify(s.schema.sql, { checkInId: off.checkInId, actorId: actor, gateway: shop.gateway, force: true })).outcome, 'done');
    await s.schema.sql`delete from app_settings where key = 'shopify'`;
    assert.deepEqual(shop.calls.adjusts, [], 'nothing was adjusted for any of these');
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
