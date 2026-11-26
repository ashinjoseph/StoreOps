import { describe, expect, it } from "vitest";
import {
  addDays, diffHours, endOfDay, formatDate, formatDateTime, getMondayOf,
  getPreviousWeekRange, parseDate, todayMidnight,
} from "../src/lib/dates";
import { loadOldUtil, norm } from "./_old-util";

const { Util: old, deps } = loadOldUtil();
const U = (y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0) => new Date(Date.UTC(y, m - 1, d, h, mi, s, ms));

// Toronto is UTC-5 in winter (EST) and UTC-4 in summer (EDT).
// Spring forward 2026-03-08 02:00 EST -> 03:00 EDT (07:00Z). Fall back 2026-11-01 02:00 EDT -> 01:00 EST (06:00Z).
const NAMED: Array<[string, Date]> = [
  ["23:59:59 Toronto (2026-06-15)", U(2026, 6, 16, 3, 59, 59)],
  ["00:00:01 Toronto (2026-06-16)", U(2026, 6, 16, 4, 0, 1)],
  ["23:59:59.999 Toronto year end", U(2026, 1, 1, 4, 59, 59, 999)],
  ["00:00:01 Toronto new year", U(2026, 1, 1, 5, 0, 1)],
  ["year end noon", U(2025, 12, 31, 17)],
  ["UTC is Jul 1, Toronto is Jun 30", U(2026, 7, 1, 3, 30)],
  ["UTC is Dec 1, Toronto is Nov 30", U(2026, 12, 1, 2, 0)],
  ["leap day", U(2028, 2, 29, 12)],
  ["day before leap day, late", U(2028, 2, 29, 4, 59, 59)],
  ["spring: 1 s before the jump", U(2026, 3, 8, 6, 59, 59)],
  ["spring: at the jump (03:00 EDT)", U(2026, 3, 8, 7, 0, 0)],
  ["spring: midnight before", U(2026, 3, 8, 5, 0, 0)],
  ["spring: 23:59:59 same day", U(2026, 3, 9, 3, 59, 59)],
  ["fall: 00:59:59 EDT", U(2026, 11, 1, 4, 59, 59)],
  ["fall: first 01:00 (EDT)", U(2026, 11, 1, 5, 0, 0)],
  ["fall: first 01:30 (EDT)", U(2026, 11, 1, 5, 30, 0)],
  ["fall: second 01:00 (EST, repeated hour)", U(2026, 11, 1, 6, 0, 0)],
  ["fall: second 01:30 (EST, repeated hour)", U(2026, 11, 1, 6, 30, 0)],
  ["fall: 02:00 EST", U(2026, 11, 1, 7, 0, 0)],
  ["fall: 23:59:59 same day (EST)", U(2026, 11, 2, 4, 59, 59)],
  ["epoch", new Date(0)],
  ["invalid date", new Date(NaN)],
];

// Every 30 minutes across both clock changes (plus a day either side).
const SWEEP: Date[] = [];
for (const start of [U(2026, 3, 6, 0), U(2026, 10, 30, 0)]) {
  for (let i = 0; i < 6 * 48; i++) SWEEP.push(new Date(start.getTime() + i * 30 * 60_000));
}

const ALL: Array<[string, Date]> = [...NAMED, ...SWEEP.map((d): [string, Date] => [d.toISOString(), d])];

describe("process sanity", () => {
  it("the oracle runs with local zone America/Toronto", () => {
    expect(new Date(2026, 6, 1).getTimezoneOffset()).toBe(240);
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(300);
  });
});

