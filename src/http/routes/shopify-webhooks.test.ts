import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';

import express from 'express';
import { pino } from 'pino';

import { createApp } from '../../app.js';
import { listOpenReviewItems } from '../../db/repos/review.js';
import type { Logger } from '../../logger.js';
import { skipWithoutDb } from '../../test/db.js';
import { fixture } from '../../test/fixtures.js';
import { type FakeShopify, fakeShopify, order } from '../../test/shopify-fake.js';
import { type Stores, migratedWithStores } from '../../test/stores.js';
import { type WebhookDeps, signShopifyBody, verifyShopifyHmac } from '../../webhooks/shopify.js';
import { shopifyWebhookRouter } from './shopify-webhooks.js';

/** A fixed secret for tests only; production uses each store app's client secret. */
const SECRET = 'test-only-webhook-secret';
const SHOP = 'nurbyjuggun.myshopify.com';

describe('verifyShopifyHmac', () => {
  const body = Buffer.from(JSON.stringify(fixture('shopify-webhook-orders-create')));
  const signature = signShopifyBody(body, SECRET);

  it('accepts the signature of the exact bytes', () => {
    assert.equal(verifyShopifyHmac(body, signature, SECRET), true);
  });

  it('rejects a tampered body, a wrong secret, and a missing or malformed header', () => {
    const tampered = Buffer.from(body.toString().replace('1250.00', '1.00'));
    assert.equal(verifyShopifyHmac(tampered, signature, SECRET), false);
    assert.equal(verifyShopifyHmac(body, signature, 'another-secret'), false);
    assert.equal(verifyShopifyHmac(body, undefined, SECRET), false);
    assert.equal(verifyShopifyHmac(body, 'not-base64!', SECRET), false);
    assert.equal(verifyShopifyHmac(body, signature, ''), false);
  });

  it('is computed over bytes, so re-serialised JSON does not verify', () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    assert.equal(verifyShopifyHmac(reserialised, signature, SECRET), false);
  });
});

