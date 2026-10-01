import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

import { type TestSchema, createTestSchema, skipWithoutDb } from '../test/db.js';
import { MIGRATIONS_DIR, MigrationError, checksum, migrate, migrationStatus, readMigrations, summarizeMigrations } from './migrate.js';

const copies: string[] = [];

/** A copy of the real migrations that a test may edit, delete from or add to. */
const copyMigrations = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nur-migrations-'));
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  copies.push(dir);
  return dir;
};

after(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
});

describe('readMigrations', () => {
  it('reads the real migrations in version order with their checksums', () => {
    const files = readMigrations();
    assert.equal(files[0]?.file, '0001_foundations.sql');
    assert.deepEqual(files.map((f) => f.version), [...files.map((f) => f.version)].sort());
    assert.equal(files[0]?.checksum, checksum(files[0]?.sql ?? ''));
  });

  it('rejects a misnamed file and a duplicate version', () => {
    const misnamed = copyMigrations();
    writeFileSync(join(misnamed, '2_oops.sql'), 'select 1;');
    assert.throws(() => readMigrations(misnamed), /must be NNNN_name\.sql: 2_oops\.sql/);

    const duplicate = copyMigrations();
    writeFileSync(join(duplicate, '0001_again.sql'), 'select 1;');
    assert.throws(() => readMigrations(duplicate), /share version 0001/);
  });
});

describe('migrate', { skip: skipWithoutDb }, () => {
  let schema: TestSchema;
  let dir: string;

  beforeEach(async () => {
    schema = await createTestSchema();
    dir = copyMigrations();
  });

  afterEach(async () => {
    await schema.drop();
  });

  it('applies each migration once; running it again applies nothing', async () => {
    const first = await migrate(schema.sql, dir);
    assert.deepEqual(first.map((f) => f.file), readMigrations(dir).map((f) => f.file));

    const second = await migrate(schema.sql, dir);
    assert.deepEqual(second, []);

    const rows = await schema.sql`select version, checksum from schema_migrations order by version`;
    assert.deepEqual(
      rows.map((r) => [r['version'], r['checksum']]),
      readMigrations(dir).map((f) => [f.version, f.checksum]),
    );
  });

  it('refuses to run when an applied file was edited, and applies nothing else', async () => {
    await migrate(schema.sql, dir);
    appendFileSync(join(dir, '0001_foundations.sql'), '\n-- edited later\n');
    writeFileSync(join(dir, '9999_next.sql'), 'create table must_not_exist (id int);');

    await assert.rejects(migrate(schema.sql, dir), (error: unknown) => {
      assert.ok(error instanceof MigrationError);
      assert.match(error.message, /Refusing to migrate/);
      assert.match(error.message, /0001_foundations\.sql was edited after it was applied/);
      return true;
    });
    const [table] = await schema.sql`select to_regclass('must_not_exist') as name`;
    assert.equal(table?.['name'], null);
  });

  it('refuses to run when an applied file is gone', async () => {
    writeFileSync(join(dir, '9998_temp.sql'), 'select 1;');
    await migrate(schema.sql, dir);
    rmSync(join(dir, '9998_temp.sql'));

    await assert.rejects(migrate(schema.sql, dir), /9998_temp\.sql was applied but the file is gone/);
  });

  it('rolls a failing file back completely and records nothing for it', async () => {
    writeFileSync(join(dir, '9997_broken.sql'), 'create table half_done (id int);\nselect * from no_such_table;');

    await assert.rejects(migrate(schema.sql, dir), /9997_broken\.sql failed: .*no_such_table/);
    const [table] = await schema.sql`select to_regclass('half_done') as name`;
    assert.equal(table?.['name'], null);
    const versions = await schema.sql`select version from schema_migrations`;
    assert.ok(!versions.some((r) => r['version'] === '9997'));
    assert.ok(versions.some((r) => r['version'] === '0001'), 'files before the broken one stay applied');
  });

  it('applies each file once when two processes migrate at the same moment', async () => {
    const [a, b] = await Promise.all([migrate(schema.sql, dir), migrate(schema.sql, dir)]);
    assert.equal(a.length + b.length, readMigrations(dir).length);
    const [count] = await schema.sql`select count(*)::int as n from schema_migrations`;
    assert.equal(count?.['n'], readMigrations(dir).length);
  });

  it('reads status without creating anything in an unmigrated database', async () => {
    await migrationStatus(schema.sql, dir);
    const [table] = await schema.sql`select to_regclass('schema_migrations') as name`;
    assert.equal(table?.['name'], null);
  });

  it('summarises for /ready: pending, then ok, then mismatch', async () => {
    assert.deepEqual(await summarizeMigrations(schema.sql, dir), {
      status: 'pending',
      applied: 0,
      pending: ['0001_foundations'],
      mismatched: [],
    });
    await migrate(schema.sql, dir);
    assert.deepEqual(await summarizeMigrations(schema.sql, dir), { status: 'ok', applied: 1, pending: [], mismatched: [] });
    appendFileSync(join(dir, '0001_foundations.sql'), '\n-- edited\n');
    assert.deepEqual(await summarizeMigrations(schema.sql, dir), {
      status: 'mismatch',
      applied: 0,
      pending: [],
      mismatched: ['0001_foundations'],
    });
  });

  it('reports pending, applied and changed in status without changing anything', async () => {
    assert.deepEqual((await migrationStatus(schema.sql, dir)).map((s) => s.state), ['pending']);
    await migrate(schema.sql, dir);
    assert.deepEqual((await migrationStatus(schema.sql, dir)).map((s) => s.state), ['applied']);
    appendFileSync(join(dir, '0001_foundations.sql'), '\n-- edited\n');
    assert.deepEqual((await migrationStatus(schema.sql, dir)).map((s) => s.state), ['changed']);
  });
});
