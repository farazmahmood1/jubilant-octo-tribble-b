-- T20: real accounts. `users` already holds email, name, role, password_hash and is_active; this
-- adds what signing in properly needs.
--
-- The TOTP secret is stored encrypted (AES-256-GCM, key derived from AUTH_SECRET), never in the
-- clear: a database dump alone cannot generate anyone's codes. `totp_pending_enc` holds a secret
-- that has been shown for enrolment and not yet proven with a code; only `totp_secret_enc` with
-- `totp_enabled_at` set is enforced at sign-in. `totp_last_step` is the last 30-second step that
-- was accepted, so the same code cannot be used twice. Recovery codes are stored only as SHA-256
-- hashes (they are random and long, so a fast hash is enough) and each works once.
--
-- Five wrong passwords lock the account for fifteen minutes (`failed_logins`, `locked_until`).
alter table users
  add column totp_secret_enc        text,
  add column totp_pending_enc       text,
  add column totp_enabled_at        timestamptz,
  add column totp_last_step         bigint,
  add column totp_recovery_hashes   text[] not null default '{}',
  add column failed_logins          integer not null default 0 check (failed_logins >= 0),
  add column locked_until           timestamptz,
  add column last_login_at          timestamptz,
  add column password_changed_at    timestamptz,
  add constraint users_totp_enabled_has_secret check (totp_enabled_at is null or totp_secret_enc is not null);
