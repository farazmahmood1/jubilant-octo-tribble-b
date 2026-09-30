import { randomBytes } from 'node:crypto';

import postgres from 'postgres';

import type { Sql } from '../db.js';
import { sslOptions } from '../db.js';

const url = process.env['DATABASE_URL_TEST']?.trim() || undefined;

/**
 * Database tests run only against a scratch Postgres named in DATABASE_URL_TEST, and are skipped
 * (with this reason) when it is not set, so `npm test` still works without one.
 */
export const skipWithoutDb: string | false = url ? false : 'DATABASE_URL_TEST is not set';

export interface TestSchema {
  sql: Sql;
  name: string;
  drop: () => Promise<void>;
}

/**
 * A fresh, empty schema on the test database, with a client whose search_path points at it.
 * Each test gets its own, so migrations can be applied from scratch and test files can run in
 * parallel without seeing each other's tables.
 */
export const createTestSchema = async (): Promise<TestSchema> => {
  if (!url) throw new Error('DATABASE_URL_TEST is not set');
  // Tests create and drop schemas. Neon is where the real data lives, so it is never a target.
  if (/\.neon\.tech$/i.test(new URL(url).hostname)) {
    throw new Error('DATABASE_URL_TEST points at Neon; use a scratch Postgres instead');
  }

  const name = `test_${randomBytes(6).toString('hex')}`;
  const options = { ...sslOptions(url), max: 1, onnotice: () => {} };
  const admin = postgres(url, options);
  await admin`create schema ${admin(name)}`;
  const sql = postgres(url, { ...options, max: 4, connection: { search_path: name } }) as unknown as Sql;

  return {
    sql,
    name,
    drop: async () => {
      await sql.end({ timeout: 5 });
      await admin`drop schema ${admin(name)} cascade`;
      await admin.end({ timeout: 5 });
    },
  };
};
