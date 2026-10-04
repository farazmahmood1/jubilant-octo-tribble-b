import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../../app.js';
import { type AccountError, updateUser } from '../../auth/accounts.js';
import { ROLES, ROLE_PERMISSIONS, type Role } from '../../auth/permissions.js';
import { codeAt, stepOf } from '../../auth/totp.js';
import { createSessionToken } from '../../auth/session.js';
import { config } from '../../config.js';
import { skipWithoutDb } from '../../test/db.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';

/**
 * T20 through the real app and a real database: five roles, real accounts, the second factor, and
 * what each role is refused. Nothing here asks the permission table what it would do; every
 * expectation is a status code from a request.
 */
describe('API: accounts, roles and the second factor', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let server: Server;
  let base: string;
  const tokens = {} as Record<Role, string>;
  const GOOD = 'a long enough password for tests';

  const call = async (method: string, path: string, options: { token?: string; body?: unknown } = {}) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
  };
  const as = (role: Role) => tokens[role];
  const code = (body: Record<string, any>) => (body['error'] as { code?: string } | undefined)?.code;

  before(async () => {
    s = await migratedWithStores();
    server = createApp({ sql: () => s.schema.sql, webhooks: () => null }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // A signed session for each role; the first request creates the account behind it.
    for (const role of ROLES) tokens[role] = await createSessionToken({ email: `${role}@test.example`, name: `Test ${role}`, role });
    // The owner exists in the database, as it would after first sign-in.
    await call('GET', '/auth/me', { token: tokens.owner });
  });

  after(async () => {
    server?.close();
    await s?.schema.drop();
  });

  describe('being signed in', () => {
    it('refuses a request with no token, a garbage token, and a token for a role that does not exist', async () => {
      const none = await call('GET', '/parcels');
      assert.equal(none.status, 401);
      assert.equal(code(none.body), 'unauthenticated');
      assert.equal((await call('GET', '/parcels', { token: 'garbage' })).status, 401);
      // A validly signed token whose role is not one of the five.
      const forged = await createSessionToken({ email: 'x@test.example', name: 'X', role: 'god' as Role });
      assert.equal((await call('GET', '/parcels', { token: forged })).status, 401);
    });

    it('says who is signed in and what they may do: the permission list the server enforces', async () => {
      for (const role of ROLES) {
        const { status, body } = await call('GET', '/auth/me', { token: as(role) });
        assert.equal(status, 200);
        assert.equal(body['user'].role, role);
        assert.deepEqual(body['permissions'], [...ROLE_PERMISSIONS[role]]);
      }
    });
  });

  describe('what each role may do', () => {
    // [method, path, roles that may reach it, roles that are refused]. "May reach" means anything but
    // 401/403: an empty body or a missing record is a 400 or 404 from the route, which is fine here.
    const MATRIX: Array<[string, string, Role[], Role[]]> = [
      ['GET', '/confirmations/queue', ['owner', 'manager', 'operations', 'agent'], ['accountant']],
      ['GET', '/parcels', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
      ['GET', '/parcels/cities', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
      ['GET', '/reconciliation/items', ['owner', 'manager', 'operations', 'accountant'], ['agent']],
      ['POST', '/reconciliation/items/1/resolve', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
      ['GET', '/stock/quants', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
      ['POST', '/stock/adjustments', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
      ['POST', '/stock/returns/1/check-in', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
      ['GET', '/purchasing/vendors', ['owner', 'manager', 'operations', 'accountant'], ['agent']],
      ['POST', '/purchasing/vendors', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
      ['GET', '/consignment/partners', ['owner', 'manager', 'operations', 'accountant'], ['agent']],
      ['POST', '/consignment/partners', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
      ['GET', '/accounting/periods', ['owner', 'manager', 'accountant'], ['operations', 'agent']],
      ['POST', '/accounting/periods/2026/8/close', ['owner', 'manager', 'accountant'], ['operations', 'agent']],
      ['GET', '/reports/pnl', ['owner', 'manager', 'accountant'], ['operations', 'agent']],
      ['GET', '/reports/dashboard', ['owner', 'manager', 'operations', 'accountant'], ['agent']],
      ['GET', '/settings/alerts', ['owner', 'manager'], ['operations', 'agent', 'accountant']],
      ['PUT', '/settings/alerts', ['owner', 'manager'], ['operations', 'agent', 'accountant']],
      ['GET', '/pr/sends', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
      ['GET', '/influencers', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
      ['GET', '/orders/imports', ['owner', 'manager'], ['operations', 'agent', 'accountant']],
      ['GET', '/users', ['owner'], ['manager', 'operations', 'agent', 'accountant']],
      ['POST', '/users', ['owner'], ['manager', 'operations', 'agent', 'accountant']],
      ['GET', '/integrations/health', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
    ];

    for (const [method, path, yes, no] of MATRIX) {
      it(`${method} ${path}: ${yes.join(', ')} get through; ${no.join(', ')} get 403`, async () => {
        for (const role of yes) {
          const { status } = await call(method, path, { token: as(role), ...(method === 'GET' ? {} : { body: {} }) });
          assert.ok(status !== 401 && status !== 403, `${role} should reach ${method} ${path}, got ${status}`);
        }
        for (const role of no) {
          const { status, body } = await call(method, path, { token: as(role), ...(method === 'GET' ? {} : { body: {} }) });
          assert.equal(status, 403, `${role} should be refused ${method} ${path}`);
          assert.equal(code(body), 'forbidden');
        }
      });
    }

    it('refuses everyone a route the policy does not name, and a method it does not offer', async () => {
      for (const role of ROLES) {
        assert.equal((await call('GET', '/made-up/route', { token: as(role) })).status, 403, role);
        assert.equal((await call('DELETE', '/parcels/1', { token: as(role) })).status, 403, role);
      }
    });
  });

  describe('personal data', () => {
    before(async () => {
      // A vendor with a phone number, readable by the accountant (who may see vendors) and by others.
      await s.schema.sql`insert into vendors (name, phone, email) values ('Sample Packaging', '+923001234567', 'sales@sample.test')`;
    });

    it('never gives an accountant a phone number, though the route is theirs to read', async () => {
      const accountant = await call('GET', '/purchasing/vendors', { token: as('accountant') });
      assert.equal(accountant.status, 200);
      assert.equal(accountant.body['vendors'].length, 1);
      assert.doesNotMatch(JSON.stringify(accountant.body), /\+92|923001234567/);
      assert.equal(accountant.body['vendors'][0].phone, null);
      assert.equal(accountant.body['vendors'][0].name, 'Sample Packaging', 'everything else is intact');
    });

    it('gives the roles that work with customers their numbers, from the same route', async () => {
      for (const role of ['owner', 'manager', 'operations'] as const) {
        const { body } = await call('GET', '/purchasing/vendors', { token: as(role) });
        assert.equal(body['vendors'][0].phone, '+923001234567', role);
      }
    });

    it('applies to every route, because it is the layer under them: partners, too', async () => {
      await s.schema.sql`insert into retail_partners (name, phone) values ('Sample Mart', '+923009998888')`;
      const partners = await call('GET', '/consignment/partners', { token: as('accountant') });
      assert.equal(partners.status, 200);
      assert.doesNotMatch(JSON.stringify(partners.body), /\+92|923009998888/);
    });
  });

  describe('a change to a role takes effect on the next request', () => {
    it('promotes and demotes with no new sign-in', async () => {
      const email = 'shifter@test.example';
      const token = await createSessionToken({ email, name: 'Shifter', role: 'accountant' });
      assert.equal((await call('GET', '/reports/pnl', { token })).status, 200);
      assert.equal((await call('GET', '/stock/quants', { token })).status, 403);

      const [user] = await s.schema.sql<{ id: string }[]>`select id from users where email = ${email}`;
      // The owner moves them to operations: the same token now reaches stock and loses the books.
      assert.equal((await call('PATCH', `/users/${user!.id}`, { token: as('owner'), body: { role: 'operations' } })).status, 200);
      assert.equal((await call('GET', '/stock/quants', { token })).status, 200);
      assert.equal((await call('GET', '/reports/pnl', { token })).status, 403);
      const me = await call('GET', '/auth/me', { token });
      assert.equal(me.body['user'].role, 'operations');
      assert.deepEqual(me.body['permissions'], [...ROLE_PERMISSIONS.operations]);
    });

    it('cuts a switched-off account off at once', async () => {
      const email = 'leaver@test.example';
      const token = await createSessionToken({ email, name: 'Leaver', role: 'operations' });
      assert.equal((await call('GET', '/parcels', { token })).status, 200);
      const [user] = await s.schema.sql<{ id: string }[]>`select id from users where email = ${email}`;
      assert.equal((await call('PATCH', `/users/${user!.id}`, { token: as('owner'), body: { isActive: false } })).status, 200);
      const refused = await call('GET', '/parcels', { token });
      assert.equal(refused.status, 401);
      assert.equal(code(refused.body), 'account_disabled');
    });

    it('does not let a promotion skip the authenticator: a new manager has no access until they set one up', async () => {
      const email = 'rising@test.example';
      const token = await createSessionToken({ email, name: 'Rising', role: 'operations' });
      await call('GET', '/auth/me', { token });
      const [user] = await s.schema.sql<{ id: string }[]>`select id from users where email = ${email}`;
      await call('PATCH', `/users/${user!.id}`, { token: as('owner'), body: { role: 'manager' } });
      const blocked = await call('GET', '/parcels', { token });
      assert.equal(blocked.status, 403);
      assert.equal(code(blocked.body), 'totp_enrolment_required');
      const me = await call('GET', '/auth/me', { token });
      assert.equal(me.status, 200, 'but they can still see who they are, and set the app up');
      assert.equal(me.body['enrolmentRequired'], true);
    });
  });

  describe('signing in', () => {
    const accounts = {
      agent: 'agent.login@test.example',
      accountant: 'accountant.login@test.example',
      manager: 'manager.login@test.example',
    };
    const make = async (email: string, role: Role, name = 'Login Test') =>
      (await call('POST', '/users', { token: as('owner'), body: { email, name, role, password: GOOD } })).body['id'] as string;

    it('creates accounts with argon2id hashes and audits it, without a secret in the audit', async () => {
      const id = await make(accounts.agent, 'agent');
      const [row] = await s.schema.sql<{ password_hash: string }[]>`select password_hash from users where id = ${id}`;
      assert.match(row!.password_hash, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
      const [audit] = await s.schema.sql<{ action: string; after: Record<string, unknown> }[]>`select action, after from audit_log where entity = 'users' and entity_id = ${id} and action = 'user.create'`;
      assert.equal(audit?.action, 'user.create');
      assert.doesNotMatch(JSON.stringify(audit?.after), /password|hash|argon/i);
      assert.equal((await call('POST', '/users', { token: as('owner'), body: { email: accounts.agent, name: 'Again', role: 'agent', password: GOOD } })).status, 409, 'one account per email');
      assert.equal((await call('POST', '/users', { token: as('owner'), body: { email: 'weak@test.example', name: 'Weak', role: 'agent', password: 'short' } })).status, 400);
    });

    it('signs in with the right password and answers the same to a wrong one and to an email that has no account', async () => {
      const ok = await call('POST', '/auth/login', { body: { email: accounts.agent, password: GOOD } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body['user'].role, 'agent');
      assert.equal((await call('GET', '/confirmations/queue', { token: ok.body['token'] })).status, 200, 'and the token works');

      const wrong = await call('POST', '/auth/login', { body: { email: accounts.agent, password: 'not the password at all' } });
      const nobody = await call('POST', '/auth/login', { body: { email: 'nobody@test.example', password: GOOD } });
      assert.equal(wrong.status, 401);
      assert.equal(nobody.status, 401);
      assert.deepEqual(wrong.body, nobody.body, 'the response does not say which half was wrong');
    });

    it('locks an account after five wrong passwords, even for the right one, and an owner can unlock it', async () => {
      const id = await make(accounts.accountant, 'accountant');
      for (let i = 0; i < 4; i++) assert.equal((await call('POST', '/auth/login', { body: { email: accounts.accountant, password: `wrong password number ${i}` } })).status, 401);
      const fifth = await call('POST', '/auth/login', { body: { email: accounts.accountant, password: 'wrong password number 5' } });
      assert.equal(fifth.status, 423);
      assert.equal(code(fifth.body), 'locked');
      assert.equal((await call('POST', '/auth/login', { body: { email: accounts.accountant, password: GOOD } })).status, 423, 'the right password is refused while locked');

      assert.equal((await call('POST', `/users/${id}/password`, { token: as('owner'), body: { password: 'a brand new long password' } })).status, 200);
      assert.equal((await call('POST', '/auth/login', { body: { email: accounts.accountant, password: 'a brand new long password' } })).status, 200, 'a reset lifts the lock');
    });

    it('lets a lock run out by itself', async () => {
      const email = 'expiring@test.example';
      const id = await make(email, 'agent');
      await s.schema.sql`update users set locked_until = now() - interval '1 minute', failed_logins = 0 where id = ${id}`;
      assert.equal((await call('POST', '/auth/login', { body: { email, password: GOOD } })).status, 200);
    });

    it('refuses a switched-off account the same way it refuses a wrong password', async () => {
      const email = 'off@test.example';
      const id = await make(email, 'agent');
      await call('PATCH', `/users/${id}`, { token: as('owner'), body: { isActive: false } });
      const { status, body } = await call('POST', '/auth/login', { body: { email, password: GOOD } });
      assert.equal(status, 401);
      assert.equal(code(body), 'invalid_credentials');
    });

    it('changes your own password only with the current one, and not to a weak one', async () => {
      await make('changer@test.example', 'agent');
      const token = (await call('POST', '/auth/login', { body: { email: 'changer@test.example', password: GOOD } })).body['token'] as string;
      assert.equal((await call('POST', '/auth/password', { token, body: { current: 'the wrong current one', next: 'another long new password' } })).status, 403);
      assert.equal((await call('POST', '/auth/password', { token, body: { current: GOOD, next: 'short' } })).status, 400);
      assert.equal((await call('POST', '/auth/password', { token, body: { current: GOOD, next: 'another long new password' } })).status, 200);
      assert.equal((await call('POST', '/auth/login', { body: { email: 'changer@test.example', password: GOOD } })).status, 401, 'the old one stops working');
      assert.equal((await call('POST', '/auth/login', { body: { email: 'changer@test.example', password: 'another long new password' } })).status, 200);
    });

    it('never sends a password, hash or secret back from the user list', async () => {
      const { status, body } = await call('GET', '/users', { token: as('owner') });
      assert.equal(status, 200);
      assert.doesNotMatch(JSON.stringify(body), /argon2|password_hash|passwordHash|totp_secret|\$argon/i);
      assert.ok(body['users'].every((u: Record<string, unknown>) => typeof u['hasPassword'] === 'boolean'));
    });

    after(() => void accounts.manager);
  });

  describe('the authenticator app', () => {
    const email = 'second.factor@test.example';
    let id: string;
    let secret: string;
    let token: string;
    let recovery: string[];

    it('holds a manager to setting one up: signing in works, but nothing else does until it is done', async () => {
      id = (await call('POST', '/users', { token: as('owner'), body: { email, name: 'Second Factor', role: 'manager', password: GOOD } })).body['id'];
      const login = await call('POST', '/auth/login', { body: { email, password: GOOD } });
      assert.equal(login.status, 200);
      assert.equal(login.body['enrolmentRequired'], true);
      token = login.body['token'];
      const blocked = await call('GET', '/parcels', { token });
      assert.equal(blocked.status, 403);
      assert.equal(code(blocked.body), 'totp_enrolment_required');
    });

    it('shows a secret and an address for a QR code, and enforces nothing until a code proves it', async () => {
      const setup = await call('POST', '/auth/totp/setup', { token });
      assert.equal(setup.status, 200);
      secret = setup.body['secret'];
      assert.match(secret, /^[A-Z2-7]{32}$/);
      assert.match(setup.body['otpauthUri'], new RegExp(`^otpauth://totp/NUR%20Organics:${encodeURIComponent(email)}\\?secret=${secret}&issuer=NUR%20Organics`));
      // Set up, not yet proven: signing in still asks for no code.
      const [row] = await s.schema.sql<{ enabled: unknown; pending: string | null; secret: string | null }[]>`select totp_enabled_at as enabled, totp_pending_enc as pending, totp_secret_enc as secret from users where id = ${id}`;
      assert.equal(row?.enabled, null);
      assert.equal(row?.secret, null);
      assert.ok(row?.pending);
      assert.doesNotMatch(row!.pending!, new RegExp(secret), 'the secret is stored sealed, not in the clear');
    });

    it('refuses a wrong code, and does not switch anything on', async () => {
      const wrong = await call('POST', '/auth/totp/enable', { token, body: { code: '000000' } });
      assert.equal(wrong.status, 400);
      assert.equal(code(wrong.body), 'totp_invalid');
      assert.equal((await call('GET', '/parcels', { token })).status, 403);
    });

    it('switches it on only once the app\'s own code is given, then hands over recovery codes once', async () => {
      const done = await call('POST', '/auth/totp/enable', { token, body: { code: codeAt(secret, stepOf(new Date())) } });
      assert.equal(done.status, 200, JSON.stringify(done.body));
      recovery = done.body['recoveryCodes'];
      assert.equal(recovery.length, 8);
      assert.ok(recovery.every((c) => /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/.test(c)));
      token = done.body['token'];
      assert.equal((await call('GET', '/parcels', { token })).status, 200, 'the new token reaches everything the role may');
      const [row] = await s.schema.sql<{ hashes: string[] }[]>`select totp_recovery_hashes as hashes from users where id = ${id}`;
      assert.equal(row!.hashes.length, 8);
      assert.ok(row!.hashes.every((h) => /^[0-9a-f]{64}$/.test(h)), 'only hashes are kept');
      assert.equal((await call('POST', '/auth/totp/setup', { token })).status, 409, 'cannot be set up twice');
    });

    it('then asks for a code at every sign-in, refuses a wrong one, and a code that was already used', async () => {
      const noCode = await call('POST', '/auth/login', { body: { email, password: GOOD } });
      assert.equal(noCode.status, 401);
      assert.equal(code(noCode.body), 'totp_required');

      const wrong = await call('POST', '/auth/login', { body: { email, password: GOOD, code: '111111' } });
      assert.equal(code(wrong.body), 'totp_invalid');

      // The code used to enable it cannot be used again (replay), but the next step's is fine.
      const used = await call('POST', '/auth/login', { body: { email, password: GOOD, code: codeAt(secret, stepOf(new Date())) } });
      assert.equal(used.status, 401, 'the enabling code is spent');
      const next = codeAt(secret, stepOf(new Date()) + 1);
      const ok = await call('POST', '/auth/login', { body: { email, password: GOOD, code: next } });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body['enrolmentRequired'], undefined);
      assert.equal((await call('GET', '/parcels', { token: ok.body['token'] })).status, 200);
      const replay = await call('POST', '/auth/login', { body: { email, password: GOOD, code: next } });
      assert.equal(replay.status, 401, 'the same code twice');
    });

    it('lets a recovery code in once, and only once', async () => {
      const first = await call('POST', '/auth/login', { body: { email, password: GOOD, code: recovery[0] } });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body['usedRecoveryCode'], true);
      const again = await call('POST', '/auth/login', { body: { email, password: GOOD, code: recovery[0] } });
      assert.equal(again.status, 401);
      const [audit] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'user.recovery_code_used' and entity_id = ${id}`;
      assert.equal(audit!.n, 1);
    });

    it('lets an owner clear a lost authenticator, but not their own', async () => {
      assert.equal((await call('POST', `/users/${id}/reset-totp`, { token: as('manager') })).status, 403, 'only owners');
      assert.equal((await call('POST', `/users/${id}/reset-totp`, { token: as('owner') })).status, 200);
      const login = await call('POST', '/auth/login', { body: { email, password: GOOD } });
      assert.equal(login.body['enrolmentRequired'], true, 'back to setting one up');
      const [owner] = await s.schema.sql<{ id: string }[]>`select id from users where email = 'owner@test.example'`;
      const self = await call('POST', `/users/${owner!.id}/reset-totp`, { token: as('owner') });
      assert.equal(self.status, 409);
      assert.equal(code(self.body), 'self_change');
    });

    it('does not ask an operations user, an agent or an accountant for one', async () => {
      for (const role of ['operations', 'agent', 'accountant'] as const) {
        const e = `no.totp.${role}@test.example`;
        await call('POST', '/users', { token: as('owner'), body: { email: e, name: role, role, password: GOOD } });
        const login = await call('POST', '/auth/login', { body: { email: e, password: GOOD } });
        assert.equal(login.status, 200, role);
        assert.equal(login.body['enrolmentRequired'], undefined, role);
      }
    });
  });

  describe('the bootstrap sign-in', () => {
    it('works for the first owner, who must set an authenticator up; then setting a password closes it for good', async () => {
      // A clean slate: no owner has a password yet (the test owners were made from signed tokens).
      await s.schema.sql`delete from audit_log where actor_id in (select id from users where email = ${config.auth.email})`;
      const first = await call('POST', '/auth/login', { body: { email: config.auth.email, password: config.auth.password } });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body['user'].role, 'owner');
      assert.equal(first.body['enrolmentRequired'], true);

      // The owner is still bootstrapping: the environment's sign-in keeps working.
      assert.equal((await call('POST', '/auth/login', { body: { email: config.auth.email, password: config.auth.password } })).status, 200);

      // They choose a real password (no current one to give: they signed in with the environment's).
      const set = await call('POST', '/auth/password', { token: first.body['token'], body: { next: 'my own real long password' } });
      assert.equal(set.status, 200, JSON.stringify(set.body));

      // Now the environment's sign-in is refused, and the real one works.
      const closed = await call('POST', '/auth/login', { body: { email: config.auth.email, password: config.auth.password } });
      assert.equal(closed.status, 401, 'the bootstrap sign-in is closed once an owner has a password');
      assert.equal((await call('POST', '/auth/login', { body: { email: config.auth.email, password: 'my own real long password' } })).status, 200);
    });
  });

  describe('keeping the system reachable', () => {
    it('stops anyone changing their own role or switching themselves off', async () => {
      const [owner] = await s.schema.sql<{ id: string }[]>`select id from users where email = 'owner@test.example'`;
      for (const body of [{ role: 'agent' }, { isActive: false }]) {
        const { status, body: out } = await call('PATCH', `/users/${owner!.id}`, { token: as('owner'), body });
        assert.equal(status, 409);
        assert.equal(code(out), 'self_change');
      }
      assert.equal((await call('PATCH', `/users/${owner!.id}`, { token: as('owner'), body: { name: 'Renamed Owner' } })).status, 200, 'but renaming is fine');
    });

    it('always keeps one active owner', async () => {
      const users = await s.schema.sql<{ id: string; email: string }[]>`select id, email from users where role = 'owner' and is_active`;
      assert.ok(users.length >= 1);
      // Make every other owner inactive-by-role, then try to remove the last one as someone else.
      const sole = users[0]!;
      await s.schema.sql`update users set role = 'manager' where role = 'owner' and id <> ${sole.id}`;
      const actor = { id: '999999', email: 'ghost@test.example', name: 'Ghost', role: 'owner' as Role, mfa: true, totpEnabled: true };
      try {
        await assert.rejects(
          () => updateUser(s.schema.sql, actor, sole.id, { role: 'manager' }),
          (error: AccountError) => error.code === 'last_owner',
        );
        await assert.rejects(
          () => updateUser(s.schema.sql, actor, sole.id, { isActive: false }),
          (error: AccountError) => error.code === 'last_owner',
        );
      } finally {
        // Put the test owners back, so the tests after this one see the accounts they expect.
        await s.schema.sql`update users set role = 'owner' where email in ('owner@test.example', ${sole.email})`;
      }
    });

    it('audits every change with who made it', async () => {
      const rows = await s.schema.sql<{ action: string }[]>`select distinct action from audit_log where entity = 'users'`;
      const actions = rows.map((r) => r.action);
      for (const wanted of ['user.create', 'user.update', 'user.password_reset', 'user.totp_enabled', 'user.totp_reset', 'user.locked']) assert.ok(actions.includes(wanted), `${wanted} is audited`);
      const [orphan] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from audit_log where entity = 'users' and action <> 'user.locked' and actor_id is null`;
      assert.equal(orphan!.n, 0, 'every change names a person');
    });
  });

  describe('refreshing a session', () => {
    it('issues a token for the account as it is now', async () => {
      const email = 'refresh@test.example';
      const old = await createSessionToken({ email, name: 'Refresh', role: 'agent' });
      await call('GET', '/auth/me', { token: old });
      const [user] = await s.schema.sql<{ id: string }[]>`select id from users where email = ${email}`;
      await call('PATCH', `/users/${user!.id}`, { token: as('owner'), body: { role: 'accountant' } });
      const fresh = await call('POST', '/auth/refresh', { token: old });
      assert.equal(fresh.status, 200);
      const me = await call('GET', '/auth/me', { token: fresh.body['token'] });
      assert.equal(me.body['user'].role, 'accountant');
      assert.equal(stepOf(new Date()) > 0, true);
    });
  });

  describe('the columns each person hides', () => {
    it('keeps them with the account, per list, for every role, and keeps one person\'s apart from another\'s', async () => {
      assert.deepEqual((await call('GET', '/auth/preferences', { token: as('agent') })).body, { columns: {} });
      const saved = await call('PUT', '/auth/preferences/columns/orders', { token: as('agent'), body: { hidden: ['phone', 'items', 'phone'] } });
      assert.equal(saved.status, 200);
      await call('PUT', '/auth/preferences/columns/parcels', { token: as('agent'), body: { hidden: [] } });
      await call('PUT', '/auth/preferences/columns/orders', { token: as('accountant'), body: { hidden: ['city'] } });
      assert.deepEqual((await call('GET', '/auth/preferences', { token: as('agent') })).body, { columns: { orders: ['phone', 'items'], parcels: [] } });
      assert.deepEqual((await call('GET', '/auth/preferences', { token: as('accountant') })).body, { columns: { orders: ['city'] } });
    });

    it('replaces a list\'s columns, and refuses what is not a list or a column', async () => {
      await call('PUT', '/auth/preferences/columns/returns', { token: as('operations'), body: { hidden: ['a', 'b'] } });
      await call('PUT', '/auth/preferences/columns/returns', { token: as('operations'), body: { hidden: ['c'] } });
      assert.deepEqual((await call('GET', '/auth/preferences', { token: as('operations') })).body['columns'].returns, ['c']);
      assert.equal((await call('PUT', '/auth/preferences/columns/Bad%20Screen', { token: as('operations'), body: { hidden: [] } })).status, 400);
      assert.equal((await call('PUT', '/auth/preferences/columns/orders', { token: as('operations'), body: { hidden: ['<script>'] } })).status, 400);
      assert.equal((await call('PUT', '/auth/preferences/columns/orders', { token: as('operations'), body: {} })).status, 400);
      assert.equal((await call('GET', '/auth/preferences')).status, 401);
    });
  });
});
