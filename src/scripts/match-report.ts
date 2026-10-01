/**
 * Match rate per PostEx account and the order-number prefixes seen on parcels, to prove Step 6
 * ("unmatched at most 4.6%, every unmatched parcel has a queue row") on real data and to choose
 * the `matching` setting's prefixes. Exits 1 when an account misses the target.
 * Run with: npm run match:report   (after postex:sync and reconciliation:scan)
 */
import { closeDb, db } from '../db.js';
import { MAX_UNMATCHED_RATE, matchReport } from '../db/repos/match-report.js';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const run = async (): Promise<number> => {
  const sql = db();
  if (!sql) {
    console.error('DATABASE_URL is not set');
    return 2;
  }
  const reports = await matchReport(sql);
  if (reports.length === 0) {
    console.log('\nNo parcels yet: run `npm run job -- postex:sync` first.\n');
    return 2;
  }
  for (const r of reports) {
    console.log(`\n  ${r.account} (store ${r.storeKey ?? 'none'})`);
    console.log(`    parcels              ${r.parcels}`);
    console.log(`    matched              ${r.matched}  ${JSON.stringify(r.byMethod)}`);
    console.log(`    unmatched            ${r.unmatched}  (${pct(r.unmatchedRate)}, target at most ${pct(MAX_UNMATCHED_RATE)})`);
    console.log(`    unmatched, no item   ${r.unmatchedWithoutItem}  (must be 0)`);
    console.log(`    refs not a number    ${r.unparsedRefs}`);
    console.log('    prefixes on parcels:');
    for (const p of r.prefixes) {
      const name = p.prefix ?? '(none, e.g. #1234)';
      console.log(`      ${name.padEnd(20)} ${String(p.parcels).padStart(6)} parcels, ${String(p.matched).padStart(6)} matched${p.configured ? '' : '   <- not in the matching setting'}`);
    }
    console.log(`    ${r.withinTarget ? 'OK' : 'BELOW TARGET'}`);
  }
  console.log();
  return reports.every((r) => r.withinTarget) ? 0 : 1;
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
