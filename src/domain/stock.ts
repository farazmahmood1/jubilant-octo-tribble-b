import type { Sql } from '../db.js';
import { openReviewItem } from '../db/repos/review.js';
import { type Db, atomically } from '../db/repos/upsert.js';
import { POSTEX_STATUS_CODES, type ShipmentEvent } from '../integrations/postex/mapper.js';
import { type OrderState, explain } from './order-state.js';

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
    const [checkIn] = await tx<{ id: string; outcome: 'restocked' | 'damaged'; actor_id: string; checked_in_at: Date }[]>`
      select id, outcome, actor_id, checked_in_at from return_check_ins where shipment_id = ${shipmentId}
    `;

    // The parcel's own outcome, whatever the order's channel: a PR parcel is refused and
    // returned like any other (S10), so `explain` is asked about the parcel, not the PR order.
    const events: ShipmentEvent[] = stored.map((e) => ({ code: e.code, message: e.message, occurredAt: e.occurred_at, known: Object.hasOwn(POSTEX_STATUS_CODES, e.code) }));
    const parcelState = explain({ order: { channel: 'online', cancelledAt: null }, shipment: { trackingNumber: parcel.tracking_number }, events, confirmation: null });

    let target: LocationKey;
    let ref: { type: string; id: string; at: Date; actorId: string | null; reason: string };
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

/**
 * A person has the returned parcel in hand: its units go back on the shelf or to damaged. Allowed
 * once PostEx has started the return (0040) or finished it (0006); the team often has the parcel
 * before PostEx updates. Recorded once per parcel and audited (rule 8).
 */
export const checkInReturn = async (
  sql: Sql,
  shipmentId: string,
  outcome: 'restocked' | 'damaged',
  actorId: string,
  note?: string,
): Promise<ReconcileResult> => {
  await atomically(sql, async (tx) => {
    const [parcel] = await tx<{ status_code: string | null; tracking_number: string }[]>`
      select status_code, tracking_number from shipments where id = ${shipmentId} for update
    `;
    if (!parcel) throw new StockError(`Shipment ${shipmentId} not found`);
    if (parcel.status_code !== '0040' && parcel.status_code !== '0006') {
      throw new StockError(`Parcel ${parcel.tracking_number} is not being returned (status ${parcel.status_code ?? 'none'}); nothing to check in`);
    }
    const [row] = await tx<{ id: string }[]>`
      insert into return_check_ins (shipment_id, outcome, note, actor_id) values (${shipmentId}, ${outcome}, ${note ?? null}, ${actorId})
      on conflict (shipment_id) do nothing
      returning id
    `;
    if (!row) throw new StockError(`Parcel ${parcel.tracking_number} is already checked in`);
    // A damaged return is written off in the journal: the accounting pass picks it up.
    await tx`update shipments set accounting_pending = true where id = ${shipmentId}`;
    await tx`
      insert into audit_log (actor_id, action, entity, entity_id, after)
      values (${actorId}, 'stock.return_check_in', 'shipments', ${shipmentId}, ${tx.json({ outcome, checkInId: row.id } as never)})
    `;
  });
  return reconcileShipmentStock(sql, shipmentId);
};

export interface AwaitingCheckIn {
  shipmentId: string;
  trackingNumber: string;
  account: string;
  orderId: string | null;
  returnedAt: Date | null;
}

/**
 * The returns-not-checked-in alert: PostEx says the parcel is back at the merchant (0006) and
 * nobody has checked it in. Unmatched parcels are included; the parcel is physically missing
 * whether or not its order is known. Oldest first.
 */
export const returnsAwaitingCheckIn = async (db: Db, storeKey?: string): Promise<AwaitingCheckIn[]> => {
  const rows = await db<{ id: string; tracking_number: string; account: string; order_id: string | null; returned_at: Date | null }[]>`
    select s.id, s.tracking_number, a.key as account, s.order_id, s.status_updated_at as returned_at
    from shipments s
    join postex_accounts a on a.id = s.postex_account_id
    where s.status_code = '0006'
      ${storeKey ? db`and a.store_id = (select id from stores where key = ${storeKey})` : db``}
      and not exists (select 1 from return_check_ins c where c.shipment_id = s.id)
    order by s.status_updated_at nulls last, s.id
  `;
  return rows.map((r) => ({ shipmentId: r.id, trackingNumber: r.tracking_number, account: r.account, orderId: r.order_id, returnedAt: r.returned_at }));
};
