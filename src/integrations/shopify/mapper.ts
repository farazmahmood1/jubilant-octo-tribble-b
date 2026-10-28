import type { AddressInput } from '../../db/repos/customers.js';
import type { OrderLineInput, RefundInput, ReturnInput } from '../../db/repos/orders.js';
import { type Paisa, fromRupeeString } from '../../lib/money.js';

/**
 * Shopify Admin GraphQL nodes → repo inputs. Pure: no database, no HTTP. Ids are resolved to
 * our own rows (store, customer, variant) by the sync job, which is why the outputs here still
 * carry Shopify ids.
 */

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface Connection<T> {
  pageInfo: PageInfo;
  nodes: T[];
}

export interface ShopifyVariantNode {
  id: string;
  sku: string | null;
  title: string;
  barcode: string | null;
}

export interface ShopifyProductNode {
  id: string;
  title: string;
  vendor: string | null;
  status: string;
  variants: Connection<ShopifyVariantNode>;
}

interface MoneySet {
  shopMoney: { amount: string; currencyCode: string };
}

export interface ShopifyLineNode {
  id: string;
  title: string;
  sku: string | null;
  quantity: number;
  currentQuantity: number | null;
  variant: { id: string } | null;
  originalUnitPriceSet: MoneySet;
  totalDiscountSet: MoneySet;
  discountedTotalSet: MoneySet;
}

export interface ShopifyOrderNode {
  id: string;
  name: string;
  /** Free text: staff and apps write here, customers too. Read only for tracking numbers. */
  note?: string | null;
  createdAt: string;
  updatedAt: string;
  cancelledAt: string | null;
  cancelReason: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  tags: string[];
  discountCodes: string[];
  subtotalPriceSet: MoneySet | null;
  totalDiscountsSet: MoneySet | null;
  totalShippingPriceSet: MoneySet | null;
  totalTaxSet: MoneySet | null;
  totalPriceSet: MoneySet;
  /**
   * The same amounts after order edits: an item removed on the phone leaves `totalPriceSet` as it
   * was placed, but not these. Absent from older payloads (an export, a stored raw order).
   */
  currentSubtotalPriceSet?: MoneySet | null;
  currentTotalDiscountsSet?: MoneySet | null;
  currentShippingPriceSet?: MoneySet | null;
  currentTotalTaxSet?: MoneySet | null;
  currentTotalPriceSet?: MoneySet | null;
  /** Shopify's Order.returnStatus (NO_RETURN, RETURN_REQUESTED, IN_PROGRESS, RETURNED, …). */
  returnStatus?: string | null;
  totalRefundedSet?: MoneySet | null;
  /** Every refund, a cancellation included: its lines say whether the units were restocked. */
  refunds?: ShopifyRefundNode[];
  returns?: { nodes: ShopifyReturnNode[] } | null;
  customer: { id: string; firstName: string | null; lastName: string | null; phone: string | null } | null;
  shippingAddress: {
    name: string | null;
    phone: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    zip: string | null;
    countryCodeV2: string | null;
  } | null;
  lineItems: Connection<ShopifyLineNode>;
}

export interface ShopifyRefundNode {
  id: string;
  createdAt: string;
  totalRefundedSet: MoneySet | null;
  refundLineItems: { nodes: Array<{ quantity: number; restockType: string; restocked: boolean; lineItem: { id: string } | null; subtotalSet: MoneySet | null }> };
}

export interface ShopifyReturnNode {
  id: string;
  name: string | null;
  status: string;
  createdAt: string | null;
  closedAt: string | null;
  returnLineItems: { nodes: Array<{ quantity: number; returnReason?: string | null; fulfillmentLineItem?: { lineItem: { id: string } | null } | null }> };
}

export class ShopifyMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShopifyMappingError';
  }
}

/** `gid://shopify/Order/5000000001` → `5000000001n`. Checks the type so a variant id is never stored as a product id. */
export const parseGid = (gid: string, type: string): bigint => {
  const match = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)$/.exec(gid);
  if (!match || match[1] !== type) throw new ShopifyMappingError(`Expected a Shopify ${type} gid, got "${gid}"`);
  return BigInt(match[2] ?? '');
};

/** Both stores sell in PKR; an amount in another currency is a configuration change, not data to convert. */
const money = (set: MoneySet | null | undefined, field: string): Paisa => {
  if (!set) return fromRupeeString('0');
  if (set.shopMoney.currencyCode !== 'PKR') {
    throw new ShopifyMappingError(`${field} is in ${set.shopMoney.currencyCode}, expected PKR`);
  }
  return fromRupeeString(set.shopMoney.amount);
};

export interface MappedProduct {
  product: { shopifyProductId: bigint; title: string; brand: string | null; status: string };
  variants: Array<{ shopifyVariantId: bigint; sku: string | null; title: string; barcode: string | null }>;
}

