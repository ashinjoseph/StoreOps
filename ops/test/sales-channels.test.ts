// Sales by channel (card P5-03b): the vape till's own figures for a range of days, in its three channels,
// beside what cashiers typed at close. A NEW ability of the Operations app (ADR-0023, ADR-0024): there is
// nothing in the Apps Script app to compare with, so these tests are its specification.
//
// The till is `createFakeTill` handed to the handler as the context's `fetch`: the real till is never
// called, and the global fetch must not be reached. Order: the pure part (money in cents); the fake's days;
// the range; every state; who may call; the key never leaks; read only; the app's own total; the allowlist.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPin } from "../src/auth/pin";
import { createSession } from "../src/auth/sessions";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { Config, loadConfig } from "../src/lib/config";
import { parseDate } from "../src/lib/dates";
import * as channels from "../src/modules/sales-channels";
import * as dashboard from "../src/modules/sales-dashboard";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { rpcGetSalesByChannel } from "../src/rpc/handlers/sales-channels";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import type { RpcContext } from "../src/rpc/types";
import { FAKE_BASE_URL, FAKE_DAYS, FAKE_HIDDEN_STORE_ID, FAKE_STORE_ID, createFakeTill, type FakeTill } from "../src/till/fake";
import type { DailyRow } from "../src/till/types";
import { createTestDb, type TestDb } from "./helpers/db";
import { noGlobalFetch } from "./helpers/no-network";

const { reached } = noGlobalFetch();

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

const PEPPER = "test-only-pepper-not-a-secret";
/** Obviously fake, and unlike anything else in the data so a search for it is meaningful. */
const KEY = "sc-key-NOT-REAL-4d8e1a07";
const ENV = { PIN_PEPPER: PEPPER, TILL_API_KEY: KEY };
// The fake till's "today" is Friday 2026-11-27, 10:00 in Toronto.
const NOW = new Date("2026-11-27T15:00:00Z");

type Seed = [id: string, name: string, role: string, pin: string];
const STAFF: Seed[] = [
  ["S_001", "Priya Nair", "admin", "1111"],
  ["S_002", "Daniel Okafor", "manager", "2222"],
  ["S_003", "Maya Chen", "employee", "3333"],
  ["S_005", "Fay Ruiz", "payroll_admin", "6666"],
];
const hashes = new Map<string, string>();

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  owner = await connect(testDb.ownerUrl);
  for (const s of STAFF) hashes.set(s[0], await hashPin(s[3], PEPPER, { iterations: 1000 }));
});
afterAll(async () => {
  await db?.close();
  await owner?.close();
  await testDb?.drop();
});

const LINKED = { till_enabled: "true", till_api_url: FAKE_BASE_URL };
async function seed(config: Record<string, string> = LINKED) {
  for (const t of ["till_staff_links", "till_stores", "audit_log", "cash_handover_items", "cash_handovers", "payment_items", "payments", "sales", "till_sessions", "bonuses", "attendance", "sessions", "login_failures", "config", "staff"]) {
    await owner.query(`delete from ops.${t}`);
  }
  for (const s of STAFF) {
    await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized, created_at, pin_hash) values ($1,$2,18,true,$3,'cstore,vape','2025-01-01T12:00:00Z',$4)", [s[0], s[1], s[2], hashes.get(s[0])]);
  }
  for (const [k, v] of Object.entries(config)) await owner.query("insert into ops.config (key, value) values ($1, $2)", [k, v]);
}
async function matchStore(tillStoreId: string = FAKE_STORE_ID) {
  await owner.query("insert into ops.till_stores (store_id, till_store_id, till_name, matched_by, matched_at) values ('store_main', $1, 'Fictional Corner Store', 'S_001', '2026-11-20T15:00:00Z')", [tillStoreId]);
}
beforeEach(async () => {
  await seed();
  await matchStore();
});

// ── Calling ────────────────────────────────────────────────

const session = (staffId: string, role: Session["role"]): Session => ({ staffId, name: "x", role, companiesAuthorized: ["cstore"], expiresAt: 0 });
const ADMIN = session("S_001", "admin");
const newTill = (): FakeTill => createFakeTill({ key: KEY });
const RANGE = { from: "2026-11-20", to: "2026-11-27" };

/** The real handler, a real transaction, the fake till's fetch. Its timer is the real one: only for answers that need none. */
async function rpc(who: Session | null, input: unknown, till: FakeTill, env: Record<string, unknown> = ENV): Promise<any> {
  return withTransaction(db, async (tx) => rpcGetSalesByChannel({ db: tx, session: who, config: () => loadConfig(tx), env, fetch: till.fetch, now: NOW } as RpcContext, input));
}

let spentMs = 0;
/** The module with the fake till's own clock, so a slow till costs no real time and the budget can be read. */
async function viaModule(till: FakeTill, input: { from: string; to: string; day: string | null }, env: Record<string, unknown> = ENV, log?: (e: object) => void): Promise<channels.SalesByChannel> {
  const start = till.clock.now();
  return withTransaction(db, async (tx) => {
    const deps: channels.SalesChannelsDeps = { config: await loadConfig(tx), env, fetch: till.fetch, now: start, sleep: till.clock.sleep, elapsedMs: () => till.clock.now().getTime() - start.getTime(), log };
    const out = await channels.get(tx, input, deps);
    spentMs = deps.elapsedMs();
    return out;
  });
}

