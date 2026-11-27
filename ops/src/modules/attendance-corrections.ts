// Attendance corrections: an admin sets a past day to what really happened (card P4-10). NEW in the
// Operations app (ADR-0023): in the Apps Script app an admin edited the attendance tab by hand, so
// there is nothing to port and nothing for the parity harness to compare; the unit tests in
// ops/test/attendance-corrections.test.ts are the specification.
//
// The owner's two cases:
//   1. someone left early and the other person stayed: both days get their real times;
//   2. a scheduled person did not show and a stand-in worked who was never scheduled: the no-show's
//      day is cancelled and the stand-in's day is added, as worked.
//
// A correction sets the day to exactly what the input says (every field, prefilled by the page from
// getDay); it is not a patch. Payroll pays hours_worked x rate_at_attendance, so a correction changes
// what the person is owed, and the answer says by how much for this one day.
//
// Blank is not zero (ADR-0004). Unlike attendance.ts's reader (which keeps the old app's
// `Number(x) || 0`), this module reads the row itself so that a blank hours_worked,
// rate_at_attendance or hourly_rate is null in the answer and in the audit row, and a blank current
// rate is written as NULL, never 0. One exception, on purpose: a rate_at_attendance of exactly 0 is
// not treated as a snapshot to keep. schedule() and openOrPromote() write 0 there as the old code's
// stand-in for "no rate yet", so keeping it would pay a corrected day nothing; a correction takes the
// person's current rate instead (NULL when that is blank).
//
// Locks, in this order, inside the router's one transaction: the person's staff row, then the day's
// attendance row (when it exists). payShifts and Payments.undo lock the staff row first too, so a
// correction and a payment of the same person are serialised: either the payment reads the
// corrected hours, or the correction sees the payment and is refused. Two corrections of one person
// and day wait for each other, so the row is created once and the second updates it.
//
// Never touched: till sessions, sales, payments, payment items, bonuses. Nothing is deleted.
import type { Db } from "../db/client";
import { lockRow, type Tx } from "../db/tx";
import * as audit from "../lib/audit";
import { diffHours, formatDate, parseDate } from "../lib/dates";
import { attendanceId } from "../lib/ids";
import { roundMoney } from "../lib/money";
import * as attendance from "./attendance";

/** How far back a day can be corrected. */
export const MAX_DAYS_BACK = 370;
/** A worked day may start this long before its Toronto midnight or after the next one. */
const EDGE_MS = 6 * 3_600_000;
/** The longest day a correction accepts. */
const MAX_SPAN_MS = 24 * 3_600_000;
/** Notes are capped at this many characters; the newest text is kept (see capNotes). */
export const NOTES_CAP = 2000;
export const REASON_MIN = 3;
export const REASON_MAX = 300;

export interface CorrectionRecord {
  attendanceId: string;
  status: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  /** ISO strings; null when blank. */
  actualStart: string | null;
  actualEnd: string | null;
  hoursWorked: number | null;
  rateAtAttendance: number | null;
  hoursBasis: string | null;
  notes: string | null;
}

/** The whole row, as the audit row holds it. */
export interface FullRecord extends CorrectionRecord {
  staffId: string;
  date: string;
  createdBy: string | null;
  createdAt: string | null;
  modifiedBy: string | null;
  modifiedAt: string | null;
}

export interface DaySession {
  sessionId: string;
  company: string;
  status: string;
  startTime: string | null;
  endTime: string | null;
}

export interface AttendanceDay {
  staffId: string;
  name: string;
  active: boolean;
  date: string;
  record: CorrectionRecord | null;
  currentRate: number | null;
  paid: number;
  tillSessions: DaySession[];
  canCorrect: boolean;
  blockedBy: string | null;
}

export interface CorrectionInput {
  staffId?: unknown;
  date?: unknown;
  status?: unknown;
  scheduledStart?: unknown;
  scheduledEnd?: unknown;
  actualStart?: unknown;
  actualEnd?: unknown;
  reason?: unknown;
}

export interface CorrectionResult {
  record: CorrectionRecord;
  created: boolean;
  owedBefore: number | null;
  owedAfter: number | null;
}

interface Row {
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
}

interface Person {
  staff_id: string;
  name: string;
  active: boolean;
  hourly_rate: number | null;
}

