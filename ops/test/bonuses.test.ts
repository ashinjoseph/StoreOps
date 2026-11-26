// The Bonuses module and its four RPCs, against a real database with invented people.
//
// The parity cases (ops/parity/cases/bonuses.ts) compare the fixture's shapes with the old app.
// What the fixture lacks is covered here: a cancelled bonus with a note, a blank-everything bonus,
// proposals made by the engine's own path (propose, with a run written after them), the
// existsCommissionFor questions the commission-fixed suite asks (a fee and a sales commission do
// not block each other; a legacy row with no rule still blocks), the status moves Payments will
// make (markPaid, revertToPending), and two admins acting on one bonus at once. Expected values are
// what src/Bonuses.gs and the rpc* functions in src/WebApp.gs return and store.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { parseDate } from "../src/lib/dates";
import * as bonuses from "../src/modules/bonuses";
import { rpcApproveBonus, rpcCancelBonus, rpcCreateBonus, rpcGetProposedBonuses } from "../src/rpc/handlers/bonuses";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
// The app role cannot delete money or audit rows (by design), so the fixture rows are reset as the owner.
let owner: Db & { close(): Promise<void> };

// Toronto is UTC-4 in June (summer time): 09:00 local is 13:00Z.
const NOW = new Date("2026-06-10T15:00:00Z");
const LATER = new Date("2026-06-10T16:30:00Z");

const STAFF: Array<[string, string, boolean, string]> = [
  ["S_001", "Ada Quill", true, "admin"],
  ["S_002", "Bram Hale", true, "manager"],
  ["S_003", "Cleo Marsh", true, "employee"],
  ["S_004", "Dara Vance", false, "employee"],
  ["S_005", "  Eli Stone  ", true, "employee"],
];

type Row = {
  id: string;
  staff: string;
  date: string;
  type?: string;
  amount: number;
  reason?: string | null;
  status: string;
  ps?: string | null;
  pe?: string | null;
  company?: string | null;
  run?: string | null;
  rule?: string | null;
  by?: string | null;
  at?: string | null;
  notes?: string | null;
};

