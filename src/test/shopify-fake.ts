import type { ShopifyLineNode, ShopifyOrderNode, ShopifyProductNode, ShopifyVariantNode } from '../integrations/shopify/mapper.js';
import type { GraphqlFn } from '../jobs/shopify.js';
import { fromRupeeString, mul, toRupeeString } from '../lib/money.js';

/**
 * SYNTHETIC Shopify data and a fake Admin GraphQL endpoint, for testing the syncs without live
 * credentials. Shapes follow the queries in src/integrations/shopify/queries.ts; they are not
 * recordings. Names, phones and addresses are placeholders.
 */

const money = (amount: string) => ({ shopMoney: { amount, currencyCode: 'PKR' } });

export const variant = (id: number, sku: string | null): ShopifyVariantNode => ({
  id: `gid://shopify/ProductVariant/${id}`,
  sku,
  title: `Variant ${id}`,
  barcode: null,
});

export const product = (id: number, variants: ShopifyVariantNode[]): ShopifyProductNode => ({
  id: `gid://shopify/Product/${id}`,
  title: `Product ${id}`,
  vendor: 'NUR',
  status: 'ACTIVE',
  variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: variants },
});

export const line = (id: number, variantId: number | null, qty = 1, unit = '1000.00'): ShopifyLineNode => ({
  id: `gid://shopify/LineItem/${id}`,
  title: `Item ${id}`,
  sku: variantId === null ? null : `SKU-${variantId}`,
  quantity: qty,
  currentQuantity: qty,
  variant: variantId === null ? null : { id: `gid://shopify/ProductVariant/${variantId}` },
  originalUnitPriceSet: money(unit),
  totalDiscountSet: money('0.00'),
  discountedTotalSet: money(toRupeeString(mul(fromRupeeString(unit), qty))),
});

export const order = (id: number, updatedAt: string, overrides: Partial<ShopifyOrderNode> = {}): ShopifyOrderNode => ({
  id: `gid://shopify/Order/${id}`,
  name: `#${id}`,
  createdAt: updatedAt,
  updatedAt,
  cancelledAt: null,
  cancelReason: null,
  displayFinancialStatus: 'PENDING',
  displayFulfillmentStatus: 'UNFULFILLED',
  tags: [],
  discountCodes: [],
  subtotalPriceSet: money('1000.00'),
  totalDiscountsSet: money('0.00'),
  totalShippingPriceSet: money('250.00'),
  totalTaxSet: money('0.00'),
  totalPriceSet: money('1250.00'),
  customer: null,
  shippingAddress: {
    name: 'Test Customer',
    phone: '0300 1234567',
    address1: 'House 1',
    address2: null,
    city: 'Lahore',
    province: 'Punjab',
    zip: null,
    countryCodeV2: 'PK',
  },
  lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [line(id * 10, null)] },
  ...overrides,
});

/** Splits a nested list the way Shopify does: the first `size` inline, the rest by follow-up query. */
const connection = <T>(all: T[], offset: number, size: number) => ({
  pageInfo: { hasNextPage: offset + size < all.length, endCursor: offset + size < all.length ? String(offset + size) : null },
  nodes: all.slice(offset, offset + size),
});

/** A variant's cost per item and stock at one location, as the inventory query returns them. */
export interface FakeInventory {
  /** Rupees as Shopify sends them ("450.00"), or null for no cost entered. */
  cost: string | null;
  onHand: number;
  available: number;
  committed: number;
}

export interface FakeShopify {
  graphql: GraphqlFn;
  products: ShopifyProductNode[];
  orders: ShopifyOrderNode[];
  /** Keyed by Shopify variant id. Variants not listed have no cost and no levels. */
  inventory: Map<number, FakeInventory>;
  /** Every call, in order: the operation name and its variables. */
  calls: Array<{ operation: string; variables: Record<string, unknown> }>;
  /** Make the n-th call of an operation (1-based) throw once, e.g. to interrupt a sync mid-run. */
  failOnce: (operation: string, nth: number) => void;
}

