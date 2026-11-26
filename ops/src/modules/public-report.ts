// PublicReport: the port of src/PublicReport.gs, every function. The payloads of the two pages
// anyone can open with no sign-in: `?v=recon` (build: who holds the shop's cash, how the lotto pot
// moved, whether the days added up) and `?v=sales` (buildSales: the sales dashboard's aggregates).
//
// Exported under the old names without the underscore: build, buildSales (the old public two), and
// the pieces: dayKey, dayWindow, section, reserveSection, cashSection, reconcileSection,
// salesSection. Each takes a `Db` first and `{ config, now }`; "today" is `now` in Toronto.
//
// READ ONLY. Nothing here writes; the caller (ops/src/public/pages.ts) runs it inside one read-only
// transaction. WHAT IT RETURNS IS PUBLIC: every field below is the old payload's, field for field,
// and nothing is added. The recon payload names people (who holds cash, who handed cash to whom,
// who recorded it) and carries text people typed (the lotto note, the handover note), as the old
// one did, deliberately ("Names are shown — that is the point of the page"). The sales payload is
// aggregates only: no session rows, so no names against takings.
//
// Same as the old code, deliberately (each is in the card's report):
//   - dayKey reads a 'yyyy-MM-dd' through `new Date(s)`, which is UTC midnight, then formats it in
//     Toronto: the day BEFORE. So every lotto count is filed under the day before its close, and
//     `currentDate` is the day before the last count (old lines 59 and 87);
//   - a day with no count shows `topup: 0` and `shortfall: 0` (old lines 77-78), a count with no
//     shortfall `shortfall: 0` (`e.shortfall || 0`); a day with no handover `movedIn: 0`; these are
//     sums or absences the page prints as "—" / nothing, not measurements;
//   - several counts on one day: the balance is the one seen last in newest-close-first order (the
//     day's earliest close), the top-ups add up, the note is the newest non-blank one;
//   - `days` is not clamped here (the page clamps it); 0, junk and null are the default; a negative
//     recon window has no first day and throws, as the old code did (`window[0].key`).
//
// One deliberate difference: a section that throws reports `{ unavailable: 'not available' }`, not
// the error's message (the old code published `e.message`: on this side that could name a table or
// quote a value on a no-login page). The error goes to `deps.log`, if given.
//
// Reads: recon, 9 or 10 queries (the lotto log 2, +1 when no count exists at all; cash 7; reconcile
// 1); sales, 2. None in a loop: each module reads its tables once.
import type { Db } from "../db/client";
import type { Config } from "../lib/config";
import { addDays, endOfDay, formatDate, formatDateTime, todayMidnight } from "../lib/dates";
import { roundMoney } from "../lib/money";
import * as cashHandling from "./cash-handling";
import * as reconcile from "./reconcile";
import * as salesDashboard from "./sales-dashboard";
import * as tillSessions from "./till-sessions";

export const DEFAULT_DAYS = 7;
export const DEFAULT_SALES_DAYS = 60;
/** What a section that threw says (see the header: the error's own text is never published). */
export const SECTION_UNAVAILABLE = "not available";

export interface PublicDeps {
  config: Config;
  now: Date;
  /** Where a section's failure is reported (never into the payload). */
  log?: (entry: Record<string, unknown>) => void;
}

export interface Unavailable {
  unavailable: string;
}

export interface WindowDay {
  key: string;
  date: Date;
}

/** A Date as its Toronto day; anything else as text ('' for blank). (dayKey_) */
export function dayKey(d: unknown): string {
  return d instanceof Date ? formatDate(d) : String(d || "");
}

/**
 * The last `days` calendar days, oldest first, as yyyy-MM-dd, from Toronto midnights (a clock change
 * neither duplicates nor skips a day). (dayWindow_)
 */
export function dayWindow(days: number, now: Date): WindowDay[] {
  const out: WindowDay[] = [];
  const today = todayMidnight(now);
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    out.push({ key: formatDate(d), date: d });
  }
  return out;
}

