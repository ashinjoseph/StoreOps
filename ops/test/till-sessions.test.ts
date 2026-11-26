// The open and the close: modules/till-sessions.ts, the two attendance functions it calls, and the
// three RPCs of handlers/shifts.ts, against a real database with invented people.
//
// Ported here, assertion for assertion, from the old suites:
//   - tests/suites/lotto-payout.js: every assertion (netting, the reserve fed from two counts, no
//     double-counted top-up, the two guards, no previous count, a drawer below float, the log's
//     lastCounted). `lastOpening` is undefined in the old log and here.
//   - tests/suites/wiring.js: the server half (each close-sheet field reaches the session and the
//     sales row under its ledger name; blank is not zero across the hop; a recorded zero stays a
//     zero; a minus survives; the actor is the session; the reply is flat JSON with no Date; the
//     open is bound to the caller and an admin may name someone). The page half (reading the field
//     names out of Index.html's call site) is about the page's own script and stays in tests/.
// What the parity fixture cannot show is covered too: a person not authorised for a till, an
// unreadable count (refused here; the Sheet stored NaN), a database failure inside the close
// (nothing is kept), two closes of one session at once, Attendance.complete refusing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction, type Tx } from "../src/db/tx";
import { loadConfig } from "../src/lib/config";
import * as ts from "../src/modules/till-sessions";
import { rpcCloseShift, rpcNotifyShiftOpen, rpcOpenShift } from "../src/rpc/handlers/shifts";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

// Saturday 12 September 2026; Toronto is UTC-4. 09:00 local = 13:00Z.
const OPEN_AT = new Date("2026-09-12T13:00:00Z");
const CLOSE_AT = new Date("2026-09-12T21:00:00Z");
const DAY = "2026-09-12";

const STAFF: Array<[string, string, number | null, string, string]> = [
  ["S_001", "Ada Quill", 25, "admin", "cstore,vape"],
  ["S_002", "Bram Hale", 21, "manager", "cstore,vape"],
  ["S_003", "Cleo Marsh", 18.25, "employee", "cstore,vape"],
  ["S_004", "Dara Vance", 17.5, "employee", "vape"],
  ["S_005", "Eli Stone", 17.2, "employee", "cstore,vape"],
];
const CONFIG: Record<string, string> = {
  cstore_default_opening_float: "250",
  vape_default_opening_float: "60",
  lotto_reserve_default: "500",
  variance_ok_threshold: "1",
  variance_minor_threshold: "30",
};

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

async function setConfig(rows: Record<string, string | null>): Promise<void> {
  await owner.query("delete from ops.config");
  for (const [k, v] of Object.entries(rows)) await owner.query("insert into ops.config (key, value) values ($1, $2)", [k, v]);
}

beforeEach(async () => {
  for (const t of ["audit_log", "sales", "till_sessions", "attendance", "staff", "config"]) await owner.query(`delete from ops.${t}`);
  for (const s of STAFF) await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized) values ($1,$2,$3,true,$4,$5)", s);
  await setConfig(CONFIG);
});

const session = (staffId: string, role: Session["role"], name = staffId): Session => ({ staffId, name, role, companiesAuthorized: ["cstore", "vape"], expiresAt: 0 });
const ME = session("S_003", "employee", "Cleo Marsh");
const ADMIN = session("S_001", "admin", "Ada Quill");
const MANAGER = session("S_002", "manager", "Bram Hale");

function ctxFor(tx: Tx, who: Session | null, now: Date, extra: Partial<RpcContext> = {}): RpcContext {
  return { db: tx, session: who, config: () => loadConfig(tx), env: {}, fetch: () => Promise.reject(new Error("no network in this test")), now, ...extra };
}
async function rpc(handler: (ctx: RpcContext, ...a: unknown[]) => unknown, who: Session | null, args: unknown[], now: Date, extra: Partial<RpcContext> = {}): Promise<any> {
  return withTransaction(db, async (tx) => handler(ctxFor(tx, who, now, extra), ...args));
}
const deps = async (tx: Tx, now: Date) => ({ config: await loadConfig(tx), now });
const open = (input: ts.OpenInput, now = OPEN_AT) => withTransaction(db, async (tx) => ts.open(tx, input, await deps(tx, now)));
const close = (input: ts.CloseInput, now = CLOSE_AT) => withTransaction(db, async (tx) => ts.close(tx, input, await deps(tx, now)));

