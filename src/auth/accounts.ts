import { config } from '../config.js';
import { atomically, type Db } from '../db/repos/upsert.js';
import { type AuthUser, BOOTSTRAP_NAME, type SessionUser, type TokenClaims, matchesBootstrapCredentials } from './session.js';
import { type Role, ROLES_REQUIRING_TOTP, SECOND_FACTOR_ENFORCED, isRole } from './permissions.js';
import { dummyHash, hashPassword, needsRehash, passwordProblem, verifyPassword } from './password.js';
import { generateRecoveryCodes, generateSecret, hashRecoveryCode, looksLikeRecoveryCode, openSecret, otpauthUri, sealSecret, stepOf, verifyCode } from './totp.js';

/**
 * Accounts: signing in, the second factor, and who the person making a request is right now. The
 * database is the authority on all of it; a token only says who signed in, never what they may do.
 * Every change to an account is audited with who made it (rule 8), and no secret, hash or code is
 * ever written to the audit log.
 */

export class AccountError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 423,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

/** Five wrong passwords or codes lock an account for fifteen minutes. */
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;
export const ISSUER = 'NUR Organics';

const requiresTotp = (role: Role): boolean => ROLES_REQUIRING_TOTP.includes(role);

const audit = (db: Db, actorId: string | null, action: string, entityId: string, before: unknown, after: unknown) =>
  db`
    insert into audit_log (actor_id, action, entity, entity_id, before, after)
    values (${actorId}, ${action}, 'users', ${entityId}, ${before === null ? null : db.json(before as never)}, ${after === null ? null : db.json(after as never)})
  `;

// ---- Who is making this request ----

interface SessionRow {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  totp: boolean;
}

/**
 * The person behind a valid token, as the database has them now: their role this minute (so a role
 * change applies to the next request, not at the next sign-in), and whether they are still active.
 * A token for an email with no account creates one, from the signed claims (that is how the
 * bootstrap owner and the test sessions first appear). Null if the account is switched off.
 *
 * Second factor: the token says whether it was met at sign-in. If the person's role changed since
 * to one that requires a second factor and they have none set up, the session drops to
 * enrolment-only until they do, so promoting someone cannot skip it.
 */
export const resolveSession = async (db: Db, claims: TokenClaims): Promise<AuthUser | null> => {
  const email = claims.email.trim().toLowerCase();
  const select = () => db<SessionRow[]>`select id, email, name, role, is_active, totp_enabled_at is not null as totp from users where email = ${email}`;
  let [row] = await select();
  if (!row) {
    await db`insert into users (email, name, role) values (${email}, ${claims.name || email}, ${claims.role}) on conflict (email) do nothing`;
    [row] = await select();
  }
  if (!row || !row.is_active || !isRole(row.role)) return null;
  const roleChanged = row.role !== claims.role;
  const mfa = claims.mfa && !(roleChanged && requiresTotp(row.role) && !row.totp);
  return { id: row.id, email: row.email, name: row.name, role: row.role, mfa, totpEnabled: row.totp };
};

// ---- Signing in ----

interface LoginRow {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  password_hash: string | null;
  totp_secret_enc: string | null;
  totp_enabled_at: Date | null;
  totp_last_step: string | null;
  totp_recovery_hashes: string[];
  failed_logins: number;
  locked_until: Date | null;
}

export type LoginResult =
  | { ok: true; user: SessionUser; id: string; mfa: boolean; enrolmentRequired: boolean; usedRecoveryCode: boolean }
  | { ok: false; reason: 'invalid' | 'locked' | 'totp_required' | 'totp_invalid'; lockedUntil?: Date };

/**
 * Checks a sign-in. Never says which half was wrong (an unknown email takes as long as a known
 * one, and answers the same), and counts every wrong password or code toward the lockout. Returns
 * a result rather than throwing, so the counters it just wrote are kept.
 *
 * The environment's account works only while no active owner has a password: it is how the very
 * first owner gets in to set one. Once any owner has, it is refused.
 */
