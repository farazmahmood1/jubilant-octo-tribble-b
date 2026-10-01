import type { Sql } from '../db.js';
import type { Db } from '../db/repos/upsert.js';
import { endOfKarachiDay } from '../lib/time.js';
import { StockError, locationId, recordAdjustment } from './stock.js';

/**
 * Shopify's stock beside ours, and an opening count taken from it.
 *
 * Shopify's "on hand" cannot be used as it is: the team ships through PostEx and does not mark
 * orders fulfilled, so a parcel that left last week is still "on hand" in Shopify, counted under
 * "committed". What is physically on the shelf is Shopify's **available** plus what is
 * **committed to orders not yet booked** with PostEx (those goods have not left). That is the
 * estimate below; every number it is made from is shown beside it, for a person to judge.
 *
 * The opening count is set so that our warehouse **today** equals that estimate, and it is dated
 * on the cut-over day: our warehouse today is the opening count plus everything our ledger moved
 * since, so this back-computes the count the cut-over day must have had.
 */

export const SHOPIFY_OPENING_NOTE = 'From Shopify: available + committed to orders not yet booked';

export interface StockComparisonRow {
  variantId: string;
  store: string;
  sku: string | null;
  title: string;
  onHand: number;
  available: number;
  committed: number;
  /** Units on unbooked, uncancelled orders we hold: committed in Shopify but still on the shelf. */
  committedUnbooked: number;
  /** available + committedUnbooked (never more than on hand): the shelf, by Shopify's figures. */
  estimate: number;
  /** Our warehouse quant now. */
  warehouse: number;
  /** estimate − warehouse: what an opening count from Shopify would add (negative: remove). */
  difference: number;
  readAt: Date;
}

export const shopifyStockComparison = async (db: Db, storeKey?: string): Promise<StockComparisonRow[]> => {
  const rows = await db<
    {
      variant_id: string; store: string; sku: string | null; title: string; on_hand: number; available: number; committed: number;
      unbooked: number; warehouse: number; read_at: Date;
    }[]
  >`
    with levels as (
      select variant_id, store_id, sum(on_hand)::int as on_hand, sum(available)::int as available, sum(committed)::int as committed,
             max(read_at) as read_at
      from shopify_stock_levels group by variant_id, store_id
    ),
    unbooked as (
      select l.variant_id, sum(l.qty)::int as qty
      from order_lines l join orders o on o.id = l.order_id
      where l.variant_id is not null and o.cancelled_at is null
        and coalesce(o.fulfillment_status, 'unfulfilled') not in ('fulfilled', 'restocked')
        and not exists (select 1 from shipments s where s.order_id = o.id)
      group by l.variant_id
    ),
    warehouse as (
      select q.variant_id, q.qty::int as qty from stock_quants q join locations loc on loc.id = q.location_id where loc.key = 'warehouse'
    )
    select v.id as variant_id, st.key as store, v.sku, p.title || ' · ' || v.title as title,
           lv.on_hand, lv.available, lv.committed, coalesce(u.qty, 0) as unbooked, coalesce(w.qty, 0) as warehouse, lv.read_at
    from levels lv
    join variants v on v.id = lv.variant_id
    join products p on p.id = v.product_id
    join stores st on st.id = lv.store_id
    left join unbooked u on u.variant_id = v.id
    left join warehouse w on w.variant_id = v.id
    where v.deleted_at is null ${storeKey ? db`and st.key = ${storeKey}` : db``}
    order by st.key, p.title, v.title
  `;
  return rows.map((r) => {
    const committedUnbooked = Math.min(r.unbooked, r.committed);
    const estimate = Math.max(0, Math.min(r.on_hand, r.available + committedUnbooked));
    return {
      variantId: r.variant_id,
      store: r.store,
      sku: r.sku,
      title: r.title,
      onHand: r.on_hand,
      available: r.available,
      committed: r.committed,
      committedUnbooked,
      estimate,
      warehouse: r.warehouse,
      difference: estimate - r.warehouse,
      readAt: r.read_at,
    };
  });
};

/**
 * Records the opening stock count from Shopify's figures, dated at the end of the cut-over day,
 * for one store or both. Once per store: after that, differences are counts or corrections,
 * which are true on the day they are made. Returns null when nothing differs.
 */
export const openingStockFromShopify = async (
  sql: Sql,
  input: { asAt: string; actorId: string; storeKey?: string },
): Promise<{ adjustmentId: string; lines: number; units: number } | null> => {
  const at = endOfKarachiDay(input.asAt);
  const [done] = await sql<{ store: string }[]>`
    select distinct st.key as store
    from stock_adjustments a
    join stock_moves m on m.ref_type = 'stock_adjustment' and m.ref_id = a.id::text
    join variants v on v.id = m.variant_id join stores st on st.id = v.store_id
    where a.reason = 'opening_stock' and a.note = ${SHOPIFY_OPENING_NOTE}
      ${input.storeKey ? sql`and st.key = ${input.storeKey}` : sql``}
    limit 1
  `;
  if (done) throw new StockError(`The opening count for ${done.store} was already taken from Shopify; enter differences as stock counts`);
  const rows = (await shopifyStockComparison(sql, input.storeKey)).filter((r) => r.difference !== 0);
  if (rows.length === 0) return null;
  const adjustmentId = await recordAdjustment(sql, {
    locationId: await locationId(sql, 'warehouse'),
    reason: 'opening_stock',
    note: SHOPIFY_OPENING_NOTE,
    actorId: input.actorId,
    at,
    lines: rows.map((r) => ({ variantId: r.variantId, delta: r.difference })),
  });
  return { adjustmentId, lines: rows.length, units: rows.reduce((n, r) => n + r.difference, 0) };
};
