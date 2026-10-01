import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';

import { matchReport } from '../db/repos/match-report.js';
import { decideReviewItem } from '../db/repos/review.js';
import type { Logger } from '../logger.js';
import { skipWithoutDb } from '../test/db.js';
import { orderWithLines, testUser, variantsIn } from '../test/inventory.js';
import { SPIKE, fakePostex, syntheticParcels } from '../test/postex-fake.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { syncPostex } from './postex.js';
import { RECONCILIATION_JOB, scanReconciliation } from './reconciliation.js';
import { jobs } from './registry.js';

const silent = pino({ level: 'silent' }) as unknown as Logger;
const NOW = new Date('2026-09-20T06:00:00Z');
/** 1,073 × (1 − 0.954) = 49.4: the spike's unmatched share, rounded down. */
const WITHOUT_ORDER = 49;

describe('reconciliation:scan over the spike-scale history', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let actor: string;
  const parcels = syntheticParcels();
  const scan = (now = NOW) => scanReconciliation({ sql: s.schema.sql, logger: silent, now: () => now });

  const items = async (status: 'open' | 'resolved' | 'ignored', kind?: string) => {
    const rows = await s.schema.sql<{ n: number }[]>`
      select count(*)::int as n from reconciliation_items where status = ${status} ${kind ? s.schema.sql`and kind = ${kind}` : s.schema.sql``}
    `;
    return rows[0]!.n;
  };
  const snapshot = () => s.schema.sql`select id, kind, dedupe_key, status, detail, updated_at from reconciliation_items order by id`;

  before(async () => {
    s = await migratedWithStores();
    actor = await testUser(s.schema.sql);
    const [account] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    const [variant] = await variantsIn(s.schema.sql, s.nur, 1);
    // Every parcel's order exists except the last 49 open and returned ones; one order is
    // deliberately 1 rupee off its parcel's COD, and one has two live parcels.
    for (const [i, p] of parcels.entries()) {
      if (i >= SPIKE.total - WITHOUT_ORDER) continue;
      await orderWithLines(s.schema.sql, {
        storeId: s.nur,
        number: String(p['orderRefNumber']),
        placedAt: new Date(`${String(p['transactionDate']).slice(0, 10)}T03:00:00Z`),
        totalPaisa: BigInt(String(p['invoicePayment'])) * 100n + (i === 10 ? 100n : 0n),
        lines: [{ variantId: variant!, qty: 1 }],
      });
    }
    const duplicate = { ...parcels[SPIKE.delivered + SPIKE.returned]!, trackingNumber: '99990000000001' };
    const fake = fakePostex([...parcels, duplicate]);
    await syncPostex({ sql: s.schema.sql, logger: silent, accounts: [{ key: 'nur', id: account!.id, source: fake }], now: () => NOW, historyFrom: '2026-05-01' });
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('unmatched parcels are at most 4.6%, and every one has a queue row', async () => {
    const [report] = await matchReport(s.schema.sql);
    assert.equal(report?.parcels, SPIKE.total + 1);
    assert.equal(report?.unmatched, WITHOUT_ORDER);
    assert.ok(report!.unmatchedRate <= 0.046, `${report!.unmatchedRate}`);
    assert.equal(report?.unmatchedWithoutItem, 0);
    assert.equal(report?.withinTarget, true);
    assert.deepEqual(report?.prefixes.map((p) => [p.prefix, p.parcels, p.configured]), [[null, SPIKE.total + 1, true]]);
  });

  it('materialises each rule: unmatched, COD mismatch, duplicate booking, stuck in transit, unknown status', async () => {
    const stats = await scan();
    assert.equal(stats['found.unmatched_shipment'], WITHOUT_ORDER);
    assert.equal(stats['found.cod_mismatch'], 1);
    assert.equal(stats['found.possible_duplicate_booking'], 1);
    assert.equal(stats['found.postex_unknown_status'], 1);
    // The open synthetic parcels last moved on their booking's next day, months before NOW.
    assert.ok(Number(stats['found.stuck_in_transit']) > 0);
    assert.equal(await items('open', 'unmatched_shipment'), WITHOUT_ORDER, 'the matcher already opened these; the scan adds none');
    const [reasons] = await s.schema.sql<{ n: number }[]>`
      select count(*)::int as n from reconciliation_items where kind = 'unmatched_shipment' and detail->>'reason' = 'order_ref_not_found'
    `;
    assert.equal(reasons?.n, WITHOUT_ORDER, "the matcher's reason is kept, not overwritten by the scan");
    assert.equal(await items('open', 'cod_mismatch'), 1);
    assert.equal(await items('open', 'possible_duplicate_booking'), 1);
  });

  it('re-running changes nothing: no duplicate items, no detail rewritten', async () => {
    const before = await snapshot();
    const again = await scan();
    assert.equal(again['opened'], 0);
    assert.equal(again['closed'], 0);
    assert.deepEqual(await snapshot(), before);
  });

  it('does not reopen an item a person resolved or ignored', async () => {
    const [cod] = await s.schema.sql<{ id: string }[]>`select id from reconciliation_items where kind = 'cod_mismatch' and status = 'open'`;
    const [dup] = await s.schema.sql<{ id: string }[]>`select id from reconciliation_items where kind = 'possible_duplicate_booking' and status = 'open'`;
    await decideReviewItem(s.schema.sql, cod!.id, 'resolved', 'Customer agreed a one-rupee discount on the phone', actor);
    await decideReviewItem(s.schema.sql, dup!.id, 'ignored', 'A second box, sent on purpose', actor);

    const stats = await scan();
    assert.equal(stats['suppressed'], 2);
    assert.equal(await items('open', 'cod_mismatch'), 0);
    assert.equal(await items('open', 'possible_duplicate_booking'), 0);
    assert.equal(await items('resolved', 'cod_mismatch'), 1);
    const audits = await s.schema.sql`select action from audit_log where entity = 'reconciliation_items' and actor_id = ${actor} order by id`;
    assert.deepEqual(audits.map((a) => a['action']), ['review.resolve', 'review.ignore']);
  });

  it('closes, and audits, an item whose condition has cleared; opens it again if it comes back', async () => {
    const open = await items('open', 'stuck_in_transit');
    // Pretend the clock is back on the day after the parcels' last status: nothing is stuck yet.
    const early = await scan(new Date('2026-05-16T06:00:00Z'));
    assert.ok(Number(early['closed']) >= open);
    assert.equal(await items('open', 'stuck_in_transit'), 0);
    const [audit] = await s.schema.sql`
      select count(*)::int as n from audit_log where action = 'review.resolve' and actor_id is null and after->>'kind' = 'stuck_in_transit'
    `;
    assert.equal(audit?.['n'], open);
    const later = await scan();
    assert.equal(Number(later['opened']), open, 'closed by the system, so it may open again');
  });

  it('is registered hourly, on the hour', () => {
    assert.deepEqual(jobs.find((j) => j.name === RECONCILIATION_JOB)?.schedule, { everyMs: 60 * 60 * 1000, alignToClock: true });
  });
});
