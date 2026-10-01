import { Router } from 'express';

import type { SqlProvider } from '../middleware/database.js';
import { requireAuth } from '../middleware/require-auth.js';
import { accountingRouter } from './accounting.js';
import { authRouter } from './auth.js';
import { confirmationsRouter } from './confirmations.js';
import { consignmentRouter } from './consignment.js';
import { healthRouter } from './health.js';
import { influencersRouter } from './influencers.js';
import { integrationsRouter } from './integrations.js';
import { orderImportRouter } from './order-import.js';
import { parcelsRouter } from './parcels.js';
import { prRouter } from './pr.js';
import { purchasingRouter } from './purchasing.js';
import { reconciliationRouter } from './reconciliation.js';
import { reportsRouter } from './reports.js';
import { settingsRouter } from './settings.js';
import { stockRouter } from './stock.js';

export const createApiRouter = (getSql: SqlProvider): Router => {
  const apiRouter = Router();

  // Public: sign-in and the health probes.
  apiRouter.use(authRouter);
  apiRouter.use(healthRouter);

  // Everything below needs a session.
  apiRouter.use(requireAuth);
  apiRouter.use(integrationsRouter);
  apiRouter.use(reconciliationRouter(getSql));
  apiRouter.use(stockRouter(getSql));
  apiRouter.use(settingsRouter(getSql));
  apiRouter.use(accountingRouter(getSql));
  apiRouter.use(confirmationsRouter(getSql));
  apiRouter.use(influencersRouter(getSql));
  apiRouter.use(reportsRouter(getSql));
  apiRouter.use(purchasingRouter(getSql));
  apiRouter.use(consignmentRouter(getSql));
  apiRouter.use(prRouter(getSql));
  apiRouter.use(orderImportRouter(getSql));
  apiRouter.use(parcelsRouter(getSql));
  return apiRouter;
};
