// Sessions: the port of Auth.login_'s session creation, peek_, validate_ and logout_.
// Against a real database; the old rules are stated with the src/Auth.gs line they come from.
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, type Db } from "../src/db/client";
import { createSession, destroySession, purgeExpired, validateSession } from "../src/auth/sessions";
import { logout } from "../src/auth/login";
import { setPin } from "../src/auth/pin";
import { Config } from "../src/lib/config";
import { NOT_LOGGED_IN } from "../src/auth/types";
import { createTestDb, type TestDb } from "./helpers/db";

type Conn = Db & { close(): Promise<void> };
let testDb: TestDb;
let db: Conn;
let owner: Conn;
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
  await owner.query("delete from ops.sessions");
  await owner.query("delete from ops.audit_log");
  await owner.query("delete from ops.staff");
  await db.query(
    `insert into ops.staff (staff_id, name, active, role, companies_authorized) values
       ('S1', ' Asha Example ', true, 'admin', ' cstore , vape,'),
       ('S2', 'Ben Sample', true, 'employee', null),
       ('S3', 'Cara Gone', false, 'manager', 'cstore')`,
  );
});

const HOUR = 3600 * 1000;
const T0 = new Date(Date.UTC(2026, 5, 15, 16, 0, 0));
const at = (ms: number) => new Date(T0.getTime() + ms);
const CONFIG = Config.fromRows([]); // session_hours blank: the default, 24
const expiresOf = async (token: string) =>
  (await db.one<{ expires_at: Date }>("select expires_at from ops.sessions where token_hash = $1", [createHash("sha256").update(token).digest()])).expires_at.getTime();
const countRows = async () => (await db.one<{ n: number }>("select count(*)::int as n from ops.sessions")).n;
const messageOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "(did not throw)";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("createSession", () => {
  it("returns a token and an expiry of now + session_hours (Auth.gs:97,104)", async () => {
    const { token, expiresAt } = await createSession(db, "S1", CONFIG, T0);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(expiresAt).toBe(T0.getTime() + 24 * HOUR);
    expect(await expiresOf(token)).toBe(expiresAt);
  });

  it("session_hours comes from config; blank, zero and non-numeric give 24 (Number(...) || 24)", async () => {
    const hours = async (v: string) => (await createSession(db, "S1", Config.fromRows([{ key: "session_hours", value: v }]), T0)).expiresAt - T0.getTime();
    expect(await hours("8")).toBe(8 * HOUR);
    expect(await hours("")).toBe(24 * HOUR);
    expect(await hours("0")).toBe(24 * HOUR);
    expect(await hours("abc")).toBe(24 * HOUR);
    expect(await hours("1.5")).toBe(1.5 * HOUR);
  });

  it("two sessions get different tokens, and the database never holds the token itself", async () => {
    const a = await createSession(db, "S1", CONFIG, T0);
    const b = await createSession(db, "S1", CONFIG, T0);
    expect(a.token).not.toBe(b.token);
    const rows = await db.query<Record<string, unknown>>("select * from ops.sessions");
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      const text = JSON.stringify(r);
      expect(text).not.toContain(a.token);
      expect(text).not.toContain(b.token);
    }
    // What is stored is exactly sha256(token).
    const hashes = (await db.query<{ h: string }>("select encode(token_hash, 'hex') as h from ops.sessions")).map((r) => r.h).sort();
    expect(hashes).toEqual([a.token, b.token].map((t) => createHash("sha256").update(t).digest("hex")).sort());
    // Nor does the audit log (login/logout write token prefixes only; see below).
    expect(JSON.stringify(await db.query("select * from ops.audit_log"))).not.toContain(a.token);
  });
});

