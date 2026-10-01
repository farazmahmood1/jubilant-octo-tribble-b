import { Router } from 'express';
import { z } from 'zod';

import { AccountError, changeOwnPassword, finishTotpEnrolment, login, startTotpEnrolment } from '../../auth/accounts.js';
import { ROLE_LABELS, ROLES_REQUIRING_TOTP, permissionsOf } from '../../auth/permissions.js';
import { createSessionToken, sessionExpiresInSeconds } from '../../auth/session.js';
import { logger } from '../../logger.js';
import { HttpError } from '../middleware/errors.js';
import { type SqlProvider, requireSql } from '../middleware/database.js';
import { authenticate } from '../middleware/require-auth.js';
import { parse } from '../validate.js';

/**
 * Signing in and the signed-in person's own security: who they are and what they may do, setting up
 * an authenticator app, changing their password. These routes sit outside the permission table
 * (anyone signed in may use them), and the ones for setting up the authenticator are open to a
 * session that has not finished doing so, since that is all such a session may do.
 */

const credentials = z.object({
  email: z.string().min(1, 'Email is required'),
  password: z.string().min(1, 'Password is required'),
  /** A six-digit code from the authenticator app, or a recovery code. */
  code: z.string().trim().max(32).optional(),
});
const enable = z.object({ code: z.string().trim().min(1, 'Enter the code the app shows').max(16) });
const newPassword = z.object({ current: z.string().max(200).optional(), next: z.string().min(1, 'Choose a password').max(200) });

/** An account rule that was broken is the request's fault, not the server's. */
const asHttp = (error: unknown): never => {
  if (error instanceof AccountError) throw new HttpError(error.status, error.message, undefined, error.code);
  throw error;
};

export const authRouter = (getSql: SqlProvider): Router => {
  const router = Router();
  const protect = authenticate(getSql);

  router.post('/auth/login', async (req, res) => {
    const body = parse(credentials, req.body);
    const sql = requireSql(getSql);
    const result = await login(sql, { email: body.email, password: body.password, code: body.code });

    if (!result.ok) {
      // Never say which half was wrong; that only helps someone guessing.
      if (result.reason === 'totp_required') throw new HttpError(401, 'Enter the code from your authenticator app', undefined, 'totp_required');
      if (result.reason === 'locked') {
        logger.warn({ email: body.email, ip: req.ip }, 'Sign-in refused: account locked');
        throw new HttpError(423, 'Too many wrong attempts. This account is locked for a few minutes.', { lockedUntil: result.lockedUntil }, 'locked');
      }
      logger.warn({ email: body.email, ip: req.ip, reason: result.reason }, 'Failed sign-in attempt');
      if (result.reason === 'totp_invalid') throw new HttpError(401, 'That code is not right', undefined, 'totp_invalid');
      throw new HttpError(401, 'Wrong email or password', undefined, 'invalid_credentials');
    }

    res.json({
      token: await createSessionToken(result.user, { mfa: result.mfa }),
      expiresIn: sessionExpiresInSeconds(),
      user: result.user,
      ...(result.enrolmentRequired ? { enrolmentRequired: true } : {}),
      ...(result.usedRecoveryCode ? { usedRecoveryCode: true } : {}),
    });
  });

  /**
   * Who is signed in and what they may do, as the server sees it now. The dashboard builds its
   * menus from `permissions` and asks again as it goes, so a change to a role shows up without a
   * reload.
   */
  router.get('/auth/me', protect, (req, res) => {
    const user = req.user!;
    res.json({
      user: { email: user.email, name: user.name, role: user.role },
      roleLabel: ROLE_LABELS[user.role],
      permissions: permissionsOf(user.role),
      totp: { enabled: user.totpEnabled, required: ROLES_REQUIRING_TOTP.includes(user.role) },
      // True until a role that needs an authenticator app has one: the dashboard then shows only its setup.
      enrolmentRequired: !user.mfa,
    });
  });

  /**
   * A fresh token for the current state of the account: after a role change, or after setting up
   * the authenticator. It keeps the second factor the old token had earned and takes the role and
   * name from the database.
   */
  router.post('/auth/refresh', protect, async (req, res) => {
    const user = req.user!;
    res.json({ token: await createSessionToken(user, { mfa: user.mfa }), expiresIn: sessionExpiresInSeconds() });
  });

  /** Starts setting up an authenticator app: the secret to show as a QR code. Nothing is enforced yet. */
  router.post('/auth/totp/setup', protect, async (req, res) => {
    res.json(await startTotpEnrolment(requireSql(getSql), req.user!).catch(asHttp));
  });

  /**
   * Finishes it, once the app's current code proves the QR code was read right. Answers with the
   * recovery codes (shown once) and a token that has met the second factor.
   */
  router.post('/auth/totp/enable', protect, async (req, res) => {
    const { code } = parse(enable, req.body);
    const user = req.user!;
    const { recoveryCodes } = await finishTotpEnrolment(requireSql(getSql), user, code).catch(asHttp);
    res.json({ recoveryCodes, token: await createSessionToken(user, { mfa: true }), expiresIn: sessionExpiresInSeconds() });
  });

  router.post('/auth/password', protect, async (req, res) => {
    const { current, next } = parse(newPassword, req.body);
    await changeOwnPassword(requireSql(getSql), req.user!, { current, next }).catch(asHttp);
    res.json({ ok: true });
  });

  return router;
};
