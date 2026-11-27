// Till sessions: one till (cstore or vape), opened and closed by one person on one day. The port
// of src/TillSessions.gs, every function: the open, the close (which writes the sales row and
// completes the day's attendance), the admin edit, the readers other modules call, the lotto
// reserve log.
//
// Records have the field names and shapes TillSessions.gs rowToRecord_ returns, with these
// differences: no _rowIndex and no _lottoRaw (Sheet artefacts: a row number, and the raw cell kept
// for a diagnostic, which here reads the stored value instead); `date` is "YYYY-MM-DD" (a Date in
// the old app); startTime and endTime are Dates.
//
// Same as the old code, deliberately (each is in the card's report):
//   - every money field but lottoReserveCounted reads a blank as 0 (`numOrNull_(x) || 0`);
//   - an open session stores 0, not blank, in closing_cash_counted, cash_left_in_till,
//     cash_removed_at_close, expected_cash and closing_variance; a cstore one 0 in
//     lotto_reserve_counted and lotto_topup_from_till (a vape one blank there);
//   - the opening floats and lotto_reserve_default are `Number(setting) || 0` (an explicit 0 is 0;
//     junk is 0); the variance thresholds are `Number(setting) || default`.
//
// Where the new schema cannot hold what the old code stored, the call is refused with a plain
// message instead (orchestrator's ruling): an opening count or physical count that is not a
// finite number (the Sheet kept NaN). Figures the old code stored unrounded (the opening count,
// the configured float, the physical count) are rounded with roundMoney before they are written:
// identical for any figure in cents; a third decimal is not kept.
//
// Writes: in the caller's transaction (the router's: the close's session, sales row and attendance
// change together or not at all). The session row is locked (lockRow) before the close or the edit
// reads it; attendance.ts locks the attendance row it changes. Time is the call's `now`.
//
// Order: the Sheet listed sessions in the order they were opened. Lists here are
// `order by start_time, session_id`; where the old code broke a tie by row ("the lower row is the
// later close"), this breaks it by start_time, then session_id.
import type { Db } from "../db/client";
import { DbError } from "../db/client";
import { lockRow, type Tx } from "../db/tx";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import { addDays, endOfDay, formatDate, parseDate, todayMidnight, TZ } from "../lib/dates";
import { tillSessionId } from "../lib/ids";
import { formatMoney, roundMoney } from "../lib/money";
import * as attendance from "./attendance";
import * as notifier from "./notifier";
import * as sales from "./sales";
import * as staff from "./staff";

/** Only the convenience store sells lotto, so only its close asks about the reserve. */
export const LOTTO_COMPANY = "cstore";
const COMPANIES = ["cstore", "vape"];

export interface TillSessionRecord {
  sessionId: string;
  attendanceId: string;
  staffId: string;
  company: string;
  /** "YYYY-MM-DD", or null. (A Date in the old app.) */
  date: string | null;
  status: string;
  startTime: Date | null;
  endTime: Date | null;
  expectedOpening: number;
  openingFloat: number;
  openingNote: string;
  closingCashCounted: number;
  cashLeftInTill: number;
  cashRemovedAtClose: number;
  expectedCash: number;
  closingVariance: number;
  varianceStatus: string;
  notes: string;
  /** Blank is null here (not 0): a pot nobody counted. */
  lottoReserveCounted: number | null;
  lottoTopupFromTill: number;
  lottoReserveNote: string;
}

interface SessionRow {
  session_id: string;
  attendance_id: string;
  staff_id: string;
  company: string;
  date: string | null;
  status: string | null;
  start_time: Date | null;
  end_time: Date | null;
  expected_opening: number | null;
  opening_float: number | null;
  opening_note: string | null;
  closing_cash_counted: number | null;
  cash_left_in_till: number | null;
  cash_removed_at_close: number | null;
  expected_cash: number | null;
  closing_variance: number | null;
  variance_status: string | null;
  notes: string | null;
  lotto_reserve_counted: number | null;
  lotto_topup_from_till: number | null;
  lotto_reserve_note: string | null;
}

/** What the open, the close and the readers that need settings are given. */
export interface TillDeps {
  config: Config;
  now: Date;
}

const COLUMNS =
  "session_id, attendance_id, staff_id, company, date, status, start_time, end_time, expected_opening, opening_float, opening_note, closing_cash_counted, cash_left_in_till, cash_removed_at_close, expected_cash, closing_variance, variance_status, notes, lotto_reserve_counted, lotto_topup_from_till, lotto_reserve_note";
