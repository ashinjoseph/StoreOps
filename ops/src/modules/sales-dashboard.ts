// The sales dashboard and its insights: the port of the second half of src/Sales.gs (pctChange_
// to getDashboard_) and of rpcGetSalesDashboard's reading of the page's filters.
//
// To the cent, in the same order. Every sum below adds in the order the old code added, and every
// roundMoney is where the old one was: floating-point sums differ in the last digit if reordered.
// So nothing here aggregates in SQL: the rows are read once and everything is computed in
// TypeScript with the ported functions, which are pure over plain rows (the old tests apply to them
// unchanged).
//
// Row order. The Sheet listed sales rows in the order they were appended; the dashboard then
// sorted them newest day first, and the sort is stable, so rows of one day kept the append order.
// That order is sales.seq, numbered by the database as each row is inserted (migration 0005; the
// import loads the tab top to bottom). It decides the page's `rows` within a day and the order of
// the additions inside a day, so sums are added in the order the old code added them.
//
// Reads: ONE query for the sales rows of the range AND of the preceding window of the same length
// (the old code read the sheet once and filtered twice; the two are told apart in memory), and ONE
// for the staff names. Two queries per call, none in a loop. The row mapping is sales.ts's (toRecord is not exported, so it is repeated here; a test
// checks the two give the same record).
//
// Where the old code turns a blank into 0 (ADR-0004), marked "blank" below: a null card column adds
// 0 to every sum; a split row's missing credit or debit shows 0; a row with neither card shape
// shows card 0. Anything the old dashboard showed as null stays null: a single-total row's credit
// and debit, a split row's card, a share of nothing, a change with no baseline.
//
// Dates: the old RPC returns no Date (days are "yyyy-MM-dd" strings, `dateMs` is a number), so
// nothing here is nulled.
import type { Db } from "../db/client";
import type { Config } from "../lib/config";
import { addDays, formatDate, parseDate, wallClock } from "../lib/dates";
import { roundMoney } from "../lib/money";
import * as sales from "./sales";
import type { SalesRecord } from "./sales";
import * as staff from "./staff";

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_BUCKETS = [
  { key: "early", label: "Days 1-10" },
  { key: "mid", label: "Days 11-20" },
  { key: "late", label: "Days 21-end" },
];
/** Bucket label for rows whose company cell is empty. */
export const UNASSIGNED = "unassigned";
const DAY_MS = 86_400_000;

// ── Reading the rows ───────────────────────────────────────

interface Joined {
  sales_id: string;
  session_id: string;
  staff_id: string;
  company: string;
  date: string | null;
  cash_sales: number | null;
  credit_card_sales: number | null;
  debit_card_sales: number | null;
  cashback_paid: number | null;
  hst_collected: number | null;
  bottle_deposit: number | null;
  round_off: number | null;
  misc_cash_sales: number | null;
  misc_credit_sales: number | null;
  misc_debit_sales: number | null;
  misc_notes: string | null;
  card_total_sales: number | null;
  misc_card_sales: number | null;
}

const COLUMNS = ["sales_id", "session_id", "staff_id", "company", "date", "cash_sales", "credit_card_sales", "debit_card_sales", "cashback_paid", "hst_collected", "bottle_deposit", "round_off", "misc_cash_sales", "misc_credit_sales", "misc_debit_sales", "misc_notes", "card_total_sales", "misc_card_sales"].map((c) => `s.${c}`).join(", ");
/** The order written (see the header). */
const ROW_ORDER = "order by s.seq";
const trimmed = (v: string | null): string => (v || "").toString().trim();
const num0 = (v: number | null): number => Number(v) || 0;
const numOrNull = (v: number | null): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

/** The record sales.ts gives for a row (Sales.rowToRecord_). */
function toRecord(r: Joined): SalesRecord {
  return {
    salesId: trimmed(r.sales_id),
    sessionId: trimmed(r.session_id),
    staffId: trimmed(r.staff_id),
    company: trimmed(r.company),
    date: r.date,
    cashSales: num0(r.cash_sales),
    creditCardSales: numOrNull(r.credit_card_sales),
    debitCardSales: numOrNull(r.debit_card_sales),
    cashbackPaid: num0(r.cashback_paid),
    hstCollected: num0(r.hst_collected),
    bottleDeposit: num0(r.bottle_deposit),
    roundOff: num0(r.round_off),
    miscCashSales: num0(r.misc_cash_sales),
    miscCreditSales: numOrNull(r.misc_credit_sales),
    miscDebitSales: numOrNull(r.misc_debit_sales),
    miscNotes: (r.misc_notes || "").toString(),
    cardTotalSales: numOrNull(r.card_total_sales),
    miscCardSales: numOrNull(r.misc_card_sales),
    cardSplit: numOrNull(r.credit_card_sales) !== null || numOrNull(r.debit_card_sales) !== null,
  };
}

