// Attendance: one row per person per workday, the record payroll pays from. The port of
// src/Attendance.gs for the Schedule screen (rpcGetWeekSchedule, rpcScheduleShift,
// rpcCancelScheduledShift, rpcAdjustAttendanceHours, rpcEditAttendanceTimes) plus the reads
// other modules will call.
//
// Records have the field names and shapes Attendance.gs rowToRecord_ returns, with these
// differences: no _rowIndex (a Sheet row number means nothing here), `date` is "YYYY-MM-DD"
// (a Date in the old app), and the instants are Dates.
//
// Same as the old code, deliberately (ADR-0004 warns about each; parity decides, so they are
// kept and listed in the card's report):
//   - a blank hours_worked reads as 0 (`Number(x) || 0`);
//   - a new scheduled row is written with hours_worked = 0 and rate_at_attendance = 0, not blank;
//   - a blank hours_worked is audited as 0 in "before".
//
// One deliberate difference (card P4-11b, ADR-0031): a blank rate is not 0. complete() stores
// rate_at_attendance NULL when the person's hourly rate is blank (the old code copied 0), and a blank
// rate_at_attendance reads as null. A real 0 stays 0, and rows already holding 0 are not rewritten.
//
// Writes: one statement per row changed, in the caller's transaction, the row locked before it is
// read (lockRow) so two managers editing one shift cannot both win, and the audit row written
// with the same action, target, before and after as the old code. The time is the call's `now`.
//
// Order: the Sheet returned rows in the order they were appended. `created_at` is the moment a
// row was appended (a promoted row keeps its own), so lists are `order by created_at,
// attendance_id`. It is the same except among rows created in the same instant and for imported
// history, whose created_at is not always in sheet order (the docs fixture's third shift of a
// day starts before the second); nothing here depends on that order.
//
// Not ported (no RPC being moved calls them): openOrPromote_ and complete_ (the till open and
// close write them; the Shifts card ports them with TillSessions), getAll_ (nothing needs every
// row), getUnpaidForStaff_ (Payments' allocation walk; the Payroll card), the per-execution
// cache and _rowIndex (a Sheet read cost and a Sheet row number).
import type { Db } from "../db/client";
import { lockRow, type Tx } from "../db/tx";
import * as audit from "../lib/audit";
import { addDays, diffHours, endOfDay, formatDate, getMondayOf, parseDate, wallClock } from "../lib/dates";
import { attendanceId } from "../lib/ids";
import { roundMoney } from "../lib/money";
import * as payments from "./payments";
import * as staff from "./staff";

export interface AttendanceRecord {
  attendanceId: string;
  staffId: string;
  /** "YYYY-MM-DD", or null. (A Date in the old app.) */
  date: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  actualStart: Date | null;
  actualEnd: Date | null;
  /** Blank in the database reads as 0, as in the old app. */
  hoursWorked: number;
  /** Blank in the database reads as null ("no rate set"; ADR-0031), not 0 as in the old app. */
  rateAtAttendance: number | null;
  status: string;
  notes: string;
  createdBy: string;
  createdAt: Date | null;
  modifiedBy: string;
  modifiedAt: Date | null;
  hoursBasis: string;
}

interface AttendanceRow {
  attendance_id: string;
  staff_id: string;
  date: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  actual_start: Date | null;
  actual_end: Date | null;
  hours_worked: number | null;
  rate_at_attendance: number | null;
  status: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: Date | null;
  modified_by: string | null;
  modified_at: Date | null;
  hours_basis: string | null;
}

const COLUMNS =
  "attendance_id, staff_id, date, scheduled_start, scheduled_end, actual_start, actual_end, hours_worked, rate_at_attendance, status, notes, created_by, created_at, modified_by, modified_at, hours_basis";
const ORDER = `order by created_at nulls last, attendance_id collate "C"`;
const trimmed = (v: string | null): string => (v || "").toString().trim();

function toRecord(r: AttendanceRow): AttendanceRecord {
  return {
    attendanceId: trimmed(r.attendance_id),
    staffId: trimmed(r.staff_id),
    date: r.date,
    scheduledStart: trimmed(r.scheduled_start),
    scheduledEnd: trimmed(r.scheduled_end),
    actualStart: r.actual_start,
    actualEnd: r.actual_end,
    hoursWorked: Number(r.hours_worked) || 0,
    rateAtAttendance: r.rate_at_attendance === null ? null : Number(r.rate_at_attendance) || 0,
    status: trimmed(r.status) || "scheduled",
    notes: (r.notes || "").toString(),
    createdBy: trimmed(r.created_by),
    createdAt: r.created_at,
    modifiedBy: trimmed(r.modified_by),
    modifiedAt: r.modified_at,
    hoursBasis: trimmed(r.hours_basis),
  };
}

