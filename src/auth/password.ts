import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing: argon2id, from Node's own `crypto` (no dependency), with the parameters written
 * down here and recorded in every hash so they can be raised later without breaking old ones.
 *
 * - **argon2id**: resists both GPU cracking and side-channel attacks (RFC 9106's recommendation).
 * - **memory 64 MiB, 3 passes, 1 lane**: above OWASP's minimum (19 MiB, 2 passes) and RFC 9106's
 *   second recommended set (64 MiB, 3 passes), and about 0.1–0.2 s on a small server, which a
 *   person signing in never notices and an attacker guessing millions of passwords does.
 * - **16-byte random salt, 32-byte tag**: the sizes RFC 9106 recommends.
 *
 * The stored form is the standard PHC string, `$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>`, so
 * `verifyPassword` reads the parameters from the hash itself and a hash made with older, weaker
 * parameters still verifies; `needsRehash` says when to upgrade it at the next sign-in.
 */
export interface Argon2Params {
  /** Memory in KiB. */
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
  saltLength: number;
}

export const ARGON2_PARAMS: Argon2Params = { memory: 65_536, passes: 3, parallelism: 1, tagLength: 32, saltLength: 16 };

const derive = promisify(argon2) as (algorithm: 'argon2id', parameters: { message: Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number }) => Promise<Buffer>;

const b64 = (buffer: Buffer): string => buffer.toString('base64').replace(/=+$/, '');
const fromB64 = (text: string): Buffer => Buffer.from(text, 'base64');

export const MIN_PASSWORD_LENGTH = 12;

/** Why a password is not acceptable, or null. Length is what counts; no composition rules (NIST 800-63B). */
export const passwordProblem = (password: string): string | null => {
  if ([...password].length < MIN_PASSWORD_LENGTH) return `A password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > 200) return 'A password can be at most 200 characters';
  if (/^(.)\1+$/.test(password)) return 'A password cannot be one character repeated';
  return null;
};

export const hashPassword = async (password: string, params: Argon2Params = ARGON2_PARAMS): Promise<string> => {
  const salt = randomBytes(params.saltLength);
  const tag = await derive('argon2id', { message: Buffer.from(password, 'utf8'), nonce: salt, parallelism: params.parallelism, tagLength: params.tagLength, memory: params.memory, passes: params.passes });
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`;
};

interface Parsed {
  memory: number;
  passes: number;
  parallelism: number;
  salt: Buffer;
  tag: Buffer;
}

const parse = (hash: string): Parsed | null => {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(hash);
  if (!m) return null;
  return { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]), salt: fromB64(m[4]!), tag: fromB64(m[5]!) };
};

/** Whether a password matches a stored hash, in constant time. A malformed or foreign hash never matches. */
export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const p = parse(stored);
  if (!p) return false;
  try {
    const tag = await derive('argon2id', { message: Buffer.from(password, 'utf8'), nonce: p.salt, parallelism: p.parallelism, tagLength: p.tag.length, memory: p.memory, passes: p.passes });
    return tag.length === p.tag.length && timingSafeEqual(tag, p.tag);
  } catch {
    return false;
  }
};

/** A hash made with weaker parameters than today's: replace it the next time the password is known. */
export const needsRehash = (stored: string, target: Argon2Params = ARGON2_PARAMS): boolean => {
  const p = parse(stored);
  return !p || p.memory < target.memory || p.passes < target.passes || p.parallelism !== target.parallelism || p.tag.length < target.tagLength;
};

/**
 * A hash to check a password against when the account does not exist, so signing in as a user that
 * is not there takes as long as signing in as one that is (otherwise the response time says which
 * emails have accounts). Computed once, lazily.
 */
let dummy: Promise<string> | undefined;
export const dummyHash = (): Promise<string> => (dummy ??= hashPassword(randomBytes(16).toString('hex')));
