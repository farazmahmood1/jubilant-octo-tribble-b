import { Router } from 'express';
import { z } from 'zod';

import { AccountError, createUser, listUsers, resetPassword, resetTotp, updateUser } from '../../auth/accounts.js';
import { PERMISSIONS, ROLES, ROLE_LABELS, ROLE_PERMISSIONS } from '../../auth/permissions.js';
import { HttpError } from '../middleware/errors.js';
import { type SqlProvider, requireSql, sessionUser } from '../middleware/database.js';
import { ID, parse } from '../validate.js';

/**
 * User management, for those who hold `users.manage` (the owner): the accounts, their roles, their
 * passwords and their authenticators, and the matrix of what each role may do. Every change is
 * audited with the owner who made it. Passwords, hashes and secrets are never in a response.
 */

const role = z.enum(ROLES);
const email = z.string().trim().toLowerCase().email().max(200);
const name = z.string().trim().min(1).max(120);
const idParams = z.object({ id: z.string().regex(ID) });
const create = z.object({ email, name, role, password: z.string().min(1).max(200) });
const patch = z
  .object({ name: name.optional(), role: role.optional(), isActive: z.boolean().optional() })
  .refine((v) => v.name !== undefined || v.role !== undefined || v.isActive !== undefined, { message: 'Nothing to change' });
const password = z.object({ password: z.string().min(1).max(200) });

const asHttp = (error: unknown): never => {
  if (error instanceof AccountError) throw new HttpError(error.status, error.message, undefined, error.code);
  throw error;
};

export const usersRouter = (getSql: SqlProvider): Router => {
  const router = Router();

  router.get('/users', async (_req, res) => {
    res.json({ users: await listUsers(requireSql(getSql)) });
  });

  /** The matrix itself: what each role may do. The same data the server enforces. */
  router.get('/users/roles', (_req, res) => {
    res.json({ roles: ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r], permissions: ROLE_PERMISSIONS[r] })), permissions: PERMISSIONS });
  });

  router.post('/users', async (req, res) => {
    const body = parse(create, req.body);
    const id = await createUser(requireSql(getSql), sessionUser(req), body).catch(asHttp);
    res.status(201).json({ id });
  });

  router.patch('/users/:id', async (req, res) => {
    const { id } = parse(idParams, req.params);
    await updateUser(requireSql(getSql), sessionUser(req), id, parse(patch, req.body)).catch(asHttp);
    res.json({ id });
  });

  router.post('/users/:id/password', async (req, res) => {
    const { id } = parse(idParams, req.params);
    await resetPassword(requireSql(getSql), sessionUser(req), id, parse(password, req.body).password).catch(asHttp);
    res.json({ id });
  });

  router.post('/users/:id/reset-totp', async (req, res) => {
    const { id } = parse(idParams, req.params);
    await resetTotp(requireSql(getSql), sessionUser(req), id).catch(asHttp);
    res.json({ id });
  });

  return router;
};