const ROWS: Row[] = [
  // The engine's proposals for the week of 1 June, in the order it writes them (rules, then people), all in one instant.
  { id: "B_P1", staff: "S_003", date: "2026-06-08", type: "commission", amount: 40, reason: "Weekly commission: cstore", status: "proposed", ps: "2026-06-01", pe: "2026-06-07", company: "cstore", run: "CRN_1", rule: "CR_1", by: "SYSTEM_TRIGGER", at: "2026-06-08T09:00:00Z" },
  { id: "B_P2", staff: "S_005", date: "2026-06-08", type: "commission", amount: 12.5, reason: "Weekly commission: cstore", status: "proposed", ps: "2026-06-01", pe: "2026-06-07", company: "cstore", run: "CRN_1", rule: "CR_1", by: "SYSTEM_TRIGGER", at: "2026-06-08T09:00:00Z" },
  { id: "B_P3", staff: "S_003", date: "2026-06-08", type: "commission", amount: 3, reason: "Weekly commission: vape", status: "proposed", ps: "2026-06-01", pe: "2026-06-07", company: "vape", run: "CRN_1", rule: "CR_2", by: "SYSTEM_TRIGGER", at: "2026-06-08T09:00:00Z" },
  { id: "B_P4", staff: "S_002", date: "2026-06-08", type: "commission", amount: 120, reason: "Weekly fixed amount: fee", status: "proposed", ps: "2026-06-01", pe: "2026-06-07", company: "cstore", run: "CRN_1", rule: "CR_3", by: "SYSTEM_TRIGGER", at: "2026-06-08T09:00:00Z" },
  // An older proposal, made earlier: it comes first.
  { id: "B_P0", staff: "S_005", date: "2026-06-01", type: "commission", amount: 7.25, reason: "Older", status: "proposed", ps: "2026-05-25", pe: "2026-05-31", company: "vape", run: "CRN_0", rule: "CR_2", by: "SYSTEM_TRIGGER", at: "2026-06-01T09:00:00Z" },
  // Pending, paid, cancelled with a note; and one with everything optional blank.
  { id: "B_PEND", staff: "S_003", date: "2026-05-30", type: "bonus", amount: 50, reason: "Holiday", status: "pending", company: "vape", by: "S_001", at: "2026-05-30T14:00:00Z", notes: "Original note" },
  { id: "B_PAID", staff: "S_003", date: "2026-05-20", type: "tip", amount: 20, reason: "Tips", status: "paid", by: "S_001", at: "2026-05-20T14:00:00Z" },
  { id: "B_CANC", staff: "S_005", date: "2026-05-10", type: "deduction", amount: -15, reason: "Shortage", status: "cancelled", by: "S_001", at: "2026-05-10T14:00:00Z", notes: "Cancelled: wrong person" },
  { id: "B_BLANK", staff: "S_002", date: "2026-05-01", type: "adjustment", amount: 5, reason: null, status: "pending", ps: null, pe: null, company: null, run: null, rule: null, by: null, at: null, notes: null },
  // A legacy commission with no rule id, for a week of its own.
  { id: "B_LEG", staff: "S_005", date: "2026-05-26", type: "commission", amount: 9, reason: "Legacy", status: "pending", ps: "2026-05-18", pe: "2026-05-24", company: "cstore", run: "CRN_0", rule: null, by: "SYSTEM_TRIGGER", at: "2026-05-26T09:00:00Z" },
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
  for (const t of ["audit_log", "bonuses", "commission_runs", "commission_rules", "staff"]) await owner.query(`delete from ops.${t}`);
  for (const s of STAFF) await owner.query("insert into ops.staff (staff_id, name, active, role) values ($1,$2,$3,$4)", s);
  for (const r of ["CRN_0", "CRN_1"]) await owner.query("insert into ops.commission_runs (run_id) values ($1)", [r]);
  for (const [id, company] of [["CR_1", "cstore"], ["CR_2", "vape"], ["CR_3", "cstore"]]) {
    await owner.query("insert into ops.commission_rules (rule_id, name, applies_to, company, active) values ($1,$2,'all_staff',$3,true)", [id, id, company]);
  }
  for (const r of ROWS) {
    await owner.query(
      `insert into ops.bonuses (bonus_id, staff_id, date, type, amount, reason, status, period_start, period_end, company,
                                source_run_id, created_by, created_at, notes, source_rule_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [r.id, r.staff, r.date, r.type ?? "bonus", r.amount, r.reason === undefined ? "r" : r.reason, r.status, r.ps ?? null, r.pe ?? null, r.company ?? null, r.run ?? null, r.by ?? null, r.at ?? null, r.notes ?? null, r.rule ?? null],
    );
  }
});

const session = (staffId: string, role: Session["role"]): Session => ({ staffId, name: "x", role, companiesAuthorized: ["cstore"], expiresAt: 0 });
const ADMIN = session("S_001", "admin");
const PAYROLL = session("S_006", "payroll_admin");

async function rpc(handler: (ctx: RpcContext, ...a: unknown[]) => unknown, who: Session | null, args: unknown[], now = NOW): Promise<any> {
  return withTransaction(db, async (tx) => handler({ db: tx, session: who, config: () => Promise.reject(new Error("no config")), env: {}, fetch, now }, ...args));
}
const inTx = <T>(fn: (tx: Parameters<Parameters<typeof withTransaction>[1]>[0]) => Promise<T>): Promise<T> => withTransaction(db, fn);
const row = (id: string) => db.one<any>("select * from ops.bonuses where bonus_id = $1", [id]);
const count = async () => (await db.one<{ n: number }>("select count(*)::int as n from ops.bonuses")).n;
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details, "timestamp" from ops.audit_log order by "timestamp", target_id, log_id`);

describe("reads", () => {
  it("getById returns the old record shape: trimmed text, blanks as '', dates as days", async () => {
    expect(await bonuses.getById(db, "B_PEND")).toEqual({
      bonusId: "B_PEND",
      staffId: "S_003",
      date: "2026-05-30",
      type: "bonus",
      amount: 50,
      reason: "Holiday",
      status: "pending",
      periodStart: null,
      periodEnd: null,
      company: "vape",
      sourceRunId: "",
      sourceRuleId: "",
      createdBy: "S_001",
      createdAt: new Date("2026-05-30T14:00:00Z"),
      notes: "Original note",
    });
  });
  it("a bonus with every optional column blank reads as '' text and null dates, never a 0 for a blank text (and an amount of 0 stays 0)", async () => {
    expect(await bonuses.getById(db, "B_BLANK")).toMatchObject({ reason: "", company: "", sourceRunId: "", sourceRuleId: "", createdBy: "", createdAt: null, notes: "", periodStart: null, periodEnd: null, amount: 5 });
  });
  it("getById is null for an unknown id and for something that is not an id", async () => {
    expect(await bonuses.getById(db, "B_NOPE")).toBeNull();
    expect(await bonuses.getById(db, 7 as never)).toBeNull();
    expect(await bonuses.getById(db, " B_PEND ")).toBeNull();
  });
  it("getAll lists every bonus in the order the rows were created, then the engine's order (rule, person) within one instant", async () => {
    const ids = (await bonuses.getAll(db)).map((b) => b.bonusId);
    expect(ids).toHaveLength(ROWS.length);
    expect(ids.indexOf("B_P0")).toBeLessThan(ids.indexOf("B_P1"));
    expect(ids.filter((i) => /^B_P[1-4]$/.test(i))).toEqual(["B_P1", "B_P2", "B_P3", "B_P4"]);
  });
  it("getProposed is only proposed ones, oldest first", async () => {
    expect((await bonuses.getProposed(db)).map((b) => b.bonusId)).toEqual(["B_P0", "B_P1", "B_P2", "B_P3", "B_P4"]);
  });
  it("getForStaff is one person's, newest first, optionally of one status; a non-string gives nothing", async () => {
    expect((await bonuses.getForStaff(db, "S_003")).map((b) => b.bonusId)).toEqual(["B_P1", "B_P3", "B_PEND", "B_PAID"]);
    expect((await bonuses.getForStaff(db, "S_003", "pending")).map((b) => b.bonusId)).toEqual(["B_PEND"]);
    expect(await bonuses.getForStaff(db, "S_004")).toEqual([]);
    expect(await bonuses.getForStaff(db, undefined as never)).toEqual([]);
  });
});

describe("rpcGetProposedBonuses", () => {
  it("answers the old shape: the person's name, instants for the dates, blanks as ''", async () => {
    const out = await rpc(rpcGetProposedBonuses, ADMIN, []);
    expect(out.map((b: any) => b.bonusId)).toEqual(["B_P0", "B_P1", "B_P2", "B_P3", "B_P4"]);
    expect(out[1]).toEqual({
      bonusId: "B_P1",
      staffId: "S_003",
      staffName: "Cleo Marsh",
      type: "commission",
      amount: 40,
      reason: "Weekly commission: cstore",
      date: "2026-06-08T09:00:00.000Z", // the moment it was made: on the stored day (Toronto), so kept
      status: "proposed",
      periodStart: "2026-06-01T04:00:00.000Z", // Toronto midnight
      periodEnd: "2026-06-08T03:59:59.000Z", // 23:59:59 Toronto of the stored day
      company: "cstore",
      sourceRunId: "CRN_1",
      notes: "",
    });
    expect(out[2].staffName).toBe("Eli Stone"); // trimmed
  });
  it("a date typed by an admin (made on another day) is Toronto midnight of that day", () => {
    expect(bonuses.instantsOf({ date: "2026-05-20", createdAt: new Date("2026-06-10T15:00:00Z"), periodStart: null, periodEnd: null })).toEqual({ date: "2026-05-20T04:00:00.000Z", periodStart: null, periodEnd: null });
  });
  it("a person who is not on the staff list shows as their id", async () => {
    await owner.query("update ops.staff set name = '' where staff_id = 'S_002'");
    const out = await rpc(rpcGetProposedBonuses, ADMIN, []);
    expect(out.find((b: any) => b.bonusId === "B_P4").staffName).toBe("S_002");
  });
  it("no session is a failure; the handler adds no prefix (the router does, for the nine old RPCs that had one)", async () => {
    await expect(rpc(rpcGetProposedBonuses, null, [])).rejects.toThrow(/^NOT_LOGGED_IN$/);
  });
  it("reads only: nothing is written", async () => {
    await rpc(rpcGetProposedBonuses, PAYROLL, []);
    expect(await audits()).toEqual([]);
  });
});

describe("rpcCreateBonus", () => {
  it("one pending row with blanks as NULL, who and when from the session and the clock; the answer has null for every date", async () => {
    const out = await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "incentive", amount: 15.25, reason: "Upsell", date: "2026-06-05", actorId: "S_002", createdBy: "S_002", status: "paid" }]);
    expect(out).toMatchObject({
      staffId: "S_003",
      date: null, // a Date in the old app: the page has always received null
      type: "incentive",
      amount: 15.25,
      reason: "Upsell",
      status: "pending",
      periodStart: null,
      periodEnd: null,
      company: "",
      sourceRunId: "",
      sourceRuleId: "",
      createdBy: "S_001",
      createdAt: null,
      notes: "",
    });
    expect(out.bonusId).toMatch(/^B_20260610_110000_[0-9a-z]{1,10}$/); // Toronto time
    expect(await row(out.bonusId)).toMatchObject({
      date: "2026-06-05",
      amount: 15.25,
      status: "pending",
      period_start: null,
      period_end: null,
      company: null,
      source_run_id: null,
      source_rule_id: null,
      notes: null,
      created_by: "S_001",
      created_at: NOW,
    });
  });
  it("writes one audit row: bonus.created, the amount as rounded, the reason cut at 100 characters", async () => {
    const out = await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "bonus", amount: 10.005, reason: "x".repeat(150) }]);
    expect(await audits()).toEqual([
      {
        actor_id: "S_001",
        action: "bonus.created",
        target_type: "bonuses",
        target_id: out.bonusId,
        before: null,
        after: JSON.stringify({ staffId: "S_003", type: "bonus", amount: 10.01, status: "pending", reason: "x".repeat(100) }),
        details: null,
        timestamp: NOW,
      },
    ]);
  });
  it("rounds to cents the way the old code did: 10.005 is 10.01, a tenth of a cent is 0", async () => {
    expect((await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "bonus", amount: 10.005, reason: "r" }])).amount).toBe(10.01);
    // 1.005 and 1.255 are just under their cent in floating point: the old code stores 1 and 1.25 where a database would round the text to 1.01 and 1.26.
    expect((await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "bonus", amount: 1.005, reason: "r" }])).amount).toBe(1);
    expect((await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "bonus", amount: 1.255, reason: "r" }])).amount).toBe(1.25);
    const tiny = await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "bonus", amount: 0.004, reason: "r" }]);
    expect(tiny.amount).toBe(0); // not "cannot be zero": that check is before rounding (kept)
    expect((await row(tiny.bonusId)).amount).toBe(0);
  });
  it("a negative amount is kept (a deduction); every type is accepted", async () => {
    for (const type of ["bonus", "commission", "incentive", "deduction", "tip", "adjustment"]) {
      const out = await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type, amount: -12.4, reason: "r" }]);
      expect(out).toMatchObject({ type, amount: -12.4, status: "pending" });
    }
  });
  it("an amount that is not a number is stored as 0 (kept: NaN passes both checks, then rounds to 0)", async () => {
    for (const amount of ["abc", undefined]) {
      const out = await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "bonus", amount, reason: "r" }]);
      expect(out.amount).toBe(0);
    }
  });
  it("zero is refused, whether 0, '0', '' or null (all read as 0)", async () => {
    for (const amount of [0, "0", "", null]) {
      await expect(rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "bonus", amount, reason: "r" }])).rejects.toThrow("amount cannot be zero");
    }
    expect(await count()).toBe(ROWS.length);
  });
  it("company and notes are kept, blank ones are NULL", async () => {
    const a = await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "bonus", amount: 5, reason: "r", company: "vape", notes: "Quarter end" }]);
    expect(a).toMatchObject({ company: "vape", notes: "Quarter end" });
    const b = await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "bonus", amount: 5, reason: "r", company: "", notes: "" }]);
    expect(await row(b.bonusId)).toMatchObject({ company: null, notes: null });
  });
  it("no date means the call's clock, as a day in Toronto (late evening stays on its own day)", async () => {
    const out = await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "bonus", amount: 5, reason: "r" }], new Date("2026-06-11T02:30:00Z")); // 22:30 on the 10th in Toronto
    expect((await row(out.bonusId)).date).toBe("2026-06-10");
  });
  it("refuses with the old messages, in the old order, and writes nothing", async () => {
    const ok = { staffId: "S_003", type: "bonus", amount: 5, reason: "r" };
    const refused = async (patch: object, message: string) => {
      await expect(rpc(rpcCreateBonus, ADMIN, [{ ...ok, ...patch }])).rejects.toThrow(message);
    };
    await refused({ staffId: "" }, "staffId required");
    await refused({ type: "" }, "type required");
    await refused({ type: "gift" }, "Invalid type: gift. Must be one of: bonus, commission, incentive, deduction, tip, adjustment");
    await refused({ reason: "" }, "reason required");
    await refused({ staffId: "S_999" }, "Staff not found: S_999");
    await refused({ staffId: " S_003 " }, "Staff not found:  S_003 ");
    expect(await count()).toBe(ROWS.length);
    expect(await audits()).toEqual([]);
  });
  it("the inactive person is accepted (the old code does not check)", async () => {
    expect(await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_004", type: "bonus", amount: 5, reason: "r" }])).toMatchObject({ staffId: "S_004" });
  });
  it("an input that is not an object fails as the old property read did, as a message for the person", async () => {
    await expect(rpc(rpcCreateBonus, ADMIN, [null])).rejects.toThrow("Cannot read properties of null (reading 'staffId')");
    await expect(rpc(rpcCreateBonus, ADMIN, [])).rejects.toThrow("Cannot read properties of undefined (reading 'staffId')");
  });
  it("two in one second get two rows with two ids", async () => {
    const a = await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "bonus", amount: 5, reason: "r" }]);
    const b = await rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "bonus", amount: 5, reason: "r" }]);
    expect(a.bonusId).not.toBe(b.bonusId);
    expect(await count()).toBe(ROWS.length + 2);
  });
  it("an unknown company is refused with a readable message before the insert (the Sheet took any text)", async () => {
    await expect(rpc(rpcCreateBonus, ADMIN, [{ staffId: "S_003", type: "bonus", amount: 5, reason: "r", company: "grocery" }])).rejects.toThrow("Invalid company: grocery");
    expect(await count()).toBe(ROWS.length);
  });
});

