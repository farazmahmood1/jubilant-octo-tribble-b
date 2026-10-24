import type { Sql } from '../db.js';
import { openReviewItem } from '../db/repos/review.js';
import { type Db, atomically } from '../db/repos/upsert.js';
import { POSTEX_STATUS_CODES, type ShipmentEvent } from '../integrations/postex/mapper.js';
import { type OrderState, type ParcelStage, RETURN_STAGES, explain } from './order-state.js';

/**
 * The stock ledger (BUILD-PLAN 1.4, Step 8). A unit only ever moves from one location to another;
 * `stock_quants` follows from the moves (a trigger keeps it current, `rebuildQuants` recomputes it
 * from nothing) and is never written directly (rule 6).
 *
 * A parcel's units move as its PostEx outcome changes. Rather than mapping each event to a move,
 * the parcel's target location is derived from its full event history (the same replay the order
 * state uses), and its units are moved from wherever its own moves left them to that target. A
 * replayed or back-filled event therefore cannot move stock twice, and an outcome that flips
 * (failed, then delivered) moves only what changed.
 */

export type LocationKey = 'warehouse' | 'in_transit' | 'returning' | 'customer' | 'marketing' | 'damaged' | 'supplier' | 'adjustment';

export interface MoveInput {
  variantId: string;
  qty: number;
  from: string;
  to: string;
  reason: string;
  refType: string;
  refId: string;
  shipmentId?: string | null;
  actorId?: string | null;
  occurredAt: Date;
  note?: string | null;
}

export class StockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StockError';
  }
}

const locationIds = new WeakMap<object, Map<LocationKey, string>>();

/** The id of a system location. Looked up once per client. */
export const locationId = async (db: Db, key: LocationKey): Promise<string> => {
  let ids = locationIds.get(db);
  if (!ids) {
    const rows = await db<{ id: string; key: LocationKey }[]>`select id, key from locations where key is not null`;
    ids = new Map(rows.map((r) => [r.key, r.id]));
    locationIds.set(db, ids);
  }
  const id = ids.get(key);
  if (!id) throw new StockError(`Location "${key}" is not seeded`);
  return id;
};

/**
 * Records one move: always a from and a to, never a bare delta. A move with the same reference,
 * variant and locations as one already recorded is skipped, so replaying the cause is a no-op.
 * Returns whether a row was written.
 */
export const recordMove = async (db: Db, move: MoveInput): Promise<boolean> => {
  if (!Number.isInteger(move.qty) || move.qty <= 0) throw new StockError(`Move quantity must be a positive integer, got ${move.qty}`);
  if (move.from === move.to) throw new StockError('A move needs two different locations');
  const rows = await db`
    insert into stock_moves (variant_id, qty, from_location_id, to_location_id, reason, ref_type, ref_id, shipment_id, actor_id, occurred_at, note)
    values (${move.variantId}, ${move.qty}, ${move.from}, ${move.to}, ${move.reason}, ${move.refType}, ${move.refId},
            ${move.shipmentId ?? null}, ${move.actorId ?? null}, ${move.occurredAt}, ${move.note ?? null})
    on conflict (ref_type, ref_id, variant_id, from_location_id, to_location_id) do nothing
    returning id
  `;
  return rows.length > 0;
};

/**
 * Recomputes every quant from the ledger. Inserts into stock_moves wait for it (the table lock),
 * so the result is exact at the moment it commits. Returns the number of quant rows.
 */
export const rebuildQuants = async (sql: Sql): Promise<number> =>
  atomically(sql, async (tx) => {
    await tx`lock table stock_moves in share mode`;
    await tx`delete from stock_quants`;
    const rows = await tx`
      insert into stock_quants (variant_id, location_id, qty)
      select variant_id, location_id, sum(qty)::bigint from (
        select variant_id, from_location_id as location_id, -qty as qty from stock_moves
        union all
        select variant_id, to_location_id, qty from stock_moves
      ) legs
      group by variant_id, location_id
      returning variant_id
    `;
    return rows.length;
  });

export interface AdjustmentLine {
  variantId: string;
  /** Positive adds stock at the location, negative removes it. */
  delta: number;
}

