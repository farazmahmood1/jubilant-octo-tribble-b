// Build helpers that tsc does not do itself, in plain Node so they work on Windows and Render.
//   node scripts/dist.mjs clean             remove dist/, so deleted sources leave nothing behind
//   node scripts/dist.mjs copy-migrations   copy src/db/migrations/*.sql into dist/db/migrations
import { cpSync, rmSync } from 'node:fs';

const command = process.argv[2];
if (command === 'clean') {
  rmSync('dist', { recursive: true, force: true });
} else if (command === 'copy-migrations') {
  cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true, filter: (src) => !src.endsWith('.gitkeep') });
} else {
  console.error(`Unknown command: ${command ?? '(none)'}`);
  process.exit(1);
}