describe("formatDate / formatDateTime match Util", () => {
  for (const [name, d] of NAMED.filter(([n]) => n !== "invalid date")) {
    it(name, () => {
      expect(formatDate(d)).toBe(old.formatDate(d));
      expect(formatDateTime(d)).toBe(old.formatDateTime(d));
    });
  }
  it("sweep across both clock changes", () => {
    for (const d of SWEEP) {
      expect(formatDate(d)).toBe(old.formatDate(d));
      expect(formatDateTime(d)).toBe(old.formatDateTime(d));
    }
  });
  it("business-date examples", () => {
    expect(formatDate(U(2026, 7, 1, 3, 30))).toBe("2026-06-30");
    expect(formatDate(U(2026, 1, 1, 4, 59, 59))).toBe("2025-12-31");
    expect(formatDate(U(2026, 1, 1, 5, 0, 1))).toBe("2026-01-01");
    expect(formatDateTime(U(2026, 11, 1, 6, 30))).toBe("2026-11-01 01:30:00");
  });
  it("an invalid date throws, as Utilities.formatDate would", () => {
    expect(() => formatDate(new Date(NaN))).toThrow();
  });
});

describe("todayMidnight matches Util.todayMidnight", () => {
  for (const [name, d] of ALL.filter(([n]) => n !== "invalid date")) {
    it(name, () => {
      deps.nowMs = d.getTime();
      expect(norm(todayMidnight(d))).toEqual(norm(old.todayMidnight()));
    });
  }
  it("defaults to the real clock when no now is passed", () => {
    expect(Math.abs(todayMidnight().getTime() - Date.now())).toBeLessThan(25 * 3600_000);
  });
});

describe("endOfDay matches Util.endOfDay", () => {
  for (const [name, d] of ALL) {
    it(name, () => {
      expect(norm(endOfDay(d))).toEqual(norm(old.endOfDay(d)));
    });
  }
  it("does not mutate its argument", () => {
    const d = U(2026, 6, 15, 16);
    const t = d.getTime();
    endOfDay(d);
    expect(d.getTime()).toBe(t);
  });
  it("accepts a millisecond number like new Date(n)", () => {
    const n = U(2026, 6, 15, 16).getTime();
    expect(norm(endOfDay(n))).toEqual(norm(old.endOfDay(n)));
  });
});

describe("addDays matches Util.addDays", () => {
  const DAYS: number[] = [0, 1, -1, 7, -7, 30, 365, -365, 1.5, -1.5, 0.9, NaN, Infinity];
  for (const [name, d] of NAMED) {
    it(name, () => {
      for (const n of DAYS) expect(norm(addDays(d, n))).toEqual(norm(old.addDays(d, n)));
    });
  }
  it("sweep across both clock changes", () => {
    for (const d of SWEEP) for (const n of [1, -1, 7, -7]) {
      expect(norm(addDays(d, n))).toEqual(norm(old.addDays(d, n)));
    }
  });
  it("keeps the wall-clock time across a clock change", () => {
    // 2026-03-07 12:00 EST + 1 day = 2026-03-08 12:00 EDT, only 23 real hours later
    const r = addDays(U(2026, 3, 7, 17), 1);
    expect(r.toISOString()).toBe("2026-03-08T16:00:00.000Z");
  });
  it("a missing or null day count behaves like the old code", () => {
    const d = U(2026, 6, 15, 16);
    expect(norm(addDays(d, undefined as unknown as number))).toEqual(norm(old.addDays(d, undefined)));
    expect(norm(addDays(d, null as unknown as number))).toEqual(norm(old.addDays(d, null)));
  });
});

describe("getMondayOf matches Util.getMondayOf", () => {
  for (const [name, d] of ALL) {
    it(name, () => {
      expect(norm(getMondayOf(d))).toEqual(norm(old.getMondayOf(d)));
    });
  }
  it("Sunday belongs to the week that started the Monday before", () => {
    // Sunday 2026-06-14 -> Monday 2026-06-08 00:00 Toronto
    expect(getMondayOf(U(2026, 6, 14, 16)).toISOString()).toBe("2026-06-08T04:00:00.000Z");
  });
});