describe("propose (the commission engine)", () => {
  const input = (patch: object = {}) => ({
    staffId: "S_003",
    amount: 33.335,
    reason: "Weekly commission",
    periodStart: parseDate("2026-06-08"),
    periodEnd: new Date("2026-06-15T03:59:59Z"),
    company: "cstore",
    sourceRunId: "CRN_1",
    sourceRuleId: "CR_1",
    actorId: "SYSTEM_TRIGGER",
    ...patch,
  });
  it("writes a proposed commission dated now, with its run and rule, and audits bonus.proposed", async () => {
    const made = await inTx((tx) => bonuses.propose(tx, input(), NOW));
    expect(made).toMatchObject({
      staffId: "S_003",
      type: "commission",
      amount: 33.34,
      status: "proposed",
      date: "2026-06-10",
      periodStart: "2026-06-08",
      periodEnd: "2026-06-14", // 23:59:59 Toronto of Sunday
      company: "cstore",
      sourceRunId: "CRN_1",
      sourceRuleId: "CR_1",
      createdBy: "SYSTEM_TRIGGER",
      createdAt: NOW,
      notes: "",
    });
    expect(await audits()).toEqual([
      {
        actor_id: "SYSTEM_TRIGGER",
        action: "bonus.proposed",
        target_type: "bonuses",
        target_id: made.bonusId,
        before: null,
        after: JSON.stringify({ staffId: "S_003", type: "commission", amount: 33.34, status: "proposed", reason: "Weekly commission" }),
        details: null,
        timestamp: NOW,
      },
    ]);
  });
  it("a run and its bonuses are written bonuses first (the link to the run is checked at commit)", async () => {
    await inTx(async (tx) => {
      await bonuses.propose(tx, input({ sourceRunId: "CRN_NEW" }), NOW);
      await tx.query("insert into ops.commission_runs (run_id) values ('CRN_NEW')");
    });
    expect((await db.one<any>("select count(*)::int as n from ops.bonuses where source_run_id = 'CRN_NEW'")).n).toBe(1);
    await expect(inTx((tx) => bonuses.propose(tx, input({ sourceRunId: "CRN_NEVER" }), NOW))).rejects.toThrow();
  });
  it("many in one call get many ids", async () => {
    const made = await inTx(async (tx) => {
      const out = [];
      for (let i = 0; i < 25; i++) out.push(await bonuses.propose(tx, input({ amount: 1 + i }), NOW));
      return out;
    });
    expect(new Set(made.map((b) => b.bonusId)).size).toBe(25);
  });
  it("refuses with the old messages", async () => {
    const refused = (patch: object, message: string) => expect(inTx((tx) => bonuses.propose(tx, input(patch), NOW))).rejects.toThrow(message);
    await refused({ staffId: "" }, "staffId required");
    await refused({ amount: 0 }, "amount must be a positive number");
    await refused({ amount: -5 }, "amount must be a positive number");
    await refused({ amount: "5" }, "amount must be a positive number");
    await refused({ reason: "" }, "reason required");
    await refused({ periodStart: "2026-06-08" }, "periodStart Date required");
    await refused({ periodEnd: null }, "periodEnd Date required");
    await refused({ company: "grocery" }, "Invalid company: grocery");
    await refused({ company: "" }, "Invalid company: ");
    await refused({ actorId: "" }, "actorId required");
    expect(await count()).toBe(ROWS.length);
  });
});

