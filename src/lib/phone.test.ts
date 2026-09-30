import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizePk } from './phone.js';

// Shapes seen in Shopify addresses and PostEx parcels. The subscriber digits are placeholders.
const valid: Array<[unknown, string]> = [
  ['03001234567', '+923001234567'],
  ['+923001234567', '+923001234567'],
  ['923001234567', '+923001234567'],
  ['92 300 1234567', '+923001234567'],
  ['0300-1234567', '+923001234567'],
  ['0300 1234567', '+923001234567'],
  ['0300 123 4567', '+923001234567'],
  ['(0300) 1234567', '+923001234567'],
  ['+92 (300) 123-4567', '+923001234567'],
  ['+92-300-1234567', '+923001234567'],
  ['0092 300 1234567', '+923001234567'],
  ['+92 0300 1234567', '+923001234567'],
  ['92-0300-1234567', '+923001234567'],
  ['3001234567', '+923001234567'],
  [3001234567, '+923001234567'],
  ['  0321.1234567  ', '+923211234567'],
  ['0345/1234567', '+923451234567'],
  ['tel:+923331234567', '+923331234567'],
  ['۰۳۰۰۱۲۳۴۵۶۷', '+923001234567'],
  ['0300 1234567', '+923001234567'],
];

const invalid: unknown[] = [
  '',
  '   ',
  '0300123456',
  '030012345678',
  '04235761234',
  '+14155550100',
  '+3001234567',
  '00443001234567',
  '0300-1234567 ext 12',
  '03001234567 / 03111234567',
  'call me',
  '0300-12345ab',
  null,
  undefined,
  {},
  [],
  Number.NaN,
  -3001234567,
  3.001234567e9 + 0.5,
  Symbol('phone'),
];

describe('normalizePk', () => {
  for (const [raw, expected] of valid) {
    it(`normalises ${JSON.stringify(raw)}`, () => assert.equal(normalizePk(raw), expected));
  }

  for (const raw of invalid) {
    it(`returns null for ${typeof raw === 'symbol' ? 'a symbol' : JSON.stringify(raw) ?? String(raw)}`, () => {
      assert.equal(normalizePk(raw), null);
    });
  }
});
