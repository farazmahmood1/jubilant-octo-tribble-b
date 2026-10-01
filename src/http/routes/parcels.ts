import { Router } from 'express';
import { z } from 'zod';

import { PARCEL_FLAGS, PARCEL_SORTS, STAGES, listParcels, parcelCities, parcelDetail } from '../../db/repos/parcels.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { ID, parse } from '../validate.js';

/**
 * Parcels, read-only (PostEx is never written to): the list with the search and filters of
 * proposal 6.6, the cities to filter by, and one parcel with its timeline, order, charges, payout
 * and check-in. The parameters match the dashboard's URL state (`q`, `stage`, `page`, `size`,
 * `sort=key:dir`). The accountant role gets no customer phone (1.9).
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))] : []))
    .pipe(z.array(z.enum(values)));
const listQuery = z.object({
  q: z.string().trim().max(60).optional(),
  stage: csv(STAGES),
  store: csv(['nur', 'organics'] as const),
  flag: csv(PARCEL_FLAGS),
  city: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20) : [])),
  from: z.string().regex(DAY).optional(),
  to: z.string().regex(DAY).optional(),
  sort: z
    .string()
    .optional()
    .transform((v) => {
      const [key, dir] = (v ?? '').split(':');
      return (PARCEL_SORTS as readonly string[]).includes(key ?? '') && (dir === 'asc' || dir === 'desc') ? { key: key as (typeof PARCEL_SORTS)[number], dir: dir as 'asc' | 'desc' } : null;
    }),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  size: z.coerce.number().int().min(1).max(200).default(25),
});
const idParams = z.object({ id: z.string().regex(ID) });

export const parcelsRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  router.get('/parcels', async (req, res) => {
    const q = parse(listQuery, req.query);
    const result = await listParcels(requireSql(getSql), {
      ...(q.q ? { search: q.q } : {}),
      stages: q.stage,
      stores: q.store,
      flags: q.flag,
      cities: q.city,
      from: q.from ?? null,
      to: q.to ?? null,
      sort: q.sort,
      page: q.page,
      pageSize: q.size,
    });
    res.json({ total: result.total, page: q.page, pageSize: q.size, rows: result.rows });
  });

  router.get('/parcels/cities', async (_req, res) => {
    res.json({ cities: await parcelCities(requireSql(getSql)) });
  });

  router.get('/parcels/:id', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const parcel = await parcelDetail(requireSql(getSql), id);
    if (!parcel) throw new HttpError(404, `Parcel ${id} not found`);
    const seesPhones = sessionUser(req).role !== ('accountant' as string);
    res.json({ parcel: seesPhones ? parcel : { ...parcel, customerPhone: null } });
  });

  return router;
};