describe("existsCommissionFor", () => {
  const week = (s: string, e: string) => [parseDate(s) as Date, new Date(parseDate(e)!.getTime() + 86_399_000)] as const;
  const ask = (staff: string, company: string, [s, e]: readonly [Date, Date], opts?: bonuses.ExistsOptions) => bonuses.existsCommissionFor(db, staff, company, s, e, opts);
  it("is yes for the same person, company and week; no for another person, company or week", async () => {
    const w = week("2026-06-01", "2026-06-07");
    expect(await ask("S_003", "cstore", w)).toBe(true);
    expect(await ask("S_003", "vape", w)).toBe(true);
    expect(await ask("S_005", "vape", w)).toBe(false);
    expect(await ask("S_003", "cstore", week("2026-06-08", "2026-06-14"))).toBe(false);
    expect(await ask("S_004", "cstore", w)).toBe(false);
  });
  it("a cancelled commission does not count; neither does a bonus of another type", async () => {
    await owner.query("update ops.bonuses set status = 'cancelled' where bonus_id = 'B_P1'");
    expect(await ask("S_003", "cstore", week("2026-06-01", "2026-06-07"))).toBe(false);
    await owner.query("update ops.bonuses set type = 'bonus' where bonus_id = 'B_P3'");
    expect(await ask("S_003", "vape", week("2026-06-01", "2026-06-07"))).toBe(false);
  });
  it("a period that is not two Dates is no", async () => {
    expect(await bonuses.existsCommissionFor(db, "S_003", "cstore", "2026-06-01", "2026-06-07")).toBe(false);
    expect(await bonuses.existsCommissionFor(db, "S_003", "cstore", null, null)).toBe(false);
  });
  it("sourceRuleId asks 'has THIS rule paid?': a fee and a sales commission do not block each other", async () => {
    const w = week("2026-06-01", "2026-06-07");
    expect(await ask("S_002", "cstore", w, { sourceRuleId: "CR_3" })).toBe(true); // the fee
    expect(await ask("S_002", "cstore", w, { sourceRuleId: "CR_1" })).toBe(false); // a sales rule has not paid S_002
    expect(await ask("S_003", "cstore", w, { sourceRuleId: "CR_1" })).toBe(true);
    expect(await ask("S_003", "cstore", w, { sourceRuleId: "CR_3" })).toBe(false);
  });
  it("blockingRuleIds counts only the listed rules, plus a legacy row with no rule", async () => {
    const w = week("2026-06-01", "2026-06-07");
    expect(await ask("S_002", "cstore", w, { blockingRuleIds: ["CR_1", "CR_2"] })).toBe(false); // only the fee exists; its rule is not listed (ended or deleted)
    expect(await ask("S_002", "cstore", w, { blockingRuleIds: ["CR_3"] })).toBe(true);
    expect(await ask("S_003", "cstore", w, { blockingRuleIds: [] })).toBe(false);
    const legacy = week("2026-05-18", "2026-05-24");
    expect(await ask("S_005", "cstore", legacy, { blockingRuleIds: [] })).toBe(true); // predates the column: still blocks
    expect(await ask("S_005", "cstore", legacy, { blockingRuleIds: ["CR_1"] })).toBe(true);
    expect(await ask("S_005", "cstore", legacy)).toBe(true);
  });
  it("sourceRuleId wins when both options are given", async () => {
    const w = week("2026-06-01", "2026-06-07");
    expect(await ask("S_003", "cstore", w, { sourceRuleId: "CR_3", blockingRuleIds: ["CR_1"] })).toBe(false);
  });
});

