// The audit log screen's call (card P4-13): rpcGetAuditLog, against a real database with invented people.
// It exists only in the Operations app (ADR-0023): there is nothing to compare with, so these tests ARE the
// specification. They cover who may call (through the real router), paging (newest first by `seq`, no
// offset, nothing shifts when rows arrive), each filter alone and combined, every refusal, the masking of
// what a row may hold (phone numbers, secret-looking keys) and what must NOT be touched (ids, amounts,
// dates), that reading changes nothing, and that the module has no statement that writes.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setPin } from "../src/auth/pin";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import * as audit from "../src/lib/audit";
import { loadConfig } from "../src/lib/config";
import * as auditView from "../src/modules/audit-view";
import * as settings from "../src/modules/settings";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { rpcGetAuditLog } from "../src/rpc/handlers/audit-view";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

const PEPPER = "test-pepper-not-a-secret";
const NOW = new Date("2026-11-20T14:00:00Z");

const contract = parseRpcContract(
  mergeOpsContract(
    JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
    JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
  ),
);

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

const STAFF: Array<[string, string, string, string]> = [
  ["S_001", "Ada Quill", "admin", "1111"],
  ["S_002", "Bram Hale", "manager", "2222"],
  ["S_003", "Cleo Marsh", "employee", "3333"],
  ["S_004", "Dara Vance", "payroll_admin", "4444"],
];

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  owner = await connect(testDb.ownerUrl);
  for (const [id, name, role, pin] of STAFF) {
    await owner.query("insert into ops.staff (staff_id, name, active, role, companies_authorized) values ($1, $2, true, $3, 'cstore,vape')", [id, name, role]);
    await setPin(db, id, pin, PEPPER);
  }
});
afterAll(async () => {
  await db?.close();
  await owner?.close();
  await testDb?.drop();
});
beforeEach(async () => {
  await owner.query("delete from ops.audit_log");
  await owner.query("delete from ops.config");
  await owner.query("delete from ops.sessions");
  await owner.query("delete from ops.login_failures");
});

const ADMIN: Session = { staffId: "S_001", name: "Ada Quill", role: "admin", companiesAuthorized: ["cstore", "vape"], expiresAt: 0 };

function ctxFor(tx: Db, session: RpcContext["session"] = ADMIN, at = NOW): RpcContext {
  let cfg: ReturnType<typeof loadConfig> | undefined;
  return {
    db: tx as RpcContext["db"],
    session,
    config: () => (cfg ??= loadConfig(tx)),
    env: { PIN_PEPPER: PEPPER },
    fetch: (() => {
      throw new Error("no network in this test");
    }) as typeof fetch,
    now: at,
  };
}
/** The handler the way the router runs it: one transaction. */
const rpc = (input?: unknown, session: RpcContext["session"] = ADMIN) => withTransaction(db, async (tx) => (await rpcGetAuditLog(ctxFor(tx, session), input)) as auditView.AuditPageOut);
/** The module directly, on the app role's connection. */
const page = (input?: unknown) => auditView.page(db, input);

/** Write one row the way a module does. Rows written with the same `at` share a time, as one change's rows do. */
const put = (e: Partial<audit.AuditEntry> & { action: string }, at: Date = NOW) => audit.write(owner, { actorId: "S_001", ...e }, { now: at });
const everything = () => owner.query<Record<string, unknown>>('select seq::text as seq_text, log_id, "timestamp", actor_id, action, target_type, target_id, "before", "after", details from ops.audit_log order by seq');

// ── Who may call ────────────────────────────────────────────

