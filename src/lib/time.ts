/**
 * Business days, month close, payout ageing and PostEx timestamps all run on Karachi time.
 * Offsets come from the IANA zone through Intl, never a hard-coded +05:00: Pakistan has
 * observed DST before (2008, 2009) and the zone database is where a future change would land.
 */
export const KARACHI = 'Asia/Karachi';

const MS_PER_DAY = 86_400_000;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: KARACHI,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const assertValid = (date: Date): void => {
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid Date');
};

/** The Karachi wall-clock reading of an instant. */
const karachiParts = (date: Date): LocalParts => {
  assertValid(date);
  const parts: Record<string, number> = {};
  for (const { type, value } of formatter.formatToParts(date)) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return {
    year: parts['year'] ?? 0,
    month: parts['month'] ?? 0,
    day: parts['day'] ?? 0,
    hour: parts['hour'] ?? 0,
    minute: parts['minute'] ?? 0,
    second: parts['second'] ?? 0,
    millisecond: date.getUTCMilliseconds(),
  };
};

const wallClockAsUtc = (p: LocalParts): number =>
  Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.millisecond);

/** How far Karachi's clock is ahead of UTC at a given instant, in ms. */
const offsetAt = (utcMs: number): number => wallClockAsUtc(karachiParts(new Date(utcMs))) - utcMs;

/**
 * The instant at which Karachi's clock shows the given wall time. The offset is looked up at a
 * first guess and then again at the result, which settles correctly even across an offset
 * change.
 */
const fromKarachiWallClock = (p: LocalParts): Date => {
  const asUtc = wallClockAsUtc(p);
  const first = asUtc - offsetAt(asUtc);
  return new Date(asUtc - offsetAt(first));
};

const POSTEX_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

/**
 * PostEx returns Karachi wall-clock time with no offset, e.g. `"2026-05-21 14:30:00"`. Read as
 * UTC it would be five hours off, which moves late-evening deliveries into the next day and
 * the next month. Strings that carry their own offset or `Z` are rejected: they are not the
 * shape PostEx sends, so something upstream changed.
 */
export const parsePostexLocal = (text: string): Date => {
  const match = POSTEX_LOCAL.exec(text.trim());
  if (!match) throw new RangeError(`Not a PostEx local timestamp: "${text}"`);

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const millisecond = Number((match[7] ?? '0').padEnd(3, '0'));
  const parts = { year, month, day, hour, minute, second, millisecond };

  // Date.UTC rolls 2026-02-30 over to 2 March; a date that does not survive the round trip
  // did not exist.
  const check = new Date(wallClockAsUtc(parts));
  if (
    hour > 23 || minute > 59 || second > 59 ||
    check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
  ) {
    throw new RangeError(`Not a real date and time: "${text}"`);
  }
  return fromKarachiWallClock(parts);
};

/**
 * The last second of a Karachi calendar day (`"2026-09-30"`): what "as at" a date means for
 * counts and balances. Throws RangeError for a day that does not exist.
 */
export const endOfKarachiDay = (day: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError(`Not a calendar day: "${day}"`);
  return parsePostexLocal(`${day} 23:59:59.999`);
};

/** The first instant of a Karachi calendar day (`"2026-09-30"`). Throws RangeError for a day that does not exist. */
export const startOfKarachiDate = (day: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError(`Not a calendar day: "${day}"`);
  return parsePostexLocal(`${day} 00:00:00`);
};

/** Midnight in Karachi at the start of the Karachi day containing `date`. */
export const startOfKarachiDay = (date: Date): Date => {
  const { year, month, day } = karachiParts(date);
  return fromKarachiWallClock({ year, month, day, hour: 0, minute: 0, second: 0, millisecond: 0 });
};

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `"2026-05"`: the Karachi month an instant belongs to, used for month close and P&L. */
export const karachiMonthKey = (date: Date): string => {
  const { year, month } = karachiParts(date);
  return `${pad(year, 4)}-${pad(month)}`;
};

/** `"2026-05-21 14:30:00"`: Karachi wall time, the same shape `parsePostexLocal` reads. */
export const formatKarachi = (date: Date): string => {
  const p = karachiParts(date);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
};

/**
 * Calendar days from `a` to `b` in Karachi, negative when `b` is earlier. 23:59 to 00:01 the
 * next day is one day: ageing buckets and "not booked within a day" count calendar days, not
 * 24-hour periods.
 */
export const daysBetweenKarachi = (a: Date, b: Date): number => {
  const day = (d: Date) => {
    const { year, month, day: dayOfMonth } = karachiParts(d);
    return Date.UTC(year, month - 1, dayOfMonth);
  };
  return Math.round((day(b) - day(a)) / MS_PER_DAY);
};
