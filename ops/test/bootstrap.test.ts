// rpcGetBootstrap and rpcGetMyShiftState (card P3-05c): modules/shift-state.ts and the two handlers
// of handlers/bootstrap.ts, against a real database with invented people.
//
// Old-suite assertions: tests/suites/ has none about these two RPCs (grep for both names in tests/
// finds nothing: wiring.js, rpc-guards.js, perf.js and shopping-gate.js never call them), so there is
// nothing to port; this file pins what the old body did instead, and the parity cases compare it.
// What the parity fixture cannot show is here: a person authorised for one till only, more than ten
// recent sessions, a shift state that fails (bootstrap keeps `me`), the query count, the router's
// error text for each RPC.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../src/auth/types";
import { connect, DbError, type Db } from "../src/db/client";
import { withTransaction, type Tx } from "../src/db/tx";
import { loadConfig } from "../src/lib/config";
import { rpcGetBootstrap, rpcGetMyShiftState } from "../src/rpc/handlers/bootstrap";
import { parseRpcContract } from "../src/rpc/contract";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

// Friday 20 November 2026, 10:30 Toronto (UTC-5).
const NOW = new Date("2026-11-20T15:30:00Z");

const STAFF: Array<[string, string, string, string]> = [
  ["S_001", "Ada Quill", "admin", "cstore,vape"],
  ["S_002", "Bram Hale", "manager", "cstore,vape"],
  ["S_003", "Cleo Marsh", "employee", "cstore,vape"],
  ["S_004", "Dara Vance", "employee", "vape"],
  ["S_005", "Eli Stone", "employee", "cstore,vape"],
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
  for (const t of ["audit_log", "cash_handover_items", "cash_handovers", "sales", "till_sessions", "attendance", "staff", "config"]) await owner.query(`delete from ops.${t}`);
  for (const [id, name, role, companies] of STAFF) await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized) values ($1,$2,18,true,$3,$4)", [id, name, role, companies]);
  await setConfig({ cstore_default_opening_float: "250", vape_default_opening_float: "100", lotto_reserve_default: "500", cash_manager_staff_id: "S_002" });
});

async function setConfig(rows: Record<string, string>): Promise<void> {
  await owner.query("delete from ops.config");
  for (const [k, v] of Object.entries(rows)) await owner.query("insert into ops.config (key, value) values ($1, $2)", [k, v]);
}

const session = (staffId: string): Session => {
  const s = STAFF.find((r) => r[0] === staffId) as (typeof STAFF)[number];
  return { staffId, name: s[1], role: s[2] as Session["role"], companiesAuthorized: s[3].split(","), expiresAt: 0 };
};

function ctxFor(tx: Tx, who: Session | null, now: Date = NOW, extra: Partial<RpcContext> = {}): RpcContext {
  return { db: tx, session: who, config: () => loadConfig(tx), env: {}, fetch: () => Promise.reject(new Error("no network in this test")), now, ...extra };
}
async function rpc(handler: (ctx: RpcContext, ...a: unknown[]) => unknown, who: Session | null, args: unknown[] = [], now: Date = NOW, extra: Partial<RpcContext> = {}): Promise<any> {
  return withTransaction(db, async (tx) => handler(ctxFor(tx, who, now, extra), ...args));
}

