import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';
import postgres from 'postgres';

import { type Sql, sslOptions } from '../db.js';
import { migrate } from '../db/migrate.js';
import type { Logger } from '../logger.js';
import { type TestSchema, createTestDatabase, createTestSchema, skipWithoutDb } from '../test/db.js';
import { type JobDefinition, JobRunner, UnknownJobError, exitCodeFor } from './runner.js';

const silent = pino({ level: 'silent' }) as unknown as Logger;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Job names are unique per test: advisory locks are per database, and test files share one. */
const unique = (base: string) => `${base}.${randomBytes(4).toString('hex')}`;

const job = (name: string, handler: JobDefinition['handler'], everyMs = 60_000): JobDefinition => ({
  name,
  schedule: { everyMs },
  handler,
});

/** A promise and the function that settles it, for holding a job open mid-run. */
const gate = () => {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

describe('exitCodeFor', () => {
  it('maps succeeded, failed and skipped to 0, 1 and 3', () => {
    const base = { job: 'j', accountRef: 'all', runId: null, stats: {}, durationMs: 0 };
    assert.equal(exitCodeFor({ ...base, status: 'succeeded' }), 0);
    assert.equal(exitCodeFor({ ...base, status: 'failed' }), 1);
    assert.equal(exitCodeFor({ ...base, status: 'skipped' }), 3);
  });
});

describe('JobRunner', { skip: skipWithoutDb }, () => {
  let schema: TestSchema;

  before(async () => {
    schema = await createTestSchema();
    await migrate(schema.sql);
  });

  after(async () => {
    await schema?.drop();
  });

  const runsOf = (name: string) =>
    schema.sql<{ id: string; status: string; stats: Record<string, unknown>; error: string | null; finished_at: Date | null }[]>`
      select id, status, stats, error, finished_at from sync_runs where job = ${name} order by id
    `;

  it('records a successful run in exactly one sync_runs row, with its stats', async () => {
    const name = unique('ok');
    const runner = new JobRunner(schema.sql, silent).register(
      job(name, async ({ stats }) => {
        stats['seen'] = 10;
        return { changed: 3 };
      }),
    );

    const result = await runner.runJobOnce(name);
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.stats, { seen: 10, changed: 3 });

    const rows = await runsOf(name);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, result.runId);
    assert.equal(rows[0]?.status, 'succeeded');
    assert.deepEqual(rows[0]?.stats, { seen: 10, changed: 3 });
    assert.ok(rows[0]?.finished_at instanceof Date);
  });

  it('records a job that throws as failed, keeps its partial stats, and keeps working', async () => {
    const name = unique('boom');
    let calls = 0;
    const runner = new JobRunner(schema.sql, silent).register(
      job(name, async ({ stats }) => {
        calls++;
        stats['processed'] = 899;
        if (calls === 1) throw new Error('PostEx timed out at row 900');
      }),
    );

    const failed = await runner.runJobOnce(name);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error ?? '', /Error: PostEx timed out at row 900/);
    const again = await runner.runJobOnce(name);
    assert.equal(again.status, 'succeeded', 'the runner is still usable after a failure');

    const rows = await runsOf(name);
    assert.deepEqual(rows.map((r) => r.status), ['failed', 'succeeded']);
    assert.deepEqual(rows[0]?.stats, { processed: 899 });
    assert.match(rows[0]?.error ?? '', /row 900/);
  });

  it('keeps scheduling a job that throws every time, without crashing', async () => {
    const name = unique('always-fails');
    let calls = 0;
    const runner = new JobRunner(schema.sql, silent).register(
      job(name, async () => {
        calls++;
        throw new Error('still broken');
      }, 20),
    );
    runner.start();
    await sleep(250);
    await runner.stop();

    assert.ok(calls >= 3, `ran ${calls} times`);
    const rows = await runsOf(name);
    assert.equal(rows.length, calls);
    assert.ok(rows.every((r) => r.status === 'failed'));
  });

  it('skips a second trigger in the same process while the first is still running', async () => {
    const name = unique('slow-local');
    const hold = gate();
    const started = gate();
    const runner = new JobRunner(schema.sql, silent).register(
      job(name, async () => {
        started.open();
        await hold.opened;
      }),
    );

    const first = runner.runJobOnce(name);
    await started.opened;
    const second = await runner.runJobOnce(name);
    hold.open();

    assert.equal(second.status, 'skipped');
    assert.equal((await first).status, 'succeeded');
    assert.equal((await runsOf(name)).length, 1);
  });

  it('skips a trigger from another process while the job is running there', async () => {
    const name = unique('slow-shared');
    const hold = gate();
    const started = gate();
    // A second client with its own connections stands in for a second worker process.
    const url = process.env['DATABASE_URL_TEST'] ?? '';
    const otherProcess = postgres(url, { ...sslOptions(url), max: 2, onnotice: () => {}, connection: { search_path: schema.name } }) as unknown as Sql;
    try {
      const a = new JobRunner(schema.sql, silent).register(
        job(name, async () => {
          started.open();
          await hold.opened;
        }),
      );
      const b = new JobRunner(otherProcess, silent).register(job(name, async () => {}));

      const first = a.runJobOnce(name);
      await started.opened;
      const fromOther = await b.runJobOnce(name);
      hold.open();

      assert.equal(fromOther.status, 'skipped');
      assert.equal((await first).status, 'succeeded');
      assert.equal((await b.runJobOnce(name)).status, 'succeeded', 'the lock is released after the run');
      assert.equal((await runsOf(name)).length, 2);
    } finally {
      await otherProcess.end({ timeout: 5 });
    }
  });

  it('writes exactly one row per run, each with stats', async () => {
    const name = unique('counted');
    let n = 0;
    const runner = new JobRunner(schema.sql, silent).register(job(name, async () => ({ run: ++n })));
    for (let i = 0; i < 5; i++) await runner.runJobOnce(name);

    const rows = await runsOf(name);
    assert.deepEqual(rows.map((r) => r.stats), [1, 2, 3, 4, 5].map((run) => ({ run })));
    assert.ok(rows.every((r) => r.status === 'succeeded' && r.finished_at));
  });

  it('closes a run left "running" by a process that died, then runs normally', async () => {
    const name = unique('crashed');
    await schema.sql`insert into sync_runs (job, account_ref) values (${name}, 'all')`;
    const runner = new JobRunner(schema.sql, silent).register(job(name, async () => {}));

    await runner.runJobOnce(name);
    const rows = await runsOf(name);
    assert.deepEqual(rows.map((r) => r.status), ['failed', 'succeeded']);
    assert.match(rows[0]?.error ?? '', /interrupted/);
  });

  it('runs on start and then on its interval; stop waits for the run in progress', async () => {
    const name = unique('scheduled');
    let completed = 0;
    const runner = new JobRunner(schema.sql, silent).register(
      job(name, async () => {
        await sleep(15);
        completed++;
      }, 25),
    );
    runner.start();
    await sleep(200);
    await runner.stop();
    const after = completed;
    await sleep(100);

    assert.ok(after >= 3, `ran ${after} times`);
    assert.equal(completed, after, 'nothing runs after stop');
    const rows = await runsOf(name);
    assert.equal(rows.length, after);
    assert.ok(rows.every((r) => r.status === 'succeeded'), 'no run left running');
  });

  it('aborts the signal on stop, so a long job can finish cleanly', async () => {
    const name = unique('long');
    const runner = new JobRunner(schema.sql, silent).register(
      job(name, async ({ signal, stats }) => {
        let batches = 0;
        while (!signal.aborted && batches < 1_000) {
          await sleep(5);
          batches++;
        }
        stats['batches'] = batches;
      }),
    );
    runner.start();
    await sleep(60);
    await runner.stop();

    const [row] = await runsOf(name);
    assert.equal(row?.status, 'succeeded');
    assert.ok(Number(row?.stats['batches']) < 1_000, 'the job stopped early');
  });

  it('reports a database it cannot record to as a failed run, not an exception', async () => {
    const bare = await createTestSchema();
    try {
      const name = unique('no-table');
      const result = await new JobRunner(bare.sql, silent).register(job(name, async () => {})).runJobOnce(name);
      assert.equal(result.status, 'failed');
      assert.equal(result.runId, null);
      assert.match(result.error ?? '', /sync_runs/);
    } finally {
      await bare.drop();
    }
  });

  it('refuses unknown jobs, duplicate names and a non-positive schedule', async () => {
    const runner = new JobRunner(schema.sql, silent).register(job('dup', async () => {}));
    await assert.rejects(runner.runJobOnce('nope'), UnknownJobError);
    assert.throws(() => runner.register(job('dup', async () => {})), /already registered/);
    assert.throws(() => runner.register(job('zero', async () => {}, 0)), /positive/);
  });
});

