import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { skipWithoutDb } from '../test/db.js';
import { testUser, variantsIn } from '../test/inventory.js';
import { type Stores, migratedWithStores } from '../test/stores.js';
import {
  TEMPLATE_CSV,
  commitImport,
  createPartner,
  createTransfer,
  dryRunImport,
  listImports,
  listPartners,
  partnerStock,
  reverseImport,
  sheetHash,
} from './consignment.js';

/** SKUs and the partner are made up. */
describe('consignment and partner sales import', { skip: skipWithoutDb }, () => {
  let s: Stores;
  let actor: string;
  let partner: string;
  let serum: string;
  let cream: string;
  const now = new Date('2026-09-30T10:00:00Z');

  before(async () => {
    s = await migratedWithStores();
    actor = await testUser(s.schema.sql);
    [serum, cream] = (await variantsIn(s.schema.sql, s.nur, 2)) as [string, string];
    await s.schema.sql`update variants set sku = 'NBJ-SERUM-30' where id = ${serum}`;
    await s.schema.sql`update variants set sku = 'NBJ-CREAM-50' where id = ${cream}`;
    await s.schema.sql`insert into product_costs (variant_id, unit_cost_paisa, effective_from, source) values (${serum}, '45000', '2026-01-01', 'manual'), (${cream}, '30000', '2026-01-01', 'manual')`;
    partner = await createPartner(s.schema.sql, { name: 'Test Grocer', city: 'Lahore' }, actor);
    await createTransfer(s.schema.sql, {
      partnerId: partner,
      direction: 'out',
      sentAt: new Date('2026-08-25T06:00:00Z'),
      lines: [{ variantId: serum, qty: 10 }, { variantId: cream, qty: 5 }],
      actorId: actor,
    });
  });

  after(async () => {
    await s?.schema.drop();
  });

  const held = async () => Object.fromEntries((await partnerStock(s.schema.sql, partner)).map((r) => [r.sku, r.qty]));
  const counts = async () =>
    (await s.schema.sql<Record<string, number>[]>`
      select (select count(*)::int from stock_moves) as moves, (select count(*)::int from journal_entries) as entries,
             (select count(*)::int from partner_sales_imports) as imports, (select count(*)::int from partner_sales) as sales,
             (select count(*)::int from invoices) as invoices, (select count(*)::int from audit_log) as audits
    `)[0]!;
  const ledger = async (code: string) =>
    BigInt((await s.schema.sql<{ v: string }[]>`select coalesce(sum(l.debit_paisa - l.credit_paisa), 0)::text as v from journal_lines l join accounts a on a.id = l.account_id where a.code = ${code}`)[0]!.v);

  it('transfers move warehouse → partner and back, never more back than the partner holds', async () => {
    assert.deepEqual(await held(), { 'NBJ-SERUM-30': 10, 'NBJ-CREAM-50': 5 });
    await assert.rejects(
      createTransfer(s.schema.sql, { partnerId: partner, direction: 'back', sentAt: now, lines: [{ variantId: cream, qty: 6 }], actorId: actor }),
      /Test Grocer holds 5 of product \d+; 6 cannot come back/,
    );
    assert.equal((await listPartners(s.schema.sql)).find((p) => p.id === partner)?.units, 15);
  });

  it('the published template is a valid sheet for the stock the partner holds', async () => {
    const report = await dryRunImport(s.schema.sql, partner, TEMPLATE_CSV, now);
    assert.deepEqual([report.fileErrors, report.valid, report.invalid], [[], 2, 0]);
  });

  it('DRY RUN NEVER WRITES, and reports invalid rows precisely, by line and reason', async () => {
    const csv = [
      'Date,SKU,Quantity,Unit_Price,Tax',
      '2026-09-10,NBJ-SERUM-30,3,1450.00,0',
      '2026-09-31,NBJ-SERUM-30,1,1450,0',
      '2026-09-11,NOPE-1,1,1450,0',
      '2026-09-11,nbj-cream-50,0,abc,',
      '',
      '2026-10-05,NBJ-CREAM-50,2,990,0',
      '2026-09-12,NBJ-SERUM-30,8,1450,0',
      '2026-09-12,NBJ-CREAM-50,"2",990,"148.50"',
    ].join('\n');
    const before = await counts();
    const report = await dryRunImport(s.schema.sql, partner, csv, now);
    assert.deepEqual(await counts(), before, 'nothing written');
    assert.deepEqual(
      report.rows.filter((r) => !r.ok).map((r) => [r.row, r.errors]),
      [
        [3, ['date "2026-09-31" is not a date as YYYY-MM-DD']],
        [4, ['sku "NOPE-1" is not one of our products']],
        [5, ['quantity "0" is not a whole number above zero', 'unit_price "abc" is not an amount in rupees']],
        [7, ['date 2026-10-05 is in the future']],
        [8, ['Test Grocer holds 7 of "NBJ-SERUM-30" after the rows above; 8 cannot have sold']],
      ],
    );
    assert.deepEqual([report.valid, report.invalid, report.units], [2, 5, 5]);
    assert.equal(report.net, 1450_00n * 3n + 990_00n * 2n);
    assert.equal(report.tax, 148_50n);

    // Committed without force: refused, nothing written.
    await assert.rejects(commitImport(s.schema.sql, { partnerId: partner, fileName: 'bad.csv', csv, actorId: actor, now }), (e: unknown) => {
      assert.match((e as Error).message, /5 of 7 rows are invalid; nothing was imported/);
      assert.equal((e as { report?: { invalid: number } }).report?.invalid, 5);
      return true;
    });
    assert.deepEqual(await counts(), before);
    const missing = await dryRunImport(s.schema.sql, partner, 'date,sku\n2026-09-01,X', now);
    assert.deepEqual(missing.fileErrors, ['Missing columns: quantity, unit_price. Use the template.']);
  });

  it('COMMIT moves partner → customer, posts the sale and its cost, raises the invoice; FORCE commits only the valid rows', async () => {
    const csv = 'date,sku,quantity,unit_price,tax\n2026-09-10,NBJ-SERUM-30,3,1450,0\n2026-09-11,NOPE-1,1,10,0\n2026-09-12,NBJ-CREAM-50,2,990,148.50\n';
    const revenue = await ledger('4000');
    const result = await commitImport(s.schema.sql, { partnerId: partner, fileName: 'sept.csv', csv, force: true, actorId: actor, now });
    assert.deepEqual([result.version, result.rowsImported, result.rowsSkipped], [1, 2, 1]);
    assert.deepEqual(result.invoices.map((i) => [i.number, i.total]), [[`CI-${result.importId.padStart(5, '0')}-NUR`, 4350_00n + 1980_00n + 148_50n]]);
    assert.deepEqual(await held(), { 'NBJ-SERUM-30': 7, 'NBJ-CREAM-50': 3 });
    assert.equal((await ledger('4000')) - revenue, -(4350_00n + 1980_00n), 'revenue credited');
    const entries = await s.schema.sql<{ source_type: string; entry_date: string; source_id: string }[]>`
      select source_type, entry_date::text, source_id from journal_entries where source_id like ${`${result.importId}:%`} order by source_type, entry_date
    `;
    assert.deepEqual(entries.map((e) => [e.source_type, e.entry_date]), [
      ['consignment_cogs', '2026-09-10'], ['consignment_cogs', '2026-09-12'], ['consignment_sale', '2026-09-10'], ['consignment_sale', '2026-09-12'],
    ], 'recognised on the day the partner sold');
    const [cogs] = await s.schema.sql<{ v: string }[]>`
      select sum(l.debit_paisa)::text as v from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
      where e.source_id like ${`${result.importId}:%`} and a.code = '5000'
    `;
    assert.equal(cogs?.v, String(3n * 450_00n + 2n * 300_00n), 'cost at each product\'s cost on the sale day');
    assert.equal((await listPartners(s.schema.sql)).find((p) => p.id === partner)?.receivable, 4350_00n + 1980_00n + 148_50n);
    const [audit] = await s.schema.sql<{ after: { skipped: number[] } }[]>`select after from audit_log where action = 'consignment.import' and entity_id = ${result.importId}`;
    assert.deepEqual(audit?.after.skipped, [3]);
  });

  it('RE-IMPORTING the same file is refused (line ends do not matter), unless explicitly a new version', async () => {
    const csv = 'date,sku,quantity,unit_price,tax\n2026-09-15,NBJ-SERUM-30,1,1450,0\n';
    const first = await commitImport(s.schema.sql, { partnerId: partner, fileName: 'week3.csv', csv, actorId: actor, now });
    const before = await counts();
    await assert.rejects(
      commitImport(s.schema.sql, { partnerId: partner, fileName: 'week3 (1).csv', csv: csv.replaceAll('\n', '\r\n'), actorId: actor, now }),
      new RegExp(`already imported \\(import ${first.importId}, version 1, .*\\)\\. Reverse that import, or import this one as a new version`),
    );
    assert.deepEqual(await counts(), before);
    assert.ok((await dryRunImport(s.schema.sql, partner, csv, now)).alreadyImported, 'the dry run says so too');
    const again = await commitImport(s.schema.sql, { partnerId: partner, fileName: 'week3.csv', csv, newVersion: true, actorId: actor, now });
    assert.equal(again.version, 2);
    assert.equal(sheetHash(csv), sheetHash(`﻿${csv.replaceAll('\n', '\r\n')}\n`));
  });

  it('REVERSING an import restores the partner\'s stock and reverses every entry, as a unit, once', async () => {
    const csv = 'date,sku,quantity,unit_price,tax\n2026-09-20,NBJ-SERUM-30,2,1450,0\n2026-09-20,NBJ-CREAM-50,1,990,0\n';
    const stockBefore = await held();
    const balances = async () => ({ revenue: await ledger('4000'), receivable: await ledger('1200'), inventory: await ledger('1300'), cogs: await ledger('5000') });
    const moneyBefore = await balances();
    const imported = await commitImport(s.schema.sql, { partnerId: partner, fileName: 'week4.csv', csv, actorId: actor, now });
    assert.notDeepEqual(await held(), stockBefore);

    const result = await reverseImport(s.schema.sql, { importId: imported.importId, reason: 'Partner sent the wrong week', actorId: actor, now });
    assert.deepEqual(result, { entriesReversed: 2, unitsRestored: 3 });
    assert.deepEqual(await held(), stockBefore, 'units back at the partner');
    assert.deepEqual(await balances(), moneyBefore, 'revenue, receivable, inventory and COGS as before');
    const [live] = await s.schema.sql<{ n: number }[]>`select count(*)::int as n from journal_entries where source_id like ${`${imported.importId}:%`} and reversed_by is null`;
    assert.equal(live?.n, 0);
    const [invoice] = await s.schema.sql`select voided_at from invoices where import_id = ${imported.importId}`;
    assert.ok(invoice?.['voided_at']);
    await assert.rejects(reverseImport(s.schema.sql, { importId: imported.importId, reason: 'again', actorId: actor, now }), /already reversed/);
    const row = (await listImports(s.schema.sql, partner)).find((i) => i.id === imported.importId)!;
    assert.equal(row.reversalReason, 'Partner sent the wrong week');
    // The reversed file can be imported again, as the next version.
    assert.equal((await commitImport(s.schema.sql, { partnerId: partner, fileName: 'week4.csv', csv, actorId: actor, now })).version, 2);
    await assert.rejects(s.schema.sql`update partner_sales_imports set file_name = 'x' where id = ${imported.importId}`, /can only be reversed, once/);
  });
});
