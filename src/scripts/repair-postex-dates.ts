/**
 * One-off repair for parcels synced before the mapper learned PostEx's `…+0500` timestamps.
 * Those parcels were flagged `invalid_date`, stored with no booking date, and every one of their
 * history events was stored with no time.
 *
 * For each parcel carrying `invalid_date` it:
 *   1. deletes the history events that have no time (shipment_events is append-only, so the guard
 *      trigger is switched off for this transaction only, and back on before it commits),
 *   2. removes the stale `invalid_date` flag (a re-read puts it back if the date is genuinely bad),
 *   3. clears last_synced_at, so the next postex:sync re-reads the parcel and stores it with dates.
 * Nothing else is touched: no order, payout, charge, journal or stock row changes here.
 *
 * Dry run by default: it only reports what it would do. Writing needs --apply.
 * Stop any running `postex:sync` first, or it keeps writing undated rows with the old code.
 *
 * Run with: npm run postex:repair-dates              (report only)
 *           npm run postex:repair-dates -- --apply    (make the change)
 * Then:     npm run job -- postex:sync                (re-reads every cleared parcel)
 */
import { closeDb, db } from '../db.js';

const apply = process.argv.includes('--apply');
const ignoreRunning = process.argv.includes('--ignore-running');

const run = async (): Promise<number> => {
  const sql = db();
  if (!sql) {
    console.error('DATABASE_URL is not set');
    return 2;
  }

  const running = await sql<{ id: string; account_ref: string; started_at: Date }[]>`
    select id, account_ref, started_at from sync_runs where job = 'postex:sync' and status = 'running'
  `;
  if (running.length > 0 && !ignoreRunning) {
    console.error('\nA postex:sync run is still marked running:');
    for (const r of running) console.error(`  #${r.id}  ${r.account_ref}  started ${r.started_at.toISOString()}`);
    console.error('\nStop it (Ctrl+C in its terminal) and run this again. If it is a leftover from a');
    console.error('sync you already stopped, add --ignore-running.\n');
    return 1;
  }

  const [before] = await sql<{ parcels: number; events: number; total_parcels: number; total_events: number }[]>`
    select count(distinct s.id)::int as parcels,
           count(e.id) filter (where e.occurred_at is null)::int as events,
           (select count(*)::int from shipments) as total_parcels,
           (select count(*)::int from shipment_events) as total_events
    from shipments s
    left join shipment_events e on e.shipment_id = s.id
    where 'invalid_date' = any(s.flags)
  `;
  if (!before) throw new Error('count query returned nothing');
  console.log(`\nParcels flagged invalid_date:      ${before.parcels}  (of ${before.total_parcels})`);
  console.log(`Their events with no time:         ${before.events}  (of ${before.total_events} events in all)`);

  if (before.parcels === 0) {
    console.log('\nNothing to repair.\n');
    return 0;
  }
  if (!apply) {
    console.log('\nDry run, nothing changed. Re-run with --apply to delete those events and queue the parcels for re-reading.\n');
    return 0;
  }

  const done = await sql.begin(async (tx) => {
    // Fail fast rather than queue behind another session's lock on the table.
    await tx.unsafe(`set local lock_timeout = '10s'`);
    await tx.unsafe('alter table shipment_events disable trigger shipment_events_append_only');
    const deleted = await tx`
      delete from shipment_events e
      using shipments s
      where e.shipment_id = s.id and 'invalid_date' = any(s.flags) and e.occurred_at is null
    `;
    await tx.unsafe('alter table shipment_events enable trigger shipment_events_append_only');
    const reset = await tx`
      update shipments
      set flags = array_remove(flags, 'invalid_date'), last_synced_at = null
      where 'invalid_date' = any(flags)
    `;
    return { events: deleted.count, parcels: reset.count };
  });

  // The guard must be back on; say so rather than assume.
  const [guard] = await sql<{ enabled: string }[]>`
    select tgenabled::text as enabled from pg_trigger where tgname = 'shipment_events_append_only'
  `;
  console.log(`\nDeleted ${done.events} undated events; queued ${done.parcels} parcels for re-reading.`);
  console.log(`Append-only guard on shipment_events: ${guard?.enabled === 'O' ? 'on' : `NOT ON (state "${guard?.enabled ?? 'missing'}")`}`);
  console.log('\nNow run: npm run job -- postex:sync   (about 1 request per second, 25 parcels per request)\n');
  return guard?.enabled === 'O' ? 0 : 1;
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