const COLUMNS =
  "attendance_id, staff_id, date, scheduled_start, scheduled_end, actual_start, actual_end, hours_worked, rate_at_attendance, status, notes, created_by, created_at, modified_by, modified_at, hours_basis";

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const blankToNull = (v: string | null): string | null => {
  const s = (v ?? "").toString().trim();
  return s === "" ? null : s;
};

function toRecord(r: Row): CorrectionRecord {
  return {
    attendanceId: r.attendance_id,
    status: (r.status || "").trim() || "scheduled",
    scheduledStart: blankToNull(r.scheduled_start),
    scheduledEnd: blankToNull(r.scheduled_end),
    actualStart: iso(r.actual_start),
    actualEnd: iso(r.actual_end),
    hoursWorked: r.hours_worked,
    rateAtAttendance: r.rate_at_attendance,
    hoursBasis: blankToNull(r.hours_basis),
    notes: r.notes === null || r.notes === "" ? null : r.notes,
  };
}

function toFull(r: Row): FullRecord {
  return {
    ...toRecord(r),
    staffId: r.staff_id,
    date: r.date,
    createdBy: blankToNull(r.created_by),
    createdAt: iso(r.created_at),
    modifiedBy: blankToNull(r.modified_by),
    modifiedAt: iso(r.modified_at),
  };
}

/** What one day is worth: hours x rate, rounded; null when either factor is blank. */
export function dayValue(r: Pick<CorrectionRecord, "hoursWorked" | "rateAtAttendance"> | null): number | null {
  if (!r || r.hoursWorked === null || r.rateAtAttendance === null) return null;
  return roundMoney(r.hoursWorked * r.rateAtAttendance);
}

// ── Reads ──────────────────────────────────────────────────

async function readPerson(db: Db, staffId: string): Promise<Person | null> {
  return db.maybeOne<Person>("select staff_id, name, active, hourly_rate from ops.staff where staff_id = $1", [staffId]);
}

async function readRow(db: Db, id: string): Promise<Row | null> {
  return db.maybeOne<Row>(`select ${COLUMNS} from ops.attendance where attendance_id = $1`, [id]);
}

/** The person's till sessions of that day: those filed under the day's attendance id, and any of theirs dated that day. */
async function readSessions(db: Db, id: string, staffId: string, date: string): Promise<DaySession[]> {
  const rows = await db.query<{ session_id: string; company: string; status: string; start_time: Date | null; end_time: Date | null }>(
    `select session_id, company, status, start_time, end_time from ops.till_sessions
      where attendance_id = $1 or (staff_id = $2 and date = $3)
      order by start_time nulls last, session_id collate "C"`,
    [id, staffId, date],
  );
  return rows.map((s) => ({ sessionId: s.session_id, company: s.company, status: (s.status || "").trim() || "open", startTime: iso(s.start_time), endTime: iso(s.end_time) }));
}

// ── Checks ─────────────────────────────────────────────────

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" that is a real calendar day, or null. (lib/dates parseDate rolls 02-30 over to March: not here.) */
function realDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = DAY.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return value;
}

/** Whole calendar days from `a` to `b` (both "YYYY-MM-DD"). */
function daysBetween(a: string, b: string): number {
  const ms = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

const midnightOf = (day: string): Date => parseDate(day) as Date;
const nextDay = (day: string): string => {
  const t = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + 1));
  return t.toISOString().slice(0, 10);
};

/** Why a day cannot be corrected because of its date, or null. */
function dateRefusal(day: string, now: Date): string | null {
  const today = formatDate(now);
  if (day > today) return "Use the schedule for a day that has not happened yet.";
  if (daysBetween(day, today) > MAX_DAYS_BACK) return `Cannot correct a day more than ${MAX_DAYS_BACK} days ago.`;
  return null;
}

const paidRefusal = (paid: number): string => "Cannot correct: $" + paid.toFixed(2) + " has been paid against this day. Undo the payment first.";
const tillRefusal = (name: string): string => "Close " + name + "'s till first.";

