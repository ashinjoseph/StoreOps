// The sales dashboard and its insights (src/Sales.gs getDashboard_ and the insight functions), with
// invented people. The insight functions are pure over plain rows, so they are tested without a
// database, one branch each; the dashboard itself runs against a real database.
//
// Ported from tests/suites/sales-insights.js (every assertion), the getDashboard assertions of
// tests/suites/sales-cards.js (every one) and tests/suites/perf.js (the read-count assertions become
// the query count below: the old code read the sheet once; this reads the sales table once for the
// range AND its previous window, and the staff names once: two queries). The cache assertions of
// perf.js (a second call is free; a write busts the cache) are about a per-execution Sheet cache that
// does not exist here, so they are not ported. tests/suites/wiring.js checks that the RPC forwards
// every field the page reads: the handler test at the bottom does the same.
//
// Expected values are what Sales.gs returns.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { parseDate } from "../src/lib/dates";
import * as sales from "../src/modules/sales";
import * as sd from "../src/modules/sales-dashboard";
import type { DashRow, Daily } from "../src/modules/sales-dashboard";
import { rpcGetSalesDashboard } from "../src/rpc/handlers/sales-dashboard";
import { handlers } from "../src/rpc/registry";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

// ── Plain rows (no database) ───────────────────────────────

function row(date: string | null, o: Partial<DashRow> = {}): DashRow {
  return {
    salesId: "x",
    sessionId: "x",
    staffId: "S_1",
    company: "cstore",
    date,
    cashSales: 0,
    creditCardSales: null,
    debitCardSales: null,
    cashbackPaid: 0,
    miscCashSales: 0,
    miscCreditSales: null,
    miscDebitSales: null,
    miscNotes: "",
    cardTotalSales: null,
    miscCardSales: null,
    cardSplit: false,
    ...o,
  };
}
const day = (date: string, total: number, cash = 0): Daily => ({ dateStr: date, dateMs: (parseDate(date) as Date).getTime(), cash, credit: 0, debit: 0, card: 0, misc: 0, total, sessionCount: 1, byCompany: {} });
/** Consecutive days from `start`, one row each. */
function days(start: string, n: number, total = 100): Daily[] {
  const out: Daily[] = [];
  const t0 = Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)));
  for (let i = 0; i < n; i++) out.push(day(new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), total));
  return out;
}

describe("pctChange", () => {
  it("is the change against the baseline, to one decimal, with the baseline's size as the divisor", () => {
    expect(sd.pctChange(110, 100)).toBe(10);
    expect(sd.pctChange(90, 100)).toBe(-10);
    expect(sd.pctChange(1, 3)).toBe(-66.7);
    expect(sd.pctChange(-50, -100)).toBe(50);
  });
  it("is null with no baseline (0), not infinity", () => {
    expect(sd.pctChange(50, 0)).toBeNull();
  });
});

describe("sumTotals", () => {
  it("adds cash and misc cash for the cash figure, every card column of both shapes for the total, and rounds once at the end", () => {
    const rows = [
      row("2026-09-01", { cashSales: 0.1, miscCashSales: 0.2, creditCardSales: null, cardTotalSales: 10 }),
      row("2026-09-01", { cashSales: 5, creditCardSales: 2, debitCardSales: 3, miscCreditSales: 1, cardSplit: true }),
    ];
    expect(sd.sumTotals(rows)).toEqual({ cash: 5.3, total: 21.3 });
  });
  it("is zero for no rows", () => {
    expect(sd.sumTotals([])).toEqual({ cash: 0, total: 0 });
  });
});

describe("rollingAverage", () => {
  it("is null until a full window exists, then the rounded trailing mean", () => {
    const d = [10, 20, 40, 5, 0.01].map((t, i) => day(`2026-09-0${i + 1}`, t));
    expect(sd.rollingAverage(d, 3)).toEqual([null, null, 23.33, 21.67, 15]);
  });
});

describe("trendInsight", () => {
  it("no days: no best or worst, a per-day figure of 0, and the reason for the missing average", () => {
    const t = sd.trendInsight([], { total: 0 }, [], 0);
    expect(t).toMatchObject({ total: 0, previousTotal: 0, changePct: null, changeAmount: 0, perTradingDay: 0, tradingDays: 0, best: null, worst: null, rolling7: null });
    expect(t.rollingInsufficient).toBe("Needs 7 days of sales for a rolling average — this range has 0.");
  });
  it("six days: no rolling average; seven: one, null for the first six", () => {
    expect(sd.trendInsight(days("2026-09-01", 6), { total: 600 }, [], 6)).toMatchObject({ rolling7: null, rollingInsufficient: "Needs 7 days of sales for a rolling average — this range has 6." });
    const t = sd.trendInsight(days("2026-09-01", 7), { total: 700 }, [], 7);
    expect(t.rolling7).toEqual([null, null, null, null, null, null, 100]);
    expect(t.rollingInsufficient).toBeUndefined();
  });
  it("names the best and worst days; on a tie the earlier day is the best and the later the worst", () => {
    const d = [day("2026-09-01", 50), day("2026-09-02", 80), day("2026-09-03", 80), day("2026-09-04", 50)];
    const t = sd.trendInsight(d, { total: 260 }, [], 4);
    expect(t.best).toEqual({ dateStr: "2026-09-02", total: 80 });
    expect(t.worst).toEqual({ dateStr: "2026-09-04", total: 50 });
  });
  it("compares with the previous window: a change and an amount; a baseline of 0 has no percentage", () => {
    const prev = [row("2026-08-01", { cashSales: 100 }), row("2026-08-02", { cashSales: 100 })];
    const t = sd.trendInsight(days("2026-09-01", 2, 150), { total: 300 }, prev, 2);
    expect(t).toMatchObject({ previousTotal: 200, changePct: 50, changeAmount: 100, perTradingDay: 150 });
    expect(sd.trendInsight(days("2026-09-01", 2, 150), { total: 300 }, [], 2)).toMatchObject({ previousTotal: 0, changePct: null, changeAmount: 300 });
  });
});

