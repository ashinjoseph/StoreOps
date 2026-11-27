// Attendance corrections (card P4-10): an admin sets a past day to what really happened. A NEW ability
// of the Operations app (ADR-0023): nothing in the Apps Script app to compare with, so these tests
// are its specification. Against a real database, with invented people and figures.
//
// The owner's two cases come first, end to end with payroll; then who may call; then each rule in
// the order the module checks them; then the audit row, what is never touched, and the races.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/sessions";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { Config } from "../src/lib/config";
import * as attendance from "../src/modules/attendance";
import * as corrections from "../src/modules/attendance-corrections";
import * as payments from "../src/modules/payments";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { rpcCorrectAttendance, rpcGetAttendanceDay } from "../src/rpc/handlers/attendance-corrections";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
// The app role cannot delete money or audit rows (by design): the rows are reset as the owner.
let owner: Db & { close(): Promise<void> };

// Toronto is UTC-4 in June. NOW is Wednesday 2026-06-10, 14:00 in Toronto.
const NOW = new Date("2026-06-10T18:00:00Z");
const DAY = "2026-06-08";
/** An instant on DAY, Toronto summer time. */
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00-04:00`;

const STAFF: Array<[string, string, number | null, boolean, string]> = [
  ["S_001", "Ada Quill", 25, true, "admin"],
  ["S_002", "Bram Hale", 21, true, "manager"],
  ["S_003", "Cleo Marsh", 20, true, "employee"],
  ["S_004", "Dara Vance", null, true, "employee"], // no rate recorded
  ["S_005", "Eli Stone", 18, true, "employee"],
  ["S_006", "Fay Ruiz", 22, true, "payroll_admin"],
  ["S_007", "Gus Lowe", 19, false, "employee"], // has left
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

async function seed() {
  for (const t of ["audit_log", "payment_items", "payments", "sales", "till_sessions", "bonuses", "attendance", "sessions", "staff"]) await owner.query(`delete from ops.${t}`);
  for (const s of STAFF) await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role) values ($1,$2,$3,$4,$5)", s);
  // Case 1's day: Cleo opened cstore 09:00-17:00, Eli vape 13:00-17:00; both closed, both worked.
  await insertDay({ id: "A_20260608_S_003", staff: "S_003", ss: "09:00", se: "17:00", as: at("09:00"), ae: at("17:00"), hours: 8, rate: 20, status: "worked", notes: null });
  await insertDay({ id: "A_20260608_S_005", staff: "S_005", ss: "13:00", se: "17:00", as: at("13:00"), ae: at("17:00"), hours: 4, rate: 18, status: "worked", notes: null });
  await owner.query(
    `insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time, end_time) values
       ('CST-20260608-S_003', 'A_20260608_S_003', 'S_003', 'cstore', $1, 'closed', $2, $3),
       ('VAP-20260608-S_005', 'A_20260608_S_005', 'S_005', 'vape', $1, 'closed', $4, $3)`,
    [DAY, at("09:00"), at("17:00"), at("13:00")],
  );
  await owner.query("insert into ops.sales (sales_id, session_id, staff_id, company, date, cash_sales) values ('CST-20260608-S_003', 'CST-20260608-S_003', 'S_003', 'cstore', $1, 312.4)", [DAY]);
  await owner.query("insert into ops.bonuses (bonus_id, staff_id, date, type, amount, reason, status) values ('B_1', 'S_003', $1, 'bonus', 15, 'Tidy stockroom', 'pending')", [DAY]);
  // Case 2's day: Dara scheduled 10:00-18:00 on 2026-06-09 (as schedule() writes it: hours and rate 0).
  await insertDay({ id: "A_20260609_S_004", staff: "S_004", date: "2026-06-09", ss: "10:00", se: "18:00", hours: 0, rate: 0, status: "scheduled", notes: null });
}

type DayRow = { id: string; staff: string; date?: string; ss?: string | null; se?: string | null; as?: string | null; ae?: string | null; hours?: number | null; rate?: number | null; status: string; notes?: string | null; basis?: string | null };
async function insertDay(r: DayRow) {
  await owner.query(
    `insert into ops.attendance (attendance_id, staff_id, date, scheduled_start, scheduled_end, actual_start, actual_end, hours_worked, rate_at_attendance, status, notes, created_by, created_at, hours_basis)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'S_002',$12,$13)`,
    [r.id, r.staff, r.date ?? DAY, r.ss ?? null, r.se ?? null, r.as ?? null, r.ae ?? null, r.hours ?? null, r.rate ?? null, r.status, r.notes ?? null, "2026-06-01T12:00:00Z", r.basis ?? null],
  );
}

beforeEach(seed);

const session = (staffId: string, role: Session["role"]): Session => ({ staffId, name: "x", role, companiesAuthorized: ["cstore"], expiresAt: 0 });
const ADMIN = session("S_001", "admin");

async function rpc(handler: (ctx: RpcContext, ...a: unknown[]) => unknown, who: Session | null, args: unknown[], now = NOW, on: Db = db): Promise<any> {
  return withTransaction(on, async (tx) => handler({ db: tx, session: who, config: () => Promise.reject(new Error("no config")), env: {}, fetch, now }, ...args));
}
const fix = (input: Record<string, unknown>, now = NOW) => rpc(rpcCorrectAttendance, ADMIN, [input], now);
const day = (staffId: unknown, date: unknown, now = NOW) => rpc(rpcGetAttendanceDay, ADMIN, [staffId, date], now);
const row = (id: string) => db.maybeOne<any>("select * from ops.attendance where attendance_id = $1", [id]);
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details from ops.audit_log order by seq`);
const owed = async (staffId: string) => (await payments.getOwedSummary(db, staffId)).shiftsOwed;

