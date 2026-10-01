import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Sql } from '../db.js';

/**
 * Next to this module: src/db/migrations under tsx, dist/db/migrations in the build, which
 * `npm run build` copies there so production needs neither tsx nor the source tree.
 */
export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Any fixed number works, as long as every process that migrates uses the same one. */
const LOCK_KEY = 7_236_547_365_871;

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationFile {
  version: string;
  name: string;
  file: string;
  sql: string;
  checksum: string;
}

interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
}

export type MigrationState = 'applied' | 'pending' | 'changed' | 'missing';

export interface MigrationStatus {
  version: string;
  name: string;
  state: MigrationState;
  appliedAt?: Date;
}

export const checksum = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Every `.sql` file in the directory, in version order. A misnamed or duplicate file stops the run. */
export const readMigrations = (dir: string = MIGRATIONS_DIR): MigrationFile[] => {
  if (!existsSync(dir)) throw new MigrationError(`Migrations directory not found: ${dir}`);

  const files: MigrationFile[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const match = FILE_NAME.exec(file);
    if (!match) throw new MigrationError(`Migration file name must be NNNN_name.sql: ${file}`);
    const [, version = '', name = ''] = match;
    if (files.some((f) => f.version === version)) {
      throw new MigrationError(`Two migrations share version ${version}: ${file}`);
    }
    const sql = readFileSync(resolve(dir, file), 'utf8');
    files.push({ version, name, file, sql, checksum: checksum(sql) });
  }
  return files;
};

// "if not exists" alone is not enough: two processes creating the table at once can still
// collide in the catalog, so creation takes the same lock as applying.
const ensureTable = async (sql: Sql): Promise<void> => {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
    await tx`
      create table if not exists schema_migrations (
        version     text primary key,
        name        text not null,
        checksum    text not null,
        applied_at  timestamptz not null default now(),
        duration_ms integer not null
      )
    `;
  });
};

/** Read-only: a database that has never been migrated simply has nothing applied. */
const appliedRows = async (sql: Sql): Promise<AppliedRow[]> => {
  const [table] = await sql`select to_regclass('schema_migrations') is not null as exists`;
  if (!table?.['exists']) return [];
  return sql<AppliedRow[]>`select version, name, checksum, applied_at from schema_migrations order by version`;
};

/**
 * Compares the files with what the database has applied. `changed` means a file was edited
 * after it ran, `missing` that an applied migration's file is gone; both mean the database no
 * longer matches the code, and both stop `migrate`.
 */
export const migrationStatus = async (sql: Sql, dir: string = MIGRATIONS_DIR): Promise<MigrationStatus[]> => {
  const files = readMigrations(dir);
  const applied = new Map((await appliedRows(sql)).map((row) => [row.version, row]));

  const status: MigrationStatus[] = files.map((file) => {
    const row = applied.get(file.version);
    if (!row) return { version: file.version, name: file.name, state: 'pending' };
    const state = row.checksum === file.checksum ? 'applied' : 'changed';
    return { version: file.version, name: file.name, state, appliedAt: row.applied_at };
  });
  for (const row of applied.values()) {
    if (!files.some((f) => f.version === row.version)) {
      status.push({ version: row.version, name: row.name, state: 'missing', appliedAt: row.applied_at });
    }
  }
  return status.sort((a, b) => a.version.localeCompare(b.version));
};

const assertConsistent = (status: MigrationStatus[]): void => {
  const broken = status.filter((s) => s.state === 'changed' || s.state === 'missing');
  if (broken.length === 0) return;
  const lines = broken.map((s) =>
    s.state === 'changed'
      ? `  ${s.version}_${s.name}.sql was edited after it was applied`
      : `  ${s.version}_${s.name}.sql was applied but the file is gone`,
  );
  throw new MigrationError(
    `Refusing to migrate: applied migrations no longer match their files.\n${lines.join('\n')}\n` +
      'Restore the original file and put the change in a new migration.',
  );
};

/**
 * Applies pending migrations in order, each in its own transaction with its schema_migrations
 * row, so a failing file leaves nothing behind. A transaction-scoped advisory lock serialises
 * the web service and the worker when both start at once; the applied check is repeated under
 * the lock so the second one skips what the first just did.
 */
export const migrate = async (sql: Sql, dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> => {
  await ensureTable(sql);
  assertConsistent(await migrationStatus(sql, dir));

  const applied: MigrationFile[] = [];
  for (const file of readMigrations(dir)) {
    const ran = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
      const [existing] = await tx<AppliedRow[]>`select version, name, checksum, applied_at from schema_migrations where version = ${file.version}`;
      if (existing) {
        if (existing.checksum !== file.checksum) assertConsistent([{ version: file.version, name: file.name, state: 'changed' }]);
        return false;
      }
      const startedAt = Date.now();
      try {
        await tx.unsafe(file.sql);
      } catch (error) {
        throw new MigrationError(`${file.file} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await tx`
        insert into schema_migrations (version, name, checksum, duration_ms)
        values (${file.version}, ${file.name}, ${file.checksum}, ${Date.now() - startedAt})
      `;
      return true;
    });
    if (ran) applied.push(file);
  }
  return applied;
};

export interface MigrationSummary {
  status: 'ok' | 'pending' | 'mismatch';
  applied: number;
  pending: string[];
  mismatched: string[];
}

/**
 * What `/ready` reports. `pending` means the code expects tables the database does not have
 * yet; `mismatch` means an applied file was edited or removed. Neither is safe to serve on.
 */
export const summarizeMigrations = async (sql: Sql, dir: string = MIGRATIONS_DIR): Promise<MigrationSummary> => {
  const status = await migrationStatus(sql, dir);
  const named = (state: MigrationState[]) =>
    status.filter((s) => state.includes(s.state)).map((s) => `${s.version}_${s.name}`);
  const pending = named(['pending']);
  const mismatched = named(['changed', 'missing']);
  return {
    status: mismatched.length > 0 ? 'mismatch' : pending.length > 0 ? 'pending' : 'ok',
    applied: status.filter((s) => s.state === 'applied').length,
    pending,
    mismatched,
  };
};