describe("rpcApproveBonus", () => {
  it("a proposed bonus becomes pending: only the status changes, one audit row says so, the answer has null dates", async () => {
    const before = await row("B_P1");
    const out = await rpc(rpcApproveBonus, PAYROLL, ["B_P1"]);
    expect(out).toEqual({
      bonusId: "B_P1",
      staffId: "S_003",
      date: null,
      type: "commission",
      amount: 40,
      reason: "Weekly commission: cstore",
      status: "pending",
      periodStart: null,
      periodEnd: null,
      company: "cstore",
      sourceRunId: "CRN_1",
      sourceRuleId: "CR_1",
      createdBy: "SYSTEM_TRIGGER",
      createdAt: null,
      notes: "",
    });
    expect(await row("B_P1")).toEqual({ ...before, status: "pending" });
    expect(await audits()).toEqual([
      { actor_id: "S_006", action: "bonus.approved", target_type: "bonuses", target_id: "B_P1", before: '{"status":"proposed"}', after: '{"status":"pending"}', details: null, timestamp: NOW },
    ]);
  });
  it("it then leaves the proposed list", async () => {
    await rpc(rpcApproveBonus, ADMIN, ["B_P1"]);
    expect((await rpc(rpcGetProposedBonuses, ADMIN, [])).map((b: any) => b.bonusId)).toEqual(["B_P0", "B_P2", "B_P3", "B_P4"]);
  });
  it("anything that is not proposed is refused with its status, and nothing is written", async () => {
    for (const [id, status] of [["B_PEND", "pending"], ["B_PAID", "paid"], ["B_CANC", "cancelled"]]) {
      const before = await row(id!);
      await expect(rpc(rpcApproveBonus, ADMIN, [id])).rejects.toThrow(`Can only approve proposed bonuses (current: ${status})`);
      expect(await row(id!)).toEqual(before);
    }
    expect(await audits()).toEqual([]);
  });
  it("approving twice: the second is refused as pending", async () => {
    await rpc(rpcApproveBonus, ADMIN, ["B_P1"]);
    await expect(rpc(rpcApproveBonus, ADMIN, ["B_P1"])).rejects.toThrow("Can only approve proposed bonuses (current: pending)");
    expect(await audits()).toHaveLength(1);
  });
  it("a missing or unknown id is refused, in the old order", async () => {
    await expect(rpc(rpcApproveBonus, ADMIN, [])).rejects.toThrow("bonusId required");
    await expect(rpc(rpcApproveBonus, ADMIN, [""])).rejects.toThrow("bonusId required");
    await expect(rpc(rpcApproveBonus, ADMIN, ["B_NOPE"])).rejects.toThrow("Bonus not found: B_NOPE");
    await expect(rpc(rpcApproveBonus, ADMIN, [12])).rejects.toThrow("Bonus not found: 12");
  });
});

