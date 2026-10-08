import { Router } from 'express';

import type { SqlProvider } from '../middleware/database.js';
import { authenticate, authorize, stripPii } from '../middleware/require-auth.js';
import { accountingRouter } from './accounting.js';
import { authRouter } from './auth.js';
import { type ConfirmationsOptions, confirmationsRouter } from './confirmations.js';
import { consignmentRouter } from './consignment.js';
import { expensesRouter } from './expenses.js';
import { healthRouter } from './health.js';
import { influencersRouter } from './influencers.js';
import { integrationsRouter } from './integrations.js';
import { orderImportRouter } from './order-import.js';
import { ordersRouter } from './orders.js';
import { parcelsRouter } from './parcels.js';
import { prRouter } from './pr.js';
import { purchasingRouter } from './purchasing.js';
import { reconciliationRouter } from './reconciliation.js';
import { reportsRouter } from './reports.js';
import { settingsRouter } from './settings.js';
import { type StockRouterOptions, stockRouter } from './stock.js';
import { usersRouter } from './users.js';

export const createApiRouter = (getSql: SqlProvider, options: { confirmations?: ConfirmationsOptions; stock?: StockRouterOptions } = {}): Router => {
  const apiRouter = Router();

  // Public: sign-in (and the signed-in person's own security, which checks its own session) and
  // the health probes.
  apiRouter.use(authRouter(getSql));
  apiRouter.use(healthRouter);

  // Everything below needs a session, then a role that the permission table says may make the
  // request, and returns no customer phone number to a role that may not see one.
  apiRouter.use(authenticate(getSql));
  apiRouter.use(authorize);
  apiRouter.use(stripPii);
  apiRouter.use(integrationsRouter);
  apiRouter.use(usersRouter(getSql));
  apiRouter.use(reconciliationRouter(getSql));
  apiRouter.use(stockRouter(getSql, options.stock));
  apiRouter.use(settingsRouter(getSql));
  apiRouter.use(accountingRouter(getSql));
  apiRouter.use(expensesRouter(getSql));
  apiRouter.use(confirmationsRouter(getSql, options.confirmations));
  apiRouter.use(influencersRouter(getSql));
  apiRouter.use(reportsRouter(getSql));
  apiRouter.use(purchasingRouter(getSql));
  apiRouter.use(consignmentRouter(getSql));
  apiRouter.use(prRouter(getSql));
  apiRouter.use(orderImportRouter(getSql));
  apiRouter.use(ordersRouter(getSql));
  apiRouter.use(parcelsRouter(getSql));
  return apiRouter;
};