const contract = parseRpcContract(
  mergeOpsContract(
    JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
    JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
  ),
);
const router = (till: FakeTill, env: Record<string, unknown> = ENV) =>
  createRpcRouter({ contract, handlers, openDb: () => connect(testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env, fetch: till.fetch, now: () => NOW, log: () => undefined });
async function call(till: FakeTill, name: string, args: unknown[], env: Record<string, unknown> = ENV): Promise<{ ok: boolean; result?: any; error?: { message: string }; text: string }> {
  const res = await router(till, env)(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
  const text = await res.text();
  return { ...(JSON.parse(text) as { ok: boolean; result?: any; error?: { message: string } }), text };
}
const tokenOf = async (staffId: string) => (await createSession(db, staffId, Config.fromRows([]), NOW)).token;

async function snapshotAll(): Promise<string> {
  const tables = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'ops' and table_type = 'BASE TABLE' order by 1");
  const out: Record<string, unknown> = {};
  for (const { table_name } of tables) out[table_name] = await db.query(`select * from ops.${table_name} order by 1`);
  return JSON.stringify(out);
}
const getsOf = (till: FakeTill) => till.requests.map((r) => `${r.method} ${new URL(r.url).pathname.replace("/ops/v1", "")}`);

// ── Hand-built rows ────────────────────────────────────────

const r2 = (x: number): number => Math.round(x * 100) / 100;
interface RowOpts {
  net: number;
  hst?: number;
  refunds?: number;
  count?: number;
  refundCount?: number;
  orders?: number;
  fees?: number;
}
/** A row that satisfies every rule: total = net + hst, and the takings (all cash) add up to it. */
function mk(day: string, channel: DailyRow["channel"], o: RowOpts): DailyRow {
  const hst = o.hst ?? 0;
  const total = r2(o.net + hst);
  const refunds = o.refunds ?? 0;
  const none = { sales_total: 0, refunds_total: 0, net_total: 0 };
  const row: DailyRow = {
    business_day: day,
    channel,
    sales_summary: { count: o.count ?? 1, refund_count: o.refundCount ?? 0, subtotal: o.net, discount: 0, net: o.net, surcharge: 0, rounding: 0, hst, total },
    takings: { cash: { sales_total: r2(total - refunds), refunds_total: refunds, net_total: total }, credit: { ...none }, debit: { ...none }, etransfer: { ...none }, other: { ...none } },
  };
  if (channel === "delivery") row.delivery = { orders: o.orders ?? 1, fees: o.fees ?? 0 };
  return row;
}
const day = (n: number): string => `2026-10-${String(n).padStart(2, "0")}`;
const R = { from: "2026-10-01", to: "2026-10-31" };

describe("the pure part: the till's rows to figures, in whole cents", () => {
  it("amounts whose float sums are wrong are added exactly (0.1 + 0.2, 100 days of 0.35, 30 days of 1.15)", () => {
    const naive = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const cases: Array<[string, number[], number]> = [
      ["0.1 + 0.2", [0.1, 0.2], 0.3],
      ["0.7 + 0.1", [0.7, 0.1], 0.8],
      ["4.35 + 0.1", [4.35, 0.1], 4.45],
      ["ten days of 0.1", Array(10).fill(0.1), 1],
      ["thirty days of 1.15", Array(30).fill(1.15), 34.5],
      ["a hundred days of 0.35", Array(100).fill(0.35), 35],
    ];
    for (const [name, amounts, exact] of cases) {
      // the table is only worth anything where float addition really is wrong
      expect(naive(amounts), `${name}: a float sum must differ here`).not.toBe(exact);
      const rows = amounts.map((a, i) => mk(`2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`, "till", { net: a }));
      const s = channels.summarise(rows, { from: "2026-01-01", to: "2026-12-31" }, null);
      expect(s.channels.till!.total, name).toBe(exact);
      expect(s.channels.till!.net, name).toBe(exact);
      expect(s.channels.all!.total, name).toBe(exact);
      expect(s.brokenRows, name).toBe(false);
    }
  });

  it("net, HST, refunds and fees are added in cents too, per channel and together", () => {
    const rows = [
      mk(day(1), "till", { net: 0.1, hst: 0.2, refunds: -0.1 }),
      mk(day(2), "till", { net: 0.2, hst: 0.1, refunds: -0.2 }),
      mk(day(1), "online", { net: 1.1, hst: 2.2 }),
      mk(day(1), "delivery", { net: 4.35, hst: 0.1, fees: 0.1, orders: 2 }),
      mk(day(2), "delivery", { net: 0.7, hst: 0.1, fees: 0.2, orders: 1 }),
    ];
    const s = channels.summarise(rows, R, null);
    expect(s.channels.till).toEqual({ total: 0.6, net: 0.3, hst: 0.3, refunds: -0.3, count: 2, refundCount: 0, days: 2 });
    expect(s.channels.online).toEqual({ total: 3.3, net: 1.1, hst: 2.2, refunds: 0, count: 1, refundCount: 0, days: 1 });
    expect(s.channels.delivery).toEqual({ total: 5.25, net: 5.05, hst: 0.2, refunds: 0, count: 2, refundCount: 0, days: 2, orders: 3, fees: 0.3 });
    expect(s.channels.all).toEqual({ total: 9.15, net: 6.45, hst: 2.7, refunds: -0.3, count: 5, refundCount: 0, days: 2 });
    expect(s.toCheck).toEqual([]);
    expect(s.brokenRows).toBe(false);
  });

  it("a negative day (more refunded than sold) is negative, and adds as negative", () => {
    const rows = [mk(day(1), "till", { net: -12.35, hst: -1.6, refunds: -13.95, refundCount: 2, count: 0 }), mk(day(2), "till", { net: 5.05 })];
    const s = channels.summarise(rows, R, null);
    expect(s.channels.till).toMatchObject({ total: -8.9, net: -7.3, hst: -1.6, refunds: -13.95, refundCount: 2, count: 1 });
  });

  it("a channel missing on some days counts only the days it reported; a channel reported as 0 is 0, not missing", () => {
    const rows = [mk(day(1), "till", { net: 10 }), mk(day(2), "till", { net: 20 }), mk(day(2), "online", { net: 0, count: 0 }), mk(day(3), "till", { net: 5 })];
    const s = channels.summarise(rows, R, null);
    expect(s.channels.till).toMatchObject({ total: 35, days: 3 });
    expect(s.channels.online).toEqual({ total: 0, net: 0, hst: 0, refunds: 0, count: 0, refundCount: 0, days: 1 });
    expect(s.channels.delivery).toBeNull();
    expect(s.channels.all).toMatchObject({ total: 35, days: 3 });
  });

  it("a range with nothing reported says no figures (null), never zeros", () => {
    const s = channels.summarise([], R, day(5));
    expect(s.channels).toEqual({ till: null, online: null, delivery: null, all: null });
    expect(s.day).toEqual({ till: null, online: null, delivery: null, all: null });
    expect(s.toCheck).toEqual([]);
  });

  it("the selected day is the same three lines for that day alone; a day with no rows has no figures", () => {
    const rows = [mk(day(1), "till", { net: 10 }), mk(day(2), "till", { net: 20 }), mk(day(2), "online", { net: 3 })];
    const s = channels.summarise(rows, R, day(2));
    expect(s.day!.till).toMatchObject({ total: 20, days: 1 });
    expect(s.day!.online).toMatchObject({ total: 3, days: 1 });
    expect(s.day!.delivery).toBeNull();
    expect(s.day!.all).toMatchObject({ total: 23, days: 1 });
    expect(channels.summarise(rows, R, day(9)).day).toEqual({ till: null, online: null, delivery: null, all: null });
    expect(channels.summarise(rows, R, null).day).toBeNull();
  });

  it("a day whose takings do not add up to its total is counted as reported, and listed once, in order", () => {
    const off = mk(day(3), "till", { net: 90.4 });
    off.takings.cash = { sales_total: 86.4, refunds_total: 0, net_total: 86.4 }; // 4.00 short
    const off2 = mk(day(3), "online", { net: 7 });
    off2.takings.cash.net_total = 1;
    off2.takings.cash.sales_total = 1;
    const early = mk(day(2), "delivery", { net: 10 });
    early.takings.cash = { sales_total: 9, refunds_total: 0, net_total: 9 };
    const s = channels.summarise([off, mk(day(4), "till", { net: 10 }), off2, early], R, null);
    expect(s.toCheck).toEqual([day(2), day(3)]);
    expect(s.channels.till).toMatchObject({ total: 100.4, days: 2 }); // the 90.40 as the till reports it
    expect(s.channels.all!.total).toBe(r2(90.4 + 10 + 7 + 10));
    expect(s.brokenRows).toBe(false); // "to check" is the till's own flag, not a broken sum
  });

  it("a broken row is kept as sent, flagged, and its place named (no value)", () => {
    const broken = mk(day(1), "till", { net: 10, hst: 1.3 });
    broken.sales_summary.total = 99; // net + hst is 11.30
    const outside = mk("2026-09-30", "online", { net: 4 });
    const twice = [mk(day(2), "till", { net: 1 }), mk(day(2), "till", { net: 2 })];
    const s = channels.summarise([broken, outside, ...twice], R, null);
    expect(s.brokenRows).toBe(true);
    expect(s.channels.till).toMatchObject({ total: 99 + 1 + 2 });
    expect(s.channels.online).toMatchObject({ total: 4 });
    expect(s.brokenPaths).toEqual(expect.arrayContaining(["days[0].sales_summary.total", "days[1].business_day", "days[3]"]));
    for (const p of s.brokenPaths) expect(p).toMatch(/^days\[\d+\][\w.]*$/);
    const delivery = mk(day(5), "till", { net: 1 });
    (delivery as any).delivery = { orders: 1, fees: 1 };
    const d = channels.summarise([delivery], R, null);
    expect(d.brokenRows).toBe(true);
    expect(d.channels.till).not.toHaveProperty("orders"); // a delivery object on another channel is not read
  });

  it("a row whose figure is not a number is flagged and that figure left out of the sum, not turned into zero", () => {
    const bad = mk(day(1), "till", { net: 10 }) as any;
    bad.sales_summary.hst = "1.30";
    const s = channels.summarise([bad], R, null);
    expect(s.brokenRows).toBe(true);
    expect(s.channels.till!.net).toBe(10);
  });

  it("delivery adds its orders and its fees, and only delivery rows do", () => {
    const s = channels.summarise([mk(day(1), "delivery", { net: 30, fees: 5, orders: 3 }), mk(day(2), "delivery", { net: 12.5, fees: 2.5, orders: 1 }), mk(day(2), "till", { net: 1 })], R, null);
    expect(s.channels.delivery).toMatchObject({ orders: 4, fees: 7.5, net: 42.5 });
    expect(s.channels.till).not.toHaveProperty("fees");
  });

  it("fromCents writes two decimals from cents and never -0", () => {
    expect(channels.fromCents(0)).toBe(0);
    expect(Object.is(channels.fromCents(-0), 0)).toBe(true);
    expect(channels.fromCents(-5)).toBe(-0.05);
    expect(channels.fromCents(123456789)).toBe(1234567.89);
  });
});

// ── The range ──────────────────────────────────────────────

describe("the range: what is asked of the till", () => {
  it("a range inside the contract's limit is asked as it is", () => {
    expect(channels.parseRange({ from: "2026-11-01", to: "2026-11-27", day: "2026-11-25" }, "2026-11-27")).toEqual({ range: { from: "2026-11-01", to: "2026-11-27", clamped: false }, day: "2026-11-25" });
    // exactly 92 days (91 days after from) is allowed
    expect(channels.parseRange({ from: "2026-08-28", to: "2026-11-27", day: null }, "2026-11-27").range).toEqual({ from: "2026-08-28", to: "2026-11-27", clamped: false });
  });

  it("a longer range keeps the newest 92 days and says so; a day cut off the front has no figures", () => {
    const p = channels.parseRange({ from: "2026-08-27", to: "2026-11-27", day: null }, "2026-11-27");
    expect(p.range).toEqual({ from: "2026-08-28", to: "2026-11-27", clamped: true });
    expect(channels.parseRange({ from: "2026-01-01", to: "2026-11-27", day: "2026-02-02" }, "2026-11-27").day).toBeNull();
    expect(channels.parseRange({ from: "2026-01-01", to: "2026-11-27", day: "2026-11-02" }, "2026-11-27").day).toBe("2026-11-02");
  });

  it("is refused, in words: a bad date, from after to, the future, a day outside the range", () => {
    const t = "2026-11-27";
    expect(() => channels.parseRange({ from: "2026-02-30", to: "2026-03-01", day: null }, t)).toThrow(/real days/);
    expect(() => channels.parseRange({ from: "2026-11-10", to: "2026-11-01", day: null }, t)).toThrow("The start date is after the end date.");
    expect(() => channels.parseRange({ from: "2026-11-20", to: "2026-11-28", day: null }, t)).toThrow(/end date is in the future/);
    expect(() => channels.parseRange({ from: "2026-11-20", to: "2026-11-27", day: "2026-11-19" }, t)).toThrow("The day must be inside the range.");
    expect(() => channels.parseRange({ from: "2026-11-20", to: "2026-11-27", day: "2026-11-31" }, t)).toThrow(/real day/);
  });
});

// ── Against the fake till ──────────────────────────────────

describe("against the fake till: its days, in the answer", () => {
  it("the whole week: every channel, the 'to check' day listed, the app's own total beside it", async () => {
    const till = newTill();
    const a = await rpc(ADMIN, { ...RANGE, day: FAKE_DAYS.allChannels }, till);
    expect(a.state).toBe("ok");
    expect(a.message).toBe("The till answered.");
    expect(a.range).toEqual({ ...RANGE, clamped: false });
    // till: 90.40 (to check) + 108.35 + 67.80; online 22.60; delivery 28.25
    expect(a.channels.till).toEqual({ total: 266.55, net: 235, hst: 30.55, refunds: -5, count: 7, refundCount: 1, days: 3 });
    expect(a.channels.online).toMatchObject({ total: 22.6, net: 20, hst: 2.6, days: 1 });
    expect(a.channels.delivery).toMatchObject({ total: 28.25, net: 25, hst: 3.25, days: 1, orders: 1, fees: 5 });
    expect(a.channels.all).toMatchObject({ total: 317.4, days: 3 });
    expect(a.toCheck).toEqual([FAKE_DAYS.toCheck]);
    expect(a.brokenRows).toBe(false);
    expect(a.enteredAtClose).toEqual({ total: null, days: 0 });
    expect(Object.keys(a).sort()).toEqual(["brokenRows", "channels", "day", "enteredAtClose", "message", "range", "state", "toCheck"]);
  });

  it("the selected day: allChannels has three lines; empty has none (no figures, not zero); toCheck is counted as reported", async () => {
    const till = newTill();
    const all = (await rpc(ADMIN, { ...RANGE, day: FAKE_DAYS.allChannels }, till)).day;
    expect(all.till).toMatchObject({ total: 67.8, days: 1 });
    expect(all.online).toMatchObject({ total: 22.6 });
    expect(all.delivery).toMatchObject({ total: 28.25, orders: 1, fees: 5 });
    expect(all.all).toMatchObject({ total: 118.65 });
    const empty = (await rpc(ADMIN, { ...RANGE, day: FAKE_DAYS.empty }, till)).day;
    expect(empty).toEqual({ till: null, online: null, delivery: null, all: null });
    const check = await rpc(ADMIN, { ...RANGE, day: FAKE_DAYS.toCheck }, till);
    expect(check.day.till).toMatchObject({ total: 90.4 });
    expect(check.toCheck).toContain(FAKE_DAYS.toCheck);
    expect((await rpc(ADMIN, RANGE, till)).day).toBeNull();
    expect((await rpc(ADMIN, { ...RANGE, day: "" }, till)).day).toBeNull();
  });

  it("a range with no sales at all: ok, and every channel says no figures, not zero", async () => {
    const till = newTill();
    const a = await rpc(ADMIN, { from: FAKE_DAYS.empty, to: FAKE_DAYS.empty, day: FAKE_DAYS.empty }, till);
    expect(a.state).toBe("ok");
    expect(a.channels).toEqual({ till: null, online: null, delivery: null, all: null });
    expect(a.day).toEqual({ till: null, online: null, delivery: null, all: null });
  });

  it("a row the till sent that its own rules reject is shown as sent, flagged, and logged once with no audit row", async () => {
    const till = newTill();
    till.state.data.sales[0]!.sales_summary.total = 1000; // 90.40 -> 1000.00: net + hst no longer add up to it
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const before = await snapshotAll();
      const a = await rpc(ADMIN, RANGE, till);
      expect(a.brokenRows).toBe(true);
      expect(a.channels.till.total).toBe(r2(1000 + 108.35 + 67.8));
      expect(warn).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(warn.mock.calls[0]![0]));
      expect(line).toMatchObject({ rpc: "rpcGetSalesByChannel", event: "sales_channels.rows_rejected", from: RANGE.from, to: RANGE.to });
      expect(line.where).toContain("days[0].sales_summary.total");
      expect(JSON.stringify(line)).not.toMatch(/Priya|Daniel|Maya|1000/);
      expect(await snapshotAll()).toBe(before); // no audit row, nothing stored
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the range, against the fake", () => {
  it("a range longer than the contract allows is clamped to the newest 92 days, says so, and asks the till for that", async () => {
    const till = newTill();
    const a = await rpc(ADMIN, { from: "2026-01-01", to: "2026-11-27", day: FAKE_DAYS.allChannels }, till);
    expect(a.range).toEqual({ from: "2026-08-28", to: "2026-11-27", clamped: true });
    expect(a.state).toBe("ok");
    expect(a.channels.all.days).toBe(3);
    expect(till.requests).toHaveLength(1);
    const q = new URL(till.requests[0]!.url).searchParams;
    expect([q.get("from"), q.get("to")]).toEqual(["2026-08-28", "2026-11-27"]);
  });

  it("the app's own total is read for the same (clamped) days", async () => {
    await put("2026-08-27", "vape", { cash: 1000 }); // cut off by the clamp
    await put("2026-08-28", "vape", { cash: 10 });
    const a = await rpc(ADMIN, { from: "2026-01-01", to: "2026-11-27", day: null }, newTill());
    expect(a.enteredAtClose).toEqual({ total: 10, days: 1 });
  });

  const BAD: Array<[string, unknown, RegExp]> = [
    ["from after to", { from: "2026-11-27", to: "2026-11-20" }, /start date is after the end date/],
    ["a bad date", { from: "2026-02-30", to: "2026-11-20" }, /start date must be a real day/],
    ["a bad end date", { from: "2026-11-01", to: "tomorrow" }, /end date must be a real day/],
    ["no dates", {}, /start date must be a real day/],
    ["not an object", "2026-11-01", /start date must be a real day/],
    ["a number", { from: 20261101, to: "2026-11-02" }, /start date must be a real day/],
    ["the future", { from: "2026-11-20", to: "2026-11-28" }, /end date is in the future/],
    ["a future day", { from: "2026-11-20", to: "2026-11-27", day: "2026-11-30" }, /day must be inside the range/],
    ["a bad day", { from: "2026-11-20", to: "2026-11-27", day: "2026-13-01" }, /day must be a real day/],
    ["a day before the range", { from: "2026-11-20", to: "2026-11-27", day: "2026-11-19" }, /day must be inside the range/],
  ];
  for (const [name, input, message] of BAD) {
    it(`${name}: refused with a readable message before any request`, async () => {
      const till = newTill();
      await expect(rpc(ADMIN, input, till)).rejects.toThrow(message);
      expect(till.requests).toEqual([]);
      const t = await tokenOf("S_001");
      const out = await call(till, "rpcGetSalesByChannel", [t, input]);
      expect(out.ok).toBe(false);
      expect(out.error!.message).toMatch(message);
      expect(till.requests).toEqual([]);
    });
  }
});

// ── Every state ────────────────────────────────────────────

describe("every state: the RPC answers (never throws), inside the budget, with no figures, and the app's own total is still there", () => {
  type Case = { name: string; state: string; message: RegExp | string; setup: (t: FakeTill) => void; env?: Record<string, unknown>; config?: Record<string, string>; store?: string | null; requests?: boolean };
  const CASES: Case[] = [
    { name: "off (the setting)", state: "off", message: /switched off/i, setup: () => undefined, config: { till_enabled: "false", till_api_url: FAKE_BASE_URL }, requests: false },
    { name: "off (never set)", state: "off", message: /switched off/i, setup: () => undefined, config: {}, requests: false },
    { name: "not configured (no key)", state: "not_configured", message: /not set up/i, setup: () => undefined, env: { PIN_PEPPER: PEPPER }, requests: false },
    { name: "not configured (a bad address)", state: "not_configured", message: /not set up/i, setup: () => undefined, config: { till_enabled: "true", till_api_url: "https://evil.example.com/ops/v1" }, requests: false },
    { name: "not configured (no address)", state: "not_configured", message: /not set up/i, setup: () => undefined, config: { till_enabled: "true" }, requests: false },
    { name: "no store matched", state: "no_store", message: channels.NO_STORE_MESSAGE, setup: () => undefined, store: null, requests: false },
    { name: "not configured wins over no store", state: "not_configured", message: /not set up/i, setup: () => undefined, store: null, env: { PIN_PEPPER: PEPPER }, requests: false },
    { name: "off wins over no store", state: "off", message: /switched off/i, setup: () => undefined, store: null, config: {}, requests: false },
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
      else await seed();
      if (c.store !== null) await matchStore(c.store ?? FAKE_STORE_ID);
      await put("2026-11-25", "vape", { cash: 100.1, credit: 50.2 });
      const till = newTill();
      c.setup(till);
      const a = await viaModule(till, { ...RANGE, day: FAKE_DAYS.allChannels }, c.env ?? ENV);
      expect(a.state).toBe(c.state);
      if (typeof c.message === "string") expect(a.message).toBe(c.message);
      else expect(a.message).toMatch(c.message);
      expect(spentMs).toBeLessThanOrEqual(8_000);
      expect(a.channels).toBeNull();
      expect(a.day).toBeNull();
      expect(a.toCheck).toEqual([]);
      expect(a.brokenRows).toBe(false);
      expect(a.enteredAtClose).toEqual({ total: 150.3, days: 1 });
      expect(a.range).toEqual({ ...RANGE, clamped: false });
      if (c.requests === false) expect(till.requests).toEqual([]);
    });
  }

  it("a till so slow that the whole RPC's 8 seconds run out: it answers, at 8 seconds, as unreachable", async () => {
    const till = newTill();
    till.slow(5_000);
    till.rateLimit(1, 2); // one request is told to wait 2 more seconds and ask again: past 8
    const a = await viaModule(till, { ...RANGE, day: null });
    expect(a.state).toBe("unreachable");
    expect(a.message).toMatch(/did not answer in time/i);
    expect(a.channels).toBeNull();
    expect(spentMs).toBeLessThanOrEqual(8_000);
  });

  it("through the handler too (real timers): down, garbage, refused and off answer; nothing throws", async () => {
    for (const [setup, state] of [[(t: FakeTill) => t.down(), "unreachable"], [(t: FakeTill) => t.garbage(), "bad_answer"], [(t: FakeTill) => t.serverError(), "unreachable"]] as const) {
      const till = newTill();
      setup(till);
      const a = await rpc(ADMIN, RANGE, till);
      expect(a.state).toBe(state);
      expect(a.channels).toBeNull();
    }
    const refused = await rpc(ADMIN, RANGE, newTill(), { PIN_PEPPER: PEPPER, TILL_API_KEY: "wrong-NOT-REAL" });
    expect(refused.state).toBe("refused");
    await seed({});
    const off = await rpc(ADMIN, RANGE, newTill());
    expect(off.state).toBe("off");
  });

  it("a state is never an error to the router: the call answers ok:true", async () => {
    const till = newTill();
    till.down();
    const t = await tokenOf("S_001");
    const out = await call(till, "rpcGetSalesByChannel", [t, RANGE]);
    expect(out.ok).toBe(true);
    expect(out.result.state).toBe("unreachable");
  });
});

// ── Who may call ───────────────────────────────────────────

describe("who may call: the same roles as the Sales screen's own call, read from the contracts", () => {
  const rpcJson = JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")) as { functions?: any[]; rpcs?: any[] };
  const list: Array<{ name: string; roles: string[] | null; params: string[]; needs_session: boolean }> = (rpcJson.functions ?? rpcJson.rpcs ?? (rpcJson as any)) as any;
  const own = list.find((e) => e.name === "rpcGetSalesDashboard")!;
  const opsJson = JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")) as { functions?: any[]; rpcs?: any[] };
  const mine = ((opsJson.functions ?? opsJson.rpcs) as any[]).find((e) => e.name === "rpcGetSalesByChannel")!;

  it("is listed with the same roles as the Sales screen's, writing them out, and needs a session", () => {
    expect(own.roles).toEqual(["admin", "manager", "payroll_admin"]);
    expect(mine.roles).toEqual(own.roles);
    expect(mine.needs_session).toBe(true);
    expect(mine.params).toEqual(["token", "input"]);
    expect(contract.get("rpcGetSalesByChannel")).toMatchObject({ roles: own.roles, needs_session: true, migrate: true });
    expect(handlers).toHaveProperty("rpcGetSalesByChannel");
  });

  it("each role: the Sales screen's roles may; an employee and no token may not, and the till is not asked", async () => {
    const people: Array<[string, string]> = [["S_001", "admin"], ["S_002", "manager"], ["S_005", "payroll_admin"], ["S_003", "employee"]];
    for (const [id, role] of people) {
      const till = newTill();
      const t = await tokenOf(id);
      const out = await call(till, "rpcGetSalesByChannel", [t, RANGE]);
      if (own.roles!.includes(role)) {
        expect(out.ok, `${role}: ${out.error?.message}`).toBe(true);
        expect(out.result.state).toBe("ok");
      } else {
        expect(out.error?.message).toBe(`FORBIDDEN: requires ${own.roles!.join(" or ")}, got ${role}`);
        expect(till.requests).toEqual([]);
      }
      // the Sales screen's own call agrees
      const dash = await call(till, "rpcGetSalesDashboard", [t, { startDate: RANGE.from, endDate: RANGE.to }]);
      expect(dash.ok, `${role}: dashboard`).toBe(own.roles!.includes(role));
    }
    for (const t of [undefined, "", "nope"]) {
      const till = newTill();
      expect((await call(till, "rpcGetSalesByChannel", [t, RANGE])).error?.message).toBe("NOT_LOGGED_IN");
      expect(till.requests).toEqual([]);
    }
  });

  it("the handler itself refuses an employee and no session, even if the contract were wrong", async () => {
    const till = newTill();
    await expect(rpc(session("S_003", "employee"), RANGE, till)).rejects.toThrow("FORBIDDEN: requires admin or manager or payroll_admin, got employee");
    await expect(rpc(null, RANGE, till)).rejects.toThrow("NOT_LOGGED_IN");
    expect(till.requests).toEqual([]);
    for (const role of ["manager", "payroll_admin"] as const) expect((await rpc(session("S_002", role), RANGE, till)).state).toBe("ok");
  });

  it("a planted role, actorId or storeId changes nothing: the store asked is the matched one", async () => {
    const till = newTill();
    const t = await tokenOf("S_003");
    const refused = await call(till, "rpcGetSalesByChannel", [t, { ...RANGE, role: "admin", actorId: "S_001", viewerRole: "admin" }]);
    expect(refused.error?.message).toMatch(/^FORBIDDEN/);
    const planted = { ...RANGE, role: "employee", actorId: "S_003", storeId: FAKE_HIDDEN_STORE_ID, tillStoreId: FAKE_HIDDEN_STORE_ID, store_id: FAKE_HIDDEN_STORE_ID, staffId: "S_003" };
    const a = await rpc(ADMIN, planted, till);
    expect(a.state).toBe("ok");
    expect(till.requests).toHaveLength(1);
    expect(new URL(till.requests[0]!.url).searchParams.get("store_id")).toBe(FAKE_STORE_ID);
    const t1 = await tokenOf("S_001");
    const viaRouter = await call(till, "rpcGetSalesByChannel", [t1, planted]);
    expect(viaRouter.ok).toBe(true);
    expect(new URL(till.requests[1]!.url).searchParams.get("store_id")).toBe(FAKE_STORE_ID);
    expect(till.requests.every((r) => !r.url.includes(FAKE_HIDDEN_STORE_ID))).toBe(true);
  });
});

// ── The key never leaks ────────────────────────────────────

describe("the key is in no answer and no thrown message, in every state, with the till echoing it", () => {
  const forms = [KEY, encodeURIComponent(KEY), btoa(KEY), `Bearer ${KEY}`];
  const STATES: Array<[string, (t: FakeTill) => void, Record<string, unknown>?, Record<string, string>?, boolean?]> = [
    ["ok", () => undefined],
    ["down", (t) => t.down()],
    ["serverError", (t) => t.serverError()],
    ["garbage", (t) => t.garbage()],
    ["redirect", (t) => t.redirect(`https://evil.example.com/?k=${KEY}`)],
    ["wrong key", () => undefined, { PIN_PEPPER: PEPPER, TILL_API_KEY: KEY + "-x" }],
    ["hidden store", () => undefined, undefined, undefined, true],
    ["off", () => undefined, undefined, { till_enabled: "false" }],
    ["not configured", () => undefined, { PIN_PEPPER: PEPPER }],
    ["bad input", () => undefined],
  ];
  for (const [name, setup, env, config, hidden] of STATES) {
    it(`${name}`, async () => {
      if (config) await seed(config);
      if (hidden) {
        await owner.query("delete from ops.till_stores");
        await matchStore(FAKE_HIDDEN_STORE_ID);
      }
      const till = newTill();
      setup(till);
      till.echoKey();
      const texts: string[] = [];
      const input = name === "bad input" ? { from: "2026-11-30", to: "2026-11-01" } : { ...RANGE, day: FAKE_DAYS.allChannels };
      try {
        texts.push(JSON.stringify(await rpc(ADMIN, input, till, env ?? ENV)));
      } catch (e) {
        texts.push(String((e as Error).message));
      }
      const t = await tokenOf("S_001");
      texts.push((await call(till, "rpcGetSalesByChannel", [t, input], env ?? ENV)).text);
      for (const text of texts) for (const f of forms) expect(text, `${name}: the answer holds the key as ${f.slice(0, 6)}...`).not.toContain(f);
    });
  }

  it("echoKey really does make the till say the key (the test would otherwise prove nothing)", async () => {
    const till = newTill();
    till.echoKey();
    const res = await till.fetch(`${FAKE_BASE_URL}/sales/daily?store_id=${FAKE_STORE_ID}&from=2026-11-20&to=2026-11-21`, { headers: { Authorization: `Bearer ${KEY}` } });
    expect(await res.text()).toContain(KEY);
  });
});

// ── Read only ──────────────────────────────────────────────

describe("read only: one GET of /sales/daily per call, and no row of the database changes", () => {
  it("the fake sees one GET to /sales/daily and nothing else, for every state that reaches the till", async () => {
    await put("2026-11-25", "vape", { cash: 10 });
    for (const setup of [(_: FakeTill) => undefined, (t: FakeTill) => t.serverError(), (t: FakeTill) => t.garbage()]) {
      const till = newTill();
      setup(till);
      const before = await snapshotAll();
      await rpc(ADMIN, { ...RANGE, day: FAKE_DAYS.allChannels }, till);
      expect(getsOf(till)).toEqual(["GET /sales/daily"]);
      expect(till.requests.every((r) => r.method === "GET")).toBe(true);
      expect(await snapshotAll(), "a table changed").toBe(before);
    }
  });

  it("a clamped range, a selected day and a day with nothing are still one request", async () => {
    const till = newTill();
    await rpc(ADMIN, { from: "2026-01-01", to: "2026-11-27", day: FAKE_DAYS.empty }, till);
    expect(getsOf(till)).toEqual(["GET /sales/daily"]);
  });

  it("no request at all when off, not set up, no store, or the request is refused", async () => {
    for (const config of [{}, { till_enabled: "true" }] as Array<Record<string, string>>) {
      await seed(config);
      const till = newTill();
      await rpc(ADMIN, RANGE, till);
      expect(till.requests).toEqual([]);
    }
    await seed();
    const till = newTill();
    await rpc(ADMIN, RANGE, till);
    expect(till.requests).toEqual([]); // no store matched (beforeEach's match was cleared by seed)
  });

  it("no figure from the till is kept: every table is identical after, with the till's amounts in the answer", async () => {
    const till = newTill();
    const before = await snapshotAll();
    const a = await rpc(ADMIN, RANGE, till);
    expect(a.channels.all.total).toBeGreaterThan(0);
    const after = await snapshotAll();
    expect(after).toBe(before);
    expect(after).not.toMatch(/266\.55|317\.4|22\.6/);
  });

  it("the module and the handler have no way to write, take no clock and no randomness of their own", () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const file of ["../src/modules/sales-channels.ts", "../src/rpc/handlers/sales-channels.ts"]) {
      const src = strip(readFileSync(new URL(file, import.meta.url), "utf8"));
      expect(src, file).not.toMatch(/new Date\(\)|Date\.now|process\.env|Math\.random|\binsert\b|\bupdate\b|\bdelete\b|audit/i);
      expect(src, file).not.toMatch(/createFakeTill|till\/fake/);
    }
  });
});

