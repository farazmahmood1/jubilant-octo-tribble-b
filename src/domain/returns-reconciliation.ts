import type { ParcelStage } from './order-state.js';

/**
 * Returns as each source records them, side by side, and what does not agree. The sources record
 * different events, and none of them is wrong for not recording the others' (they are related,
 * not equivalent):
 *
 * | Source            | Records                                                     | Authoritative for            |
 * |-------------------|-------------------------------------------------------------|------------------------------|
 * | PostEx            | a parcel's delivery failing and the parcel coming back      | whether a parcel came back   |
 * | The platform      | a person checking the parcel in: shelf or damaged           | what came back, in what state |
 * | Shopify           | the order cancelled, refunded, returned; its items restocked | Shopify's order and its stock |
 *
 * So a PostEx return that Shopify knows nothing about is normal for a refused COD parcel (nobody
 * paid, nothing to refund), and is only worth acting on for Shopify's stock: its units stay
 * committed to the open order until it is cancelled. A Shopify return with no PostEx return is a
 * customer sending goods back some other way after delivery, which the platform's stock does not
 * see. Each finding names the record it is about and what would settle it; nothing here changes
 * any record.
 */

export interface ReturnFacts {
  orderId: string | null;
  orderNumber: string | null;
  store: string | null;
  placedAt: Date | null;
  /** The order was placed before the first parcel the platform holds for its store: its parcels may predate the import. */
  beforeImport: boolean;
  shipmentId: string | null;
  trackingNumber: string | null;
  stage: ParcelStage | null;
  /** When PostEx handed the parcel back (0006). */
  returnedAt: Date | null;
  checkIn: 'restocked' | 'damaged' | 'mixed' | null;
  checkedInAt: Date | null;
  /** The latest attempt to bring Shopify's stock in line with the check-in. */
  restock: { outcome: 'done' | 'skipped' | 'failed' | 'pending'; message: string; ahead: number; notFound: boolean } | null;
  shopify: {
    cancelled: boolean;
    financialStatus: string | null;
    fulfillmentStatus: string | null;
    returnStatus: string | null;
    refundedPaisa: string;
    /** Units Shopify put back by refund or cancellation with restock, and units refunded or cancelled without. */
    unitsRestocked: number;
    unitsNotRestocked: number;
    /** Units refunded after delivery or from a return (restock type RETURN or LEGACY_RESTOCK). */
    unitsReturned: number;
    returns: Array<{ name: string | null; status: string }>;
  } | null;
}

export type IssueKind =
  | 'parcel_without_order'
  | 'not_checked_in'
  | 'shopify_order_still_open'
  | 'shopify_stock_not_updated'
  | 'shopify_restocked_twice'
  | 'shopify_order_missing'
  | 'shopify_return_not_in_postex'
  | 'cancelled_parcel_still_out';

export interface ReturnIssue {
  kind: IssueKind;
  severity: 'info' | 'warning' | 'error';
  /** A sentence for the screen: what disagrees and what settles it. */
  text: string;
}

/** PostEx has handed a parcel back for this long without anyone checking it in: someone should look for it. */
export const CHECK_IN_GRACE_DAYS = 2;

const RETURNING: readonly (ParcelStage | null)[] = ['returning', 'returned'];
const OUT: readonly (ParcelStage | null)[] = ['booked', 'in_transit', 'attempted', 'delivered'];

export const returnIssues = (f: ReturnFacts, now: Date): ReturnIssue[] => {
  const issues: ReturnIssue[] = [];
  const parcelReturned = RETURNING.includes(f.stage);

  if (f.shipmentId && !f.orderId && parcelReturned) {
    issues.push({ kind: 'parcel_without_order', severity: 'warning', text: 'PostEx returned this parcel, but it is not linked to a Shopify order. Link it on the Reconciliation queue so its stock and money land on the right order.' });
  }
  if (f.stage === 'returned' && !f.checkIn && f.returnedAt && now.getTime() - f.returnedAt.getTime() > CHECK_IN_GRACE_DAYS * 86_400_000) {
    issues.push({ kind: 'not_checked_in', severity: 'warning', text: `PostEx handed this parcel back more than ${CHECK_IN_GRACE_DAYS} days ago and nobody has checked it in, so its units are not on the shelf.` });
  }
  if (f.checkIn && f.restock) {
    if (f.restock.notFound) {
      issues.push({ kind: 'shopify_order_missing', severity: 'error', text: 'Shopify no longer has this order (deleted there). The platform keeps it for its parcel and money; nothing in Shopify can be updated.' });
    } else if (f.restock.outcome === 'failed') {
      issues.push({ kind: 'shopify_stock_not_updated', severity: 'warning', text: `Checked in, but Shopify's stock was not updated: ${f.restock.message}` });
    } else if (f.restock.outcome === 'pending') {
      issues.push({ kind: 'shopify_order_still_open', severity: 'warning', text: 'Checked in, but the order is still open in Shopify, which keeps the returned units committed to it. Cancel it in Shopify (from the Returns page or in Shopify) to make them available.' });
    }
    if (f.restock.ahead > 0) {
      issues.push({ kind: 'shopify_restocked_twice', severity: 'error', text: `Shopify shows ${f.restock.ahead} more unit(s) of this order back in stock than came back in good condition (restocked twice, or damaged units restocked). Correct Shopify's inventory by hand.` });
    }
  } else if (f.checkIn && !f.restock && f.orderId) {
    issues.push({ kind: 'shopify_stock_not_updated', severity: 'warning', text: 'Checked in, but Shopify has not been asked to update its stock yet. Press Retry on the Returns page.' });
  } else if (parcelReturned && f.shopify && !f.shopify.cancelled && f.shopify.unitsRestocked === 0 && !f.checkIn) {
    issues.push({ kind: 'shopify_order_still_open', severity: 'info', text: 'PostEx is returning this parcel; Shopify still shows the order open. Nothing to do until it is checked in.' });
  }
  if (f.shopify && (f.shopify.unitsReturned > 0 || f.shopify.returns.some((r) => r.status !== 'CANCELED' && r.status !== 'DECLINED')) && !parcelReturned) {
    issues.push({
      kind: 'shopify_return_not_in_postex',
      severity: f.beforeImport && !f.shipmentId ? 'info' : 'warning',
      text: f.beforeImport && !f.shipmentId
        ? 'Shopify records a return on this order, which was placed before the platform\'s PostEx history starts, so its parcel is not here to compare with.'
        : `Shopify records a return on this order, but PostEx ${f.stage === 'delivered' ? 'delivered the parcel and shows no return' : 'has no returned parcel for it'}. If goods came back another way, count them into stock with a stock adjustment.`,
    });
  }
  if (f.shopify?.cancelled && OUT.includes(f.stage)) {
    issues.push({
      kind: 'cancelled_parcel_still_out',
      severity: f.stage === 'delivered' ? 'error' : 'warning',
      text: f.stage === 'delivered' ? 'Cancelled in Shopify, but PostEx delivered the parcel.' : 'Cancelled in Shopify, but its parcel is still out with PostEx.',
    });
  }
  return issues;
};
