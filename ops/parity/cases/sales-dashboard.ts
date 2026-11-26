// Parity cases for the sales dashboard (card P3-11): rpcGetSalesDashboard.
//
// The fixture (frozen at Friday 20 November 2026, cases start at 10:30 that day):
//   - sales rows for every day from 2026-07-23 to 2026-11-19 (120 days, 3 a day): two cstore
//     shifts and one vape shift. Vape is always the credit + debit shape; cstore is credit + debit
//     until 2026-10-29 and the single card total from 2026-10-30 (the ePOS change), so any range
//     from the 30th of October on mixes both shapes.
//   - nothing for today (CST-20261120-S_003 is open: its sales row exists only after the close).
//   - S_003, S_004, S_005 work the shifts; S_001, S_002, S_006 (admin, manager, payroll admin) and
//     S_007 (inactive) have no sales.
//
// The old RPC never reads the clock: the page picks its range (the default is today and the 59
// days before it, pageSize 1000) and "today" is the page's. So the clock only matters for a case
// that writes (the closes below); the cases with `at` show that moving it changes nothing, and
// that is why every insight branch is reached through the range, not the date. Branches and the
// case that reaches each:
//
//   trend            no rows (rows empty: best/worst null) ........ NO_SALES, BEFORE_DATA
//                    fewer than 7 days (rollingInsufficient) ....... ONE_DAY, WEEK_NO (3 days)
//                    7 or more days (rolling7) ..................... WEEK, MONTH
//                    no baseline (changePct null) .................. BEFORE_DATA, HISTORY_START (baseline mostly empty)
//                    a baseline and no current rows ................. TODAY_ONLY
//   dayOfWeek        one weekday only (insufficient) ................ ONE_DAY, TODAY_ONLY (none)
//                    two or more weekdays ........................... WEEK, MONTH
//   timeOfMonth      under 28 trading days (insufficient) ........... WEEK, WEEK_NO
//                    28+ days over 3 parts (the full block) ......... DEFAULT_60, FULL_HISTORY
//                    28+ days over fewer than 3 parts ............... not reachable: any 28 consecutive days
//                    touch all three parts. Unit test (ops/test/sales-dashboard.test.ts).
//   tenderMix        no takings (share null) ........................ NO_SALES, TODAY_ONLY
//                    shares and changePoints ........................ every range with a baseline
//   byCompany        two companies, no company filter ............... NO_FILTER ranges
//                    absent when filtered / when nothing traded ..... COMPANY cases, NO_SALES
//
// Row order: the dashboard lists a day's rows in the order the Sheet appended them, which is the
// order of the closes. The new app keeps that order in sales.seq (migration 0005). One case below
// closes vape before cstore to show it.
//
// Not here, by ruling: a date the old code could not read (an unreadable start or end), which
// the new app refuses with a plain message (ops/test/sales-dashboard.test.ts).
import { codeOf, nameOf, parityCase, paritySequence, resultOf, step, type ParityCase, type Step } from "../case";

type F = Record<string, unknown>;
const dash = (f: unknown, spec: { as?: string | null; title?: string; at?: string } = {}): ParityCase => {
  const as = spec.as === undefined ? "manager" : spec.as;
  const tail = typeof f === "object" && f !== null ? JSON.stringify(f) : String(f);
  const writes = spec.at ? { writes: ["sessions"] } : {};
  return parityCase("rpcGetSalesDashboard", { as, args: f === undefined ? [] : [f], ...(spec.at ? { at: spec.at } : {}), ...writes, title: spec.title ?? `rpcGetSalesDashboard${as ? ` as ${as}` : " with no token"}: ${tail}` });
};

const w = (startDate: string, endDate: string, extra: F = {}): F => ({ startDate, endDate, ...extra });