export const login = async (db: Db, input: { email: string; password: string; code?: string | undefined }, now: Date = new Date()): Promise<LoginResult> =>
  atomically(db, async (tx): Promise<LoginResult> => {
    const email = input.email.trim().toLowerCase();
    const find = () =>
      tx<LoginRow[]>`
        select id, email, name, role, is_active, password_hash, totp_secret_enc, totp_enabled_at, totp_last_step::text, totp_recovery_hashes, failed_logins, locked_until
        from users where email = ${email} for update
      `;
    let [u] = await find();

    const bootstrapOpen = async () => {
      const [r] = await tx<{ open: boolean }[]>`select not exists (select 1 from users where role = 'owner' and is_active and password_hash is not null) as open`;
      return r!.open;
    };
    const bootstrap = !u?.password_hash && matchesBootstrapCredentials(email, input.password) && (await bootstrapOpen());
    if (bootstrap && !u) {
      await tx`insert into users (email, name, role) values (${email}, ${BOOTSTRAP_NAME}, 'owner') on conflict (email) do nothing`;
      [u] = await find();
    }

    if (!u || (!u.password_hash && !bootstrap) || !isRole(u.role)) {
      // Spend the same time as a real check, so response time does not say which emails exist.
      await verifyPassword(input.password, await dummyHash());
      return { ok: false, reason: 'invalid' };
    }
    const user = u;
    const role = user.role as Role;

    if (user.locked_until && user.locked_until > now) return { ok: false, reason: 'locked', lockedUntil: user.locked_until };

    const fail = async (reason: 'invalid' | 'totp_invalid'): Promise<LoginResult> => {
      const failed = user.failed_logins + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      const until = lock ? new Date(now.getTime() + LOCK_MINUTES * 60_000) : null;
      await tx`update users set failed_logins = ${lock ? 0 : failed}, locked_until = ${until} where id = ${user.id}`;
      if (lock) await audit(tx, null, 'user.locked', user.id, null, { reason: `${MAX_FAILED_LOGINS} wrong attempts`, until: until!.toISOString() });
      return lock ? { ok: false, reason: 'locked', lockedUntil: until! } : { ok: false, reason };
    };

    const passwordOk = bootstrap ? true : await verifyPassword(input.password, user.password_hash!);
    if (!passwordOk) return fail('invalid');
    // A switched-off account answers exactly as a wrong password does.
    if (!user.is_active) return { ok: false, reason: 'invalid' };

    // The second factor, for anyone who has set one up.
    const totpOn = SECOND_FACTOR_ENFORCED && user.totp_enabled_at !== null && user.totp_secret_enc !== null;
    let lastStep: number | null = user.totp_last_step === null ? null : Number(user.totp_last_step);
    let recoveryHashes = user.totp_recovery_hashes;
    let usedRecoveryCode = false;
    if (totpOn) {
      const typed = input.code?.trim();
      if (!typed) return { ok: false, reason: 'totp_required' };
      if (looksLikeRecoveryCode(typed)) {
        const hash = hashRecoveryCode(typed);
        if (!recoveryHashes.includes(hash)) return fail('totp_invalid');
        // Each recovery code works once.
        recoveryHashes = recoveryHashes.filter((h) => h !== hash);
        usedRecoveryCode = true;
        await audit(tx, user.id, 'user.recovery_code_used', user.id, null, { codesLeft: recoveryHashes.length });
      } else {
        const secret = openSecret(user.totp_secret_enc!, config.auth.secret);
        const match = secret ? verifyCode(secret, typed, now, lastStep) : null;
        if (!match) return fail('totp_invalid');
        lastStep = match.step;
      }
    }

    const upgraded = !bootstrap && needsRehash(user.password_hash!) ? await hashPassword(input.password) : null;
    await tx`
      update users set failed_logins = 0, locked_until = null, last_login_at = ${now}, totp_last_step = ${lastStep}, totp_recovery_hashes = ${recoveryHashes}
        ${upgraded ? tx`, password_hash = ${upgraded}` : tx``}
      where id = ${user.id}
    `;
    const enrolmentRequired = requiresTotp(role) && !totpOn;
    return { ok: true, user: { email: user.email, name: user.name, role }, id: user.id, mfa: !enrolmentRequired, enrolmentRequired, usedRecoveryCode };
  });

// ---- Authenticator enrolment ----

