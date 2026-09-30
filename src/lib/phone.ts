// Urdu keyboards type Extended Arabic-Indic digits (۰–۹); some Arabic input sends ٠–٩.
const toAsciiDigits = (text: string): string =>
  text.replace(/[۰-۹٠-٩]/g, (d) => String((d.codePointAt(0) ?? 0) & 0xf));

/** Separators customers and couriers put inside a number. Anything else makes it unusable. */
const SEPARATORS = /[\s\-.()/ ]/g;

/**
 * Normalises a Pakistani mobile number to `+923001234567`, or returns `null`.
 *
 * Accepts the shapes that occur in Shopify and PostEx data: `03001234567`, `+923001234567`,
 * `923001234567`, `00923001234567`, `3001234567` (the leading zero lost to a numeric column),
 * `+920300…` (country code *and* trunk zero), with spaces, dashes, dots and brackets.
 *
 * Mobiles only: this is the key for WhatsApp confirmation and refusal history, and a landline
 * can do neither. Two numbers in one field, letters or an extension return `null` rather than
 * a guess. Never throws, whatever it is given.
 */
export const normalizePk = (raw: unknown): string | null => {
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || raw < 0) return null;
    raw = String(raw);
  }
  if (typeof raw !== 'string') return null;

  let digits = toAsciiDigits(raw.trim()).replace(/^tel:/i, '').replace(SEPARATORS, '');
  // After + or 00 the country code is explicit; +3001234567 is a European number, not Pakistan.
  const international = digits.startsWith('+') || digits.startsWith('00');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d+$/.test(digits)) return null;
  if (international && !digits.startsWith('92')) return null;

  let national: string;
  if (digits.startsWith('92')) national = digits.slice(2).replace(/^0/, '');
  else if (digits.startsWith('0')) national = digits.slice(1);
  else national = digits;

  // Mobile: a 3xx operator code followed by seven digits.
  return /^3\d{9}$/.test(national) ? `+92${national}` : null;
};
