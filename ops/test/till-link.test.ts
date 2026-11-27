// The till link's matching (card P5-02b): match each Operations person to their till login, match the
// till's store to Operations' store, and warn before the till's key expires. The first code that calls
// the till from a request. A NEW ability of the Operations app (ADR-0023, ADR-0024): there is nothing in
// the Apps Script app to compare with, so these tests are its specification.
//
// Against a real database and the fake till (ops/src/till/fake.ts): the real till is never called, and the
// global fetch must not be reached. Order: the card's own list; every state; the matching rules; the store
// map; who may call; the key never leaks; the till is only read; nothing else moves; the races; the
// database's own rules; the Worker's wiring (real timers, once).
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPin } from "../src/auth/pin";
import { createSession } from "../src/auth/sessions";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { Config, loadConfig } from "../src/lib/config";
import * as settings from "../src/modules/settings";
import * as tillLink from "../src/modules/till-link";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { rpcGetSettings } from "../src/rpc/handlers/settings";
import { rpcGetTillLink, rpcLinkTillStaff, rpcSetTillStore, rpcUnlinkTillStaff } from "../src/rpc/handlers/till-link";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import type { RpcContext } from "../src/rpc/types";
import { FAKE_BASE_URL, FAKE_HIDDEN_STORE_ID, FAKE_PEOPLE, FAKE_STORE_ID, createFakeTill, type FakeTill } from "../src/till/fake";
import { NIL_STAFF_ID } from "../src/till/types";
import { createTestDb, type TestDb } from "./helpers/db";
import { noGlobalFetch } from "./helpers/no-network";

const { reached } = noGlobalFetch();

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

const PEPPER = "test-only-pepper-not-a-secret";
/** Obviously fake, and unlike anything else in the data so a search for it is meaningful. */
const KEY = "tl-key-NOT-REAL-9f3b7c21";
const ENV = { PIN_PEPPER: PEPPER, TILL_API_KEY: KEY };
// The fake till's "today" is Friday 2026-11-27, 10:00 in Toronto.
const NOW = new Date("2026-11-27T15:00:00Z");

type Seed = [id: string, name: string, role: string, active: boolean, pin: string | null];
const STAFF: Seed[] = [
  ["S_001", "Priya Nair", "admin", true, "1111"],
  ["S_002", "Daniel Okafor", "manager", true, "2222"],
  ["S_003", "Maya Chen", "employee", true, "3333"],
  ["S_004", "Eli Stone", "employee", true, "5555"],
  ["S_005", "Fay Ruiz", "payroll_admin", true, "6666"],
  ["S_006", "Gus Lowe", "employee", false, "7777"],
  ["S_008", "Ada Quill", "admin", true, "8888"],
];
const hashes = new Map<string, string>();

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  owner = await connect(testDb.ownerUrl);
  for (const s of STAFF) if (s[4]) hashes.set(s[0], await hashPin(s[4], PEPPER, { iterations: 1000 }));
});
afterAll(async () => {
  await db?.close();
  await owner?.close();
  await testDb?.drop();
});

const PAY_TABLES = ["till_sessions", "sales", "payments", "payment_items", "bonuses", "cash_handovers", "attendance"];
const EMAIL = "maya.private@example.test";
const NOTE = "Allergic to the back-room cat";

async function seed(config: Record<string, string> = { till_enabled: "true", till_api_url: FAKE_BASE_URL, till_key_expires_on: "2027-03-01" }) {
  for (const t of ["till_staff_links", "till_stores", "audit_log", "cash_handover_items", "cash_handovers", "payment_items", "payments", "sales", "till_sessions", "bonuses", "attendance", "sessions", "login_failures", "config", "staff"]) {
    await owner.query(`delete from ops.${t}`);
  }
  for (const s of STAFF) {
    await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized, email, start_date, created_at, notes, pin_hash) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [
      s[0],
      s[1],
      s[0] === "S_003" ? 21.5 : 18,
      s[3],
      s[2],
      "cstore,vape",
      s[0] === "S_003" ? EMAIL : null,
      null,
      "2025-01-01T12:00:00Z",
      s[0] === "S_003" ? NOTE : null,
      hashes.get(s[0]) ?? null,
    ]);
  }
  for (const [k, v] of Object.entries(config)) await owner.query("insert into ops.config (key, value) values ($1, $2)", [k, v]);
}
beforeEach(async () => {
  await seed();
});

/** The matches an earlier admin made: the store, and Maya <-> the till's Maya. */
async function seedMatches(opts: { store?: string; maya?: boolean } = {}) {
  await owner.query("insert into ops.till_stores (store_id, till_store_id, till_name, matched_by, matched_at) values ('store_main', $1, 'Fictional Corner Store', 'S_001', '2026-11-20T15:00:00Z')", [opts.store ?? FAKE_STORE_ID]);
  if (opts.maya !== false) {
    await owner.query(
      "insert into ops.till_staff_links (staff_id, till_store_id, till_staff_id, till_name, till_role, matched_by, matched_at, last_seen_at) values ('S_003', $1, $2, 'Maya Chen', 'cashier', 'S_001', '2026-11-20T15:00:00Z', '2026-11-26T15:00:00Z')",
      [opts.store ?? FAKE_STORE_ID, FAKE_PEOPLE.maya.staff_id],
    );
  }
}

// ── Calling ────────────────────────────────────────────────

const session = (staffId: string, role: Session["role"]): Session => ({ staffId, name: "x", role, companiesAuthorized: ["cstore"], expiresAt: 0 });
const ADMIN = session("S_001", "admin");
const ADMIN2 = session("S_008", "admin");
const MANAGER = session("S_002", "manager");

const newTill = (opts: Parameters<typeof createFakeTill>[0] = { key: KEY }): FakeTill => createFakeTill(opts);

/** A handler called directly: the real handler, a real transaction, the fake till's fetch. */
async function rpc(handler: (ctx: RpcContext, ...a: unknown[]) => unknown, who: Session | null, args: unknown[], till: FakeTill, env: Record<string, unknown> = ENV, on: Db = db, now = NOW): Promise<any> {
  return withTransaction(on, async (tx) => handler({ db: tx, session: who, config: () => loadConfig(tx), env, fetch: till.fetch, now }, ...args));
}