/** The rows with a date from `fromKey` to `toKey` inclusive ("YYYY-MM-DD"), optionally one person's and/or one till's, in the order above. */
export async function readRows(db: Db, fromKey: string, toKey: string, filters: { staffId?: string | null; company?: string | null }): Promise<SalesRecord[]> {
  const params: unknown[] = [fromKey, toKey];
  const where = ["s.date is not null", "s.date >= $1", "s.date <= $2"];
  if (filters.staffId) {
    params.push(String(filters.staffId));
    where.push(`s.staff_id = $${params.length}`);
  }
  if (filters.company) {
    params.push(String(filters.company));
    where.push(`s.company = $${params.length}`);
  }
  const rows = await db.query<Joined>(`select ${COLUMNS} from ops.sales s where ${where.join(" and ")} ${ROW_ORDER}`, params);
  return rows.map(toRecord);
}

/** The fields of a sales row the dashboard reads. */
export type DashRow = Pick<
  SalesRecord,
  | "salesId"
  | "sessionId"
  | "staffId"
  | "company"
  | "date"
  | "cashSales"
  | "creditCardSales"
  | "debitCardSales"
  | "cashbackPaid"
  | "miscCashSales"
  | "miscCreditSales"
  | "miscDebitSales"
  | "miscNotes"
  | "cardTotalSales"
  | "miscCardSales"
  | "cardSplit"
>;

export interface Daily {
  dateStr: string;
  dateMs: number;
  cash: number;
  credit: number;
  debit: number;
  card: number;
  misc: number;
  total: number;
  sessionCount: number;
  byCompany: Record<string, number>;
}

export interface Totals {
  cash: number;
  credit: number;
  debit: number;
  card: number;
  cardAll: number;
  misc: number;
  total: number;
  cashback: number;
  sessionCount: number;
  splitRows: number;
  totalRows: number;
}

// ── Insight helpers ────────────────────────────────────────

/** Percent change, one decimal; null when there is no baseline. (pctChange_) */
export function pctChange(now: number, before: number): number | null {
  if (!before) return null;
  return Math.round(((now - before) / Math.abs(before)) * 1000) / 10;
}

/** Cash and total of a set of rows, rounded once at the end. (sumTotals_) */
export function sumTotals(rows: readonly DashRow[]): { cash: number; total: number } {
  let cash = 0;
  let total = 0;
  for (const r of rows) {
    const c = (r.cashSales || 0) + (r.miscCashSales || 0);
    cash += c;
    total += sales.totalForRow(r);
  }
  return { cash: roundMoney(cash), total: roundMoney(total) };
}

/** Trailing mean over `window` days of the daily series; null until a full window exists. (rollingAverage_) */
export function rollingAverage(daily: readonly Pick<Daily, "total">[], window: number): Array<number | null> {
  const out: Array<number | null> = [];
  for (let i = 0; i < daily.length; i++) {
    if (i + 1 < window) {
      out.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) sum += (daily[j] as Daily).total;
    out.push(roundMoney(sum / window));
  }
  return out;
}

export interface TrendBlock {
  total: number;
  previousTotal: number;
  changePct: number | null;
  changeAmount: number;
  perTradingDay: number;
  tradingDays: number;
  best: { dateStr: string; total: number } | null;
  worst: { dateStr: string; total: number } | null;
  rolling7: Array<number | null> | null;
  rollingInsufficient?: string;
}