// ── Reads ──────────────────────────────────────────────────

/** One day by its id, or null. (Attendance.getById) */
export async function getById(db: Db, id: string): Promise<AttendanceRecord | null> {
  if (typeof id !== "string") return null; // the old comparison was ===, so a non-string never matched
  const row = await db.maybeOne<AttendanceRow>(`select ${COLUMNS} from ops.attendance where attendance_id = $1`, [id]);
  return row ? toRecord(row) : null;
}

/** Every day of one person, in the order the rows were created. (Attendance.getForStaff) */
export async function getForStaff(db: Db, staffId: string): Promise<AttendanceRecord[]> {
  if (typeof staffId !== "string") return [];
  const rows = await db.query<AttendanceRow>(`select ${COLUMNS} from ops.attendance where staff_id = $1 ${ORDER}`, [staffId]);
  return rows.map(toRecord);
}

/** One person's day: the id is deterministic from the Toronto date. (Attendance.getForDateAndStaff) */
export async function getForDateAndStaff(db: Db, date: Date | string, staffId: string): Promise<AttendanceRecord | null> {
  const day = date instanceof Date ? date : parseDate(date);
  if (!day) return null;
  return getById(db, attendanceId(day, staffId));
}

/**
 * Days from `start` to `end` inclusive (a day counts when its Toronto midnight is not before `start`
 * and not after `end`), optionally one person's, in creation order. A blank bound gives []. An
 * unreadable bound (an Invalid Date) is no bound at all, because the old comparisons with it were all
 * false and so kept every row (kept). (Attendance.getForDateRange)
 */
export async function getForDateRange(db: Db, startDate: Date | string, endDate: Date | string, filterStaffId?: string | null): Promise<AttendanceRecord[]> {
  const start = startDate instanceof Date ? startDate : parseDate(startDate);
  const end = endDate instanceof Date ? endDate : parseDate(endDate);
  if (!start || !end) return [];
  const where: string[] = [];
  const params: unknown[] = [];
  if (!Number.isNaN(start.getTime())) {
    // The first day whose midnight is not before `start`: its own day if it is exactly midnight, else the next.
    const first = formatDate(start);
    const midnight = parseDate(first) as Date;
    params.push(midnight.getTime() >= start.getTime() ? first : formatDate(addDays(midnight, 1)));
    where.push(`date >= $${params.length}`);
  }
  if (!Number.isNaN(end.getTime())) {
    params.push(formatDate(end)); // the midnight of `end`'s own day is never after `end`
    where.push(`date <= $${params.length}`);
  }
  if (filterStaffId) {
    params.push(String(filterStaffId));
    where.push(`staff_id = $${params.length}`);
  }
  const rows = await db.query<AttendanceRow>(`select ${COLUMNS} from ops.attendance ${where.length ? "where " + where.join(" and ") : ""} ${ORDER}`, params);
  return rows.map(toRecord);
}

/**
 * What has been paid against one day through payment items of type shift, rounded; a voided
 * payment's items count for nothing. (`Payments.getAttendancePaidAmounts([id])[id] || 0`)
 */
export async function paidAmount(db: Db, id: string): Promise<number> {
  return (await payments.getAttendancePaidAmounts(db, [id]))[id] || 0;
}

// ── Hours ──────────────────────────────────────────────────

/** Hours implied by the scheduled HH:mm window (overnight-safe). 0 if unset or unreadable. */
export function scheduledHours(att: Pick<AttendanceRecord, "scheduledStart" | "scheduledEnd">): number {
  const mins = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec((s || "").toString().trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  };
  const a = mins(att.scheduledStart);
  const b = mins(att.scheduledEnd);
  if (a === null || b === null) return 0;
  let d = b - a;
  if (d <= 0) d += 24 * 60; // overnight shift
  return roundMoney(d / 60);
}

/** Hours from the actual open to close span. 0 if either time is missing. */
export function actualHours(att: Pick<AttendanceRecord, "actualStart" | "actualEnd">): number {
  if (!(att.actualStart instanceof Date) || !(att.actualEnd instanceof Date)) return 0;
  return roundMoney(diffHours(att.actualStart, att.actualEnd));
}

// ── Time input ─────────────────────────────────────────────

