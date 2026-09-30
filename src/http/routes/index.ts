import { Router } from 'express';

import { requireAuth } from '../middleware/require-auth.js';
import { authRouter } from './auth.js';
import { healthRouter } from './health.js';
import { integrationsRouter } from './integrations.js';

export const apiRouter: Router = Router();

// Public: sign-in and the health probes.
apiRouter.use(authRouter);
apiRouter.use(healthRouter);

// Everything below needs a session.
apiRouter.use(requireAuth);
apiRouter.use(integrationsRouter);
