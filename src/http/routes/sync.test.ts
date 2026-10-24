import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../../app.js';
import { config } from '../../config.js';

/**
 * The cron route is outside the signed-in API and guarded by its own secret: it does not exist on
 * a deploy that has not set CRON_SECRET, and refuses any other secret before touching a job.
 */
describe('/internal/cron', () => {
  let server: Server;
  let base: string;
  const sync = config.sync as { cronSecret: string | undefined };
  const saved = sync.cronSecret;

  before(async () => {
    server = createApp({ sql: () => null }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    sync.cronSecret = saved;
    await new Promise((resolve) => server.close(resolve));
  });

  it('is not there without a CRON_SECRET', async () => {
    sync.cronSecret = undefined;
    assert.equal((await fetch(`${base}/internal/cron`)).status, 404);
  });

  it('refuses a missing or wrong secret, by GET (Vercel Cron) and by POST', async () => {
    sync.cronSecret = 'a-test-secret-long-enough';
    assert.equal((await fetch(`${base}/internal/cron`)).status, 401);
    assert.equal((await fetch(`${base}/internal/cron`, { headers: { authorization: 'Bearer wrong-secret-of-some-length' } })).status, 401);
    assert.equal((await fetch(`${base}/internal/cron`, { method: 'POST', headers: { authorization: 'Bearer a-test-secret-long-enough-but-not' } })).status, 401);
  });

  it('with the right secret, gets as far as the database (none here, so 503)', async () => {
    sync.cronSecret = 'a-test-secret-long-enough';
    const response = await fetch(`${base}/internal/cron`, { headers: { authorization: 'Bearer a-test-secret-long-enough' } });
    assert.equal(response.status, 503);
  });
});
