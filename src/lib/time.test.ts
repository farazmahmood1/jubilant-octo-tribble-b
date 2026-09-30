import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  KARACHI,
  daysBetweenKarachi,
  formatKarachi,
  karachiMonthKey,
  parsePostexLocal,
  startOfKarachiDay,
} from './time.js';

const utc = (iso: string) => new Date(iso);

describe('parsePostexLocal', () => {
  it('reads PostEx wall-clock time as Karachi', () => {
    assert.equal(parsePostexLocal('2026-05-21 14:30:00').toISOString(), '2026-05-21T09:30:00.000Z');
  });

  it('keeps a late-evening delivery on its Karachi day, and an early one in its month', () => {
    assert.equal(parsePostexLocal('2026-06-30 23:45:10').toISOString(), '2026-06-30T18:45:10.000Z');
    assert.equal(parsePostexLocal('2026-07-01 02:00:00').toISOString(), '2026-06-30T21:00:00.000Z');
  });

  it('accepts a T separator and milliseconds', () => {
    assert.equal(parsePostexLocal('2026-05-21T14:30:00.25').toISOString(), '2026-05-21T09:30:00.250Z');
  });

  it('uses the zone database, not a fixed +05:00', () => {
    // Pakistan observed DST (UTC+6) from 1 June to 31 October 2008.
    assert.equal(parsePostexLocal('2008-07-01 12:00:00').toISOString(), '2008-07-01T06:00:00.000Z');
    assert.equal(parsePostexLocal('2008-12-01 12:00:00').toISOString(), '2008-12-01T07:00:00.000Z');
  });

  for (const text of ['2026-02-30 10:00:00', '2026-13-01 10:00:00', '2026-05-21 24:00:00', '2026-05-21 14:60:00', '2026-05-21T14:30:00Z', '2026-05-21 14:30:00+05:00', '21/05/2026 14:30', '', '2026-05-21']) {
    it(`rejects "${text}"`, () => assert.throws(() => parsePostexLocal(text), RangeError));
  }
});

describe('startOfKarachiDay', () => {
  it('is Karachi midnight, which is 19:00 UTC the day before', () => {
    assert.equal(startOfKarachiDay(utc('2026-05-21T09:30:00Z')).toISOString(), '2026-05-20T19:00:00.000Z');
  });

  it('puts 21:00 UTC into the next Karachi day', () => {
    assert.equal(startOfKarachiDay(utc('2026-05-31T21:00:00Z')).toISOString(), '2026-05-31T19:00:00.000Z');
  });
});

describe('karachiMonthKey', () => {
  it('uses the Karachi month even when UTC is still in the previous one', () => {
    assert.equal(karachiMonthKey(utc('2026-05-31T21:00:00Z')), '2026-06');
    assert.equal(karachiMonthKey(utc('2026-05-31T18:59:59Z')), '2026-05');
  });
});

describe('formatKarachi', () => {
  it('writes Karachi wall time and round-trips through parsePostexLocal', () => {
    const text = formatKarachi(utc('2026-05-21T09:30:00Z'));
    assert.equal(text, '2026-05-21 14:30:00');
    assert.equal(parsePostexLocal(text).toISOString(), '2026-05-21T09:30:00.000Z');
  });

  it('writes midnight as 00, not 24', () => {
    assert.equal(formatKarachi(utc('2026-05-20T19:00:00Z')), '2026-05-21 00:00:00');
  });
});

describe('daysBetweenKarachi', () => {
  it('counts Karachi calendar days, not 24-hour periods', () => {
    const lateNight = parsePostexLocal('2026-05-21 23:59:00');
    const justAfter = parsePostexLocal('2026-05-22 00:01:00');
    assert.equal(daysBetweenKarachi(lateNight, justAfter), 1);
    assert.equal(daysBetweenKarachi(parsePostexLocal('2026-05-21 00:00:00'), lateNight), 0);
  });

  it('matches the proposal sample: delivered 27 June, settled 2 July', () => {
    assert.equal(daysBetweenKarachi(parsePostexLocal('2026-06-27 16:00:00'), parsePostexLocal('2026-07-02 11:00:00')), 5);
  });

  it('is negative when the second date is earlier', () => {
    assert.equal(daysBetweenKarachi(parsePostexLocal('2026-07-02 11:00:00'), parsePostexLocal('2026-06-27 16:00:00')), -5);
  });

  it('rejects an invalid Date instead of returning NaN', () => {
    assert.throws(() => daysBetweenKarachi(new Date('nope'), new Date()), RangeError);
  });
});

it('names the IANA zone', () => {
  assert.equal(KARACHI, 'Asia/Karachi');
});
