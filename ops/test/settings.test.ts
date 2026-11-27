// The Settings calls (card P4-09): rpcGetSettings and rpcUpdateSetting, against a real database with
// invented people. They exist only in the Operations app (ADR-0023): there is nothing to compare
// with, so these tests ARE the specification. They cover who may call, what the list shows (and never
// shows), each validation rule with a value it accepts and one it refuses, what a blank stores, that
// the app behaves differently afterwards, the audit row (phone numbers masked), two edits at once,
// and that the app's database role cannot delete a setting.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setPin } from "../src/auth/pin";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { CONFIG_KEYS, SECRET_KEYS } from "../src/lib/config-keys";
import { loadConfig } from "../src/lib/config";
import * as settings from "../src/modules/settings";
import * as ts from "../src/modules/till-sessions";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { rpcGetSettings, rpcUpdateSetting } from "../src/rpc/handlers/settings";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

const PEPPER = "test-pepper-not-a-secret";
const NOW = new Date("2026-11-20T14:00:00Z");
const LATER = new Date("2026-11-20T16:30:00Z");

// Distinctive values planted in the Worker's bindings: none of them may ever come back.
const ENV = {
  PIN_PEPPER: PEPPER,
  WHATSAPP_API_TOKEN: "WA-SECRET-aaaa1111bbbb2222",
  CLOVER_CSTORE_TOKEN: "CLV-SECRET-cccc3333dddd4444",
  CLOVER_VAPE_TOKEN: "",
  TILL_API_KEY: "TILL-SECRET-eeee5555ffff6666",
};

const contract = parseRpcContract(
  mergeOpsContract(
    JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
    JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
  ),
);

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

