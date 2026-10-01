import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../../app.js';
import { createSessionToken } from '../../auth/session.js';
import { config } from '../../config.js';
import { skipWithoutDb } from '../../test/db.js';
import { variantsIn } from '../../test/inventory.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';

/** Partners, transfers and a sheet import through the real app. Names and SKUs are made up. */
describe('API: consignment', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let server: Server;
  let base: string;
  let token: string;
  let variant: string;

  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const isJson = response.headers.get('content-type')?.includes('json');
    return { status: response.status, body: (isJson ? await response.json() : { text: await response.text() }) as Record<string, unknown> };
  };

  before(async () => {
    s = await migratedWithStores();
    [variant] = (await variantsIn(s.schema.sql, s.nur, 1)) as [string];
    await s.schema.sql`update variants set sku = 'NBJ-SERUM-30' where id = ${variant}`;
    await s.schema.sql`insert into product_costs (variant_id, unit_cost_paisa, effective_from, source) values (${variant}, '45000', '2026-01-01', 'manual')`;
    token = await createSessionToken({ email: config.auth.email, name: 'Owner', role: 'owner' });
    server = createApp({ sql: () => s.schema.sql, webhooks: () => null }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await s?.schema.drop();
  });

  it('refuses without a session, and publishes the template', async () => {
    assert.equal((await call('GET', '/consignment/partners', undefined, false)).status, 401);
    const template = await call('GET', '/consignment/template.csv');
    assert.equal(template.status, 200);
    assert.match(String(template.body['text']), /^date,sku,quantity,unit_price,tax\n/);
  });

  it('partner → transfer → dry run (report) → commit → re-import refused → reverse', async () => {
    const partner = await call('POST', '/consignment/partners', { name: 'Test Grocer', city: 'Lahore' });
    const partnerId = String(partner.body['id']);
    assert.equal((await call('POST', '/consignment/transfers', { partnerId, direction: 'out', lines: [{ variantId: variant, qty: 6 }] })).status, 201);
    const stock = (await call('GET', `/consignment/partners/${partnerId}/stock`)).body['stock'] as Array<Record<string, unknown>>;
    assert.deepEqual(stock.map((r) => [r['sku'], r['qty']]), [['NBJ-SERUM-30', 6]]);

    const csv = 'date,sku,quantity,unit_price,tax\n2026-09-10,NBJ-SERUM-30,2,1450,0\n2026-09-11,BAD,1,1,0\n';
    const dry = await call('POST', '/consignment/imports/dry-run', { partnerId, fileName: 'sept.csv', csv });
    const report = dry.body['report'] as { valid: number; invalid: number; net: string; rows: Array<{ row: number; errors: string[] }> };
    assert.deepEqual([report.valid, report.invalid, report.net], [1, 1, '290000']);
    assert.deepEqual(report.rows[1], { row: 3, ok: false, errors: ['sku "BAD" is not one of our products'] });

    const refused = await call('POST', '/consignment/imports', { partnerId, fileName: 'sept.csv', csv });
    assert.equal(refused.status, 409);
    assert.equal((refused.body['report'] as { invalid: number }).invalid, 1, 'the report comes back with the refusal');
    const forced = await call('POST', '/consignment/imports', { partnerId, fileName: 'sept.csv', csv, force: true });
    assert.deepEqual([forced.status, forced.body['rowsImported'], forced.body['rowsSkipped']], [201, 1, 1]);
    const again = await call('POST', '/consignment/imports', { partnerId, fileName: 'sept.csv', csv, force: true });
    assert.equal(again.status, 409);
    assert.match(String((again.body['error'] as Record<string, unknown>)['message']), /already imported/);

    const reversed = await call('POST', `/consignment/imports/${forced.body['importId']}/reverse`, { reason: 'Wrong sheet' });
    assert.deepEqual(reversed.body, { entriesReversed: 2, unitsRestored: 2 });
    const imports = (await call('GET', `/consignment/imports?partnerId=${partnerId}`)).body['imports'] as Array<Record<string, unknown>>;
    assert.ok(imports[0]!['reversedAt']);
    const actions = await s.schema.sql<{ action: string }[]>`select action from audit_log where action like 'consignment.%' or action = 'partner.create' order by id`;
    assert.deepEqual(actions.map((a) => a.action), ['partner.create', 'consignment.transfer_out', 'consignment.import', 'consignment.import_reverse']);
  });
});
