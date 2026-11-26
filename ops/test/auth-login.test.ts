// login / logout against a real database, compared step by step with the REAL src/Auth.gs
// and src/Staff.gs loaded in Node (the oracle). Only Google services are stubbed:
// PropertiesService (a Map), SpreadsheetApp (staff and config tabs as arrays), CacheService
// (always a miss), Utilities (a fixed uuid) and AuditLog (collects entries).
// The people are fictional; PINs and the pepper are obviously fake.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, type Db } from "../src/db/client";
import * as pinModule from "../src/auth/pin";
import { setPin } from "../src/auth/pin";
import { login, logout, type LoginDeps } from "../src/auth/login";
import { validateSession } from "../src/auth/sessions";
import { Config, loadConfig } from "../src/lib/config";
import { createTestDb, type TestDb } from "./helpers/db";
import { loadOldUtil } from "./_old-util";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const PEPPER = "test-pepper-not-a-secret";
const MIN = 60_000;
const BASE = Date.UTC(2026, 5, 15, 16, 0, 0);

interface Person { id: string; name: string; active: boolean; role: string; companies: string | null; pin: string | null }
const PEOPLE: Person[] = [
  { id: "S1", name: "Asha Example", active: true, role: "admin", companies: " cstore , vape", pin: "4821" },
  { id: "S2", name: "Ben Sample", active: true, role: "employee", companies: null, pin: "1357" },
  { id: "S3", name: "Cara Gone", active: false, role: "manager", companies: "cstore", pin: "2468" },
  { id: "S4", name: "Dev Nopin", active: true, role: "employee", companies: "vape", pin: null },
];

// ---- the oracle: the real Auth.gs + Staff.gs ----------------------------------------------------
interface OldAudit { actorId?: string; action: string; targetType?: string; targetId?: string; details?: string }
function makeOracle(configRows: Array<[string, string]>) {
  let nowMs = BASE;
  const props = new Map<string, string>();
  const audit: OldAudit[] = [];
  const tab = (rows: unknown[][]) => ({
    getLastRow: () => rows.length + 2,
    getRange: (r: number, c: number, nr: number, nc: number) => ({
      getValues: () => rows.slice(r - 3, r - 3 + nr).map((row) => Array.from({ length: nc }, (_, i) => row[c - 1 + i] ?? "")),
    }),
  });
  const tabs: Record<string, unknown> = {
    staff: tab(PEOPLE.map((p) => [p.id, p.name, 0, p.active, p.role, p.pin ?? "", p.companies ?? "", "", "", "", ""])),
    config: tab(configRows),
  };
  const globals = {
    SHEETS: { STAFF: "staff", CONFIG: "config" },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: (n: string) => tabs[n] }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => undefined, remove: () => undefined }) },
  };
  const OldDate = { now: () => nowMs };
  const Staff = new Function("SHEETS", "SpreadsheetApp", "CacheService", readFileSync(`${SRC}/Staff.gs`, "utf8") + "\n;return Staff;")(
    globals.SHEETS, globals.SpreadsheetApp, globals.CacheService,
  );
  const { Util } = loadOldUtil();
  const Auth = new Function(
    "PropertiesService", "CacheService", "SpreadsheetApp", "SHEETS", "Util", "AuditLog", "Staff", "Date",
    readFileSync(`${SRC}/Auth.gs`, "utf8") + "\n;return Auth;",
  )(
    { getScriptProperties: () => ({ getProperty: (k: string) => props.get(k) ?? null, setProperty: (k: string, v: string) => void props.set(k, v), deleteProperty: (k: string) => void props.delete(k) }) },
    globals.CacheService, globals.SpreadsheetApp, globals.SHEETS, Util,
    { write: (e: OldAudit) => void audit.push(e) },
    Staff, OldDate,
  ) as { login: (n: unknown, c: unknown) => Record<string, unknown>; logout: (t: string) => Record<string, unknown> };
  return { Auth, audit, props, setNow: (ms: number) => void (nowMs = ms) };
}