// ── The app's own figures ──────────────────────────────────

let n = 0;
interface Put {
  cash?: number;
  credit?: number | null;
  debit?: number | null;
  card?: number | null;
  miscCash?: number;
  miscCard?: number | null;
}
/** One sales row (with its session and attendance). */
async function put(date: string, company: string, o: Put = {}): Promise<void> {
  const id = `${company === "vape" ? "VAP" : "CST"}-${date.replace(/-/g, "")}-${++n}`;
  const staff = "S_002";
  const att = `A_${date.replace(/-/g, "")}_${staff}`;
  await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ($1, $2, $3, 'worked') on conflict do nothing", [att, staff, date]);
  await owner.query("insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status) values ($1, $2, $3, $4, $5, 'closed')", [id, att, staff, company, date]);
  await owner.query(
    `insert into ops.sales (sales_id, session_id, staff_id, company, date, cash_sales, credit_card_sales, debit_card_sales, cashback_paid, misc_cash_sales, misc_card_sales, card_total_sales)
     values ($1, $1, $2, $3, $4, $5, $6, $7, 0, $8, $9, $10)`,
    [id, staff, company, date, o.cash ?? 0, o.credit ?? null, o.debit ?? null, o.miscCash ?? 0, o.miscCard ?? null, o.card ?? null],
  );
}

