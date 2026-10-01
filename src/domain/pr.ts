import type { Sql } from '../db.js';
import { recomputeOrderState } from '../db/repos/order-state.js';
import { openReviewItem } from '../db/repos/review.js';
import { type Db, atomically, readPaisa } from '../db/repos/upsert.js';
import { costAt } from '../db/repos/variants.js';
import type { JobDefinition } from '../jobs/runner.js';
import { type Paisa, ZERO, add, paisa } from '../lib/money.js';
import { cogsLines, karachiDay, postShipmentAccounting, settle } from './accounting.js';
import { locationId, reconcileShipmentStock, recordMove } from './stock.js';

/**
 * Influencer PR (Step 13). A PR send is marketing: no sale, no revenue, not a return when it
 * comes back, its goods and its PostEx charges expensed to marketing.
 *
 * **Detection** (`pr:detect`, hourly, idempotent) finds sends made outside the platform:
 *
 * | Signal                                   | Becomes                                              |
 * |------------------------------------------|------------------------------------------------------|
 * | Shopify order tagged `PR`                | PR: the team marked it so themselves                 |
 * | Shopify order discounted to zero         | a suggestion for a person to classify                |
 * | PostEx parcel with zero COD              | a suggestion (CLAUDE.md: PR, a gift or a replacement; never assumed) |
 *
 * It only inserts, keyed on the parcel or order, so running it again changes nothing and it can
 * never touch a send a person classified.
 *
 * **Classifying** a send (PR, replacement, gift, or not PR) is a person's decision, audited. Its
 * effects follow at once: `shipment_is_pr()` (0016) is what stock, accounting and every report
 * ask, so the parcel's stock moves, postings and order state are re-derived in the same
 * transaction. A PR parcel's goods go `in_transit → marketing` on delivery and a refused one comes
 * back through `returning` (note S10). Goods in a send with no order lines (a parcel booked
 * outside Shopify, or handed over) are entered as lines and move `warehouse → marketing`, their
 * cost posted Marketing / Inventory.
 */

export class PrError extends Error {
  readonly status: 404 | 409;
  constructor(message: string, status: 404 | 409 = 409) {
    super(message);
    this.name = 'PrError';
    this.status = status;
  }
}

