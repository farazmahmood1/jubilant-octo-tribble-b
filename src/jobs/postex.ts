import { config } from '../config.js';
import type { Sql } from '../db.js';
import { getCursor, setCursor } from '../db/repos/cursors.js';
import { openReviewItem } from '../db/repos/review.js';
import {
  DEFAULT_TIERS,
  type RefreshTiers,
  dueForRefresh,
  insertEvents,
  markSynced,
  refreshDerived,
  upsertCharges,
  upsertShipment,
} from '../db/repos/shipments.js';
import { atomically } from '../db/repos/upsert.js';
import { postexClient } from '../integrations/postex/client.js';
import { toCharges, toShipment, toShipmentEvents } from '../integrations/postex/mapper.js';
import { formatKarachi } from '../lib/time.js';
import type { Logger } from '../logger.js';
import type { JobDefinition, JobStats } from './runner.js';

export const POSTEX_JOB = 'postex:sync';

/**
 * The two read calls the sync makes. `PostexClient` satisfies this; tests pass a fake. There is
 * deliberately nothing here that books, cancels or advises on a parcel (CLAUDE.md rule 1).
 */
export interface PostexSource {
  listOrders(params: { from: string; to: string }): Promise<unknown[]>;
  trackBulk(trackingNumbers: string[]): Promise<unknown[]>;
}

export interface PostexAccountTarget {
  key: string;
  id: string;
  source: PostexSource;
}

export interface PostexDeps {
  sql: Sql;
  logger: Logger;
  accounts: PostexAccountTarget[];
  signal?: AbortSignal;
  now?: () => Date;
  /** Karachi date the first listing starts from. Earlier than any account's first parcel is fine. */
  historyFrom?: string;
  tiers?: RefreshTiers;
}

export const HISTORY_FROM = '2026-01-01';
/** Listing finds new parcels; detail refreshes known ones. New parcels can wait this long to be found. */
export const LIST_EVERY_MS = 15 * 60 * 1000;
/** Re-list this many days before the last listed date: a parcel booked late in the day can land on either side. */
export const LIST_OVERLAP_DAYS = 3;
/** Days per get-all-order call, so one call never spans the whole history. */
export const LIST_CHUNK_DAYS = 31;
/** Parcels per track-bulk call: one request per second either way, so fewer, larger calls are faster. */
export const TRACK_BATCH = 25;

