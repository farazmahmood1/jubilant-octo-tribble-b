import { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import { atomically } from '../../db/repos/upsert.js';
import { type Paisa, paisa } from '../../lib/money.js';
import { endOfKarachiDay, formatKarachi } from '../../lib/time.js';
import {
  PurchaseError,
  type PurchasingSettings,
  cancelPurchaseOrder,
  cancelRequest,
  compareQuotes,
  createPurchaseOrder,
  createQuotation,
  createRequest,
  createVendor,
  listBills,
  listPurchaseOrders,
  listRequests,
  listVendors,
  payBill,
  purchaseOrderDetail,
  purchasingSettings,
  receiveGoods,
  recordBill,
  reorderSuggestions,
  updateVendor,
} from '../../domain/purchasing.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { ID, parse } from '../validate.js';

/**
 * Purchasing (Batch F, proposal 6.1): vendors, requests, quotations, purchase orders, goods
 * receipts, vendor bills and payments, and reorder suggestions. Amounts travel as integer paisa
 * in decimal strings, both ways. Every change is audited with the signed-in user.
 */

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => {
    try {
      endOfKarachiDay(d);
      return true;
    } catch {
      return false;
    }
  }, 'not a real date');
const money = z
  .string()
  .regex(/^\d{1,15}$/, 'an amount in paisa, as digits')
  .transform((v): Paisa => paisa(BigInt(v)));
const id = z.string().regex(ID);
const qty = z.number().int().min(1).max(1_000_000);
const text = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

const vendorFields = {
  name: z.string().trim().min(1).max(120),
  contactName: text(120),
  phone: text(40),
  email: text(120),
  city: text(80),
  leadTimeDays: z.number().int().min(0).max(365).nullish(),
  paymentTermsDays: z.number().int().min(0).max(365).nullish(),
  notes: text(2000),
  isActive: z.boolean().optional(),
};
const idParams = z.object({ id });
const request = z.object({ variantId: id, qty, reason: text(500) });
const quotation = z.object({
  vendorId: id,
  receivedOn: day,
  validUntil: day.nullish(),
  reference: text(80),
  note: text(2000),
  lines: z.array(z.object({ variantId: id, qty, unitPricePaisa: money, requestId: id.nullish() })).min(1).max(200),
});
const purchaseOrder = z.object({
  vendorId: id,
  store: z.enum(['nur', 'organics']),
  quotationId: id.nullish(),
  orderedOn: day,
  expectedOn: day.nullish(),
  note: text(2000),
  lines: z.array(z.object({ variantId: id, qty, unitCostPaisa: money, requestId: id.nullish() })).max(200).optional(),
});
const receipt = z.object({
  receivedAt: z.string().datetime({ offset: true }).optional(),
  note: text(2000),
  lines: z.array(z.object({ poLineId: id, qty })).min(1).max(200),
});
const bill = z.object({
  billNumber: z.string().trim().min(1).max(60),
  billDate: day,
  dueOn: day.nullish(),
  taxPaisa: money.default(paisa(0n)),
  lines: z.array(z.object({ poLineId: id, qty, unitPricePaisa: money })).max(200),
  charges: z.array(z.object({ description: z.string().trim().min(1).max(120), amountPaisa: money })).max(20).default([]),
});
const payment = z.object({ amountPaisa: money, paidOn: day, method: z.enum(['bank_transfer', 'cash', 'cheque']), reference: text(80) });
const reorderQuery = z.object({
  store: z.enum(['nur', 'organics']).optional(),
  windowDays: z.coerce.number().int().min(7).max(365).optional(),
  coverDays: z.coerce.number().int().min(0).max(365).optional(),
});
const settings = z.object({
  tolerancePercent: z.number().min(0).max(50),
  toleranceAbsolutePaisa: z.number().int().min(0).max(100_000_000),
  velocityWindowDays: z.number().int().min(7).max(365),
  coverDays: z.number().int().min(0).max(365),
  defaultLeadTimeDays: z.number().int().min(0).max(365),
});

/** Bigints (paisa) as decimal strings, everywhere in a response. */
const json = (value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(json);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v)]));
  return value;
};

const asHttp = (error: unknown): never => {
  if (error instanceof PurchaseError) throw new HttpError(error.status, error.message);
  throw error;
};

const today = () => formatKarachi(new Date()).slice(0, 10);

