/**
 * Money is integer paisa (PKR × 100) held in a bigint. Nothing in this module uses floating
 * point: numbers from outside are converted through their decimal string, and every division
 * states how it rounds. The brand stops a raw bigint (a count, an id) being passed as money.
 */
export type Paisa = bigint & { readonly __brand: 'Paisa' };

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export const ZERO = 0n as Paisa;

export const paisa = (value: bigint): Paisa => value as Paisa;

// Groups of three (1,234,567) or the South Asian lakh grouping (12,34,567). Anything else with
// a comma, such as "1,23" (a decimal comma elsewhere), is rejected rather than guessed at.
const WESTERN_GROUPS = /^\d{1,3}(?:,\d{3})+$/;
const LAKH_GROUPS = /^\d{1,2}(?:,\d{2})*,\d{3}$/;
const PLAIN = /^\d+$/;

/**
 * Parses a rupee amount such as `"1,234.50"`, `"-99"` or `"2500.00"`.
 *
 * Rejects rather than guesses: empty strings, currency symbols, exponents, a bare `"."`,
 * `".5"` or `"5."`, a leading `+`, spaces inside the number, and more than two decimals unless
 * the extras are zeros (`"1.500"` is fine, `"1.505"` is a fraction of a paisa and is not).
 */
export const fromRupeeString = (input: string): Paisa => {
  const text = input.trim();
  const match = /^(-)?([\d,]+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new MoneyError(`Not a rupee amount: "${input}"`);

  const [, sign, whole = '', fraction = ''] = match;
  if (!PLAIN.test(whole) && !WESTERN_GROUPS.test(whole) && !LAKH_GROUPS.test(whole)) {
    throw new MoneyError(`Ambiguous digit grouping: "${input}"`);
  }
  if (/[^0]/.test(fraction.slice(2))) {
    throw new MoneyError(`More precise than one paisa: "${input}"`);
  }

  const value = BigInt(whole.replaceAll(',', '')) * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0'));
  return paisa(sign ? -value : value);
};

/**
 * Converts a rupee amount that arrived as a JS number (PostEx sends `invoicePayment: 2500`).
 * Goes through the number's shortest decimal string, so `0.1 + 0.2` is rejected as more precise
 * than a paisa instead of being silently rounded.
 */
export const fromNumber = (rupees: number): Paisa => {
  if (!Number.isFinite(rupees)) throw new MoneyError(`Not a finite amount: ${rupees}`);
  const text = String(rupees);
  if (/e/i.test(text)) throw new MoneyError(`Amount out of range: ${text}`);
  return fromRupeeString(text);
};

/** `"1234.50"`, `"-0.05"`: plain digits with two decimals, parseable by `fromRupeeString`. */
export const toRupeeString = (amount: Paisa): string => {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const rupees = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${rupees}.${cents}`;
};

export const add = (a: Paisa, b: Paisa): Paisa => paisa(a + b);

export const sub = (a: Paisa, b: Paisa): Paisa => paisa(a - b);

export const sum = (amounts: Iterable<Paisa>): Paisa => {
  let total = 0n;
  for (const amount of amounts) total += amount;
  return paisa(total);
};

/** A fraction such as 16/100 for a 16% tax. The denominator is always positive. */
export interface Ratio {
  readonly num: bigint;
  readonly den: bigint;
}

export const ratio = (num: bigint, den: bigint): Ratio => {
  if (den === 0n) throw new MoneyError('Ratio denominator cannot be zero');
  return den < 0n ? { num: -num, den: -den } : { num, den };
};

/**
 * - `half-up`: halves round away from zero, so 0.5 → 1 and -0.5 → -1 (commercial rounding).
 * - `down`: toward zero, dropping the remainder.
 * - `up`: away from zero whenever there is any remainder.
 */
export type Rounding = 'half-up' | 'down' | 'up';

const divide = (numerator: bigint, denominator: bigint, rounding: Rounding): bigint => {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;

  const away = numerator < 0n ? -1n : 1n;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  switch (rounding) {
    case 'down':
      return quotient;
    case 'up':
      return quotient + away;
    case 'half-up':
      return twiceRemainder >= denominator ? quotient + away : quotient;
  }
};

/**
 * Multiplies by a whole number (exact) or by a ratio (rounded as stated). There is no default
 * rounding for ratios: a tax, a split and a discount can each need a different one.
 */
export function mul(amount: Paisa, factor: bigint | number): Paisa;
export function mul(amount: Paisa, factor: Ratio, rounding: Rounding): Paisa;
export function mul(amount: Paisa, factor: bigint | number | Ratio, rounding?: Rounding): Paisa {
  if (typeof factor === 'object') {
    if (!rounding) throw new MoneyError('Multiplying by a ratio needs an explicit rounding mode');
    return paisa(divide(amount * factor.num, factor.den, rounding));
  }
  if (typeof factor === 'number' && !Number.isSafeInteger(factor)) {
    throw new MoneyError(`Multiplier must be a whole number, got ${factor}; use a ratio instead`);
  }
  return paisa(amount * BigInt(factor));
}
