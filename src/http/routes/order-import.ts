import express, { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import { EXPORT_COLUMNS, commitOrderImport, dryRunOrderImport } from '../../domain/order-import.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { parse } from '../validate.js';

/**
 * Order history from Shopify's order export (Step 16). The file is the request body, sent as
 * `text/csv`: a store's full history runs to megabytes, past the JSON body limit. Dry run, then
 * commit; malformed rows are reported by row number and never stop the rest.
 */

const query = z.object({ store: z.enum(['nur', 'organics']), fileName: z.string().trim().min(1).max(200) });
const csvBody = express.text({ type: ['text/csv', 'text/plain'], limit: '25mb' });

const body = (req: express.Request): string => {
  if (typeof req.body !== 'string' || req.body.trim() === '') throw new HttpError(400, 'Send the export as the body, Content-Type: text/csv');
  return req.body;
};

export const orderImportRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  /** The declared mapping: our field and the Shopify export column it is read from. */
  router.get('/orders/import/columns', (_req, res) => {
    res.json({ columns: EXPORT_COLUMNS });
  });

  router.post('/orders/import/dry-run', csvBody, async (req, res) => {
    const q = parse(query, req.query);
    res.json({ report: await dryRunOrderImport(requireSql(getSql), q.store, body(req)) });
  });

  router.post('/orders/import', csvBody, async (req, res) => {
    const q = parse(query, req.query);
    const sql = requireSql(getSql);
    const report = await commitOrderImport(sql, { store: q.store, fileName: q.fileName, csv: body(req), actorId: await actorId(sql, sessionUser(req)) });
    res.status(report.fileErrors.length > 0 ? 422 : 201).json({ report });
  });

  router.get('/orders/imports', async (_req, res) => {
    const sql = requireSql(getSql);
    const runs = await sql`
      select r.id, st.key as store, r.file_name, r.rows_total, r.orders_inserted, r.orders_updated, r.orders_unchanged, r.orders_api_kept,
             r.orders_malformed, r.parcels_matched, u.name as imported_by, r.imported_at
      from order_csv_imports r join stores st on st.id = r.store_id join users u on u.id = r.imported_by
      order by r.imported_at desc, r.id desc limit 100
    `;
    res.json({ imports: [...runs] });
  });

  return router;
};