// The page's own default: 60 days ending today (Friday 20 November), the whole range in one page.
const DEFAULT_60 = w("2026-09-22", "2026-11-20", { page: 1, pageSize: 1000, staffId: "", company: "" });
const FULL_HISTORY = w("2026-07-23", "2026-11-19", { pageSize: 1000 });
const MONTH = w("2026-10-01", "2026-10-31"); // a whole month: cstore changes shape on the 30th
const WEEK = w("2026-11-09", "2026-11-15"); // Monday to Sunday
const WEEK_NO = w("2026-11-17", "2026-11-19"); // three days, mixed shapes
const ONE_DAY = w("2026-11-19", "2026-11-19");
const TODAY_ONLY = w("2026-11-20", "2026-11-20"); // nothing yet today; yesterday is the baseline
const NO_SALES = w("2027-01-01", "2027-01-31");
const BEFORE_DATA = w("2026-01-01", "2026-01-31");
const HISTORY_START = w("2026-07-10", "2026-08-05"); // the baseline is mostly before the first row
const MIXED_SHAPES = w("2026-10-25", "2026-11-03"); // the ePOS change inside the range

// A close in each shape, then the dashboard for the days around it. Saturday 21 November.
const EVE20 = "2026-11-21T03:00:00Z"; // Friday 20th, 22:00 Toronto
const D21 = "2026-11-21T14:00:00Z"; // Saturday 21st, 09:00 Toronto
const CLOSE_W = ["till_sessions", "attendance", "sales", "audit_log", "sessions"];
const open = (company: string, openingCount: number, spec: { at?: string; advance?: { hours?: number; minutes?: number }; as?: string } = {}): Step =>
  step("rpcOpenShift", { args: [{ company, openingCount }], ...spec });
const close = (sessionId: string, fields: Record<string, unknown>, spec: { at?: string; advance?: { hours?: number; minutes?: number }; as?: string } = { advance: { hours: 8 } }): Step =>
  step("rpcCloseShift", { args: [{ sessionId, ...fields }], ...spec });
const CLEAR_CSTORE = close("CST-20261120-S_003", { cashSales: 600, cardTotalSales: 900, miscCashSales: 0, physicalCount: 850, lottoCounted: 500 }, { as: "S_003", at: EVE20 });
const show = (f: F, as = "manager"): Step => step("rpcGetSalesDashboard", { as, args: [f] });
// A sign-in lasts 24 hours and the harness signs everyone in at the case's start, the afternoon of
// the 20th. The closes below end on the evening of the 21st, so whoever reads the dashboard then
// calls something on the morning of the 21st, which renews their sign-in (SIGNED_OUT_RULE in
// ops/parity/run.ts fails a case whose reader had been signed out).
const alive = (as = "manager"): Step => step("rpcGetMe", { as });
/** The dashboard with the clock somewhere else: the manager signs in there first. */
const dashAt = (f: F, at: string, title: string): ParityCase =>
  paritySequence(title, { writes: ["sessions", "audit_log", "login_failures"] }, [
    step("rpcLogin", { at, args: [nameOf("manager"), codeOf("manager")] }),
    step("rpcGetSalesDashboard", { as: { token: resultOf(1, "$.token") }, args: [f] }),
  ]);
const AROUND = w("2026-11-19", "2026-11-21", { pageSize: 1000 });

