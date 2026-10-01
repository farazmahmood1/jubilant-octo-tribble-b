import { type Db, type UpsertResult, big, readBigint, toUpsertResult } from './upsert.js';

export interface ProductRow {
  id: string;
  storeId: string;
  shopifyProductId: bigint;
  title: string;
  brand: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductInput {
  storeId: string;
  /** The numeric part of `gid://shopify/Product/…`. */
  shopifyProductId: bigint;
  title: string;
  brand: string | null;
  /** Shopify's status (`ACTIVE`, `DRAFT`, …); stored lowercased. */
  status: string;
}

interface RawProduct {
  id: string;
  store_id: string;
  shopify_product_id: string;
  title: string;
  brand: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
}

const toRow = (r: RawProduct): ProductRow => ({
  id: r.id,
  storeId: r.store_id,
  shopifyProductId: readBigint(r.shopify_product_id),
  title: r.title,
  brand: r.brand,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Keyed on (store, Shopify product id). */
export const upsertProduct = async (db: Db, input: ProductInput): Promise<UpsertResult> => {
  const [row] = await db<{ id: string; inserted: boolean; changed: boolean }[]>`
    with prev as (
      select to_jsonb(p) - 'updated_at' as doc from products p
      where store_id = ${input.storeId} and shopify_product_id = ${big(input.shopifyProductId)}
    )
    insert into products (store_id, shopify_product_id, title, brand, status)
    values (${input.storeId}, ${big(input.shopifyProductId)}, ${input.title}, ${input.brand}, ${input.status.toLowerCase()})
    on conflict (store_id, shopify_product_id) do update
      set title = excluded.title, brand = excluded.brand, status = excluded.status
    returning id, (xmax = 0) as inserted, (select doc from prev) is distinct from (to_jsonb(products) - 'updated_at') as changed
  `;
  return toUpsertResult(row);
};

export const findProduct = async (db: Db, storeId: string, shopifyProductId: bigint): Promise<ProductRow | null> => {
  const [row] = await db<RawProduct[]>`
    select id, store_id, shopify_product_id::text, title, brand, status, created_at, updated_at
    from products where store_id = ${storeId} and shopify_product_id = ${big(shopifyProductId)}
  `;
  return row ? toRow(row) : null;
};
