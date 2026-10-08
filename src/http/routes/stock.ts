import { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import { can } from '../../auth/permissions.js';
import { damagedRegister } from '../../db/repos/damaged.js';
import { postShipmentAccounting } from '../../domain/accounting.js';
import { type ShopifyReturnsGateway, syncCheckInToShopify } from '../../domain/shopify-returns.js';
import { openingStockFromShopify, shopifyStockComparison } from '../../domain/opening-stock.js';
import { StockError, checkInReturn, countSheet, recordAdjustment, recordCount, returnsAwaitingCheckIn, stockHealth } from '../../domain/stock.js';
import { endOfKarachiDay } from '../../lib/time.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { ID, parse } from '../validate.js';

/**
 * Stock screens (Step 8): the returns-not-checked-in alert, checking a return in, current stock,
 * and counts or corrections. Every change goes through the ledger functions, never a quantity
 * update, and is audited with the signed-in user.
 */

const shipmentParams = z.object({ shipmentId: z.string().regex(ID) });
const variantParams = z.object({ variantId: z.string().regex(ID) });
const movesQuery = z.object({ before: z.string().regex(ID).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const checkIn = z.object({ outcome: z.enum(['restocked', 'damaged']), note: z.string().trim().max(2000).optional() });
const quantsQuery = z.object({
  location: z.string().regex(/^[a-z_]+$/).optional(),
  store: z.enum(['nur', 'organics']).optional(),
  search: z.string().trim().max(80).optional(),
});
const adjustment = z.object({
  locationId: z.string().regex(ID),
  reason: z.enum(['opening_stock', 'count', 'correction', 'damage', 'loss']),
  note: z.string().trim().max(2000).optional(),
  /** Opening stock only: the Karachi day the count was true (the cut-over date). */
  asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z
    .array(z.object({ variantId: z.string().regex(ID), delta: z.number().int().refine((n) => n !== 0, 'must not be zero') }))
    .min(1)
    .max(500),
});
const storeQuery = z.object({ store: z.enum(['nur', 'organics']).optional() });
const openingFromShopify = z.object({ asAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), store: z.enum(['nur', 'organics']).optional() });
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const damagedQuery = z.object({
  store: z.enum(['nur', 'organics']).optional(),
  from: z.string().regex(DAY).optional(),
  to: z.string().regex(DAY).optional(),
  q: z.string().trim().max(60).optional(),
});
const count = z.object({
  reason: z.enum(['opening_stock', 'count']),
  /** Opening stock only: the Karachi day the count was true. */
  asAt: z.string().regex(DAY).optional(),
  note: z.string().trim().max(2000).optional(),
  lines: z.array(z.object({ variantId: z.string().regex(ID), counted: z.number().int().min(0).max(1_000_000) })).min(1).max(2000),
});
const variantsQuery = z.object({ search: z.string().trim().min(1).max(80), store: z.enum(['nur', 'organics']).optional() });

const asAtDay = (day: string): Date => {
  try {
    return endOfKarachiDay(day);
  } catch {
    throw new HttpError(400, `asAt: ${day} is not a real date`);
  }
};

/** StockError is a rule the request broke, not a server fault. */
const asHttp = (error: unknown): never => {
  if (error instanceof StockError) throw new HttpError(409, error.message);
  throw error;
};

export interface StockRouterOptions {
  /** Shopify for return check-ins; tests pass a fake, the default calls the real stores. */
  shopifyReturns?: ShopifyReturnsGateway;
}

export const stockRouter = (getSql: SqlProvider, options: StockRouterOptions = {}): Router => {
  const router = Router();
  const gateway = options.shopifyReturns;

  /** The check-in of a parcel, if it has one. */
  const checkInOf = async (shipmentId: string): Promise<string | null> => {
    const [row] = await requireSql(getSql)<{ id: string }[]>`select id from return_check_ins where shipment_id = ${shipmentId}`;
    return row?.id ?? null;
  };

  router.get('/stock/returns-awaiting', async (req, res) => {
    const sql = requireSql(getSql);
    const { store } = parse(storeQuery, req.query);
    res.json({ returns: await returnsAwaitingCheckIn(sql, store) });
  });

  router.post('/stock/returns/:shipmentId/check-in', async (req, res) => {
    const sql = requireSql(getSql);
    const { shipmentId } = parse(shipmentParams, req.params);
    const body = parse(checkIn, req.body);
    const actor = await actorId(sql, sessionUser(req));
    const result = await checkInReturn(sql, shipmentId, body.outcome, actor, body.note).catch(asHttp);
    // A damaged return is written off now rather than on the next sync.
    await postShipmentAccounting(sql, shipmentId);
    // Then Shopify: the check-in stands whatever Shopify says, and the attempt is kept to retry.
    const checkInId = await checkInOf(shipmentId);
    const shopify = checkInId ? await syncCheckInToShopify(sql, { checkInId, actorId: actor, ...(gateway ? { gateway } : {}) }) : null;
    res.json({ ...result, shopify });
  });

  /** Tries Shopify again for a check-in it refused or could not be reached for. */
  router.post('/stock/returns/:shipmentId/shopify-sync', async (req, res) => {
    const sql = requireSql(getSql);
    const { shipmentId } = parse(shipmentParams, req.params);
    const checkInId = await checkInOf(shipmentId);
    if (!checkInId) throw new HttpError(409, 'This parcel has not been checked in yet');
    const shopify = await syncCheckInToShopify(sql, { checkInId, actorId: await actorId(sql, sessionUser(req)), force: true, ...(gateway ? { gateway } : {}) });
    res.json({ shopify });
  });

  /** Every return checked in as damaged, with its items, dates and the cost written off. */
  router.get('/stock/damaged', async (req, res) => {
    const q = parse(damagedQuery, req.query);
    const result = await damagedRegister(
      requireSql(getSql),
      { ...(q.store ? { store: q.store } : {}), ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}), ...(q.q ? { search: q.q } : {}) },
      { phones: can(sessionUser(req).role, 'pii.phone') },
    );
    res.json(result);
  });

  /** Per brand, why the shelf reads as it does: opening count, returns waiting, unmapped lines. */
  router.get('/stock/health', async (_req, res) => {
    res.json({ stores: await stockHealth(requireSql(getSql)) });
  });

  /** Every product of the brand with what the ledger holds, to count the shelf against. */
  router.get('/stock/count-sheet', async (req, res) => {
    const { store } = parse(storeQuery, req.query);
    res.json({ rows: await countSheet(requireSql(getSql), store) });
  });

  /** A physical count, entered as what was found; the differences are worked out here. */
  router.post('/stock/counts', async (req, res) => {
    const sql = requireSql(getSql);
    const body = parse(count, req.body);
    if (body.asAt && body.reason !== 'opening_stock') throw new HttpError(400, 'asAt: only an opening count can be dated back');
    const result = await recordCount(sql, {
      reason: body.reason,
      actorId: await actorId(sql, sessionUser(req)),
      lines: body.lines,
      ...(body.note ? { note: body.note } : {}),
      ...(body.asAt ? { at: asAtDay(body.asAt) } : {}),
    }).catch(asHttp);
    res.status(result.adjustmentId ? 201 : 200).json(result);
  });

  router.get('/stock/locations', async (_req, res) => {
    const sql = requireSql(getSql);
    const rows = await sql<{ id: string; key: string | null; kind: string; label: string }[]>`
      select id, key, kind, label from locations where is_active order by id
    `;
    res.json({ locations: [...rows] });
  });

  /** Non-zero stock per variant and location. Quantities are whole units, sent as numbers. */
  router.get('/stock/quants', async (req, res) => {
    const sql = requireSql(getSql);
    const query = parse(quantsQuery, req.query);
    const like = query.search ? `%${query.search.replace(/[%_\\]/g, '\\$&')}%` : null;
    const rows = await sql<{ variant_id: string; store: string; sku: string | null; product: string; variant: string; location_id: string; location: string; location_kind: string; qty: number }[]>`
      select q.variant_id, st.key as store, v.sku, p.title as product, v.title as variant,
             l.id as location_id, coalesce(l.key, l.label) as location, l.kind as location_kind, q.qty::int as qty
      from stock_quants q
      join variants v on v.id = q.variant_id
      join products p on p.id = v.product_id
      join stores st on st.id = v.store_id
      join locations l on l.id = q.location_id
      where q.qty <> 0
        ${query.location ? sql`and l.key = ${query.location}` : sql``}
        ${query.store ? sql`and st.key = ${query.store}` : sql``}
        ${like ? sql`and (v.sku ilike ${like} or p.title ilike ${like} or v.title ilike ${like})` : sql``}
      order by st.key, p.title, v.title, l.id
      limit 1000
    `;
    res.json({ quants: [...rows] });
  });

  /**
   * Every move of one product, newest recorded first: where it came from and went, why, and who or
   * which parcel caused it. Read-only; the ledger is only ever written through its functions.
   */
  router.get('/stock/variants/:variantId/moves', async (req, res) => {
    const sql = requireSql(getSql);
    const { variantId } = parse(variantParams, req.params);
    const { before, limit } = parse(movesQuery, req.query);
    const [variant] = await sql`select 1 from variants where id = ${variantId}`;
    if (!variant) throw new HttpError(404, `Product ${variantId} not found`);
    const rows = await sql<
      {
        id: string; qty: number; reason: string; ref_type: string; ref_id: string; shipment_id: string | null; tracking_number: string | null;
        actor: string | null; occurred_at: Date; note: string | null; from_key: string | null; from_kind: string; from_label: string;
        to_key: string | null; to_kind: string; to_label: string;
      }[]
    >`
      select m.id, m.qty, m.reason, m.ref_type, m.ref_id, m.shipment_id, s.tracking_number, u.name as actor, m.occurred_at, m.note,
             lf.key as from_key, lf.kind as from_kind, lf.label as from_label, lt.key as to_key, lt.kind as to_kind, lt.label as to_label
      from stock_moves m
      join locations lf on lf.id = m.from_location_id
      join locations lt on lt.id = m.to_location_id
      left join shipments s on s.id = m.shipment_id
      left join users u on u.id = m.actor_id
      where m.variant_id = ${variantId} ${before ? sql`and m.id < ${before}` : sql``}
      order by m.id desc
      limit ${limit}
    `;
    res.json({
      moves: rows.map((r) => ({
        id: r.id,
        qty: r.qty,
        from: { key: r.from_key, kind: r.from_kind, label: r.from_label },
        to: { key: r.to_key, kind: r.to_kind, label: r.to_label },
        reason: r.reason,
        refType: r.ref_type,
        refId: r.ref_id,
        shipmentId: r.shipment_id,
        trackingNumber: r.tracking_number,
        actor: r.actor,
        occurredAt: r.occurred_at,
        note: r.note,
      })),
      nextBefore: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
    });
  });

  /** Variant search for the adjustment form. */
  router.get('/stock/variants', async (req, res) => {
    const sql = requireSql(getSql);
    const query = parse(variantsQuery, req.query);
    const like = `%${query.search.replace(/[%_\\]/g, '\\$&')}%`;
    const rows = await sql<{ id: string; store: string; sku: string | null; product: string; variant: string }[]>`
      select v.id, st.key as store, v.sku, p.title as product, v.title as variant
      from variants v join products p on p.id = v.product_id join stores st on st.id = v.store_id
      where v.deleted_at is null
        and (v.sku ilike ${like} or p.title ilike ${like} or v.title ilike ${like})
        ${query.store ? sql`and st.key = ${query.store}` : sql``}
      order by st.key, p.title, v.title
      limit 50
    `;
    res.json({ variants: [...rows] });
  });

  /** Shopify's stock per variant beside our warehouse, with the shelf estimate and its parts. */
  router.get('/stock/shopify-comparison', async (req, res) => {
    const sql = requireSql(getSql);
    const { store } = parse(storeQuery, req.query);
    res.json({ rows: await shopifyStockComparison(sql, store) });
  });

  /** Takes the opening count from Shopify's figures, dated at the cut-over day. Once per store. */
  router.post('/stock/opening-from-shopify', async (req, res) => {
    const sql = requireSql(getSql);
    const body = parse(openingFromShopify, req.body);
    asAtDay(body.asAt);
    const result = await openingStockFromShopify(sql, {
      asAt: body.asAt,
      actorId: await actorId(sql, sessionUser(req)),
      ...(body.store ? { storeKey: body.store } : {}),
    }).catch(asHttp);
    res.status(result ? 201 : 200).json(result ?? { adjustmentId: null, lines: 0, units: 0 });
  });

  router.post('/stock/adjustments', async (req, res) => {
    const sql = requireSql(getSql);
    const body = parse(adjustment, req.body);
    const [location] = await sql`select 1 from locations where id = ${body.locationId} and kind in ('warehouse', 'partner', 'damaged')`;
    // Counts are taken where stock is physically held; transit and sinks follow from parcels.
    if (!location) throw new HttpError(409, 'Adjustments are made at a warehouse, partner or damaged location');
    const id = await recordAdjustment(sql, {
      locationId: body.locationId,
      reason: body.reason,
      actorId: await actorId(sql, sessionUser(req)),
      lines: body.lines,
      ...(body.note ? { note: body.note } : {}),
      // End of that day in Karachi, so the count is in any check "as at" the same date.
      ...(body.asAt ? { at: asAtDay(body.asAt) } : {}),
    }).catch(asHttp);
    res.status(201).json({ id });
  });

  return router;
};
