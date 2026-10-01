import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PERMISSIONS, PHONE_FIELDS, ROLES, ROLE_PERMISSIONS, ROUTE_POLICY, can, canAny, permissionsFor, stripPhones } from './permissions.js';

const routesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'http', 'routes');

/** Every route the API serves behind a session, read from the route files themselves. */
const privateRoutes = (): Array<{ method: string; path: string; file: string }> => {
  const found: Array<{ method: string; path: string; file: string }> = [];
  for (const file of readdirSync(routesDir)) {
    // Public: sign-in, health, Shopify's own signed webhooks. Everything else needs a session.
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || ['auth.ts', 'health.ts', 'shopify-webhooks.ts', 'index.ts'].includes(file)) continue;
    const source = readFileSync(join(routesDir, file), 'utf8');
    for (const m of source.matchAll(/(?:router|\w+Router)\.(get|post|put|patch|delete)\(\s*([`'])([^`']+)\2/g)) {
      found.push({ method: m[1]!.toUpperCase(), path: m[3]!, file });
    }
    // The resolve/ignore pair is registered in a loop over a template path.
    for (const m of source.matchAll(/router\.post\(`([^`$]*)\$\{[^}]*\}`/g)) found.push({ method: 'POST', path: `${m[1]}resolve`, file });
  }
  return found;
};

/** `/parcels/:id` as a request would carry it. */
const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, '12').replace(/\$\{[^}]*\}/g, 'x');

describe('the permission matrix', () => {
  it('is data: five roles, each a list of known permissions', () => {
    assert.deepEqual([...ROLES], ['owner', 'manager', 'operations', 'agent', 'accountant']);
    for (const role of ROLES) {
      assert.ok(ROLE_PERMISSIONS[role].length > 0, role);
      for (const p of ROLE_PERMISSIONS[role]) assert.ok((PERMISSIONS as readonly string[]).includes(p), `${role}: ${p}`);
      assert.equal(new Set(ROLE_PERMISSIONS[role]).size, ROLE_PERMISSIONS[role].length, `${role} lists a permission twice`);
    }
  });

  it('gives the owner everything, and the manager everything but running the users', () => {
    assert.deepEqual([...ROLE_PERMISSIONS.owner], [...PERMISSIONS]);
    assert.deepEqual(PERMISSIONS.filter((p) => !can('manager', p)), ['users.manage']);
  });

  it('keeps the accountant away from customers\' phone numbers, and the agent able to use them', () => {
    assert.equal(can('accountant', 'pii.phone'), false);
    for (const role of ['owner', 'manager', 'operations', 'agent'] as const) assert.equal(can(role, 'pii.phone'), true, role);
  });

  it('lets only the people who run things manage users and settings', () => {
    for (const role of ROLES) assert.equal(can(role, 'users.manage'), role === 'owner', role);
    for (const role of ROLES) assert.equal(can(role, 'settings.manage'), role === 'owner' || role === 'manager', role);
  });

  it('keeps the agent to the desk, and the accountant to the books', () => {
    assert.deepEqual([...ROLE_PERMISSIONS.agent].sort(), ['confirmations.work', 'orders.read', 'pii.phone']);
    for (const p of ROLE_PERMISSIONS.accountant) assert.ok(/\.read$|^accounting\.close$/.test(p), `accountant holds ${p}`);
    assert.equal(canAny('accountant', ['stock.adjust', 'purchasing.write']), false);
  });
});

describe('the route policy', () => {
  it('covers every route the API serves, so a new endpoint cannot be left open by accident', () => {
    const routes = privateRoutes();
    assert.ok(routes.length > 80, `found only ${routes.length} routes; the scan is broken`);
    const open = routes.filter((r) => permissionsFor(r.method, concrete(r.path)) === undefined).map((r) => `${r.method} ${r.path} (${r.file})`);
    assert.deepEqual(open, [], 'these routes have no entry in ROUTE_POLICY');
  });

  it('refuses a route that is not in it, and a method a rule does not offer', () => {
    assert.equal(permissionsFor('GET', '/made-up/route'), undefined);
    assert.equal(permissionsFor('POST', '/parcels/12'), undefined, 'parcels are read-only');
    assert.equal(permissionsFor('DELETE', '/reports/pnl'), undefined);
  });

  it('asks for the narrow permission before the broad one', () => {
    assert.deepEqual(permissionsFor('GET', '/reports/dashboard'), ['dashboard.read']);
    assert.deepEqual(permissionsFor('GET', '/reports/pnl'), ['reports.read']);
    assert.deepEqual(permissionsFor('POST', '/stock/adjustments'), ['stock.adjust']);
    assert.deepEqual(permissionsFor('GET', '/stock/quants'), ['stock.read']);
    assert.deepEqual(permissionsFor('POST', '/accounting/periods/2026/8/close'), ['accounting.close']);
    assert.deepEqual(permissionsFor('GET', '/users'), ['users.manage']);
  });

  it('treats reading and writing differently on the same path', () => {
    assert.deepEqual(permissionsFor('GET', '/settings/alerts'), ['settings.manage']);
    assert.deepEqual(permissionsFor('GET', '/settings/confirmation-desk'), ['confirmations.work', 'settings.manage']);
    assert.deepEqual(permissionsFor('PUT', '/settings/confirmation-desk'), ['settings.manage']);
    assert.deepEqual(permissionsFor('GET', '/reconciliation/items'), ['reconciliation.read']);
    assert.deepEqual(permissionsFor('POST', '/reconciliation/items/4/resolve'), ['reconciliation.work']);
  });

  it('has no rule that can never match, and none that shadows a later one', () => {
    const paths = ROUTE_POLICY.map((r) => r.path.source);
    assert.equal(new Set(paths).size, paths.length, 'a rule is written twice');
  });
});

describe('what each role may do, through the policy', () => {
  const ALLOWED: Array<[string, string, string[], string[]]> = [
    // [method, path, roles that may, roles that may not]
    ['GET', '/confirmations/queue', ['owner', 'manager', 'operations', 'agent'], ['accountant']],
    ['POST', '/confirmations/orders/1/attempts', ['owner', 'manager', 'operations', 'agent'], ['accountant']],
    ['GET', '/parcels', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
    ['POST', '/stock/returns/1/check-in', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
    ['GET', '/reconciliation/items', ['owner', 'manager', 'operations', 'accountant'], ['agent']],
    ['POST', '/reconciliation/items/1/link', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
    ['GET', '/stock/quants', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
    ['POST', '/stock/adjustments', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
    ['GET', '/purchasing/bills', ['owner', 'manager', 'operations', 'accountant'], ['agent']],
    ['POST', '/purchasing/orders', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
    ['GET', '/consignment/partners', ['owner', 'manager', 'operations', 'accountant'], ['agent']],
    ['POST', '/consignment/imports', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
    ['GET', '/accounting/invoices', ['owner', 'manager', 'accountant'], ['operations', 'agent']],
    ['POST', '/accounting/periods/2026/8/close', ['owner', 'manager', 'accountant'], ['operations', 'agent']],
    ['GET', '/reports/pnl', ['owner', 'manager', 'accountant'], ['operations', 'agent']],
    ['GET', '/reports/dashboard', ['owner', 'manager', 'operations', 'accountant'], ['agent']],
    ['GET', '/settings/alerts', ['owner', 'manager'], ['operations', 'agent', 'accountant']],
    ['PUT', '/settings/alerts', ['owner', 'manager'], ['operations', 'agent', 'accountant']],
    ['GET', '/users', ['owner'], ['manager', 'operations', 'agent', 'accountant']],
    ['POST', '/users', ['owner'], ['manager', 'operations', 'agent', 'accountant']],
    ['GET', '/pr/sends', ['owner', 'manager', 'operations'], ['agent', 'accountant']],
    ['GET', '/orders/imports', ['owner', 'manager'], ['operations', 'agent', 'accountant']],
  ];

  for (const [method, path, yes, no] of ALLOWED) {
    it(`${method} ${path}: ${yes.join(', ')} may; ${no.join(', ')} may not`, () => {
      const needs = permissionsFor(method, path)!;
      assert.ok(needs, 'has a policy');
      for (const role of yes) assert.equal(canAny(role as never, needs), true, `${role} should be allowed`);
      for (const role of no) assert.equal(canAny(role as never, needs), false, `${role} should be refused`);
    });
  }
});

describe('stripping phone numbers', () => {
  it('nulls every phone field, however deep, and leaves the rest alone', () => {
    const response = {
      total: 2,
      rows: [
        { id: '1', orderNumber: '#1001', phone: '+923001234567', whatsappUrl: 'https://wa.me/923001234567', callUrl: 'tel:+923001234567', city: 'Lahore', totalPaisa: '275000' },
        { id: '2', customer: { name: 'Sample', customerPhone: '+923009999999', history: [{ phone: '+923001111111', n: 3 }] } },
      ],
    };
    const out = stripPhones(response);
    assert.doesNotMatch(JSON.stringify(out), /\+92|wa\.me|tel:/);
    assert.deepEqual(out.rows[0], { id: '1', orderNumber: '#1001', phone: null, whatsappUrl: null, callUrl: null, city: 'Lahore', totalPaisa: '275000' });
    assert.equal((out.rows[1] as { customer: { name: string } }).customer.name, 'Sample');
    assert.equal(response.rows[0]!.phone, '+923001234567', 'the original is not changed');
  });

  it('leaves dates, numbers, null and absent fields as they were', () => {
    const when = new Date('2026-09-01T00:00:00Z');
    assert.deepEqual(stripPhones({ when, n: 5, nothing: null, phone: undefined }), { when, n: 5, nothing: null, phone: undefined });
    assert.equal(stripPhones(null), null);
    assert.equal(stripPhones('text'), 'text');
  });

  it('names every field the confirmation desk and parcels use for a number', () => {
    for (const field of ['phone', 'customerPhone', 'whatsappUrl', 'callUrl']) assert.ok(PHONE_FIELDS.has(field), field);
  });
});