export const purchasingRouter = (getSql: SqlProvider): Router => {
  const router = Router();
  const actor = async (req: Parameters<typeof sessionUser>[0]) => actorId(requireSql(getSql), sessionUser(req));

  router.get('/purchasing/vendors', async (_req, res) => {
    res.json({ vendors: json(await listVendors(requireSql(getSql))) });
  });

  router.post('/purchasing/vendors', async (req, res) => {
    const body = parse(z.object(vendorFields), req.body);
    res.status(201).json({ id: await createVendor(requireSql(getSql), body, await actor(req)).catch(asHttp) });
  });

  router.patch('/purchasing/vendors/:id', async (req, res) => {
    const { id: vendorId } = parse(idParams, req.params);
    const body = parse(z.object(vendorFields).partial(), req.body);
    await updateVendor(requireSql(getSql), vendorId, body, await actor(req)).catch(asHttp);
    res.json({ id: vendorId });
  });

  router.get('/purchasing/requests', async (req, res) => {
    const all = req.query['all'] === 'true';
    res.json({ requests: json(await listRequests(requireSql(getSql), { includeClosed: all })) });
  });

  router.post('/purchasing/requests', async (req, res) => {
    const body = parse(request, req.body);
    res.status(201).json({ id: await createRequest(requireSql(getSql), { ...body, actorId: await actor(req) }).catch(asHttp) });
  });

  router.post('/purchasing/requests/:id/cancel', async (req, res) => {
    const { id: requestId } = parse(idParams, req.params);
    await cancelRequest(requireSql(getSql), requestId, await actor(req)).catch(asHttp);
    res.json({ id: requestId });
  });

  router.post('/purchasing/quotations', async (req, res) => {
    const body = parse(quotation, req.body);
    const quotationId = await createQuotation(requireSql(getSql), {
      ...body,
      lines: body.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitPrice: l.unitPricePaisa, requestId: l.requestId ?? null })),
      actorId: await actor(req),
    }).catch(asHttp);
    res.status(201).json({ id: quotationId });
  });

  /** Every quote for one product, cheapest first. */
  router.get('/purchasing/quotations/compare/:id', async (req, res) => {
    const { id: variantId } = parse(idParams, req.params);
    res.json({ quotes: json(await compareQuotes(requireSql(getSql), variantId, today())) });
  });

  router.get('/purchasing/orders', async (req, res) => {
    const open = req.query['open'] === 'true';
    res.json({ orders: json(await listPurchaseOrders(requireSql(getSql), { open })) });
  });

  router.get('/purchasing/orders/:id', async (req, res) => {
    const { id: poId } = parse(idParams, req.params);
    const detail = await purchaseOrderDetail(requireSql(getSql), poId);
    if (!detail) throw new HttpError(404, `Purchase order ${poId} not found`);
    res.json({ order: json(detail) });
  });

  router.post('/purchasing/orders', async (req, res) => {
    const body = parse(purchaseOrder, req.body);
    const { lines, ...header } = body;
    const po = await createPurchaseOrder(requireSql(getSql), {
      ...header,
      ...(lines ? { lines: lines.map((l) => ({ variantId: l.variantId, qty: l.qty, unitCost: l.unitCostPaisa, requestId: l.requestId ?? null })) } : {}),
      actorId: await actor(req),
    }).catch(asHttp);
    res.status(201).json(po);
  });

  router.post('/purchasing/orders/:id/cancel', async (req, res) => {
    const { id: poId } = parse(idParams, req.params);
    await cancelPurchaseOrder(requireSql(getSql), poId, await actor(req)).catch(asHttp);
    res.json({ id: poId });
  });

  /** Goods arrived: all or part of what is outstanding on the order. */
  router.post('/purchasing/orders/:id/receipts', async (req, res) => {
    const { id: poId } = parse(idParams, req.params);
    const body = parse(receipt, req.body);
    const result = await receiveGoods(requireSql(getSql), {
      poId,
      receivedAt: body.receivedAt ? new Date(body.receivedAt) : new Date(),
      lines: body.lines,
      note: body.note,
      actorId: await actor(req),
    }).catch(asHttp);
    res.status(201).json(json(result));
  });

  /** The vendor's bill, refused unless it matches the order and what was received. */
  router.post('/purchasing/orders/:id/bills', async (req, res) => {
    const { id: poId } = parse(idParams, req.params);
    const body = parse(bill, req.body);
    const result = await recordBill(requireSql(getSql), {
      poId,
      billNumber: body.billNumber,
      billDate: body.billDate,
      dueOn: body.dueOn ?? null,
      tax: body.taxPaisa,
      lines: body.lines.map((l) => ({ poLineId: l.poLineId, qty: l.qty, unitPrice: l.unitPricePaisa })),
      charges: body.charges.map((c) => ({ description: c.description, amount: c.amountPaisa })),
      actorId: await actor(req),
    }).catch(asHttp);
    res.status(201).json(json(result));
  });

  router.get('/purchasing/bills', async (req, res) => {
    const unpaidOnly = req.query['unpaid'] === 'true';
    res.json({ bills: json(await listBills(requireSql(getSql), { unpaidOnly, today: today() })) });
  });

  router.post('/purchasing/bills/:id/payments', async (req, res) => {
    const { id: billId } = parse(idParams, req.params);
    const body = parse(payment, req.body);
    const result = await payBill(requireSql(getSql), {
      billId,
      amount: body.amountPaisa,
      paidOn: body.paidOn,
      method: body.method,
      reference: body.reference,
      actorId: await actor(req),
    }).catch(asHttp);
    res.status(201).json(json(result));
  });

  /** What to order now, from delivered velocity. */
  router.get('/purchasing/reorder-suggestions', async (req, res) => {
    const q = parse(reorderQuery, req.query);
    res.json({ suggestions: json(await reorderSuggestions(requireSql(getSql), { now: new Date(), ...q })) });
  });

  router.get('/settings/purchasing', async (_req, res) => {
    res.json({ purchasing: await purchasingSettings(requireSql(getSql)) });
  });

  router.put('/settings/purchasing', async (req, res) => {
    const sql = requireSql(getSql);
    const value: PurchasingSettings = parse(settings, req.body);
    const actorUser = await actor(req);
    await atomically(sql, async (tx) => {
      const [before] = await tx<{ value: unknown }[]>`select value from app_settings where key = 'purchasing' for update`;
      await tx`
        insert into app_settings (key, value) values ('purchasing', ${tx.json(value as never)})
        on conflict (key) do update set value = excluded.value
      `;
      await tx`
        insert into audit_log (actor_id, action, entity, entity_id, before, after)
        values (${actorUser}, 'settings.update', 'app_settings', 'purchasing', ${before ? tx.json(before.value as never) : null}, ${tx.json(value as never)})
      `;
    });
    res.json({ purchasing: value });
  });

  return router;
};
