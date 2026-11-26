// Cash handling: modules/cash-handling.ts and the five RPCs of handlers/cash-handling.ts, against a
// real database with invented people.
//
// Ported here from the old suites, assertion for assertion:
//   - tests/suites/cash-handling.js: the balance is the sum of what left the drawers; a session that
//     removed nothing (0, or a negative) is not owed; settlement is oldest-first across every company;
//     a handover cannot exceed what is held; the preview and the write agree; the per-company split
//     adds up to the total; voiding returns the cash.
//     NOT ported: "missing tables degrade rather than throw" (the old feature flag for a Sheet whose two
//     tabs were not yet added: the tables always exist here, so there is nothing to degrade).
//   - tests/suites/rpc-guards.js (cash sections): no token and a junk token are refused (the token is
//     the router's: here a call with no session); a cashier hands over their OWN cash, not someone
//     else's; the configured cash manager may record for anyone; voiding is the cash manager or an admin
//     only (a plain manager is refused); another person's balance is privileged; a role in the call's
//     arguments is ignored. The old suite stubbed CashHandling; these run the real module.
// Plus what the old suites did not hold down: the audit rows, the ids of a many-item handover, the two
// handovers for one person at once, two voids at once, the stale-days rule, the history's order and
// limits, and each refusal the new schema forces (method, date, NUL).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction, type Tx } from "../src/db/tx";
import { loadConfig } from "../src/lib/config";
import * as ch from "../src/modules/cash-handling";
import { rpcGetCashHandoverHistory, rpcGetCashOutstandingFor, rpcGetCashPosition, rpcRecordCashHandover, rpcVoidCashHandover } from "../src/rpc/handlers/cash-handling";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

// Friday 20 November 2026, 10:30 Toronto (UTC-5).
const NOW = new Date("2026-11-20T15:30:00Z");
const LATER = new Date("2026-11-20T15:40:00Z");

const STAFF: Array<[string, string, string]> = [
  ["S_001", "Ada Quill", "admin"],
  ["S_002", "Bram Hale", "manager"],
  ["S_003", "Cleo Marsh", "employee"],
  ["S_004", "Dara Vance", "employee"],
  ["S_005", "Eli Stone", "employee"],
  ["S_006", "Fay Ortega", "payroll_admin"],
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

async function setConfig(rows: Record<string, string | null>): Promise<void> {
  await owner.query("delete from ops.config");
  for (const [k, v] of Object.entries(rows)) await owner.query("insert into ops.config (key, value) values ($1, $2)", [k, v]);
}

beforeEach(async () => {
  for (const t of ["audit_log", "cash_handover_items", "cash_handovers", "sales", "till_sessions", "attendance", "staff", "config"]) await owner.query(`delete from ops.${t}`);
  for (const [id, name, role] of STAFF) await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized) values ($1,$2,17,true,$3,'cstore,vape')", [id, name, role]);
  await setConfig({ cash_manager_staff_id: "S_002" });
});

const session = (staffId: string, role: Session["role"], name = staffId): Session => ({ staffId, name, role, companiesAuthorized: ["cstore", "vape"], expiresAt: 0 });
const CASHIER = session("S_003", "employee", "Cleo Marsh");
const ADMIN = session("S_001", "admin", "Ada Quill");
const CASH_MANAGER = session("S_002", "manager", "Bram Hale");
const OTHER_MANAGER = session("S_004", "manager", "Dara Vance"); // a manager who is not the cash manager
const PAYROLL = session("S_006", "payroll_admin", "Fay Ortega");

function ctxFor(tx: Tx, who: Session | null, now: Date): RpcContext {
  return { db: tx, session: who, config: () => loadConfig(tx), env: {}, fetch: () => Promise.reject(new Error("no network in this test")), now };
}
const rpc = (handler: (ctx: RpcContext, ...a: unknown[]) => unknown, who: Session | null, args: unknown[], now = NOW): Promise<any> =>
  withTransaction(db, async (tx) => handler(ctxFor(tx, who, now), ...args));

const cfg = (tx: Tx) => loadConfig(tx);
const recordIn = (input: Record<string, unknown>, now = NOW, random?: () => number) =>
  withTransaction(db, async (tx) => ch.record(tx, await cfg(tx), input, now, random));
const voidIn = (id: unknown, actorId: unknown, now = LATER) => withTransaction(db, async (tx) => ch.voidHandover(tx, id as string, actorId as string, now));
const owedBy = (staffId: unknown, now = NOW) => ch.getOutstandingForStaff(db, staffId, now);
const history = (limit: number | undefined, staffId?: unknown) => ch.getHistory(db, limit, staffId);

