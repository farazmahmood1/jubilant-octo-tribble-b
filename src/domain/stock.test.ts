import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { skipWithoutDb } from '../test/db.js';
import { addEvent, orderWithLines, parcel, testUser, variantsIn } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import {
  type LocationKey,
  StockError,
  checkInReturn,
  locationId,
  rebuildQuants,
  recordAdjustment,
  recordMove,
  reconcileShipmentStock,
  returnsAwaitingCheckIn,
  targetFor,
} from './stock.js';

/** mulberry32: a seeded generator, so a failing random sequence can be replayed exactly. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
};

describe('targetFor', () => {
  it('maps parcel states to locations per step 8, with S8–S10', () => {
    const cases: Array<[Parameters<typeof targetFor>[0], boolean, LocationKey]> = [
      ['booked', false, 'in_transit'],
      ['in_transit', false, 'in_transit'],
      ['failed', false, 'in_transit'],
      ['delivered', false, 'customer'],
      ['delivered', true, 'marketing'],
      ['returning', false, 'returning'],
      ['returned_received', false, 'returning'],
      ['returning', true, 'returning'],
      ['cancelled', false, 'warehouse'],
    ];
    for (const [state, isPr, expected] of cases) assert.equal(targetFor(state, isPr), expected, `${state} pr=${isPr}`);
  });
});

describe('stock ledger', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let variants: string[];
  let accountId: string;
  let actor: string;
  const loc: Partial<Record<LocationKey, string>> = {};
  const at = (key: LocationKey) => loc[key]!;

  before(async () => {
    s = await migratedWithStores();
    variants = await variantsIn(s.schema.sql, s.nur, 5);
    for (const key of ['warehouse', 'in_transit', 'returning', 'customer', 'marketing', 'damaged', 'supplier', 'adjustment'] as const) {
      loc[key] = await locationId(s.schema.sql, key);
    }
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    accountId = account!.id;
    actor = await testUser(s.schema.sql);
  });

  after(async () => {
    await s?.schema.drop();
  });

  const quants = async () =>
    s.schema.sql<{ variant_id: string; location_id: string; qty: string }[]>`
      select variant_id, location_id, qty::text from stock_quants where qty <> 0 order by variant_id, location_id
    `.then((rows) => [...rows]);

  /** stock_quants recomputed independently of the trigger and of rebuildQuants. */
  const recomputed = async () =>
    s.schema.sql<{ variant_id: string; location_id: string; qty: string }[]>`
      select variant_id, location_id, sum(qty)::text as qty from (
        select variant_id, from_location_id as location_id, -qty as qty from stock_moves
        union all select variant_id, to_location_id, qty from stock_moves
      ) legs group by variant_id, location_id having sum(qty) <> 0 order by variant_id, location_id
    `.then((rows) => [...rows]);

  const qtyAt = async (variantId: string, key: LocationKey): Promise<number> => {
    const [row] = await s.schema.sql<{ qty: number }[]>`select qty::int from stock_quants where variant_id = ${variantId} and location_id = ${at(key)}`;
    return row?.qty ?? 0;
  };

  const movesOf = async (shipmentId: string) =>
    s.schema.sql<{ from_key: string; to_key: string; qty: number; ref_type: string }[]>`
      select f.key as from_key, t.key as to_key, m.qty, m.ref_type from stock_moves m
      join locations f on f.id = m.from_location_id join locations t on t.id = m.to_location_id
      where m.shipment_id = ${shipmentId} order by m.id
    `.then((rows) => rows.map((r) => `${r.from_key}→${r.to_key} ×${r.qty} (${r.ref_type})`));

  it('seeds one location of each system kind', async () => {
    const rows = await s.schema.sql<{ key: string; kind: string }[]>`select key, kind from locations order by id`;
    assert.deepEqual(rows.map((r) => r.kind).sort(), ['adjustment', 'customer', 'damaged', 'in_transit', 'marketing', 'returning', 'supplier', 'warehouse']);
  });

  it('quants equal a full rebuild after a randomised sequence of 500 moves, and each move conserves the variant', async () => {
    const random = seeded(20260920);
    const [partner] = await s.schema.sql<{ id: string }[]>`insert into retail_partners (name, city) values ('Test Grocer', 'Lahore') returning id`;
    const [partnerLoc] = await s.schema.sql<{ id: string }[]>`
      insert into locations (kind, label, partner_id) values ('partner', 'Test Grocer', ${partner!.id}) returning id
    `;
    const places = [...Object.values(loc), partnerLoc!.id] as string[];
    const totalOf = async (variantId: string) => {
      const [row] = await s.schema.sql<{ total: string }[]>`select coalesce(sum(qty), 0)::text as total from stock_quants where variant_id = ${variantId}`;
      return row!.total;
    };

    for (let i = 0; i < 500; i++) {
      const variantId = variants[Math.floor(random() * variants.length)]!;
      const from = places[Math.floor(random() * places.length)]!;
      let to = places[Math.floor(random() * places.length)]!;
      if (to === from) to = places[(places.indexOf(from) + 1) % places.length]!;
      const qty = 1 + Math.floor(random() * 20);
      const [beforeFrom, beforeTo] = await Promise.all([qtyAtId(variantId, from), qtyAtId(variantId, to)]);
      assert.ok(await recordMove(s.schema.sql, { variantId, qty, from, to, reason: 'test', refType: 'test', refId: String(i), occurredAt: new Date() }));
      // Exactly the two legs moved, by the same amount: the variant's total is unchanged.
      assert.equal(await qtyAtId(variantId, from), beforeFrom - qty);
      assert.equal(await qtyAtId(variantId, to), beforeTo + qty);
      assert.equal(await totalOf(variantId), '0', `variant total after move ${i}`);
    }

    const live = await quants();
    assert.deepEqual(live, await recomputed(), 'the trigger kept every quant equal to the ledger');
    const rows = await rebuildQuants(s.schema.sql);
    assert.ok(rows > 0);
    assert.deepEqual(await quants(), live, 'a full rebuild changes nothing');

    // A quant someone tampered with is put right by the rebuild.
    await s.schema.sql`update stock_quants set qty = qty + 7 where variant_id = ${variants[0]!} and location_id = ${at('warehouse')}`;
    await rebuildQuants(s.schema.sql);
    assert.deepEqual(await quants(), live);
    for (const variantId of variants) assert.equal(await totalOf(variantId), '0');
  });

  const qtyAtId = async (variantId: string, locationIdValue: string): Promise<number> => {
    const [row] = await s.schema.sql<{ qty: number }[]>`select qty::int from stock_quants where variant_id = ${variantId} and location_id = ${locationIdValue}`;
    return row?.qty ?? 0;
  };

  it('refuses a move without two locations, or with a quantity that is not a positive integer', async () => {
    const base = { variantId: variants[0]!, from: at('warehouse'), to: at('customer'), reason: 'test', refType: 'bad', refId: '1', occurredAt: new Date() };
    for (const qty of [0, -1, 1.5]) await assert.rejects(recordMove(s.schema.sql, { ...base, qty }), StockError);
    await assert.rejects(recordMove(s.schema.sql, { ...base, qty: 1, to: base.from }), StockError);
    // And the table refuses the same, for anything that bypasses recordMove.
    await assert.rejects(
      s.schema.sql`insert into stock_moves (variant_id, qty, from_location_id, to_location_id, reason, ref_type, ref_id, occurred_at)
                   values (${base.variantId}, 1, ${base.from}, ${base.from}, 'x', 'x', 'x', now())`,
      /check constraint/,
    );
  });

  it('keeps the ledger append-only and dedupes a repeated move', async () => {
    const move = { variantId: variants[1]!, qty: 3, from: at('supplier'), to: at('warehouse'), reason: 'receipt', refType: 'goods_receipt', refId: 'GR-1', occurredAt: new Date() };
    assert.equal(await recordMove(s.schema.sql, move), true);
    assert.equal(await recordMove(s.schema.sql, move), false);
    await assert.rejects(s.schema.sql`update stock_moves set qty = 99`, /append-only/);
    await assert.rejects(s.schema.sql`delete from stock_moves`, /append-only/);
  });

  it('records an adjustment against the adjustment location, and audits it', async () => {
    const variantId = variants[4]!;
    const before = await qtyAt(variantId, 'warehouse');
    const id = await recordAdjustment(s.schema.sql, {
      locationId: at('warehouse'),
      reason: 'count',
      actorId: actor,
      lines: [{ variantId, delta: 12 }, { variantId: variants[3]!, delta: -2 }, { variantId: variants[2]!, delta: 0 }],
    });
    assert.equal(await qtyAt(variantId, 'warehouse'), before + 12);
    const [audit] = await s.schema.sql<{ actor_id: string }[]>`select actor_id from audit_log where action = 'stock.adjust' and entity_id = ${id}`;
    assert.equal(audit?.actor_id, actor);
    const moves = await s.schema.sql`select 1 from stock_moves where ref_type = 'stock_adjustment' and ref_id = ${id}`;
    assert.equal(moves.length, 2, 'a zero line moves nothing');
  });

  describe('parcels', () => {
    const order = (lines: Array<{ variantId: string | null; qty: number }>, channel: 'online' | 'pr' = 'online') =>
      orderWithLines(s.schema.sql, { storeId: s.nur, number: `#${Math.floor(Math.random() * 1e9)}`, placedAt: new Date('2026-09-01T05:00:00Z'), channel, lines });

    it('delivered: warehouse → in transit → customer, and a second pass moves nothing', async () => {
      const id = await parcel(s.schema.sql, { accountId, orderId: await order([{ variantId: variants[0]!, qty: 2 }]), events: [['0005', '2026-09-03T10:00:00Z']] });
      const result = await reconcileShipmentStock(s.schema.sql, id);
      assert.equal(result.target, 'customer');
      assert.deepEqual(await movesOf(id), ['warehouse→in_transit ×2 (shipment)', 'in_transit→customer ×2 (shipment_event)']);
      assert.equal((await reconcileShipmentStock(s.schema.sql, id)).moves, 0);
    });

    it('PostEx-returned (0006) and warehouse-received are distinct: 0006 leaves stock in returning until a person checks it in', async () => {
      const returned = await parcel(s.schema.sql, {
        accountId,
        orderId: await order([{ variantId: variants[1]!, qty: 1 }, { variantId: variants[2]!, qty: 3 }]),
        events: [['0013', '2026-09-02T09:00:00Z'], ['0040', '2026-09-03T09:00:00Z'], ['0006', '2026-09-08T09:00:00Z']],
      });
      const returning = await parcel(s.schema.sql, { accountId, orderId: await order([{ variantId: variants[1]!, qty: 1 }]), events: [['0040', '2026-09-03T09:00:00Z']] });
      const delivered = await parcel(s.schema.sql, { accountId, orderId: await order([{ variantId: variants[1]!, qty: 1 }]), events: [['0005', '2026-09-03T09:00:00Z']] });
      const unmatched = await parcel(s.schema.sql, { accountId, orderId: null, events: [['0006', '2026-09-07T09:00:00Z']] });
      for (const id of [returned, returning, delivered, unmatched]) await reconcileShipmentStock(s.schema.sql, id);

      assert.deepEqual(await movesOf(returned), [
        `warehouse→in_transit ×1 (shipment)`,
        `warehouse→in_transit ×3 (shipment)`,
        `in_transit→returning ×1 (shipment_event)`,
        `in_transit→returning ×3 (shipment_event)`,
      ]);
      const awaiting = async () => (await returnsAwaitingCheckIn(s.schema.sql)).map((r) => r.shipmentId).sort();
      assert.deepEqual(await awaiting(), [returned, unmatched].sort(), '0006 only: not the 0040 parcel, not the delivered one; the unmatched one too');

      await checkInReturn(s.schema.sql, returned, 'restocked', actor);
      assert.deepEqual((await movesOf(returned)).slice(4), ['returning→warehouse ×1 (return_check_in)', 'returning→warehouse ×3 (return_check_in)']);
      assert.deepEqual(await awaiting(), [unmatched]);
      const [audit] = await s.schema.sql`select actor_id from audit_log where action = 'stock.return_check_in' and entity_id = ${returned}`;
      assert.equal(audit?.['actor_id'], actor);

      // Checked in once only; and a delivered parcel cannot be checked in at all.
      await assert.rejects(checkInReturn(s.schema.sql, returned, 'damaged', actor), /already checked in/);
      await assert.rejects(checkInReturn(s.schema.sql, delivered, 'restocked', actor), /not being returned/);

      // The team often has the parcel before PostEx says 0006: a 0040 parcel can be checked in.
      await checkInReturn(s.schema.sql, returning, 'damaged', actor);
      assert.deepEqual((await movesOf(returning)).at(-1), 'returning→damaged ×1 (return_check_in)');

      // And a later 0006 for it moves nothing: the check-in decides.
      await addEvent(s.schema.sql, returning, '0006', '2026-09-09T09:00:00Z');
      assert.equal((await reconcileShipmentStock(s.schema.sql, returning)).moves, 0);
      assert.ok(!(await awaiting()).includes(returning));

      // The unmatched parcel's check-in is recorded although it has no lines to move.
      assert.equal((await checkInReturn(s.schema.sql, unmatched, 'restocked', actor)).skipped, 'unmatched');
      assert.deepEqual(await awaiting(), []);
    });

    it('a PR parcel delivered goes to marketing; refused, it comes back through returning like any other (S10)', async () => {
      const delivered = await parcel(s.schema.sql, { accountId, orderId: await order([{ variantId: variants[3]!, qty: 1 }], 'pr'), events: [['0005', '2026-09-03T09:00:00Z']] });
      const refused = await parcel(s.schema.sql, { accountId, orderId: await order([{ variantId: variants[3]!, qty: 1 }], 'pr'), events: [['0040', '2026-09-03T09:00:00Z']] });
      assert.equal((await reconcileShipmentStock(s.schema.sql, delivered)).target, 'marketing');
      assert.equal((await reconcileShipmentStock(s.schema.sql, refused)).target, 'returning');
    });

    it('cancelled by merchant (0002) after booking puts the units back in the warehouse (S9)', async () => {
      const variantId = variants[4]!;
      const before = await qtyAt(variantId, 'warehouse');
      const id = await parcel(s.schema.sql, { accountId, orderId: await order([{ variantId, qty: 4 }]) });
      await reconcileShipmentStock(s.schema.sql, id);
      assert.equal(await qtyAt(variantId, 'warehouse'), before - 4);
      await addEvent(s.schema.sql, id, '0002', '2026-09-02T09:00:00Z');
      await reconcileShipmentStock(s.schema.sql, id);
      assert.equal(await qtyAt(variantId, 'warehouse'), before);
      assert.deepEqual(await movesOf(id), ['warehouse→in_transit ×4 (shipment)', 'in_transit→warehouse ×4 (shipment_event)']);
    });

    it('follows an outcome that flips: failed attempt, then delivered', async () => {
      const id = await parcel(s.schema.sql, { accountId, orderId: await order([{ variantId: variants[0]!, qty: 1 }]), events: [['0013', '2026-09-02T09:00:00Z']] });
      assert.equal((await reconcileShipmentStock(s.schema.sql, id)).target, 'in_transit');
      await addEvent(s.schema.sql, id, '0005', '2026-09-03T09:00:00Z');
      assert.equal((await reconcileShipmentStock(s.schema.sql, id)).target, 'customer');
      assert.deepEqual(await movesOf(id), ['warehouse→in_transit ×1 (shipment)', 'in_transit→customer ×1 (shipment_event)']);
    });

    it('replaying the same events, or back-filling an older one, creates no duplicate moves', async () => {
      const events: Array<[string, string]> = [['0013', '2026-09-02T09:00:00Z'], ['0040', '2026-09-03T09:00:00Z'], ['0006', '2026-09-06T09:00:00Z']];
      const id = await parcel(s.schema.sql, { accountId, orderId: await order([{ variantId: variants[2]!, qty: 2 }]), events });
      await reconcileShipmentStock(s.schema.sql, id);
      const first = await movesOf(id);
      for (const [code, when] of events) await addEvent(s.schema.sql, id, code, when);
      await reconcileShipmentStock(s.schema.sql, id);
      await addEvent(s.schema.sql, id, '0008', '2026-09-01T12:00:00Z');
      await reconcileShipmentStock(s.schema.sql, id);
      assert.deepEqual(await movesOf(id), first);
    });

    it('moves only mapped lines, and queues the order once for the ones it cannot move', async () => {
      const orderId = await order([{ variantId: variants[0]!, qty: 1 }, { variantId: null, qty: 2 }]);
      const id = await parcel(s.schema.sql, { accountId, orderId });
      await reconcileShipmentStock(s.schema.sql, id);
      assert.deepEqual(await movesOf(id), ['warehouse→in_transit ×1 (shipment)']);
      const items = await s.schema.sql`select detail from reconciliation_items where kind = 'stock_unmapped_line' and order_id = ${orderId}`;
      assert.equal(items.length, 1);
    });

    it('leaves an unmatched parcel alone and clears the pending mark once a parcel is in line', async () => {
      const unmatched = await parcel(s.schema.sql, { accountId, orderId: null, events: [['0005', '2026-09-03T09:00:00Z']] });
      assert.equal((await reconcileShipmentStock(s.schema.sql, unmatched)).skipped, 'unmatched');
      const matched = await parcel(s.schema.sql, { accountId, orderId: await order([{ variantId: variants[0]!, qty: 1 }]) });
      await reconcileShipmentStock(s.schema.sql, matched);
      const rows = await s.schema.sql<{ id: string; stock_pending: boolean }[]>`select id, stock_pending from shipments where id in (${unmatched}, ${matched})`;
      assert.deepEqual(Object.fromEntries(rows.map((r) => [r.id, r.stock_pending])), { [unmatched]: true, [matched]: false });
    });

    it('after every parcel scenario above, quants still equal a full rebuild', async () => {
      const live = await quants();
      assert.deepEqual(live, await recomputed());
      await rebuildQuants(s.schema.sql);
      assert.deepEqual(await quants(), live);
    });
  });
});