const ORDER = `order by start_time nulls last, session_id collate "C"`;
const trimmed = (v: string | null): string => (v || "").toString().trim();
const num0 = (v: number | null): number => Number(v) || 0;
const text = (v: string | null): string => (v || "").toString();
/** A text cell: '' is blank (NULL). */
const cell = (v: unknown): string | null => (v === "" || v === null || v === undefined ? null : String(v));

function toRecord(r: SessionRow): TillSessionRecord {
  return {
    sessionId: trimmed(r.session_id),
    attendanceId: trimmed(r.attendance_id),
    staffId: trimmed(r.staff_id),
    company: trimmed(r.company),
    date: r.date,
    status: trimmed(r.status) || "open",
    startTime: r.start_time,
    endTime: r.end_time,
    expectedOpening: num0(r.expected_opening),
    openingFloat: num0(r.opening_float),
    openingNote: text(r.opening_note),
    closingCashCounted: num0(r.closing_cash_counted),
    cashLeftInTill: num0(r.cash_left_in_till),
    cashRemovedAtClose: num0(r.cash_removed_at_close),
    expectedCash: num0(r.expected_cash),
    closingVariance: num0(r.closing_variance),
    varianceStatus: text(r.variance_status),
    notes: text(r.notes),
    lottoReserveCounted: r.lotto_reserve_counted === null ? null : Number(r.lotto_reserve_counted),
    lottoTopupFromTill: num0(r.lotto_topup_from_till),
    lottoReserveNote: text(r.lotto_reserve_note),
  };
}

/** A money figure to store: rounded here, never by the database; refused when it is not a finite number. */
function stored(name: string, v: number): number {
  if (!Number.isFinite(v)) throw new Error(name + " is not a number");
  return roundMoney(v);
}

const isClosed = (s: Pick<TillSessionRecord, "status">): boolean => {
  const st = (s.status || "").toLowerCase();
  return st === "closed" || st === "validated";
};

// ── Settings ───────────────────────────────────────────────

/** The float a till opens and closes with: `Number(setting) || 0`, default 250 (cstore) / 100. (TillSessions.getExpectedFloat) */
export function getExpectedFloat(config: Config, company: string): number {
  return company === "cstore" ? Number(config.value("cstore_default_opening_float", "250")) || 0 : Number(config.value("vape_default_opening_float", "100")) || 0;
}

/** The lotto pot's expected balance: `Number(setting) || 0`, default 500. (TillSessions.getLottoExpected) */
export function getLottoExpected(config: Config): number {
  return Number(config.value("lotto_reserve_default", "500")) || 0;
}

/** |variance| ≤ ok (default 1) → OK; ≤ minor (default 30) → minor; else investigate. (TillSessions.getVarianceStatus) */
export function getVarianceStatus(config: Config, variance: number): "OK" | "minor" | "investigate" {
  const ok = Number(config.value("variance_ok_threshold", "1")) || 1;
  const minor = Number(config.value("variance_minor_threshold", "30")) || 30;
  const abs = Math.abs(variance);
  if (abs <= ok) return "OK";
  if (abs <= minor) return "minor";
  return "investigate";
}

// ── Reads ──────────────────────────────────────────────────

/** Every session. (TillSessions.getAll) */
export async function getAll(db: Db): Promise<TillSessionRecord[]> {
  const rows = await db.query<SessionRow>(`select ${COLUMNS} from ops.till_sessions ${ORDER}`);
  return rows.map(toRecord).filter((s) => s.sessionId);
}

/** One session by id, or null. (TillSessions.getById) */
export async function getById(db: Db, sessionId: unknown): Promise<TillSessionRecord | null> {
  if (typeof sessionId !== "string") return null;
  const row = await db.maybeOne<SessionRow>(`select ${COLUMNS} from ops.till_sessions where session_id = $1`, [sessionId]);
  return row ? toRecord(row) : null;
}

/** Every session of one attendance day, i.e. of one person on one day. (TillSessions.getForAttendance) */
export async function getForAttendance(db: Db, attendanceId: string): Promise<TillSessionRecord[]> {
  if (typeof attendanceId !== "string") return [];
  const rows = await db.query<SessionRow>(`select ${COLUMNS} from ops.till_sessions where attendance_id = $1 ${ORDER}`, [attendanceId]);
  return rows.map(toRecord);
}

/** The first open session of a till, or null. (TillSessions.getOpenForCompany) */
export async function getOpenForCompany(db: Db, company: string): Promise<TillSessionRecord | null> {
  const rows = await db.query<SessionRow>(`select ${COLUMNS} from ops.till_sessions where company = $1 and status = 'open' ${ORDER} limit 1`, [String(company)]);
  return rows[0] ? toRecord(rows[0]) : null;
}

