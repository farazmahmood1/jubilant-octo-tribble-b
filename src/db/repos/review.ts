import { type Db, atomically } from './upsert.js';

/**
 * The reconciliation queue: things a sync could not store or decide on, for a person or a
 * later retry to resolve. Unknown is a state, not an error (1.10).
 *
 * A problem a person has decided on stays decided: an item they ignored, or resolved, is never
 * opened again for the same dedupe key, however often a job finds the same thing. An item the
 * system closed itself (the retry worked, the condition cleared) can open again if the problem
 * comes back. Every close is written to `audit_log`, by the person or by the system (rule 8).
 */

export interface ReviewItemInput {
  kind: string;
  /** Identifies the problem, so reporting it again while it is still open updates one item. */
  dedupeKey: string;
  storeId?: string | null;
  orderId?: string | null;
  shipmentId?: string | null;
  severity?: 'info' | 'warning' | 'error';
  detail: Record<string, unknown>;
}

export interface ReviewItemRow {
  id: string;
  kind: string;
  dedupeKey: string;
  storeId: string | null;
  orderId: string | null;
  detail: Record<string, unknown>;
  status: 'open' | 'resolved' | 'ignored';
  note: string | null;
}

/**
 * Opens an item, or refreshes the detail of the one already open for the same problem. Returns
 * null, writing nothing, when a person already decided on this problem.
 */
export const openReviewItem = async (db: Db, input: ReviewItemInput): Promise<string | null> => {
  const [row] = await db<{ id: string }[]>`
    insert into reconciliation_items (kind, dedupe_key, store_id, order_id, shipment_id, severity, detail)
    select ${input.kind}, ${input.dedupeKey}, ${input.storeId ?? null}, ${input.orderId ?? null}, ${input.shipmentId ?? null},
           ${input.severity ?? 'warning'}, ${db.json(input.detail as never)}
    where not exists (
      select 1 from reconciliation_items
      where dedupe_key = ${input.dedupeKey} and (status = 'ignored' or (status = 'resolved' and resolved_by is not null))
    )
    on conflict (dedupe_key) where status = 'open' do update set detail = excluded.detail, severity = excluded.severity
    returning id
  `;
  return row?.id ?? null;
};

type Decision = 'resolved' | 'ignored';

/** Closes open items by id or by dedupe key and audits each close. Returns the ids closed. */
const close = async (db: Db, where: { id: string } | { dedupeKey: string }, status: Decision, note: string, actorId: string | null): Promise<string[]> =>
  atomically(db, async (tx) => {
    const rows = await tx<{ id: string; kind: string; dedupe_key: string }[]>`
      update reconciliation_items
      set status = ${status}, resolved_at = now(), resolved_by = ${actorId}, note = ${note}
      where status = 'open' and ${'id' in where ? tx`id = ${where.id}` : tx`dedupe_key = ${where.dedupeKey}`}
      returning id, kind, dedupe_key
    `;
    for (const row of rows) {
      await tx`
        insert into audit_log (actor_id, action, entity, entity_id, before, after)
        values (${actorId}, ${`review.${status === 'resolved' ? 'resolve' : 'ignore'}`}, 'reconciliation_items', ${row.id},
                ${tx.json({ status: 'open' })}, ${tx.json({ status, note, kind: row.kind, dedupeKey: row.dedupe_key })})
      `;
    }
    return rows.map((r) => r.id);
  });

/** Closes an item. `actorId` is null when the system resolved it (a retry that succeeded). */
export const resolveReviewItem = async (db: Db, id: string, note: string, actorId: string | null = null): Promise<void> => {
  await close(db, { id }, 'resolved', note, actorId);
};

/** Closes the open item for a problem, if there is one: the sync found the answer itself. */
export const resolveOpenReviewItem = async (db: Db, dedupeKey: string, note: string, actorId: string | null = null): Promise<boolean> =>
  (await close(db, { dedupeKey }, 'resolved', note, actorId)).length > 0;

export class ReviewItemNotOpenError extends Error {
  constructor(id: string) {
    super(`Review item ${id} is not open`);
    this.name = 'ReviewItemNotOpenError';
  }
}