describe("rpcCancelBonus", () => {
  it("cancels a proposed bonus, adds the reason to the notes, audits before and after", async () => {
    const out = await rpc(rpcCancelBonus, ADMIN, ["B_P1", "Rule was wrong"]);
    expect(out).toMatchObject({ bonusId: "B_P1", status: "cancelled", notes: "Cancelled: Rule was wrong", date: null, createdAt: null });
    expect((await row("B_P1")).notes).toBe("Cancelled: Rule was wrong");
    expect(await audits()).toEqual([
      {
        actor_id: "S_001",
        action: "bonus.cancelled",
        target_type: "bonuses",
        target_id: "B_P1",
        before: '{"status":"proposed"}',
        after: '{"status":"cancelled","reason":"Rule was wrong"}',
        details: null,
        timestamp: NOW,
      },
    ]);
  });
  it("a pending bonus keeps its earlier note, then ' | ', then the reason", async () => {
    await rpc(rpcCancelBonus, PAYROLL, ["B_PEND", "Left the company"]);
    expect(await row("B_PEND")).toMatchObject({ status: "cancelled", notes: "Original note | Cancelled: Left the company" });
  });
  it("no reason leaves the notes alone (blank stays NULL) and audits an empty reason", async () => {
    await rpc(rpcCancelBonus, ADMIN, ["B_P2"]);
    await rpc(rpcCancelBonus, ADMIN, ["B_P3", ""]);
    await rpc(rpcCancelBonus, ADMIN, ["B_BLANK", null]);
    expect(await row("B_P2")).toMatchObject({ status: "cancelled", notes: null });
    expect(await row("B_BLANK")).toMatchObject({ status: "cancelled", notes: null });
    expect((await audits())[0].after).toBe('{"status":"cancelled","reason":""}');
  });
  it("a reason that is not text is written as text", async () => {
    await rpc(rpcCancelBonus, ADMIN, ["B_P2", 42]);
    expect((await row("B_P2")).notes).toBe("Cancelled: 42");
  });
  it("a paid bonus is refused and unchanged", async () => {
    const before = await row("B_PAID");
    await expect(rpc(rpcCancelBonus, ADMIN, ["B_PAID", "Mistake"])).rejects.toThrow("Cannot cancel a paid bonus — undo the payment first");
    expect(await row("B_PAID")).toEqual(before);
    expect(await audits()).toEqual([]);
  });
  it("an already cancelled bonus is answered as it is: no write, no audit, the reason is not added", async () => {
    const before = await row("B_CANC");
    const out = await rpc(rpcCancelBonus, ADMIN, ["B_CANC", "Again"]);
    expect(out).toMatchObject({ bonusId: "B_CANC", status: "cancelled", notes: "Cancelled: wrong person", amount: -15 });
    expect(await row("B_CANC")).toEqual(before);
    expect(await audits()).toEqual([]);
  });
  it("a missing or unknown id is refused", async () => {
    await expect(rpc(rpcCancelBonus, ADMIN, [])).rejects.toThrow("bonusId required");
    await expect(rpc(rpcCancelBonus, ADMIN, ["B_NOPE", "x"])).rejects.toThrow("Bonus not found: B_NOPE");
  });
  it("a cancelled bonus can no longer be approved", async () => {
    await rpc(rpcCancelBonus, ADMIN, ["B_P1", "x"]);
    await expect(rpc(rpcApproveBonus, ADMIN, ["B_P1"])).rejects.toThrow("Can only approve proposed bonuses (current: cancelled)");
  });
});

