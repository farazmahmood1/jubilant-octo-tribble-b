import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { readSessionToken, type SessionUser } from '../../auth/session.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

const bearerToken = (req: Request): string | undefined => {
  const header = req.header('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) return undefined;
  return header.slice(7).trim() || undefined;
};

/** Rejects the request unless it carries a valid session token. */
export const requireAuth: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: { message: 'Sign in required' } });
    return;
  }
  readSessionToken(token)
    .then((user) => {
      if (!user) {
        res.status(401).json({ error: { message: 'Session expired, please sign in again' } });
        return;
      }
      req.user = user;
      next();
    })
    .catch(next);
};
