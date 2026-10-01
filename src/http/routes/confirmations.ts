import { Router } from 'express';
import { z } from 'zod';

import { actorId } from '../../auth/actor.js';
import { deskSettings } from '../../db/repos/confirmations.js';
import { atomically } from '../../db/repos/upsert.js';
import { ATTEMPT_OUTCOMES, CHANNELS, type DeskSettings, unknownFields } from '../../domain/confirmation.js';
import {
  DeskError,
  QUEUE_STATES,
  agentPerformance,
  customerHistory,
  deskOrder,
  deskQueue,
  recordAttempt,
} from '../../domain/confirmation-desk.js';
import { endOfKarachiDay } from '../../lib/time.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { HttpError } from '../middleware/errors.js';
import { ID, parse } from '../validate.js';

/**
 * The Confirmation Desk (Step 11): the queue agents work from, one order with the customer's
 * history across both brands, recording what happened, scheduling a follow-up, agent performance,
 * the desk's two alerts, and the desk's settings. Every outcome is audited with the agent.
 *
 * Phone numbers are customer PII. The accountant role never sees them (1.9); that is enforced
 * here, in what the API sends, not in the screen.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const store = z.enum(['nur', 'organics']);
const queueQuery = z.object({
  store: store.optional(),
  state: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').map((x) => x.trim()) : []))
    .pipe(z.array(z.enum(QUEUE_STATES))),
  due: z.enum(['now', 'all']).default('all'),
  search: z.string().trim().max(40).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const orderParams = z.object({ orderId: z.string().regex(ID) });
const attempt = z.object({
  channel: z.enum(CHANNELS),
  outcome: z.enum(ATTEMPT_OUTCOMES).exclude(['rescheduled']),
  reason: z.string().trim().max(500).optional(),
  note: z.string().trim().max(2000).optional(),
  /** A callback's time, ISO with an offset. */
  followUpAt: z.string().datetime({ offset: true }).optional(),
});
const followUp = z.object({ at: z.string().datetime({ offset: true }), note: z.string().trim().max(2000).optional() });
const historyQuery = z.object({ phone: z.string().trim().min(7).max(30), city: z.string().trim().max(80).optional() });
const periodQuery = z.object({ from: z.string().regex(DAY).optional(), to: z.string().regex(DAY).optional() });

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a time is HH:MM, 24-hour');
const template = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .superRefine((t, ctx) => {
    const unknown = unknownFields(t);
    if (unknown.length > 0) ctx.addIssue({ code: 'custom', message: `unknown placeholders: ${unknown.map((f) => `{${f}}`).join(', ')}` });
  });
const settings = z
  .object({
    maxAttempts: z.number().int().min(1).max(10),
    retryMinutes: z.array(z.number().int().min(5).max(24 * 60)).min(1).max(5),
    deskHours: z.object({ open: hhmm, close: hhmm }),
    whatsappTemplates: z.object({ nur: template, organics: template }),
  })
  .refine((s) => s.deskHours.open < s.deskHours.close, { message: 'the desk must open before it closes', path: ['deskHours'] });

/** Whether a role may see customers' phone numbers. */
const seesPhones = (role: string): boolean => role !== 'accountant';

export const withoutPhones = <T extends { phone: string | null; whatsappUrl: string | null; callUrl: string | null }>(row: T, role: string): T =>
  seesPhones(role) ? row : { ...row, phone: null, whatsappUrl: null, callUrl: null };

const asHttp = (error: unknown): never => {
  if (error instanceof DeskError) throw new HttpError(error.status, error.message);
  throw error;
};