interface ListCursor {
  listedThrough: string;
  listedAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const karachiDate = (d: Date) => formatKarachi(d).slice(0, 10);
const addDays = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

interface Counts {
  listed: number;
  detailed: number;
  inserted: number;
  updated: number;
  changed: number;
  eventsInserted: number;
  chargesInserted: number;
  chargesChanged: number;
  skipped: number;
  notReturned: number;
  unknownCodes: number;
}

const emptyCounts = (): Counts => ({
  listed: 0,
  detailed: 0,
  inserted: 0,
  updated: 0,
  changed: 0,
  eventsInserted: 0,
  chargesInserted: 0,
  chargesChanged: 0,
  skipped: 0,
  notReturned: 0,
  unknownCodes: 0,
});

const hasHistory = (raw: unknown): boolean => {
  const parcel = (raw as Record<string, unknown> | null)?.['trackingResponse'] ?? raw;
  const history = (parcel as Record<string, unknown> | null)?.['transactionStatusHistory'];
  return Array.isArray(history) && history.length > 0;
};

/**
 * Stores one PostEx payload: the parcel, any new history steps, its charges, then the status
 * derived from everything stored. One transaction per parcel. Returns the shipment id, or null
 * if the payload had no tracking number (counted as skipped).
 */
const storeParcel = async (
  deps: PostexDeps,
  account: PostexAccountTarget,
  raw: unknown,
  counts: Counts,
  reportedCodes: Set<string>,
): Promise<string | null> => {
  let shipment;
  try {
    shipment = toShipment(raw);
  } catch (error) {
    counts.skipped++;
    deps.logger.warn({ account: account.key, err: error }, 'PostEx parcel skipped');
    return null;
  }
  const events = toShipmentEvents(raw);
  const charges = toCharges(raw);

  const id = await atomically(deps.sql, async (tx) => {
    const result = await upsertShipment(tx, account.id, shipment, raw, hasHistory(raw));
    counts[result.action]++;
    counts.eventsInserted += await insertEvents(tx, result.id, events);
    const chargeTotals = await upsertCharges(tx, result.id, charges);
    counts.chargesInserted += chargeTotals.inserted;
    counts.chargesChanged += chargeTotals.changed;
    const derivedChanged = await refreshDerived(tx, result.id);
    if (result.changed || derivedChanged || chargeTotals.changed > 0) counts.changed++;
    return result.id;
  });

  // An unknown code is reported once per code, not once per parcel: every open parcel carries the
  // booking and in-transit codes that CLAUDE.md does not list yet.
  for (const event of events) {
    if (event.known || reportedCodes.has(event.code)) continue;
    reportedCodes.add(event.code);
    counts.unknownCodes++;
    await openReviewItem(deps.sql, {
      kind: 'postex_unknown_status',
      dedupeKey: `postex_unknown_status:${event.code}`,
      severity: 'info',
      detail: { code: event.code, message: event.message, exampleTrackingNumber: shipment.trackingNumber, account: account.key },
    });
  }
  return id;
};

/**
 * Lists parcels booked since the account's cursor, in 31-day chunks, saving the cursor after each
 * chunk. Runs at most every 15 minutes; new parcels found here have never been synced, so the
 * detail pass below fetches their history in the same run.
 */
const listNew = async (deps: PostexDeps, account: PostexAccountTarget, now: Date, counts: Counts, reported: Set<string>): Promise<void> => {
  const saved = await getCursor(deps.sql, POSTEX_JOB, account.key);
  const cursor: ListCursor | null = saved ? (JSON.parse(saved) as ListCursor) : null;
  if (cursor?.listedAt && Date.parse(cursor.listedAt) > now.getTime() - LIST_EVERY_MS) return;

  const today = karachiDate(now);
  let from = cursor ? addDays(cursor.listedThrough, -LIST_OVERLAP_DAYS) : (deps.historyFrom ?? HISTORY_FROM);
  while (from <= today) {
    if (deps.signal?.aborted) return;
    const to = [addDays(from, LIST_CHUNK_DAYS - 1), today].sort()[0] ?? today;
    const rows = await account.source.listOrders({ from, to });
    for (const row of rows) {
      counts.listed++;
      await storeParcel(deps, account, row, counts, reported);
    }
    await setCursor(deps.sql, POSTEX_JOB, account.key, JSON.stringify({ listedThrough: to, listedAt: cursor?.listedAt ?? null }));
    from = addDays(to, 1);
  }
  await setCursor(deps.sql, POSTEX_JOB, account.key, JSON.stringify({ listedThrough: today, listedAt: now.toISOString() }));
};

/** Re-reads, in batches of 25, every parcel whose refresh tier says it is due. */
const refreshDue = async (deps: PostexDeps, account: PostexAccountTarget, now: Date, counts: Counts, reported: Set<string>): Promise<void> => {
  const due = await dueForRefresh(deps.sql, account.id, now, deps.tiers ?? DEFAULT_TIERS);
  for (let i = 0; i < due.length; i += TRACK_BATCH) {
    if (deps.signal?.aborted) return;
    const batch = due.slice(i, i + TRACK_BATCH);
    const parcels = await account.source.trackBulk(batch.map((p) => p.trackingNumber));
    for (const parcel of parcels) {
      counts.detailed++;
      await storeParcel(deps, account, parcel, counts, reported);
    }
    counts.notReturned += Math.max(0, batch.length - parcels.length);
    // Marked even when PostEx returned nothing for a number, so one bad number cannot be
    // re-requested every five minutes; it comes round again on its tier.
    await markSynced(deps.sql, batch.map((p) => p.id), now);
  }
};

/**
 * `postex:sync`: for each account, find new parcels, then refresh the ones that are due. Stats
 * are totals plus `<account>.<counter>`. Every write is an upsert or an insert that the unique
 * keys dedupe, so a second run adds no rows.
 */
export const syncPostex = async (deps: PostexDeps): Promise<JobStats> => {
  const now = (deps.now ?? (() => new Date()))();
  const stats: JobStats = {};
  for (const account of deps.accounts) {
    const counts = emptyCounts();
    const reported = new Set<string>();
    await listNew(deps, account, now, counts, reported);
    await refreshDue(deps, account, now, counts, reported);
    for (const [key, value] of Object.entries(counts)) {
      stats[key] = (Number(stats[key]) || 0) + value;
      stats[`${account.key}.${key}`] = value;
    }
  }
  return stats;
};

/** Configured accounts with their `postex_accounts` row. None at all is an error, not an empty success. */
export const configuredPostexAccounts = async (sql: Sql): Promise<PostexAccountTarget[]> => {
  const rows = await sql<{ id: string; key: string }[]>`
    select id, key from postex_accounts where key = any(${config.postex.accounts.map((a) => a.key)}::text[])
  `;
  const targets = config.postex.accounts.flatMap((account): PostexAccountTarget[] => {
    const row = rows.find((r) => r.key === account.key);
    if (!row) return [];
    const client = postexClient(account.key);
    return [{ key: account.key, id: row.id, source: { listOrders: (p) => client.listOrders(p), trackBulk: (n) => client.trackBulk(n) } }];
  });
  if (targets.length === 0) throw new Error('No PostEx account is ready to sync: set its token, and seed the postex_accounts table');
  return targets;
};

export const postexJob: JobDefinition = {
  name: POSTEX_JOB,
  // The fastest tier (out for delivery) is five minutes; the run itself decides what is due.
  schedule: { everyMs: 5 * 60 * 1000 },
  handler: async ({ sql, logger, signal }) => syncPostex({ sql, logger, signal, accounts: await configuredPostexAccounts(sql) }),
};