/**
 * A count or correction: each line moves units between `adjustment` and the location, so even a
 * correction has a counterpart and a reason. Audited with the actor (rule 8).
 */
export const recordAdjustment = async (
  sql: Sql,
  input: {
    locationId: string;
    reason: 'opening_stock' | 'count' | 'correction' | 'damage' | 'loss';
    note?: string;
    actorId: string;
    lines: AdjustmentLine[];
    /**
     * When the count was true, for an opening stock count taken as at the cut-over date. Only
     * opening stock may be dated back: any other count is true when it is recorded.
     */
    at?: Date;
  },
): Promise<string> =>
  atomically(sql, async (tx) => {
    const lines = input.lines.filter((l) => l.delta !== 0);
    if (lines.length === 0) throw new StockError('An adjustment needs at least one non-zero line');
    if (input.at && input.reason !== 'opening_stock') throw new StockError('Only an opening stock count can be dated back');
    const [row] = await tx<{ id: string; at: Date }[]>`
      insert into stock_adjustments (location_id, reason, note, actor_id, at)
      values (${input.locationId}, ${input.reason}, ${input.note ?? null}, ${input.actorId}, ${input.at ?? new Date()})
      returning id, at
    `;
    if (!row) throw new StockError('Adjustment insert returned no row');
    const adjustment = await locationId(tx, 'adjustment');
    for (const line of lines) {
      const inbound = line.delta > 0;
      await recordMove(tx, {
        variantId: line.variantId,
        qty: Math.abs(line.delta),
        from: inbound ? adjustment : input.locationId,
        to: inbound ? input.locationId : adjustment,
        reason: input.reason,
        refType: 'stock_adjustment',
        refId: row.id,
        actorId: input.actorId,
        occurredAt: row.at,
      });
    }
    await tx`
      insert into audit_log (actor_id, action, entity, entity_id, after)
      values (${input.actorId}, 'stock.adjust', 'stock_adjustments', ${row.id},
              ${tx.json({ locationId: input.locationId, reason: input.reason, lines } as never)})
    `;
    return row.id;
  });

/**
 * Where a parcel's units belong for a parcel state (step 8 table, with 3.2 notes S8–S10):
 * - booked or failed: still with PostEx;
 * - delivered: sold, or marketing for a PR order (S10: PR parcels travel like any other);
 * - return initiated (0040) and returned at merchant (0006): `returning`. 0006 moves nothing
 *   (S8); only a person checking the parcel in does;
 * - cancelled by merchant (0002): back to the warehouse (S9).
 */
export const targetFor = (state: OrderState, isPr: boolean): LocationKey => {
  switch (state) {
    case 'delivered':
      return isPr ? 'marketing' : 'customer';
    case 'returning':
    case 'returned_received':
      return 'returning';
    case 'cancelled':
      return 'warehouse';
    default:
      return 'in_transit';
  }
};

/**
 * A parcel was linked to the wrong order, so the units its moves carried are the wrong order's
 * lines. Puts everything the parcel holds back in the warehouse, so a later link books the right
 * order's lines from a clean start. Returns the number of moves written.
 *
 * `refId` must be unique to this unlink (its audit row), because a parcel can be linked and
 * unlinked more than once and a repeated reference would be skipped as a replay. A parcel
 * already checked in is refused: a person decided where those units went.
 */
export const returnParcelStockToWarehouse = async (db: Db, input: { shipmentId: string; refId: string; actorId: string; at: Date }): Promise<number> => {
  const [checkIn] = await db`select 1 from return_check_ins where shipment_id = ${input.shipmentId}`;
  if (checkIn) throw new StockError('This parcel has been checked in; its stock was placed by a person and is not undone by an unlink');
  const warehouse = await locationId(db, 'warehouse');
  let moves = 0;
  for (const holding of await holdings(db, input.shipmentId)) {
    if (holding.locationId === warehouse) continue;
    const written = await recordMove(db, {
      variantId: holding.variantId,
      qty: holding.qty,
      from: holding.locationId,
      to: warehouse,
      reason: 'unlink',
      refType: 'shipment_unlink',
      refId: input.refId,
      shipmentId: input.shipmentId,
      actorId: input.actorId,
      occurredAt: input.at,
    });
    if (written) moves++;
  }
  return moves;
};