/**
 * Starts setting up an authenticator app: a fresh secret, kept (sealed) as pending and handed back
 * once, to be shown as a QR code. It is not enforced until `finishTotpEnrolment` has seen a code
 * from the app, so a mis-scanned code can never lock someone out.
 */
export const startTotpEnrolment = async (db: Db, user: AuthUser): Promise<{ secret: string; otpauthUri: string }> => {
  const [row] = await db<{ enabled: boolean }[]>`select totp_enabled_at is not null as enabled from users where id = ${user.id}`;
  if (row?.enabled) throw new AccountError(409, 'totp_already_enabled', 'An authenticator app is already set up. Ask an owner to reset it first.');
  const secret = generateSecret();
  await db`update users set totp_pending_enc = ${sealSecret(secret, config.auth.secret)} where id = ${user.id}`;
  return { secret, otpauthUri: otpauthUri(secret, user.email, ISSUER) };
};

/**
 * Proves the app was set up right: the code it shows now must match the pending secret. Only then
 * is the second factor switched on, and the one-time recovery codes made. They are returned here
 * once and kept only as hashes.
 */
export const finishTotpEnrolment = async (db: Db, user: AuthUser, code: string, now: Date = new Date()): Promise<{ recoveryCodes: string[] }> =>
  atomically(db, async (tx) => {
    const [row] = await tx<{ pending: string | null; enabled: boolean }[]>`select totp_pending_enc as pending, totp_enabled_at is not null as enabled from users where id = ${user.id} for update`;
    if (row?.enabled) throw new AccountError(409, 'totp_already_enabled', 'An authenticator app is already set up.');
    const secret = row?.pending ? openSecret(row.pending, config.auth.secret) : null;
    if (!secret) throw new AccountError(409, 'totp_not_started', 'Start the setup again to get a new QR code.');
    const match = verifyCode(secret, code, now);
    if (!match) throw new AccountError(400, 'totp_invalid', 'That code is not right. Check the app and try the new code it shows.');
    const recoveryCodes = generateRecoveryCodes();
    await tx`
      update users set totp_secret_enc = totp_pending_enc, totp_pending_enc = null, totp_enabled_at = ${now}, totp_last_step = ${match.step},
        totp_recovery_hashes = ${recoveryCodes.map(hashRecoveryCode)}
      where id = ${user.id}
    `;
    await audit(tx, user.id, 'user.totp_enabled', user.id, null, { recoveryCodes: recoveryCodes.length });
    return { recoveryCodes };
  });

// ---- Passwords ----

const checkPassword = (password: string) => {
  const problem = passwordProblem(password);
  if (problem) throw new AccountError(400, 'weak_password', problem);
};

/**
 * A person changing their own password. They must give the current one, except the bootstrap owner
 * who signed in with the environment's and so has none stored yet: setting one is what closes the
 * bootstrap sign-in.
 */
export const changeOwnPassword = async (db: Db, user: AuthUser, input: { current?: string | undefined; next: string }): Promise<void> => {
  checkPassword(input.next);
  const hash = await hashPassword(input.next);
  await atomically(db, async (tx) => {
    const [row] = await tx<{ password_hash: string | null }[]>`select password_hash from users where id = ${user.id} for update`;
    if (row?.password_hash) {
      if (!input.current || !(await verifyPassword(input.current, row.password_hash))) throw new AccountError(403, 'wrong_password', 'The current password is not right.');
    }
    await tx`update users set password_hash = ${hash}, password_changed_at = now(), failed_logins = 0, locked_until = null where id = ${user.id}`;
    await audit(tx, user.id, 'user.password_changed', user.id, null, null);
  });
};

// ---- Managing users ----

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: Role;
  isActive: boolean;
  hasPassword: boolean;
  totpEnabled: boolean;
  locked: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export const listUsers = async (db: Db, now: Date = new Date()): Promise<UserView[]> => {
  const rows = await db<
    { id: string; email: string; name: string; role: Role; is_active: boolean; has_password: boolean; totp: boolean; locked_until: Date | null; last_login_at: Date | null; created_at: Date }[]
  >`
    select id, email, name, role, is_active, password_hash is not null as has_password, totp_enabled_at is not null as totp, locked_until, last_login_at, created_at
    from users order by is_active desc, case role when 'owner' then 0 when 'manager' then 1 when 'operations' then 2 when 'agent' then 3 else 4 end, lower(name)
  `;
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    isActive: r.is_active,
    hasPassword: r.has_password,
    totpEnabled: r.totp,
    locked: r.locked_until !== null && r.locked_until > now,
    lastLoginAt: r.last_login_at,
    createdAt: r.created_at,
  }));
};