describe("validateSession", () => {
  it("returns the Session shaped as the old session (Auth.gs:99-105; Staff.gs rowToRecord_)", async () => {
    const { token, expiresAt } = await createSession(db, "S1", CONFIG, T0);
    const s = await validateSession(db, token, CONFIG, at(HOUR));
    expect(s).toEqual({
      staffId: "S1",
      name: "Asha Example", // trimmed, as rowToRecord_ trims
      role: "admin",
      companiesAuthorized: ["cstore", "vape"], // split on commas, trimmed, empties dropped
      expiresAt,
    });
    expect(Object.keys(s).sort()).toEqual(["companiesAuthorized", "expiresAt", "name", "role", "staffId"]);
    const noCompanies = await createSession(db, "S2", CONFIG, T0);
    expect((await validateSession(db, noCompanies.token, CONFIG, T0)).companiesAuthorized).toEqual([]);
  });

  it("an unknown, empty, missing or non-string token throws exactly NOT_LOGGED_IN", async () => {
    await createSession(db, "S1", CONFIG, T0);
    for (const t of ["", "0123456789abcdef0123456789abcdef", "nope", undefined, null, 12345, {}]) {
      expect(await messageOf(validateSession(db, t as unknown as string, CONFIG, T0)), String(t)).toBe(NOT_LOGGED_IN);
    }
    expect(NOT_LOGGED_IN).toBe("NOT_LOGGED_IN");
  });

  it("an expired token throws and its row is deleted; exactly at expiry is still valid (Auth.gs:150 is a strict >)", async () => {
    const { token, expiresAt } = await createSession(db, "S1", CONFIG, T0);
    const other = await createSession(db, "S2", CONFIG, T0);
    const atEdge = await createSession(db, "S1", CONFIG, T0);
    expect(await validateSession(db, atEdge.token, CONFIG, new Date(expiresAt))).toMatchObject({ staffId: "S1" });
    await destroySession(db, atEdge.token);
    expect(await messageOf(validateSession(db, token, CONFIG, new Date(expiresAt + 1)))).toBe(NOT_LOGGED_IN);
    expect(await countRows()).toBe(1);
    expect(await messageOf(validateSession(db, token, CONFIG, T0))).toBe(NOT_LOGGED_IN); // gone for good
    expect(await validateSession(db, other.token, CONFIG, T0)).toMatchObject({ staffId: "S2" });
  });

  it("rolling renewal: more than half the window left changes nothing; less than half renews to now + window", async () => {
    const { token, expiresAt } = await createSession(db, "S1", CONFIG, T0); // T0 + 24h
    // 1) 6h in: 18h left, more than half (12h): unchanged.
    const early = await validateSession(db, token, CONFIG, at(6 * HOUR));
    expect(early.expiresAt).toBe(expiresAt);
    expect(await expiresOf(token)).toBe(expiresAt);
    // 2) exactly half left (12h): not "less than", so unchanged (Auth.gs:171 is a strict <).
    expect((await validateSession(db, token, CONFIG, at(12 * HOUR))).expiresAt).toBe(expiresAt);
    expect(await expiresOf(token)).toBe(expiresAt);
    // 3) 18h in: 6h left, less than half: becomes now + 24h, and is returned so.
    const late = await validateSession(db, token, CONFIG, at(18 * HOUR));
    expect(late.expiresAt).toBe(T0.getTime() + 18 * HOUR + 24 * HOUR);
    expect(await expiresOf(token)).toBe(late.expiresAt);
  });

  it("the window is read from the current config, as validate_ does", async () => {
    const { token } = await createSession(db, "S1", CONFIG, T0); // stored with 24h
    const short = Config.fromRows([{ key: "session_hours", value: "2" }]);
    // 1h in: 23h left is not less than 1h, so no renewal even though the config now says 2h.
    expect((await validateSession(db, token, short, at(HOUR))).expiresAt).toBe(T0.getTime() + 24 * HOUR);
  });

  it("deactivating the person ends their existing session at once (new: read from the staff row)", async () => {
    const { token } = await createSession(db, "S2", CONFIG, T0);
    expect(await validateSession(db, token, CONFIG, T0)).toMatchObject({ staffId: "S2" });
    await db.query("update ops.staff set active = false where staff_id = 'S2'");
    expect(await messageOf(validateSession(db, token, CONFIG, T0))).toBe(NOT_LOGGED_IN);
    await db.query("update ops.staff set active = true where staff_id = 'S2'");
    expect(await validateSession(db, token, CONFIG, T0)).toMatchObject({ staffId: "S2" });
  });

  it("a session of a person who was already inactive (Cara) never validates", async () => {
    const { token } = await createSession(db, "S3", CONFIG, T0);
    expect(await messageOf(validateSession(db, token, CONFIG, T0))).toBe(NOT_LOGGED_IN);
  });

  it("a changed role or name shows in the next validateSession", async () => {
    const { token } = await createSession(db, "S2", CONFIG, T0);
    expect(await validateSession(db, token, CONFIG, T0)).toMatchObject({ role: "employee" });
    await db.query("update ops.staff set role = 'payroll_admin', name = 'Ben Renamed', companies_authorized = 'vape' where staff_id = 'S2'");
    expect(await validateSession(db, token, CONFIG, T0)).toMatchObject({ role: "payroll_admin", name: "Ben Renamed", companiesAuthorized: ["vape"] });
  });
});

