import type { Request } from 'express';

import type { Sql } from '../../db.js';
import { HttpError } from './errors.js';

/** How routes reach the database. The app passes the real client; tests pass a scratch schema. */
export type SqlProvider = () => Sql | null | undefined;

export const requireSql = (provider: SqlProvider): Sql => {
  const sql = provider();
  if (!sql) throw new HttpError(503, 'Database is not configured');
  return sql;
};

/** The signed-in user; `requireAuth` runs before every route that calls this. */
export const sessionUser = (req: Request) => {
  if (!req.user) throw new HttpError(401, 'Sign in required');
  return req.user;
};
