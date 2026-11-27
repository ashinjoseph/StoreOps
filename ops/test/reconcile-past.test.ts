// Reconcile a past day again (card P4-12c). A NEW ability of the Operations app (ADR-0023): nothing in
// the Apps Script app to compare with, so these tests are its specification. Against a real database
// with invented people and figures, a fake network (no test reaches Clover or Meta), and the
// notifier watched.
//
// In order: today's run is unchanged by the split that made the past-day run possible (a golden
// recorded from the code before the split); the promise (a past day reconciled through the new call
// stores what the real run on that day stored); after a till correction; each rule in order with its
// message; the card processor (off, unreachable, out of time, refusing a past day, and the window
// asked of it, on clock-change days too); no message; what is kept and what is never touched; the
// audit row; who may call, through the real router; two re-runs at once; a correction racing a re-run.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../src/auth/sessions";
import { ROLES, type Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction, type Tx } from "../src/db/tx";
import { Config, loadConfig } from "../src/lib/config";
import * as reconcile from "../src/modules/reconcile";
import * as pastDay from "../src/modules/reconcile-past";
import * as corrections from "../src/modules/till-corrections";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { MAY_RERUN, rpcReconcilePastDay } from "../src/rpc/handlers/reconcile-past";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import type { RpcContext } from "../src/rpc/types";
import * as notifier from "../src/modules/notifier";
import { createTestDb, type TestDb } from "./helpers/db";

// The real notifier, watched: a past-day run must never reach sendOp.
vi.mock("../src/modules/notifier", async (original) => {
  const real = await original<typeof import("../src/modules/notifier")>();
  return { ...real, sendOp: vi.fn(real.sendOp) };
});

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let db2: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

// Friday 27 November 2026, 15:00 Toronto (UTC-5): the day the re-runs are made.
const PAST_NOW = new Date("2026-11-27T20:00:00Z");
const TODAY = "2026-11-27";
// The day being reconciled again, and the moment it was reconciled the first time (22:05 that evening).
const DAY = "2026-11-20";
const DAY_NOW = new Date("2026-11-21T03:05:00Z");
const WA_TOKEN = "test-wa-token-Hk2";
const CLOVER_TOKEN = "test-clover-vape-Zq81xV";
const META_URL = "https://graph.facebook.com/v21.0/100000000000001/messages";
const REASON = "Till 2 count was fixed on Monday";

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  db2 = await connect(testDb.appUrl);
  owner = await connect(testDb.ownerUrl);
});
afterAll(async () => {
  await db?.close();
  await db2?.close();
  await owner?.close();
  await testDb?.drop();
});

const BASE_CONFIG: Record<string, string> = {
  cstore_default_opening_float: "250",
  vape_default_opening_float: "60",
  lotto_reserve_default: "500",
  variance_ok_threshold: "1",
  variance_minor_threshold: "30",
  card_variance_threshold: "1",
  whatsapp_template_shift_close: "shift_close_v2",
  whatsapp_template_shift_close_cstore: "shift_close_cstore",
  whatsapp_template_shift_close_vape: "shift_close_vape",
  notifier_enabled: "TRUE",
  whatsapp_api_url: META_URL,
  whatsapp_target_number: "14165550100",
  cstore_card_split: "false",
  vape_card_split: "true",
  clover_enabled: "true",
  clover_vape_merchant_id: "VAPE1",
};
const ENV = { WHATSAPP_API_TOKEN: WA_TOKEN, CLOVER_VAPE_TOKEN: CLOVER_TOKEN };

async function setConfig(over: Record<string, string | null> = {}): Promise<void> {
  await owner.query("delete from ops.config");
  for (const [k, v] of Object.entries({ ...BASE_CONFIG, ...over })) {
    if (v === null) continue;
    await owner.query("insert into ops.config (key, value) values ($1, $2)", [k, v]);
  }
}

const STAFF: Array<[string, string, string]> = [
  ["S_001", "Ada Quill", "admin"],
  ["S_002", "Bram Hale", "manager"],
  ["S_004", "Ashin Vale", "employee"],
  ["S_005", "Meera Stone", "employee"],
  ["S_006", "Fay Ortega", "payroll_admin"],
];

async function reset(over: Record<string, string | null> = {}): Promise<void> {
  for (const t of ["audit_log", "validation_results", "cash_handover_items", "cash_handovers", "commission_runs", "payment_items", "payments", "sales", "till_sessions", "attendance", "sessions", "staff", "config"]) {
    await owner.query(`delete from ops.${t}`);
  }
  for (const [id, name, role] of STAFF) {
    await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized) values ($1,$2,17,true,$3,'cstore,vape')", [id, name, role]);
  }
  await setConfig(over);
  vi.mocked(notifier.sendOp).mockClear();
}
beforeEach(() => reset());

// ── The day's data ─────────────────────────────────────────

