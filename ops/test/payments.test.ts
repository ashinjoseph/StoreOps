// The Payments module and its seven RPCs, against a real database with invented people.
//
// The parity cases (ops/parity/cases/payments.ts) compare the fixture's shapes with the old app.
// What the fixture lacks is covered here: shifts whose pay needs rounding (one a database would
// round the other way), blank hours and rates, a deduction, a scheduled-vs-actual difference (the
// old guard never sees it), the void (rows kept, every read leaves them out, the app cannot delete),
// two payments to one person at once, and an employee asking for someone else's figures. Expected
// values are what src/Payments.gs, Attendance.getUnpaidForStaff and the rpc* functions in
// src/WebApp.gs return and store.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction, type Tx } from "../src/db/tx";
import { Config } from "../src/lib/config";
import * as attendance from "../src/modules/attendance";
import * as payments from "../src/modules/payments";
import { rpcGetMyOwedSummary, rpcGetOwedSummary, rpcGetPaymentHistory, rpcGetPayrollOverview, rpcPayBonus, rpcPayShifts, rpcUndoPayment } from "../src/rpc/handlers/payments";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
// The app role cannot delete money or audit rows (by design), so the rows are reset as the owner.
let owner: Db & { close(): Promise<void> };

// Toronto is UTC-4 in June: 11:00 local is 15:00Z.
const NOW = new Date("2026-06-10T15:00:00Z");
const LATER = new Date("2026-06-10T15:05:00Z");

const STAFF: Array<[string, string, number | null, boolean, string]> = [
  ["S_001", "Ada Quill", 0, true, "admin"],
  ["S_002", "Bram Hale", 19.5, true, "manager"],
  ["S_003", "Cleo Marsh", 17.6, true, "employee"],
  ["S_004", "Dara Vance", 17.2, false, "employee"],
  ["S_005", "Eli Stone", 16.125, true, "employee"],
  ["S_006", "Fen Ward", 21.5, true, "payroll_admin"],
];

type Att = { id: string; staff: string; date: string; hours: number | null; rate: number | null; status: string; ss?: string; se?: string; as?: string; ae?: string; basis?: string | null };
const ATT: Att[] = [
  // S_003: four worked days, oldest first by date (inserted out of order on purpose).
  { id: "A_20260603_S_003", staff: "S_003", date: "2026-06-03", hours: 9.88, rate: 17.6, status: "worked" }, // 173.888 -> 173.89
  { id: "A_20260601_S_003", staff: "S_003", date: "2026-06-01", hours: 7.12, rate: 17.6, status: "worked" }, // 125.312 -> 125.31
  { id: "A_20260602_S_003", staff: "S_003", date: "2026-06-02", hours: 7.37, rate: 17.6, status: "worked", ss: "09:00", se: "17:00", as: "2026-06-02T13:00:00Z", ae: "2026-06-02T20:22:00Z", basis: null }, // 129.712 -> 129.71; scheduled 8 h, actual 7.37 h
  { id: "A_20260604_S_003", staff: "S_003", date: "2026-06-04", hours: 8, rate: 17.6, status: "worked" }, // 140.80
  // Not owed: a blank rate, blank hours, cancelled, scheduled, in progress.
  { id: "A_20260605_S_003", staff: "S_003", date: "2026-06-05", hours: 8, rate: null, status: "worked" },
  { id: "A_20260606_S_003", staff: "S_003", date: "2026-06-06", hours: null, rate: 17.6, status: "worked" },
  { id: "A_20260607_S_003", staff: "S_003", date: "2026-06-07", hours: 8, rate: 17.6, status: "cancelled" },
  { id: "A_20260608_S_003", staff: "S_003", date: "2026-06-08", hours: 0, rate: 0, status: "scheduled" },
  { id: "A_20260610_S_003", staff: "S_003", date: "2026-06-10", hours: null, rate: 17.6, status: "in_progress" },
  // S_005: 1.16 h x 16.125 = 18.705, which floating point makes 18.70499999… and rounds to 18.70, where a database says 18.71.
  { id: "A_20260601_S_005", staff: "S_005", date: "2026-06-01", hours: 1.16, rate: 16.125, status: "worked" },
  { id: "A_20260602_S_005", staff: "S_005", date: "2026-06-02", hours: 4, rate: 16.125, status: "worked" }, // 64.50
];
const S3_OWED = 569.71; // 125.31 + 129.71 + 173.89 + 140.80
const S5_OWED = 83.2; // 18.70 + 64.50

