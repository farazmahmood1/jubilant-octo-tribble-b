import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { pino } from 'pino';

import { DEFAULT_TIERS, dueForRefresh, postexTotals } from '../db/repos/shipments.js';
import type { Logger } from '../logger.js';
import { parsePostexLocal } from '../lib/time.js';
import { rebuildQuants, returnsAwaitingCheckIn } from '../domain/stock.js';
import { skipWithoutDb } from '../test/db.js';
import { orderWithLines, variantsIn } from '../test/inventory.js';
import { type FakePostex, SPIKE, fakePostex, syntheticParcels } from '../test/postex-fake.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import { ACTIVE_EVERY_MS, configuredPostexAccounts, LIST_CHUNK_DAYS, POSTEX_JOB, type PostexDeps, TRACK_BATCH, runPostexSync, syncPostex } from './postex.js';
import { jobs } from './registry.js';
import { OVERNIGHT } from './runner.js';

const silent = pino({ level: 'silent' }) as unknown as Logger;
/** 11:00 in Karachi on 20 September, the day after the spike's window. */
const NOW = new Date('2026-09-20T06:00:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

const withAccount = async (s: Stores): Promise<string> => {
  const [row] = await s.schema.sql<{ id: string }[]>`
    insert into postex_accounts (key, label, store_id) values ('nur', 'NUR by Juggun', ${s.nur}) returning id
  `;
  return row!.id;
};

const counts = async (s: Stores) => {
  const [row] = await s.schema.sql<{ shipments: number; events: number; charges: number }[]>`
    select (select count(*)::int from shipments) as shipments,
           (select count(*)::int from shipment_events) as events,
           (select count(*)::int from shipment_charges) as charges
  `;
  return row!;
};

describe('postex:sync against the synthetic spike history', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let accountId: string;
  let fake: FakePostex;
  const parcels = syntheticParcels();
  const historySteps = parcels.reduce((n, p) => n + (p['transactionStatusHistory'] as unknown[]).length, 0);

  const deps = (now: Date, extra: Partial<PostexDeps> = {}): PostexDeps => ({
    sql: s.schema.sql,
    logger: silent,
    accounts: [{ key: 'nur', id: accountId, source: fake }],
    now: () => now,
    historyFrom: '2026-05-01',
    ...extra,
  });

  before(async () => {
    s = await migratedWithStores();
    accountId = await withAccount(s);
    fake = fakePostex(parcels);
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('loads all 1,073 parcels with their full event history and charges', async () => {
    const stats = await syncPostex(deps(NOW));
    assert.equal(stats['listed'], SPIKE.total);
    assert.equal(stats['inserted'], SPIKE.total);
    assert.equal(stats['detailed'], SPIKE.total, 'every new parcel is fetched with its history in the same run');
    assert.deepEqual(await counts(s), {
      shipments: SPIKE.total,
      events: historySteps,
      charges: (SPIKE.delivered + SPIKE.returned) * 2,
    });
  });

  it('reconciles to the spike: 877 delivered, 117 returned, PKR 209,009 forward and PKR 27,787 return charges', async () => {
    const [totals] = await postexTotals(s.schema.sql, '2026-05-14', '2026-09-19');
    assert.equal(totals?.parcels, 1_073);
    assert.equal(totals?.delivered, 877);
    assert.equal(totals?.returned, 117);
    assert.equal(totals?.forwardFee, 20_900_900n, 'PKR 209,009.00 in paisa');
    assert.equal(totals?.reversalFee, 2_778_700n, 'PKR 27,787.00 in paisa');
    assert.equal(totals?.forwardTax, 3_344_144n, '16% of the forward charges, exactly');
  });

  it('re-running adds zero rows: counts before and after are equal', async () => {
    const before = await counts(s);
    // 20 minutes on: listing is due again and every open parcel is due for detail.
    const second = await syncPostex(deps(later(20)));
    assert.equal(second['inserted'], 0);
    assert.equal(second['eventsInserted'], 0);
    assert.equal(second['chargesInserted'], 0);
    assert.ok(Number(second['listed']) > 0 && Number(second['detailed']) > 0, 'it really did re-read');
    assert.deepEqual(await counts(s), before);

    // And forcing every parcel, terminal ones included, through a detail refresh changes nothing either.
    const forced = await syncPostex(deps(later(40), { tiers: { ...DEFAULT_TIERS, activeMs: 0, defaultMs: 0, dailyMs: 0, terminalWatchMs: 365 * 86_400_000 } }));
    assert.equal(forced['detailed'], SPIKE.total);
    assert.equal(forced['inserted'], 0);
    assert.equal(forced['changed'], 0);
    assert.deepEqual(await counts(s), before);
  });

  it('a list row without history never erases the status the detail call derived', async () => {
    const [totals] = await postexTotals(s.schema.sql, '2026-05-14', '2026-09-19');
    assert.deepEqual([totals?.delivered, totals?.returned], [877, 117]);
    const [row] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from shipments where raw->'transactionStatusHistory' is null and status_code = '0005'`;
    assert.equal(row?.n, 0, 'raw keeps the copy with history');
  });

  it('derives attempts and the failure reason from stored events', async () => {
    const [returned] = await s.schema.sql<{ attempts: number; reason: string; code: string }[]>`
      select attempts_count as attempts, last_failure_reason as reason, status_code as code
      from shipments where tracking_number = ${String(parcels[SPIKE.delivered]!['trackingNumber'])}
    `;
    assert.deepEqual(returned, { attempts: 1, reason: 'RFD', code: '0006' });
  });

  it('reports an unknown status code once, not once per parcel, and flags the parcels', async () => {
    const items = await s.schema.sql<{ dedupe_key: string }[]>`select dedupe_key from reconciliation_items where kind = 'postex_unknown_status' and status = 'open'`;
    assert.deepEqual(items.map((i) => i.dedupe_key), ['postex_unknown_status:0099']);
    const [flagged] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from shipments where 'unknown_status' = any(flags)`;
    const expected = parcels.filter((p) => (p['transactionStatusHistory'] as Array<{ transactionStatusMessageCode: string }>).some((h) => h.transactionStatusMessageCode === '0099')).length;
    assert.equal(flagged?.n, expected);
  });

  it('calls PostEx only through the two read endpoints, within the batch and chunk sizes', () => {
    assert.deepEqual([...new Set(fake.calls.map((c) => c.method))].sort(), ['listOrders', 'trackBulk']);
    for (const call of fake.calls) {
      if (call.method === 'trackBulk') assert.ok(Number(call.args) <= TRACK_BATCH);
      if (call.method === 'listOrders') {
        const { from, to } = call.args as { from: string; to: string };
        assert.ok((Date.parse(to) - Date.parse(from)) / 86_400_000 < LIST_CHUNK_DAYS);
      }
    }
  });
});

describe('postex:sync interrupted mid-run', { skip: skipWithoutDb }, () => {
  it('fails, then resumes on the next run without duplicates', async (t) => {
    const s = await migratedWithStores();
    t.after(() => s.schema.drop());
    const accountId = await withAccount(s);
    const parcels = syntheticParcels({ ...SPIKE, total: 120, delivered: 90, returned: 20, forwardFeeRupees: 21_000, returnFeeRupees: 4_700 });
    const fake = fakePostex(parcels);
    fake.failOnce('trackBulk', 3);
    const deps: PostexDeps = { sql: s.schema.sql, logger: silent, accounts: [{ key: 'nur', id: accountId, source: fake }], now: () => NOW, historyFrom: '2026-05-01' };

    await assert.rejects(syncPostex(deps), /simulated failure/);
    const partial = await counts(s);
    assert.equal(partial.shipments, 120, 'every parcel was listed before detail failed');

    await syncPostex(deps);
    const full = await counts(s);
    assert.equal(full.shipments, 120);
    assert.equal(full.events, parcels.reduce((n, p) => n + (p['transactionStatusHistory'] as unknown[]).length, 0));
    const [unsynced] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from shipments where last_synced_at is null`;
    assert.equal(unsynced?.n, 0);
  });
});

describe('status from stored events', { skip: skipWithoutDb }, () => {
  it('uses event time, not arrival: an older step PostEx adds later never becomes the status', async (t) => {
    const s = await migratedWithStores();
    t.after(() => s.schema.drop());
    const accountId = await withAccount(s);
    const step = (code: string, message: string, at: string) => ({ transactionStatusMessageCode: code, transactionStatusMessage: message, updatedAt: at });
    const parcel = { trackingNumber: '24009999', transactionDate: '2026-09-10 18:00:00', invoicePayment: 2000, transactionStatusHistory: [step('0040', 'Return Initiated', '2026-09-12 10:00:00')] };
    const fake = fakePostex([parcel]);
    const deps = (now: Date, extra: Partial<PostexDeps> = {}): PostexDeps => ({ sql: s.schema.sql, logger: silent, accounts: [{ key: 'nur', id: accountId, source: fake }], now: () => now, historyFrom: '2026-09-01', ...extra });

    await syncPostex(deps(NOW));
    // The next poll shows the parcel was delivered after all, and also back-fills an older attempt,
    // which is stored after the delivery even though it happened first.
    parcel.transactionStatusHistory = [
      step('0013', 'Attempt Made: CNA(CUSTOMER NOT AVAILABLE)', '2026-09-11 16:00:00'),
      step('0040', 'Return Initiated', '2026-09-12 10:00:00'),
      step('0005', 'Delivered', '2026-09-13 15:00:00'),
    ];
    await syncPostex(deps(later(20)));
    parcel.transactionStatusHistory.push(step('0013', 'Attempt Made: RFD(REFUSED TO RECEIVE)', '2026-09-10 20:00:00'));
    // Delivered is terminal and only re-read daily, so force this third poll.
    await syncPostex(deps(later(40), { tiers: { ...DEFAULT_TIERS, dailyMs: 0 } }));

    const [row] = await s.schema.sql<{ code: string; attempts: number; reason: string }[]>`
      select status_code as code, attempts_count as attempts, last_failure_reason as reason from shipments where tracking_number = '24009999'
    `;
    assert.deepEqual(row, { code: '0005', attempts: 2, reason: 'CNA' }, 'the latest attempt by time is the CNA one');
  });
});

describe('refresh tiers', { skip: skipWithoutDb }, () => {
  it('selects parcels by tier: new, out for delivery 5 min, open 15 min, stale daily, recent terminal daily, old terminal never', async (t) => {
    const s = await migratedWithStores();
    t.after(() => s.schema.drop());
    const accountId = await withAccount(s);
    const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);
    const day = 24 * 60;
    const parcel = async (tracking: string, fields: { status_code?: string; status_label?: string; booked: number; synced: number | null; updated?: number }) => {
      await s.schema.sql`
        insert into shipments (postex_account_id, tracking_number, status_code, status_label, booked_at, last_synced_at, status_updated_at)
        values (${accountId}, ${tracking}, ${fields.status_code ?? null}, ${fields.status_label ?? null}, ${at(fields.booked)},
                ${fields.synced === null ? null : at(fields.synced)}, ${fields.updated === undefined ? null : at(fields.updated)})
      `;
    };
    await parcel('never-synced', { booked: day, synced: null });
    await parcel('ofd-6min', { status_label: 'Out For Delivery', booked: day, synced: 6 });
    await parcel('ofd-3min', { status_label: 'Out For Delivery', booked: day, synced: 3 });
    await parcel('attempted-6min', { status_code: '0013', booked: day, synced: 6 });
    await parcel('open-10min', { status_code: '0008', booked: day, synced: 10 });
    await parcel('open-16min', { status_code: '0008', booked: day, synced: 16 });
    await parcel('stale-2h', { booked: 40 * day, synced: 120 });
    await parcel('stale-25h', { booked: 40 * day, synced: 25 * 60 });
    await parcel('delivered-recent-25h', { status_code: '0005', booked: 3 * day, synced: 25 * 60, updated: 2 * day });
    await parcel('delivered-recent-2h', { status_code: '0005', booked: 3 * day, synced: 120, updated: 2 * day });
    await parcel('returned-old', { status_code: '0006', booked: 30 * day, synced: 25 * 60, updated: 20 * day });

    const due = (await dueForRefresh(s.schema.sql, accountId, NOW)).map((p) => p.trackingNumber).sort();
    assert.deepEqual(due, ['attempted-6min', 'delivered-recent-25h', 'never-synced', 'ofd-6min', 'open-16min', 'stale-25h']);
  });
});

describe('postex:sync links parcels to orders and moves their stock', { skip: skipWithoutDb }, () => {
  const SPEC = { ...SPIKE, total: 120, delivered: 90, returned: 20, forwardFeeRupees: 21_000, returnFeeRupees: 4_700 };
  const parcels = syntheticParcels(SPEC);
  let s: Stores;
  let deps: (now: Date, extra?: Partial<PostexDeps>) => PostexDeps;
  let fake: FakePostex;
  let variant: string;

  const ledger = async () => {
    const [row] = await s.schema.sql<{ moves: number; customer: number; returning: number; in_transit: number; warehouse: number }[]>`
      select (select count(*)::int from stock_moves) as moves,
        ${s.schema.sql.unsafe(['customer', 'returning', 'in_transit', 'warehouse']
          .map((k) => `(select coalesce(sum(q.qty), 0)::int from stock_quants q join locations l on l.id = q.location_id where l.key = '${k}') as ${k}`)
          .join(', '))}
    `;
    return row!;
  };

  before(async () => {
    s = await migratedWithStores();
    const accountId = await withAccount(s);
    [variant] = (await variantsIn(s.schema.sql, s.nur, 1)) as [string];
    // Every synthetic parcel carries '#5xxxx'; its order holds one unit, the last ten orders two.
    for (const [i, p] of parcels.entries()) {
      await orderWithLines(s.schema.sql, {
        storeId: s.nur,
        number: String(p['orderRefNumber']),
        placedAt: new Date(`${String(p['transactionDate']).slice(0, 10)}T03:00:00Z`),
        lines: [{ variantId: variant, qty: i >= SPEC.total - 10 ? 2 : 1 }],
      });
    }
    fake = fakePostex(parcels);
    deps = (now, extra = {}) => ({ sql: s.schema.sql, logger: silent, accounts: [{ key: 'nur', id: accountId, source: fake }], now: () => now, historyFrom: '2026-05-01', ...extra });
  });

  after(async () => {
    await s?.schema.drop();
  });

  it('matches every parcel by order number and moves delivered units to customer, returned ones to returning', async () => {
    const stats = await syncPostex(deps(NOW));
    assert.deepEqual([stats['matched'], stats['unmatched'], stats['suggested']], [SPEC.total, 0, 0]);
    const open = SPEC.total - SPEC.delivered - SPEC.returned;
    assert.deepEqual(await ledger(), {
      moves: SPEC.total + SPEC.delivered + SPEC.returned,
      customer: SPEC.delivered,
      returning: SPEC.returned,
      in_transit: open + 10, // the last ten parcels are open and carry two units each
      warehouse: -(SPEC.total + 10),
    });
    assert.equal(stats['stockMoves'], SPEC.total + SPEC.delivered + SPEC.returned);
    assert.equal((await returnsAwaitingCheckIn(s.schema.sql)).length, SPEC.returned);
  });

  it('replaying the same shipment events creates no duplicate moves, and quants equal a rebuild', async () => {
    const before = await ledger();
    const again = await syncPostex(deps(later(20)));
    const forced = await syncPostex(deps(later(40), { tiers: { ...DEFAULT_TIERS, activeMs: 0, defaultMs: 0, dailyMs: 0, terminalWatchMs: 365 * 86_400_000 } }));
    assert.equal(forced['detailed'], SPEC.total, 'every parcel was re-read with its full history');
    assert.deepEqual([again['stockMoves'], forced['stockMoves']], [0, 0]);
    assert.deepEqual(await ledger(), before);
    await rebuildQuants(s.schema.sql);
    assert.deepEqual(await ledger(), before);
  });

  it('a parcel whose stock pass was interrupted is caught up by the next run', async () => {
    const tracking = String(parcels[SPEC.total - 1]!['trackingNumber']);
    fake.parcels = fake.parcels.map((p) =>
      p['trackingNumber'] === tracking
        ? { ...p, transactionStatusHistory: [...(p['transactionStatusHistory'] as unknown[]), { transactionStatusMessage: 'Delivered', transactionStatusMessageCode: '0005', updatedAt: '2026-09-20 10:00:00' }] }
        : p,
    );
    const due = { tiers: { ...DEFAULT_TIERS, activeMs: 0, defaultMs: 0 } };
    // The parcel is stored (and marked) but the run dies before the stock pass.
    const aborted = new AbortController();
    const sql = s.schema.sql;
    const stopAfterDetail: PostexDeps = {
      ...deps(later(60), due),
      signal: aborted.signal,
      accounts: deps(NOW).accounts.map((a) => ({ ...a, source: { ...a.source, trackBulk: async (n: string[]) => { const rows = await a.source.trackBulk(n); aborted.abort(); return rows; } } })),
    };
    await syncPostex(stopAfterDetail);
    const [marked] = await sql<{ stock_pending: boolean }[]>`select stock_pending from shipments where tracking_number = ${tracking}`;
    assert.equal(marked?.stock_pending, true);

    const next = await syncPostex(deps(later(80), due));
    assert.equal(next['changed'], 0, 'nothing new from PostEx this time');
    assert.equal(next['stockMoves'], 1, 'yet the delivery moves its units');
    const [after] = await sql<{ stock_pending: boolean }[]>`select stock_pending from shipments where tracking_number = ${tracking}`;
    assert.equal(after?.stock_pending, false);
  });

  it('asks for the next run in 5 minutes only while a parcel is out for delivery or attempted', async () => {
    const asked: number[] = [];
    const ctx = { sql: s.schema.sql, logger: silent, signal: new AbortController().signal, runAgainIn: (ms: number) => void asked.push(ms) };
    const accounts = deps(NOW).accounts;
    await runPostexSync(ctx, accounts, () => later(100));
    assert.deepEqual(asked, [], 'no parcel is active');

    const tracking = String(parcels[SPEC.delivered + SPEC.returned]!['trackingNumber']);
    fake.parcels = fake.parcels.map((p) =>
      p['trackingNumber'] === tracking
        ? { ...p, transactionStatus: 'Out For Delivery', transactionStatusHistory: [{ transactionStatusMessage: 'Attempt Made: CNA', transactionStatusMessageCode: '0013', updatedAt: '2026-09-20 09:00:00' }] }
        : p,
    );
    await runPostexSync(ctx, accounts, () => later(200));
    assert.deepEqual(asked, [ACTIVE_EVERY_MS]);
  });
});

describe('the job', { skip: skipWithoutDb }, () => {
  it('is registered as postex:sync every 15 minutes on the quarter hour, hourly overnight, and refuses to run with no account configured', async (t) => {
    assert.deepEqual(jobs.find((j) => j.name === POSTEX_JOB)?.schedule, { everyMs: 15 * 60 * 1000, alignToClock: true, quiet: OVERNIGHT });
    const s = await migratedWithStores();
    t.after(() => s.schema.drop());
    await assert.rejects(configuredPostexAccounts(s.schema.sql), /No PostEx account is ready to sync/);
  });
});

describe('no write call to PostEx', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const sources = [
    ...readdirSync(join(root, 'integrations', 'postex')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).map((f) => join(root, 'integrations', 'postex', f)),
    join(root, 'jobs', 'postex.ts'),
    join(root, 'jobs', 'postex-match.ts'),
    join(root, 'jobs', 'postex-payouts.ts'),
    join(root, 'db', 'repos', 'shipments.ts'),
    join(root, 'db', 'repos', 'payouts.ts'),
  ];

  it('the PostEx client and the sync use no write method and no booking or cancelling endpoint', () => {
    for (const file of sources) {
      const code = readFileSync(file, 'utf8');
      assert.doesNotMatch(code, /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i, file);
      assert.doesNotMatch(code, /create-order|cancel-order|order-cancel|save-shipper-advice|book-order/i, file);
    }
  });

  it('nothing asks PostEx for shipper advice, and the client has no method for it (CLAUDE.md rule 1)', () => {
    for (const file of sources) assert.doesNotMatch(readFileSync(file, 'utf8'), /shipperAdvice|shipper-advice|ShipperAdvice/, file);
  });

  it('parses PostEx times as Karachi local time', () => {
    assert.equal(parsePostexLocal('2026-09-19 18:00:00').toISOString(), '2026-09-19T13:00:00.000Z');
  });
});