/** A worked-day correction for Cleo on DAY, as the sheet sends it. */
const cleo = (patch: Record<string, unknown> = {}) => ({
  staffId: "S_003",
  date: DAY,
  status: "worked",
  scheduledStart: "09:00",
  scheduledEnd: "17:00",
  actualStart: at("09:00"),
  actualEnd: at("14:00"),
  reason: "Left at 14:00, Eli covered",
  ...patch,
});

describe("the owner's two cases, end to end with payroll", () => {
  it("1. someone left early and the other person stayed: both days corrected, owed changes by exactly hours x rate", async () => {
    const cleoBefore = await owed("S_003");
    const eliBefore = await owed("S_005");
    expect([cleoBefore, eliBefore]).toEqual([160, 72]);

    const a = await fix(cleo());
    expect(a).toMatchObject({ created: false, owedBefore: 160, owedAfter: 100 });
    expect(a.record).toMatchObject({ status: "worked", hoursWorked: 5, rateAtAttendance: 20, actualEnd: new Date(at("14:00")).toISOString() });

    const b = await fix({ staffId: "S_005", date: DAY, status: "worked", scheduledStart: "13:00", scheduledEnd: "17:00", actualStart: at("13:00"), actualEnd: at("19:00"), reason: "Stayed until 19:00 when Cleo left" });
    expect(b).toMatchObject({ created: false, owedBefore: 72, owedAfter: 108 });

    expect(await owed("S_003")).toBe(roundDiff(cleoBefore, -3 * 20));
    expect(await owed("S_005")).toBe(roundDiff(eliBefore, 2 * 18));
    // The till sessions still say 17:00: the correction is visible as a difference, and allowed.
    const after = await day("S_005", DAY);
    expect(after.tillSessions).toEqual([{ sessionId: "VAP-20260608-S_005", company: "vape", status: "closed", startTime: new Date(at("13:00")).toISOString(), endTime: new Date(at("17:00")).toISOString() }]);
    expect(after.record.hoursWorked).toBe(6);
  });

  it("2. a no-show and an unscheduled stand-in: the no-show's day cancelled, the stand-in's day added; payroll and the week agree", async () => {
    const reason = "Dara did not come; Eli covered 10:00-18:00";
    const cancelled = await fix({ staffId: "S_004", date: "2026-06-09", status: "cancelled", scheduledStart: "10:00", scheduledEnd: "18:00", actualStart: "", actualEnd: "", reason });
    expect(cancelled).toMatchObject({ created: false, owedAfter: null });
    expect(cancelled.record).toMatchObject({ status: "cancelled", scheduledStart: "10:00", scheduledEnd: "18:00", actualStart: null, actualEnd: null, hoursWorked: null });

    // Eli (active, rate 18) stood in with no row at all.
    expect(await row("A_20260609_S_005")).toBeNull();
    const added = await fix({ staffId: "S_005", date: "2026-06-09", status: "worked", scheduledStart: "", scheduledEnd: "", actualStart: at("10:00", "2026-06-09"), actualEnd: at("18:00", "2026-06-09"), reason });
    expect(added).toMatchObject({ created: true, owedBefore: null, owedAfter: 144 });
    expect(await row("A_20260609_S_005")).toMatchObject({ staff_id: "S_005", date: "2026-06-09", status: "worked", hours_worked: 8, rate_at_attendance: 18, scheduled_start: null, scheduled_end: null, created_by: "S_001", created_at: NOW, modified_by: null, hours_basis: null });

    const dara = await payments.getOwedSummary(db, "S_004");
    expect(dara.shiftsOwed).toBe(0);
    const eli = await payments.getOwedSummary(db, "S_005");
    expect(eli.unpaidShifts.map((s) => [s.attendanceId, s.value])).toEqual([["A_20260608_S_005", 72], ["A_20260609_S_005", 144]]);

    const week = await attendance.weekSchedule(db, "2026-06-08", NOW);
    const cell = (s: string) => week.cells.find((c) => c.staffId === s && c.date === "2026-06-09");
    expect(cell("S_004")).toMatchObject({ status: "cancelled", scheduledStart: "10:00", scheduledEnd: "18:00" });
    expect(cell("S_005")).toMatchObject({ attendanceId: "A_20260609_S_005", status: "worked", hoursWorked: 8, actualHours: 8 });
  });
});

const roundDiff = (a: number, d: number) => Math.round((a + d) * 100) / 100;