describe("dayOfWeekInsight", () => {
  it("one weekday is not a comparison", () => {
    const r = sd.dayOfWeekInsight([day("2026-06-01", 100), day("2026-06-08", 300)]); // two Mondays
    expect(r).toMatchObject({ insufficient: "Needs at least two different weekdays of sales." });
    expect(r.buckets[1]).toMatchObject({ name: "Monday", days: 2, total: 400, average: 200 });
  });
  it("averages per trading day, names the best and worst weekday, and the spread", () => {
    const d = [day("2026-06-01", 100), day("2026-06-08", 300), day("2026-06-02", 50)]; // Mon Mon Tue
    const r = sd.dayOfWeekInsight(d) as Extract<ReturnType<typeof sd.dayOfWeekInsight>, { best: unknown }>;
    expect(r.best).toEqual({ name: "Monday", average: 200 });
    expect(r.worst).toEqual({ name: "Tuesday", average: 50 });
    expect(r.spreadPct).toBe(300);
    expect(r.buckets.map((b) => b.short)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  });
  it("a day with no date is skipped", () => {
    expect(sd.dayOfWeekInsight([{ dateMs: 0, total: 5 }, day("2026-06-01", 100)])).toMatchObject({ insufficient: expect.any(String) });
  });
  it("the weekday is the Toronto one, the day's own midnight", () => {
    const r = sd.dayOfWeekInsight([day("2026-11-01", 10), day("2026-11-02", 20)]); // the clock change Sunday, then Monday
    expect(r.buckets[0]).toMatchObject({ name: "Sunday", days: 1 });
    expect(r.buckets[1]).toMatchObject({ name: "Monday", days: 1 });
  });
});

describe("timeOfMonthInsight", () => {
  it("under 28 trading days: the reason, with the counts (one day is singular)", () => {
    expect(sd.timeOfMonthInsight([day("2026-06-01", 5)])).toMatchObject({ insufficient: "Needs a full month of sales to compare parts of the month — this range covers 1 trading day across 1 of 3 parts." });
    const r = sd.timeOfMonthInsight(days("2026-06-01", 27));
    expect(r).toMatchObject({ insufficient: "Needs a full month of sales to compare parts of the month — this range covers 27 trading days across 3 of 3 parts." });
  });
  it("28 trading days over fewer than three parts: also insufficient (days 1-20 of three months)", () => {
    const d = [...days("2026-01-01", 20), ...days("2026-02-01", 20), ...days("2026-03-01", 20)];
    expect(sd.timeOfMonthInsight(d)).toMatchObject({ insufficient: "Needs a full month of sales to compare parts of the month — this range covers 60 trading days across 2 of 3 parts." });
  });
  it("day 10 is early, day 11 mid, day 20 mid, day 21 late", () => {
    const d = days("2026-06-01", 30, 100);
    const r = sd.timeOfMonthInsight(d) as Extract<ReturnType<typeof sd.timeOfMonthInsight>, { strongest: unknown }>;
    expect(r.buckets.map((b) => b.days)).toEqual([10, 10, 10]);
    const one = [...d];
    one[9] = day("2026-06-10", 1000);
    const r2 = sd.timeOfMonthInsight(one) as Extract<ReturnType<typeof sd.timeOfMonthInsight>, { strongest: unknown }>;
    expect(r2.strongest.label).toBe("Days 1-10");
    const two = [...d];
    two[10] = day("2026-06-11", 1000);
    expect((sd.timeOfMonthInsight(two) as typeof r2).strongest.label).toBe("Days 11-20");
    const three = [...d];
    three[20] = day("2026-06-21", 1000);
    expect((sd.timeOfMonthInsight(three) as typeof r2).strongest.label).toBe("Days 21-end");
  });
  it("the full block: per-part averages, the overall average, each part against it, strongest and weakest", () => {
    const d = days("2026-06-01", 30, 100).map((x, i) => (i < 10 ? { ...x, total: 140 } : i >= 20 ? { ...x, total: 80 } : x));
    expect(sd.timeOfMonthInsight(d)).toEqual({
      buckets: [
        { key: "early", label: "Days 1-10", total: 1400, days: 10, average: 140, vsOverallPct: 31.2 },
        { key: "mid", label: "Days 11-20", total: 1000, days: 10, average: 100, vsOverallPct: -6.3 },
        { key: "late", label: "Days 21-end", total: 800, days: 10, average: 80, vsOverallPct: -25 },
      ],
      overallAverage: 106.67,
      strongest: { label: "Days 1-10", average: 140 },
      weakest: { label: "Days 21-end", average: 80 },
    });
  });
});

describe("tenderMixInsight", () => {
  it("no takings: no share (null, not 0), and no change in points", () => {
    expect(sd.tenderMixInsight([], { cash: 0, total: 0 }, [])).toEqual({ cash: 0, total: 0, cashSharePct: null, previousCashSharePct: null, changePoints: null, series: [] });
  });
  it("a share, the previous share, and the change in percentage POINTS", () => {
    const prev = [row("2026-08-01", { cashSales: 50, cardTotalSales: 50 })];
    const r = sd.tenderMixInsight([day("2026-09-01", 100, 60), day("2026-09-02", 0, 0)], { cash: 60, total: 100 }, prev);
    expect(r).toMatchObject({ cashSharePct: 60, previousCashSharePct: 50, changePoints: 10 });
    expect(r.series).toEqual([
      { dateStr: "2026-09-01", sharePct: 60 },
      { dateStr: "2026-09-02", sharePct: null },
    ]);
  });
  it("a previous window with no takings has no change in points", () => {
    expect(sd.tenderMixInsight([], { cash: 10, total: 40 }, [])).toMatchObject({ cashSharePct: 25, previousCashSharePct: null, changePoints: null });
  });
});

describe("buildDaily", () => {
  it("one entry per day, oldest first, sums by tender, a bucket per company, total rounded from the unrounded sums", () => {
    const rows = [
      row("2026-09-02", { company: "vape", cashSales: 10, creditCardSales: 5, debitCardSales: 5, cardSplit: true, miscCreditSales: 1, miscDebitSales: 2 }),
      row("2026-09-01", { company: "cstore", cashSales: 0.1, cardTotalSales: 0.2, miscCashSales: 0.3, miscCardSales: 0.4 }),
      row("2026-09-02", { company: "cstore", cashSales: 20, cardTotalSales: 30 }),
    ];
    const d = sd.buildDaily(rows);
    expect(d.map((x) => x.dateStr)).toEqual(["2026-09-01", "2026-09-02"]);
    expect(d[0]).toMatchObject({ cash: 0.1, credit: 0, debit: 0, card: 0.2, misc: 0.7, total: 1, sessionCount: 1, byCompany: { cstore: 1 } });
    expect(d[1]).toMatchObject({ cash: 30, credit: 5, debit: 5, card: 30, misc: 3, total: 73, sessionCount: 2, byCompany: { vape: 23, cstore: 50 } });
    expect(d[0]?.dateMs).toBe((parseDate("2026-09-01") as Date).getTime());
  });
  it("a blank company gets the 'unassigned' bucket, so the segments still add up to the bar", () => {
    const d = sd.buildDaily([row("2026-09-01", { company: "", cashSales: 50, cardTotalSales: 50 }), row("2026-09-01", { cashSales: 100, cardTotalSales: 100 })]);
    expect(d[0]?.byCompany).toEqual({ unassigned: 100, cstore: 200 });
    expect(d[0]?.total).toBe(300);
  });
  it("a row with no date gets the '—' day and no time", () => {
    const d = sd.buildDaily([row(null, { cashSales: 5 })]);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ dateStr: "—", dateMs: 0, total: 5 });
  });
});

