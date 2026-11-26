// Loads the REAL src/Util.gs in Node, with the Apps Script globals stubbed,
// so tests can compare the TypeScript port against the original (the oracle).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Apps Script runs Date in the script time zone (America/Toronto). The old
// code uses local-time Date methods (setHours, getDay...), so the oracle must
// run with the same local zone.
process.env.TZ = "America/Toronto";

const RealDate = Date;
const UTIL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/Util.gs");

/** Independent Utilities.formatDate: uses the sv-SE locale ("yyyy-MM-dd HH:mm:ss"), a different route from the port. */
export function stubFormatDate(d: Date, tz: string, fmt: string): string {
  if (!(d instanceof RealDate)) throw new Error("formatDate needs a Date");
  const s = d.toLocaleString("sv-SE", { timeZone: tz, hourCycle: "h23" }); // 2026-03-08 03:30:00
  const [date = "", time = ""] = s.split(" ");
  const [y = "", mo = "", da = ""] = date.split("-");
  const [h = "", mi = "", se = ""] = time.split(":");
  switch (fmt) {
    case "yyyy-MM-dd": return `${y}-${mo}-${da}`;
    case "yyyy-MM-dd HH:mm:ss": return `${y}-${mo}-${da} ${h}:${mi}:${se}`;
    case "yyyyMMdd": return `${y}${mo}${da}`;
    case "yyyyMMdd_HHmmss": return `${y}${mo}${da}_${h}${mi}${se}`;
    default: throw new Error("unsupported format " + fmt);
  }
}

export interface OldDeps {
  /** Instant returned by `new Date()` with no arguments inside the old code. */
  nowMs: number;
  /** Replaces Math.random inside the old code. */
  random: () => number;
  /** Replaces Utilities.getUuid. */
  uuid: () => string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...args: any[]) => any;
export interface OldUtil {
  todayMidnight: Fn; endOfDay: Fn; formatDate: Fn; formatDateTime: Fn;
  parseDate: Fn; addDays: Fn; getMondayOf: Fn; getPreviousWeekRange: Fn;
  diffHours: Fn; newId: Fn; attendanceId: Fn; tillSessionId: Fn;
  newToken: Fn; newLoginCode: Fn; roundMoney: Fn; moneyEquals: Fn;
  formatMoney: Fn; parseTimeRange: Fn; formatTimeHHMM: Fn;
}

export function loadOldUtil(): { Util: OldUtil; deps: OldDeps } {
  const deps: OldDeps = {
    nowMs: RealDate.UTC(2026, 5, 15, 16, 0, 0),
    random: () => 0.123456789,
    uuid: () => "00000000-0000-4000-8000-000000000001",
  };
  // `new Date()` with no args returns deps.nowMs; instanceof still works for real Dates.
  class FakeDate extends RealDate {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(deps.nowMs);
      else super(...(a as [number]));
    }
    static override now(): number { return deps.nowMs; }
  }
  Object.defineProperty(FakeDate, Symbol.hasInstance, { value: (x: unknown) => x instanceof RealDate });
  const FakeMath = Object.create(Math) as Math;
  FakeMath.random = () => deps.random();

  const src = readFileSync(UTIL_PATH, "utf8");
  const factory = new Function("Session", "Utilities", "Date", "Math", src + "\n;return Util;");
  const Util = factory(
    { getScriptTimeZone: () => "America/Toronto" },
    { formatDate: stubFormatDate, getUuid: () => deps.uuid() },
    FakeDate,
    FakeMath,
  ) as OldUtil;
  return { Util, deps };
}

/** Description of a value that keeps +0/-0, NaN, Invalid Date and Date instants distinct. */
export function norm(v: unknown): unknown {
  if (v instanceof RealDate) return { __date: Number.isNaN(v.getTime()) ? "invalid" : v.toISOString() };
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : Number.isNaN(v) ? "NaN" : v;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
  return v;
}