describe("who may call: the real router with the merged contract", () => {
  const contract = parseRpcContract(
    mergeOpsContract(
      JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
      JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
    ),
  );
  const router = () =>
    createRpcRouter({ contract, handlers, openDb: () => connect(testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env: {}, now: () => NOW, log: () => undefined });
  async function call(name: string, args: unknown[]) {
    const res = await router()(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
    return (await res.json()) as { ok: boolean; result?: any; error?: { message: string } };
  }
  const tokenOf = async (staffId: string) => (await createSession(db, staffId, Config.fromRows([]), NOW)).token;

  it("the contract lists both as admin only, needing a session", () => {
    expect(contract.get("rpcGetAttendanceDay")).toMatchObject({ params: ["token", "staffId", "date"], roles: ["admin"], needs_session: true, migrate: true });
    expect(contract.get("rpcCorrectAttendance")).toMatchObject({ params: ["token", "input"], roles: ["admin"], needs_session: true, migrate: true });
  });

  it("both answer an admin", async () => {
    const t = await tokenOf("S_001");
    expect((await call("rpcGetAttendanceDay", [t, "S_003", DAY])).result).toMatchObject({ staffId: "S_003", name: "Cleo Marsh", canCorrect: true });
    const out = await call("rpcCorrectAttendance", [t, cleo()]);
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({ owedBefore: 160, owedAfter: 100 });
  });

  it("both refuse a manager, a payroll admin and an employee, and change nothing", async () => {
    for (const [id, role] of [["S_002", "manager"], ["S_006", "payroll_admin"], ["S_003", "employee"]]) {
      const t = await tokenOf(id as string);
      expect((await call("rpcGetAttendanceDay", [t, "S_003", DAY])).error?.message).toBe(`FORBIDDEN: requires admin, got ${role}`);
      expect((await call("rpcCorrectAttendance", [t, cleo()])).error?.message).toBe(`FORBIDDEN: requires admin, got ${role}`);
    }
    expect((await row("A_20260608_S_003")).hours_worked).toBe(8);
    expect(await audits()).toEqual([]);
  });

  it("both refuse a call with no token or an unknown one", async () => {
    for (const t of [undefined, "", "nope"]) {
      expect((await call("rpcGetAttendanceDay", [t, "S_003", DAY])).error?.message).toBe("NOT_LOGGED_IN");
      expect((await call("rpcCorrectAttendance", [t, cleo()])).error?.message).toBe("NOT_LOGGED_IN");
    }
  });

  it("a role or actorId planted in the input changes nothing: the audit row names the session's person", async () => {
    const manager = await tokenOf("S_002");
    expect((await call("rpcCorrectAttendance", [manager, cleo({ role: "admin", actorId: "S_001" })])).error?.message).toBe("FORBIDDEN: requires admin, got manager");
    const admin = await tokenOf("S_001");
    expect((await call("rpcCorrectAttendance", [admin, cleo({ role: "employee", actorId: "S_006" })])).ok).toBe(true);
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0].actor_id).toBe("S_001");
    expect((await row("A_20260608_S_003")).modified_by).toBe("S_001");
  });

  it("the handlers check the role themselves too (a defence if the contract file were wrong)", async () => {
    for (const who of [session("S_002", "manager"), session("S_006", "payroll_admin"), session("S_003", "employee")]) {
      await expect(rpc(rpcCorrectAttendance, who, [cleo()])).rejects.toThrow(`FORBIDDEN: requires admin, got ${who.role}`);
      await expect(rpc(rpcGetAttendanceDay, who, ["S_003", DAY])).rejects.toThrow(`FORBIDDEN: requires admin, got ${who.role}`);
    }
    await expect(rpc(rpcCorrectAttendance, null, [cleo()])).rejects.toThrow("NOT_LOGGED_IN");
    await expect(rpc(rpcGetAttendanceDay, null, ["S_003", DAY])).rejects.toThrow("NOT_LOGGED_IN");
    await expect(rpc(rpcCorrectAttendance, ADMIN, [null])).rejects.toThrow("input is required");
  });
});

describe("rpcGetAttendanceDay", () => {
  it("answers every field: the record with blanks as null, the current rate, what is paid, the day's tills", async () => {
    await owner.query("update ops.attendance set notes = 'Swapped with Eli', hours_basis = 'actual' where attendance_id = 'A_20260608_S_003'");
    expect(await day("S_003", DAY)).toEqual({
      staffId: "S_003",
      name: "Cleo Marsh",
      active: true,
      date: DAY,
      record: {
        attendanceId: "A_20260608_S_003",
        status: "worked",
        scheduledStart: "09:00",
        scheduledEnd: "17:00",
        actualStart: "2026-06-08T13:00:00.000Z",
        actualEnd: "2026-06-08T21:00:00.000Z",
        hoursWorked: 8,
        rateAtAttendance: 20,
        hoursBasis: "actual",
        notes: "Swapped with Eli",
      },
      currentRate: 20,
      paid: 0,
      tillSessions: [{ sessionId: "CST-20260608-S_003", company: "cstore", status: "closed", startTime: "2026-06-08T13:00:00.000Z", endTime: "2026-06-08T21:00:00.000Z" }],
      canCorrect: true,
      blockedBy: null,
    });
  });

  it("a day with no row, a blank rate, a person who has left", async () => {
    expect(await day("S_004", "2026-06-07")).toMatchObject({ name: "Dara Vance", record: null, currentRate: null, paid: 0, tillSessions: [], canCorrect: true, blockedBy: null });
    expect(await day("S_007", "2026-06-07")).toMatchObject({ name: "Gus Lowe", active: false, canCorrect: true });
    const blank = await day("S_004", "2026-06-09");
    expect(blank.record).toMatchObject({ status: "scheduled", actualStart: null, actualEnd: null, hoursWorked: 0, rateAtAttendance: 0, hoursBasis: null, notes: null });
  });

  it("a paid day: canCorrect false with the amount; a voided payment does not count", async () => {
    await owner.query("insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method) values ('P_1','S_003','2026-06-09',60.5,'cash'), ('P_2','S_003','2026-06-09',99,'cash')");
    await owner.query("update ops.payments set voided_at = $1, voided_by = 'S_001' where payment_id = 'P_2'", [NOW]);
    await owner.query("insert into ops.payment_items (item_id, payment_id, item_type, ref_id, amount) values ('I_1','P_1','shift','A_20260608_S_003',60.5), ('I_2','P_2','shift','A_20260608_S_003',99)");
    expect(await day("S_003", DAY)).toMatchObject({ paid: 60.5, canCorrect: false, blockedBy: "Cannot correct: $60.50 has been paid against this day. Undo the payment first." });
  });

  it("an open till that day: canCorrect false", async () => {
    await owner.query("update ops.till_sessions set status = 'open', end_time = null where session_id = 'CST-20260608-S_003'");
    expect(await day("S_003", DAY)).toMatchObject({ canCorrect: false, blockedBy: "Close Cleo Marsh's till first." });
  });

  it("a future day: canCorrect false; an unknown person and an unreadable date are refused", async () => {
    expect(await day("S_003", "2026-06-11")).toMatchObject({ canCorrect: false, blockedBy: "Use the schedule for a day that has not happened yet." });
    await expect(day("S_999", DAY)).rejects.toThrow("Staff not found: S_999");
    for (const bad of ["2026-02-30", "08/06/2026", "", null, 20260608]) await expect(day("S_003", bad)).rejects.toThrow("date is not a readable date");
  });

  it("reads one or two rows per table, none in a loop", async () => {
    const seen: string[] = [];
    const counting: Db = { query: (t, p) => (seen.push(t), db.query(t, p)), one: (t, p) => (seen.push(t), db.one(t, p)), maybeOne: (t, p) => (seen.push(t), db.maybeOne(t, p)) };
    await corrections.getDay(counting, "S_003", DAY, NOW);
    expect(seen).toHaveLength(4);
  });
});

