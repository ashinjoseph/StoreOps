// What the page first asks for on every load: one person's view of the tills (the port of the body of
// _rpcGetMyShiftState in WebApp.gs, which rpcGetMyShiftState and rpcGetBootstrap both answer with).
// The public pages card can reuse these functions: each takes a Db first and never reads the clock.
//
// It composes ported modules and does nothing of its own to money: every figure is what
// till-sessions / cash-handling / sales return. Same as the old body, deliberately:
//   - openingFloat, expectedFloat, hoursWorked, variance read a blank as 0 (`x || 0`);
//   - varianceStatus blank reads as null; an attendance day with no start/end answers null for them;
//   - the lotto log and cash-in-hand are best-effort in the old code (an error there gives null, the
//     page hides the section). A database error is not swallowed here: inside a transaction it has
//     already ruined the call, so it is thrown.
//   - nothing returned is a Date: times are ISO strings, days are "YYYY-MM-DD".
// Queries: a fixed number whatever the data (none inside a loop): see the test pinning it.
import type { Db } from "../db/client";
import { DbError } from "../db/client";
import type { Config } from "../lib/config";
import { addDays, endOfDay, formatDate, todayMidnight } from "../lib/dates";
import * as attendance from "./attendance";
import * as cashHandling from "./cash-handling";
import * as sales from "./sales";
import * as staff from "./staff";
import * as tillSessions from "./till-sessions";

/** The two tills, in the order the page shows them. */
const COMPANIES = ["cstore", "vape"] as const;

export interface Caller {
  staffId: string;
  companiesAuthorized: readonly string[];
}
export interface ShiftDeps {
  config: Config;
  now: Date;
}

export interface TillCard {
  company: string;
  state: "closed" | "open_by_me" | "open_by_other";
  authorized: boolean;
  expectedFloat: number;
  cardSplit: boolean;
  detail: { sessionId: string; startTime: string | null; openingFloat: number } | { staffName: string; startTime: string | null } | null;
}
export interface TodaySummary {
  attendanceId: string;
  status: string;
  actualStart: string | null;
  actualEnd: string | null;
  hoursWorked: number;
  sessionsOpen: number;
  sessionsClosed: number;
}
export interface LottoSection {
  enabled: boolean;
  expected: number;
  lastCounted: number | null;
  lastCountedDate: string | null;
  diagnostic: unknown;
  entries: Array<{ date: string | null; staffName: string; counted: number; shortfall: number; topup: number; note: string }>;
}
export interface CashInHand {
  total: number;
  shifts: number;
  oldest: string;
  managerName: string | null;
}
export interface RecentSession {
  sessionId: string;
  company: string;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  variance: number;
  varianceStatus: string | null;
}
export interface ShiftState {
  today: string;
  cards: TillCard[];
  todaySummary: TodaySummary | null;
  lotto: LottoSection | null;
  cashInHand: CashInHand | null;
  recentTill: RecentSession[];
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** staff id to name, everyone active or not. (_staffNameMap) */
export async function staffNames(db: Db): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const s of await staff.getAll(db)) map[s.staffId] = s.name;
  return map;
}

