import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { paymentMethod } from './order-list.js';

describe('paymentMethod', () => {
  it('reads COD and card from Shopify gateway names, and both for an order part-paid ahead', () => {
    assert.equal(paymentMethod(['Cash on Delivery (COD)']), 'cod');
    assert.equal(paymentMethod(['COD']), 'cod');
    assert.equal(paymentMethod(['shopify_payments']), 'card');
    assert.equal(paymentMethod(['PayFast']), 'card');
    assert.equal(paymentMethod(['shopify_payments', 'Cash on Delivery (COD)']), 'card_and_cod');
  });

  it('keeps a manual, bank or gift card payment apart from card', () => {
    assert.equal(paymentMethod(['manual']), 'other');
    assert.equal(paymentMethod(['Bank Deposit']), 'other');
    assert.equal(paymentMethod(['gift_card']), 'other');
  });

  it('is unknown when Shopify named no gateway or the order was not read since', () => {
    assert.equal(paymentMethod([]), null);
    assert.equal(paymentMethod(null), null);
  });

  it('does not read COD inside another word', () => {
    assert.equal(paymentMethod(['Codapay']), 'card');
  });
});