/** (trendInsight_) */
export function trendInsight(daily: readonly Daily[], totals: Pick<Totals, "total">, prevRows: readonly DashRow[], dayCount: number): TrendBlock {
  const prev = sumTotals(prevRows);
  const perDay = dayCount ? roundMoney(totals.total / dayCount) : 0;
  const block: TrendBlock = {
    total: totals.total,
    previousTotal: prev.total,
    changePct: pctChange(totals.total, prev.total),
    changeAmount: roundMoney(totals.total - prev.total),
    perTradingDay: perDay,
    tradingDays: dayCount,
    best: null,
    worst: null,
    rolling7: null,
  };
  if (daily.length) {
    const sorted = daily.slice().sort((a, b) => b.total - a.total);
    const first = sorted[0] as Daily;
    const last = sorted[sorted.length - 1] as Daily;
    block.best = { dateStr: first.dateStr, total: first.total };
    block.worst = { dateStr: last.dateStr, total: last.total };
  }
  if (daily.length >= 7) {
    block.rolling7 = rollingAverage(daily, 7);
  } else {
    block.rollingInsufficient = "Needs 7 days of sales for a rolling average — this range has " + daily.length + ".";
  }
  return block;
}

interface DowBucket {
  dow: number;
  name: string;
  short: string;
  total: number;
  days: number;
  average: number;
}
export type DayOfWeekBlock =
  | { insufficient: string; buckets: DowBucket[] }
  | { buckets: DowBucket[]; best: { name: string; average: number }; worst: { name: string; average: number }; spreadPct: number | null };

/** (dayOfWeekInsight_) */
export function dayOfWeekInsight(daily: readonly Pick<Daily, "dateMs" | "total">[]): DayOfWeekBlock {
  const buckets: DowBucket[] = DOW_NAMES.map((n, i) => ({ dow: i, name: n, short: DOW_SHORT[i] as string, total: 0, days: 0, average: 0 }));
  for (const d of daily) {
    if (!d.dateMs) continue;
    const b = buckets[wallClock(new Date(d.dateMs)).dow] as DowBucket;
    b.total = roundMoney(b.total + d.total);
    b.days++;
  }
  for (const b of buckets) b.average = b.days ? roundMoney(b.total / b.days) : 0;

  const traded = buckets.filter((b) => b.days > 0);
  if (traded.length < 2) return { insufficient: "Needs at least two different weekdays of sales.", buckets };
  const ranked = traded.slice().sort((a, b) => b.average - a.average);
  const top = ranked[0] as DowBucket;
  const bottom = ranked[ranked.length - 1] as DowBucket;
  return {
    buckets,
    best: { name: top.name, average: top.average },
    worst: { name: bottom.name, average: bottom.average },
    // How much better the best day is than the worst.
    spreadPct: pctChange(top.average, bottom.average),
  };
}

interface MonthBucket {
  key: string;
  label: string;
  total: number;
  days: number;
  average: number;
  vsOverallPct?: number | null;
}
export type TimeOfMonthBlock =
  | { insufficient: string; buckets: MonthBucket[] }
  | { buckets: MonthBucket[]; overallAverage: number; strongest: { label: string; average: number }; weakest: { label: string; average: number } };

/** (timeOfMonthInsight_) */
export function timeOfMonthInsight(daily: readonly Pick<Daily, "dateMs" | "total">[]): TimeOfMonthBlock {
  const buckets: MonthBucket[] = MONTH_BUCKETS.map((b) => ({ key: b.key, label: b.label, total: 0, days: 0, average: 0 }));
  for (const d of daily) {
    if (!d.dateMs) continue;
    const dom = wallClock(new Date(d.dateMs)).day;
    const b = buckets[dom <= 10 ? 0 : dom <= 20 ? 1 : 2] as MonthBucket;
    b.total = roundMoney(b.total + d.total);
    b.days++;
  }
  for (const b of buckets) b.average = b.days ? roundMoney(b.total / b.days) : 0;

  // Under a month, at least one bucket is missing or barely sampled.
  const covered = buckets.filter((b) => b.days > 0).length;
  if (daily.length < 28 || covered < 3) {
    return {
      insufficient:
        "Needs a full month of sales to compare parts of the month — this range covers " + daily.length + " trading day" + (daily.length === 1 ? "" : "s") + " across " + covered + " of 3 parts.",
      buckets,
    };
  }
  const ranked = buckets.slice().sort((a, b) => b.average - a.average);
  const overall = roundMoney(buckets.reduce((s, b) => s + b.total, 0) / buckets.reduce((s, b) => s + b.days, 0));
  for (const b of buckets) b.vsOverallPct = pctChange(b.average, overall);
  const strongest = ranked[0] as MonthBucket;
  const weakest = ranked[2] as MonthBucket;
  return {
    buckets,
    overallAverage: overall,
    strongest: { label: strongest.label, average: strongest.average },
    weakest: { label: weakest.label, average: weakest.average },
  };
}

