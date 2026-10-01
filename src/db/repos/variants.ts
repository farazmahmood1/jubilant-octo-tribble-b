import type { Paisa } from '../../lib/money.js';
import { formatKarachi } from '../../lib/time.js';
import { type Db, type UpsertResult, big, blankToNull, readBigint, readPaisa, toUpsertResult } from './upsert.js';

export interface VariantRow {
  id: string;
  storeId: string;
  productId: string;
  shopifyVariantId: bigint;
  sku: string | null;
  title: string;
  barcode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VariantInput {
  storeId: string;
  productId: string;
  /** The numeric part of `gid://shopify/ProductVariant/…`. */
  shopifyVariantId: bigint;
  /** Blank is stored as null: Juggun's Organics has no SKUs yet. */
  sku: string | null;
  title: string;
  barcode: string | null;
}

interface RawVariant {
  id: string;
  store_id: string;
  product_id: string;
  shopify_variant_id: string;
  sku: string | null;
  title: string;
  barcode: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'id, store_id, product_id, shopify_variant_id::text, sku, title, barcode, created_at, updated_at';

const toRow = (r: RawVariant): VariantRow => ({
  id: r.id,
  storeId: r.store_id,
  productId: r.product_id,
  shopifyVariantId: readBigint(r.shopify_variant_id),
  sku: r.sku,
  title: r.title,
  barcode: r.barcode,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * Keyed on (store, Shopify variant id). A SKU already used by another variant in the same store
 * is rejected by the database (unique where not null), not silently reassigned.
 */
export const upsertVariant = async (db: Db, input: VariantInput): Promise<UpsertResult> => {
  const [row] = await db<{ id: string; inserted: boolean; changed: boolean }[]>`
    with prev as (
      select to_jsonb(v) - 'updated_at' as doc from variants v
      where store_id = ${input.storeId} and shopify_variant_id = ${big(input.shopifyVariantId)}
    )
    insert into variants (store_id, product_id, shopify_variant_id, sku, title, barcode)
    values (${input.storeId}, ${input.productId}, ${big(input.shopifyVariantId)}, ${blankToNull(input.sku)},
            ${input.title}, ${blankToNull(input.barcode)})
    on conflict (store_id, shopify_variant_id) do update
      set product_id = excluded.product_id, sku = excluded.sku, title = excluded.title, barcode = excluded.barcode
    returning id, (xmax = 0) as inserted, (select doc from prev) is distinct from (to_jsonb(variants) - 'updated_at') as changed
  `;
  return toUpsertResult(row);
};

export const findVariant = async (db: Db, storeId: string, shopifyVariantId: bigint): Promise<VariantRow | null> => {
  const [row] = await db<RawVariant[]>`
    select ${db.unsafe(COLUMNS)} from variants where store_id = ${storeId} and shopify_variant_id = ${big(shopifyVariantId)}
  `;
  return row ? toRow(row) : null;
};

/** The "unmapped variants" screen: variants with no SKU, which stock cannot be tracked by yet. */
export const listUnmappedVariants = async (db: Db, storeId: string): Promise<VariantRow[]> => {
  const rows = await db<RawVariant[]>`
    select ${db.unsafe(COLUMNS)} from variants where store_id = ${storeId} and sku is null order by id
  `;
  return rows.map(toRow);
};

export type CostSource = 'import' | 'goods_receipt' | 'manual';

export interface CostInput {
  variantId: string;
  unitCost: Paisa;
  /** A Karachi business date, `YYYY-MM-DD`. */
  effectiveFrom: string;
  source: CostSource;
  note?: string | null;
  actorId?: string | null;
}

const KARACHI_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Records a cost from a date onwards. Costs are never edited: a price change, or a correction, is
 * a new row, and the newest row for the same date wins.
 */
export const addProductCost = async (db: Db, input: CostInput): Promise<string> => {
  if (!KARACHI_DATE.test(input.effectiveFrom)) {
    throw new RangeError(`effectiveFrom must be a YYYY-MM-DD Karachi date, got "${input.effectiveFrom}"`);
  }
  const [row] = await db<{ id: string }[]>`
    insert into product_costs (variant_id, unit_cost_paisa, effective_from, source, note, actor_id)
    values (${input.variantId}, ${big(input.unitCost)}, ${input.effectiveFrom}, ${input.source}, ${input.note ?? null}, ${input.actorId ?? null})
    returning id
  `;
  if (!row) throw new Error('Insert returned no row');
  return row.id;
};

/**
 * The unit cost in force at an instant: the newest cost whose Karachi effective date is on or
 * before that instant's Karachi date. COGS uses the order's placed date (BUILD-PLAN Batch B), so
 * a later price change never rewrites the profit of an earlier order. Null when no cost exists
 * yet for that date.
 */
export const costAt = async (db: Db, variantId: string, at: Date): Promise<Paisa | null> => {
  const day = formatKarachi(at).slice(0, 10);
  const [row] = await db<{ unit_cost_paisa: string }[]>`
    select unit_cost_paisa::text from product_costs
    where variant_id = ${variantId} and effective_from <= ${day}
    order by effective_from desc, id desc
    limit 1
  `;
  return row ? readPaisa(row.unit_cost_paisa) : null;
};
