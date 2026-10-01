/**
 * PostEx totals per account for parcels booked between two Karachi dates, to reconcile a sync
 * against the spike figures (877 delivered, 117 returned, PKR 209,009 forward and PKR 27,787
 * return charges for 14 May – 19 Sep 2026).
 * Run with: npm run postex:totals -- 2026-05-14 2026-09-19
 */
import { closeDb, db } from '../db.js';
import { postexTotals } from '../db/repos/shipments.js';
import { paisa, toRupeeString } from '../lib/money.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const rs = (amount: bigint) => `PKR ${toRupeeString(paisa(amount))}`;

const run = async (from = '2026-05-14', to = '2026-09-19'): Promise<number> => {
  const sql = db();
  if (!sql) {
    console.error('DATABASE_URL is not set');
    return 2;
  }
  if (!DATE.test(from) || !DATE.test(to)) {
    console.error('Usage: npm run postex:totals -- <from YYYY-MM-DD> <to YYYY-MM-DD>');
    return 2;
  }
  const totals = await postexTotals(sql, from, to);
  console.log(`\nPostEx parcels booked ${from} to ${to} (Karachi)`);
  if (totals.length === 0) console.log('  none');
  for (const t of totals) {
    console.log(`\n  ${t.account}`);
    console.log(`    parcels            ${t.parcels}`);
    console.log(`    delivered (0005)   ${t.delivered}`);
    console.log(`    returned (0006)    ${t.returned}`);
    console.log(`    forward charges    ${rs(t.forwardFee)}  + tax ${rs(t.forwardTax)}  = ${rs(t.forwardFee + t.forwardTax)}`);
    console.log(`    return charges     ${rs(t.reversalFee)}  + tax ${rs(t.reversalTax)}  = ${rs(t.reversalFee + t.reversalTax)}`);
  }
  console.log();
  return 0;
};

run(process.argv[2], process.argv[3])
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