export interface TenderMixBlock {
  cash: number;
  total: number;
  cashSharePct: number | null;
  previousCashSharePct: number | null;
  changePoints: number | null;
  series: Array<{ dateStr: string; sharePct: number | null }>;
}

/** (tenderMixInsight_) */
export function tenderMixInsight(daily: readonly (Pick<Daily, "dateStr" | "total" | "cash">)[], totals: { cash: number; total: number }, prevRows: readonly DashRow[]): TenderMixBlock {
  const share = (cash: number, total: number): number | null => (total ? Math.round((cash / total) * 1000) / 10 : null);
  const prev = sumTotals(prevRows);
  const nowShare = share(totals.cash, totals.total);
  const prevShare = share(prev.cash, prev.total);
  return {
    cash: totals.cash,
    total: totals.total,
    cashSharePct: nowShare,
    previousCashSharePct: prevShare,
    // Percentage POINTS, not a percent change of a percent.
    changePoints: nowShare != null && prevShare != null ? Math.round((nowShare - prevShare) * 10) / 10 : null,
    series: daily.map((d) => ({ dateStr: d.dateStr, sharePct: share(d.cash, d.total) })),
  };
}

// ── The daily series and the company slices ────────────────

/** Rows to one entry per calendar day, oldest first, summed in the order the rows arrive. (buildDaily_) */
export function buildDaily(rows: readonly DashRow[]): Daily[] {
  const map = new Map<string, Daily>();
  for (const r of rows) {
    const key = r.date ? r.date : "—";
    let d = map.get(key);
    if (!d) {
      d = {
        dateStr: key,
        // The Toronto midnight of the day, as the Sheet's Date cell was (ms since the epoch).
        dateMs: r.date ? (parseDate(r.date) as Date).getTime() : 0,
        cash: 0,
        credit: 0,
        debit: 0,
        card: 0,
        misc: 0,
        total: 0,
        sessionCount: 0,
        byCompany: {},
      };
      map.set(key, d);
    }
    const rowTotal = sales.totalForRow(r);
    // blank: a null card column adds 0 to the day.
    d.cash += r.cashSales || 0;
    d.credit += r.creditCardSales || 0;
    d.debit += r.debitCardSales || 0;
    d.card += r.cardTotalSales || 0;
    d.misc += (r.miscCashSales || 0) + (r.miscCreditSales || 0) + (r.miscDebitSales || 0) + (r.miscCardSales || 0);
    d.sessionCount++;
    // A blank company still belongs to the day's total, so it gets a bucket.
    const c = r.company || UNASSIGNED;
    d.byCompany[c] = (d.byCompany[c] || 0) + rowTotal;
  }
  const out = [...map.values()].map((d) => {
    d.total = roundMoney(d.cash + d.credit + d.debit + d.card + d.misc);
    d.cash = roundMoney(d.cash);
    d.credit = roundMoney(d.credit);
    d.debit = roundMoney(d.debit);
    d.card = roundMoney(d.card);
    d.misc = roundMoney(d.misc);
    for (const c of Object.keys(d.byCompany)) d.byCompany[c] = roundMoney(d.byCompany[c]);
    return d;
  });
  // The old sorted Object.keys of its map (insertion order); the sort is stable.
  return out.sort((a, b) => a.dateMs - b.dateMs);
}

export interface CompanySlice {
  total: number;
  tradingDays: number;
  perTradingDay: number;
  sharePct: number;
  sessionCount: number;
  dayOfWeek: DayOfWeekBlock;
  daily: Daily[];
}

/** One company's slice of the same range. `rangeTradingDays` is the days the whole range traded. (companySlice_) */
export function companySlice(companyRows: readonly DashRow[], grandTotal: number, rangeTradingDays: number): CompanySlice {
  const cDaily = buildDaily(companyRows);
  const total = roundMoney(cDaily.reduce((s, d) => s + d.total, 0));
  const tradingDays = cDaily.length;
  // Divide by the days the RANGE traded, so the per-day figures are additive against the headline.
  const days = rangeTradingDays || tradingDays;
  return {
    total,
    tradingDays,
    perTradingDay: days ? roundMoney(total / days) : 0,
    sharePct: grandTotal ? Math.round((total / grandTotal) * 1000) / 10 : 0,
    sessionCount: companyRows.length,
    dayOfWeek: dayOfWeekInsight(cDaily),
    daily: cDaily,
  };
}

