import type { ShopifyStoreConfig } from '../../config.js';
import { config, isShopifyStoreReady } from '../../config.js';
import { logger } from '../../logger.js';

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 4;

export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ShopifyError';
  }
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: { cost?: { requestedQueryCost: number; throttleStatus: { currentlyAvailable: number; restoreRate: number } } };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shopify Admin API client, one per store.
 *
 * Tokens come either from an older admin-created custom app (a static shpat_ token) or from the
 * client credentials grant, which returns a token valid for 24 hours and is cached here.
 */
export class ShopifyClient {
  private token?: { value: string; expiresAt: number };

  constructor(private readonly store: ShopifyStoreConfig) {}

  get key(): string {
    return this.store.key;
  }

  get domain(): string {
    return `${this.store.shop}.myshopify.com`;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const token = await this.accessToken();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const response = await fetch(`https://${this.domain}/admin/api/${config.shopify.apiVersion}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables }),
      });

      if (response.status === 429) {
        await sleep(2_000 * attempt);
        continue;
      }

      const body = (await response.json().catch(() => ({}))) as GraphqlResponse<T>;
      const message = body.errors?.map((e) => e.message).join('; ');

      if (message && /throttled/i.test(message) && attempt < MAX_ATTEMPTS) {
        await sleep(2_000 * attempt);
        continue;
      }
      if (!response.ok || message) {
        throw new ShopifyError(
          `Shopify ${this.store.key}: ${message ?? `HTTP ${response.status}`}`,
          body.errors?.[0]?.extensions?.code,
          response.status,
        );
      }
      if (!body.data) throw new ShopifyError(`Shopify ${this.store.key}: empty response`);

      // Cost-aware backoff: design against the lower documented limit rather than the current one.
      const throttle = body.extensions?.cost?.throttleStatus;
      if (throttle && throttle.currentlyAvailable < 300) {
        await sleep(((300 - throttle.currentlyAvailable) / throttle.restoreRate) * 1000);
      }
      return body.data;
    }
    throw new ShopifyError(`Shopify ${this.store.key}: throttled after ${MAX_ATTEMPTS} attempts`);
  }

  /**
   * Adds and removes tags on one order, leaving its other tags alone. The only write the platform
   * makes to Shopify; it needs the `write_orders` scope, which Shopify refuses without.
   */
  async setOrderTags(shopifyOrderId: string, add: readonly string[], remove: readonly string[]): Promise<void> {
    if (add.length === 0 && remove.length === 0) return;
    const parts = [
      add.length > 0 ? 'added: tagsAdd(id: $id, tags: $add) { userErrors { field message } }' : '',
      remove.length > 0 ? 'removed: tagsRemove(id: $id, tags: $remove) { userErrors { field message } }' : '',
    ].filter(Boolean);
    const query = `mutation OrderTags($id: ID!${add.length > 0 ? ', $add: [String!]!' : ''}${remove.length > 0 ? ', $remove: [String!]!' : ''}) { ${parts.join(' ')} }`;
    const result = await this.graphql<Record<'added' | 'removed', { userErrors: Array<{ message: string }> } | undefined>>(query, {
      id: `gid://shopify/Order/${shopifyOrderId}`,
      ...(add.length > 0 ? { add } : {}),
      ...(remove.length > 0 ? { remove } : {}),
    });
    const refused = [...(result.added?.userErrors ?? []), ...(result.removed?.userErrors ?? [])].map((e) => e.message);
    if (refused.length > 0) throw new ShopifyError(`Shopify ${this.store.key}: ${refused.join('; ')}`);
  }

  private async accessToken(): Promise<string> {
    if (this.store.accessToken) return this.store.accessToken;
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return this.token.value;

    const { clientId, clientSecret } = this.store;
    if (!clientId || !clientSecret) {
      throw new ShopifyError(`Shopify ${this.store.key}: no access token and no client ID/secret configured`);
    }

    const response = await fetch(`https://${this.domain}/admin/oauth/access_token`, {
      method: 'POST',
      // Without Accept, Shopify answers errors with an HTML page instead of JSON.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !body.access_token) {
      const hint =
        body.error === 'app_not_installed'
          ? ' — release a version and install the app on this store from the Dev Dashboard'
          : body.error === 'shop_not_permitted'
            ? ' — the app and the store must belong to the same Shopify organization'
            : '';
      throw new ShopifyError(
        `Shopify ${this.store.key}: ${body.error ?? `HTTP ${response.status}`}${body.error_description ? ` (${body.error_description})` : ''}${hint}`,
        body.error,
        response.status,
      );
    }

    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 86_399) * 1000 };
    logger.debug({ store: this.store.key }, 'Shopify access token refreshed');
    return this.token.value;
  }
}

const clients = new Map<string, ShopifyClient>();

export const shopifyClient = (storeKey: string): ShopifyClient => {
  const existing = clients.get(storeKey);
  if (existing) return existing;
  const store = config.shopify.stores.find((s) => s.key === storeKey);
  if (!store) throw new Error(`No Shopify store configured for "${storeKey}"`);
  if (!isShopifyStoreReady(store)) throw new ShopifyError(`Shopify ${storeKey}: credentials incomplete`);
  const client = new ShopifyClient(store);
  clients.set(storeKey, client);
  return client;
};

export const shopifyClients = (): ShopifyClient[] =>
  config.shopify.stores.filter(isShopifyStoreReady).map((s) => shopifyClient(s.key));
