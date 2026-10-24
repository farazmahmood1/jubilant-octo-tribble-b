// Development: the API and the background worker together, each with reload, so the syncs and the
// reconciliation scan run every 2 minutes (SYNC_EVERY_MS) without a second terminal.
//   node scripts/dev.mjs
// `npm run dev:api` or `npm run dev:worker` start just one of them. If either stops for good, so
// does the other: a worker alone, or an API alone, quietly leaves half the platform stale.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const entries = [
  ['api', 'src/index.ts'],
  ['worker', 'src/index.worker.ts'],
];

let stopping = false;

// tsx starts the app as its own child, so on Windows the whole tree has to be taken down.
const kill = (child) => {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGTERM');
};

const children = entries.map(([name, entry]) => {
  // Without --clear-screen=false one app's restart wipes the other's log from the shared terminal.
  const child = spawn(process.execPath, [tsx, 'watch', '--clear-screen=false', entry], { stdio: 'inherit' });
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`[dev] ${name} stopped (exit ${code ?? 'signal'}); stopping the other`);
      process.exitCode = code || 1;
    }
    stopping = true;
    for (const other of children) kill(other);
  });
  return child;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    for (const child of children) kill(child);
  });
}