/** A person's open sessions. (TillSessions.getOpenForStaff) */
export async function getOpenForStaff(db: Db, staffId: string): Promise<TillSessionRecord[]> {
  if (typeof staffId !== "string") return [];
  const rows = await db.query<SessionRow>(`select ${COLUMNS} from ops.till_sessions where staff_id = $1 and status = 'open' ${ORDER}`, [staffId]);
  return rows.map(toRecord);
}

/**
 * Sessions from `start` to `end` inclusive (a session counts when its Toronto midnight is not before
 * `start` and not after `end`), optionally one till's. A blank bound gives []; an unreadable one is
 * no bound (the old comparisons with it were all false). (TillSessions.getForDateRange)
 */
export async function getForDateRange(db: Db, startDate: Date | string, endDate: Date | string, filterCompany?: string | null): Promise<TillSessionRecord[]> {
  const start = startDate instanceof Date ? startDate : parseDate(startDate);
  const end = endDate instanceof Date ? endDate : parseDate(endDate);
  if (!start || !end) return [];
  const where: string[] = ["date is not null"];
  const params: unknown[] = [];
  if (!Number.isNaN(start.getTime())) {
    const first = formatDate(start);
    const midnight = parseDate(first) as Date;
    params.push(midnight.getTime() >= start.getTime() ? first : formatDate(addDays(midnight, 1)));
    where.push(`date >= $${params.length}`);
  }
  if (!Number.isNaN(end.getTime())) {
    params.push(formatDate(end));
    where.push(`date <= $${params.length}`);
  }
  if (filterCompany) {
    params.push(String(filterCompany));
    where.push(`company = $${params.length}`);
  }
  const rows = await db.query<SessionRow>(`select ${COLUMNS} from ops.till_sessions where ${where.join(" and ")} ${ORDER}`, params);
  return rows.map(toRecord);
}

/** When a session really ended: end_time, else its Toronto midnight, else 0. */
const closeKey = (s: TillSessionRecord): number => (s.endTime ? s.endTime.getTime() : s.date ? (parseDate(s.date) as Date).getTime() : 0);

/** Newest close first; a tie goes to the later-started session, then the larger id. (byCloseTimeDesc_) */
function byCloseTimeDesc(a: TillSessionRecord, b: TillSessionRecord): number {
  const diff = closeKey(b) - closeKey(a);
  if (diff) return diff;
  const sd = (b.startTime ? b.startTime.getTime() : 0) - (a.startTime ? a.startTime.getTime() : 0);
  if (sd) return sd;
  return a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0;
}

/**
 * What the pot held when it was last counted (the previous close's count for the lotto till):
 * the newest closed cstore session with a count, unwindowed. Null when nothing was ever counted.
 * (TillSessions.lastReserveCount_)
 */
export async function lastReserveCount(db: Db): Promise<{ counted: number; date: string | null } | null> {
  const row = await db.maybeOne<SessionRow>(
    `select ${COLUMNS} from ops.till_sessions
      where company = $1 and lower(status) in ('closed', 'validated') and lotto_reserve_counted is not null
      order by coalesce(end_time, date::timestamp at time zone $2) desc nulls last, start_time desc nulls last, session_id collate "C" desc
      limit 1`,
    [LOTTO_COMPANY, TZ],
  );
  if (!row) return null;
  const last = toRecord(row);
  return { counted: roundMoney(last.lottoReserveCounted), date: last.date };
}

// ── The open ───────────────────────────────────────────────

export interface OpenInput {
  staffId?: unknown;
  company?: unknown;
  openingCount?: unknown;
  openingNote?: unknown;
  notes?: unknown;
  actorId?: unknown;
}

/** The notify call's dependencies: notify writes an audit row and sends nothing. */
function notifyDeps(db: Db, deps: TillDeps): notifier.NotifierDeps {
  const noFetch = (() => Promise.reject(new Error("notify sends nothing"))) as unknown as typeof fetch;
  return { config: deps.config, env: {}, fetch: noFetch, db, now: deps.now };
}

/**
 * Open a till: refuse a till already open, a second shift of the same person on the same till the
 * same day, and a counted float off by more than a cent with no note; get or create today's
 * attendance; write the session; audit and notify. Returns the session. (TillSessions.open)
 */
