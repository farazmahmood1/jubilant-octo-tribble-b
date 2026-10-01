import type { MappedVariantInventory } from '../../integrations/shopify/mapper.js';
import type { Paisa } from '../../lib/money.js';
import { costRecorded } from './costs.js';
import { type Db, atomically, big } from './upsert.js';

/**
 * Shopify's "Cost per item" and stock levels, read by the catalogue sync.
 *
 * Costs go into `product_costs`, which is append-only and effective-dated: a row is added only
 * when Shopify's cost differs from the last one imported from Shopify, so an unchanged catalogue
 * adds nothing. The first cost Shopify gives a variant that has no cost at all is taken back to
 * the start of the synced history (the `costs` setting, default 1 January 2026), so the parcels
 * already delivered can be costed; a person can always enter a dated cost that overrides it.
 * Later changes take effect on the day they are seen. A variant bought through a goods receipt
 * takes its cost from its receipts from then on, and Shopify's is ignored.
 */

export const SHOPIFY_COST_NOTE = 'shopify:cost_per_item';
export const DEFAULT_FIRST_COST_FROM = '2026-01-01';

const firstCostFrom = async (db: Db): Promise<string> => {
  const [row] = await db<{ value: { shopifyFirstEffectiveFrom?: string } }[]>`select value from app_settings where key = 'costs'`;
  return row?.value.shopifyFirstEffectiveFrom ?? DEFAULT_FIRST_COST_FROM;
};

export type CostImport = 'unchanged' | 'first' | 'changed' | 'none' | 'purchased';

/**
 * Records Shopify's cost for one variant if it is new or different. When a cost is added, the
 * parcels that carried the variant are marked for the accounting pass (their COGS can now post)
 * and the `cost_missing` items it answers are closed.
 */
export const importShopifyCost = async (db: Db, variantId: string, cost: Paisa | null, today: string): Promise<CostImport> => {
  if (cost === null) return 'none';
  return atomically(db, async (tx) => {
    // Once a variant has been bought through a goods receipt, its cost comes from what was
    // paid; a "Cost per item" left stale in Shopify must not overwrite it.
    const [purchased] = await tx`select 1 from product_costs where variant_id = ${variantId} and source = 'goods_receipt' limit 1`;
    if (purchased) return 'purchased';
    const [last] = await tx<{ unit_cost_paisa: string }[]>`
      select unit_cost_paisa::text from product_costs
      where variant_id = ${variantId} and source = 'import' and note = ${SHOPIFY_COST_NOTE}
      order by effective_from desc, id desc limit 1
    `;
    if (last && BigInt(last.unit_cost_paisa) === cost) return 'unchanged';
    const [any] = await tx`select 1 from product_costs where variant_id = ${variantId} limit 1`;
    const effectiveFrom = any ? today : await firstCostFrom(tx);
    await tx`
      insert into product_costs (variant_id, unit_cost_paisa, effective_from, source, note)
      values (${variantId}, ${big(cost)}, ${effectiveFrom}, 'import', ${SHOPIFY_COST_NOTE})
    `;
    await costRecorded(tx, variantId, effectiveFrom, 'Cost imported from Shopify');
    return any ? 'changed' : 'first';
  });
};

/** Replaces one variant's Shopify levels with what Shopify returned now. */
export const replaceStockLevels = async (db: Db, storeId: string, variantId: string, inventory: MappedVariantInventory, readAt: Date): Promise<void> =>
  atomically(db, async (tx) => {
    await tx`delete from shopify_stock_levels where variant_id = ${variantId}`;
    for (const level of inventory.levels) {
      await tx`
        insert into shopify_stock_levels (variant_id, store_id, location_gid, location_name, on_hand, available, committed, read_at)
        values (${variantId}, ${storeId}, ${level.locationGid}, ${level.locationName}, ${level.onHand}, ${level.available}, ${level.committed}, ${readAt})
      `;
    }
  });
