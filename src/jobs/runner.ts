import type { Sql } from '../db.js';
import { formatKarachi } from '../lib/time.js';
import type { Logger } from '../logger.js';

/** Counters a job reports: rows seen, inserted, changed, parcels polled, and so on. */
export type JobStats = Record<string, number | string | boolean>;

export interface JobContext {
  sql: Sql;
  logger: Logger;
  /**
   * The run's stats, written as the job goes. Whatever is here when the job throws is kept on
   * the failed run, so a sync that dies at row 900 still says it got through 899.
   */
  stats: JobStats;
  /** Aborted when the worker is shutting down; long jobs should check it between batches. */
  signal: AbortSignal;
  runId: string;
  /**
   * Asks for the next run sooner (or later) than `schedule.everyMs`, e.g. every 5 minutes only
   * while parcels are out for delivery. Quiet hours still apply on top.
   */
  runAgainIn: (ms: number) => void;
}

export interface JobSchedule {
  /** Time from the end of one run to the start of the next. */
  everyMs: number;
  /** Run as soon as the scheduler starts instead of waiting one interval. Default true. */
  runOnStart?: boolean;
  /**
   * Start runs on multiples of the interval (:00, :15, :30, :45 for 15 minutes) instead of
   * `everyMs` after the last one. Jobs that share an interval then wake the database together,
   * so it can sleep in between (risk R3).
   */
  alignToClock?: boolean;
  /**
   * Overnight in Karachi, run at most this often. `fromHour` to `toHour` may wrap midnight
   * (23 to 8). Keeps Neon's scale-to-zero compute within budget (proposal §10).
   */
  quiet?: { fromHour: number; toHour: number; everyMs: number };
}

export interface JobDefinition {
  /** Unique, e.g. `postex.shipments.track`. */
  name: string;
  /** The store or PostEx account the job covers, recorded in sync_runs. Defaults to `all`. */
  accountRef?: string;
  schedule: JobSchedule;
  /** May return stats; they are merged over `ctx.stats`. */
  handler: (ctx: JobContext) => Promise<JobStats | void>;
}

export type RunStatus = 'succeeded' | 'failed' | 'skipped';

export interface RunResult {
  job: string;
  accountRef: string;
  status: RunStatus;
  /** The sync_runs row, or null when the run was skipped or the row could not be written. */
  runId: string | null;
  stats: JobStats;
  error?: string;
  durationMs: number;
  /** What the run asked for through `ctx.runAgainIn`, if anything. */
  nextRunInMs?: number;
}

const inQuietHours = (quiet: NonNullable<JobSchedule['quiet']>, now: Date): boolean => {
  const hour = Number(formatKarachi(now).slice(11, 13));
  return quiet.fromHour <= quiet.toHour ? hour >= quiet.fromHour && hour < quiet.toHour : hour >= quiet.fromHour || hour < quiet.toHour;
};

/**
 * How long to wait before a job's next run: the run's own request or the schedule's interval,
 * stretched to the quiet-hours interval overnight, then aligned to the clock if asked.
 */
export const nextDelayMs = (schedule: JobSchedule, now: Date, requestedMs?: number): number => {
  let interval = requestedMs !== undefined && requestedMs > 0 ? requestedMs : schedule.everyMs;
  if (schedule.quiet && inQuietHours(schedule.quiet, now)) interval = Math.max(interval, schedule.quiet.everyMs);
  if (!schedule.alignToClock) return interval;
  return interval - (now.getTime() % interval);
};

/**
 * The overnight window note S4 recommends: full cadence 08:00–23:00 Karachi, hourly outside it.
 * Nobody confirms orders or books parcels overnight, so nothing is lost by polling less.
 */
export const OVERNIGHT: NonNullable<JobSchedule['quiet']> = { fromHour: 23, toHour: 8, everyMs: 60 * 60 * 1000 };

export class UnknownJobError extends Error {
  constructor(name: string, known: string[]) {
    super(`Unknown job "${name}". Known jobs: ${known.length ? known.join(', ') : '(none)'}`);
    this.name = 'UnknownJobError';
  }
}

const MAX_ERROR_LENGTH = 2_000;

/**
 * Job locks use the two-key form of Postgres advisory locks; the migration lock uses the
 * one-key form, and the two forms never conflict with each other.
 */
const LOCK_NAMESPACE = 'nur.jobs';

const errorText = (error: unknown): string => {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
};

/**
 * Runs registered jobs once or on a schedule.
 *
 * - **No overlap.** A job holds a Postgres advisory lock for the whole run, on a connection
 *   reserved for it. A second trigger, in this process or another worker, finds the lock taken
 *   and is skipped. If a process dies its connection closes and the lock frees itself.
 * - **One sync_runs row per run.** Inserted as `running` before the handler starts and finished
 *   as `succeeded` or `failed` with its stats. A skipped trigger is not a run and writes nothing.
 * - **Never crashes the worker.** A job that throws, or a database that is down, gives a
 *   `failed` result and a log line; the scheduler carries on.
 * - **Recovers interrupted runs.** A `running` row left by a process that died is closed as
 *   failed by the next run of the same job, which can only start once that process's lock is gone.
 */