/**
 * Serves the operations the syncs use. Pages are `pageSize` long whatever `first` asks
 * for, so a handful of records spans several pages. Orders honour the `updated_at:>=` filter
 * and come back oldest update first, as `sortKey: UPDATED_AT` does.
 */
export const fakeShopify = (init: { products?: ShopifyProductNode[]; orders?: ShopifyOrderNode[]; pageSize?: number; nestedSize?: number } = {}): FakeShopify => {
  const pageSize = init.pageSize ?? 2;
  const nestedSize = init.nestedSize ?? 100;
  const fake: FakeShopify = {
    products: init.products ?? [],
    orders: init.orders ?? [],
    inventory: new Map(),
    calls: [],
    failOnce: () => {},
    graphql: async () => {
      throw new Error('not set');
    },
  };
  const failures = new Map<string, number>();
  const counts = new Map<string, number>();
  fake.failOnce = (operation, nth) => failures.set(operation, nth);

  const graphql = async (query: string, variables: Record<string, unknown>): Promise<unknown> => {
    const operation = /query (\w+)/.exec(query)?.[1] ?? 'unknown';
    fake.calls.push({ operation, variables: structuredClone(variables) });
    const n = (counts.get(operation) ?? 0) + 1;
    counts.set(operation, n);
    if (failures.get(operation) === n) {
      failures.delete(operation);
      throw new Error(`Shopify ${operation}: simulated network failure on call ${n}`);
    }
    const offset = variables['after'] ? Number(variables['after']) : 0;

    if (operation === 'Products') {
      const page = connection(fake.products, offset, pageSize);
      return {
        products: {
          ...page,
          nodes: page.nodes.map((p) => ({ ...p, variants: connection(p.variants.nodes, 0, nestedSize) })),
        },
      };
    }
    if (operation === 'ProductVariants') {
      const target = fake.products.find((p) => p.id === variables['id']);
      return { product: target ? { variants: connection(target.variants.nodes, offset, nestedSize) } : null };
    }
    if (operation === 'VariantInventory') {
      const variants = fake.products.flatMap((p) => p.variants.nodes);
      const page = connection(variants, offset, pageSize);
      return {
        productVariants: {
          ...page,
          nodes: page.nodes.map((v) => {
            const stock = fake.inventory.get(Number(v.id.split('/').pop()));
            return {
              id: v.id,
              inventoryItem: {
                tracked: true,
                unitCost: stock?.cost ? { amount: stock.cost, currencyCode: 'PKR' } : null,
                inventoryLevels: {
                  pageInfo: { hasNextPage: false },
                  nodes: stock
                    ? [
                        {
                          location: { id: 'gid://shopify/Location/1', name: 'Shop location' },
                          quantities: [
                            { name: 'on_hand', quantity: stock.onHand },
                            { name: 'available', quantity: stock.available },
                            { name: 'committed', quantity: stock.committed },
                          ],
                        },
                      ]
                    : [],
                },
              },
            };
          }),
        },
      };
    }
    if (operation === 'Orders') {
      const since = /updated_at:>='([^']+)'/.exec(String(variables['query']))?.[1];
      const matching = fake.orders
        .filter((o) => !since || o.updatedAt >= since)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
      const page = connection(matching, offset, pageSize);
      return {
        orders: {
          ...page,
          nodes: page.nodes.map((o) => ({ ...o, lineItems: connection(o.lineItems.nodes, 0, nestedSize) })),
        },
      };
    }
    if (operation === 'Order') {
      const target = fake.orders.find((o) => o.id === variables['id']);
      return { order: target ? { ...target, lineItems: connection(target.lineItems.nodes, 0, nestedSize) } : null };
    }
    if (operation === 'OrderLines') {
      const target = fake.orders.find((o) => o.id === variables['id']);
      return { order: target ? { lineItems: connection(target.lineItems.nodes, offset, nestedSize) } : null };
    }
    throw new Error(`Fake Shopify does not serve ${operation}`);
  };
  fake.graphql = graphql as GraphqlFn;
  return fake;
};
