// The Attendance module and its six RPCs, against a real database with invented people.
//
// The parity cases (ops/parity/cases/attendance.ts) compare the fixture's shapes with the old
// app. What the fixture lacks is covered here: a schedule with times that is worked (so "adjust
// to scheduled" can succeed), an overnight schedule, blank and zero hours, a cancelled day with
// a note, a paid day, padded text, and two managers editing one shift at once. Expected values
// are what src/Attendance.gs and the rpc* functions in src/WebApp.gs return and store.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import * as attendance from "../src/modules/attendance";
import {
  rpcAdjustAttendanceHours,
  rpcCancelScheduledShift,
  rpcEditAttendanceTimes,
  rpcGetWeekSchedule,
  rpcScheduleShift,
} from "../src/rpc/handlers/attendance";
import { rpcGetMe } from "../src/rpc/handlers/auth";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
// The app role cannot delete money or audit rows (by design), so the fixture rows are reset as the owner.
let owner: Db & { close(): Promise<void> };

// Toronto is UTC-4 in June (summer time): 09:00 local is 13:00Z.
const NOW = new Date("2026-06-10T15:00:00Z");
const LATER = new Date("2026-06-10T16:30:00Z");

const STAFF: Array<[string, string, number | null, boolean, string]> = [
  ["S_001", "Ada Quill", 25, true, "admin"],
  ["S_002", "Bram Hale", 21, true, "manager"],
  ["S_003", "Cleo Marsh", 18.25, true, "employee"],
  ["S_004", "Dara Vance", null, false, "employee"],
  ["S_005", "  Eli Stone  ", 17.5, true, "employee"],
];

type Row = {
  id: string;
  staff: string;
  date: string;
  ss?: string | null;
  se?: string | null;
  as?: string | null;
  ae?: string | null;
  hours?: number | null;
  rate?: number | null;
  status: string;
  notes?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
  basis?: string | null;
};