describe("the rules, in order", () => {
  it("1. the person must exist; one who has left can still be corrected", async () => {
    await expect(fix(cleo({ staffId: "S_999" }))).rejects.toThrow("Staff not found: S_999");
    await expect(fix(cleo({ staffId: 3 }))).rejects.toThrow("Staff not found: 3");
    const gone = await fix(cleo({ staffId: "S_007", reason: "Worked before leaving" }));
    expect(gone).toMatchObject({ created: true, owedAfter: 95 });
  });

  it("2. a real day, today or earlier in Toronto, not more than 370 days back", async () => {
    for (const bad of ["2026-06-31", "2026-6-8", "yesterday", "", undefined]) await expect(fix(cleo({ date: bad }))).rejects.toThrow("date is not a readable date");
    await expect(fix(cleo({ date: "2026-06-11" }))).rejects.toThrow("Use the schedule for a day that has not happened yet.");
    // 23:30 on the 10th in Toronto is already the 11th in UTC: still today, so accepted.
    const lateNow = new Date("2026-06-11T03:30:00Z");
    await expect(fix(cleo({ date: "2026-06-10", actualStart: at("09:00", "2026-06-10"), actualEnd: at("17:00", "2026-06-10") }), lateNow)).resolves.toMatchObject({ created: true });
    await expect(fix(cleo({ date: "2026-06-11", actualStart: at("09:00", "2026-06-10"), actualEnd: at("17:00", "2026-06-10") }), lateNow)).rejects.toThrow("Use the schedule");
    await expect(fix(cleo({ date: "2025-06-05", actualStart: at("09:00", "2025-06-05"), actualEnd: at("17:00", "2025-06-05") }))).resolves.toMatchObject({ created: true }); // 370 days
    await expect(fix(cleo({ date: "2025-06-04", actualStart: at("09:00", "2025-06-04"), actualEnd: at("17:00", "2025-06-04") }))).rejects.toThrow("Cannot correct a day more than 370 days ago.");
  });

  it("3. a reason of 3 to 300 characters after trimming, no control characters", async () => {
    for (const bad of [undefined, "", "  ", " ab ", "x".repeat(301), 42]) await expect(fix(cleo({ reason: bad }))).rejects.toThrow("A reason is required: 3 to 300 characters.");
    await expect(fix(cleo({ reason: "line one\nline two" }))).rejects.toThrow("The reason cannot contain control characters");
    await expect(fix(cleo({ reason: "tab\there" }))).rejects.toThrow("control characters");
    const ok = await fix(cleo({ reason: "  " + "y".repeat(300) + "  " }));
    expect(ok.record.notes).toBe("Corrected: " + "y".repeat(300));
  });

  it("4. refused while anything is paid against the day; allowed again once the payment is undone", async () => {
    const paid = await withTransaction(db, (tx) => payments.payShifts(tx, { staffId: "S_003", amount: 50, actorId: "S_006" }, { config: Config.fromRows([]), env: {}, fetch, now: NOW }));
    await expect(fix(cleo())).rejects.toThrow("Cannot correct: $50.00 has been paid against this day. Undo the payment first.");
    expect((await row("A_20260608_S_003")).hours_worked).toBe(8);
    await withTransaction(db, (tx) => payments.undo(tx, paid.paymentId, "S_001", { now: NOW }, "paid too early"));
    await expect(fix(cleo())).resolves.toMatchObject({ owedAfter: 100 });
  });

  it("5. refused while the day is in progress or the person has an open till that day", async () => {
    await owner.query("update ops.till_sessions set status = 'open', end_time = null where session_id = 'CST-20260608-S_003'");
    await expect(fix(cleo())).rejects.toThrow("Close Cleo Marsh's till first.");
    await owner.query("update ops.till_sessions set status = 'closed', end_time = $1 where session_id = 'CST-20260608-S_003'", [at("17:00")]);
    await owner.query("update ops.attendance set status = 'in_progress' where attendance_id = 'A_20260608_S_003'");
    await expect(fix(cleo())).rejects.toThrow("Close Cleo Marsh's till first.");
    await owner.query("update ops.attendance set status = 'worked' where attendance_id = 'A_20260608_S_003'");
    await expect(fix(cleo())).resolves.toMatchObject({ created: false });
  });

  it("6. status is worked or cancelled, nothing else", async () => {
    for (const bad of ["scheduled", "in_progress", "Worked", "", undefined]) await expect(fix(cleo({ status: bad }))).rejects.toThrow("status must be worked or cancelled.");
  });

  it("7. scheduled times: blank or HH:MM, both or neither, end after start; blank is stored as NULL", async () => {
    for (const bad of ["9:00", "24:00", "12:60", "noon", 900]) await expect(fix(cleo({ scheduledStart: bad }))).rejects.toThrow("Scheduled start must be blank or a time as HH:MM");
    await expect(fix(cleo({ scheduledEnd: "25:00" }))).rejects.toThrow("Scheduled end must be blank or a time as HH:MM");
    await expect(fix(cleo({ scheduledEnd: "" }))).rejects.toThrow("Give both scheduled times, or neither");
    await expect(fix(cleo({ scheduledStart: "17:00", scheduledEnd: "09:00" }))).rejects.toThrow("The scheduled end must be after the scheduled start.");
    await expect(fix(cleo({ scheduledStart: "09:00", scheduledEnd: "09:00" }))).rejects.toThrow("after the scheduled start");
    await fix(cleo({ scheduledStart: "", scheduledEnd: null }));
    expect(await row("A_20260608_S_003")).toMatchObject({ scheduled_start: null, scheduled_end: null });
    await fix(cleo({ scheduledStart: "00:00", scheduledEnd: "23:59" }));
    expect(await row("A_20260608_S_003")).toMatchObject({ scheduled_start: "00:00", scheduled_end: "23:59" });
  });

  describe("8. a worked day", () => {
    it("needs both instants, with a zone, real, end after start, at most 24 hours, not in the future", async () => {
      await expect(fix(cleo({ actualEnd: "" }))).rejects.toThrow("A worked day needs its actual start and end.");
      await expect(fix(cleo({ actualStart: null }))).rejects.toThrow("A worked day needs its actual start and end.");
      await expect(fix(cleo({ actualStart: "2026-06-08T09:00:00" }))).rejects.toThrow("The actual start must be a date and time with its zone");
      await expect(fix(cleo({ actualEnd: "June 8 5pm" }))).rejects.toThrow("The actual end must be a date and time with its zone");
      await expect(fix(cleo({ actualEnd: "2026-06-31T17:00:00-04:00" }))).rejects.toThrow("The actual end is not a real date and time.");
      await expect(fix(cleo({ actualEnd: at("09:00") }))).rejects.toThrow("The actual end must be after the actual start.");
      await expect(fix(cleo({ actualEnd: at("08:00") }))).rejects.toThrow("after the actual start");
      await expect(fix(cleo({ actualStart: at("01:00"), actualEnd: at("01:01", "2026-06-09") }))).rejects.toThrow("A day cannot be longer than 24 hours.");
      await expect(fix(cleo({ actualStart: at("01:00"), actualEnd: at("01:00", "2026-06-09") }))).resolves.toMatchObject({ record: { hoursWorked: 24 } });
      await expect(fix(cleo({ date: "2026-06-10", actualStart: at("09:00", "2026-06-10"), actualEnd: at("14:01", "2026-06-10") }))).rejects.toThrow("The actual end cannot be in the future.");
      await expect(fix(cleo({ date: "2026-06-10", actualStart: at("09:00", "2026-06-10"), actualEnd: at("14:00", "2026-06-10") }))).resolves.toMatchObject({ record: { hoursWorked: 5 } });
      // The same instant written in UTC is the same correction.
      await expect(fix(cleo({ actualStart: "2026-06-08T13:00:00Z", actualEnd: "2026-06-08T18:30:00.000Z" }))).resolves.toMatchObject({ record: { hoursWorked: 5.5 } });
    });

    it("the start is on that Toronto day, or within 6 hours of it: 23:30 the night before and 00:30 the morning after", async () => {
      await expect(fix(cleo({ actualStart: at("23:30", "2026-06-07"), actualEnd: at("07:30") }))).resolves.toMatchObject({ record: { hoursWorked: 8 } });
      await expect(fix(cleo({ actualStart: at("00:30", "2026-06-09"), actualEnd: at("02:30", "2026-06-09") }))).resolves.toMatchObject({ record: { hoursWorked: 2 } });
      await expect(fix(cleo({ actualStart: at("18:00", "2026-06-07"), actualEnd: at("19:00", "2026-06-07") }))).resolves.toMatchObject({ record: { hoursWorked: 1 } });
      await expect(fix(cleo({ actualStart: at("17:59", "2026-06-07"), actualEnd: at("19:00", "2026-06-07") }))).rejects.toThrow("The actual start must be on 2026-06-08 (Toronto time), or within 6 hours of it.");
      await expect(fix(cleo({ actualStart: at("06:00", "2026-06-09"), actualEnd: at("07:00", "2026-06-09") }))).rejects.toThrow("within 6 hours of it");
      await expect(fix(cleo({ actualStart: at("05:59", "2026-06-09"), actualEnd: at("07:00", "2026-06-09") }))).resolves.toMatchObject({ created: false });
    });

    it("on both clock-change days the Toronto day has its real length (23 and 25 hours)", async () => {
      const later = new Date("2026-11-20T12:00:00Z");
      // 2026-03-08: 02:00 EST becomes 03:00 EDT. Midnight is -05:00, the next midnight -04:00.
      await expect(fix(cleo({ date: "2026-03-08", actualStart: "2026-03-08T01:00:00-05:00", actualEnd: "2026-03-08T09:00:00-04:00" }), later)).resolves.toMatchObject({ record: { hoursWorked: 7 } });
      await expect(fix(cleo({ date: "2026-03-08", actualStart: "2026-03-07T18:00:00-05:00", actualEnd: "2026-03-07T19:00:00-05:00" }), later)).resolves.toMatchObject({ created: false });
      await expect(fix(cleo({ date: "2026-03-08", actualStart: "2026-03-07T17:59:00-05:00", actualEnd: "2026-03-07T19:00:00-05:00" }), later)).rejects.toThrow("within 6 hours");
      await expect(fix(cleo({ date: "2026-03-08", actualStart: "2026-03-09T05:59:00-04:00", actualEnd: "2026-03-09T07:00:00-04:00" }), later)).resolves.toMatchObject({ created: false });
      await expect(fix(cleo({ date: "2026-03-08", actualStart: "2026-03-09T06:00:00-04:00", actualEnd: "2026-03-09T07:00:00-04:00" }), later)).rejects.toThrow("within 6 hours");
      // 2026-11-01: 02:00 EDT becomes 01:00 EST. 00:30 to 03:30 on the wall is 4 real hours.
      await expect(fix(cleo({ date: "2026-11-01", actualStart: "2026-11-01T00:30:00-04:00", actualEnd: "2026-11-01T03:30:00-05:00" }), later)).resolves.toMatchObject({ record: { hoursWorked: 4 } });
      await expect(fix(cleo({ date: "2026-11-01", actualStart: "2026-10-31T18:00:00-04:00", actualEnd: "2026-10-31T19:00:00-04:00" }), later)).resolves.toMatchObject({ created: false });
      await expect(fix(cleo({ date: "2026-11-01", actualStart: "2026-10-31T17:59:00-04:00", actualEnd: "2026-10-31T19:00:00-04:00" }), later)).rejects.toThrow("within 6 hours");
      await expect(fix(cleo({ date: "2026-11-01", actualStart: "2026-11-02T05:59:00-05:00", actualEnd: "2026-11-02T07:00:00-05:00" }), later)).resolves.toMatchObject({ created: false });
      await expect(fix(cleo({ date: "2026-11-01", actualStart: "2026-11-02T06:00:00-05:00", actualEnd: "2026-11-02T07:00:00-05:00" }), later)).rejects.toThrow("within 6 hours");
      expect((await row("A_20260308_S_003")).date).toBe("2026-03-08");
      expect((await row("A_20261101_S_003")).date).toBe("2026-11-01");
    });

    it("hours are the span rounded to cents of an hour; hours_basis is cleared", async () => {
      await owner.query("update ops.attendance set hours_basis = 'scheduled' where attendance_id = 'A_20260608_S_003'");
      await fix(cleo({ actualStart: at("09:00"), actualEnd: "2026-06-08T14:20:00-04:00" }));
      expect(await row("A_20260608_S_003")).toMatchObject({ hours_worked: 5.33, hours_basis: null });
    });

    it("an existing rate snapshot is kept when the person's rate has since changed", async () => {
      await owner.query("update ops.staff set hourly_rate = 23 where staff_id = 'S_003'");
      const out = await fix(cleo());
      expect(out.record.rateAtAttendance).toBe(20);
      expect(out.owedAfter).toBe(100);
    });

    it("no snapshot: the person's current rate; a blank current rate is NULL and owed null, never 0", async () => {
      const noRate = await fix({ staffId: "S_004", date: "2026-06-07", status: "worked", scheduledStart: "", scheduledEnd: "", actualStart: at("10:00", "2026-06-07"), actualEnd: at("14:00", "2026-06-07"), reason: "Covered the morning" });
      expect(noRate).toMatchObject({ created: true, owedBefore: null, owedAfter: null });
      expect(noRate.record.rateAtAttendance).toBeNull();
      expect((await row("A_20260607_S_004")).rate_at_attendance).toBeNull();
      // A blank snapshot on an existing row takes the current rate.
      await owner.query("update ops.attendance set rate_at_attendance = null where attendance_id = 'A_20260608_S_005'");
      expect((await fix({ staffId: "S_005", date: DAY, status: "worked", scheduledStart: "", scheduledEnd: "", actualStart: at("13:00"), actualEnd: at("17:00"), reason: "rate was missing" })).record.rateAtAttendance).toBe(18);
    });

    it("a scheduled row's 0 rate (what schedule() writes for 'no rate yet') is not kept: the person who did work is paid", async () => {
      // Dara (blank rate) is scheduled on the 9th; give her a rate, as the admin would once she is set up.
      await owner.query("update ops.staff set hourly_rate = 17 where staff_id = 'S_004'");
      const out = await fix({ staffId: "S_004", date: "2026-06-09", status: "worked", scheduledStart: "10:00", scheduledEnd: "18:00", actualStart: at("10:00", "2026-06-09"), actualEnd: at("18:00", "2026-06-09"), reason: "Worked; the till was opened by Eli" });
      expect(out).toMatchObject({ owedBefore: 0, owedAfter: 136 });
      expect(out.record.rateAtAttendance).toBe(17);
    });
  });

  it("9. cancelling: refused when the person had any till session that day; otherwise times and hours cleared, schedule kept", async () => {
    await expect(fix(cleo({ status: "cancelled" }))).rejects.toThrow("Cleo Marsh opened a till that day: it was worked. Correct the times instead.");
    // A till session dated that day but filed under another day's id still counts.
    await owner.query("update ops.till_sessions set attendance_id = 'A_20260609_S_004', staff_id = 'S_004', date = '2026-06-09' where session_id = 'VAP-20260608-S_005'");
    await expect(fix({ staffId: "S_004", date: "2026-06-09", status: "cancelled", scheduledStart: "10:00", scheduledEnd: "18:00", reason: "did not come" })).rejects.toThrow("Dara Vance opened a till that day");
    await owner.query("update ops.till_sessions set attendance_id = 'A_20260608_S_005', staff_id = 'S_005', date = $1 where session_id = 'VAP-20260608-S_005'", [DAY]);
    await insertDay({ id: "A_20260605_S_005", staff: "S_005", date: "2026-06-05", ss: "09:00", se: "13:00", as: at("09:00", "2026-06-05"), ae: at("13:00", "2026-06-05"), hours: 4, rate: 18, status: "worked", basis: "actual" });
    const out = await fix({ staffId: "S_005", date: "2026-06-05", status: "cancelled", scheduledStart: "09:00", scheduledEnd: "13:00", actualStart: at("09:00", "2026-06-05"), actualEnd: at("13:00", "2026-06-05"), reason: "Recorded by mistake" });
    expect(out).toMatchObject({ owedBefore: 72, owedAfter: null });
    expect(await row("A_20260605_S_005")).toMatchObject({ status: "cancelled", actual_start: null, actual_end: null, hours_worked: null, hours_basis: null, scheduled_start: "09:00", scheduled_end: "13:00", rate_at_attendance: 18 });
  });

  it("10. a missing row is created with the module's id; an existing one is updated and marked modified", async () => {
    const made = await fix(cleo({ date: "2026-06-06", actualStart: at("09:00", "2026-06-06"), actualEnd: at("12:00", "2026-06-06") }));
    expect(made.created).toBe(true);
    expect(made.record.attendanceId).toBe("A_20260606_S_003");
    expect(await row("A_20260606_S_003")).toMatchObject({ created_by: "S_001", created_at: NOW, modified_by: null, modified_at: null });
    const later = new Date(NOW.getTime() + 60_000);
    const again = await fix(cleo({ date: "2026-06-06", actualStart: at("09:00", "2026-06-06"), actualEnd: at("13:00", "2026-06-06"), reason: "Stayed an hour more" }), later);
    expect(again.created).toBe(false);
    expect(await row("A_20260606_S_003")).toMatchObject({ created_by: "S_001", created_at: NOW, modified_by: "S_001", modified_at: later, hours_worked: 4 });
    expect(await db.one<any>("select count(*)::int as n from ops.attendance where staff_id = 'S_003'")).toEqual({ n: 2 });
  });

  it("11. the reason is appended to the notes; the notes are capped, keeping the newest text", async () => {
    await owner.query("update ops.attendance set notes = 'Cancelled: ill' where attendance_id = 'A_20260608_S_003'");
    await fix(cleo({ reason: "Left early" }));
    expect((await row("A_20260608_S_003")).notes).toBe("Cancelled: ill | Corrected: Left early");
    await owner.query("update ops.attendance set notes = $1 where attendance_id = 'A_20260608_S_003'", ["o".repeat(1990)]);
    await fix(cleo({ reason: "The newest reason" }));
    const notes = (await row("A_20260608_S_003")).notes as string;
    expect(notes).toHaveLength(corrections.NOTES_CAP);
    expect(notes.startsWith("…o")).toBe(true);
    expect(notes.endsWith(" | Corrected: The newest reason")).toBe(true);
  });

  it("12. one audit row: the whole record before and after, the reason in details", async () => {
    await fix(cleo());
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_id: "S_001", action: "attendance.correct", target_type: "attendance", target_id: "A_20260608_S_003", details: "Left at 14:00, Eli covered" });
    const whole = {
      attendanceId: "A_20260608_S_003",
      status: "worked",
      scheduledStart: "09:00",
      scheduledEnd: "17:00",
      actualStart: "2026-06-08T13:00:00.000Z",
      hoursWorked: 8,
      rateAtAttendance: 20,
      hoursBasis: null,
      staffId: "S_003",
      date: DAY,
      createdBy: "S_002",
      createdAt: "2026-06-01T12:00:00.000Z",
    };
    expect(JSON.parse(a[0].before)).toEqual({ ...whole, actualEnd: "2026-06-08T21:00:00.000Z", notes: null, modifiedBy: null, modifiedAt: null });
    expect(JSON.parse(a[0].after)).toEqual({ ...whole, actualEnd: "2026-06-08T18:00:00.000Z", hoursWorked: 5, notes: "Corrected: Left at 14:00, Eli covered", modifiedBy: "S_001", modifiedAt: NOW.toISOString() });
  });

  it("12. created from nothing: before is null", async () => {
    await fix(cleo({ staffId: "S_005", date: "2026-06-07", actualStart: at("09:00", "2026-06-07"), actualEnd: at("11:00", "2026-06-07") }));
    const a = await audits();
    expect(a[0].before).toBeNull();
    expect(JSON.parse(a[0].after)).toMatchObject({ attendanceId: "A_20260607_S_005", staffId: "S_005", hoursWorked: 2, rateAtAttendance: 18, createdBy: "S_001", notes: "Corrected: Left at 14:00, Eli covered" });
  });

  it("13. till sessions, sales, payments, payment items and bonuses are never touched", async () => {
    await owner.query("insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method) values ('P_9','S_005','2026-06-09',10,'cash')");
    await owner.query("insert into ops.payment_items (item_id, payment_id, item_type, ref_id, amount) values ('I_9','P_9','shift','A_20260608_S_005',10)");
    const snap = async () => {
      const out: Record<string, unknown> = {};
      for (const t of ["till_sessions", "sales", "payments", "payment_items", "bonuses"]) out[t] = await db.query(`select * from ops.${t} order by 1`);
      return JSON.stringify(out);
    };
    const before = await snap();
    await fix(cleo());
    await fix({ staffId: "S_004", date: "2026-06-09", status: "cancelled", scheduledStart: "10:00", scheduledEnd: "18:00", reason: "no-show" });
    await fix(cleo({ staffId: "S_007", date: "2026-06-07", actualStart: at("09:00", "2026-06-07"), actualEnd: at("10:00", "2026-06-07") }));
    expect(await snap()).toBe(before);
  });
});