/** `fn`'s answer, or { unavailable } if it throws. (section_; see the header for the one difference) */
export async function section<T>(fn: () => Promise<T>, name = "section", log?: PublicDeps["log"]): Promise<T | Unavailable> {
  try {
    return await fn();
  } catch (e) {
    log?.({ event: "public_report.section_failed", section: name, errorClass: e instanceof Error ? e.name : typeof e, message: e instanceof Error ? e.message : String(e) });
    return { unavailable: SECTION_UNAVAILABLE };
  }
}

const first = (window: readonly WindowDay[]): string => (window[0] as WindowDay).key;

// ── Reserve ────────────────────────────────────────────────

export interface ReserveRow {
  dateStr: string;
  counted: number | null;
  topup: number;
  shortfall: number;
  note: string;
  traded: boolean;
}

/** The lotto pot over the window: each day's count, what moved in, and the cashier's reason. (reserveSection_) */
export async function reserveSection(db: Db, days: number, window: readonly WindowDay[], deps: PublicDeps) {
  const log = await tillSessions.getLottoLog(db, Math.max(days, 14), { config: deps.config, now: deps.now });
  if (!log || !log.enabled) return { unavailable: "Lotto reserve is not set up on this sheet." };

  const byDay: Record<string, { counted: number; topup: number; note: string; shortfall: number }> = {};
  (log.entries || []).forEach((e) => {
    const k = dayKey(e.date ? new Date(e.date) : null);
    if (!k) return;
    const prev = byDay[k];
    byDay[k] = {
      counted: e.counted,
      topup: roundMoney((prev ? prev.topup : 0) + (e.topup || 0)),
      note: e.note || (prev ? prev.note : ""),
      shortfall: e.shortfall || 0,
    };
  });

  const rows: ReserveRow[] = window.map((w) => {
    const d = byDay[w.key];
    return {
      dateStr: w.key,
      counted: d ? d.counted : null,
      topup: d ? d.topup : 0,
      shortfall: d ? d.shortfall : 0,
      note: d ? d.note : "",
      traded: !!d,
    };
  });

  return {
    expected: log.expected,
    current: log.lastCounted,
    currentDate: log.lastCountedDate ? dayKey(new Date(log.lastCountedDate)) : "",
    shortfall: log.lastCounted == null ? null : roundMoney(log.expected - log.lastCounted),
    movedIn: roundMoney(rows.reduce((s, r) => s + (r.topup || 0), 0)),
    rows,
  };
}

// ── Cash held ──────────────────────────────────────────────

/** Who is carrying shop cash now, by name, and the handovers inside the window, oldest first. (cashSection_) */
export async function cashSection(db: Db, _days: number, window: readonly WindowDay[], deps: PublicDeps) {
  if (!(await cashHandling.sheetsExist(db))) {
    return { unavailable: "Cash handling is not set up on this sheet." };
  }
  const out = await cashHandling.getAllOutstanding(db, deps.config, deps.now);
  const mgr = await cashHandling.cashManager(db, deps.config);

  const from = first(window);
  const moves = (await cashHandling.getHistory(db, 200, null))
    .filter((h) => h.status !== "voided" && h.handedOnStr && h.handedOnStr >= from)
    .sort((a, b) => (a.handedOnStr < b.handedOnStr ? -1 : 1))
    .map((h) => ({
      dateStr: h.handedOnStr,
      from: h.fromName,
      to: h.toName,
      amount: h.amount,
      recordedBy: h.recordedByName,
      notes: h.notes || "",
    }));

  const movedByDay: Record<string, number> = {};
  moves.forEach((m) => {
    movedByDay[m.dateStr] = roundMoney((movedByDay[m.dateStr] || 0) + m.amount);
  });

  return {
    total: out.grandTotal,
    holders: out.holders.map((h) => ({
      name: h.name,
      total: h.total,
      shifts: h.shifts,
      oldest: h.oldest,
      oldestAge: h.oldestAge,
    })),
    stale: out.stale.map((s) => ({
      name: s.name,
      dateStr: s.dateStr,
      remaining: s.remaining,
      ageDays: s.ageDays,
    })),
    staleDays: out.staleDays,
    cashManager: mgr ? mgr.name : null,
    moves,
    movedTotal: roundMoney(moves.reduce((s, m) => s + m.amount, 0)),
    byDay: window.map((w) => ({ dateStr: w.key, movedIn: movedByDay[w.key] || 0 })),
  };
}