function checkReason(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < REASON_MIN || text.length > REASON_MAX) throw new Error(`A reason is required: ${REASON_MIN} to ${REASON_MAX} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) throw new Error("The reason cannot contain control characters (such as a line break).");
  return text;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function checkScheduled(start: unknown, end: unknown): { start: string | null; end: string | null } {
  const one = (v: unknown, label: string): string | null => {
    if (isBlank(v)) return null;
    const s = typeof v === "string" ? v.trim() : "";
    if (!HHMM.test(s)) throw new Error(`${label} must be blank or a time as HH:MM (24-hour, 00:00 to 23:59).`);
    return s;
  };
  const a = one(start, "Scheduled start");
  const b = one(end, "Scheduled end");
  if ((a === null) !== (b === null)) throw new Error("Give both scheduled times, or neither (not scheduled).");
  if (a !== null && b !== null && minutes(b) <= minutes(a)) throw new Error("The scheduled end must be after the scheduled start.");
  return { start: a, end: b };
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * A strict instant: an ISO date-time with `Z` or an offset, every field in range (no 02-30, no 24:00).
 * attendance.parseInstant is not used: it reads zoneless text as Toronto and anything else as
 * `new Date` does (which rolls 02-30 over), which suits a port, not a new rule.
 */
export function readInstant(value: unknown, label: string): Date {
  const m = typeof value === "string" ? INSTANT.exec(value.trim()) : null;
  if (!m) throw new Error(`${label} must be a date and time with its zone, such as 2026-06-01T09:00:00-04:00.`);
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));
  const offH = m[10] === undefined ? 0 : Number(m[10]);
  const offM = m[11] === undefined ? 0 : Number(m[11]);
  const wall = new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
  const inRange =
    wall.getUTCFullYear() === y && wall.getUTCMonth() === mo - 1 && wall.getUTCDate() === d && h <= 23 && mi <= 59 && s <= 59 && offH <= 14 && offM <= 59;
  if (!inRange) throw new Error(`${label} is not a real date and time.`);
  const sign = m[9] === "-" ? -1 : 1;
  return new Date(wall.getTime() - sign * (offH * 60 + offM) * 60_000);
}

function checkActual(day: string, startValue: unknown, endValue: unknown, now: Date): { start: Date; end: Date; hours: number } {
  if (isBlank(startValue) || isBlank(endValue)) throw new Error("A worked day needs its actual start and end.");
  const start = readInstant(startValue, "The actual start");
  const end = readInstant(endValue, "The actual end");
  if (end.getTime() <= start.getTime()) throw new Error("The actual end must be after the actual start.");
  if (end.getTime() - start.getTime() > MAX_SPAN_MS) throw new Error("A day cannot be longer than 24 hours.");
  const from = midnightOf(day).getTime() - EDGE_MS;
  const until = midnightOf(nextDay(day)).getTime() + EDGE_MS;
  if (start.getTime() < from || start.getTime() >= until) throw new Error(`The actual start must be on ${day} (Toronto time), or within 6 hours of it.`);
  if (end.getTime() > now.getTime()) throw new Error("The actual end cannot be in the future.");
  return { start, end, hours: roundMoney(diffHours(start, end)) };
}

/** Appends "Corrected: <reason>" (after " | " when there are notes), keeping at most NOTES_CAP characters: the newest text, behind "…". */
export function capNotes(existing: string | null, reason: string): string {
  const note = (existing ? existing + " | " : "") + "Corrected: " + reason;
  return note.length <= NOTES_CAP ? note : "…" + note.slice(note.length - (NOTES_CAP - 1));
}

// ── The two calls ──────────────────────────────────────────

/** What the correction sheet shows before anything is changed. (rpcGetAttendanceDay) */
export async function getDay(db: Db, staffId: unknown, date: unknown, now: Date): Promise<AttendanceDay> {
  const person = typeof staffId === "string" && staffId !== "" ? await readPerson(db, staffId) : null;
  if (!person) throw new Error("Staff not found: " + String(staffId));
  const day = realDay(date);
  if (!day) throw new Error("date is not a readable date");
  const id = attendanceId(midnightOf(day), person.staff_id);

  const row = await readRow(db, id);
  const sessions = await readSessions(db, id, person.staff_id, day);
  const paid = await attendance.paidAmount(db, id);
  const record = row ? toRecord(row) : null;

  let blockedBy = dateRefusal(day, now);
  if (!blockedBy && paid > 0) blockedBy = paidRefusal(paid);
  if (!blockedBy && (record?.status === "in_progress" || sessions.some((s) => s.status === "open"))) blockedBy = tillRefusal(person.name);

  return {
    staffId: person.staff_id,
    name: person.name,
    active: person.active === true,
    date: day,
    record,
    currentRate: person.hourly_rate,
    paid,
    tillSessions: sessions,
    canCorrect: blockedBy === null,
    blockedBy,
  };
}

/** Set one person's day to what really happened. (rpcCorrectAttendance) */
export async function correct(db: Tx, input: CorrectionInput, actorId: string, now: Date): Promise<CorrectionResult> {
  if (!actorId) throw new Error("actorId required");

  // 1. The person, locked first: every correction and payment of this person waits here.
  const staffId = input.staffId;
  const exists = typeof staffId === "string" && staffId !== "" && (await lockRow(db, "staff", staffId));
  const person = exists ? await readPerson(db, staffId as string) : null;
  if (!person) throw new Error("Staff not found: " + String(staffId));

  // 2. The day: real, today or earlier in Toronto, not too long ago.
  const day = realDay(input.date);
  if (!day) throw new Error("date is not a readable date");
  const byDate = dateRefusal(day, now);
  if (byDate) throw new Error(byDate);

  // 3. Why.
  const reason = checkReason(input.reason);

  // 4. Nothing paid against it.
  const id = attendanceId(midnightOf(day), person.staff_id);
  await lockRow(db, "attendance", id);
  const before = await readRow(db, id);
  const paid = await attendance.paidAmount(db, id);
  if (paid > 0) throw new Error(paidRefusal(paid));

  // 5. No till still open that day.
  const sessions = await readSessions(db, id, person.staff_id, day);
  if ((before && before.status === "in_progress") || sessions.some((s) => s.status === "open")) throw new Error(tillRefusal(person.name));

  // 6. What it becomes.
  const status = input.status;
  if (status !== "worked" && status !== "cancelled") throw new Error("status must be worked or cancelled.");

  // 7. What was planned.
  const scheduled = checkScheduled(input.scheduledStart, input.scheduledEnd);

  // 8 and 9. What happened.
  let actualStart: Date | null = null;
  let actualEnd: Date | null = null;
  let hours: number | null = null;
  let rate: number | null = before ? before.rate_at_attendance : null;
  if (status === "worked") {
    const actual = checkActual(day, input.actualStart, input.actualEnd, now);
    actualStart = actual.start;
    actualEnd = actual.end;
    hours = actual.hours;
    // A snapshot is kept; a blank or a 0 (the old code's "no rate yet") takes the current rate, NULL when that is blank.
    if (!(rate !== null && rate > 0)) rate = person.hourly_rate === null ? null : Number(person.hourly_rate);
  } else if (sessions.length > 0) {
    throw new Error(person.name + " opened a till that day: it was worked. Correct the times instead.");
  }

  // 10 and 11. Write it.
  const notes = capNotes(before ? before.notes : null, reason);
  if (before) {
    await db.query(
      `update ops.attendance set status = $2, scheduled_start = $3, scheduled_end = $4, actual_start = $5, actual_end = $6,
         hours_worked = $7, rate_at_attendance = $8, hours_basis = null, notes = $9, modified_by = $10, modified_at = $11
       where attendance_id = $1`,
      [id, status, scheduled.start, scheduled.end, actualStart, actualEnd, hours, rate, notes, actorId, now],
    );
  } else {
    await db.query(
      `insert into ops.attendance (attendance_id, staff_id, date, scheduled_start, scheduled_end, actual_start, actual_end,
         hours_worked, rate_at_attendance, status, notes, created_by, created_at, modified_by, modified_at, hours_basis)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, null, null, null)`,
      [id, person.staff_id, day, scheduled.start, scheduled.end, actualStart, actualEnd, hours, rate, status, notes, actorId, now],
    );
  }
  const after = (await readRow(db, id)) as Row;

  // 12. One audit row with the whole record before and after.
  await audit.write(
    db,
    { actorId, action: "attendance.correct", targetType: "attendance", targetId: id, before: before ? toFull(before) : null, after: toFull(after), details: reason },
    { now },
  );

  const record = toRecord(after);
  return { record, created: before === null, owedBefore: before ? dayValue(toRecord(before)) : null, owedAfter: dayValue(record) };
}