describe("logout and destroySession", () => {
  const deps = () => ({ db, config: CONFIG, pepper: "test-pepper-not-a-secret", now: T0 });
  const audit = () => db.query<Record<string, string | null>>("select actor_id, action, target_type, target_id, details from ops.audit_log");

  it("logout deletes the row and writes the old audit row with the token prefix only (Auth.gs:131-137)", async () => {
    const { token } = await createSession(db, "S1", CONFIG, T0);
    expect(await logout(deps(), token)).toEqual({ success: true });
    expect(await countRows()).toBe(0);
    expect(await messageOf(validateSession(db, token, CONFIG, T0))).toBe(NOT_LOGGED_IN);
    const rows = await audit();
    expect(rows).toEqual([{ actor_id: "S1", action: "login.logout", target_type: "session", target_id: token.substring(0, 8) + "...", details: null }]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("logout with no token, or an unknown or expired one, succeeds and writes nothing", async () => {
    expect(await logout(deps(), "")).toEqual({ success: true });
    expect(await logout(deps(), undefined as unknown as string)).toEqual({ success: true });
    expect(await logout(deps(), "0123456789abcdef0123456789abcdef")).toEqual({ success: true });
    const { token, expiresAt } = await createSession(db, "S1", CONFIG, T0);
    expect(await logout({ ...deps(), now: new Date(expiresAt + 1) }, token)).toEqual({ success: true });
    expect(await countRows()).toBe(0); // the expired row is removed, as peek_ removes it
    expect(await audit()).toEqual([]);
  });

  it("logout removes only that session", async () => {
    const a = await createSession(db, "S1", CONFIG, T0);
    const b = await createSession(db, "S1", CONFIG, T0);
    await logout(deps(), a.token);
    expect(await validateSession(db, b.token, CONFIG, T0)).toMatchObject({ staffId: "S1" });
  });

  it("destroySession deletes the row and says nothing else", async () => {
    const { token } = await createSession(db, "S1", CONFIG, T0);
    await destroySession(db, token);
    expect(await countRows()).toBe(0);
    await destroySession(db, token); // twice is fine
    await destroySession(db, "");
    expect(await audit()).toEqual([]);
  });
});

describe("purgeExpired", () => {
  it("removes only expired rows", async () => {
    const live = await createSession(db, "S1", CONFIG, T0);
    const edge = await createSession(db, "S2", CONFIG, T0);
    const short = await createSession(db, "S1", Config.fromRows([{ key: "session_hours", value: "1" }]), T0);
    await purgeExpired(db, at(2 * HOUR)); // only the 1h session is past its end
    expect(await countRows()).toBe(2);
    expect(await validateSession(db, live.token, CONFIG, at(2 * HOUR))).toMatchObject({ staffId: "S1" });
    expect(await messageOf(validateSession(db, short.token, CONFIG, at(2 * HOUR)))).toBe(NOT_LOGGED_IN);
    await purgeExpired(db, new Date(edge.expiresAt)); // exactly at expiry: not past it
    expect(await countRows()).toBe(2);
    await purgeExpired(db, new Date(edge.expiresAt + 1));
    expect(await countRows()).toBe(0);
  });
});

describe("the client cannot choose its identity", () => {
  it("validateSession takes only a token: extra arguments change nothing", async () => {
    const { token } = await createSession(db, "S2", CONFIG, T0);
    const call = validateSession as unknown as (...a: unknown[]) => Promise<{ staffId: string; role: string }>;
    const s = await call(db, token, CONFIG, T0, "S1", "admin", { role: "admin", staffId: "S1" });
    expect(s).toMatchObject({ staffId: "S2", role: "employee" });
  });

  it("a PIN set through setPin is what the staff row holds (smoke: setPin is not needed to create a session)", async () => {
    await setPin(db, "S1", "4821", "test-pepper-not-a-secret");
    const { token } = await createSession(db, "S1", CONFIG, T0);
    expect(await validateSession(db, token, CONFIG, T0)).toMatchObject({ staffId: "S1" });
  });
});
