// Missed shifts: an admin enters a shift that was worked but never opened or closed in the app (card
// P4-12b). NEW in the Operations app (ADR-0023): in the Apps Script app an admin typed the rows into
// the till_sessions, sales and attendance tabs by hand (the first import of real data found such
// rows), so there is nothing to port and nothing for the parity harness to compare; the unit tests in
// ops/test/missed-shifts.test.ts are the specification.
//
// An entry writes what an open followed by a close would have left: the till session (closed), its
// sales row and the person's attendance for the day, together, in the router's one transaction. Every
// derived figure comes from till-sessions.ts closeFigures, the function `close` calls; the entered
// figures are read by till-corrections.ts's own helpers (blank is NULL, never 0: ADR-0004). What a
// close takes from settings or history:
//   - the float left in the drawer (and the expected opening) is the setting in force now: nothing
//     records the one in force that day, and the answer says so;
//   - the pot's previous count is the count of the cstore close immediately before this shift's end;
//     the answer names the next cstore close after it, whose expected cash was measured without it;
//   - the variance thresholds and the pot's expected balance are today's settings.
//
// Differences from a real open and close, on purpose: a blank figure is stored NULL (the close writes
// 0); a blank reserve count is "not counted" (the close reads it as the expected balance); a blank
// current rate is stored NULL on a new day (the close writes 0); no opening note is asked for (the
// reason covers a float that differs from the setting); the notes end "Entered after the fact:
// <reason>". Nothing is sent: no WhatsApp message, no Clover call, no reconcile.
//
// Locks, in this order, inside the router's one transaction: the person's staff row (payments,
// schedule corrections and cash handovers lock it first too), then the till's advisory lock (the one
// `open` takes, so an entry and an open of that till are serialised and the second sees the first),
// then the day's attendance row. The preview takes no lock and writes nothing.
//
// Never touched: payments, payment items, bonuses, cash handovers, commission runs, reconcile
// results, other sessions. Nothing is deleted. A worked day's hours are never changed.
import type { Db } from "../db/client";
import { lockRow, type Tx } from "../db/tx";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import { diffHours, formatDate, parseDate, TZ, wallClock } from "../lib/dates";
import { attendanceId, tillSessionId } from "../lib/ids";
import { roundMoney } from "../lib/money";
import * as attendance from "./attendance";
import { dayValue, daysBetween, NOTES_CAP, readInstant, realDay } from "./attendance-corrections";
import * as tc from "./till-corrections";
import * as tillSessions from "./till-sessions";

/** How far back a shift can be entered. */
export const MAX_DAYS_BACK = 370;
/** A shift may start this long before its business date's Toronto midnight or after the next one. */
const EDGE_MS = 6 * 3_600_000;
const MAX_SPAN_MS = 24 * 3_600_000;
const COMPANIES = ["cstore", "vape"];

export const TODAY_REFUSAL = "Open and close today's till on the Shift screen.";
export const FUTURE_REFUSAL = "A shift cannot be entered for a day that has not happened yet.";
export const AGE_REFUSAL = `Cannot enter a shift from more than ${MAX_DAYS_BACK} days ago.`;

export interface MissedShiftInput {
  staffId?: unknown;
  company?: unknown;
  date?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  openingFloat?: unknown;
  closingCashCounted?: unknown;
  cashSales?: unknown;
  creditCardSales?: unknown;
  debitCardSales?: unknown;
  cardTotalSales?: unknown;
  miscCashSales?: unknown;
  miscCreditSales?: unknown;
  miscDebitSales?: unknown;
  miscCardSales?: unknown;
  miscNotes?: unknown;
  lottoReserveCounted?: unknown;
  lottoTopupFromTill?: unknown;
  lottoReserveNote?: unknown;
  notes?: unknown;
  reason?: unknown;
}

/** The day's attendance as the sheet shows it: blanks are null, instants ISO strings. */
export interface AttendanceView {
  attendanceId: string;
  staffId: string;
  date: string;
  status: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  hoursWorked: number | null;
  rateAtAttendance: number | null;
  hoursBasis: string | null;
  notes: string | null;
  /** hours x rate, rounded; null when either is blank (never 0 for a blank rate). */
  owed: number | null;
}

