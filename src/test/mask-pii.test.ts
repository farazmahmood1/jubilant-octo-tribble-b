import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MASK, maskPii } from './mask-pii.js';

describe('maskPii', () => {
  it('masks PostEx customer fields and keeps everything matching depends on', () => {
    const parcel = {
      trackingNumber: '20000000000001',
      orderRefNumber: '#10001',
      customerName: 'Test Customer',
      consignee_name: 'Test Customer',
      customerPhone: '03000000000',
      deliveryAddress: 'House 1, Street 1',
      cityName: 'Lahore',
      merchantName: 'NUR by Juggun',
      invoicePayment: 2500,
    };

    assert.deepEqual(maskPii(parcel), {
      ...parcel,
      customerName: MASK,
      consignee_name: MASK,
      customerPhone: MASK,
      deliveryAddress: MASK,
    });
  });

  it('masks nested objects and arrays at any depth', () => {
    const order = {
      name: '#10001',
      email: 'someone@example.com',
      customer: { firstName: 'A', lastName: 'B', phone: '+923000000000', tags: ['vip'] },
      shippingAddress: { name: 'A B', address1: 'House 1', address2: null, city: 'Karachi', phone: '+923000000000' },
      lineItems: { nodes: [{ name: 'Face serum', quantity: 1 }] },
      fulfillments: [{ trackingInfo: [{ number: '123' }], destination: { name: 'A B', phone: '0300' } }],
    };

    const masked = maskPii(order);

    assert.equal(masked.name, '#10001', 'order name is what shipments match on');
    assert.equal(masked.email, MASK);
    assert.deepEqual(masked.customer, { firstName: MASK, lastName: MASK, phone: MASK, tags: ['vip'] });
    assert.deepEqual(masked.shippingAddress, { name: MASK, address1: MASK, address2: null, city: 'Karachi', phone: MASK });
    assert.equal(masked.lineItems.nodes[0]?.name, 'Face serum', 'a product name is not a person');
    assert.deepEqual(masked.fulfillments[0]?.destination, { name: MASK, phone: MASK });
  });

  it('leaves non-PII untouched and does not modify its input', () => {
    const input = { total: 125000, tags: ['PR'], status: 'Delivered', history: [{ code: '0005' }] };
    const copy = structuredClone(input);

    assert.deepEqual(maskPii(input), copy);
    assert.deepEqual(input, copy);
    assert.notEqual(maskPii(input), input);
  });

  it('never throws on null or undefined, at the top or nested', () => {
    assert.equal(maskPii(null), null);
    assert.equal(maskPii(undefined), undefined);
    assert.deepEqual(maskPii({ phone: undefined, customer: null, items: [null, undefined] }), {
      phone: undefined,
      customer: null,
      items: [null, undefined],
    });
  });

  it('masks the other identifying fields of a REST webhook payload', () => {
    const payload = {
      note: 'Call before coming, house behind the mosque',
      browser_ip: '203.0.113.7',
      shipping_address: { first_name: 'A', last_name: 'B', zip: '54000', company: 'Shop', latitude: 31.5, longitude: 74.3, city: 'Lahore' },
      note_attributes: [],
      total_price: '1250.00',
    };
    assert.deepEqual(maskPii(payload), {
      note: MASK,
      browser_ip: MASK,
      shipping_address: { first_name: MASK, last_name: MASK, zip: MASK, company: MASK, latitude: MASK, longitude: MASK, city: 'Lahore' },
      note_attributes: [],
      total_price: '1250.00',
    });
  });

  it('masks numeric PII too', () => {
    assert.deepEqual(maskPii({ customerPhone: 3000000000 }), { customerPhone: MASK });
  });
});