const ZONELESS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

/** Toronto's offset from UTC at an instant, in ms. */
function offsetAt(t: number): number {
  const w = wallClock(new Date(t));
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second, 0) - Math.floor(t / 1000) * 1000;
}

/**
 * `new Date(value)` as the old RPC did it, in the old app's time zone. Apps Script ran in Toronto, so a
 * time with no zone ("2026-06-01T09:00:00") meant Toronto time; a Worker runs in UTC, so the same text
 * is read here explicitly as Toronto (a repeated hour takes the first, a skipped one the offset from
 * before the jump, as V8 does). Text with a zone, a number (epoch ms), null (the epoch) and a Date
 * are read as `new Date` reads them; undefined and unreadable text are an Invalid Date. Other zoneless
 * spellings ("Jun 1 2026 9am") are left to `new Date`, which in a Worker reads them as UTC (a known gap).
 */
export function parseInstant(value: unknown): Date {
  if (typeof value === "string") {
    const m = ZONELESS.exec(value);
    if (m) {
      const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
      const s = m[6] === undefined ? 0 : Number(m[6]);
      const ms = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59 && s <= 59) {
        const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
        const before = offsetAt(guess - 86_400_000);
        const after = offsetAt(guess + 86_400_000);
        const valid: number[] = [];
        for (const off of new Set([before, after])) {
          const t = guess - off;
          if (offsetAt(t) === off) valid.push(t);
        }
        return new Date(valid.length > 0 ? Math.min(...valid) : guess - before);
      }
    }
  }
  return new Date(value as never);
}

// ── Writes ─────────────────────────────────────────────────

export interface ScheduleInput {
  staffId?: unknown;
  date?: unknown;
  scheduledStart?: unknown;
  scheduledEnd?: unknown;
  notes?: unknown;
  actorId?: unknown;
}

/** A cell value as the Sheet kept it: '' is a blank cell (NULL), anything else its text. */
const cell = (v: unknown): string | null => (v === "" || v === null || v === undefined ? null : String(v));

async function mustGet(db: Db, id: string): Promise<AttendanceRecord> {
  const rec = await getById(db, id);
  if (!rec) throw new Error("attendance not found: " + String(id));
  return rec;
}

/**
 * Schedule a day in advance; scheduling the same person and day again updates the times in place.
 * A day in progress or worked is refused. (Attendance.schedule)
 */
export async function schedule(db: Tx, input: ScheduleInput, now: Date): Promise<AttendanceRecord> {
  if (!input.staffId) throw new Error("staffId required");
  if (!input.date) throw new Error("date required");
  if (!input.actorId) throw new Error("actorId required");
  const actorId = String(input.actorId);

  const person = typeof input.staffId === "string" ? await staff.getById(db, input.staffId) : null;
  if (!person) throw new Error("Staff not found: " + String(input.staffId));

  const date = input.date instanceof Date ? input.date : (parseDate(input.date) as Date);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid date");
  const id = attendanceId(date, person.staffId);

  await lockRow(db, "attendance", id);
  const existing = await getById(db, id);

  if (existing) {
    if (existing.status === "in_progress" || existing.status === "worked") {
      throw new Error("Cannot schedule: attendance " + id + " is already " + existing.status);
    }
    const before = { scheduledStart: existing.scheduledStart, scheduledEnd: existing.scheduledEnd };
    const sets: string[] = [];
    const params: unknown[] = [id];
    if (input.scheduledStart != null) {
      params.push(cell(input.scheduledStart));
      sets.push(`scheduled_start = $${params.length}`);
    }
    if (input.scheduledEnd != null) {
      params.push(cell(input.scheduledEnd));
      sets.push(`scheduled_end = $${params.length}`);
    }
    if (existing.status === "cancelled") sets.push("status = 'scheduled'");
    params.push(actorId, now);
    sets.push(`modified_by = $${params.length - 1}`, `modified_at = $${params.length}`);
    await db.query(`update ops.attendance set ${sets.join(", ")} where attendance_id = $1`, params);

    await audit.write(
      db,
      {
        actorId,
        action: "attendance.schedule_update",
        targetType: "attendance",
        targetId: id,
        before,
        after: { scheduledStart: input.scheduledStart, scheduledEnd: input.scheduledEnd },
      },
      { now },
    );
    return mustGet(db, id);
  }

  // hours_worked and rate_at_attendance are written as 0, not blank: what the old code wrote.
  await db.query(
    `insert into ops.attendance (attendance_id, staff_id, date, scheduled_start, scheduled_end, actual_start, actual_end,
       hours_worked, rate_at_attendance, status, notes, created_by, created_at, modified_by, modified_at, hours_basis)
     values ($1, $2, $3, $4, $5, null, null, 0, 0, 'scheduled', $6, $7, $8, null, null, null)`,
    [id, person.staffId, formatDate(date), cell(input.scheduledStart || ""), cell(input.scheduledEnd || ""), cell(input.notes || ""), actorId, now],
  );
  await audit.write(
    db,
    {
      actorId,
      action: "attendance.schedule",
      targetType: "attendance",
      targetId: id,
      after: { staffId: person.staffId, date: formatDate(date), scheduledStart: input.scheduledStart, scheduledEnd: input.scheduledEnd },
    },
    { now },
  );
  return mustGet(db, id);
}