describe("what Payments calls", () => {
  it("markPaid: pending becomes paid, the actor and 'bonus.paid' are audited; SYSTEM when there is no actor", async () => {
    const out = await inTx((tx) => bonuses.markPaid(tx, "B_PEND", "S_001", NOW));
    expect(out).toMatchObject({ bonusId: "B_PEND", status: "paid" });
    await inTx((tx) => bonuses.markPaid(tx, "B_P1", "S_001", NOW)).catch(() => undefined);
    await owner.query("update ops.bonuses set status = 'pending' where bonus_id = 'B_P2'");
    await inTx((tx) => bonuses.markPaid(tx, "B_P2", "", LATER));
    const log = await audits();
    expect(log.map((a: any) => [a.actor_id, a.action, a.target_id, a.before, a.after])).toEqual([
      ["S_001", "bonus.paid", "B_PEND", '{"status":"pending"}', '{"status":"paid"}'],
      ["SYSTEM", "bonus.paid", "B_P2", '{"status":"pending"}', '{"status":"paid"}'],
    ]);
  });
  it("markPaid refuses a proposed, paid or cancelled bonus, and an unknown one", async () => {
    await expect(inTx((tx) => bonuses.markPaid(tx, "B_P1", "S_001", NOW))).rejects.toThrow("Can only pay pending bonuses (current: proposed)");
    await expect(inTx((tx) => bonuses.markPaid(tx, "B_PAID", "S_001", NOW))).rejects.toThrow("Can only pay pending bonuses (current: paid)");
    await expect(inTx((tx) => bonuses.markPaid(tx, "B_CANC", "S_001", NOW))).rejects.toThrow("Can only pay pending bonuses (current: cancelled)");
    await expect(inTx((tx) => bonuses.markPaid(tx, "B_NOPE", "S_001", NOW))).rejects.toThrow("Bonus not found: B_NOPE");
    expect(await audits()).toEqual([]);
  });
  it("revertToPending: paid becomes pending with the old details text; anything else comes back as it is; unknown is null", async () => {
    const out = await inTx((tx) => bonuses.revertToPending(tx, "B_PAID", "S_001", NOW));
    expect(out).toMatchObject({ bonusId: "B_PAID", status: "pending" });
    expect(await audits()).toEqual([
      { actor_id: "S_001", action: "bonus.reverted", target_type: "bonuses", target_id: "B_PAID", before: '{"status":"paid"}', after: '{"status":"pending"}', details: "Reverted due to payment undo", timestamp: NOW },
    ]);
    expect(await inTx((tx) => bonuses.revertToPending(tx, "B_PEND", "S_001", NOW))).toMatchObject({ status: "pending" });
    expect(await inTx((tx) => bonuses.revertToPending(tx, "B_CANC", "S_001", NOW))).toMatchObject({ status: "cancelled" });
    expect(await inTx((tx) => bonuses.revertToPending(tx, "B_NOPE", "S_001", NOW))).toBeNull();
    expect(await audits()).toHaveLength(1);
  });
  it("with no actor the audit says SYSTEM", async () => {
    await inTx((tx) => bonuses.revertToPending(tx, "B_PAID", undefined, NOW));
    expect((await audits())[0].actor_id).toBe("SYSTEM");
  });
});