describe('npm run job CLI', { skip: skipWithoutDb }, () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const cli = (databaseUrl: string, ...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', 'src/scripts/job.ts', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl, LOG_LEVEL: 'fatal', NODE_ENV: 'test' },
      timeout: 60_000,
    });

  let migrated: Awaited<ReturnType<typeof createTestDatabase>>;
  let empty: Awaited<ReturnType<typeof createTestDatabase>>;

  before(async () => {
    migrated = await createTestDatabase();
    empty = await createTestDatabase();
    const sql = postgres(migrated.url, { ...sslOptions(migrated.url), max: 1, onnotice: () => {} }) as unknown as Sql;
    await migrate(sql);
    await sql.end({ timeout: 5 });
  });

  after(async () => {
    await migrated?.drop();
    await empty?.drop();
  });

  it('exits 0 and records the run when the job succeeds', async () => {
    const result = cli(migrated.url, 'system.heartbeat');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /system\.heartbeat \(all\): succeeded/);
    const sql = postgres(migrated.url, { ...sslOptions(migrated.url), max: 1 });
    const rows = await sql`select status from sync_runs where job = 'system.heartbeat'`;
    await sql.end({ timeout: 5 });
    assert.deepEqual(rows.map((r) => r['status']), ['succeeded']);
  });

  it('exits 1 when the run fails', () => {
    const result = cli(empty.url, 'system.heartbeat');
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /failed/);
  });

  it('exits 2 for an unknown job, or no job name, and lists the jobs', () => {
    const unknown = cli(migrated.url, 'no.such.job');
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Unknown job "no\.such\.job"\. Known jobs: .*system\.heartbeat/);
    const missing = cli(migrated.url);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /Usage: npm run job -- <name>/);
  });

  it('exits 3 when the job is already running elsewhere', async () => {
    const sql = postgres(migrated.url, { ...sslOptions(migrated.url), max: 1 });
    const holder = await sql.reserve();
    try {
      await holder`select pg_advisory_lock(hashtext('nur.jobs'), hashtext('system.heartbeat:all'))`;
      const result = cli(migrated.url, 'system.heartbeat');
      assert.equal(result.status, 3, result.stdout + result.stderr);
      assert.match(result.stdout, /skipped/);
    } finally {
      holder.release();
      await sql.end({ timeout: 5 });
    }
  });
});