// ---- the database ------------------------------------------------------------------------------
type Conn = Db & { close(): Promise<void> };
let testDb: TestDb;
let db: Conn;
let owner: Conn;
const pinHashes = new Map<string, string>();

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  owner = await connect(testDb.ownerUrl);
  for (const p of PEOPLE) {
    await db.query("insert into ops.staff (staff_id, name, active, role, companies_authorized) values ($1, $2, $3, $4, $5)", [p.id, p.name, p.active, p.role, p.companies]);
    if (p.pin) await setPin(db, p.id, p.pin, PEPPER);
  }
});
afterAll(async () => {
  await db?.close();
  await owner?.close();
  await testDb?.drop();
});
beforeEach(async () => {
  await owner.query("delete from ops.sessions");
  await owner.query("delete from ops.login_failures");
  await owner.query("delete from ops.audit_log");
  await owner.query("delete from ops.config");
});

const setConfig = async (rows: Array<[string, string]>) => {
  for (const [k, v] of rows) await owner.query("insert into ops.config (key, value, description) values ($1, $2, '')", [k, v]);
};

/** One world: the new code over the database and the old code over its stubs, fed the same config. */
async function world(configRows: Array<[string, string]> = []) {
  await setConfig(configRows);
  const config = await loadConfig(db);
  const oracle = makeOracle(configRows);
  type Out = { result: Record<string, unknown>; audit: Array<Record<string, string | null>> };
  // Postgres text cannot hold NUL: the port shows it as U+FFFD (the one stated difference in login.ts).
  const nul = (s: string | undefined) => (s ? s.replaceAll("\u0000", "�") : null);
  const seen: string[] = [];
  const norm = (a: OldAudit) => ({ actorId: nul(a.actorId), action: a.action, targetType: nul(a.targetType), targetId: nul(a.targetId), details: nul(a.details) });
  return {
    config,
    oracle,
    /** Run one login on both sides at `minutes` after BASE; return what each returned and wrote. */
    async both(name: unknown, code: unknown, minutes = 0): Promise<{ old: Out; neu: Out; now: Date }> {
      const ms = BASE + minutes * MIN;
      oracle.setNow(ms);
      const before = oracle.audit.length;
      const oldResult = oracle.Auth.login(name, code);
      const old = { result: oldResult, audit: oracle.audit.slice(before).map(norm) };
      const now = new Date(ms);
      const neuResult = await login({ db, config, pepper: PEPPER, now }, name as string, code as string);
      // The audit rows this call added: those whose log id we have not seen yet.
      const rows = await db.query<{ log_id: string; actor_id: string | null; action: string; target_type: string | null; target_id: string | null; details: string | null }>(
        "select log_id, actor_id, action, target_type, target_id, details from ops.audit_log where log_id <> all($1::text[])",
        [seen],
      );
      seen.push(...rows.map((r) => r.log_id));
      const neu = {
        result: neuResult as unknown as Record<string, unknown>,
        audit: rows.map((r) => ({ actorId: r.actor_id, action: r.action, targetType: r.target_type, targetId: r.target_id, details: r.details })),
      };
      return { old, neu, now };
    },
  };
}

const sansToken = (r: Record<string, unknown>) => ({ ...r, token: r["token"] === undefined ? undefined : "<token>" });
const failureCount = async (key: string) => (await db.one<{ n: number }>("select count(*)::int as n from ops.login_failures where name_key = $1", [key])).n;
const sessionCount = async () => (await db.one<{ n: number }>("select count(*)::int as n from ops.sessions")).n;

/** The new answer equals the old one (token aside), and so does the audit row. Returns the new result. */
async function same(w: Awaited<ReturnType<typeof world>>, name: unknown, code: unknown, minutes = 0) {
  const { old, neu } = await w.both(name, code, minutes);
  expect(sansToken(neu.result)).toEqual(sansToken(old.result));
  expect(Object.keys(neu.result).sort()).toEqual(Object.keys(old.result).sort());
  expect(neu.audit).toEqual(old.audit);
  return neu.result;
}

