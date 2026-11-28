// A day worked with no pay rate is "no rate set", not $0 (card P4-11b; ADR-0031). A DELIBERATE
// difference from the Apps Script app, in the Operations app only: the old app copies 0 onto the day
// when the person's rate is blank (`Number(x) || 0`), so the day is worth $0, is owed nothing and
// appears nowhere. Here the till close stores NULL for a blank rate, and the pay answers carry the
// day in an ADDED list (`noRateDays`, `noRateDayCount`, `skippedNoRate`), present only when there is
// such a day, so that for everyone else every answer is exactly what it was.
//
// Against a real database, through the REAL router and the merged contract. Order: the till close;
// the whole story (a manager adds someone with no rate, they work two days, payroll sees and refuses,
// the admin sets the rate from the first day, the days are owed and paid); a person with rated and
// no-rate days; rows already at 0 left alone; every answer for people with a rate pinned against the
// pre-change code; who may call; and the comparison harness's fixture, which has no blank-rate worker.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPin } from "../src/auth/pin";
import { createSession } from "../src/auth/sessions";
import { connect, type Db } from "../src/db/client";
import { Config } from "../src/lib/config";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import { allCases } from "../parity/cases/index";
import { CASE_START_AT, FIXTURE_BOOT_AT, FrozenClock } from "../parity/clock";
import { OldWorld } from "../parity/old-world";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
// The app role cannot delete money or audit rows (by design): the tables are reset as the owner.
let owner: Db & { close(): Promise<void> };

const PEPPER = "test-only-pepper-not-a-secret";
const ENV = { PIN_PEPPER: PEPPER };

// Toronto is UTC-4 in September. D1 is Tuesday 15 September 2026, D2 the Wednesday after.
const D1 = "2026-09-15";
const D2 = "2026-09-16";
const OPEN_1 = new Date("2026-09-15T14:00:00Z"); // 10:00
const CLOSE_1 = new Date("2026-09-15T20:30:00Z"); // 16:30: 6.5 h
const OPEN_2 = new Date("2026-09-16T13:00:00Z"); // 09:00
const CLOSE_2 = new Date("2026-09-16T21:15:00Z"); // 17:15: 8.25 h
/** When payroll is looked at and paid: Friday 18 September, 14:00. */
const NOW = new Date("2026-09-18T18:00:00Z");
const LATER = new Date("2026-09-18T18:05:00Z");

type Seed = [id: string, name: string, rate: number | null, role: string, companies: string | null];
const STAFF: Seed[] = [
  ["S_001", "Ada Quill", 0, "admin", "cstore,vape"], // a real rate of 0 (the owner)
  ["S_002", "Bram Hale", 21, "manager", "cstore,vape"],
  ["S_003", "Cleo Marsh", 20, "employee", "cstore,vape"],
  ["S_004", "Dara Vance", null, "employee", "cstore,vape"], // no rate recorded
  ["S_005", "Eli Stone", 18, "employee", "cstore,vape"],
  ["S_006", "Fay Ruiz", 22, "payroll_admin", null],
];
const CONFIG: Record<string, string> = {
  cstore_default_opening_float: "250",
  vape_default_opening_float: "60",
  lotto_reserve_default: "500",
  variance_ok_threshold: "1",
  variance_minor_threshold: "30",
};
let pinHash = "";

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  owner = await connect(testDb.ownerUrl);
  pinHash = await hashPin("2468", PEPPER, { iterations: 1000 });
});
afterAll(async () => {
  await db?.close();
  await owner?.close();
  await testDb?.drop();
});

beforeEach(async () => {
  for (const t of ["audit_log", "cash_handover_items", "cash_handovers", "payment_items", "payments", "sales", "till_sessions", "bonuses", "commission_runs", "attendance", "sessions", "login_failures", "config", "staff"]) {
    await owner.query(`delete from ops.${t}`);
  }
  for (const s of STAFF) {
    await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized, created_at, pin_hash) values ($1,$2,$3,true,$4,$5,'2025-01-01T12:00:00Z',$6)", [...s, pinHash]);
  }
  for (const [k, v] of Object.entries(CONFIG)) await owner.query("insert into ops.config (key, value) values ($1, $2)", [k, v]);
});

// ── Calling, through the real router ───────────────────────

