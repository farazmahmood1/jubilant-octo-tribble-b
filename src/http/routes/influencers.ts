import { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import { InfluencerError, addCode, createInfluencer, listInfluencers, removeCode, unassignedCodes, updateInfluencer } from '../../db/repos/influencers.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { ID, parse } from '../validate.js';

/**
 * Influencers and their discount codes, which the influencer breakdown attributes orders by.
 * Every change is audited with the signed-in user.
 */

const optionalText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const fields = {
  // Typed with or without the @.
  handle: z.string().trim().transform((h) => h.replace(/^@/, '')).pipe(z.string().regex(/^[A-Za-z0-9._]{1,60}$/, 'letters, digits, dots and underscores')),
  name: z.string().trim().min(1).max(120),
  city: optionalText(80),
  followers: z.number().int().min(0).max(1_000_000_000).nullish().transform((v) => v ?? null),
  niche: optionalText(80),
  notes: optionalText(2000),
  isActive: z.boolean().optional(),
};
const create = z.object(fields);
const update = z.object(fields).partial();
const idParams = z.object({ id: z.string().regex(ID) });
const codeParams = z.object({ id: z.string().regex(ID), codeId: z.string().regex(ID) });
const code = z.object({ store: z.enum(['nur', 'organics']), code: z.string().trim().min(1).max(60) });
const storeQuery = z.object({ store: z.enum(['nur', 'organics']).optional() });

const asHttp = (error: unknown): never => {
  if (error instanceof InfluencerError) throw new HttpError(error.status, error.message);
  throw error;
};

export const influencersRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  router.get('/influencers', async (_req, res) => {
    res.json({ influencers: await listInfluencers(requireSql(getSql)) });
  });

  router.post('/influencers', async (req, res) => {
    const sql = requireSql(getSql);
    const body = parse(create, req.body);
    const id = await createInfluencer(sql, body, await actorId(sql, sessionUser(req))).catch(asHttp);
    res.status(201).json({ id });
  });

  router.patch('/influencers/:id', async (req, res) => {
    const sql = requireSql(getSql);
    const { id } = parse(idParams, req.params);
    const body = parse(update, req.body);
    await updateInfluencer(sql, id, body, await actorId(sql, sessionUser(req))).catch(asHttp);
    res.json({ id });
  });

  router.post('/influencers/:id/codes', async (req, res) => {
    const sql = requireSql(getSql);
    const { id } = parse(idParams, req.params);
    const body = parse(code, req.body);
    res.status(201).json(await addCode(sql, id, body, await actorId(sql, sessionUser(req))).catch(asHttp));
  });

  router.delete('/influencers/:id/codes/:codeId', async (req, res) => {
    const sql = requireSql(getSql);
    const { id, codeId } = parse(codeParams, req.params);
    await removeCode(sql, id, codeId, await actorId(sql, sessionUser(req))).catch(asHttp);
    res.json({ removed: codeId });
  });

  /** Codes on orders that no influencer owns yet, most used first. */
  router.get('/influencers/unassigned-codes', async (req, res) => {
    const { store } = parse(storeQuery, req.query);
    res.json({ codes: await unassignedCodes(requireSql(getSql), store) });
  });

  return router;
};
