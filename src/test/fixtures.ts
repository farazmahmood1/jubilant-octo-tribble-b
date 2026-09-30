import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** `<source>-<endpoint>-<case>`, e.g. `postex-track-order-delivered`. */
const FIXTURE_NAME = /^(postex|shopify)-[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+$/;

/**
 * Loads a recorded response from `src/test/fixtures/<name>.json`. Names are checked against the
 * convention so a typo fails loudly instead of loading the wrong file.
 */
export const fixture = <T = unknown>(name: string, dir: string = FIXTURES_DIR): T => {
  if (!FIXTURE_NAME.test(name)) {
    throw new Error(`Fixture name "${name}" does not follow <source>-<endpoint>-<case>`);
  }
  const file = resolve(dir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`Fixture not found: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as T;
};