export async function open(db: Tx, input: OpenInput, deps: TillDeps): Promise<TillSessionRecord | null> {
  if (!input.staffId) throw new Error("staffId required");
  if (!input.actorId) throw new Error("actorId required");
  if (!input.company || !COMPANIES.includes(input.company as string)) throw new Error("Invalid company: " + String(input.company));
  if (typeof input.openingCount !== "number" || input.openingCount < 0) throw new Error("openingCount must be a non-negative number");
  const openingCount = input.openingCount;
  const company = input.company as string;
  const actorId = String(input.actorId);

  const person = typeof input.staffId === "string" ? await staff.getById(db, input.staffId) : null;
  if (!person) throw new Error("Staff not found: " + String(input.staffId));
  const staffId = input.staffId as string;
  if (!person.companiesAuthorized.includes(company)) throw new Error(person.name + " is not authorized for " + company);

  // One open at a time per till. Two requests at once would otherwise both find no open session
  // and both insert one (different people, so different ids, and nothing else stops it). The lock
  // is released when this transaction ends; the second request then sees the first one's session.
  await db.query("select pg_advisory_xact_lock(hashtextextended('ops.till.open:' || $1, 0))", [company]);

  const existingOpen = await getOpenForCompany(db, company);
  if (existingOpen) throw new Error(company + " already has an open shift (" + existingOpen.sessionId + " by " + existingOpen.staffId + ")");

  const now = deps.now;
  const today = todayMidnight(now);
  const sessionId = tillSessionId(today, staffId, company);
  const sameDay = await getById(db, sessionId);
  if (sameDay) {
    throw new Error(
      person.name + " already has a " + company + " shift today (" + sessionId + ", " + sameDay.status + "). One shift per person per till " + "per day — an admin can edit that session instead.",
    );
  }

  const expectedFloat = getExpectedFloat(deps.config, company);
  if (Math.abs(openingCount - expectedFloat) > 0.01 && !input.openingNote) {
    throw new Error("Float mismatch (counted " + openingCount + ", expected " + expectedFloat + "). Please provide an opening note.");
  }
  // The old code stored NaN here; the schema cannot (ruling: refuse with a plain message).
  const openingFloat = stored("openingCount", openingCount);
  const expectedOpening = stored("expected opening float", expectedFloat);

  const day = await attendance.openOrPromote(db, staffId, today, actorId, now);

  // Non-lotto tills get blanks, not zeros, in the lotto columns.
  const lotto = company === LOTTO_COMPANY ? [0, 0] : [null, null];
  await db.query(
    `insert into ops.till_sessions (${COLUMNS})
     values ($1, $2, $3, $4, $5, 'open', $6, null, $7, $8, $9, 0, 0, 0, 0, 0, null, $10, $11, $12, null)`,
    [sessionId, day.attendanceId, staffId, company, formatDate(today), now, expectedOpening, openingFloat, cell(input.openingNote || ""), cell(input.notes || ""), lotto[0], lotto[1]],
  );

  await audit.write(
    db,
    { actorId, action: "till.open", targetType: "till_sessions", targetId: sessionId, after: { staffId, company, openingFloat: openingCount, attendanceId: day.attendanceId } },
    { now },
  );
  await notifier.notify(notifyDeps(db, deps), "shift.opened", { staffId, staffName: person.name, company, sessionId, openingFloat: openingCount } as notifier.NotifyPayload);

  return getById(db, sessionId);
}

// ── The close ──────────────────────────────────────────────

export interface CloseInput {
  sessionId?: unknown;
  actorId?: unknown;
  cashSales?: unknown;
  creditCard?: unknown;
  debitCard?: unknown;
  cashback?: unknown;
  hstCollected?: unknown;
  bottleDeposit?: unknown;
  roundOff?: unknown;
  miscCash?: unknown;
  miscCredit?: unknown;
  miscDebit?: unknown;
  miscNotes?: unknown;
  cardTotal?: unknown;
  miscCard?: unknown;
  physicalCount?: unknown;
  lottoCounted?: unknown;
  lottoTopupFromTill?: unknown;
  lottoNote?: unknown;
  notes?: unknown;
}

export interface CloseResult {
  session: TillSessionRecord | null;
  expectedCash: number;
  counted: number;
  variance: number;
  cashRemoved: number;
  floatLeft: number;
  varianceStatus: string;
  lottoReserveCounted: number | null;
  lottoReserveShort: number;
  lottoTopupFromTill: number;
  reserveFedToTill: number;
}