describe("who may call", () => {
  const router = createRpcRouter({
    contract,
    handlers,
    openDb: () => connect(testDb.appUrl),
    resolveSession,
    errorPrefixed: ERROR_PREFIXED,
    env: { PIN_PEPPER: PEPPER },
    now: () => NOW,
    log: () => undefined,
  });
  async function call(name: string, args: unknown[]) {
    const res = await router(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
    return { status: res.status, body: (await res.json()) as { ok: boolean; result?: any; error?: { message: string } } };
  }
  async function token(name: string, pin: string): Promise<string> {
    return (await call("rpcLogin", [name, pin])).body.result.token as string;
  }

  it("the contract lists it for admin only, with a session, params token and input", () => {
    expect(contract.get("rpcGetAuditLog")).toMatchObject({ roles: ["admin"], needs_session: true, migrate: true, params: ["token", "input"] });
  });

  it("an admin is answered", async () => {
    await put({ action: "till.correct", targetType: "till_sessions", targetId: "TS_1" });
    const t = await token("Ada Quill", "1111");
    const got = await call("rpcGetAuditLog", [t, {}]);
    expect(got.body.ok).toBe(true);
    // The sign-in is itself a row: login.success is the newest, the planted row is below it.
    expect(got.body.result.rows.map((r: any) => r.action)).toEqual(["login.success", "till.correct"]);
    expect(got.body.result.total).toBeNull();
  });

  it.each([
    ["a manager", "Bram Hale", "2222", "manager"],
    ["an employee", "Cleo Marsh", "3333", "employee"],
    ["a payroll admin", "Dara Vance", "4444", "payroll_admin"],
  ])("%s is refused, and sees no row", async (_who, name, pin, role) => {
    await put({ action: "till.correct" });
    const t = await token(name, pin);
    const r = await call("rpcGetAuditLog", [t, {}]);
    expect(r.body).toEqual({ ok: false, error: { message: `FORBIDDEN: requires admin, got ${role}` } });
  });

  it("no token, or a made-up one, is NOT_LOGGED_IN", async () => {
    expect((await call("rpcGetAuditLog", [])).body.error?.message).toBe("NOT_LOGGED_IN");
    expect((await call("rpcGetAuditLog", ["nope", {}])).body.error?.message).toBe("NOT_LOGGED_IN");
  });

  it("a role or an actor planted in the input changes nothing", async () => {
    const t = await token("Cleo Marsh", "3333");
    const planted = await call("rpcGetAuditLog", [t, { role: "admin", actorId: "S_001", session: { role: "admin" }, staffId: "S_001" }]);
    expect(planted.body.error?.message).toBe("FORBIDDEN: requires admin, got employee");
  });

  it("the handler checks the role itself too, in case the contract is ever wrong", async () => {
    for (const role of ["manager", "employee", "payroll_admin"]) {
      await expect(rpc({}, { ...ADMIN, staffId: "S_003", role: role as Session["role"] })).rejects.toThrow(`FORBIDDEN: requires admin, got ${role}`);
    }
    await expect(rpc({}, null)).rejects.toThrow("NOT_LOGGED_IN");
  });

  it("reading the log writes nothing: no row is added by any read", async () => {
    await put({ action: "till.correct" });
    const before = await owner.query("select count(*)::int as n from ops.audit_log");
    await rpc({});
    await rpc({ action: "till." });
    await expect(rpc({ day: "nonsense" })).rejects.toThrow();
    expect(await owner.query("select count(*)::int as n from ops.audit_log")).toEqual(before);
  });
});

// ── Paging ──────────────────────────────────────────────────

describe("paging", () => {
  it("150 rows in three pages of 50: newest first, none twice, none missed, nextBefore is null at the end", async () => {
    await audit.writeMany(owner, Array.from({ length: 150 }, (_, i) => ({ actorId: "S_001", action: "till.edit", targetType: "till_sessions", targetId: `TS_${i}`, details: `row ${i}` })), { now: NOW });
    const seen: number[] = [];
    let before: number | null | undefined;
    const sizes: number[] = [];
    for (let n = 0; n < 5; n++) {
      const p: auditView.AuditPageOut = await rpc(before === undefined ? {} : { before });
      sizes.push(p.rows.length);
      seen.push(...p.rows.map((r) => r.seq));
      if (p.nextBefore === null) break;
      expect(p.nextBefore).toBe(p.rows[p.rows.length - 1]?.seq);
      before = p.nextBefore;
    }
    expect(sizes).toEqual([50, 50, 50]);
    expect(seen).toHaveLength(150);
    expect(new Set(seen).size).toBe(150);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
    const all = await owner.query<{ seq: string }>("select seq::text as seq from ops.audit_log order by ops.audit_log.seq desc");
    expect(seen).toEqual(all.map((r) => Number(r.seq)));
  });

  it("the default page is 50, a limit up to 100 is allowed, and 150 rows with limit 100 give nextBefore", async () => {
    await audit.writeMany(owner, Array.from({ length: 150 }, (_, i) => ({ actorId: "S_001", action: "till.edit", details: String(i) })), { now: NOW });
    expect((await rpc({})).rows).toHaveLength(50);
    const big = await rpc({ limit: 100 });
    expect(big.rows).toHaveLength(100);
    expect(big.nextBefore).toBe(big.rows[99]?.seq);
    expect((await rpc({ limit: 1 })).rows).toHaveLength(1);
  });

  it("exactly one page of rows has no next page", async () => {
    await audit.writeMany(owner, Array.from({ length: 50 }, () => ({ actorId: "S_001", action: "till.edit" })), { now: NOW });
    const p = await rpc({});
    expect(p.rows).toHaveLength(50);
    expect(p.nextBefore).toBeNull();
  });

  it("rows that arrive between two page reads do not shift the next page", async () => {
    await audit.writeMany(owner, Array.from({ length: 120 }, (_, i) => ({ actorId: "S_001", action: "till.edit", details: `old ${i}` })), { now: NOW });
    const first = await rpc({});
    await audit.writeMany(owner, Array.from({ length: 7 }, (_, i) => ({ actorId: "S_001", action: "till.edit", details: `new ${i}` })), { now: NOW });
    const second = await rpc({ before: first.nextBefore });
    // Without the new rows the second page is rows 51 to 100 of the old ones, whatever arrived.
    expect(second.rows.map((r) => r.details)).toEqual(Array.from({ length: 50 }, (_, i) => `old ${119 - 50 - i}`));
    const fresh = await rpc({});
    expect(fresh.rows.slice(0, 7).map((r) => r.details)).toEqual(["new 6", "new 5", "new 4", "new 3", "new 2", "new 1", "new 0"].slice(0, 7));
  });

  it("order is by seq, never by time: a row written later with an earlier time still comes first", async () => {
    await put({ action: "a.first", details: "written first, newest time" }, new Date("2026-11-20T15:00:00Z"));
    await put({ action: "a.second", details: "written second, oldest time" }, new Date("2026-11-20T09:00:00Z"));
    await put({ action: "a.third", details: "written third, same time as the first" }, new Date("2026-11-20T15:00:00Z"));
    expect((await rpc({})).rows.map((r) => r.action)).toEqual(["a.third", "a.second", "a.first"]);
  });

  it("rows of one transaction share a time and still come in the order they were written", async () => {
    await audit.writeMany(owner, ["x.one", "x.two", "x.three", "x.four"].map((action) => ({ actorId: "S_001", action })), { now: NOW });
    const rows = (await rpc({})).rows;
    expect(new Set(rows.map((r) => r.at)).size).toBe(1);
    expect(rows.map((r) => r.action)).toEqual(["x.four", "x.three", "x.two", "x.one"]);
  });

  it("before may be given as a number or as digits, and nothing is shown at or after it", async () => {
    await audit.writeMany(owner, Array.from({ length: 5 }, (_, i) => ({ actorId: "S_001", action: "till.edit", details: String(i) })), { now: NOW });
    const all = (await rpc({})).rows;
    const third = all[2] as auditView.AuditRowOut;
    expect((await rpc({ before: third.seq })).rows.map((r) => r.seq)).toEqual(all.slice(3).map((r) => r.seq));
    expect((await rpc({ before: String(third.seq) })).rows.map((r) => r.seq)).toEqual(all.slice(3).map((r) => r.seq));
  });
});

// ── The shape of a row ──────────────────────────────────────

describe("each row", () => {
  it("is answered with the documented fields, the time as an ISO instant, before and after as the stored JSON and details as text", async () => {
    await put({ actorId: "S_001", action: "till.correct", targetType: "till_sessions", targetId: "TS_9", before: { session: { cashSales: 10 } }, after: { session: { cashSales: 12.5 } }, details: "miscounted the coins" });
    const [row] = (await rpc({})).rows;
    expect(row).toEqual({
      seq: expect.any(Number),
      at: "2026-11-20T14:00:00.000Z",
      actorId: "S_001",
      actorName: "Ada Quill",
      action: "till.correct",
      targetType: "till_sessions",
      targetId: "TS_9",
      before: { session: { cashSales: 10 } },
      after: { session: { cashSales: 12.5 } },
      details: "miscounted the coins",
    });
  });

  it("a row with no before, after, details, target or actor is answered with nulls", async () => {
    await audit.write(owner, { action: "staff.pin_set" }, { now: NOW });
    const [row] = (await rpc({})).rows;
    expect(row).toMatchObject({ actorId: null, actorName: null, targetType: null, targetId: null, before: null, after: null, details: null });
  });

  it("who: a staff name, System for SYSTEM, the Monday run for SYSTEM_TRIGGER, and the id itself when the person is unknown", async () => {
    await put({ actorId: "S_003", action: "x.one" });
    await put({ actorId: "SYSTEM", action: "x.two" });
    await put({ actorId: "SYSTEM_TRIGGER", action: "x.three" });
    await put({ actorId: "S_GONE", action: "x.four" });
    const rows = (await rpc({})).rows;
    expect(rows.map((r) => [r.actorId, r.actorName])).toEqual([
      ["S_GONE", "S_GONE"],
      ["SYSTEM_TRIGGER", "System (Monday run)"],
      ["SYSTEM", "System"],
      ["S_003", "Cleo Marsh"],
    ]);
  });

  it("before or after that is not JSON (an old row) comes back as masked text, not an error", async () => {
    await owner.query(`insert into ops.audit_log (log_id, "timestamp", actor_id, action, "before", "after") values ('LOG_OLD_1', $1, 'S_001', 'old.row', 'not json 4165550199', '{broken')`, [NOW]);
    const [row] = (await rpc({})).rows;
    expect(row).toMatchObject({ before: "not json ••••••0199", after: "{broken" });
  });

  it("total is null: the table is never counted", async () => {
    await put({ action: "x.one" });
    expect((await rpc({})).total).toBeNull();
  });
});

// ── Filters ─────────────────────────────────────────────────

describe("filters", () => {
  async function seed() {
    await put({ actorId: "S_001", action: "staff.update", targetType: "staff", targetId: "S_003" }, new Date("2026-11-19T15:00:00Z"));
    await put({ actorId: "S_001", action: "staff.pin_set", targetType: "staff", targetId: "S_004" }, new Date("2026-11-19T16:00:00Z"));
    await put({ actorId: "S_002", action: "till.correct", targetType: "till_sessions", targetId: "TS_1" }, new Date("2026-11-20T15:00:00Z"));
    await put({ actorId: "SYSTEM", action: "commissions.run_skipped", targetType: "commission_week", targetId: "2026-11-09" }, new Date("2026-11-20T16:00:00Z"));
    await put({ actorId: "S_001", action: "config.update", targetType: "config", targetId: "session_hours" }, new Date("2026-11-21T03:00:00Z")); // 22:00 on the 20th in Toronto
  }
  const actions = async (input: object) => (await rpc(input)).rows.map((r) => r.action).reverse();

  it("actorId: a staff id, or SYSTEM", async () => {
    await seed();
    expect(await actions({ actorId: "S_002" })).toEqual(["till.correct"]);
    expect(await actions({ actorId: "SYSTEM" })).toEqual(["commissions.run_skipped"]);
    expect(await actions({ actorId: "S_001" })).toEqual(["staff.update", "staff.pin_set", "config.update"]);
    expect(await actions({ actorId: "S_NOBODY" })).toEqual([]);
  });

  it("action: exact, or a prefix that ends in a dot", async () => {
    await seed();
    expect(await actions({ action: "staff.update" })).toEqual(["staff.update"]);
    expect(await actions({ action: "staff." })).toEqual(["staff.update", "staff.pin_set"]);
    expect(await actions({ action: "staff" })).toEqual([]); // exact, and there is no action called "staff"
    expect(await actions({ action: "till." })).toEqual(["till.correct"]);
    expect(await actions({ action: "commissions." })).toEqual(["commissions.run_skipped"]);
  });

  it("a prefix is a prefix, not a pattern: an underscore matches itself", async () => {
    await put({ action: "a_b.one" });
    await put({ action: "axb.one" });
    expect(await actions({ action: "a_b." })).toEqual(["a_b.one"]);
  });

  it("targetType and targetId: exact", async () => {
    await seed();
    expect(await actions({ targetType: "staff" })).toEqual(["staff.update", "staff.pin_set"]);
    expect(await actions({ targetType: "staff", targetId: "S_004" })).toEqual(["staff.pin_set"]);
    expect(await actions({ targetId: "S_00" })).toEqual([]);
    expect(await actions({ targetId: "TS_1" })).toEqual(["till.correct"]);
  });

  it("day: the Toronto day the row was written (22:00 on the 20th is the 20th, though it is the 21st in UTC)", async () => {
    await seed();
    expect(await actions({ day: "2026-11-20" })).toEqual(["till.correct", "commissions.run_skipped", "config.update"]);
    expect(await actions({ day: "2026-11-19" })).toEqual(["staff.update", "staff.pin_set"]);
    expect(await actions({ day: "2026-11-21" })).toEqual([]);
  });

  it("day on the two clock-change days: the day is 23 hours in spring and 25 hours in autumn", async () => {
    // Spring: Sunday 8 March 2026. Toronto midnight is 05:00Z; the next midnight is 04:00Z of the 9th (EDT).
    await put({ action: "t.before", details: "mar 7 23:59:59" }, new Date("2026-03-08T04:59:59Z"));
    await put({ action: "t.first", details: "mar 8 00:00:00" }, new Date("2026-03-08T05:00:00Z"));
    await put({ action: "t.last", details: "mar 8 23:59:59 EDT" }, new Date("2026-03-09T03:59:59Z"));
    await put({ action: "t.after", details: "mar 9 00:00:00 EDT" }, new Date("2026-03-09T04:00:00Z"));
    expect(await actions({ day: "2026-03-08" })).toEqual(["t.first", "t.last"]);
    expect(await actions({ day: "2026-03-09" })).toEqual(["t.after"]);
    // Autumn: Sunday 1 November 2026. Midnight is 04:00Z; the next midnight is 05:00Z of the 2nd (EST).
    await put({ action: "n.before" }, new Date("2026-11-01T03:59:59Z"));
    await put({ action: "n.first" }, new Date("2026-11-01T04:00:00Z"));
    await put({ action: "n.repeat" }, new Date("2026-11-01T06:30:00Z")); // 01:30 EST, the second 01:30
    await put({ action: "n.last" }, new Date("2026-11-02T04:59:59Z"));
    await put({ action: "n.after" }, new Date("2026-11-02T05:00:00Z"));
    expect(await actions({ day: "2026-11-01", action: "n." })).toEqual(["n.first", "n.repeat", "n.last"]);
    expect(await actions({ day: "2026-11-02", action: "n." })).toEqual(["n.after"]);
    expect(await actions({ day: "2026-10-31", action: "n." })).toEqual(["n.before"]);
  });

  it("combined with AND, and with paging", async () => {
    await seed();
    expect(await actions({ actorId: "S_001", action: "staff.", day: "2026-11-19" })).toEqual(["staff.update", "staff.pin_set"]);
    expect(await actions({ actorId: "S_001", action: "staff.", day: "2026-11-20" })).toEqual([]);
    expect(await actions({ actorId: "S_001", targetType: "staff", targetId: "S_004", action: "staff.pin_set", day: "2026-11-19" })).toEqual(["staff.pin_set"]);
    const first = await rpc({ actorId: "S_001", limit: 2 });
    expect(first.rows.map((r) => r.action)).toEqual(["config.update", "staff.pin_set"]);
    const second = await rpc({ actorId: "S_001", limit: 2, before: first.nextBefore });
    expect(second.rows.map((r) => r.action)).toEqual(["staff.update"]);
    expect(second.nextBefore).toBeNull();
  });

  it("blank filters are ignored", async () => {
    await seed();
    expect(await actions({ actorId: "", action: "", targetType: null, targetId: "  ", day: "", before: "", limit: null })).toHaveLength(5);
    expect(await rpc(undefined)).toMatchObject({ rows: expect.any(Array) });
    expect(await rpc(null)).toMatchObject({ rows: expect.any(Array) });
  });
});

// ── Refusals ────────────────────────────────────────────────

describe("what is refused", () => {
  const SQL_WORDS = /syntax|relation|column|pg_|postgres|operator|invalid input|violates|ops\.|select |\$1/i;
  async function refuses(input: unknown, message: RegExp) {
    let thrown: Error | undefined;
    try {
      await rpc(input);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown, JSON.stringify(input)).toBeDefined();
    expect(thrown?.message).toMatch(message);
    expect(thrown?.message).not.toMatch(SQL_WORDS);
  }

  it.each([
    ["uppercase", "TILL.CORRECT"],
    ["a space", "till correct"],
    ["a quote", "till'"],
    ["a quote and a comment", "' or 1=1 --"],
    ["a percent sign", "till.%"],
    ["a dash", "till-correct"],
    ["a semicolon", "x;drop table ops.audit_log"],
    ["61 characters", "a".repeat(61)],
    ["a newline", "till.\ncorrect"],
    ["non-ASCII letters", "tïll."],
  ])("an action with %s is refused with a message, not run", async (_why, action) => {
    await refuses({ action }, /action must be lower-case letters, digits, _ and \. only/);
  });

  it("an action of exactly 60 characters is allowed", async () => {
    expect((await rpc({ action: "a".repeat(60) })).rows).toEqual([]);
  });

  it.each(["2026-02-30", "2026-13-01", "2026-00-10", "20261120", "2026-1-5", "tomorrow", "2026-11-20T10:00", "2026-11-20; drop", "0000-00-00", " 2026-11-31 "])("the day %j is refused", async (day) => {
    await refuses({ day }, /day must be a real date written yyyy-mm-dd/);
  });

  it("a leap day is a real day, in a leap year only", async () => {
    expect(await rpc({ day: "2028-02-29" })).toMatchObject({ rows: [] });
    await refuses({ day: "2026-02-29" }, /real date/);
  });

  it.each([0, -1, 101, 1.5, "10", "x", NaN, {}, []])("the limit %j is refused", async (limit) => {
    await refuses({ limit }, /limit must be a whole number from 1 to 100/);
  });

  it.each([0, -5, 1.5, "abc", "1 or 1=1", "0", "99999999999999999999", {}, [], true])("before %j is refused", async (before) => {
    await refuses({ before }, /before must be the number of the last row/);
  });

  it.each([
    ["actorId", 5],
    ["actorId", { a: 1 }],
    ["targetType", ["x"]],
    ["targetId", 12],
    ["action", 7],
    ["day", 20261120],
  ])("a %s that is not text (%j) is refused", async (name, value) => {
    await refuses({ [name]: value }, /must be text|real date|lower-case/);
  });

  it("text filters longer than 200 characters are refused", async () => {
    await refuses({ targetId: "x".repeat(201) }, /targetId must be 200 characters or fewer/);
    await refuses({ actorId: "x".repeat(201) }, /actorId must be 200 characters or fewer/);
  });

  it("a question that is not an object is refused", async () => {
    await refuses("till.", /must be an object/);
    await refuses(["x"], /must be an object/);
    await refuses(5, /must be an object/);
  });

  it("an action that looks like SQL is never executed, and the log is untouched", async () => {
    await put({ action: "till.correct" });
    const before = await everything();
    for (const action of ["' or 1=1 --", "'; delete from ops.audit_log; --", "x' union select 1,2,3 --", "till.correct' or action like '%"]) {
      await expect(rpc({ action })).rejects.toThrow(/action must be/);
    }
    expect(await everything()).toEqual(before);
  });

  it("a text filter that looks like SQL is matched literally: no row, no error, the log untouched", async () => {
    await put({ action: "till.correct", targetType: "till_sessions", targetId: "TS_1" });
    await put({ action: "till.edit", targetType: "till_sessions", targetId: "x' or '1'='1" });
    const before = await everything();
    const hostile = ["' or 1=1 --", "x' or '1'='1", "'; delete from ops.audit_log; --", "%", "_", "TS_1' --"];
    for (const v of hostile) {
      for (const name of ["actorId", "targetType", "targetId"]) {
        const p = await rpc({ [name]: v });
        // The only way a hostile value finds a row is by being the row's own text.
        expect(p.rows.every((r) => (r as any)[name] === v), `${name}=${v}`).toBe(true);
      }
    }
    expect((await rpc({ targetId: "x' or '1'='1" })).rows.map((r) => r.action)).toEqual(["till.edit"]);
    expect(await everything()).toEqual(before);
  });

  it("every value goes to SQL as a parameter: the statement text holds none of what was asked", async () => {
    const seen: Array<{ text: string; params: readonly unknown[] }> = [];
    const spy: Db = {
      query: async (t, p) => (seen.push({ text: t, params: p ?? [] }), db.query(t, p)),
      one: (t, p) => db.one(t, p),
      maybeOne: (t, p) => db.maybeOne(t, p),
    };
    await auditView.page(spy, { actorId: "S_001", action: "till.correct", targetType: "till_sessions", targetId: "TS_1' or 1=1", before: 99999, day: "2026-11-20", limit: 7 });
    const main = seen[0] as { text: string; params: readonly unknown[] };
    for (const needle of ["S_001", "till.correct", "till_sessions", "TS_1", "1=1", "99999", "2026-11-20"]) expect(main.text, needle).not.toContain(needle);
    expect(main.params).toEqual(expect.arrayContaining(["S_001", "till.correct", "till_sessions", "TS_1' or 1=1", "99999"]));
    expect(main.params).toContain(8); // limit + 1: one more row than shown tells whether there is a next page
    expect(main.params.filter((p) => p instanceof Date)).toHaveLength(2);
  });
});

// ── Masking ─────────────────────────────────────────────────

describe("masking: a phone number is shown by its last four digits", () => {
  const masked: Array<[string, string]> = [
    ["4165550199", "••••••0199"],
    ["14165550199", "•••••••0199"],
    ["+14165550199", "•••••••0199"],
    ["+1 416 555 0199", "•••••••0199"],
    ["416-555-0199", "••••••0199"],
    ["416 555 0199", "••••••0199"],
    ["(416) 555-0199", "••••••0199"],
    ["+1 (416) 555-0199", "•••••••0199"],
    ["1-416-555-0199", "•••••••0199"],
    ["call 416.555.0199", "call ••••••0199"], // dots between three groups: a phone number, not an amount
    ["call 416.555.0199.", "call ••••••0199."],
    ["12345678", "••••5678"], // eight digits
    ["123456789012345", "•••••••••••2345"], // fifteen digits
    ["14165550199,14169998888", "•••••••0199,•••••••8888"],
    ["to 4165550199.", "to ••••••0199."],
    ["WhatsApp shift-open NOT sent — 14165550199 http_401: bad token (code 190)", "WhatsApp shift-open NOT sent — •••••••0199 http_401: bad token (code 190)"],
    ["(call me on 416 555 0199 please)", "(call me on ••••••0199 please)"],
    ["rang 4165550199 and 4165550123", "rang ••••••0199 and ••••••0123"],
    ["2026-11-20 14165550199", "2026-11-20 •••••••0199"],
    ["•••••••0199", "•••••••0199"], // already masked by the Settings card
  ];
  it.each(masked)("%j is shown as %j", (input, expected) => {
    expect(auditView.maskText(input)).toBe(expected);
  });

  it("works through a row: before, after (nested, in arrays), details and the target id", async () => {
    await put({
      action: "staff.update",
      targetType: "staff",
      targetId: "4165550199",
      before: { notes: "ring 416-555-0199", list: [{ phone: "+14165550199" }, "call 14165550123"], amount: 12345678 },
      after: { notes: "none" },
      details: "was 416 555 0199",
    });
    const [row] = (await rpc({})).rows;
    expect(row).toMatchObject({
      targetId: "••••••0199",
      before: { notes: "ring ••••••0199", list: [{ phone: "•••••••0199" }, "call •••••••0123"], amount: 12345678 },
      details: "was ••••••0199",
    });
  });

  it("the target id of a session row (a few characters of a sign-in token) is never masked, whatever it holds", async () => {
    await put({ action: "login.logout", targetType: "session", targetId: "12345678..." });
    expect((await rpc({})).rows[0]?.targetId).toBe("12345678...");
  });
});

describe("masking: ids, amounts, dates and numbers of other kinds are NOT touched", () => {
  const untouched = [
    // ids the app writes
    "PAY_20261120_ab1",
    "LOG_20261120_140000_a1b2c3d4e5",
    "A_20261120_S_001",
    "CST-20261120-S_003",
    "VAP-20261120-S_001",
    "TS_20261120_140000_x9z",
    "BON_20261120_091500_k3q",
    "RUN_20260921_090000_p0w",
    "S_001",
    "S_ASH",
    "CR_001",
    "KEY_20261120_123456_ab12cd34ef",
    "12345678-1234-1234-1234-123456789012",
    "SES_1234567890",
    "LOG_20261120_140000_1234567890",
    "TILL-1234567890",
    "S_00012345678",
    // hashes and tokens of other things
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "a1234567890b",
    "abcdef12345678",
    "12345678abcd",
    "abcd12345678",
    "12345678_x",
    // amounts
    "1234567.89",
    "$12345678.50",
    "0.12345678",
    "12345678.0",
    "Unallocated $1,234.56 after walking shifts — INVESTIGATE",
    "Paid $950.00 to Cleo Marsh",
    "Partial — $100.00 of $250.00",
    "-12345678.5",
    // dates and times
    "2026-11-20",
    "2026-11-20 14:30:00",
    "2026-11-20T14:00:00.000Z",
    "2026-09-21 2026-09-27",
    "Week 2026-09-21 to 2026-09-27: 3 bonuses totalling 360",
    "20261120",
    "19991231",
    // business and other numbers
    "123456789 RT0001",
    "123456789RT0001",
    "HST 123456789 RT 0001",
    "1234567",
    "1234567890123456",
    "12 34 56 7",
    "staff 7 of 12 on 3 shifts",
    "rate 18.5 to 19.75",
    "S_001 changed the rate of S_003 from 18.5 to 19.75",
    "Reverted due to payment undo",
  ];
  it.each(untouched)("%j is not changed", (s) => {
    expect(auditView.maskText(s)).toBe(s);
  });

  it("numbers in the JSON itself are never touched, whatever their size", () => {
    const v = { amount: 12345678, n: 1234567890123, ratio: 0.12345678, list: [20261120, 41655501990] };
    expect(auditView.maskValue(v)).toEqual(v);
  });

  // A value of each kind a writer puts in a row, as the writers build them (read from ops/src).
  const REAL: Array<[string, unknown]> = [
    ["till.open", { staffId: "S_003", company: "cstore", openingFloat: 250, attendanceId: "A_20261120_S_003" }],
    ["till.close", { status: "closed", cashSales: 1234.5, variance: -2.25, closedAt: "2026-11-20T22:05:00.000Z" }],
    ["till.correct", { session: { sessionId: "TS_20261120_090000_a1b", date: "2026-11-20", staffId: "S_003", lottoReserveCounted: 500 }, sales: { salesId: "TS_20261120_090000_a1b", cashSales: 1234.5 } }],
    ["till.enter_missed", { staffId: "S_003", date: "2026-11-18", company: "vape", sessionId: "TS_20261118_220000_zz9" }],
    ["sales.update", { cashSales: 1200, creditCardSales: 300.5, debitCardSales: 10, cashbackPaid: 0 }],
    ["payment.shifts", { staffId: "S_003", amount: 412.5, itemCount: 2, attendanceIds: ["A_20261118_S_003", "A_20261119_S_003"] }],
    ["payment.bonus", { staffId: "S_003", bonusId: "BON_20261120_091500_k3q", amount: 120, bonusType: "commission", fullyPaid: true }],
    ["payment.undo", { staffId: "S_003", amount: 412.5, itemCount: 2 }],
    ["bonus.proposed", { staffId: "S_003", type: "commission", amount: 120, status: "proposed", reason: "Commission Fee: 2026-09-21 to 2026-09-27, 12 sales of $10.00 each" }],
    ["commission.run", { weekStart: "2026-09-21", weekEnd: "2026-09-27", bonusesCreated: 1, totalAmount: 120, staffCount: 1 }],
    ["commissions.run_skipped", { weekStart: "2026-11-09", weekEnd: "2026-11-15" }],
    ["attendance.schedule", { staffId: "S_003", date: "2026-11-21", scheduledStart: "2026-11-21T14:00:00.000Z", scheduledEnd: "2026-11-21T22:00:00.000Z" }],
    ["attendance.edit_times", { actualStart: "2026-11-20T14:02:00.000Z", actualEnd: "2026-11-20T22:01:00.000Z", hoursWorked: 7.98 }],
    ["attendance.correct", { attendanceId: "A_20261120_S_003", hoursWorked: 8, rateAtAttendance: 18.5, status: "worked" }],
    ["cash.handover", { handoverId: "HO_20261120_221000_c4d", amount: 1180.25, fromStaffId: "S_003", toStaffId: "S_001", sessionIds: ["TS_20261120_090000_a1b"] }],
    ["reconcile.day", { date: "2026-11-20", cstoreVariance: -1.5, vapeVariance: 0.25, cloverTotal: 2345.67 }],
    ["staff.update", { staffId: "S_003", name: "Cleo Marsh", role: "employee", companies: ["cstore", "vape"], active: true, hourlyRate: 18.5, startDate: "2025-03-01", email: "cleo.marsh@example.com", notes: "Weekends only", createdAt: "2025-03-01T15:00:00.000Z" }],
    ["staff.rate_applied", { applyRateFrom: "2026-11-16", oldRate: 18.5, newRate: 19.75, owedBefore: 148, owedAfter: 158, days: [{ attendanceId: "A_20261116_S_003", date: "2026-11-16", hours: 8, rateBefore: 18.5 }], skippedPaid: [{ date: "2026-11-10", paid: 148 }] }],
    ["assistant_key.create", { staffId: "S_001", label: "Priya's Muse", right: "propose", personalDetails: false, expiresAt: "2027-02-18T14:00:00.000Z" }],
    ["config.update", { value: "12" }],
    ["login.success", "session created"],
    ["login.fail", "rate_limited: 59min"],
    ["notify.payment.recorded", "💰 Paid $412.50 to Cleo Marsh"],
    ["notify.shift_open_failed", "WhatsApp shift-open NOT sent — 14165550199 http_131047: Re-engagement message (code 131047)"],
    ["payment.allocation_error", "Unallocated $0.01 after walking shifts — INVESTIGATE"],
  ];
  it.each(REAL.filter(([a]) => a !== "notify.shift_open_failed"))("a realistic %s payload comes out unchanged", (_action, payload) => {
    expect(auditView.maskValue(payload)).toEqual(payload);
  });
  it("a failed WhatsApp send holds a recipient in full: only that number is masked", () => {
    expect(auditView.maskText(REAL.find(([a]) => a === "notify.shift_open_failed")?.[1] as string)).toBe("WhatsApp shift-open NOT sent — •••••••0199 http_131047: Re-engagement message (code 131047)");
  });

  it("email addresses and pay rates are shown as they are", async () => {
    await put({ action: "staff.update", targetType: "staff", targetId: "S_003", before: { email: "cleo.marsh@example.com", hourlyRate: 18.5 }, after: { email: "cleo@example.org", hourlyRate: 19.75 }, details: "raise from 2026-11-16" });
    const [row] = (await rpc({})).rows;
    expect(row).toMatchObject({ before: { email: "cleo.marsh@example.com", hourlyRate: 18.5 }, after: { email: "cleo@example.org", hourlyRate: 19.75 }, details: "raise from 2026-11-16" });
  });
});

describe("masking: a key that looks like a secret has its value hidden, at any depth", () => {
  const SECRETS = ["pinHash", "pin_hash", "pin", "PIN", "newPin", "token", "sessionToken", "apiKey", "api_key", "key", "secret", "clientSecret", "password", "passwordHash", "hash", "tokenHash", "keyHash"];
  it.each(SECRETS)("the key %s is hidden", (key) => {
    expect(auditView.maskValue({ [key]: "9f86d081884c7d65" })).toEqual({ [key]: "[hidden]" });
  });
  it.each(["staffId", "label", "right", "amount", "keyId", "keyboard", "pending", "rights", "personalDetails", "expiresAt", "name", "applyRateFrom"])("the key %s is not hidden", (key) => {
    expect(auditView.maskValue({ [key]: "visible" })).toEqual({ [key]: "visible" });
  });
  it("whatever the value holds: text, a number, an object, an array, null (a plain yes/no is the one thing shown)", () => {
    expect(auditView.maskValue({ pinHash: { a: 1 }, token: [1, 2], apiKey: 12345, secret: null, password: "true" })).toEqual({
      pinHash: "[hidden]",
      token: "[hidden]",
      apiKey: "[hidden]",
      secret: "[hidden]",
      password: "[hidden]",
    });
  });
  it("at any depth, in objects and arrays", () => {
    const planted = { a: { b: [{ c: { pinHash: "x", ok: 1 } }, [{ token: "t" }]], staffId: "S_1" }, list: [{ apiKey: "k" }] };
    expect(auditView.maskValue(planted)).toEqual({ a: { b: [{ c: { pinHash: "[hidden]", ok: 1 } }, [{ token: "[hidden]" }]], staffId: "S_1" }, list: [{ apiKey: "[hidden]" }] });
  });
  it("a very deep value does not run away", () => {
    let deep: unknown = "end";
    for (let i = 0; i < 200; i++) deep = { n: deep };
    expect(JSON.stringify(auditView.maskValue(deep))).toContain("[too deep]");
  });
  it("a planted row is hidden through the RPC, in before and after, and the stored row is untouched", async () => {
    await put({
      action: "staff.update",
      targetType: "staff",
      targetId: "S_003",
      before: { staffId: "S_003", pinHash: "pbkdf2$100000$abc$def", nested: { sessionToken: "tok-1234" } },
      after: { staffId: "S_003", pinHash: "pbkdf2$100000$ghi$jkl", keys: [{ apiKey: "sk-live-1" }] },
    });
    const stored = await everything();
    const [row] = (await rpc({})).rows;
    expect(row?.before).toEqual({ staffId: "S_003", pinHash: "[hidden]", nested: { sessionToken: "[hidden]" } });
    expect(row?.after).toEqual({ staffId: "S_003", pinHash: "[hidden]", keys: [{ apiKey: "[hidden]" }] });
    expect(JSON.stringify(await rpc({}))).not.toMatch(/pbkdf2|tok-1234|sk-live/);
    expect(await everything()).toEqual(stored);
    expect(String(stored[0]?.["before"])).toContain("pbkdf2$100000$abc$def"); // the stored row still has it: only the answer is masked
  });
  it("a yes/no under such a key (hasPin) is shown: it is a flag about a secret, not the secret; anything else under the same key is hidden", () => {
    expect(auditView.maskValue({ hasPin: true })).toEqual({ hasPin: true });
    expect(auditView.maskValue({ hasPin: false, nested: { hasPin: true } })).toEqual({ hasPin: false, nested: { hasPin: true } });
    expect(auditView.maskValue({ hasPin: "1234" })).toEqual({ hasPin: "[hidden]" });
    expect(auditView.maskValue({ hasPin: 1234 })).toEqual({ hasPin: "[hidden]" });
    expect(auditView.maskValue({ pin: null, token: { a: 1 } })).toEqual({ pin: "[hidden]", token: "[hidden]" });
  });
});

describe("the log is read, never changed", () => {
  it("the stored rows are byte-identical after any number of reads, with masks and filters on", async () => {
    await put({ action: "staff.update", targetId: "S_003", before: { pinHash: "x", notes: "416-555-0199" }, details: "4165550199" });
    await put({ action: "till.correct", before: { a: 1 }, after: { a: 2 } });
    const before = await everything();
    for (let i = 0; i < 5; i++) {
      await rpc({});
      await rpc({ action: "staff.", day: "2026-11-20", actorId: "S_001" });
      await page({ limit: 1 });
    }
    expect(await everything()).toEqual(before);
  });

  it("the module has no statement that writes, and takes no lock", () => {
    const source = readFileSync(new URL("../src/modules/audit-view.ts", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n");
    expect(source).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|create|grant|copy)\b/i);
    expect(source).not.toMatch(/for\s+(update|share|no key)|pg_advisory|\block\b|\bbegin\b|\bcommit\b/i);
    expect(source).not.toMatch(/\baudit\.write|\bwriteMany\b|withTransaction/);
    const handler = readFileSync(new URL("../src/rpc/handlers/audit-view.ts", import.meta.url), "utf8");
    expect(handler).not.toMatch(/audit\.write|writeMany|\.query\(/);
  });

  it("every statement it runs is a select", async () => {
    await put({ action: "x.one" });
    const seen: string[] = [];
    const spy: Db = {
      query: async (t, p) => (seen.push(t), db.query(t, p)),
      one: async (t, p) => (seen.push(t), db.one(t, p)),
      maybeOne: async (t, p) => (seen.push(t), db.maybeOne(t, p)),
    };
    await auditView.page(spy, { action: "x.", day: "2026-11-20" });
    expect(seen).toHaveLength(3);
    for (const s of seen) expect(s.trim().toLowerCase().startsWith("select")).toBe(true);
  });
});

// ── A story ─────────────────────────────────────────────────

describe("a day's rows for one target, read in order, make sense", () => {
  it("a till corrected twice and a person's rate changed: newest first, each second `before` is the first `after`", async () => {
    const t = (hhmm: string) => new Date(`2026-11-20T${hhmm}:00Z`);
    const till = (cash: number) => ({ session: { sessionId: "TS_20261120_090000_a1b", status: "closed" }, sales: { cashSales: cash } });
    // The till is closed with 1000, corrected to 1020, then to 1015.
    await put({ actorId: "S_003", action: "till.close", targetType: "till_sessions", targetId: "TS_20261120_090000_a1b", after: till(1000) }, t("13:00"));
    await put({ actorId: "S_001", action: "till.correct", targetType: "till_sessions", targetId: "TS_20261120_090000_a1b", before: till(1000), after: till(1020), details: "Counted the rolls twice" }, t("15:00"));
    // The rate changes in the middle, through the real Settings module and the real staff update shape.
    await put({ actorId: "S_001", action: "staff.update", targetType: "staff", targetId: "S_003", before: { hourlyRate: 18.5 }, after: { hourlyRate: 19.75 }, details: "Annual review" }, t("15:30"));
    await put({ actorId: "S_001", action: "till.correct", targetType: "till_sessions", targetId: "TS_20261120_090000_a1b", before: till(1020), after: till(1015), details: "Five dollars of coupons" }, t("16:00"));

    const tillRows = (await rpc({ targetType: "till_sessions", targetId: "TS_20261120_090000_a1b", day: "2026-11-20" })).rows;
    expect(tillRows.map((r) => r.action)).toEqual(["till.correct", "till.correct", "till.close"]);
    expect(tillRows.map((r) => r.details)).toEqual(["Five dollars of coupons", "Counted the rolls twice", null]);
    // Newest first: the second correction's before is the first correction's after, which is the close's... corrected.
    expect(tillRows[0]?.before).toEqual(tillRows[1]?.after);
    expect(tillRows[1]?.before).toEqual(tillRows[2]?.after);

    const rate = (await rpc({ targetType: "staff", targetId: "S_003" })).rows;
    expect(rate).toHaveLength(1);
    expect(rate[0]).toMatchObject({ actorName: "Ada Quill", before: { hourlyRate: 18.5 }, after: { hourlyRate: 19.75 }, details: "Annual review" });

    // The whole day, newest first, is the order the things happened in, reversed.
    expect((await rpc({ day: "2026-11-20" })).rows.map((r) => r.action)).toEqual(["till.correct", "staff.update", "till.correct", "till.close"]);
  });

  it("two edits of one setting made through the real module chain: the second `before` is the first `after`", async () => {
    const edit = (value: string, at: Date) => withTransaction(db, (tx) => settings.update(tx, { key: "session_hours", value, actorId: "S_001" }, { now: at }));
    await edit("12", new Date("2026-11-20T14:00:00Z"));
    await edit("8", new Date("2026-11-20T14:00:00Z")); // the same instant: only seq can order them
    const rows = (await rpc({ targetType: "config", targetId: "session_hours" })).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ action: "config.update", before: { value: "12" }, after: { value: "8" } });
    expect(rows[1]).toMatchObject({ before: { value: null }, after: { value: "12" } });
    expect(rows[0]?.before).toEqual(rows[1]?.after);
  });

  it("the whatsapp recipients setting is masked once by the Settings card and stays so here", async () => {
    await withTransaction(db, (tx) => settings.update(tx, { key: "whatsapp_target_number", value: "14165550199, 14169998888", actorId: "S_001" }, { now: NOW }));
    const [row] = (await rpc({ targetId: "whatsapp_target_number" })).rows;
    expect(row?.after).toEqual({ value: "•••••••0199,•••••••8888", count: 2 });
    expect(JSON.stringify(row)).not.toMatch(/4165550199|4169998888/);
  });
});