/** A day and a till session written straight in: history, not an open or close under test. */
async function seedSession(o: { id: string; staffId: string; company: string; date: string; status: string; start: string; end?: string | null; variance?: number | null; varStatus?: string | null; removed?: number; float?: number; counted?: number | null; topup?: number }) {
  const att = `A_${o.date.replace(/-/g, "")}_${o.staffId}`;
  await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ($1, $2, $3, 'worked') on conflict do nothing", [att, o.staffId, o.date]);
  await owner.query(
    `insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time, end_time, opening_float, closing_variance, variance_status, cash_removed_at_close, lotto_reserve_counted, lotto_topup_from_till)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [o.id, att, o.staffId, o.company, o.date, o.status, o.start, o.end ?? null, o.float ?? 100, o.variance ?? null, o.varStatus ?? null, o.removed ?? null, o.counted ?? null, o.topup ?? 0],
  );
}
const closed = (id: string, staffId: string, company: string, date: string, extra: Record<string, unknown> = {}) =>
  seedSession({ id, staffId, company, date, status: "closed", start: `${date}T13:00:00Z`, end: `${date}T21:00:00Z`, ...extra } as any);

describe("rpcGetMyShiftState", () => {
  it("nothing open anywhere: two closed cards with the settings, today's date, nothing else", async () => {
    const r = await rpc(rpcGetMyShiftState, session("S_003"));
    expect(r).toEqual({
      today: "2026-11-20",
      cards: [
        { company: "cstore", state: "closed", authorized: true, expectedFloat: 250, cardSplit: true, detail: null },
        { company: "vape", state: "closed", authorized: true, expectedFloat: 100, cardSplit: true, detail: null },
      ],
      todaySummary: null,
      lotto: { enabled: true, expected: 500, lastCounted: null, lastCountedDate: null, diagnostic: { sessions: 0, cstore: 0, closed: 0, withCount: 0, newestSession: null, newestCell: null }, entries: [] },
      cashInHand: { total: 0, shifts: 0, oldest: "", managerName: "Bram Hale" },
      recentTill: [],
    });
  });

  it("my open till, someone else's open till (by name), a till I am not authorised for", async () => {
    await seedSession({ id: "VAP-20261120-S_004", staffId: "S_004", company: "vape", date: "2026-11-20", status: "open", start: "2026-11-20T13:05:00Z", float: 92.5 });
    await seedSession({ id: "CST-20261120-S_003", staffId: "S_003", company: "cstore", date: "2026-11-20", status: "open", start: "2026-11-20T13:02:00Z" });
    const mine = await rpc(rpcGetMyShiftState, session("S_004"));
    expect(mine.cards).toEqual([
      { company: "cstore", state: "open_by_other", authorized: false, expectedFloat: 250, cardSplit: true, detail: { staffName: "Cleo Marsh", startTime: "2026-11-20T13:02:00.000Z" } },
      { company: "vape", state: "open_by_me", authorized: true, expectedFloat: 100, cardSplit: true, detail: { sessionId: "VAP-20261120-S_004", startTime: "2026-11-20T13:05:00.000Z", openingFloat: 92.5 } },
    ]);
    // Today's attendance exists (the seed made it): in the summary, with two sessions open and none closed.
    expect(mine.todaySummary).toEqual({ attendanceId: "A_20261120_S_004", status: "worked", actualStart: null, actualEnd: null, hoursWorked: 0, sessionsOpen: 1, sessionsClosed: 0 });
    const theirs = await rpc(rpcGetMyShiftState, session("S_003"));
    expect(theirs.cards.map((c: any) => [c.company, c.state])).toEqual([["cstore", "open_by_me"], ["vape", "open_by_other"]]);
    expect(theirs.cards[1].detail).toEqual({ staffName: "Dara Vance", startTime: "2026-11-20T13:05:00.000Z" });
  });

  it("the card-split settings and floats are read as the old code read them", async () => {
    await setConfig({ cstore_card_split: " FALSE ", vape_card_split: "", cstore_default_opening_float: "lots", vape_default_opening_float: "75.5" });
    const r = await rpc(rpcGetMyShiftState, session("S_003"));
    expect(r.cards.map((c: any) => [c.cardSplit, c.expectedFloat])).toEqual([[false, 0], [true, 75.5]]);
  });

  it("identity is the session: a staff id in the arguments changes nothing", async () => {
    await closed("VAP-20261119-S_003", "S_003", "vape", "2026-11-19");
    const own = await rpc(rpcGetMyShiftState, session("S_003"));
    const asked = await rpc(rpcGetMyShiftState, session("S_003"), [{ staffId: "S_004" }, "S_004"]);
    expect(asked).toEqual(own);
    expect(own.recentTill).toHaveLength(1);
    const other = await rpc(rpcGetMyShiftState, session("S_004"), [{ staffId: "S_003" }]);
    expect(other.recentTill).toEqual([]);
  });

  it("recent shifts: mine only, closed or validated, the last 7 days to the end of today, newest start first, at most ten", async () => {
    // Twelve closed vape days for S_003 (Nov 8 to 19) plus S_004's, an open one, and one 8 days old.
    for (let d = 8; d <= 19; d++) {
      const day = `2026-11-${String(d).padStart(2, "0")}`;
      await closed(`VAP-${day.replace(/-/g, "")}-S_003`, "S_003", "vape", day, { variance: d === 19 ? -12.4 : null, varStatus: d === 19 ? "minor" : null });
    }
    await closed("VAP-20261119-S_004", "S_004", "vape", "2026-11-19");
    await seedSession({ id: "VAP-20261120-S_003", staffId: "S_003", company: "vape", date: "2026-11-20", status: "validated", start: "2026-11-20T13:00:00Z", end: "2026-11-20T14:00:00Z", variance: 0.5, varStatus: "OK" });
    await seedSession({ id: "CST-20261120-S_003", staffId: "S_003", company: "cstore", date: "2026-11-20", status: "open", start: "2026-11-20T13:30:00Z" });
    const r = await rpc(rpcGetMyShiftState, session("S_003"));
    const ids = r.recentTill.map((s: any) => s.sessionId);
    // 13..19 are inside 7 days (13 is exactly 7 days back), 12 and earlier are not; the validated one of today comes first.
    expect(ids).toEqual(["VAP-20261120-S_003", "VAP-20261119-S_003", "VAP-20261118-S_003", "VAP-20261117-S_003", "VAP-20261116-S_003", "VAP-20261115-S_003", "VAP-20261114-S_003", "VAP-20261113-S_003"]);
    expect(r.recentTill[0]).toEqual({ sessionId: "VAP-20261120-S_003", company: "vape", date: "2026-11-20", startTime: "2026-11-20T13:00:00.000Z", endTime: "2026-11-20T14:00:00.000Z", variance: 0.5, varianceStatus: "OK" });
    // A blank variance reads as 0 (the old `|| 0`) and a blank status as null.
    expect(r.recentTill[2]).toMatchObject({ sessionId: "VAP-20261118-S_003", variance: 0, varianceStatus: null });
    expect(r.recentTill[1]).toMatchObject({ variance: -12.4, varianceStatus: "minor" });
  });

  it("the list stops at ten", async () => {
    for (let i = 0; i < 12; i++) {
      const id = `VAP-2026111${i < 5 ? 6 : i < 10 ? 7 : 8}-S_003-${i}`;
      await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ($1, 'S_003', '2026-11-18', 'worked') on conflict do nothing", ["A_20261118_S_003"]);
      await owner.query("insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time) values ($1, 'A_20261118_S_003', 'S_003', 'vape', '2026-11-18', 'closed', $2)", [id, new Date(Date.UTC(2026, 10, 18, 10, i)).toISOString()]);
    }
    const r = await rpc(rpcGetMyShiftState, session("S_003"));
    expect(r.recentTill).toHaveLength(10);
    expect(r.recentTill[0].sessionId).toBe("VAP-20261118-S_003-11");
  });

  it("today comes from the call's clock in Toronto: 21:30 on the 20th is still the 20th, 00:30 on the 21st is the 21st", async () => {
    await closed("VAP-20261120-S_003", "S_003", "vape", "2026-11-20");
    expect((await rpc(rpcGetMyShiftState, session("S_003"), [], new Date("2026-11-21T02:30:00Z"))).today).toBe("2026-11-20");
    const next = await rpc(rpcGetMyShiftState, session("S_003"), [], new Date("2026-11-21T05:30:00Z"));
    expect(next.today).toBe("2026-11-21");
    expect(next.todaySummary).toBeNull();
    expect(next.recentTill.map((s: any) => s.sessionId)).toEqual(["VAP-20261120-S_003"]);
  });

  it("today's summary: times as ISO strings, hours as stored, open and closed counted from the day's sessions", async () => {
    await owner.query(
      "insert into ops.attendance (attendance_id, staff_id, date, status, actual_start, actual_end, hours_worked) values ('A_20261120_S_003','S_003','2026-11-20','in_progress','2026-11-20T13:02:00Z',null,null)",
    );
    for (const [id, company, status] of [["CST-20261120-S_003", "cstore", "open"], ["VAP-20261120-S_003", "vape", "closed"]]) {
      await owner.query("insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time) values ($1,'A_20261120_S_003','S_003',$2,'2026-11-20',$3,'2026-11-20T13:02:00Z')", [id, company, status]);
    }
    const r = await rpc(rpcGetMyShiftState, session("S_003"));
    expect(r.todaySummary).toEqual({ attendanceId: "A_20261120_S_003", status: "in_progress", actualStart: "2026-11-20T13:02:00.000Z", actualEnd: null, hoursWorked: 0, sessionsOpen: 1, sessionsClosed: 1 });
  });

  it("lotto: the log names people, the last count is kept apart from the window; never counted is null, not 0", async () => {
    await closed("CST-20261119-S_005", "S_005", "cstore", "2026-11-19", { counted: 420, topup: 80 });
    await closed("CST-20261118-S_004", "S_003", "cstore", "2026-11-18", { counted: 500 });
    const r = await rpc(rpcGetMyShiftState, session("S_004"));
    expect(r.lotto).toEqual({
      enabled: true,
      expected: 500,
      lastCounted: 420,
      lastCountedDate: "2026-11-19",
      diagnostic: null,
      entries: [
        { date: "2026-11-19", staffName: "Eli Stone", counted: 420, shortfall: 80, topup: 80, note: "" },
        { date: "2026-11-18", staffName: "Cleo Marsh", counted: 500, shortfall: 0, topup: 0, note: "" },
      ],
    });
  });

  it("cash in hand: what I carry, the number of shifts, the oldest day, the manager's name (null when there is none)", async () => {
    await closed("VAP-20261117-S_003", "S_003", "vape", "2026-11-17", { removed: 150 });
    await closed("CST-20261119-S_003", "S_003", "cstore", "2026-11-19", { removed: 200.25 });
    await closed("VAP-20261119-S_004", "S_004", "vape", "2026-11-19", { removed: 99 });
    expect((await rpc(rpcGetMyShiftState, session("S_003"))).cashInHand).toEqual({ total: 350.25, shifts: 2, oldest: "2026-11-17", managerName: "Bram Hale" });
    await setConfig({ cash_manager_staff_id: "S_999" });
    expect((await rpc(rpcGetMyShiftState, session("S_004"))).cashInHand).toEqual({ total: 99, shifts: 1, oldest: "2026-11-19", managerName: null });
  });

  it("blank is not zero: a till nobody counted has no lastCounted, an open session's blank variance is not shown as a figure", async () => {
    await seedSession({ id: "CST-20261119-S_003", staffId: "S_003", company: "cstore", date: "2026-11-19", status: "closed", start: "2026-11-19T13:00:00Z", end: "2026-11-19T21:00:00Z", counted: null });
    const r = await rpc(rpcGetMyShiftState, session("S_003"));
    expect(r.lotto.lastCounted).toBeNull();
    expect(r.lotto.lastCountedDate).toBeNull();
    expect(r.lotto.diagnostic).toMatchObject({ cstore: 1, closed: 1, withCount: 0, newestSession: "CST-20261119-S_003", newestCell: "blank (string)" });
    expect(r.lotto.entries).toEqual([]);
  });

  it("the answer is plain JSON: no Date, nothing undefined, no row indexes", async () => {
    await seedSession({ id: "CST-20261120-S_003", staffId: "S_003", company: "cstore", date: "2026-11-20", status: "open", start: "2026-11-20T13:02:00Z" });
    await closed("VAP-20261119-S_003", "S_003", "vape", "2026-11-19", { removed: 10 });
    const r = await rpc(rpcGetMyShiftState, session("S_003"));
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    expect(JSON.stringify(r)).not.toContain("_rowIndex");
  });

  it("no session: refused as the old code refused", async () => {
    await expect(rpc(rpcGetMyShiftState, null)).rejects.toThrow("NOT_LOGGED_IN");
  });
});

describe("rpcGetBootstrap", () => {
  it("me from the session and the same shift state, nothing else", async () => {
    await closed("VAP-20261119-S_004", "S_004", "vape", "2026-11-19", { removed: 20 });
    const b = await rpc(rpcGetBootstrap, session("S_004"));
    expect(Object.keys(b).sort()).toEqual(["me", "shift"]);
    expect(b.me).toEqual({ staffId: "S_004", name: "Dara Vance", role: "employee", companiesAuthorized: ["vape"] });
    expect(b.shift).toEqual(await rpc(rpcGetMyShiftState, session("S_004")));
    // Nothing about the deprecated features (shopping list, suppliers, order catalogue, product master).
    expect(JSON.stringify(b)).not.toMatch(/shopping|supplier|catalog|product/i);
  });

  it("each person gets their own, never another's", async () => {
    await closed("VAP-20261119-S_003", "S_003", "vape", "2026-11-19", { removed: 77 });
    const a = await rpc(rpcGetBootstrap, session("S_003"));
    const b = await rpc(rpcGetBootstrap, session("S_005"));
    expect(a.me.staffId).toBe("S_003");
    expect(a.shift.cashInHand.total).toBe(77);
    expect(b.me.staffId).toBe("S_005");
    expect(b.shift.cashInHand.total).toBe(0);
    expect(b.shift.recentTill).toEqual([]);
  });

  it("if the shift state cannot be built, `me` still comes back and shift is null", async () => {
    const b = await rpc(rpcGetBootstrap, session("S_003"), [], NOW, { config: () => Promise.reject(new Error("settings unreadable")) });
    expect(b).toEqual({ me: { staffId: "S_003", name: "Cleo Marsh", role: "employee", companiesAuthorized: ["cstore", "vape"] }, shift: null });
  });

  it("a database error is not swallowed (the transaction is already lost)", async () => {
    const boom = () => Promise.reject(new DbError("other", { code: "XX000" }));
    await expect(rpc(rpcGetBootstrap, session("S_003"), [], NOW, { config: boom as any })).rejects.toBeInstanceOf(DbError);
  });

  it("no session: refused", async () => {
    await expect(rpc(rpcGetBootstrap, null)).rejects.toThrow("NOT_LOGGED_IN");
  });
});

describe("query count (these run on every page load)", () => {
  /** The call's transaction, counting every statement it sends. */
  async function count(handler: (ctx: RpcContext) => unknown, who: Session): Promise<number> {
    return withTransaction(db, async (tx) => {
      let n = 0;
      const counting = {
        query: (t: string, p?: readonly unknown[]) => (n++, tx.query(t, p)),
        one: (t: string, p?: readonly unknown[]) => (n++, tx.one(t, p)),
        maybeOne: (t: string, p?: readonly unknown[]) => (n++, tx.maybeOne(t, p)),
      } as unknown as Tx;
      await handler(ctxFor(counting, who));
      return n;
    });
  }

  it("does not grow with the data: the same for 4 sessions as for 40, and small", async () => {
    const seedDays = async (from: number, to: number) => {
      for (let d = from; d <= to; d++) {
        const day = `2026-11-${String(d).padStart(2, "0")}`;
        for (const [staffId, company] of [["S_003", "cstore"], ["S_004", "vape"]] as const) {
          await closed(`${company === "cstore" ? "CST" : "VAP"}-${day.replace(/-/g, "")}-${staffId}`, staffId, company, day, { removed: 10, counted: company === "cstore" ? 480 : null });
        }
      }
    };
    await seedDays(18, 19);
    await seedSession({ id: "CST-20261120-S_005", staffId: "S_005", company: "cstore", date: "2026-11-20", status: "open", start: "2026-11-20T13:00:00Z" });
    const few = await count(rpcGetMyShiftState, session("S_003"));
    await seedDays(1, 17);
    const many = await count(rpcGetMyShiftState, session("S_003"));
    expect(many).toBe(few);
    expect(many).toBeLessThanOrEqual(14);
    expect(await count(rpcGetBootstrap, session("S_003"))).toBe(many);
  });

  it("pinned: 13 statements with no attendance today, 14 with one", async () => {
    expect(await count(rpcGetMyShiftState, session("S_003"))).toBe(13);
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ('A_20261120_S_003','S_003','2026-11-20','scheduled')");
    expect(await count(rpcGetMyShiftState, session("S_003"))).toBe(14);
  });
});

describe("through the router", () => {
  const contract = parseRpcContract(JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")));
  it("the old error texts: rpcGetMyShiftState is prefixed, rpcGetBootstrap is not", async () => {
    expect(ERROR_PREFIXED.has("rpcGetMyShiftState")).toBe(true);
    expect(ERROR_PREFIXED.has("rpcGetBootstrap")).toBe(false);
    const r = createRpcRouter({ contract, handlers, openDb: () => connect(testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env: {}, now: () => NOW, log: () => undefined });
    const call = async (name: string, args: unknown[]) => (await r(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }))).json();
    expect(await call("rpcGetMyShiftState", ["no-such-token"])).toEqual({ ok: false, error: { message: "rpcGetMyShiftState: NOT_LOGGED_IN" } });
    expect(await call("rpcGetBootstrap", ["no-such-token"])).toEqual({ ok: false, error: { message: "NOT_LOGGED_IN" } });
  });
});