const count = async (table: string) => (await db.one<{ n: number }>(`select count(*)::int as n from ops.${table}`)).n;
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details, "timestamp" from ops.audit_log order by "timestamp", log_id`);
const handoverRow = (id: string) => db.one<any>("select * from ops.cash_handovers where handover_id = $1", [id]);
const itemRows = (handoverId: string) => db.query<any>("select * from ops.cash_handover_items where handover_id = $1 order by session_id", [handoverId]);

/** A closed till that sent `removed` out of the door with `staff`. NULL removed is a blank cell. */
async function closed(id: string, staff: string, date: string, removed: number | null, company = "cstore", status = "closed"): Promise<void> {
  const att = `A_${date.replace(/-/g, "")}_${staff}`;
  await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ($1, $2, $3, 'worked') on conflict do nothing", [att, staff, date]);
  await owner.query(
    `insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time, end_time, cash_removed_at_close)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, att, staff, company, date, status, `${date}T14:00:00Z`, `${date}T22:00:00Z`, removed],
  );
}
async function seedHandover(id: string, from: string, to: string, amount: number, over: Record<string, unknown> = {}): Promise<void> {
  const h = { handed_on: "2026-11-10", recorded_by: to, recorded_at: "2026-11-10T20:00:00Z", method: "cash", status: "recorded", notes: null, voided_by: null, voided_at: null, ...over };
  await owner.query(
    `insert into ops.cash_handovers (handover_id, from_staff_id, to_staff_id, amount, handed_on, recorded_by, recorded_at, method, status, notes, voided_by, voided_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, from, to, amount, h.handed_on, h.recorded_by, h.recorded_at, h.method, h.status, h.notes, h.voided_by, h.voided_at],
  );
}
async function seedItem(id: string, handoverId: string, sessionId: string, amount: number): Promise<void> {
  await owner.query("insert into ops.cash_handover_items (item_id, handover_id, session_id, amount) values ($1,$2,$3,$4)", [id, handoverId, sessionId, amount]);
}

// ── What a person holds ─────────────────────────────────────

describe("outstanding", () => {
  it("is the sum of what left the drawers, per person (old: balance is the sum of what left the drawer)", async () => {
    await closed("S1", "S_003", "2026-11-10", 520);
    await closed("S2", "S_003", "2026-11-12", 420);
    await closed("S3", "S_004", "2026-11-12", 300);
    const a = await owedBy("S_003");
    expect(a.totalOutstanding).toBe(940);
    expect(a.unsettledSessions).toHaveLength(2);
    expect((await owedBy("S_004")).totalOutstanding).toBe(300);
    expect(await owedBy("S_005")).toEqual({ staffId: "S_005", totalOutstanding: 0, unsettledSessions: [] });
  });

  it("does not count a session that removed nothing, a negative one, a blank one, or one still open (old: sessions that removed nothing are not owed)", async () => {
    await closed("S1", "S_003", "2026-11-10", 520);
    await closed("S2", "S_003", "2026-11-11", 0);
    await closed("S3", "S_003", "2026-11-12", -250);
    await closed("S4", "S_003", "2026-11-13", null); // blank is not zero: not counted, and not an error
    await closed("S5", "S_003", "2026-11-14", 80, "vape", "open");
    const a = await owedBy("S_003");
    expect(a.totalOutstanding).toBe(520);
    expect(a.unsettledSessions.map((s) => s.sessionId)).toEqual(["S1"]);
  });

  it("counts a validated session as closed", async () => {
    await closed("S1", "S_003", "2026-11-10", 60, "cstore", "validated");
    expect((await owedBy("S_003")).totalOutstanding).toBe(60);
  });

  it("describes each shift: date as the Toronto midnight, text date, what is settled and left, its age in days", async () => {
    await closed("S1", "S_003", "2026-11-10", 500, "vape");
    await seedHandover("H1", "S_003", "S_002", 120);
    await seedItem("I1", "H1", "S1", 120);
    const a = await owedBy("S_003");
    expect(a.unsettledSessions).toEqual([
      { sessionId: "S1", company: "vape", date: "2026-11-10T05:00:00.000Z", dateStr: "2026-11-10", cashTaken: 500, settled: 120, remaining: 380, ageDays: 10 },
    ]);
    // Aged by whole days since the Toronto midnight, never below 0.
    expect((await owedBy("S_003", new Date("2026-11-10T05:00:00Z"))).unsettledSessions[0]!.ageDays).toBe(0);
    expect((await owedBy("S_003", new Date("2026-11-09T05:00:00Z"))).unsettledSessions[0]!.ageDays).toBe(0);
    expect((await owedBy("S_003", new Date("2026-11-11T04:59:59Z"))).unsettledSessions[0]!.ageDays).toBe(0);
    expect((await owedBy("S_003", new Date("2026-11-11T05:00:00Z"))).unsettledSessions[0]!.ageDays).toBe(1);
  });

  it("lists the shifts oldest first, across every company (old: settlement is oldest-first)", async () => {
    await closed("S3", "S_003", "2026-11-12", 200, "cstore");
    await closed("S1", "S_003", "2026-11-10", 500, "cstore");
    await closed("S2", "S_003", "2026-11-11", 300, "vape");
    expect((await owedBy("S_003")).unsettledSessions.map((s) => s.sessionId)).toEqual(["S1", "S2", "S3"]);
  });

  it("does not count what a voided handover settled, and counts what a live one settled (the void reverses the allocation)", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    await seedHandover("H1", "S_003", "S_002", 500, { status: "voided", voided_by: "S_002", voided_at: "2026-11-11T10:00:00Z" });
    await seedItem("I1", "H1", "S1", 500);
    expect((await owedBy("S_003")).totalOutstanding).toBe(500);
    await seedHandover("H2", "S_003", "S_002", 200);
    await seedItem("I2", "H2", "S1", 200);
    expect((await owedBy("S_003")).totalOutstanding).toBe(300);
  });

  it("is settled to nothing below half a cent, and the staff id is required", async () => {
    await closed("S1", "S_003", "2026-11-10", 100);
    await seedHandover("H1", "S_003", "S_002", 99.995);
    await seedItem("I1", "H1", "S1", 99.99);
    expect((await owedBy("S_003")).unsettledSessions).toHaveLength(1); // 0.01 left
    await expect(owedBy("")).rejects.toThrow("staffId required");
    await expect(owedBy(undefined)).rejects.toThrow("staffId required");
    expect(await owedBy(42)).toEqual({ staffId: 42, totalOutstanding: 0, unsettledSessions: [] }); // a number matches nobody, as before
  });
});

describe("the roster (getAllOutstanding)", () => {
  async function scenario(): Promise<void> {
    await closed("S1", "S_003", "2026-11-10", 500, "cstore");
    await closed("S2", "S_003", "2026-11-11", 300, "vape");
    await closed("S3", "S_004", "2026-11-11", 120, "vape");
    await closed("S4", "S_005", "2026-11-19", 900, "cstore");
  }

  it("lists the holders largest first with their split, and the grand totals (old: the per-company split reconciles)", async () => {
    await scenario();
    const all = await ch.getAllOutstanding(db, await loadConfig(db), NOW);
    expect(all.holders.map((h) => [h.staffId, h.name, h.total])).toEqual([
      ["S_005", "Eli Stone", 900],
      ["S_003", "Cleo Marsh", 800],
      ["S_004", "Dara Vance", 120],
    ]);
    expect(all.holders[1]).toEqual({
      staffId: "S_003",
      name: "Cleo Marsh",
      total: 800,
      byCompany: { cstore: 500, vape: 300 },
      shifts: 2,
      shiftsByCompany: { cstore: 1, vape: 1 },
      oldest: "2026-11-10",
      oldestAge: 10,
    });
    expect(all.grandTotal).toBe(1820);
    expect(all.grandByCompany).toEqual({ cstore: 1400, vape: 420 });
    expect(all.grandByCompany.cstore! + all.grandByCompany.vape!).toBe(all.grandTotal);
    for (const h of all.holders) expect(Object.values(h.byCompany).reduce((a, b) => a + b, 0)).toBe(h.total);
  });

  it("flags the shifts out for the stale limit or longer, oldest first (default 7 days)", async () => {
    await scenario();
    const all = await ch.getAllOutstanding(db, await loadConfig(db), NOW);
    expect(all.staleDays).toBe(7);
    expect(all.stale).toEqual([
      { staffId: "S_003", name: "Cleo Marsh", sessionId: "S1", company: "cstore", dateStr: "2026-11-10", remaining: 500, ageDays: 10 },
      { staffId: "S_003", name: "Cleo Marsh", sessionId: "S2", company: "vape", dateStr: "2026-11-11", remaining: 300, ageDays: 9 },
      { staffId: "S_004", name: "Dara Vance", sessionId: "S3", company: "vape", dateStr: "2026-11-11", remaining: 120, ageDays: 9 },
    ]);
  });

  it.each([
    ["", 7],
    ["0", 7],
    ["-3", 7],
    ["soon", 7],
    ["  ", 7],
    ["1.5", 1.5],
    ["3", 3],
    [" 4 ", 4],
  ])("reads cash_handover_stale_days %j as %s (a zero, negative or unreadable value is 7)", async (value, expected) => {
    await setConfig({ cash_manager_staff_id: "S_002", cash_handover_stale_days: value });
    await scenario();
    const all = await ch.getAllOutstanding(db, await loadConfig(db), NOW);
    expect(all.staleDays).toBe(expected);
  });

  it("uses 7 when the setting is missing or NULL", async () => {
    await setConfig({ cash_manager_staff_id: "S_002", cash_handover_stale_days: null });
    expect((await ch.getAllOutstanding(db, await loadConfig(db), NOW)).staleDays).toBe(7);
    await setConfig({});
    expect((await ch.getAllOutstanding(db, await loadConfig(db), NOW)).staleDays).toBe(7);
  });

  it("has a stale limit that changes what is flagged", async () => {
    await scenario();
    await setConfig({ cash_manager_staff_id: "S_002", cash_handover_stale_days: "1" });
    const all = await ch.getAllOutstanding(db, await loadConfig(db), NOW);
    expect(all.stale.map((s) => s.sessionId)).toEqual(["S1", "S2", "S3", "S4"]);
    expect(all.stale[3]).toMatchObject({ remaining: 900, ageDays: 1 });
  });

  it("includes an inactive person who still holds cash, and leaves out anyone holding nothing", async () => {
    await owner.query("update ops.staff set active = false where staff_id = 'S_005'");
    await scenario();
    const all = await ch.getAllOutstanding(db, await loadConfig(db), NOW);
    expect(all.holders.map((h) => h.staffId)).toEqual(["S_005", "S_003", "S_004"]);
  });

  it("is empty when nobody holds anything", async () => {
    expect(await ch.getAllOutstanding(db, await loadConfig(db), NOW)).toEqual({ holders: [], grandTotal: 0, grandByCompany: {}, stale: [], staleDays: 7 });
  });
});

// ── Record ──────────────────────────────────────────────────

describe("record", () => {
  it("settles the oldest shift first and fills each before moving on, across every company; the newest is untouched (old: oldest-first across every company)", async () => {
    await closed("S1", "S_003", "2026-11-10", 500, "cstore");
    await closed("S2", "S_003", "2026-11-11", 300, "vape");
    await closed("S3", "S_003", "2026-11-12", 200, "cstore");
    const r = await recordIn({ fromStaffId: "S_003", toStaffId: "S_002", amount: 700, actorId: "S_002", method: "cash", notes: "rest tomorrow" });
    expect(r.itemsCreated.map((i) => i.sessionId)).toEqual(["S1", "S2"]);
    expect(r.itemsCreated.map((i) => i.amount)).toEqual([500, 200]);
    expect(r.itemsCreated.map((i) => i.isPartial)).toEqual([false, true]);
    expect(r.itemsCreated[1]).toMatchObject({ dateStr: "2026-11-11", company: "vape" });
    expect(r).toMatchObject({ amount: 700, outstandingBefore: 1000, outstandingAfter: 300 });
    expect(r.handoverId).toMatch(/^H_20261120_103000_[a-z0-9]{1,10}$/);
    expect(r.itemsCreated.every((i) => /^CI_20261120_103000_[a-z0-9]{1,10}$/.test(i.itemId))).toBe(true);
  });

  it("refuses more than is held, with the old words (old: a handover cannot exceed what is held)", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    await expect(recordIn({ fromStaffId: "S_003", toStaffId: "S_002", amount: 600, actorId: "S_002", method: "cash" })).rejects.toThrow(
      "Cleo Marsh is holding $500.00, so $600.00 cannot be handed over.",
    );
    expect(await count("cash_handovers")).toBe(0);
    expect(await count("audit_log")).toBe(0);
  });

  it("agrees with the preview: holding 800, hand over 500, holding 300 (old: the preview and the write agree)", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    await closed("S2", "S_003", "2026-11-11", 300);
    expect((await owedBy("S_003")).totalOutstanding).toBe(800);
    await recordIn({ fromStaffId: "S_003", toStaffId: "S_002", amount: 500, actorId: "S_002", method: "cash", notes: "rest tomorrow" });
    const after = await owedBy("S_003");
    expect(after.totalOutstanding).toBe(300);
    expect(after.unsettledSessions.map((s) => [s.sessionId, s.remaining])).toEqual([["S2", 300]]);
  });

  it("returns the cash to the holder when voided (old: voiding returns the cash)", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    const h = await recordIn({ fromStaffId: "S_003", toStaffId: "S_002", amount: 500, actorId: "S_002", method: "cash" });
    expect((await owedBy("S_003")).totalOutstanding).toBe(0);
    await voidIn(h.handoverId, "S_002");
    expect((await owedBy("S_003")).totalOutstanding).toBe(500);
  });

  it("writes the handover and its items as the old code did, and the audit row", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    await closed("S2", "S_003", "2026-11-11", 300);
    const r = await recordIn({ fromStaffId: "S_003", amount: 600, actorId: "S_003", handedOn: "2026-11-19", notes: "  rest tomorrow  " });
    expect(await handoverRow(r.handoverId)).toMatchObject({
      from_staff_id: "S_003",
      to_staff_id: "S_002", // the configured cash manager
      amount: 600,
      handed_on: "2026-11-19",
      recorded_by: "S_003",
      recorded_at: NOW,
      method: "cash",
      status: "recorded",
      notes: "rest tomorrow",
      voided_by: null,
      voided_at: null,
    });
    expect((await itemRows(r.handoverId)).map((i) => [i.session_id, i.amount, i.notes])).toEqual([
      ["S1", 500, null],
      ["S2", 100, null],
    ]);
    expect(await audits()).toEqual([
      {
        actor_id: "S_003",
        action: "cash.handover",
        target_type: "cash_handovers",
        target_id: r.handoverId,
        before: null,
        after: JSON.stringify({ from: "S_003", to: "S_002", amount: 600, sessions: 2, stillOut: 200, notes: "rest tomorrow" }),
        details: "Cleo Marsh → Bram Hale $600.00, recorded by Cleo Marsh, $200.00 still out",
        timestamp: NOW,
      },
    ]);
  });

  it("stores a blank note as NULL, with no 'still out' in the audit details when everything is handed over", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    const r = await recordIn({ fromStaffId: "S_003", amount: 500, actorId: "S_001" });
    expect((await handoverRow(r.handoverId)).notes).toBeNull();
    expect((await handoverRow(r.handoverId)).recorded_by).toBe("S_001");
    const [a] = await audits();
    expect(a.details).toBe("Cleo Marsh → Bram Hale $500.00, recorded by Ada Quill");
    expect(JSON.parse(a.after)).toEqual({ from: "S_003", to: "S_002", amount: 500, sessions: 1, stillOut: 0, notes: "" });
  });

  it("refuses with the old words, in the old order", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    const base = { fromStaffId: "S_003", toStaffId: "S_002", amount: 100, actorId: "S_003", notes: "x" };
    const refuse = (over: Record<string, unknown>, text: string) => expect(recordIn({ ...base, ...over })).rejects.toThrow(text);
    await refuse({ fromStaffId: "" }, "fromStaffId required");
    await refuse({ fromStaffId: undefined, amount: -1 }, "fromStaffId required");
    await refuse({ actorId: "" }, "actorId required");
    await refuse({ actorId: undefined, amount: -1 }, "actorId required");
    await refuse({ amount: undefined }, "amount must be a positive number");
    await refuse({ amount: "abc" }, "amount must be a positive number");
    await refuse({ amount: 0 }, "amount must be a positive number");
    await refuse({ amount: -5 }, "amount must be a positive number");
    await refuse({ amount: 0.004 }, "amount must be a positive number");
    await refuse({ fromStaffId: "S_999", amount: -1 }, "amount must be a positive number"); // the amount is checked before the person
    await refuse({ fromStaffId: "S_999" }, "Staff not found: S_999");
    await refuse({ toStaffId: "S_999" }, "Recipient not found: S_999");
    await refuse({ actorId: "S_004", toStaffId: "S_002" }, "Only Cleo Marsh, the cash manager, or an admin can record this handover");
    await refuse({ actorId: "S_999" }, "Only Cleo Marsh, the cash manager, or an admin can record this handover");
    await refuse({ amount: 500.01 }, "Cleo Marsh is holding $500.00, so $500.01 cannot be handed over.");
    await refuse({ amount: 400, notes: "   " }, "$100.00 would stay in Cleo Marsh's hands. Please give a reason.");
    await refuse({ amount: 400, notes: undefined }, "$100.00 would stay in Cleo Marsh's hands. Please give a reason.");
    expect(await count("cash_handovers")).toBe(0);
    expect(await count("audit_log")).toBe(0);
    // The check for a missing recipient comes before the person is looked up as an actor.
    await setConfig({});
    await refuse({ toStaffId: undefined }, "No cash manager configured — set cash_manager_staff_id in the config tab to the staff_id of whoever holds the business cash.");
    await refuse({ toStaffId: "" }, "No cash manager configured");
    await setConfig({ cash_manager_staff_id: "S_999" });
    await refuse({ toStaffId: undefined }, "No cash manager configured");
  });

  it("lets the cashier, the recipient or an admin record it, and nobody else", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    const base = { fromStaffId: "S_003", amount: 10, notes: "x" };
    await recordIn({ ...base, actorId: "S_003" }); // the cashier
    await recordIn({ ...base, actorId: "S_002" }); // the recipient (the cash manager)
    await recordIn({ ...base, actorId: "S_001" }); // an admin
    await recordIn({ ...base, toStaffId: "S_005", actorId: "S_005" }); // a named recipient, recording
    await expect(recordIn({ ...base, toStaffId: "S_005", actorId: "S_002" })).rejects.toThrow("Only Cleo Marsh, the cash manager, or an admin");
    await expect(recordIn({ ...base, actorId: "S_006" })).rejects.toThrow("Only Cleo Marsh");
    await expect(recordIn({ ...base, actorId: "S_004" })).rejects.toThrow("Only Cleo Marsh");
    expect(await count("cash_handovers")).toBe(4);
  });

  it("allows a handover to oneself, to an inactive person, and the recipient named over the default (as the old code did)", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    await owner.query("update ops.staff set active = false where staff_id = 'S_005'");
    await recordIn({ fromStaffId: "S_003", toStaffId: "S_003", amount: 10, actorId: "S_003", notes: "x" });
    await recordIn({ fromStaffId: "S_003", toStaffId: "S_005", amount: 10, actorId: "S_001", notes: "x" });
    expect((await history(10)).map((h) => h.toStaffId).sort()).toEqual(["S_003", "S_005"]);
  });

  it("makes ids that do not collide when one handover settles many shifts, in one second, even if the random numbers repeat", async () => {
    for (let d = 1; d <= 25; d++) await closed(`S${String(d).padStart(2, "0")}`, "S_003", `2026-10-${String(d).padStart(2, "0")}`, 10 + d);
    const r = await recordIn({ fromStaffId: "S_003", amount: 25 * 10 + (25 * 26) / 2, actorId: "S_003" });
    expect(r.itemsCreated).toHaveLength(25);
    expect(new Set(r.itemsCreated.map((i) => i.itemId)).size).toBe(25);
    expect(await count("cash_handover_items")).toBe(25);
    // Two handovers in the same second also get ids of their own.
    await closed("T1", "S_004", "2026-11-01", 100);
    const a = await recordIn({ fromStaffId: "S_004", amount: 10, actorId: "S_004", notes: "x" });
    const b = await recordIn({ fromStaffId: "S_004", amount: 10, actorId: "S_004", notes: "x" });
    expect(a.handoverId).not.toBe(b.handoverId);
    expect(a.itemsCreated[0]!.itemId).not.toBe(b.itemsCreated[0]!.itemId);
  });

  it("reads handedOn as the old toDate_ did: a day, a rolled-over day, a datetime, and anything unreadable as today", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    const day = async (handedOn: unknown) => {
      const r = await recordIn({ fromStaffId: "S_003", amount: 1, actorId: "S_003", notes: "x", handedOn });
      return (await handoverRow(r.handoverId)).handed_on as string;
    };
    expect(await day("2026-11-18")).toBe("2026-11-18");
    expect(await day(" 2026-11-18 ")).toBe("2026-11-18");
    expect(await day("2026-02-30")).toBe("2026-03-02");
    expect(await day("2026-11-18T23:30:00")).toBe("2026-11-18"); // no zone: the Toronto wall clock
    expect(await day("2026-11-18T23:30:00-05:00")).toBe("2026-11-18");
    expect(await day("2026-11-19T02:00:00Z")).toBe("2026-11-18"); // 21:00 in Toronto
    expect(await day("2027-01-05")).toBe("2027-01-05");
    expect(await day(undefined)).toBe("2026-11-20");
    expect(await day(null)).toBe("2026-11-20");
    expect(await day("")).toBe("2026-11-20");
    expect(await day("   ")).toBe("2026-11-20");
    expect(await day("last Tuesday")).toBe("2026-11-20");
    expect(await day("2026-13-45")).toBe("2026-11-20");
    expect(await day(20261118)).toBe("2026-11-20");
  });

  it("refuses what the old code stored and the database cannot hold, in plain words (a deliberate difference)", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    const base = { fromStaffId: "S_003", amount: 10, actorId: "S_003", notes: "x" };
    await expect(recordIn({ ...base, method: "cheque" })).rejects.toThrow("method must be cash, bank, etransfer or other");
    await expect(recordIn({ ...base, method: "Bank" })).rejects.toThrow("method must be cash, bank, etransfer or other");
    await expect(recordIn({ ...base, method: 5 })).rejects.toThrow("method must be cash, bank, etransfer or other");
    await expect(recordIn({ ...base, method: { a: 1 } })).rejects.toThrow("method must be cash, bank, etransfer or other");
    await expect(recordIn({ ...base, notes: "a\u0000b" })).rejects.toThrow("notes cannot contain a null character");
    await expect(recordIn({ ...base, handedOn: "+275760-09-13" })).rejects.toThrow("handedOn is not a date this app can store");
    await expect(recordIn({ ...base, handedOn: "0000-05-05" })).rejects.toThrow("handedOn is not a date this app can store");
    // A NUL in an id is "not found", as it was in the Sheet, never a database error.
    await expect(recordIn({ ...base, fromStaffId: "S_0\u00003" })).rejects.toThrow("Staff not found: S_0\u00003");
    await expect(recordIn({ ...base, toStaffId: "S_0\u00002" })).rejects.toThrow("Recipient not found: S_0\u00002");
    // The old refusals still win over the new one when both apply.
    await expect(recordIn({ ...base, amount: 0, method: "cheque" })).rejects.toThrow("amount must be a positive number");
    await expect(recordIn({ ...base, amount: 9999, method: "cheque" })).rejects.toThrow("cannot be handed over");
    expect(await count("cash_handovers")).toBe(0);
    for (const method of ["cash", "bank", "etransfer", "other"]) await recordIn({ ...base, method, amount: 1 });
    await recordIn({ ...base, method: "", amount: 1 });
    await recordIn({ ...base, method: null, amount: 1 });
    expect((await history(10)).map((h) => h.method).sort()).toEqual(["bank", "cash", "cash", "cash", "etransfer", "other"]);
  });

  it("rounds the amount to cents, like Util.roundMoney, and accepts a string", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    const a = await recordIn({ fromStaffId: "S_003", amount: 12.345, actorId: "S_003", notes: "x" });
    expect(a.amount).toBe(12.35);
    const b = await recordIn({ fromStaffId: "S_003", amount: "75.50", actorId: "S_003", notes: "x" });
    expect(b.amount).toBe(75.5);
    expect((await handoverRow(b.handoverId)).amount).toBe(75.5);
    expect((await owedBy("S_003")).totalOutstanding).toBe(412.15);
  });

  it("refuses an infinite amount as more than is held, as before", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    await expect(recordIn({ fromStaffId: "S_003", amount: Infinity, actorId: "S_003" })).rejects.toThrow("so $Infinity cannot be handed over.");
  });

  it("two handovers for one person at the same moment: the second sees the first", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    const [c1, c2] = await Promise.all([connect(testDb.appUrl), connect(testDb.appUrl)]);
    try {
      let recorded!: () => void;
      const firstDone = new Promise<void>((r) => (recorded = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const input = { fromStaffId: "S_003", amount: 500, actorId: "S_003" };
      // The first has recorded (its rows are written, not yet committed) when the second starts. Without
      // the lock on the cashier's staff row the second reads the pre-commit state and hands the same cash over again.
      const first = withTransaction(c1, async (tx) => {
        const r = await ch.record(tx, await cfg(tx), input, NOW);
        recorded();
        await gate;
        return r;
      });
      await firstDone;
      const second = withTransaction(c2, async (tx) => ch.record(tx, await cfg(tx), input, NOW)).then(
        (v) => ({ ok: true as const, v }),
        (e: Error) => ({ ok: false as const, e }),
      );
      await new Promise((r) => setTimeout(r, 400));
      release();
      const r1 = await first;
      const r2 = await second;
      expect(r1.outstandingAfter).toBe(0);
      expect(r2.ok).toBe(false);
      expect((r2 as { e: Error }).e.message).toBe("Cleo Marsh is holding $0.00, so $500.00 cannot be handed over.");
      expect(await count("cash_handovers")).toBe(1);
      expect(await count("cash_handover_items")).toBe(1);
      expect((await owedBy("S_003")).totalOutstanding).toBe(0);
    } finally {
      await Promise.all([c1.close(), c2.close()]);
    }
  });

  it("two handovers for one person at once, each more than half the balance: one is kept, none is handed over twice", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    for (let round = 0; round < 4; round++) {
      await owner.query("delete from ops.audit_log");
      await owner.query("delete from ops.cash_handover_items");
      await owner.query("delete from ops.cash_handovers");
      const conns = await Promise.all([connect(testDb.appUrl), connect(testDb.appUrl)]);
      try {
        const tries = await Promise.allSettled(
          conns.map((c) => withTransaction(c, async (tx) => ch.record(tx, await cfg(tx), { fromStaffId: "S_003", amount: 300, actorId: "S_003", notes: "x" }, NOW))),
        );
        expect(tries.filter((t) => t.status === "fulfilled")).toHaveLength(1);
        expect(String((tries.find((t) => t.status === "rejected") as PromiseRejectedResult).reason.message)).toBe("Cleo Marsh is holding $200.00, so $300.00 cannot be handed over.");
        expect(await count("cash_handover_items")).toBe(1);
        expect((await owedBy("S_003")).totalOutstanding).toBe(200);
      } finally {
        await Promise.all(conns.map((c) => c.close()));
      }
    }
  });

  it("two cashiers at once do not wait on each other", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    await closed("S2", "S_004", "2026-11-10", 500);
    const conns = await Promise.all([connect(testDb.appUrl), connect(testDb.appUrl)]);
    try {
      const tries = await Promise.allSettled(
        ["S_003", "S_004"].map((id, i) => withTransaction(conns[i]!, async (tx) => ch.record(tx, await cfg(tx), { fromStaffId: id, amount: 500, actorId: id }, NOW))),
      );
      expect(tries.map((t) => t.status)).toEqual(["fulfilled", "fulfilled"]);
    } finally {
      await Promise.all(conns.map((c) => c.close()));
    }
  });

  it("keeps nothing when a later step fails: all or none", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    await expect(
      withTransaction(db, async (tx) => {
        await ch.record(tx, await cfg(tx), { fromStaffId: "S_003", amount: 500, actorId: "S_003" }, NOW);
        throw new Error("a later step failed");
      }),
    ).rejects.toThrow("a later step failed");
    expect(await count("cash_handovers")).toBe(0);
    expect(await count("cash_handover_items")).toBe(0);
    expect(await count("audit_log")).toBe(0);
  });
});

// ── Void ────────────────────────────────────────────────────

describe("void", () => {
  async function recorded(): Promise<string> {
    await closed("S1", "S_003", "2026-11-10", 500);
    return (await recordIn({ fromStaffId: "S_003", amount: 300, actorId: "S_003", notes: "x" })).handoverId;
  }

  it("marks the handover voided and keeps the row and its items; writes the audit row; returns the old answer", async () => {
    const id = await recorded();
    const before = await audits();
    expect(await voidIn(id, "S_002")).toEqual({ handoverId: id, status: "voided", amount: 300 });
    expect(await handoverRow(id)).toMatchObject({ status: "voided", voided_by: "S_002", voided_at: LATER, amount: 300, recorded_by: "S_003" });
    expect(await count("cash_handovers")).toBe(1);
    expect(await count("cash_handover_items")).toBe(1);
    const all = await audits();
    expect(all).toHaveLength(before.length + 1);
    expect(all[all.length - 1]).toEqual({
      actor_id: "S_002",
      action: "cash.handover.void",
      target_type: "cash_handovers",
      target_id: id,
      before: JSON.stringify({ amount: 300, from: "S_003", to: "S_002", recordedBy: "S_003" }),
      after: null,
      details: "Voided $300.00 handover recorded by S_003",
      timestamp: LATER,
    });
    expect((await owedBy("S_003")).totalOutstanding).toBe(500);
  });

  it("refuses with the old words: no id, no actor, unknown, twice", async () => {
    const id = await recorded();
    await expect(voidIn("", "S_002")).rejects.toThrow("handoverId required");
    await expect(voidIn(undefined, "S_002")).rejects.toThrow("handoverId required");
    await expect(voidIn(id, "")).rejects.toThrow("actorId required");
    await expect(voidIn("H_nope", "S_002")).rejects.toThrow("Handover not found: H_nope");
    await expect(voidIn(12, "S_002")).rejects.toThrow("Handover not found: 12");
    await expect(voidIn("H\u0000x", "S_002")).rejects.toThrow("Handover not found: H\u0000x");
    await voidIn(id, "S_002");
    await expect(voidIn(id, "S_002")).rejects.toThrow("Handover is already voided");
    expect((await handoverRow(id)).voided_at).toEqual(LATER);
    expect((await audits()).filter((a) => a.action === "cash.handover.void")).toHaveLength(1);
  });

  it("two voids of one handover at once: one wins, the other is told it is already voided", async () => {
    const id = await recorded();
    const [c1, c2] = await Promise.all([connect(testDb.appUrl), connect(testDb.appUrl)]);
    try {
      let locked!: () => void;
      const held = new Promise<void>((r) => (locked = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const first = withTransaction(c1, async (tx) => {
        const r = await ch.voidHandover(tx, id, "S_002", LATER);
        locked();
        await gate;
        return r;
      });
      await held;
      const second = withTransaction(c2, async (tx) => ch.voidHandover(tx, id, "S_001", LATER)).then(
        () => "voided",
        (e: Error) => e.message,
      );
      await new Promise((r) => setTimeout(r, 400));
      release();
      await first;
      expect(await second).toBe("Handover is already voided");
      expect((await audits()).filter((a) => a.action === "cash.handover.void")).toHaveLength(1);
      expect((await handoverRow(id)).voided_by).toBe("S_002");
    } finally {
      await Promise.all([c1.close(), c2.close()]);
    }
  });

  it("frees the cash for another handover, and a void of an old handover leaves the later ones alone", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    const a = await recordIn({ fromStaffId: "S_003", amount: 200, actorId: "S_003", notes: "x" });
    const b = await recordIn({ fromStaffId: "S_003", amount: 100, actorId: "S_003", notes: "x" }, LATER);
    await voidIn(a.handoverId, "S_002");
    const o = await owedBy("S_003");
    expect(o.totalOutstanding).toBe(400);
    expect(o.unsettledSessions[0]).toMatchObject({ settled: 100, remaining: 400 });
    await recordIn({ fromStaffId: "S_003", amount: 400, actorId: "S_003" }, new Date("2026-11-20T16:00:00Z"));
    expect((await owedBy("S_003")).totalOutstanding).toBe(0);
    expect((await handoverRow(b.handoverId)).status).toBe("recorded");
  });
});

// ── History ─────────────────────────────────────────────────

describe("history", () => {
  async function ledger(): Promise<void> {
    await closed("S1", "S_003", "2026-11-01", 100);
    await closed("S2", "S_003", "2026-11-02", 100);
    await closed("S3", "S_004", "2026-11-03", 100);
    await seedHandover("H1", "S_003", "S_002", 150, { recorded_at: "2026-11-05T15:00:00Z", handed_on: "2026-11-05", recorded_by: "S_002", notes: "Weekly drop" });
    await seedItem("I1b", "H1", "S2", 50);
    await seedItem("I1a", "H1", "S1", 100);
    await seedHandover("H2", "S_004", "S_002", 100, { recorded_at: "2026-11-06T15:00:00Z", handed_on: "2026-11-06", recorded_by: "SYSTEM" });
    await seedItem("I2", "H2", "S3", 100);
    await seedHandover("H3", "S_003", "S_001", 10, { recorded_at: "2026-11-07T15:00:00Z", handed_on: null, recorded_by: "S_003", method: null, status: "voided", voided_by: "S_001", voided_at: "2026-11-08T15:00:00Z" });
    await seedHandover("H4", "S_005", "S_002", 1, { recorded_at: null, handed_on: null, recorded_by: "S_005" });
  }

  it("is newest recorded first, each with names, ISO dates, its items in the order they were allocated, and what a blank reads as", async () => {
    await ledger();
    const rows = await history(10);
    expect(rows.map((h) => h.handoverId)).toEqual(["H3", "H2", "H1", "H4"]);
    expect(rows[2]).toEqual({
      handoverId: "H1",
      fromStaffId: "S_003",
      fromName: "Cleo Marsh",
      toStaffId: "S_002",
      toName: "Bram Hale",
      amount: 150,
      handedOn: "2026-11-05T05:00:00.000Z",
      handedOnStr: "2026-11-05",
      recordedBy: "S_002",
      recordedByName: "Bram Hale",
      recordedAt: "2026-11-05T15:00:00.000Z",
      method: "cash",
      status: "recorded",
      notes: "Weekly drop",
      voidedBy: "",
      voidedByName: "",
      items: [
        { sessionId: "S1", amount: 100, notes: "" },
        { sessionId: "S2", amount: 50, notes: "" },
      ],
    });
    // A name that is not on the staff list shows as the id; a blank method reads as cash; a blank date is null / ''.
    expect(rows[1]).toMatchObject({ recordedBy: "SYSTEM", recordedByName: "SYSTEM" });
    expect(rows[0]).toMatchObject({ method: "cash", status: "voided", voidedBy: "S_001", voidedByName: "Ada Quill", handedOn: null, handedOnStr: "", items: [] });
    expect(rows[3]).toMatchObject({ recordedAt: null, handedOn: null, handedOnStr: "" });
  });

  it("filters to a person on either side of the handover", async () => {
    await ledger();
    expect((await history(10, "S_003")).map((h) => h.handoverId)).toEqual(["H3", "H1"]);
    expect((await history(10, "S_002")).map((h) => h.handoverId)).toEqual(["H2", "H1", "H4"]);
    expect((await history(10, "S_001")).map((h) => h.handoverId)).toEqual(["H3"]);
    expect(await history(10, "S_999")).toEqual([]);
    expect(await history(10, 7)).toEqual([]);
    expect((await history(10, "")).length).toBe(4);
    expect((await history(10, null)).length).toBe(4);
  });

  it("limits as slice(0, limit || 25) did: 0 or none is 25, a decimal is truncated, a negative drops from the end", async () => {
    await ledger();
    const ids = async (limit: number | undefined) => (await history(limit)).map((h) => h.handoverId);
    expect(await ids(1)).toEqual(["H3"]);
    expect(await ids(2)).toEqual(["H3", "H2"]);
    expect(await ids(1.5)).toEqual(["H3"]);
    expect(await ids(0)).toHaveLength(4);
    expect(await ids(undefined)).toHaveLength(4);
    expect(await ids(-1)).toEqual(["H3", "H2", "H1"]);
    expect(await ids(-100)).toEqual([]);
    expect(await ids(Infinity)).toHaveLength(4);
    expect(await ids(NaN)).toHaveLength(4);
  });

  it("breaks a tie in the recorded time by the order the rows were written, newest first", async () => {
    await ledger();
    await seedHandover("H5", "S_003", "S_002", 1, { recorded_at: "2026-11-06T15:00:00Z", handed_on: "2026-11-06" });
    expect((await history(10)).map((h) => h.handoverId).slice(0, 3)).toEqual(["H3", "H5", "H2"]);
  });

  it("lists a handover's items in the allocation order a record wrote them (oldest shift first), not in id order", async () => {
    for (let d = 1; d <= 6; d++) await closed(`S${d}`, "S_003", `2026-11-0${d}`, 10);
    const r = await recordIn({ fromStaffId: "S_003", amount: 60, actorId: "S_003" });
    expect((await history(1))[0]!.items.map((i) => i.sessionId)).toEqual(r.itemsCreated.map((i) => i.sessionId));
    expect(r.itemsCreated.map((i) => i.sessionId)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
  });
});

// ── The page's payload ──────────────────────────────────────

describe("position", () => {
  it("is what one person needs, and the roster only for the privileged", async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    await seedHandover("H1", "S_004", "S_002", 10, { recorded_at: "2026-11-05T15:00:00Z" });
    const config = await loadConfig(db);
    const mine = await ch.getPosition(db, config, "S_003", false, NOW);
    expect(mine).toEqual({
      enabled: true,
      cashManager: { staffId: "S_002", name: "Bram Hale" },
      isCashManager: false,
      mine: await owedBy("S_003"),
      recent: [],
    });
    const priv = await ch.getPosition(db, config, "S_002", true, NOW);
    expect(priv).toMatchObject({ isCashManager: true, grandTotal: 500, staleDays: 7, grandByCompany: { cstore: 500 } });
    expect((priv as any).holders).toHaveLength(1);
    expect((priv as any).allRecent.map((h: any) => h.handoverId)).toEqual(["H1"]);
    expect((priv as any).recent.map((h: any) => h.handoverId)).toEqual(["H1"]); // the cash manager is a party to it
  });

  it("has no cash manager when none is configured or the one named is gone", async () => {
    const config = await loadConfig(db);
    expect(await ch.cashManager(db, Object.assign(config))).toMatchObject({ staffId: "S_002" });
    await setConfig({});
    expect(await ch.cashManager(db, await loadConfig(db))).toBeNull();
    await setConfig({ cash_manager_staff_id: "S_999" });
    expect(await ch.cashManager(db, await loadConfig(db))).toBeNull();
    await setConfig({ cash_manager_staff_id: "  S_002 " });
    expect(await ch.cashManager(db, await loadConfig(db))).toMatchObject({ staffId: "S_002" });
    expect((await ch.getPosition(db, await loadConfig(db), "S_003", false, NOW)).cashManager).toEqual({ staffId: "S_002", name: "Bram Hale" });
    await setConfig({});
    expect(await ch.getPosition(db, await loadConfig(db), "S_003", false, NOW)).toMatchObject({ cashManager: null, isCashManager: false });
    expect(await ch.sheetsExist(db)).toBe(true);
  });
});

// ── The five RPCs ───────────────────────────────────────────

describe("rpc guards (old: rpc-guards.js, cash sections)", () => {
  beforeEach(async () => {
    await closed("S1", "S_003", "2026-11-10", 500);
    await closed("S2", "S_004", "2026-11-10", 300);
  });

  it("refuses a call with no session (the router turns a missing or junk token into this)", async () => {
    for (const [h, args] of [
      [rpcGetCashPosition, []],
      [rpcRecordCashHandover, [{}]],
      [rpcVoidCashHandover, ["H1"]],
      [rpcGetCashOutstandingFor, ["S_003"]],
      [rpcGetCashHandoverHistory, [10]],
    ] as const) {
      await expect(rpc(h, null, [...args])).rejects.toThrow("NOT_LOGGED_IN");
    }
  });

  it("lets a cashier hand over their OWN cash, whoever the input names as the actor", async () => {
    const r = await rpc(rpcRecordCashHandover, CASHIER, [{ amount: 100, notes: "x", actorId: "S_001", recordedBy: "S_001" }]);
    expect(r).toMatchObject({ amount: 100, outstandingBefore: 500, outstandingAfter: 400 });
    expect((await history(1))[0]).toMatchObject({ fromStaffId: "S_003", recordedBy: "S_003" });
    expect((await audits())[0]).toMatchObject({ actor_id: "S_003" });
  });

  it("refuses a cashier handing over someone else's, before touching anything", async () => {
    await expect(rpc(rpcRecordCashHandover, CASHIER, [{ fromStaffId: "S_004", amount: 100 }])).rejects.toThrow(
      "FORBIDDEN: only the cashier, the cash manager, or an admin can record this handover",
    );
    await expect(rpc(rpcRecordCashHandover, PAYROLL, [{ fromStaffId: "S_004", amount: 100 }])).rejects.toThrow("FORBIDDEN: only the cashier");
    await expect(rpc(rpcRecordCashHandover, OTHER_MANAGER, [{ fromStaffId: "S_003", amount: 100 }])).rejects.toThrow("FORBIDDEN: only the cashier");
    expect(await count("cash_handovers")).toBe(0);
  });

  it("lets the configured cash manager, and an admin, record for anyone", async () => {
    await rpc(rpcRecordCashHandover, CASH_MANAGER, [{ fromStaffId: "S_003", amount: 100, notes: "x" }]);
    await rpc(rpcRecordCashHandover, ADMIN, [{ fromStaffId: "S_004", amount: 100, notes: "x" }]);
    expect((await history(5)).map((h) => [h.fromStaffId, h.recordedBy]).sort()).toEqual([
      ["S_003", "S_002"],
      ["S_004", "S_001"],
    ]);
    // The module still wants the actor to be the cashier, the recipient or an admin.
    await expect(rpc(rpcRecordCashHandover, CASH_MANAGER, [{ fromStaffId: "S_003", toStaffId: "S_004", amount: 10, notes: "x" }])).rejects.toThrow("Only Cleo Marsh, the cash manager, or an admin");
  });

  it("makes someone the cash manager by config, not by role", async () => {
    await setConfig({ cash_manager_staff_id: "S_006" });
    await rpc(rpcRecordCashHandover, PAYROLL, [{ fromStaffId: "S_003", amount: 100, notes: "x" }]);
    await expect(rpc(rpcRecordCashHandover, CASH_MANAGER, [{ fromStaffId: "S_003", amount: 100, notes: "x" }])).rejects.toThrow("FORBIDDEN");
  });

  it("answers the record with a flat, JSON-safe object", async () => {
    const r = await rpc(rpcRecordCashHandover, CASHIER, [{ amount: 500 }]);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(Object.keys(r).sort()).toEqual(["amount", "handoverId", "itemsCreated", "outstandingAfter", "outstandingBefore"]);
  });

  it("reads the page's amount the way the old RPC did: Number(input.amount), then the module's rounding", async () => {
    await expect(rpc(rpcRecordCashHandover, CASHIER, [{}])).rejects.toThrow("amount must be a positive number");
    await expect(rpc(rpcRecordCashHandover, CASHIER, [])).rejects.toThrow("amount must be a positive number");
    await expect(rpc(rpcRecordCashHandover, CASHIER, [null])).rejects.toThrow("amount must be a positive number");
    await expect(rpc(rpcRecordCashHandover, CASHIER, ["abc"])).rejects.toThrow("amount must be a positive number");
    await expect(rpc(rpcRecordCashHandover, CASHIER, [{ amount: "x", method: "bank" }])).rejects.toThrow("amount must be a positive number");
    await rpc(rpcRecordCashHandover, CASHIER, [{ amount: "100", notes: "x", method: "" }]);
    expect((await history(1))[0]).toMatchObject({ amount: 100, method: "cash" });
  });

  it("lets only the cash manager or an admin void; a plain manager and a cashier are refused; a role in the arguments is ignored", async () => {
    const id = (await rpc(rpcRecordCashHandover, ADMIN, [{ fromStaffId: "S_003", amount: 100, notes: "x" }])).handoverId;
    const forbidden = "FORBIDDEN: only the cash manager or an admin can void a handover";
    await expect(rpc(rpcVoidCashHandover, CASHIER, [id])).rejects.toThrow(forbidden);
    await expect(rpc(rpcVoidCashHandover, CASHIER, [id, { role: "admin" }])).rejects.toThrow(forbidden);
    await expect(rpc(rpcVoidCashHandover, OTHER_MANAGER, [id])).rejects.toThrow(forbidden);
    await expect(rpc(rpcVoidCashHandover, PAYROLL, [id])).rejects.toThrow(forbidden);
    await expect(rpc(rpcVoidCashHandover, CASHIER, [])).rejects.toThrow(forbidden);
    expect((await handoverRow(id)).status).toBe("recorded");
    expect(await rpc(rpcVoidCashHandover, CASH_MANAGER, [id])).toEqual({ handoverId: id, status: "voided", amount: 100 });
    const id2 = (await rpc(rpcRecordCashHandover, ADMIN, [{ fromStaffId: "S_003", amount: 100, notes: "x" }])).handoverId;
    expect((await rpc(rpcVoidCashHandover, ADMIN, [id2])).status).toBe("voided");
    await expect(rpc(rpcVoidCashHandover, ADMIN, [])).rejects.toThrow("handoverId required");
    await expect(rpc(rpcVoidCashHandover, ADMIN, ["H_nope"])).rejects.toThrow("Handover not found: H_nope");
    const voids = (await audits()).filter((a) => a.action === "cash.handover.void");
    expect(voids.map((a) => a.actor_id).sort()).toEqual(["S_001", "S_002"]);
  });

  it("gives your own balance to you, and anyone's to the cash manager or an admin only (old: another person's balance is privileged)", async () => {
    const mine = await rpc(rpcGetCashOutstandingFor, CASHIER, ["S_003"]);
    expect(mine).toMatchObject({ enabled: true, staffId: "S_003", totalOutstanding: 500 });
    expect(Object.keys(mine)).toEqual(["staffId", "totalOutstanding", "unsettledSessions", "enabled"]);
    const forbidden = "FORBIDDEN: only the cash manager or an admin can view another cashier's balance";
    await expect(rpc(rpcGetCashOutstandingFor, CASHIER, ["S_004"])).rejects.toThrow(forbidden);
    await expect(rpc(rpcGetCashOutstandingFor, CASHIER, [])).rejects.toThrow(forbidden);
    await expect(rpc(rpcGetCashOutstandingFor, PAYROLL, ["S_003"])).rejects.toThrow(forbidden);
    await expect(rpc(rpcGetCashOutstandingFor, OTHER_MANAGER, ["S_003"])).rejects.toThrow(forbidden);
    expect((await rpc(rpcGetCashOutstandingFor, CASH_MANAGER, ["S_003"])).totalOutstanding).toBe(500);
    expect((await rpc(rpcGetCashOutstandingFor, ADMIN, ["S_004"])).totalOutstanding).toBe(300);
    expect(await rpc(rpcGetCashOutstandingFor, ADMIN, ["S_999"])).toEqual({ staffId: "S_999", totalOutstanding: 0, unsettledSessions: [], enabled: true });
    await expect(rpc(rpcGetCashOutstandingFor, ADMIN, [])).rejects.toThrow("staffId required");
    await expect(rpc(rpcGetCashOutstandingFor, ADMIN, [""])).rejects.toThrow("staffId required");
  });

  it("gives the roster to the cash manager and admins only", async () => {
    const as = (who: Session) => rpc(rpcGetCashPosition, who, [], NOW);
    expect(await as(CASHIER)).not.toHaveProperty("holders");
    expect(await as(PAYROLL)).not.toHaveProperty("holders");
    expect(await as(OTHER_MANAGER)).not.toHaveProperty("holders");
    const cm = await as(CASH_MANAGER);
    expect(cm).toMatchObject({ enabled: true, isCashManager: true, grandTotal: 800 });
    expect((await as(ADMIN)).holders).toHaveLength(2);
    expect((await as(ADMIN)).isCashManager).toBe(false);
  });

  it("pins the history of anyone but the cash manager or an admin to their own rows", async () => {
    await seedHandover("H1", "S_003", "S_002", 10, { recorded_at: "2026-11-05T15:00:00Z" });
    await seedHandover("H2", "S_004", "S_002", 10, { recorded_at: "2026-11-06T15:00:00Z" });
    const ids = async (who: Session, args: unknown[]) => (await rpc(rpcGetCashHandoverHistory, who, args)).handovers.map((h: any) => h.handoverId);
    expect(await ids(CASHIER, [25, "S_004"])).toEqual(["H1"]);
    expect(await ids(CASHIER, [25])).toEqual(["H1"]);
    expect(await ids(PAYROLL, [25, "S_003"])).toEqual([]);
    expect(await ids(CASH_MANAGER, [25])).toEqual(["H2", "H1"]);
    expect(await ids(ADMIN, [25, "S_004"])).toEqual(["H2"]);
    expect(await ids(ADMIN, [25, ""])).toEqual(["H2", "H1"]);
    expect(await ids(ADMIN, ["1"])).toEqual(["H2"]);
    expect(await ids(ADMIN, [0])).toEqual(["H2", "H1"]);
    expect(await ids(ADMIN, ["abc"])).toEqual(["H2", "H1"]);
    expect(await ids(ADMIN, [-1])).toEqual(["H2"]);
    expect(await rpc(rpcGetCashHandoverHistory, ADMIN, [1])).toMatchObject({ enabled: true });
  });

  it("changes nothing when it only reads", async () => {
    const before = [await count("audit_log"), await count("cash_handovers")];
    await rpc(rpcGetCashPosition, ADMIN, []);
    await rpc(rpcGetCashOutstandingFor, ADMIN, ["S_003"]);
    await rpc(rpcGetCashHandoverHistory, ADMIN, [5]);
    expect([await count("audit_log"), await count("cash_handovers")]).toEqual(before);
  });
});
