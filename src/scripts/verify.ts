/**
 * Read-only connection check for every configured integration.
 * Run with: npm run verify
 *
 * Makes no changes anywhere: it lists PostEx statuses and a couple of days of parcels, and asks
 * Shopify for the shop name and its granted scopes.
 */
import { config, isShopifyStoreReady } from '../config.js';
import { checkDb } from '../db.js';
import { postexClient } from '../integrations/postex/client.js';
import { shopifyClient } from '../integrations/shopify/client.js';

const ymd = (date: Date) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

const line = (label: string, detail: string) => console.log(`  ${label.padEnd(26)} ${detail}`);

const run = async (): Promise<void> => {
  console.log(`\nDatabase`);
  const database = await checkDb();
  line('connection', database.status === 'ok' ? `ok (${database.latencyMs} ms)` : (database.error ?? database.status));

  console.log(`\nShopify (API ${config.shopify.apiVersion})`);
  if (config.shopify.stores.length === 0) line('stores', 'none configured');
  for (const store of config.shopify.stores) {
    if (!isShopifyStoreReady(store)) {
      line(store.key, 'credentials incomplete');
      continue;
    }
    try {
      const data = await shopifyClient(store.key).graphql<{
        shop: { name: string; currencyCode: string };
        currentAppInstallation: { accessScopes: Array<{ handle: string }> };
      }>('{ shop { name currencyCode } currentAppInstallation { accessScopes { handle } } }');
      line(store.key, `${data.shop.name} (${data.shop.currencyCode}) — ${data.currentAppInstallation.accessScopes.length} scopes`);
    } catch (error) {
      line(store.key, `FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`\nPostEx (writes ${config.postex.allowWrites ? 'ENABLED' : 'disabled'})`);
  if (config.postex.accounts.length === 0) line('accounts', 'none configured');
  for (const account of config.postex.accounts) {
    const client = postexClient(account.key);
    try {
      const statuses = await client.getOrderStatuses();
      const parcels = await client.listOrders({ from: ymd(daysAgo(7)), to: ymd(new Date()) });
      const delivered = parcels.filter((p) => /^delivered$/i.test(p.transactionStatus)).length;
      const returned = parcels.filter((p) => /^return(ed)?$/i.test(p.transactionStatus)).length;
      line(account.key, `${statuses.length} statuses · last 7 days: ${parcels.length} parcels, ${delivered} delivered, ${returned} returned`);
    } catch (error) {
      line(account.key, `FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.log();
};

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