describe("what cashiers entered at close, beside the till's figures", () => {
  it("equals what the Sales screen's own reader gives for the vape till over the same days (and leaves the cstore till out)", async () => {
    await put("2026-11-20", "vape", { cash: 100.1, credit: 20.2 });
    await put("2026-11-22", "vape", { cash: 0.1, card: 0.2 });
    await put("2026-11-22", "vape", { cash: 55.55, miscCash: 4.45, miscCard: 1.1 });
    await put("2026-11-27", "vape", { cash: 7.35, debit: 3.3 });
    await put("2026-11-24", "cstore", { cash: 5000 });
    await put("2026-11-19", "vape", { cash: 9000 }); // before the range
    const a = await rpc(ADMIN, RANGE, newTill());
    const dash = await dashboard.getDashboard(db, { startDate: parseDate(RANGE.from) as Date, endDate: new Date((parseDate(RANGE.to) as Date).getTime() + 86_399_000), company: "vape", pageSize: 500 });
    expect(a.enteredAtClose.total).toBe(dash.totals.total);
    expect(a.enteredAtClose).toEqual({ total: 192.35, days: 3 });
    expect(a.enteredAtClose.total).toBe(r2(100.1 + 20.2 + 0.1 + 0.2 + 55.55 + 4.45 + 1.1 + 7.35 + 3.3));
  });

  it("no closes in the range: no total (not 0), no days", async () => {
    const a = await rpc(ADMIN, RANGE, newTill());
    expect(a.enteredAtClose).toEqual({ total: null, days: 0 });
  });

  it("a day closed with 0 is 0: reported, not missing", async () => {
    await put("2026-11-21", "vape", { cash: 0 });
    expect((await rpc(ADMIN, RANGE, newTill())).enteredAtClose).toEqual({ total: 0, days: 1 });
  });
});