// ── The previous window and the insights ───────────────────

/**
 * The window of the same length just before the range, in whole Toronto days: `prevStart` is a
 * Toronto midnight, `prevEnd` the last millisecond before the range's first day. A range with its
 * end before its start counts as one day long. Both inputs must be readable dates.
 */
export function previousWindow(startDate: Date, endDate: Date): { prevStart: Date; prevEnd: Date } {
  const startDay = parseDate(formatDate(startDate)) as Date;
  const endDay = parseDate(formatDate(endDate)) as Date;
  const spanDays = Math.max(1, Math.round((endDay.getTime() - startDay.getTime()) / DAY_MS) + 1);
  return { prevStart: addDays(startDay, -spanDays), prevEnd: new Date(startDay.getTime() - 1) };
}

export interface Insights {
  trend: TrendBlock;
  dayOfWeek: DayOfWeekBlock;
  timeOfMonth: TimeOfMonthBlock;
  tenderMix: TenderMixBlock;
  previousPeriod: { startStr: string; endStr: string; sessionCount: number };
  byCompany?: Record<string, CompanySlice>;
}

/**
 * The four insights and the previous period. `prevRows` are the rows of `previousWindow`'s window:
 * the old function read them itself, here the caller has them already. (buildInsights_)
 */
export function buildInsights(daily: readonly Daily[], totals: Totals, startDate: Date, endDate: Date, prevRows: readonly DashRow[]): Insights {
  const { prevStart, prevEnd } = previousWindow(startDate, endDate);
  return {
    trend: trendInsight(daily, totals, prevRows, daily.length),
    dayOfWeek: dayOfWeekInsight(daily),
    timeOfMonth: timeOfMonthInsight(daily),
    tenderMix: tenderMixInsight(daily, totals, prevRows),
    previousPeriod: { startStr: formatDate(prevStart), endStr: formatDate(prevEnd), sessionCount: prevRows.length },
  };
}

// ── The dashboard ──────────────────────────────────────────

export interface DashboardInput {
  /** A Date or "yyyy-MM-dd". Both bounds are required. */
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  staffId?: unknown;
  company?: unknown;
  page?: number;
  pageSize?: number;
}

export interface DashboardRow {
  salesId: string;
  sessionId: string;
  staffId: string;
  staffName: string;
  company: string;
  date: string | null;
  cash: number;
  credit: number | null;
  debit: number | null;
  card: number | null;
  misc: number;
  cashback: number;
  total: number;
  miscNotes: string;
}

export interface Dashboard {
  rows: DashboardRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  pageCount: number;
  totals: Totals;
  daily: Daily[];
  companies: string[];
  insights: Insights;
}

/** A bound as the old getDashboard_ read it: a Date as it is, anything else through parseDate; blank is null. */
function bound(v: unknown): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : parseDate(v);
}

/** The first day a range starting at `start` takes in: the day itself if its midnight is not before `start`, else the next. */
function firstDayKey(start: Date): string {
  const first = formatDate(start);
  const midnight = parseDate(first) as Date;
  return midnight.getTime() >= start.getTime() ? first : formatDate(addDays(midnight, 1));
}

/** Newest day first; the sort is stable, so one day's rows keep the order they arrived in. */
function newestFirst(a: { date: string | null }, b: { date: string | null }): number {
  const x = a.date as string;
  const y = b.date as string;
  return x < y ? 1 : x > y ? -1 : 0;
}

/**
 * Everything the Sales screen shows: the rows of the range newest first (one page of them), the
 * tender totals, the daily series, the companies, and the insights. Two queries: the sales rows of
 * the range and its previous window together, and the staff names. `_ctx` is accepted for the
 * signature every port shares; nothing here reads the clock or the settings (the page chooses its
 * range, and "today" is its own).
 */