export const createUser = async (db: Db, actor: AuthUser, input: { email: string; name: string; role: Role; password: string }): Promise<string> => {
  checkPassword(input.password);
  const hash = await hashPassword(input.password);
  const email = input.email.trim().toLowerCase();
  return atomically(db, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into users (email, name, role, password_hash, password_changed_at) values (${email}, ${input.name.trim()}, ${input.role}, ${hash}, now())
      on conflict (email) do nothing returning id
    `;
    if (!row) throw new AccountError(409, 'email_taken', `${email} already has an account.`);
    await audit(tx, actor.id, 'user.create', row.id, null, { email, name: input.name.trim(), role: input.role });
    return row.id;
  });
};

/**
 * Renames, re-roles or switches off an account. Two rules keep the system reachable: nobody can
 * change their own role or switch themselves off (another owner must), and there is always at
 * least one active owner. A role change applies from the person's next request.
 */
export const updateUser = async (db: Db, actor: AuthUser, id: string, patch: { name?: string | undefined; role?: Role | undefined; isActive?: boolean | undefined }): Promise<void> =>
  atomically(db, async (tx) => {
    const [target] = await tx<{ id: string; name: string; role: Role; is_active: boolean }[]>`select id, name, role, is_active from users where id = ${id} for update`;
    if (!target) throw new AccountError(404, 'not_found', 'No such user.');
    const role = patch.role ?? target.role;
    const isActive = patch.isActive ?? target.is_active;
    const name = patch.name?.trim() || target.name;
    if (id === actor.id && (role !== target.role || !isActive)) {
      throw new AccountError(409, 'self_change', 'You cannot change your own role or switch yourself off. Ask another owner.');
    }
    if (target.role === 'owner' && target.is_active && (role !== 'owner' || !isActive)) {
      const [others] = await tx<{ n: number }[]>`select count(*)::int as n from users where role = 'owner' and is_active and id <> ${id}`;
      if (others!.n === 0) throw new AccountError(409, 'last_owner', 'There must always be at least one active owner.');
    }
    await tx`update users set name = ${name}, role = ${role}, is_active = ${isActive} where id = ${id}`;
    await audit(tx, actor.id, 'user.update', id, { name: target.name, role: target.role, isActive: target.is_active }, { name, role, isActive });
  });

/** An owner setting someone's password (their first, or one they forgot). Also lifts a lockout. */
export const resetPassword = async (db: Db, actor: AuthUser, id: string, password: string): Promise<void> => {
  checkPassword(password);
  const hash = await hashPassword(password);
  await atomically(db, async (tx) => {
    const done = await tx`update users set password_hash = ${hash}, password_changed_at = now(), failed_logins = 0, locked_until = null where id = ${id} returning id`;
    if (done.length === 0) throw new AccountError(404, 'not_found', 'No such user.');
    await audit(tx, actor.id, 'user.password_reset', id, null, null);
  });
};

/**
 * An owner clearing someone's authenticator (a lost phone, with no recovery code left). They set
 * one up again at next sign-in. Not for yourself: you are signed in with it, and a session should
 * not be able to switch off its own second factor.
 */
export const resetTotp = async (db: Db, actor: AuthUser, id: string): Promise<void> => {
  if (id === actor.id) throw new AccountError(409, 'self_change', 'You cannot reset your own authenticator. Ask another owner.');
  await atomically(db, async (tx) => {
    const done = await tx`
      update users set totp_secret_enc = null, totp_pending_enc = null, totp_enabled_at = null, totp_last_step = null, totp_recovery_hashes = '{}'
      where id = ${id} returning id
    `;
    if (done.length === 0) throw new AccountError(404, 'not_found', 'No such user.');
    await audit(tx, actor.id, 'user.totp_reset', id, null, null);
  });
};

/** The step a code was accepted in, exposed for tests that need a code to be fresh. */
export const currentStep = (at: Date = new Date()): number => stepOf(at);
