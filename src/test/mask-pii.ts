export const MASK = '[masked]';

/**
 * Keys that hold customer PII wherever they appear. Matched on the lowercased key, so
 * `customerPhone`, `deliveryAddress`, `address1` and `contact_email` are all caught.
 */
const PII_KEY = /phone|email|address/;

/** Person-name keys. Matched whole: `cityName` and `merchantName` are not PII. */
const NAME_KEY = /^(first|last|full|customer|consignee|receiver|contact)_?name$/;

/**
 * A bare `name` means different things by context: on an order it is "#63648", which matching
 * depends on; inside a customer or an address it is a person. Only the second is masked.
 */
const PERSON_CONTEXT = /customer|address|billing|shipping|destination|consignee|receiver/;

const isPiiKey = (key: string, inPerson: boolean): boolean => {
  const lower = key.toLowerCase();
  if (NAME_KEY.test(lower)) return true;
  if (lower === 'name') return inPerson;
  return PII_KEY.test(lower);
};

const walk = (value: unknown, inPerson: boolean): unknown => {
  if (Array.isArray(value)) return value.map((item) => walk(item, inPerson));
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // An address object is recursed into rather than masked whole, so `city` survives: city
    // drives matching and the return-rate reports, and on its own identifies nobody.
    if (isPiiKey(key, inPerson) && (child === null || typeof child !== 'object')) {
      out[key] = child === null || child === undefined ? child : MASK;
    } else {
      out[key] = walk(child, inPerson || PERSON_CONTEXT.test(key.toLowerCase()));
    }
  }
  return out;
};

/**
 * Returns a copy of a recorded Shopify or PostEx response with customer names, phones,
 * addresses and emails replaced, so it can be committed as a fixture. The input is not
 * modified, and `null`/`undefined` pass through.
 */
export const maskPii = <T>(value: T): T => walk(value, false) as T;
