import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createApp } from '../../app.js';
import { createSessionToken } from '../../auth/session.js';
import { config } from '../../config.js';
import { postShipmentAccounting } from '../../domain/accounting.js';
import { reconcileShipmentStock } from '../../domain/stock.js';
import { skipWithoutDb } from '../../test/db.js';
import { orderWithLines, parcel, variantsIn } from '../../test/inventory.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';

/** The breakdown routes through the real app over one delivered parcel. */
describe('API: breakdowns', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let server: Server;
  let base: string;
  let token: string;
  let variant: string;
  let shipmentId: string;

  const call = async (path: string, auth = true) => {
    const response = await fetch(`${base}/api/v1${path}`, { headers: auth ? { Authorization: `Bearer ${token}` } : {} });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  before(async () => {
    s = await migratedWithStores();
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    [variant] = (await variantsIn(s.schema.sql, s.nur, 1)) as [string];
    await s.schema.sql`insert into product_costs (variant_id, unit_cost_paisa, effective_from, source) values (${variant}, '40000', '2026-01-01', 'manual')`;
    const orderId = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#R1', placedAt: new Date('2026-09-01T05:00:00Z'), totalPaisa: 250_000n, lines: [{ variantId: variant, qty: 1 }] });
    await s.schema.sql`update orders set discount_codes = '{GLOW10}' where id = ${orderId}`;
    const [influencer] = await s.schema.sql<{ id: string }[]>`insert into influencers (handle, name) values ('test.creator', 'Test Creator') returning id`;
    await s.schema.sql`insert into influencer_codes (influencer_id, store_id, discount_code) values (${influencer!.id}, ${s.nur}, 'glow10')`;
    shipmentId = await parcel(s.schema.sql, { accountId: account!.id, orderId, events: [['0005', '2026-09-03T10:00:00Z']] });
    await s.schema.sql`update shipments set cod_amount_paisa = 250000 where id = ${shipmentId}`;
    await reconcileShipmentStock(s.schema.sql, shipmentId);
    await postShipmentAccounting(s.schema.sql, shipmentId);
    token = await createSessionToken({ email: config.auth.email, name: 'Owner', role: 'owner' });
    server = createApp({ sql: () => s.schema.sql, webhooks: () => null }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server?.close();
    await s?.schema.drop();
  });

  it('serves the influencer breakdown with people, not raw codes, and drills into it', async () => {
    assert.equal((await call('/reports/breakdowns/influencer', false)).status, 401);
    const { body } = await call('/reports/breakdowns/influencer?from=2026-09-01&to=2026-09-30&store=nur');
    const rows = body['rows'] as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((r) => [r['label'], r['revenue'], r['goods']]), [['Test Creator (@test.creator)', '250000', '40000']]);
    const drill = await call(`/reports/breakdowns/influencer/drill?key=${encodeURIComponent(String(rows[0]!['key']))}`);
    assert.deepEqual(drill.body['shipmentIds'], [shipmentId]);
    assert.equal((await call('/reports/breakdowns/colour')).status, 400);
    assert.equal((await call('/reports/breakdowns/month?from=2026-02-30')).status, 400);
  });

  it('serves the product breakdown, adding up to the ledger', async () => {
    const { body } = await call('/reports/products');
    assert.deepEqual([body['revenue'], body['goods']], ['250000', '40000']);
    const rows = body['rows'] as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((r) => [r['key'], r['units'], r['revenue'], r['grossProfit']]), [[variant, 1, '250000', '210000']]);
    assert.deepEqual((await call(`/reports/products/drill?key=${variant}`)).body['shipmentIds'], [shipmentId]);
  });
});