// ── Daily reconcile ────────────────────────────────────────

/**
 * One row per reconciliation in the window, newest first: claimed, measured, measured minus claimed.
 * A card figure nothing measured is null, never 0. (reconcileSection_)
 */
export async function reconcileSection(db: Db, _days: number, window: readonly WindowDay[]) {
  const from = first(window);
  const rows = ((await reconcile.getRecent(db, 200)) || [])
    .filter((r) => r.businessDate && r.businessDate >= from)
    .map((r) => ({
      dateStr: r.businessDate,
      companies: r.companies,
      cashClaimed: roundMoney(r.cashCounted - r.cashVariance),
      cashMeasured: roundMoney(r.cashCounted),
      cashVar: roundMoney(r.cashVariance),
      cardClaimed: roundMoney(r.cashierCard),
      cardMeasured: r.cloverCard == null ? null : roundMoney(r.cloverCard),
      cardVar: r.cloverCard == null ? null : roundMoney(r.cloverCard - r.cashierCard),
      status: r.status,
    }))
    .sort((a, b) => (a.dateStr < b.dateStr ? 1 : -1));

  if (!rows.length) return { rows: [], note: "Nothing reconciled in this window yet." };
  return {
    rows,
    okCount: rows.filter((r) => r.status === "OK").length,
    flagged: rows.filter((r) => r.status !== "OK").length,
  };
}

/** The whole recon payload. A failed section reports itself; only a window with no first day throws. (build_) */
export async function build(db: Db, daysIn: unknown, deps: PublicDeps) {
  const days = Number(daysIn) || DEFAULT_DAYS;
  const window = dayWindow(days, deps.now);
  return {
    days,
    fromStr: first(window),
    toStr: (window[window.length - 1] as WindowDay).key,
    generatedAt: formatDateTime(deps.now),
    reserve: await section(() => reserveSection(db, days, window, deps), "reserve", deps.log),
    cash: await section(() => cashSection(db, days, window, deps), "cash", deps.log),
    reconcile: await section(() => reconcileSection(db, days, window), "reconcile", deps.log),
  };
}

// ── Sales ──────────────────────────────────────────────────

/**
 * The sales dashboard for people with no login: aggregates only. The session rows are never carried
 * across (they name the cashier against the takings), and only one is asked for. (salesSection_)
 */
export async function salesSection(db: Db, days: number, deps: PublicDeps) {
  const end = todayMidnight(deps.now);
  const start = addDays(end, -(days - 1));
  // 23:59:59.000 Toronto, as `new Date(y, m, d, 23, 59, 59)`.
  const endOfDayAt = new Date(endOfDay(end).getTime() - 999);

  const d = await salesDashboard.getDashboard(db, { startDate: start, endDate: endOfDayAt, page: 1, pageSize: 1 }, { config: deps.config, now: deps.now });

  return {
    fromStr: formatDate(start),
    toStr: formatDate(end),
    totals: d.totals,
    companies: d.companies || [],
    sessionCount: d.totalCount || 0,
    daily: (d.daily || []).map((x) => ({
      dateStr: x.dateStr,
      total: x.total,
      sessionCount: x.sessionCount,
      byCompany: x.byCompany || {},
    })),
    insights: d.insights || null,
  };
}

/** The whole sales payload. Never throws: a failed section reports itself. (buildSales_) */
export async function buildSales(db: Db, daysIn: unknown, deps: PublicDeps) {
  const days = Number(daysIn) || DEFAULT_SALES_DAYS;
  return Object.assign({ days, generatedAt: formatDateTime(deps.now) }, await section(() => salesSection(db, days, deps), "sales", deps.log));
}
