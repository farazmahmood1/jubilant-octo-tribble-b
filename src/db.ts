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
    ...sslOptions(config.databaseUrl),
    onnotice: (notice) => logger.debug({ notice }, 'postgres notice'),
  });
  return client;
};

let lockClient: Sql | undefined;

/**
 * The same database without Neon's pooler. The pooler gives each statement whichever server
 * session is free, so a session-level advisory lock taken by one statement can be released, or
 * looked for, by another: it stays held by an idle session and the job it guards is skipped for
 * good. On the direct endpoint (no `-pooler` in the host) a reserved connection is one session.
 */
export const directUrl = (databaseUrl: string): string => {
  const { hostname } = new URL(databaseUrl);
  const direct = hostname.replace(/-pooler(?=\.)/, '');
  return direct === hostname ? databaseUrl : databaseUrl.replace(hostname, direct);
};

/** Where the job runner takes its locks: direct, one session per running job. Nothing else should use it. */
export const lockDb = (): Sql | undefined => {
  if (!config.databaseUrl) return undefined;
  const url = directUrl(config.databaseUrl);
  lockClient ??= postgres(url, {
    max: 10,
    connect_timeout: 15,
    ...sslOptions(url),
    onnotice: (notice) => logger.debug({ notice }, 'postgres notice'),
  });
  return lockClient;
};

/**
 * Neon only accepts TLS, so it is required by default. A local scratch database (the one tests
 * and migrations are tried against) has no certificate, and a URL that names its own `sslmode`
 * is left to decide. postgres.js lets an explicit `ssl` option override the URL, so the key is
 * omitted entirely in that case rather than set to undefined.
 */
export const sslOptions = (databaseUrl: string): { ssl?: 'require' | false } => {
  const url = new URL(databaseUrl);
  if (url.searchParams.has('sslmode')) return {};
  return { ssl: ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? false : 'require' };
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
  const open = [client, lockClient].filter((c): c is Sql => c !== undefined);
  client = undefined;
  lockClient = undefined;
  await Promise.all(open.map((c) => c.end({ timeout: 5 })));
};
