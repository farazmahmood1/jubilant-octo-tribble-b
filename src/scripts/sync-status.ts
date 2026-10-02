/**
 * Where the PostEx sync has got to, read from the database. Read-only: it changes nothing, so it is
 * safe to run while a sync is going (a long sync prints nothing until it finishes).
 * Run with: npm run sync:status      (run it twice a minute apart to see the rate)
 */
import { closeDb, db } from '../db.js';

const when = (d: Date | null): string => (d ? `${d.toISOString().replace('T', ' ').slice(0, 19)} UTC` : '—');

const run = async (): Promise<number> => {
  const sql = db();
  if (!sql) {
    console.error('DATABASE_URL is not set');
    return 2;
  }
  console.log(`\nPostEx sync status, ${when(new Date())}\n`);

  const accounts = await sql<{ key: string; parcels: number; dated: number; detailed: number; delivered: number; returned: number; first: Date | null; last: Date | null }[]>`
    select a.key,
           count(s.id)::int as parcels,
           count(s.booked_at)::int as dated,
           count(distinct e.shipment_id)::int as detailed,
           count(s.id) filter (where s.status_code = '0005')::int as delivered,
           count(s.id) filter (where s.status_code = '0006')::int as returned,
           min(s.booked_at) as first, max(s.booked_at) as last
    from postex_accounts a
    left join shipments s on s.postex_account_id = a.id
    left join (select distinct shipment_id from shipment_events) e on e.shipment_id = s.id
    group by a.key order by a.key
  `;
  const cursors = await sql<{ account_ref: string; cursor: string; updated_at: Date }[]>`
    select account_ref, cursor, updated_at from integration_cursors where job = 'postex:sync'
  `;
  for (const a of accounts) {
    const listed = cursors.find((c) => c.account_ref === a.key);
    const through = listed ? (JSON.parse(listed.cursor) as { listedThrough?: string }).listedThrough : undefined;
    console.log(`  ${a.key}`);
    console.log(`    parcels found          ${a.parcels}`);
    console.log(`    with a booking date    ${a.dated}   (filled in when each parcel's history is fetched)`);
    console.log(`    with history fetched   ${a.detailed}`);
    console.log(`    delivered / returned   ${a.delivered} / ${a.returned}`);
    console.log(`    booked between         ${when(a.first)}  and  ${when(a.last)}`);
    console.log(`    listed through         ${through ?? 'not started'}${listed ? `   (cursor saved ${when(listed.updated_at)})` : ''}`);
  }

  const runs = await sql<{ id: string; status: string; started_at: Date; finished_at: Date | null; error: string | null }[]>`
    select id, status, started_at, finished_at, error from sync_runs where job = 'postex:sync' order by id desc limit 4
  `;
  console.log('\n  Latest runs');
  for (const r of runs) {
    console.log(`    #${r.id}  ${r.status.padEnd(9)} started ${when(r.started_at)}  ${r.finished_at ? `finished ${when(r.finished_at)}` : 'not finished'}${r.error ? `  (${r.error})` : ''}`);
  }

  // What the database is doing for others right now: a live sync shows up as a connection with a recent query.
  const busy = await sql<{ n: number; waiting: number }[]>`
    select count(*)::int as n, count(*) filter (where cardinality(pg_blocking_pids(pid)) > 0)::int as waiting
    from pg_stat_activity
    where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend' and state <> 'idle'
  `;
  const live = busy[0];
  console.log(`\n  Database connections doing work right now: ${live?.n ?? 0}${live?.waiting ? `, ${live.waiting} waiting on a lock` : ''}`);
  console.log('  (A running sync keeps at least one busy. Run this again in a minute: "parcels found" going up means it is moving.)\n');
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