export const mapProduct = (node: ShopifyProductNode, variants: ShopifyVariantNode[] = node.variants.nodes): MappedProduct => ({
  product: { shopifyProductId: parseGid(node.id, 'Product'), title: node.title, brand: node.vendor || null, status: node.status },
  variants: variants.map((v) => ({ shopifyVariantId: parseGid(v.id, 'ProductVariant'), sku: v.sku, title: v.title, barcode: v.barcode })),
});

export interface ShopifyVariantInventoryNode {
  id: string;
  inventoryItem: {
    tracked: boolean;
    unitCost: { amount: string; currencyCode: string } | null;
    inventoryLevels: {
      pageInfo: { hasNextPage: boolean };
      nodes: Array<{ location: { id: string; name: string }; quantities: Array<{ name: string; quantity: number }> }>;
    };
  } | null;
}

export interface MappedVariantInventory {
  shopifyVariantId: bigint;
  /** Shopify's "Cost per item", or null where nobody has entered one. */
  unitCost: Paisa | null;
  tracked: boolean;
  levels: Array<{ locationGid: string; locationName: string; onHand: number; available: number; committed: number }>;
  /** More locations than one page holds: the levels are incomplete and the sync says so. */
  levelsTruncated: boolean;
}

/**
 * A variant's cost and stock. A cost of zero is read as "not entered" (Shopify shows an empty
 * Cost per item as nothing, and a real product does not cost nothing); a cost in another
 * currency is refused rather than converted.
 */
export const mapVariantInventory = (node: ShopifyVariantInventoryNode): MappedVariantInventory => {
  const item = node.inventoryItem;
  const cost = item?.unitCost ?? null;
  if (cost && cost.currencyCode !== 'PKR') throw new ShopifyMappingError(`Cost of ${node.id} is in ${cost.currencyCode}, expected PKR`);
  const unitCost = cost ? fromRupeeString(cost.amount) : null;
  const quantity = (q: Array<{ name: string; quantity: number }>, name: string) => q.find((x) => x.name === name)?.quantity ?? 0;
  return {
    shopifyVariantId: parseGid(node.id, 'ProductVariant'),
    unitCost: unitCost !== null && unitCost > 0n ? unitCost : null,
    tracked: item?.tracked ?? false,
    levels: (item?.inventoryLevels.nodes ?? []).map((level) => ({
      locationGid: level.location.id,
      locationName: level.location.name,
      onHand: quantity(level.quantities, 'on_hand'),
      available: quantity(level.quantities, 'available'),
      committed: quantity(level.quantities, 'committed'),
    })),
    levelsTruncated: item?.inventoryLevels.pageInfo.hasNextPage ?? false,
  };
};

export interface MappedOrder {
  customer: { shopifyCustomerId: bigint | null; name: string | null; phone: string | null };
  address: AddressInput | null;
  order: {
    shopifyOrderId: bigint;
    orderNumber: string;
    placedAt: Date;
    updatedAt: Date;
    financialStatus: string | null;
    fulfillmentStatus: string | null;
    subtotal: Paisa;
    discount: Paisa;
    shipping: Paisa;
    tax: Paisa;
    total: Paisa;
    channel: 'online' | 'pr';
    cancelledAt: Date | null;
    cancelReason: string | null;
    tags: string[];
    discountCodes: string[];
    postexTrackingNumbers: string[];
    refunded: Paisa;
    returnStatus: string | null;
  };
  refunds: RefundInput[];
  returns: ReturnInput[];
  /** Lines with the Shopify variant id still to be resolved to our variant row. */
  lines: Array<Omit<OrderLineInput, 'variantId'> & { shopifyVariantId: bigint | null }>;
}

/**
 * PostEx tracking numbers in an order note, as the "Book at PostEx" app writes them: "Order has
 * been shipped via PostEx with Tracking 28544400000462". Only a run of digits that follows the
 * word "tracking" counts, so a phone number or an amount in the same note is never taken.
 * A re-sent order can carry several; each is kept once, in the order written.
 */
