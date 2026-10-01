import { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import { type ConfirmationTags, DEFAULT_CONFIRMATION_TAGS } from '../../db/repos/order-state.js';
import { atomically } from '../../db/repos/upsert.js';
import { DEFAULT_WINDOW_DAYS } from '../../domain/matching.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { parse } from '../validate.js';

/**
 * The matching setting: which order-number prefixes each store's team types on parcels
 * (`NBJ-1234`), and the booking window for the fallbacks. Read by `postex:sync` on every run, so
 * a change applies to every still-unmatched parcel on the next run. Changes are audited.
 */

const prefixes = z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{1,6}$/, 'a prefix is 1–6 letters')).max(20);
const matching = z.object({
  refPrefixes: z.object({ nur: prefixes.default([]), organics: prefixes.default([]) }),
  windowDays: z.number().int().min(0).max(14).default(DEFAULT_WINDOW_DAYS),
});

export type MatchingSetting = z.infer<typeof matching>;

const tagList = z.array(z.string().trim().min(1).max(80)).max(30);
const confirmationTags = z.object({ confirmed: tagList, cancelled: tagList, pending: tagList, noAnswer: tagList, unreachable: tagList });

export const settingsRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  router.get('/settings/matching', async (_req, res) => {
    const sql = requireSql(getSql);
    const [row] = await sql<{ value: unknown }[]>`select value from app_settings where key = 'matching'`;
    res.json({ matching: matching.parse(row?.value ?? { refPrefixes: {} }) });
  });

  router.put('/settings/matching', async (req, res) => {
    const sql = requireSql(getSql);
    const value = parse(matching, req.body);
    const actor = await actorId(sql, sessionUser(req));
    await atomically(sql, async (tx) => {
      const [before] = await tx<{ value: unknown }[]>`select value from app_settings where key = 'matching' for update`;
      await tx`
        insert into app_settings (key, value) values ('matching', ${tx.json(value)})
        on conflict (key) do update set value = excluded.value
      `;
      await tx`
        insert into audit_log (actor_id, action, entity, entity_id, before, after)
        values (${actor}, 'settings.update', 'app_settings', 'matching', ${before ? tx.json(before.value as never) : null}, ${tx.json(value)})
      `;
    });
    res.json({ matching: value });
  });

  /** Which Shopify tags mean which confirmation outcome (S7). Run `npm run orders:states` after a change. */
  router.get('/settings/confirmation-tags', async (_req, res) => {
    const sql = requireSql(getSql);
    const [row] = await sql<{ value: Partial<ConfirmationTags> }[]>`select value from app_settings where key = 'confirmation_tags'`;
    res.json({ confirmationTags: { ...DEFAULT_CONFIRMATION_TAGS, ...(row?.value ?? {}) } });
  });

  router.put('/settings/confirmation-tags', async (req, res) => {
    const sql = requireSql(getSql);
    const value = parse(confirmationTags, req.body);
    const actor = await actorId(sql, sessionUser(req));
    await atomically(sql, async (tx) => {
      const [before] = await tx<{ value: unknown }[]>`select value from app_settings where key = 'confirmation_tags' for update`;
      await tx`
        insert into app_settings (key, value) values ('confirmation_tags', ${tx.json(value)})
        on conflict (key) do update set value = excluded.value
      `;
      await tx`
        insert into audit_log (actor_id, action, entity, entity_id, before, after)
        values (${actor}, 'settings.update', 'app_settings', 'confirmation_tags', ${before ? tx.json(before.value as never) : null}, ${tx.json(value)})
      `;
    });
    res.json({ confirmationTags: value });
  });

  return router;
};