export interface ReconcileResult {
  shipmentId: string;
  orderId: string | null;
  /** Why nothing was looked at: the parcel has no order yet, so there are no lines to move. */
  skipped?: 'unmatched';
  target?: LocationKey;
  moves: number;
}

interface Holding {
  variantId: string;
  locationId: string;
  qty: number;
}

/** What the parcel's own moves have put where: the net per (variant, location), positive only. */
const holdings = async (tx: Db, shipmentId: string): Promise<Holding[]> => {
  const rows = await tx<{ variant_id: string; location_id: string; qty: number }[]>`
    select variant_id, location_id, sum(qty)::int as qty from (
      select variant_id, from_location_id as location_id, -qty as qty from stock_moves where shipment_id = ${shipmentId}
      union all
      select variant_id, to_location_id, qty from stock_moves where shipment_id = ${shipmentId}
    ) legs
    group by variant_id, location_id
    having sum(qty) > 0
    order by variant_id, location_id
  `;
  return rows.map((r) => ({ variantId: r.variant_id, locationId: r.location_id, qty: r.qty }));
};

/**
 * Brings one parcel's stock in line with its PostEx history and any check-in. Safe to call any
 * number of times: with nothing new it writes nothing.
 *
 * The parcel's units are the order's mapped lines at the time it first leaves the warehouse;
 * from then on the ledger, not the order, says what the parcel holds. Lines with no variant
 * cannot move and are queued once per order.
 */
