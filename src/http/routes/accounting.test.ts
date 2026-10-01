import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../../app.js';
import { createSessionToken } from '../../auth/session.js';
import { config } from '../../config.js';
import { payoutLines, postEntry } from '../../domain/accounting.js';
import { paisa } from '../../lib/money.js';
import { skipWithoutDb } from '../../test/db.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';

/** The accounting and confirmation-tag routes through the real app, against a scratch schema. */
describe('API: trial balance, ledger, month close, opening balances, confirmation tags', { skip: skipWithoutDb }, () => {
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
    await postEntry(s.schema.sql, {
      date: '2026-08-20',
      memo: 'August payout',
      source: { type: 'test', id: 'aug' },
      lines: payoutLines({ storeId: s.nur, postexAccountId: account!.id, amount: paisa(251_800n) }),
    });
    token = await createSessionToken({ email: config.auth.email, name: 'Owner', role: 'owner' });
    server = createApp({ sql: () => s.schema.sql, webhooks: () => null }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await s?.schema.drop();
  });

  it('refuses every route without a session', async () => {
    for (const path of ['/accounting/trial-balance', '/accounting/periods', '/accounting/opening-balances', '/settings/confirmation-tags']) {
      assert.equal((await call('GET', path, undefined, false)).status, 401, path);
    }
  });

  it('serves the trial balance as paisa strings, per brand, with the ledger behind each figure', async () => {
    const { body } = await call('GET', '/accounting/trial-balance?store=nur');
    assert.equal(body['balanced'], true);
    assert.deepEqual([body['debit'], body['credit']], ['251800', '251800']);
    const rows = body['rows'] as Array<{ code: string; debit: string; credit: string }>;
    assert.deepEqual(rows.map((r) => [r.code, r.debit, r.credit]), [['1000', '251800', '0'], ['1100', '0', '251800']]);
    assert.deepEqual((await call('GET', '/accounting/trial-balance?store=organics')).body['rows'], []);
    assert.deepEqual((await call('GET', '/accounting/trial-balance?to=2026-08-01')).body['rows'], [], 'before the entry');

    const ledger = await call('GET', '/accounting/accounts/1000/lines');
    const lines = ledger.body['lines'] as Array<{ memo: string; debit: string; date: string }>;
    assert.deepEqual(lines.map((l) => [l.date, l.memo, l.debit]), [['2026-08-20', 'August payout', '251800']]);
    assert.equal((await call('GET', '/accounting/trial-balance?to=20260801')).status, 400);
  });

  it('opening balances: posted with the difference as opening equity, replaced by reversal, audited', async () => {
    const first = await call('PUT', '/accounting/opening-balances', {
      date: '2026-09-30',
      lines: [
        { code: '1000', balancePaisa: '500000' },
        { code: '1300', balancePaisa: '1200000', store: 'nur' },
        { code: '2000', balancePaisa: '-300000' },
      ],
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body['replaced'], false);
    const current = await call('GET', '/accounting/opening-balances');
    const opening = current.body['opening'] as { date: string; lines: Array<{ code: string; balancePaisa: string; store: string | null }> };
    assert.equal(opening.date, '2026-09-30');
    assert.deepEqual(opening.lines.map((l) => [l.code, l.balancePaisa, l.store]).sort(), [['1000', '500000', null], ['1300', '1200000', 'nur'], ['2000', '-300000', null]]);
    const tb = (await call('GET', '/accounting/trial-balance')).body;
    assert.equal(tb['balanced'], true);
    const equity = (tb['rows'] as Array<{ code: string; credit: string }>).find((r) => r.code === '3100');
    assert.equal(equity?.credit, '1400000');

    // Entering the same again changes nothing; a correction reverses the old entry.
    assert.equal((await call('PUT', '/accounting/opening-balances', { date: '2026-09-30', lines: [{ code: '1000', balancePaisa: '500000' }, { code: '1300', balancePaisa: '1200000', store: 'nur' }, { code: '2000', balancePaisa: '-300000' }] })).body['replaced'], false);
    const corrected = await call('PUT', '/accounting/opening-balances', { date: '2026-09-30', lines: [{ code: '1000', balancePaisa: '650000' }] });
    assert.equal(corrected.body['replaced'], true);
    const [live] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from journal_entries where source_type = 'opening_balance' and reversed_by is null`;
    assert.equal(live?.n, 1);
    const audits = await s.schema.sql`select 1 from audit_log where action = 'accounting.opening_balances'`;
    assert.equal(audits.length, 2);

    assert.equal((await call('PUT', '/accounting/opening-balances', { date: '2026-09-30', lines: [{ code: '4000', balancePaisa: '-100' }] })).status, 400, 'not on a P&L account');
    assert.equal((await call('PUT', '/accounting/opening-balances', { date: '2026-09-30', lines: [{ code: '1000', balancePaisa: '12.50' }] })).status, 400, 'paisa only');
  });

  it('closes a month from the 5th of the next, once; after that nothing can be dated in it', async () => {
    const periods = (await call('GET', '/accounting/periods')).body['periods'] as Array<{ year: number; month: number; status: string; entries: number; closableFrom: string }>;
    const august = periods.find((p) => p.year === 2026 && p.month === 8);
    assert.deepEqual([august?.status, august?.entries, august?.closableFrom], ['open', 1, '2026-09-05']);

    assert.equal((await call('POST', '/accounting/periods/2026/8/close')).status, 200);
    const again = await call('POST', '/accounting/periods/2026/8/close');
    assert.deepEqual([again.status, (again.body['error'] as { message: string }).message], [409, 'Period 2026-08 is already closed']);
    const early = await call('POST', '/accounting/periods/2030/1/close');
    assert.deepEqual([early.status, (early.body['error'] as { message: string }).message], [409, 'Period 2030-01 can be closed from 2030-02-05, not before']);

    const closed = ((await call('GET', '/accounting/periods')).body['periods'] as Array<{ year: number; month: number; status: string; closedBy: string }>).find((p) => p.year === 2026 && p.month === 8);
    assert.deepEqual([closed?.status, closed?.closedBy], ['closed', config.auth.email]);
    const late = await call('PUT', '/accounting/opening-balances', { date: '2026-08-31', lines: [{ code: '1000', balancePaisa: '1' }] });
    assert.equal(late.status, 409);
    assert.match((late.body['error'] as { message: string }).message, /Period 2026-08 is closed/);
  });

  it("confirmation tags: the team's tags by default, replaced and audited", async () => {
    const current = await call('GET', '/settings/confirmation-tags');
    assert.deepEqual((current.body['confirmationTags'] as Record<string, string[]>)['confirmed'], ['Order Confirmed']);
    const tags = { confirmed: ['Order Confirmed', 'Confirmed by WhatsApp'], cancelled: ['Order Canceled'], pending: [], noAnswer: ['didnt answer the call'], unreachable: ['number off'] };
    assert.equal((await call('PUT', '/settings/confirmation-tags', tags)).status, 200);
    assert.deepEqual((await call('GET', '/settings/confirmation-tags')).body['confirmationTags'], tags);
    const [audit] = await s.schema.sql`select 1 from audit_log where action = 'settings.update' and entity_id = 'confirmation_tags'`;
    assert.ok(audit);
    assert.equal((await call('PUT', '/settings/confirmation-tags', { confirmed: 'x' })).status, 400);
  });
});
