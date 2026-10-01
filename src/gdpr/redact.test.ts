import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { skipWithoutDb } from '../test/db.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { redactCustomer, redactShop } from './redact.js';

const PHONE = '+923001234567';
const parcelRaw = { trackingNumber: 'x', customerName: 'Test Customer', customerPhone: '03001234567', deliveryAddress: 'House 1', cityName: 'Lahore' };

describe('GDPR redaction of PostEx parcels', { skip: skipWithoutDb }, () => {
  let s: Stores;

  const shipment = async (account: string, tracking: string, orderId: string | null, phone: string | null) => {
    await s.schema.sql`
      insert into shipments (postex_account_id, tracking_number, order_id, match_method, match_confidence, customer_phone, raw, city)
      values (${account}, ${tracking}, ${orderId}, ${orderId ? 'order_ref' : null}, ${orderId ? 1 : null}, ${phone},
              ${s.schema.sql.json({ ...parcelRaw, trackingNumber: tracking })}, 'Lahore')
    `;
  };
  const parcel = async (tracking: string) => {
    const [row] = await s.schema.sql<{ phone: string | null; raw: Record<string, unknown> }[]>`
      select customer_phone as phone, raw from shipments where tracking_number = ${tracking}
    `;
    return row!;
  };

  before(async () => {
    s = await migratedWithStores();
    const [nurAccount] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'N', ${s.nur}) returning id`;
    const [orgAccount] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('organics', 'O', ${s.organics}) returning id`;
    const [customer] = await s.schema.sql<{ id: string }[]>`
      insert into customers (store_id, external_key, shopify_customer_id, name, phone_e164) values (${s.nur}, 'shopify:77', 77, 'Test Customer', ${PHONE}) returning id
    `;
    const [order] = await s.schema.sql<{ id: string }[]>`
      insert into orders (store_id, shopify_order_id, order_number, placed_at, customer_id, subtotal_paisa, total_paisa, channel)
      values (${s.nur}, 1001, '#1001', now(), ${customer!.id}, 0, 0, 'online') returning id
    `;
    await shipment(nurAccount!.id, 'matched', order!.id, PHONE);
    await shipment(nurAccount!.id, 'unmatched-same-phone', null, PHONE);
    await shipment(nurAccount!.id, 'someone-else', null, '+923009999999');
    await shipment(orgAccount!.id, 'other-brand-same-phone', null, PHONE);
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('customers/redact clears the parcel phone and masks the raw parcel, for their orders and unmatched parcels with their phone', async () => {
    const result = await redactCustomer(s.schema.sql, s.nur, { shopifyCustomerId: '77', phone: null, shopifyOrderIds: ['1001'] });
    assert.equal(result.shipments, 2);
    for (const tracking of ['matched', 'unmatched-same-phone']) {
      const row = await parcel(tracking);
      assert.equal(row.phone, null, tracking);
      assert.doesNotMatch(JSON.stringify(row.raw), /Test Customer|03001234567|House 1/, tracking);
      assert.equal(row.raw['cityName'], 'Lahore', 'the city is kept');
    }
  });

  it('leaves another customer\'s parcel, and the other brand\'s parcels, untouched', async () => {
    assert.equal((await parcel('someone-else')).phone, '+923009999999');
    const other = await parcel('other-brand-same-phone');
    assert.equal(other.phone, PHONE, 'a GDPR request is per shop');
    assert.equal(other.raw['customerName'], 'Test Customer');
  });

  it('shop/redact clears every parcel of that store\'s accounts only', async () => {
    const result = await redactShop(s.schema.sql, s.nur);
    assert.equal(result.shipments, 3);
    assert.equal((await parcel('someone-else')).phone, null);
    assert.equal((await parcel('other-brand-same-phone')).phone, PHONE);
  });
});