describe("getPreviousWeekRange matches Util.getPreviousWeekRange", () => {
  for (const [name, d] of ALL.filter(([n]) => n !== "invalid date")) {
    it(name, () => {
      deps.nowMs = d.getTime();
      expect(norm(getPreviousWeekRange(d))).toEqual(norm(old.getPreviousWeekRange(d)));
    });
  }
  it("invalid now gives invalid dates in both", () => {
    expect(norm(getPreviousWeekRange(new Date(NaN)))).toEqual(norm(old.getPreviousWeekRange(new Date(NaN))));
  });
  it("omitted or null now falls back to the real clock (old: now || new Date())", () => {
    const week = 7 * 86400_000;
    for (const r of [getPreviousWeekRange(), getPreviousWeekRange(null)]) {
      expect(Date.now() - r.start.getTime()).toBeGreaterThan(week - 1);
      expect(Date.now() - r.start.getTime()).toBeLessThan(2 * week);
    }
  });
  it("last week window is Monday 00:00 to Sunday 23:59:59.999 Toronto", () => {
    const r = getPreviousWeekRange(U(2026, 6, 17, 16)); // Wed 2026-06-17
    expect(r.start.toISOString()).toBe("2026-06-08T04:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-06-15T03:59:59.999Z");
  });
});

describe("diffHours matches Util.diffHours", () => {
  const vals: unknown[] = [null, undefined, new Date(NaN), ...NAMED.slice(0, 20).map(([, d]) => d)];
  it("every pair", () => {
    for (const a of vals) for (const b of vals) {
      expect(norm(diffHours(a as Date, b as Date))).toEqual(norm(old.diffHours(a, b)));
    }
  });
  it("end before start is 0, never negative", () => {
    expect(diffHours(U(2026, 6, 15, 18), U(2026, 6, 15, 16))).toBe(0);
  });
  it("missing end or start is 0", () => {
    expect(diffHours(null, U(2026, 6, 15))).toBe(0);
    expect(diffHours(U(2026, 6, 15), undefined)).toBe(0);
  });
  it("counts real elapsed hours across a clock change", () => {
    // midnight to midnight over the spring jump is 23 hours
    expect(diffHours(U(2026, 3, 8, 5), U(2026, 3, 9, 4))).toBe(23);
  });
});

describe("parseDate matches Util.parseDate", () => {
  const STRINGS: unknown[] = [
    "2026-06-15", "2026-03-08", "2026-11-01", "2026-12-31", "2026-01-01", "2028-02-29",
    "2026-02-29", "2026-02-30", "2026-04-31", "2026-02-31", "2026-02-32", "2026-00-10", "2026-01-00", "2026-13-01",
    "2026-03", "2026", "2026-3-5", "2026-1-01", "20260308", "abc", "",
    "2026-03-08T00:00:00", "2026-03-08 ", " 2026-03-08", "March 5 2026", "2026-03-08Z", "2026-03-08+01:00",
    "0001-01-01", "9999-12-31", "+002026-03-08", "2026/03/08", "12", "1e3", "Invalid",
    null, undefined, 0, NaN, false, 5, "0",
  ];
  for (const s of STRINGS) {
    it(`parseDate(${String(JSON.stringify(s) ?? s)})`, () => {
      expect(norm(parseDate(s as string))).toEqual(norm(old.parseDate(s)));
    });
  }
  it("a Date comes back as the same object", () => {
    const d = U(2026, 6, 15);
    expect(parseDate(d)).toBe(d);
  });
  it("blank is null, not a date", () => {
    expect(parseDate("")).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate(undefined)).toBeNull();
  });
  it("every day of 2026 and 2028 parses to Toronto midnight like the old code", () => {
    for (const y of [2026, 2028]) {
      for (let t = Date.UTC(y, 0, 1); t < Date.UTC(y + 1, 0, 1); t += 86400_000) {
        const s = new Date(t).toISOString().slice(0, 10);
        expect(norm(parseDate(s))).toEqual(norm(old.parseDate(s)));
      }
    }
  });
});
