/**
 * Admin GraphQL documents for the catalogue and order syncs (API version from config).
 *
 * Only the customer fields delivery needs are requested: the shipping address's name and phone, never email (1.9).
 * The `customer` object is not requested: it needs the read_customers scope, which the app does not have.
 * Customers are keyed by phone instead, the same as in the CSV import, so both sources agree.
 * Lists nested inside a node (variants of a product, line items of an order) are fetched 100
 * at a time; the rare node with more is completed by the follow-up queries below.
 */

export const PAGE_SIZE = 50;
export const NESTED_PAGE_SIZE = 100;

const VARIANT_FIELDS = 'id sku title barcode';

export const PRODUCTS_QUERY = `
  query Products($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id title vendor status
        variants(first: ${NESTED_PAGE_SIZE}) { pageInfo { hasNextPage endCursor } nodes { ${VARIANT_FIELDS} } }
      }
    }
  }
`;

/** Variants per page for the inventory pass: each carries its levels, so the page is kept small. */
export const INVENTORY_PAGE_SIZE = 50;
/** Locations per variant. Both stores have one today; more than this is reported, not dropped silently. */
export const LOCATIONS_PER_VARIANT = 10;

/**
 * Cost per item and stock per location for every variant (read_inventory, read_locations). A
 * separate pass from the products query: nesting levels inside variants inside products would
 * exceed Shopify's query cost limit.
 */
export const VARIANT_INVENTORY_QUERY = `
  query VariantInventory($first: Int!, $after: String) {
    productVariants(first: $first, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        inventoryItem {
          tracked
          unitCost { amount currencyCode }
          inventoryLevels(first: ${LOCATIONS_PER_VARIANT}) {
            pageInfo { hasNextPage }
            nodes {
              location { id name }
              quantities(names: ["on_hand", "available", "committed"]) { name quantity }
            }
          }
        }
      }
    }
  }
`;

export const PRODUCT_VARIANTS_QUERY = `
  query ProductVariants($id: ID!, $after: String) {
    product(id: $id) {
      variants(first: ${NESTED_PAGE_SIZE}, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${VARIANT_FIELDS} } }
    }
  }
`;

const MONEY = 'shopMoney { amount currencyCode }';
const LINE_FIELDS = `
  id title sku quantity currentQuantity
  variant { id }
  originalUnitPriceSet { ${MONEY} }
  totalDiscountSet { ${MONEY} }
  discountedTotalSet { ${MONEY} }
`;

const ORDER_FIELDS = `
  id name note createdAt updatedAt cancelledAt cancelReason
  displayFinancialStatus displayFulfillmentStatus
  tags discountCodes
  subtotalPriceSet { ${MONEY} }
  totalDiscountsSet { ${MONEY} }
  totalShippingPriceSet { ${MONEY} }
  totalTaxSet { ${MONEY} }
  totalPriceSet { ${MONEY} }
  shippingAddress { name phone address1 address2 city province zip countryCodeV2 }
  lineItems(first: ${NESTED_PAGE_SIZE}) { pageInfo { hasNextPage endCursor } nodes { ${LINE_FIELDS} } }
`;

/** Sorted by UPDATED_AT ascending, so a cursor saved after each page is a safe resume point. */
export const ORDERS_QUERY = `
  query Orders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ORDER_FIELDS} }
    }
  }
`;

/**
 * One order by gid, with exactly the fields the bulk sync reads. Webhooks, retries and the
 * catch-up fetch the order this way rather than mapping Shopify's REST webhook payload, so there
 * is a single mapping path for every way an order arrives.
 */
export const ORDER_QUERY = `
  query Order($id: ID!) {
    order(id: $id) { ${ORDER_FIELDS} }
  }
`;

export const ORDER_LINES_QUERY = `
  query OrderLines($id: ID!, $after: String) {
    order(id: $id) {
      lineItems(first: ${NESTED_PAGE_SIZE}, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${LINE_FIELDS} } }
    }
  }
`;
