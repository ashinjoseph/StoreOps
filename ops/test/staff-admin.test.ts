// Staff admin (card P4-11): add a person, change them, deactivate them, set their PIN, give a raise
// that may reach back to unpaid days. A NEW ability of the Operations app (ADR-0023): in the Apps
// Script app this was typing into the Sheet's staff tab, so there is nothing to compare with and these
// tests are its specification. Against a real database, with invented people and figures.
//
// Order: who may call (through the real router and the merged contract); the list; adding; changing
// (each guard); the raise end to end with payroll; setting a PIN; that the PIN never leaks; that nothing
// else moves; and the races, on two connections.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPin } from "../src/auth/pin";
import { createSession } from "../src/auth/sessions";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { Config, loadConfig } from "../src/lib/config";
import * as payments from "../src/modules/payments";
import * as staffAdmin from "../src/modules/staff-admin";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { rpcCreateStaff, rpcGetStaffAdmin, rpcPreviewRateChange, rpcSetStaffPin, rpcUpdateStaff } from "../src/rpc/handlers/staff-admin";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
// The app role cannot delete money or audit rows (by design): the tables are reset as the owner.
let owner: Db & { close(): Promise<void> };

const PEPPER = "test-only-pepper-not-a-secret";
const ENV = { PIN_PEPPER: PEPPER };
// Toronto is UTC-4 in June. NOW is Wednesday 2026-06-10, 14:00 in Toronto.
const NOW = new Date("2026-06-10T18:00:00Z");
const LATER = new Date(NOW.getTime() + 60_000);
/** An unusual PIN, searched for in everything the app keeps or answers. */
const SECRET_PIN = "73918264";

type Seed = [id: string, name: string, rate: number | null, active: boolean, role: string, companies: string | null, pin: string | null];
const STAFF: Seed[] = [
  ["S_001", "Ada Quill", 25, true, "admin", "cstore,vape", "1111"],
  ["S_002", "Bram Hale", 21, true, "manager", "cstore,vape", "2222"],
  ["S_003", "Cleo Marsh", 20, true, "employee", "cstore", "3333"],
  ["S_004", "Dara Vance", null, true, "employee", "vape", null], // no rate recorded, no PIN yet
  ["S_005", "Eli Stone", 18, true, "employee", "vape", "5555"],
  ["S_006", "Fay Ruiz", 22, true, "payroll_admin", null, "6666"],
  ["S_007", "Gus Lowe", 19, false, "employee", "cstore", "7777"], // has left
];
const hashes = new Map<string, string>();

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  owner = await connect(testDb.ownerUrl);
  // Low iteration counts keep the seed fast; verifyPin reads the count back from the stored value.
  for (const s of STAFF) if (s[6]) hashes.set(s[0], await hashPin(s[6], PEPPER, { iterations: 1000 }));
});
afterAll(async () => {
  await db?.close();
  await owner?.close();
  await testDb?.drop();
});

const MONEY_TABLES = ["till_sessions", "sales", "payments", "payment_items", "bonuses", "cash_handovers"];

async function seed() {
  for (const t of ["audit_log", "cash_handover_items", "cash_handovers", "payment_items", "payments", "sales", "till_sessions", "bonuses", "attendance", "sessions", "login_failures", "config", "staff"]) {
    await owner.query(`delete from ops.${t}`);
  }
  for (const s of STAFF) {
    await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized, email, start_date, created_at, notes, pin_hash) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [
      s[0],
      s[1],
      s[2],
      s[3],
      s[4],
      s[5],
      s[0] === "S_003" ? "cleo@example.test" : null,
      s[0] === "S_003" ? "2025-03-01" : null,
      "2025-01-01T12:00:00Z",
      s[0] === "S_003" ? "Prefers mornings" : null,
      hashes.get(s[0]) ?? null,
    ]);
  }
}
beforeEach(seed);

// ── Calling ────────────────────────────────────────────────

const session = (staffId: string, role: Session["role"], expiresAt = 0): Session => ({ staffId, name: "x", role, companiesAuthorized: ["cstore"], expiresAt });
const ADMIN = session("S_001", "admin");
const MANAGER = session("S_002", "manager");

async function rpc(handler: (ctx: RpcContext, ...a: unknown[]) => unknown, who: Session | null, args: unknown[], now = NOW, on: Db = db): Promise<any> {
  return withTransaction(on, async (tx) => handler({ db: tx, session: who, config: () => loadConfig(tx), env: ENV, fetch, now }, ...args));
}