const contract = parseRpcContract(
  mergeOpsContract(
    JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
    JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
  ),
);
const router = (now: Date) => createRpcRouter({ contract, handlers, openDb: () => connect(testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env: ENV, now: () => now, log: () => undefined });

interface Answer {
  ok: boolean;
  result?: any;
  error?: { message: string; code?: string };
}
/** Call `name` as `staffId` (a session made at `now`) with the arguments after the token. */
async function as(staffId: string, name: string, args: unknown[] = [], now = NOW): Promise<Answer> {
  const token = (await createSession(db, staffId, Config.fromRows([]), now)).token;
  const res = await router(now)(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: [token, ...args] }) }));
  return (await res.json()) as Answer;
}
async function ok(staffId: string, name: string, args: unknown[] = [], now = NOW): Promise<any> {
  const a = await as(staffId, name, args, now);
  if (!a.ok) throw new Error(`${name} as ${staffId} failed: ${JSON.stringify(a.error)}`);
  return a.result;
}

/** One vape till for `staffId`, opened and closed at the given instants with invented figures. */
async function workVape(staffId: string, openAt: Date, closeAt: Date): Promise<void> {
  await ok(staffId, "rpcOpenShift", [{ company: "vape", openingCount: 60 }], openAt);
  const day = openAt.toISOString().slice(0, 10).replaceAll("-", "");
  await ok(staffId, "rpcCloseShift", [{ sessionId: `VAP-${day}-${staffId}`, cashSales: 140, creditCardSales: 61.2, debitCardSales: 38.8, physicalCount: 200 }], closeAt);
}
async function workCstore(staffId: string, openAt: Date, closeAt: Date): Promise<void> {
  await ok(staffId, "rpcOpenShift", [{ company: "cstore", openingCount: 250 }], openAt);
  const day = openAt.toISOString().slice(0, 10).replaceAll("-", "");
  await ok(staffId, "rpcCloseShift", [{ sessionId: `CST-${day}-${staffId}`, cashSales: 300, cardTotalSales: 410, physicalCount: 550, lottoCounted: null, lottoTopupFromTill: 0, lottoNote: "" }], closeAt);
}

async function seedDay(id: string, staffId: string, date: string, hours: number | null, rate: number | null, status = "worked"): Promise<void> {
  await owner.query("insert into ops.attendance (attendance_id, staff_id, date, hours_worked, rate_at_attendance, status, created_by, created_at) values ($1,$2,$3,$4,$5,$6,'S_001',$7)", [
    id,
    staffId,
    date,
    hours,
    rate,
    status,
    `${date}T12:00:00Z`,
  ]);
}
async function seedPayment(id: string, staffId: string, items: Array<[ref: string, amount: number]>): Promise<void> {
  const total = items.reduce((s, i) => s + i[1], 0);
  await owner.query("insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method, recorded_by) values ($1,$2,'2026-09-12',$3,'cash','S_006')", [id, staffId, total]);
  for (const [n, [ref, amount]] of items.entries()) {
    await owner.query("insert into ops.payment_items (item_id, payment_id, item_type, ref_id, amount) values ($1,$2,'shift',$3,$4)", [`IT_${id}_${n}`, id, ref, amount]);
  }
}