describe("companySlice", () => {
  it("divides by the days the RANGE traded, reports its own, and its share of the whole", () => {
    const rows = [row("2026-09-01", { company: "vape", cashSales: 100 }), row("2026-09-02", { company: "vape", cashSales: 50 })];
    const s = sd.companySlice(rows, 600, 4);
    expect(s).toMatchObject({ total: 150, tradingDays: 2, perTradingDay: 37.5, sharePct: 25, sessionCount: 2 });
    expect(s.daily).toHaveLength(2);
    expect(s.dayOfWeek).toMatchObject({ buckets: expect.any(Array) });
  });
  it("a range that traded no days falls back to its own; a grand total of 0 is a share of 0", () => {
    const s = sd.companySlice([row("2026-09-01", { cashSales: 90 })], 0, 0);
    expect(s).toMatchObject({ perTradingDay: 90, sharePct: 0 });
  });
});

describe("previousWindow", () => {
  const w = (a: string, b: string) => {
    const p = sd.previousWindow(parseDate(a) as Date, parseDate(b) as Date);
    return [p.prevStart.getTime(), p.prevEnd.getTime()].map((t) => new Date(t).toISOString());
  };
  it("is the same number of whole days just before the range", () => {
    // Toronto is UTC-5 in November (05:00Z is midnight), UTC-4 before the 1st.
    expect(w("2026-11-09", "2026-11-15")).toEqual(["2026-11-02T05:00:00.000Z", "2026-11-09T04:59:59.999Z"]);
  });
  it("a range holding a clock change is still whole days", () => {
    expect(w("2026-10-28", "2026-11-04")).toEqual(["2026-10-20T04:00:00.000Z", "2026-10-28T03:59:59.999Z"]);
  });
  it("an end with a time of day is the same day as its midnight", () => {
    const p = sd.previousWindow(parseDate("2026-11-09") as Date, new Date((parseDate("2026-11-15") as Date).getTime() + 86_399_000));
    expect(p.prevStart.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
  it("an end before the start counts as one day", () => {
    expect(w("2026-11-15", "2026-11-10")).toEqual(["2026-11-14T05:00:00.000Z", "2026-11-15T04:59:59.999Z"]);
  });
});

describe("buildInsights", () => {
  it("assembles the four insights and names the previous period with the rows found in it", () => {
    const prev = [row("2026-11-03", { cashSales: 10 })];
    const daily = days("2026-11-09", 7, 100);
    const totals = { cash: 700, credit: 0, debit: 0, card: 0, cardAll: 0, misc: 0, total: 700, cashback: 0, sessionCount: 7, splitRows: 0, totalRows: 7 };
    const r = sd.buildInsights(daily, totals, parseDate("2026-11-09") as Date, parseDate("2026-11-15") as Date, prev);
    expect(Object.keys(r).sort()).toEqual(["dayOfWeek", "previousPeriod", "tenderMix", "timeOfMonth", "trend"]);
    expect(r.previousPeriod).toEqual({ startStr: "2026-11-02", endStr: "2026-11-08", sessionCount: 1 });
    expect(r.trend.previousTotal).toBe(10);
  });
});

// ── The dashboard, over a database ─────────────────────────

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  owner = await connect(testDb.ownerUrl);
});
afterAll(async () => {
  await db?.close();
  await owner?.close();
  await testDb?.drop();
});

beforeEach(async () => {
  for (const t of ["audit_log", "sales", "till_sessions", "attendance", "staff"]) await owner.query(`delete from ops.${t}`);
  await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized) values ('S_1', 'Ash Fernly', 17, true, 'employee', 'cstore,vape'), ('S_2', 'Bea Lund', 18, true, 'employee', 'vape'), ('S_3', '', 18, true, 'employee', 'vape')");
  n = 0;
});

