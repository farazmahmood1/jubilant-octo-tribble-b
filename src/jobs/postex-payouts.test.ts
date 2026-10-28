import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';

import type { Logger } from '../logger.js';
import { skipWithoutDb } from '../test/db.js';
import { type FakePostex, SPIKE, fakePostex, syntheticParcels } from '../test/postex-fake.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { syncPostex } from './postex.js';
import { PAYOUTS_JOB, syncPayouts } from './postex-payouts.js';
import { jobs } from './registry.js';
import { SYNC_EVERY_MS } from './runner.js';

const silent = pino({ level: 'silent' }) as unknown as Logger;
const NOW = new Date('2026-09-20T06:00:00Z');
const SPEC = { ...SPIKE, total: 120, delivered: 90, returned: 20, forwardFeeRupees: 21_000, returnFeeRupees: 4_700 };

describe('postex:payouts', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let fake: FakePostex;
  let accounts: Array<{ key: string; id: string; source: FakePostex }>;
  const parcels = syntheticParcels(SPEC);
  const deliveredTracking = parcels.slice(0, SPEC.delivered).map((p) => String(p['trackingNumber']));

  before(async () => {
    s = await migratedWithStores();
    const [row] = await s.schema.sql<{ id: string }[]>`insert into postex_accounts (key, label, store_id) values ('nur', 'NUR', ${s.nur}) returning id`;
    fake = fakePostex(parcels);
    accounts = [{ key: 'nur', id: row!.id, source: fake }];
    await syncPostex({ sql: s.schema.sql, logger: silent, accounts, now: () => NOW, historyFrom: '2026-05-01' });
    // The newest five deliveries are not paid out yet.
    for (const tracking of deliveredTracking.slice(-5)) fake.unsettled.add(tracking);
  });

  after(async () => {
    await s?.schema.drop();
  });

  const lines = async () => {
    const [row] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from payout_lines`;
    return row!.n;
  };

  it('asks about delivered parcels oldest first, then returned ones, capped per run, and records the settled ones under their CPR', async () => {
    fake.calls.length = 0;
    const first = await syncPayouts({ sql: s.schema.sql, logger: silent, accounts, batch: 50 });
    assert.equal(first['checked'], 50);
    assert.deepEqual(fake.calls.map((c) => c.args), deliveredTracking.slice(0, 50), 'the oldest 50 deliveries before any return');
    assert.equal(first['paid'], 50);

    // The other 40 deliveries, then 10 of the 20 returns (which this fake never settles).
    const second = await syncPayouts({ sql: s.schema.sql, logger: silent, accounts, batch: 50 });
    assert.deepEqual([second['checked'], second['paid'], second['unsettled']], [50, 35, 15]);
    assert.equal(await lines(), 85);
  });

  it('a payout line is the COD less the charges and their tax; the payout is the sum of its lines', async () => {
    const [mismatch] = await s.schema.sql<{ n: number }[]>`
      select count(*)::int as n from payout_lines l join shipments s on s.id = l.shipment_id
      where l.amount_paisa <> s.cod_amount_paisa
        - (select coalesce(sum(amount_paisa), 0) from shipment_charges c where c.shipment_id = s.id and c.kind in ('forward', 'forward_tax', 'reversal', 'reversal_tax'))
    `;
    assert.equal(mismatch?.n, 0);
    const [unbalanced] = await s.schema.sql<{ n: number }[]>`
      select count(*)::int as n from cod_payouts p
      where p.amount_paisa <> (select sum(amount_paisa) from payout_lines l where l.cod_payout_id = p.id)
    `;
    assert.equal(unbalanced?.n, 0);
    const payouts = await s.schema.sql<{ cpr_number: string; paid_at: Date }[]>`select cpr_number, paid_at from cod_payouts order by cpr_number`;
    assert.ok(payouts.length > 1 && payouts.every((p) => /^CPR-\d{8}$/.test(p.cpr_number) && p.paid_at instanceof Date));
  });

  it('is idempotent: re-running asks only about the unsettled parcels and writes nothing', async () => {
    const before = await s.schema.sql`select id, amount_paisa, updated_at from cod_payouts order by id`;
    const again = await syncPayouts({ sql: s.schema.sql, logger: silent, accounts });
    assert.deepEqual([again['checked'], again['paid'], again['unsettled']], [25, 0, 25], 'the 5 unpaid deliveries and the 20 returns');
    assert.equal(await lines(), 85);
    assert.deepEqual(await s.schema.sql`select id, amount_paisa, updated_at from cod_payouts order by id`, before);
  });

  it('records a parcel once PostEx settles it, adding to its week\'s payout', async () => {
    const late = deliveredTracking.at(-1)!;
    fake.unsettled.delete(late);
    const run = await syncPayouts({ sql: s.schema.sql, logger: silent, accounts });
    assert.equal(run['paid'], 1);
    assert.equal(await lines(), 86);
  });

  it('skips a parcel PostEx cannot answer for, and fails the run only when every request fails', async () => {
    fake.failOnce('paymentStatus', fake.calls.filter((c) => c.method === 'paymentStatus').length + 1);
    const run = await syncPayouts({ sql: s.schema.sql, logger: silent, accounts });
    assert.deepEqual([run['checked'], run['failed']], [24, 1]);

    const single = await syncPayouts({ sql: s.schema.sql, logger: silent, accounts, batch: 1 });
    assert.equal(single['checked'], 1);
    fake.failOnce('paymentStatus', fake.calls.filter((c) => c.method === 'paymentStatus').length + 1);
    await assert.rejects(syncPayouts({ sql: s.schema.sql, logger: silent, accounts, batch: 1 }), /failed for all 1 parcels/);
  });

  it('a quick check asks about the oldest few unpaid deliveries, and about the rest only once one of them is paid', async () => {
    // Four deliveries are unpaid (the newest five less the one settled above), and the 20 returns.
    const [newest] = await s.schema.sql<{ at: Date }[]>`select max(delivered_at) as at from shipments`;
    const now = () => new Date(newest!.at.getTime() + 86_400_000);
    const quiet = await syncPayouts({ sql: s.schema.sql, logger: silent, accounts, probe: 3, now });
    assert.deepEqual([quiet['checked'], quiet['paid']], [3, 0], 'three asked, none paid: the rest is left for the next pass');

    fake.unsettled.delete(deliveredTracking.at(-5)!);
    const paid = await syncPayouts({ sql: s.schema.sql, logger: silent, accounts, probe: 3, now });
    assert.deepEqual([paid['checked'], paid['paid']], [24, 1], 'one of the three paid, so the other unpaid parcels were asked too');
  });

  it('is registered to run with the other syncs', () => {
    assert.deepEqual(jobs.find((j) => j.name === PAYOUTS_JOB)?.schedule, { everyMs: SYNC_EVERY_MS, alignToClock: true });
  });
});