/** Cancel a day (any status), appending the reason to its note. Refused when anything was paid against it. (Attendance.cancel) */
export async function cancel(db: Tx, id: string, actorId: string, reason: unknown, now: Date): Promise<AttendanceRecord> {
  if (typeof id === "string") await lockRow(db, "attendance", id);
  const existing = await mustGet(db, id);

  const paid = await paidAmount(db, id);
  if (paid > 0) throw new Error("Cannot cancel: $" + paid.toFixed(2) + " has been paid against this attendance. Undo the payment first.");

  const note = (existing.notes ? existing.notes + " | " : "") + "Cancelled: " + String(reason || "");
  await db.query("update ops.attendance set status = 'cancelled', notes = $2, modified_by = $3, modified_at = $4 where attendance_id = $1", [id, cell(note), actorId, now]);

  await audit.write(
    db,
    { actorId, action: "attendance.cancel", targetType: "attendance", targetId: id, before: { status: existing.status }, after: { status: "cancelled", reason: reason || "" } },
    { now },
  );
  return mustGet(db, id);
}

/**
 * Admin: replace actual_start and actual_end (a data-entry fix), recompute the hours, clear the pay basis
 * so the day is reviewed again. Any status; refused when anything was paid. (Attendance.editActualTimes)
 */
export async function editActualTimes(db: Tx, id: string, start: Date, end: Date, actorId: string, now: Date): Promise<AttendanceRecord> {
  if (typeof id === "string") await lockRow(db, "attendance", id);
  const existing = await mustGet(db, id);

  const paid = await paidAmount(db, id);
  if (paid > 0) throw new Error("Cannot edit: $" + paid.toFixed(2) + " already paid. Undo the payment first.");

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new Error("Invalid start or end time");
  if (end <= start) throw new Error("End time must be after start time");

  const hours = roundMoney(diffHours(start, end));
  await db.query(
    "update ops.attendance set actual_start = $2, actual_end = $3, hours_worked = $4, hours_basis = null, modified_by = $5, modified_at = $6 where attendance_id = $1",
    [id, start, end, hours, actorId, now],
  );
  await audit.write(
    db,
    {
      actorId,
      action: "attendance.edit_times",
      targetType: "attendance",
      targetId: id,
      before: { actualStart: existing.actualStart, actualEnd: existing.actualEnd, hoursWorked: existing.hoursWorked },
      after: { actualStart: start, actualEnd: end, hoursWorked: hours },
    },
    { now },
  );
  return mustGet(db, id);
}

/**
 * Set the recorded hours to the scheduled window or the actual span, on a worked or in-progress day
 * with nothing paid against it, and remember which. (Attendance.adjustHours)
 */
export async function adjustHours(db: Tx, id: string, basis: unknown, actorId: string, now: Date): Promise<AttendanceRecord> {
  if (!actorId) throw new Error("actorId required");
  if (basis !== "scheduled" && basis !== "actual") throw new Error('basis must be "scheduled" or "actual"');
  if (typeof id === "string") await lockRow(db, "attendance", id);
  const existing = await mustGet(db, id);
  if (existing.status !== "worked" && existing.status !== "in_progress") throw new Error("Can only adjust hours on a worked or in-progress day");

  const paid = await paidAmount(db, id);
  if (paid > 0) throw new Error("Cannot adjust: $" + paid.toFixed(2) + " already paid. Undo the payment first.");

  const hours = basis === "scheduled" ? scheduledHours(existing) : actualHours(existing);
  if (!(hours > 0)) throw new Error("No " + basis + " hours available to apply");

  await db.query("update ops.attendance set hours_worked = $2, hours_basis = $3, modified_by = $4, modified_at = $5 where attendance_id = $1", [id, hours, basis, actorId, now]);
  await audit.write(
    db,
    { actorId, action: "attendance.adjust_hours", targetType: "attendance", targetId: id, before: { hoursWorked: existing.hoursWorked }, after: { hoursWorked: hours, basis } },
    { now },
  );
  return mustGet(db, id);
}