/** What closeFigures is given: the till, what the drawer started and ends with, the pot's previous count, and the figures entered. */
export interface CloseFiguresInput {
  company: string;
  /** The float counted at the open (the session's opening_float). */
  openingFloat: number;
  /** The float left in the drawer for the next shift (the close: getExpectedFloat). */
  floatAmount: number;
  /** The pot's expected balance (getLottoExpected). */
  lottoExpected: number;
  /** The pot's count at the previous close, or null when none was ever counted. */
  prevReserveCounted: number | null;
  physicalCount: unknown;
  cashSales?: unknown;
  creditCard?: unknown;
  debitCard?: unknown;
  cashback?: unknown;
  hstCollected?: unknown;
  bottleDeposit?: unknown;
  roundOff?: unknown;
  miscCash?: unknown;
  miscCredit?: unknown;
  miscDebit?: unknown;
  miscNotes?: unknown;
  cardTotal?: unknown;
  miscCard?: unknown;
  /** The lotto till's count as the caller reads it (the close reads a blank as lottoExpected first); null: not counted. Ignored on other tills. */
  lottoCounted: number | null;
  lottoTopupFromTill?: unknown;
  lottoNote?: unknown;
}

/** Every figure a close stores, worked out from what was entered. */
export interface CloseFigures {
  lottoOn: boolean;
  /** Unrounded; 0 on a till with no pot; null when not counted. */
  lottoCounted: number | null;
  lottoTopup: number;
  lottoNote: string;
  reserveFed: number;
  /** The sales row's figures (without its ids), as sales.write takes them: the shape follows what was sent. */
  sales: Omit<sales.SalesInput, "sessionId" | "staffId" | "company" | "date">;
  /** Unrounded (the session stores roundMoney of it). */
  expectedCash: number;
  countStored: number;
  floatStored: number;
  variance: number;
  cashRemoved: number;
  varianceStatus: "OK" | "minor" | "investigate";
}

/**
 * The close's arithmetic, with no database: turns the entered figures into every figure the close
 * stores, refusing what the close refuses, in the close's order. `close` calls it; so does a till
 * correction (modules/till-corrections.ts), so the two cannot drift.
 *
 *   reserveFed   = previous count − this count                 (cstore; 0 with no previous count)
 *   expectedCash = openingFloat + cashSales + miscCash − cashback + reserveFed
 *   variance     = roundMoney(physicalCount − expectedCash)
 *   cashRemoved  = roundMoney(physicalCount − float − lottoTopup)
 */
export function closeFigures(config: Config, f: CloseFiguresInput): CloseFigures {
  if (typeof f.physicalCount !== "number" || f.physicalCount < 0) throw new Error("physicalCount required (non-negative number)");
  const physicalCount = f.physicalCount;
  const company = f.company;

  // ── Lotto reserve (cstore only) ──
  const lottoOn = company === LOTTO_COMPANY;
  const lottoCounted = lottoOn ? f.lottoCounted : 0;
  const lottoTopup = lottoOn ? Math.max(0, Number(f.lottoTopupFromTill) || 0) : 0;
  const lottoNote = lottoOn ? String(f.lottoNote || "").trim() : "";

  if (lottoOn && lottoCounted !== null && Math.abs(lottoCounted - f.lottoExpected) > 0.01 && !lottoNote) {
    throw new Error("Lotto reserve counted " + lottoCounted + ", expected " + f.lottoExpected + ". Please provide a reason.");
  }

  // What the pot fed the drawer: derived from the two counts (ADR-0008).
  const reserveFed = f.prevReserveCounted !== null && lottoCounted !== null && lottoOn ? roundMoney(f.prevReserveCounted - lottoCounted) : 0;

  // One card shape per row (ADR-0005).
  const sentSplit = f.creditCard != null || f.debitCard != null || f.miscCredit != null || f.miscDebit != null;
  const sentTotal = f.cardTotal != null || f.miscCard != null;
  if (sentSplit && sentTotal) {
    throw new Error("Close for " + company + " sent both a credit/debit split and a " + "single card total. Send one shape — check " + company + "_card_split.");
  }

  const salesInput: CloseFigures["sales"] = {
    cashSales: Number(f.cashSales) || 0,
    creditCardSales: Number(f.creditCard) || 0,
    debitCardSales: Number(f.debitCard) || 0,
    cashbackPaid: Number(f.cashback) || 0,
    hstCollected: Number(f.hstCollected) || 0,
    bottleDeposit: Number(f.bottleDeposit) || 0,
    roundOff: Number(f.roundOff) || 0,
    miscCashSales: Number(f.miscCash) || 0,
    miscCreditSales: Number(f.miscCredit) || 0,
    miscDebitSales: Number(f.miscDebit) || 0,
    miscNotes: f.miscNotes || "",
  };
  if (sentTotal) {
    salesInput.cardTotalSales = Number(f.cardTotal) || 0;
    salesInput.miscCardSales = Number(f.miscCard) || 0;
    salesInput.creditCardSales = 0;
    salesInput.debitCardSales = 0;
    salesInput.miscCreditSales = 0;
    salesInput.miscDebitSales = 0;
  }
  const cashSales = salesInput.cashSales as number;
  const miscCashSales = salesInput.miscCashSales as number;
  const cashbackPaid = salesInput.cashbackPaid as number;

  // A negative cash_sales is only meaningful where a lotto pot can explain it (ADR-0006).
  if (cashSales < 0 && !lottoOn) {
    throw new Error("Cash sales cannot be negative on " + company + " — there is no lotto reserve on this till to fund a payout.");
  }

  const expectedCash = f.openingFloat + cashSales + miscCashSales - cashbackPaid + reserveFed;

  if (expectedCash < -0.005) {
    throw new Error(
      "Expected cash works out to " +
        formatMoney(expectedCash) +
        ", which no drawer can hold. Cash paid out exceeds what was in the " +
        "till — check the lotto reserve count, since cash drawn from the pot " +
        "is what covers the difference.",
    );
  }
  // The old code stored NaN for an unreadable count; the schema cannot (ruling: refuse).
  const countStored = stored("physicalCount", physicalCount);
  const floatStored = stored("float", f.floatAmount);

  const variance = roundMoney(physicalCount - expectedCash);
  const cashRemoved = roundMoney(physicalCount - f.floatAmount - lottoTopup);
  const varianceStatus = getVarianceStatus(config, variance);

  return { lottoOn, lottoCounted, lottoTopup, lottoNote, reserveFed, sales: salesInput, expectedCash, countStored, floatStored, variance, cashRemoved, varianceStatus };
}

