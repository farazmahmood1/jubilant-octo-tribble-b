import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  MoneyError,
  type Paisa,
  type Rounding,
  ZERO,
  add,
  allocate,
  fromNumber,
  fromRupeeString,
  mul,
  paisa,
  ratio,
  sub,
  sum,
  toRupeeString,
} from './money.js';

describe('fromRupeeString', () => {
  const valid: Array<[string, bigint]> = [
    ['0', 0n],
    ['0.00', 0n],
    ['1', 100n],
    ['2500', 250_000n],
    ['2500.00', 250_000n],
    ['1234.5', 123_450n],
    ['1234.50', 123_450n],
    ['1234.500', 123_450n],
    ['0.05', 5n],
    ['0.5', 50n],
    ['1,234', 123_400n],
    ['1,234.50', 123_450n],
    ['1,234,567.89', 123_456_789n],
    ['12,34,567.89', 123_456_789n],
    ['1,00,000', 10_000_000n],
    ['-1', -100n],
    ['-0.05', -5n],
    ['-1,234.50', -123_450n],
    ['-0', 0n],
    ['  275980  ', 27_598_000n],
    ['99999999999999999.99', 9_999_999_999_999_999_999n],
  ];
  for (const [input, expected] of valid) {
    it(`parses "${input}"`, () => assert.equal(fromRupeeString(input), expected));
  }

  const rejected = [
    '',
    '   ',
    '.',
    '.5',
    '5.',
    '+5',
    '--5',
    '1.505',
    '1.2.3',
    '1,23',
    '1,2345',
    ',123',
    '123,',
    '1 234',
    'Rs 100',
    'PKR100',
    '1e3',
    '0x10',
    'NaN',
    '١٢٣',
  ];
  for (const input of rejected) {
    it(`rejects "${input}"`, () => assert.throws(() => fromRupeeString(input), MoneyError));
  }
});

describe('fromNumber', () => {
  it('converts whole and two-decimal rupee numbers exactly', () => {
    assert.equal(fromNumber(2500), 250_000n);
    assert.equal(fromNumber(237.5), 23_750n);
    assert.equal(fromNumber(-19.99), -1_999n);
    assert.equal(fromNumber(0), 0n);
  });

  it('rejects float noise instead of rounding it away', () => {
    assert.throws(() => fromNumber(0.1 + 0.2), MoneyError);
  });

  it('rejects non-finite and exponent-sized values', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1e21, 1e-7]) {
      assert.throws(() => fromNumber(value), MoneyError, String(value));
    }
  });
});

describe('toRupeeString', () => {
  it('formats with two decimals and round-trips through fromRupeeString', () => {
    const cases: Array<[bigint, string]> = [
      [0n, '0.00'],
      [5n, '0.05'],
      [-5n, '-0.05'],
      [123_450n, '1234.50'],
      [-123_456_789n, '-1234567.89'],
    ];
    for (const [amount, text] of cases) {
      assert.equal(toRupeeString(paisa(amount)), text);
      assert.equal(fromRupeeString(text), amount);
    }
  });
});

describe('add, sub, sum', () => {
  it('are exact on amounts no float could hold', () => {
    const big = paisa(9_007_199_254_740_993n);
    assert.equal(add(big, paisa(1n)), 9_007_199_254_740_994n);
    assert.equal(sub(ZERO, big), -9_007_199_254_740_993n);
  });

  it('sums PostEx charges, and an empty list is zero', () => {
    assert.equal(sum([fromNumber(237), fromNumber(37.92), fromNumber(-0.92)]), 27_400n);
    assert.equal(sum([]), 0n);
  });
});

describe('mul', () => {
  it('multiplies by a whole number exactly', () => {
    assert.equal(mul(fromNumber(1250), 3), 375_000n);
    assert.equal(mul(fromNumber(1250), -2n), -250_000n);
  });

  it('refuses a fractional number multiplier', () => {
    assert.throws(() => mul(fromNumber(100), 1.5), MoneyError);
  });

  it('refuses a ratio without a rounding mode', () => {
    // The overloads make this call impossible in TypeScript; plain JS callers can still make it.
    const unsafeMul = mul as unknown as (a: Paisa, f: ReturnType<typeof ratio>) => Paisa;
    assert.throws(() => unsafeMul(fromNumber(100), ratio(1n, 3n)), /explicit rounding/);
  });

  // 5 paisa × 1/2 lands exactly on 2.5, the boundary each mode must treat differently, in both
  // signs. The 16/100 rows are the PostEx tax rate on real charge amounts.
  const cases: Array<[bigint, [bigint, bigint], Rounding, bigint]> = [
    [5n, [1n, 2n], 'half-up', 3n],
    [5n, [1n, 2n], 'down', 2n],
    [5n, [1n, 2n], 'up', 3n],
    [-5n, [1n, 2n], 'half-up', -3n],
    [-5n, [1n, 2n], 'down', -2n],
    [-5n, [1n, 2n], 'up', -3n],
    [7n, [1n, 3n], 'half-up', 2n],
    [8n, [1n, 3n], 'half-up', 3n],
    [7n, [1n, 3n], 'up', 3n],
    [313n, [16n, 100n], 'half-up', 50n],
    [23_750n, [16n, 100n], 'half-up', 3_800n],
    [100n, [1n, -4n], 'half-up', -25n],
  ];
  for (const [amount, [num, den], rounding, expected] of cases) {
    it(`${amount} × ${num}/${den} (${rounding}) = ${expected}`, () => {
      assert.equal(mul(paisa(amount), ratio(num, den), rounding), expected);
    });
  }

  it('refuses a zero denominator', () => {
    assert.throws(() => ratio(1n, 0n), MoneyError);
  });
});

describe('allocate', () => {
  it('splits in proportion and always adds back to the amount, to the paisa', () => {
    assert.deepEqual(allocate(paisa(1000n), [1n, 1n, 1n]), [334n, 333n, 333n]);
    assert.deepEqual(allocate(paisa(275_000n), [200_000n, 50_000n]), [220_000n, 55_000n]);
    assert.deepEqual(allocate(paisa(-1000n), [1n, 1n, 1n]), [-334n, -333n, -333n], 'a reversal splits as the mirror of its sale');
    assert.deepEqual(allocate(paisa(5n), [0n, 0n]), [3n, 2n], 'equal shares when every weight is zero');
    assert.deepEqual(allocate(paisa(10n), [1n, 2n, 0n]), [3n, 7n, 0n], 'largest remainder first');
    for (let amount = 0n; amount < 300n; amount += 7n) {
      const parts = allocate(paisa(amount), [3n, 5n, 11n, 0n, 1n]);
      assert.equal(parts.reduce((t, p) => t + p, 0n), amount);
    }
    assert.throws(() => allocate(paisa(1n), []), MoneyError);
    assert.throws(() => allocate(paisa(1n), [-1n]), MoneyError);
  });
});

describe('money module', () => {
  it('contains no floating-point operations', () => {
    const source = readFileSync(new URL('./money.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    for (const forbidden of [/\bparseFloat\b/, /\bparseInt\b/, /\bNumber\(/, /\btoFixed\b/, /\btoPrecision\b/, /\bMath\./, /\b\d+\.\d+\b/]) {
      assert.doesNotMatch(source, forbidden);
    }
  });
});
