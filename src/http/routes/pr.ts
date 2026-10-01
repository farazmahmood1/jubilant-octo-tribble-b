import { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import { CLASSIFICATIONS, PrError, addPost, classifyPrSend, createPrSend, detectPrSends, listPosts, listPrSends } from '../../domain/pr.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { ID, parse } from '../validate.js';

/**
 * Influencer PR: sends (detected or entered), a person's classification of each, and posts.
 * Influencers and their discount codes are in `influencers.ts`. Amounts are paisa in strings.
 */

const id = z.string().regex(ID);
const lines = z.array(z.object({ variantId: id, qty: z.number().int().min(1).max(10_000) })).max(100);
const listQuery = z.object({ status: z.enum(['suggested', 'decided', 'pr', 'all']).default('all'), influencerId: id.optional() });
const classify = z.object({
  classification: z.enum(CLASSIFICATIONS),
  influencerId: id.nullish(),
  lines: lines.optional(),
  note: z.string().trim().max(2000).nullish(),
});
const manual = z.object({
  influencerId: id,
  sentAt: z.string().datetime({ offset: true }),
  trackingNumber: z.string().trim().min(4).max(40).nullish(),
  lines: lines.optional(),
  note: z.string().trim().max(2000).nullish(),
});
const post = z.object({
  url: z.string().trim().url().max(500),
  kind: z.enum(['reel', 'story', 'post']),
  postedAt: z.string().datetime({ offset: true }),
  prSendId: id.nullish(),
  note: z.string().trim().max(2000).nullish(),
});
const idParams = z.object({ id });

const asHttp = (error: unknown): never => {
  if (error instanceof PrError) throw new HttpError(error.status, error.message);
  throw error;
};

export const prRouter = (getSql: SqlProvider): Router => {
  const router = Router();
  const actor = async (req: Parameters<typeof sessionUser>[0]) => actorId(requireSql(getSql), sessionUser(req));

  router.get('/pr/sends', async (req, res) => {
    const q = parse(listQuery, req.query);
    const sends = await listPrSends(requireSql(getSql), { status: q.status, ...(q.influencerId ? { influencerId: q.influencerId } : {}) });
    res.json({ sends: sends.map((s) => ({ ...s, marketing: s.marketing.toString() })) });
  });

  /** Runs detection now, as the hourly job does. */
  router.post('/pr/detect', async (_req, res) => {
    res.json(await detectPrSends(requireSql(getSql)));
  });

  router.post('/pr/sends', async (req, res) => {
    const body = parse(manual, req.body);
    const sendId = await createPrSend(requireSql(getSql), { ...body, sentAt: new Date(body.sentAt), actorId: await actor(req) }).catch(asHttp);
    res.status(201).json({ id: sendId });
  });

  router.post('/pr/sends/:id/classify', async (req, res) => {
    const { id: sendId } = parse(idParams, req.params);
    const body = parse(classify, req.body);
    await classifyPrSend(requireSql(getSql), { sendId, ...body, actorId: await actor(req) }).catch(asHttp);
    res.json({ id: sendId, classification: body.classification });
  });

  router.get('/influencers/:id/posts', async (req, res) => {
    const { id: influencerId } = parse(idParams, req.params);
    res.json({ posts: [...(await listPosts(requireSql(getSql), influencerId))] });
  });

  router.post('/influencers/:id/posts', async (req, res) => {
    const { id: influencerId } = parse(idParams, req.params);
    const body = parse(post, req.body);
    const postId = await addPost(requireSql(getSql), { influencerId, ...body, postedAt: new Date(body.postedAt), actorId: await actor(req) }).catch(asHttp);
    res.status(201).json({ id: postId });
  });

  return router;
};
