import { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import { postShipmentAccounting } from '../../domain/accounting.js';
import { StockError, checkInReturn, recordAdjustment, returnsAwaitingCheckIn } from '../../domain/stock.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { ID, parse } from '../validate.js';

/**
 * Stock screens (Step 8): the returns-not-checked-in alert, checking a return in, current stock,
 * and counts or corrections. Every change goes through the ledger functions, never a quantity
 * update, and is audited with the signed-in user.
 */

const shipmentParams = z.object({ shipmentId: z.string().regex(ID) });
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
  lines: z
    .array(z.object({ variantId: z.string().regex(ID), delta: z.number().int().refine((n) => n !== 0, 'must not be zero') }))
    .min(1)
    .max(500),
});
const variantsQuery = z.object({ search: z.string().trim().min(1).max(80), store: z.enum(['nur', 'organics']).optional() });

/** StockError is a rule the request broke, not a server fault. */
const asHttp = (error: unknown): never => {
  if (error instanceof StockError) throw new HttpError(409, error.message);
  throw error;
};

export const stockRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  router.get('/stock/returns-awaiting', async (_req, res) => {
    const sql = requireSql(getSql);
    res.json({ returns: await returnsAwaitingCheckIn(sql) });
  });

  router.post('/stock/returns/:shipmentId/check-in', async (req, res) => {
    const sql = requireSql(getSql);
    const { shipmentId } = parse(shipmentParams, req.params);
    const body = parse(checkIn, req.body);
    const result = await checkInReturn(sql, shipmentId, body.outcome, await actorId(sql, sessionUser(req)), body.note).catch(asHttp);
    // A damaged return is written off now rather than on the next sync.
    await postShipmentAccounting(sql, shipmentId);
    res.json(result);
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
    }).catch(asHttp);
    res.status(201).json({ id });
  });

  return router;
};
