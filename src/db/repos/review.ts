import type { Db } from './upsert.js';

/**
 * The reconciliation queue: things a sync could not store or decide on, for a person or a
 * later retry to resolve. Unknown is a state, not an error (1.10).
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

/** Opens an item, or refreshes the detail of the one already open for the same problem. */
export const openReviewItem = async (db: Db, input: ReviewItemInput): Promise<string> => {
  const [row] = await db<{ id: string }[]>`
    insert into reconciliation_items (kind, dedupe_key, store_id, order_id, shipment_id, severity, detail)
    values (${input.kind}, ${input.dedupeKey}, ${input.storeId ?? null}, ${input.orderId ?? null}, ${input.shipmentId ?? null},
            ${input.severity ?? 'warning'}, ${db.json(input.detail as never)})
    on conflict (dedupe_key) where status = 'open' do update set detail = excluded.detail, severity = excluded.severity
    returning id
  `;
  if (!row) throw new Error('Review item upsert returned no row');
  return row.id;
};

/** Closes an item. `actorId` is null when the system resolved it (a retry that succeeded). */
export const resolveReviewItem = async (db: Db, id: string, note: string, actorId: string | null = null): Promise<void> => {
  await db`
    update reconciliation_items
    set status = 'resolved', resolved_at = now(), resolved_by = ${actorId}, note = ${note}
    where id = ${id} and status = 'open'
  `;
};

/** Closes the open item for a problem, if there is one: the sync found the answer itself. */
export const resolveOpenReviewItem = async (db: Db, dedupeKey: string, note: string): Promise<boolean> => {
  const rows = await db`
    update reconciliation_items
    set status = 'resolved', resolved_at = now(), resolved_by = null, note = ${note}
    where dedupe_key = ${dedupeKey} and status = 'open'
    returning id
  `;
  return rows.length > 0;
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