export const reconcileShipmentStock = async (sql: Sql, shipmentId: string): Promise<ReconcileResult> =>
  atomically(sql, async (tx) => {
    const [parcel] = await tx<
      { tracking_number: string; order_id: string | null; channel: 'online' | 'consignment' | 'pr' | null; store_id: string | null; booked_at: Date | null; created_at: Date }[]
    >`
      select s.tracking_number, s.order_id, case when shipment_is_pr(s.id) then 'pr' else o.channel end as channel, o.store_id, s.booked_at, s.created_at
      from shipments s left join orders o on o.id = s.order_id
      where s.id = ${shipmentId}
      for update of s
    `;
    if (!parcel) throw new StockError(`Shipment ${shipmentId} not found`);
    if (!parcel.order_id) return { shipmentId, orderId: null, skipped: 'unmatched', moves: 0 };

    const stored = await tx<{ id: string; code: string; message: string; occurred_at: Date | null; created_at: Date }[]>`
      select id, code, message, occurred_at, created_at from shipment_events where shipment_id = ${shipmentId}
    `;
    const [checkIn] = await tx<{ id: string; outcome: CheckInOutcome; actor_id: string; checked_in_at: Date }[]>`
      select id, outcome, actor_id, checked_in_at from return_check_ins where shipment_id = ${shipmentId}
    `;

    // The parcel's own outcome, whatever the order's channel: a PR parcel is refused and
    // returned like any other (S10), so `explain` is asked about the parcel, not the PR order.
    const events: ShipmentEvent[] = stored.map((e) => ({ code: e.code, message: e.message, occurredAt: e.occurred_at, known: Object.hasOwn(POSTEX_STATUS_CODES, e.code) }));
    const parcelState = explain({ order: { channel: 'online', cancelledAt: null }, shipment: { trackingNumber: parcel.tracking_number }, events, confirmation: null });

    let target: LocationKey;
    let ref: { type: string; id: string; at: Date; actorId: string | null; reason: string };
    if (checkIn?.outcome === 'mixed') {
      const moves = await splitCheckIn(tx, shipmentId, checkIn);
      await tx`update shipments set stock_pending = false where id = ${shipmentId} and stock_pending`;
      return { shipmentId, orderId: parcel.order_id, target: 'warehouse', moves };
    }
    if (checkIn) {
      target = checkIn.outcome === 'restocked' ? 'warehouse' : 'damaged';
      ref = { type: 'return_check_in', id: checkIn.id, at: checkIn.checked_in_at, actorId: checkIn.actor_id, reason: `return_${checkIn.outcome}` };
    } else {
      target = targetFor(parcelState.state, parcel.channel === 'pr');
      const decider = parcelState.decidedBy.kind === 'event' ? parcelState.decidedBy : null;
      const event = decider ? stored.find((e) => e.code === decider.code && (e.occurred_at?.getTime() ?? null) === (decider.occurredAt?.getTime() ?? null)) : undefined;
      ref = event
        ? { type: 'shipment_event', id: event.id, at: event.occurred_at ?? event.created_at, actorId: null, reason: `postex_${event.code}` }
        : { type: 'shipment', id: shipmentId, at: parcel.booked_at ?? parcel.created_at, actorId: null, reason: 'booked' };
    }

    const targetId = await locationId(tx, target);
    let held = await holdings(tx, shipmentId);
    let moves = 0;

    // First departure: the booking takes the order's lines out of the warehouse. A parcel
    // cancelled before anything left has nothing to move.
    if (held.length === 0 && target !== 'warehouse') {
      const lines = await tx<{ variant_id: string | null; qty: number; title: string }[]>`
        select variant_id, qty, title from order_lines where order_id = ${parcel.order_id} and qty > 0 order by id
      `;
      const unmapped = lines.filter((l) => l.variant_id === null);
      if (unmapped.length > 0) {
        await openReviewItem(tx, {
          kind: 'stock_unmapped_line',
          dedupeKey: `stock_unmapped_line:${parcel.order_id}`,
          storeId: parcel.store_id,
          orderId: parcel.order_id,
          shipmentId,
          detail: { trackingNumber: parcel.tracking_number, lines: unmapped.map((l) => ({ title: l.title, qty: l.qty })) },
        });
      }
      const warehouse = await locationId(tx, 'warehouse');
      const inTransit = await locationId(tx, 'in_transit');
      const perVariant = new Map<string, number>();
      for (const line of lines) if (line.variant_id) perVariant.set(line.variant_id, (perVariant.get(line.variant_id) ?? 0) + line.qty);
      for (const [variantId, qty] of perVariant) {
        if (
          await recordMove(tx, {
            variantId,
            qty,
            from: warehouse,
            to: inTransit,
            reason: 'booked',
            refType: 'shipment',
            refId: shipmentId,
            shipmentId,
            occurredAt: parcel.booked_at ?? parcel.created_at,
          })
        )
          moves++;
      }
      held = await holdings(tx, shipmentId);
    }

    for (const holding of held) {
      if (holding.locationId === targetId) continue;
      if (
        await recordMove(tx, {
          variantId: holding.variantId,
          qty: holding.qty,
          from: holding.locationId,
          to: targetId,
          reason: ref.reason,
          refType: ref.type,
          refId: ref.id,
          shipmentId,
          actorId: ref.actorId,
          occurredAt: ref.at,
        })
      )
        moves++;
    }
    await tx`update shipments set stock_pending = false where id = ${shipmentId} and stock_pending`;
    return { shipmentId, orderId: parcel.order_id, target, moves };
  });

export type CheckInOutcome = 'restocked' | 'damaged' | 'mixed';

/** One product of a split check-in: how many of its units went back on the shelf, and how many are damaged. */
export interface CheckInLine {
  variantId: string;
  restocked: number;
  damaged: number;
}

/**
 * A split check-in's moves: per product, its damaged units to `damaged` and the rest to the
 * shelf, from wherever the parcel's own moves left them. Re-running writes nothing: once a
 * product is placed, the parcel holds nothing more of it anywhere else.
 */
