import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { line, order, product, variant } from '../../test/shopify-fake.js';
import { ShopifyMappingError, mapOrder, mapProduct, parseGid, postexTrackingFromNote } from './mapper.js';
import { ORDERS_QUERY } from './queries.js';

describe('parseGid', () => {
  it('reads the numeric id, beyond 2^53 too', () => {
    assert.equal(parseGid('gid://shopify/Order/5000000001', 'Order'), 5_000_000_001n);
    assert.equal(parseGid('gid://shopify/Order/9007199254740993', 'Order'), 9_007_199_254_740_993n);
  });

  it('refuses a gid of another type or a malformed one', () => {
    assert.throws(() => parseGid('gid://shopify/ProductVariant/1', 'Product'), ShopifyMappingError);
    assert.throws(() => parseGid('1234', 'Order'), ShopifyMappingError);
  });
});

describe('mapProduct', () => {
  it('maps the product and its variants, keeping a missing SKU as null', () => {
    assert.deepEqual(mapProduct(product(11, [variant(21, 'NBJ-1'), variant(22, null)])), {
      product: { shopifyProductId: 11n, title: 'Product 11', brand: 'NUR', status: 'ACTIVE' },
      variants: [
        { shopifyVariantId: 21n, sku: 'NBJ-1', title: 'Variant 21', barcode: null },
        { shopifyVariantId: 22n, sku: null, title: 'Variant 22', barcode: null },
      ],
    });
  });
});

describe('postexTrackingFromNote', () => {
  it('reads the tracking number the Book at PostEx app writes', () => {
    assert.deepEqual(postexTrackingFromNote('Order has been shipped via PostEx with Tracking 20000000000462.'), ['20000000000462']);
  });

  it('takes several, once each, and the usual spellings', () => {
    assert.deepEqual(
      postexTrackingFromNote('Order has been shipped via PostEx with Tracking 20000000000462\nRe-sent: tracking no. 20000000000999; Tracking #20000000000462'),
      ['20000000000462', '20000000000999'],
    );
    assert.deepEqual(postexTrackingFromNote('tracking number: 20000000000123'), ['20000000000123']);
  });

  it('never takes a phone number, an amount or a number not following "tracking"', () => {
    assert.deepEqual(postexTrackingFromNote('Call 03001234567 before delivery, COD 2750'), []);
    assert.deepEqual(postexTrackingFromNote('Tracking 12345'), [], 'too short to be a parcel');
    assert.deepEqual(postexTrackingFromNote(null), []);
  });
});

describe('mapOrder', () => {
  it('maps money to Paisa, statuses lowercased, and the shipping phone first', () => {
    const mapped = mapOrder(
      order(1001, '2026-09-01T10:00:00Z', {
        customer: { id: 'gid://shopify/Customer/77', firstName: 'Test', lastName: 'Customer', phone: '+923111111111' },
        lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [line(5, 21, 2, '500.00')] },
      }),
    );
    assert.equal(mapped.order.shopifyOrderId, 1001n);
    assert.equal(mapped.order.orderNumber, '#1001');
    assert.equal(mapped.order.total, 125_000n);
    assert.equal(mapped.order.shipping, 25_000n);
    assert.equal(mapped.order.financialStatus, 'pending');
    assert.equal(mapped.order.channel, 'online');
    assert.deepEqual(mapped.order.placedAt, new Date('2026-09-01T10:00:00Z'));
    assert.deepEqual(mapped.customer, { shopifyCustomerId: 77n, name: 'Test Customer', phone: '0300 1234567' });
    assert.deepEqual(mapped.lines, [
      { lineKey: 'shopify:5', shopifyVariantId: 21n, sku: 'SKU-21', title: 'Item 5', qty: 2, unitPrice: 50_000n, discount: 0n, total: 100_000n },
    ]);
  });

  it('falls back to the customer phone, and to the address name, when the other is missing', () => {
    const mapped = mapOrder(
      order(1, '2026-09-01T10:00:00Z', {
        customer: { id: 'gid://shopify/Customer/1', firstName: null, lastName: null, phone: '03001234567' },
        shippingAddress: { name: 'Ship Name', phone: null, address1: null, address2: null, city: 'Karachi', province: null, zip: null, countryCodeV2: 'PK' },
      }),
    );
    assert.equal(mapped.customer.phone, '03001234567');
    assert.equal(mapped.customer.name, 'Ship Name');
  });

  it('is PR only when staff tagged it PR; a free order stays online for a person to classify', () => {
    assert.equal(mapOrder(order(1, '2026-09-01T10:00:00Z', { tags: [' pr '] })).order.channel, 'pr');
    const free = order(2, '2026-09-01T10:00:00Z', { totalPriceSet: { shopMoney: { amount: '0.00', currencyCode: 'PKR' } } });
    assert.equal(mapOrder(free).order.channel, 'online');
  });

  it('counts an item removed by an order edit as quantity 0', () => {
    const edited = { ...line(9, null, 3), currentQuantity: 0 };
    assert.equal(mapOrder(order(1, '2026-09-01T10:00:00Z', { lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [edited] } })).lines[0]?.qty, 0);
  });

  it('maps a cancellation and an order with no address', () => {
    const mapped = mapOrder(order(1, '2026-09-01T10:00:00Z', { cancelledAt: '2026-09-02T08:00:00Z', cancelReason: 'CUSTOMER', shippingAddress: null }));
    assert.deepEqual(mapped.order.cancelledAt, new Date('2026-09-02T08:00:00Z'));
    assert.equal(mapped.order.cancelReason, 'customer');
    assert.equal(mapped.address, null);
  });

  it('refuses an amount that is not in PKR rather than mixing currencies', () => {
    const usd = order(1, '2026-09-01T10:00:00Z', { totalPriceSet: { shopMoney: { amount: '10.00', currencyCode: 'USD' } } });
    assert.throws(() => mapOrder(usd), /total is in USD, expected PKR/);
  });

  it('never asks Shopify for customer email (1.9)', () => {
    assert.doesNotMatch(ORDERS_QUERY, /email/i);
  });
});
