import { resolveOpenReviewItem } from './review.js';
import type { Db } from './upsert.js';

/**
 * What follows a new product cost, wherever it came from (Shopify, a goods receipt, a person):
 * the parcels that carried the variant are marked for the accounting pass, so a COGS held back
 * for want of a cost can post, and the `cost_missing` items the cost answers are closed.
 */
export const costRecorded = async (db: Db, variantId: string, effectiveFrom: string, how: string): Promise<void> => {
  await db`
    update shipments set accounting_pending = true
    where not accounting_pending and id in (select shipment_id from stock_moves where variant_id = ${variantId} and shipment_id is not null)
  `;
  const answered = await db<{ dedupe_key: string }[]>`
    select dedupe_key from reconciliation_items
    where kind = 'cost_missing' and status = 'open' and detail->>'variantId' = ${variantId} and detail->>'needCostOn' >= ${effectiveFrom}
  `;
  for (const item of answered) await resolveOpenReviewItem(db, item.dedupe_key, `${how}, effective ${effectiveFrom}`);
};