describe("success", () => {
  it("returns the exact old object (same keys, no extras), makes a session and writes login.success", async () => {
    const w = await world();
    const { old, neu, now } = await w.both("Asha Example", "4821");
    expect(old.result["success"]).toBe(true);
    expect(sansToken(neu.result)).toEqual(sansToken(old.result));
    expect(Object.keys(neu.result).sort()).toEqual(["companiesAuthorized", "name", "role", "staffId", "success", "token"]);
    expect(neu.result).toMatchObject({ success: true, staffId: "S1", name: "Asha Example", role: "admin", companiesAuthorized: ["cstore", "vape"] });
    expect(neu.result["token"]).toMatch(/^[0-9a-f]{32}$/);
    expect(neu.audit).toEqual(old.audit);
    expect(neu.audit).toEqual([{ actorId: "S1", action: "login.success", targetType: "staff", targetId: "S1", details: "session created" }]);
    expect(await sessionCount()).toBe(1);
    // The session works, and is the person's own.
    expect(await validateSession(db, neu.result["token"] as string, w.config, now)).toMatchObject({ staffId: "S1", role: "admin" });
  });

  it("a PIN with surrounding spaces is trimmed, as the old code trims the submitted code", async () => {
    const w = await world();
    expect((await same(w, "Ben Sample", "  1357 "))["success"]).toBe(true);
  });

  it("a person with no companies gets an empty list, as the old code does", async () => {
    const w = await world();
    expect((await same(w, "Ben Sample", "1357"))["companiesAuthorized"]).toEqual([]);
  });
});

describe("name matching is Staff.getByName_'s: trimmed, then exact and case-sensitive", () => {
  it("surrounding spaces are fine", async () => {
    const w = await world();
    expect((await same(w, "   Asha Example  ", "4821"))["success"]).toBe(true);
  });
  it("a different case is an unknown name (the lockout key is lower-cased, the match is not)", async () => {
    const w = await world();
    const r = await same(w, "asha example", "4821");
    expect(r).toEqual({ success: false, error: "Invalid name or code" });
    expect(await failureCount("asha example")).toBe(1);
  });
  it("inner whitespace is not collapsed", async () => {
    const w = await world();
    expect((await same(w, "Asha  Example", "4821"))["success"]).toBe(false);
  });
});