const contract = parseRpcContract(
  mergeOpsContract(
    JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
    JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
  ),
);
const router = (now = NOW) => createRpcRouter({ contract, handlers, openDb: () => connect(testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env: ENV, now: () => now, log: () => undefined });
async function call(name: string, args: unknown[], now = NOW): Promise<{ ok: boolean; result?: any; error?: { message: string }; text: string }> {
  const res = await router(now)(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
  const text = await res.text();
  return { ...(JSON.parse(text) as { ok: boolean; result?: any; error?: { message: string } }), text };
}
const tokenOf = async (staffId: string, now = NOW) => (await createSession(db, staffId, Config.fromRows([]), now)).token;
const signIn = (name: string, pin: string, now = NOW) => call("rpcLogin", [name, pin], now);

const staffRow = (id: string) => db.maybeOne<any>("select staff_id, name, hourly_rate, active, role, companies_authorized, email, start_date, created_at, notes, pin_hash from ops.staff where staff_id = $1", [id]);
const staffCount = async () => (await db.one<{ n: number }>("select count(*)::int as n from ops.staff")).n;
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details from ops.audit_log order by seq`);
const sessionsOf = async (id: string) => (await db.one<{ n: number }>("select count(*)::int as n from ops.sessions where staff_id = $1", [id])).n;
async function snapshot(tables: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = await db.query(`select * from ops.${t} order by 1`);
  return JSON.stringify(out);
}

/** What the change sheet sends for a person: every field, as stored in the fixture, with a patch. */
function edit(id: string, patch: Record<string, unknown> = {}) {
  const s = STAFF.find((x) => x[0] === id) as Seed;
  return {
    staffId: id,
    name: s[1],
    role: s[4],
    companies: s[5] ? s[5].split(",") : [],
    hourlyRate: s[2],
    startDate: id === "S_003" ? "2025-03-01" : "",
    email: id === "S_003" ? "cleo@example.test" : "",
    notes: id === "S_003" ? "Prefers mornings" : "",
    active: s[3],
    applyRateFrom: "",
    reason: "",
    ...patch,
  };
}
const newPerson = (patch: Record<string, unknown> = {}) => ({ name: "Hana Park", role: "employee", companies: ["cstore"], hourlyRate: "", startDate: "", email: "", notes: "", pin: "4826", ...patch });

const create = (input: unknown, who: Session = ADMIN, now = NOW) => rpc(rpcCreateStaff, who, [input], now);
const update = (input: unknown, who: Session = ADMIN, now = NOW) => rpc(rpcUpdateStaff, who, [input], now);
const preview = (input: unknown, who: Session = ADMIN) => rpc(rpcPreviewRateChange, who, [input]);
const setPinFor = (input: unknown, who: Session = ADMIN) => rpc(rpcSetStaffPin, who, [input]);
const listAs = (who: Session = ADMIN) => rpc(rpcGetStaffAdmin, who, []);

// ── Who may call ───────────────────────────────────────────

describe("who may call: the real router with the merged contract", () => {
  const VALID: Record<string, () => unknown[]> = {
    rpcGetStaffAdmin: () => [],
    rpcCreateStaff: () => [newPerson()],
    rpcUpdateStaff: () => [edit("S_005", { notes: "Keys to the back door" })],
    rpcPreviewRateChange: () => [{ staffId: "S_003", hourlyRate: 22, applyRateFrom: "2026-05-15" }],
    rpcSetStaffPin: () => [{ staffId: "S_005", pin: "8642" }],
  };
  const ROLES_OF: Record<string, string[]> = {
    rpcGetStaffAdmin: ["admin", "manager"],
    rpcCreateStaff: ["admin", "manager"],
    rpcUpdateStaff: ["admin"],
    rpcPreviewRateChange: ["admin"],
    rpcSetStaffPin: ["admin"],
  };

  it("the contract lists the five, each needing a session, with their roles", () => {
    for (const [name, roles] of Object.entries(ROLES_OF)) {
      expect(contract.get(name)).toMatchObject({ params: name === "rpcGetStaffAdmin" ? ["token"] : ["token", "input"], roles, needs_session: true, migrate: true });
    }
  });

  for (const [name, roles] of Object.entries(ROLES_OF)) {
    it(`${name}: answers ${roles.join(" and ")}; refuses the other roles and no token, writing nothing`, async () => {
      const people: Array<[string, Session["role"]]> = [
        ["S_001", "admin"],
        ["S_002", "manager"],
        ["S_006", "payroll_admin"],
        ["S_003", "employee"],
      ];
      for (const [id, role] of people) {
        await seed();
        const t = await tokenOf(id);
        const before = await snapshot(["staff", "audit_log", "attendance"]);
        const out = await call(name, [t, ...VALID[name]!()]);
        if (roles.includes(role)) {
          expect(out.ok, `${name} as ${role}: ${out.error?.message}`).toBe(true);
        } else {
          expect(out.error?.message).toBe(`FORBIDDEN: requires ${roles.join(" or ")}, got ${role}`);
          expect(await snapshot(["staff", "audit_log", "attendance"])).toBe(before);
        }
      }
      for (const t of [undefined, "", "nope"]) expect((await call(name, [t, ...VALID[name]!()])).error?.message).toBe("NOT_LOGGED_IN");
    });
  }

  it("a manager's add: another role, a rate, an email or notes are each refused, and nothing is written", async () => {
    const t = await tokenOf("S_002");
    const before = await snapshot(["staff", "audit_log"]);
    const refused: Array<[Record<string, unknown>, string]> = [
      [{ role: "manager" }, "A manager can add an employee only."],
      [{ role: "admin" }, "A manager can add an employee only."],
      [{ role: "payroll_admin" }, "A manager can add an employee only."],
      [{ hourlyRate: 18 }, "Only an admin sets a pay rate."],
      [{ hourlyRate: "0" }, "Only an admin sets a pay rate."],
      [{ email: "hana@example.test" }, "Only an admin sets an email or notes."],
      [{ notes: "Knows the lotto machine" }, "Only an admin sets an email or notes."],
    ];
    for (const [patch, message] of refused) expect((await call("rpcCreateStaff", [t, newPerson(patch)])).error?.message).toBe(message);
    expect(await snapshot(["staff", "audit_log"])).toBe(before);
    // With none of those, and no role at all, the manager adds an employee.
    const ok = await call("rpcCreateStaff", [t, { name: "Hana Park", companies: ["cstore"], startDate: "2026-06-15", pin: "4826" }]);
    expect(ok.ok).toBe(true);
    expect(ok.result).toEqual({ staffId: "S_008", name: "Hana Park", role: "employee", companies: ["cstore"], active: true, hasPin: true });
    expect((await staffRow("S_008")).hourly_rate).toBeNull();
  });

  it("a role or actorId planted in the input changes nothing: the audit row and the view follow the session", async () => {
    const t = await tokenOf("S_002");
    const out = await call("rpcCreateStaff", [t, newPerson({ actorId: "S_001", viewerRole: "admin", sessionRole: "admin" })]);
    expect(out.ok).toBe(true);
    expect(Object.keys(out.result).sort()).toEqual(["active", "companies", "hasPin", "name", "role", "staffId"]);
    const a = await audits();
    expect(a.map((r) => [r.actor_id, r.action, r.target_id])).toEqual([["S_002", "staff.create", "S_008"]]);
    const list = await call("rpcGetStaffAdmin", [t, { role: "admin" }]);
    expect(list.result.viewerRole).toBe("manager");
    expect(list.result.staff[0].hourlyRate).toBeUndefined();
    const admin = await tokenOf("S_001");
    const u = await call("rpcUpdateStaff", [admin, edit("S_005", { notes: "x", actorId: "S_006", role: "employee" })]);
    expect(u.ok).toBe(true);
    expect((await audits()).at(-1).actor_id).toBe("S_001");
  });

  it("the manager's list holds none of the admin-only fields (asserted on the keys)", async () => {
    const out = await call("rpcGetStaffAdmin", [await tokenOf("S_002")]);
    expect(Object.keys(out.result).sort()).toEqual(["staff", "viewerRole"]);
    for (const p of out.result.staff) expect(Object.keys(p).sort()).toEqual(["active", "companies", "hasPin", "name", "role", "staffId"]);
    expect(out.text).not.toMatch(/hourlyRate|email|notes|cashHeld|openTills|lockedOut|cashManager|pbkdf2|pin_hash/);
    expect(out.text).not.toContain("cleo@example.test");
  });

  it("the handlers check the role themselves too (a defence if the contract file were wrong)", async () => {
    for (const who of [session("S_006", "payroll_admin"), session("S_003", "employee")]) {
      for (const [h, args] of [
        [rpcGetStaffAdmin, []],
        [rpcCreateStaff, [newPerson()]],
        [rpcUpdateStaff, [edit("S_005")]],
        [rpcPreviewRateChange, [{ staffId: "S_003", hourlyRate: 22, applyRateFrom: "2026-05-15" }]],
        [rpcSetStaffPin, [{ staffId: "S_005", pin: "8642" }]],
      ] as const) {
        await expect(rpc(h, who, [...args])).rejects.toThrow(/^FORBIDDEN: requires admin/);
        await expect(rpc(h, null, [...args])).rejects.toThrow("NOT_LOGGED_IN");
      }
    }
    for (const [h, args] of [
      [rpcUpdateStaff, [edit("S_005")]],
      [rpcPreviewRateChange, [{ staffId: "S_003", hourlyRate: 22, applyRateFrom: "2026-05-15" }]],
      [rpcSetStaffPin, [{ staffId: "S_005", pin: "8642" }]],
    ] as const) {
      await expect(rpc(h, MANAGER, [...args])).rejects.toThrow("FORBIDDEN: requires admin, got manager");
    }
    expect(await staffCount()).toBe(STAFF.length);
    for (const h of [rpcCreateStaff, rpcUpdateStaff, rpcPreviewRateChange, rpcSetStaffPin]) await expect(rpc(h, ADMIN, [null])).rejects.toThrow("input is required");
  });
});

// ── The list ───────────────────────────────────────────────

describe("rpcGetStaffAdmin", () => {
  async function decorate() {
    // Eli has the vape till open; Cleo closed hers with $200 taken out and not yet handed over.
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ('A_20260610_S_005','S_005','2026-06-10','in_progress'), ('A_20260609_S_003','S_003','2026-06-09','worked')");
    await owner.query(
      `insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time, end_time, cash_removed_at_close) values
        ('VAP-20260610-S_005','A_20260610_S_005','S_005','vape','2026-06-10','open','2026-06-10T13:00:00Z',null,null),
        ('CST-20260609-S_003','A_20260609_S_003','S_003','cstore','2026-06-09','closed','2026-06-09T13:00:00Z','2026-06-09T21:00:00Z',200)`,
    );
    // Cleo has five failed sign-ins in the last hour: locked out.
    for (let i = 0; i < 5; i++) await owner.query("insert into ops.login_failures (name_key, failed_at) values ('cleo marsh', $1)", [new Date(NOW.getTime() - (10 - i) * 60_000)]);
    // Eli had five, long ago: not locked out any more.
    for (let i = 0; i < 5; i++) await owner.query("insert into ops.login_failures (name_key, failed_at) values ('eli stone', $1)", [new Date(NOW.getTime() - 3 * 3600_000)]);
    await owner.query("insert into ops.config (key, value) values ('cash_manager_staff_id', 'S_002')");
  }

  it("an admin sees everyone, active first then by name, with every field; a blank rate is null, never 0", async () => {
    await decorate();
    const out = await listAs();
    expect(out.viewerRole).toBe("admin");
    expect(out.cashManagerStaffId).toBe("S_002");
    expect(out.staff.map((p: any) => p.name)).toEqual(["Ada Quill", "Bram Hale", "Cleo Marsh", "Dara Vance", "Eli Stone", "Fay Ruiz", "Gus Lowe"]);
    const by = (id: string) => out.staff.find((p: any) => p.staffId === id);
    expect(by("S_003")).toEqual({
      staffId: "S_003",
      name: "Cleo Marsh",
      role: "employee",
      companies: ["cstore"],
      active: true,
      hourlyRate: 20,
      startDate: "2025-03-01",
      email: "cleo@example.test",
      notes: "Prefers mornings",
      hasPin: true,
      lockedOut: true,
      openTills: [],
      cashHeld: 200,
    });
    expect(by("S_004")).toMatchObject({ hourlyRate: null, hasPin: false, companies: ["vape"], startDate: null, email: "", notes: "" });
    expect(by("S_005")).toMatchObject({ openTills: ["vape"], lockedOut: false, cashHeld: 0 });
    expect(by("S_006")).toMatchObject({ companies: [] });
    expect(by("S_007")).toMatchObject({ active: false });
  });

  it("an inactive person comes after every active one, whatever the name", async () => {
    await owner.query("update ops.staff set active = false where staff_id = 'S_001'");
    await owner.query("insert into ops.staff (staff_id, name, active, role) values ('S_010', 'Zed Admin', true, 'admin')");
    const out = await rpc(rpcGetStaffAdmin, session("S_010", "admin"), []);
    expect(out.staff.map((p: any) => [p.name, p.active])).toEqual([
      ["Bram Hale", true],
      ["Cleo Marsh", true],
      ["Dara Vance", true],
      ["Eli Stone", true],
      ["Fay Ruiz", true],
      ["Zed Admin", true],
      ["Ada Quill", false],
      ["Gus Lowe", false],
    ]);
  });

  it("never returns a PIN hash to anyone", async () => {
    for (const who of [ADMIN, MANAGER]) {
      const text = JSON.stringify(await listAs(who));
      expect(text).not.toMatch(/pbkdf2|pin_?hash/i);
      for (const h of hashes.values()) expect(text).not.toContain(h.split("$")[3]);
    }
  });

  it("reads a fixed number of times, whatever the number of people (no query per person)", async () => {
    async function count(): Promise<number> {
      let n = 0;
      await withTransaction(db, async (tx) => {
        const counting = { ...tx, query: (t: string, p?: readonly unknown[]) => (n++, tx.query(t, p)), one: (t: string, p?: readonly unknown[]) => (n++, tx.one(t, p)), maybeOne: (t: string, p?: readonly unknown[]) => (n++, tx.maybeOne(t, p)) } as typeof tx;
        await staffAdmin.list(counting, await loadConfig(tx), { staffId: "S_001", role: "admin" }, NOW);
      });
      return n;
    }
    await decorate();
    const few = await count();
    for (let i = 20; i < 60; i++) await owner.query("insert into ops.staff (staff_id, name, active, role) values ($1, $2, true, 'employee')", [`S_${i}0`, `Person ${i}`]);
    expect(await count()).toBe(few);
    expect(few).toBeLessThanOrEqual(6);
  });
});

// ── Adding a person ────────────────────────────────────────

describe("rpcCreateStaff", () => {
  it("adds a person with every field: the next id, active, created now, the companies as the table's comma list", async () => {
    const out = await create(newPerson({ name: "  Hana Park ", role: "manager", companies: ["vape", "cstore"], hourlyRate: "19.5", startDate: "2026-06-15", email: "hana@example.test", notes: "Starts Monday" }));
    expect(out).toEqual({
      staffId: "S_008",
      name: "Hana Park",
      role: "manager",
      companies: ["cstore", "vape"],
      active: true,
      hourlyRate: 19.5,
      startDate: "2026-06-15",
      email: "hana@example.test",
      notes: "Starts Monday",
      hasPin: true,
      lockedOut: false,
      openTills: [],
      cashHeld: 0,
    });
    const row = await staffRow("S_008");
    expect(row).toMatchObject({ name: "Hana Park", hourly_rate: 19.5, active: true, role: "manager", companies_authorized: "cstore,vape", start_date: "2026-06-15", email: "hana@example.test", notes: "Starts Monday" });
    expect(row.created_at.toISOString()).toBe(NOW.toISOString());
    expect(row.pin_hash).toMatch(/^pbkdf2-sha256\$100000\$/);
  });

  it("a blank rate is stored NULL ('no rate yet'), never 0, and reads back null", async () => {
    for (const blank of ["", "  ", null, undefined]) {
      await seed();
      await create(newPerson({ hourlyRate: blank }));
      expect((await staffRow("S_008")).hourly_rate).toBeNull();
      expect((await listAs()).staff.find((p: any) => p.staffId === "S_008").hourlyRate).toBeNull();
    }
    await seed();
    await create(newPerson({ hourlyRate: 0 }));
    expect((await staffRow("S_008")).hourly_rate).toBe(0);
  });

  it("blank email, notes, start date and an empty tills list are stored NULL", async () => {
    await create(newPerson({ companies: [] }));
    expect(await staffRow("S_008")).toMatchObject({ companies_authorized: null, email: null, notes: null, start_date: null });
  });

  const REFUSED: Array<[string, Record<string, unknown>, string | RegExp]> = [
    ["no name", { name: "" }, "A name is required."],
    ["only spaces", { name: "   " }, "A name is required."],
    ["a name that is not text", { name: 42 }, "A name is required."],
    ["81 characters", { name: "A".repeat(81) }, "A name can be at most 80 characters."],
    ["a line break in the name", { name: "Hana\nPark" }, "A name cannot contain control characters (such as a line break)."],
    ["the name of an active person, another case and spacing", { name: "ada   QUILL" }, "There is already an active person called Ada Quill."],
    ["an unknown role", { role: "owner" }, "role must be one of employee, manager, payroll_admin, admin."],
    ["no role from an admin", { role: "" }, "role must be one of employee, manager, payroll_admin, admin."],
    ["a till twice", { companies: ["cstore", "cstore"] }, "Each till can be listed once."],
    ["an unknown till", { companies: ["bar"] }, "Tills must be cstore and/or vape."],
    ["tills not a list", { companies: "cstore" }, "Tills must be a list (cstore, vape, both or none)."],
    ["a negative rate", { hourlyRate: -1 }, "The hourly rate must be a plain number from 0 to 1000, with at most 4 decimals, or blank."],
    ["a rate over 1000", { hourlyRate: "1000.01" }, /^The hourly rate must be/],
    ["five decimals", { hourlyRate: 18.12345 }, /^The hourly rate must be/],
    ["a rate that is not a number", { hourlyRate: "abc" }, /^The hourly rate must be/],
    ["an exponent", { hourlyRate: "1e2" }, /^The hourly rate must be/],
    ["a rate that is NaN-like", { hourlyRate: "NaN" }, /^The hourly rate must be/],
    ["a rate that is true", { hourlyRate: true }, /^The hourly rate must be/],
    ["a start date that does not exist", { startDate: "2026-02-30" }, "The start date must be a real date (YYYY-MM-DD), or blank."],
    ["a start date in another shape", { startDate: "2026/01/01" }, "The start date must be a real date (YYYY-MM-DD), or blank."],
    ["an email with no @", { email: "hana.example.test" }, "The email must be one address such as name@example.com, at most 200 characters, or blank."],
    ["an email with no dot after @", { email: "hana@example" }, /^The email must be one address/],
    ["two emails", { email: "a@example.test, b@example.test" }, /^The email must be one address/],
    ["an email over 200 characters", { email: "a".repeat(190) + "@example.test" }, /^The email must be one address/],
    ["notes over 500 characters", { notes: "n".repeat(501) }, "Notes can be at most 500 characters."],
    ["a control character in the notes", { notes: "first\u0007second" }, "Notes cannot contain control characters (such as a line break)."],
    ["no PIN", { pin: "" }, "The PIN must be 4 to 8 digits."],
    ["three digits", { pin: "123" }, "The PIN must be 4 to 8 digits."],
    ["nine digits", { pin: "123456789" }, "The PIN must be 4 to 8 digits."],
    ["a letter", { pin: "12a4" }, "The PIN must be 4 to 8 digits."],
    ["a PIN sent as a number", { pin: 4826 }, "The PIN must be 4 to 8 digits."],
  ];
  for (const [what, patch, message] of REFUSED) {
    it(`refuses ${what}, and writes nothing`, async () => {
      const before = await snapshot(["staff", "audit_log"]);
      await expect(create(newPerson(patch))).rejects.toThrow(message);
      expect(await snapshot(["staff", "audit_log"])).toBe(before);
    });
  }

  it("accepts the edges: 80 characters, the name of someone who has left, rates 0, 1000 and 4 decimals, 4- and 8-digit PINs", async () => {
    const ok: Array<Record<string, unknown>> = [
      { name: "B".repeat(80) },
      { name: "Gus Lowe" },
      { name: "Rate Zero", hourlyRate: 0 },
      { name: "Rate Max", hourlyRate: "1000" },
      { name: "Rate Fine", hourlyRate: 18.1234 },
      { name: "Pin Long", pin: "12345678" },
      { name: "Pin Short", pin: "0000" },
      { name: "Nobody's Till", companies: [] },
      { name: "Both Tills", companies: ["cstore", "vape"] },
    ];
    for (const patch of ok) await expect(create(newPerson(patch))).resolves.toMatchObject({ active: true });
    expect(await staffCount()).toBe(STAFF.length + ok.length);
  });

  it("the id is the next S_NNN after the highest of that shape: S_010 after S_009, S_100 after S_099, S_1000 after S_999", async () => {
    for (const [highest, next] of [
      ["S_009", "S_010"],
      ["S_099", "S_100"],
      ["S_999", "S_1000"],
      ["S_1000", "S_1001"],
    ]) {
      await seed();
      await owner.query("insert into ops.staff (staff_id, name, active, role) values ($1, 'Old Record', false, 'employee')", [highest]);
      expect((await create(newPerson())).staffId).toBe(next);
    }
  });

  it("ids of another shape are ignored", async () => {
    for (const odd of ["X_900", "S_ABC", "staff9", "S_12", "S_0450x", " S_500"]) {
      await owner.query("insert into ops.staff (staff_id, name, active, role) values ($1, 'Odd Record', false, 'employee')", [odd]);
    }
    expect((await create(newPerson())).staffId).toBe("S_008");
  });

  it("an empty staff table starts at S_001", async () => {
    await owner.query("delete from ops.staff");
    // The defensive check reads nothing about the caller from the table: a session is enough.
    expect((await create(newPerson())).staffId).toBe("S_001");
  });

  it("one audit row staff.create with the record after (no PIN, no hash); from a manager it names the manager", async () => {
    await create(newPerson({ hourlyRate: 17 }));
    await create(newPerson({ name: "Ivo Grant", hourlyRate: "" }), MANAGER);
    const a = await audits();
    expect(a.map((r) => [r.actor_id, r.action, r.target_type, r.target_id])).toEqual([
      ["S_001", "staff.create", "staff", "S_008"],
      ["S_002", "staff.create", "staff", "S_009"],
    ]);
    expect(a[0].before).toBeNull();
    expect(JSON.parse(a[0].after)).toEqual({ staffId: "S_008", name: "Hana Park", role: "employee", companies: ["cstore"], active: true, hourlyRate: 17, startDate: null, email: null, notes: null, createdAt: NOW.toISOString(), hasPin: true });
    expect(JSON.parse(a[1].after).hourlyRate).toBeNull();
  });

  it("the new person can sign in with that PIN through the real sign-in call, and not with another", async () => {
    const admin = await tokenOf("S_001");
    expect((await call("rpcCreateStaff", [admin, newPerson({ pin: "4826" })])).ok).toBe(true);
    expect((await signIn("Hana Park", "4825")).result).toEqual({ success: false, error: "Invalid name or code" });
    const ok = await signIn("Hana Park", "4826");
    expect(ok.result).toMatchObject({ success: true, staffId: "S_008", name: "Hana Park", role: "employee", companiesAuthorized: ["cstore"] });
    // and their session works for an ordinary call
    expect((await call("rpcGetMe", [ok.result.token])).result).toMatchObject({ staffId: "S_008", role: "employee" });
  });
});

// ── Changing a person ──────────────────────────────────────

describe("rpcUpdateStaff", () => {
  it("sets the person to exactly what the input says; no reason needed for details", async () => {
    const out = await update(edit("S_003", { name: "Cleo  Marsh-Day", companies: ["cstore", "vape"], startDate: "", email: "", notes: "Mornings and Saturdays" }));
    expect(out.record).toMatchObject({ staffId: "S_003", name: "Cleo  Marsh-Day", companies: ["cstore", "vape"], startDate: null, email: "", notes: "Mornings and Saturdays", hourlyRate: 20 });
    expect(out).toMatchObject({ changed: true, daysChanged: 0, owedBefore: null, owedAfter: null, skippedPaid: [], cashHeld: 0 });
    expect(await staffRow("S_003")).toMatchObject({ companies_authorized: "cstore,vape", start_date: null, email: null, notes: "Mornings and Saturdays" });
  });

  it("an unknown person is refused", async () => {
    await expect(update(edit("S_003", { staffId: "S_404" }))).rejects.toThrow("Staff not found: S_404");
  });

  it("the same field rules as adding: a refusal writes nothing", async () => {
    const before = await snapshot(["staff", "audit_log"]);
    for (const [patch, message] of [
      [{ name: "" }, "A name is required."],
      [{ name: "Eli stone" }, "There is already an active person called Eli Stone."],
      [{ role: "owner" }, /^role must be one of/],
      [{ companies: ["cstore", "bar"] }, "Tills must be cstore and/or vape."],
      [{ hourlyRate: "-3", reason: "Fix" }, /^The hourly rate must be/],
      [{ startDate: "2026-13-01" }, /^The start date must be/],
      [{ email: "x@" }, /^The email must be/],
      [{ notes: "n".repeat(501) }, "Notes can be at most 500 characters."],
      [{ active: "yes" }, "active must be true or false."],
    ] as Array<[Record<string, unknown>, string | RegExp]>) {
      await expect(update(edit("S_003", patch))).rejects.toThrow(message);
    }
    expect(await snapshot(["staff", "audit_log"])).toBe(before);
  });

  it("the name check ignores the person themselves; a name matching someone who has left is fine", async () => {
    await expect(update(edit("S_003", { name: "CLEO MARSH" }))).resolves.toMatchObject({ changed: true });
    await expect(update(edit("S_005", { name: "gus lowe" }))).resolves.toMatchObject({ changed: true });
  });

  it("reactivating someone whose name now matches an active person is refused", async () => {
    await create(newPerson({ name: "Gus Lowe" }));
    await expect(update(edit("S_007", { active: true, reason: "Back for the summer" }))).rejects.toThrow("There is already an active person called Gus Lowe.");
  });

  it("a reason of 3 to 300 characters is required when the rate, the role or active changes", async () => {
    for (const patch of [{ hourlyRate: 21 }, { role: "manager" }, { active: false }]) {
      for (const reason of ["", "ok", "x".repeat(301), "bad\nreason"]) {
        await expect(update(edit("S_005", { ...patch, reason }))).rejects.toThrow(reason.includes("\n") ? "The reason cannot contain control characters (such as a line break)." : "A reason is required (3 to 300 characters) when the rate, the role or active changes.");
      }
    }
    expect(await audits()).toEqual([]);
    await expect(update(edit("S_005", { hourlyRate: 21, reason: "Annual raise" }))).resolves.toMatchObject({ changed: true });
  });

  it("an unchanged rate needs no reason, whether written 18, '18' or '18.0000'", async () => {
    for (const r of [18, "18", "18.0000"]) await expect(update(edit("S_005", { hourlyRate: r, notes: "n" }))).resolves.toBeTruthy();
  });

  it("the last active admin cannot be demoted or deactivated", async () => {
    await expect(update(edit("S_001", { role: "manager", reason: "Stepping back" }))).rejects.toThrow("Ada Quill is the only active admin.");
    await expect(update(edit("S_001", { active: false, reason: "Leaving" }))).rejects.toThrow("Ada Quill is the only active admin.");
    // Called from below the router (where a session can be older than a change), the rule still holds for another admin's target.
    await expect(withTransaction(db, (tx) => staffAdmin.update(tx, edit("S_001", { active: false, reason: "Leaving" }), { staffId: "S_006", role: "admin" }, { now: NOW, config: Config.fromRows([]) }))).rejects.toThrow("Ada Quill is the only active admin.");
    expect(await staffRow("S_001")).toMatchObject({ role: "admin", active: true });
  });

  it("nobody deactivates or demotes themselves, even with another admin about", async () => {
    await owner.query("update ops.staff set role = 'admin' where staff_id = 'S_006'");
    await expect(update(edit("S_001", { active: false, reason: "Leaving" }))).rejects.toThrow("You cannot deactivate yourself: ask another admin.");
    await expect(update(edit("S_001", { role: "payroll_admin", reason: "Stepping back" }))).rejects.toThrow("You cannot change your own role: ask another admin.");
    // Another admin may.
    const fay = session("S_006", "admin");
    await expect(update(edit("S_001", { role: "manager", reason: "Stepping back" }), fay)).resolves.toMatchObject({ changed: true });
  });

  it("deactivating is refused while the person has an open till", async () => {
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ('A_20260610_S_005','S_005','2026-06-10','in_progress')");
    await owner.query("insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time) values ('VAP-20260610-S_005','A_20260610_S_005','S_005','vape','2026-06-10','open','2026-06-10T13:00:00Z')");
    await expect(update(edit("S_005", { active: false, reason: "Leaving" }))).rejects.toThrow("Close Eli Stone's till first.");
    expect((await staffRow("S_005")).active).toBe(true);
  });

  it("deactivating is refused while the setting cash_manager_staff_id names them", async () => {
    await owner.query("insert into ops.config (key, value) values ('cash_manager_staff_id', ' S_002 ')");
    await expect(update(edit("S_002", { active: false, reason: "Leaving" }))).rejects.toThrow("Bram Hale is the cash manager: name someone else in Settings first.");
    await owner.query("update ops.config set value = 'S_001' where key = 'cash_manager_staff_id'");
    await expect(update(edit("S_002", { active: false, reason: "Leaving" }))).resolves.toMatchObject({ changed: true });
  });

  it("deactivating someone who holds shop cash is allowed; the answer says how much", async () => {
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ('A_20260609_S_003','S_003','2026-06-09','worked')");
    await owner.query("insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, cash_removed_at_close) values ('CST-20260609-S_003','A_20260609_S_003','S_003','cstore','2026-06-09','closed',212.5)");
    const out = await update(edit("S_003", { active: false, reason: "Moved away" }));
    expect(out).toMatchObject({ changed: true, cashHeld: 212.5 });
    expect(out.record).toMatchObject({ active: false, cashHeld: 212.5 });
  });

  it("deactivating signs the person out everywhere at once: their next call through the router is refused; reactivating lets them sign in again", async () => {
    const t1 = await tokenOf("S_003");
    const t2 = await tokenOf("S_003", new Date(NOW.getTime() - 3600_000));
    expect(await sessionsOf("S_003")).toBe(2);
    expect((await call("rpcGetMe", [t1])).ok).toBe(true);
    const admin = await tokenOf("S_001");
    expect((await call("rpcUpdateStaff", [admin, edit("S_003", { active: false, reason: "Moved away" })])).ok).toBe(true);
    expect(await sessionsOf("S_003")).toBe(0);
    for (const t of [t1, t2]) expect((await call("rpcGetMe", [t])).error?.message).toBe("NOT_LOGGED_IN");
    expect((await signIn("Cleo Marsh", "3333")).result).toEqual({ success: false, error: "Account is inactive" });
    expect(await sessionsOf("S_001")).toBe(1); // nobody else is signed out
    expect((await call("rpcUpdateStaff", [admin, edit("S_003", { active: true, reason: "Back again" })])).result.record.active).toBe(true);
    expect((await signIn("Cleo Marsh", "3333")).result).toMatchObject({ success: true, staffId: "S_003" });
  });

  it("a role change applies at once: the next call of a person already signed in uses the new role", async () => {
    const cleo = await tokenOf("S_003");
    expect((await call("rpcGetStaffAdmin", [cleo])).error?.message).toBe("FORBIDDEN: requires admin or manager, got employee");
    const admin = await tokenOf("S_001");
    expect((await call("rpcUpdateStaff", [admin, edit("S_003", { role: "manager", reason: "Promoted to manager" })])).ok).toBe(true);
    expect(await sessionsOf("S_003")).toBe(1); // not signed out
    const after = await call("rpcGetStaffAdmin", [cleo]);
    expect(after.ok).toBe(true);
    expect(after.result.viewerRole).toBe("manager");
    expect((await call("rpcGetMe", [cleo])).result.role).toBe("manager");
    // and back
    expect((await call("rpcUpdateStaff", [admin, edit("S_003", { role: "employee", reason: "Back to employee" })])).ok).toBe(true);
    expect((await call("rpcGetStaffAdmin", [cleo])).error?.message).toBe("FORBIDDEN: requires admin or manager, got employee");
  });

  it("one audit row staff.update: the whole record before and after (no hash) and the reason", async () => {
    await update(edit("S_005", { hourlyRate: 19, role: "manager", reason: "Runs the vape side now" }));
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_id: "S_001", action: "staff.update", target_type: "staff", target_id: "S_005", details: "Runs the vape side now" });
    const fields = { staffId: "S_005", name: "Eli Stone", companies: ["vape"], active: true, startDate: null, email: null, notes: null, createdAt: "2025-01-01T12:00:00.000Z", hasPin: true };
    expect(JSON.parse(a[0].before)).toEqual({ ...fields, role: "employee", hourlyRate: 18 });
    expect(JSON.parse(a[0].after)).toEqual({ ...fields, role: "manager", hourlyRate: 19 });
    expect(a[0].before + a[0].after).not.toMatch(/pbkdf2/);
  });

  it("nothing changed: no write and no audit row", async () => {
    const out = await update(edit("S_005"));
    expect(out).toMatchObject({ changed: false, daysChanged: 0 });
    expect(await audits()).toEqual([]);
  });

  it("a new rate without a date applies from now on: days already worked keep the rate they were worked at", async () => {
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, hours_worked, rate_at_attendance, status) values ('A_20260608_S_005','S_005','2026-06-08',8,18,'worked'), ('A_20260609_S_005','S_005','2026-06-09',4,null,'worked')");
    const out = await update(edit("S_005", { hourlyRate: 19.25, reason: "Raise" }));
    expect(out).toMatchObject({ daysChanged: 0, owedBefore: null, owedAfter: null });
    expect((await staffRow("S_005")).hourly_rate).toBe(19.25);
    expect((await db.query<any>("select rate_at_attendance as r from ops.attendance where staff_id = 'S_005' order by date")).map((x) => x.r)).toEqual([18, null]);
  });

  it("a rate can be made blank again (stored NULL, with a reason)", async () => {
    await update(edit("S_005", { hourlyRate: "", reason: "Rate to be agreed" }));
    expect((await staffRow("S_005")).hourly_rate).toBeNull();
  });

  it("applyRateFrom is refused with an unchanged or blank rate, a future day, more than 370 days back, or an unreadable date", async () => {
    const msg = "Unpaid days can take a new rate only when the rate changes to an amount: change the rate, or leave the date blank.";
    await expect(update(edit("S_005", { applyRateFrom: "2026-06-01", reason: "Raise" }))).rejects.toThrow(msg);
    await expect(update(edit("S_005", { hourlyRate: "", applyRateFrom: "2026-06-01", reason: "No rate" }))).rejects.toThrow(msg);
    await expect(update(edit("S_005", { hourlyRate: 19, applyRateFrom: "2026-06-11", reason: "Raise" }))).rejects.toThrow("The date to apply the rate from cannot be in the future.");
    await expect(update(edit("S_005", { hourlyRate: 19, applyRateFrom: "2025-06-04", reason: "Raise" }))).rejects.toThrow("The date to apply the rate from cannot be more than 370 days ago.");
    await expect(update(edit("S_005", { hourlyRate: 19, applyRateFrom: "2026-02-30", reason: "Raise" }))).rejects.toThrow("The date to apply the rate from must be a real date (YYYY-MM-DD), or blank.");
    // the edges: today and exactly 370 days back
    await expect(update(edit("S_005", { hourlyRate: 19, applyRateFrom: "2026-06-10", reason: "Raise" }))).resolves.toMatchObject({ daysChanged: 0 });
    await expect(update(edit("S_005", { hourlyRate: 20, applyRateFrom: "2025-06-05", reason: "Raise" }))).resolves.toMatchObject({ daysChanged: 0 });
  });
});

// ── The raise, end to end with payroll ─────────────────────

describe("the raise reaches unpaid days, end to end with payroll", () => {
  const FROM = "2026-05-15";
  async function cleoDays() {
    const days: Array<[string, number | null, number | null, string]> = [
      ["2026-05-01", 8, 20, "worked"], // before the date: untouched
      ["2026-05-18", 8, 20, "worked"], // paid in full ($160)
      ["2026-05-19", 6, 20, "worked"], // partly paid ($50 of $120)
      ["2026-05-20", 5, 20, "worked"], // its payment was voided: counts for nothing
      ["2026-05-21", 4, null, "worked"], // no rate recorded
      ["2026-05-22", 7, 0, "worked"], // the 0 the old code wrote for "no rate yet"
      ["2026-05-23", 0, 0, "cancelled"],
      ["2026-05-24", 3, 20, "worked"], // unpaid
      ["2026-06-10", null, 0, "in_progress"],
      ["2026-06-12", 0, 0, "scheduled"],
    ];
    for (const [date, hours, rate, status] of days) {
      await owner.query("insert into ops.attendance (attendance_id, staff_id, date, hours_worked, rate_at_attendance, status, created_at) values ($1, 'S_003', $2, $3, $4, $5, $6)", [
        `A_${date.replaceAll("-", "")}_S_003`,
        date,
        hours,
        rate,
        status,
        `${date}T12:00:00Z`,
      ]);
    }
    // Eli worked the same days: a raise for Cleo must not touch him.
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, hours_worked, rate_at_attendance, status) values ('A_20260520_S_005','S_005','2026-05-20',5,18,'worked')");
    await owner.query(
      `insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method, recorded_by, voided_at, voided_by) values
        ('P_20260601_120000_aaa','S_003','2026-06-01',160,'cash','S_006',null,null),
        ('P_20260602_120000_bbb','S_003','2026-06-02',50,'cash','S_006',null,null),
        ('P_20260603_120000_ccc','S_003','2026-06-03',100,'cash','S_006','2026-06-04T12:00:00Z','S_006')`,
    );
    await owner.query(
      `insert into ops.payment_items (item_id, payment_id, item_type, ref_id, amount) values
        ('IT_1','P_20260601_120000_aaa','shift','A_20260518_S_003',160),
        ('IT_2','P_20260602_120000_bbb','shift','A_20260519_S_003',50),
        ('IT_3','P_20260603_120000_ccc','shift','A_20260520_S_003',100)`,
    );
  }
  const rates = async () => Object.fromEntries((await db.query<any>("select date, rate_at_attendance as r from ops.attendance where staff_id = 'S_003' order by date")).map((x) => [x.date, x.r]));
  const owed = async (id = "S_003") => (await payments.getOwedSummary(db, id)).shiftsOwed;
  const SKIPPED = [
    { date: "2026-05-18", paid: 160 },
    { date: "2026-05-19", paid: 50 },
  ];

  it("preview answers the figures and changes nothing (every table the same before and after)", async () => {
    await cleoDays();
    const all = ["staff", "attendance", "audit_log", "sessions", "login_failures", "config", ...MONEY_TABLES];
    const before = await snapshot(all);
    const p = await preview({ staffId: "S_003", hourlyRate: "22", applyRateFrom: FROM });
    expect(p).toEqual({ days: 4, owedBefore: 160, owedAfter: 418, skippedPaid: SKIPPED });
    expect(await snapshot(all)).toBe(before);
  });

  it("preview refuses what the save would refuse", async () => {
    await cleoDays();
    const msg = "Unpaid days can take a new rate only when the rate changes to an amount: change the rate, or leave the date blank.";
    await expect(preview({ staffId: "S_003", hourlyRate: 20, applyRateFrom: FROM })).rejects.toThrow(msg);
    await expect(preview({ staffId: "S_003", hourlyRate: "", applyRateFrom: FROM })).rejects.toThrow(msg);
    await expect(preview({ staffId: "S_003", hourlyRate: 22, applyRateFrom: "" })).rejects.toThrow("The date to apply the rate from must be a real date (YYYY-MM-DD), or blank.");
    await expect(preview({ staffId: "S_003", hourlyRate: 22, applyRateFrom: "2026-06-11" })).rejects.toThrow("The date to apply the rate from cannot be in the future.");
    await expect(preview({ staffId: "S_404", hourlyRate: 22, applyRateFrom: FROM })).rejects.toThrow("Staff not found: S_404");
    await expect(preview({ staffId: "S_003", hourlyRate: -2, applyRateFrom: FROM })).rejects.toThrow(/^The hourly rate must be/);
  });

  it("the save re-rates exactly the unpaid worked days from the date; payroll's owed moves by exactly the difference", async () => {
    await cleoDays();
    const owedBefore = await owed();
    expect(owedBefore).toBe(390); // 160 (May 1) + 70 (rest of May 19) + 100 (May 20, its payment voided) + 60 (May 24); May 21 and 22 are worth nothing at no rate
    const eliBefore = await owed("S_005");
    const out = await update(edit("S_003", { hourlyRate: 22, applyRateFrom: FROM, reason: "Raise from mid-May, agreed in June" }));
    expect(out).toMatchObject({ changed: true, daysChanged: 4, owedBefore: 160, owedAfter: 418, skippedPaid: SKIPPED, cashHeld: 0 });
    expect(out.record.hourlyRate).toBe(22);
    expect(await rates()).toEqual({
      "2026-05-01": 20,
      "2026-05-18": 20,
      "2026-05-19": 20,
      "2026-05-20": 22,
      "2026-05-21": 22,
      "2026-05-22": 22,
      "2026-05-23": 0,
      "2026-05-24": 22,
      "2026-06-10": 0,
      "2026-06-12": 0,
    });
    expect(await owed()).toBe(Math.round((owedBefore + (418 - 160)) * 100) / 100);
    expect(await owed("S_005")).toBe(eliBefore);
    const changed = await db.query<any>("select modified_by, modified_at from ops.attendance where attendance_id = 'A_20260521_S_003'");
    expect(changed[0].modified_by).toBe("S_001");
    expect(changed[0].modified_at.toISOString()).toBe(NOW.toISOString());
  });

  it("the audit rows: staff.update with before and after, then staff.rate_applied with the date, both rates and each day changed", async () => {
    await cleoDays();
    await update(edit("S_003", { hourlyRate: 22, applyRateFrom: FROM, reason: "Raise from mid-May" }));
    const a = await audits();
    expect(a.map((r) => [r.actor_id, r.action, r.target_type, r.target_id])).toEqual([
      ["S_001", "staff.update", "staff", "S_003"],
      ["S_001", "staff.rate_applied", "staff", "S_003"],
    ]);
    expect(JSON.parse(a[0].before).hourlyRate).toBe(20);
    expect(JSON.parse(a[0].after).hourlyRate).toBe(22);
    expect(a[1].details).toBe("Raise from mid-May");
    expect(JSON.parse(a[1].after)).toEqual({
      applyRateFrom: FROM,
      oldRate: 20,
      newRate: 22,
      owedBefore: 160,
      owedAfter: 418,
      days: [
        { attendanceId: "A_20260520_S_003", date: "2026-05-20", hours: 5, rateBefore: 20 },
        { attendanceId: "A_20260521_S_003", date: "2026-05-21", hours: 4, rateBefore: null },
        { attendanceId: "A_20260522_S_003", date: "2026-05-22", hours: 7, rateBefore: 0 },
        { attendanceId: "A_20260524_S_003", date: "2026-05-24", hours: 3, rateBefore: 20 },
      ],
      skippedPaid: SKIPPED,
    });
  });

  it("someone added with no rate gets paid for their first days once a rate is given from their start", async () => {
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, hours_worked, rate_at_attendance, status) values ('A_20260608_S_004','S_004','2026-06-08',6,0,'worked'), ('A_20260609_S_004','S_004','2026-06-09',5,null,'worked')");
    expect(await owed("S_004")).toBe(0);
    const out = await update(edit("S_004", { hourlyRate: 17.5, applyRateFrom: "2026-06-08", reason: "Rate agreed" }));
    expect(out).toMatchObject({ daysChanged: 2, owedBefore: 0, owedAfter: 192.5, skippedPaid: [] });
    expect(await owed("S_004")).toBe(192.5);
  });

  it("a date with no unpaid days after it re-rates nothing: the figures are null", async () => {
    await cleoDays();
    const out = await update(edit("S_003", { hourlyRate: 22, applyRateFrom: "2026-06-01", reason: "Raise" }));
    expect(out).toMatchObject({ daysChanged: 0, owedBefore: null, owedAfter: null, skippedPaid: [] });
    expect((await audits()).map((r) => r.action)).toEqual(["staff.update"]);
  });
});

// ── Setting a PIN ──────────────────────────────────────────

describe("rpcSetStaffPin", () => {
  it("the old PIN stops working, the new one works, and every session of that person ends", async () => {
    const t1 = await tokenOf("S_003");
    const t2 = await tokenOf("S_003", new Date(NOW.getTime() - 3600_000));
    const admin = await tokenOf("S_001");
    const out = await call("rpcSetStaffPin", [admin, { staffId: "S_003", pin: "9070" }]);
    expect(out.result).toEqual({ staffId: "S_003", sessionsEnded: 2, lockoutCleared: false });
    for (const t of [t1, t2]) expect((await call("rpcGetMe", [t])).error?.message).toBe("NOT_LOGGED_IN");
    expect((await signIn("Cleo Marsh", "3333")).result).toEqual({ success: false, error: "Invalid name or code" });
    expect((await signIn("Cleo Marsh", "9070")).result).toMatchObject({ success: true });
    expect((await call("rpcGetMe", [admin])).ok).toBe(true);
  });

  it("an admin setting their own: the session making the call is kept, their other sessions end", async () => {
    const other = await tokenOf("S_001", new Date(NOW.getTime() - 7200_000));
    const mine = await tokenOf("S_001");
    const out = await call("rpcSetStaffPin", [mine, { staffId: "S_001", pin: "2468" }]);
    expect(out.result).toMatchObject({ sessionsEnded: 1 });
    expect((await call("rpcGetMe", [mine])).ok).toBe(true);
    expect((await call("rpcGetMe", [other])).error?.message).toBe("NOT_LOGGED_IN");
    expect((await signIn("Ada Quill", "2468")).result).toMatchObject({ success: true });
  });

  it("clears a lockout made by real failed sign-ins", async () => {
    for (let i = 0; i < 5; i++) expect((await signIn("Cleo Marsh", "0000")).result.success).toBe(false);
    expect((await signIn("Cleo Marsh", "3333")).result.error).toMatch(/^Too many failed attempts/);
    expect((await listAs()).staff.find((p: any) => p.staffId === "S_003").lockedOut).toBe(true);
    const out = await setPinFor({ staffId: "S_003", pin: "9070" });
    expect(out.lockoutCleared).toBe(true);
    expect((await db.one<any>("select count(*)::int as n from ops.login_failures")).n).toBe(0);
    expect((await listAs()).staff.find((p: any) => p.staffId === "S_003").lockedOut).toBe(false);
    expect((await signIn("Cleo Marsh", "9070")).result).toMatchObject({ success: true });
  });

  it("a person with no PIN yet gets one and can then sign in", async () => {
    expect((await signIn("Dara Vance", "1357")).result.success).toBe(false);
    await setPinFor({ staffId: "S_004", pin: "1357" });
    expect((await listAs()).staff.find((p: any) => p.staffId === "S_004").hasPin).toBe(true);
    expect((await signIn("Dara Vance", "1357")).result).toMatchObject({ success: true });
  });

  it("an inactive person's PIN may be set; it does not let them sign in", async () => {
    await expect(setPinFor({ staffId: "S_007", pin: "1212" })).resolves.toMatchObject({ staffId: "S_007" });
    expect((await signIn("Gus Lowe", "1212")).result).toEqual({ success: false, error: "Account is inactive" });
  });

  it("refuses a bad PIN or an unknown person, writing nothing; the audit row is staff.pin_set naming the admin", async () => {
    const before = await snapshot(["staff", "audit_log", "sessions"]);
    for (const pin of ["", "123", "123456789", "12 34", "abcd", 1234, null]) await expect(setPinFor({ staffId: "S_003", pin })).rejects.toThrow("The PIN must be 4 to 8 digits.");
    await expect(setPinFor({ staffId: "S_404", pin: "1234" })).rejects.toThrow("Staff not found: S_404");
    expect(await snapshot(["staff", "audit_log", "sessions"])).toBe(before);
    await setPinFor({ staffId: "S_005", pin: "8642" });
    expect(await audits()).toEqual([{ actor_id: "S_001", action: "staff.pin_set", target_type: "staff", target_id: "S_005", before: null, after: null, details: null }]);
  });
});

// ── The PIN never leaks ────────────────────────────────────

describe("the PIN never leaks", () => {
  it("after an add and after a set-PIN: no audit row, no answer and no thrown message holds the PIN or its hash", async () => {
    const admin = await tokenOf("S_001");
    const texts: string[] = [];
    const created = await call("rpcCreateStaff", [admin, newPerson({ pin: SECRET_PIN })]);
    expect(created.ok).toBe(true);
    texts.push(created.text);
    const hashAfterCreate = (await staffRow("S_008")).pin_hash as string;
    // refusals that carry the PIN in their input
    for (const patch of [{ name: "Ada Quill" }, { name: "" }, { role: "owner" }, { hourlyRate: "x" }]) texts.push((await call("rpcCreateStaff", [admin, newPerson({ ...patch, pin: SECRET_PIN })])).text);
    texts.push((await call("rpcCreateStaff", [await tokenOf("S_002"), newPerson({ role: "admin", pin: SECRET_PIN })])).text);
    const set = await call("rpcSetStaffPin", [admin, { staffId: "S_005", pin: SECRET_PIN }]);
    expect(set.ok).toBe(true);
    texts.push(set.text);
    texts.push((await call("rpcSetStaffPin", [admin, { staffId: "S_404", pin: SECRET_PIN }])).text);
    texts.push((await call("rpcSetStaffPin", [admin, { staffId: "S_005", pin: SECRET_PIN + "9" }])).text);
    texts.push((await call("rpcGetStaffAdmin", [admin])).text);
    const hashAfterSet = (await staffRow("S_005")).pin_hash as string;
    const auditText = JSON.stringify(await db.query("select * from ops.audit_log"));
    for (const t of [...texts, auditText]) {
      expect(t).not.toContain(SECRET_PIN);
      for (const h of [hashAfterCreate, hashAfterSet]) {
        expect(t).not.toContain(h);
        expect(t).not.toContain(h.split("$")[3] as string);
      }
    }
    // and the PIN really was set both times
    expect((await signIn("Hana Park", SECRET_PIN)).result.success).toBe(true);
    expect((await signIn("Eli Stone", SECRET_PIN)).result.success).toBe(true);
  });
});

// ── Nothing else moves ─────────────────────────────────────

describe("nothing else moves", () => {
  it("till sessions, sales, payments, payment items, bonuses and cash handovers are identical before and after every call", async () => {
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, hours_worked, rate_at_attendance, status) values ('A_20260608_S_005','S_005','2026-06-08',8,18,'worked'), ('A_20260609_S_005','S_005','2026-06-09',4,18,'worked')");
    await owner.query("insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, cash_removed_at_close) values ('VAP-20260608-S_005','A_20260608_S_005','S_005','vape','2026-06-08','closed',150)");
    await owner.query("insert into ops.sales (sales_id, session_id, staff_id, company, date, cash_sales) values ('VAP-20260608-S_005','VAP-20260608-S_005','S_005','vape','2026-06-08',312.4)");
    await owner.query("insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method) values ('P_20260609_100000_zzz','S_005','2026-06-09',144,'cash')");
    await owner.query("insert into ops.payment_items (item_id, payment_id, item_type, ref_id, amount) values ('IT_9','P_20260609_100000_zzz','shift','A_20260608_S_005',144)");
    await owner.query("insert into ops.bonuses (bonus_id, staff_id, date, type, amount, reason, status) values ('B_1','S_005','2026-06-08','bonus',15,'Tidy stockroom','pending')");
    await owner.query("insert into ops.cash_handovers (handover_id, from_staff_id, to_staff_id, amount, handed_on, recorded_by, status) values ('H_1','S_005','S_002',50,'2026-06-09','S_005','recorded')");
    const before = await snapshot(MONEY_TABLES);
    await listAs();
    await listAs(MANAGER);
    await create(newPerson());
    await create(newPerson({ name: "Ivo Grant" }), MANAGER);
    await preview({ staffId: "S_005", hourlyRate: 19, applyRateFrom: "2026-06-01" });
    await update(edit("S_005", { hourlyRate: 19, applyRateFrom: "2026-06-01", reason: "Raise", notes: "Raise in June" }));
    await update(edit("S_005", { active: false, reason: "Leaving", hourlyRate: 19, notes: "Raise in June" }));
    await setPinFor({ staffId: "S_005", pin: "8642" });
    expect(await snapshot(MONEY_TABLES)).toBe(before);
    expect(await staffCount()).toBe(STAFF.length + 2); // and no staff row is ever deleted
  });
});

// ── At the same moment ─────────────────────────────────────

describe("at the same moment (two connections)", () => {
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
  const deps = { pepper: PEPPER, config: Config.fromRows([]), now: NOW };
  const createOn = (input: Record<string, unknown>) => (tx: any) => staffAdmin.create(tx, input, { staffId: "S_001", role: "admin" }, deps);
  const updateOn = (input: Record<string, unknown>, actor = "S_001", now = NOW) => (tx: any) => staffAdmin.update(tx, input, { staffId: actor, role: "admin" }, { config: Config.fromRows([]), now });

  it("two people added at once get two different ids, and both succeed", async () => {
    const [one, two] = await overlap(createOn(newPerson({ name: "Hana Park" })), createOn(newPerson({ name: "Ivo Grant" })));
    expect(one.status).toBe("fulfilled");
    expect(two.status).toBe("fulfilled");
    const ids = [(one as PromiseFulfilledResult<any>).value.staffId, (two as PromiseFulfilledResult<any>).value.staffId];
    expect(ids).toEqual(["S_008", "S_009"]);
    expect((await db.query<any>("select staff_id, name from ops.staff where staff_id in ('S_008','S_009') order by staff_id")).map((r) => r.name)).toEqual(["Hana Park", "Ivo Grant"]);
  });

  it("the same name added twice at once: the second waits and is refused", async () => {
    const [one, two] = await overlap(createOn(newPerson()), createOn(newPerson()));
    expect(one.status).toBe("fulfilled");
    expect(String((two as PromiseRejectedResult).reason?.message)).toBe("There is already an active person called Hana Park.");
  });

  it("two admins demoting each other at once: one wins, the other is refused as the only admin left", async () => {
    await owner.query("update ops.staff set role = 'admin' where staff_id = 'S_006'");
    const [one, two] = await overlap(updateOn(edit("S_006", { role: "payroll_admin", reason: "Step down" }), "S_001"), updateOn(edit("S_001", { role: "manager", reason: "Step down" }), "S_006"));
    expect(one.status).toBe("fulfilled");
    expect(String((two as PromiseRejectedResult).reason?.message)).toBe("Ada Quill is the only active admin.");
    expect((await db.query<any>("select staff_id from ops.staff where role = 'admin' and active")).map((r) => r.staff_id)).toEqual(["S_001"]);
  });

  async function twoDays() {
    await owner.query(
      "insert into ops.attendance (attendance_id, staff_id, date, hours_worked, rate_at_attendance, status) values ('A_20260601_S_003','S_003','2026-06-01',8,20,'worked'), ('A_20260602_S_003','S_003','2026-06-02',5,20,'worked')",
    );
  }
  const pay = (amount: number, now = LATER) => (tx: any) => payments.payShifts(tx, { staffId: "S_003", amount, actorId: "S_006" }, { config: Config.fromRows([]), env: {}, fetch, now });
  const raise = (now = NOW) => updateOn(edit("S_003", { hourlyRate: 22, applyRateFrom: "2026-06-01", reason: "Raise" }), "S_001", now);

  it("a payment first, a re-rate meanwhile: the re-rate waits, then skips the paid day", async () => {
    await twoDays();
    const [p, r] = await overlap(pay(160), raise(LATER));
    expect(p.status).toBe("fulfilled");
    expect(r.status).toBe("fulfilled");
    expect((r as PromiseFulfilledResult<any>).value).toMatchObject({ daysChanged: 1, owedBefore: 100, owedAfter: 110, skippedPaid: [{ date: "2026-06-01", paid: 160 }] });
    expect((await db.query<any>("select rate_at_attendance as r from ops.attendance where staff_id = 'S_003' order by date")).map((x) => x.r)).toEqual([20, 22]);
  });

  it("a re-rate first, a payment meanwhile: the payment waits, then sees the new rates", async () => {
    await twoDays();
    const [r, p] = await overlap(raise(), pay(286));
    expect(r.status).toBe("fulfilled");
    expect((r as PromiseFulfilledResult<any>).value).toMatchObject({ daysChanged: 2, owedBefore: 260, owedAfter: 286 });
    expect(p.status).toBe("fulfilled");
    expect((p as PromiseFulfilledResult<any>).value.itemsCreated.map((i: any) => [i.attendanceId, i.amount])).toEqual([
      ["A_20260601_S_003", 176],
      ["A_20260602_S_003", 110],
    ]);
  });
});
