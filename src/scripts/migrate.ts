/**
 * Database migrations and seeding.
 * Run with: npm run migrate | npm run migrate:status | npm run seed
 *
 * `migrate` refuses to run when an applied migration's file has changed or disappeared, and
 * exits non-zero; `migrate:status` shows the same thing without changing anything.
 */
import { closeDb, db } from '../db.js';
import { MigrationError, migrate, migrationStatus } from '../db/migrate.js';
import { seed } from '../db/seed.js';

const line = (label: string, detail: string) => console.log(`  ${label.padEnd(34)} ${detail}`);

const run = async (command: string): Promise<void> => {
  const sql = db();
  if (!sql) throw new Error('DATABASE_URL is not set');

  if (command === 'status') {
    const status = await migrationStatus(sql);
    console.log('\nMigrations');
    for (const s of status) {
      line(`${s.version}_${s.name}`, s.appliedAt ? `${s.state} (${s.appliedAt.toISOString()})` : s.state);
    }
    if (status.some((s) => s.state === 'changed' || s.state === 'missing')) process.exitCode = 1;
    console.log();
    return;
  }

  if (command === 'seed') {
    const result = await seed(sql);
    console.log(`Seeded: ${result.stores} store(s), ${result.postexAccounts} PostEx account(s) inserted or changed`);
    return;
  }

  const applied = await migrate(sql);
  if (applied.length === 0) console.log('Nothing to migrate: the database is up to date');
  for (const file of applied) console.log(`Applied ${file.file}`);
};

run(process.argv[2] ?? 'up')
  .catch((error: unknown) => {
    // A refusal is an expected outcome with its own explanation; a stack trace would bury it.
    console.error(error instanceof MigrationError ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
    process.exit();
  });