export const CLASSIFICATIONS = ['pr', 'replacement', 'gift', 'not_pr'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

const audit = (db: Db, actorId: string, action: string, entityId: string, after: Record<string, unknown>) =>
  db`insert into audit_log (actor_id, action, entity, entity_id, after) values (${actorId}, ${action}, 'pr_sends', ${entityId}, ${db.json(after as never)})`;

// ---- Detection ----

export interface DetectionStats {
  tagged: number;
  fullDiscount: number;
  zeroCod: number;
}

/** Inserts a send for every signal not already covered. Never updates a row. */
export const detectPrSends = async (sql: Sql): Promise<DetectionStats> =>
  atomically(sql, async (tx) => {
    const tagged = await tx`
      insert into pr_sends (order_id, source, detected_by, classification, sent_at)
      select o.id, 'auto', 'shopify_pr_tag', 'pr', o.placed_at from orders o
      where o.channel = 'pr' and not exists (select 1 from pr_sends ps where ps.order_id = o.id)
      on conflict do nothing
      returning id
    `;
    // Discounted to nothing: items were on it, the customer was charged nothing.
    const fullDiscount = await tx`
      insert into pr_sends (order_id, source, detected_by, sent_at)
      select o.id, 'auto', 'full_discount', o.placed_at from orders o
      where o.channel = 'online' and o.cancelled_at is null and o.total_paisa = 0 and o.subtotal_paisa > 0
        and not exists (select 1 from pr_sends ps where ps.order_id = o.id)
        and not exists (select 1 from pr_sends ps join shipments s on s.id = ps.shipment_id where s.order_id = o.id)
      on conflict do nothing
      returning id
    `;
    // A parcel with nothing to collect, unless its order is already a send.
    const zeroCod = await tx`
      insert into pr_sends (shipment_id, source, detected_by, sent_at)
      select s.id, 'auto', 'zero_cod', coalesce(s.booked_at, s.created_at) from shipments s
      where s.cod_amount_paisa = 0
        and not exists (select 1 from pr_sends ps where ps.shipment_id = s.id)
        and (s.order_id is null or not exists (select 1 from pr_sends ps where ps.order_id = s.order_id))
      on conflict do nothing
      returning id
    `;
    return { tagged: tagged.length, fullDiscount: fullDiscount.length, zeroCod: zeroCod.length };
  });

export const PR_DETECT_JOB = 'pr:detect';

export const prDetectJob: JobDefinition = {
  name: PR_DETECT_JOB,
  // Hourly, after the order and parcel syncs have had their turn.
  schedule: { everyMs: 60 * 60 * 1000, alignToClock: true },
  handler: async ({ sql, logger }) => {
    const stats = await detectPrSends(sql);
    logger.info({ ...stats }, 'PR detection finished');
    return { ...stats };
  },
};

// ---- Effects ----

/** The parcels a send concerns: its own, or its order's. */
const parcelsOf = async (db: Db, send: { shipment_id: string | null; order_id: string | null }): Promise<string[]> =>
  (
    await db<{ id: string }[]>`
      select id from shipments where id = ${send.shipment_id} or (${send.order_id}::bigint is not null and order_id = ${send.order_id})
    `
  ).map((r) => r.id);

/**
 * Brings a send's own lines (if any) in line with its classification: units in marketing and
 * their cost expensed while it is PR, back in the warehouse and the entry reversed when it is
 * not. Moves are numbered per line, so classifying back and forth stays a true history.
 */
const settleLines = async (db: Db, sendId: string, pr: boolean, sentAt: Date, actorId: string): Promise<void> => {
  const lines = await db<{ id: string; variant_id: string; qty: number; store_id: string }[]>`
    select l.id, l.variant_id, l.qty, v.store_id from pr_send_lines l join variants v on v.id = l.variant_id where l.pr_send_id = ${sendId} order by l.id
  `;
  if (lines.length === 0) return;
  const warehouse = await locationId(db, 'warehouse');
  const marketing = await locationId(db, 'marketing');
  const costs = new Map<string, Paisa>();
  let missing = false;
  for (const line of lines) {
    const moves = await db<{ to_marketing: number; from_marketing: number; n: number }[]>`
      select coalesce(sum(qty) filter (where to_location_id = ${marketing}), 0)::int as to_marketing,
             coalesce(sum(qty) filter (where from_location_id = ${marketing}), 0)::int as from_marketing, count(*)::int as n
      from stock_moves where ref_type = 'pr_send_line' and ref_id like ${`${line.id}:%`}
    `;
    const out = moves[0]!.to_marketing - moves[0]!.from_marketing > 0;
    if (pr !== out) {
      await recordMove(db, {
        variantId: line.variant_id,
        qty: line.qty,
        from: pr ? warehouse : marketing,
        to: pr ? marketing : warehouse,
        reason: pr ? 'pr_send' : 'pr_send_undone',
        refType: 'pr_send_line',
        refId: `${line.id}:${moves[0]!.n + 1}`,
        actorId,
        occurredAt: pr ? sentAt : new Date(),
      });
    }
    const cost = await costAt(db, line.variant_id, sentAt);
    if (cost === null) {
      missing = true;
      await openReviewItem(db, {
        kind: 'cost_missing',
        dedupeKey: `cost_missing:${line.variant_id}:${karachiDay(sentAt)}`,
        storeId: line.store_id,
        detail: { variantId: line.variant_id, needCostOn: karachiDay(sentAt) },
      });
      continue;
    }
    costs.set(line.store_id, add(costs.get(line.store_id) ?? ZERO, paisa(cost * BigInt(line.qty))));
  }
  for (const storeId of new Set(lines.map((l) => l.store_id))) {
    const cost = costs.get(storeId);
    await settle(db, {
      source: { type: 'pr_send', id: `${sendId}:${storeId}` },
      lines: pr && !missing && cost !== undefined ? cogsLines({ storeId, cost, pr: true }) : null,
      date: karachiDay(sentAt),
      memo: `PR send ${sendId}: goods to marketing`,
    });
  }
};

/** Re-derives everything a send's classification decides, in the caller's transaction. */
const applySend = async (sql: Sql, sendId: string, actorId: string): Promise<void> => {
  const [send] = await sql<{ shipment_id: string | null; order_id: string | null; classification: Classification | null; sent_at: Date }[]>`
    select shipment_id, order_id, classification, sent_at from pr_sends where id = ${sendId}
  `;
  if (!send) return;
  await settleLines(sql, sendId, send.classification === 'pr', send.sent_at, actorId);
  for (const shipmentId of await parcelsOf(sql, send)) {
    await reconcileShipmentStock(sql, shipmentId);
    await postShipmentAccounting(sql, shipmentId);
  }
  const orders = new Set<string>(send.order_id ? [send.order_id] : []);
  if (send.shipment_id) {
    const [linked] = await sql<{ order_id: string | null }[]>`select order_id from shipments where id = ${send.shipment_id}`;
    if (linked?.order_id) orders.add(linked.order_id);
  }
  for (const orderId of orders) await recomputeOrderState(sql, orderId);
};

// ---- A person's decisions ----

export interface ClassifyInput {
  sendId: string;
  classification: Classification;
  influencerId?: string | null;
  /** What was in it, for a send with no order lines; entered once. */
  lines?: Array<{ variantId: string; qty: number }>;
  note?: string | null;
  actorId: string;
}

const hasOrderLines = async (db: Db, send: { shipment_id: string | null; order_id: string | null }): Promise<boolean> => {
  const [row] = await db`
    select 1 from order_lines ol
    where ol.qty > 0 and ol.order_id in (
      select ${send.order_id}::bigint where ${send.order_id}::bigint is not null
      union select order_id from shipments where id = ${send.shipment_id} and order_id is not null
    ) limit 1
  `;
  return row !== undefined;
};

const addLines = async (db: Db, sendId: string, send: { shipment_id: string | null; order_id: string | null }, lines: ClassifyInput['lines']): Promise<void> => {
  if (!lines || lines.length === 0) return;
  // The order's lines already say what went out; entering them again would move the stock twice.
  if (await hasOrderLines(db, send)) throw new PrError('This send has an order with lines; its goods are already known');
  const [existing] = await db`select 1 from pr_send_lines where pr_send_id = ${sendId} limit 1`;
  if (existing) throw new PrError('The goods in this send are already entered');
  for (const line of lines) {
    await db`insert into pr_send_lines (pr_send_id, variant_id, qty) values (${sendId}, ${line.variantId}, ${line.qty})`.catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && (error as { code?: string }).code === '23503') throw new PrError(`Product ${line.variantId} not found`, 404);
      if (error instanceof Error && 'code' in error && (error as { code?: string }).code === '23505') throw new PrError('Each product once per send');
      throw error;
    });
  }
};