export const salesDashboardCases: ParityCase[] = [
  // ── Who may ask ─────────────────────────────────────────
  dash(DEFAULT_60, { as: "admin" }),
  dash(DEFAULT_60, { as: "manager" }),
  dash(DEFAULT_60, { as: "payroll_admin" }),
  dash(DEFAULT_60, { as: "S_006", title: "rpcGetSalesDashboard as S_006 (the payroll admin by id)" }),
  dash(DEFAULT_60, { as: "employee", title: "rpcGetSalesDashboard: an employee is refused" }),
  dash(DEFAULT_60, { as: "S_005", title: "rpcGetSalesDashboard: an employee by id is refused" }),
  dash(DEFAULT_60, { as: null, title: "rpcGetSalesDashboard: no token" }),

  // ── What the page sends, and what it might not ─────────
  dash(undefined, { title: "rpcGetSalesDashboard: no filters at all" }),
  dash(null, { title: "rpcGetSalesDashboard: null filters" }),
  dash({}, { title: "rpcGetSalesDashboard: an empty filters object" }),
  dash({ startDate: "2026-11-01" }, { title: "rpcGetSalesDashboard: a start and no end" }),
  dash({ endDate: "2026-11-19" }, { title: "rpcGetSalesDashboard: an end and no start" }),
  dash(w("", "2026-11-19"), { title: "rpcGetSalesDashboard: a blank start" }),
  dash(w("2026-11-01", null as unknown as string), { title: "rpcGetSalesDashboard: a null end" }),
  dash("2026-11-01", { title: "rpcGetSalesDashboard: filters that are a string" }),
  dash(0, { title: "rpcGetSalesDashboard: filters that are zero" }),

  // ── The ranges ──────────────────────────────────────────
  dash(DEFAULT_60, { title: "rpcGetSalesDashboard: the page's default, 60 days to today (timeOfMonth in full, rolling7, byCompany)" }),
  dash(FULL_HISTORY, { title: "rpcGetSalesDashboard: the whole history, 120 days (the previous window is mostly empty)" }),
  dash(w("2026-11-14", "2026-11-20", { pageSize: 1000 }), { title: "rpcGetSalesDashboard: preset last 7 days" }),
  dash(w("2026-10-22", "2026-11-20", { pageSize: 1000 }), { title: "rpcGetSalesDashboard: preset last 30 days (the ePOS change inside)" }),
  dash(w("2026-11-01", "2026-11-20", { pageSize: 1000 }), { title: "rpcGetSalesDashboard: preset this month so far" }),
  dash(w("2026-10-01", "2026-10-31", { pageSize: 1000 }), { title: "rpcGetSalesDashboard: preset last month" }),
  dash(w("2026-11-16", "2026-11-20", { pageSize: 1000 }), { title: "rpcGetSalesDashboard: preset this week (Monday to today)" }),
  dash(ONE_DAY, { title: "rpcGetSalesDashboard: one day (rollingInsufficient, dayOfWeek insufficient)" }),
  dash(WEEK, { title: "rpcGetSalesDashboard: a week (rolling7, dayOfWeek, timeOfMonth insufficient)" }),
  dash(WEEK_NO, { title: "rpcGetSalesDashboard: three days (rollingInsufficient)" }),
  dash(MONTH, { title: "rpcGetSalesDashboard: October (31 days: timeOfMonth in full)" }),
  dash(w("2026-10-05", "2026-10-31"), { title: "rpcGetSalesDashboard: 27 days (timeOfMonth one short of full)" }),
  dash(w("2026-10-04", "2026-10-31"), { title: "rpcGetSalesDashboard: exactly 28 days (timeOfMonth in full)" }),
  dash(NO_SALES, { title: "rpcGetSalesDashboard: a range with no sales" }),
  dash(BEFORE_DATA, { title: "rpcGetSalesDashboard: a range before any data" }),
  dash(HISTORY_START, { title: "rpcGetSalesDashboard: a range whose baseline straddles the first day of history" }),
  dash(w("2026-07-23", "2026-07-23"), { title: "rpcGetSalesDashboard: the first day of history (no baseline)" }),
  dash(TODAY_ONLY, { title: "rpcGetSalesDashboard: today only, nothing sold yet (a baseline and no rows)" }),
  dash(MIXED_SHAPES, { title: "rpcGetSalesDashboard: a range holding both card shapes" }),
  dash(w("2026-11-15", "2026-11-10"), { title: "rpcGetSalesDashboard: start after end" }),
  dash(w("2026-11-15", "2026-11-14"), { title: "rpcGetSalesDashboard: start one day after end" }),
  dash(w("2026-11-15", "2026-11-15"), { title: "rpcGetSalesDashboard: a Sunday alone" }),
  dash(w("2026-11-14", "2026-11-14"), { title: "rpcGetSalesDashboard: a Saturday alone" }),
  dash(w("2026-11-01", "2026-11-01"), { title: "rpcGetSalesDashboard: the day of the clock change, alone" }),
  dash(w("2026-10-28", "2026-11-04"), { title: "rpcGetSalesDashboard: a range holding the November clock change" }),
  dash(w("2026-03-01", "2026-03-31"), { title: "rpcGetSalesDashboard: a range holding the March clock change (no data)" }),
  dash(w("2026-02-30", "2026-03-05"), { title: "rpcGetSalesDashboard: 30 February rolls over, as the old parse does" }),
  dash(w("2026-11-09", "2026-11-15", { startDate2: "ignored" }), { title: "rpcGetSalesDashboard: an unknown field is ignored" }),

  // ── Company and person ──────────────────────────────────
  dash(w("2026-10-01", "2026-11-19", { company: "cstore", pageSize: 1000 }), { title: "rpcGetSalesDashboard: cstore alone (no byCompany)" }),
  dash(w("2026-10-01", "2026-11-19", { company: "vape", pageSize: 1000 }), { title: "rpcGetSalesDashboard: vape alone (no byCompany)" }),
  dash(w("2026-10-01", "2026-11-19", { company: "", pageSize: 1000 }), { title: "rpcGetSalesDashboard: both tills (a blank company)" }),
  dash(w("2026-10-01", "2026-11-19", { company: null, pageSize: 1000 }), { title: "rpcGetSalesDashboard: both tills (a null company)" }),
  dash(w("2026-10-01", "2026-11-19", { company: "grocery" }), { title: "rpcGetSalesDashboard: an unknown company" }),
  dash(w("2026-10-01", "2026-11-19", { company: "CSTORE" }), { title: "rpcGetSalesDashboard: a company in capitals is not a company" }),
  dash(w("2026-10-01", "2026-11-19", { company: 5 }), { title: "rpcGetSalesDashboard: a company that is a number" }),
  dash(w("2026-10-01", "2026-11-19", { staffId: "S_003", pageSize: 1000 }), { title: "rpcGetSalesDashboard: one person" }),
  dash(w("2026-10-01", "2026-11-19", { staffId: "S_004", company: "vape", pageSize: 1000 }), { title: "rpcGetSalesDashboard: one person on one till" }),
  dash(w("2026-10-01", "2026-11-19", { staffId: "S_001" }), { title: "rpcGetSalesDashboard: a person with no sales" }),
  dash(w("2026-10-01", "2026-11-19", { staffId: "S_007" }), { title: "rpcGetSalesDashboard: an inactive person with no sales" }),
  dash(w("2026-10-01", "2026-11-19", { staffId: "S_999" }), { title: "rpcGetSalesDashboard: an unknown person" }),
  dash(w("2026-10-01", "2026-11-19", { staffId: 3 }), { title: "rpcGetSalesDashboard: a person that is a number" }),
  dash(w("2026-10-01", "2026-11-19", { staffId: "s_003" }), { title: "rpcGetSalesDashboard: a person in lower case is not a person" }),

  // ── Paging ──────────────────────────────────────────────
  dash(w("2026-11-01", "2026-11-19"), { title: "rpcGetSalesDashboard: no paging sent (page 1 of 50)" }),
  dash(w("2026-11-01", "2026-11-19", { page: 2, pageSize: 10 }), { title: "rpcGetSalesDashboard: page 2 of 10" }),
  dash(w("2026-11-01", "2026-11-19", { page: 4, pageSize: 10 }), { title: "rpcGetSalesDashboard: the last, short page" }),
  dash(w("2026-11-01", "2026-11-19", { page: 99, pageSize: 10 }), { title: "rpcGetSalesDashboard: a page past the end" }),
  dash(w("2026-11-01", "2026-11-19", { page: 0, pageSize: 10 }), { title: "rpcGetSalesDashboard: page 0 reads as 1" }),
  dash(w("2026-11-01", "2026-11-19", { page: -1, pageSize: 10 }), { title: "rpcGetSalesDashboard: a negative page (slice counts from the end)" }),
  dash(w("2026-11-01", "2026-11-19", { page: "2", pageSize: "10" }), { title: "rpcGetSalesDashboard: paging sent as text" }),
  dash(w("2026-11-01", "2026-11-19", { page: "abc", pageSize: "xyz" }), { title: "rpcGetSalesDashboard: paging that is not a number" }),
  dash(w("2026-11-01", "2026-11-19", { pageSize: 0 }), { title: "rpcGetSalesDashboard: pageSize 0 reads as 50" }),
  dash(w("2026-11-01", "2026-11-19", { pageSize: -5 }), { title: "rpcGetSalesDashboard: a negative pageSize" }),
  dash(w("2026-11-01", "2026-11-19", { pageSize: 2.5, page: 2 }), { title: "rpcGetSalesDashboard: a fractional pageSize" }),
  dash(w("2026-11-01", "2026-11-19", { pageSize: 1 }), { title: "rpcGetSalesDashboard: one row a page" }),
  dash(w("2026-11-01", "2026-11-19", { pageSize: 100000 }), { title: "rpcGetSalesDashboard: a huge page" }),

  // ── The clock does not matter to the read ───────────────
  dashAt(w("2026-10-03", "2026-12-01", { pageSize: 1000 }), "2026-12-01T15:00:00Z", "rpcGetSalesDashboard: clock on the first of a month, the page's 60 days from it"),
  dashAt(w("2026-09-25", "2026-11-23", { pageSize: 1000 }), "2026-11-23T15:00:00Z", "rpcGetSalesDashboard: clock on a Monday"),
  dashAt(w("2026-09-24", "2026-11-22", { pageSize: 1000 }), "2026-11-22T15:00:00Z", "rpcGetSalesDashboard: clock on a Sunday"),
  dash(w("2026-09-23", "2026-11-21", { pageSize: 1000 }), { at: "2026-11-21T15:00:00Z", title: "rpcGetSalesDashboard: clock on the day after the last fixture day... plus one" }),

  // ── After a close, in each card shape ───────────────────
  paritySequence("a vape close in the split shape shows in the dashboard", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, { at: D21 }),
    alive(),
    close("VAP-20261121-S_004", { cashSales: 143.25, creditCardSales: 210.1, debitCardSales: 99.9, physicalCount: 243.25 }),
    show(AROUND),
  ]),
  paritySequence("a cstore close with one card total shows in the dashboard", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, { at: D21 }),
    alive(),
    close("CST-20261121-S_004", { cashSales: 512.4, cardTotalSales: 1033.65, physicalCount: 762.4, lottoCounted: 500 }),
    show(AROUND),
    show(w("2026-11-21", "2026-11-21", { company: "cstore" })),
  ]),
  paritySequence("a close with misc sales in each shape", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("vape", 100, { at: D21 }),
    alive(),
    open("cstore", 250, { advance: { minutes: 5 } }),
    close("CST-20261121-S_004", { cashSales: 400, cardTotalSales: 900, miscCashSales: 15, miscCardSales: 30.3, miscNotes: "phone cards", physicalCount: 665, lottoCounted: 500 }, { advance: { hours: 6 } }),
    close("VAP-20261121-S_004", { cashSales: 180.55, creditCardSales: 120, debitCardSales: 80.4, cashbackPaid: 40, miscCashSales: 22.5, miscCreditSales: 12.25, miscDebitSales: 7.75, miscNotes: "two coil packs", physicalCount: 263.05 }, { advance: { hours: 2 } }),
    show(AROUND),
    show(w("2026-11-21", "2026-11-21")),
    show(w("2026-11-21", "2026-11-21", { staffId: "S_004", pageSize: 1 })),
  ]),
  paritySequence("vape closed before cstore on the same day: the day's rows are listed in the order of the closes", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, { at: D21 }),
    alive(),
    open("vape", 100, { advance: { minutes: 5 } }),
    close("VAP-20261121-S_004", { cashSales: 80.1, creditCardSales: 60, debitCardSales: 40.2, physicalCount: 180.1 }, { advance: { hours: 6 } }),
    close("CST-20261121-S_004", { cashSales: 410.3, cardTotalSales: 700.7, physicalCount: 660.3, lottoCounted: 500 }, { advance: { hours: 2 } }),
    show(w("2026-11-21", "2026-11-21")),
    show(AROUND),
  ]),
  paritySequence("a day closed before the dashboard is first read, then a negative cash day and a zero day", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, { at: D21 }),
    alive(),
    close("CST-20261121-S_004", { cashSales: -300, cardTotalSales: 640, physicalCount: 250, lottoCounted: 200, lottoNote: "Paid $500 winning ticket" }),
    show(w("2026-11-20", "2026-11-21", { pageSize: 1000 })),
    open("vape", 100, { advance: { minutes: 5 } }),
    close("VAP-20261121-S_004", { cashSales: 0, creditCardSales: 0, debitCardSales: 0, physicalCount: 100 }, { advance: { hours: 1 } }),
    show(w("2026-11-21", "2026-11-21")),
  ]),
  paritySequence("a close shows in the dashboard only to the roles allowed", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, { at: D21 }),
    alive("payroll_admin"),
    close("VAP-20261121-S_004", { cashSales: 10, creditCardSales: 5, debitCardSales: 5, physicalCount: 110 }),
    show(AROUND, "S_004"),
    show(AROUND, "payroll_admin"),
  ]),
];
