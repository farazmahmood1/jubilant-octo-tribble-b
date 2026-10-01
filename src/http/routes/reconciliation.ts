import { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import { matchReport } from '../../db/repos/match-report.js';
import { ReviewItemNotOpenError, countOpenByKind, decideReviewItem, listReviewItems } from '../../db/repos/review.js';
import { LinkError, linkShipmentToOrder, unlinkShipmentFromOrder } from '../../db/repos/shipment-links.js';
import { DEFAULT_WINDOW_DAYS } from '../../domain/matching.js';
import { candidatesFor } from '../../jobs/postex-match.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { ID, parse } from '../validate.js';

/**
 * The reconciliation queue (Step 9): list, resolve, ignore, and link a parcel to its order by
 * hand, or take a wrong link back out. Every decision is audited with the signed-in user. Responses carry order and tracking
 * numbers, never customer names, phones or addresses (rule 2).
 */

const listQuery = z.object({
  status: z.enum(['open', 'resolved', 'ignored']).default('open'),
  kind: z.string().regex(/^[a-z_]+$/).optional(),
  store: z.enum(['nur', 'organics']).optional(),
  before: z.string().regex(ID).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const idParams = z.object({ id: z.string().regex(ID) });
const decision = z.object({ note: z.string().trim().min(1, 'A note is required').max(2000) });
const link = z
  .object({
    orderId: z.string().regex(ID).optional(),
    orderNumber: z.string().trim().min(1).max(40).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.orderId || v.orderNumber, { message: 'orderId or orderNumber is required' });

export const reconciliationRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  router.get('/reconciliation/items', async (req, res) => {
    const sql = requireSql(getSql);
    const query = parse(listQuery, req.query);
    const items = await listReviewItems(sql, {
      status: query.status,
      limit: query.limit,
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.store ? { storeKey: query.store } : {}),
      ...(query.before ? { beforeId: query.before } : {}),
    });
    res.json({ items, nextBefore: items.length === query.limit ? (items.at(-1)?.id ?? null) : null });
  });

  router.get('/reconciliation/summary', async (req, res) => {
    const sql = requireSql(getSql);
    const { store } = parse(z.object({ store: z.enum(['nur', 'organics']).optional() }), req.query);
    const [open, matching] = await Promise.all([countOpenByKind(sql, store), matchReport(sql)]);
    res.json({ open, matching });
  });

  for (const status of ['resolved', 'ignored'] as const) {
    router.post(`/reconciliation/items/:id/${status === 'resolved' ? 'resolve' : 'ignore'}`, async (req, res) => {
      const sql = requireSql(getSql);
      const { id } = parse(idParams, req.params);
      const { note } = parse(decision, req.body);
      try {
        await decideReviewItem(sql, id, status, note, await actorId(sql, sessionUser(req)));
      } catch (error) {
        if (error instanceof ReviewItemNotOpenError) throw new HttpError(409, error.message);
        throw error;
      }
      res.json({ id, status });
    });
  }

  /** Orders that could own the item's parcel, for the link dialog: numbers, totals, dates, city. */
  router.get('/reconciliation/items/:id/candidates', async (req, res) => {
    const sql = requireSql(getSql);
    const { id } = parse(idParams, req.params);
    const [item] = await sql<{ shipment_id: string | null; store_id: string | null; ref: string | null; booked_at: Date | null }[]>`
      select r.shipment_id, a.store_id, s.order_ref_number as ref, s.booked_at
      from reconciliation_items r
      left join shipments s on s.id = r.shipment_id
      left join postex_accounts a on a.id = s.postex_account_id
      where r.id = ${id}
    `;
    if (!item) throw new HttpError(404, `Review item ${id} not found`);
    if (!item.shipment_id || !item.store_id) {
      res.json({ candidates: [] });
      return;
    }
    // A wider window than the matcher's: a person is choosing, not the machine.
    const candidates = await candidatesFor(sql, item.store_id, { orderRef: item.ref, bookedAt: item.booked_at }, DEFAULT_WINDOW_DAYS * 3);
    res.json({
      candidates: candidates
        .sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime())
        .slice(0, 50)
        .map((c) => ({ id: c.id, orderNumber: c.name, totalPaisa: c.codAmount.toString(), city: c.city, placedAt: c.placedAt })),
    });
  });

  router.post('/reconciliation/items/:id/link', async (req, res) => {
    const sql = requireSql(getSql);
    const { id } = parse(idParams, req.params);
    const body = parse(link, req.body);
    const [item] = await sql<{ shipment_id: string | null; status: string; store_id: string | null }[]>`
      select r.shipment_id, r.status, a.store_id
      from reconciliation_items r
      left join shipments s on s.id = r.shipment_id
      left join postex_accounts a on a.id = s.postex_account_id
      where r.id = ${id}
    `;
    if (!item) throw new HttpError(404, `Review item ${id} not found`);
    if (!item.shipment_id) throw new HttpError(409, 'This item is not about a single parcel; there is nothing to link');

    let orderId = body.orderId ?? null;
    if (!orderId && body.orderNumber) {
      const wanted = body.orderNumber.startsWith('#') ? body.orderNumber : `#${body.orderNumber}`;
      const [order] = await sql<{ id: string }[]>`select id from orders where store_id = ${item.store_id} and order_number = ${wanted}`;
      if (!order) throw new HttpError(404, `No order ${wanted} in this parcel's store`);
      orderId = order.id;
    }
    try {
      const result = await linkShipmentToOrder(sql, {
        shipmentId: item.shipment_id,
        orderId: orderId!,
        actorId: await actorId(sql, sessionUser(req)),
        ...(body.note ? { note: body.note } : {}),
      });
      res.json(result);
    } catch (error) {
      if (error instanceof LinkError) throw new HttpError(error.status, error.message);
      throw error;
    }
  });

  /**
   * The parcel is linked to the wrong order: take it back out. Needs a note, like every decision on
   * the queue. The parcel returns to the queue as unmatched and the order is not offered for it again.
   */
  router.post('/reconciliation/items/:id/unlink', async (req, res) => {
    const sql = requireSql(getSql);
    const { id } = parse(idParams, req.params);
    const { note } = parse(decision, req.body);
    const [item] = await sql<{ shipment_id: string | null }[]>`select shipment_id from reconciliation_items where id = ${id}`;
    if (!item) throw new HttpError(404, `Review item ${id} not found`);
    if (!item.shipment_id) throw new HttpError(409, 'This item is not about a single parcel; there is nothing to unlink');
    try {
      res.json(await unlinkShipmentFromOrder(sql, { shipmentId: item.shipment_id, actorId: await actorId(sql, sessionUser(req)), note }));
    } catch (error) {
      if (error instanceof LinkError) throw new HttpError(error.status, error.message);
      throw error;
    }
  });

  return router;
};