describe("failures", () => {
  it("a wrong PIN and an unknown name give the same text, each audited as the old code audits it, each counted once", async () => {
    const w = await world();
    const wrong = await w.both("Asha Example", "0000");
    const unknown = await w.both("Nobody Atall", "4821", 1);
    expect(wrong.neu.result).toEqual({ success: false, error: "Invalid name or code" });
    expect(unknown.neu.result).toEqual(wrong.neu.result);
    expect(wrong.neu.result).toEqual(wrong.old.result);
    expect(unknown.neu.result).toEqual(unknown.old.result);
    expect(wrong.neu.audit).toEqual(wrong.old.audit);
    expect(unknown.neu.audit).toEqual(unknown.old.audit);
    expect(wrong.neu.audit).toEqual([{ actorId: "SYSTEM", action: "login.fail", targetType: "staff", targetId: "S1", details: "wrong_code" }]);
    expect(unknown.neu.audit).toEqual([{ actorId: "SYSTEM", action: "login.fail", targetType: "staff", targetId: "Nobody Atall", details: "unknown_name" }]);
    expect(await failureCount("asha example")).toBe(1);
    expect(await failureCount("nobody atall")).toBe(1);
    expect(await sessionCount()).toBe(0);
  });

  it("a blank, whitespace or missing name is 'Name is required', writes nothing and counts nothing", async () => {
    const w = await world();
    for (const n of ["", "   ", null, undefined]) {
      const { old, neu } = await w.both(n, "4821");
      expect(neu.result).toEqual({ success: false, error: "Name is required" });
      expect(neu.result).toEqual(old.result);
      expect(neu.audit).toEqual([]);
      expect(old.audit).toEqual([]);
    }
    expect((await db.one<{ n: number }>("select count(*)::int as n from ops.login_failures")).n).toBe(0);
  });

  it("an inactive person: 'Account is inactive', audit 'inactive', and (as today) no failure is counted", async () => {
    const w = await world();
    const { old, neu } = await w.both("Cara Gone", "2468");
    expect(neu.result).toEqual({ success: false, error: "Account is inactive" });
    expect(neu.result).toEqual(old.result);
    expect(neu.audit).toEqual(old.audit);
    expect(neu.audit).toEqual([{ actorId: "SYSTEM", action: "login.fail", targetType: "staff", targetId: "S3", details: "inactive" }]);
    expect(await failureCount("cara gone")).toBe(0);
    // Even a wrong PIN says inactive (the old code never looks at the code for an inactive person).
    expect((await same(w, "Cara Gone", "9999"))["error"]).toBe("Account is inactive");
    expect(await failureCount("cara gone")).toBe(0);
  });

  it("a person with no stored PIN cannot sign in: the same answer and audit as a wrong code", async () => {
    const w = await world();
    const { neu } = await w.both("Dev Nopin", "1234");
    expect(neu.result).toEqual({ success: false, error: "Invalid name or code" });
    expect(neu.audit).toEqual([{ actorId: "SYSTEM", action: "login.fail", targetType: "staff", targetId: "S4", details: "wrong_code" }]);
    expect(await failureCount("dev nopin")).toBe(1);
    // The old code has the same rule (a blank login_code never matches), even for a blank submitted code.
    expect((await same(w, "Dev Nopin", ""))["error"]).toBe("Invalid name or code");
    expect((await same(w, "Dev Nopin", null))["error"]).toBe("Invalid name or code");
  });

  it("a missing or non-string code is a wrong code, as in the old code", async () => {
    const w = await world();
    for (const c of ["", null, undefined, 4821]) {
      const { old, neu } = await w.both("Asha Example", c);
      // The old code compares String(code): 4821 as a number is the right PIN there. The same holds here.
      expect(sansToken(neu.result)).toEqual(sansToken(old.result));
    }
  });
});