/** A person's view of the tills today. (_rpcGetMyShiftState) */
export async function getMyShiftState(db: Db, who: Caller, deps: ShiftDeps): Promise<ShiftState> {
  const staffId = who.staffId;
  const today = todayMidnight(deps.now);

  // Names are read once, and only if something needs one.
  let names: Promise<Record<string, string>> | null = null;
  const nameMap = (): Promise<Record<string, string>> => (names ??= staffNames(db));

  // Per-company open session for me (if any); with two open on one till the last one listed wins.
  const myOpen = await tillSessions.getOpenForStaff(db, staffId);
  const openByCompany: Record<string, tillSessions.TillSessionRecord> = {};
  for (const s of myOpen) if (s && s.company) openByCompany[s.company] = s;

  // Who is holding each till (maybe someone else): the single open session or null.
  const cstoreOpen = await tillSessions.getOpenForCompany(db, "cstore");
  const vapeOpen = await tillSessions.getOpenForCompany(db, "vape");

  const att = await attendance.getForDateAndStaff(db, today, staffId);

  // Recent shifts: mine, closed or validated, the last 7 days (to the end of today), newest start first, ten.
  const sevenDaysAgo = addDays(today, -7);
  const allInRange = await tillSessions.getForDateRange(db, sevenDaysAgo, endOfDay(today));
  const recent = allInRange
    .filter((s) => s && s.staffId === staffId && (s.status === "closed" || s.status === "validated"))
    .sort((a, b) => (b.startTime ? b.startTime.getTime() : 0) - (a.startTime ? a.startTime.getTime() : 0))
    .slice(0, 10);

  const cards: TillCard[] = [];
  for (const company of COMPANIES) {
    const mine = openByCompany[company];
    const occupied = company === "cstore" ? cstoreOpen : vapeOpen;
    let state: TillCard["state"] = "closed";
    let detail: TillCard["detail"] = null;
    if (mine) {
      state = "open_by_me";
      detail = { sessionId: mine.sessionId, startTime: iso(mine.startTime), openingFloat: mine.openingFloat || 0 };
    } else if (occupied && occupied.staffId !== staffId) {
      state = "open_by_other";
      detail = { staffName: (await nameMap())[occupied.staffId] || occupied.staffId, startTime: iso(occupied.startTime) };
    }
    cards.push({
      company,
      state,
      authorized: who.companiesAuthorized.indexOf(company) !== -1,
      expectedFloat: tillSessions.getExpectedFloat(deps.config, company) || 0,
      cardSplit: sales.cardSplitFor(deps.config, company),
      detail,
    });
  }

  let todaySummary: TodaySummary | null = null;
  if (att) {
    const sessionsToday = await tillSessions.getForAttendance(db, att.attendanceId);
    todaySummary = {
      attendanceId: att.attendanceId,
      status: att.status,
      actualStart: iso(att.actualStart),
      actualEnd: iso(att.actualEnd),
      hoursWorked: att.hoursWorked || 0,
      sessionsOpen: sessionsToday.filter((s) => s.status === "open").length,
      sessionsClosed: sessionsToday.filter((s) => s.status === "closed" || s.status === "validated").length,
    };
  }

  // The lotto reserve log: every role sees it. Best-effort in the old code.
  let lotto: LottoSection | null = null;
  try {
    const log = await tillSessions.getLottoLog(db, 14, deps);
    const nm = await nameMap();
    lotto = {
      enabled: log.enabled,
      expected: log.expected,
      lastCounted: log.lastCounted,
      lastCountedDate: log.lastCountedDate,
      diagnostic: log.diagnostic || null,
      entries: log.entries.map((e) => ({ date: e.date, staffName: nm[e.staffId] || e.staffId, counted: e.counted, shortfall: e.shortfall, topup: e.topup, note: e.note })),
    };
  } catch (e) {
    if (e instanceof DbError) throw e;
  }

  // Cash this person still carries from closed shifts. Best-effort in the old code.
  let cashInHand: CashInHand | null = null;
  try {
    if (await cashHandling.sheetsExist(db)) {
      const o = await cashHandling.getOutstandingForStaff(db, staffId, deps.now);
      const mgr = await cashHandling.cashManager(db, deps.config);
      cashInHand = {
        total: o.totalOutstanding,
        shifts: o.unsettledSessions.length,
        oldest: o.unsettledSessions.length ? (o.unsettledSessions[0] as { dateStr: string }).dateStr : "",
        managerName: mgr ? mgr.name : null,
      };
    }
  } catch (e) {
    if (e instanceof DbError) throw e;
  }

  return {
    today: formatDate(today),
    cards,
    todaySummary,
    lotto,
    cashInHand,
    recentTill: recent.map((s) => ({
      sessionId: s.sessionId,
      company: s.company,
      date: s.date ? s.date : null,
      startTime: iso(s.startTime),
      endTime: iso(s.endTime),
      variance: s.closingVariance || 0,
      varianceStatus: s.varianceStatus || null,
    })),
  };
}
