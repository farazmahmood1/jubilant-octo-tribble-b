import type { Sql } from '../../db.js';
import { type Paisa, paisa } from '../../lib/money.js';

/**
 * A client or an open transaction (typed as a client): repos work inside a caller's transaction
 * as well as alone. `atomically` tells the two apart at run time.
 */
export type Db = Sql;

/**
 * What an upsert did. `action` says whether the row existed; `changed` says whether anything in
 * it differs from before. Re-syncing an identical payload is `updated` with `changed: false`, so
 * sync stats can say "1,000 seen, 3 changed" instead of "1,000 updated".
 */
export interface UpsertResult {
  id: string;
  action: 'inserted' | 'updated';
  changed: boolean;
}

export interface UpsertTally {
  inserted: number;
  updated: number;
  changed: number;
}

export const toUpsertResult = (row: { id: string; inserted: boolean; changed: boolean } | undefined): UpsertResult => {
  if (!row) throw new Error('Upsert returned no row');
  return { id: String(row.id), action: row.inserted ? 'inserted' : 'updated', changed: row.inserted || row.changed };
};

export const tally = (results: Iterable<UpsertResult>): UpsertTally => {
  const total: UpsertTally = { inserted: 0, updated: 0, changed: 0 };
  for (const result of results) {
    total[result.action === 'inserted' ? 'inserted' : 'updated']++;
    if (result.changed) total.changed++;
  }
  return total;
};

/**
 * Runs `work` atomically whether `db` is a client (new transaction) or already a transaction
 * (savepoint), so a repo function can be called on its own or as part of a larger sync step.
 */
export const atomically = async <T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> => {
  const maybeTx = db as Db & { savepoint?: (fn: (tx: unknown) => Promise<T>) => Promise<T> };
  if (typeof maybeTx.savepoint === 'function') return maybeTx.savepoint((tx) => work(tx as Db));
  return (await db.begin((tx) => work(tx as unknown as Db))) as T;
};

/**
 * A bigint (an external id, or Paisa) as a query parameter. postgres.js sends strings untyped, so
 * Postgres reads them as the column's bigint exactly; a JS number would lose precision above 2^53.
 */
export const big = <T extends bigint | null>(value: T): T extends bigint ? string : string | null =>
  (value === null ? null : value.toString()) as T extends bigint ? string : string | null;

/** postgres.js returns bigint columns as strings; money is read back as exact Paisa. */
export const readPaisa = (value: string | number | bigint): Paisa => paisa(BigInt(value));

export const readBigint = (value: string | number | bigint): bigint => BigInt(value);

/** Empty and whitespace-only strings are stored as null, so "no SKU" has one spelling. */
export const blankToNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};
