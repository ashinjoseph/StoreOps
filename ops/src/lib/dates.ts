// Port of the date helpers in src/Util.gs.
//
// The old code ran in Apps Script, where every Date method that reads or sets
// "local" time (getDay, setHours, setDate...) means America/Toronto. A Worker
// runs in UTC, so every such step here is done on Toronto wall-clock time
// explicitly, with Intl and no date library. Results are real Date instants,
// exactly as before.
//
// The clock is never read deep inside: functions that need "now" take it as an
// argument, defaulting to the real clock only at that boundary.

export const TZ = "America/Toronto";

const PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Toronto wall-clock fields of an instant. `month` is 1-12, `dow` is 0 (Sunday) to 6. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  dow: number;
}

/** Date.UTC that also accepts years 0-99 as themselves, and overflowing fields (like the Date constructor). */
function utc(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number): number {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo, d);
  dt.setUTCHours(h, mi, s, ms);
  return dt.getTime();
}

/** Toronto wall-clock fields for an instant. The instant must be a valid Date. */
export function wallClock(d: Date): WallClock {
  const t = d.getTime();
  const v: Record<string, string> = {};
  for (const p of PARTS.formatToParts(d)) v[p.type] = p.value;
  const num = (k: string): number => Number(v[k]);
  return {
    year: num("year"),
    month: num("month"),
    day: num("day"),
    hour: num("hour"),
    minute: num("minute"),
    second: num("second"),
    ms: ((t % 1000) + 1000) % 1000,
    dow: DOW[v["weekday"] ?? ""] ?? 0,
  };
}

/** Toronto's offset from UTC at an instant, in ms (negative: Toronto is behind). */
function offsetAt(t: number): number {
  const w = wallClock(new Date(t));
  return utc(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, 0) - Math.floor(t / 1000) * 1000;
}

/**
 * The instant at which Toronto's wall clock reads the given fields, resolved the way
 * V8 resolves a local Date: a repeated wall time (fall back) takes the first
 * occurrence; a skipped one (spring forward) is read with the offset from before the
 * jump, so 02:30 becomes 03:30. Fields may overflow (day 0, day 32, month 12...).
 */
function wallToInstant(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number): Date {
  const guess = utc(y, mo, d, h, mi, s, ms);
  if (Number.isNaN(guess)) return new Date(NaN);
  const before = offsetAt(guess - DAY_MS);
  const after = offsetAt(guess + DAY_MS);
  const valid: number[] = [];
  for (const off of new Set([before, after])) {
    const t = guess - off;
    if (offsetAt(t) === off) valid.push(t);
  }
  return new Date(valid.length > 0 ? Math.min(...valid) : guess - before);
}

const invalid = (d: Date): boolean => Number.isNaN(d.getTime());
const p2 = (n: number): string => String(n).padStart(2, "0");
const p4 = (n: number): string => String(n).padStart(4, "0");

/** Toronto midnight (00:00:00.000) of the day containing `now`. */
export function todayMidnight(now: Date = new Date()): Date {
  if (invalid(now)) return new Date(NaN);
  const w = wallClock(now);
  return wallToInstant(w.year, w.month - 1, w.day, 0, 0, 0, 0);
}

/** 23:59:59.999 Toronto of the day containing `d`. Returns a new Date. */
export function endOfDay(d: Date | number): Date {
  const x = new Date(d);
  if (invalid(x)) return x;
  const w = wallClock(x);
  return wallToInstant(w.year, w.month - 1, w.day, 23, 59, 59, 999);
}

/** The Toronto business date, "yyyy-MM-dd". Throws on an invalid Date, like Utilities.formatDate. */
export function formatDate(d: Date): string {
  const w = wallClock(d);
  return `${p4(w.year)}-${p2(w.month)}-${p2(w.day)}`;
}

/** Toronto "yyyy-MM-dd HH:mm:ss". */
export function formatDateTime(d: Date): string {
  const w = wallClock(d);
  return `${p4(w.year)}-${p2(w.month)}-${p2(w.day)} ${p2(w.hour)}:${p2(w.minute)}:${p2(w.second)}`;
}

/** Toronto "yyyyMMdd" (used inside ids). */
export function formatDateStamp(d: Date): string {
  const w = wallClock(d);
  return `${p4(w.year)}${p2(w.month)}${p2(w.day)}`;
}

/** Toronto "yyyyMMdd_HHmmss" (used inside ids). */
export function formatDateTimeStamp(d: Date): string {
  const w = wallClock(d);
  return `${p4(w.year)}${p2(w.month)}${p2(w.day)}_${p2(w.hour)}${p2(w.minute)}${p2(w.second)}`;
}

const ISO_DAY = /^([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/**
 * "yyyy-MM-dd" to Toronto midnight. Blank is null (not a date). A Date passes through
 * as the same object. Anything else that the old `new Date(s + 'T00:00:00')` would
 * not read as a Toronto local date-time gives an Invalid Date. Quirk kept: a day up to
 * 31 is accepted in any month and rolls over ("2026-02-30" is 2026-03-02).
 */
export function parseDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const m = ISO_DAY.exec(String(value));
  if (!m) return new Date(NaN);
  const y = Number(m[1]);
  const mo = m[2] === undefined ? 1 : Number(m[2]);
  const d = m[3] === undefined ? 1 : Number(m[3]);
  if (m[1] === "-000000" || mo < 1 || mo > 12 || d < 1 || d > 31) return new Date(NaN);
  return wallToInstant(y, mo - 1, d, 0, 0, 0, 0);
}

/** `days` calendar days later at the same Toronto wall-clock time (a clock change does not shift it). */
export function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  if (invalid(x)) return x;
  const w = wallClock(x);
  return wallToInstant(w.year, w.month - 1, w.day + days, w.hour, w.minute, w.second, w.ms);
}

/** Monday 00:00 Toronto of the week containing `d` (a Sunday belongs to the week before it). */
export function getMondayOf(d: Date): Date {
  const x = new Date(d);
  if (invalid(x)) return x;
  const w = wallClock(x);
  const diff = w.dow === 0 ? -6 : 1 - w.dow;
  return wallToInstant(w.year, w.month - 1, w.day + diff, 0, 0, 0, 0);
}

/** The Monday 00:00 to Sunday 23:59:59.999 window of the week before the one containing `now`. */
export function getPreviousWeekRange(now?: Date | null): { start: Date; end: Date } {
  const ref = now || new Date();
  const thisMonday = getMondayOf(ref);
  const lastMonday = addDays(thisMonday, -7);
  const lastSunday = endOfDay(addDays(lastMonday, 6));
  return { start: lastMonday, end: lastSunday };
}

/** Real elapsed hours between two instants; 0 when either is missing or the end is before the start. */
export function diffHours(start?: Date | null, end?: Date | null): number {
  if (!start || !end) return 0;
  const ms = end.getTime() - start.getTime();
  return Math.max(0, ms / HOUR_MS);
}
