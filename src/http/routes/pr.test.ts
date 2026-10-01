import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../../app.js';
import { createSessionToken } from '../../auth/session.js';
import { config } from '../../config.js';
import { skipWithoutDb } from '../../test/db.js';
import { parcel } from '../../test/inventory.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';

/** PR sends through the real app: detect, classify, post. Handles and URLs are made up. */
describe('API: PR', { skip: skipWithoutDb }, () => {
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
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    const shipmentId = await parcel(s.schema.sql, { accountId: account!.id, orderId: null, events: [['0005', '2026-09-03T10:00:00Z']] });
    await s.schema.sql`update shipments set cod_amount_paisa = 0 where id = ${shipmentId}`;
    token = await createSessionToken({ email: config.auth.email, name: 'Owner', role: 'owner' });
    server = createApp({ sql: () => s.schema.sql, webhooks: () => null }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await s?.schema.drop();
  });

  it('refuses without a session', async () => {
    assert.equal((await call('GET', '/pr/sends', undefined, false)).status, 401);
    assert.equal((await call('POST', '/pr/detect', {}, false)).status, 401);
  });

  it('detects a zero-COD parcel as a suggestion, a person classifies it, and a post is linked to it', async () => {
    assert.deepEqual((await call('POST', '/pr/detect', {})).body, { tagged: 0, fullDiscount: 0, zeroCod: 1 });
    assert.deepEqual((await call('POST', '/pr/detect', {})).body, { tagged: 0, fullDiscount: 0, zeroCod: 0 });
    const suggested = (await call('GET', '/pr/sends?status=suggested')).body['sends'] as Array<Record<string, unknown>>;
    assert.equal(suggested.length, 1);
    const influencer = await call('POST', '/influencers', { handle: 'test.creator', name: 'Test Creator' });
    const sendId = String(suggested[0]!['id']);
    assert.equal((await call('POST', `/pr/sends/${sendId}/classify`, { classification: 'maybe' })).status, 400);
    const classified = await call('POST', `/pr/sends/${sendId}/classify`, { classification: 'pr', influencerId: influencer.body['id'] });
    assert.equal(classified.status, 200, JSON.stringify(classified.body));
    const pr = (await call('GET', '/pr/sends?status=pr')).body['sends'] as Array<Record<string, unknown>>;
    assert.deepEqual([pr[0]!['influencer'], pr[0]!['classification']], ['Test Creator', 'pr']);
    const posted = await call('POST', `/influencers/${influencer.body['id']}/posts`, { url: 'https://example.com/p/1', kind: 'story', postedAt: '2026-09-05T12:00:00+05:00', prSendId: sendId });
    assert.equal(posted.status, 201);
    assert.equal(((await call('GET', `/influencers/${influencer.body['id']}/posts`)).body['posts'] as unknown[]).length, 1);
    const [audit] = await s.schema.sql`select 1 from audit_log a join users u on u.id = a.actor_id where a.action = 'pr_send.classify' and u.email = ${config.auth.email.toLowerCase()}`;
    assert.ok(audit, 'the decision is audited with the person');
  });
});