// ── The lists for the filter controls ───────────────────────

describe("actions and actors", () => {
  it("the distinct actions present, sorted, and the people who appear with their names", async () => {
    await put({ actorId: "S_003", action: "till.close" });
    await put({ actorId: "S_001", action: "config.update" });
    await put({ actorId: "S_003", action: "till.close" });
    await put({ actorId: "SYSTEM", action: "commissions.run_skipped" });
    await put({ actorId: "S_GONE", action: "staff.update" });
    const p = await rpc({ limit: 1 });
    expect(p.actions).toEqual(["commissions.run_skipped", "config.update", "staff.update", "till.close"]);
    expect(p.actors).toEqual([
      { id: "S_001", name: "Ada Quill" },
      { id: "S_003", name: "Cleo Marsh" },
      { id: "S_GONE", name: "S_GONE" },
      { id: "SYSTEM", name: "System" },
    ]);
  });

  it("the lists do not depend on the filters or the page (so a person can change a filter)", async () => {
    await put({ actorId: "S_003", action: "till.close" });
    await put({ actorId: "S_001", action: "config.update" });
    const all = await rpc({});
    const filtered = await rpc({ actorId: "S_001", action: "config.update" });
    expect(filtered.actions).toEqual(all.actions);
    expect(filtered.actors).toEqual(all.actors);
  });

  it("they look at the newest rows only: a bound, not a scan of the whole table", async () => {
    expect(auditView.LISTS_WINDOW).toBe(20_000);
    const seen: string[] = [];
    const spy: Db = { query: async (t, p) => (seen.push(t), db.query(t, p)), one: (t, p) => db.one(t, p), maybeOne: (t, p) => db.maybeOne(t, p) };
    await auditView.page(spy, {});
    expect(seen.filter((s) => /order by seq desc limit 20000/.test(s))).toHaveLength(2);
  });

  it("an empty log is answered with empty lists", async () => {
    expect(await rpc({})).toEqual({ rows: [], nextBefore: null, total: null, actions: [], actors: [] });
  });
});