const contract = parseRpcContract(
  mergeOpsContract(
    JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
    JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
  ),
);
const router = (till: FakeTill, env: Record<string, unknown> = ENV, now = NOW, fetchImpl?: typeof fetch) =>
  createRpcRouter({ contract, handlers, openDb: () => connect(testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env, fetch: fetchImpl ?? till.fetch, now: () => now, log: () => undefined });
async function call(till: FakeTill, name: string, args: unknown[], env: Record<string, unknown> = ENV, now = NOW): Promise<{ ok: boolean; result?: any; error?: { message: string }; text: string }> {
  const res = await router(till, env, now)(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
  const text = await res.text();
  return { ...(JSON.parse(text) as { ok: boolean; result?: any; error?: { message: string } }), text };
}
const tokenOf = async (staffId: string) => (await createSession(db, staffId, Config.fromRows([]), NOW)).token;

/** The module called directly, with the fake till's own clock, so a slow till costs no real time. */
async function viaModule<T>(till: FakeTill, fn: (tx: Parameters<Parameters<typeof withTransaction>[1]>[0], deps: tillLink.TillDeps) => Promise<T>, env: Record<string, unknown> = ENV): Promise<T> {
  const start = till.clock.now();
  return withTransaction(db, async (tx) => {
    const deps: tillLink.TillDeps = { config: await loadConfig(tx), env, fetch: till.fetch, now: start, sleep: till.clock.sleep, elapsedMs: () => till.clock.now().getTime() - start.getTime() };
    const out = await fn(tx, deps);
    spentMs = deps.elapsedMs(); // read the moment the module answers: the fake clock keeps running for work the budget gave up on
    return out;
  });
}
const getView = (till: FakeTill, env: Record<string, unknown> = ENV) => viaModule(till, (tx, deps) => tillLink.get(tx, deps), env);
let spentMs = 0;

const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details from ops.audit_log order by seq`);
const links = () => db.query<any>("select staff_id, till_store_id, till_staff_id, till_name, till_role, matched_by, ended_by, ended_at, ended_reason, last_seen_at from ops.till_staff_links order by link_id");
const storeRows = () => db.query<any>("select store_id, till_store_id, till_name, matched_by, ended_by, ended_at from ops.till_stores order by match_id");
async function snapshot(tables: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = await db.query(`select * from ops.${t} order by 1`);
  return JSON.stringify(out);
}
const getsOf = (till: FakeTill) => till.requests.map((r) => `${r.method} ${new URL(r.url).pathname.replace("/ops/v1", "")}`);
const keysDeep = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keysDeep(x, out));
  return out;
};

// ── The card's own list ────────────────────────────────────

describe("linking a person, and a till person who is not in Operations", () => {
  it("matches Maya to the till's Maya once the store is matched, and the screen data shows it", async () => {
    const till = newTill();
    const store = await rpc(rpcSetTillStore, ADMIN, [{ storeId: "store_main", tillStoreId: FAKE_STORE_ID }], till);
    expect(store).toMatchObject({ storeId: "store_main", tillStore: { id: FAKE_STORE_ID, name: "Fictional Corner Store" }, changed: true });
    const linked = await rpc(rpcLinkTillStaff, ADMIN, [{ staffId: "S_003", tillStaffId: FAKE_PEOPLE.maya.staff_id }], till);
    expect(linked).toMatchObject({ staffId: "S_003", name: "Maya Chen", link: { tillStaffId: FAKE_PEOPLE.maya.staff_id, tillName: "Maya Chen", tillRole: "cashier", inTillList: true } });

    const view = await rpc(rpcGetTillLink, ADMIN, [], till);
    expect(view.state).toBe("ok");
    const maya = view.people.find((p: any) => p.staffId === "S_003");
    expect(maya.link).toMatchObject({ tillStaffId: FAKE_PEOPLE.maya.staff_id, tillName: "Maya Chen", tillRole: "cashier", inTillList: true });
    expect(maya.link.matchedAt).toBe(NOW.toISOString());
    expect(maya.suggestion).toBeNull();
    expect(await links()).toEqual([expect.objectContaining({ staff_id: "S_003", till_staff_id: FAKE_PEOPLE.maya.staff_id, till_name: "Maya Chen", till_role: "cashier", matched_by: "S_001", ended_at: null })]);
    const logged = await audits();
    expect(logged.map((a: any) => a.action)).toEqual(["till_link.store_matched", "till_link.staff_linked"]);
    expect(logged[1]).toMatchObject({ actor_id: "S_001", target_type: "staff", target_id: "S_003" });
  });

  it("a till person who is not in Operations is listed, never created", async () => {
    await seedMatches({ maya: false });
    const before = await snapshot(["staff"]);
    const till = newTill();
    const view = await rpc(rpcGetTillLink, ADMIN, [], till);
    expect(view.state).toBe("ok");
    const names = view.unmatchedTillPeople.map((p: any) => p.name).sort();
    expect(names).toEqual(["Casey Lindqvist", "Daniel Okafor", "Maya Chen", "Priya Nair"]);
    expect(view.unmatchedTillPeople.find((p: any) => p.name === "Casey Lindqvist")).toMatchObject({ tillStaffId: FAKE_PEOPLE.casey.staff_id, role: "cashier", active: false });
    expect(view.people.map((p: any) => p.name)).not.toContain("Casey Lindqvist");
    expect(await snapshot(["staff"])).toBe(before);
    expect((await db.one<{ n: number }>("select count(*)::int as n from ops.staff")).n).toBe(STAFF.length);
  });

  it("the till down: the screen data says so, the matches are still listed, and signing in still works", async () => {
    await seedMatches();
    const till = newTill();
    till.down();
    const view = await rpc(rpcGetTillLink, ADMIN, [], till);
    expect(view.state).toBe("unreachable");
    expect(view.message).toMatch(/could not be reached/i);
    expect(view.people.find((p: any) => p.staffId === "S_003").link).toMatchObject({ tillName: "Maya Chen", inTillList: null });
    expect(view.stores[0].tillStore).toEqual({ id: FAKE_STORE_ID, name: "Fictional Corner Store" });
    expect(view.tillStores).toEqual([]);
    expect(view.unmatchedTillPeople).toEqual([]);
    // sign-in is Operations' own: name and PIN, no till call, with the till down
    const before = till.requests.length;
    const login = await call(till, "rpcLogin", ["Priya Nair", "1111"]);
    expect(login.ok, login.error?.message).toBe(true);
    expect(login.result.token).toBeTruthy();
    expect(till.requests.length).toBe(before);
    // the Staff screen's own list and another RPC are untouched too
    const t = await tokenOf("S_001");
    expect((await call(till, "rpcGetStaffAdmin", [t])).ok).toBe(true);
    expect((await call(till, "rpcGetSettings", [t])).ok).toBe(true);
  });
});

describe("the key's expiry warning (keyExpiryWarning)", () => {
  const cfg = (day: string | null, enabled = true) => Config.fromRows([{ key: "till_enabled", value: enabled ? "true" : "false" }, { key: "till_key_expires_on", value: day }]);
  // The expiry is the day typed in; "today" is Toronto's day at the instant given.
  const at = (day: string, now: string, enabled = true) => tillLink.keyExpiryWarning(cfg(day, enabled), new Date(now));

  it("warns at 14 days, not at 15; on the day; and after it", () => {
    expect(at("2026-12-11", "2026-11-27T15:00:00Z")).toMatchObject({ day: "2026-12-11", daysLeft: 14, warn: true, recorded: true });
    expect(at("2026-12-12", "2026-11-27T15:00:00Z")).toMatchObject({ day: "2026-12-12", daysLeft: 15, warn: false, recorded: true });
    expect(at("2026-11-27", "2026-11-27T15:00:00Z")).toMatchObject({ daysLeft: 0, warn: true });
    expect(at("2026-11-24", "2026-11-27T15:00:00Z")).toMatchObject({ daysLeft: -3, warn: true });
    expect(at("2026-12-11", "2026-11-27T15:00:00Z").message).toMatch(/expires on 2026-12-11 \(in 14 days\)/);
    expect(at("2026-11-28", "2026-11-27T15:00:00Z").message).toMatch(/expires tomorrow/);
    expect(at("2026-11-27", "2026-11-27T15:00:00Z").message).toMatch(/expires today/);
    expect(at("2026-11-24", "2026-11-27T15:00:00Z").message).toMatch(/expired on 2026-11-24 \(3 days ago\)/);
    expect(at("2027-03-01", "2026-11-27T15:00:00Z").message).toBeNull();
  });

  it("counts Toronto's days: the evening before still belongs to the day before", () => {
    // 2026-11-27T04:59Z is still the 26th in Toronto (UTC-5); 05:00Z is the 27th.
    expect(at("2026-12-11", "2026-11-27T04:59:00Z")).toMatchObject({ daysLeft: 15, warn: false });
    expect(at("2026-12-11", "2026-11-27T05:00:00Z")).toMatchObject({ daysLeft: 14, warn: true });
  });

  it("counts calendar days across the clock changes, not 24-hour blocks", () => {
    // Fall back: Sunday 2026-11-01. Expiry 2026-11-15.
    expect(at("2026-11-15", "2026-11-01T03:59:00Z")).toMatchObject({ daysLeft: 15, warn: false }); // Oct 31, 23:59 EDT
    expect(at("2026-11-15", "2026-11-01T04:00:00Z")).toMatchObject({ daysLeft: 14, warn: true }); // Nov 1, 00:00 EDT
    expect(at("2026-11-15", "2026-11-02T04:59:00Z")).toMatchObject({ daysLeft: 14, warn: true }); // Nov 1, 23:59 EST
    expect(at("2026-11-15", "2026-11-02T05:00:00Z")).toMatchObject({ daysLeft: 13, warn: true }); // Nov 2, 00:00 EST
    // Spring forward: Sunday 2027-03-14. Expiry 2027-03-28.
    expect(at("2027-03-28", "2027-03-14T04:59:00Z")).toMatchObject({ daysLeft: 15, warn: false }); // Mar 13, 23:59 EST
    expect(at("2027-03-28", "2027-03-14T05:00:00Z")).toMatchObject({ daysLeft: 14, warn: true }); // Mar 14, 00:00 EST
    expect(at("2027-03-28", "2027-03-15T03:59:00Z")).toMatchObject({ daysLeft: 14, warn: true }); // Mar 14, 23:59 EDT (a 23-hour day)
    expect(at("2027-03-28", "2027-03-15T04:00:00Z")).toMatchObject({ daysLeft: 13, warn: true }); // Mar 15, 00:00 EDT
  });

  it("a blank date with the link switched on says it is not recorded; switched off, nothing", () => {
    expect(tillLink.keyExpiryWarning(cfg(null, true), NOW)).toEqual({ day: null, daysLeft: null, warn: true, recorded: false, message: "The key's expiry date is not recorded: type it into Settings (Till) when a key is installed." });
    expect(tillLink.keyExpiryWarning(cfg(null, false), NOW)).toMatchObject({ day: null, daysLeft: null, warn: false, recorded: false });
    // a date that is not a real date (only possible by editing the table by hand) is not guessed at
    expect(tillLink.keyExpiryWarning(cfg("2026-02-30", true), NOW)).toMatchObject({ day: null, recorded: false, warn: true });
  });

  it("a recorded date warns even while the link is switched off", () => {
    expect(at("2026-12-01", "2026-11-27T15:00:00Z", false)).toMatchObject({ warn: true, daysLeft: 4 });
  });

  it("is on rpcGetTillLink and on the Settings answer, the same, with no second call", async () => {
    await seed({ till_enabled: "true", till_api_url: FAKE_BASE_URL, till_key_expires_on: "2026-12-11" });
    const till = newTill();
    const view = await rpc(rpcGetTillLink, ADMIN, [], till);
    expect(view.keyExpiry).toMatchObject({ day: "2026-12-11", daysLeft: 14, warn: true, recorded: true });
    const s = await rpc(rpcGetSettings, ADMIN, [], till);
    expect(s.tillKeyExpiry).toEqual(view.keyExpiry);
    await seed({ till_enabled: "true", till_api_url: FAKE_BASE_URL, till_key_expires_on: "2026-12-12" });
    expect((await rpc(rpcGetSettings, ADMIN, [], till)).tillKeyExpiry).toMatchObject({ daysLeft: 15, warn: false });
    expect(await settings.list(db, ENV)).not.toHaveProperty("tillKeyExpiry.warn");
  });
});

// ── Every state ────────────────────────────────────────────

describe("every state: the RPC answers, within the budget, and the stored matches are still listed", () => {
  type Case = { name: string; state: string; message: RegExp; setup: (t: FakeTill) => void; env?: Record<string, unknown>; config?: Record<string, string>; store?: string; requests?: boolean };
  const CASES: Case[] = [
    { name: "off (the setting)", state: "off", message: /switched off/i, setup: () => undefined, config: { till_enabled: "false", till_api_url: FAKE_BASE_URL }, requests: false },
    { name: "off (never set)", state: "off", message: /switched off/i, setup: () => undefined, config: {}, requests: false },
    { name: "not configured (no key)", state: "not_configured", message: /not set up/i, setup: () => undefined, env: { PIN_PEPPER: PEPPER }, requests: false },
    { name: "not configured (a bad address)", state: "not_configured", message: /not set up/i, setup: () => undefined, config: { till_enabled: "true", till_api_url: "https://evil.example.com/ops/v1" }, requests: false },
    { name: "not configured (no address)", state: "not_configured", message: /not set up/i, setup: () => undefined, config: { till_enabled: "true" }, requests: false },
    { name: "ok", state: "ok", message: /answered/i, setup: () => undefined },
    { name: "unreachable (down)", state: "unreachable", message: /could not be reached/i, setup: (t) => t.down() },
    { name: "unreachable (slow, past the client's limit)", state: "unreachable", message: /did not answer/i, setup: (t) => t.slow(9_000) },
    { name: "unreachable (the till failing)", state: "unreachable", message: /could not be reached/i, setup: (t) => t.serverError() },
    { name: "unreachable (throttled)", state: "unreachable", message: /slow down/i, setup: (t) => t.rateLimit(5, 1) },
    { name: "refused (the wrong key)", state: "refused", message: /did not accept the key/i, setup: () => undefined, env: { PIN_PEPPER: PEPPER, TILL_API_KEY: "another-key-NOT-REAL-0000" } },
    { name: "refused (a store the key may not see)", state: "refused", message: /may not see/i, setup: () => undefined, store: FAKE_HIDDEN_STORE_ID },
    { name: "bad answer (not JSON)", state: "bad_answer", message: /does not understand/i, setup: (t) => t.garbage() },
    { name: "bad answer (a redirect)", state: "bad_answer", message: /does not understand/i, setup: (t) => t.redirect("https://evil.example.com/steal") },
  ];

  for (const c of CASES) {
    it(`${c.name}: state ${c.state}`, async () => {
      if (c.config) await seed(c.config);
      await seedMatches({ store: c.store });
      const till = newTill();
      c.setup(till);
      const view: any = await viaModule(till, (tx, deps) => tillLink.get(tx, deps), c.env ?? ENV);
      expect(view.state).toBe(c.state);
      expect(view.message).toMatch(c.message);
      expect(spentMs).toBeLessThanOrEqual(8_000);
      // the stored matches are listed whatever the till said
      expect(view.stores).toEqual([{ storeId: "store_main", name: "Main store", tillStore: { id: c.store ?? FAKE_STORE_ID, name: "Fictional Corner Store" } }]);
      expect(view.people.find((p: any) => p.staffId === "S_003").link).toMatchObject({ tillStaffId: FAKE_PEOPLE.maya.staff_id, tillName: "Maya Chen", tillRole: "cashier" });
      expect(view.people.find((p: any) => p.staffId === "S_003").link.inTillList).toBe(c.state === "ok" ? true : null);
      if (c.state !== "ok") {
        expect(view.tillStores).toEqual([]);
        expect(view.unmatchedTillPeople).toEqual([]);
        expect(view.people.every((p: any) => p.suggestion === null)).toBe(true);
      }
      if (c.requests === false) expect(till.requests).toEqual([]);
      expect(view.keyExpiry).toMatchObject({ recorded: expect.any(Boolean) });
    });
  }

  it("a till so slow that the whole RPC's 8 seconds run out: it still answers, at 8 seconds, as unreachable", async () => {
    await seedMatches();
    const till = newTill();
    till.slow(5_000); // under the client's own limit of 7.5 seconds a request ...
    till.rateLimit(1, 2); // ... but one is told to wait 2 more seconds and ask again (another 5 seconds): past 8
    const view: any = await getView(till);
    expect(view.state).toBe("unreachable");
    expect(view.message).toMatch(/did not answer in time/i);
    expect(spentMs).toBeLessThanOrEqual(8_000);
    expect(view.people.find((p: any) => p.staffId === "S_003").link.tillName).toBe("Maya Chen");
  });

  it("the writes that need the till say why they cannot, change nothing, and do not throw anything but a message", async () => {
    await seedMatches({ maya: false });
    for (const [setup, re] of [
      [(t: FakeTill) => t.down(), /could not be reached/i],
      [(t: FakeTill) => t.garbage(), /does not understand/i],
    ] as const) {
      const till = newTill();
      setup(till);
      const before = await snapshot(["till_staff_links", "till_stores", "audit_log"]);
      await expect(rpc(rpcLinkTillStaff, ADMIN, [{ staffId: "S_003", tillStaffId: FAKE_PEOPLE.maya.staff_id }], till)).rejects.toThrow(re);
      await expect(rpc(rpcSetTillStore, ADMIN, [{ storeId: "store_main", tillStoreId: FAKE_STORE_ID }], till)).rejects.toThrow(re);
      expect(await snapshot(["till_staff_links", "till_stores", "audit_log"])).toBe(before);
    }
  });
});

// ── The matching rules ─────────────────────────────────────

describe("suggestions", () => {
  it("offered on equal names ignoring case and repeated spaces; none otherwise; never matched by itself", async () => {
    await seedMatches({ maya: false });
    await owner.query("update ops.staff set name = $1 where staff_id = 'S_003'", ["  maya    CHEN "]);
    await owner.query("update ops.staff set name = $1 where staff_id = 'S_004'", ["Eli Stone"]); // no one of that name in the till
    const till = newTill();
    const view = await rpc(rpcGetTillLink, ADMIN, [], till);
    const by = (id: string) => view.people.find((p: any) => p.staffId === id);
    expect(by("S_003").suggestion).toEqual({ tillStaffId: FAKE_PEOPLE.maya.staff_id, tillName: "Maya Chen" });
    expect(by("S_001").suggestion).toEqual({ tillStaffId: FAKE_PEOPLE.priya.staff_id, tillName: "Priya Nair" });
    expect(by("S_002").suggestion).toEqual({ tillStaffId: FAKE_PEOPLE.daniel.staff_id, tillName: "Daniel Okafor" });
    expect(by("S_004").suggestion).toBeNull();
    // near misses are not suggested
    till.state.data.staff[0]!.display_name = "Priya Nairr";
    till.state.data.staff[1]!.display_name = "Daniel O'Kafor";
    const view2 = await rpc(rpcGetTillLink, ADMIN, [], till);
    expect(view2.people.find((p: any) => p.staffId === "S_001").suggestion).toBeNull();
    expect(view2.people.find((p: any) => p.staffId === "S_002").suggestion).toBeNull();
    // nothing was matched by asking: no row, no audit, no write
    expect(await links()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(view.people.every((p: any) => p.link === null)).toBe(true);
  });

  it("no suggestion when two people in the till have the same name, or the till person is already matched", async () => {
    await seedMatches({ maya: false });
    const till = newTill();
    till.state.data.staff.push({ staff_id: "11111111-aaaa-4aaa-8aaa-0000000000ff", display_name: "maya chen", role: "cashier", active: true, all_stores: false, store_ids: [FAKE_STORE_ID], has_pin: false });
    expect((await rpc(rpcGetTillLink, ADMIN, [], till)).people.find((p: any) => p.staffId === "S_003").suggestion).toBeNull();
    till.reset();
    await owner.query("insert into ops.till_staff_links (staff_id, till_store_id, till_staff_id, till_name, till_role, matched_by, matched_at) values ('S_004', $1, $2, 'Maya Chen', 'cashier', 'S_001', $3)", [FAKE_STORE_ID, FAKE_PEOPLE.maya.staff_id, NOW]);
    const view = await rpc(rpcGetTillLink, ADMIN, [], till);
    expect(view.people.find((p: any) => p.staffId === "S_003").suggestion).toBeNull();
  });

  it("no suggestion before the store is matched, and nobody is listed to match", async () => {
    const till = newTill();
    const view = await rpc(rpcGetTillLink, ADMIN, [], till);
    expect(view.state).toBe("ok");
    expect(view.stores).toEqual([{ storeId: "store_main", name: "Main store", tillStore: null }]);
    expect(view.tillStores).toEqual([{ id: FAKE_STORE_ID, name: "Fictional Corner Store", code: "FIC1", active: true }]);
    expect(view.people.every((p: any) => p.suggestion === null && p.link === null)).toBe(true);
    expect(view.unmatchedTillPeople).toEqual([]);
    expect(getsOf(till)).toEqual(["GET /stores"]);
  });
});

describe("linking: the rules", () => {
  const link = (till: FakeTill, staffId: string, tillStaffId: string, who = ADMIN) => rpc(rpcLinkTillStaff, who, [{ staffId, tillStaffId }], till);

  it("the nil uuid (\"Not known\") is never offered and is refused if sent", async () => {
    await seedMatches({ maya: false });
    const till = newTill();
    till.state.data.staff.push({ staff_id: NIL_STAFF_ID, display_name: "Not known", role: "cashier", active: true, all_stores: true, store_ids: [], has_pin: false });
    const view = await rpc(rpcGetTillLink, ADMIN, [], till);
    expect(JSON.stringify(view)).not.toContain(NIL_STAFF_ID);
    expect(view.unmatchedTillPeople.map((p: any) => p.name)).not.toContain("Not known");
    for (const id of [NIL_STAFF_ID, NIL_STAFF_ID.toUpperCase()]) {
      await expect(link(till, "S_003", id)).rejects.toThrow('"Not known" is the till\'s name for no one: it cannot be matched to a person.');
    }
    expect(await links()).toEqual([]);
  });

  it("a till person who is not in the till's list now is refused, and so is a thing that is not a till id", async () => {
    await seedMatches({ maya: false });
    const till = newTill();
    await expect(link(till, "S_003", "99999999-aaaa-4aaa-8aaa-000000000009")).rejects.toThrow("That person is not in the till's list for this store now.");
    for (const bad of ["", null, undefined, 7, "maya", "11111111-aaaa-4aaa-8aaa-00000000000g"]) {
      await expect(rpc(rpcLinkTillStaff, ADMIN, [{ staffId: "S_003", tillStaffId: bad }], till)).rejects.toThrow("Choose the person in the till to match.");
    }
    await expect(link(till, "S_999", FAKE_PEOPLE.maya.staff_id)).rejects.toThrow("There is no such person.");
    await expect(rpc(rpcLinkTillStaff, ADMIN, [{ tillStaffId: FAKE_PEOPLE.maya.staff_id }], till)).rejects.toThrow("There is no such person.");
    await expect(rpc(rpcLinkTillStaff, ADMIN, [null], till)).rejects.toThrow("input is required");
    expect(await links()).toEqual([]);
    // the list is read after the person is chosen: a till person who has just gone is refused
    till.state.data.staff = till.state.data.staff.filter((s) => s.staff_id !== FAKE_PEOPLE.maya.staff_id);
    await expect(link(till, "S_003", FAKE_PEOPLE.maya.staff_id)).rejects.toThrow("not in the till's list");
  });

  it("matching a person before the store is matched is refused", async () => {
    const till = newTill();
    await expect(link(till, "S_003", FAKE_PEOPLE.maya.staff_id)).rejects.toThrow("Match the till's store to this store first.");
    expect(till.requests).toEqual([]);
  });

  it("both ways: a till person already matched to someone, and a person already matched", async () => {
    await seedMatches();
    const till = newTill();
    await expect(link(till, "S_004", FAKE_PEOPLE.maya.staff_id)).rejects.toThrow("Maya Chen is already matched to Maya Chen.");
    await expect(link(till, "S_003", FAKE_PEOPLE.daniel.staff_id)).rejects.toThrow("Maya Chen is already matched to Maya Chen: end that match first.");
    await owner.query("update ops.till_staff_links set till_name = 'Maya C.' where staff_id = 'S_003'");
    await expect(link(till, "S_004", FAKE_PEOPLE.maya.staff_id)).rejects.toThrow("Maya Chen is already matched to Maya Chen.");
    await expect(link(till, "S_003", FAKE_PEOPLE.daniel.staff_id)).rejects.toThrow("Maya Chen is already matched to Maya C.: end that match first.");
    expect((await links()).length).toBe(1);
    expect((await audits()).length).toBe(0);
  });

  it("an inactive Operations person may be matched (their history is still theirs)", async () => {
    await seedMatches({ maya: false });
    await owner.query("update ops.staff set name = 'Casey Lindqvist' where staff_id = 'S_006'");
    const till = newTill();
    const view = await rpc(rpcGetTillLink, ADMIN, [], till);
    expect(view.people.find((p: any) => p.staffId === "S_006")).toMatchObject({ active: false, suggestion: { tillName: "Casey Lindqvist" } });
    const r = await link(till, "S_006", FAKE_PEOPLE.casey.staff_id);
    expect(r.link).toMatchObject({ tillName: "Casey Lindqvist", tillRole: "cashier" });
    expect((await rpc(rpcGetTillLink, ADMIN, [], till)).unmatchedTillPeople.map((p: any) => p.name)).not.toContain("Casey Lindqvist");
  });

  it("ending a match works with the till down; the row stays, with who, when and why; the till login can be matched again", async () => {
    await seedMatches();
    const till = newTill();
    till.down();
    const out = await rpc(rpcUnlinkTillStaff, ADMIN, [{ staffId: "S_003", reason: "  Left the till company  " }], till, ENV, db, new Date("2026-11-27T16:00:00Z"));
    expect(out).toMatchObject({ staffId: "S_003", name: "Maya Chen", ended: true, tillName: "Maya Chen" });
    const rows = await links();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ staff_id: "S_003", ended_by: "S_001", ended_reason: "Left the till company" });
    expect(rows[0].ended_at.toISOString()).toBe("2026-11-27T16:00:00.000Z");
    const logged = await audits();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ actor_id: "S_001", action: "till_link.staff_unlinked", target_type: "staff", target_id: "S_003", details: "Left the till company" });
    expect(JSON.parse(logged[0].before)).toMatchObject({ tillStaffId: FAKE_PEOPLE.maya.staff_id, tillName: "Maya Chen" });
    expect(till.requests).toEqual([]);
    // matched again, to a different person
    till.reset();
    await link(till, "S_004", FAKE_PEOPLE.maya.staff_id);
    expect((await links()).filter((r: any) => r.ended_at === null)).toHaveLength(1);
  });

  it("ending a match: someone not matched, no reason, a reason too short or too long, a control character", async () => {
    await seedMatches();
    const till = newTill();
    const end = (input: unknown) => rpc(rpcUnlinkTillStaff, ADMIN, [input], till);
    await expect(end({ staffId: "S_004", reason: "Wrong person" })).rejects.toThrow("Eli Stone is not matched to anyone in the till.");
    await expect(end({ staffId: "S_999", reason: "Wrong person" })).rejects.toThrow("There is no such person.");
    for (const reason of [undefined, "", "  ", "ab", " a ", "x".repeat(301), "two\nlines"]) {
      await expect(end({ staffId: "S_003", reason })).rejects.toThrow(/reason/i);
    }
    expect((await end({ staffId: "S_003", reason: "x".repeat(300) })).ended).toBe(true);
  });

  it("a match the till no longer lists is flagged and kept, never deleted", async () => {
    await seedMatches();
    const till = newTill();
    till.state.data.staff = till.state.data.staff.filter((s) => s.staff_id !== FAKE_PEOPLE.maya.staff_id);
    const view = await rpc(rpcGetTillLink, ADMIN, [], till);
    expect(view.state).toBe("ok");
    expect(view.people.find((p: any) => p.staffId === "S_003").link).toMatchObject({ tillName: "Maya Chen", inTillList: false });
    expect((await links())).toHaveLength(1);
    expect((await links())[0].ended_at).toBeNull();
    // and when the till lists them again, it is back
    till.reset();
    expect((await rpc(rpcGetTillLink, ADMIN, [], till)).people.find((p: any) => p.staffId === "S_003").link.inTillList).toBe(true);
  });

  it("when the till's list holds a matched person, 'last seen' moves to now; otherwise it stays", async () => {
    await seedMatches();
    const till = newTill();
    await rpc(rpcGetTillLink, ADMIN, [], till);
    expect((await links())[0].last_seen_at.toISOString()).toBe(NOW.toISOString());
    await owner.query("update ops.till_staff_links set last_seen_at = '2026-11-01T00:00:00Z'");
    till.state.data.staff = till.state.data.staff.filter((s) => s.staff_id !== FAKE_PEOPLE.maya.staff_id);
    await rpc(rpcGetTillLink, ADMIN, [], till);
    expect((await links())[0].last_seen_at.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    till.down();
    const down = await rpc(rpcGetTillLink, ADMIN, [], till);
    expect(down.people.find((p: any) => p.staffId === "S_003").link.lastSeenAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("the till's name and role are kept as given at the time; a later rename does not change the stored match", async () => {
    await seedMatches({ maya: false });
    const till = newTill();
    await link(till, "S_003", FAKE_PEOPLE.maya.staff_id);
    till.state.data.staff.find((s) => s.staff_id === FAKE_PEOPLE.maya.staff_id)!.display_name = "Maya C. Chen";
    till.state.data.staff.find((s) => s.staff_id === FAKE_PEOPLE.maya.staff_id)!.role = "store_manager";
    await rpc(rpcGetTillLink, ADMIN, [], till);
    expect((await links())[0]).toMatchObject({ till_name: "Maya Chen", till_role: "cashier" });
  });
});

describe("two admins at once", () => {
  it("the same till person matched to two people at once, on two connections: exactly one succeeds", async () => {
    await seedMatches({ maya: false });
    const a = await connect(testDb.appUrl);
    const b = await connect(testDb.appUrl);
    try {
      for (let round = 0; round < 6; round++) {
        await owner.query("delete from ops.till_staff_links");
        const till = newTill();
        const results = await Promise.allSettled([
          rpc(rpcLinkTillStaff, ADMIN, [{ staffId: "S_003", tillStaffId: FAKE_PEOPLE.maya.staff_id }], till, ENV, a),
          rpc(rpcLinkTillStaff, ADMIN2, [{ staffId: "S_004", tillStaffId: FAKE_PEOPLE.maya.staff_id }], till, ENV, b),
        ]);
        expect(results.filter((r) => r.status === "fulfilled"), `round ${round}`).toHaveLength(1);
        const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(lost.reason).toBeInstanceOf(Error);
        expect(Object.getPrototypeOf(lost.reason)).toBe(Error.prototype); // a message for the person, not a database fault
        expect(lost.reason.message).toMatch(/is already matched to/);
        expect((await links()).filter((r: any) => r.till_staff_id === FAKE_PEOPLE.maya.staff_id)).toHaveLength(1);
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("the same person matched to two till logins at once: exactly one succeeds", async () => {
    await seedMatches({ maya: false });
    const a = await connect(testDb.appUrl);
    const b = await connect(testDb.appUrl);
    try {
      const till = newTill();
      const results = await Promise.allSettled([
        rpc(rpcLinkTillStaff, ADMIN, [{ staffId: "S_003", tillStaffId: FAKE_PEOPLE.maya.staff_id }], till, ENV, a),
        rpc(rpcLinkTillStaff, ADMIN2, [{ staffId: "S_003", tillStaffId: FAKE_PEOPLE.daniel.staff_id }], till, ENV, b),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason as Error).message).toMatch(/already matched to .*: end that match first\./);
      expect(await links()).toHaveLength(1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("a match ended while another is being made: the second sees it", async () => {
    await seedMatches();
    const till = newTill();
    await rpc(rpcUnlinkTillStaff, ADMIN, [{ staffId: "S_003", reason: "Wrong person" }], till);
    await rpc(rpcLinkTillStaff, ADMIN2, [{ staffId: "S_004", tillStaffId: FAKE_PEOPLE.maya.staff_id }], till);
    expect((await links()).map((r: any) => [r.staff_id, r.ended_at === null])).toEqual([["S_003", false], ["S_004", true]]);
  });
});

// ── The store map ──────────────────────────────────────────

describe("matching the till's store to Operations' store", () => {
  const setStore = (till: FakeTill, tillStoreId: unknown, who = ADMIN, storeId: unknown = "store_main") => rpc(rpcSetTillStore, who, [{ storeId, tillStoreId }], till);

  it("only a store the till lists now", async () => {
    const till = newTill();
    await expect(setStore(till, FAKE_HIDDEN_STORE_ID)).rejects.toThrow("The till does not list that store.");
    await expect(setStore(till, "5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4eff")).rejects.toThrow("The till does not list that store.");
    for (const bad of ["x", 5, "5b0a1c52"]) await expect(setStore(till, bad)).rejects.toThrow("Choose a store from the till's list.");
    await expect(setStore(till, FAKE_STORE_ID, ADMIN, "store_nowhere")).rejects.toThrow("There is no such store.");
    expect(await storeRows()).toEqual([]);
    expect(await setStore(till, FAKE_STORE_ID)).toMatchObject({ changed: true, tillStore: { id: FAKE_STORE_ID, name: "Fictional Corner Store" } });
    expect(await storeRows()).toEqual([expect.objectContaining({ store_id: "store_main", till_store_id: FAKE_STORE_ID, till_name: "Fictional Corner Store", matched_by: "S_001", ended_at: null })]);
    // saying it again changes nothing, and writes nothing
    const audits1 = (await audits()).length;
    expect(await setStore(till, FAKE_STORE_ID.toUpperCase())).toMatchObject({ changed: false });
    expect((await audits()).length).toBe(audits1);
  });

  it("another till store while one is matched is refused: end it first; ending needs no till", async () => {
    const till = newTill();
    till.state.data.stores.push({ ...till.state.data.stores[0]!, store_id: "5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e07", code: "FIC2", name: "Second Fictional Store" });
    till.state.data.visibleStoreIds.push("5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e07");
    await setStore(till, FAKE_STORE_ID);
    await expect(setStore(till, "5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e07")).rejects.toThrow("Main store is already matched to Fictional Corner Store: end that match first.");
    till.down();
    const ended = await setStore(till, null);
    expect(ended).toMatchObject({ storeId: "store_main", tillStore: null, changed: true });
    expect(await storeRows()).toEqual([expect.objectContaining({ ended_by: "S_001" })]);
    expect((await setStore(till, null)).changed).toBe(false);
    till.reset(); // puts the till's data back: the second store is added again
    till.state.data.stores.push({ ...till.state.data.stores[0]!, store_id: "5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e07", code: "FIC2", name: "Second Fictional Store" });
    till.state.data.visibleStoreIds.push("5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e07");
    expect(await setStore(till, "5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e07")).toMatchObject({ changed: true });
    expect((await audits()).map((a: any) => a.action)).toEqual(["till_link.store_matched", "till_link.store_ended", "till_link.store_matched"]);
  });

  it("a till store that already stands for another Operations store is refused", async () => {
    await owner.query("insert into ops.stores (id, code, name, active) values ('store_two', 'two', 'Second store', true)");
    try {
      const till = newTill();
      await setStore(till, FAKE_STORE_ID);
      await expect(setStore(till, FAKE_STORE_ID, ADMIN, "store_two")).rejects.toThrow("Fictional Corner Store is already matched to Main store.");
    } finally {
      await owner.query("delete from ops.till_stores where store_id = 'store_two'");
      await owner.query("delete from ops.stores where id = 'store_two'");
    }
  });

  it("while people are matched through it, the store match cannot be ended", async () => {
    await seedMatches();
    const till = newTill();
    await expect(setStore(till, null)).rejects.toThrow("1 person is matched through it: end their match first.");
    expect(await storeRows()).toHaveLength(1);
    expect((await storeRows())[0].ended_at).toBeNull();
    await rpc(rpcUnlinkTillStaff, ADMIN, [{ staffId: "S_003", reason: "Cleaning up" }], till);
    expect((await setStore(till, null)).changed).toBe(true);
  });

  it("matching people is refused until a store is matched, and after it is ended", async () => {
    const till = newTill();
    await setStore(till, FAKE_STORE_ID);
    await setStore(till, null);
    await expect(rpc(rpcLinkTillStaff, ADMIN, [{ staffId: "S_003", tillStaffId: FAKE_PEOPLE.maya.staff_id }], till)).rejects.toThrow("Match the till's store to this store first.");
  });
});

// ── Who may call ───────────────────────────────────────────

describe("who may call: the real router with the merged contract, and each handler on its own", () => {
  const VALID: Record<string, () => unknown[]> = {
    rpcGetTillLink: () => [],
    rpcSetTillStore: () => [{ storeId: "store_main", tillStoreId: FAKE_STORE_ID }],
    rpcLinkTillStaff: () => [{ staffId: "S_003", tillStaffId: FAKE_PEOPLE.maya.staff_id }],
    rpcUnlinkTillStaff: () => [{ staffId: "S_003", reason: "Cleaning up" }],
  };
  const PARAMS: Record<string, string[]> = { rpcGetTillLink: ["token"], rpcSetTillStore: ["token", "input"], rpcLinkTillStaff: ["token", "input"], rpcUnlinkTillStaff: ["token", "input"] };
  const HANDLERS = { rpcGetTillLink, rpcSetTillStore, rpcLinkTillStaff, rpcUnlinkTillStaff } as const;
  const prepare = async (name: string) => {
    await seed();
    await seedMatches({ maya: name === "rpcUnlinkTillStaff" });
  };

  it("the contract lists the four, each admin only, needing a session", () => {
    for (const [name, params] of Object.entries(PARAMS)) expect(contract.get(name)).toMatchObject({ params, roles: ["admin"], needs_session: true, migrate: true });
  });

  for (const name of Object.keys(PARAMS)) {
    it(`${name}: an admin may; a manager, a payroll admin, an employee and no token may not, and nothing is written or asked of the till`, async () => {
      const people: Array<[string, Session["role"]]> = [["S_001", "admin"], ["S_002", "manager"], ["S_005", "payroll_admin"], ["S_003", "employee"]];
      for (const [id, role] of people) {
        await prepare(name);
        const till = newTill();
        const t = await tokenOf(id);
        const before = await snapshot(["till_staff_links", "till_stores", "audit_log", "staff"]);
        const out = await call(till, name, [t, ...VALID[name]!()]);
        if (role === "admin") {
          expect(out.ok, `${name} as ${role}: ${out.error?.message}`).toBe(true);
        } else {
          expect(out.error?.message).toBe(`FORBIDDEN: requires admin, got ${role}`);
          expect(await snapshot(["till_staff_links", "till_stores", "audit_log", "staff"])).toBe(before);
          expect(till.requests).toEqual([]);
        }
      }
      for (const t of [undefined, "", "nope"]) {
        const till = newTill();
        expect((await call(till, name, [t, ...VALID[name]!()])).error?.message).toBe("NOT_LOGGED_IN");
        expect(till.requests).toEqual([]);
      }
    });

    it(`${name}: the handler itself refuses a manager, an employee and no session, even if the contract were wrong`, async () => {
      await prepare(name);
      const till = newTill();
      const before = await snapshot(["till_staff_links", "till_stores", "audit_log"]);
      for (const who of [MANAGER, session("S_005", "payroll_admin"), session("S_003", "employee")]) {
        await expect(rpc(HANDLERS[name as keyof typeof HANDLERS], who, VALID[name]!(), till)).rejects.toThrow(`FORBIDDEN: requires admin, got ${who.role}`);
      }
      await expect(rpc(HANDLERS[name as keyof typeof HANDLERS], null, VALID[name]!(), till)).rejects.toThrow("NOT_LOGGED_IN");
      expect(await snapshot(["till_staff_links", "till_stores", "audit_log"])).toBe(before);
      expect(till.requests).toEqual([]);
    });
  }

  it("a planted role, actorId or viewer in the input changes nothing: the session decides who did it", async () => {
    await seedMatches({ maya: false });
    const till = newTill();
    const t = await tokenOf("S_001");
    const out = await call(till, "rpcLinkTillStaff", [t, { staffId: "S_003", tillStaffId: FAKE_PEOPLE.maya.staff_id, actorId: "S_004", role: "employee", matchedBy: "S_004", viewerRole: "manager" }]);
    expect(out.ok, out.error?.message).toBe(true);
    expect((await links())[0].matched_by).toBe("S_001");
    expect((await audits())[0].actor_id).toBe("S_001");
    const m = await tokenOf("S_002");
    const refused = await call(till, "rpcLinkTillStaff", [m, { staffId: "S_004", tillStaffId: FAKE_PEOPLE.daniel.staff_id, role: "admin", actorId: "S_001" }]);
    expect(refused.error?.message).toBe("FORBIDDEN: requires admin, got manager");
  });

  it("rpcGetTillLink's answer holds no pay rate, PIN, hash, email or notes of anyone, in any state", async () => {
    await seedMatches();
    const BANNED = ["hourlyRate", "hourly_rate", "rate", "pin", "pinHash", "pin_hash", "hash", "email", "notes", "startDate", "companies", "cashHeld", "hasPin"];
    for (const setup of [(t: FakeTill) => undefined, (t: FakeTill) => t.down()]) {
      const till = newTill();
      setup(till);
      const view = await rpc(rpcGetTillLink, ADMIN, [], till);
      const keys = keysDeep(view);
      for (const k of BANNED) expect(keys.has(k), `the answer has a key ${k}`).toBe(false);
      const text = JSON.stringify(view);
      for (const leaked of [EMAIL, NOTE, "21.5", "pin_hash", hashes.get("S_001")!]) expect(text, leaked).not.toContain(leaked);
      for (const p of view.people) expect(Object.keys(p).sort()).toEqual(["active", "link", "name", "staffId", "suggestion"]);
    }
  });
});

// ── The key never leaks ────────────────────────────────────

describe("the key is in no answer, no audit row and no thrown message, in every state", () => {
  const forms = [KEY, encodeURIComponent(KEY), btoa(KEY), `Bearer ${KEY}`];
  const noKeyIn = (what: string, text: string) => {
    for (const f of forms) expect(text, `${what} holds the key as ${f.slice(0, 6)}...`).not.toContain(f);
  };

  const SWITCHES: Array<[string, (t: FakeTill) => void, Record<string, unknown>?]> = [
    ["ok", () => undefined],
    ["echoKey", (t) => t.echoKey()],
    ["garbage", (t) => t.garbage()],
    ["redirect", (t) => t.redirect(`https://evil.example.com/?k=${KEY}`)],
    ["down", (t) => t.down()],
    ["serverError", (t) => t.serverError()],
    ["wrong key", () => undefined, { PIN_PEPPER: PEPPER, TILL_API_KEY: KEY + "-x" }],
  ];

  for (const [name, setup, env] of SWITCHES) {
    it(`${name}: every RPC's answer or error, and the audit log, are free of the key`, async () => {
      await seedMatches({ maya: false });
      const till = newTill();
      setup(till);
      if (name === "echoKey") till.echoKey();
      const t = await tokenOf("S_001");
      const texts: string[] = [];
      for (const [rpcName, args] of [
        ["rpcGetTillLink", []],
        ["rpcLinkTillStaff", [{ staffId: "S_003", tillStaffId: FAKE_PEOPLE.maya.staff_id }]],
        ["rpcSetTillStore", [{ storeId: "store_main", tillStoreId: FAKE_STORE_ID }]],
        ["rpcUnlinkTillStaff", [{ staffId: "S_003", reason: "Cleaning up" }]],
        ["rpcGetSettings", []],
      ] as const) {
        texts.push((await call(till, rpcName, [t, ...args], env ?? ENV)).text);
      }
      for (const handler of [rpcGetTillLink, rpcLinkTillStaff, rpcSetTillStore]) {
        try {
          texts.push(JSON.stringify(await rpc(handler, ADMIN, handler === rpcGetTillLink ? [] : [{ staffId: "S_003", tillStaffId: FAKE_PEOPLE.maya.staff_id, storeId: "store_main", tillStoreId: FAKE_STORE_ID }], till, env ?? ENV)));
        } catch (e) {
          texts.push(String((e as Error).message), String((e as Error).stack));
        }
      }
      texts.push(JSON.stringify(await audits()), JSON.stringify(await links()), JSON.stringify(await storeRows()), JSON.stringify(till.requests));
      texts.forEach((x, i) => noKeyIn(`text ${i} (${name})`, x));
      expect(texts.join("\n").length).toBeGreaterThan(200);
    });
  }

  it("echoKey really does make the till say the key (the test would otherwise prove nothing)", async () => {
    const till = newTill();
    till.echoKey();
    const res = await till.fetch(`${till.baseUrl}/stores`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(await res.text()).toContain(KEY);
  });
});