export interface OtherTillSession {
  sessionId: string;
  company: string;
  status: string;
  startTime: string | null;
  endTime: string | null;
}

export interface MissedShiftResult {
  session: tc.SessionView;
  sales: tc.SalesView;
  attendance: AttendanceView;
  attendanceChange: "created" | "promoted" | "left";
  /** For "left": the hours recorded, the span the day's shifts would make, and what to do. */
  hoursLeft: { recorded: number | null; span: number; message: string } | null;
  notAuthorised: boolean;
  otherTill: OtherTillSession[];
  cardShape: tc.CardShape;
  /** The float left in the drawer: the setting in force now. */
  floatLeft: number;
  floatNote: string;
  /** cstore: the pot's expected balance and the count this shift's count is measured against. */
  lotto: { expected: number; previousCount: number | null } | null;
  variance: number;
  varianceStatus: string;
  cashRemoved: number;
  total: number;
  staleReconcile: boolean;
  commissionRunsTouched: tc.RunTouched[];
  nextLottoSession: { sessionId: string; date: string } | null;
}

interface Person {
  staff_id: string;
  name: string;
  active: boolean;
  hourly_rate: number | null;
  companies_authorized: string | null;
}

interface AttRow {
  attendance_id: string;
  staff_id: string;
  date: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  actual_start: Date | null;
  actual_end: Date | null;
  hours_worked: number | null;
  rate_at_attendance: number | null;
  status: string;
  notes: string | null;
  created_by: string | null;
  created_at: Date | null;
  modified_by: string | null;
  modified_at: Date | null;
  hours_basis: string | null;
  store_id?: string;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const blankToNull = (v: string | null): string | null => {
  const s = (v ?? "").toString().trim();
  return s === "" ? null : s;
};
const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const has = (input: MissedShiftInput, key: keyof MissedShiftInput): boolean => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
const pad = (n: number): string => (n < 10 ? "0" : "") + n;
/** HH:MM on Toronto's clock. */
const clock = (d: Date): string => {
  const w = wallClock(d);
  return pad(w.hour) + ":" + pad(w.minute);
};
const nextDay = (day: string): string => new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + 1)).toISOString().slice(0, 10);

function attView(r: AttRow): AttendanceView {
  const v = {
    attendanceId: r.attendance_id,
    staffId: r.staff_id,
    date: r.date,
    status: (r.status || "").trim() || "scheduled",
    scheduledStart: blankToNull(r.scheduled_start),
    scheduledEnd: blankToNull(r.scheduled_end),
    actualStart: iso(r.actual_start),
    actualEnd: iso(r.actual_end),
    hoursWorked: r.hours_worked === null ? null : Number(r.hours_worked),
    rateAtAttendance: r.rate_at_attendance === null ? null : Number(r.rate_at_attendance),
    hoursBasis: blankToNull(r.hours_basis),
    notes: r.notes === null || r.notes === "" ? null : r.notes,
  };
  return { ...v, owed: dayValue(v) };
}