describe("lockout (Auth.gs:192-227), same arithmetic, counted in ops.login_failures", () => {
  it("5 failures lock the name: even the right PIN is refused with the minutes remaining; then it opens again", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) await same(w, "Asha Example", "0000", i); // minutes 0..4
    expect(await failureCount("asha example")).toBe(5);
    // First failure was at minute 0, so at minute 10 there are 60 - 10 = 50 minutes left.
    const locked = await w.both("Asha Example", "4821", 10);
    expect(locked.neu.result).toEqual({ success: false, error: "Too many failed attempts. Try again in 50 minutes." });
    expect(locked.neu.result).toEqual(locked.old.result);
    expect(locked.neu.audit).toEqual(locked.old.audit);
    expect(locked.neu.audit).toEqual([{ actorId: "SYSTEM", action: "login.fail", targetType: "staff", targetId: "Asha Example", details: "rate_limited: 50min" }]);
    expect(await sessionCount()).toBe(0);
    // A locked attempt is not itself counted.
    expect(await failureCount("asha example")).toBe(5);
    // Rounding up: 59 minutes 30 seconds after the first failure is 1 minute left.
    const oneLeft = await same(w, "Asha Example", "4821", 59.5);
    expect(oneLeft["error"]).toBe("Too many failed attempts. Try again in 1 minutes.");
    // Once login_lockout_mins have passed, sign-in works again and the old failures are gone.
    const open = await same(w, "Asha Example", "4821", 60);
    expect(open["success"]).toBe(true);
    expect(await failureCount("asha example")).toBe(0);
  });

  it("one failure short of the limit is not locked, and a success clears the count", async () => {
    const w = await world();
    for (let i = 0; i < 4; i++) await same(w, "Ben Sample", "0000", i);
    expect((await same(w, "Ben Sample", "1357", 5))["success"]).toBe(true);
    expect(await failureCount("ben sample")).toBe(0);
    for (let i = 0; i < 4; i++) await same(w, "Ben Sample", "0000", 6 + i); // fresh count of 4
    expect((await same(w, "Ben Sample", "1357", 11))["success"]).toBe(true);
  });

  it("is per name key: another person is unaffected; the typed case shares one key", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) await same(w, i % 2 ? "ASHA EXAMPLE" : "Asha Example", "0000", i);
    expect(await failureCount("asha example")).toBe(5);
    expect((await same(w, "Asha Example", "4821", 6))["error"]).toMatch(/^Too many failed attempts/);
    expect((await same(w, "Ben Sample", "1357", 6))["success"]).toBe(true);
  });

  it("unknown names lock too (the key is the typed name)", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) await same(w, "Nobody Atall", "1234", i);
    expect((await same(w, "  nobody atall ", "1234", 6))["error"]).toBe("Too many failed attempts. Try again in 54 minutes.");
  });

  it("an inactive person who is locked is told they are locked first (the lockout check comes first)", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) await same(w, "Cara Gone", "0000", i);
    // Inactive never counts, so Cara is not locked: still 'inactive'.
    expect((await same(w, "Cara Gone", "2468", 6))["error"]).toBe("Account is inactive");
  });

  it("a failure after the window has passed starts a new count (the old window is fixed from the first failure)", async () => {
    const w = await world();
    await same(w, "Ben Sample", "0000", 0);
    await same(w, "Ben Sample", "0000", 1);
    for (let i = 0; i < 4; i++) await same(w, "Ben Sample", "0000", 70 + i); // window restarted at minute 70
    expect(await failureCount("ben sample")).toBe(4);
    expect((await same(w, "Ben Sample", "1357", 75))["success"]).toBe(true);
  });

  it("login_max_fails and login_lockout_mins come from the config table; blank and 0 give 5 and 60", async () => {
    const w = await world([["login_max_fails", "2"], ["login_lockout_mins", "10"]]);
    await same(w, "Ben Sample", "0000", 0);
    await same(w, "Ben Sample", "0000", 1);
    expect(await same(w, "Ben Sample", "1357", 2)).toEqual({ success: false, error: "Too many failed attempts. Try again in 8 minutes." });
    expect((await same(w, "Ben Sample", "1357", 10))["success"]).toBe(true);

    await owner.query("delete from ops.config");
    await owner.query("delete from ops.login_failures");
    await owner.query("delete from ops.audit_log");
    const blank = await world([["login_max_fails", ""], ["login_lockout_mins", "0"]]);
    for (let i = 0; i < 4; i++) await same(blank, "Ben Sample", "0000", i);
    expect((await same(blank, "Ben Sample", "1357", 4))["success"]).toBe(true); // 4 < the default 5
    for (let i = 0; i < 5; i++) await same(blank, "Ben Sample", "0000", 10 + i);
    expect((await same(blank, "Ben Sample", "1357", 20))["error"]).toBe("Too many failed attempts. Try again in 50 minutes."); // default 60, first fail at 10
  });
});

