import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../../app.js';
import { createSessionToken } from '../../auth/session.js';
import { config } from '../../config.js';
import { skipWithoutDb } from '../../test/db.js';
import { orderWithLines } from '../../test/inventory.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';

/** Influencers and their codes through the real app, against a scratch schema. Handles are made up. */
describe('API: influencers and their discount codes', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let server: Server;
  let base: string;
  let token: string;

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
    for (const [i, codes] of [['glow10'], ['GLOW10', 'WELCOME5'], ['welcome5'], []].entries()) {
      const id = await orderWithLines(s.schema.sql, { storeId: s.nur, number: `#I${i}`, placedAt: new Date(`2026-09-0${i + 1}T06:00:00Z`), lines: [] });
      await s.schema.sql`update orders set discount_codes = ${codes}::text[] where id = ${id}`;
    }
    token = await createSessionToken({ email: config.auth.email, name: 'Owner', role: 'owner' });
    server = createApp({ sql: () => s.schema.sql, webhooks: () => null }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await s?.schema.drop();
  });

  it('refuses without a session', async () => {
    assert.equal((await call('GET', '/influencers', undefined, false)).status, 401);
    assert.equal((await call('POST', '/influencers', { handle: 'x', name: 'x' }, false)).status, 401);
  });

  it('lists the codes customers used that nobody owns, then assigns one, any case, and counts the orders it attributes', async () => {
    const unassigned = (await call('GET', '/influencers/unassigned-codes?store=nur')).body['codes'] as Array<{ code: string; orders: number }>;
    assert.deepEqual(unassigned.map((c) => [c.code.toUpperCase(), c.orders]), [['GLOW10', 2], ['WELCOME5', 2]]);

    const created = await call('POST', '/influencers', { handle: '@test.creator', name: 'Test Creator', city: 'Lahore', followers: 120_000 });
    assert.equal(created.status, 201);
    const id = String(created.body['id']);
    assert.equal((await call('POST', '/influencers', { handle: 'TEST.CREATOR', name: 'Again' })).status, 409, 'handles are unique, any case');
    assert.equal((await call('POST', '/influencers', { handle: 'not valid!', name: 'x' })).status, 400);

    const added = await call('POST', `/influencers/${id}/codes`, { store: 'nur', code: 'Glow10' });
    assert.deepEqual([added.status, added.body['orders']], [201, 2]);
    const [other] = await s.schema.sql<{ id: string }[]>`insert into influencers (handle, name) values ('someone.else', 'Someone Else') returning id`;
    const taken = await call('POST', `/influencers/${other!.id}/codes`, { store: 'nur', code: 'GLOW10' });
    assert.equal(taken.status, 409);
    assert.match(String((taken.body['error'] as Record<string, unknown>)['message']), /already Test Creator's code on nur/);
    assert.equal((await call('POST', `/influencers/${other!.id}/codes`, { store: 'organics', code: 'GLOW10' })).status, 201, 'the other brand is separate');

    const list = (await call('GET', '/influencers')).body['influencers'] as Array<{ handle: string; codes: Array<{ code: string; orders: number }> }>;
    assert.deepEqual(list.find((i) => i.handle === 'test.creator')?.codes.map((c) => [c.code, c.orders]), [['Glow10', 2]]);
    const remaining = (await call('GET', '/influencers/unassigned-codes?store=nur')).body['codes'] as Array<{ code: string }>;
    assert.deepEqual(remaining.map((c) => c.code.toUpperCase()), ['WELCOME5']);
  });

  it('updates and removes codes, each change audited with the signed-in user', async () => {
    const [row] = await s.schema.sql<{ id: string; code_id: string }[]>`
      select i.id, ic.id as code_id from influencers i join influencer_codes ic on ic.influencer_id = i.id where i.handle = 'test.creator'
    `;
    assert.equal((await call('PATCH', `/influencers/${row!.id}`, { followers: 150_000, isActive: false })).status, 200);
    assert.equal((await call('PATCH', '/influencers/999999', { name: 'x' })).status, 404);
    assert.equal((await call('DELETE', `/influencers/${row!.id}/codes/${row!.code_id}`)).status, 200);
    assert.equal((await call('DELETE', `/influencers/${row!.id}/codes/${row!.code_id}`)).status, 404);
    const audit = await s.schema.sql<{ action: string; email: string }[]>`
      select a.action, u.email from audit_log a join users u on u.id = a.actor_id where a.entity = 'influencers' and a.entity_id = ${row!.id} order by a.id
    `;
    assert.deepEqual(audit.map((a) => a.action), ['influencer.create', 'influencer.add_code', 'influencer.update', 'influencer.remove_code']);
    assert.ok(audit.every((a) => a.email === config.auth.email.toLowerCase()));
  });
});
