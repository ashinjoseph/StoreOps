// Parity cases for Schedule and attendance (card P3-05a): rpcGetMe,
// rpcGetWeekSchedule, rpcScheduleShift, rpcCancelScheduledShift,
// rpcAdjustAttendanceHours and rpcEditAttendanceTimes.
//
// The fixture (frozen at Friday 20 November 2026, cases start at 10:30 that day):
//   - S_003, S_004, S_005 (employees) each have a worked row for every day from
//     2026-07-23 to 2026-11-19, hours 7 to 10, hours_basis "actual", no scheduled
//     times; S_003 also has today's row, in progress (no end, hours blank).
//   - S_001 admin, S_002 manager and S_006 payroll admin have no rows at all.
//     S_007 is inactive and has none.
//   - S_003's shifts up to 2026-11-05 are paid (payment_items).
//   - The week of Monday 2026-10-26 holds the clock change of Sunday 1 November.
//   - No fixture row has scheduled times, so "adjust to scheduled" succeeds only on
//     rows the unit tests insert (ops/test/attendance.test.ts).
//
// Every write case declares attendance and audit_log: any other table that
// changes on either side fails the case.
import { parityCase, paritySequence, resultOf, step, type ParityCase } from "../case";

const ROLES = ["admin", "manager", "employee", "payroll_admin"] as const;
const WRITES = ["attendance", "audit_log"];
const WORKED = "A_20261119_S_004"; // worked, unpaid, no schedule
const WORKED_3 = "A_20261119_S_003";
const PAID = "A_20261101_S_003"; // worked and paid
const TODAY_3 = "A_20261120_S_003"; // in progress
const NEXT_MON = "2026-11-23";

const read = (week: string, as = "manager") => step("rpcGetWeekSchedule", { as, args: [week] });
const schedule = (input: unknown, as = "manager") => step("rpcScheduleShift", { as, args: [input] });
const shift = (staffId: string, date: string, scheduledStart = "09:00", scheduledEnd = "17:00") => ({ staffId, date, scheduledStart, scheduledEnd });