const ROWS: Row[] = [
  // Scheduled 09:00-17:00 and worked 09:05-17:35 (Toronto): 8.5 actual hours, 8 scheduled, 8.5 recorded.
  { id: "A_20260601_S_003", staff: "S_003", date: "2026-06-01", ss: "09:00", se: "17:00", as: "2026-06-01T13:05:00Z", ae: "2026-06-01T21:35:00Z", hours: 8.5, rate: 18.25, status: "worked", createdBy: "S_003", createdAt: "2026-06-01T13:05:00Z" },
  // Overnight schedule, in progress, no end yet, hours blank.
  { id: "A_20260602_S_003", staff: "S_003", date: "2026-06-02", ss: " 22:00", se: "06:00 ", as: "2026-06-03T02:00:00Z", status: "in_progress", createdBy: "S_001", createdAt: "2026-06-01T20:00:00Z" },
  // Scheduled only: blank hours, rate, times.
  { id: "A_20260603_S_005", staff: "S_005", date: "2026-06-03", ss: "10:00", se: "18:30", status: "scheduled", createdBy: "S_002", createdAt: "2026-06-01T20:05:00Z" },
  // Cancelled with a note.
  { id: "A_20260604_S_005", staff: "S_005", date: "2026-06-04", ss: "10:00", se: "14:00", hours: 0, rate: 0, status: "cancelled", notes: "Cancelled: ill", createdBy: "S_002", createdAt: "2026-06-01T20:06:00Z" },
  // Worked and paid.
  { id: "A_20260605_S_003", staff: "S_003", date: "2026-06-05", as: "2026-06-05T13:00:00Z", ae: "2026-06-05T20:00:00Z", hours: 7, rate: 18.25, status: "worked", createdBy: "S_003", createdAt: "2026-06-05T13:00:00Z", basis: "actual" },
  // Worked, a day with hours of 0 and no times at all.
  { id: "A_20260606_S_005", staff: "S_005", date: "2026-06-06", hours: 0, rate: 17.5, status: "worked", createdBy: "S_001", createdAt: "2026-06-06T13:00:00Z" },
  // Worked 1h 0m 18s: 1.005 hours, which floating point rounds to 1 and a database rounds to 1.01.
  { id: "A_20260607_S_003", staff: "S_003", date: "2026-06-07", ss: "09:00", se: "16:00", as: "2026-06-07T13:00:00Z", ae: "2026-06-07T14:00:18Z", hours: 7, rate: 18.25, status: "worked", createdBy: "S_003", createdAt: "2026-06-07T13:00:00Z" },
];

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
  for (const t of ["audit_log", "payment_items", "payments", "attendance", "staff"]) await owner.query(`delete from ops.${t}`);
  for (const s of STAFF) {
    await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role) values ($1,$2,$3,$4,$5)", s);
  }
  for (const r of ROWS) {
    await owner.query(
      `insert into ops.attendance (attendance_id, staff_id, date, scheduled_start, scheduled_end, actual_start, actual_end,
         hours_worked, rate_at_attendance, status, notes, created_by, created_at, hours_basis)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [r.id, r.staff, r.date, r.ss ?? null, r.se ?? null, r.as ?? null, r.ae ?? null, r.hours ?? null, r.rate ?? null, r.status, r.notes ?? null, r.createdBy ?? null, r.createdAt ?? null, r.basis ?? null],
    );
  }
  await owner.query("insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method) values ('P_1','S_003','2026-06-08',130.5,'cash')");
  await owner.query("insert into ops.payment_items (item_id, payment_id, item_type, ref_id, amount) values ('I_1','P_1','shift','A_20260605_S_003',100.25), ('I_2','P_1','shift','A_20260605_S_003',30.25)");
});

const session = (staffId: string, role: Session["role"]): Session => ({ staffId, name: "x", role, companiesAuthorized: ["cstore"], expiresAt: 0 });
const MANAGER = session("S_002", "manager");
const ADMIN = session("S_001", "admin");

async function rpc(handler: (ctx: RpcContext, ...a: unknown[]) => unknown, who: Session | null, args: unknown[], now = NOW): Promise<any> {
  return withTransaction(db, async (tx) => handler({ db: tx, session: who, config: () => Promise.reject(new Error("no config")), env: {}, fetch, now }, ...args));
}
const row = (id: string) => db.one<any>("select * from ops.attendance where attendance_id = $1", [id]);
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details, "timestamp" from ops.audit_log order by seq`);

describe("reads", () => {
  it("getById returns the old record shape: trimmed text, blank times null, blank hours 0; a blank rate is null (ADR-0031)", async () => {
    expect(await attendance.getById(db, "A_20260603_S_005")).toEqual({
      attendanceId: "A_20260603_S_005",
      staffId: "S_005",
      date: "2026-06-03",
      scheduledStart: "10:00",
      scheduledEnd: "18:30",
      actualStart: null,
      actualEnd: null,
      hoursWorked: 0, // blank in the database, 0 in the old record (Number(x) || 0): kept
      rateAtAttendance: null, // blank: null, not the old 0 (card P4-11b, ADR-0031)
      status: "scheduled",
      notes: "",
      createdBy: "S_002",
      createdAt: new Date("2026-06-01T20:05:00Z"),
      modifiedBy: "",
      modifiedAt: null,
      hoursBasis: "",
    });
  });
  it("trims scheduled times, keeps notes as typed, and gives instants as Dates", async () => {
    const r = await attendance.getById(db, "A_20260602_S_003");
    expect(r).toMatchObject({ scheduledStart: "22:00", scheduledEnd: "06:00", actualStart: new Date("2026-06-03T02:00:00Z"), actualEnd: null });
    expect((await attendance.getById(db, "A_20260604_S_005"))?.notes).toBe("Cancelled: ill");
  });
  it("getById is null for an unknown id and for something that is not an id", async () => {
    expect(await attendance.getById(db, "A_nope")).toBeNull();
    expect(await attendance.getById(db, undefined as never)).toBeNull();
    expect(await attendance.getById(db, 5 as never)).toBeNull();
  });
  it("getForDateAndStaff builds the deterministic id", async () => {
    expect((await attendance.getForDateAndStaff(db, new Date("2026-06-05T04:00:00Z"), "S_003"))?.attendanceId).toBe("A_20260605_S_003");
    expect(await attendance.getForDateAndStaff(db, new Date("2026-06-05T04:00:00Z"), "S_005")).toBeNull();
  });
  it("getForStaff lists one person's days in the order they were created", async () => {
    expect((await attendance.getForStaff(db, "S_003")).map((a) => a.attendanceId)).toEqual(["A_20260601_S_003", "A_20260602_S_003", "A_20260605_S_003", "A_20260607_S_003"]);
  });
  it("getForDateRange includes both ends, filters by person, and keeps creation order", async () => {
    const ids = (await attendance.getForDateRange(db, "2026-06-02", "2026-06-05")).map((a) => a.attendanceId);
    expect(ids).toEqual(["A_20260602_S_003", "A_20260603_S_005", "A_20260604_S_005", "A_20260605_S_003"]);
    const one = await attendance.getForDateRange(db, new Date("2026-06-02T04:00:00Z"), new Date("2026-06-05T04:00:00Z"), "S_005");
    expect(one.map((a) => a.attendanceId)).toEqual(["A_20260603_S_005", "A_20260604_S_005"]);
  });
  it("getForDateRange with a start part-way through a day starts the next day, and an end part-way through a day includes that day", async () => {
    const ids = (await attendance.getForDateRange(db, new Date("2026-06-02T12:00:00Z"), new Date("2026-06-04T12:00:00Z"))).map((a) => a.attendanceId);
    expect(ids).toEqual(["A_20260603_S_005", "A_20260604_S_005"]);
  });
  it("getForDateRange with an empty bound is [] and with an unreadable one has no bound (the old comparisons with an Invalid Date are all false)", async () => {
    expect(await attendance.getForDateRange(db, "", "2026-06-05")).toEqual([]);
    expect(await attendance.getForDateRange(db, "2026-06-01", null as never)).toEqual([]);
    expect((await attendance.getForDateRange(db, "garbage", "garbage")).length).toBe(ROWS.length);
  });
});

describe("hours helpers", () => {
  it("scheduledHours reads HH:MM, overnight, and gives 0 for anything else", async () => {
    const h = (s: string, e: string) => attendance.scheduledHours({ scheduledStart: s, scheduledEnd: e });
    expect(h("09:00", "17:00")).toBe(8);
    expect(h("9:30", "17:45")).toBe(8.25);
    expect(h("22:00", "06:00")).toBe(8);
    expect(h("09:00", "09:00")).toBe(24); // an end equal to the start is "overnight": a whole day
    expect(h("09:00", "")).toBe(0);
    expect(h("25:00", "08:00")).toBe(0);
    expect(h("9am", "5pm")).toBe(0);
    expect(h("09:00", "17:20")).toBe(8.33);
  });
  it("actualHours is the rounded span, 0 when either end is missing", async () => {
    const t = (a: string | null, e: string | null) => attendance.actualHours({ actualStart: a ? new Date(a) : null, actualEnd: e ? new Date(e) : null });
    expect(t("2026-06-07T13:00:00Z", "2026-06-07T14:00:18Z")).toBe(1); // 1.005 rounds down in floating point (a database would say 1.01)
    expect(t("2026-06-07T13:00:00Z", "2026-06-07T21:30:00Z")).toBe(8.5);
    expect(t("2026-06-07T13:00:00Z", null)).toBe(0);
    expect(t(null, null)).toBe(0);
  });
});

describe("paidAmount", () => {
  it("sums the shift payment items against a day, rounded", async () => {
    expect(await attendance.paidAmount(db, "A_20260605_S_003")).toBe(130.5);
    expect(await attendance.paidAmount(db, "A_20260601_S_003")).toBe(0);
  });
});

describe("rpcScheduleShift", () => {
  it("a new shift: one row with blanks as NULL, hours and rate as 0, who and when from the session and the clock", async () => {
    const out = await rpc(rpcScheduleShift, MANAGER, [{ staffId: "S_003", date: "2026-06-20", scheduledStart: "09:00", scheduledEnd: "17:00", actorId: "S_001", notes: "ignored" }]);
    expect(out).toEqual({
      attendanceId: "A_20260620_S_003",
      staffId: "S_003",
      date: null, // a Date in the old app: the page has always received null
      scheduledStart: "09:00",
      scheduledEnd: "17:00",
      actualStart: null,
      actualEnd: null,
      hoursWorked: 0,
      rateAtAttendance: 0,
      status: "scheduled",
      notes: "",
      createdBy: "S_002",
      createdAt: null,
      modifiedBy: "",
      modifiedAt: null,
      hoursBasis: "",
    });
    expect(await row("A_20260620_S_003")).toMatchObject({
      date: "2026-06-20",
      actual_start: null,
      actual_end: null,
      hours_worked: 0,
      rate_at_attendance: 0,
      notes: null,
      created_by: "S_002",
      created_at: NOW,
      modified_by: null,
      modified_at: null,
      hours_basis: null,
      status: "scheduled",
    });
  });
  it("writes one audit row with the old action, target and JSON", async () => {
    await rpc(rpcScheduleShift, MANAGER, [{ staffId: "S_003", date: "2026-06-20", scheduledStart: "09:00", scheduledEnd: "17:00" }]);
    expect(await audits()).toEqual([
      {
        actor_id: "S_002",
        action: "attendance.schedule",
        target_type: "attendance",
        target_id: "A_20260620_S_003",
        before: null,
        after: '{"staffId":"S_003","date":"2026-06-20","scheduledStart":"09:00","scheduledEnd":"17:00"}',
        details: null,
        timestamp: NOW,
      },
    ]);
  });
  it("blank times are stored as NULL and audited as empty strings", async () => {
    await rpc(rpcScheduleShift, ADMIN, [{ staffId: "S_003", date: "2026-06-21" }]);
    expect(await row("A_20260621_S_003")).toMatchObject({ scheduled_start: null, scheduled_end: null });
    expect((await audits())[0].after).toBe('{"staffId":"S_003","date":"2026-06-21","scheduledStart":"","scheduledEnd":""}');
  });
  it("the same person and day again updates the times, keeps the creator, and audits before and after", async () => {
    await rpc(rpcScheduleShift, MANAGER, [{ staffId: "S_003", date: "2026-06-20", scheduledStart: "09:00", scheduledEnd: "17:00" }]);
    const out = await rpc(rpcScheduleShift, ADMIN, [{ staffId: "S_003", date: "2026-06-20", scheduledStart: "10:00", scheduledEnd: "18:00" }], LATER);
    expect(out).toMatchObject({ scheduledStart: "10:00", scheduledEnd: "18:00", createdBy: "S_002", modifiedBy: "S_001", status: "scheduled" });
    expect(await row("A_20260620_S_003")).toMatchObject({ modified_by: "S_001", modified_at: LATER, created_at: NOW });
    const a = await audits();
    expect(a).toHaveLength(2);
    expect(a[1]).toMatchObject({
      action: "attendance.schedule_update",
      actor_id: "S_001",
      before: '{"scheduledStart":"09:00","scheduledEnd":"17:00"}',
      after: '{"scheduledStart":"10:00","scheduledEnd":"18:00"}',
    });
  });
  it("a cancelled day scheduled again is scheduled again, notes kept", async () => {
    const out = await rpc(rpcScheduleShift, MANAGER, [{ staffId: "S_005", date: "2026-06-04", scheduledStart: "11:00", scheduledEnd: "15:00" }]);
    expect(out).toMatchObject({ status: "scheduled", scheduledStart: "11:00", notes: "Cancelled: ill" });
    expect(await row("A_20260604_S_005")).toMatchObject({ status: "scheduled", notes: "Cancelled: ill", hours_worked: 0 });
  });
  it("a day in progress or worked is refused, and nothing is written", async () => {
    await expect(rpc(rpcScheduleShift, MANAGER, [{ staffId: "S_003", date: "2026-06-02" }])).rejects.toThrow("Cannot schedule: attendance A_20260602_S_003 is already in_progress");
    await expect(rpc(rpcScheduleShift, MANAGER, [{ staffId: "S_003", date: "2026-06-01" }])).rejects.toThrow("Cannot schedule: attendance A_20260601_S_003 is already worked");
    expect(await audits()).toEqual([]);
  });
  it("refuses a missing or unknown person and a missing date with the old messages; the inactive person is accepted", async () => {
    await expect(rpc(rpcScheduleShift, MANAGER, [{ date: "2026-06-20" }])).rejects.toThrow("staffId required");
    await expect(rpc(rpcScheduleShift, MANAGER, [{ staffId: "S_999", date: "2026-06-20" }])).rejects.toThrow("Staff not found: S_999");
    await expect(rpc(rpcScheduleShift, MANAGER, [{ staffId: "S_003" }])).rejects.toThrow("date required");
    await expect(rpc(rpcScheduleShift, MANAGER, [{ staffId: "S_003", date: "" }])).rejects.toThrow("date required");
    await expect(rpc(rpcScheduleShift, MANAGER, [{ staffId: 3, date: "2026-06-20" }])).rejects.toThrow("Staff not found: 3");
    // The old code, given an unreadable date, wrote a row whose id held NaN (the Sheet took it). A date column cannot: refused.
    await expect(rpc(rpcScheduleShift, MANAGER, [{ staffId: "S_003", date: "next tuesday" }])).rejects.toThrow("Invalid date");
    await rpc(rpcScheduleShift, MANAGER, [{ staffId: "S_004", date: "2026-06-20" }]);
    expect((await row("A_20260620_S_004")).staff_id).toBe("S_004");
  });
  it("an input object that is not an object fails as the old property read did, as a message for the person", async () => {
    await expect(rpc(rpcScheduleShift, MANAGER, [])).rejects.toThrow("Cannot read properties of undefined (reading 'staffId')");
    await expect(rpc(rpcScheduleShift, MANAGER, [null])).rejects.toThrow("Cannot read properties of null (reading 'staffId')");
    await expect(rpc(rpcScheduleShift, MANAGER, ["S_003"])).rejects.toThrow("staffId required");
  });
  it("identity comes from the session, never from an actorId in the input", async () => {
    await rpc(rpcScheduleShift, MANAGER, [{ staffId: "S_003", date: "2026-06-20", actorId: "S_001", createdBy: "S_001" }]);
    expect((await row("A_20260620_S_003")).created_by).toBe("S_002");
    expect((await audits())[0].actor_id).toBe("S_002");
  });
});

describe("rpcCancelScheduledShift", () => {
  it("cancels, appends the reason to the note, stamps who and when, audits", async () => {
    const out = await rpc(rpcCancelScheduledShift, MANAGER, ["A_20260603_S_005", "Called in sick"]);
    expect(out).toMatchObject({ status: "cancelled", notes: "Cancelled: Called in sick", modifiedBy: "S_002", date: null, modifiedAt: null });
    expect(await row("A_20260603_S_005")).toMatchObject({ status: "cancelled", notes: "Cancelled: Called in sick", modified_by: "S_002", modified_at: NOW, hours_worked: null });
    expect(await audits()).toEqual([
      {
        actor_id: "S_002",
        action: "attendance.cancel",
        target_type: "attendance",
        target_id: "A_20260603_S_005",
        before: '{"status":"scheduled"}',
        after: '{"status":"cancelled","reason":"Called in sick"}',
        details: null,
        timestamp: NOW,
      },
    ]);
  });
  it("no reason gives 'Cancelled: ' and an empty reason; an earlier note is kept after ' | '", async () => {
    await rpc(rpcCancelScheduledShift, MANAGER, ["A_20260604_S_005"]);
    expect((await row("A_20260604_S_005")).notes).toBe("Cancelled: ill | Cancelled: ");
    expect((await audits())[0].after).toBe('{"status":"cancelled","reason":""}');
  });
  it("a worked day can be cancelled and keeps its hours", async () => {
    await rpc(rpcCancelScheduledShift, ADMIN, ["A_20260601_S_003", "entered twice"]);
    expect(await row("A_20260601_S_003")).toMatchObject({ status: "cancelled", hours_worked: 8.5, rate_at_attendance: 18.25 });
    expect((await audits())[0].before).toBe('{"status":"worked"}');
  });
  it("is refused with the amount when something was paid, and for an unknown or missing id", async () => {
    await expect(rpc(rpcCancelScheduledShift, MANAGER, ["A_20260605_S_003", "x"])).rejects.toThrow("Cannot cancel: $130.50 has been paid against this attendance. Undo the payment first.");
    await expect(rpc(rpcCancelScheduledShift, MANAGER, ["A_nope", "x"])).rejects.toThrow("attendance not found: A_nope");
    await expect(rpc(rpcCancelScheduledShift, MANAGER, [])).rejects.toThrow("attendance not found: undefined");
    expect(await audits()).toEqual([]);
  });
});

describe("rpcAdjustAttendanceHours", () => {
  it("'scheduled' stores the scheduled window's hours and the basis", async () => {
    const out = await rpc(rpcAdjustAttendanceHours, MANAGER, ["A_20260601_S_003", "scheduled"]);
    expect(out).toMatchObject({ hoursWorked: 8, hoursBasis: "scheduled", modifiedBy: "S_002" });
    expect(await row("A_20260601_S_003")).toMatchObject({ hours_worked: 8, hours_basis: "scheduled", modified_by: "S_002", modified_at: NOW });
    expect(await audits()).toEqual([
      {
        actor_id: "S_002",
        action: "attendance.adjust_hours",
        target_type: "attendance",
        target_id: "A_20260601_S_003",
        before: '{"hoursWorked":8.5}',
        after: '{"hoursWorked":8,"basis":"scheduled"}',
        details: null,
        timestamp: NOW,
      },
    ]);
  });
  it("'actual' stores the span between the actual times", async () => {
    await rpc(rpcAdjustAttendanceHours, MANAGER, ["A_20260601_S_003", "actual"]);
    expect(await row("A_20260601_S_003")).toMatchObject({ hours_worked: 8.5, hours_basis: "actual" });
  });
  it("rounds the span as the old code did, not as the database would: 1h 0m 18s is 1, not 1.01", async () => {
    await rpc(rpcAdjustAttendanceHours, MANAGER, ["A_20260607_S_003", "actual"]);
    expect((await row("A_20260607_S_003")).hours_worked).toBe(1);
  });
  it("an overnight schedule is its length across midnight, on an in-progress day too", async () => {
    await rpc(rpcAdjustAttendanceHours, ADMIN, ["A_20260602_S_003", "scheduled"]);
    expect(await row("A_20260602_S_003")).toMatchObject({ hours_worked: 8, hours_basis: "scheduled" });
    expect((await audits())[0].before).toBe('{"hoursWorked":0}'); // blank hours read as 0 in the old record
  });
  it("refuses when there are no such hours, a bad basis (before the id is looked up), an unknown id, a day not yet worked, a cancelled day", async () => {
    await expect(rpc(rpcAdjustAttendanceHours, MANAGER, ["A_20260602_S_003", "actual"])).rejects.toThrow("No actual hours available to apply");
    await expect(rpc(rpcAdjustAttendanceHours, MANAGER, ["A_20260605_S_003", "scheduled"])).rejects.toThrow("Cannot adjust: $130.50 already paid");
    await expect(rpc(rpcAdjustAttendanceHours, MANAGER, ["A_20260606_S_005", "scheduled"])).rejects.toThrow("No scheduled hours available to apply");
    await expect(rpc(rpcAdjustAttendanceHours, MANAGER, ["A_nope", "other"])).rejects.toThrow('basis must be "scheduled" or "actual"');
    await expect(rpc(rpcAdjustAttendanceHours, MANAGER, ["A_nope", "actual"])).rejects.toThrow("attendance not found: A_nope");
    await expect(rpc(rpcAdjustAttendanceHours, MANAGER, ["A_20260603_S_005", "scheduled"])).rejects.toThrow("Can only adjust hours on a worked or in-progress day");
    await expect(rpc(rpcAdjustAttendanceHours, MANAGER, ["A_20260604_S_005", "scheduled"])).rejects.toThrow("Can only adjust hours on a worked or in-progress day");
    expect(await audits()).toEqual([]);
  });
});

describe("rpcEditAttendanceTimes", () => {
  it("sets the times and the hours, clears the basis, audits instants as ISO text", async () => {
    await owner.query("update ops.attendance set hours_basis = 'scheduled' where attendance_id = 'A_20260601_S_003'");
    const out = await rpc(rpcEditAttendanceTimes, ADMIN, [{ attendanceId: "A_20260601_S_003", actualStart: "2026-06-01T13:00:00.000Z", actualEnd: "2026-06-01T20:20:20.000Z" }]);
    expect(out).toMatchObject({ hoursWorked: 7.34, hoursBasis: "", actualStart: null, actualEnd: null, modifiedBy: "S_001" });
    expect(await row("A_20260601_S_003")).toMatchObject({ hours_worked: 7.34, hours_basis: null, actual_start: new Date("2026-06-01T13:00:00Z"), modified_at: NOW });
    expect(await audits()).toEqual([
      {
        actor_id: "S_001",
        action: "attendance.edit_times",
        target_type: "attendance",
        target_id: "A_20260601_S_003",
        before: '{"actualStart":"2026-06-01T13:05:00.000Z","actualEnd":"2026-06-01T21:35:00.000Z","hoursWorked":8.5}',
        after: '{"actualStart":"2026-06-01T13:00:00.000Z","actualEnd":"2026-06-01T20:20:20.000Z","hoursWorked":7.34}',
        details: null,
        timestamp: NOW,
      },
    ]);
  });
  it("audits a blank previous time as null and a blank previous hours as 0", async () => {
    await rpc(rpcEditAttendanceTimes, ADMIN, [{ attendanceId: "A_20260603_S_005", actualStart: "2026-06-03T14:00:00Z", actualEnd: "2026-06-03T18:00:00Z" }]);
    expect((await audits())[0].before).toBe('{"actualStart":null,"actualEnd":null,"hoursWorked":0}');
    expect(await row("A_20260603_S_005")).toMatchObject({ status: "scheduled", hours_worked: 4 });
  });
  it("reads a time with no zone as Toronto time (the old app ran in Toronto), and epoch milliseconds as instants", async () => {
    expect(attendance.parseInstant("2026-06-01T09:00:00").toISOString()).toBe("2026-06-01T13:00:00.000Z");
    expect(attendance.parseInstant("2026-01-15T09:00").toISOString()).toBe("2026-01-15T14:00:00.000Z");
    expect(attendance.parseInstant("2026-03-08T02:30:00").toISOString()).toBe("2026-03-08T07:30:00.000Z"); // skipped hour: the offset from before the jump
    expect(attendance.parseInstant("2026-11-01T01:30:00").toISOString()).toBe("2026-11-01T05:30:00.000Z"); // repeated hour: the first one
    expect(attendance.parseInstant("2026-06-01T09:00:00Z").toISOString()).toBe("2026-06-01T09:00:00.000Z");
    expect(attendance.parseInstant("2026-06-01T09:00:00-05:00").toISOString()).toBe("2026-06-01T14:00:00.000Z");
    expect(attendance.parseInstant(Date.UTC(2026, 5, 1, 13)).toISOString()).toBe("2026-06-01T13:00:00.000Z");
    expect(Number.isNaN(attendance.parseInstant("garbage").getTime())).toBe(true);
    expect(attendance.parseInstant(null).getTime()).toBe(0);
    expect(Number.isNaN(attendance.parseInstant(undefined).getTime())).toBe(true);
  });
  it("refuses an end that is not after the start, unreadable times, an unknown id, a paid day", async () => {
    const edit = (o: Record<string, unknown>) => rpc(rpcEditAttendanceTimes, ADMIN, [o]);
    const id = "A_20260601_S_003";
    await expect(edit({ attendanceId: id, actualStart: "2026-06-01T14:00:00Z", actualEnd: "2026-06-01T13:00:00Z" })).rejects.toThrow("End time must be after start time");
    await expect(edit({ attendanceId: id, actualStart: "2026-06-01T14:00:00Z", actualEnd: "2026-06-01T14:00:00Z" })).rejects.toThrow("End time must be after start time");
    await expect(edit({ attendanceId: id })).rejects.toThrow("Invalid start or end time");
    await expect(edit({ attendanceId: id, actualStart: "x", actualEnd: "y" })).rejects.toThrow("Invalid start or end time");
    await expect(edit({ attendanceId: "A_nope", actualStart: "x" })).rejects.toThrow("attendance not found: A_nope");
    await expect(edit({ attendanceId: "A_20260605_S_003", actualStart: "2026-06-05T13:00:00Z", actualEnd: "2026-06-05T20:30:00Z" })).rejects.toThrow("Cannot edit: $130.50 already paid. Undo the payment first.");
    await expect(rpc(rpcEditAttendanceTimes, ADMIN, [])).rejects.toThrow("Cannot read properties of undefined (reading 'attendanceId')");
    expect(await audits()).toEqual([]);
  });
});

describe("two managers at once", () => {
  it("the second waits for the first, then sees its result (the row is locked before it is read)", async () => {
    const a = await connect(testDb.appUrl);
    const b = await connect(testDb.appUrl);
    try {
      let release!: () => void;
      let written!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      const didWrite = new Promise<void>((r) => (written = r));
      const first = withTransaction(a, async (tx) => {
        await attendance.cancel(tx, "A_20260601_S_003", "S_002", "gone", NOW);
        written();
        await hold;
      });
      await didWrite;
      let settled = false;
      const second = withTransaction(b, (tx) => attendance.adjustHours(tx, "A_20260601_S_003", "actual", "S_001", LATER)).finally(() => (settled = true));
      second.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // waiting on the row lock
      release();
      await first;
      await expect(second).rejects.toThrow("Can only adjust hours on a worked or in-progress day");
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("rpcGetWeekSchedule", () => {
  it("answers seven days, active people by id, and a cell per person per day", async () => {
    const out = await rpc(rpcGetWeekSchedule, MANAGER, ["2026-06-01"]);
    expect(out.weekStart).toBe("2026-06-01");
    expect(out.weekEnd).toBe("2026-06-07");
    expect(out.days).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((dayName, i) => ({ date: `2026-06-0${i + 1}`, dayName })));
    expect(out.staff).toEqual([
      { staffId: "S_001", name: "Ada Quill" },
      { staffId: "S_002", name: "Bram Hale" },
      { staffId: "S_003", name: "Cleo Marsh" },
      { staffId: "S_005", name: "Eli Stone" }, // inactive S_004 is left out; names are trimmed
    ]);
    expect(out.cells).toHaveLength(4 * 7);
    expect(out.cells.slice(0, 8).map((c: any) => c.staffId)).toEqual(Array(7).fill("S_001").concat("S_002"));
    const at = (staffId: string, date: string) => out.cells.find((c: any) => c.staffId === staffId && c.date === date);
    expect(at("S_003", "2026-06-01")).toEqual({
      staffId: "S_003",
      staffName: "Cleo Marsh",
      date: "2026-06-01",
      attendanceId: "A_20260601_S_003",
      status: "worked",
      scheduledStart: "09:00",
      scheduledEnd: "17:00",
      hoursWorked: 8.5,
      scheduledHours: 8,
      actualHours: 8.5,
      hoursBasis: "",
    });
    expect(at("S_003", "2026-06-02")).toMatchObject({ status: "in_progress", hoursWorked: 0, scheduledHours: 8, actualHours: 0, scheduledStart: "22:00" });
    expect(at("S_005", "2026-06-06")).toMatchObject({ status: "worked", hoursWorked: 0 });
    expect(at("S_001", "2026-06-01")).toEqual({
      staffId: "S_001",
      staffName: "Ada Quill",
      date: "2026-06-01",
      attendanceId: null,
      status: null,
      scheduledStart: "",
      scheduledEnd: "",
      hoursWorked: 0,
      scheduledHours: 0,
      actualHours: 0,
      hoursBasis: "",
    });
    // A cancelled day appears as such; the inactive person's day (none here) would not.
    expect(at("S_005", "2026-06-04")).toMatchObject({ status: "cancelled" });
  });
  it("a blank date means the week of the call's clock, Monday to Sunday in Toronto", async () => {
    const out = await rpc(rpcGetWeekSchedule, MANAGER, [""], new Date("2026-06-14T02:00:00Z")); // Saturday 22:00 Toronto
    expect(out.weekStart).toBe("2026-06-08");
    const sunday = await rpc(rpcGetWeekSchedule, MANAGER, [undefined], new Date("2026-06-15T02:00:00Z")); // Sunday 22:00 Toronto: still the week before
    expect(sunday.weekStart).toBe("2026-06-08");
  });
  it("an unreadable date gives the old answer: seven NaN-NaN-NaN days, every active person, no shifts", async () => {
    const out = await rpc(rpcGetWeekSchedule, MANAGER, ["not-a-date"]);
    expect(out.weekStart).toBe("NaN-NaN-NaN");
    expect(out.weekEnd).toBe("NaN-NaN-NaN");
    expect(out.days.map((d: any) => d.dayName)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(out.days.every((d: any) => d.date === "NaN-NaN-NaN")).toBe(true);
    expect(out.cells).toHaveLength(28);
    expect(out.cells.every((c: any) => c.attendanceId === null && c.date === "NaN-NaN-NaN")).toBe(true);
  });
  it("a week that holds a clock change is seven calendar days", async () => {
    const out = await rpc(rpcGetWeekSchedule, MANAGER, ["2026-10-26"]);
    expect(out.days.map((d: any) => d.date)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(out.weekEnd).toBe("2026-11-01");
  });
  it("is one read of attendance for the whole grid, not one per cell", async () => {
    const queries: string[] = [];
    const spy: Db = { query: (t, p) => (queries.push(t), db.query(t, p)), one: (t, p) => (queries.push(t), db.one(t, p)), maybeOne: (t, p) => (queries.push(t), db.maybeOne(t, p)) };
    await attendance.weekSchedule(spy, "2026-06-01", NOW);
    expect(queries.filter((q) => /ops\.attendance/.test(q))).toHaveLength(1);
  });
});

describe("rpcGetMe", () => {
  it("answers the four fields of the session", async () => {
    expect(await rpc(rpcGetMe, session("S_003", "employee"), [])).toEqual({ staffId: "S_003", name: "x", role: "employee", companiesAuthorized: ["cstore"] });
  });
});
