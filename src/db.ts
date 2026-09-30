import postgres from 'postgres';

import { config } from './config.js';
import { logger } from './logger.js';

export type Sql = postgres.Sql<Record<string, never>>;

let client: Sql | undefined;

/**
 * Lazily opens the Neon connection. Returns undefined when DATABASE_URL is not set, so the
 * service still starts and /ready reports the database as unconfigured rather than crashing.
 */
export const db = (): Sql | undefined => {
  if (!config.databaseUrl) return undefined;
  client ??= postgres(config.databaseUrl, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 15,
    ssl: 'require',
    onnotice: (notice) => logger.debug({ notice }, 'postgres notice'),
  });
  return client;
};

export type DbHealth = { status: 'ok' | 'error' | 'not_configured'; latencyMs?: number; error?: string };

export const checkDb = async (): Promise<DbHealth> => {
  const sql = db();
  if (!sql) return { status: 'not_configured' };
  const startedAt = Date.now();
  try {
    await sql`select 1`;
    return { status: 'ok', latencyMs: Date.now() - startedAt };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
};

export const closeDb = async (): Promise<void> => {
  if (!client) return;
  await client.end({ timeout: 5 });
  client = undefined;
};
