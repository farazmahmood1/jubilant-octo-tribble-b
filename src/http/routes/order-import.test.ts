import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../../app.js';
import { createSessionToken } from '../../auth/session.js';
import { config } from '../../config.js';
import { skipWithoutDb } from '../../test/db.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';

/** The order history import through the real app, the file as a text/csv body. Data made up. */
describe('API: order history import', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let server: Server;
  let base: string;
  let token: string;
  const csv =
    'Name,Financial Status,Subtotal,Total,Created at,Lineitem quantity,Lineitem name,Lineitem price,Id\n' +
    '#6001,pending,1500.00,1500.00,2026-03-01 11:00:00 +0500,1,Serum,1500.00,6001\n' +
    '#6002,pending,900.00,nine,2026-03-01 12:00:00 +0500,1,Cream,900.00,6002\n';

  const post = (path: string, body: string, contentType = 'text/csv', auth = true) =>
    fetch(`${base}/api/v1${path}`, { method: 'POST', headers: { 'Content-Type': contentType, ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body }).then(async (r) => ({
      status: r.status,
      body: (await r.json()) as Record<string, unknown>,
    }));

  before(async () => {
    s = await migratedWithStores();
    token = await createSessionToken({ email: config.auth.email, name: 'Owner', role: 'owner' });
    server = createApp({ sql: () => s.schema.sql, webhooks: () => null }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await s?.schema.drop();
  });

  it('refuses without a session, and publishes the declared column mapping', async () => {
    assert.equal((await post('/orders/import/dry-run?store=nur&fileName=a.csv', csv, 'text/csv', false)).status, 401);
    const columns = await fetch(`${base}/api/v1/orders/import/columns`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json() as Promise<{ columns: Record<string, string> }>);
    assert.equal(columns.columns['shopifyOrderId'], 'Id');
  });

  it('dry run, then commit: the malformed order reported by row, the good one imported and audited', async () => {
    const dry = await post('/orders/import/dry-run?store=nur&fileName=march.csv', csv);
    const report = dry.body['report'] as { orders: { valid: number; malformed: number }; problems: Array<{ row: number; reason: string }> };
    assert.deepEqual([report.orders.valid, report.orders.malformed], [1, 1]);
    assert.deepEqual(report.problems, [{ row: 3, orderNumber: '#6002', reason: 'Total "nine" is not an amount' }]);
    const [none] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from orders`;
    assert.equal(none?.n, 0);

    const committed = await post('/orders/import?store=nur&fileName=march.csv', csv);
    assert.equal(committed.status, 201);
    assert.equal((committed.body['report'] as { inserted: number }).inserted, 1);
    const [audit] = await s.schema.sql`select 1 from audit_log where action = 'orders.csv_import'`;
    assert.ok(audit);
    assert.equal((await post('/orders/import?store=nur&fileName=x.csv', '')).status, 400);
    assert.equal((await post('/orders/import?store=other&fileName=x.csv', csv)).status, 400);
    assert.equal((await post('/orders/import?store=nur&fileName=x.csv', 'Name,Total\n#1,5\n')).status, 422, 'not an order export');
  });
});