interface Sess {
  id: string;
  company: "cstore" | "vape";
  staff?: string;
  float: number;
  counted: number;
  expected: number;
  status?: string;
  start?: string | null;
  end?: string | null;
  date?: string;
}
/** A till session of `date`, 09:00 to 21:20 Toronto (winter time) unless said otherwise. */
async function sess(o: Sess): Promise<void> {
  const staff = o.staff ?? (o.company === "cstore" ? "S_004" : "S_005");
  const date = o.date ?? DAY;
  const next = new Date(Date.parse(date + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
  const att = `A_${date.replace(/-/g, "")}_${staff}`;
  await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ($1, $2, $3, 'worked') on conflict do nothing", [att, staff, date]);
  const cstore = o.company === "cstore";
  await owner.query(
    `insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time, end_time, expected_opening, opening_float,
       closing_cash_counted, cash_left_in_till, cash_removed_at_close, expected_cash, closing_variance, variance_status, lotto_reserve_counted, lotto_topup_from_till, lotto_reserve_note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$9,$11,$12,$13,'OK',$14,$15,null)`,
    [
      o.id,
      att,
      staff,
      o.company,
      date,
      o.status ?? "closed",
      o.start === undefined ? `${date}T14:00:00Z` : o.start,
      o.end === undefined ? `${next}T02:20:00Z` : o.end,
      o.float,
      o.counted,
      Math.round((o.counted - o.float) * 100) / 100,
      o.expected,
      Math.round((o.counted - o.expected) * 100) / 100,
      cstore ? 500 : null,
      cstore ? 0 : null,
    ],
  );
}
async function sale(sessionId: string, company: string, staff: string, date: string, f: { cash: number; credit?: number; debit?: number; total?: number }): Promise<void> {
  await owner.query(
    `insert into ops.sales (sales_id, session_id, staff_id, company, date, cash_sales, credit_card_sales, debit_card_sales, misc_cash_sales, misc_credit_sales, misc_debit_sales, card_total_sales, misc_card_sales)
     values ($1,$1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11)`,
    [sessionId, staff, company, date, f.cash, f.credit ?? null, f.debit ?? null, f.total === undefined ? 0 : null, f.total === undefined ? 0 : null, f.total ?? null, f.total === undefined ? null : 0],
  );
}

type Tills = "both" | "cstore" | "vape";
/** cstore: one card total ($1,240), cash exact. vape: credit 1 + debit 50, cash $6 short. */
async function seedDay(day = DAY, tills: Tills = "both", ids: { cst?: string; vap?: string } = {}): Promise<void> {
  const cst = ids.cst ?? "CST-1";
  const vap = ids.vap ?? "VAP-1";
  if (tills !== "vape") {
    await sess({ id: cst, company: "cstore", float: 250, counted: 850, expected: 850, date: day });
    await sale(cst, "cstore", "S_004", day, { cash: 600, total: 1240 });
  }
  if (tills !== "cstore") {
    await sess({ id: vap, company: "vape", float: 60, counted: 105, expected: 111, date: day });
    await sale(vap, "vape", "S_005", day, { cash: 51, credit: 1, debit: 50 });
  }
}

// ── The network ────────────────────────────────────────────

type Reply = { status: number; body?: unknown } | { throws: string };
interface Sent {
  url: string;
  method: string;
}
/** Clover answers from `clover` in order (VAPE_OK when it runs out, unless `strict`); Meta answers 200. */
function net(clover: Reply[] = [], opts: { gate?: Promise<void>; onFirst?: () => void } = {}) {
  const sent: Sent[] = [];
  const queue = [...clover];
  let first = true;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, method: init?.method ?? "GET" });
    if (new URL(url).hostname === "graph.facebook.com") return new Response(JSON.stringify({ messages: [{ id: "wamid.T" }] }), { status: 200 });
    if (first) {
      first = false;
      opts.onFirst?.();
      if (opts.gate) await opts.gate;
    }
    const r = queue.shift() ?? VAPE_OK;
    if ("throws" in r) throw new Error(r.throws);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null), { status: r.status });
  }) as typeof fetch;
  return {
    fetch: f,
    sent,
    clover: () => sent.filter((s) => !s.url.startsWith("https://graph.facebook.com/")),
    meta: () => sent.filter((s) => s.url.startsWith("https://graph.facebook.com/")),
  };
}
type Net = ReturnType<typeof net>;
const card = (cents: number, kind: "credit" | "debit") => ({ amount: cents, result: "SUCCESS", cardTransaction: { type: kind.toUpperCase() }, tender: { label: kind } });
/** credit 1, debit 50, total 51: matches the vape till's claim. */
const VAPE_OK: Reply = { status: 200, body: { elements: [card(100, "credit"), card(5000, "debit")] } };

type Deps = { env?: Record<string, string>; now?: Date; elapsedMs?: () => number; on?: Db };
/** Today's run, the real way, as the reconcile screen's "Reconcile today" does it. */
async function runToday(n: Net, o: Deps = {}, mode: "auto" | "manual" = "manual", actor = "S_004"): Promise<any> {
  return withTransaction(o.on ?? db, async (tx) =>
    reconcile.reconcileDay(tx, { config: await loadConfig(tx), env: o.env ?? ENV, fetch: n.fetch, now: o.now ?? DAY_NOW, ...(o.elapsedMs ? { elapsedMs: o.elapsedMs } : {}) }, actor, mode),
  );
}
/** The past-day run, through the module. */
async function runPast(n: Net, input: Record<string, unknown> = { date: DAY, reason: REASON }, o: Deps = {}, actor = "S_001"): Promise<any> {
  return withTransaction(o.on ?? db, async (tx) =>
    pastDay.reconcilePastDay(tx, { config: await loadConfig(tx), env: o.env ?? ENV, fetch: n.fetch, now: o.now ?? PAST_NOW, ...(o.elapsedMs ? { elapsedMs: o.elapsedMs } : {}) }, actor, input),
  );
}

