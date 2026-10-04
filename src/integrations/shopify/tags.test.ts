import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import { ShopifyClient, ShopifyError } from './client.js';

const client = () => new ShopifyClient({ key: 'nur', label: 'NUR', shop: 'example', accessToken: 'shpat_test' });

const respond = (body: unknown, status = 200) => mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(body), { status }));

afterEach(() => mock.restoreAll());

describe('setting an order\'s tags in Shopify', () => {
  it('adds and removes in one request, on the order\'s global id, and nothing else', async () => {
    const fetch = respond({ data: { added: { userErrors: [] }, removed: { userErrors: [] } } });
    await client().setOrderTags('1234', ['Order Confirmed'], ['Confirmation Pending']);
    assert.equal(fetch.mock.callCount(), 1);
    const [url, init] = fetch.mock.calls[0]!.arguments as [string, RequestInit];
    assert.match(url, /^https:\/\/example\.myshopify\.com\/admin\/api\/.+\/graphql\.json$/);
    const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    assert.match(body.query, /tagsAdd/);
    assert.match(body.query, /tagsRemove/);
    assert.deepEqual(body.variables, { id: 'gid://shopify/Order/1234', add: ['Order Confirmed'], remove: ['Confirmation Pending'] });
  });

  it('only asks for what it needs: no remove call when there is nothing to remove, no call at all for nothing', async () => {
    const fetch = respond({ data: { added: { userErrors: [] } } });
    await client().setOrderTags('1', ['Order Confirmed'], []);
    const body = JSON.parse(String((fetch.mock.calls[0]!.arguments[1] as RequestInit).body)) as { query: string; variables: Record<string, unknown> };
    assert.doesNotMatch(body.query, /tagsRemove/);
    assert.deepEqual(Object.keys(body.variables).sort(), ['add', 'id']);
    await client().setOrderTags('1', [], []);
    assert.equal(fetch.mock.callCount(), 1);
  });

  it('fails with Shopify\'s own words when it refuses a tag, so the caller can show them', async () => {
    respond({ data: { added: { userErrors: [{ message: 'Tags cannot be longer than 255 characters' }] } } });
    await assert.rejects(client().setOrderTags('1', ['x'], []), (error: unknown) => error instanceof ShopifyError && /255 characters/.test(error.message));
  });

  it('fails clearly when the app lacks the write_orders scope', async () => {
    respond({ errors: [{ message: 'Access denied for tagsAdd field. Required access: `write_orders` access scope.', extensions: { code: 'ACCESS_DENIED' } }] });
    await assert.rejects(client().setOrderTags('1', ['x'], []), (error: unknown) => error instanceof ShopifyError && /write_orders/.test(error.message) && error.code === 'ACCESS_DENIED');
  });
});
