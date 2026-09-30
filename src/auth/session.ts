import { timingSafeEqual } from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';

import { config } from '../config.js';

export interface SessionUser {
  email: string;
  name: string;
  role: 'owner';
}

const secret = new TextEncoder().encode(config.auth.secret);
const ISSUER = 'nur-platform';

/** Constant-time compare so a wrong password cannot be guessed from response timing. */
const equals = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
};

/**
 * Checks the single set of credentials held in the environment.
 * Real accounts (users table, argon2 hashes, per-role permissions) replace this once the
 * database schema lands; the API shape stays the same.
 */
export const verifyCredentials = (email: string, password: string): SessionUser | undefined => {
  const emailOk = equals(email.trim().toLowerCase(), config.auth.email);
  const passwordOk = equals(password, config.auth.password);
  if (!emailOk || !passwordOk) return undefined;
  return { email: config.auth.email, name: 'NUR Organics', role: 'owner' };
};

export const createSessionToken = async (user: SessionUser): Promise<string> =>
  new SignJWT({ name: user.name, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.email)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${config.auth.sessionHours}h`)
    .sign(secret);

export const readSessionToken = async (token: string): Promise<SessionUser | undefined> => {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (!payload.sub) return undefined;
    return { email: payload.sub, name: String(payload.name ?? ''), role: 'owner' };
  } catch {
    return undefined;
  }
};

export const sessionExpiresInSeconds = (): number => config.auth.sessionHours * 3600;