/** A person classifies a send (or changes their mind), and its stock and postings follow. */
export const classifyPrSend = async (sql: Sql, input: ClassifyInput): Promise<void> =>
  atomically(sql, async (tx) => {
    const [send] = await tx<{ shipment_id: string | null; order_id: string | null; classification: Classification | null; detected_by: string | null }[]>`
      select shipment_id, order_id, classification, detected_by from pr_sends where id = ${input.sendId} for update
    `;
    if (!send) throw new PrError(`PR send ${input.sendId} not found`, 404);
    if (send.detected_by === 'shopify_pr_tag' && input.classification !== 'pr') {
      throw new PrError('The order is tagged PR in Shopify; remove the tag there to change it');
    }
    await addLines(tx, input.sendId, send, input.lines);
    await tx`
      update pr_sends set classification = ${input.classification}, decided_by = ${input.actorId}, decided_at = now(),
             influencer_id = coalesce(${input.influencerId ?? null}, influencer_id), note = coalesce(${input.note ?? null}, note)
      where id = ${input.sendId}
    `;
    await applySend(tx as Sql, input.sendId, input.actorId);
    await audit(tx, input.actorId, 'pr_send.classify', input.sendId, {
      from: send.classification,
      to: input.classification,
      influencerId: input.influencerId ?? null,
      lines: input.lines ?? [],
    });
  });