// ── The Schedule screen ────────────────────────────────────

export interface WeekCell {
  staffId: string;
  staffName: string;
  date: string;
  attendanceId: string | null;
  status: string | null;
  scheduledStart: string;
  scheduledEnd: string;
  hoursWorked: number;
  scheduledHours: number;
  actualHours: number;
  hoursBasis: string;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Util.formatDate as the old app's runtime answered it for an unreadable date: "NaN-NaN-NaN", not an
 * error (lib/dates.ts formatDate throws instead). Only the week grid uses it, so that an unreadable
 * weekStartStr gets the same answer as before: a grid of seven "NaN-NaN-NaN" days with no shifts.
 */
const label = (d: Date): string => (Number.isNaN(d.getTime()) ? "NaN-NaN-NaN" : formatDate(d));

/**
 * A 7-day grid for a week starting on the given date (not snapped to a Monday: the old code did not),
 * or this week's Monday when it is blank: every active person by every day. (rpcGetWeekSchedule)
 */
export async function weekSchedule(db: Db, weekStartStr: unknown, now: Date) {
  const weekStart = parseDate(weekStartStr) || getMondayOf(now);
  const weekEnd = endOfDay(addDays(weekStart, 6));

  const activeStaff = await staff.getActive(db);
  const days: Array<{ date: string; dayName: string }> = [];
  for (let i = 0; i < 7; i++) days.push({ date: label(addDays(weekStart, i)), dayName: DAY_NAMES[i] as string });

  // One read for the whole grid: the ids are deterministic, so the cells are looked up in a map.
  const ids = new Map<string, string>();
  if (!Number.isNaN(weekStart.getTime())) {
    for (const s of activeStaff) for (const d of days) ids.set(`${s.staffId}|${d.date}`, attendanceId(parseDate(d.date) as Date, s.staffId));
  }
  const rows = ids.size === 0 ? [] : await db.query<AttendanceRow>(`select ${COLUMNS} from ops.attendance where attendance_id = any($1::text[])`, [[...new Set(ids.values())]]);
  const byId = new Map(rows.map((r) => [r.attendance_id, toRecord(r)]));

  const cells: WeekCell[] = [];
  for (const s of activeStaff) {
    for (const d of days) {
      const att = byId.get(ids.get(`${s.staffId}|${d.date}`) ?? "");
      cells.push({
        staffId: s.staffId,
        staffName: s.name,
        date: d.date,
        attendanceId: att ? att.attendanceId : null,
        status: att ? att.status : null,
        scheduledStart: att ? att.scheduledStart : "",
        scheduledEnd: att ? att.scheduledEnd : "",
        hoursWorked: att ? att.hoursWorked : 0,
        scheduledHours: att ? scheduledHours(att) : 0,
        actualHours: att ? actualHours(att) : 0,
        hoursBasis: att ? att.hoursBasis : "",
      });
    }
  }

  return {
    weekStart: label(weekStart),
    weekEnd: label(weekEnd),
    days,
    staff: activeStaff.map((s) => ({ staffId: s.staffId, name: s.name })),
    cells,
  };
}

// ── The till open and close (card P3-05b) ──────────────────
//
// openOrPromote and complete are called by modules/till-sessions.ts, inside the open's and the
// close's transaction: the port of Attendance.openOrPromote_ and Attendance.complete_. complete
// reads the day's till sessions itself (one query on ops.till_sessions), not through
// modules/till-sessions.ts, so the two modules do not import each other.

/**
 * Get or create the day for (date, staff) when a till opens: no row → a new one in progress from
 * `now` (hours and rate written as 0, not blank, as before); scheduled → promoted to in progress
 * from `now`; in progress → returned unchanged; worked or cancelled → refused. (Attendance.openOrPromote)
 */
export async function openOrPromote(db: Tx, staffId: string, dateObj: Date, actorId: string, now: Date): Promise<AttendanceRecord> {
  if (!staffId) throw new Error("staffId required");
  if (!dateObj) throw new Error("date required");
  if (!actorId) throw new Error("actorId required");

  const person = typeof staffId === "string" ? await staff.getById(db, staffId) : null;
  if (!person) throw new Error("Staff not found: " + String(staffId));
  if (Number.isNaN(dateObj.getTime())) throw new Error("Invalid date");

  const id = attendanceId(dateObj, staffId);
  await lockRow(db, "attendance", id);
  const existing = await getById(db, id);

  if (existing) {
    if (existing.status === "worked") {
      throw new Error("Attendance for " + staffId + " on " + formatDate(dateObj) + " is already completed (status=worked). Cannot reopen.");
    }
    if (existing.status === "cancelled") {
      throw new Error("Attendance for " + staffId + " on " + formatDate(dateObj) + " is cancelled. Uncancel before opening.");
    }
    if (existing.status === "in_progress") return existing;
    // scheduled → promote
    await db.query("update ops.attendance set status = 'in_progress', actual_start = $2, modified_by = $3, modified_at = $4 where attendance_id = $1", [id, now, actorId, now]);
    await audit.write(
      db,
      { actorId, action: "attendance.promote", targetType: "attendance", targetId: id, before: { status: "scheduled" }, after: { status: "in_progress", actualStart: now } },
      { now },
    );
    return mustGet(db, id);
  }

  // hours_worked and rate_at_attendance are written as 0, not blank: what the old code wrote.
  await db.query(
    `insert into ops.attendance (attendance_id, staff_id, date, scheduled_start, scheduled_end, actual_start, actual_end,
       hours_worked, rate_at_attendance, status, notes, created_by, created_at, modified_by, modified_at, hours_basis)
     values ($1, $2, $3, null, null, $4, null, 0, 0, 'in_progress', null, $5, $6, null, null, null)`,
    [id, staffId, formatDate(dateObj), now, actorId, now],
  );
  await audit.write(
    db,
    { actorId, action: "attendance.open", targetType: "attendance", targetId: id, after: { staffId, date: formatDate(dateObj), status: "in_progress", actualStart: now } },
    { now },
  );
  return mustGet(db, id);
}

/**
 * Complete a day when its last till session closes: hours from the day's actual start (else the
 * earliest session start) to the latest session end, rounded; the person's rate snapshotted (NULL
 * when it is blank, never 0: ADR-0031); status worked. A worked or cancelled day is returned
 * unchanged. (Attendance.complete)
 */
export async function complete(db: Tx, id: string, now: Date, actorId: string): Promise<AttendanceRecord> {
  if (typeof id === "string") await lockRow(db, "attendance", id);
  const existing = await mustGet(db, id);
  if (existing.status === "worked") return existing;
  if (existing.status === "cancelled") return existing;

  const rows = await db.query<{ status: string | null; start_time: Date | null; end_time: Date | null }>(
    "select status, start_time, end_time from ops.till_sessions where attendance_id = $1",
    [id],
  );
  const sessions = rows.filter((s) => {
    const st = trimmed(s.status) || "open";
    return st === "closed" || st === "validated";
  });
  if (sessions.length === 0) throw new Error("Cannot complete: no closed till_sessions for " + id);

  const allStarts = sessions.map((s) => s.start_time).filter((d): d is Date => d instanceof Date);
  const allEnds = sessions.map((s) => s.end_time).filter((d): d is Date => d instanceof Date);
  if (allStarts.length === 0 || allEnds.length === 0) throw new Error("Cannot compute hours: missing till_session start/end times");

  const dayStart = existing.actualStart || new Date(Math.min(...allStarts.map((d) => d.getTime())));
  const dayEnd = new Date(Math.max(...allEnds.map((d) => d.getTime())));
  const hours = roundMoney(diffHours(dayStart, dayEnd));

  // The rate as stored: a blank is NULL here, where the old code copied 0 (`Number(x) || 0`).
  const rates = await staff.hourlyRatesOf(db, [existing.staffId]);
  const rate = rates.has(existing.staffId) ? (rates.get(existing.staffId) as number | null) : 0;

  await db.query(
    "update ops.attendance set actual_end = $2, hours_worked = $3, rate_at_attendance = $4, status = 'worked', modified_by = $5, modified_at = $6 where attendance_id = $1",
    [id, dayEnd, hours, rate, actorId, now],
  );
  await audit.write(
    db,
    {
      actorId,
      action: "attendance.complete",
      targetType: "attendance",
      targetId: id,
      before: { status: existing.status, hoursWorked: existing.hoursWorked },
      after: { status: "worked", hoursWorked: hours, rate },
    },
    { now },
  );
  return mustGet(db, id);
}