export const postexTrackingFromNote = (note: string | null | undefined): string[] => {
  if (!note) return [];
  const found = [...note.matchAll(/tracking\s*(?:no\.?|number|#|id)?\s*[:#-]?\s*(\d{10,20})(?!\d)/gi)].map((m) => m[1]!);
  return [...new Set(found)];
};

const joinName = (...parts: Array<string | null | undefined>): string | null => {
  const name = parts.filter(Boolean).join(' ').trim();
  return name || null;
};

/**
 * One Shopify order. Notes on the choices:
 * - The phone is the shipping address's first, the customer's second: it is the number the
 *   courier and the confirmation desk will call.
 * - `channel` is `pr` only when staff tagged the order `PR`. A 100%-discounted order is left
 *   `online` for a person to classify (CLAUDE.md: never assumed to be PR).
 * - A line's quantity is its current quantity, so items removed by an order edit count as 0. The
 *   order's amounts are its current ones for the same reason: an edited order's total is what the
 *   customer now owes (and what PostEx collects), not what was first placed. A cancelled order
 *   keeps its placed amounts, since cancelling sets the current ones to zero.
 */
export const mapOrder = (node: ShopifyOrderNode, lineNodes: ShopifyLineNode[] = node.lineItems.nodes): MappedOrder => {
  const shipping = node.shippingAddress;
  const tags = node.tags.map((t) => t.trim()).filter(Boolean);
  // A cancellation empties Shopify's current amounts: a cancelled order keeps what it was placed for.
  const current = (now: MoneySet | null | undefined, placed: MoneySet | null): MoneySet | null => (node.cancelledAt ? placed : (now ?? placed));
  return {
    customer: {
      shopifyCustomerId: node.customer ? parseGid(node.customer.id, 'Customer') : null,
      name: joinName(node.customer?.firstName, node.customer?.lastName) ?? shipping?.name ?? null,
      phone: shipping?.phone || node.customer?.phone || null,
    },
    address: shipping
      ? {
          line1: shipping.address1,
          line2: shipping.address2,
          city: shipping.city,
          province: shipping.province,
          postal: shipping.zip,
          country: shipping.countryCodeV2,
        }
      : null,
    order: {
      shopifyOrderId: parseGid(node.id, 'Order'),
      orderNumber: node.name,
      placedAt: new Date(node.createdAt),
      updatedAt: new Date(node.updatedAt),
      financialStatus: node.displayFinancialStatus?.toLowerCase() ?? null,
      fulfillmentStatus: node.displayFulfillmentStatus?.toLowerCase() ?? null,
      subtotal: money(current(node.currentSubtotalPriceSet, node.subtotalPriceSet), 'subtotal'),
      discount: money(current(node.currentTotalDiscountsSet, node.totalDiscountsSet), 'discount'),
      shipping: money(current(node.currentShippingPriceSet, node.totalShippingPriceSet), 'shipping'),
      tax: money(current(node.currentTotalTaxSet, node.totalTaxSet), 'tax'),
      total: money(current(node.currentTotalPriceSet, node.totalPriceSet) ?? node.totalPriceSet, 'total'),
      channel: tags.some((t) => t.toUpperCase() === 'PR') ? 'pr' : 'online',
      cancelledAt: node.cancelledAt ? new Date(node.cancelledAt) : null,
      cancelReason: node.cancelReason?.toLowerCase() ?? null,
      tags,
      discountCodes: node.discountCodes,
      postexTrackingNumbers: postexTrackingFromNote(node.note),
      refunded: money(node.totalRefundedSet, 'total refunded'),
      returnStatus: node.returnStatus ?? null,
    },
    refunds: (node.refunds ?? []).map((refund) => ({
      shopifyRefundId: parseGid(refund.id, 'Refund'),
      refundedAt: new Date(refund.createdAt),
      amount: money(refund.totalRefundedSet, `refund ${refund.id}`),
      lines: refund.refundLineItems.nodes.flatMap((line) =>
        line.lineItem
          ? [
              {
                shopifyLineItemId: parseGid(line.lineItem.id, 'LineItem'),
                qty: line.quantity,
                restockType: line.restockType,
                restocked: line.restocked,
                amount: money(line.subtotalSet, `refund ${refund.id} line`),
              },
            ]
          : [],
      ),
    })),
    returns: (node.returns?.nodes ?? []).map((ret) => ({
      shopifyReturnId: parseGid(ret.id, 'Return'),
      name: ret.name,
      status: ret.status,
      openedAt: ret.createdAt ? new Date(ret.createdAt) : null,
      closedAt: ret.closedAt ? new Date(ret.closedAt) : null,
      lines: ret.returnLineItems.nodes.map((line) => ({
        lineItemId: line.fulfillmentLineItem?.lineItem ? String(parseGid(line.fulfillmentLineItem.lineItem.id, 'LineItem')) : null,
        qty: line.quantity,
        reason: line.returnReason ?? null,
      })),
    })),
    lines: lineNodes.map((line) => ({
      lineKey: `shopify:${parseGid(line.id, 'LineItem')}`,
      shopifyVariantId: line.variant ? parseGid(line.variant.id, 'ProductVariant') : null,
      sku: line.sku || null,
      title: line.title,
      qty: line.currentQuantity ?? line.quantity,
      unitPrice: money(line.originalUnitPriceSet, `line ${line.id} unit price`),
      discount: money(line.totalDiscountSet, `line ${line.id} discount`),
      total: money(line.discountedTotalSet, `line ${line.id} total`),
    })),
  };
};
