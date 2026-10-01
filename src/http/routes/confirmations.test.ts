import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';

import { createApp } from '../../app.js';
import { createSessionToken } from '../../auth/session.js';
import { config } from '../../config.js';
import { recomputeOrderState } from '../../db/repos/order-state.js';
import { scanReconciliation } from '../../jobs/reconciliation.js';
import type { Logger } from '../../logger.js';
import { skipWithoutDb } from '../../test/db.js';
import { orderWithLines, variantsIn } from '../../test/inventory.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';
import { withoutPhones } from './confirmations.js';

/** The Confirmation Desk routes through the real app, against a scratch schema. Phones are made up. */
describe('API: Confirmation Desk', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let server: Server;
  let base: string;
  let token: string;
  let orderId: string;

  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const response = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  before(async () => {
    s = await migratedWithStores();
    const [variant] = await variantsIn(s.schema.sql, s.nur, 1);
    orderId = await orderWithLines(s.schema.sql, {
      storeId: s.nur,
      number: '#5001',
      placedAt: new Date(Date.now() - 2 * 3_600_000),
      phone: '+923000000801',
      city: 'Lahore',
      lines: [{ variantId: variant!, qty: 1 }],
    });
    await recomputeOrderState(s.schema.sql, orderId);
    token = await createSessionToken({ email: config.auth.email, name: 'Owner', role: 'owner' });
    server = createApp({ sql: () => s.schema.sql, webhooks: () => null }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await s?.schema.drop();
  });

  it('refuses every route without a session', async () => {
    for (const path of ['/confirmations/queue', `/confirmations/orders/${orderId}`, '/confirmations/history?phone=03000000801', '/confirmations/agents', '/confirmations/alerts', '/settings/confirmation-desk']) {
      assert.equal((await call('GET', path, undefined, false)).status, 401, path);
    }
    assert.equal((await call('POST', `/confirmations/orders/${orderId}/attempts`, { channel: 'call', outcome: 'confirmed' }, false)).status, 401);
  });

  it('serves the queue with the click-to-chat link, and one order with its history', async () => {
    const { status, body } = await call('GET', '/confirmations/queue?due=now&pageSize=10');
    assert.equal(status, 200);
    const rows = body['rows'] as Array<Record<string, unknown>>;
    assert.equal(body['total'], 1);
    assert.deepEqual([rows[0]!['orderNumber'], rows[0]!['state'], rows[0]!['phone'], rows[0]!['due']], ['#5001', 'pending', '+923000000801', true]);
    assert.match(String(rows[0]!['whatsappUrl']), /^https:\/\/wa\.me\/923000000801\?text=.*%235001/);
    assert.equal((await call('GET', '/confirmations/queue?state=bogus')).status, 400);

    const one = await call('GET', `/confirmations/orders/${orderId}`);
    assert.equal((one.body['order'] as Record<string, unknown>)['orderNumber'], '#5001');
    assert.equal((one.body['history'] as Record<string, unknown>)['phone'], '+923000000801');
    assert.equal((await call('GET', '/confirmations/orders/999999')).status, 404);
    assert.equal((await call('GET', '/confirmations/history?phone=not-a-number')).status, 400);
  });

  it('records outcomes as the signed-in user, audits each, and answers 409 or 400 for what cannot be recorded', async () => {
    const noAnswer = await call('POST', `/confirmations/orders/${orderId}/attempts`, { channel: 'whatsapp', outcome: 'no_answer', note: 'Two ticks, no reply' });
    assert.equal(noAnswer.status, 201, JSON.stringify(noAnswer.body));
    assert.equal((noAnswer.body['confirmation'] as Record<string, unknown>)['state'], 'no_answer');
    const followUp = await call('POST', `/confirmations/orders/${orderId}/follow-up`, { at: new Date(Date.now() + 3_600_000).toISOString() });
    assert.equal(followUp.status, 201);
    assert.equal((await call('POST', `/confirmations/orders/${orderId}/follow-up`, { at: '2020-01-01T00:00:00Z' })).status, 409);
    assert.equal((await call('POST', `/confirmations/orders/${orderId}/attempts`, { channel: 'call', outcome: 'cancelled' })).status, 409, 'no reason');
    assert.equal((await call('POST', `/confirmations/orders/${orderId}/attempts`, { channel: 'pigeon', outcome: 'confirmed' })).status, 400);
    assert.equal((await call('POST', `/confirmations/orders/${orderId}/attempts`, { channel: 'call', outcome: 'rescheduled' })).status, 400, 'a follow-up has its own route');
    const confirmed = await call('POST', `/confirmations/orders/${orderId}/attempts`, { channel: 'call', outcome: 'confirmed' });
    assert.deepEqual([confirmed.status, confirmed.body['orderState']], [201, 'ready_to_book']);

    const audit = await s.schema.sql<{ action: string; email: string }[]>`
      select a.action, u.email from audit_log a join users u on u.id = a.actor_id where a.entity = 'orders' and a.entity_id = ${orderId} order by a.id
    `;
    assert.deepEqual(audit.map((a) => a.action), ['confirmation.no_answer', 'confirmation.rescheduled', 'confirmation.confirmed']);
    assert.ok(audit.every((a) => a.email === config.auth.email.toLowerCase()), 'the agent is the signed-in user');

    const agents = await call('GET', '/confirmations/agents');
    const me = (agents.body['agents'] as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual([me['contacts'], me['confirmed'], me['noAnswer']], [2, 1, 1]);
    assert.equal((await call('GET', '/confirmations/agents?from=2026-02-30')).status, 400);
  });

  it('lists the desk alerts the scan raised', async () => {
    await scanReconciliation({ sql: s.schema.sql, logger: pino({ level: 'silent' }) as unknown as Logger, now: () => new Date(Date.now() + 25 * 3_600_000) });
    const { body } = await call('GET', '/confirmations/alerts');
    const alerts = body['alerts'] as Array<Record<string, unknown>>;
    assert.deepEqual(alerts.map((a) => [a['kind'], a['orderId'], a['store']]), [['confirmed_not_booked', orderId, 'nur']]);
  });

  it('desk settings: validated (unknown placeholders, hours), audited, and used for the next link', async () => {
    const current = (await call('GET', '/settings/confirmation-desk')).body['confirmationDesk'] as Record<string, unknown>;
    assert.equal(current['maxAttempts'], 3);
    const bad = await call('PUT', '/settings/confirmation-desk', { ...current, whatsappTemplates: { nur: 'Hi {nickname}', organics: 'Hi' } });
    assert.equal(bad.status, 400);
    assert.match(String((bad.body['error'] as Record<string, unknown>)['message']), /unknown placeholders: \{nickname\}/);
    assert.equal((await call('PUT', '/settings/confirmation-desk', { ...current, deskHours: { open: '22:00', close: '10:00' } })).status, 400);
    const saved = await call('PUT', '/settings/confirmation-desk', { ...current, maxAttempts: 4, whatsappTemplates: { nur: 'Salam {firstName}, {orderNumber}?', organics: 'Hi' } });
    assert.equal(saved.status, 200);
    const [audit] = await s.schema.sql`select 1 from audit_log where action = 'settings.update' and entity_id = 'confirmation_desk'`;
    assert.ok(audit);
    const one = await call('GET', `/confirmations/orders/${orderId}`);
    assert.match(String((one.body['order'] as Record<string, unknown>)['whatsappUrl']), /text=Salam%20there%2C%20%235001%3F$/);
  });

  it('the accountant role gets no phone number or contact link (1.9)', () => {
    const row = { orderId: '1', phone: '+923000000801', whatsappUrl: 'https://wa.me/923000000801', callUrl: 'tel:+923000000801' };
    assert.deepEqual(withoutPhones(row, 'accountant'), { orderId: '1', phone: null, whatsappUrl: null, callUrl: null });
    assert.deepEqual(withoutPhones(row, 'agent'), row);
  });
});
