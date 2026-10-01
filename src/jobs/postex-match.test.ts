import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { skipWithoutDb } from '../test/db.js';
import { orderWithLines } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { type MatchCounts, SUGGESTED_KIND, UNMATCHED_KIND, matchUnmatched } from './postex-match.js';

const BOOKED = new Date('2026-09-10T08:00:00Z');
const PLACED = new Date('2026-09-09T08:00:00Z');

describe('matching wired into the sync', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let nurAccount: { id: string; key: string };
  let strayAccount: { id: string; key: string };
  let tracking = 1;

  before(async () => {
    s = await migratedWithStores();
    const [nur] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    const [stray] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label) values ('stray', 'No store yet') returning id`;
    nurAccount = { id: nur!.id, key: 'nur' };
    strayAccount = { id: stray!.id, key: 'stray' };
    await s.schema.sql`insert into app_settings (key, value) values ('matching', ${s.schema.sql.json({ refPrefixes: { nur: ['NBJ'] } })})`;
  });

  after(async () => {
    await s?.schema.drop();
  });

  const shipment = async (accountId: string, fields: { ref?: string | null; cod?: bigint; city?: string; phone?: string }) => {
    const [row] = await s.schema.sql<{ id: string }[]>`
      insert into shipments (postex_account_id, tracking_number, order_ref_number, cod_amount_paisa, city, customer_phone, booked_at)
      values (${accountId}, ${`M${tracking++}`}, ${fields.ref ?? null}, ${fields.cod?.toString() ?? null}, ${fields.city ?? null}, ${fields.phone ?? null}, ${BOOKED})
      returning id
    `;
    return row!.id;
  };
  const link = async (id: string) => {
    const [row] = await s.schema.sql<{ order_id: string | null; match_method: string | null }[]>`select order_id, match_method from shipments where id = ${id}`;
    return row!;
  };
  const openItem = async (kind: string, shipmentId: string) => {
    const [row] = await s.schema.sql<{ detail: Record<string, unknown> }[]>`
      select detail from reconciliation_items where kind = ${kind} and shipment_id = ${shipmentId} and status = 'open'
    `;
    return row?.detail ?? null;
  };
  const run = async (account = nurAccount) => {
    const counts: MatchCounts = { matched: 0, suggested: 0, unmatched: 0 };
    const linked = await matchUnmatched(s.schema.sql, account, counts);
    return { counts, linked };
  };

  it('links by order number with the store prefix, by COD + city, and by phone; queues the rest with a reason', async () => {
    const byRef = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#1201', placedAt: new Date('2026-07-01T08:00:00Z'), lines: [] });
    const byCod = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#1202', placedAt: PLACED, totalPaisa: 345_600n, city: 'Multan', lines: [] });
    const byPhone = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#1203', placedAt: PLACED, totalPaisa: 111_100n, phone: '+923001112233', lines: [] });
    // The other brand's order with the same number never matches a NUR parcel.
    await orderWithLines(s.schema.sql, { storeId: s.organics, number: '#1299', placedAt: PLACED, lines: [] });

    const refParcel = await shipment(nurAccount.id, { ref: 'NBJ-1201' });
    const codParcel = await shipment(nurAccount.id, { cod: 345_600n, city: 'multan ' });
    const phoneParcel = await shipment(nurAccount.id, { cod: 999_900n, phone: '+923001112233' });
    const foreign = await shipment(nurAccount.id, { ref: 'JO-1201' });
    const otherStore = await shipment(nurAccount.id, { ref: '#1299' });
    const nothing = await shipment(nurAccount.id, { cod: 1n, city: 'Nowhere' });
    const noStore = await shipment(strayAccount.id, { ref: '#1201' });

    const { counts, linked } = await run();
    assert.deepEqual(counts, { matched: 3, suggested: 2, unmatched: 3 });
    assert.deepEqual(linked.sort(), [refParcel, codParcel, phoneParcel].sort());
    assert.deepEqual(await link(refParcel), { order_id: byRef, match_method: 'order_ref' });
    assert.deepEqual(await link(codParcel), { order_id: byCod, match_method: 'cod_city_window' });
    assert.deepEqual(await link(phoneParcel), { order_id: byPhone, match_method: 'phone_window' });

    assert.equal(await openItem(SUGGESTED_KIND, refParcel), null, 'a link by order number needs no second look');
    assert.equal((await openItem(SUGGESTED_KIND, codParcel))?.['method'], 'cod_city_window');
    assert.equal((await openItem(UNMATCHED_KIND, foreign))?.['reason'], 'foreign_ref_prefix');
    assert.equal((await openItem(UNMATCHED_KIND, otherStore))?.['reason'], 'order_ref_not_found');
    assert.equal((await openItem(UNMATCHED_KIND, nothing))?.['reason'], 'no_candidate_matched');

    const stray = await run(strayAccount);
    assert.deepEqual(stray.counts, { matched: 0, suggested: 0, unmatched: 1 });
    assert.equal((await openItem(UNMATCHED_KIND, noStore))?.['reason'], 'account_has_no_store');
  });

  it('is idempotent: a second run links nothing new and opens no second item', async () => {
    const [before] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from reconciliation_items`;
    const { counts } = await run();
    assert.deepEqual(counts, { matched: 0, suggested: 0, unmatched: 3 });
    const [afterRun] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from reconciliation_items`;
    assert.equal(afterRun?.n, before?.n);
  });

  it('resolves the unmatched item when the order turns up later, and marks the parcel for the stock pass', async () => {
    const parcel = await shipment(nurAccount.id, { ref: '#1250' });
    await run();
    assert.equal((await openItem(UNMATCHED_KIND, parcel))?.['reason'], 'order_ref_not_found');
    await s.schema.sql`update shipments set stock_pending = false where id = ${parcel}`;

    const order = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#1250', placedAt: PLACED, lines: [] });
    await run();
    assert.deepEqual(await link(parcel), { order_id: order, match_method: 'order_ref' });
    assert.equal(await openItem(UNMATCHED_KIND, parcel), null);
    const [resolved] = await s.schema.sql<{ note: string }[]>`select note from reconciliation_items where kind = ${UNMATCHED_KIND} and shipment_id = ${parcel}`;
    assert.equal(resolved?.note, 'Matched by order_ref');
    const [row] = await s.schema.sql<{ stock_pending: boolean }[]>`select stock_pending from shipments where id = ${parcel}`;
    assert.equal(row?.stock_pending, true);
  });

  it('links by the tracking number the booking app wrote on the order, before anything else, with no second look', async () => {
    const named = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#1270', placedAt: PLACED, lines: [] });
    // The parcel's own tracking number goes on the order; its typed ref is wrong.
    const parcelId = await shipment(nurAccount.id, { ref: '#1999' });
    const [row] = await s.schema.sql<{ tracking_number: string }[]>`select tracking_number from shipments where id = ${parcelId}`;
    await s.schema.sql`update orders set postex_tracking_numbers = ${[row!.tracking_number]}::text[] where id = ${named}`;
    const { counts } = await run();
    assert.ok(counts.matched >= 1);
    assert.deepEqual(await link(parcelId), { order_id: named, match_method: 'tracking_note' });
    assert.equal(await openItem(SUGGESTED_KIND, parcelId), null);
    assert.equal(await openItem(UNMATCHED_KIND, parcelId), null);
  });

  it('never overrides a manual link', async () => {
    const order = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#1260', placedAt: PLACED, lines: [] });
    const other = await orderWithLines(s.schema.sql, { storeId: s.nur, number: '#1261', placedAt: PLACED, lines: [] });
    const parcel = await shipment(nurAccount.id, { ref: '#1261' });
    await s.schema.sql`update shipments set order_id = ${order}, match_method = 'manual', match_confidence = 1 where id = ${parcel}`;
    await run();
    assert.deepEqual(await link(parcel), { order_id: order, match_method: 'manual' });
    assert.notEqual(order, other);
  });
});
