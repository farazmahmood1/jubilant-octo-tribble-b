import { Router } from 'express';

import { config, isShopifyStoreReady } from '../../config.js';
import { postexClient } from '../../integrations/postex/client.js';
import { allShopifyAccess } from '../../integrations/shopify/access.js';
import { shopifyClient } from '../../integrations/shopify/client.js';

export const integrationsRouter: Router = Router();

/**
 * Which connections are configured. Reports readiness only, never a credential, so it is safe
 * to expose to the dashboard.
 */
integrationsRouter.get('/integrations/status', (_req, res) => {
  res.json({
    shopify: {
      apiVersion: config.shopify.apiVersion,
      stores: config.shopify.stores.map((store) => ({
        key: store.key,
        label: store.label,
        domain: `${store.shop}.myshopify.com`,
        configured: isShopifyStoreReady(store),
        auth: store.accessToken ? 'access_token' : store.clientId ? 'client_credentials' : 'missing',
      })),
    },
    postex: {
      writesEnabled: config.postex.allowWrites,
      accounts: config.postex.accounts.map((account) => ({ key: account.key, label: account.label, configured: true })),
    },
  });
});

/**
 * What Shopify has granted each store's app, and so whether tag changes and return check-ins can
 * be written there. Read from Shopify (cached for a few minutes); `refresh=true` asks again, for
 * right after the owner has approved a new scope.
 */
integrationsRouter.get('/integrations/shopify-access', async (req, res) => {
  const stores = await allShopifyAccess({ fresh: req.query['refresh'] === 'true' });
  res.json({ stores: stores.map((s) => ({ ...s, checkedAt: s.checkedAt.toISOString() })) });
});

export interface ConnectionHealth {
  key: string;
  label: string;
  detail: string;
  status: 'ok' | 'error' | 'not_configured';
  message?: string;
}

interface HealthPayload {
  checkedAt: string;
  shopify: ConnectionHealth[];
  postex: ConnectionHealth[];
}

// Each check costs a real API call, so the result is reused briefly.
const CACHE_MS = 60_000;
let cache: { at: number; payload: HealthPayload } | undefined;

const checkShopify = async (): Promise<ConnectionHealth[]> =>
  Promise.all(
    config.shopify.stores.map(async (store): Promise<ConnectionHealth> => {
      const base = { key: store.key, label: store.label, detail: `${store.shop}.myshopify.com` };
      if (!isShopifyStoreReady(store)) {
        return { ...base, status: 'not_configured', message: 'Client ID and secret missing' };
      }
      try {
        const data = await shopifyClient(store.key).graphql<{ shop: { name: string } }>('{ shop { name } }');
        return { ...base, status: 'ok', message: data.shop.name };
      } catch (error) {
        return { ...base, status: 'error', message: error instanceof Error ? error.message : 'Unreachable' };
      }
    }),
  );

const checkPostex = async (): Promise<ConnectionHealth[]> =>
  Promise.all(
    config.postex.accounts.map(async (account): Promise<ConnectionHealth> => {
      const base = { key: account.key, label: account.label, detail: 'COD merchant account' };
      try {
        const statuses = await postexClient(account.key).getOrderStatuses();
        return { ...base, status: 'ok', message: `${statuses.length} statuses` };
      } catch (error) {
        return { ...base, status: 'error', message: error instanceof Error ? error.message : 'Unreachable' };
      }
    }),
  );

/**
 * Actually calls Shopify and PostEx. "Configured" is not the same as "working": an app whose
 * keys are correct but which was never installed on the store fails here, and should.
 */
integrationsRouter.get('/integrations/health', async (req, res) => {
  const fresh = req.query['refresh'] === 'true';
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) {
    res.json(cache.payload);
    return;
  }

  const [shopify, postex] = await Promise.all([checkShopify(), checkPostex()]);
  const payload: HealthPayload = { checkedAt: new Date().toISOString(), shopify, postex };
  cache = { at: Date.now(), payload };
  res.json(payload);
});