const results = (where = "true") => db.query<any>(`select * from ops.validation_results where ${where} order by seq`);
const audits = (action?: string) => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details from ops.audit_log ${action ? "where action = '" + action + "'" : ""} order by seq`);
/** The columns that are the day's verdict: everything but the row's own identity and order. */
const FIGURES = [
  "business_date",
  "window_start",
  "window_end",
  "merchant",
  "companies",
  "cashier_credit",
  "clover_credit",
  "cashier_debit",
  "clover_debit",
  "cashier_card",
  "clover_card",
  "card_variance",
  "cash_counted",
  "cash_variance",
  "status",
  "mode",
  "session_ids",
  "cash_sales",
  "validated_by",
];
const figs = (rows: any[]) => rows.map((r) => Object.fromEntries(FIGURES.map((k) => [k, r[k] instanceof Date ? r[k].toISOString() : r[k]])));

// ── 0. Today's run is unchanged ────────────────────────────

describe("rpcReconcileDay is unchanged by the split (a golden recorded from the code before it)", () => {
  // Recorded by running exactly this day through reconcileDay as it was at commit 196f6f4 (before
  // buildRecords was split out of it). If this fails, the split changed what a today-run stores.
  const GOLDEN: any[] = [
    {
      business_date: "2026-11-20",
      window_start: "2026-11-20T14:00:00.000Z",
      window_end: "2026-11-21T02:20:00.000Z",
      merchant: "(not configured)",
      companies: "cstore",
      cashier_credit: null,
      clover_credit: null,
      cashier_debit: null,
      clover_debit: null,
      cashier_card: 1240,
      clover_card: null,
      card_variance: null,
      cash_counted: 850,
      cash_variance: 0,
      status: "OK",
      mode: "manual",
      session_ids: "CST-1",
      cash_sales: 600,
      validated_by: "S_004",
    },
    {
      business_date: "2026-11-20",
      window_start: "2026-11-20T14:00:00.000Z",
      window_end: "2026-11-21T02:20:00.000Z",
      merchant: "VAPE1",
      companies: "vape",
      cashier_credit: 1,
      clover_credit: 1,
      cashier_debit: 50,
      clover_debit: 50,
      cashier_card: 51,
      clover_card: 51,
      card_variance: 0,
      cash_counted: 105,
      cash_variance: -6,
      status: "investigate",
      mode: "manual",
      session_ids: "VAP-1",
      cash_sales: 51,
      validated_by: "S_004",
    },
  ];
  it("a manual run of a two-till day stores these rows, sends two messages and audits reconcile.day", async () => {
    await seedDay();
    const n = net();
    const out = await runToday(n);
    expect(figs(await results())).toEqual(GOLDEN);
    expect(out.merchants).toHaveLength(2);
    expect(out.whatsapp.perGroup).toHaveLength(2);
    expect(n.meta()).toHaveLength(2);
    expect((await audits()).map((a: any) => a.action)).toEqual(["reconcile.day"]);
  });
});

// ── 1. The promise ─────────────────────────────────────────

describe("past-equals-today: the new call stores what the real run on that day stored", () => {
  const cases: Array<{ name: string; tills: Tills; processor: boolean }> = [
    { name: "both tills, the processor on", tills: "both", processor: true },
    { name: "both tills, the processor off", tills: "both", processor: false },
    { name: "one till (vape), the processor on", tills: "vape", processor: true },
    { name: "one till (vape), the processor off", tills: "vape", processor: false },
    { name: "one till (cstore, which has no processor)", tills: "cstore", processor: true },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const over = { clover_enabled: c.processor ? "true" : "false" };
      // World A: the real run, on that day, in the evening.
      await reset(over);
      await seedDay(DAY, c.tills);
      const a = net();
      await runToday(a);
      const real = figs(await results());
      const realClover = a.clover().map((s) => s.url);
      // World B: an identical day, reconciled again from another day.
      await reset(over);
      await seedDay(DAY, c.tills);
      const b = net();
      const out = await runPast(b, { date: DAY, reason: REASON }, {}, "S_004");
      const again = figs(await results());
      expect(again.length).toBeGreaterThan(0);
      expect(again).toEqual(real);
      // The same questions of the processor (the same window, the same merchant).
      expect(b.clover().map((s) => s.url)).toEqual(realClover);
      expect(out.merchants.map((m: any) => [m.merchant, m.status, m.cardsVerified, m.cashVariance])).toEqual(
        (await results()).map((r) => [r.merchant, r.status, r.clover_card !== null, Number(r.cash_variance)]),
      );
    });
  }

  it("a group with a session missing its times falls back to the day itself, not to the moment of the re-run", async () => {
    await sess({ id: "VAP-1", company: "vape", float: 60, counted: 111, expected: 111, start: null, end: null });
    await sale("VAP-1", "vape", "S_005", DAY, { cash: 51, credit: 1, debit: 50 });
    await runPast(net());
    const [r] = await results();
    expect(r.window_start.toISOString()).toBe("2026-11-20T05:00:00.000Z"); // Toronto midnight
    expect(r.window_end.toISOString()).toBe("2026-11-21T04:59:59.999Z"); // 23:59:59.999 that day, not 27 Nov
  });
});

// ── 2. After a correction ──────────────────────────────────

describe("after a correction: the new rows carry the corrected figures", () => {
  async function closeVape(): Promise<string> {
    const { open, close } = await import("../src/modules/till-sessions");
    const deps = async (tx: Tx, now: Date) => ({ config: await loadConfig(tx), now });
    await withTransaction(db, async (tx) => open(tx, { staffId: "S_005", company: "vape", openingCount: 60, actorId: "S_005" }, await deps(tx, new Date(`${DAY}T14:00:00Z`))));
    const id = `VAP-${DAY.replace(/-/g, "")}-S_005`;
    await withTransaction(db, async (tx) =>
      close(
        tx,
        { sessionId: id, actorId: "S_005", cashSales: 1150, creditCard: 300, debitCard: 200, miscCash: 0, miscCredit: 0, miscDebit: 0, miscNotes: "", physicalCount: 1480, lottoCounted: null, lottoTopupFromTill: 0, lottoNote: "" },
        await deps(tx, new Date(`${DAY}T22:00:00Z`)),
      ),
    );
    return id;
  }

  it("reconcile, correct a till, run the day again: new rows are the corrected verdict, old rows are untouched, the reader lists the new first", async () => {
    const id = await closeVape();
    // Clover says 300 + 200 = 500 for the day: the cards match; the count is $270 over (1480 vs 1210 expected).
    const first = net([{ status: 200, body: { elements: [card(30000, "credit"), card(20000, "debit")] } }]);
    await runToday(first);
    const oldRows = await results();
    expect(oldRows).toHaveLength(1);
    expect(oldRows[0].status).toBe("investigate");
    expect(Number(oldRows[0].cash_variance)).toBe(270);
    const oldSnapshot = JSON.stringify(oldRows);

    // The admin corrects the count: it was 1,250.00.
    await withTransaction(db, async (tx) =>
      corrections.correct(
        tx,
        { sessionId: id, openingFloat: 60, closingCashCounted: 1210, cashSales: 1150, creditCardSales: 300, debitCardSales: 200, miscCashSales: 0, miscCreditSales: 0, miscDebitSales: 0, miscNotes: "", notes: null, reason: "Count typed as 1,480.00" },
        "S_001",
        await loadConfig(tx),
        new Date("2026-11-23T15:00:00Z"),
      ),
    );

    const second = net([{ status: 200, body: { elements: [card(30000, "credit"), card(20000, "debit")] } }]);
    const out = await runPast(second);
    expect(out.rerun).toBe(true);
    expect(out.previous).toBe(1);
    const all = await results();
    expect(all).toHaveLength(2);
    expect(JSON.stringify(all.slice(0, 1))).toBe(oldSnapshot); // byte-identical
    expect(all[1].status).toBe("OK");
    expect(Number(all[1].cash_variance)).toBe(0);
    expect(Number(all[1].cash_counted)).toBe(1210);
    expect(Number(all[1].card_variance)).toBe(0);
    // The reader the Reconcile screen uses lists the newest first; the page shows the first set of a day.
    const recent = await reconcile.getRecent(db, 60);
    expect(recent.map((r) => [r.status, r.cashVariance, r.validatedAt])).toEqual([
      ["OK", 0, PAST_NOW.toISOString()],
      ["investigate", 270, oldRows[0].validated_at.toISOString()],
    ]);
  });
});

// ── 3. The rules, in order ─────────────────────────────────

describe("the rules, in order", () => {
  const fail = (input: unknown, msg: string) => expect(runPast(net(), input as Record<string, unknown>)).rejects.toThrow(msg);
  beforeEach(() => seedDay());

  it("1. the date is a real YYYY-MM-DD", async () => {
    for (const bad of [undefined, null, "", "20261120", "2026-11-2", "11/20/2026", "2026-02-30", "2026-13-01", "2026-00-10", "2026-11-31", 20261120, "2026-11-20 ", "2026-11-20T00:00:00Z"]) {
      await fail({ date: bad, reason: REASON }, "Enter the date as YYYY-MM-DD.");
    }
    await fail({ reason: REASON }, "Enter the date as YYYY-MM-DD.");
  });
  it("1. before today in Toronto: today and the future are refused", async () => {
    await fail({ date: TODAY, reason: REASON }, "Use Reconcile today for today.");
    await fail({ date: "2026-11-28", reason: REASON }, "That day has not happened yet.");
    await fail({ date: "2027-01-01", reason: REASON }, "That day has not happened yet.");
    // Toronto's today, not UTC's: 23:30 Toronto on the 27th is already the 28th in UTC.
    const lateEvening = new Date("2026-11-28T04:30:00Z");
    await fail({ date: TODAY, reason: REASON }, "Use Reconcile today for today.");
    await expect(runPast(net(), { date: TODAY, reason: REASON }, { now: lateEvening })).rejects.toThrow("Use Reconcile today for today.");
    // ...and a few minutes after midnight Toronto, yesterday is the 27th.
    await seedDay("2026-11-27", "vape", { vap: "VAP-27" });
    const afterMidnight = new Date("2026-11-28T05:10:00Z");
    expect((await runPast(net(), { date: TODAY, reason: REASON }, { now: afterMidnight })).ready).toBe(true);
  });
  it("1. not more than 370 days back: 370 is accepted, 371 is refused", async () => {
    await expect(runPast(net(), { date: "2025-11-21", reason: REASON })).rejects.toThrow("Cannot reconcile a day from more than 370 days ago.");
    await expect(runPast(net(), { date: "2020-01-01", reason: REASON })).rejects.toThrow("Cannot reconcile a day from more than 370 days ago.");
    await seedDay("2025-11-22", "vape", { vap: "VAP-OLD" });
    expect((await runPast(net(), { date: "2025-11-22", reason: REASON })).date).toBe("2025-11-22");
  });
  it("1 comes before 2: a bad date with no reason says the date", async () => {
    await fail({ date: "nope" }, "Enter the date as YYYY-MM-DD.");
    await fail({ date: TODAY }, "Use Reconcile today for today.");
  });
  it("2. a reason of 3 to 300 characters after trimming, no control characters", async () => {
    const need = "A reason is required: 3 to 300 characters.";
    for (const r of [undefined, null, "", "  ", "ab", "  a  ", 12345, "x".repeat(301)]) await fail({ date: DAY, reason: r }, need);
    await fail({ date: DAY, reason: "two\nlines" }, "The reason cannot contain control characters (such as a line break).");
    await fail({ date: DAY, reason: "tab\there" }, "The reason cannot contain control characters (such as a line break).");
    expect(await results()).toHaveLength(0);
    for (const ok of ["abc", "  trimmed  ", "x".repeat(300)]) {
      await reset();
      await seedDay();
      await runPast(net(), { date: DAY, reason: ok });
      expect((await audits("reconcile.past_day"))[0].details).toBe(ok.trim());
    }
  });
  it("3. refused while any till of that day is still open, naming whose", async () => {
    await sess({ id: "VAP-2", company: "vape", staff: "S_004", float: 60, counted: 0, expected: 0, status: "open", end: null });
    const n = net();
    await expect(runPast(n)).rejects.toThrow("Ashin Vale's vape till from that day is still open: close it first.");
    expect(await results()).toHaveLength(0);
    expect(n.clover()).toHaveLength(0);
    expect(await audits()).toEqual([]);
  });
  it("3 comes before 4: an open till is named even when nothing is closed", async () => {
    await reset();
    await sess({ id: "CST-9", company: "cstore", float: 250, counted: 0, expected: 0, status: "open", end: null });
    await expect(runPast(net())).rejects.toThrow("Ashin Vale's cstore till from that day is still open: close it first.");
  });
  it("4. refused when that day has no closed till at all", async () => {
    await expect(runPast(net(), { date: "2026-11-19", reason: REASON })).rejects.toThrow("No closed till on 2026-11-19.");
    expect(await results()).toHaveLength(0);
    expect(await audits()).toEqual([]);
  });
  it("5. reconciles the whole day: every till with a closed or validated session, and nothing of another day", async () => {
    await reset();
    await seedDay(DAY, "cstore");
    await sess({ id: "VAP-1", company: "vape", float: 60, counted: 111, expected: 111, status: "validated" });
    await sale("VAP-1", "vape", "S_005", DAY, { cash: 51, credit: 1, debit: 50 });
    await seedDay("2026-11-19", "both", { cst: "CST-19", vap: "VAP-19" });
    const out = await runPast(net());
    expect(out.merchants.map((m: any) => m.companies)).toEqual([["cstore"], ["vape"]]);
    const rows = await results();
    expect(rows.map((r) => [r.business_date, r.companies, r.session_ids])).toEqual([
      ["2026-11-20", "cstore", "CST-1"],
      ["2026-11-20", "vape", "VAP-1"],
    ]);
  });
  it("5. a second re-run reconciles the whole day again, not only what is new", async () => {
    await runPast(net());
    const out = await runPast(net(), { date: DAY, reason: "Second look" }, { now: new Date(PAST_NOW.getTime() + 60_000) });
    expect(out.previous).toBe(2);
    expect(out.merchants).toHaveLength(2);
    expect(await results()).toHaveLength(4);
  });
});

// ── 4. The card processor ──────────────────────────────────

describe("cards: asked for that day's window; when it cannot answer they are not verified, never matching, never 0", () => {
  const notVerified = (r: any, status: string) => {
    expect(r.clover_credit).toBeNull();
    expect(r.clover_debit).toBeNull();
    expect(r.clover_card).toBeNull();
    expect(r.card_variance).toBeNull();
    expect(Number(r.cashier_card)).toBe(51);
    expect(r.status).toBe(status);
  };
  beforeEach(() => seedDay(DAY, "vape"));

  it("the processor off: out of scope, the cash verdict stands", async () => {
    await reset({ clover_enabled: "false" });
    await seedDay(DAY, "vape");
    const n = net();
    const out = await runPast(n);
    expect(n.clover()).toHaveLength(0);
    const [r] = await results();
    notVerified(r, "investigate"); // $6 short
    expect(out.merchants[0]).toMatchObject({ cloverNA: true, cardsVerified: false, cloverCard: null, cardDiff: null });
  });
  it("unreachable: clover_unavailable", async () => {
    const out = await runPast(net([{ throws: "ECONNRESET" }]));
    notVerified((await results())[0], "clover_unavailable");
    expect(out.merchants[0]).toMatchObject({ cloverNA: false, cardsVerified: false, cloverError: "exception" });
  });
  it("refusing a past day (any HTTP error): clover_unavailable", async () => {
    await runPast(net([{ status: 400, body: "createdTime out of range" }]));
    notVerified((await results())[0], "clover_unavailable");
    expect((await runPast(net([{ status: 500, body: "oops" }]), { date: DAY, reason: "again" }, { now: new Date(PAST_NOW.getTime() + 1) })).merchants[0].cloverError).toBe("http_500");
  });
  it("out of time (the budget used up before the question): no request is made, clover_unavailable", async () => {
    const n = net();
    const out = await runPast(n, { date: DAY, reason: REASON }, { elapsedMs: () => reconcile.CLOVER_BUDGET_MS + 1 });
    expect(n.clover()).toHaveLength(0);
    notVerified((await results())[0], "clover_unavailable");
    expect(out.merchants[0].cloverError).toBe("exception");
  });
  it("answering: matched, and a real difference is a difference", async () => {
    await runPast(net([VAPE_OK]));
    expect(Number((await results())[0].card_variance)).toBe(0);
    await runPast(net([{ status: 200, body: { elements: [card(100, "credit"), card(4000, "debit")] } }]), { date: DAY, reason: "again" }, { now: new Date(PAST_NOW.getTime() + 1) });
    expect(Number((await results())[1].card_variance)).toBe(10);
    expect((await results())[1].status).toBe("investigate");
  });

  const window = (n: Net) => {
    const u = new URL(n.clover()[0]!.url);
    const [from, to] = u.searchParams.getAll("filter").map((f) => Number(f.split(/[<>]=/)[1]));
    return { from, to, path: u.pathname };
  };
  it("the window asked is the window of that day's sessions, not today's", async () => {
    const n = net();
    await runPast(n);
    expect(window(n)).toEqual({ from: Date.parse("2026-11-20T14:00:00Z"), to: Date.parse("2026-11-21T02:20:00Z"), path: "/v3/merchants/VAPE1/payments" });
  });
  it("two sessions of one merchant: from the earliest start to the latest end", async () => {
    await sess({ id: "VAP-2", company: "vape", staff: "S_004", float: 60, counted: 60, expected: 60, start: `${DAY}T12:30:00Z`, end: `${DAY}T15:00:00Z` });
    await sale("VAP-2", "vape", "S_004", DAY, { cash: 0, credit: 0, debit: 0 });
    const n = net();
    await runPast(n);
    expect(window(n)).toEqual({ from: Date.parse("2026-11-20T12:30:00Z"), to: Date.parse("2026-11-21T02:20:00Z"), path: "/v3/merchants/VAPE1/payments" });
  });
  for (const [name, day, start, end] of [
    ["the clock goes back (Sun 1 Nov 2026, a 25-hour day)", "2026-11-01", "2026-11-01T04:30:00Z", "2026-11-02T04:30:00Z"],
    ["the clock goes forward (Sun 8 Mar 2026, a 23-hour day)", "2026-03-08", "2026-03-08T05:30:00Z", "2026-03-09T03:30:00Z"],
  ] as const) {
    it(`on a clock-change day: ${name}`, async () => {
      await reset();
      await sess({ id: "VAP-C", company: "vape", float: 60, counted: 111, expected: 111, date: day, start, end });
      await sale("VAP-C", "vape", "S_005", day, { cash: 51, credit: 1, debit: 50 });
      const n = net();
      await runPast(n, { date: day, reason: REASON });
      expect(window(n)).toMatchObject({ from: Date.parse(start), to: Date.parse(end) });
      // Not today's window, nor the one that day's midnights would give.
      expect(window(n).from).toBeLessThan(Date.parse(TODAY));
      const [r] = await results();
      expect(r.business_date).toBe(day);
      expect(r.window_start.toISOString()).toBe(new Date(start).toISOString());
    });
  }
});

// ── 5. No message ──────────────────────────────────────────

describe("no WhatsApp message is sent", () => {
  it("the notifier is never called, nothing reaches Meta, and the answer says so", async () => {
    await seedDay();
    const n = net();
    const out = await runPast(n);
    expect(notifier.sendOp).not.toHaveBeenCalled();
    expect(n.meta()).toHaveLength(0);
    expect(out.sent).toBe(false);
    expect(out.whatsapp).toEqual({ sent: false, reason: "past_day_rerun" });
    expect(out.whatsappSummary).toBe("not sent: a re-run of a past day sends no message");
    // Whereas today's run, with the same configuration, does send (the test can see a send).
    await runToday(net());
    expect(notifier.sendOp).toHaveBeenCalledTimes(2);
  });
  it("the module has no way to send: it names no notifier and no message builder", () => {
    const src = readFileSync(new URL("../src/modules/reconcile-past.ts", import.meta.url), "utf8");
    for (const word of ["notifier", "sendOp", "reconParams", "formatMessage", "sendNotifications", "inHandParam", "statusParam"]) {
      expect(src.replace(/\/\/.*$/gm, "")).not.toContain(word);
    }
  });
  it("the audit row is the only trace, and it names no send", async () => {
    await seedDay();
    await runPast(net());
    expect((await audits()).map((a: any) => a.action)).toEqual(["reconcile.past_day"]);
    expect(await db.query("select * from ops.audit_log where action like 'notify%' or action = 'reconcile.day'")).toHaveLength(0);
  });
});

// ── 6. What is kept, what is never touched ─────────────────

const TABLES = ["till_sessions", "sales", "payments", "payment_items", "attendance", "cash_handovers", "cash_handover_items", "commission_runs", "bonuses", "staff", "config"];
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const t of TABLES) {
    const r = await owner.one<any>(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as j from ops.${t} x`);
    out[t] = r.j;
  }
  return out;
}