/** The whole row as the audit row holds it: every column, instants as ISO strings. */
function whole(r: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

/** The notes plus "Entered after the fact: <reason>", capped as a correction's notes are: the newest text, behind "…". */
export function entryNotes(existing: string | null, reason: string): string {
  const note = (existing ? existing + " | " : "") + "Entered after the fact: " + reason;
  return note.length <= NOTES_CAP ? note : "…" + note.slice(note.length - (NOTES_CAP - 1));
}

// ── Reads ──────────────────────────────────────────────────

async function readPerson(db: Db, staffId: string): Promise<Person | null> {
  return db.maybeOne<Person>("select staff_id, name, active, hourly_rate, companies_authorized from ops.staff where staff_id = $1", [staffId]);
}

async function readAttendance(db: Db, id: string): Promise<AttRow | null> {
  return db.maybeOne<AttRow>("select * from ops.attendance where attendance_id = $1", [id]);
}

interface Placed {
  session_id: string;
  staff_id: string;
  company: string;
  status: string;
  start_time: Date | null;
  end_time: Date | null;
  name: string | null;
}

/**
 * Sessions that overlap [start, end): of one till (any person), or of one person on the other till.
 * Touching ends do not overlap. An open session runs on with no end; a session with no start (a hand-made
 * row) cannot be placed and is not counted; a closed one with no end is taken as ending where it started.
 */
async function overlapping(db: Db, where: "till" | "person", key: string, company: string, start: Date, end: Date): Promise<Placed[]> {
  const filter = where === "till" ? "s.company = $1" : "s.staff_id = $1 and s.company <> $4";
  return db.query<Placed>(
    `select s.session_id, s.staff_id, s.company, s.status, s.start_time, s.end_time, st.name
       from ops.till_sessions s left join ops.staff st on st.staff_id = s.staff_id
      where ${filter} and s.start_time is not null and s.start_time < $3
        and coalesce(s.end_time, case when s.status = 'open' then 'infinity'::timestamptz else s.start_time end) > $2
      order by s.start_time, s.session_id collate "C"`,
    where === "till" ? [company, start, end] : [key, start, end, company],
  );
}

const CLOSE_KEY = `coalesce(s.end_time, s.date::timestamp at time zone $2)`;
const START_KEY = `coalesce(s.start_time, '-infinity'::timestamptz)`;
const COUNTED = `s.company = $1 and lower(s.status) in ('closed', 'validated') and s.lotto_reserve_counted is not null and s.session_id <> $5`;

/** The pot's count at the cstore close immediately before this shift's end (in the order lastReserveCount reads closes). */
async function previousCount(db: Db, id: string, start: Date, end: Date): Promise<number | null> {
  const row = await db.maybeOne<{ counted: number }>(
    `select s.lotto_reserve_counted as counted from ops.till_sessions s
      where ${COUNTED} and (${CLOSE_KEY}, ${START_KEY}, s.session_id collate "C") < ($3::timestamptz, $4::timestamptz, $5 collate "C")
      order by ${CLOSE_KEY} desc, ${START_KEY} desc, s.session_id collate "C" desc
      limit 1`,
    [tillSessions.LOTTO_COMPANY, TZ, end, start, id],
  );
  return row ? roundMoney(row.counted) : null;
}

/** The next counted cstore close after this shift: its expected cash was measured against a chain without it. */
async function nextCounted(db: Db, id: string, start: Date, end: Date): Promise<{ sessionId: string; date: string } | null> {
  const row = await db.maybeOne<{ session_id: string; date: string }>(
    `select s.session_id, s.date from ops.till_sessions s
      where ${COUNTED} and (${CLOSE_KEY}, ${START_KEY}, s.session_id collate "C") > ($3::timestamptz, $4::timestamptz, $5 collate "C")
      order by ${CLOSE_KEY}, ${START_KEY}, s.session_id collate "C"
      limit 1`,
    [tillSessions.LOTTO_COMPANY, TZ, end, start, id],
  );
  return row ? { sessionId: row.session_id, date: row.date } : null;
}

/** A reconcile result for that day that covers this till (its companies name it, or name none). */
async function reconciledFor(db: Db, day: string, company: string): Promise<boolean> {
  const rows = await db.query<{ companies: string | null }>("select companies from ops.validation_results where business_date = $1", [day]);
  return rows.some((r) => {
    const list = (r.companies || "")
      .split("+")
      .map((x) => x.trim())
      .filter(Boolean);
    return list.length === 0 || list.includes(company);
  });
}

/** Every start and end of the day: its closed sessions, its recorded times, and this shift. */
async function daySpan(db: Db, att: AttRow, start: Date, end: Date): Promise<number> {
  const rows = await db.query<{ start_time: Date | null; end_time: Date | null }>(
    "select start_time, end_time from ops.till_sessions where attendance_id = $1 and lower(status) in ('closed', 'validated')",
    [att.attendance_id],
  );
  const starts = [start, att.actual_start, ...rows.map((r) => r.start_time)].filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
  const ends = [end, att.actual_end, ...rows.map((r) => r.end_time)].filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
  return roundMoney(diffHours(new Date(Math.min(...starts)), new Date(Math.max(...ends))));
}

// ── Checks ─────────────────────────────────────────────────

function checkDate(value: unknown, now: Date): string {
  const day = realDay(value);
  if (!day) throw new Error("date is not a readable date");
  const today = formatDate(now);
  if (day === today) throw new Error(TODAY_REFUSAL);
  if (day > today) throw new Error(FUTURE_REFUSAL);
  if (daysBetween(day, today) > MAX_DAYS_BACK) throw new Error(AGE_REFUSAL);
  return day;
}

function checkTimes(day: string, startValue: unknown, endValue: unknown, now: Date): { start: Date; end: Date } {
  const start = readInstant(startValue, "The start");
  const end = readInstant(endValue, "The end");
  if (end.getTime() <= start.getTime()) throw new Error("The end must be after the start.");
  if (end.getTime() - start.getTime() > MAX_SPAN_MS) throw new Error("A shift cannot be longer than 24 hours.");
  const from = (parseDate(day) as Date).getTime() - EDGE_MS;
  const until = (parseDate(nextDay(day)) as Date).getTime() + EDGE_MS;
  if (start.getTime() < from || start.getTime() >= until) throw new Error(`The start must be on ${day} (Toronto time), or within 6 hours of it.`);
  if (end.getTime() > now.getTime()) throw new Error("The end cannot be in the future.");
  return { start, end };
}

function overlapRefusal(company: string, s: Placed): string {
  const when = s.status === "open" || !s.end_time ? "from " + clock(s.start_time as Date) + " (still open)" : "from " + clock(s.start_time as Date) + " to " + clock(s.end_time);
  return `The ${company} till already has a shift ${when} that day (${s.name || s.staff_id}).`;
}

// ── The work, shared by the preview and the entry ──────────

async function work(db: Db, input: MissedShiftInput, actorId: string, config: Config, now: Date, write: Tx | null): Promise<MissedShiftResult> {
  if (!actorId) throw new Error("actorId required");

  // 1. The person (active or not), locked first.
  const staffId = input.staffId;
  const named = typeof staffId === "string" && staffId !== "";
  if (write && named) await lockRow(write, "staff", staffId as string);
  const person = named ? await readPerson(db, staffId as string) : null;
  if (!person) throw new Error("Staff not found: " + String(staffId));

  // 2. The till; the person need not be authorised for it today, but the answer says so.
  const company = input.company;
  if (typeof company !== "string" || !COMPANIES.includes(company)) throw new Error("The till must be cstore or vape.");
  const notAuthorised = !(person.companies_authorized || "")
    .split(",")
    .map((c) => c.trim())
    .includes(company);

  // 3. A real day before today in Toronto, not too long ago.
  const day = checkDate(input.date, now);
  const midnight = parseDate(day) as Date;

  // 4. The times.
  const { start, end } = checkTimes(day, input.startTime, input.endTime, now);

  // 5. Why (the preview may run before it is typed).
  const reason = write || !isBlank(input.reason) ? tc.checkReason(input.reason) : null;

  // 6. No other shift on that till at those times, under the lock an open of that till takes.
  if (write) await write.query("select pg_advisory_xact_lock(hashtextextended('ops.till.open:' || $1, 0))", [company]);
  const clash = await overlapping(db, "till", person.staff_id, company, start, end);
  if (clash.length) throw new Error(overlapRefusal(company, clash[0] as Placed));
  const sessionId = tillSessionId(midnight, person.staff_id, company);
  const sameId = await db.maybeOne<{ status: string }>("select status from ops.till_sessions where session_id = $1", [sessionId]);
  if (sameId) throw new Error(`${person.name} already has a ${company} shift on ${day} (${sessionId}): one shift per person per till per day. Correct that till instead.`);

  // 7. The same person on the other till at the same time is allowed (a small store), and reported.
  const otherTill: OtherTillSession[] = (await overlapping(db, "person", person.staff_id, company, start, end)).map((s) => ({
    sessionId: s.session_id,
    company: s.company,
    status: (s.status || "").trim(),
    startTime: iso(s.start_time),
    endTime: iso(s.end_time),
  }));

  // 8. The figures, read as a correction reads them, derived by the close's own arithmetic.
  const lottoOn = company === tillSessions.LOTTO_COMPANY;
  const openingFloat = tc.money(input.openingFloat, "The opening float");
  if (openingFloat === null || openingFloat < 0) throw new Error("The opening float must be a number, 0 or more.");
  const count = tc.money(input.closingCashCounted, "The cash counted");
  const cash = tc.money(input.cashSales, "Cash sales");
  const credit = tc.money(input.creditCardSales, "Credit card sales");
  const debit = tc.money(input.debitCardSales, "Debit card sales");
  const cardTotal = tc.money(input.cardTotalSales, "Card sales");
  const miscCash = tc.money(input.miscCashSales, "Misc cash");
  const miscCredit = tc.money(input.miscCreditSales, "Misc credit");
  const miscDebit = tc.money(input.miscDebitSales, "Misc debit");
  const miscCard = tc.money(input.miscCardSales, "Misc card");
  const miscNotes = tc.text(input.miscNotes, "Misc notes");
  const notesIn = tc.text(input.notes, "Notes");
  const lottoCounted = tc.money(input.lottoReserveCounted, "Reserve counted");
  const lottoTopupIn = tc.money(input.lottoTopupFromTill, "Moving from till into reserve");
  const lottoNoteIn = tc.text(input.lottoReserveNote, "The reserve reason");
  if (!lottoOn && (lottoCounted !== null || lottoTopupIn !== null || lottoNoteIn !== null)) throw new Error("A " + company + " till has no lotto reserve.");

  // One card shape (ADR-0005), the one that till reports on that date.
  const sentSplit = has(input, "creditCardSales") || has(input, "debitCardSales") || has(input, "miscCreditSales") || has(input, "miscDebitSales");
  const sentSingle = has(input, "cardTotalSales") || has(input, "miscCardSales");
  if (sentSplit === sentSingle) throw new Error("Send one card shape.");
  const shape: tc.CardShape = sentSplit ? "split" : "single";
  const dateShape = tc.shapeForDate(config, company, day);
  if (shape !== dateShape) throw new Error("On " + day + " the " + company + " till reports " + tc.SHAPE_WORDS[dateShape] + ": send " + tc.SHAPE_WORDS[dateShape] + ".");
  const split = shape === "split";

  const floatLeft = tillSessions.getExpectedFloat(config, company);
  const lottoExpected = tillSessions.getLottoExpected(config);
  const prevReserve = lottoOn ? await previousCount(db, sessionId, start, end) : null;
  const f = tillSessions.closeFigures(config, {
    company,
    openingFloat,
    floatAmount: floatLeft,
    lottoExpected,
    prevReserveCounted: prevReserve,
    physicalCount: count === null ? undefined : count,
    cashSales: cash,
    miscCash,
    ...(split ? { creditCard: credit ?? 0, debitCard: debit ?? 0, miscCredit: miscCredit ?? 0, miscDebit: miscDebit ?? 0 } : { cardTotal: cardTotal ?? 0, miscCard: miscCard ?? 0 }),
    miscNotes,
    lottoCounted: lottoOn ? lottoCounted : 0,
    lottoTopupFromTill: lottoTopupIn,
    lottoNote: lottoNoteIn,
  });
  const keep = (entered: number | null, derived: unknown): number | null => (entered === null ? null : roundMoney(derived));

  // 9. The session, as an open then a close would have left it.
  const sessionRow: tc.SessionRow = {
    session_id: sessionId,
    attendance_id: attendanceId(midnight, person.staff_id),
    staff_id: person.staff_id,
    company,
    date: day,
    status: "closed",
    start_time: start,
    end_time: end,
    expected_opening: roundMoney(floatLeft),
    opening_float: openingFloat,
    opening_note: null,
    closing_cash_counted: f.countStored,
    cash_left_in_till: f.floatStored,
    cash_removed_at_close: f.cashRemoved,
    expected_cash: roundMoney(f.expectedCash),
    closing_variance: f.variance,
    variance_status: f.varianceStatus,
    notes: entryNotes(notesIn, reason ?? "…"),
    lotto_reserve_counted: lottoOn && lottoCounted !== null ? roundMoney(f.lottoCounted) : null,
    lotto_topup_from_till: lottoOn ? keep(lottoTopupIn, f.lottoTopup) : null,
    lotto_reserve_note: lottoOn && f.lottoNote !== "" ? f.lottoNote : null,
    store_id: "store_main",
  };

  // 10. The sales row, as a close writes it (0 in the figures the close sheet no longer asks for).
  const s = f.sales;
  const salesRow: tc.SalesRow = {
    sales_id: sessionId,
    session_id: sessionId,
    staff_id: person.staff_id,
    company,
    date: day,
    cash_sales: keep(cash, s.cashSales),
    credit_card_sales: split ? keep(credit, s.creditCardSales) : null,
    debit_card_sales: split ? keep(debit, s.debitCardSales) : null,
    cashback_paid: 0,
    hst_collected: 0,
    bottle_deposit: 0,
    round_off: 0,
    misc_cash_sales: keep(miscCash, s.miscCashSales),
    misc_credit_sales: split ? keep(miscCredit, s.miscCreditSales) : null,
    misc_debit_sales: split ? keep(miscDebit, s.miscDebitSales) : null,
    misc_notes: miscNotes,
    card_total_sales: split ? null : keep(cardTotal, s.cardTotalSales),
    misc_card_sales: split ? null : keep(miscCard, s.miscCardSales),
    store_id: "store_main",
    seq: 0,
  };

  // 11. The day's attendance.
  const attId = sessionRow.attendance_id;
  if (write) await lockRow(write, "attendance", attId);
  const before = await readAttendance(db, attId);
  const hours = roundMoney(diffHours(start, end));
  const currentRate = person.hourly_rate === null ? null : Number(person.hourly_rate);
  let change: MissedShiftResult["attendanceChange"];
  let attAfter: AttRow;
  let hoursLeft: MissedShiftResult["hoursLeft"] = null;
  const status = before ? (before.status || "").trim() || "scheduled" : null;
  if (!before) {
    change = "created";
    attAfter = {
      attendance_id: attId,
      staff_id: person.staff_id,
      date: day,
      scheduled_start: null,
      scheduled_end: null,
      actual_start: start,
      actual_end: end,
      hours_worked: hours,
      rate_at_attendance: currentRate,
      status: "worked",
      notes: null,
      created_by: actorId,
      created_at: now,
      modified_by: null,
      modified_at: null,
      hours_basis: null,
    };
  } else if (status === "in_progress") {
    throw new Error("Close " + person.name + "'s till first.");
  } else if (status === "worked") {
    change = "left";
    attAfter = before;
    const recorded = before.hours_worked === null ? null : Number(before.hours_worked);
    const span = await daySpan(db, before, start, end);
    hoursLeft = {
      recorded,
      span,
      message:
        "The day's hours were left at " +
        (recorded === null ? "blank" : String(recorded)) +
        ": correct the day on the Schedule screen if they should change (the day's shifts would span " +
        span +
        " hours).",
    };
  } else {
    const paid = await attendance.paidAmount(db, attId);
    if (paid > 0) throw new Error("Cannot enter: $" + paid.toFixed(2) + " has been paid against this day. Undo the payment first.");
    change = "promoted";
    const kept = before.rate_at_attendance !== null && Number(before.rate_at_attendance) > 0 ? Number(before.rate_at_attendance) : currentRate;
    attAfter = { ...before, status: "worked", actual_start: start, actual_end: end, hours_worked: hours, rate_at_attendance: kept, modified_by: actorId, modified_at: now };
  }

  // What has gone stale, and what follows the pot's chain.
  const staleReconcile = await reconciledFor(db, day, company);
  const commissionRunsTouched = await tc.runsCovering(db, day);
  const nextLottoSession = lottoOn ? await nextCounted(db, sessionId, start, end) : null;

  let sessionOut = sessionRow;
  let salesOut = salesRow;
  if (write) {
    // 11, 9, 10: the day first (the session points at it), then the session, then its sales row.
    if (change === "created") {
      await write.query(
        `insert into ops.attendance (attendance_id, staff_id, date, scheduled_start, scheduled_end, actual_start, actual_end,
           hours_worked, rate_at_attendance, status, notes, created_by, created_at, modified_by, modified_at, hours_basis)
         values ($1, $2, $3, null, null, $4, $5, $6, $7, 'worked', null, $8, $9, null, null, null)`,
        [attId, person.staff_id, day, start, end, hours, currentRate, actorId, now],
      );
    } else if (change === "promoted") {
      await write.query(
        `update ops.attendance set status = 'worked', actual_start = $2, actual_end = $3, hours_worked = $4, rate_at_attendance = $5,
           modified_by = $6, modified_at = $7 where attendance_id = $1`,
        [attId, start, end, hours, attAfter.rate_at_attendance, actorId, now],
      );
    }
    const r = sessionRow;
    await write.query(
      `insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time, end_time, expected_opening,
         opening_float, opening_note, closing_cash_counted, cash_left_in_till, cash_removed_at_close, expected_cash, closing_variance,
         variance_status, notes, lotto_reserve_counted, lotto_topup_from_till, lotto_reserve_note)
       values ($1, $2, $3, $4, $5, 'closed', $6, $7, $8, $9, null, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        r.session_id,
        r.attendance_id,
        r.staff_id,
        r.company,
        r.date,
        r.start_time,
        r.end_time,
        r.expected_opening,
        r.opening_float,
        r.closing_cash_counted,
        r.cash_left_in_till,
        r.cash_removed_at_close,
        r.expected_cash,
        r.closing_variance,
        r.variance_status,
        r.notes,
        r.lotto_reserve_counted,
        r.lotto_topup_from_till,
        r.lotto_reserve_note,
      ],
    );
    const q = salesRow;
    await write.query(
      `insert into ops.sales (sales_id, session_id, staff_id, company, date, cash_sales, credit_card_sales, debit_card_sales, cashback_paid,
         hst_collected, bottle_deposit, round_off, misc_cash_sales, misc_credit_sales, misc_debit_sales, misc_notes, card_total_sales, misc_card_sales)
       values ($1, $1, $2, $3, $4, $5, $6, $7, 0, 0, 0, 0, $8, $9, $10, $11, $12, $13)`,
      [q.sales_id, q.staff_id, q.company, q.date, q.cash_sales, q.credit_card_sales, q.debit_card_sales, q.misc_cash_sales, q.misc_credit_sales, q.misc_debit_sales, q.misc_notes, q.card_total_sales, q.misc_card_sales],
    );
    sessionOut = (await write.one<tc.SessionRow>("select * from ops.till_sessions where session_id = $1", [sessionId])) as tc.SessionRow;
    salesOut = (await write.one<tc.SalesRow>("select * from ops.sales where session_id = $1", [sessionId])) as tc.SalesRow;
    attAfter = (await readAttendance(write, attId)) as AttRow;

    // 12. One audit row: the whole session, sales row and day as stored; the reason in details.
    await audit.write(
      write,
      {
        actorId,
        action: "till.enter_missed",
        targetType: "till_sessions",
        targetId: sessionId,
        before: null,
        after: { session: whole(sessionOut), sales: whole(salesOut), attendance: whole(attAfter), attendanceChange: change },
        details: reason as string,
      },
      { now },
    );
  }

  const salesV = tc.salesView(salesOut) as tc.SalesView;
  return {
    session: tc.sessionView(sessionOut, person.name),
    sales: salesV,
    attendance: attView(attAfter),
    attendanceChange: change,
    hoursLeft,
    notAuthorised,
    otherTill,
    cardShape: shape,
    floatLeft,
    floatNote: "The float left in the drawer is today's setting for the " + company + " till (" + "$" + floatLeft.toFixed(2) + "): nothing records the one in force that day.",
    lotto: lottoOn ? { expected: lottoExpected, previousCount: prevReserve } : null,
    variance: f.variance,
    varianceStatus: f.varianceStatus,
    cashRemoved: f.cashRemoved,
    total: salesV.total,
    staleReconcile,
    commissionRunsTouched,
    nextLottoSession,
  };
}

// ── The two calls ──────────────────────────────────────────

/** Every rule and all the arithmetic of an entry, writing nothing: what rpcEnterMissedShift would answer. (rpcPreviewMissedShift) */
export async function preview(db: Db, input: MissedShiftInput, actorId: string, config: Config, now: Date): Promise<MissedShiftResult> {
  return work(db, input, actorId, config, now, null);
}

/** Enter a shift that was never put in the app: the session, its sales row and the day, together. (rpcEnterMissedShift) */
export async function enter(db: Tx, input: MissedShiftInput, actorId: string, config: Config, now: Date): Promise<MissedShiftResult> {
  return work(db, input, actorId, config, now, db);
}