/** A plain Error (the old code caught these around Attendance.complete); a database fault is never one. */
const isPlainError = (e: unknown): e is Error => e instanceof Error && !(e instanceof DbError) && Object.getPrototypeOf(e) === Error.prototype;

/**
 * Close a till: write the sales row, the session's closing figures and, when it was the person's
 * last open till that day, complete the attendance. (TillSessions.close)
 *
 *   reserveFed   = previous count − this count                 (cstore; 0 with no previous count)
 *   expectedCash = openingFloat + cashSales + miscCash − cashback + reserveFed
 *   variance     = roundMoney(physicalCount − expectedCash)
 *   cashRemoved  = roundMoney(physicalCount − float − lottoTopup)
 */
export async function close(db: Tx, input: CloseInput, deps: TillDeps): Promise<CloseResult> {
  if (!input.sessionId) throw new Error("sessionId required");
  if (!input.actorId) throw new Error("actorId required");
  if (typeof input.physicalCount !== "number" || input.physicalCount < 0) throw new Error("physicalCount required (non-negative number)");
  const physicalCount = input.physicalCount;
  const actorId = String(input.actorId);
  const now = deps.now;

  if (typeof input.sessionId === "string") await lockRow(db, "till_sessions", input.sessionId);
  const session = await getById(db, input.sessionId);
  if (!session) throw new Error("Session not found: " + String(input.sessionId));
  if (session.status !== "open") throw new Error("Session is not open (status: " + session.status + ")");

  // Only the cashier who opened, OR an admin/manager, can close
  if (session.staffId !== actorId) {
    const actor = await staff.getById(db, actorId);
    if (!actor || (actor.role !== "admin" && actor.role !== "manager")) {
      throw new Error("Only " + session.staffId + " or an admin/manager can close this session");
    }
  }

  const floatAmount = getExpectedFloat(deps.config, session.company);

  // ── Lotto reserve (cstore only) ──
  const lottoOn = session.company === LOTTO_COMPANY;
  const lottoExpected = getLottoExpected(deps.config);
  // The page sends no count when it did not ask: read as "still at the expected balance".
  const lottoCountedIn = lottoOn ? (input.lottoCounted == null ? lottoExpected : Number(input.lottoCounted) || 0) : 0;
  // What the pot held at the previous close: what this close's count is measured against (ADR-0008).
  const prevReserve = lottoOn ? await lastReserveCount(db) : null;

  // Every figure the close stores, from the figures entered (shared with till corrections).
  const f = closeFigures(deps.config, {
    company: session.company,
    openingFloat: session.openingFloat,
    floatAmount,
    lottoExpected,
    prevReserveCounted: prevReserve ? prevReserve.counted : null,
    physicalCount,
    cashSales: input.cashSales,
    creditCard: input.creditCard,
    debitCard: input.debitCard,
    cashback: input.cashback,
    hstCollected: input.hstCollected,
    bottleDeposit: input.bottleDeposit,
    roundOff: input.roundOff,
    miscCash: input.miscCash,
    miscCredit: input.miscCredit,
    miscDebit: input.miscDebit,
    miscNotes: input.miscNotes,
    cardTotal: input.cardTotal,
    miscCard: input.miscCard,
    lottoCounted: lottoCountedIn,
    lottoTopupFromTill: input.lottoTopupFromTill,
    lottoNote: input.lottoNote,
  });
  const lottoCounted = f.lottoCounted as number;
  const { lottoTopup, lottoNote, reserveFed, expectedCash, countStored, variance, cashRemoved, varianceStatus } = f;

  await sales.write(db, { sessionId: session.sessionId, staffId: session.staffId, company: session.company, date: session.date, ...f.sales }, actorId, now);

  const sets = [
    "status = 'closed'",
    "end_time = $2",
    "closing_cash_counted = $3",
    "cash_left_in_till = $4",
    "cash_removed_at_close = $5",
    "expected_cash = $6",
    "closing_variance = $7",
    "variance_status = $8",
  ];
  const params: unknown[] = [session.sessionId, now, countStored, f.floatStored, cashRemoved, roundMoney(expectedCash), variance, varianceStatus];
  if (input.notes) {
    params.push(String(input.notes));
    sets.push(`notes = $${params.length}`);
  }
  if (lottoOn) {
    params.push(roundMoney(lottoCounted), roundMoney(lottoTopup), cell(lottoNote));
    sets.push(`lotto_reserve_counted = $${params.length - 2}`, `lotto_topup_from_till = $${params.length - 1}`, `lotto_reserve_note = $${params.length}`);
  }
  await db.query(`update ops.till_sessions set ${sets.join(", ")} where session_id = $1`, params);

  await audit.write(
    db,
    {
      actorId,
      action: "till.close",
      targetType: "till_sessions",
      targetId: session.sessionId,
      after: {
        physicalCount,
        expectedCash: roundMoney(expectedCash),
        variance,
        varianceStatus,
        reserveFedToTill: lottoOn ? reserveFed : null,
        lottoReserveCounted: lottoOn ? roundMoney(lottoCounted) : null,
        lottoTopupFromTill: lottoOn ? roundMoney(lottoTopup) : null,
        lottoReserveNote: lottoNote,
      },
    },
    { now },
  );

  const owner = await staff.getById(db, session.staffId);
  await notifier.notify(notifyDeps(db, deps), "shift.closed", {
    staffId: session.staffId,
    staffName: owner ? owner.name : undefined,
    company: session.company,
    sessionId: session.sessionId,
    variance,
    lottoReserveCounted: lottoOn ? roundMoney(lottoCounted) : null,
    lottoTopupFromTill: lottoOn ? roundMoney(lottoTopup) : 0,
    cashInHand: cashRemoved,
  } as notifier.NotifyPayload);

  // The person's last open till that day completes the attendance.
  const siblings = await getForAttendance(db, session.attendanceId);
  const stillOpen = siblings.filter((s) => s.status === "open" && s.sessionId !== session.sessionId);
  if (stillOpen.length === 0) {
    try {
      await attendance.complete(db, session.attendanceId, now, actorId);
    } catch (e) {
      // The old code logged a refusal here and did not fail the close. A database fault is not a
      // refusal: it is rethrown, and the router rolls the whole close back.
      if (!isPlainError(e)) throw e;
    }
  }

  return {
    session: await getById(db, session.sessionId),
    expectedCash: roundMoney(expectedCash),
    counted: physicalCount,
    variance,
    cashRemoved,
    floatLeft: floatAmount,
    varianceStatus,
    lottoReserveCounted: lottoOn ? roundMoney(lottoCounted) : null,
    lottoReserveShort: lottoOn ? roundMoney(lottoExpected - lottoCounted) : 0,
    lottoTopupFromTill: lottoOn ? roundMoney(lottoTopup) : 0,
    reserveFedToTill: lottoOn ? reserveFed : 0,
  };
}