const splitCheckIn = async (tx: Db, shipmentId: string, checkIn: { id: string; actor_id: string; checked_in_at: Date }): Promise<number> => {
  const lines = await tx<{ variant_id: string; damaged: number }[]>`
    select variant_id, damaged from return_check_in_lines where check_in_id = ${checkIn.id}
  `;
  const damagedOf = new Map(lines.map((l) => [l.variant_id, l.damaged]));
  const warehouse = await locationId(tx, 'warehouse');
  const damaged = await locationId(tx, 'damaged');
  const held = await holdings(tx, shipmentId);
  let moves = 0;
  for (const variantId of new Set(held.map((h) => h.variantId))) {
    let toDamage = (damagedOf.get(variantId) ?? 0) - (held.find((h) => h.variantId === variantId && h.locationId === damaged)?.qty ?? 0);
    for (const holding of held.filter((h) => h.variantId === variantId && h.locationId !== damaged)) {
      const broken = Math.min(Math.max(toDamage, 0), holding.qty);
      toDamage -= broken;
      const parts: Array<[string, number, string]> = [
        [damaged, broken, 'return_damaged'],
        [warehouse, holding.qty - broken, 'return_restocked'],
      ];
      for (const [to, qty, reason] of parts) {
        if (qty <= 0) continue;
        const written = await recordMove(tx, {
          variantId,
          qty,
          from: holding.locationId,
          to,
          reason,
          refType: 'return_check_in',
          refId: checkIn.id,
          shipmentId,
          actorId: checkIn.actor_id,
          occurredAt: checkIn.checked_in_at,
        });
        if (written) moves++;
      }
    }
  }
  return moves;
};

/**
 * A person has the returned parcel in hand: its units go back on the shelf, to damaged, or split
 * product by product (`lines`, which must account for every unit the parcel carried). Allowed once
 * the parcel's history says it is coming back (0040, and every movement after it) or is back
 * (0006); the team often has the parcel before PostEx updates. Recorded once per parcel and
 * audited (rule 8): a second check-in of the same parcel, from a double click or a retry, is
 * refused and changes nothing.
 */
export const checkInReturn = async (
  sql: Sql,
  shipmentId: string,
  outcome: CheckInOutcome,
  actorId: string,
  note?: string,
  lines?: readonly CheckInLine[],
): Promise<ReconcileResult> => {
  await atomically(sql, async (tx) => {
    const [parcel] = await tx<{ stage: ParcelStage | null; status_code: string | null; tracking_number: string }[]>`
      select stage, status_code, tracking_number from shipments where id = ${shipmentId} for update
    `;
    if (!parcel) throw new StockError(`Shipment ${shipmentId} not found`);
    const coming = parcel.stage ? RETURN_STAGES.includes(parcel.stage) : parcel.status_code === '0040' || parcel.status_code === '0006';
    if (!coming) {
      throw new StockError(`Parcel ${parcel.tracking_number} is not being returned (${parcel.stage ?? `status ${parcel.status_code ?? 'none'}`}); nothing to check in`);
    }
    const split = outcome === 'mixed' ? await validSplit(tx, shipmentId, parcel.tracking_number, lines ?? []) : null;
    const [row] = await tx<{ id: string }[]>`
      insert into return_check_ins (shipment_id, outcome, note, actor_id) values (${shipmentId}, ${outcome}, ${note ?? null}, ${actorId})
      on conflict (shipment_id) do nothing
      returning id
    `;
    if (!row) throw new StockError(`Parcel ${parcel.tracking_number} is already checked in`);
    for (const line of split ?? []) {
      await tx`insert into return_check_in_lines (check_in_id, variant_id, restocked, damaged) values (${row.id}, ${line.variantId}, ${line.restocked}, ${line.damaged})`;
    }
    // A damaged return is written off in the journal: the accounting pass picks it up.
    await tx`update shipments set accounting_pending = true where id = ${shipmentId}`;
    await tx`
      insert into audit_log (actor_id, action, entity, entity_id, after)
      values (${actorId}, 'stock.return_check_in', 'shipments', ${shipmentId}, ${tx.json({ outcome, checkInId: row.id, ...(split ? { lines: split } : {}) } as never)})
    `;
  });
  return reconcileShipmentStock(sql, shipmentId);
};

/**
 * A split must place every unit the parcel carried, per product, and nothing else: a product the
 * parcel did not carry, a count that does not add up, or a split that sends everything one way
 * (that is a plain restock or damaged check-in) is refused with what was expected.
 */
