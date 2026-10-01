import { timingSafeEqual } from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';

import { config } from '../config.js';
import { type Role, isRole } from './permissions.js';

/** Who a token says is signed in. The database, not the token, says what that person may do now. */
export interface SessionUser {
  email: string;
  name: string;
  role: Role;
}

/** A signed-in person as every request sees them, resolved from the database on each request. */
export interface AuthUser extends SessionUser {
  id: string;
  /**
   * Whether this session has met its second-factor requirement. False for an owner or manager who
   * has not set up an authenticator app yet: such a session can reach nothing but the screens to set one up.
   */
  mfa: boolean;
  totpEnabled: boolean;
}

export interface TokenClaims extends SessionUser {
  mfa: boolean;
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
 * The bootstrap sign-in: the one account in the environment, for the very first start, before any
 * real account has a password. `accounts.login` only consults it while no active owner has one;
 * after that it is refused, whatever the environment says.
 */
export const matchesBootstrapCredentials = (email: string, password: string): boolean =>
  equals(email.trim().toLowerCase(), config.auth.email) && equals(password, config.auth.password);

export const BOOTSTRAP_NAME = 'NUR Organics';

/**
 * A signed session token. `mfa` is whether the second factor was satisfied when it was issued; a
 * token made without saying so is a fully authenticated one (the sign-in route is what decides).
 */
export const createSessionToken = async (user: SessionUser, options: { mfa?: boolean } = {}): Promise<string> =>
  new SignJWT({ name: user.name, role: user.role, mfa: options.mfa ?? true })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.email)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${config.auth.sessionHours}h`)
    .sign(secret);

export const readSessionToken = async (token: string): Promise<TokenClaims | undefined> => {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (!payload.sub || !isRole(payload.role)) return undefined;
    return { email: payload.sub, name: String(payload.name ?? ''), role: payload.role, mfa: payload.mfa !== false };
  } catch {
    return undefined;
  }
};

export const sessionExpiresInSeconds = (): number => config.auth.sessionHours * 3600;