// ── The admin edit ─────────────────────────────────────────

export interface EditInput {
  sessionId?: unknown;
  actorId?: unknown;
  openingFloat?: unknown;
  closingCashCounted?: unknown;
  notes?: unknown;
}

/**
 * Admin or manager: change the opening float, the closing count or the notes of a session, and
 * recompute expected cash, variance and cash removed when it has a sales row. The recompute leaves
 * out what the pot fed the drawer (as the old code did). (TillSessions.edit)
 */
export async function edit(db: Tx, input: EditInput, deps: TillDeps): Promise<TillSessionRecord | null> {
  if (!input.sessionId) throw new Error("sessionId required");
  if (!input.actorId) throw new Error("actorId required");
  const actorId = String(input.actorId);
  const actor = await staff.getById(db, actorId);
  if (!actor || (actor.role !== "admin" && actor.role !== "manager")) throw new Error("Only admin/manager can edit closed sessions");
  if (typeof input.sessionId === "string") await lockRow(db, "till_sessions", input.sessionId);
  const session = await getById(db, input.sessionId);
  if (!session) throw new Error("Session not found: " + String(input.sessionId));

  const before = { openingFloat: session.openingFloat, closingCashCounted: session.closingCashCounted, notes: session.notes };
  if (input.openingFloat != null) {
    await db.query("update ops.till_sessions set opening_float = $2 where session_id = $1", [session.sessionId, stored("openingFloat", Number(input.openingFloat))]);
  }
  if (input.closingCashCounted != null) {
    await db.query("update ops.till_sessions set closing_cash_counted = $2 where session_id = $1", [session.sessionId, stored("closingCashCounted", Number(input.closingCashCounted))]);
  }
  if (input.notes != null) await db.query("update ops.till_sessions set notes = $2 where session_id = $1", [session.sessionId, cell(input.notes)]);

  const updated = (await getById(db, session.sessionId)) as TillSessionRecord;
  const salesRow = await sales.getForSession(db, updated.sessionId);
  if (salesRow) {
    const expected = updated.openingFloat + salesRow.cashSales + salesRow.miscCashSales - salesRow.cashbackPaid;
    const variance = roundMoney(updated.closingCashCounted - expected);
    await db.query("update ops.till_sessions set expected_cash = $2, closing_variance = $3, variance_status = $4, cash_removed_at_close = $5 where session_id = $1", [
      session.sessionId,
      roundMoney(expected),
      variance,
      getVarianceStatus(deps.config, variance),
      roundMoney(updated.closingCashCounted - getExpectedFloat(deps.config, updated.company) - (updated.lottoTopupFromTill || 0)),
    ]);
  }

  await audit.write(
    db,
    {
      actorId,
      action: "till.edit",
      targetType: "till_sessions",
      targetId: session.sessionId,
      before,
      after: { openingFloat: input.openingFloat, closingCashCounted: input.closingCashCounted, notes: input.notes },
    },
    { now: deps.now },
  );
  return getById(db, session.sessionId);
}