export async function getDashboard(db: Db, input: DashboardInput, _ctx?: { config?: Config; now?: Date }): Promise<Dashboard> {
  const startDate = bound(input.startDate);
  const endDate = bound(input.endDate);
  if (!startDate || !endDate) throw new Error("startDate and endDate required");
  // The old code, given an unreadable date, failed deep inside with an engine message.
  if (Number.isNaN(startDate.getTime())) throw new Error("startDate is not a readable date");
  if (Number.isNaN(endDate.getTime())) throw new Error("endDate is not a readable date");

  const { prevStart, prevEnd } = previousWindow(startDate, endDate);
  const fromKey = firstDayKey(startDate);
  const toKey = formatDate(endDate);
  const prevFrom = formatDate(prevStart);
  const prevTo = formatDate(prevEnd);

  // A person or till filter that is not text matches nothing (the old strict comparison with a number or object).
  const notText = (v: unknown): boolean => !!v && typeof v !== "string";
  let all: SalesRecord[] = [];
  if (!notText(input.staffId) && !notText(input.company)) {
    const filters = { staffId: (input.staffId as string) || null, company: (input.company as string) || null };
    all = await readRows(db, prevFrom, toKey > prevTo ? toKey : prevTo, filters);
  }
  const rows = all.filter((r) => r.date !== null && r.date >= fromKey && r.date <= toKey);
  const prevRows = all.filter((r) => r.date !== null && r.date >= prevFrom && r.date <= prevTo);
  rows.sort(newestFirst);

  // `cardAll` is the tender; credit/debit are a breakdown that only some rows carry.
  const totals: Totals = { cash: 0, credit: 0, debit: 0, card: 0, cardAll: 0, misc: 0, total: 0, cashback: 0, sessionCount: rows.length, splitRows: 0, totalRows: 0 };
  for (const r of rows) {
    // blank: a null card column adds 0.
    totals.cash += r.cashSales || 0;
    totals.credit += r.creditCardSales || 0;
    totals.debit += r.debitCardSales || 0;
    totals.card += r.cardTotalSales || 0;
    totals.misc += (r.miscCashSales || 0) + (r.miscCreditSales || 0) + (r.miscDebitSales || 0) + (r.miscCardSales || 0);
    totals.cashback += r.cashbackPaid || 0;
    if (r.cardSplit) totals.splitRows++;
    else totals.totalRows++;
  }
  totals.cardAll = totals.credit + totals.debit + totals.card;
  totals.total = totals.cash + totals.credit + totals.debit + totals.card + totals.misc;
  for (const k of ["cash", "credit", "debit", "card", "cardAll", "misc", "total", "cashback"] as const) totals[k] = roundMoney(totals[k]);

  const daily = buildDaily(rows);

  const companies: string[] = [];
  for (const r of rows) {
    const c = r.company || UNASSIGNED;
    if (companies.indexOf(c) === -1) companies.push(c);
  }
  companies.sort();

  const pageSize = input.pageSize || 50;
  const page = input.page || 1;
  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);

  const names = new Map((await staff.getAll(db)).map((s) => [s.staffId, s.name]));

  const insights = buildInsights(daily, totals, startDate, endDate, prevRows);
  // Only when nothing is filtered out: narrowed to one company there is no comparison to draw.
  if (!input.company && companies.length > 1) {
    const byCompany: Record<string, CompanySlice> = {};
    for (const c of companies) {
      byCompany[c] = companySlice(
        rows.filter((r) => (r.company || UNASSIGNED) === c),
        totals.total,
        daily.length,
      );
    }
    insights.byCompany = byCompany;
  }

  return {
    rows: pageRows.map((r) => ({
      salesId: r.salesId,
      sessionId: r.sessionId,
      staffId: r.staffId,
      staffName: names.get(r.staffId) || r.staffId,
      company: r.company,
      date: r.date ? r.date : null,
      cash: roundMoney(r.cashSales || 0),
      // blank: a split row's missing credit or debit shows 0; a single-total row shows null (not 0) for both.
      credit: r.cardSplit ? roundMoney(r.creditCardSales || 0) : null,
      debit: r.cardSplit ? roundMoney(r.debitCardSales || 0) : null,
      // blank: a row with neither shape shows 0 here.
      card: r.cardSplit ? null : roundMoney(r.cardTotalSales || 0),
      misc: roundMoney((r.miscCashSales || 0) + (r.miscCreditSales || 0) + (r.miscDebitSales || 0) + (r.miscCardSales || 0)),
      cashback: r.cashbackPaid || 0,
      total: sales.totalForRow(r),
      miscNotes: r.miscNotes,
    })),
    totalCount: rows.length,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(rows.length / pageSize)),
    totals,
    daily,
    companies,
    insights,
  };
}
