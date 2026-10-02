/**
 * Imports a store's Shopify order export from a file, for histories too large to upload.
 * A dry run unless --commit is given. Run with:
 *   npm run orders:import -- nur ./orders_export.csv            (dry run)
 *   npm run orders:import -- nur ./orders_export.csv --commit   (import)
 * Imports are recorded as the user named by IMPORT_ACTOR_EMAIL (default: the AUTH_EMAIL owner).
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import { config } from '../config.js';
import { closeDb, db } from '../db.js';
import { type ImportReport, commitOrderImport, dryRunOrderImport } from '../domain/order-import.js';
import { type Progress, progressBar } from '../lib/progress.js';

const print = (report: ImportReport) => {
  for (const error of report.fileErrors) console.error(`File: ${error}`);
  console.log(`${report.rowsTotal} rows. Orders: ${JSON.stringify(report.orders)}`);
  for (const p of report.problems.slice(0, 200)) console.log(`  row ${p.row}${p.orderNumber ? ` (${p.orderNumber})` : ''}: ${p.reason}`);
  if (report.problems.length > 200) console.log(`  … and ${report.problems.length - 200} more`);
};

const run = async (): Promise<number> => {
  const [store, path, flag] = process.argv.slice(2);
  if ((store !== 'nur' && store !== 'organics') || !path) {
    console.error('Usage: npm run orders:import -- <nur|organics> <file.csv> [--commit]');
    return 2;
  }
  const sql = db();
  if (!sql) {
    console.error('DATABASE_URL is not set');
    return 2;
  }
  const csv = await readFile(path, 'utf8');
  if (flag !== '--commit') {
    print(await dryRunOrderImport(sql, store, csv));
    console.log('\nDry run: nothing written. Add --commit to import.');
    return 0;
  }
  const email = (process.env['IMPORT_ACTOR_EMAIL'] ?? config.auth.email).toLowerCase();
  const [actor] = await sql<{ id: string }[]>`
    insert into users (email, name, role) values (${email}, ${email}, 'owner') on conflict (email) do update set name = users.name returning id
  `;
  // One bar per stage: the orders, then the parcels the matcher links to them (once per PostEx account).
  let bar: Progress | undefined;
  let current = '';
  const report = await commitOrderImport(sql, { store, fileName: basename(path), csv, actorId: actor!.id }, (stage, done, total) => {
    const key = `${stage}:${total}`;
    if (key !== current) {
      bar?.finish();
      bar = progressBar(stage === 'orders' ? 'Importing orders ' : 'Matching parcels', total);
      current = key;
    }
    bar!.update(done);
  });
  bar?.finish();
  print(report);
  console.log(`\nInserted ${report.inserted}, updated ${report.updated}, unchanged ${report.unchanged}; ${report.parcelsMatched} parcels matched.`);
  return report.fileErrors.length > 0 ? 1 : 0;
};

run()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
    process.exit();
  });
