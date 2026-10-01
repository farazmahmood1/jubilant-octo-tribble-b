import type { Sql } from '../db.js';
import { openReviewItem, resolveOpenReviewItem } from '../db/repos/review.js';
import { readPaisa } from '../db/repos/upsert.js';
import type { ConfirmationState } from '../domain/order-state.js';
import {
  type Finding,
  ORDER_RULE_KINDS,
  type OrderFacts,
  type ParcelFacts,
  RULE_KINDS,
  type SiblingFacts,
  evaluate,
  evaluateOrder,
} from '../domain/reconciliation.js';
import type { Logger } from '../logger.js';
import type { JobDefinition, JobStats } from './runner.js';

export const RECONCILIATION_JOB = 'reconciliation:scan';
export const DEFAULT_STUCK_DAYS = 7;
export const DEFAULT_CONFIRMED_NOT_BOOKED_HOURS = 24;
export const DEFAULT_CONFIRMED_LOOKBACK_DAYS = 30;

export interface ScanDeps {
  sql: Sql;
  logger: Logger;
  now?: () => Date;
}

interface Row {
  id: string;
  account: string;
  store_id: string | null;
  tracking_number: string;
  order_ref_number: string | null;
  order_id: string | null;
  cod: string | null;
  status_code: string | null;
  booked_at: Date | null;
  status_updated_at: Date | null;
  order_number: string | null;
  order_total: string | null;
  financial_status: string | null;
  channel: OrderFacts['channel'] | null;
  codes: string[];
}

const refKey = (account: string, ref: string | null): string | null => (ref?.trim() ? `${account}:${ref.trim().toUpperCase()}` : null);

/**
 * `reconciliation:scan`: evaluates the five parcel rules over every parcel and the desk's two
 * order rules over every confirmed-but-unbooked or cancelled-but-booked order, and keeps the
 * queue equal to what they find.
 * - A finding with no open item opens one, unless a person already resolved or ignored that
 *   problem (it stays decided).
 * - A finding with an open item refreshes its detail; except an unmatched parcel's, whose detail
 *   (the matcher's reason) belongs to the matcher.
 * - An open item of these kinds with no finding any more is closed by the system, and audited.
 * Running it twice changes nothing the second time.
 */
