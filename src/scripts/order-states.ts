/**
 * Re-derives every order's confirmation and state, e.g. after the confirmation tags or desk
 * settings change, and once after migration 0012 to create every order's confirmation. Logs only
 * the orders whose state moved. Run with: npm run orders:states
 */
import { closeDb, db } from '../db.js';
import { recomputeOrderState } from '../db/repos/order-state.js';

const run = async (): Promise<number> => {
  const sql = db();
  if (!sql) {
    console.error('DATABASE_URL is not set');
    return 2;
  }
  const orders = await sql<{ id: string }[]>`select id from orders order by id`;
  let changed = 0;
  for (const { id } of orders) if ((await recomputeOrderState(sql, id)).changed) changed++;
  const states = await sql<{ state: string; n: number }[]>`select coalesce(state, '(none)') as state, count(*)::int as n from orders group by 1 order by 2 desc`;
  console.log(`\n${orders.length} orders, ${changed} changed state.`);
  for (const s of states) console.log(`  ${s.state.padEnd(20)} ${s.n}`);
  console.log();
  return 0;
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