// ── The allowlist ──────────────────────────────────────────

describe("the files that call the till: this card's module is one, and it is the allowlist test that names all four", () => {
  const OPS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const TILL_DIR = join(OPS, "src/till");
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "public" || name === ".wrangler") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|mts|mjs|js)$/.test(name)) out.push(p);
    }
    return out;
  }
  it("this card's module names the client's factory (with the till link's, the only two that do), and its handler imports the till's days", () => {
    const found: string[] = [];
    for (const file of walk(join(OPS, "src")).filter((f) => !f.startsWith(TILL_DIR + "/"))) {
      const src = readFileSync(file, "utf8");
      if (src.includes("tillClientFor")) found.push(relative(OPS, file));
    }
    expect(found.sort()).toEqual(["src/modules/sales-channels.ts", "src/modules/till-link.ts"]);
    // and the handler is a caller too: it imports from the till folder (the day check), so the allowlist test names it
    expect(readFileSync(join(OPS, "src/rpc/handlers/sales-channels.ts"), "utf8")).toMatch(/from "\.\.\/\.\.\/till\/days"/);
  });

  it("the module asks the client only for dailySales, and builds no address", () => {
    const src = readFileSync(join(OPS, "src/modules/sales-channels.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
    expect([...src.matchAll(/client\.(\w+)\(/g)].map((m) => m[1])).toEqual(["dailySales"]);
    expect(src).not.toMatch(/https?:\/\/|\bfetch\(/);
  });
});

void reached;