const validSplit = async (tx: Db, shipmentId: string, trackingNumber: string, lines: readonly CheckInLine[]): Promise<CheckInLine[]> => {
  const carried = await tx<{ variant_id: string; qty: number }[]>`
    select variant_id, sum(qty)::int as qty from stock_moves where shipment_id = ${shipmentId} and ref_type = 'shipment' and reason = 'booked' group by variant_id
  `;
  if (carried.length === 0) throw new StockError(`Parcel ${trackingNumber}'s items are not linked to products, so it can only be checked in whole`);
  const given = new Map<string, CheckInLine>();
  for (const line of lines) {
    if (!Number.isInteger(line.restocked) || !Number.isInteger(line.damaged) || line.restocked < 0 || line.damaged < 0) throw new StockError('Quantities must be whole numbers, zero or more');
    if (given.has(line.variantId)) throw new StockError('A product appears twice in the check-in');
    given.set(line.variantId, line);
  }
  for (const id of given.keys()) {
    if (!carried.some((c) => c.variant_id === id)) throw new StockError(`Parcel ${trackingNumber} did not carry product ${id}`);
  }
  const split = carried.map((c) => {
    const line = given.get(c.variant_id);
    if (!line || line.restocked + line.damaged !== c.qty) {
      throw new StockError(`Parcel ${trackingNumber} carried ${c.qty} of product ${c.variant_id}; restocked and damaged must add up to ${c.qty}`);
    }
    return { variantId: c.variant_id, restocked: line.restocked, damaged: line.damaged };
  });
  if (split.every((l) => l.damaged === 0) || split.every((l) => l.restocked === 0)) {
    throw new StockError('Everything went one way: check the parcel in as restocked or as damaged instead of splitting it');
  }
  return split;
};

export interface AwaitingCheckIn {
  shipmentId: string;
  trackingNumber: string;
  account: string;
  orderId: string | null;
  returnedAt: Date | null;
}

/**
 * The returns-not-checked-in alert: PostEx says the parcel is back at the merchant (stage
 * `returned`, its 0006, whatever movement codes came with it) and nobody has checked it in.
 * Unmatched parcels are included; the parcel is physically missing whether or not its order is
 * known. Oldest first. Parcels still on their way back are counted by `returnsComingBack`.
 */
export const returnsAwaitingCheckIn = async (db: Db, storeKey?: string): Promise<AwaitingCheckIn[]> => {
  const rows = await db<{ id: string; tracking_number: string; account: string; order_id: string | null; returned_at: Date | null }[]>`
    select s.id, s.tracking_number, a.key as account, s.order_id,
           coalesce((select max(e.occurred_at) from shipment_events e where e.shipment_id = s.id and e.code = '0006'), s.status_updated_at) as returned_at
    from shipments s
    join postex_accounts a on a.id = s.postex_account_id
    where coalesce(s.stage = 'returned', s.status_code = '0006')
      ${storeKey ? db`and a.store_id = (select id from stores where key = ${storeKey})` : db``}
      and not exists (select 1 from return_check_ins c where c.shipment_id = s.id)
    order by returned_at nulls last, s.id
  `;
  return rows.map((r) => ({ shipmentId: r.id, trackingNumber: r.tracking_number, account: r.account, orderId: r.order_id, returnedAt: r.returned_at }));
};

