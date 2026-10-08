import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { ShopifyClient, ShopifyError } from './client.js';

/** The client against a fetch that answers as Shopify does. No network; the token is made up. */
describe('ShopifyClient errors', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const answer = (status: number, body: unknown) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  };
  const client = () => new ShopifyClient({ key: 'nur', label: 'NUR', shop: 'example-test', accessToken: 'test-token-not-real' });

  it('says what Shopify said when it refuses the request with a plain string (a bad token, an unknown shop)', async () => {
    answer(401, { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' });
    await assert.rejects(client().graphql('{ shop { name } }'), (error: unknown) => error instanceof ShopifyError && /Invalid API key/.test(error.message) && error.httpStatus === 401);
  });

  it('joins GraphQL errors and keeps the first code', async () => {
    answer(200, { errors: [{ message: 'Access denied for orderCancel field.', extensions: { code: 'ACCESS_DENIED' } }] });
    await assert.rejects(client().graphql('mutation { x }'), (error: unknown) => error instanceof ShopifyError && /Access denied/.test(error.message) && error.code === 'ACCESS_DENIED');
  });

  it('returns the data of a good answer', async () => {
    answer(200, { data: { shop: { name: 'Test' } } });
    assert.deepEqual(await client().graphql('{ shop { name } }'), { shop: { name: 'Test' } });
  });
});
