import { Router } from 'express';
import { z } from 'zod';

import { ORDER_CHANNELS, ORDER_FLAGS, ORDER_SORTS, ORDER_STATES, listOrders, orderCities } from '../../db/repos/order-list.js';
import { type SqlProvider, requireSql } from '../middleware/database.js';
import { parse } from '../validate.js';

/**
 * Orders, read-only: the list with search and filters, and the cities to filter by. The parameters
 * match the dashboard's URL state (`q`, `state`, `page`, `size`, `sort=key:dir`). The accountant
 * role gets no customer phone (1.9). The import routes under `/orders/imports` are a separate
 * router and mounted first.
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
  state: csv(ORDER_STATES),
  store: csv(['nur', 'organics'] as const),
  channel: csv(ORDER_CHANNELS),
  flag: csv(ORDER_FLAGS),
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
      return (ORDER_SORTS as readonly string[]).includes(key ?? '') && (dir === 'asc' || dir === 'desc') ? { key: key as (typeof ORDER_SORTS)[number], dir: dir as 'asc' | 'desc' } : null;
    }),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  size: z.coerce.number().int().min(1).max(200).default(25),
});

export const ordersRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  router.get('/orders', async (req, res) => {
    const q = parse(listQuery, req.query);
    const result = await listOrders(requireSql(getSql), {
      ...(q.q ? { search: q.q } : {}),
      states: q.state,
      stores: q.store,
      channels: q.channel,
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

  router.get('/orders/cities', async (_req, res) => {
    res.json({ cities: await orderCities(requireSql(getSql)) });
  });

  return router;
};