/** Parcels PostEx is bringing back (return started, not handed over yet) that nobody has checked in early. */
export const returnsComingBack = async (db: Db, storeKey?: string): Promise<number> => {
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n from shipments s join postex_accounts a on a.id = s.postex_account_id
    where s.stage = 'returning'
      ${storeKey ? db`and a.store_id = (select id from stores where key = ${storeKey})` : db``}
      and not exists (select 1 from return_check_ins c where c.shipment_id = s.id)
  `;
  return row?.n ?? 0;
};

// ---- Stock counts ----

export interface CountLine {
  variantId: string;
  /** Units found on the shelf. */
  counted: number;
}

export interface CountResult {
  adjustmentId: string | null;
  /** Products whose shelf differed from the ledger, and by how much in all. */
  lines: number;
  units: number;
}

/**
 * A physical count of the warehouse, entered as what was found rather than as differences: each
 * line's difference from the warehouse quant is worked out here, inside the transaction, so a
 * parcel booked while the sheet was open cannot make the count wrong. Lines that agree move
 * nothing. An opening count may be dated back to the cut-over day and is taken once per brand;
 * after that a count is a `count`, true on the day it is recorded.
 */
export const recordCount = async (
  sql: Sql,
  input: { reason: 'opening_stock' | 'count'; at?: Date; note?: string; actorId: string; lines: readonly CountLine[] },
): Promise<CountResult> =>
  atomically(sql, async (tx) => {
    if (input.lines.some((l) => !Number.isInteger(l.counted) || l.counted < 0)) throw new StockError('A counted quantity must be a whole number, zero or more');
    if (new Set(input.lines.map((l) => l.variantId)).size !== input.lines.length) throw new StockError('A product appears twice on the count');
    await tx`lock table stock_moves in share row exclusive mode`;
    const warehouse = await locationId(tx, 'warehouse');
    const ids = input.lines.map((l) => l.variantId);
    const held = await tx<{ variant_id: string; qty: number; store: string }[]>`
      select v.id as variant_id, coalesce(q.qty, 0)::int as qty, st.key as store
      from variants v join stores st on st.id = v.store_id
      left join stock_quants q on q.variant_id = v.id and q.location_id = ${warehouse}
      where v.id = any(${ids}::bigint[])
    `;
    if (held.length !== ids.length) throw new StockError('A product on the count is not in the catalogue');
    if (input.reason === 'opening_stock') {
      const stores = [...new Set(held.map((h) => h.store))];
      const [taken] = await tx<{ store: string }[]>`
        select distinct st.key as store
        from stock_adjustments a
        join stock_moves m on m.ref_type = 'stock_adjustment' and m.ref_id = a.id::text
        join variants v on v.id = m.variant_id join stores st on st.id = v.store_id
        where a.reason = 'opening_stock' and st.key = any(${stores}::text[])
        limit 1
      `;
      if (taken) throw new StockError(`The opening stock for ${taken.store === 'nur' ? 'NUR by Juggun' : "Juggun's Organics"} is already entered; record this as a stock count`);
    }
    const now = new Map(held.map((h) => [h.variant_id, h.qty]));
    const deltas = input.lines.map((l) => ({ variantId: l.variantId, delta: l.counted - (now.get(l.variantId) ?? 0) })).filter((l) => l.delta !== 0);
    if (deltas.length === 0) return { adjustmentId: null, lines: 0, units: 0 };
    const adjustmentId = await recordAdjustment(tx as unknown as Sql, {
      locationId: warehouse,
      reason: input.reason,
      ...(input.note ? { note: input.note } : {}),
      actorId: input.actorId,
      ...(input.at ? { at: input.at } : {}),
      lines: deltas,
    });
    return { adjustmentId, lines: deltas.length, units: deltas.reduce((n, l) => n + l.delta, 0) };
  });

export interface CountSheetRow {
  variantId: string;
  store: string;
  product: string;
  variant: string;
  sku: string | null;
  /** What the ledger says is on the shelf now. */
  warehouse: number;
  inTransit: number;
  returning: number;
  /** Shopify's own figures, for reference; null when the variant has no Shopify stock record. */
  shopifyOnHand: number | null;
  shopifyAvailable: number | null;
}

/** Every product of a brand, with what the ledger holds where: the sheet a person counts against. */
export const countSheet = async (db: Db, store?: 'nur' | 'organics'): Promise<CountSheetRow[]> => {
  const rows = await db<
    { variant_id: string; store: string; product: string; variant: string; sku: string | null; warehouse: number; in_transit: number; returning: number; on_hand: number | null; available: number | null }[]
  >`
    select v.id as variant_id, st.key as store, p.title as product, v.title as variant, v.sku,
           coalesce(sum(q.qty) filter (where l.key = 'warehouse'), 0)::int as warehouse,
           coalesce(sum(q.qty) filter (where l.key = 'in_transit'), 0)::int as in_transit,
           coalesce(sum(q.qty) filter (where l.key = 'returning'), 0)::int as returning,
           (select sum(sl.on_hand)::int from shopify_stock_levels sl where sl.variant_id = v.id) as on_hand,
           (select sum(sl.available)::int from shopify_stock_levels sl where sl.variant_id = v.id) as available
    from variants v
    join products p on p.id = v.product_id
    join stores st on st.id = v.store_id
    left join stock_quants q on q.variant_id = v.id
    left join locations l on l.id = q.location_id
    where v.deleted_at is null ${store ? db`and st.key = ${store}` : db``}
    group by v.id, st.key, p.title, v.title, v.sku
    order by st.key, p.title, v.title
  `;
  return rows.map((r) => ({
    variantId: r.variant_id,
    store: r.store,
    product: r.product,
    variant: r.variant,
    sku: r.sku,
    warehouse: r.warehouse,
    inTransit: r.in_transit,
    returning: r.returning,
    shopifyOnHand: r.on_hand,
    shopifyAvailable: r.available,
  }));
};

export interface StockHealth {
  store: 'nur' | 'organics';
  /** When the opening count was entered (the day it is dated), or null if it never was. */
  openingCountAt: Date | null;
  lastCountAt: Date | null;
  /** Products whose shelf figure is below zero: sold before any count put them on the shelf. */
  negativeProducts: number;
  shelfUnits: number;
  withPostex: number;
  comingBack: number;
  /** Returned by PostEx (0006) and not checked in. */
  returnsWaiting: number;
  /** Order lines whose product is not in the catalogue, so their units cannot move. */
  unmappedLines: number;
}

/** Why each brand's shelf reads as it does: the facts the Inventory screen explains negatives with. */
export const stockHealth = async (db: Db): Promise<StockHealth[]> => {
  const rows = await db<
    { store: 'nur' | 'organics'; opening_at: Date | null; last_count_at: Date | null; negative: number; shelf: number; postex: number; back: number; waiting: number; unmapped: number }[]
  >`
    select st.key as store,
      (select max(a.at) from stock_adjustments a join stock_moves m on m.ref_type = 'stock_adjustment' and m.ref_id = a.id::text join variants v on v.id = m.variant_id
        where a.reason = 'opening_stock' and v.store_id = st.id) as opening_at,
      (select max(a.at) from stock_adjustments a join stock_moves m on m.ref_type = 'stock_adjustment' and m.ref_id = a.id::text join variants v on v.id = m.variant_id
        where a.reason = 'count' and v.store_id = st.id) as last_count_at,
      (select count(*)::int from stock_quants q join locations l on l.id = q.location_id join variants v on v.id = q.variant_id
        where l.key = 'warehouse' and q.qty < 0 and v.store_id = st.id) as negative,
      (select coalesce(sum(q.qty), 0)::int from stock_quants q join locations l on l.id = q.location_id join variants v on v.id = q.variant_id
        where l.key = 'warehouse' and v.store_id = st.id) as shelf,
      (select coalesce(sum(q.qty), 0)::int from stock_quants q join locations l on l.id = q.location_id join variants v on v.id = q.variant_id
        where l.key = 'in_transit' and v.store_id = st.id) as postex,
      (select coalesce(sum(q.qty), 0)::int from stock_quants q join locations l on l.id = q.location_id join variants v on v.id = q.variant_id
        where l.key = 'returning' and v.store_id = st.id) as back,
      (select count(*)::int from shipments s join postex_accounts a on a.id = s.postex_account_id
        where a.store_id = st.id and coalesce(s.stage = 'returned', s.status_code = '0006') and not exists (select 1 from return_check_ins c where c.shipment_id = s.id)) as waiting,
      (select count(*)::int from order_lines ol join orders o on o.id = ol.order_id
        where o.store_id = st.id and ol.variant_id is null and ol.qty > 0 and exists (select 1 from shipments s where s.order_id = o.id)) as unmapped
    from stores st order by st.key
  `;
  return rows.map((r) => ({
    store: r.store,
    openingCountAt: r.opening_at,
    lastCountAt: r.last_count_at,
    negativeProducts: r.negative,
    shelfUnits: r.shelf,
    withPostex: r.postex,
    comingBack: r.back,
    returnsWaiting: r.waiting,
    unmappedLines: r.unmapped,
  }));
};
