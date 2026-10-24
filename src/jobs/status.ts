import type { Sql } from '../db.js';
import { lockDb } from '../db.js';
import type { Logger } from '../logger.js';
import { jobs } from './registry.js';
import { JobRunner, type RunResult } from './runner.js';

/**
 * How fresh the platform's copy of Shopify and PostEx is, read from `sync_runs`, and the one way
 * every host runs the syncs that are due: the worker on its timers, or, where there is no
 * long-running process (Vercel), a cron or the open dashboard calling `runDueSyncs`.
 */

export interface JobFreshness {
  name: string;
  everyMs: number;
  lastStartedAt: Date | null;
  lastSucceededAt: Date | null;
  lastStatus: 'running' | 'succeeded' | 'failed' | null;
  lastError: string | null;
  running: boolean;
}

export interface SyncStatus {
  now: Date;
  /** When each source was last read completely: Shopify's orders, PostEx's parcels. */
  shopify: { lastSyncedAt: Date | null; stale: boolean };
  postex: { lastSyncedAt: Date | null; stale: boolean };
  /** The last Shopify webhook received: null means Shopify is not sending any (none registered). */
  lastWebhookAt: Date | null;
  jobs: JobFreshness[];
}

/** A source is stale once its sync has not succeeded for this many of its intervals. */
const STALE_INTERVALS = 5;

const SHOPIFY_JOBS = ['shopify:orders', 'shopify:catchup'];
const POSTEX_JOBS = ['postex:sync'];

export const syncStatus = async (sql: Sql, now: Date = new Date()): Promise<SyncStatus> => {
  const rows = await sql<{ job: string; last_started: Date | null; last_succeeded: Date | null; last_status: JobFreshness['lastStatus']; last_error: string | null; running: boolean }[]>`
    select job,
           max(started_at) as last_started,
           max(finished_at) filter (where status = 'succeeded') as last_succeeded,
           (array_agg(status order by started_at desc))[1] as last_status,
           (array_agg(error order by started_at desc))[1] as last_error,
           coalesce(bool_or(status = 'running' and started_at > ${new Date(now.getTime() - 30 * 60_000)}), false) as running
    from sync_runs
    where started_at > ${new Date(now.getTime() - 7 * 86_400_000)}
    group by job
  `;
  const [webhook] = await sql<{ at: Date | null }[]>`select max(received_at) as at from webhook_events`;
  const freshness: JobFreshness[] = jobs.map((job) => {
    const row = rows.find((r) => r.job === job.name);
    return {
      name: job.name,
      everyMs: job.schedule.everyMs,
      lastStartedAt: row?.last_started ?? null,
      lastSucceededAt: row?.last_succeeded ?? null,
      lastStatus: row?.last_status ?? null,
      lastError: row?.last_error ?? null,
      running: row?.running ?? false,
    };
  });
  const source = (names: string[]) => {
    const own = freshness.filter((j) => names.includes(j.name));
    const last = own.map((j) => j.lastSucceededAt).filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const every = Math.min(...own.map((j) => j.everyMs));
    return { lastSyncedAt: last, stale: !last || now.getTime() - last.getTime() > every * STALE_INTERVALS };
  };
  return { now, shopify: source(SHOPIFY_JOBS), postex: source(POSTEX_JOBS), lastWebhookAt: webhook?.at ?? null, jobs: freshness };
};

/** The Shopify and PostEx syncs a person may ask for at once: everything but the daily and hourly housekeeping. */
export const ON_DEMAND = ['shopify:orders', 'shopify:catchup', 'postex:sync', 'reconciliation:scan'] as const;

/** A person asking again this soon after the last run gets the due jobs only. */
const ON_DEMAND_GAP_MS = 30 * 1000;

/**
 * Runs the jobs that are due, or (`now: true`) the on-demand syncs whatever their schedule, unless
 * one started in the last 30 seconds. Every run takes its job's lock, so a worker, a cron and the
 * dashboard calling at once never run a job twice side by side.
 */
export const runDueSyncs = async (sql: Sql, logger: Logger, options: { budgetMs: number; now?: boolean }): Promise<RunResult[]> => {
  const runner = new JobRunner(sql, logger, lockDb() ?? sql);
  for (const job of jobs) runner.register(job);
  let force: string[] = [];
  if (options.now) {
    const [recent] = await sql<{ n: number }[]>`
      select count(*)::int as n from sync_runs where job = any(${[...ON_DEMAND]}::text[]) and started_at > ${new Date(Date.now() - ON_DEMAND_GAP_MS)}
    `;
    if ((recent?.n ?? 0) === 0) force = [...ON_DEMAND];
  }
  return runner.runDue({ budgetMs: options.budgetMs, force });
};
