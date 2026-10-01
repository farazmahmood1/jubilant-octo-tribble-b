import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { resolveSession } from '../../auth/accounts.js';
import { can, canAny, permissionsFor, stripPhones } from '../../auth/permissions.js';
import { type AuthUser, readSessionToken } from '../../auth/session.js';
import { HttpError } from './errors.js';
import { type SqlProvider, requireSql } from './database.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

const bearerToken = (req: Request): string | undefined => {
  const header = req.header('authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) return undefined;
  return header.slice(7).trim() || undefined;
};

/**
 * Rejects the request unless it carries a valid token for an account that is still switched on, and
 * puts that account on the request as the database has it now: so a role change, or an account
 * being turned off, takes effect on the very next request.
 */
export const authenticate =
  (getSql: SqlProvider): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    const token = bearerToken(req);
    if (!token) throw new HttpError(401, 'Sign in required', undefined, 'unauthenticated');
    readSessionToken(token)
      .then(async (claims) => {
        if (!claims) throw new HttpError(401, 'Session expired, please sign in again', undefined, 'session_expired');
        const user = await resolveSession(requireSql(getSql), claims);
        if (!user) throw new HttpError(401, 'This account is switched off', undefined, 'account_disabled');
        req.user = user;
        next();
      })
      .catch(next);
  };

/**
 * Refuses a request the signed-in role is not allowed to make, by the permission table alone. A
 * route the table does not mention is refused for everyone. A session that still has to set up its
 * authenticator app can reach nothing else.
 */
export const authorize: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  const user = req.user;
  if (!user) throw new HttpError(401, 'Sign in required', undefined, 'unauthenticated');
  const needs = permissionsFor(req.method, req.path);
  if (!needs) throw new HttpError(403, 'This is not available', undefined, 'forbidden');
  if (!user.mfa) throw new HttpError(403, 'Set up your authenticator app to continue', undefined, 'totp_enrolment_required');
  if (!canAny(user.role, needs)) throw new HttpError(403, 'Your role does not allow this', { needs }, 'forbidden');
  next();
};

/**
 * Removes customers' phone numbers (and the links built from them) from every response a role
 * without `pii.phone` receives, wherever in the response they are: so a screen that was never told
 * to hide one still cannot show one. The routes may also leave them out themselves; this is the
 * guarantee underneath.
 */
export const stripPii: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const user = req.user;
  if (!user || can(user.role, 'pii.phone')) return next();
  const json = res.json.bind(res);
  res.json = (body: unknown) => json(stripPhones(body));
  next();
};
