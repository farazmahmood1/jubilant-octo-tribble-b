import { config, isShopifyStoreReady } from '../../config.js';
import { shopifyClient } from './client.js';

/**
 * What each store's app has been granted, read from Shopify itself. The platform only writes to
 * Shopify for two features, and Shopify refuses both until the store owner adds the scope to the
 * app and approves it: order tags and cancelling a returned order need `write_orders`, putting
 * units back into stock needs `write_inventory`. Screens use this to say so up front instead of
 * failing on the first click.
 */

export interface ShopifyAccess {
  store: string;
  /** Null when Shopify could not be asked; `error` says why. */
  scopes: string[] | null;
  writeOrders: boolean | null;
  writeInventory: boolean | null;
  error: string | null;
  checkedAt: Date;
}

// Scopes change only when someone edits the app, so a few minutes' reuse is safe.
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, ShopifyAccess>();

const has = (scopes: readonly string[], scope: string): boolean => scopes.includes(scope);

export const shopifyAccess = async (store: string, options: { fresh?: boolean } = {}): Promise<ShopifyAccess> => {
  const cached = cache.get(store);
  if (!options.fresh && cached && Date.now() - cached.checkedAt.getTime() < CACHE_MS) return cached;
  const settings = config.shopify.stores.find((s) => s.key === store);
  let access: ShopifyAccess;
  if (!settings || !isShopifyStoreReady(settings)) {
    access = { store, scopes: null, writeOrders: null, writeInventory: null, error: 'Shopify is not configured for this store', checkedAt: new Date() };
  } else {
    try {
      const data = await shopifyClient(store).graphql<{ currentAppInstallation: { accessScopes: Array<{ handle: string }> } }>(
        '{ currentAppInstallation { accessScopes { handle } } }',
      );
      const scopes = data.currentAppInstallation.accessScopes.map((s) => s.handle).sort();
      access = { store, scopes, writeOrders: has(scopes, 'write_orders'), writeInventory: has(scopes, 'write_inventory'), error: null, checkedAt: new Date() };
    } catch (error) {
      access = { store, scopes: null, writeOrders: null, writeInventory: null, error: error instanceof Error ? error.message : 'Shopify did not answer', checkedAt: new Date() };
    }
  }
  // A failed check is not kept: the next screen asks again.
  if (access.error === null) cache.set(store, access);
  return access;
};

export const allShopifyAccess = async (options: { fresh?: boolean } = {}): Promise<ShopifyAccess[]> =>
  Promise.all(config.shopify.stores.map((s) => shopifyAccess(s.key, options)));

/** Forgets what was read, for tests. */
export const clearShopifyAccess = (): void => cache.clear();
