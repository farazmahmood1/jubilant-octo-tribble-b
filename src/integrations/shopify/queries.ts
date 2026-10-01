/**
 * Admin GraphQL documents for the catalogue and order syncs (API version from config).
 *
 * Only the customer fields delivery needs are requested: names and phones, never email (1.9).
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

/** Sorted by UPDATED_AT ascending, so a cursor saved after each page is a safe resume point. */
export const ORDERS_QUERY = `
  query Orders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id name createdAt updatedAt cancelledAt cancelReason
        displayFinancialStatus displayFulfillmentStatus
        tags discountCodes
        subtotalPriceSet { ${MONEY} }
        totalDiscountsSet { ${MONEY} }
        totalShippingPriceSet { ${MONEY} }
        totalTaxSet { ${MONEY} }
        totalPriceSet { ${MONEY} }
        customer { id firstName lastName phone }
        shippingAddress { name phone address1 address2 city province zip countryCodeV2 }
        lineItems(first: ${NESTED_PAGE_SIZE}) { pageInfo { hasNextPage endCursor } nodes { ${LINE_FIELDS} } }
      }
    }
  }
`;

export const ORDER_LINES_QUERY = `
  query OrderLines($id: ID!, $after: String) {
    order(id: $id) {
      lineItems(first: ${NESTED_PAGE_SIZE}, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${LINE_FIELDS} } }
    }
  }
`;