describe('POST /webhooks/shopify/:topic through the app', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let fake: FakeShopify;
  let server: Server;
  let base: string;
  let logLines: string[];
  let pending: Array<Promise<void>>;
  /** When false, processing is held until the test runs it, to show the response comes first. */
  let runDeferred = true;
  let held: Array<() => Promise<void>>;

  const deps = (): WebhookDeps => ({
    sql: s.schema.sql,
    logger: pino({ level: 'debug' }, { write: (line: string) => void logLines.push(line) }) as unknown as Logger,
    resolveStore: async (domain) =>
      domain === SHOP ? { key: 'nur', id: s.nur, shopDomain: SHOP, secret: SECRET, graphql: fake.graphql } : null,
    defer: (work) => {
      if (runDeferred) pending.push(work());
      else held.push(work);
    },
  });

  before(async () => {
    s = await migratedWithStores();
    fake = fakeShopify({
      orders: [
        order(1001, '2026-09-30T05:00:00Z', {
          customer: { id: 'gid://shopify/Customer/77', firstName: 'Test', lastName: 'Customer', phone: '0300 1234567' },
        }),
        order(1002, '2026-09-30T06:00:00Z'),
      ],
    });
    server = createApp({ webhooks: deps }).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await s?.schema.drop();
  });

  beforeEach(() => {
    logLines = [];
    pending = [];
    held = [];
    runDeferred = true;
  });

  const deliver = async (topic: string, body: string, headers: Record<string, string | undefined> = {}) => {
    const defaults: Record<string, string | undefined> = {
      'content-type': 'application/json',
      'x-shopify-shop-domain': SHOP,
      'x-shopify-topic': topic,
      'x-shopify-event-id': `evt-${Math.random().toString(36).slice(2)}`,
      'x-shopify-hmac-sha256': signShopifyBody(body, SECRET),
      ...headers,
    };
    const response = await fetch(`${base}/webhooks/shopify/${topic.replaceAll('/', '-')}`, {
      method: 'POST',
      headers: Object.fromEntries(Object.entries(defaults).filter(([, v]) => v !== undefined)) as Record<string, string>,
      body,
    });
    await Promise.all(pending);
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };

  const orderBody = JSON.stringify(fixture('shopify-webhook-orders-create'));
  const events = async () => [...(await s.schema.sql<{ topic: string; processed: boolean }[]>`select topic, processed_at is not null as processed from webhook_events order by id`)];

  it('accepts a correctly signed delivery, stores the event and processes it into an order', async () => {
    const result = await deliver('orders/create', orderBody);
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { received: true });
    assert.deepEqual(await events(), [{ topic: 'orders/create', processed: true }]);
    const [stored] = await s.schema.sql<{ order_number: string }[]>`select order_number from orders where shopify_order_id = 1001`;
    assert.equal(stored?.order_number, '#1001');
  });

  it('rejects a tampered body with 401, stores nothing, and logs without the body', async () => {
    const before = (await events()).length;
    const signature = signShopifyBody(orderBody, SECRET);
    const result = await deliver('orders/create', orderBody.replace('1250.00', '1.00'), { 'x-shopify-hmac-sha256': signature });
    assert.equal(result.status, 401);
    assert.equal((await events()).length, before);
    const log = logLines.join('\n');
    assert.match(log, /invalid signature/);
    assert.doesNotMatch(log, /total_price|1250\.00|1\.00|Lahore/, 'the body never reaches the log');
  });

  it('rejects a wrong secret, a missing signature and an unknown shop with 401', async () => {
    for (const headers of [
      { 'x-shopify-hmac-sha256': signShopifyBody(orderBody, 'wrong-secret') },
      { 'x-shopify-hmac-sha256': undefined },
      { 'x-shopify-shop-domain': 'someone-else.myshopify.com' },
    ]) {
      assert.equal((await deliver('orders/create', orderBody, headers)).status, 401, JSON.stringify(headers));
    }
  });

  it('processes the same event id once, however many times Shopify delivers it', async () => {
    const callsBefore = fake.calls.filter((c) => c.operation === 'Order').length;
    const body = JSON.stringify({ id: 1002, admin_graphql_api_id: 'gid://shopify/Order/1002' });
    const first = await deliver('orders/updated', body, { 'x-shopify-event-id': 'evt-dup-1' });
    const second = await deliver('orders/updated', body, { 'x-shopify-event-id': 'evt-dup-1' });
    assert.deepEqual([first.json, second.json], [{ received: true }, { duplicate: true }]);
    assert.equal(fake.calls.filter((c) => c.operation === 'Order').length - callsBefore, 1);
    const [row] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from webhook_events where shopify_event_id = 'evt-dup-1'`;
    assert.equal(row?.n, 1);
  });

  it('answers before processing: the event is stored but not yet processed when the 200 arrives', async () => {
    runDeferred = false;
    const result = await deliver('orders/updated', JSON.stringify({ id: 1002 }), { 'x-shopify-event-id': 'evt-slow' });
    assert.equal(result.status, 200);
    const [row] = await s.schema.sql<{ processed: boolean }[]>`select processed_at is not null as processed from webhook_events where shopify_event_id = 'evt-slow'`;
    assert.equal(row?.processed, false);
    await Promise.all(held.map((work) => work()));
    const [after] = await s.schema.sql<{ processed: boolean }[]>`select processed_at is not null as processed from webhook_events where shopify_event_id = 'evt-slow'`;
    assert.equal(after?.processed, true);
  });

  it('leaves an event unprocessed when processing fails, for the catch-up to retry', async () => {
    fake.failOnce('Order', 1 + fake.calls.filter((c) => c.operation === 'Order').length);
    const result = await deliver('orders/updated', JSON.stringify({ id: 1002 }), { 'x-shopify-event-id': 'evt-fails' });
    assert.equal(result.status, 200);
    const [row] = await s.schema.sql<{ processed: boolean }[]>`select processed_at is not null as processed from webhook_events where shopify_event_id = 'evt-fails'`;
    assert.equal(row?.processed, false);
    assert.match(logLines.join('\n'), /catch-up will retry/);
  });

  it('re-fetches the order for fulfillment and refund events', async () => {
    const target = fake.orders.find((o) => o.name === '#1002')!;
    target.displayFulfillmentStatus = 'FULFILLED';
    await deliver('fulfillments/create', JSON.stringify({ id: 5, order_id: 1002 }));
    const [fulfilled] = await s.schema.sql<{ status: string }[]>`select fulfillment_status as status from orders where shopify_order_id = 1002`;
    assert.equal(fulfilled?.status, 'fulfilled');

    target.displayFinancialStatus = 'REFUNDED';
    await deliver('refunds/create', JSON.stringify({ id: 6, order_id: 1002 }));
    const [refunded] = await s.schema.sql<{ status: string }[]>`select financial_status as status from orders where shopify_order_id = 1002`;
    assert.equal(refunded?.status, 'refunded');
  });

  it('answers 400 for a topic that does not match the URL, a missing event id, or a body that is not JSON', async () => {
    const mismatch = await fetch(`${base}/webhooks/shopify/orders-create`, {
      method: 'POST',
      headers: { 'x-shopify-shop-domain': SHOP, 'x-shopify-topic': 'orders/updated', 'x-shopify-event-id': 'e1', 'x-shopify-hmac-sha256': signShopifyBody(orderBody, SECRET) },
      body: orderBody,
    });
    assert.equal(mismatch.status, 400);
    assert.equal((await deliver('orders/create', orderBody, { 'x-shopify-event-id': undefined })).status, 400);
    assert.equal((await deliver('orders/create', 'not json')).status, 400);
  });

  it('acknowledges a topic we do not handle, without storing it', async () => {
    const before = (await events()).length;
    const result = await deliver('products/update', JSON.stringify({ id: 1 }));
    assert.deepEqual([result.status, result.json], [200, { ignored: true }]);
    assert.equal((await events()).length, before);
  });

  it('leaves JSON parsing working for every other route', async () => {
    // A wrong password only gets as far as "Wrong email or password" if the JSON body was parsed.
    const response = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'wrong' }),
    });
    assert.equal(response.status, 401);
    assert.match(JSON.stringify(await response.json()), /Wrong email or password/);
  });

  it('refuses loudly (500, with the reason logged) if express.json() is ever mounted first', async () => {
    const wrong = express().use(express.json()).use(shopifyWebhookRouter(deps)).listen(0);
    try {
      const response = await fetch(`http://127.0.0.1:${(wrong.address() as AddressInfo).port}/webhooks/shopify/orders-create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-shopify-shop-domain': SHOP, 'x-shopify-topic': 'orders/create', 'x-shopify-event-id': 'e2', 'x-shopify-hmac-sha256': signShopifyBody(orderBody, SECRET) },
        body: orderBody,
      });
      assert.equal(response.status, 500);
      assert.match(logLines.join('\n'), /express\.json\(\) must come after this router/);
    } finally {
      await new Promise((resolve) => wrong.close(resolve));
    }
  });

  it('customers/redact scrubs the customer, their orders\' raw data and the webhook payloads, and audits it', async () => {
    const result = await deliver('customers/redact', JSON.stringify(fixture('shopify-webhook-customers-redact')));
    assert.equal(result.status, 200);

    const [customer] = await s.schema.sql<{ name: string | null; phone: string | null; key: string; redacted: boolean }[]>`
      select name, phone_e164 as phone, external_key as key, redacted_at is not null as redacted from customers where shopify_customer_id = 77
    `;
    assert.equal(customer?.name, null);
    assert.equal(customer?.phone, null);
    assert.match(customer?.key ?? '', /^redacted:\d+$/);
    assert.equal(customer?.redacted, true);

    const [stored] = await s.schema.sql<{ raw: unknown }[]>`select raw from orders where shopify_order_id = 1001`;
    const raw = JSON.stringify(stored?.raw);
    assert.doesNotMatch(raw, /Test|Customer"|0300 1234567|House 1/);
    assert.match(raw, /Lahore/, 'the city is kept');

    const [address] = await s.schema.sql<{ line1: string | null; city: string | null }[]>`
      select line1, city from addresses where customer_id = (select id from customers where shopify_customer_id = 77)
    `;
    assert.deepEqual(address, { line1: null, city: 'Lahore' });

    const payloads = await s.schema.sql<{ payload: unknown }[]>`select payload from webhook_events where topic in ('orders/create', 'customers/redact')`;
    for (const { payload } of payloads) assert.doesNotMatch(JSON.stringify(payload), /0300 1234567|"Test"/);

    const [audit] = await s.schema.sql<{ action: string; after: Record<string, number> }[]>`select action, after from audit_log where action = 'gdpr.customers_redact'`;
    assert.equal(audit?.after['customers'], 1);
    assert.ok((audit?.after['orders'] ?? 0) >= 1);
  });

  it('customers/data_request queues the request for a person and audits it', async () => {
    const result = await deliver('customers/data_request', JSON.stringify({ shop_domain: SHOP, customer: { id: 78, email: '[masked]' }, orders_requested: [1002], data_request: { id: 9 } }));
    assert.equal(result.status, 200);
    const items = await listOpenReviewItems(s.schema.sql, 'gdpr_data_request', s.nur);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0]?.detail['ordersRequested'], ['1002']);
    const [audit] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'gdpr.customers_data_request'`;
    assert.equal(audit?.n, 1);
  });

  it('shop/redact scrubs every customer of that store and leaves the other store alone', async () => {
    await s.schema.sql`
      insert into customers (store_id, external_key, name, phone_e164) values
        (${s.nur}, 'phone:+923001111111', 'Another Customer', '+923001111111'),
        (${s.organics}, 'phone:+923002222222', 'Organics Customer', '+923002222222')
    `;
    const result = await deliver('shop/redact', JSON.stringify({ shop_id: 1, shop_domain: SHOP }));
    assert.equal(result.status, 200);
    const [nur] = await s.schema.sql<{ left: number }[]>`select count(*)::int as left from customers where store_id = ${s.nur} and (name is not null or phone_e164 is not null)`;
    assert.equal(nur?.left, 0);
    const [organics] = await s.schema.sql<{ name: string }[]>`select name from customers where store_id = ${s.organics}`;
    assert.equal(organics?.name, 'Organics Customer');
  });
});