const sessRow = (id: string) => db.one<any>("select * from ops.till_sessions where session_id = $1", [id]);
const salesRow = (id: string) => db.maybeOne<any>("select * from ops.sales where session_id = $1", [id]);
const attRow = (id: string) => db.one<any>("select * from ops.attendance where attendance_id = $1", [id]);
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details from ops.audit_log order by "timestamp", log_id`);
const count = async (table: string) => (await db.one<{ n: number }>(`select count(*)::int as n from ops.${table}`)).n;

/** A closed cstore session with a reserve count, written straight in: history, not a close under test. */
async function seedReserve(counted: number | null, topup = 0, date = "2026-09-10", id = "CST-20260910-S_005") {
  await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ($1, 'S_005', $2, 'worked') on conflict do nothing", [`A_${date.replace(/-/g, "")}_S_005`, date]);
  await owner.query(
    `insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time, end_time, lotto_reserve_counted, lotto_topup_from_till, lotto_reserve_note)
     values ($1, $2, 'S_005', 'cstore', $3, 'closed', $4, $5, $6, $7, 'seed')`,
    [id, `A_${date.replace(/-/g, "")}_S_005`, date, `${date}T12:00:00Z`, `${date}T23:59:00Z`, counted, topup],
  );
}

// ── The open ───────────────────────────────────────────────

describe("open", () => {
  it("two people opening the same till at the same moment: exactly one gets it", async () => {
    // Each on its own connection, as two requests are. Without a lock both see "no open session"
    // and both insert, and the till has two open sessions.
    for (let round = 0; round < 5; round++) {
      await owner.query("delete from ops.audit_log");
      await owner.query("delete from ops.till_sessions");
      await owner.query("delete from ops.attendance");
      const conns = await Promise.all([connect(testDb.appUrl), connect(testDb.appUrl)]);
      try {
        const tries = await Promise.allSettled(
          ["S_003", "S_005"].map((staffId, i) =>
            withTransaction(conns[i]!, async (tx) => ts.open(tx, { staffId, company: "cstore", openingCount: 250, actorId: staffId }, await deps(tx, OPEN_AT))),
          ),
        );
        expect(tries.filter((t) => t.status === "fulfilled")).toHaveLength(1);
        const refused = tries.find((t) => t.status === "rejected") as PromiseRejectedResult;
        expect(String(refused.reason.message)).toMatch(/^cstore already has an open shift \(CST-20260912-S_00[35] by S_00[35]\)$/);
        expect(await count("till_sessions")).toBe(1);
        expect(await count("attendance")).toBe(1);
      } finally {
        await Promise.all(conns.map((c) => c.close()));
      }
    }
  });

  it("cstore: writes the session with zeros in the closing columns and the lotto pair, creates the day, audits and notifies", async () => {
    const r = await rpc(rpcOpenShift, ME, [{ company: "cstore", openingCount: "250" }], OPEN_AT);
    expect(r).toEqual({ sessionId: "CST-20260912-S_003", company: "cstore", staffId: "S_003", status: "open", openingFloat: 250, startTime: OPEN_AT.toISOString() });
    expect(await sessRow("CST-20260912-S_003")).toMatchObject({
      attendance_id: "A_20260912_S_003",
      date: DAY,
      status: "open",
      start_time: OPEN_AT,
      end_time: null,
      expected_opening: 250,
      opening_float: 250,
      opening_note: null,
      // The old code writes 0, not blank, in these on an open session: kept.
      closing_cash_counted: 0,
      cash_left_in_till: 0,
      cash_removed_at_close: 0,
      expected_cash: 0,
      closing_variance: 0,
      variance_status: null,
      notes: null,
      lotto_reserve_counted: 0,
      lotto_topup_from_till: 0,
      lotto_reserve_note: null,
    });
    expect(await attRow("A_20260912_S_003")).toMatchObject({ status: "in_progress", actual_start: OPEN_AT, hours_worked: 0, rate_at_attendance: 0, created_by: "S_003", created_at: OPEN_AT });
    const a = await audits();
    expect(a.map((x) => x.action)).toEqual(expect.arrayContaining(["attendance.open", "till.open", "notify.shift.opened"]));
    expect(JSON.parse(a.find((x) => x.action === "till.open").after)).toEqual({ staffId: "S_003", company: "cstore", openingFloat: 250, attendanceId: "A_20260912_S_003" });
    expect(a.find((x) => x.action === "notify.shift.opened")).toMatchObject({ actor_id: "SYSTEM", target_type: "notification", target_id: null, details: "🟢 Cleo Marsh opened cstore shift (float $250)" });
  });

  it("vape: blanks, not zeros, in the lotto columns", async () => {
    await rpc(rpcOpenShift, ME, [{ company: "vape", openingCount: 60 }], OPEN_AT);
    expect(await sessRow("VAP-20260912-S_003")).toMatchObject({ lotto_reserve_counted: null, lotto_topup_from_till: null, expected_opening: 60 });
  });

  it("refuses a till the person is not authorised for", async () => {
    await expect(rpc(rpcOpenShift, session("S_004", "employee"), [{ company: "cstore", openingCount: 250 }], OPEN_AT)).rejects.toThrow("Dara Vance is not authorized for cstore");
    expect(await count("till_sessions")).toBe(0);
  });

  it("a counted float off by more than a cent needs a note; 100.01 against 100 is already more than a cent", async () => {
    await expect(open({ staffId: "S_003", company: "vape", openingCount: 55, actorId: "S_003" })).rejects.toThrow("Float mismatch (counted 55, expected 60). Please provide an opening note.");
    await setConfig({ ...CONFIG, vape_default_opening_float: "100" });
    await expect(open({ staffId: "S_003", company: "vape", openingCount: 100.01, actorId: "S_003" })).rejects.toThrow("Float mismatch");
    await open({ staffId: "S_003", company: "vape", openingCount: 100.005, actorId: "S_003" });
    expect((await sessRow("VAP-20260912-S_003")).opening_float).toBe(100.01); // roundMoney(100.005), within a cent of the float
  });

  it("a mismatched float with a note opens, and the note is kept", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 55, openingNote: "short $5", actorId: "S_003" });
    expect(await sessRow("VAP-20260912-S_003")).toMatchObject({ opening_float: 55, expected_opening: 60, opening_note: "short $5" });
  });

  it("the floats read `Number(setting) || 0`: an explicit 0 is 0, junk is 0, blank is the default", async () => {
    const c = async (rows: Record<string, string | null>) => {
      await setConfig(rows);
      return withTransaction(db, async (tx) => ts.getExpectedFloat(await loadConfig(tx), "cstore"));
    };
    expect(await c({ cstore_default_opening_float: "0" })).toBe(0);
    expect(await c({ cstore_default_opening_float: "abc" })).toBe(0);
    expect(await c({ cstore_default_opening_float: "" })).toBe(250);
    expect(await c({})).toBe(250);
    await setConfig({ lotto_reserve_default: "0" });
    expect(await withTransaction(db, async (tx) => ts.getLottoExpected(await loadConfig(tx)))).toBe(0);
  });

  it("an unreadable count is refused with a plain message (the Sheet stored NaN; the schema cannot), and nothing is written", async () => {
    await expect(rpc(rpcOpenShift, ME, [{ company: "vape", openingCount: "abc" }], OPEN_AT)).rejects.toThrow("openingCount is not a number");
    await expect(rpc(rpcOpenShift, ME, [{ company: "vape" }], OPEN_AT)).rejects.toThrow("openingCount is not a number");
    expect(await count("till_sessions")).toBe(0);
    expect(await count("attendance")).toBe(0);
    expect(await count("audit_log")).toBe(0);
  });

  it("refuses a second open of the same till, and a second shift of the same person on the same till the same day", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    await expect(open({ staffId: "S_005", company: "vape", openingCount: 60, actorId: "S_005" })).rejects.toThrow("vape already has an open shift (VAP-20260912-S_003 by S_003)");
    await close({ sessionId: "VAP-20260912-S_003", actorId: "S_003", physicalCount: 60 });
    await expect(open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" }, CLOSE_AT)).rejects.toThrow(
      "Cleo Marsh already has a vape shift today (VAP-20260912-S_003, closed). One shift per person per till per day — an admin can edit that session instead.",
    );
  });

  it("promotes a scheduled day, keeps a day in progress, refuses a worked or cancelled one", async () => {
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, scheduled_start, scheduled_end, status, created_by) values ('A_20260912_S_003','S_003','2026-09-12','09:00','17:00','scheduled','S_002')");
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    expect(await attRow("A_20260912_S_003")).toMatchObject({ status: "in_progress", actual_start: OPEN_AT, modified_by: "S_003", modified_at: OPEN_AT, scheduled_start: "09:00", hours_worked: null });
    const promote = (await audits()).find((x) => x.action === "attendance.promote");
    expect(JSON.parse(promote.after)).toEqual({ status: "in_progress", actualStart: OPEN_AT.toISOString() });
    await open({ staffId: "S_003", company: "cstore", openingCount: 250, actorId: "S_003" }, new Date("2026-09-12T14:00:00Z"));
    expect((await attRow("A_20260912_S_003")).actual_start).toEqual(OPEN_AT); // unchanged by the second till
  });

  it("refuses a cancelled day, and writes nothing", async () => {
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ('A_20260912_S_005','S_005','2026-09-12','cancelled')");
    await expect(open({ staffId: "S_005", company: "vape", openingCount: 60, actorId: "S_005" })).rejects.toThrow("Attendance for S_005 on 2026-09-12 is cancelled. Uncancel before opening.");
    expect(await count("till_sessions")).toBe(0);
  });

  it("the open is bound to the caller: a cashier cannot name someone else, an admin can (and is the actor), a manager cannot", async () => {
    await expect(rpc(rpcOpenShift, ME, [{ staffId: "S_005", company: "cstore", openingCount: 250 }], OPEN_AT)).rejects.toThrow("FORBIDDEN: can only open your own shift");
    await expect(rpc(rpcOpenShift, MANAGER, [{ staffId: "S_005", company: "cstore", openingCount: 250 }], OPEN_AT)).rejects.toThrow("FORBIDDEN");
    const r = await rpc(rpcOpenShift, ADMIN, [{ staffId: "S_005", company: "cstore", openingCount: 250, openingNote: "float ok" }], OPEN_AT);
    expect(r.staffId).toBe("S_005");
    expect(r.startTime).toBe(OPEN_AT.toISOString());
    expect((await sessRow("CST-20260912-S_005")).opening_note).toBe("float ok");
    expect((await audits()).find((x) => x.action === "till.open").actor_id).toBe("S_001");
    expect((await attRow("A_20260912_S_005")).created_by).toBe("S_001");
  });

  it("a missing input object fails as the old code did", async () => {
    await expect(rpc(rpcOpenShift, ME, [], OPEN_AT)).rejects.toThrow("Cannot read properties of undefined (reading 'staffId')");
  });
});

// ── The close ──────────────────────────────────────────────

async function openCstore(staffId = "S_003", now = OPEN_AT) {
  await open({ staffId, company: "cstore", openingCount: 250, actorId: staffId }, now);
  return `CST-20260912-${staffId}`;
}

describe("close", () => {
  it("vape, credit + debit: the session, the sales row, the attendance and the audit rows change together", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    const r = await rpc(rpcCloseShift, ME, [{ sessionId: "VAP-20260912-S_003", cashSales: 150, creditCardSales: 210.1, debitCardSales: 99.9, cashbackPaid: 5, miscCashSales: 10, miscCreditSales: 2, miscDebitSales: 3, miscNotes: "bag", physicalCount: 214.5, closingNote: "fine" }], CLOSE_AT);
    // expected = 60 + 150 + 10 − 5 = 215; variance −0.50
    expect(r).toEqual({ sessionId: "VAP-20260912-S_003", expectedCash: 215, counted: 214.5, variance: -0.5, cashRemoved: 154.5, floatLeft: 60, varianceStatus: "OK", lottoReserveCounted: null, lottoReserveShort: 0 });
    expect(await sessRow("VAP-20260912-S_003")).toMatchObject({ status: "closed", end_time: CLOSE_AT, closing_cash_counted: 214.5, cash_left_in_till: 60, cash_removed_at_close: 154.5, expected_cash: 215, closing_variance: -0.5, variance_status: "OK", notes: "fine", lotto_reserve_counted: null });
    expect(await salesRow("VAP-20260912-S_003")).toMatchObject({ sales_id: "VAP-20260912-S_003", date: DAY, cash_sales: 150, credit_card_sales: 210.1, debit_card_sales: 99.9, cashback_paid: 5, misc_cash_sales: 10, misc_credit_sales: 2, misc_debit_sales: 3, misc_notes: "bag", card_total_sales: null, misc_card_sales: null });
    expect(await attRow("A_20260912_S_003")).toMatchObject({ status: "worked", actual_end: CLOSE_AT, hours_worked: 8, rate_at_attendance: 18.25, modified_by: "S_003" });
    const a = await audits();
    expect(a.map((x) => x.action)).toEqual(expect.arrayContaining(["sales.create", "till.close", "notify.shift.closed", "attendance.complete"]));
    expect(JSON.parse(a.find((x) => x.action === "till.close").after)).toEqual({ physicalCount: 214.5, expectedCash: 215, variance: -0.5, varianceStatus: "OK", reserveFedToTill: null, lottoReserveCounted: null, lottoTopupFromTill: null, lottoReserveNote: "" });
    expect(a.find((x) => x.action === "notify.shift.closed").details).toBe("🔴 Cleo Marsh closed vape shift, -$0.50 short, $154.50 in hand");
    expect(JSON.parse(a.find((x) => x.action === "attendance.complete").after)).toEqual({ status: "worked", hoursWorked: 8, rate: 18.25 });
  });

  it("cstore, one card total: credit and debit are blank, the lotto pair is written", async () => {
    await seedReserve(500);
    const id = await openCstore();
    const r = await rpc(rpcCloseShift, ME, [{ sessionId: id, cashSales: 450, cardTotalSales: 380, cashbackPaid: 0, miscCashSales: 0, miscCardSales: 12, miscNotes: "", physicalCount: 700, lottoCounted: null, lottoTopupFromTill: 0, lottoNote: "" }], CLOSE_AT);
    expect(r).toMatchObject({ expectedCash: 700, variance: 0, cashRemoved: 450, lottoReserveCounted: 500, lottoReserveShort: 0 });
    expect(await salesRow(id)).toMatchObject({ card_total_sales: 380, misc_card_sales: 12, credit_card_sales: null, debit_card_sales: null, misc_credit_sales: null, misc_debit_sales: null });
    expect(await sessRow(id)).toMatchObject({ lotto_reserve_counted: 500, lotto_topup_from_till: 0, lotto_reserve_note: null });
  });

  it("blank is not zero across the hop: nothing card-shaped sent is a split with zeros; a card total of 0 is a single-total row; '' is not sent", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    await rpc(rpcCloseShift, ME, [{ sessionId: "VAP-20260912-S_003", physicalCount: 60 }], CLOSE_AT);
    expect(await salesRow("VAP-20260912-S_003")).toMatchObject({ credit_card_sales: 0, debit_card_sales: 0, misc_credit_sales: 0, misc_debit_sales: 0, card_total_sales: null, misc_card_sales: null, cash_sales: 0, hst_collected: 0 });

    await open({ staffId: "S_005", company: "vape", openingCount: 60, actorId: "S_005" }, new Date("2026-09-12T21:30:00Z"));
    await rpc(rpcCloseShift, session("S_005", "employee"), [{ sessionId: "VAP-20260912-S_005", cashSales: 0, cardTotalSales: 0, miscCardSales: 0, physicalCount: 60, lottoCounted: 0 }], new Date("2026-09-12T23:00:00Z"));
    expect(await salesRow("VAP-20260912-S_005")).toMatchObject({ credit_card_sales: null, debit_card_sales: null, card_total_sales: 0, misc_card_sales: 0 });

    await open({ staffId: "S_002", company: "vape", openingCount: 60, actorId: "S_002" }, new Date("2026-09-12T23:10:00Z"));
    await rpc(rpcCloseShift, MANAGER, [{ sessionId: "VAP-20260912-S_002", cashSales: 100, cardTotalSales: "", physicalCount: 160 }], new Date("2026-09-12T23:50:00Z"));
    expect(await salesRow("VAP-20260912-S_002")).toMatchObject({ card_total_sales: null, credit_card_sales: 0 }); // an emptied card field is not sent
  });

  it("hstCollected, bottleDeposit and roundOff are not forwarded by rpcCloseShift (stored 0), but the module stores them", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    await rpc(rpcCloseShift, ME, [{ sessionId: "VAP-20260912-S_003", hstCollected: 5, bottleDeposit: 1, roundOff: 0.02, physicalCount: 60 }], CLOSE_AT);
    expect(await salesRow("VAP-20260912-S_003")).toMatchObject({ hst_collected: 0, bottle_deposit: 0, round_off: 0 });
    await open({ staffId: "S_005", company: "vape", openingCount: 60, actorId: "S_005" }, CLOSE_AT);
    await close({ sessionId: "VAP-20260912-S_005", actorId: "S_005", hstCollected: 1.005, bottleDeposit: 1, roundOff: -0.02, physicalCount: 60 }, new Date("2026-09-12T22:00:00Z"));
    expect(await salesRow("VAP-20260912-S_005")).toMatchObject({ hst_collected: 1, bottle_deposit: 1, round_off: -0.02 });
  });

  it("sub-cent figures are rounded in code (roundMoney), where the database would round half away from zero", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    await close({ sessionId: "VAP-20260912-S_003", actorId: "S_003", cashSales: 1.005, physicalCount: 61 });
    expect(await salesRow("VAP-20260912-S_003")).toMatchObject({ cash_sales: 1 });
    expect(await sessRow("VAP-20260912-S_003")).toMatchObject({ closing_cash_counted: 61, expected_cash: 61.01, closing_variance: -0.01 });
  });

  it("an unreadable physical count is refused with a plain message (the Sheet stored NaN and called it OK), and nothing is written", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    const before = await count("audit_log");
    await expect(rpc(rpcCloseShift, ME, [{ sessionId: "VAP-20260912-S_003", cashSales: 10 }], CLOSE_AT)).rejects.toThrow("physicalCount is not a number");
    await expect(rpc(rpcCloseShift, ME, [{ sessionId: "VAP-20260912-S_003", physicalCount: "abc" }], CLOSE_AT)).rejects.toThrow("physicalCount is not a number");
    expect((await sessRow("VAP-20260912-S_003")).status).toBe("open");
    expect(await salesRow("VAP-20260912-S_003")).toBeNull();
    expect(await count("audit_log")).toBe(before);
  });

  it("refuses a negative count, a missing session, a closed session, and both card shapes at once", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    await expect(close({ sessionId: "VAP-20260912-S_003", actorId: "S_003", physicalCount: -1 })).rejects.toThrow("physicalCount required (non-negative number)");
    await expect(close({ sessionId: "VAP-nope", actorId: "S_003", physicalCount: 1 })).rejects.toThrow("Session not found: VAP-nope");
    await expect(close({ sessionId: "VAP-20260912-S_003", actorId: "S_003", physicalCount: 1, creditCard: 1, cardTotal: 1 })).rejects.toThrow(
      "Close for vape sent both a credit/debit split and a single card total. Send one shape — check vape_card_split.",
    );
    expect(await salesRow("VAP-20260912-S_003")).toBeNull();
    await close({ sessionId: "VAP-20260912-S_003", actorId: "S_003", physicalCount: 60 });
    await expect(close({ sessionId: "VAP-20260912-S_003", actorId: "S_003", physicalCount: 60 })).rejects.toThrow("Session is not open (status: closed)");
    await expect(rpc(rpcCloseShift, ME, [], CLOSE_AT)).rejects.toThrow("Cannot read properties of undefined (reading 'sessionId')");
  });

  it("only the cashier who opened, or an admin or manager, closes; the actor is the session, never the payload", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    await expect(rpc(rpcCloseShift, session("S_005", "employee"), [{ sessionId: "VAP-20260912-S_003", physicalCount: 60 }], CLOSE_AT)).rejects.toThrow(
      "FORBIDDEN: only the cashier who opened, or an admin/manager, can close this shift",
    );
    await expect(close({ sessionId: "VAP-20260912-S_003", actorId: "S_005", physicalCount: 60 })).rejects.toThrow("Only S_003 or an admin/manager can close this session");
    await rpc(rpcCloseShift, MANAGER, [{ sessionId: "VAP-20260912-S_003", physicalCount: 60, actorId: "S_001", staffId: "S_001" }], CLOSE_AT);
    const a = await audits();
    expect(a.find((x) => x.action === "till.close").actor_id).toBe("S_002");
    expect(a.find((x) => x.action === "sales.create").actor_id).toBe("S_002");
    expect((await attRow("A_20260912_S_003")).modified_by).toBe("S_002");
  });

  it("the reply is flat JSON with no Date, and survives a round trip unchanged", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    const r = await rpc(rpcCloseShift, ME, [{ sessionId: "VAP-20260912-S_003", cashSales: 1, physicalCount: 50 }], CLOSE_AT);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    for (const v of Object.values(r)) expect(typeof v !== "object" || v === null).toBe(true);
    expect(r.session).toBeUndefined();
  });

  it("variance bands: |v| ≤ ok is OK, ≤ minor is minor, beyond is investigate; a 0 threshold falls back to its default", async () => {
    const status = async (v: number, rows: Record<string, string> = CONFIG) => {
      await setConfig(rows);
      return withTransaction(db, async (tx) => ts.getVarianceStatus(await loadConfig(tx), v));
    };
    expect(await status(1)).toBe("OK");
    expect(await status(-1)).toBe("OK");
    expect(await status(1.01)).toBe("minor");
    expect(await status(-30)).toBe("minor");
    expect(await status(30.01)).toBe("investigate");
    expect(await status(5, { variance_ok_threshold: "5", variance_minor_threshold: "10" })).toBe("OK");
    expect(await status(10.01, { variance_ok_threshold: "5", variance_minor_threshold: "10" })).toBe("investigate");
    expect(await status(1.5, { variance_ok_threshold: "0", variance_minor_threshold: "0" })).toBe("minor");
  });

  it("two tills at once: the first close leaves the day in progress; the last completes it, first open to last close", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    const id = await openCstore("S_003", new Date("2026-09-12T13:30:00Z"));
    await close({ sessionId: "VAP-20260912-S_003", actorId: "S_003", physicalCount: 60 }, new Date("2026-09-12T18:00:00Z"));
    expect((await attRow("A_20260912_S_003")).status).toBe("in_progress");
    await close({ sessionId: id, actorId: "S_003", physicalCount: 250, lottoCounted: 500 }, new Date("2026-09-12T22:15:00Z"));
    expect(await attRow("A_20260912_S_003")).toMatchObject({ status: "worked", hours_worked: 9.25, actual_end: new Date("2026-09-12T22:15:00Z") });
  });

  it("a refusal from Attendance.complete does not fail the close (as before); the day stays in progress", async () => {
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ('A_20260912_S_005','S_005','2026-09-12','in_progress')");
    await owner.query("insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time, opening_float) values ('VAP-20260912-S_005','A_20260912_S_005','S_005','vape','2026-09-12','open', null, 60)");
    const r = await close({ sessionId: "VAP-20260912-S_005", actorId: "S_005", physicalCount: 60 });
    expect(r.variance).toBe(0);
    expect((await sessRow("VAP-20260912-S_005")).status).toBe("closed");
    expect((await attRow("A_20260912_S_005")).status).toBe("in_progress"); // "Cannot compute hours: missing till_session start/end times", swallowed
  });

  it("the close is one unit: a database failure in it keeps nothing (session, sales row, attendance, audit)", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    // A sales row that already holds this session's id as its own key, under another session: the insert fails.
    await open({ staffId: "S_005", company: "cstore", openingCount: 250, actorId: "S_005" });
    await owner.query("insert into ops.sales (sales_id, session_id, staff_id, company, date) values ('VAP-20260912-S_003', 'CST-20260912-S_005', 'S_005', 'cstore', '2026-09-12')");
    const before = await count("audit_log");
    await expect(close({ sessionId: "VAP-20260912-S_003", actorId: "S_003", physicalCount: 60 })).rejects.toThrow();
    expect((await sessRow("VAP-20260912-S_003")).status).toBe("open");
    expect((await attRow("A_20260912_S_003")).status).toBe("in_progress");
    expect(await count("audit_log")).toBe(before);
  });

  it("two closes of one session at once: the row lock makes the second wait and then find it closed", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    const other = await connect(testDb.appUrl);
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const first = withTransaction(db, async (tx) => {
        const out = await ts.close(tx, { sessionId: "VAP-20260912-S_003", actorId: "S_003", physicalCount: 60 }, await deps(tx, CLOSE_AT));
        await gate;
        return out;
      });
      await new Promise((r) => setTimeout(r, 100));
      const second = withTransaction(other, async (tx) => ts.close(tx, { sessionId: "VAP-20260912-S_003", actorId: "S_003", physicalCount: 70 }, await deps(tx, CLOSE_AT)));
      await new Promise((r) => setTimeout(r, 100));
      release();
      await expect(first).resolves.toMatchObject({ counted: 60 });
      await expect(second).rejects.toThrow("Session is not open (status: closed)");
      expect(await count("sales")).toBe(1);
    } finally {
      await other.close();
    }
  });
});

// ── lotto-payout.js, assertion for assertion ───────────────

describe("lotto payout and reserve (lotto-payout)", () => {
  async function runShift(o: { cashSales: number; count: number; lottoCounted?: number | null; topup?: number; note?: string; company?: string; staff?: string; float?: number }) {
    const staffId = o.staff ?? "S_003";
    const company = o.company ?? "cstore";
    if (company === "vape") await setConfig({ ...CONFIG, vape_default_opening_float: "60" });
    const s = await open({ staffId, company, openingCount: o.float ?? (company === "cstore" ? 250 : 60), actorId: staffId });
    return close({
      sessionId: s?.sessionId,
      actorId: staffId,
      creditCard: 0,
      debitCard: 0,
      miscCash: 0,
      miscCredit: 0,
      miscDebit: 0,
      lottoNote: o.note === undefined ? "payout" : o.note,
      cashSales: o.cashSales,
      physicalCount: o.count,
      lottoCounted: o.lottoCounted,
      lottoTopupFromTill: o.topup || 0,
    });
  }

  it("a payout larger than the drawer, funded by the reserve", async () => {
    await seedReserve(500);
    const r = await runShift({ cashSales: -300, count: 0, lottoCounted: 450 });
    expect(r.expectedCash).toBe(0);
    expect(r.variance).toBe(0);
    expect(r.reserveFedToTill).toBe(50);
  });
  it("same shift, float restored instead: both conventions reconcile", async () => {
    await seedReserve(500);
    const r = await runShift({ cashSales: -300, count: 250, lottoCounted: 200 });
    expect(r.reserveFedToTill).toBe(300);
    expect(r.expectedCash).toBe(250);
    expect(r.variance).toBe(0);
  });
  it("which pot paid the customer cancels out", async () => {
    await seedReserve(500);
    const r = await runShift({ cashSales: -300, count: 450, lottoCounted: 0 });
    expect(r.reserveFedToTill).toBe(500);
    expect(r.expectedCash).toBe(450);
    expect(r.variance).toBe(0);
  });
  it("a real shortfall on top of a payout still surfaces", async () => {
    await seedReserve(500);
    const r = await runShift({ cashSales: -300, count: 200, lottoCounted: 200 });
    expect(r.reserveFedToTill).toBe(300);
    expect(r.expectedCash).toBe(250);
    expect(r.variance).toBe(-50);
    expect(r.varianceStatus).not.toBe("OK");
  });
  it("a previous top-up is already inside the stored count", async () => {
    await seedReserve(425, 160);
    const r = await runShift({ cashSales: 200, count: 450, lottoCounted: 425, note: "topped up last shift" });
    expect(r.reserveFedToTill).toBe(0);
    expect(r.expectedCash).toBe(450);
    expect(r.variance).toBe(0);
    expect(r.varianceStatus).toBe("OK");
  });
  it("a genuine draw from a topped-up pot still reads correctly", async () => {
    await seedReserve(425, 160);
    const r = await runShift({ cashSales: -100, count: 250, lottoCounted: 325 });
    expect(r.reserveFedToTill).toBe(100);
    expect(r.expectedCash).toBe(250);
    expect(r.variance).toBe(0);
  });
  it("the close sheet pre-fills from the closing balance", async () => {
    await seedReserve(425, 160);
    const log = await withTransaction(db, async (tx) => ts.getLottoLog(tx, 30, await deps(tx, OPEN_AT)));
    expect(log.lastCounted).toBe(425);
    expect((log as Record<string, unknown>)["lastOpening"]).toBeUndefined();
    expect(log).toMatchObject({ enabled: true, expected: 500, lastCountedDate: "2026-09-10", diagnostic: null });
    expect(log.entries).toEqual([{ sessionId: "CST-20260910-S_005", date: "2026-09-10", staffId: "S_005", counted: 425, shortfall: 75, topup: 160, note: "seed" }]);
  });
  it("negative cash sales only where a pot can fund it: vape refuses, and no sales row is written", async () => {
    await seedReserve(500);
    await expect(runShift({ company: "vape", staff: "S_005", float: 60, cashSales: -50, count: 10 })).rejects.toThrow("cannot be negative");
    expect(await count("sales")).toBe(0);
  });
  it("an impossible expected cash is rejected, and no sales row is written", async () => {
    await seedReserve(500);
    await expect(runShift({ cashSales: -900, count: 0, lottoCounted: 500 })).rejects.toThrow("exceed");
    expect(await count("sales")).toBe(0);
  });
  it("no previous reserve count: no crash, nothing fed", async () => {
    const r = await runShift({ cashSales: 200, count: 450, lottoCounted: 500, note: "" });
    expect(r.reserveFedToTill).toBe(0);
    expect(r.expectedCash).toBe(450);
  });
  it("a drawer below float owes nobody anything", async () => {
    await seedReserve(500);
    const r = await runShift({ cashSales: -300, count: 0, lottoCounted: 450 });
    expect(r.session?.cashRemovedAtClose).toBe(-250);
    expect((r.session?.cashRemovedAtClose as number) < 0).toBe(true);
  });
  it("a pot off its expected balance needs a reason; a top-up comes off the cash banked, not off expected cash", async () => {
    await seedReserve(500);
    await expect(runShift({ cashSales: 100, count: 350, lottoCounted: 400, note: "" })).rejects.toThrow("Lotto reserve counted 400, expected 500. Please provide a reason.");
    const r = await close({ sessionId: "CST-20260912-S_003", actorId: "S_003", cashSales: 100, physicalCount: 450, lottoCounted: 500, lottoTopupFromTill: 60 }); // the session the refused close left open
    expect(r).toMatchObject({ expectedCash: 350, variance: 100, cashRemoved: 140, lottoTopupFromTill: 60, lottoReserveCounted: 500, lottoReserveShort: 0 });
  });
  it("with no count ever, the log says so and explains what it found", async () => {
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ('A_20260911_S_005','S_005','2026-09-11','worked')");
    await owner.query("insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, end_time) values ('CST-20260911-S_005','A_20260911_S_005','S_005','cstore','2026-09-11','closed','2026-09-11T20:00:00Z')");
    const log = await withTransaction(db, async (tx) => ts.getLottoLog(tx, undefined, await deps(tx, OPEN_AT)));
    expect(log).toMatchObject({ lastCounted: null, lastCountedDate: null, entries: [] });
    expect(log.diagnostic).toEqual({ sessions: 1, cstore: 1, closed: 1, withCount: 0, newestSession: "CST-20260911-S_005", newestCell: "blank (string)" });
  });
});

// ── Readers other modules call ─────────────────────────────

describe("readers", () => {
  it("by id, by attendance day, the open sessions of a person, the open session of a till, a date range", async () => {
    await seedReserve(500);
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    await openCstore("S_003", new Date("2026-09-12T13:05:00Z"));
    expect((await ts.getById(db, "VAP-20260912-S_003"))?.status).toBe("open");
    expect(await ts.getById(db, 42)).toBeNull();
    expect((await ts.getForAttendance(db, "A_20260912_S_003")).map((s) => s.sessionId)).toEqual(["VAP-20260912-S_003", "CST-20260912-S_003"]);
    expect((await ts.getOpenForStaff(db, "S_003")).length).toBe(2);
    expect((await ts.getOpenForCompany(db, "cstore"))?.sessionId).toBe("CST-20260912-S_003");
    expect((await ts.getForDateRange(db, "2026-09-10", "2026-09-12", "cstore")).map((s) => s.sessionId)).toEqual(["CST-20260910-S_005", "CST-20260912-S_003"]);
    expect((await ts.getForDateRange(db, "2026-09-11", "2026-09-12")).length).toBe(2);
    expect(await ts.lastReserveCount(db)).toEqual({ counted: 500, date: "2026-09-10" });
    const rec = await ts.getById(db, "VAP-20260912-S_003");
    expect(rec).toMatchObject({ date: DAY, startTime: OPEN_AT, endTime: null, closingCashCounted: 0, lottoReserveCounted: null, lottoTopupFromTill: 0, varianceStatus: "", notes: "" });
  });
});

// ── The admin edit ─────────────────────────────────────────

describe("edit", () => {
  it("an admin corrects the count; expected, variance and cash removed are recomputed (without the pot's feed, as before)", async () => {
    await open({ staffId: "S_003", company: "vape", openingCount: 60, actorId: "S_003" });
    await close({ sessionId: "VAP-20260912-S_003", actorId: "S_003", cashSales: 100, physicalCount: 160 });
    await expect(withTransaction(db, async (tx) => ts.edit(tx, { sessionId: "VAP-20260912-S_003", actorId: "S_003", closingCashCounted: 150 }, await deps(tx, CLOSE_AT)))).rejects.toThrow("Only admin/manager can edit closed sessions");
    const r = await withTransaction(db, async (tx) => ts.edit(tx, { sessionId: "VAP-20260912-S_003", actorId: "S_001", closingCashCounted: 120, notes: "recount" }, await deps(tx, CLOSE_AT)));
    expect(r).toMatchObject({ closingCashCounted: 120, expectedCash: 160, closingVariance: -40, varianceStatus: "investigate", cashRemovedAtClose: 60, notes: "recount" });
    const a = (await audits()).find((x) => x.action === "till.edit");
    expect(JSON.parse(a.before)).toEqual({ openingFloat: 60, closingCashCounted: 160, notes: "" });
    expect(JSON.parse(a.after)).toEqual({ closingCashCounted: 120, notes: "recount" });
  });
});

// ── rpcNotifyShiftOpen ─────────────────────────────────────

describe("rpcNotifyShiftOpen", () => {
  const WA = { notifier_enabled: "TRUE", whatsapp_api_url: "https://graph.facebook.com/v21.0/100000000000001/messages", whatsapp_target_number: "14165550100,14165550101", whatsapp_template_shift_open: "shift_open" };
  const ENV = { WHATSAPP_API_TOKEN: "test-token-shifts" };
  const replies = (...r: Array<{ status: number; body: unknown }>) => {
    const sent: Array<{ url: string; body: any }> = [];
    const f = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      const next = r.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status });
    }) as unknown as typeof fetch;
    return { f, sent };
  };
  const NOW = new Date("2026-11-21T14:05:00Z"); // Saturday 09:05 Toronto

  it("sends the template with name, till and Toronto time; a success leaves no audit row", async () => {
    await setConfig({ ...CONFIG, ...WA });
    const { f, sent } = replies({ status: 200, body: {} }, { status: 200, body: {} });
    const r = await rpc(rpcNotifyShiftOpen, ME, ["vape"], NOW, { env: ENV, fetch: f });
    expect(r).toEqual({ sent: true, sentCount: 2, total: 2, results: [{ to: "14165550100", sent: true }, { to: "14165550101", sent: true }] });
    expect(sent[0]?.body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(["Cleo Marsh", "Vape", "Sat 21 Nov, 09:05"]);
    expect(await count("audit_log")).toBe(0);
  });
  it("a refusal from Meta is returned and audited as notify.shift_open_failed", async () => {
    await setConfig({ ...CONFIG, ...WA });
    const err = { status: 400, body: { error: { message: "(#133010) Account not registered" } } };
    const { f } = replies(err, err);
    const r = await rpc(rpcNotifyShiftOpen, ME, ["cstore"], NOW, { env: ENV, fetch: f });
    expect(r.sent).toBe(false);
    expect(await audits()).toEqual([
      {
        actor_id: "S_003",
        action: "notify.shift_open_failed",
        target_type: "notification",
        target_id: "Cstore",
        before: null,
        after: null,
        details: "WhatsApp shift-open NOT sent — 14165550100 http_400: (#133010) Account not registered; 14165550101 http_400: (#133010) Account not registered",
      },
    ]);
  });
  it("switched off: not sent, not audited; no token: not configured, audited", async () => {
    await setConfig({ ...CONFIG, ...WA, notifier_enabled: "false" });
    expect(await rpc(rpcNotifyShiftOpen, ME, ["vape"], NOW, { env: ENV })).toEqual({ sent: false, reason: "disabled" });
    expect(await count("audit_log")).toBe(0);
    await setConfig({ ...CONFIG, ...WA });
    expect(await rpc(rpcNotifyShiftOpen, ME, [undefined], NOW, { env: {} })).toEqual({ sent: false, reason: "not_configured" });
    expect((await audits())[0]).toMatchObject({ action: "notify.shift_open_failed", target_id: null, details: "WhatsApp shift-open NOT sent — not_configured" });
  });
});
