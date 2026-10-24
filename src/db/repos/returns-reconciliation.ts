import type { ParcelStage } from '../../domain/order-state.js';
import { type IssueKind, type ReturnFacts, type ReturnIssue, returnIssues } from '../../domain/returns-reconciliation.js';
import { STAGE_SQL } from './parcels.js';
import type { Db } from './upsert.js';

/**
 * The returns reconciliation (domain/returns-reconciliation.ts): every order or parcel that any
 * source says came back, or was refunded, returned or cancelled after a parcel left, one row per
 * parcel (per order when Shopify's record has no parcel here), with each source's facts and what
 * disagrees. Read-only.
 */

export interface ReturnsReconciliationFilter {
  store?: 'nur' | 'organics';
  /** Only rows with at least one warning or error (the default), or every row; a note alone needs nobody. */
  onlyIssues?: boolean;
  kind?: IssueKind;
  limit?: number;
}

export interface ReturnsReconciliationRow extends ReturnFacts {
  issues: ReturnIssue[];
}

export const returnsReconciliation = async (db: Db, f: ReturnsReconciliationFilter = {}, now: Date = new Date()): Promise<{ rows: ReturnsReconciliationRow[]; counts: Record<string, number> }> => {
  const rows = await db<{
    order_id: string | null; order_number: string | null; store: string | null; placed_at: Date | null; before_import: boolean;
    shipment_id: string | null; tracking_number: string | null; stage: ParcelStage | null; returned_at: Date | null;
    check_in: 'restocked' | 'damaged' | 'mixed' | null; checked_in_at: Date | null;
    wb_outcome: 'done' | 'skipped' | 'failed' | 'pending' | null; wb_message: string | null; wb_ahead: number | null; wb_not_found: boolean | null;
    cancelled: boolean | null; financial_status: string | null; fulfillment_status: string | null; return_status: string | null; refunded: string | null;
    units_restocked: number; units_not_restocked: number; units_returned: number; returns: Array<{ name: string | null; status: string }> | null;
  }[]>`
    with first_parcel as (
      select a.store_id, min(s.booked_at) as since from shipments s join postex_accounts a on a.id = s.postex_account_id group by a.store_id
    ),
    pairs as (
      -- Parcels on their way back, back, or checked in.
      select s.id as shipment_id, s.order_id from shipments s
      where ${db.unsafe(STAGE_SQL)} in ('returning', 'returned') or exists (select 1 from return_check_ins c where c.shipment_id = s.id)
      union
      -- Orders Shopify records a refund, a return or a cancellation on: each of their parcels, or the order alone.
      select s.id, o.id from orders o
      left join shipments s on s.order_id = o.id
      where exists (select 1 from shopify_refunds r join shopify_refund_lines rl on rl.refund_id = r.id where r.order_id = o.id and rl.qty > 0)
         or exists (select 1 from shopify_returns sr where sr.order_id = o.id)
         or (o.cancelled_at is not null and s.id is not null)
    )
    select o.id as order_id, o.order_number, coalesce(ost.key, ast.key) as store, o.placed_at,
           coalesce(o.placed_at < fp.since, false) as before_import,
           s.id as shipment_id, s.tracking_number, case when s.id is null then null else ${db.unsafe(STAGE_SQL)} end as stage,
           (select max(e.occurred_at) from shipment_events e where e.shipment_id = s.id and e.code = '0006') as returned_at,
           c.outcome as check_in, c.checked_in_at,
           wb.outcome as wb_outcome, wb.detail->>'message' as wb_message,
           (select coalesce(sum((p->>'ahead')::int), 0) from jsonb_array_elements(coalesce(wb.detail->'products', '[]'::jsonb)) p)::int as wb_ahead,
           wb.error = 'order not found' as wb_not_found,
           o.cancelled_at is not null as cancelled, o.financial_status, o.fulfillment_status, o.return_status, o.refunded_paisa::text as refunded,
           coalesce((select sum(rl.qty) from shopify_refunds r join shopify_refund_lines rl on rl.refund_id = r.id where r.order_id = o.id and rl.restocked), 0)::int as units_restocked,
           coalesce((select sum(rl.qty) from shopify_refunds r join shopify_refund_lines rl on rl.refund_id = r.id where r.order_id = o.id and not rl.restocked), 0)::int as units_not_restocked,
           coalesce((select sum(rl.qty) from shopify_refunds r join shopify_refund_lines rl on rl.refund_id = r.id where r.order_id = o.id and rl.restock_type in ('RETURN', 'LEGACY_RESTOCK')), 0)::int as units_returned,
           (select json_agg(json_build_object('name', sr.name, 'status', sr.status) order by sr.id) from shopify_returns sr where sr.order_id = o.id) as returns
    from pairs pr
    left join shipments s on s.id = pr.shipment_id
    left join orders o on o.id = coalesce(pr.order_id, s.order_id)
    left join stores ost on ost.id = o.store_id
    left join postex_accounts a on a.id = s.postex_account_id
    left join stores ast on ast.id = a.store_id
    left join first_parcel fp on fp.store_id = coalesce(o.store_id, a.store_id)
    left join return_check_ins c on c.shipment_id = s.id
    left join lateral (
      select w.outcome, w.detail, w.error from shopify_writebacks w where w.check_in_id = c.id order by w.at desc, w.id desc limit 1
    ) wb on true
    where true ${f.store ? db`and coalesce(ost.key, ast.key) = ${f.store}` : db``}
    order by coalesce((select max(e.occurred_at) from shipment_events e where e.shipment_id = s.id), o.placed_at) desc nulls last, s.id desc nulls last, o.id desc
    limit 2000
  `;
  const all = rows.map((r): ReturnsReconciliationRow => {
    const facts: ReturnFacts = {
      orderId: r.order_id,
      orderNumber: r.order_number,
      store: r.store,
      placedAt: r.placed_at,
      beforeImport: r.before_import,
      shipmentId: r.shipment_id,
      trackingNumber: r.tracking_number,
      stage: r.stage,
      returnedAt: r.returned_at,
      checkIn: r.check_in,
      checkedInAt: r.checked_in_at,
      restock: r.wb_outcome ? { outcome: r.wb_outcome, message: r.wb_message ?? '', ahead: r.wb_ahead ?? 0, notFound: r.wb_not_found === true } : null,
      shopify: r.order_id
        ? {
            cancelled: r.cancelled === true,
            financialStatus: r.financial_status,
            fulfillmentStatus: r.fulfillment_status,
            returnStatus: r.return_status,
            refundedPaisa: r.refunded ?? '0',
            unitsRestocked: r.units_restocked,
            unitsNotRestocked: r.units_not_restocked,
            unitsReturned: r.units_returned,
            returns: r.returns ?? [],
          }
        : null,
    };
    return { ...facts, issues: returnIssues(facts, now) };
  });
  const needsSomeone = (r: ReturnsReconciliationRow) => r.issues.some((i) => i.severity !== 'info');
  const counts: Record<string, number> = { rows: all.length, withIssues: all.filter(needsSomeone).length };
  for (const row of all) for (const issue of row.issues) counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
  const shown = all.filter((r) => (f.onlyIssues === false || needsSomeone(r)) && (!f.kind || r.issues.some((i) => i.kind === f.kind)));
  return { rows: shown.slice(0, f.limit ?? 500), counts };
};