describe("a bonus is never removed", () => {
  it("the app's database role cannot delete from bonuses", async () => {
    await expect(db.query("delete from ops.bonuses where bonus_id = 'B_CANC'")).rejects.toThrow(/permission denied/);
  });
});

describe("two admins at once", () => {
  it("the second approval waits for the first, then is refused: only one audit row, one approval", async () => {
    const a = await connect(testDb.appUrl);
    const b = await connect(testDb.appUrl);
    try {
      let release!: () => void;
      let written!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      const didWrite = new Promise<void>((r) => (written = r));
      const first = withTransaction(a, async (tx) => {
        await bonuses.approve(tx, "B_P1", "S_001", NOW);
        written();
        await hold;
      });
      await didWrite;
      let settled = false;
      const second = withTransaction(b, (tx) => bonuses.approve(tx, "B_P1", "S_006", LATER)).finally(() => (settled = true));
      second.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // waiting on the row lock
      release();
      await first;
      await expect(second).rejects.toThrow("Can only approve proposed bonuses (current: pending)");
      expect((await audits()).map((x: any) => x.actor_id)).toEqual(["S_001"]);
    } finally {
      await a.close();
      await b.close();
    }
  });
  it("an approval and a cancellation: the later one sees the earlier one's result", async () => {
    const a = await connect(testDb.appUrl);
    const b = await connect(testDb.appUrl);
    try {
      let release!: () => void;
      let written!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      const didWrite = new Promise<void>((r) => (written = r));
      const first = withTransaction(a, async (tx) => {
        await bonuses.cancel(tx, "B_P1", "S_001", "no", NOW);
        written();
        await hold;
      });
      await didWrite;
      const second = withTransaction(b, (tx) => bonuses.approve(tx, "B_P1", "S_006", LATER));
      second.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      release();
      await first;
      await expect(second).rejects.toThrow("Can only approve proposed bonuses (current: cancelled)");
      expect((await row("B_P1")).status).toBe("cancelled");
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("what the Sheet took and the database refuses (added in review)", () => {
  it("an unreadable date and an unknown company are refused with a readable message, and nothing is written", async () => {
    const tdb = await createTestDb();
    const c = await connect(tdb.appUrl);
    try {
      await c.query("insert into ops.staff (staff_id, name, active, role) values ('S1', 'Asha Example', true, 'admin')");
      const now = new Date(Date.UTC(2026, 10, 20, 15, 0, 0));
      const base = { staffId: "S1", type: "bonus", amount: 10, reason: "test", actorId: "S1" };
      await expect(bonuses.create(c, { ...base, date: new Date("not-a-date") }, now)).rejects.toThrow("Invalid date");
      await expect(bonuses.create(c, { ...base, company: "grocery" }, now)).rejects.toThrow("Invalid company: grocery");
      for (const err of [await bonuses.create(c, { ...base, date: new Date(NaN) }, now).catch((e: unknown) => e), await bonuses.create(c, { ...base, company: "grocery" }, now).catch((e: unknown) => e)]) {
        expect(Object.getPrototypeOf(err)).toBe(Error.prototype); // a plain Error: the router shows it, not SERVER_ERROR
      }
      expect((await c.one<{ n: number }>("select count(*)::int as n from ops.bonuses")).n).toBe(0);
      expect((await c.one<{ n: number }>("select count(*)::int as n from ops.audit_log")).n).toBe(0);
      expect((await bonuses.create(c, { ...base, company: "vape" }, now)).company).toBe("vape");
      expect((await bonuses.create(c, { ...base, company: "" }, now)).company).toBe("");
    } finally {
      await c.close();
      await tdb.drop();
    }
  });
});