describe("earlier results are kept, new rows are marked, nothing else moves", () => {
  it("inserts new rows beside the old: the old ones are byte-identical, the new ones are manual rows validated later", async () => {
    await seedDay();
    await runToday(net());
    const before = await results();
    const out = await runPast(net(), { date: DAY, reason: REASON }, {}, "S_001");
    expect(out.previous).toBe(2);
    const after = await results();
    expect(after).toHaveLength(4);
    expect(JSON.stringify(after.slice(0, 2))).toBe(JSON.stringify(before));
    const fresh = after.slice(2);
    expect(fresh.map((r) => r.mode)).toEqual(["manual", "manual"]);
    expect(fresh.map((r) => r.validated_by)).toEqual(["S_001", "S_001"]);
    expect(fresh.every((r) => r.validated_at.toISOString() === PAST_NOW.toISOString())).toBe(true);
    expect(fresh.every((r) => r.business_date === DAY)).toBe(true);
    // The mark: validated on a later day than the business day (an ordinary run is validated on its own day).
    expect(before.every((r) => r.validated_at.toISOString().slice(0, 10) === "2026-11-21")).toBe(true);
    expect(new Set(fresh.map((r) => r.validation_id)).size).toBe(2);
    expect(await db.query("select validation_id from ops.validation_results where validation_id = any($1)", [before.map((r) => r.validation_id)])).toHaveLength(2);
  });
  it("till_sessions (statuses too), sales, payments, attendance, handovers and commission runs are identical before and after", async () => {
    await seedDay();
    await sess({ id: "VAP-V", company: "vape", staff: "S_004", float: 60, counted: 60, expected: 60, status: "validated" });
    await sale("VAP-V", "vape", "S_004", DAY, { cash: 0, credit: 0, debit: 0 });
    await runToday(net());
    const before = await snapshot();
    await runPast(net());
    expect(await snapshot()).toEqual(before);
    expect((await db.one<any>("select status from ops.till_sessions where session_id = 'VAP-V'")).status).toBe("validated");
    expect((await db.one<any>("select status from ops.till_sessions where session_id = 'VAP-1'")).status).toBe("closed");
  });
  it("today's own run leaves the session status as it is too (so the re-run moves it exactly as today's does: not at all)", async () => {
    await seedDay();
    const before = await snapshot();
    await runToday(net());
    expect(await snapshot()).toEqual(before);
  });
  it("answers what a manual run answers, plus rerun, sent and previous", async () => {
    await seedDay();
    const out = JSON.parse(JSON.stringify(await runPast(net())));
    expect(Object.keys(out).sort()).toEqual(["date", "merchants", "mode", "previous", "ready", "rerun", "sent", "whatsapp", "whatsappSummary"]);
    expect(out).toMatchObject({ ready: true, mode: "manual", date: DAY, rerun: true, sent: false, previous: 0 });
    const manual = JSON.parse(JSON.stringify(await runToday(net(), { now: new Date("2026-11-21T03:10:00Z") })));
    for (const k of Object.keys(manual)) expect(k in out).toBe(true);
    expect(Object.keys(out.merchants[0]).sort()).toEqual(Object.keys(manual.merchants[0]).sort());
  });
  it("one audit row, reconcile.past_day, targeting the day: the reason, the tills, the cash and card verdict per till", async () => {
    await seedDay();
    await runPast(net(), { date: DAY, reason: "  Till 2 count was fixed  " }, {}, "S_001");
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_id: "S_001", action: "reconcile.past_day", target_type: "validation_results", target_id: DAY, details: "Till 2 count was fixed" });
    const ids = (await results()).map((r) => r.validation_id);
    const after = JSON.parse(a[0].after);
    expect(after).toMatchObject({ date: DAY, reason: "Till 2 count was fixed", previous: 0, sent: false });
    expect(after.tills).toEqual([
      { validationId: ids[0], merchant: "(not configured)", companies: ["cstore"], sessionIds: ["CST-1"], cashCounted: 850, cashVariance: 0, cash: "OK", cardsVerified: false, cardDiff: null, cards: "not verified", status: "OK" },
      { validationId: ids[1], merchant: "VAPE1", companies: ["vape"], sessionIds: ["VAP-1"], cashCounted: 105, cashVariance: -6, cash: "short", cardsVerified: true, cardDiff: 0, cards: "matched", status: "investigate" },
    ]);
  });
  it("money in the audit row is rounded to cents", async () => {
    await sess({ id: "VAP-1", company: "vape", float: 60, counted: 111.005, expected: 111, date: DAY });
    await sale("VAP-1", "vape", "S_005", DAY, { cash: 51.004, credit: 1, debit: 50 });
    await runPast(net());
    const t = JSON.parse((await audits())[0].after).tills[0];
    expect(Number.isInteger(Math.round(t.cashVariance * 100))).toBe(true);
    expect(String(t.cashCounted)).toMatch(/^\d+(\.\d{1,2})?$/);
  });
});

