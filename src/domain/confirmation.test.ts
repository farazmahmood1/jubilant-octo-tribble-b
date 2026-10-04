import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { paisa } from '../lib/money.js';
import { callLink, confirmationOf, formatRupees, whatsappLink } from './confirmation.js';

describe('confirmation from the Shopify tags', () => {
  it('is what the tags say, or pending with nothing said yet', () => {
    assert.deepEqual(confirmationOf('confirmed'), { state: 'confirmed', source: 'shopify_tags' });
    assert.deepEqual(confirmationOf('no_answer'), { state: 'no_answer', source: 'shopify_tags' });
    assert.deepEqual(confirmationOf(null), { state: 'pending', source: 'none' });
  });
});

describe('contact links and amounts', () => {
  it('opens a WhatsApp chat or a call with the number', () => {
    assert.equal(whatsappLink('+923001234567'), 'https://wa.me/923001234567');
    assert.equal(callLink('+923001234567'), 'tel:+923001234567');
  });

  it('formats paisa as rupees without floating point', () => {
    assert.equal(formatRupees(paisa(275_000n)), 'Rs 2,750');
    assert.equal(formatRupees(paisa(123_456_705n)), 'Rs 1,234,567.05');
    assert.equal(formatRupees(paisa(0n)), 'Rs 0');
  });
});
