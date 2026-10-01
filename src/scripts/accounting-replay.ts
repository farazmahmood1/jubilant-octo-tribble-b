/**
 * Posts everything the journal is missing for every parcel and payout, then prints the trial
 * balance. Safe to run any time: a journal already in line gets no new entries.
 * Run with: npm run accounting:replay
 */
import { closeDb, db } from '../db.js';
import { replayAccounting, trialBalance } from '../domain/accounting.js';
import { paisa, toRupeeString } from '../lib/money.js';

const rs = (amount: bigint) => `PKR ${toRupeeString(paisa(amount))}`.padStart(22);

const run = async (): Promise<number> => {
  const sql = db();
  if (!sql) {
    console.error('DATABASE_URL is not set');
    return 2;
  }
  const replay = await replayAccounting(sql);
  console.log(`\nReplayed ${replay.shipments} parcels: ${replay.postings} postings, ${replay.payoutLines} payout lines posted.\n`);
  const tb = await trialBalance(sql);
  console.log(`  ${'Account'.padEnd(52)}${'Debit'.padStart(22)}${'Credit'.padStart(22)}`);
  for (const row of tb.rows) console.log(`  ${`${row.code} ${row.name}`.padEnd(52)}${rs(row.debit)}${rs(row.credit)}`);
  console.log(`  ${'Total'.padEnd(52)}${rs(tb.debit)}${rs(tb.credit)}\n`);
  return tb.debit === tb.credit ? 0 : 1;
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
