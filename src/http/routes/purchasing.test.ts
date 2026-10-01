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

/** The five purchasing steps through the real app, against a scratch schema. */
describe('API: purchasing', { skip: skipWithoutDb }, () => {
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
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const message = (body: Record<string, unknown>) => String((body['error'] as Record<string, unknown>)['message']);

  before(async () => {
    s = await migratedWithStores();
    [variant] = (await variantsIn(s.schema.sql, s.nur, 1)) as [string];
    token = await createSessionToken({ email: config.auth.email, name: 'Owner', role: 'owner' });
    server = createApp({ sql: () => s.schema.sql, webhooks: () => null }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await s?.schema.drop();
  });

  it('refuses without a session', async () => {
    for (const path of ['/purchasing/vendors', '/purchasing/orders', '/purchasing/bills', '/purchasing/reorder-suggestions', '/settings/purchasing']) {
      assert.equal((await call('GET', path, undefined, false)).status, 401, path);
    }
  });

  it('request → quotation → order → partial receipts → bill (refused over tolerance, then matched) → payment, all audited', async () => {
    const vendor = await call('POST', '/purchasing/vendors', { name: 'Test Labs', paymentTermsDays: 15 });
    assert.equal(vendor.status, 201);
    const vendorId = String(vendor.body['id']);
    const request = await call('POST', '/purchasing/requests', { variantId: variant, qty: 10, reason: 'Running low' });
    const quote = await call('POST', '/purchasing/quotations', {
      vendorId,
      receivedOn: '2026-09-01',
      lines: [{ variantId: variant, qty: 10, unitPricePaisa: '40000', requestId: request.body['id'] }],
    });
    assert.equal(quote.status, 201);
    assert.equal((await call('POST', '/purchasing/quotations', { vendorId, receivedOn: '2026-09-01', lines: [{ variantId: variant, qty: 1, unitPricePaisa: '4.5' }] })).status, 400, 'paisa are digits');
    const compare = await call('GET', `/purchasing/quotations/compare/${variant}`);
    assert.deepEqual((compare.body['quotes'] as Array<Record<string, unknown>>).map((q) => q['unitPrice']), ['40000']);

    const po = await call('POST', '/purchasing/orders', { vendorId, store: 'nur', quotationId: quote.body['id'], orderedOn: '2026-09-02' });
    assert.equal(po.status, 201, JSON.stringify(po.body));
    const poId = String(po.body['id']);
    const detail = async () => (await call('GET', `/purchasing/orders/${poId}`)).body['order'] as Record<string, unknown>;
    const lineId = String(((await detail())['lines'] as Array<Record<string, unknown>>)[0]!['id']);

    const first = await call('POST', `/purchasing/orders/${poId}/receipts`, { receivedAt: '2026-09-04T10:00:00+05:00', lines: [{ poLineId: lineId, qty: 4 }] });
    assert.deepEqual([first.status, first.body['value']], [201, '160000']);
    assert.equal((await detail())['status'], 'partially_received');
    const over = await call('POST', `/purchasing/orders/${poId}/receipts`, { lines: [{ poLineId: lineId, qty: 7 }] });
    assert.equal(over.status, 409);
    assert.match(message(over.body), /only 6 of 10 ordered are still to come/);
    await call('POST', `/purchasing/orders/${poId}/receipts`, { receivedAt: '2026-09-06T10:00:00+05:00', lines: [{ poLineId: lineId, qty: 6 }] });

    const refused = await call('POST', `/purchasing/orders/${poId}/bills`, { billNumber: 'TL-77', billDate: '2026-09-07', lines: [{ poLineId: lineId, qty: 10, unitPricePaisa: '41500' }] });
    assert.equal(refused.status, 409);
    assert.match(message(refused.body), /Rs 4,150 billed for 10 units received at the order.s Rs 400 \(Rs 4,000\): over by Rs 150, more than the Rs 100 tolerance/);
    const billed = await call('POST', `/purchasing/orders/${poId}/bills`, {
      billNumber: 'TL-77',
      billDate: '2026-09-07',
      taxPaisa: '64000',
      lines: [{ poLineId: lineId, qty: 10, unitPricePaisa: '40000' }],
    });
    assert.deepEqual([billed.status, billed.body['total']], [201, '464000']);
    const bills = (await call('GET', '/purchasing/bills?unpaid=true')).body['bills'] as Array<Record<string, unknown>>;
    assert.deepEqual([bills[0]!['dueOn'], bills[0]!['outstanding']], ['2026-09-22', '464000']);
    const paid = await call('POST', `/purchasing/bills/${billed.body['billId']}/payments`, { amountPaisa: '464000', paidOn: '2026-09-20', method: 'bank_transfer', reference: 'TT-9' });
    assert.deepEqual([paid.status, paid.body['outstanding']], [201, '0']);
    assert.equal((await detail())['status'], 'paid');
    const vendors = (await call('GET', '/purchasing/vendors')).body['vendors'] as Array<Record<string, unknown>>;
    assert.deepEqual([vendors[0]!['payable'], vendors[0]!['receivedNotBilled']], ['0', '0'], 'billed, paid, nothing owed');

    const audit = await s.schema.sql<{ action: string }[]>`select action from audit_log a join users u on u.id = a.actor_id where u.email = ${config.auth.email.toLowerCase()} order by a.id`;
    assert.deepEqual(audit.map((a) => a.action), [
      'vendor.create', 'purchase_request.create', 'quotation.create', 'purchase_order.create', 'goods_receipt.create', 'goods_receipt.create', 'vendor_bill.create', 'vendor_payment.create',
    ]);
  });

  it('serves reorder suggestions and the tolerance setting, validated and audited', async () => {
    const suggestions = await call('GET', '/purchasing/reorder-suggestions?store=nur&windowDays=30');
    assert.equal(suggestions.status, 200);
    assert.ok(Array.isArray(suggestions.body['suggestions']));
    assert.equal((await call('GET', '/purchasing/reorder-suggestions?windowDays=2')).status, 400);
    const current = (await call('GET', '/settings/purchasing')).body['purchasing'] as Record<string, unknown>;
    assert.deepEqual([current['tolerancePercent'], current['toleranceAbsolutePaisa']], [2, 10000]);
    assert.equal((await call('PUT', '/settings/purchasing', { ...current, tolerancePercent: 80 })).status, 400);
    assert.equal((await call('PUT', '/settings/purchasing', { ...current, tolerancePercent: 1 })).status, 200);
    const [row] = await s.schema.sql`select 1 from audit_log where action = 'settings.update' and entity_id = 'purchasing'`;
    assert.ok(row);
  });
});