export const attendanceCases: ParityCase[] = [
  // ── rpcGetMe ────────────────────────────────────────────
  ...ROLES.map((role) => parityCase("rpcGetMe", { as: role })),
  parityCase("rpcGetMe", { as: null, title: "rpcGetMe: no token is refused" }),

  // ── rpcGetWeekSchedule ──────────────────────────────────
  ...ROLES.map((role) => parityCase("rpcGetWeekSchedule", { as: role, args: ["2026-11-09"], title: `rpcGetWeekSchedule: a past week full of shifts, as ${role}` })),
  parityCase("rpcGetWeekSchedule", { as: null, args: ["2026-11-09"], title: "rpcGetWeekSchedule: no token is refused" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: ["2026-11-16"], title: "rpcGetWeekSchedule: the current week (today's shift is in progress)" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: ["2027-02-01"], title: "rpcGetWeekSchedule: a future week is empty" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: [""], title: "rpcGetWeekSchedule: a blank date means this week" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: [], title: "rpcGetWeekSchedule: no date at all means this week" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: [null], title: "rpcGetWeekSchedule: null means this week" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: ["not-a-date"], title: "rpcGetWeekSchedule: a malformed date" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: ["2026-13-45"], title: "rpcGetWeekSchedule: an impossible date" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: [12345], title: "rpcGetWeekSchedule: a number is not a date" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: ["2026-10-26"], title: "rpcGetWeekSchedule: the week of the November clock change" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: ["2026-11-01"], title: "rpcGetWeekSchedule: a week starting on the clock-change Sunday" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: ["2026-11-18"], title: "rpcGetWeekSchedule: a Wednesday is taken as the week's start (no snapping)" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: ["2026-02-30"], title: "rpcGetWeekSchedule: 30 February rolls over, as the old parse does" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: ["2026-11-09T10:00:00"], title: "rpcGetWeekSchedule: a date with a time is not a date" }),
  parityCase("rpcGetWeekSchedule", { as: "manager", args: ["2026-07-20"], title: "rpcGetWeekSchedule: the first week of history (a partial week)" }),

  // ── rpcScheduleShift ────────────────────────────────────
  paritySequence("rpcScheduleShift: a manager schedules a shift, and the week shows it", { writes: WRITES }, [
    schedule(shift("S_006", NEXT_MON)),
    read(NEXT_MON),
  ]),
  paritySequence("rpcScheduleShift: an admin schedules two people on one day", { writes: WRITES }, [
    schedule(shift("S_003", NEXT_MON, "08:00", "16:00"), "admin"),
    schedule(shift("S_004", NEXT_MON, "12:00", "20:30"), "admin"),
    read(NEXT_MON, "admin"),
  ]),
  paritySequence("rpcScheduleShift: scheduling the same person and day again updates the times in place", { writes: WRITES }, [
    schedule(shift("S_006", NEXT_MON)),
    schedule(shift("S_006", NEXT_MON, "10:00", "18:00"), "admin"),
    read(NEXT_MON),
  ]),
  paritySequence("rpcScheduleShift: blank times on an existing shift blank them", { writes: WRITES }, [
    schedule(shift("S_006", NEXT_MON)),
    schedule({ staffId: "S_006", date: NEXT_MON }),
    read(NEXT_MON),
  ]),
  paritySequence("rpcScheduleShift: a shift with no times is scheduled with blanks", { writes: WRITES }, [
    schedule({ staffId: "S_005", date: NEXT_MON }),
    read(NEXT_MON),
  ]),
  paritySequence("rpcScheduleShift: a cancelled shift scheduled again comes back", { writes: WRITES }, [
    schedule(shift("S_006", NEXT_MON)),
    step("rpcCancelScheduledShift", { as: "manager", args: [resultOf(1, "$.attendanceId"), "Sick"], advance: { minutes: 5 } }),
    read(NEXT_MON),
    schedule(shift("S_006", NEXT_MON, "13:00", "21:00"), "manager"),
    read(NEXT_MON),
  ]),
  paritySequence("rpcScheduleShift: a day that is already worked is refused", { writes: WRITES }, [
    schedule(shift("S_003", "2026-11-19")),
    read("2026-11-16"),
  ]),
  paritySequence("rpcScheduleShift: a day in progress is refused", { writes: WRITES }, [schedule(shift("S_003", "2026-11-20")), read("2026-11-16")]),
  paritySequence("rpcScheduleShift: a day in the past with no row is accepted", { writes: WRITES }, [
    schedule(shift("S_006", "2026-11-10")),
    read("2026-11-09"),
  ]),
  paritySequence("rpcScheduleShift: today, for someone not yet in", { writes: WRITES }, [schedule(shift("S_004", "2026-11-20", "17:00", "23:00")), read("2026-11-16")]),
  paritySequence("rpcScheduleShift: the inactive person can be scheduled (the old code does not check)", { writes: WRITES }, [
    schedule(shift("S_007", NEXT_MON)),
    read(NEXT_MON),
  ]),
  paritySequence("rpcScheduleShift: the day of the clock change", { writes: WRITES }, [schedule(shift("S_006", "2027-03-14")), read("2027-03-08")]),
  paritySequence("rpcScheduleShift: the day the clocks go back", { writes: WRITES }, [schedule(shift("S_006", "2026-11-01")), read("2026-10-26")]),
  paritySequence("rpcScheduleShift: an overnight range is stored as typed", { writes: WRITES }, [
    schedule(shift("S_006", NEXT_MON, "22:00", "06:00")),
    read(NEXT_MON),
  ]),
  paritySequence("rpcScheduleShift: an end equal to the start is stored as typed", { writes: WRITES }, [
    schedule(shift("S_006", NEXT_MON, "09:00", "09:00")),
    read(NEXT_MON),
  ]),
  paritySequence("rpcScheduleShift: times that are not HH:MM are stored as typed (and count as no hours)", { writes: WRITES }, [
    schedule(shift("S_006", NEXT_MON, "9am", "5pm")),
    schedule(shift("S_005", NEXT_MON, "25:99", "08:00")),
    schedule(shift("S_004", NEXT_MON, "  9:30 ", " 17:45  ")),
    read(NEXT_MON),
  ]),
  paritySequence("rpcScheduleShift: a start with no end", { writes: WRITES }, [schedule({ staffId: "S_006", date: NEXT_MON, scheduledStart: "09:00" }), read(NEXT_MON)]),
  paritySequence("rpcScheduleShift: the first schedule has an empty-string update on the second", { writes: WRITES }, [
    schedule(shift("S_006", NEXT_MON)),
    schedule({ staffId: "S_006", date: NEXT_MON, scheduledStart: "", scheduledEnd: "18:00" }),
    read(NEXT_MON),
  ]),
  parityCase("rpcScheduleShift", { as: "manager", args: [{ date: NEXT_MON, scheduledStart: "09:00", scheduledEnd: "17:00" }], title: "rpcScheduleShift: no person is refused" }),
  parityCase("rpcScheduleShift", { as: "manager", args: [shift("S_999", NEXT_MON)], title: "rpcScheduleShift: an unknown person is refused" }),
  parityCase("rpcScheduleShift", { as: "manager", args: [shift("s_003", NEXT_MON)], title: "rpcScheduleShift: a staff id in the wrong case is unknown" }),
  parityCase("rpcScheduleShift", { as: "manager", args: [{ staffId: 3, date: NEXT_MON }], title: "rpcScheduleShift: a number is not a staff id" }),
  parityCase("rpcScheduleShift", { as: "manager", args: [{ staffId: "S_003", scheduledStart: "09:00" }], title: "rpcScheduleShift: no date is refused" }),
  parityCase("rpcScheduleShift", { as: "manager", args: [{ staffId: "S_003", date: "" }], title: "rpcScheduleShift: a blank date is refused" }),
  parityCase("rpcScheduleShift", { as: "manager", args: [{ staffId: "S_003", date: "next tuesday" }], title: "rpcScheduleShift: a malformed date is refused" }),
  parityCase("rpcScheduleShift", { as: "manager", args: [{ staffId: "S_003", date: "2026-13-45" }], title: "rpcScheduleShift: an impossible date is refused" }),
  parityCase("rpcScheduleShift", { as: "manager", args: [], title: "rpcScheduleShift: no input object at all" }),
  parityCase("rpcScheduleShift", { as: "manager", args: [null], title: "rpcScheduleShift: a null input object" }),
  parityCase("rpcScheduleShift", { as: "manager", args: ["S_003"], title: "rpcScheduleShift: a string instead of an input object" }),
  parityCase("rpcScheduleShift", { as: "employee", args: [shift("S_003", NEXT_MON)], title: "rpcScheduleShift: an employee is refused" }),
  parityCase("rpcScheduleShift", { as: "payroll_admin", args: [shift("S_003", NEXT_MON)], title: "rpcScheduleShift: a payroll admin is refused" }),
  parityCase("rpcScheduleShift", { as: null, args: [shift("S_003", NEXT_MON)], title: "rpcScheduleShift: no token is refused" }),

  // ── rpcCancelScheduledShift ─────────────────────────────
  paritySequence("rpcCancelScheduledShift: a scheduled shift, with a reason", { writes: WRITES }, [
    schedule(shift("S_006", NEXT_MON)),
    step("rpcCancelScheduledShift", { as: "manager", args: [resultOf(1, "$.attendanceId"), "Called in sick"], advance: { minutes: 10 } }),
    read(NEXT_MON),
  ]),
  paritySequence("rpcCancelScheduledShift: a scheduled shift, no reason", { writes: WRITES }, [
    schedule(shift("S_006", NEXT_MON)),
    step("rpcCancelScheduledShift", { as: "admin", args: [resultOf(1, "$.attendanceId")] }),
    read(NEXT_MON, "admin"),
  ]),
  paritySequence("rpcCancelScheduledShift: cancelling twice appends to the note each time", { writes: WRITES }, [
    schedule(shift("S_006", NEXT_MON)),
    step("rpcCancelScheduledShift", { as: "manager", args: [resultOf(1, "$.attendanceId"), "first"] }),
    step("rpcCancelScheduledShift", { as: "manager", args: [resultOf(1, "$.attendanceId"), "second"], advance: { minutes: 1 } }),
    read(NEXT_MON),
  ]),
  paritySequence("rpcCancelScheduledShift: a worked, unpaid shift can be cancelled (its hours stay)", { writes: WRITES }, [
    step("rpcCancelScheduledShift", { as: "manager", args: [WORKED, "Entered by mistake"] }),
    read("2026-11-16"),
  ]),
  paritySequence("rpcCancelScheduledShift: a shift in progress can be cancelled", { writes: WRITES }, [
    step("rpcCancelScheduledShift", { as: "manager", args: [TODAY_3, "Never came"] }),
    read("2026-11-16"),
  ]),
  paritySequence("rpcCancelScheduledShift: a paid shift is refused with the amount paid", { writes: WRITES }, [
    step("rpcCancelScheduledShift", { as: "manager", args: [PAID, "too late"] }),
    read("2026-10-26"),
  ]),
  parityCase("rpcCancelScheduledShift", { as: "manager", args: ["A_20260101_S_003", "nothing"], title: "rpcCancelScheduledShift: an unknown id is refused" }),
  parityCase("rpcCancelScheduledShift", { as: "manager", args: [], title: "rpcCancelScheduledShift: no id at all" }),
  parityCase("rpcCancelScheduledShift", { as: "manager", args: [null, "x"], title: "rpcCancelScheduledShift: a null id" }),
  parityCase("rpcCancelScheduledShift", { as: "manager", args: [""], title: "rpcCancelScheduledShift: a blank id" }),
  parityCase("rpcCancelScheduledShift", { as: "employee", args: [WORKED, "x"], title: "rpcCancelScheduledShift: an employee is refused" }),
  parityCase("rpcCancelScheduledShift", { as: "payroll_admin", args: [WORKED, "x"], title: "rpcCancelScheduledShift: a payroll admin is refused" }),
  parityCase("rpcCancelScheduledShift", { as: null, args: [WORKED, "x"], title: "rpcCancelScheduledShift: no token is refused" }),

  // ── rpcAdjustAttendanceHours ────────────────────────────
  paritySequence("rpcAdjustAttendanceHours: 'actual' on a worked shift keeps the hours and stamps the basis", { writes: WRITES }, [
    step("rpcAdjustAttendanceHours", { as: "manager", args: [WORKED, "actual"] }),
    read("2026-11-16"),
  ]),
  paritySequence("rpcAdjustAttendanceHours: 'scheduled' on a worked shift with no schedule is refused", { writes: WRITES }, [
    step("rpcAdjustAttendanceHours", { as: "manager", args: [WORKED, "scheduled"] }),
    read("2026-11-16"),
  ]),
  paritySequence("rpcAdjustAttendanceHours: after the times are edited, 'actual' follows the new times", { writes: WRITES }, [
    step("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: WORKED, actualStart: "2026-11-19T14:00:00.000Z", actualEnd: "2026-11-19T21:20:00.000Z" }] }),
    read("2026-11-16", "admin"),
    step("rpcAdjustAttendanceHours", { as: "manager", args: [WORKED, "actual"], advance: { minutes: 3 } }),
    read("2026-11-16"),
  ]),
  paritySequence("rpcAdjustAttendanceHours: a span of 1h 0m 18s (1.005 hours) is stored as 1, not the 1.01 a database would round to", { writes: WRITES }, [
    step("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: WORKED, actualStart: "2026-11-19T14:00:00.000Z", actualEnd: "2026-11-19T15:00:18.000Z" }] }),
    step("rpcAdjustAttendanceHours", { as: "manager", args: [WORKED, "actual"], advance: { minutes: 3 } }),
    read("2026-11-16"),
  ]),
  paritySequence("rpcAdjustAttendanceHours: scheduling a worked day is refused, and 'scheduled' stays refused", { writes: WRITES }, [
    schedule(shift("S_004", "2026-11-19")),
    step("rpcAdjustAttendanceHours", { as: "admin", args: [WORKED, "scheduled"] }),
  ]),
  paritySequence("rpcAdjustAttendanceHours: a shift in progress has no end, so 'actual' has no hours", { writes: WRITES }, [
    step("rpcAdjustAttendanceHours", { as: "manager", args: [TODAY_3, "actual"] }),
    step("rpcAdjustAttendanceHours", { as: "manager", args: [TODAY_3, "scheduled"] }),
  ]),
  paritySequence("rpcAdjustAttendanceHours: a shift in progress whose times were set can be adjusted", { writes: WRITES }, [
    step("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: TODAY_3, actualStart: "2026-11-20T13:02:00.000Z", actualEnd: "2026-11-20T14:47:30.000Z" }] }),
    step("rpcAdjustAttendanceHours", { as: "manager", args: [TODAY_3, "actual"], advance: { minutes: 1 } }),
    read("2026-11-16"),
  ]),
  paritySequence("rpcAdjustAttendanceHours: a cancelled day cannot be adjusted", { writes: WRITES }, [
    step("rpcCancelScheduledShift", { as: "manager", args: [WORKED, "oops"] }),
    step("rpcAdjustAttendanceHours", { as: "manager", args: [WORKED, "actual"] }),
  ]),
  paritySequence("rpcAdjustAttendanceHours: a scheduled day (not yet worked) is refused", { writes: WRITES }, [
    schedule(shift("S_006", NEXT_MON)),
    step("rpcAdjustAttendanceHours", { as: "manager", args: [resultOf(1, "$.attendanceId"), "scheduled"] }),
  ]),
  parityCase("rpcAdjustAttendanceHours", { as: "manager", args: [PAID, "actual"], title: "rpcAdjustAttendanceHours: a paid shift is refused with the amount paid" }),
  parityCase("rpcAdjustAttendanceHours", { as: "manager", args: ["A_20260101_S_003", "actual"], title: "rpcAdjustAttendanceHours: an unknown id is refused" }),
  parityCase("rpcAdjustAttendanceHours", { as: "manager", args: [WORKED, "other"], title: "rpcAdjustAttendanceHours: a bad basis is refused" }),
  parityCase("rpcAdjustAttendanceHours", { as: "manager", args: [WORKED, "ACTUAL"], title: "rpcAdjustAttendanceHours: the basis is case sensitive" }),
  parityCase("rpcAdjustAttendanceHours", { as: "manager", args: [WORKED], title: "rpcAdjustAttendanceHours: no basis" }),
  parityCase("rpcAdjustAttendanceHours", { as: "manager", args: [], title: "rpcAdjustAttendanceHours: no arguments" }),
  parityCase("rpcAdjustAttendanceHours", { as: "manager", args: ["A_20260101_S_003", "other"], title: "rpcAdjustAttendanceHours: a bad basis is reported before an unknown id" }),
  parityCase("rpcAdjustAttendanceHours", { as: "employee", args: [WORKED, "actual"], title: "rpcAdjustAttendanceHours: an employee is refused" }),
  parityCase("rpcAdjustAttendanceHours", { as: "payroll_admin", args: [WORKED, "actual"], title: "rpcAdjustAttendanceHours: a payroll admin is refused" }),
  parityCase("rpcAdjustAttendanceHours", { as: null, args: [WORKED, "actual"], title: "rpcAdjustAttendanceHours: no token is refused" }),

  // ── rpcEditAttendanceTimes ──────────────────────────────
  paritySequence("rpcEditAttendanceTimes: an admin corrects a worked shift; the hours follow and the pay basis is cleared", { writes: WRITES }, [
    step("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: WORKED_3, actualStart: "2026-11-19T14:30:00.000Z", actualEnd: "2026-11-19T22:10:00.000Z" }] }),
    read("2026-11-16", "admin"),
  ]),
  paritySequence("rpcEditAttendanceTimes: hours are rounded to the cent of an hour", { writes: WRITES }, [
    step("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: WORKED, actualStart: "2026-11-19T14:00:00.000Z", actualEnd: "2026-11-19T20:20:20.000Z" }] }),
    read("2026-11-16", "admin"),
  ]),
  paritySequence("rpcEditAttendanceTimes: times as epoch milliseconds", { writes: WRITES }, [
    step("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: WORKED, actualStart: Date.UTC(2026, 10, 19, 14, 0), actualEnd: Date.UTC(2026, 10, 19, 22, 0) }] }),
    read("2026-11-16", "admin"),
  ]),
  paritySequence("rpcEditAttendanceTimes: times with no zone are Toronto time", { writes: WRITES }, [
    step("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: WORKED, actualStart: "2026-11-19T09:00:00", actualEnd: "2026-11-19T17:30:00" }] }),
    read("2026-11-16", "admin"),
  ]),
  paritySequence("rpcEditAttendanceTimes: a shift across the November clock change is a real 9 hours", { writes: WRITES }, [
    step("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: "A_20261031_S_003", actualStart: "2026-10-31T22:00:00", actualEnd: "2026-11-01T06:00:00" }] }),
    read("2026-10-26", "admin"),
  ]),
  paritySequence("rpcEditAttendanceTimes: a cancelled day can have its times edited", { writes: WRITES }, [
    step("rpcCancelScheduledShift", { as: "manager", args: [WORKED, "x"] }),
    step("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: WORKED, actualStart: "2026-11-19T14:00:00.000Z", actualEnd: "2026-11-19T18:00:00.000Z" }] }),
    read("2026-11-16", "admin"),
  ]),
  paritySequence("rpcEditAttendanceTimes: a scheduled day gets actual times and hours but stays scheduled", { writes: WRITES }, [
    schedule(shift("S_006", NEXT_MON)),
    step("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: resultOf(1, "$.attendanceId"), actualStart: "2026-11-23T14:00:00.000Z", actualEnd: "2026-11-23T22:00:00.000Z" }] }),
    read(NEXT_MON, "admin"),
  ]),
  parityCase("rpcEditAttendanceTimes", {
    as: "admin",
    args: [{ attendanceId: WORKED, actualStart: "2026-11-19T20:00:00.000Z", actualEnd: "2026-11-19T14:00:00.000Z" }],
    title: "rpcEditAttendanceTimes: an end before the start is refused",
  }),
  parityCase("rpcEditAttendanceTimes", {
    as: "admin",
    args: [{ attendanceId: WORKED, actualStart: "2026-11-19T14:00:00.000Z", actualEnd: "2026-11-19T14:00:00.000Z" }],
    title: "rpcEditAttendanceTimes: an end equal to the start is refused",
  }),
  parityCase("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: WORKED }], title: "rpcEditAttendanceTimes: missing times are refused" }),
  parityCase("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: WORKED, actualStart: "2026-11-19T14:00:00.000Z" }], title: "rpcEditAttendanceTimes: a missing end is refused" }),
  parityCase("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: WORKED, actualStart: "garbage", actualEnd: "nonsense" }], title: "rpcEditAttendanceTimes: unreadable times are refused" }),
  parityCase("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: WORKED, actualStart: "", actualEnd: "" }], title: "rpcEditAttendanceTimes: blank times are refused" }),
  parityCase("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId: WORKED, actualStart: null, actualEnd: null }], title: "rpcEditAttendanceTimes: null times are refused (null is the epoch, and an end equal to the start)" }),
  parityCase("rpcEditAttendanceTimes", { as: "admin", args: [{ actualStart: "2026-11-19T14:00:00.000Z", actualEnd: "2026-11-19T20:00:00.000Z" }], title: "rpcEditAttendanceTimes: no id is refused" }),
  parityCase("rpcEditAttendanceTimes", {
    as: "admin",
    args: [{ attendanceId: "A_20260101_S_003", actualStart: "2026-11-19T14:00:00.000Z", actualEnd: "2026-11-19T20:00:00.000Z" }],
    title: "rpcEditAttendanceTimes: an unknown id is refused before the times are looked at",
  }),
  parityCase("rpcEditAttendanceTimes", {
    as: "admin",
    args: [{ attendanceId: PAID, actualStart: "2026-11-01T14:00:00.000Z", actualEnd: "2026-11-01T20:00:00.000Z" }],
    title: "rpcEditAttendanceTimes: a paid shift is refused with the amount paid",
  }),
  parityCase("rpcEditAttendanceTimes", { as: "admin", args: [], title: "rpcEditAttendanceTimes: no input object at all" }),
  parityCase("rpcEditAttendanceTimes", {
    as: "manager",
    args: [{ attendanceId: WORKED, actualStart: "2026-11-19T14:00:00.000Z", actualEnd: "2026-11-19T20:00:00.000Z" }],
    title: "rpcEditAttendanceTimes: a manager is refused",
  }),
  parityCase("rpcEditAttendanceTimes", {
    as: "employee",
    args: [{ attendanceId: WORKED, actualStart: "2026-11-19T14:00:00.000Z", actualEnd: "2026-11-19T20:00:00.000Z" }],
    title: "rpcEditAttendanceTimes: an employee is refused",
  }),
  parityCase("rpcEditAttendanceTimes", {
    as: "payroll_admin",
    args: [{ attendanceId: WORKED, actualStart: "2026-11-19T14:00:00.000Z", actualEnd: "2026-11-19T20:00:00.000Z" }],
    title: "rpcEditAttendanceTimes: a payroll admin is refused",
  }),
  parityCase("rpcEditAttendanceTimes", { as: null, args: [{ attendanceId: WORKED }], title: "rpcEditAttendanceTimes: no token is refused" }),
];