// ── The lotto reserve log ──────────────────────────────────

export interface LottoLogEntry {
  sessionId: string;
  date: string | null;
  staffId: string;
  counted: number;
  shortfall: number;
  topup: number;
  note: string;
}

/**
 * One entry per closed cstore session with a count over the last `days` (default 14), newest close
 * first; `lastCounted` is the last count ever, unwindowed. (TillSessions.getLottoLog)
 */
export async function getLottoLog(db: Db, days: unknown, deps: TillDeps) {
  const expected = getLottoExpected(deps.config);
  const today = todayMidnight(deps.now);
  const from = addDays(today, -(Number(days) || 14));
  const entries: LottoLogEntry[] = (await getForDateRange(db, from, endOfDay(today), LOTTO_COMPANY))
    .filter((s) => isClosed(s) && s.lottoReserveCounted != null)
    .sort(byCloseTimeDesc)
    .map((s) => ({
      sessionId: s.sessionId,
      date: s.date,
      staffId: s.staffId,
      counted: roundMoney(s.lottoReserveCounted),
      shortfall: roundMoney(expected - (s.lottoReserveCounted as number)),
      topup: roundMoney(s.lottoTopupFromTill),
      note: s.lottoReserveNote,
    }));
  const last = await lastReserveCount(db);
  return {
    enabled: true,
    expected,
    lastCounted: last ? last.counted : null,
    lastCountedDate: last ? last.date : null,
    diagnostic: last ? null : await reserveDiagnostic(db),
    entries,
  };
}

/** Why lastReserveCount found nothing: how far down the funnel the rows got, and what the newest closed cstore session holds. */
async function reserveDiagnostic(db: Db) {
  const all = await getAll(db);
  const cstore = all.filter((s) => s.company === LOTTO_COMPANY);
  const closed = cstore.filter(isClosed);
  const newest = closed.slice().sort(byCloseTimeDesc)[0];
  let cellText: string | null = null;
  if (newest) {
    const raw = newest.lottoReserveCounted;
    // A blank cell read as '' (a string) in the old app.
    cellText = raw === null ? "blank (string)" : JSON.stringify(raw) + " (number)";
  }
  return {
    sessions: all.length,
    cstore: cstore.length,
    closed: closed.length,
    withCount: closed.filter((s) => s.lottoReserveCounted != null).length,
    newestSession: newest ? newest.sessionId : null,
    newestCell: cellText,
  };
}