/** A person's decision on one open item: resolved (dealt with) or ignored (not a problem). */
export const decideReviewItem = async (db: Db, id: string, status: Decision, note: string, actorId: string): Promise<void> => {
  const closed = await close(db, { id }, status, note, actorId);
  if (closed.length === 0) throw new ReviewItemNotOpenError(id);
};

export const listOpenReviewItems = async (db: Db, kind: string, storeId?: string): Promise<ReviewItemRow[]> => {
  const rows = await db<{ id: string; kind: string; dedupe_key: string; store_id: string | null; order_id: string | null; detail: Record<string, unknown>; status: ReviewItemRow['status']; note: string | null }[]>`
    select id, kind, dedupe_key, store_id, order_id, detail, status, note from reconciliation_items
    where status = 'open' and kind = ${kind} ${storeId ? db`and store_id = ${storeId}` : db``}
    order by id
  `;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    dedupeKey: r.dedupe_key,
    storeId: r.store_id,
    orderId: r.order_id,
    detail: r.detail,
    status: r.status,
    note: r.note,
  }));
};

export interface ReviewItemView {
  id: string;
  kind: string;
  severity: 'info' | 'warning' | 'error';
  status: 'open' | 'resolved' | 'ignored';
  storeKey: string | null;
  orderId: string | null;
  orderNumber: string | null;
  shipmentId: string | null;
  trackingNumber: string | null;
  detail: Record<string, unknown>;
  note: string | null;
  resolvedBy: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface ReviewItemFilter {
  status?: 'open' | 'resolved' | 'ignored';
  kind?: string;
  storeKey?: string;
  /** Keyset pagination: items with a smaller id than this, newest first. */
  beforeId?: string;
  limit: number;
}

/**
 * The queue as the dashboard shows it, newest first. Names the order and parcel by their numbers,
 * never by customer details: `detail` is written by the jobs and holds no PII.
 */
export const listReviewItems = async (db: Db, filter: ReviewItemFilter): Promise<ReviewItemView[]> => {
  const rows = await db<
    {
      id: string; kind: string; severity: ReviewItemView['severity']; status: ReviewItemView['status']; store_key: string | null;
      order_id: string | null; order_number: string | null; shipment_id: string | null; tracking_number: string | null;
      detail: Record<string, unknown>; note: string | null; resolved_by: string | null; created_at: Date; resolved_at: Date | null;
    }[]
  >`
    select r.id, r.kind, r.severity, r.status, st.key as store_key, r.order_id, o.order_number, r.shipment_id, sh.tracking_number,
           r.detail, r.note, u.email as resolved_by, r.created_at, r.resolved_at
    from reconciliation_items r
    left join stores st on st.id = r.store_id
    left join orders o on o.id = r.order_id
    left join shipments sh on sh.id = r.shipment_id
    left join users u on u.id = r.resolved_by
    where true
      ${filter.status ? db`and r.status = ${filter.status}` : db``}
      ${filter.kind ? db`and r.kind = ${filter.kind}` : db``}
      ${filter.storeKey ? db`and st.key = ${filter.storeKey}` : db``}
      ${filter.beforeId ? db`and r.id < ${filter.beforeId}` : db``}
    order by r.id desc
    limit ${filter.limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    severity: r.severity,
    status: r.status,
    storeKey: r.store_key,
    orderId: r.order_id,
    orderNumber: r.order_number,
    shipmentId: r.shipment_id,
    trackingNumber: r.tracking_number,
    detail: r.detail,
    note: r.note,
    resolvedBy: r.resolved_by,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  }));
};

/** Open items per kind, for the queue's tabs and the dashboard; for one brand when `storeKey` is given. */
export const countOpenByKind = async (db: Db, storeKey?: string): Promise<Record<string, number>> => {
  const rows = await db<{ kind: string; n: number }[]>`
    select r.kind, count(*)::int as n from reconciliation_items r
    ${storeKey ? db`join stores st on st.id = r.store_id` : db``}
    where r.status = 'open' ${storeKey ? db`and st.key = ${storeKey}` : db``}
    group by r.kind order by r.kind
  `;
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
};
