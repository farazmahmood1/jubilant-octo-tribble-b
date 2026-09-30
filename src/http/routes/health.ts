import { Router } from 'express';

import { checkDb } from '../../db.js';

export const healthRouter: Router = Router();

/** Liveness: the process is up. Used by Render's health check. */
healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

/** Readiness: the process can reach what it needs. */
healthRouter.get('/ready', async (_req, res) => {
  const database = await checkDb();
  const ready = database.status !== 'error';
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'degraded', database });
});