export class JobRunner {
  private readonly jobs = new Map<string, JobDefinition>();
  private readonly running = new Set<string>();
  private readonly inFlight = new Set<Promise<RunResult>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly shutdown = new AbortController();
  private started = false;

  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
  ) {}

  register(job: JobDefinition): this {
    if (this.jobs.has(job.name)) throw new Error(`Job "${job.name}" is already registered`);
    if (!(job.schedule.everyMs > 0)) throw new Error(`Job "${job.name}" needs a positive schedule.everyMs`);
    this.jobs.set(job.name, job);
    return this;
  }

  get names(): string[] {
    return [...this.jobs.keys()].sort();
  }

  /** Runs one job now, once. Used by the scheduler, the `npm run job` CLI and tests. */
  async runJobOnce(name: string): Promise<RunResult> {
    const job = this.jobs.get(name);
    if (!job) throw new UnknownJobError(name, this.names);
    const run = this.execute(job);
    this.inFlight.add(run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(run);
    }
  }

  /** Starts every registered job on its schedule. Each job waits for its own run to finish first. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const job of this.jobs.values()) {
      this.schedule(job, job.schedule.runOnStart === false ? job.schedule.everyMs : 0);
    }
    this.logger.info({ jobs: this.names }, 'Scheduler started');
  }

  /** Stops scheduling, tells running jobs to wrap up, and waits for them (up to `graceMs`). */
  async stop(graceMs = 30_000): Promise<void> {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.shutdown.abort();
    if (this.inFlight.size === 0) return;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, graceMs);
      }),
    ]);
    clearTimeout(timeout);
  }

  private schedule(job: JobDefinition, delayMs: number): void {
    const timer = setTimeout(async () => {
      this.timers.delete(job.name);
      if (!this.started) return;
      const result = await this.runJobOnce(job.name);
      if (this.started) this.schedule(job, nextDelayMs(job.schedule, new Date(), result.nextRunInMs));
    }, delayMs);
    this.timers.set(job.name, timer);
  }

  private async execute(job: JobDefinition): Promise<RunResult> {
    const accountRef = job.accountRef ?? 'all';
    const startedAt = Date.now();
    const log = this.logger.child({ job: job.name, accountRef });
    const result = (status: RunStatus, extra: Partial<RunResult> = {}): RunResult => ({
      job: job.name,
      accountRef,
      status,
      runId: null,
      stats: {},
      durationMs: Date.now() - startedAt,
      ...extra,
    });

    // Cheap in-process guard first; the advisory lock below covers other processes.
    if (this.running.has(job.name)) {
      log.debug('Previous run still in progress; skipping');
      return result('skipped');
    }
    this.running.add(job.name);

    let connection: Awaited<ReturnType<Sql['reserve']>> | undefined;
    let locked = false;
    try {
      connection = await this.sql.reserve();
      const [lock] = await connection<{ locked: boolean }[]>`
        select pg_try_advisory_lock(hashtext(${LOCK_NAMESPACE}), hashtext(${`${job.name}:${accountRef}`})) as locked
      `;
      locked = lock?.locked === true;
      if (!locked) {
        log.debug('Running in another process; skipping');
        return result('skipped');
      }

      // Holding the lock means no live process is running this job, so any row still marked
      // running was left by one that died.
      await this.sql`
        update sync_runs
        set status = 'failed', finished_at = now(), error = 'interrupted: the process stopped before the run finished'
        where job = ${job.name} and account_ref = ${accountRef} and status = 'running'
      `;
      const [row] = await this.sql<{ id: string }[]>`
        insert into sync_runs (job, account_ref) values (${job.name}, ${accountRef}) returning id
      `;
      if (!row) throw new Error('sync_runs insert returned no row');
      const runId = row.id;

      const stats: JobStats = {};
      let status: RunStatus = 'succeeded';
      let error: string | undefined;
      let nextRunInMs: number | undefined;
      try {
        const returned = await job.handler({
          sql: this.sql,
          logger: log,
          stats,
          signal: this.shutdown.signal,
          runId,
          runAgainIn: (ms) => {
            nextRunInMs = ms;
          },
        });
        if (returned) Object.assign(stats, returned);
      } catch (thrown) {
        status = 'failed';
        error = errorText(thrown);
        log.error({ err: thrown, runId, stats }, 'Job failed');
      }

      await this.sql`
        update sync_runs
        set status = ${status}, finished_at = now(), stats = ${this.sql.json(stats)}, error = ${error ?? null}
        where id = ${runId}
      `;
      const finished = result(status, { runId, stats, ...(error ? { error } : {}), ...(nextRunInMs !== undefined ? { nextRunInMs } : {}) });
      if (status === 'succeeded') log.info({ runId, stats, durationMs: finished.durationMs }, 'Job finished');
      return finished;
    } catch (failure) {
      // The run could not even be recorded (database down, sync_runs missing). Say so and move on.
      log.error({ err: failure }, 'Job could not be run');
      return result('failed', { error: errorText(failure) });
    } finally {
      if (connection) {
        if (locked) {
          await connection`select pg_advisory_unlock(hashtext(${LOCK_NAMESPACE}), hashtext(${`${job.name}:${accountRef}`}))`.catch(
            (err: unknown) => log.warn({ err }, 'Could not release job lock; it frees when the connection closes'),
          );
        }
        connection.release();
      }
      this.running.delete(job.name);
    }
  }
}

/** Exit code for `npm run job`: 0 succeeded, 1 failed, 3 skipped because it is already running. */
export const exitCodeFor = (result: RunResult): number =>
  result.status === 'succeeded' ? 0 : result.status === 'skipped' ? 3 : 1;