export const scanReconciliation = async (deps: ScanDeps): Promise<JobStats> => {
  const now = (deps.now ?? (() => new Date()))();
  const [alerts] = await deps.sql<{ value: { stuckDays?: number; confirmedNotBookedHours?: number; confirmedLookbackDays?: number } }[]>`
    select value from app_settings where key = 'alerts'
  `;
  const stuckDays = alerts?.value.stuckDays ?? DEFAULT_STUCK_DAYS;

  const rows = await deps.sql<Row[]>`
    select s.id, a.key as account, a.store_id, s.tracking_number, s.order_ref_number, s.order_id, s.cod_amount_paisa::text as cod,
           s.status_code, s.booked_at, s.status_updated_at,
           o.order_number, o.total_paisa::text as order_total, o.financial_status,
           case when shipment_is_pr(s.id) then 'pr' else o.channel end as channel,
           coalesce((select array_agg(distinct e.code order by e.code) from shipment_events e where e.shipment_id = s.id), '{}') as codes
    from shipments s
    join postex_accounts a on a.id = s.postex_account_id
    left join orders o on o.id = s.order_id
    order by s.id
  `;

  // Parcels grouped for the duplicate rule: by order when linked, by reference when not.
  const byOrder = new Map<string, SiblingFacts[]>();
  const byRef = new Map<string, SiblingFacts[]>();
  for (const row of rows) {
    const sibling = { id: row.id, trackingNumber: row.tracking_number, statusCode: row.status_code };
    const key = row.order_id ?? refKey(row.account, row.order_ref_number);
    const groups = row.order_id ? byOrder : byRef;
    if (key) groups.set(key, [...(groups.get(key) ?? []), sibling]);
  }

  const findings = new Map<string, { finding: Finding; storeId: string | null; shipmentId: string | null; orderId: string | null }>();
  for (const row of rows) {
    const parcel: ParcelFacts = {
      id: row.id,
      accountKey: row.account,
      trackingNumber: row.tracking_number,
      orderRefNumber: row.order_ref_number,
      orderId: row.order_id,
      codAmount: row.cod === null ? null : readPaisa(row.cod),
      statusCode: row.status_code,
      bookedAt: row.booked_at,
      statusUpdatedAt: row.status_updated_at,
    };
    const order: OrderFacts | null =
      row.order_id && row.order_number && row.order_total && row.channel
        ? { id: row.order_id, orderNumber: row.order_number, totalPaisa: readPaisa(row.order_total), financialStatus: row.financial_status, channel: row.channel }
        : null;
    const groupKey = row.order_id ?? refKey(row.account, row.order_ref_number);
    const siblings = (groupKey ? (row.order_id ? byOrder : byRef).get(groupKey) : undefined) ?? [];
    for (const finding of evaluate({ parcel, order, events: row.codes.map((code) => ({ code })), siblings, now, stuckDays })) {
      if (findings.has(finding.dedupeKey)) continue;
      // An unknown code or a duplicate group concerns more than one parcel: no single shipment.
      const perParcel = finding.kind !== 'postex_unknown_status' && finding.kind !== 'possible_duplicate_booking';
      findings.set(finding.dedupeKey, { finding, storeId: row.store_id, shipmentId: perParcel ? row.id : null, orderId: row.order_id });
    }
  }

  // The desk's alerts: only orders that could raise one are read.
  const orders = await deps.sql<
    {
      id: string; store_id: string; order_number: string; placed_at: Date; cancelled_at: Date | null; fulfillment_status: string | null;
      state: ConfirmationState | null; confirmed_at: Date | null; parcels: Array<{ id: string; trackingNumber: string; statusCode: string | null }>;
    }[]
  >`
    select o.id, o.store_id, o.order_number, o.placed_at, o.cancelled_at, o.fulfillment_status, c.state,
           coalesce(c.confirmed_at, (select min(l.at) from order_state_log l where l.order_id = o.id and l.to_state in ('confirmed', 'ready_to_book'))) as confirmed_at,
           coalesce((select json_agg(json_build_object('id', s.id::text, 'trackingNumber', s.tracking_number, 'statusCode', s.status_code) order by s.id)
                     from shipments s where s.order_id = o.id), '[]') as parcels
    from orders o left join confirmations c on c.order_id = o.id
    where o.channel = 'online'
      and ((c.state in ('confirmed', 'changed') and o.cancelled_at is null and not exists (select 1 from shipments s where s.order_id = o.id))
           or ((o.cancelled_at is not null or c.state = 'cancelled') and exists (select 1 from shipments s where s.order_id = o.id)))
    order by o.id
  `;
  const orderRules = {
    now,
    confirmedNotBookedHours: alerts?.value.confirmedNotBookedHours ?? DEFAULT_CONFIRMED_NOT_BOOKED_HOURS,
    lookbackDays: alerts?.value.confirmedLookbackDays ?? DEFAULT_CONFIRMED_LOOKBACK_DAYS,
  };
  for (const o of orders) {
    const order = {
      id: o.id,
      orderNumber: o.order_number,
      placedAt: o.placed_at,
      confirmation: o.state,
      confirmedAt: o.confirmed_at,
      cancelledInShopify: o.cancelled_at !== null,
      onHold: o.fulfillment_status === 'on_hold',
      parcels: o.parcels,
    };
    for (const finding of evaluateOrder({ order, ...orderRules })) {
      const shipmentId = finding.kind === 'cancelled_but_booked' ? (o.parcels.find((p) => p.statusCode !== '0002')?.id ?? null) : null;
      findings.set(finding.dedupeKey, { finding, storeId: o.store_id, shipmentId, orderId: o.id });
    }
  }

  const open = await deps.sql<{ dedupe_key: string; kind: string }[]>`
    select dedupe_key, kind from reconciliation_items where status = 'open' and kind = any(${[...RULE_KINDS, ...ORDER_RULE_KINDS]}::text[])
  `;
  const openKeys = new Set(open.map((o) => o.dedupe_key));

  const stats: JobStats = { parcels: rows.length, orders: orders.length, opened: 0, refreshed: 0, suppressed: 0, closed: 0 };
  const bump = (key: string) => void (stats[key] = (Number(stats[key]) || 0) + 1);
  for (const [key, { finding, storeId, shipmentId, orderId }] of findings) {
    bump(`found.${finding.kind}`);
    if (openKeys.has(key)) {
      if (finding.kind === 'unmatched_shipment') continue;
      await openReviewItem(deps.sql, { kind: finding.kind, dedupeKey: key, severity: finding.severity, storeId, shipmentId, orderId, detail: finding.detail });
      bump('refreshed');
      continue;
    }
    const id = await openReviewItem(deps.sql, { kind: finding.kind, dedupeKey: key, severity: finding.severity, storeId, shipmentId, orderId, detail: finding.detail });
    bump(id ? 'opened' : 'suppressed');
  }
  for (const item of open) {
    if (findings.has(item.dedupe_key)) continue;
    if (await resolveOpenReviewItem(deps.sql, item.dedupe_key, 'No longer found by the reconciliation scan')) bump('closed');
  }
  deps.logger.info({ ...stats }, 'Reconciliation scan finished');
  return stats;
};

export const reconciliationJob: JobDefinition = {
  name: RECONCILIATION_JOB,
  // Hourly, on the hour with the other hourly jobs (risk R3). Parcels move by the hour at most.
  schedule: { everyMs: 60 * 60 * 1000, alignToClock: true },
  handler: async ({ sql, logger }) => scanReconciliation({ sql, logger }),
};