let n = 0;
interface Put {
  cash?: number;
  credit?: number | null;
  debit?: number | null;
  card?: number | null;
  miscCash?: number;
  miscCredit?: number | null;
  miscDebit?: number | null;
  miscCard?: number | null;
  cashback?: number;
  notes?: string;
  staff?: string;
  id?: string;
}
/** One sales row (with its session and attendance). A card figure left out is blank, not zero. */
async function put(date: string, company: string, o: Put = {}): Promise<string> {
  const id = o.id ?? `${company === "vape" ? "VAP" : "CST"}-${date.replace(/-/g, "")}-${++n}`;
  const staff = o.staff ?? "S_1";
  const att = `A_${date.replace(/-/g, "")}_${staff}`;
  await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ($1, $2, $3, 'worked') on conflict do nothing", [att, staff, date]);
  await owner.query("insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status) values ($1, $2, $3, $4, $5, 'closed')", [id, att, staff, company, date]);
  await owner.query(
    `insert into ops.sales (sales_id, session_id, staff_id, company, date, cash_sales, credit_card_sales, debit_card_sales, cashback_paid, misc_cash_sales, misc_credit_sales, misc_debit_sales, misc_notes, card_total_sales, misc_card_sales)
     values ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [id, staff, company, date, o.cash ?? 0, o.credit ?? null, o.debit ?? null, o.cashback ?? 0, o.miscCash ?? 0, o.miscCredit ?? null, o.miscDebit ?? null, o.notes ?? null, o.card ?? null, o.miscCard ?? null],
  );
  return id;
}
const midnight = (d: string): Date => parseDate(d) as Date;
const endOf = (d: string): Date => new Date(midnight(d).getTime() + 86_399_000);
const dash = (a: string, b: string, company?: string | null, extra: Record<string, unknown> = {}) =>
  sd.getDashboard(db, { startDate: midnight(a), endDate: endOf(b), company: company ?? null, pageSize: 500, ...extra });
const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** The June and July 2026 range of sales-insights.js: weekday 400, weekend 800, days 1-10 lifted by 40%. */
async function seed(company = "cstore"): Promise<void> {
  for (let m = 5; m <= 6; m++) {
    const last = new Date(Date.UTC(2026, m + 1, 0)).getUTCDate();
    for (let d = 1; d <= last; d++) {
      const t = Date.UTC(2026, m, d);
      const dow = new Date(t).getUTCDay();
      let amount = dow === 0 || dow === 6 ? 800 : 400;
      if (d <= 10) amount = Math.round(amount * 1.4);
      await put(iso(t), company, { cash: Math.round(amount * 0.6 * 100) / 100, credit: Math.round(amount * 0.4 * 100) / 100, debit: 0 });
    }
  }
}

describe("sales-insights.js: shape is recovered from the data", () => {
  it("61 trading days, one session a day, the per-day figure is total / days", async () => {
    await seed();
    const d = await dash("2026-06-01", "2026-07-31");
    expect(d.daily).toHaveLength(61);
    expect(d.totals.sessionCount).toBe(61);
    expect(Math.abs(d.insights.trend.perTradingDay - d.totals.total / 61)).toBeLessThan(0.02);
    expect(d.insights.dayOfWeek).not.toHaveProperty("insufficient");
  });
  it("weekday averages are per trading day: weekend wins, a weekday loses, Saturday's average is its total over its days", async () => {
    await seed();
    const dw = (await dash("2026-06-01", "2026-07-31")).insights.dayOfWeek as Extract<sd.DayOfWeekBlock, { best: unknown }>;
    expect(["Saturday", "Sunday"]).toContain(dw.best.name);
    expect(["Saturday", "Sunday"]).not.toContain(dw.worst.name);
    const sat = dw.buckets.find((b) => b.name === "Saturday") as sd.DayOfWeekBlock["buckets"][number];
    expect(Math.abs(sat.average - sat.total / sat.days)).toBeLessThan(0.011);
    expect(dw.buckets.every((b) => !b.days || Math.abs(b.average - b.total / b.days) < 0.011)).toBe(true);
  });
  it("the part-of-month boundary is exactly day 10: the lifted bucket wins by a margin, early and mid cover 20 days each", async () => {
    await seed();
    const tm = (await dash("2026-06-01", "2026-07-31")).insights.timeOfMonth as Extract<sd.TimeOfMonthBlock, { strongest: unknown }>;
    expect(tm).not.toHaveProperty("insufficient");
    expect(tm.strongest.label).toBe("Days 1-10");
    expect(tm.strongest.average).toBeGreaterThan(tm.weakest.average * 1.2);
    const early = tm.buckets.find((b) => b.key === "early") as sd.TimeOfMonthBlock["buckets"][number];
    const mid = tm.buckets.find((b) => b.key === "mid") as sd.TimeOfMonthBlock["buckets"][number];
    expect(early.days).toBe(20);
    expect(mid.days).toBe(20);
    expect(early.average).toBeGreaterThan(mid.average);
  });
  it("short ranges are suppressed, with a reason that mentions the month; one weekday is not a weekday comparison", async () => {
    await put("2026-06-01", "cstore", { cash: 100, credit: 100, debit: 0 });
    await put("2026-06-02", "cstore", { cash: 100, credit: 100, debit: 0 });
    const d = await dash("2026-06-01", "2026-06-02");
    expect(d.insights.timeOfMonth).toHaveProperty("insufficient");
    expect((d.insights.timeOfMonth as { insufficient: string }).insufficient).toMatch(/month/i);
    const one = await dash("2026-06-01", "2026-06-01");
    expect(one.insights.dayOfWeek).toHaveProperty("insufficient");
  });
  it("the trend compares against the preceding window", async () => {
    await seed();
    const tr = (await dash("2026-07-01", "2026-07-31")).insights.trend;
    expect(tr.tradingDays).toBe(31);
    expect(tr.previousTotal).toBeGreaterThan(0);
    expect(Math.abs(tr.changeAmount - (tr.total - tr.previousTotal))).toBeLessThan(0.011);
    expect(tr.best).not.toBeNull();
    expect((tr.best as { total: number }).total).toBeGreaterThanOrEqual((tr.worst as { total: number }).total);
  });
  it("the per-company split appears only when unfiltered, and its totals sum to the headline", async () => {
    await seed("cstore");
    await put("2026-06-15", "vape", { cash: 60, credit: 40, debit: 0 });
    let d = await dash("2026-06-01", "2026-07-31");
    const bc = d.insights.byCompany as Record<string, sd.CompanySlice>;
    expect(Object.keys(bc).sort()).toEqual(["cstore", "vape"]);
    expect(Math.abs(bc["cstore"]!.total + bc["vape"]!.total - d.totals.total)).toBeLessThan(0.02);
    d = await dash("2026-06-01", "2026-07-31", "cstore");
    expect(d.insights.byCompany).toBeUndefined();
  });
  it("a blank company still counts toward the day (the database allows only two companies, so this is the pure buildDaily test above)", async () => {
    await put("2026-06-01", "cstore", { cash: 100, credit: 100, debit: 0 });
    const d = await dash("2026-06-01", "2026-06-01");
    expect(d.daily[0]?.total).toBe(200);
  });
});

describe("sales-cards.js: two card shapes, one continuous total", () => {
  it("a single-total row keeps credit and debit blank", async () => {
    await put("2026-09-01", "cstore", { cash: 600, card: 1240 });
    const d = await dash("2026-09-01", "2026-09-01");
    expect(d.totals).toMatchObject({ total: 1840, card: 1240, credit: 0, cardAll: 1240 });
    expect(d.rows[0]).toMatchObject({ credit: null, debit: null, card: 1240 });
  });
  it("a split row is untouched: history keeps its shape (debit 0, not null, and no single-total figure)", async () => {
    await put("2026-09-01", "cstore", { cash: 600, credit: 1240, debit: 0 });
    const d = await dash("2026-09-01", "2026-09-01");
    expect(d.totals).toMatchObject({ total: 1840, credit: 1240, card: 0, cardAll: 1240 });
    expect(d.rows[0]).toMatchObject({ debit: 0, card: null });
  });
  it("a range spanning the migration sums once, not twice; the daily chart cannot dip at the boundary", async () => {
    await put("2026-09-01", "cstore", { cash: 600, credit: 1000, debit: 0 });
    await put("2026-09-02", "cstore", { cash: 700, card: 1100 });
    const d = await dash("2026-09-01", "2026-09-02");
    expect(d.totals).toMatchObject({ total: 3400, cash: 1300, credit: 1000, card: 1100, cardAll: 2100, splitRows: 1, totalRows: 1 });
    expect(d.daily).toHaveLength(2);
    expect(d.daily.map((x) => x.total)).toEqual([1600, 1800]);
    expect(d.daily.every((x) => x.total > 0)).toBe(true);
  });
  it("the same money totals the same whichever shape recorded it", async () => {
    await put("2026-09-01", "cstore", { cash: 600, credit: 1240, debit: 0 });
    const asSplit = (await dash("2026-09-01", "2026-09-01")).totals.total;
    await owner.query("delete from ops.sales");
    await put("2026-09-01", "cstore", { cash: 600, card: 1240 });
    const asTotal = (await dash("2026-09-01", "2026-09-01")).totals.total;
    expect(asSplit).toBe(asTotal);
    expect(asTotal).toBe(1840);
  });
  it("mixed shapes still add up per company, and filtering to one company keeps the arithmetic", async () => {
    await put("2026-09-01", "vape", { cash: 100, credit: 150, debit: 50 });
    await put("2026-09-01", "cstore", { cash: 600, card: 1240 });
    let d = await dash("2026-09-01", "2026-09-01");
    expect(d.daily[0]?.total).toBe(2140);
    expect(d.daily[0]?.byCompany).toEqual({ cstore: 1840, vape: 300 });
    d = await dash("2026-09-01", "2026-09-01", "cstore");
    expect(d.totals.total).toBe(1840);
    expect(d.totals.credit).toBe(0);
  });
  it("misc sales of every shape are in the total, the row's misc figure and the cash share", async () => {
    await put("2026-09-01", "vape", { cash: 10, credit: 20, debit: 30, miscCash: 1, miscCredit: 2, miscDebit: 3, notes: "coils" });
    await put("2026-09-01", "cstore", { cash: 10, card: 20, miscCash: 1, miscCard: 5 });
    const d = await dash("2026-09-01", "2026-09-01");
    expect(d.totals).toMatchObject({ cash: 20, credit: 20, debit: 30, card: 20, cardAll: 70, misc: 12, total: 102 });
    expect(d.rows.map((r) => [r.company, r.misc, r.total])).toEqual([
      ["vape", 6, 66],
      ["cstore", 6, 36],
    ]);
    expect(d.rows[0]?.miscNotes).toBe("coils");
    // The current cash figure is the totals' (cash sales only, misc cash is in `misc`); the previous window's adds misc cash (sumTotals). Kept as the old code has it.
    expect(d.insights.tenderMix).toMatchObject({ cash: 20, total: 102 });
  });
});

describe("the rows, the page and the filters", () => {
  it("rows are newest day first, a day's rows in the order they were written, with the person's name (the id when the name is blank)", async () => {
    await put("2026-09-01", "vape", { cash: 1, id: "VAP-B", staff: "S_2" });
    await put("2026-09-02", "cstore", { cash: 2, id: "CST-A", staff: "S_3" });
    await put("2026-09-01", "cstore", { cash: 3, id: "CST-B" });
    const d = await dash("2026-09-01", "2026-09-02");
    expect(d.rows.map((r) => [r.salesId, r.staffName])).toEqual([
      ["CST-A", "S_3"],
      ["VAP-B", "Bea Lund"],
      ["CST-B", "Ash Fernly"],
    ]);
    expect(d.companies).toEqual(["cstore", "vape"]);
  });
  it("pages, as the old slice did; the counts cover the whole range", async () => {
    for (let i = 1; i <= 5; i++) await put(`2026-09-0${i}`, "cstore", { cash: i });
    const d = await dash("2026-09-01", "2026-09-05", null, { page: 2, pageSize: 2 });
    expect(d.rows.map((r) => r.cash)).toEqual([3, 2]);
    expect(d).toMatchObject({ totalCount: 5, page: 2, pageSize: 2, pageCount: 3 });
    expect(d.totals.sessionCount).toBe(5);
    const dflt = await sd.getDashboard(db, { startDate: midnight("2026-09-01"), endDate: midnight("2026-09-05") });
    expect(dflt).toMatchObject({ page: 1, pageSize: 50, pageCount: 1 });
  });
  it("one person's rows; an unknown person's none", async () => {
    await put("2026-09-01", "vape", { cash: 1, staff: "S_2" });
    await put("2026-09-01", "cstore", { cash: 2, staff: "S_1" });
    expect((await dash("2026-09-01", "2026-09-01", null, { staffId: "S_2" })).rows.map((r) => r.staffId)).toEqual(["S_2"]);
    const none = await dash("2026-09-01", "2026-09-01", null, { staffId: "S_9" });
    expect(none).toMatchObject({ totalCount: 0, daily: [], companies: [], pageCount: 1 });
    expect(none.insights.byCompany).toBeUndefined();
  });
  it("a filter that is not text matches nothing, as the old strict comparison did, and asks the database nothing about sales", async () => {
    await put("2026-09-01", "cstore", { cash: 2 });
    expect((await dash("2026-09-01", "2026-09-01", null, { staffId: 1 })).totalCount).toBe(0);
    expect((await sd.getDashboard(db, { startDate: midnight("2026-09-01"), endDate: midnight("2026-09-01"), company: 5 })).totalCount).toBe(0);
  });
  it("a bound with a time of day: the start's own day counts only if its midnight is not before it", async () => {
    await put("2026-09-01", "cstore", { cash: 1 });
    await put("2026-09-02", "cstore", { cash: 2 });
    const at = (iso_: string) => new Date(iso_);
    // 2026-09-01 10:00 Toronto (UTC-4): the 1st's midnight is before it, so the 1st is out.
    const d = await sd.getDashboard(db, { startDate: at("2026-09-01T14:00:00Z"), endDate: at("2026-09-02T14:00:00Z") });
    expect(d.rows.map((r) => r.date)).toEqual(["2026-09-02"]);
    const e = await sd.getDashboard(db, { startDate: "2026-09-01", endDate: "2026-09-02" });
    expect(e.rows).toHaveLength(2);
  });
  it("a start after the end has no rows but still reads the day before the start as its baseline", async () => {
    await put("2026-09-04", "cstore", { cash: 40 });
    await put("2026-09-05", "cstore", { cash: 50 });
    const d = await dash("2026-09-06", "2026-09-01");
    expect(d.rows).toEqual([]);
    expect(d.insights.previousPeriod).toEqual({ startStr: "2026-09-05", endStr: "2026-09-05", sessionCount: 1 });
    expect(d.insights.trend.previousTotal).toBe(50);
    expect(d.insights.trend.changePct).toBe(-100);
  });
  it("blank is not zero: a single-total row's credit and debit are null in the row and 0 in the sums; a row with no card at all shows card 0", async () => {
    await put("2026-09-01", "cstore", { cash: 5, card: 10 });
    await put("2026-09-02", "vape", { cash: 5 });
    const d = await dash("2026-09-01", "2026-09-02");
    const byDate = Object.fromEntries(d.rows.map((r) => [r.date, r]));
    expect(byDate["2026-09-01"]).toMatchObject({ credit: null, debit: null, card: 10 });
    expect(byDate["2026-09-02"]).toMatchObject({ credit: null, debit: null, card: 0 });
    expect(d.totals).toMatchObject({ credit: 0, debit: 0, card: 10, splitRows: 0, totalRows: 2 });
  });
});

describe("reading the rows", () => {
  it("gives the same records as sales.getForDateRange (the mapping is repeated, so it is checked)", async () => {
    await put("2026-09-01", "cstore", { cash: 5, card: 10, miscCash: 1, miscCard: 2, notes: "n", cashback: 3 });
    await put("2026-09-01", "vape", { cash: 6, credit: 1, debit: 0, miscCredit: 4, miscDebit: 0 });
    await put("2026-09-02", "vape", { cash: 7 });
    const mine = await sd.readRows(db, "2026-09-01", "2026-09-02", {});
    const theirs = await sales.getForDateRange(db, midnight("2026-09-01"), midnight("2026-09-02"), null);
    const key = (r: sales.SalesRecord) => r.salesId;
    expect([...mine].sort((a, b) => (key(a) < key(b) ? -1 : 1))).toEqual([...theirs].sort((a, b) => (key(a) < key(b) ? -1 : 1)));
    expect(mine).toHaveLength(3);
  });
  it("within a day: the order the rows were written in (the order of the closes), whatever the till, the shift's start or the id", async () => {
    await put("2026-09-01", "cstore", { cash: 1, id: "CST-B" });
    await put("2026-09-01", "vape", { cash: 3, id: "VAP-A" });
    await put("2026-09-01", "cstore", { cash: 4, id: "CST-C" });
    await put("2026-09-01", "cstore", { cash: 2, id: "CST-A" });
    // The shift that closed last started first: start times do not decide the order.
    await owner.query("update ops.till_sessions set start_time = '2026-09-01T07:00:00Z' where session_id = 'CST-A'");
    await owner.query("update ops.till_sessions set start_time = '2026-09-01T12:00:00Z' where session_id = 'CST-B'");
    const rows = await sd.readRows(db, "2026-09-01", "2026-09-01", {});
    expect(rows.map((r) => r.salesId)).toEqual(["CST-B", "VAP-A", "CST-C", "CST-A"]);
    const d = await dash("2026-09-01", "2026-09-01");
    expect(d.rows.map((r) => r.salesId)).toEqual(["CST-B", "VAP-A", "CST-C", "CST-A"]);
  });
  it("the days run oldest first in the answer's series and newest first in its rows", async () => {
    await put("2026-09-03", "cstore", { cash: 3 });
    await put("2026-09-01", "cstore", { cash: 1 });
    await put("2026-09-02", "cstore", { cash: 2 });
    const d = await dash("2026-09-01", "2026-09-03");
    expect(d.daily.map((x) => x.dateStr)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
    expect(d.rows.map((r) => r.date)).toEqual(["2026-09-03", "2026-09-02", "2026-09-01"]);
  });
});

describe("refusals", () => {
  it("both dates are required", async () => {
    await expect(sd.getDashboard(db, {})).rejects.toThrow("startDate and endDate required");
    await expect(sd.getDashboard(db, { startDate: "2026-09-01" })).rejects.toThrow("startDate and endDate required");
    await expect(sd.getDashboard(db, { endDate: "2026-09-01" })).rejects.toThrow("startDate and endDate required");
    await expect(sd.getDashboard(db, { startDate: "", endDate: "2026-09-01" })).rejects.toThrow("startDate and endDate required");
  });
  it("an unreadable date is refused with a plain message (the old code failed deep inside with an engine message)", async () => {
    await expect(sd.getDashboard(db, { startDate: "yesterday", endDate: "2026-09-01" })).rejects.toThrow(new Error("startDate is not a readable date"));
    await expect(sd.getDashboard(db, { startDate: "2026-09-01", endDate: "2026-09-01T10:00" })).rejects.toThrow(new Error("endDate is not a readable date"));
    await expect(sd.getDashboard(db, { startDate: new Date(NaN), endDate: "2026-09-01" })).rejects.toThrow(new Error("startDate is not a readable date"));
  });
});

// ── The cost of one call ───────────────────────────────────

describe("perf.js: the number of queries", () => {
  function counting(inner: Db): { db: Db; texts: string[] } {
    const texts: string[] = [];
    const wrapped: Db = {
      query: (t, p) => (texts.push(t), inner.query(t, p)),
      one: (t, p) => (texts.push(t), inner.one(t, p)),
      maybeOne: (t, p) => (texts.push(t), inner.maybeOne(t, p)),
    };
    return { db: wrapped, texts };
  }
  const input = (extra: Record<string, unknown> = {}) => ({ startDate: midnight("2026-06-01"), endDate: endOf("2026-07-31"), pageSize: 50, ...extra });

  it("one dashboard call costs exactly two queries: the sales rows (range and baseline together) and the staff names", async () => {
    await seed();
    const c = counting(db);
    const d = await sd.getDashboard(c.db, input());
    expect(c.texts).toHaveLength(2);
    expect(c.texts[0]).toMatch(/from ops\.sales/);
    expect(c.texts[1]).toMatch(/from ops\.staff/);
    expect(d.totals.total).toBeGreaterThan(0);
    expect(d.insights.trend).toBeDefined();
  });
  it("the per-company split, a filter and a long range add no query", async () => {
    await seed();
    await put("2026-06-15", "vape", { cash: 1, credit: 1, debit: 0 });
    for (const extra of [{}, { company: "cstore" }, { staffId: "S_1" }, { startDate: midnight("2020-01-01") }]) {
      const c = counting(db);
      await sd.getDashboard(c.db, input(extra));
      expect(c.texts).toHaveLength(2);
    }
  });
  it("cost does not grow with the range: still two queries at 1200 rows", async () => {
    for (let i = 0; i < 1200; i++) {
      const t = Date.UTC(2026, 0, 1) + (i % 300) * 86_400_000;
      await put(iso(t), i % 2 ? "vape" : "cstore", { cash: 10, credit: 5, debit: 5 });
    }
    const c = counting(db);
    const d = await sd.getDashboard(c.db, { startDate: midnight("2026-01-01"), endDate: midnight("2026-12-31"), pageSize: 50 });
    expect(c.texts).toHaveLength(2);
    expect(d.totalCount).toBe(1200);
  });
  it("the SQL takes values only as parameters", async () => {
    await seed();
    const c = counting(db);
    await sd.getDashboard(c.db, input({ staffId: "S_1'; drop table ops.sales; --", company: "cstore" }));
    expect(c.texts.join(" ")).not.toMatch(/drop table/);
    expect((await owner.one<{ n: number }>("select count(*)::int as n from ops.sales")).n).toBeGreaterThan(0);
  });
});

// ── The RPC ────────────────────────────────────────────────

describe("rpcGetSalesDashboard", () => {
  // config() rejects: the dashboard reads no setting, and the page's call must not cost a config query.
  const call = (f: unknown) =>
    withTransaction(db, async (tx) => {
      const ctx: RpcContext = { db: tx, session: { staffId: "S_1" } as never, config: () => Promise.reject(new Error("no config")), env: {}, fetch: globalThis.fetch, now: new Date("2026-09-10T15:00:00Z") };
      return rpcGetSalesDashboard(ctx, f);
    });
  it("is registered, and not wrapped with its own name (the old one had no try/catch)", async () => {
    expect(handlers["rpcGetSalesDashboard"]).toBe(rpcGetSalesDashboard);
    const { ERROR_PREFIXED } = await import("../src/rpc/registry");
    expect(ERROR_PREFIXED.has("rpcGetSalesDashboard")).toBe(false);
  });
  it("forwards every field the page reads, with rowCount for totalCount and no total insights lost (wiring.js)", async () => {
    await put("2026-09-01", "cstore", { cash: 5, card: 5 });
    await put("2026-09-01", "vape", { cash: 5, credit: 5, debit: 0 });
    const r = (await call({ startDate: "2026-09-01", endDate: "2026-09-02", page: "1", pageSize: "10" })) as Record<string, any>;
    expect(Object.keys(r).sort()).toEqual(["companies", "daily", "insights", "page", "pageCount", "pageSize", "rowCount", "rows", "totals"]);
    expect(r["rowCount"]).toBe(2);
    expect(r["insights"].byCompany).toBeDefined();
    expect(r["pageSize"]).toBe(10);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
  it("no filters, a null or an empty object: startDate and endDate required; unreadable dates are refused plainly", async () => {
    for (const f of [undefined, null, {}, 0, "x"]) await expect(call(f)).rejects.toThrow("startDate and endDate required");
    await expect(call({ startDate: "soon", endDate: "2026-09-02" })).rejects.toThrow("startDate is not a readable date");
    await expect(call({ startDate: 12345, endDate: "2026-09-02" })).rejects.toThrow("startDate is not a readable date");
  });
  it("a blank staffId or company is no filter; paging that is not a number reads as the defaults", async () => {
    await put("2026-09-01", "cstore", { cash: 5, card: 5 });
    const r = (await call({ startDate: "2026-09-01", endDate: "2026-09-01", staffId: "", company: "", page: "abc", pageSize: 0 })) as Record<string, any>;
    expect(r["rowCount"]).toBe(1);
    expect(r["page"]).toBe(1);
    expect(r["pageSize"]).toBe(50);
  });
});