describe("logout", () => {
  it("matches the old result and audit row", async () => {
    const w = await world();
    const { neu, old, now } = await w.both("Asha Example", "4821");
    const oldOut = w.oracle.Auth.logout(old.result["token"] as string);
    const newOut = await logout({ db, config: w.config, pepper: PEPPER, now: new Date(now.getTime() + 1000) }, neu.result["token"] as string);
    expect(newOut).toEqual(oldOut);
    const row = await db.one<{ actor_id: string; action: string; target_type: string; target_id: string; details: string | null }>(
      "select actor_id, action, target_type, target_id, details from ops.audit_log where action = 'login.logout'",
    );
    const oldRow = w.oracle.audit.at(-1) as OldAudit;
    // The token differs between the two worlds; its first 8 characters + "..." is the old rule (Auth.gs:135).
    const oldToken = old.result["token"] as string;
    const newToken = neu.result["token"] as string;
    expect(oldRow.targetId).toBe(oldToken.substring(0, 8) + "...");
    expect(row.target_id).toBe(newToken.substring(0, 8) + "...");
    expect({ actorId: row.actor_id, action: row.action, targetType: row.target_type, details: row.details ?? "" }).toEqual({
      actorId: oldRow.actorId, action: oldRow.action, targetType: oldRow.targetType, details: oldRow.details,
    });
    expect(await sessionCount()).toBe(0);
  });
});

describe("the client cannot choose who it is", () => {
  it("extra arguments to login change nothing: the session is the named person's, from the staff row", async () => {
    const w = await world();
    const call = login as unknown as (d: LoginDeps, ...rest: unknown[]) => Promise<Record<string, unknown>>;
    const r = await call({ db, config: w.config, pepper: PEPPER, now: new Date(BASE) }, "Ben Sample", "1357", "admin", "S1", { role: "admin", staffId: "S1" });
    expect(r).toMatchObject({ success: true, staffId: "S2", role: "employee" });
    expect(await validateSession(db, r["token"] as string, w.config, new Date(BASE))).toMatchObject({ staffId: "S2", role: "employee" });
  });

  it("crafted names do not become someone else: SQL text, wildcards, ids and objects all fail like an unknown name", async () => {
    const w = await world();
    const crafted: unknown[] = ["' or true --", "S1", "Asha%", "Asha_Example", "Asha Example' --", "Asha Example\u0000", { name: "Asha Example" }, ["Asha Example"], "%", "Ben Sample\n", "BEN SAMPLE"];
    for (const [i, name] of crafted.entries()) {
      const { old, neu } = await w.both(name, "4821", i);
      // The old code String()s the name: ["Asha Example"] becomes "Asha Example", which is a real person with PIN 4821.
      expect(sansToken(neu.result), JSON.stringify(name)).toEqual(sansToken(old.result));
      if (neu.result["success"] === true) expect(neu.result["staffId"]).toBe("S1");
      expect(neu.audit).toEqual(old.audit);
    }
    // Nothing but the one legitimate session exists, and no row of other people's data changed.
    expect(await sessionCount()).toBeLessThanOrEqual(1);
  });

  it("the wrong person's PIN never opens someone else's account", async () => {
    const w = await world();
    expect((await same(w, "Asha Example", "1357"))["success"]).toBe(false); // Ben's PIN
    expect((await same(w, "Ben Sample", "4821"))["success"]).toBe(false); // Asha's PIN
  });
});

describe("no timing oracle in the code path", () => {
  it("an unknown name still performs exactly one PIN verification; so does a wrong PIN and a person with no PIN", async () => {
    const spy = vi.spyOn(pinModule, "verifyPin");
    try {
      const w = await world();
      const deps = { db, config: w.config, pepper: PEPPER, now: new Date(BASE) };
      await login(deps, "Nobody Atall", "1234");
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      await login(deps, "Asha Example", "0000");
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      await login(deps, "Dev Nopin", "1234");
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      await login(deps, "Asha Example", "4821");
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("the stored PIN hash and the PIN never appear in anything login returns or audits", async () => {
    const w = await world();
    const hash = (await db.one<{ pin_hash: string }>("select pin_hash from ops.staff where staff_id = 'S1'")).pin_hash;
    const { neu } = await w.both("Asha Example", "4821");
    const everything = JSON.stringify([neu.result, await db.query("select * from ops.audit_log"), await db.query("select * from ops.sessions")]);
    expect(everything).not.toContain(hash);
    expect(everything).not.toContain("4821");
    expect(everything).not.toContain(PEPPER);
    expect(Config).toBeDefined();
  });
});