const STAFF: Array<[string, string, string, boolean, string]> = [
  ["S_001", "Ada Quill", "admin", true, "1111"],
  ["S_002", "Bram Hale", "manager", true, "2222"],
  ["S_003", "Cleo Marsh", "employee", true, "3333"],
  ["S_004", "Dara Vance", "payroll_admin", true, "4444"],
  ["S_005", "Eli Stone", "employee", false, "5555"],
];

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  owner = await connect(testDb.ownerUrl);
  for (const [id, name, role, active, pin] of STAFF) {
    await owner.query("insert into ops.staff (staff_id, name, active, role, companies_authorized) values ($1, $2, $3, $4, 'cstore,vape')", [id, name, active, role]);
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

function ctxFor(tx: Db, session: RpcContext["session"] = ADMIN, at = NOW, env: Record<string, unknown> = ENV): RpcContext {
  let cfg: ReturnType<typeof loadConfig> | undefined;
  return {
    db: tx as RpcContext["db"],
    session,
    config: () => (cfg ??= loadConfig(tx)),
    env,
    fetch: (() => {
      throw new Error("no network in this test");
    }) as typeof fetch,
    now: at,
  };
}

/** One RPC the way the router runs it: one transaction, committed when it returns. */
async function rpc<T = Record<string, unknown>>(handler: (c: RpcContext, ...a: unknown[]) => unknown, args: unknown[], opts: { session?: RpcContext["session"]; at?: Date; env?: Record<string, unknown> } = {}): Promise<T> {
  return withTransaction(db, async (tx) => (await handler(ctxFor(tx, "session" in opts ? opts.session! : ADMIN, opts.at ?? NOW, opts.env ?? ENV), ...args)) as T);
}
const update = (key: string, value: unknown, opts: { at?: Date } = {}) => rpc(rpcUpdateSetting, [{ key, value }], opts);
const stored = async (key: string) => (await owner.maybeOne<{ value: string | null }>("select value from ops.config where key = $1", [key]))?.value;
const hasRow = async (key: string) => (await owner.maybeOne("select 1 as x from ops.config where key = $1", [key])) !== null;
const auditRows = () => owner.query<{ actor_id: string; action: string; target_type: string; target_id: string; before: string; after: string; timestamp: Date }>("select * from ops.audit_log where action = 'config.update' order by seq");
async function refused(key: string, value: unknown, message: RegExp | string): Promise<void> {
  const before = await owner.query("select key, value from ops.config order by key");
  const audited = (await auditRows()).length;
  await expect(update(key, value)).rejects.toThrow(message);
  expect(await owner.query("select key, value from ops.config order by key")).toEqual(before);
  expect(await auditRows()).toHaveLength(audited);
}
async function accepted(key: string, value: unknown, expectStored: string | null): Promise<void> {
  const r = await update(key, value);
  expect(await stored(key)).toBe(expectStored);
  expect(r).toMatchObject({ key, value: expectStored, isDefault: expectStored === null });
}

// ── Who may call ────────────────────────────────────────────

describe("who may call", () => {
  const logged: object[] = [];
  const router = createRpcRouter({
    contract,
    handlers,
    openDb: () => connect(testDb.appUrl),
    resolveSession,
    errorPrefixed: ERROR_PREFIXED,
    env: ENV,
    now: () => NOW,
    log: (e) => logged.push(e),
  });
  async function call(name: string, args: unknown[]) {
    const res = await router(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
    return { status: res.status, body: (await res.json()) as { ok: boolean; result?: any; error?: { message: string } } };
  }
  async function token(name: string, pin: string): Promise<string> {
    const r = await call("rpcLogin", [name, pin]);
    return r.body.result.token as string;
  }

  it("the contract lists both for admin only, with a session", () => {
    for (const name of ["rpcGetSettings", "rpcUpdateSetting"]) {
      expect(contract.get(name), name).toMatchObject({ roles: ["admin"], needs_session: true, migrate: true });
    }
    expect(contract.get("rpcGetSettings")?.params).toEqual(["token"]);
    expect(contract.get("rpcUpdateSetting")?.params).toEqual(["token", "input"]);
  });

  it("an admin is answered", async () => {
    const t = await token("Ada Quill", "1111");
    const got = await call("rpcGetSettings", [t]);
    expect(got.body.ok).toBe(true);
    expect(got.body.result.settings.length).toBeGreaterThan(20);
    const put = await call("rpcUpdateSetting", [t, { key: "session_hours", value: "12" }]);
    expect(put.body).toEqual({ ok: true, result: { key: "session_hours", value: "12", isDefault: false, changed: true } });
  });

  it.each([
    ["a manager", "Bram Hale", "2222", "manager"],
    ["an employee", "Cleo Marsh", "3333", "employee"],
    ["a payroll admin", "Dara Vance", "4444", "payroll_admin"],
  ])("%s is refused both, and nothing is written", async (_who, name, pin, role) => {
    const t = await token(name, pin);
    const read = await call("rpcGetSettings", [t]);
    expect(read.body).toEqual({ ok: false, error: { message: `FORBIDDEN: requires admin, got ${role}` } });
    const write = await call("rpcUpdateSetting", [t, { key: "session_hours", value: "1" }]);
    expect(write.body).toEqual({ ok: false, error: { message: `FORBIDDEN: requires admin, got ${role}` } });
    expect(await hasRow("session_hours")).toBe(false);
    expect(await auditRows()).toHaveLength(0);
  });

  it("no token, or a made-up one, is NOT_LOGGED_IN", async () => {
    expect((await call("rpcGetSettings", [])).body.error?.message).toBe("NOT_LOGGED_IN");
    expect((await call("rpcUpdateSetting", ["nope", { key: "session_hours", value: "1" }])).body.error?.message).toBe("NOT_LOGGED_IN");
    expect(await hasRow("session_hours")).toBe(false);
  });

  it("a role or an actor planted in the input changes nothing", async () => {
    const t = await token("Cleo Marsh", "3333");
    const planted = await call("rpcUpdateSetting", [t, { key: "session_hours", value: "1", role: "admin", actorId: "S_001", session: { role: "admin" } }]);
    expect(planted.body.error?.message).toBe("FORBIDDEN: requires admin, got employee");
    expect(await hasRow("session_hours")).toBe(false);

    const admin = await token("Ada Quill", "1111");
    const ok = await call("rpcUpdateSetting", [admin, { key: "session_hours", value: "10", actorId: "S_003", role: "employee" }]);
    expect(ok.body.ok).toBe(true);
    expect((await auditRows())[0]?.actor_id).toBe("S_001");
  });

  it("the handlers check the role themselves too, in case the contract is ever wrong", async () => {
    const employee: Session = { ...ADMIN, staffId: "S_003", role: "employee" };
    await expect(rpc(rpcGetSettings, [], { session: employee })).rejects.toThrow("FORBIDDEN: requires admin, got employee");
    await expect(rpc(rpcUpdateSetting, [{ key: "session_hours", value: "1" }], { session: employee })).rejects.toThrow("FORBIDDEN: requires admin, got employee");
    await expect(rpc(rpcGetSettings, [], { session: null })).rejects.toThrow("NOT_LOGGED_IN");
    await expect(rpc(rpcUpdateSetting, [{ key: "session_hours", value: "1" }], { session: null })).rejects.toThrow("NOT_LOGGED_IN");
    expect(await hasRow("session_hours")).toBe(false);
  });
});

// ── The list ────────────────────────────────────────────────

interface Listed {
  settings: Array<{ key: string; value: string | null; default: string; read: string; description: string; isDefault: boolean; group: string }>;
  other: Array<{ key: string; value: string | null; description: string }>;
  secrets: Array<{ key: string; binding: string; isSet: boolean }>;
}

describe("rpcGetSettings", () => {
  it("every registry setting appears once with its default and read kind, grouped, with a description", async () => {
    const r = await rpc<Listed>(rpcGetSettings, []);
    const registrySettings = Object.entries(CONFIG_KEYS).filter(([, s]) => s.kind === "setting");
    expect(r.settings.map((s) => s.key).sort()).toEqual(registrySettings.map(([k]) => k).sort());
    for (const [key, spec] of registrySettings) {
      const row = r.settings.find((s) => s.key === key)!;
      expect(row, key).toMatchObject({ default: spec.default, read: spec.read, value: null, isDefault: true });
      expect(row.description.length, key).toBeGreaterThan(5);
      expect(row.group.length, key).toBeGreaterThan(2);
    }
    expect(new Set(r.settings.map((s) => s.group))).toEqual(new Set(["Tills and cash", "Sign-in", "WhatsApp", "Clover", "Till", "Commissions", "Public report", "Other", "Assistants"]));
    // stable: asking twice gives the same order
    expect((await rpc<Listed>(rpcGetSettings, [])).settings.map((s) => s.key)).toEqual(r.settings.map((s) => s.key));
  });

  it("shows the stored text, and null (default) when blank, '' or absent", async () => {
    await owner.query("insert into ops.config (key, value, description) values ('session_hours', '12', 'Login session lifetime (hours)'), ('login_max_fails', NULL, null), ('login_lockout_mins', '', null)");
    const r = await rpc<Listed>(rpcGetSettings, []);
    const by = (k: string) => r.settings.find((s) => s.key === k)!;
    expect(by("session_hours")).toMatchObject({ value: "12", isDefault: false, description: "Login session lifetime (hours)" });
    expect(by("login_max_fails")).toMatchObject({ value: null, isDefault: true });
    expect(by("login_lockout_mins")).toMatchObject({ value: null, isDefault: true });
    expect(by("variance_ok_threshold")).toMatchObject({ value: null, isDefault: true });
  });

  it("also answers the till key's expiry warning (card P5-02b), so the screen needs no second call", async () => {
    // NOW is 2026-11-20 in Toronto. Blank and the link off: no warning. A date 14 days away: warning; 15: none.
    const blank = await rpc<Record<string, any>>(rpcGetSettings, []);
    expect(blank["tillKeyExpiry"]).toEqual({ day: null, daysLeft: null, warn: false, recorded: false, message: null });
    await update("till_key_expires_on", "2026-12-04");
    expect((await rpc<Record<string, any>>(rpcGetSettings, []))["tillKeyExpiry"]).toMatchObject({ day: "2026-12-04", daysLeft: 14, warn: true, recorded: true });
    await update("till_key_expires_on", "2026-12-05");
    expect((await rpc<Record<string, any>>(rpcGetSettings, []))["tillKeyExpiry"]).toMatchObject({ daysLeft: 15, warn: false });
    await update("till_key_expires_on", "");
    await update("till_enabled", "true");
    expect((await rpc<Record<string, any>>(rpcGetSettings, []))["tillKeyExpiry"]).toMatchObject({ day: null, warn: true, recorded: false });
    // the module's own list(), asked without a time, has no such field (other callers are unaffected)
    expect(await withTransaction(db, (tx) => settings.list(tx, ENV))).not.toHaveProperty("tillKeyExpiry");
  });

  it("answers one more field, lastBackup (card P4-06a): the nightly copy's line, built from the audit log; never run on a fresh database, a good run after one, and a failed run after that", async () => {
    const first = (await rpc<Record<string, any>>(rpcGetSettings, []))["lastBackup"];
    expect(first).toMatchObject({ state: "never", warn: true, lastGood: null, lastFailure: null });
    expect(first.message).toContain("no copy yet");
    await owner.query("insert into ops.audit_log (log_id, \"timestamp\", action, target_type, target_id, after) values ('LOG_B1', $1, 'backup.nightly', 'backup', 'nightly/2026-11-20', $2)", [NOW, JSON.stringify({ folder: "nightly/2026-11-20", tables: 24, rows: 2268 })]);
    const good = (await rpc<Record<string, any>>(rpcGetSettings, []))["lastBackup"];
    expect(good).toMatchObject({ state: "ok", warn: false, lastGood: { folder: "nightly/2026-11-20", tables: 24, rows: 2268 } });
    expect(good.message).toBe("Last copy: 2026-11-20 09:00:00, 24 tables, 2268 rows");
    await owner.query("insert into ops.audit_log (log_id, \"timestamp\", action, target_type, target_id, after) values ('LOG_B2', $1, 'backup.failed', 'backup', 'nightly', $2)", [LATER, JSON.stringify({ reason: "the bucket refused a write" })]);
    const failed = (await rpc<Record<string, any>>(rpcGetSettings, [], { at: LATER }))["lastBackup"];
    expect(failed).toMatchObject({ state: "failed", warn: true });
    expect(failed.message).toContain("the bucket refused a write");
    // 37 hours after the good copy, with no failure: a warning that a night was missed
    await owner.query("delete from ops.audit_log where log_id = 'LOG_B2'");
    const stale = (await rpc<Record<string, any>>(rpcGetSettings, [], { at: new Date(NOW.getTime() + 37 * 3_600_000) }))["lastBackup"];
    expect(stale).toMatchObject({ state: "stale", warn: true });
  });

  it("the commission day and hour say the weekly run's time is fixed elsewhere", async () => {
    const r = await rpc<Listed>(rpcGetSettings, []);
    for (const k of ["commission_run_day", "commission_run_hour"]) expect(r.settings.find((s) => s.key === k)?.description).toMatch(/P3-10b/);
  });

  it("a row the registry does not know appears under other, as plain text", async () => {
    await owner.query("insert into ops.config (key, value, description) values ('whatsapp_template_shopping_list', 'shopping_v2', 'Approved template for shopping list'), ('note_to_self', NULL, null)");
    const r = await rpc<Listed>(rpcGetSettings, []);
    expect(r.other).toEqual([
      { key: "note_to_self", value: null, description: "" },
      { key: "whatsapp_template_shopping_list", value: "shopping_v2", description: "Approved template for shopping list" },
    ]);
    expect(r.settings.map((s) => s.key)).not.toContain("note_to_self");
  });

  it("secrets are listed by binding name and whether set, never by value, length or part", async () => {
    // A secret that was wrongly put in the table, and an unknown key that looks like a credential: neither is shown.
    await owner.query("insert into ops.config (key, value) values ('whatsapp_api_token', 'TABLE-LEAK-9999'), ('some_new_api_key', 'TABLE-LEAK-8888'), ('smtp_password', 'TABLE-LEAK-7777')");
    const r = await rpc<Listed>(rpcGetSettings, []);
    expect(r.secrets).toEqual([
      { key: "whatsapp_api_token", binding: "WHATSAPP_API_TOKEN", isSet: true },
      { key: "clover_cstore_token", binding: "CLOVER_CSTORE_TOKEN", isSet: true },
      { key: "clover_vape_token", binding: "CLOVER_VAPE_TOKEN", isSet: false },
      { key: "till_api_key", binding: "TILL_API_KEY", isSet: true },
    ]);
    expect(r.secrets.map((s) => s.key)).toEqual([...SECRET_KEYS]);
    const text = JSON.stringify(r);
    for (const leaked of [ENV.WHATSAPP_API_TOKEN, ENV.CLOVER_CSTORE_TOKEN, ENV.TILL_API_KEY, "TILL-SECRET", "TABLE-LEAK", "SECRET-aaaa", "SECRET-cccc", "aaaa1111"]) expect(text, leaked).not.toContain(leaked);
    expect(r.other.map((o) => o.key)).toEqual([]);
    for (const s of r.secrets) expect(Object.keys(s).sort()).toEqual(["binding", "isSet", "key"]);
  });
});

// ── Refusals that are not about a value ─────────────────────

describe("what cannot be edited", () => {
  it("a secret is refused, named, and never written", async () => {
    await refused("whatsapp_api_token", "abc", "whatsapp_api_token is kept by Cloudflare, not in settings");
    await refused("clover_cstore_token", "abc", "clover_cstore_token is kept by Cloudflare, not in settings");
    await refused("clover_vape_token", "", "clover_vape_token is kept by Cloudflare, not in settings");
    expect(await hasRow("whatsapp_api_token")).toBe(false);
  });
  it("a key nobody has is refused: this screen edits settings, it does not invent them", async () => {
    await refused("made_up_setting", "1", "Unknown setting: made_up_setting");
    await refused("toString", "1", "Unknown setting: toString");
    await refused("__proto__", "1", "Unknown setting: __proto__");
    await refused("", "1", /Unknown setting/);
    await refused(undefined as unknown as string, "1", /Unknown setting/);
    await refused({ not: "text" } as unknown as string, "1", /Unknown setting/);
  });
  it("a row that already exists but is not in the registry can be edited, as plain text", async () => {
    await owner.query("insert into ops.config (key, value) values ('whatsapp_template_shopping_list', 'old')");
    await accepted("whatsapp_template_shopping_list", "  shopping_v2  ", "shopping_v2");
    await accepted("whatsapp_template_shopping_list", "", null);
    await refused("whatsapp_template_shopping_list", "two\nlines", /whatsapp_template_shopping_list.*line/);
  });
  it("an unknown row named like a credential is not editable here either", async () => {
    await owner.query("insert into ops.config (key, value) values ('some_new_api_key', NULL)");
    await refused("some_new_api_key", "abc", "some_new_api_key is kept by Cloudflare, not in settings");
  });
  it("a missing or odd input is a plain refusal", async () => {
    await expect(rpc(rpcUpdateSetting, [])).rejects.toThrow(/Unknown setting/);
    await expect(rpc(rpcUpdateSetting, [null])).rejects.toThrow(/Unknown setting/);
    await expect(rpc(rpcUpdateSetting, ["session_hours"])).rejects.toThrow(/Unknown setting/);
    await expect(rpc(rpcUpdateSetting, [[]])).rejects.toThrow(/Unknown setting/);
    expect(await auditRows()).toHaveLength(0);
  });
  it("a value that is not text or a number is refused", async () => {
    await refused("session_hours", { a: 1 }, /session_hours/);
    await refused("session_hours", [1], /session_hours/);
  });
});

// ── Blank means the default ─────────────────────────────────

describe("blank", () => {
  it.each([["empty text", ""], ["null", null], ["only spaces", "   "], ["a tab and a space", " \t "]])("%s stores NULL, never ''", async (_n, v) => {
    await update("session_hours", "12");
    expect(await stored("session_hours")).toBe("12");
    const r = await update("session_hours", v);
    expect(r).toEqual({ key: "session_hours", value: null, isDefault: true, changed: true });
    const row = await owner.one<{ value: string | null; isnull: boolean }>("select value, value is null as isnull from ops.config where key = 'session_hours'");
    expect(row.isnull).toBe(true);
    expect(row.value).toBeNull();
  });
  it("a missing value is blank too", async () => {
    await update("session_hours", "12");
    expect(await rpc(rpcUpdateSetting, [{ key: "session_hours" }])).toMatchObject({ value: null, isDefault: true, changed: true });
    expect(await stored("session_hours")).toBeNull();
  });
  it("blanking a setting that has no row writes no audit row and answers changed: false", async () => {
    expect(await update("session_hours", "")).toEqual({ key: "session_hours", value: null, isDefault: true, changed: false });
    expect(await auditRows()).toHaveLength(0);
    expect(await stored("session_hours")).toBeUndefined();
  });
  it("a '' left by an older import is the same as blank: no change", async () => {
    await owner.query("insert into ops.config (key, value) values ('session_hours', '')");
    expect(await update("session_hours", " ")).toMatchObject({ changed: false });
    expect(await auditRows()).toHaveLength(0);
  });
  it("a zero where zero is allowed stays 0, not blank", async () => {
    await accepted("cstore_default_opening_float", "0", "0");
    await accepted("vape_default_opening_float", " 0.00 ", "0.00");
    await accepted("lotto_reserve_default", "0", "0");
    await accepted("commission_run_day", "0", "0");
    await accepted("commission_run_hour", "0", "0");
    const r = await rpc<Listed>(rpcGetSettings, []);
    expect(r.settings.find((s) => s.key === "cstore_default_opening_float")).toMatchObject({ value: "0", isDefault: false });
  });
});

// ── Validation ──────────────────────────────────────────────

describe("booleans", () => {
  it("a real true or false is read as its word", async () => {
    await accepted("notifier_enabled", true, "true");
    await accepted("notifier_enabled", false, "false");
  });
  it.each([["true", "true"], ["FALSE", "false"], ["  True ", "true"]])("%j is stored as %s", async (v, out) => {
    await accepted("notifier_enabled", v, out);
  });
  it.each(["yes", "1", "0", "on", "truee", "tru"])("%j is refused", async (v) => {
    await refused("clover_enabled", v, "clover_enabled must be true or false");
  });
  it("the card split switches are booleans too", async () => {
    await accepted("cstore_card_split", "False", "false");
    await accepted("vape_card_split", "true", "true");
    await refused("vape_card_split", "maybe", /vape_card_split must be true or false/);
  });
});

describe("numbers", () => {
  it("plain decimals are kept as typed after trimming", async () => {
    await accepted("cstore_default_opening_float", " 250.50 ", "250.50");
    await accepted("vape_default_opening_float", "75", "75");
  });
  it.each(["1e3", "Infinity", "-Infinity", "NaN", "0x10", "1,000", "1 000", "$5", "five", ".", "5.", "1.2.3", "+5", "--5"])("%j is not a plain decimal number", async (v) => {
    await refused("cstore_default_opening_float", v, "cstore_default_opening_float must be a plain number such as 250 or 250.50");
  });
  it("floats and the lotto reserve may be zero but not negative", async () => {
    for (const key of ["cstore_default_opening_float", "vape_default_opening_float", "lotto_reserve_default"]) {
      await accepted(key, "0", "0");
      await refused(key, "-1", new RegExp(`${key} cannot be less than 0`));
      await refused(key, "1000001", new RegExp(`${key} cannot be more than 1000000`));
    }
  });
  it("thresholds: a zero would be read as the default, so zero is refused and says so", async () => {
    for (const [key, def] of [["variance_ok_threshold", "1"], ["variance_minor_threshold", "30"], ["card_variance_threshold", "1"]] as const) {
      await accepted(key, "0.5", "0.5");
      await refused(key, "0", new RegExp(`${key} must be more than 0 \\(a zero is read as the default, ${def}\\)`));
      await refused(key, "0.00", /must be more than 0/);
      await refused(key, "-2", /must be more than 0/);
    }
  });
  it("session_hours: 1 to 720", async () => {
    await accepted("session_hours", "1", "1");
    await accepted("session_hours", "720", "720");
    await refused("session_hours", "0", "session_hours must be a whole number from 1 to 720");
    await refused("session_hours", "721", "session_hours must be a whole number from 1 to 720");
    await refused("session_hours", "-5", /session_hours must be a whole number from 1 to 720/);
    await refused("session_hours", "1.5", /session_hours must be a whole number/);
  });
  it("login_max_fails 1 to 100; login_lockout_mins 1 to 10080", async () => {
    await accepted("login_max_fails", "100", "100");
    await refused("login_max_fails", "0", "login_max_fails must be a whole number from 1 to 100");
    await refused("login_max_fails", "101", /from 1 to 100/);
    await accepted("login_lockout_mins", "10080", "10080");
    await refused("login_lockout_mins", "0", "login_lockout_mins must be a whole number from 1 to 10080");
    await refused("login_lockout_mins", "10081", /from 1 to 10080/);
  });
  it("commission_run_day 0 to 6, commission_run_hour 0 to 23", async () => {
    await accepted("commission_run_day", "6", "6");
    await refused("commission_run_day", "7", "commission_run_day must be a whole number from 0 to 6");
    await refused("commission_run_day", "-1", /from 0 to 6/);
    await accepted("commission_run_hour", "23", "23");
    await refused("commission_run_hour", "24", "commission_run_hour must be a whole number from 0 to 23");
  });
  it("cash_handover_stale_days 1 to 365 (the reader turns zero or less into 7)", async () => {
    await accepted("cash_handover_stale_days", "365", "365");
    await refused("cash_handover_stale_days", "0", "cash_handover_stale_days must be a whole number from 1 to 365");
    await refused("cash_handover_stale_days", "366", /from 1 to 365/);
    await refused("cash_handover_stale_days", "-3", /from 1 to 365/);
  });
});

describe("the WhatsApp recipients list", () => {
  it("keeps digits only, drops spaces + - ( ), stores a comma-separated list", async () => {
    await accepted("whatsapp_target_number", "+1 (416) 555-0101, 1-416-555-0102;  14165550103", "14165550101,14165550102,14165550103");
  });
  it("a repeat is kept once", async () => {
    await accepted("whatsapp_target_number", "14165550101, +1 416 555 0101", "14165550101");
  });
  it("blank entries are ignored; nothing left is blank", async () => {
    await accepted("whatsapp_target_number", "14165550101,, ,", "14165550101");
    await accepted("whatsapp_target_number", " , ,", null);
  });
  it.each([
    ["letters", "1416555abcd"],
    ["too short (7 digits)", "4165550"],
    ["too long (16 digits)", "1416555010123456"],
    ["a name", "Ada"],
    ["an extension", "14165550101 x55"],
  ])("refuses %s, naming the entry's position", async (_n, v) => {
    await refused("whatsapp_target_number", `14165550100, ${v}`, /whatsapp_target_number: number 2 must be 8 to 15 digits/);
  });
  it("at most 20 numbers", async () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => `1416555${String(1000 + i)}`).join(",");
    await accepted("whatsapp_target_number", make(20), make(20));
    await refused("whatsapp_target_number", make(21), "whatsapp_target_number: at most 20 numbers");
  });
});

