import { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import {
  ConsignmentError,
  TEMPLATE_CSV,
  commitImport,
  createPartner,
  createTransfer,
  dryRunImport,
  listImports,
  listPartners,
  partnerStock,
  reverseImport,
} from '../../domain/consignment.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { ID, parse } from '../validate.js';

/**
 * Consignment: retail partners, transfers of stock to and from them, and their sales sheets,
 * imported as CSV text in two phases (dry run, then commit) and reversible as a unit. Amounts
 * are integer paisa in strings. Every change is audited with the signed-in user.
 */

const id = z.string().regex(ID);
const text = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const partner = z.object({
  name: z.string().trim().min(1).max(120),
  contact: text(120),
  phone: z.string().trim().regex(/^\+92[0-9]{9,10}$/, 'phone as +92…').nullish(),
  city: text(80),
  terms: text(500),
});
const transfer = z.object({
  partnerId: id,
  direction: z.enum(['out', 'back']),
  sentAt: z.string().datetime({ offset: true }).optional(),
  note: text(2000),
  lines: z.array(z.object({ variantId: id, qty: z.number().int().min(1).max(1_000_000) })).min(1).max(500),
});
// A partner's sheet is a few hundred rows; the app's body limit (1 MB) bounds it anyway.
const sheet = z.object({ partnerId: id, fileName: z.string().trim().min(1).max(200), csv: z.string().min(1).max(900_000) });
const commit = sheet.extend({ force: z.boolean().default(false), newVersion: z.boolean().default(false) });
const idParams = z.object({ id });
const reverse = z.object({ reason: z.string().trim().min(3).max(500) });

/** Bigints (paisa) as decimal strings, everywhere in a response. */
const json = (value: unknown): unknown => {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(json);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, json(v)]));
  return value;
};

export const consignmentRouter = (getSql: SqlProvider): Router => {
  const router = Router();
  const actor = async (req: Parameters<typeof sessionUser>[0]) => actorId(requireSql(getSql), sessionUser(req));
  /** A refused import answers with the per-row report beside the message. */
  const asHttp = (res: { status: (code: number) => { json: (body: unknown) => void } }) => (error: unknown) => {
    if (error instanceof ConsignmentError) {
      res.status(error.status).json({ error: { message: error.message }, ...(error.report ? { report: json(error.report) } : {}) });
      return null;
    }
    throw error;
  };

  router.get('/consignment/template.csv', (_req, res) => {
    res.type('text/csv').attachment('partner-sales-template.csv').send(TEMPLATE_CSV);
  });

  router.get('/consignment/partners', async (_req, res) => {
    res.json({ partners: json(await listPartners(requireSql(getSql))) });
  });

  router.post('/consignment/partners', async (req, res) => {
    const body = parse(partner, req.body);
    res.status(201).json({ id: await createPartner(requireSql(getSql), body, await actor(req)) });
  });

  router.get('/consignment/partners/:id/stock', async (req, res) => {
    const { id: partnerId } = parse(idParams, req.params);
    const stock = await partnerStock(requireSql(getSql), partnerId).catch(asHttp(res));
    if (stock) res.json({ stock });
  });

  router.post('/consignment/transfers', async (req, res) => {
    const body = parse(transfer, req.body);
    const transferId = await createTransfer(requireSql(getSql), {
      ...body,
      sentAt: body.sentAt ? new Date(body.sentAt) : new Date(),
      actorId: await actor(req),
    }).catch(asHttp(res));
    if (transferId) res.status(201).json({ id: transferId });
  });

  /** Phase one: validate the sheet, write nothing. */
  router.post('/consignment/imports/dry-run', async (req, res) => {
    const body = parse(sheet, req.body);
    const report = await dryRunImport(requireSql(getSql), body.partnerId, body.csv).catch(asHttp(res));
    if (report) res.json({ report: json(report) });
  });

  /** Phase two: validate again and commit, all or nothing (or the valid rows, when forced). */
  router.post('/consignment/imports', async (req, res) => {
    const body = parse(commit, req.body);
    const result = await commitImport(requireSql(getSql), { ...body, actorId: await actor(req) }).catch(asHttp(res));
    if (result) res.status(201).json(json(result));
  });

  router.get('/consignment/imports', async (req, res) => {
    const partnerId = typeof req.query['partnerId'] === 'string' && ID.test(req.query['partnerId']) ? req.query['partnerId'] : undefined;
    res.json({ imports: json(await listImports(requireSql(getSql), partnerId)) });
  });

  router.post('/consignment/imports/:id/reverse', async (req, res) => {
    const { id: importId } = parse(idParams, req.params);
    const body = parse(reverse, req.body);
    const result = await reverseImport(requireSql(getSql), { importId, reason: body.reason, actorId: await actor(req) }).catch(asHttp(res));
    if (result) res.json(result);
  });

  return router;
};
