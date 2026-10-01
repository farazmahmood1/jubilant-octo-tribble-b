import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { monthBounds } from './lines.js';

describe('monthBounds', () => {
  it('gives the first and last day of a month, leap years included', () => {
    assert.deepEqual(monthBounds('2026-09'), { from: '2026-09-01', to: '2026-09-30' });
    assert.deepEqual(monthBounds('2026-12'), { from: '2026-12-01', to: '2026-12-31' });
    assert.deepEqual(monthBounds('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
    assert.deepEqual(monthBounds('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
  });

  it('refuses anything that is not a real month', () => {
    for (const bad of ['2026-13', '2026-00', '2026-9', '202609', 'September', '', '2026-09-01']) assert.equal(monthBounds(bad), null, bad);
  });
});