type Bonus = { id: string; staff: string; date: string; amount: number; status: string; type?: string; reason?: string | null; company?: string | null; at: string };
const BONUSES: Bonus[] = [
  { id: "B_PEND", staff: "S_003", date: "2026-06-08", amount: 52.32, status: "pending", reason: "Weekly commission", company: "cstore", at: "2026-06-08T13:00:00Z" },
  { id: "B_OLD", staff: "S_003", date: "2026-06-01", amount: 10, status: "pending", reason: null, company: null, at: "2026-06-01T13:00:00Z" },
  { id: "B_PROP", staff: "S_003", date: "2026-06-09", amount: 30, status: "proposed", reason: "Proposed", company: "vape", at: "2026-06-09T13:00:00Z" },
  { id: "B_PAID", staff: "S_003", date: "2026-05-20", amount: 20, status: "paid", type: "tip", reason: "Tips", at: "2026-05-20T13:00:00Z" },
  { id: "B_DED", staff: "S_003", date: "2026-06-05", amount: -12.4, status: "pending", type: "deduction", reason: "Till shortage", at: "2026-06-05T13:00:00Z" },
  { id: "B_FEE", staff: "S_002", date: "2026-06-08", amount: 120, status: "pending", reason: "Management fee", company: "cstore", at: "2026-06-08T13:00:00Z" },
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
  for (const t of ["audit_log", "payment_items", "payments", "bonuses", "attendance", "staff"]) await owner.query(`delete from ops.${t}`);
  for (const s of STAFF) await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role) values ($1,$2,$3,$4,$5)", s);
  for (const a of ATT) {
    await owner.query(
      `insert into ops.attendance (attendance_id, staff_id, date, scheduled_start, scheduled_end, actual_start, actual_end, hours_worked, rate_at_attendance, status, created_at, hours_basis)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [a.id, a.staff, a.date, a.ss ?? null, a.se ?? null, a.as ?? null, a.ae ?? null, a.hours, a.rate, a.status, `${a.date}T13:00:00Z`, a.basis ?? null],
    );
  }
  for (const b of BONUSES) {
    await owner.query("insert into ops.bonuses (bonus_id, staff_id, date, type, amount, reason, status, company, created_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,'S_001',$9)", [
      b.id,
      b.staff,
      b.date,
      b.type ?? "commission",
      b.amount,
      b.reason === undefined ? "r" : b.reason,
      b.status,
      b.company ?? null,
      b.at,
    ]);
  }
  // B_PAID was paid in full by an earlier payment.
  await owner.query("insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method, recorded_by) values ('P_20260520_120000_aaa','S_003','2026-05-20',20,'cash','S_001')");
  await owner.query("insert into ops.payment_items (item_id, payment_id, item_type, ref_id, amount) values ('IT_old','P_20260520_120000_aaa','bonus','B_PAID',20)");
});

const session = (staffId: string, role: Session["role"], name = "x"): Session => ({ staffId, name, role, companiesAuthorized: ["cstore"], expiresAt: 0 });
const ADMIN = session("S_001", "admin", "Ada Quill");
const PAYROLL = session("S_006", "payroll_admin", "Fen Ward");
const MANAGER = session("S_002", "manager", "Bram Hale");
const CLEO = session("S_003", "employee", "Cleo Marsh");

const deps = (now = NOW) => ({ config: Config.fromRows([]), env: {}, fetch, now });

function ctxOf(tx: Tx, who: Session | null, now = NOW): RpcContext {
  return { db: tx, session: who, config: () => Promise.resolve(Config.fromRows([])), env: {}, fetch, now };
}
async function rpc(handler: (ctx: RpcContext, ...a: unknown[]) => unknown, who: Session | null, args: unknown[], now = NOW): Promise<any> {
  return withTransaction(db, async (tx) => handler(ctxOf(tx, who, now), ...args));
}
const inTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withTransaction(db, fn);
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details from ops.audit_log order by seq`);
const owedOf = async (staffId: string) => payments.getOwedSummary(db, staffId);

/** A Db that counts its statements. */
function counting(inner: Db): Db & { count: number; texts: string[] } {
  const c = {
    count: 0,
    texts: [] as string[],
    query<T>(t: string, p?: readonly unknown[]) {
      c.count++;
      c.texts.push(t);
      return inner.query<T>(t, p);
    },
    one<T>(t: string, p?: readonly unknown[]) {
      c.count++;
      c.texts.push(t);
      return inner.one<T>(t, p);
    },
    maybeOne<T>(t: string, p?: readonly unknown[]) {
      c.count++;
      c.texts.push(t);
      return inner.maybeOne<T>(t, p);
    },
  };
  return c;
}

describe("what is owed", () => {
  it("getUnpaidForStaff: worked days only, oldest first, hours x rate rounded in code (18.705 is 18.70, as JavaScript rounds it)", async () => {
    const s3 = await payments.getUnpaidForStaff(db, "S_003");
    expect(s3.map((a) => [a.attendanceId, a.value, a.paid, a.remaining])).toEqual([
      ["A_20260601_S_003", 125.31, 0, 125.31],
      ["A_20260602_S_003", 129.71, 0, 129.71],
      ["A_20260603_S_003", 173.89, 0, 173.89],
      ["A_20260604_S_003", 140.8, 0, 140.8],
    ]);
    expect(s3[0]).toEqual({ attendanceId: "A_20260601_S_003", date: "2026-06-01", dateStr: "2026-06-01", staffId: "S_003", hoursWorked: 7.12, rateAtAttendance: 17.6, value: 125.31, paid: 0, remaining: 125.31 });
    expect((await payments.getUnpaidForStaff(db, "S_005")).map((a) => a.value)).toEqual([18.7, 64.5]);
    expect(await payments.getUnpaidForStaff(db, 3 as never)).toEqual([]);
  });

  it("a worked day with a blank rate or blank hours counts as 0 (the old `Number(x) || 0`) and is owed nothing", async () => {
    const ids = (await payments.getUnpaidForStaff(db, "S_003")).map((a) => a.attendanceId);
    expect(ids).not.toContain("A_20260605_S_003");
    expect(ids).not.toContain("A_20260606_S_003");
  });

  it("getOwedSummary: the old shape, totals rounded at each step, pending bonuses newest first, a deduction and a proposed one left out", async () => {
    const o = await owedOf("S_003");
    expect(o.staffId).toBe("S_003");
    expect(o.shiftsOwed).toBe(S3_OWED);
    expect(o.bonusesOwed).toBe(62.32);
    expect(o.totalOwed).toBe(632.03);
    expect(o.unpaidShifts[0]).toEqual({
      attendanceId: "A_20260601_S_003",
      date: "2026-06-01T04:00:00.000Z", // Toronto midnight, as the old Date cell's ISO string
      dateStr: "2026-06-01",
      hoursWorked: 7.12,
      rate: 17.6,
      value: 125.31,
      paid: 0,
      remaining: 125.31,
      scheduledHours: 0,
      actualHours: 0,
      hoursBasis: "",
      mismatch: false,
    });
    expect(o.pendingBonuses).toEqual([
      { bonusId: "B_PEND", type: "commission", amount: 52.32, paid: 0, remaining: 52.32, date: "2026-06-08T13:00:00.000Z", dateStr: "2026-06-08", reason: "Weekly commission", company: "cstore" },
      { bonusId: "B_OLD", type: "commission", amount: 10, paid: 0, remaining: 10, date: "2026-06-01T13:00:00.000Z", dateStr: "2026-06-01", reason: "", company: "" },
    ]);
  });

  it("the schedule-mismatch flag is never set (kept: the old code checked a record with no times), even for a day scheduled 8 h and worked 7.37 h", async () => {
    const o = await owedOf("S_003");
    const day = o.unpaidShifts.find((s) => s.attendanceId === "A_20260602_S_003");
    expect(attendance.scheduledHours({ scheduledStart: "09:00", scheduledEnd: "17:00" })).toBe(8); // the day's real figures differ
    expect(day).toMatchObject({ scheduledHours: 0, actualHours: 0, hoursBasis: "", mismatch: false });
    expect(o).toMatchObject({ mismatchCount: 0, hasMismatch: false });
  });

  it("an unknown id, the inactive person, an id that is not text: owed nothing; no id is refused", async () => {
    expect(await owedOf("S_999")).toEqual({ staffId: "S_999", shiftsOwed: 0, bonusesOwed: 0, totalOwed: 0, unpaidShifts: [], pendingBonuses: [], mismatchCount: 0, hasMismatch: false });
    expect((await owedOf("S_004")).totalOwed).toBe(0);
    expect((await payments.getOwedSummary(db, 3)).staffId).toBe(3);
    await expect(payments.getOwedSummary(db, "")).rejects.toThrow("staffId required");
    await expect(payments.getOwedSummary(db, undefined)).rejects.toThrow("staffId required");
  });

  it("getOwedSummaries: the same answer for everyone as one by one, in a fixed number of queries", async () => {
    const ids = STAFF.map((s) => s[0]);
    const one = counting(db);
    await payments.getOwedSummaries(one, ["S_003"]);
    const all = counting(db);
    const map = await payments.getOwedSummaries(all, ids);
    expect(all.count).toBe(one.count);
    expect(all.count).toBeLessThanOrEqual(4);
    for (const id of ids) expect(map.get(id)).toEqual(await owedOf(id));
  });
});

describe("payShifts", () => {
  const pay = (amount: unknown, extra: Record<string, unknown> = {}, now = NOW) => inTx((tx) => payments.payShifts(tx, { staffId: "S_003", amount, method: "cash", notes: "", actorId: "S_001", ...extra }, deps(now)));

  it("walks oldest first, fills each day, part-pays the last, and writes one payment, its items in one statement, and the old audit rows", async () => {
    const c = counting(db);
    const out = await withTransaction(c, (tx) => payments.payShifts(tx, { staffId: "S_003", amount: 300, method: "bank", notes: "June", actorId: "S_001" }, deps()));
    expect(out.itemsCreated.map((i) => [i.attendanceId, i.amount, i.isPartial])).toEqual([
      ["A_20260601_S_003", 125.31, false],
      ["A_20260602_S_003", 129.71, false],
      ["A_20260603_S_003", 44.98, true],
    ]);
    expect(out.summary).toEqual({ shiftsOwedBefore: S3_OWED, shiftsOwedAfter: 269.71, fullyPaidCount: 2, partialCount: 1 });
    expect(out.paymentId).toMatch(/^P_20260610_110000_[0-9a-z]{1,3}$/);
    for (const i of out.itemsCreated) expect(i.itemId).toMatch(/^IT_20260610_110000_[0-9a-z]{1,10}$/);
    expect(c.texts.filter((t) => t.includes("insert into ops.payment_items"))).toHaveLength(1);

    expect(await db.one<any>("select staff_id, paid_on, total_amount, method, recorded_by, notes, voided_at, voided_by, void_reason from ops.payments where payment_id = $1", [out.paymentId])).toEqual({
      staff_id: "S_003",
      paid_on: "2026-06-10",
      total_amount: 300,
      method: "bank",
      recorded_by: "S_001",
      notes: "June",
      voided_at: null,
      voided_by: null,
      void_reason: null,
    });
    const items = await db.query<any>("select item_type, ref_id, amount, notes from ops.payment_items where payment_id = $1 order by ref_id", [out.paymentId]);
    expect(items).toEqual([
      { item_type: "shift", ref_id: "A_20260601_S_003", amount: 125.31, notes: null },
      { item_type: "shift", ref_id: "A_20260602_S_003", amount: 129.71, notes: null },
      { item_type: "shift", ref_id: "A_20260603_S_003", amount: 44.98, notes: "Partial — $44.98 of $173.89" },
    ]);
    expect(await audits()).toEqual(expect.arrayContaining([
      {
        actor_id: "S_001",
        action: "payment.shifts",
        target_type: "payments",
        target_id: out.paymentId,
        before: null,
        after: JSON.stringify({ staffId: "S_003", amount: 300, itemCount: 3, attendanceIds: ["A_20260601_S_003", "A_20260602_S_003", "A_20260603_S_003"] }),
        details: null,
      },
      { actor_id: "SYSTEM", action: "notify.payment.recorded", target_type: "notification", target_id: null, before: null, after: null, details: "💰 Paid $300.00 to Cleo Marsh" },
    ]));
    expect(await audits()).toHaveLength(2);
    // The remainder is on the next payment.
    const next = await pay(200, {}, LATER);
    expect(next.itemsCreated.map((i) => [i.attendanceId, i.amount, i.isPartial])).toEqual([
      ["A_20260603_S_003", 128.91, false],
      ["A_20260604_S_003", 71.09, true],
    ]);
  });

  it("the full amount clears every day; a cent pays a cent; an amount is rounded in code first (1.005 is 1)", async () => {
    expect((await pay(S3_OWED)).summary.shiftsOwedAfter).toBe(0);
    expect((await owedOf("S_003")).shiftsOwed).toBe(0);
    await owner.query("delete from ops.payment_items where payment_id <> 'P_20260520_120000_aaa'");
    await owner.query("delete from ops.payments where payment_id <> 'P_20260520_120000_aaa'");
    expect((await pay(0.01)).itemsCreated).toEqual([expect.objectContaining({ amount: 0.01, isPartial: true })]);
    const r = await pay(1.005, {}, LATER);
    expect(r.totalAmount).toBe(1);
    expect(r.itemsCreated[0]?.amount).toBe(1);
  });

  it("refuses with the old messages, in the old order, and writes nothing", async () => {
    const refused = async (patch: Record<string, unknown>, message: string) => {
      await expect(inTx((tx) => payments.payShifts(tx, { staffId: "S_003", amount: 10, actorId: "S_001", ...patch }, deps()))).rejects.toThrow(message);
    };
    await refused({ staffId: "" }, "staffId required");
    await refused({ amount: 0 }, "amount must be a positive number");
    await refused({ amount: -1 }, "amount must be a positive number");
    await refused({ amount: "10" }, "amount must be a positive number");
    await refused({ actorId: "" }, "actorId required");
    await refused({ staffId: "S_999" }, "Staff not found: S_999");
    await refused({ staffId: 3 }, "Staff not found: 3");
    await refused({ staffId: "S_006" }, "No unpaid shifts for Fen Ward. Nothing to pay.");
    await refused({ staffId: "S_002" }, "No unpaid shifts for Bram Hale. Nothing to pay.");
    await refused({ amount: 569.72 }, "Overpayment rejected: trying to pay $569.72 but only $569.71 owed in unpaid shifts for Cleo Marsh. To pay a bonus ($62.32 pending), use the bonus flow.");
    await refused({ staffId: "S_005", amount: 200 }, "Overpayment rejected: trying to pay $200.00 but only $83.20 owed in unpaid shifts for Eli Stone. ");
    await refused({ method: "Cash" }, "Invalid payment method: Cash");
    await refused({ method: "crypto", amount: 10000 }, "Overpayment rejected"); // the method is checked after the amounts
    expect(await db.one<any>("select count(*)::int as n from ops.payments")).toEqual({ n: 1 });
    expect(await audits()).toEqual([]);
  });

  it("a blank method is cash; each of the four is accepted", async () => {
    let at = NOW.getTime();
    for (const method of ["", undefined, "cash", "bank", "etransfer", "other"]) {
      at += 1000;
      const out = await pay(1, { method }, new Date(at));
      expect((await db.one<any>("select method from ops.payments where payment_id = $1", [out.paymentId])).method).toBe(method || "cash");
    }
  });

  it("an amount that is not a number, or under half a cent, records a $0.00 payment with no items (kept from the old code)", async () => {
    for (const [amount, now] of [
      [Number.NaN, NOW],
      [0.004, LATER],
    ] as const) {
      const out = await pay(amount, {}, now);
      expect(out).toMatchObject({ totalAmount: 0, itemsCreated: [], summary: { shiftsOwedBefore: S3_OWED, shiftsOwedAfter: S3_OWED, fullyPaidCount: 0, partialCount: 0 } });
      expect((await db.one<any>("select total_amount from ops.payments where payment_id = $1", [out.paymentId])).total_amount).toBe(0);
    }
  });

  it("S_005: pay of a day a database would price a cent higher is what JavaScript priced it", async () => {
    const out = await inTx((tx) => payments.payShifts(tx, { staffId: "S_005", amount: 18.7, actorId: "S_006" }, deps()));
    expect(out.itemsCreated).toEqual([expect.objectContaining({ attendanceId: "A_20260601_S_005", amount: 18.7, isPartial: false })]);
    expect((await owedOf("S_005")).shiftsOwed).toBe(64.5);
  });
});

describe("payBonus", () => {
  const payB = (bonusId: unknown, amount: unknown, now = NOW, extra: Record<string, unknown> = {}) => inTx((tx) => payments.payBonus(tx, { bonusId, amount, actorId: "S_001", ...extra }, deps(now)));
  const status = async (id: string) => (await db.one<{ status: string }>("select status from ops.bonuses where bonus_id = $1", [id])).status;

  it("in full: one payment, one item, the bonus becomes paid; audit rows bonus.paid, payment.bonus and the notification", async () => {
    const out = await payB("B_PEND", 52.32);
    expect(out).toEqual({ paymentId: out.paymentId, bonusId: "B_PEND", amount: 52.32, isPartial: false, newBonusStatus: "paid", kind: "bonus" });
    expect(await status("B_PEND")).toBe("paid");
    expect(await db.one<any>("select notes, method from ops.payments where payment_id = $1", [out.paymentId])).toEqual({ notes: "Bonus: Weekly commission", method: "cash" });
    expect(await db.query<any>("select item_type, ref_id, amount, notes from ops.payment_items where payment_id = $1", [out.paymentId])).toEqual([{ item_type: "bonus", ref_id: "B_PEND", amount: 52.32, notes: null }]);
    expect((await audits()).map((a) => a.action).sort()).toEqual(["bonus.paid", "notify.payment.recorded", "payment.bonus"]);
    expect((await audits()).find((a) => a.action === "payment.bonus").after).toBe(JSON.stringify({ staffId: "S_003", bonusId: "B_PEND", amount: 52.32, bonusType: "commission", fullyPaid: true }));
  });

  it("in two parts: the first stays pending with a 'Partial' note, the second makes it paid; more than is left is refused", async () => {
    const first = await payB("B_PEND", 20);
    expect(first).toMatchObject({ isPartial: true, newBonusStatus: "pending" });
    expect((await db.one<any>("select notes from ops.payment_items where payment_id = $1", [first.paymentId])).notes).toBe("Partial — $20.00 of $52.32");
    await expect(payB("B_PEND", 32.33, LATER)).rejects.toThrow("Overpayment rejected: trying to pay $32.33 but only $32.32 remaining on this bonus.");
    expect(await payB("B_PEND", 32.32, LATER)).toMatchObject({ isPartial: false, newBonusStatus: "paid" });
    expect((await owedOf("S_003")).pendingBonuses.map((b) => b.bonusId)).toEqual(["B_OLD"]);
  });

  it("refuses a proposed, paid, cancelled or unknown bonus and a deduction, with the old messages", async () => {
    await owner.query("update ops.bonuses set status = 'cancelled' where bonus_id = 'B_OLD'");
    await expect(payB("B_PROP", 30)).rejects.toThrow("Bonus is not pending (status=proposed). Approve it first.");
    await expect(payB("B_PAID", 20)).rejects.toThrow("Bonus is not pending (status=paid). Already paid.");
    await expect(payB("B_OLD", 10)).rejects.toThrow("Bonus is not pending (status=cancelled). Cannot pay a cancelled bonus.");
    await expect(payB("B_NOPE", 10)).rejects.toThrow("Bonus not found: B_NOPE");
    await expect(payB(7, 10)).rejects.toThrow("Bonus not found: 7");
    await expect(payB("B_DED", 12.4)).rejects.toThrow("Bonus already fully paid");
    await expect(payB("", 10)).rejects.toThrow("bonusId required");
    await expect(payB("B_PEND", 0)).rejects.toThrow("amount must be a positive number");
    await expect(payB("B_PEND", 1, NOW, { method: "cheque" })).rejects.toThrow("Invalid payment method: cheque");
    expect(await audits()).toEqual([]);
  });
});

describe("undo is a void", () => {
  const pay = (amount: number, now = NOW, staffId = "S_003") => inTx((tx) => payments.payShifts(tx, { staffId, amount, actorId: "S_001" }, deps(now)));
  const undo = (id: unknown, now = LATER, reason?: unknown) => inTx((tx) => payments.undo(tx, id, "S_006", { now }, reason));

  it("keeps the payment and its items, marks who, when and why, and owed goes back to exactly what it was, shift by shift", async () => {
    const before = await owedOf("S_003");
    const out = await pay(300.5);
    expect((await owedOf("S_003")).shiftsOwed).toBe(269.21);
    expect(await undo(out.paymentId, LATER, "Paid twice")).toEqual({ success: true, removedPaymentId: out.paymentId, removedItemCount: 3 });
    expect(await owedOf("S_003")).toEqual(before);
    expect(await db.one<any>("select voided_at, voided_by, void_reason from ops.payments where payment_id = $1", [out.paymentId])).toEqual({ voided_at: LATER, voided_by: "S_006", void_reason: "Paid twice" });
    expect((await db.one<any>("select count(*)::int as n from ops.payment_items where payment_id = $1", [out.paymentId])).n).toBe(3);
    const undoAudit = (await audits()).find((a) => a.action === "payment.undo");
    expect(undoAudit).toEqual({ actor_id: "S_006", action: "payment.undo", target_type: "payments", target_id: out.paymentId, before: JSON.stringify({ staffId: "S_003", amount: 300.5, itemCount: 3 }), after: null, details: null });
  });

  it("every read leaves a voided payment out: by id, its items, the person's list, the recent list, paid amounts, the history", async () => {
    const out = await pay(125.31);
    await undo(out.paymentId);
    expect(await payments.getPaymentById(db, out.paymentId)).toBeNull();
    expect(await payments.getItemsForPayment(db, out.paymentId)).toEqual([]);
    expect((await payments.getPaymentsForStaff(db, "S_003")).map((p) => p.paymentId)).toEqual(["P_20260520_120000_aaa"]);
    expect((await payments.getRecent(db)).map((p) => p.paymentId)).toEqual(["P_20260520_120000_aaa"]);
    expect((await payments.getAllItems(db)).map((i) => i.itemId)).toEqual(["IT_old"]);
    expect(await payments.getAttendancePaidAmounts(db, ["A_20260601_S_003"])).toEqual({});
    expect(await attendance.paidAmount(db, "A_20260601_S_003")).toBe(0);
    expect((await rpc(rpcGetPaymentHistory, ADMIN, [])).map((p: any) => p.paymentId)).toEqual(["P_20260520_120000_aaa"]);
    // The day can be cancelled again, as after the old delete.
    await expect(inTx((tx) => attendance.cancel(tx, "A_20260601_S_003", "S_002", "x", LATER))).resolves.toMatchObject({ status: "cancelled" });
  });

  it("a voided id is not found, to a second undo and to everything else", async () => {
    const out = await pay(10);
    await undo(out.paymentId);
    await expect(undo(out.paymentId)).rejects.toThrow("Payment not found: " + out.paymentId);
    await expect(undo("P_NOPE")).rejects.toThrow("Payment not found: P_NOPE");
    await expect(undo(7)).rejects.toThrow("Payment not found: 7");
    await expect(undo("")).rejects.toThrow("paymentId required");
  });

  it("a bonus payment: the bonus is pending again (audit rows bonus.reverted and payment.undo); a part payment leaves it alone", async () => {
    const full = await inTx((tx) => payments.payBonus(tx, { bonusId: "B_PEND", amount: 52.32, actorId: "S_001" }, deps()));
    await undo(full.paymentId);
    expect((await db.one<any>("select status from ops.bonuses where bonus_id = 'B_PEND'")).status).toBe("pending");
    expect((await audits()).filter((a) => a.action === "bonus.reverted" || a.action === "payment.undo").map((a) => a.target_id).sort()).toEqual(["B_PEND", full.paymentId].sort());
    const part = await inTx((tx) => payments.payBonus(tx, { bonusId: "B_PEND", amount: 20, actorId: "S_001" }, deps(LATER)));
    await undo(part.paymentId, new Date(LATER.getTime() + 1000));
    expect((await audits()).filter((a) => a.action === "bonus.reverted")).toHaveLength(1);
    expect((await owedOf("S_003")).pendingBonuses[0]).toMatchObject({ bonusId: "B_PEND", paid: 0, remaining: 52.32 });
  });

  it("undoLastForStaff undoes the newest payment that stands", async () => {
    const a = await pay(10, NOW);
    const b = await pay(20, LATER);
    const later = new Date(LATER.getTime() + 60_000);
    expect((await inTx((tx) => payments.undoLastForStaff(tx, "S_003", "S_001", { now: later }))).removedPaymentId).toBe(b.paymentId);
    expect((await inTx((tx) => payments.undoLastForStaff(tx, "S_003", "S_001", { now: later }))).removedPaymentId).toBe(a.paymentId);
    await expect(inTx((tx) => payments.undoLastForStaff(tx, "S_005", "S_001", { now: later }))).rejects.toThrow("No payments to undo for S_005");
  });

  it("the app cannot delete a payment or an item (so a void is the only undo), and a void needs both who and when", async () => {
    await expect(db.query("delete from ops.payments where payment_id = 'P_20260520_120000_aaa'")).rejects.toMatchObject({ kind: "permission" });
    await expect(db.query("delete from ops.payment_items where item_id = 'IT_old'")).rejects.toMatchObject({ kind: "permission" });
    await expect(owner.query("update ops.payments set voided_at = now() where payment_id = 'P_20260520_120000_aaa'")).rejects.toMatchObject({ kind: "check" });
    await expect(owner.query("update ops.payments set voided_by = 'S_001' where payment_id = 'P_20260520_120000_aaa'")).rejects.toMatchObject({ kind: "check" });
  });
});

describe("two payments to one person at once", () => {
  it("the second waits for the first (the staff row is locked before anything is read), then sees its items", async () => {
    const a = await connect(testDb.appUrl);
    const b = await connect(testDb.appUrl);
    try {
      let release!: () => void;
      let paid!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      const didPay = new Promise<void>((r) => (paid = r));
      const first = withTransaction(a, async (tx) => {
        const out = await payments.payShifts(tx, { staffId: "S_003", amount: 400, actorId: "S_001" }, deps());
        paid();
        await hold;
        return out;
      });
      await didPay;
      let settled = false;
      const second = withTransaction(b, (tx) => payments.payShifts(tx, { staffId: "S_003", amount: 300, actorId: "S_006" }, deps(LATER))).finally(() => (settled = true));
      second.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // waiting on the staff row
      release();
      await first;
      await expect(second).rejects.toThrow("Overpayment rejected: trying to pay $300.00 but only $169.71 owed");
      const third = await withTransaction(b, (tx) => payments.payShifts(tx, { staffId: "S_003", amount: 169.71, actorId: "S_006" }, deps(LATER)));
      expect(third.itemsCreated.map((i) => i.attendanceId)).toEqual(["A_20260603_S_003", "A_20260604_S_003"]);
      // No day was paid more than it is worth.
      const over = await db.query("select ref_id from ops.payment_items i join ops.attendance a on a.attendance_id = i.ref_id group by ref_id, a.hours_worked, a.rate_at_attendance having sum(i.amount) > round(a.hours_worked * a.rate_at_attendance, 2)");
      expect(over).toEqual([]);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("the RPCs", () => {
  it("rpcGetMyOwedSummary: an employee gets their own figures whatever they pass, with their rate", async () => {
    const out = await rpc(rpcGetMyOwedSummary, CLEO, ["S_005"]);
    expect(out).toMatchObject({ staffId: "S_003", staffName: "Cleo Marsh", hourlyRate: 17.6, shiftsOwed: S3_OWED, bonusesOwed: 62.32, totalOwed: 632.03 });
    expect(Object.keys(out)).toEqual(["staffId", "staffName", "hourlyRate", "shiftsOwed", "bonusesOwed", "totalOwed", "unpaidShifts", "pendingBonuses"]);
    expect((await rpc(rpcGetMyOwedSummary, MANAGER, [])).totalOwed).toBe(120);
  });

  it("rpcGetPaymentHistory: an employee sees only their own payments, whatever they pass; a manager sees everyone's; the limit is the old one", async () => {
    await inTx((tx) => payments.payShifts(tx, { staffId: "S_005", amount: 10, actorId: "S_001" }, deps()));
    await inTx((tx) => payments.payShifts(tx, { staffId: "S_003", amount: 10, actorId: "S_001" }, deps(LATER)));
    const eli = session("S_005", "employee", "Eli Stone");
    expect((await rpc(rpcGetPaymentHistory, eli, [25, "S_003"])).map((p: any) => [p.staffId, p.staffName])).toEqual([["S_005", "Eli Stone"]]);
    const all = await rpc(rpcGetPaymentHistory, MANAGER, []);
    expect(all.map((p: any) => p.staffId)).toEqual(["S_003", "S_005", "S_003"]);
    expect(all[0]).toMatchObject({ paidOn: "2026-06-10T15:05:00.000Z", totalAmount: 10, method: "cash", recordedBy: "S_001", notes: "", staffName: "Cleo Marsh" });
    expect(all[2]).toMatchObject({ paymentId: "P_20260520_120000_aaa", paidOn: "2026-05-20T16:00:00.000Z", items: [{ itemId: "IT_old", paymentId: "P_20260520_120000_aaa", itemType: "bonus", refId: "B_PAID", amount: 20, notes: "" }] });
    expect(await rpc(rpcGetPaymentHistory, ADMIN, [1])).toHaveLength(1);
    expect(await rpc(rpcGetPaymentHistory, ADMIN, [-1])).toHaveLength(2); // slice(0, -1)
    expect(await rpc(rpcGetPaymentHistory, ADMIN, ["abc"])).toHaveLength(3);
  });

  it("history: two payments in one second are in the order they were written (the old sort was stable)", async () => {
    const x = await inTx((tx) => payments.payShifts(tx, { staffId: "S_005", amount: 1, actorId: "S_001" }, deps()));
    const y = await inTx((tx) => payments.payShifts(tx, { staffId: "S_003", amount: 1, actorId: "S_001" }, deps()));
    expect((await payments.getRecent(db)).map((p) => p.paymentId).slice(0, 2)).toEqual([x.paymentId, y.paymentId]);
  });

  it("instantOf: the id's stamp when it is on the stored day, else Toronto midnight", () => {
    expect(payments.instantOf({ paymentId: "P_20260610_110000_abc", paidOn: "2026-06-10" })?.toISOString()).toBe("2026-06-10T15:00:00.000Z");
    expect(payments.instantOf({ paymentId: "P_20260610_110000_abc", paidOn: "2026-06-09" })?.toISOString()).toBe("2026-06-09T04:00:00.000Z");
    expect(payments.instantOf({ paymentId: "LEGACY_1", paidOn: "2026-01-15" })?.toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  it("rpcPayShifts reads the page's input as the old RPC did: Number(amount), a missing input fails as the property read did, the session is the actor", async () => {
    const out = await rpc(rpcPayShifts, PAYROLL, [{ staffId: "S_003", amount: "125.31", actorId: "S_003" }]);
    expect(out.itemsCreated).toEqual([{ itemId: expect.any(String), attendanceId: "A_20260601_S_003", dateStr: "2026-06-01", amount: 125.31, isPartial: false }]);
    expect((await db.one<any>("select recorded_by from ops.payments where payment_id = $1", [out.paymentId])).recorded_by).toBe("S_006");
    await expect(rpc(rpcPayShifts, ADMIN, [])).rejects.toThrow("Cannot read properties of undefined (reading 'staffId')");
    await expect(rpc(rpcPayShifts, ADMIN, [{ staffId: "S_003", amount: "" }])).rejects.toThrow("amount must be a positive number");
  });

  it("rpcPayBonus, rpcUndoPayment, rpcGetOwedSummary, rpcGetPayrollOverview", async () => {
    const paid = await rpc(rpcPayBonus, ADMIN, [{ bonusId: "B_FEE", amount: 120 }]);
    expect(paid).toMatchObject({ bonusId: "B_FEE", amount: 120, isPartial: false, newBonusStatus: "paid", kind: "bonus" });
    expect(await rpc(rpcUndoPayment, ADMIN, [paid.paymentId], LATER)).toEqual({ success: true, removedPaymentId: paid.paymentId, removedItemCount: 1 });
    expect((await db.one<any>("select void_reason from ops.payments where payment_id = $1", [paid.paymentId])).void_reason).toBeNull();
    expect(await rpc(rpcGetOwedSummary, ADMIN, ["S_002"])).toMatchObject({ staffId: "S_002", shiftsOwed: 0, bonusesOwed: 120, totalOwed: 120 });
    await expect(rpc(rpcGetOwedSummary, ADMIN, [])).rejects.toThrow(/^staffId required$/); // the router adds "rpcGetOwedSummary: "
    const overview = await rpc(rpcGetPayrollOverview, PAYROLL, []);
    expect(overview.map((o: any) => o.staffId)).toEqual(["S_001", "S_002", "S_003", "S_005", "S_006"]); // active only
    expect(overview[2]).toEqual({ staffId: "S_003", staffName: "Cleo Marsh", hourlyRate: 17.6, shiftsOwed: S3_OWED, bonusesOwed: 62.32, totalOwed: 632.03, unpaidShiftCount: 4, pendingBonusCount: 2, hasMismatch: false, mismatchCount: 0 });
    expect(overview[3]).toMatchObject({ staffId: "S_005", hourlyRate: 16.125, shiftsOwed: S5_OWED });
  });

  it("no session is refused by every handler", async () => {
    for (const h of [rpcGetPayrollOverview, rpcGetOwedSummary, rpcGetMyOwedSummary, rpcPayShifts, rpcPayBonus, rpcUndoPayment, rpcGetPaymentHistory]) {
      await expect(rpc(h, null, [{}])).rejects.toThrow(/^NOT_LOGGED_IN$/);
    }
  });
});