describe("addresses", () => {
  it("whatsapp_api_url: blank or Meta's address only", async () => {
    await accepted("whatsapp_api_url", " https://graph.facebook.com/v21.0/1234567890/messages ", "https://graph.facebook.com/v21.0/1234567890/messages");
    await refused("whatsapp_api_url", "https://example.com/v21.0/1/messages", /whatsapp_api_url must be an https:\/\/graph\.facebook\.com address/);
    await refused("whatsapp_api_url", "http://graph.facebook.com/v21.0/1/messages", /graph\.facebook\.com/);
    await refused("whatsapp_api_url", "https://graph.facebook.com.evil.test/x", /graph\.facebook\.com/);
    await refused("whatsapp_api_url", "https://user:pw@graph.facebook.com/x", /graph\.facebook\.com/);
    await refused("whatsapp_api_url", "not a url", /graph\.facebook\.com/);
    await accepted("whatsapp_api_url", "", null);
  });
  it("till_enabled: true or false, and off by default", async () => {
    expect(CONFIG_KEYS.till_enabled).toEqual({ kind: "setting", read: "boolean", default: "false" });
    await accepted("till_enabled", "TRUE", "true");
    await accepted("till_enabled", false, "false");
    await refused("till_enabled", "yes", /till_enabled must be true or false/);
    await refused("till_enabled", "1", /true or false/);
    await accepted("till_enabled", "", null);
  });
  it("till_api_url: blank or one of the till's own addresses only (the key is only ever sent there)", async () => {
    expect(CONFIG_KEYS.till_api_url).toEqual({ kind: "setting", read: "text", default: "" });
    await accepted("till_api_url", " https://office.scarbromart.ca/ops/v1 ", "https://office.scarbromart.ca/ops/v1");
    await accepted("till_api_url", "https://staging--scarbromart-office.netlify.app/ops/v1", "https://staging--scarbromart-office.netlify.app/ops/v1");
    for (const bad of [
      "https://example.com/ops/v1",
      "http://office.scarbromart.ca/ops/v1",
      "https://office.scarbromart.ca.evil.test/ops/v1",
      "https://office.scarbromart.ca@evil.test/ops/v1",
      "https://user:pw@office.scarbromart.ca/ops/v1",
      "https://office.scarbromart.ca:8443/ops/v1",
      "https://office.scarbromart.ca/other",
      "https://office.scarbromart.ca/ops/v1?x=1",
      "not a url",
    ]) {
      await refused("till_api_url", bad, /till_api_url must be one of the till's own addresses/);
    }
    await accepted("till_api_url", "", null);
  });
  it("till_key_expires_on: blank or a real date yyyy-mm-dd", async () => {
    expect(CONFIG_KEYS.till_key_expires_on).toEqual({ kind: "setting", read: "text", default: "" });
    await accepted("till_key_expires_on", "2027-02-19", "2027-02-19");
    await refused("till_key_expires_on", "2027-02-30", /till_key_expires_on must be a date written yyyy-mm-dd/);
    await refused("till_key_expires_on", "19/02/2027", /yyyy-mm-dd/);
    await refused("till_key_expires_on", "soon", /yyyy-mm-dd/);
    await accepted("till_key_expires_on", "", null);
  });
  it("the till's key is a secret: it cannot be set here, with or without a value", async () => {
    await expect(update("till_api_key", "TILL-SECRET-typed")).rejects.toThrow(/till_api_key is kept by Cloudflare/);
    await expect(update("till_api_key", "")).rejects.toThrow(/kept by Cloudflare/);
    expect(await hasRow("till_api_key")).toBe(false);
  });
  it("clover_base_url: blank or one of Clover's addresses only", async () => {
    await accepted("clover_base_url", "https://api.clover.com", "https://api.clover.com");
    await accepted("clover_base_url", "https://sandbox.dev.clover.com", "https://sandbox.dev.clover.com");
    await refused("clover_base_url", "https://example.com", /clover_base_url must be a Clover address \(https:\/\/api\.clover\.com or https:\/\/sandbox\.dev\.clover\.com\)/);
    await refused("clover_base_url", "http://api.clover.com", /Clover address/);
    await refused("clover_base_url", "https://api.clover.com.evil.test", /Clover address/);
    await refused("clover_base_url", "https://api.clover.com@evil.test", /Clover address/);
    await accepted("clover_base_url", "", null);
  });
  it("public_report_url: blank or https", async () => {
    await accepted("public_report_url", "https://reports.example.test/view", "https://reports.example.test/view");
    await refused("public_report_url", "http://reports.example.test/view", "public_report_url must be an https:// address");
    await refused("public_report_url", "javascript:alert(1)", /https/);
    await refused("public_report_url", "ftp://x.test", /https/);
    await refused("public_report_url", "reports.example.test", /https/);
    await refused("public_report_url", "https://", /https/);
  });
});

describe("the cash manager", () => {
  it("blank or the id of an active person", async () => {
    await accepted("cash_manager_staff_id", " S_002 ", "S_002");
    await accepted("cash_manager_staff_id", "", null);
  });
  it("an inactive person, an unknown id, or an id with odd characters is refused", async () => {
    await refused("cash_manager_staff_id", "S_005", "cash_manager_staff_id: S_005 is not an active person on the staff list");
    await refused("cash_manager_staff_id", "S_999", /S_999 is not an active person/);
    await refused("cash_manager_staff_id", "S_002; drop table ops.staff", /not an active person/);
  });
});

describe("text", () => {
  it("is trimmed", async () => {
    await accepted("cstore_business_name", "  Corner Shop  ", "Corner Shop");
  });
  it("500 characters is the most", async () => {
    await accepted("vape_business_name", "x".repeat(500), "x".repeat(500));
    await refused("vape_business_name", "x".repeat(501), "vape_business_name must be 500 characters or fewer");
  });
  it.each([["a newline", "Corner\nShop"], ["a carriage return", "Corner\rShop"], ["a tab", "Corner\tShop"], ["a null byte", "Corner\u0000Shop"], ["an escape", "Corner\u001bShop"], ["a line separator", "Corner Shop"]])("%s is refused", async (_n, v) => {
    await refused("cstore_business_name", v, "cstore_business_name cannot contain a line break or other control character");
  });
  it("the template names, merchant ids and language are text", async () => {
    await accepted("whatsapp_template_shift_open", "shift_open_v1", "shift_open_v1");
    await accepted("clover_cstore_merchant_id", "ABC123DEF456", "ABC123DEF456");
    await accepted("whatsapp_template_lang", "en_CA", "en_CA");
    await refused("whatsapp_template_shift_close", "a\nb", /whatsapp_template_shift_close/);
  });
  it("timezone must be a real zone; cstore_epos_from a real date", async () => {
    await accepted("timezone", "America/Toronto", "America/Toronto");
    await refused("timezone", "Mars/Olympus", "timezone: Mars/Olympus is not a time zone name such as America/Toronto");
    await accepted("cstore_epos_from", "2026-09-01", "2026-09-01");
    await refused("cstore_epos_from", "2026-02-30", "cstore_epos_from must be a date written yyyy-mm-dd");
    await refused("cstore_epos_from", "01/09/2026", /yyyy-mm-dd/);
  });
});

// ── The app behaves differently afterwards ──────────────────

describe("a saved setting takes effect", () => {
  it("the float a till is expected to hold follows", async () => {
    const before = ts.getExpectedFloat(await loadConfig(db), "vape");
    expect(before).toBe(100);
    await update("vape_default_opening_float", "135.50");
    expect(ts.getExpectedFloat(await loadConfig(db), "vape")).toBe(135.5);
    await update("vape_default_opening_float", "");
    expect(ts.getExpectedFloat(await loadConfig(db), "vape")).toBe(100);
    await update("vape_default_opening_float", "0");
    expect(ts.getExpectedFloat(await loadConfig(db), "vape")).toBe(0);
  });

  it("a new sign-in lasts as long as session_hours says", async () => {
    const logged: object[] = [];
    const router = createRpcRouter({ contract, handlers, openDb: () => connect(testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env: ENV, now: () => NOW, log: (e) => logged.push(e) });
    const login = async () => {
      const res = await router(new Request("https://ops.test/rpc/rpcLogin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: ["Cleo Marsh", "3333"] }) }));
      return ((await res.json()) as { result: { token: string } }).result.token;
    };
    await login();
    expect((await owner.one<{ h: number }>("select (extract(epoch from (max(expires_at) - max(created_at))) / 3600)::int as h from ops.sessions")).h).toBe(24);
    await owner.query("delete from ops.sessions");
    await update("session_hours", "6");
    await login();
    expect((await owner.one<{ h: number }>("select (extract(epoch from (max(expires_at) - max(created_at))) / 3600)::int as h from ops.sessions")).h).toBe(6);
  });

  it("the Clover address the reader sees is the one saved", async () => {
    await update("clover_base_url", "https://sandbox.dev.clover.com");
    expect((await loadConfig(db)).value("clover_base_url")).toBe("https://sandbox.dev.clover.com");
    await update("clover_base_url", "");
    expect((await loadConfig(db)).value("clover_base_url")).toBe("https://api.clover.com");
  });
});

// ── The audit row ───────────────────────────────────────────

describe("audit", () => {
  it("one row: who, what, before, after, when", async () => {
    await update("session_hours", "12", { at: NOW });
    await update("session_hours", "8", { at: LATER });
    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actor_id: "S_001", action: "config.update", target_type: "config", target_id: "session_hours", timestamp: NOW });
    expect(JSON.parse(rows[0]!.before)).toEqual({ value: null });
    expect(JSON.parse(rows[0]!.after)).toEqual({ value: "12" });
    expect(JSON.parse(rows[1]!.before)).toEqual({ value: "12" });
    expect(JSON.parse(rows[1]!.after)).toEqual({ value: "8" });
    expect(rows[1]?.timestamp).toEqual(LATER);
  });
  it("a blank writes null in after", async () => {
    await update("session_hours", "12");
    await update("session_hours", "");
    const rows = await auditRows();
    expect(JSON.parse(rows[1]!.before)).toEqual({ value: "12" });
    expect(JSON.parse(rows[1]!.after)).toEqual({ value: null });
  });
  it("the same value again changes nothing: changed false, no row, the stored text untouched", async () => {
    await update("session_hours", "12");
    const again = await update("session_hours", " 12 ");
    expect(again).toEqual({ key: "session_hours", value: "12", isDefault: false, changed: false });
    expect(await auditRows()).toHaveLength(1);
    // '12' and '12.0' are different text: that is a change.
    expect(await update("vape_default_opening_float", "50")).toMatchObject({ changed: true });
    expect(await update("vape_default_opening_float", "50.0")).toMatchObject({ changed: true });
  });
  it("a recipients change holds each number masked to its last four digits, and the count, never a full number", async () => {
    await update("whatsapp_target_number", "+1 416 555 0101, 14165550202");
    await update("whatsapp_target_number", "14165550202");
    const rows = await auditRows();
    expect(JSON.parse(rows[0]!.before)).toEqual({ value: null, count: 0 });
    expect(JSON.parse(rows[0]!.after)).toEqual({ value: "•••••••0101,•••••••0202", count: 2 });
    expect(JSON.parse(rows[1]!.before)).toEqual({ value: "•••••••0101,•••••••0202", count: 2 });
    expect(JSON.parse(rows[1]!.after)).toEqual({ value: "•••••••0202", count: 1 });
    const all = JSON.stringify(rows);
    for (const full of ["14165550101", "14165550202", "416 555 0101", "4165550101"]) expect(all, full).not.toContain(full);
    // and the answer to the page carries the real list: the admin is allowed to see it
    expect(await update("whatsapp_target_number", "14165550303")).toMatchObject({ value: "14165550303" });
    expect(JSON.stringify(await auditRows())).not.toContain("14165550303");
  });
  it("a refusal writes no row (see also the refusal tests, which check the table too)", async () => {
    await expect(update("session_hours", "0")).rejects.toThrow();
    expect(await auditRows()).toHaveLength(0);
  });
});

// ── Only the value moves ────────────────────────────────────

describe("what an update touches", () => {
  it("changes the value and nothing else of the row, and no other row", async () => {
    await owner.query("insert into ops.config (key, value, description) values ('session_hours', '24', 'Login session lifetime (hours)'), ('login_max_fails', '5', 'Failed login attempts before lockout')");
    await update("session_hours", "10");
    expect(await owner.query("select key, value, description from ops.config order by key")).toEqual([
      { key: "login_max_fails", value: "5", description: "Failed login attempts before lockout" },
      { key: "session_hours", value: "10", description: "Login session lifetime (hours)" },
    ]);
  });
  it("a key with no row gets one, with its description", async () => {
    await update("session_hours", "10");
    expect(await owner.query("select key, value, description from ops.config")).toEqual([{ key: "session_hours", value: "10", description: "Login session lifetime (hours)" }]);
  });
});

// ── Two at once ─────────────────────────────────────────────

describe("two edits of one key at the same moment", () => {
  it("both complete, one value wins, and the audit chain is consistent", async () => {
    for (let round = 0; round < 8; round++) {
      await owner.query("delete from ops.audit_log");
      await owner.query("delete from ops.config");
      if (round % 2 === 0) await owner.query("insert into ops.config (key, value) values ('session_hours', '24')");
      const conns = await Promise.all([connect(testDb.appUrl), connect(testDb.appUrl)]);
      try {
        const results = await Promise.all(
          ["10", "20"].map((v, i) => withTransaction(conns[i]!, async (tx) => settings.update(tx, { key: "session_hours", value: v, actorId: i === 0 ? "S_001" : "S_002" }, { now: NOW }))),
        );
        expect(results.every((r) => r.changed)).toBe(true);
        const final = await stored("session_hours");
        expect(["10", "20"]).toContain(final);
        const rows = await auditRows();
        expect(rows).toHaveLength(2);
        const [first, second] = rows.map((r) => ({ before: JSON.parse(r.before).value, after: JSON.parse(r.after).value }));
        expect(first!.before).toBe(round % 2 === 0 ? "24" : null);
        expect(second!.before).toBe(first!.after);
        expect(second!.after).toBe(final);
        expect(new Set([first!.after, second!.after])).toEqual(new Set(["10", "20"]));
      } finally {
        await Promise.all(conns.map((c) => c.close()));
      }
    }
  });
});

// ── The database role ───────────────────────────────────────

describe("permission", () => {
  it("ops_app can read, insert and update ops.config but not delete from it: 'use the default' can only be a blank", async () => {
    await owner.query("insert into ops.config (key, value) values ('session_hours', '12')");
    await expect(db.query("delete from ops.config where key = 'session_hours'")).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("delete from ops.config")).rejects.toMatchObject({ code: "42501" });
    expect(await stored("session_hours")).toBe("12");
    await update("session_hours", "");
    expect(await hasRow("session_hours")).toBe(true);
    expect(await stored("session_hours")).toBeNull();
  });
});
