import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { fixture } from './fixtures.js';

describe('fixture', () => {
  // Real fixture content arrives with the tasks that record it, so these use a scratch dir.
  const dir = mkdtempSync(join(tmpdir(), 'nur-fixtures-'));
  writeFileSync(join(dir, 'postex-track-order-delivered.json'), JSON.stringify({ trackingNumber: '1' }));

  it('loads and parses a fixture by name', () => {
    assert.deepEqual(fixture('postex-track-order-delivered', dir), { trackingNumber: '1' });
  });

  it('rejects names that break the <source>-<endpoint>-<case> convention', () => {
    assert.throws(() => fixture('delivered', dir), /does not follow/);
    assert.throws(() => fixture('stripe-charge-ok', dir), /does not follow/);
    assert.throws(() => fixture('../secrets', dir), /does not follow/);
  });

  it('says which file is missing', () => {
    assert.throws(() => fixture('shopify-orders-none', dir), /Fixture not found: .*shopify-orders-none\.json/);
  });
});