export interface ManualSendInput {
  influencerId: string;
  sentAt: Date;
  /** The PostEx parcel it went in, if it went by PostEx. */
  trackingNumber?: string | null;
  lines?: Array<{ variantId: string; qty: number }>;
  note?: string | null;
  actorId: string;
}

/** A PR send entered by a person: PR from the start. */
export const createPrSend = async (sql: Sql, input: ManualSendInput): Promise<string> =>
  atomically(sql, async (tx) => {
    const [influencer] = await tx`select 1 from influencers where id = ${input.influencerId}`;
    if (!influencer) throw new PrError(`Influencer ${input.influencerId} not found`, 404);
    let shipmentId: string | null = null;
    if (input.trackingNumber) {
      const found = await tx<{ id: string }[]>`select id from shipments where tracking_number = ${input.trackingNumber}`;
      if (found.length !== 1) throw new PrError(`Parcel ${input.trackingNumber} ${found.length === 0 ? 'not found' : 'is on more than one account'}`, found.length === 0 ? 404 : 409);
      shipmentId = found[0]!.id;
      const [taken] = await tx<{ id: string; classification: string | null }[]>`select id, classification from pr_sends where shipment_id = ${shipmentId}`;
      if (taken) throw new PrError(`Parcel ${input.trackingNumber} is already send ${taken.id}${taken.classification ? '' : ', detected and waiting to be classified'}`);
    }
    if (!shipmentId && (!input.lines || input.lines.length === 0)) throw new PrError('Say what was sent, or which parcel it went in');
    const [send] = await tx<{ id: string }[]>`
      insert into pr_sends (influencer_id, shipment_id, source, classification, decided_by, decided_at, sent_at, note, created_by)
      values (${input.influencerId}, ${shipmentId}, 'manual', 'pr', ${input.actorId}, now(), ${input.sentAt}, ${input.note ?? null}, ${input.actorId})
      returning id
    `;
    await addLines(tx, send!.id, { shipment_id: shipmentId, order_id: null }, input.lines);
    await applySend(tx as Sql, send!.id, input.actorId);
    await audit(tx, input.actorId, 'pr_send.create', send!.id, { influencerId: input.influencerId, trackingNumber: input.trackingNumber ?? null, lines: input.lines ?? [] });
    return send!.id;
  });

// ---- Reading ----

export interface PrSendRow {
  id: string;
  source: 'auto' | 'manual';
  detectedBy: string | null;
  /** Null while it waits for a person. */
  classification: Classification | null;
  decidedBy: string | null;
  influencerId: string | null;
  influencer: string | null;
  shipmentId: string | null;
  trackingNumber: string | null;
  orderId: string | null;
  orderNumber: string | null;
  sentAt: Date;
  parcelStatus: string | null;
  /** Expensed to marketing so far: goods and PostEx charges (paisa). */
  marketing: Paisa;
  note: string | null;
}

