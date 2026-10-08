import { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import { type ConfirmationTags, DEFAULT_CONFIRMATION_TAGS } from '../../db/repos/order-state.js';
import { atomically } from '../../db/repos/upsert.js';
import { DEFAULT_WINDOW_DAYS } from '../../domain/matching.js';
import { DEFAULT_CONFIRMED_LOOKBACK_DAYS, DEFAULT_CONFIRMED_NOT_BOOKED_HOURS, DEFAULT_STUCK_DAYS } from '../../jobs/reconciliation.js';
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

/**
 * `app_settings` key `alerts`: when the hourly reconciliation scan raises the time-based alerts.
 * A missing key keeps its default, so a partial setting only changes what it names.
 */
const alertThresholds = z.object({
  /** An open parcel with no status change for this many Karachi days is "stuck in transit". */
  stuckDays: z.number().int().min(1).max(90),
  /** A confirmed order with no parcel booked after this many hours raises "confirmed, not booked". */
  confirmedNotBookedHours: z.number().int().min(1).max(720),
  /** Orders confirmed longer ago than this are not chased: they are history, not a missed booking. */
  confirmedLookbackDays: z.number().int().min(1).max(180),
});
export type AlertThresholds = z.infer<typeof alertThresholds>;

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  stuckDays: DEFAULT_STUCK_DAYS,
  confirmedNotBookedHours: DEFAULT_CONFIRMED_NOT_BOOKED_HOURS,
  confirmedLookbackDays: DEFAULT_CONFIRMED_LOOKBACK_DAYS,
};

const tagList = z.array(z.string().trim().min(1).max(80)).max(30);
const confirmationTags = z.object({ confirmed: tagList, cancelled: tagList, pending: tagList, noAnswer: tagList, unreachable: tagList });

/**
 * `app_settings` key `shopify`: whether a return check-in is carried to Shopify (cancel the open
 * order with its items restocked, or put the units back on a fulfilled one). On unless switched off.
 */
const shopifySetting = z.object({ returnsWriteback: z.boolean() });

export const settingsRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  router.get('/settings/shopify', async (_req, res) => {
    const sql = requireSql(getSql);
    const [row] = await sql<{ value: { returnsWriteback?: boolean } }[]>`select value from app_settings where key = 'shopify'`;
    res.json({ shopify: { returnsWriteback: row?.value.returnsWriteback !== false } });
  });

  router.put('/settings/shopify', async (req, res) => {
    const sql = requireSql(getSql);
    const value = parse(shopifySetting, req.body);
    const actor = await actorId(sql, sessionUser(req));
    await atomically(sql, async (tx) => {
      const [before] = await tx<{ value: unknown }[]>`select value from app_settings where key = 'shopify' for update`;
      await tx`
        insert into app_settings (key, value) values ('shopify', ${tx.json(value)})
        on conflict (key) do update set value = excluded.value
      `;
      await tx`
        insert into audit_log (actor_id, action, entity, entity_id, before, after)
        values (${actor}, 'settings.update', 'app_settings', 'shopify', ${before ? tx.json(before.value as never) : null}, ${tx.json(value)})
      `;
    });
    res.json({ shopify: value });
  });

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

  router.get('/settings/alerts', async (_req, res) => {
    const sql = requireSql(getSql);
    const [row] = await sql<{ value: Partial<AlertThresholds> }[]>`select value from app_settings where key = 'alerts'`;
    res.json({ alerts: { ...DEFAULT_ALERT_THRESHOLDS, ...(row?.value ?? {}) } });
  });

  /** Read by the scan on every run, so a change applies at the next hourly scan. Audited. */
  router.put('/settings/alerts', async (req, res) => {
    const sql = requireSql(getSql);
    const value = parse(alertThresholds, req.body);
    const actor = await actorId(sql, sessionUser(req));
    await atomically(sql, async (tx) => {
      const [before] = await tx<{ value: unknown }[]>`select value from app_settings where key = 'alerts' for update`;
      await tx`
        insert into app_settings (key, value) values ('alerts', ${tx.json(value)})
        on conflict (key) do update set value = excluded.value
      `;
      await tx`
        insert into audit_log (actor_id, action, entity, entity_id, before, after)
        values (${actor}, 'settings.update', 'app_settings', 'alerts', ${before ? tx.json(before.value as never) : null}, ${tx.json(value)})
      `;
    });
    res.json({ alerts: value });
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