// ── The till is only read ──────────────────────────────────

describe("the till is only read: GETs only, at most one per endpoint per RPC", () => {
  it("every request of every RPC is a GET with the key sent only as a header, and none repeats", async () => {
    await seedMatches({ maya: false });
    const till = newTill();
    const one = async (handler: any, args: unknown[], who = ADMIN) => {
      const before = till.requests.length;
      await rpc(handler, who, args, till);
      return getsOf(till).slice(before);
    };
    expect(await one(rpcGetTillLink, [])).toEqual(["GET /stores", "GET /staff"]);
    expect(await one(rpcLinkTillStaff, [{ staffId: "S_003", tillStaffId: FAKE_PEOPLE.maya.staff_id }])).toEqual(["GET /staff"]);
    expect(await one(rpcUnlinkTillStaff, [{ staffId: "S_003", reason: "Cleaning up" }])).toEqual([]);
    expect(await one(rpcSetTillStore, [{ storeId: "store_main", tillStoreId: null }])).toEqual([]);
    expect(await one(rpcSetTillStore, [{ storeId: "store_main", tillStoreId: FAKE_STORE_ID }])).toEqual(["GET /stores"]); // refused: a match is live
    expect(till.requests.every((r) => r.method === "GET" && r.hasAuthorization && r.redirect === "manual")).toBe(true);
    expect(till.requests.every((r) => !new URL(r.url).search.includes("key") && !r.url.includes(KEY))).toBe(true);
  });

  it("a throttled till is waited for by the client, still at most twice, inside the budget", async () => {
    await seedMatches({ maya: false });
    const till = newTill();
    till.rateLimit(2, 1);
    const view: any = await viaModule(till, (tx, deps) => tillLink.get(tx, deps));
    expect(view.state).toBe("ok");
    expect(spentMs).toBeLessThanOrEqual(8_000);
    // each endpoint was answered 429 once and asked again by the client itself (the caller asked once)
    expect(getsOf(till).sort()).toEqual(["GET /staff", "GET /staff", "GET /stores", "GET /stores"]);
    expect(till.clock.waits).toEqual([1000, 1000]);
  });

  it("the module has no way to send anything else (static check)", () => {
    const text = readFileSync(new URL("../src/modules/till-link.ts", import.meta.url), "utf8");
    expect(text).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(text).not.toMatch(/\bfetch\s*\(/);
    expect(text).not.toMatch(/new Date\(\)|process\.env|Math\.random|delete from/i);
    const handler = readFileSync(new URL("../src/rpc/handlers/till-link.ts", import.meta.url), "utf8");
    expect(handler).not.toMatch(/new Date\(\)|process\.env|Math\.random|delete from/i);
    expect(handler).not.toMatch(/TILL_API_KEY|till_api_key/);
    expect(text).not.toMatch(/TILL_API_KEY|till_api_key/);
  });
});

// ── Nothing else moves ─────────────────────────────────────

describe("nothing else moves", () => {
  it("matching, ending and reading change none of the money tables, attendance, or staff", async () => {
    const before = await snapshot([...PAY_TABLES, "staff", "sessions"]);
    const till = newTill();
    await rpc(rpcGetTillLink, ADMIN, [], till);
    await rpc(rpcSetTillStore, ADMIN, [{ storeId: "store_main", tillStoreId: FAKE_STORE_ID }], till);
    await rpc(rpcLinkTillStaff, ADMIN, [{ staffId: "S_003", tillStaffId: FAKE_PEOPLE.maya.staff_id }], till);
    await rpc(rpcLinkTillStaff, ADMIN, [{ staffId: "S_001", tillStaffId: FAKE_PEOPLE.priya.staff_id }], till);
    await rpc(rpcGetTillLink, ADMIN, [], till);
    await rpc(rpcUnlinkTillStaff, ADMIN, [{ staffId: "S_003", reason: "Cleaning up" }], till);
    till.down();
    await rpc(rpcGetTillLink, ADMIN, [], till);
    expect(await snapshot([...PAY_TABLES, "staff", "sessions"])).toBe(before);
    // every change is audited, and only those
    expect((await audits()).map((a: any) => a.action)).toEqual(["till_link.store_matched", "till_link.staff_linked", "till_link.staff_linked", "till_link.staff_unlinked"]);
  });

  it("a failed call writes nothing", async () => {
    await seedMatches({ maya: false });
    const before = await snapshot(["till_staff_links", "till_stores", "audit_log"]);
    const till = newTill();
    await expect(rpc(rpcLinkTillStaff, ADMIN, [{ staffId: "S_003", tillStaffId: "99999999-aaaa-4aaa-8aaa-000000000009" }], till)).rejects.toThrow();
    expect(await snapshot(["till_staff_links", "till_stores", "audit_log"])).toBe(before);
  });

  it("people the till does not know of are not stored at all", async () => {
    await seedMatches({ maya: false });
    const till = newTill();
    await rpc(rpcGetTillLink, ADMIN, [], till);
    await rpc(rpcLinkTillStaff, ADMIN, [{ staffId: "S_003", tillStaffId: FAKE_PEOPLE.maya.staff_id }], till);
    const all = JSON.stringify([await links(), await storeRows(), await audits()]);
    for (const p of [FAKE_PEOPLE.casey, FAKE_PEOPLE.daniel, FAKE_PEOPLE.priya]) {
      expect(all).not.toContain(p.staff_id);
      expect(all).not.toContain(p.name);
    }
  });
});

// ── The database's own rules ───────────────────────────────

describe("the tables' own rules (the code is not the only guard)", () => {
  const insertLink = (staff: string, tillStaff: string, store = FAKE_STORE_ID, as: Db = owner) =>
    as.query("insert into ops.till_staff_links (staff_id, till_store_id, till_staff_id, till_name, till_role, matched_by, matched_at) values ($1, $2, $3, 'X', 'cashier', 'S_001', now())", [staff, store, tillStaff]);

  it("the nil uuid, a second login for one person, and one login for two people are refused; an ended match frees both", async () => {
    await expect(insertLink("S_003", NIL_STAFF_ID)).rejects.toThrow(/till_staff_links_not_known/);
    await insertLink("S_003", FAKE_PEOPLE.maya.staff_id);
    await expect(insertLink("S_003", FAKE_PEOPLE.daniel.staff_id)).rejects.toThrow(/till_staff_links_live_person_idx/);
    await expect(insertLink("S_004", FAKE_PEOPLE.maya.staff_id)).rejects.toThrow(/till_staff_links_live_till_idx/);
    await owner.query("update ops.till_staff_links set ended_by = 'S_001', ended_at = now(), ended_reason = 'x'");
    await insertLink("S_004", FAKE_PEOPLE.maya.staff_id);
    await insertLink("S_003", FAKE_PEOPLE.daniel.staff_id);
  });

  it("an ended match needs who, when and why together; a store has one live till store, and a till store one live store", async () => {
    await expect(owner.query("insert into ops.till_staff_links (staff_id, till_store_id, till_staff_id, till_name, till_role, matched_by, matched_at, ended_at) values ('S_003', $1, $2, 'X', 'c', 'S_001', now(), now())", [FAKE_STORE_ID, FAKE_PEOPLE.maya.staff_id])).rejects.toThrow(/till_staff_links_ended/);
    await owner.query("insert into ops.stores (id, code, name, active) values ('store_two', 'two', 'Second store', true)");
    try {
      const ins = (store: string, till: string) => owner.query("insert into ops.till_stores (store_id, till_store_id, till_name, matched_by, matched_at) values ($1, $2, 'T', 'S_001', now())", [store, till]);
      await ins("store_main", FAKE_STORE_ID);
      await expect(ins("store_main", FAKE_HIDDEN_STORE_ID)).rejects.toThrow(/till_stores_live_store_idx/);
      await expect(ins("store_two", FAKE_STORE_ID)).rejects.toThrow(/till_stores_live_till_idx/);
    } finally {
      await owner.query("delete from ops.till_stores where store_id = 'store_two'");
      await owner.query("delete from ops.stores where id = 'store_two'");
    }
  });

  it("the app role can add, read and end a match, but not rewrite who it is between, nor delete one", async () => {
    await seedMatches();
    await expect(db.query("update ops.till_staff_links set staff_id = 'S_004'")).rejects.toThrow(/permission denied/);
    await expect(db.query("update ops.till_staff_links set till_name = 'Someone Else'")).rejects.toThrow(/permission denied/);
    await expect(db.query("update ops.till_stores set till_store_id = $1", [FAKE_HIDDEN_STORE_ID])).rejects.toThrow(/permission denied/);
    await expect(db.query("delete from ops.till_staff_links")).rejects.toThrow(/permission denied/);
    await expect(db.query("delete from ops.till_stores")).rejects.toThrow(/permission denied/);
    await db.query("update ops.till_staff_links set last_seen_at = now()");
    await db.query("update ops.till_staff_links set ended_by = 'S_001', ended_at = now(), ended_reason = 'x'");
  });
});

// ── The Worker's wiring ────────────────────────────────────

describe("in the Worker: real timers, the clock from ctx.now and a real wait", () => {
  it("a till that never answers is given up on inside the 8 seconds (real time, once), and the RPC still answers", async () => {
    await seedMatches();
    const till = newTill();
    const hang = ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })) as typeof fetch;
    const t = await tokenOf("S_001");
    const began = performance.now();
    const res = await router(till, ENV, NOW, hang)(new Request("https://ops.test/rpc/rpcGetTillLink", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args: [t] }) }));
    const spent = performance.now() - began;
    const body = (await res.json()) as { ok: boolean; result: any };
    expect(body.ok).toBe(true);
    expect(body.result.state).toBe("unreachable");
    expect(body.result.message).toMatch(/did not answer/i);
    expect(body.result.people.find((p: any) => p.staffId === "S_003").link.tillName).toBe("Maya Chen");
    expect(spent).toBeGreaterThan(6_500);
    expect(spent).toBeLessThan(8_700);
  }, 20_000);

  it("the handler works with the real Worker deps: an ok answer through the router, at once", async () => {
    const till = newTill();
    const t = await tokenOf("S_001");
    const began = performance.now();
    const out = await call(till, "rpcGetTillLink", [t]);
    expect(out.ok).toBe(true);
    expect(out.result.state).toBe("ok");
    expect(performance.now() - began).toBeLessThan(3_000);
  });
});

describe("nothing here reached the network", () => {
  it("the global fetch was not called (and the file fails if it was)", () => {
    expect(reached).not.toHaveBeenCalled();
  });
});