const attRow = (id: string) => db.one<any>("select * from ops.attendance where attendance_id = $1", [id]);
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details from ops.audit_log order by seq`);
const json = (v: unknown): any => JSON.parse(JSON.stringify(v));
async function tables(names: readonly string[]): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  // Generated ids are random after their stamp, and `seq` counts every row ever written to the database: neither orders a comparison.
  const order: Record<string, string> = { payment_items: "ref_id, amount", payments: "staff_id, total_amount" };
  for (const t of names) out[t] = json(await db.query(`select * from ops.${t} order by ${order[t] ?? "1"}`)).map(({ seq: _seq, ...r }: Record<string, unknown>) => r);
  return out;
}
/** Generated ids keep their prefix and stamp; the random part is not compared. */
const normal = (v: unknown): any => JSON.parse(JSON.stringify(v).replace(/\b(P|IT|AL|B)_(\d{8})_(\d{6})_[a-z0-9]{1,10}\b/g, "$1_$2_$3_*"));

const NO_RATE_WORDS = (name: string) => `rpcPayShifts: ${name} has no pay rate set: set it on the Staff screen first.`;
const UNTOUCHED = ["till_sessions", "sales", "cash_handovers", "commission_runs", "bonuses"] as const;

// ── The till close ─────────────────────────────────────────

describe("the till close snapshots the rate as it is: NULL for a blank, 0 for a real 0", () => {
  it("a blank rate is stored NULL, a real 0 stays 0, a rate is copied; every other column as before", async () => {
    await workVape("S_004", OPEN_1, CLOSE_1); // blank rate
    await workCstore("S_001", OPEN_1, CLOSE_1); // a real 0
    await workVape("S_003", OPEN_2, CLOSE_2); // 20

    const dara = json(await attRow(`A_20260915_S_004`));
    const ada = json(await attRow(`A_20260915_S_001`));
    const cleo = json(await attRow(`A_20260916_S_003`));
    expect(dara.rate_at_attendance).toBeNull();
    expect(ada.rate_at_attendance).toBe(0);
    expect(cleo.rate_at_attendance).toBe(20);

    // What the pre-change code wrote for the same two closes (captured from it): every column but the rate.
    const PRE = (id: string, staffId: string, date: string, start: Date, end: Date, hours: number, rate: number) => ({
      attendance_id: id,
      staff_id: staffId,
      date,
      scheduled_start: null,
      scheduled_end: null,
      actual_start: start.toISOString(),
      actual_end: end.toISOString(),
      hours_worked: hours,
      rate_at_attendance: rate,
      status: "worked",
      notes: null,
      created_by: staffId,
      created_at: start.toISOString(),
      modified_by: staffId,
      modified_at: end.toISOString(),
      hours_basis: null,
      store_id: "store_main",
    });
    expect(dara).toEqual({ ...PRE("A_20260915_S_004", "S_004", D1, OPEN_1, CLOSE_1, 6.5, 0), rate_at_attendance: null });
    expect(ada).toEqual(PRE("A_20260915_S_001", "S_001", D1, OPEN_1, CLOSE_1, 6.5, 0));
    expect(cleo).toEqual(PRE("A_20260916_S_003", "S_003", D2, OPEN_2, CLOSE_2, 8.25, 20));

    // The audit row says so: rate null, not 0.
    const done = (await audits()).filter((a) => a.action === "attendance.complete").map((a) => [a.target_id, JSON.parse(a.after)]);
    expect(done).toEqual([
      ["A_20260915_S_004", { status: "worked", hoursWorked: 6.5, rate: null }],
      ["A_20260915_S_001", { status: "worked", hoursWorked: 6.5, rate: 0 }],
      ["A_20260916_S_003", { status: "worked", hoursWorked: 8.25, rate: 20 }],
    ]);
  });
});

// ── The whole story ────────────────────────────────────────

describe("the owner's story: a new hire with no rate, two days, then a rate from the first day", () => {
  it("is seen, refused, re-rated, owed and paid, and the audit rows tell it", async () => {
    const untouchedBefore = await tables(["cash_handovers", "commission_runs", "bonuses"]);

    // 1. The manager adds an employee, with no rate (the Staff card's own call).
    const added = await ok("S_002", "rpcCreateStaff", [{ name: "Hana Park", companies: ["vape"], startDate: "2026-09-14", pin: "4826" }], new Date("2026-09-14T15:00:00Z"));
    const HANA = added.record?.staffId ?? added.staffId;
    expect(HANA).toBe("S_007");
    expect((await db.one<any>("select hourly_rate from ops.staff where staff_id = $1", [HANA])).hourly_rate).toBeNull();

    // 2. They work two days.
    await workVape(HANA, OPEN_1, CLOSE_1);
    await workVape(HANA, OPEN_2, CLOSE_2);
    expect([(await attRow("A_20260915_S_007")).rate_at_attendance, (await attRow("A_20260916_S_007")).rate_at_attendance]).toEqual([null, null]);

    const DAYS = [
      { attendanceId: "A_20260915_S_007", dateStr: D1, hoursWorked: 6.5, paid: 0 },
      { attendanceId: "A_20260916_S_007", dateStr: D2, hoursWorked: 8.25, paid: 0 },
    ];

    // 3. Payroll: two days with no rate set, with the dates and hours; owed nothing; the count carried.
    const overview = await ok("S_001", "rpcGetPayrollOverview");
    expect(overview.find((p: any) => p.staffId === HANA)).toEqual({
      staffId: HANA,
      staffName: "Hana Park",
      hourlyRate: null,
      shiftsOwed: 0,
      bonusesOwed: 0,
      totalOwed: 0,
      unpaidShiftCount: 0,
      pendingBonusCount: 0,
      hasMismatch: false,
      mismatchCount: 0,
      noRateDayCount: 2,
      noRateDays: DAYS,
    });
    expect(await ok("S_006", "rpcGetOwedSummary", [HANA])).toEqual({
      staffId: HANA,
      shiftsOwed: 0,
      bonusesOwed: 0,
      totalOwed: 0,
      unpaidShifts: [],
      pendingBonuses: [],
      hasMismatch: false,
      mismatchCount: 0,
      noRateDayCount: 2,
      noRateDays: DAYS,
    });

    // 4. My Pay: no rate set (null, never 0), and the two days.
    expect(await ok(HANA, "rpcGetMyOwedSummary")).toEqual({
      staffId: HANA,
      staffName: "Hana Park",
      hourlyRate: null,
      shiftsOwed: 0,
      bonusesOwed: 0,
      totalOwed: 0,
      unpaidShifts: [],
      pendingBonuses: [],
      noRateDayCount: 2,
      noRateDays: DAYS,
    });

    // 5. Paying is refused with words, and nothing is written.
    const refused = await as("S_001", "rpcPayShifts", [{ staffId: HANA, amount: 50, method: "cash" }]);
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toBe(NO_RATE_WORDS("Hana Park"));
    expect((await db.one<any>("select count(*)::int as n from ops.payments")).n).toBe(0);

    // 6. The admin sets the rate, applying it to unpaid days from the first day.
    const update = await ok("S_001", "rpcUpdateStaff", [
      { staffId: HANA, name: "Hana Park", role: "employee", companies: ["vape"], hourlyRate: 19, startDate: "2026-09-14", email: "", notes: "", active: true, applyRateFrom: D1, reason: "first rate agreed" },
    ]);
    expect(update).toMatchObject({ daysChanged: 2, owedBefore: 0, owedAfter: 280.25 });

    // 7. Now owed hours x rate, in the unpaid list, and the no-rate fields are gone.
    const owed = await ok("S_006", "rpcGetOwedSummary", [HANA]);
    expect(owed.shiftsOwed).toBe(280.25); // 6.5 x 19 = 123.50, 8.25 x 19 = 156.75
    expect(owed.unpaidShifts.map((s: any) => [s.attendanceId, s.hoursWorked, s.rate, s.value, s.remaining])).toEqual([
      ["A_20260915_S_007", 6.5, 19, 123.5, 123.5],
      ["A_20260916_S_007", 8.25, 19, 156.75, 156.75],
    ]);
    expect(owed).not.toHaveProperty("noRateDays");
    expect(owed).not.toHaveProperty("noRateDayCount");
    const row = (await ok("S_001", "rpcGetPayrollOverview")).find((p: any) => p.staffId === HANA);
    expect(row).toMatchObject({ hourlyRate: 19, shiftsOwed: 280.25, totalOwed: 280.25, unpaidShiftCount: 2 });
    expect(row).not.toHaveProperty("noRateDays");
    expect(await ok(HANA, "rpcGetMyOwedSummary")).toMatchObject({ hourlyRate: 19, shiftsOwed: 280.25 });

    // 8. And they can be paid.
    const paid = await ok("S_001", "rpcPayShifts", [{ staffId: HANA, amount: 280.25, method: "etransfer" }], LATER);
    expect(paid.itemsCreated.map((i: any) => [i.attendanceId, i.amount, i.isPartial])).toEqual([
      ["A_20260915_S_007", 123.5, false],
      ["A_20260916_S_007", 156.75, false],
    ]);
    expect(paid).not.toHaveProperty("skippedNoRate");
    expect((await ok("S_006", "rpcGetOwedSummary", [HANA], LATER)).shiftsOwed).toBe(0);

    // The audit rows, in order, for Hana.
    const story = (await audits())
      .filter((a) => a.target_id === HANA || String(a.target_id).endsWith("_S_007") || (a.action === "payment.shifts" && JSON.parse(a.after).staffId === HANA))
      .filter((a) => a.action.startsWith("staff.") || a.action.startsWith("attendance.") || a.action.startsWith("payment."))
      .map((a) => [a.actor_id, a.action, a.target_id]);
    expect(normal(story)).toEqual([
      ["S_002", "staff.create", HANA],
      [HANA, "attendance.open", "A_20260915_S_007"],
      [HANA, "attendance.complete", "A_20260915_S_007"],
      [HANA, "attendance.open", "A_20260916_S_007"],
      [HANA, "attendance.complete", "A_20260916_S_007"],
      ["S_001", "staff.update", HANA],
      ["S_001", "staff.rate_applied", HANA],
      ["S_001", "payment.shifts", "P_20260918_140500_*"],
    ]);
    const all = await audits();
    expect(all.filter((a) => a.action === "attendance.complete" && a.target_id.endsWith("_S_007")).map((a) => JSON.parse(a.after).rate)).toEqual([null, null]);
    expect(JSON.parse(all.find((a) => a.action === "staff.rate_applied").after)).toMatchObject({
      applyRateFrom: D1,
      oldRate: null,
      newRate: 19,
      owedBefore: 0,
      owedAfter: 280.25,
      days: [
        { attendanceId: "A_20260915_S_007", date: D1, hours: 6.5, rateBefore: null },
        { attendanceId: "A_20260916_S_007", date: D2, hours: 8.25, rateBefore: null },
      ],
    });
    expect(JSON.parse(all.find((a) => a.action === "payment.shifts").after)).toEqual({ staffId: HANA, amount: 280.25, itemCount: 2, attendanceIds: ["A_20260915_S_007", "A_20260916_S_007"] });
    expect(await tables(["cash_handovers", "commission_runs", "bonuses"])).toEqual(untouchedBefore);
  });
});

// ── Rated and no-rate days together ────────────────────────

describe("a person with rated days and no-rate days", () => {
  beforeEach(async () => {
    await seedDay("A_20260908_S_005", "S_005", "2026-09-08", 8, 18); // 144.00
    await seedDay("A_20260909_S_005", "S_005", "2026-09-09", 5, null); // no rate
    await seedDay("A_20260910_S_005", "S_005", "2026-09-10", 4, 18); // 72.00
    await seedDay("A_20260911_S_005", "S_005", "2026-09-11", null, null); // no rate, no hours either
  });
  const SKIPPED = [
    { attendanceId: "A_20260909_S_005", dateStr: "2026-09-09", hoursWorked: 5, paid: 0 },
    { attendanceId: "A_20260911_S_005", dateStr: "2026-09-11", hoursWorked: null, paid: 0 },
  ];

  it("the totals count only the rated days and carry the count of days left out", async () => {
    const o = await ok("S_006", "rpcGetOwedSummary", ["S_005"]);
    expect(o).toMatchObject({ shiftsOwed: 216, totalOwed: 216, noRateDayCount: 2, noRateDays: SKIPPED });
    expect(o.unpaidShifts.map((s: any) => s.attendanceId)).toEqual(["A_20260908_S_005", "A_20260910_S_005"]);
    const row = (await ok("S_001", "rpcGetPayrollOverview")).find((p: any) => p.staffId === "S_005");
    expect(row).toMatchObject({ hourlyRate: 18, shiftsOwed: 216, totalOwed: 216, unpaidShiftCount: 2, noRateDayCount: 2, noRateDays: SKIPPED });
    expect(await ok("S_005", "rpcGetMyOwedSummary")).toMatchObject({ hourlyRate: 18, shiftsOwed: 216, noRateDayCount: 2, noRateDays: SKIPPED });
  });

  it("paying pays the rated days and names the skipped ones; more than is owed says what was not counted", async () => {
    const over = await as("S_001", "rpcPayShifts", [{ staffId: "S_005", amount: 300 }]);
    expect(over.error?.message).toBe("rpcPayShifts: Overpayment rejected: trying to pay $300.00 but only $216.00 owed in unpaid shifts for Eli Stone. Not counted: 2 days worked with no rate set.");

    const paid = await ok("S_001", "rpcPayShifts", [{ staffId: "S_005", amount: 216, method: "cash" }]);
    expect(paid.itemsCreated.map((i: any) => [i.attendanceId, i.amount])).toEqual([
      ["A_20260908_S_005", 144],
      ["A_20260910_S_005", 72],
    ]);
    expect(paid.skippedNoRate).toEqual(SKIPPED);
    expect(paid.summary).toEqual({ shiftsOwedBefore: 216, shiftsOwedAfter: 0, fullyPaidCount: 2, partialCount: 0 });
    const items = await db.query<any>("select ref_id, amount from ops.payment_items order by ref_id");
    expect(items).toEqual([
      { ref_id: "A_20260908_S_005", amount: 144 },
      { ref_id: "A_20260910_S_005", amount: 72 },
    ]);
    const a = (await audits()).find((x) => x.action === "payment.shifts");
    expect(JSON.parse(a.after)).toEqual({ staffId: "S_005", amount: 216, itemCount: 2, attendanceIds: ["A_20260908_S_005", "A_20260910_S_005"], skippedNoRate: ["A_20260909_S_005", "A_20260911_S_005"] });

    // Only no-rate days are left: refused. Eli has a rate now, so the words name the days and the fix.
    const again = await as("S_001", "rpcPayShifts", [{ staffId: "S_005", amount: 10 }], LATER);
    expect(again.error?.message).toBe(
      "rpcPayShifts: Eli Stone has 2 days worked with no rate set (2026-09-09, 2026-09-11): set the rate on the Staff screen, with 'also apply to unpaid days from' 2026-09-09, first.",
    );
    expect((await db.one<any>("select count(*)::int as n from ops.payments")).n).toBe(1);
  });

  it("a person with only a real rate of 0 is as before: nothing owed, nothing listed, 'No unpaid shifts'", async () => {
    await seedDay("A_20260908_S_001", "S_001", "2026-09-08", 6, 0);
    const o = await ok("S_006", "rpcGetOwedSummary", ["S_001"]);
    expect(o).toEqual({ staffId: "S_001", shiftsOwed: 0, bonusesOwed: 0, totalOwed: 0, unpaidShifts: [], pendingBonuses: [], hasMismatch: false, mismatchCount: 0 });
    expect(await ok("S_001", "rpcGetMyOwedSummary")).toEqual({ staffId: "S_001", staffName: "Ada Quill", hourlyRate: 0, shiftsOwed: 0, bonusesOwed: 0, totalOwed: 0, unpaidShifts: [], pendingBonuses: [] });
    expect((await as("S_001", "rpcPayShifts", [{ staffId: "S_001", amount: 5 }])).error?.message).toBe("rpcPayShifts: No unpaid shifts for Ada Quill. Nothing to pay.");
  });
});

// ── Rows already at 0 ──────────────────────────────────────

describe("rows already holding 0 are left alone", () => {
  it("no call here rewrites an old 0, and a 0 day is never listed as 'no rate'", async () => {
    // Dara (blank rate now) has a day the old app closed with 0; Cleo a day at 0 too.
    await seedDay("A_20260901_S_004", "S_004", "2026-09-01", 7, 0);
    await seedDay("A_20260902_S_003", "S_003", "2026-09-02", 6, 0);
    await seedDay("A_20260903_S_003", "S_003", "2026-09-03", 5, 20);
    const zeros = () => db.query<any>("select * from ops.attendance where attendance_id in ('A_20260901_S_004','A_20260902_S_003') order by 1");
    const before = json(await zeros());
    const calls: Array<() => Promise<unknown>> = [
      () => as("S_001", "rpcGetPayrollOverview"),
      () => as("S_006", "rpcGetOwedSummary", ["S_004"]),
      () => as("S_006", "rpcGetOwedSummary", ["S_003"]),
      () => as("S_004", "rpcGetMyOwedSummary"),
      () => as("S_003", "rpcGetMyOwedSummary"),
      () => as("S_001", "rpcGetWeekSchedule", ["2026-08-31"]),
      () => as("S_001", "rpcPayShifts", [{ staffId: "S_004", amount: 5 }]),
      () => as("S_001", "rpcPayShifts", [{ staffId: "S_003", amount: 100 }]),
      () => workVape("S_004", OPEN_1, CLOSE_1),
      () => as("S_001", "rpcGetPaymentHistory", [50]),
    ];
    for (const c of calls) {
      await c();
      expect(json(await zeros())).toEqual(before);
    }
    const o = await ok("S_006", "rpcGetOwedSummary", ["S_004"]);
    expect(o.noRateDays.map((d: any) => d.attendanceId)).toEqual(["A_20260915_S_004"]); // the new close, not the old 0
    expect(o.unpaidShifts).toEqual([]);
  });
});

// ── For people with a rate, nothing changes ────────────────

/** The rated world: days for Ada (a real 0), Cleo and Eli, a part payment, a 0 day for Dara (blank rate). */
async function ratedWorld(): Promise<void> {
  await seedDay("A_20260908_S_003", "S_003", "2026-09-08", 8, 20);
  await owner.query("update ops.attendance set scheduled_start = '09:00', scheduled_end = '17:00', actual_start = '2026-09-09T13:00:00Z', actual_end = '2026-09-09T20:30:00Z' where attendance_id = 'A_20260908_S_003'");
  await seedDay("A_20260909_S_003", "S_003", "2026-09-09", 7.5, 20);
  await seedDay("A_20260908_S_005", "S_005", "2026-09-08", 6, 18);
  await seedDay("A_20260909_S_005", "S_005", "2026-09-09", 3.33, 18.125);
  await seedDay("A_20260909_S_001", "S_001", "2026-09-09", 5, 0);
  await seedDay("A_20260910_S_002", "S_002", "2026-09-10", 0, 0, "scheduled");
  await seedDay("A_20260901_S_004", "S_004", "2026-09-01", 7, 0); // the old app's 0 for Dara
  await seedPayment("P_20260912_120000_old", "S_005", [["A_20260908_S_005", 50]]);
}

/** Every answer the pay and schedule screens get for the rated world, and the rows the calls leave. */
async function ratedAnswers(): Promise<Record<string, unknown>> {
  await ratedWorld();
  const out: Record<string, unknown> = {};
  await workCstore("S_001", OPEN_1, CLOSE_1);
  await workVape("S_003", OPEN_2, CLOSE_2);
  out["overview"] = (await ok("S_001", "rpcGetPayrollOverview")).filter((p: any) => p.staffId !== "S_004");
  for (const id of ["S_001", "S_002", "S_003", "S_005", "S_006"]) out[`owed ${id}`] = await ok("S_006", "rpcGetOwedSummary", [id]);
  for (const id of ["S_001", "S_002", "S_003", "S_005", "S_006"]) out[`my ${id}`] = await ok(id, "rpcGetMyOwedSummary");
  out["owed S_004 shifts"] = (await ok("S_006", "rpcGetOwedSummary", ["S_004"])).unpaidShifts;
  out["edit times"] = await ok("S_001", "rpcEditAttendanceTimes", [{ attendanceId: "A_20260909_S_003", actualStart: "2026-09-09T09:00", actualEnd: "2026-09-09T16:45" }]);
  out["adjust"] = await ok("S_002", "rpcAdjustAttendanceHours", ["A_20260908_S_003", "scheduled"]);
  out["schedule"] = await ok("S_002", "rpcScheduleShift", [{ staffId: "S_005", date: "2026-09-21", scheduledStart: "10:00", scheduledEnd: "18:00" }]);
  out["week"] = await ok("S_003", "rpcGetWeekSchedule", ["2026-09-07"]);
  out["week 2"] = await ok("S_003", "rpcGetWeekSchedule", ["2026-09-14"]);
  out["pay S_005"] = await ok("S_001", "rpcPayShifts", [{ staffId: "S_005", amount: 30, method: "bank", notes: "part" }]);
  out["over S_003"] = await as("S_001", "rpcPayShifts", [{ staffId: "S_003", amount: 9999 }]);
  out["pay S_003"] = await ok("S_006", "rpcPayShifts", [{ staffId: "S_003", amount: (out["owed S_003"] as any).shiftsOwed }], LATER);
  out["none S_001"] = await as("S_001", "rpcPayShifts", [{ staffId: "S_001", amount: 5 }], LATER);
  out["history"] = await ok("S_001", "rpcGetPaymentHistory", [50], LATER);
  out["my history"] = await ok("S_003", "rpcGetPaymentHistory", [50], LATER);
  out["all staff"] = await ok("S_001", "rpcGetAllStaff", [], LATER);
  out["overview after"] = (await ok("S_001", "rpcGetPayrollOverview", [], LATER)).filter((p: any) => p.staffId !== "S_004");
  out["rows"] = await tables(["attendance", "payments", "payment_items", ...UNTOUCHED]);
  out["audit"] = (await audits()).filter((a) => a.action !== "auth.login");
  return normal(json(out));
}

describe("for every person with a rate (or a real 0), every answer and row is exactly as before", () => {
  it("matches what the pre-change code answered and wrote (pinned)", async () => {
    const now = await ratedAnswers();
    const out = process.env["NO_RATE_PIN_OUT"];
    if (out) writeFileSync(out, JSON.stringify(now, null, 1) + "\n");
    const pinned = JSON.parse(readFileSync(new URL("./fixtures/no-rate/pre-change.json", import.meta.url), "utf8"));
    for (const key of Object.keys(pinned)) expect([key, now[key]]).toEqual([key, pinned[key]]);
    expect(Object.keys(now).sort()).toEqual(Object.keys(pinned).sort());
  });

  it("for a blank-rate person the answers hold null or the added fields, never a silent 0", async () => {
    await ratedWorld();
    await workVape("S_004", OPEN_1, CLOSE_1); // stored NULL
    const DAY = { attendanceId: "A_20260915_S_004", dateStr: D1, hoursWorked: 6.5, paid: 0 };
    const row = (await ok("S_001", "rpcGetPayrollOverview")).find((p: any) => p.staffId === "S_004");
    expect(row).toMatchObject({ hourlyRate: null, shiftsOwed: 0, totalOwed: 0, unpaidShiftCount: 0, noRateDayCount: 1, noRateDays: [DAY] });
    expect(await ok("S_006", "rpcGetOwedSummary", ["S_004"])).toMatchObject({ shiftsOwed: 0, noRateDayCount: 1, noRateDays: [DAY] });
    expect(await ok("S_004", "rpcGetMyOwedSummary")).toMatchObject({ hourlyRate: null, noRateDayCount: 1, noRateDays: [DAY] });
    expect((await as("S_006", "rpcPayShifts", [{ staffId: "S_004", amount: 1 }])).error?.message).toBe(NO_RATE_WORDS("Dara Vance"));
    // The Schedule answers carry the day's record: its rate is null, not 0.
    expect((await ok("S_001", "rpcEditAttendanceTimes", [{ attendanceId: "A_20260915_S_004", actualStart: "2026-09-15T10:00", actualEnd: "2026-09-15T16:00" }])).rateAtAttendance).toBeNull();
    // The old 0 row is not a no-rate day; it stays as it was, at 0.
    expect((await attRow("A_20260901_S_004")).rate_at_attendance).toBe(0);
  });
});

// ── Who may ────────────────────────────────────────────────

describe("who may call is unchanged", () => {
  it("the contract entries of every call touched here are what they were", () => {
    const raw = JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8"));
    const pick = (n: string) => {
      const e = raw.rpcs.find((x: any) => x.name === n);
      return [n, e.roles, e.needs_session, e.migrate];
    };
    expect(["rpcGetPayrollOverview", "rpcGetOwedSummary", "rpcGetMyOwedSummary", "rpcPayShifts", "rpcCloseShift", "rpcEditAttendanceTimes", "rpcAdjustAttendanceHours", "rpcGetAllStaff"].map(pick)).toEqual([
      ["rpcGetPayrollOverview", ["admin", "payroll_admin"], true, true],
      ["rpcGetOwedSummary", ["admin", "payroll_admin"], true, true],
      ["rpcGetMyOwedSummary", null, true, true],
      ["rpcPayShifts", ["admin", "payroll_admin"], true, true],
      ["rpcCloseShift", null, true, true],
      ["rpcEditAttendanceTimes", ["admin"], true, true],
      ["rpcAdjustAttendanceHours", ["admin", "manager"], true, true],
      ["rpcGetAllStaff", ["admin"], true, true],
    ]);
  });

  it("an employee or a manager still cannot see payroll or pay; an employee sees only their own pay", async () => {
    await workVape("S_004", OPEN_1, CLOSE_1);
    for (const who of ["S_002", "S_003"]) {
      expect((await as(who, "rpcGetPayrollOverview")).error?.code ?? (await as(who, "rpcGetPayrollOverview")).error?.message).toMatch(/FORBIDDEN/);
      expect((await as(who, "rpcPayShifts", [{ staffId: "S_004", amount: 1 }])).ok).toBe(false);
    }
    expect(await ok("S_003", "rpcGetMyOwedSummary", ["S_004"])).not.toHaveProperty("noRateDays"); // the argument is ignored
  });
});

// ── The comparison harness ─────────────────────────────────

describe("the comparison harness has no worker with a blank rate (so no case sees this difference)", () => {
  it("the fixture's people all have a rate, and every worked day in it has one", () => {
    const old = OldWorld.boot(new FrozenClock(CASE_START_AT), FIXTURE_BOOT_AT);
    const staffTab = old.tab("staff");
    const col = (tab: { header: unknown[] }, name: string) => tab.header.findIndex((h) => String(h).trim() === name);
    const rateCol = col(staffTab, "hourly_rate");
    const people = staffTab.rows.filter((r) => String(r[col(staffTab, "staff_id")] ?? "").trim() !== "");
    expect(people.length).toBeGreaterThanOrEqual(7);
    expect(people.filter((r) => r[rateCol] === "" || r[rateCol] === null || typeof r[rateCol] !== "number")).toEqual([]);

    const att = old.tab("attendance");
    const [st, rate] = [col(att, "status"), col(att, "rate_at_attendance")];
    const days = att.rows.filter((r) => String(r[0] ?? "").trim() !== "");
    expect(days.filter((r) => String(r[st]).trim() === "worked").length).toBeGreaterThan(300);
    expect(days.filter((r) => String(r[st]).trim() === "worked" && (r[rate] === "" || r[rate] === null))).toEqual([]);
  });

  it("no case calls anything that can set a rate, and no case passes a blank rate", () => {
    const portedRpcs = new Set(JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")).rpcs.map((e: any) => e.name));
    const blanks: string[] = [];
    const walk = (v: unknown, where: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (/rate/i.test(k) && (x === null || x === "")) blanks.push(`${where}.${k}`);
          walk(x, `${where}.${k}`);
        }
      }
    };
    for (const c of allCases) {
      for (const s of c.steps) {
        if (!s.direct) expect(portedRpcs.has(s.rpc), `${c.title}: ${s.rpc}`).toBe(true);
        walk((s as { args?: unknown }).args, `${c.title} ${s.rpc}`);
      }
    }
    expect(blanks).toEqual([]);
    // None of the ported calls writes hourly_rate (only the Staff screen's own calls do, and the harness never calls them).
    expect([...portedRpcs].filter((n) => /CreateStaff|UpdateStaff|SetRate/.test(String(n)))).toEqual([]);
  });

  it("the pinned answers file is the one captured from the pre-change code", () => {
    const text = readFileSync(new URL("./fixtures/no-rate/pre-change.json", import.meta.url), "utf8");
    expect(createHash("sha256").update(text).digest("hex")).toBe(PINNED_SHA256);
  });
});

/** sha256 of fixtures/no-rate/pre-change.json as captured from commit 91f8df5 (before this card). */
const PINNED_SHA256 = "17510ef95d2ce4884603f613fa8d9af137cc0aa170495b6e4d6b1d396df63ad3";