export const confirmationsRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  router.get('/confirmations/queue', async (req, res) => {
    const sql = requireSql(getSql);
    const q = parse(queueQuery, req.query);
    const { role } = sessionUser(req);
    const result = await deskQueue(sql, {
      ...(q.store ? { store: q.store } : {}),
      states: q.state,
      dueOnly: q.due === 'now',
      ...(q.search ? { search: q.search } : {}),
      page: q.page,
      pageSize: q.pageSize,
      now: new Date(),
    });
    res.json({ total: result.total, page: q.page, pageSize: q.pageSize, rows: result.rows.map((r) => withoutPhones(r, role)) });
  });

  /** One order at the desk: its lines, every attempt, the links, and the customer's history. */
  router.get('/confirmations/orders/:orderId', async (req, res) => {
    const sql = requireSql(getSql);
    const { orderId } = parse(orderParams, req.params);
    const order = await deskOrder(sql, orderId);
    if (!order) throw new HttpError(404, `Order ${orderId} not found`);
    const { role } = sessionUser(req);
    const history = order.phone && seesPhones(role) ? await customerHistory(sql, order.phone, { city: order.city, excludeOrderId: orderId }) : null;
    res.json({ order: withoutPhones(order, role), history });
  });

  /** History by phone, typed in any shape; matched on the normalised number across both brands. */
  router.get('/confirmations/history', async (req, res) => {
    const sql = requireSql(getSql);
    const q = parse(historyQuery, req.query);
    if (!seesPhones(sessionUser(req).role)) throw new HttpError(403, 'Customer phone numbers are not available to this role');
    const history = await customerHistory(sql, q.phone, { city: q.city ?? null });
    if (!history) throw new HttpError(400, 'phone: not a Pakistani mobile number');
    res.json({ history });
  });

  router.post('/confirmations/orders/:orderId/attempts', async (req, res) => {
    const sql = requireSql(getSql);
    const { orderId } = parse(orderParams, req.params);
    const body = parse(attempt, req.body);
    const result = await recordAttempt(sql, {
      orderId,
      agentId: await actorId(sql, sessionUser(req)),
      channel: body.channel,
      outcome: body.outcome,
      at: new Date(),
      followUpAt: body.followUpAt ? new Date(body.followUpAt) : null,
      reason: body.reason ?? null,
      note: body.note ?? null,
    }).catch(asHttp);
    res.status(201).json(result);
  });

  /** A follow-up at a set time, without contacting the customer now. */
  router.post('/confirmations/orders/:orderId/follow-up', async (req, res) => {
    const sql = requireSql(getSql);
    const { orderId } = parse(orderParams, req.params);
    const body = parse(followUp, req.body);
    const result = await recordAttempt(sql, {
      orderId,
      agentId: await actorId(sql, sessionUser(req)),
      channel: null,
      outcome: 'rescheduled',
      at: new Date(),
      followUpAt: new Date(body.at),
      note: body.note ?? null,
    }).catch(asHttp);
    res.status(201).json(result);
  });

  router.get('/confirmations/agents', async (req, res) => {
    const sql = requireSql(getSql);
    const q = parse(periodQuery, req.query);
    for (const day of [q.from, q.to]) {
      if (day) {
        try {
          endOfKarachiDay(day);
        } catch {
          throw new HttpError(400, `${day} is not a real date`);
        }
      }
    }
    res.json({ agents: await agentPerformance(sql, q) });
  });

  /** The desk's two alerts, open, oldest first. The scan raises and clears them hourly. */
  router.get('/confirmations/alerts', async (_req, res) => {
    const sql = requireSql(getSql);
    const rows = await sql<{ id: string; kind: string; severity: string; order_id: string | null; store: string | null; detail: Record<string, unknown>; created_at: Date }[]>`
      select r.id, r.kind, r.severity, r.order_id, st.key as store, r.detail, r.created_at
      from reconciliation_items r left join stores st on st.id = r.store_id
      where r.status = 'open' and r.kind in ('confirmed_not_booked', 'cancelled_but_booked')
      order by r.created_at, r.id
    `;
    res.json({
      alerts: rows.map((r) => ({ id: r.id, kind: r.kind, severity: r.severity, orderId: r.order_id, store: r.store, detail: r.detail, openedAt: r.created_at })),
    });
  });

  router.get('/settings/confirmation-desk', async (_req, res) => {
    const sql = requireSql(getSql);
    res.json({ confirmationDesk: await deskSettings(sql) });
  });

  router.put('/settings/confirmation-desk', async (req, res) => {
    const sql = requireSql(getSql);
    const value: DeskSettings = parse(settings, req.body);
    const actor = await actorId(sql, sessionUser(req));
    await atomically(sql, async (tx) => {
      const [before] = await tx<{ value: unknown }[]>`select value from app_settings where key = 'confirmation_desk' for update`;
      await tx`
        insert into app_settings (key, value) values ('confirmation_desk', ${tx.json(value as never)})
        on conflict (key) do update set value = excluded.value
      `;
      await tx`
        insert into audit_log (actor_id, action, entity, entity_id, before, after)
        values (${actor}, 'settings.update', 'app_settings', 'confirmation_desk', ${before ? tx.json(before.value as never) : null}, ${tx.json(value as never)})
      `;
    });
    res.json({ confirmationDesk: value });
  });

  return router;
};
