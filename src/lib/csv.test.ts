import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('reads plain, quoted and escaped fields, with the line each row starts on', () => {
    const rows = parseCsv('﻿date,sku,qty\r\n2026-09-01,"SER-1, 30ml",2\n2026-09-02,"say ""hi""\nthere",3\n');
    assert.deepEqual(rows, [
      { line: 1, cells: ['date', 'sku', 'qty'] },
      { line: 2, cells: ['2026-09-01', 'SER-1, 30ml', '2'] },
      { line: 3, cells: ['2026-09-02', 'say "hi"\nthere', '3'] },
    ]);
  });

  it('keeps blank lines as rows (so line numbers stay true) and a last row with no newline', () => {
    assert.deepEqual(parseCsv('a\n\nb'), [{ line: 1, cells: ['a'] }, { line: 2, cells: [''] }, { line: 3, cells: ['b'] }]);
  });

  it('refuses an unterminated quote', () => {
    assert.throws(() => parseCsv('a,"b\nc'), /Unterminated quote starting on line 1/);
  });
});
