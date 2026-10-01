import { createHash } from 'node:crypto';

import { normalizePk } from '../../lib/phone.js';
import { type Db, type UpsertResult, big, blankToNull, readBigint, toUpsertResult } from './upsert.js';

export interface CustomerRow {
  id: string;
  storeId: string;
  externalKey: string;
  shopifyCustomerId: bigint | null;
  name: string | null;
  phoneE164: string | null;
}

export interface CustomerInput {
  storeId: string;
  shopifyCustomerId: bigint | null;
  name: string | null;
  /** As Shopify has it; normalised to `+92…` here, or dropped if it is not a Pakistani mobile. */
  phone: string | null;
  /** The Shopify order id, used to key a guest who left no usable phone. */
  shopifyOrderId: bigint | null;
}

/**
 * The idempotency key for a customer. A Shopify customer id is the strongest; a guest is keyed
 * by phone, so their repeat orders and refusals land on one row; a guest with neither is keyed
 * by the order, so re-syncing it does not create a second row. Null when none applies.
 */
export const customerKey = (input: Pick<CustomerInput, 'shopifyCustomerId' | 'phone' | 'shopifyOrderId'>): string | null => {
  if (input.shopifyCustomerId !== null) return `shopify:${big(input.shopifyCustomerId)}`;
  const phone = normalizePk(input.phone);
  if (phone) return `phone:${phone}`;
  if (input.shopifyOrderId !== null) return `order:${input.shopifyOrderId}`;
  return null;
};

/** Keyed on (store, external key); returns null when the customer cannot be keyed at all. */
export const upsertCustomer = async (db: Db, input: CustomerInput): Promise<UpsertResult | null> => {
  const key = customerKey(input);
  if (!key) return null;
  const [row] = await db<{ id: string; inserted: boolean; changed: boolean }[]>`
    with prev as (
      select to_jsonb(c) - 'updated_at' as doc from customers c where store_id = ${input.storeId} and external_key = ${key}
    )
    insert into customers (store_id, external_key, shopify_customer_id, name, phone_e164)
    values (${input.storeId}, ${key}, ${big(input.shopifyCustomerId)}, ${blankToNull(input.name)}, ${normalizePk(input.phone)})
    on conflict (store_id, external_key) do update
      set name = excluded.name, phone_e164 = excluded.phone_e164
    returning id, (xmax = 0) as inserted, (select doc from prev) is distinct from (to_jsonb(customers) - 'updated_at') as changed
  `;
  return toUpsertResult(row);
};

export const findCustomer = async (db: Db, id: string): Promise<CustomerRow | null> => {
  const [row] = await db<{ id: string; store_id: string; external_key: string; shopify_customer_id: string | null; name: string | null; phone_e164: string | null }[]>`
    select id, store_id, external_key, shopify_customer_id::text, name, phone_e164 from customers where id = ${id}
  `;
  if (!row) return null;
  return {
    id: row.id,
    storeId: row.store_id,
    externalKey: row.external_key,
    shopifyCustomerId: row.shopify_customer_id === null ? null : readBigint(row.shopify_customer_id),
    name: row.name,
    phoneE164: row.phone_e164,
  };
};

export interface AddressInput {
  line1: string | null;
  line2: string | null;
  city: string | null;
  province: string | null;
  postal: string | null;
  country: string | null;
}

const FIELDS: ReadonlyArray<keyof AddressInput> = ['line1', 'line2', 'city', 'province', 'postal', 'country'];

/** Case- and spacing-insensitive, so "House 1,  Lahore" and "house 1, lahore" are one address. */
export const addressFingerprint = (address: AddressInput): string =>
  createHash('sha256')
    .update(FIELDS.map((f) => (address[f] ?? '').trim().toLowerCase().replace(/\s+/g, ' ')).join('\u001f'))
    .digest('hex');

/**
 * Stores a customer's address once, however many orders use it. An address never changes in
 * place: a different address is a different row, so old orders keep the address they shipped to.
 */
export const upsertAddress = async (db: Db, customerId: string, address: AddressInput): Promise<UpsertResult> => {
  const values = Object.fromEntries(FIELDS.map((f) => [f, blankToNull(address[f])])) as unknown as AddressInput;
  const [row] = await db<{ id: string; inserted: boolean; changed: boolean }[]>`
    insert into addresses (customer_id, fingerprint, line1, line2, city, province, postal, country)
    values (${customerId}, ${addressFingerprint(address)}, ${values.line1}, ${values.line2}, ${values.city},
            ${values.province}, ${values.postal}, ${values.country})
    on conflict (customer_id, fingerprint) do update set fingerprint = excluded.fingerprint
    returning id, (xmax = 0) as inserted, false as changed
  `;
  return toUpsertResult(row);
};