export const listPrSends = async (db: Db, opts: { status?: 'suggested' | 'decided' | 'pr' | 'all'; influencerId?: string } = {}): Promise<PrSendRow[]> => {
  const status = opts.status ?? 'all';
  const rows = await db<{
    id: string; source: 'auto' | 'manual'; detected_by: string | null; classification: Classification | null; decided_by: string | null;
    influencer_id: string | null; influencer: string | null; shipment_id: string | null; tracking_number: string | null; order_id: string | null;
    order_number: string | null; sent_at: Date; status_code: string | null; marketing: string; note: string | null;
  }[]>`
    select ps.id, ps.source, ps.detected_by, ps.classification, u.name as decided_by, ps.influencer_id, i.name as influencer,
           ps.shipment_id, s.tracking_number, coalesce(ps.order_id, s.order_id) as order_id, o.order_number, ps.sent_at, s.status_code, ps.note,
           (select coalesce(sum(l.debit_paisa - l.credit_paisa), 0) from ledger_lines l
            where l.account_code = '6100'
              and (l.shipment_id in (select sx.id from shipments sx where sx.id = ps.shipment_id or (ps.order_id is not null and sx.order_id = ps.order_id))
                   or (l.origin_type = 'pr_send' and l.origin_id like ps.id || ':%')))::text as marketing
    from pr_sends ps
    left join shipments s on s.id = ps.shipment_id
    left join orders o on o.id = coalesce(ps.order_id, s.order_id)
    left join influencers i on i.id = ps.influencer_id
    left join users u on u.id = ps.decided_by
    where true
      ${status === 'suggested' ? db`and ps.classification is null` : status === 'decided' ? db`and ps.classification is not null` : status === 'pr' ? db`and ps.classification = 'pr'` : db``}
      ${opts.influencerId ? db`and ps.influencer_id = ${opts.influencerId}` : db``}
    order by ps.classification is not null, ps.sent_at desc, ps.id desc
  `;
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    detectedBy: r.detected_by,
    classification: r.classification,
    decidedBy: r.decided_by,
    influencerId: r.influencer_id,
    influencer: r.influencer,
    shipmentId: r.shipment_id,
    trackingNumber: r.tracking_number,
    orderId: r.order_id,
    orderNumber: r.order_number,
    sentAt: r.sent_at,
    parcelStatus: r.status_code,
    marketing: readPaisa(r.marketing),
    note: r.note,
  }));
};

// ---- Posts ----

export const addPost = async (
  db: Db,
  input: { influencerId: string; url: string; kind: 'reel' | 'story' | 'post'; postedAt: Date; prSendId?: string | null; note?: string | null; actorId: string },
): Promise<string> =>
  atomically(db, async (tx) => {
    const [influencer] = await tx`select 1 from influencers where id = ${input.influencerId}`;
    if (!influencer) throw new PrError(`Influencer ${input.influencerId} not found`, 404);
    if (input.prSendId) {
      const [send] = await tx<{ influencer_id: string | null }[]>`select influencer_id from pr_sends where id = ${input.prSendId}`;
      if (!send) throw new PrError(`PR send ${input.prSendId} not found`, 404);
      if (send.influencer_id && send.influencer_id !== input.influencerId) throw new PrError('That send went to another influencer');
    }
    const [row] = await tx<{ id: string }[]>`
      insert into influencer_posts (influencer_id, pr_send_id, url, kind, posted_at, note, created_by)
      values (${input.influencerId}, ${input.prSendId ?? null}, ${input.url}, ${input.kind}, ${input.postedAt}, ${input.note ?? null}, ${input.actorId})
      returning id
    `.catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && (error as { code?: string }).code === '23505') throw new PrError('That post is already recorded');
      throw error;
    });
    await tx`insert into audit_log (actor_id, action, entity, entity_id, after) values (${input.actorId}, 'influencer.post', 'influencers', ${input.influencerId}, ${tx.json({ url: input.url, kind: input.kind })})`;
    return row!.id;
  });

export const listPosts = async (db: Db, influencerId?: string) =>
  db<{ id: string; influencer_id: string; influencer: string; pr_send_id: string | null; url: string; kind: string; posted_at: Date; note: string | null }[]>`
    select p.id, p.influencer_id, i.name as influencer, p.pr_send_id, p.url, p.kind, p.posted_at, p.note
    from influencer_posts p join influencers i on i.id = p.influencer_id
    ${influencerId ? db`where p.influencer_id = ${influencerId}` : db``}
    order by p.posted_at desc, p.id desc
  `;
