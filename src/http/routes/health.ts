import { Router } from 'express';

import { checkDb, db } from '../../db.js';
import { type MigrationSummary, summarizeMigrations } from '../../db/migrate.js';

export const healthRouter: Router = Router();

/** Liveness: the process is up. Used by Render's health check. */
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

type MigrationReport = MigrationSummary | { status: 'not_configured' | 'error'; error?: string };

const checkMigrations = async (): Promise<MigrationReport> => {
  const sql = db();
  if (!sql) return { status: 'not_configured' };
  try {
    return await summarizeMigrations(sql);
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Readiness: the process can reach what it needs, and the schema matches the code. Pending or
 * edited migrations mean queries would hit missing or different tables, so both report 503.
 */
healthRouter.get('/ready', async (_req, res) => {
  const database = await checkDb();
  const migrations = database.status === 'ok' ? await checkMigrations() : { status: database.status };
  const ready =
    database.status !== 'error' && (migrations.status === 'ok' || migrations.status === 'not_configured');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', database, migrations });
});