describe("at the same moment", () => {
  /** Runs `first` in a transaction on its own connection and holds the commit until `second` (on another connection) has had time to reach its first lock. */
  async function overlap<A, B>(first: (tx: any) => Promise<A>, second: (tx: any) => Promise<B>) {
    const [a, b] = await Promise.all([connect(testDb.appUrl), connect(testDb.appUrl)]);
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let ready!: () => void;
      const started = new Promise<void>((r) => (ready = r));
      const one = withTransaction(a, async (tx) => {
        const out = await first(tx);
        ready();
        await gate;
        return out;
      });
      await started;
      const two = withTransaction(b, second);
      await new Promise((r) => setTimeout(r, 300)); // the second is now waiting on a lock (or has run, without one)
      release();
      return await Promise.allSettled([one, two]);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  }
  const correctOn = (input: Record<string, unknown>, now: Date) => (tx: any) => corrections.correct(tx, input as any, "S_001", now);
  const T2 = new Date(NOW.getTime() + 1000);

  it("two corrections of one person and day: both complete, one row, two audit rows whose before/after chain", async () => {
    const input = { staffId: "S_005", date: "2026-06-07", status: "worked", scheduledStart: "", scheduledEnd: "", actualStart: at("09:00", "2026-06-07"), actualEnd: at("12:00", "2026-06-07"), reason: "Stood in" };
    const [one, two] = await overlap(correctOn(input, NOW), correctOn({ ...input, actualEnd: at("13:00", "2026-06-07"), reason: "Stood in until 13:00" }, T2));
    expect(one.status).toBe("fulfilled");
    expect(two.status).toBe("fulfilled");
    expect((one as PromiseFulfilledResult<any>).value.created).toBe(true);
    expect((two as PromiseFulfilledResult<any>).value.created).toBe(false);
    expect(await db.one<any>("select count(*)::int as n from ops.attendance where attendance_id = 'A_20260607_S_005'")).toEqual({ n: 1 });
    expect((await row("A_20260607_S_005")).hours_worked).toBe(4);
    const a = await audits();
    expect(a).toHaveLength(2);
    expect(a[0].before).toBeNull();
    expect(a[1].before).toBe(a[0].after);
    expect(JSON.parse(a[1].after).hoursWorked).toBe(4);
  });

  it("a payment first, a correction meanwhile: the correction waits, then is refused as paid", async () => {
    const pay = (tx: any) => payments.payShifts(tx, { staffId: "S_003", amount: 160, actorId: "S_006" }, { config: Config.fromRows([]), env: {}, fetch, now: NOW });
    const [p, c] = await overlap(pay, correctOn(cleo(), T2));
    expect(p.status).toBe("fulfilled");
    expect(c.status).toBe("rejected");
    expect(String((c as PromiseRejectedResult).reason.message)).toBe("Cannot correct: $160.00 has been paid against this day. Undo the payment first.");
    expect((await row("A_20260608_S_003")).hours_worked).toBe(8);
  });

  it("a correction first, a payment meanwhile: the payment waits, then sees the corrected hours", async () => {
    const pay = (amount: number) => (tx: any) => payments.payShifts(tx, { staffId: "S_003", amount, actorId: "S_006" }, { config: Config.fromRows([]), env: {}, fetch, now: T2 });
    const [c1, p1] = await overlap(correctOn(cleo(), NOW), pay(160));
    expect(c1.status).toBe("fulfilled");
    expect(String((p1 as PromiseRejectedResult).reason?.message)).toMatch(/^Overpayment rejected: trying to pay \$160\.00 but only \$100\.00 owed/);
    const [c2, p2] = await overlap(correctOn(cleo({ actualEnd: at("13:00"), reason: "Left at 13:00" }), new Date(NOW.getTime() + 5000)), pay(80));
    expect(c2.status).toBe("fulfilled");
    expect(p2.status).toBe("fulfilled");
    expect((p2 as PromiseFulfilledResult<any>).value.itemsCreated).toEqual([expect.objectContaining({ attendanceId: "A_20260608_S_003", amount: 80, isPartial: false })]);
  });
});