// ── 7. Who may call ────────────────────────────────────────

describe("who may call: the real router with the merged contract", () => {
  const base = JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8"));
  const contract = parseRpcContract(mergeOpsContract(base, JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8"))));
  const refuse = (async () => {
    throw new Error("no network in this test");
  }) as unknown as typeof fetch;
  const router = () => createRpcRouter({ contract, handlers, openDb: () => connect(testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env: {}, fetch: refuse, now: () => PAST_NOW, log: () => undefined });
  async function call(name: string, args: unknown[]) {
    const res = await router()(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
    return (await res.json()) as { ok: boolean; result?: any; error?: { message: string } };
  }
  const tokenOf = async (staffId: string) => (await createSession(db, staffId, Config.fromRows([]), PAST_NOW)).token;
  const sameRoles = base.rpcs.find((r: any) => r.name === "rpcReconcileDay").roles as string[] | null;
  const roleOf = (id: string) => STAFF.find((s) => s[0] === id)![2];
  const people = ["S_001", "S_002", "S_004", "S_006"];

  it("the contract lists admin, manager and payroll admin (the same three the handler checks), a session, and a token and an input", () => {
    expect(contract.get("rpcReconcilePastDay")).toMatchObject({ params: ["token", "input"], needs_session: true, migrate: true });
    expect(contract.get("rpcReconcilePastDay")!.roles).toEqual(["admin", "manager", "payroll_admin"]);
    expect(contract.get("rpcReconcilePastDay")!.roles).toEqual([...MAY_RERUN]);
    expect(handlers["rpcReconcilePastDay"]).toBe(rpcReconcilePastDay);
  });
  it("admin, manager and payroll admin are answered; an employee is refused and nothing is written", async () => {
    const allowed = (role: string) => (MAY_RERUN as readonly string[]).includes(role);
    expect(new Set(people.map(roleOf))).toEqual(new Set(ROLES));
    let expectedRuns = 0;
    for (const id of people) {
      await reset();
      await seedDay();
      const t = await tokenOf(id);
      const past = await call("rpcReconcilePastDay", [t, { date: DAY, reason: REASON }]);
      expect(past.ok, roleOf(id)).toBe(allowed(roleOf(id)));
      if (!past.ok) {
        expect(past.error!.message).toMatch(/^FORBIDDEN: requires .*, got employee$/);
        expect(await results()).toHaveLength(0);
        expect(await audits("reconcile.past_day")).toHaveLength(0);
      } else {
        expectedRuns++;
        expect(past.result).toMatchObject({ rerun: true, sent: false, previous: 0 });
      }
    }
    expect(expectedRuns).toBe(people.filter((p) => allowed(roleOf(p))).length);
  });
  it("no token, an empty one, an unknown one: NOT_LOGGED_IN, nothing written", async () => {
    await seedDay();
    for (const t of [undefined, "", "nope", null]) expect((await call("rpcReconcilePastDay", [t, { date: DAY, reason: REASON }])).error?.message).toBe("NOT_LOGGED_IN");
    expect(await results()).toHaveLength(0);
  });
  it("a role, actorId or staffId planted in the input changes nothing: the rows and the audit row name the session's person", async () => {
    await seedDay();
    const t = await tokenOf("S_002");
    const out = await call("rpcReconcilePastDay", [t, { date: DAY, reason: REASON, role: "admin", actorId: "S_001", staffId: "S_006", mode: "auto", force: true, sent: true, previous: 99 }]);
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({ mode: "manual", sent: false, previous: 0 });
    expect((await results()).map((r) => [r.validated_by, r.mode])).toEqual([["S_002", "manual"], ["S_002", "manual"]]);
    expect((await audits())[0].actor_id).toBe("S_002");
  });
  it("the handler checks again itself: no session, a role nobody has, a missing input", async () => {
    const ctx = (tx: Tx, who: Session | null): RpcContext => ({ db: tx, session: who, config: () => loadConfig(tx), env: {}, fetch: refuse, now: PAST_NOW });
    const as = (who: Session | null, ...args: unknown[]) => withTransaction(db, async (tx) => rpcReconcilePastDay(ctx(tx, who), ...args));
    const person = (role: string): Session => ({ staffId: "S_001", name: "x", role: role as Session["role"], companiesAuthorized: [], expiresAt: 0 });
    await seedDay();
    await expect(as(null, { date: DAY, reason: REASON })).rejects.toThrow("NOT_LOGGED_IN");
    await expect(as(person("ghost"), { date: DAY, reason: REASON })).rejects.toThrow("FORBIDDEN");
    await expect(as(person("employee"), { date: DAY, reason: REASON })).rejects.toThrow("FORBIDDEN");
    await expect(as(person("admin"), null)).rejects.toThrow("input is required");
    await expect(as(person("admin"), [1])).rejects.toThrow("input is required");
    await expect(as(person("admin"))).rejects.toThrow("input is required");
    expect(await results()).toHaveLength(0);
    expect(((await as(person("admin"), { date: DAY, reason: REASON })) as { rerun: boolean }).rerun).toBe(true);
  });
  it("a cashier cannot run a past day again, though the ported rpcReconcileDay still lets any signed-in person run today's", async () => {
    // rpcReconcileDay is open to everyone in the old app and so in the port (rpc.json: roles null). The new call is narrower.
    expect(sameRoles).toBeNull();
    await seedDay();
    const out = await call("rpcReconcilePastDay", [await tokenOf("S_004"), { date: DAY, reason: REASON }]);
    expect(out.ok).toBe(false);
    expect(out.error!.message).toMatch(/^FORBIDDEN/);
    expect(await results()).toHaveLength(0);
    expect(await audits("reconcile.past_day")).toHaveLength(0);
  });
});

// ── 8. Two at once ─────────────────────────────────────────

describe("two re-runs of the same day at once", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (await cond()) return;
      await sleep(10);
    }
    throw new Error("timed out waiting");
  }

  it("the day's advisory lock makes them take turns: the second waits, then sees the first's rows; no row is doubled or interleaved", async () => {
    await seedDay();
    await runToday(net());
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    const a = net([VAPE_OK], { gate, onFirst: () => (held = true) });
    const b = net([VAPE_OK]);
    const first = runPast(a, { date: DAY, reason: "first at once" }, { on: db, now: new Date(PAST_NOW.getTime()) });
    await until(() => held); // A is inside the processor's question, holding the day's lock
    let done = false;
    const second = runPast(b, { date: DAY, reason: "second at once" }, { on: db2, now: new Date(PAST_NOW.getTime() + 5000) }).then((r) => {
      done = true;
      return r;
    });
    // B is waiting for the day's advisory lock (this database's: the cluster is shared with other test files,
    // so look at ours only, and let go as soon as it is seen: others count waiting locks too).
    await until(async () => (await owner.query("select 1 from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = $1)", [testDb.name])).length === 1);
    expect(done).toBe(false);
    expect(b.clover()).toHaveLength(0); // it has not even started reading
    expect(await results()).toHaveLength(2); // only the original two are committed
    release();
    const [ra, rb] = await Promise.all([first, second]);
    expect([ra.previous, rb.previous]).toEqual([2, 4]);
    const all = await results();
    expect(all).toHaveLength(6);
    // Each run's rows are contiguous in the order written, and each run covers both tills once.
    const stamps = all.map((r) => r.validated_at.toISOString());
    expect(stamps).toEqual([stamps[0], stamps[0], stamps[2], stamps[2], stamps[4], stamps[4]]);
    expect(new Set(stamps).size).toBe(3);
    expect(all.map((r) => r.companies)).toEqual(["cstore", "vape", "cstore", "vape", "cstore", "vape"]);
    expect((await audits("reconcile.past_day")).map((x: any) => JSON.parse(x.after).previous)).toEqual([2, 4]);
  });

  it("a correction in flight is waited for: the re-run reads the corrected figures, not a mix", async () => {
    await seedDay();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let corrected = false;
    const correcting = withTransaction(db2, async (tx) => {
      await corrections.correct(
        tx,
        { sessionId: "CST-1", openingFloat: 250, closingCashCounted: 900, cashSales: 600, cardTotalSales: 1240, miscCashSales: 0, miscCardSales: 0, miscNotes: "", notes: null, reason: "Count was 900" },
        "S_001",
        await loadConfig(tx),
        new Date("2026-11-23T15:00:00Z"),
      );
      corrected = true;
      await gate;
    });
    await until(() => corrected);
    let done = false;
    const rerun = runPast(net(), { date: DAY, reason: REASON }).then((r) => {
      done = true;
      return r;
    });
    await sleep(300);
    expect(done).toBe(false);
    release();
    await correcting;
    const out = await rerun;
    expect(out.merchants[0].cashCounted).toBe(900);
    expect(Number((await results())[0].cash_counted)).toBe(900);
  });

  it("a failed re-run leaves nothing behind", async () => {
    await seedDay();
    const n = net();
    await expect(runPast(n, { date: DAY, reason: REASON }, { env: ENV, now: new Date(NaN) })).rejects.toThrow();
    expect(await results()).toHaveLength(0);
    expect(await audits()).toEqual([]);
  });
});
