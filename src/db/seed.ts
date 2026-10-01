import type { PostexAccountConfig, ShopifyStoreConfig } from '../config.js';
import { config } from '../config.js';
import type { Sql } from '../db.js';

export interface SeedInput {
  stores: Pick<ShopifyStoreConfig, 'key' | 'label' | 'shop'>[];
  postexAccounts: Pick<PostexAccountConfig, 'key' | 'label'>[];
}

export interface SeedResult {
  stores: number;
  postexAccounts: number;
}

/**
 * Upserts `stores` and `postex_accounts` from the env-driven config, so the setup that works
 * today keeps working once the rest of the schema refers to these rows by id.
 *
 * Rows are only ever inserted or relabelled, never deleted: a store dropped from .env still
 * owns its orders. An update that would change nothing is skipped, so seeding twice leaves
 * every row, `updated_at` included, exactly as it was.
 */
export const seed = async (
  sql: Sql,
  input: SeedInput = { stores: config.shopify.stores, postexAccounts: config.postex.accounts },
): Promise<SeedResult> =>
  sql.begin(async (tx) => {
    let stores = 0;
    for (const store of input.stores) {
      const rows = await tx`
        insert into stores (key, label, shop_domain)
        values (${store.key}, ${store.label}, ${`${store.shop}.myshopify.com`})
        on conflict (key) do update
          set label = excluded.label, shop_domain = excluded.shop_domain
          where (stores.label, stores.shop_domain) is distinct from (excluded.label, excluded.shop_domain)
        returning id
      `;
      stores += rows.length;
    }

    // Each PostEx account belongs to the brand with the same key; there is no other link in config.
    let postexAccounts = 0;
    for (const account of input.postexAccounts) {
      const rows = await tx`
        insert into postex_accounts (key, label, store_id)
        values (${account.key}, ${account.label}, (select id from stores where key = ${account.key}))
        on conflict (key) do update
          set label = excluded.label, store_id = coalesce(excluded.store_id, postex_accounts.store_id)
          where (postex_accounts.label, postex_accounts.store_id)
            is distinct from (excluded.label, coalesce(excluded.store_id, postex_accounts.store_id))
        returning id
      `;
      postexAccounts += rows.length;
    }

    return { stores, postexAccounts };
  });
