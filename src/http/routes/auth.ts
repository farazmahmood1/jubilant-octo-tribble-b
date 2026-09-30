import { Router } from 'express';
import { z } from 'zod';

import { createSessionToken, sessionExpiresInSeconds, verifyCredentials } from '../../auth/session.js';
import { logger } from '../../logger.js';
import { requireAuth } from '../middleware/require-auth.js';

export const authRouter: Router = Router();

const credentials = z.object({
  email: z.string().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
});

authRouter.post('/auth/login', async (req, res) => {
  const parsed = credentials.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid request' } });
    return;
  }

  const user = verifyCredentials(parsed.data.email, parsed.data.password);
  if (!user) {
    // Never say which half was wrong; that only helps someone guessing.
    logger.warn({ email: parsed.data.email, ip: req.ip }, 'Failed sign-in attempt');
    res.status(401).json({ error: { message: 'Wrong email or password' } });
    return;
  }

  res.json({ token: await createSessionToken(user), expiresIn: sessionExpiresInSeconds(), user });
});

/** Used by the dashboard on load to check whether a stored token is still valid. */
authRouter.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
