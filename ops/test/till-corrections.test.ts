// Till corrections (card P4-12a): an admin sets a closed till's figures to what was really counted
// and sold. A NEW ability of the Operations app (ADR-0023): nothing in the Apps Script app to compare
// with, so these tests are its specification. Against a real database, with invented people and
// figures.
//
// First the promise the card makes (a correction stores exactly what a close with those figures
// would have stored), then the worked example end to end, who may call, each rule in order, the
// audit row, what is never touched, what goes stale, the reader, and the races.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/sessions";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction, type Tx } from "../src/db/tx";
import { Config, loadConfig } from "../src/lib/config";
import * as cashHandling from "../src/modules/cash-handling";
import * as publicReport from "../src/modules/public-report";
import * as salesDashboard from "../src/modules/sales-dashboard";
import * as corrections from "../src/modules/till-corrections";
import * as ts from "../src/modules/till-sessions";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { rpcCorrectTillSession, rpcGetTillCorrection } from "../src/rpc/handlers/till-corrections";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
// The app role cannot delete money or audit rows (by design): the rows are reset as the owner.
let owner: Db & { close(): Promise<void> };

// Toronto is UTC-4 in September. NOW is Sunday 2026-09-20, 14:00 in Toronto.
const NOW = new Date("2026-09-20T18:00:00Z");
/** After cstore moved to ePOS (one card figure). */
const DAY = "2026-09-12";
/** Before it (credit and debit). */
const OLD_DAY = "2026-08-20";
const EPOS_FROM = "2026-09-01";

const STAFF: Array<[string, string, number, string]> = [
  ["S_001", "Ada Quill", 25, "admin"],
  ["S_002", "Bram Hale", 21, "manager"],
  ["S_003", "Cleo Marsh", 18, "employee"],
  ["S_004", "Dara Vance", 17.5, "employee"],
  ["S_005", "Eli Stone", 17, "employee"],
  ["S_006", "Fay Ruiz", 22, "payroll_admin"],
];
const CONFIG: Record<string, string> = {
  cstore_default_opening_float: "250",
  vape_default_opening_float: "100",
  lotto_reserve_default: "500",
  variance_ok_threshold: "1",
  variance_minor_threshold: "30",
  cstore_card_split: "false",
  vape_card_split: "true",
  cstore_epos_from: EPOS_FROM,
  cash_manager_staff_id: "S_002",
};

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

async function setConfig(rows: Record<string, string>): Promise<void> {
  await owner.query("delete from ops.config");
  for (const [k, v] of Object.entries(rows)) await owner.query("insert into ops.config (key, value) values ($1, $2)", [k, v]);
}

async function reset(config: Record<string, string> = CONFIG) {
  for (const t of [
    "audit_log",
    "cash_handover_items",
    "cash_handovers",
    "payment_items",
    "payments",
    "bonuses",
    "commission_runs",
    "validation_results",
    "sales",
    "till_sessions",
    "attendance",
    "sessions",
    "staff",
  ]) {
    await owner.query(`delete from ops.${t}`);
  }
  for (const s of STAFF) await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized) values ($1,$2,$3,true,$4,'cstore,vape')", s);
  await setConfig(config);
}

beforeEach(() => reset());

const session = (staffId: string, role: Session["role"]): Session => ({ staffId, name: "x", role, companiesAuthorized: ["cstore", "vape"], expiresAt: 0 });
const ADMIN = session("S_001", "admin");

/** Every outbound request a handler attempts (there must be none). */
let fetched: unknown[] = [];
const fetchSpy = ((...a: unknown[]) => {
  fetched.push(a);
  return Promise.reject(new Error("no network in this test"));
}) as unknown as typeof fetch;
beforeEach(() => {
  fetched = [];
});

function ctxFor(tx: Tx, who: Session | null, now: Date): RpcContext {
  return { db: tx, session: who, config: () => loadConfig(tx), env: {}, fetch: fetchSpy, now };
}
async function rpc(handler: (ctx: RpcContext, ...a: unknown[]) => unknown, who: Session | null, args: unknown[], now = NOW, on: Db = db): Promise<any> {
  return withTransaction(on, async (tx) => handler(ctxFor(tx, who, now), ...args));
}
const fix = (input: Record<string, unknown>, now = NOW) => rpc(rpcCorrectTillSession, ADMIN, [input], now);
const view = (sessionId: unknown, now = NOW) => rpc(rpcGetTillCorrection, ADMIN, [sessionId], now);

const sessRow = (id: string) => db.one<any>("select * from ops.till_sessions where session_id = $1", [id]);
const salesRow = (id: string) => db.maybeOne<any>("select * from ops.sales where session_id = $1", [id]);
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details from ops.audit_log where action = 'till.correct' order by seq`);
const allAudits = () => db.query<any>(`select action from ops.audit_log order by seq`);

const deps = async (tx: Tx, now: Date) => ({ config: await loadConfig(tx), now });
const sid = (company: string, day: string, staffId: string) => `${company === "cstore" ? "CST" : "VAP"}-${day.replace(/-/g, "")}-${staffId}`;

/** The figures a close sheet takes (what the person enters). */
interface Figures {
  cash: number;
  credit?: number;
  debit?: number;
  card?: number;
  miscCash: number;
  miscCredit?: number;
  miscDebit?: number;
  miscCard?: number;
  miscNotes: string;
  count: number;
  lotto?: { counted: number; topup: number; note: string };
}

/** Open a till on `day` at 09:00 Toronto and close it at 17:00 through the real open and close. */
async function openClose(staffId: string, company: string, day: string, f: Figures): Promise<string> {
  const openAt = new Date(`${day}T13:00:00Z`);
  const closeAt = new Date(`${day}T21:00:00Z`);
  await withTransaction(db, async (tx) => ts.open(tx, { staffId, company, openingCount: company === "cstore" ? 250 : 100, actorId: staffId }, await deps(tx, openAt)));
  const id = sid(company, day, staffId);
  await withTransaction(db, async (tx) =>
    ts.close(
      tx,
      {
        sessionId: id,
        actorId: staffId,
        cashSales: f.cash,
        creditCard: f.credit,
        debitCard: f.debit,
        cardTotal: f.card,
        miscCash: f.miscCash,
        miscCredit: f.miscCredit,
        miscDebit: f.miscDebit,
        miscCard: f.miscCard,
        miscNotes: f.miscNotes,
        physicalCount: f.count,
        lottoCounted: f.lotto ? f.lotto.counted : null,
        lottoTopupFromTill: f.lotto ? f.lotto.topup : 0,
        lottoNote: f.lotto ? f.lotto.note : "",
      },
      await deps(tx, closeAt),
    ),
  );
  return id;
}

/** The correction input for figures `f`, as the sheet sends it. */
function correctionOf(id: string, f: Figures, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const split = f.card === undefined;
  return {
    sessionId: id,
    openingFloat: id.startsWith("CST") ? 250 : 100,
    closingCashCounted: f.count,
    cashSales: f.cash,
    ...(split ? { creditCardSales: f.credit, debitCardSales: f.debit, miscCreditSales: f.miscCredit, miscDebitSales: f.miscDebit } : { cardTotalSales: f.card, miscCardSales: f.miscCard }),
    miscCashSales: f.miscCash,
    miscNotes: f.miscNotes,
    ...(f.lotto ? { lottoReserveCounted: f.lotto.counted, lottoTopupFromTill: f.lotto.topup, lottoReserveNote: f.lotto.note } : {}),
    notes: null,
    reason: "Figures typed wrong at close",
    ...extra,
  };
}

/** A closed cstore session with a reserve count, written straight in: the close before the one under test. */
async function seedReserve(counted: number, date = "2026-08-01", id = "CST-20260801-S_005") {
  const att = `A_${date.replace(/-/g, "")}_S_005`;
  await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ($1, 'S_005', $2, 'worked') on conflict do nothing", [att, date]);
  await owner.query(
    `insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time, end_time, lotto_reserve_counted, lotto_topup_from_till)
     values ($1, $2, 'S_005', 'cstore', $3, 'closed', $4, $5, $6, 0)`,
    [id, att, date, `${date}T12:00:00Z`, `${date}T23:59:00Z`, counted],
  );
}

/** A closed session written straight in (an old or hand-made row), with or without a sales row. */
async function insertClosed(id: string, staffId: string, company: string, date: string, s: Record<string, unknown> = {}, sales: Record<string, unknown> | null = null) {
  const att = `A_${date.replace(/-/g, "")}_${staffId}`;
  await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ($1, $2, $3, 'worked') on conflict do nothing", [att, staffId, date]);
  const row: Record<string, unknown> = {
    session_id: id,
    attendance_id: att,
    staff_id: staffId,
    company,
    date,
    status: "closed",
    start_time: `${date}T13:00:00Z`,
    end_time: `${date}T21:00:00Z`,
    expected_opening: 100,
    opening_float: 100,
    closing_cash_counted: 400,
    cash_left_in_till: 100,
    cash_removed_at_close: 300,
    expected_cash: 400,
    closing_variance: 0,
    variance_status: "OK",
    ...s,
  };
  const keys = Object.keys(row);
  await owner.query(`insert into ops.till_sessions (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map((k) => row[k]));
  if (sales) {
    const r: Record<string, unknown> = { sales_id: id, session_id: id, staff_id: staffId, company, date, ...sales };
    const k2 = Object.keys(r);
    await owner.query(`insert into ops.sales (${k2.join(", ")}) values (${k2.map((_, i) => `$${i + 1}`).join(", ")})`, k2.map((k) => r[k]));
  }
}

/** Every stored column that does not record who or when (or the notes, which record the correction). */
function figuresOf(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  const { start_time: _a, end_time: _b, notes: _c, seq: _d, ...rest } = row;
  return rest;
}

const VAPE_F: Figures = { cash: 1150, credit: 300, debit: 200, miscCash: 0, miscCredit: 0, miscDebit: 0, miscNotes: "", count: 1520 };

// ── The promise: a correction stores what a close would have ──

describe("correct-equals-close: a corrected till stores exactly what a close with the same figures stores", () => {
  const WRONG = (f: Figures): Figures => ({
    ...f,
    cash: f.cash + 100,
    ...(f.card !== undefined ? { card: f.card * 10 } : { credit: (f.credit as number) + 9, debit: 0 }),
    miscCash: f.miscCash + 3,
    miscNotes: "typo",
    count: f.count + 270,
    ...(f.lotto ? { lotto: { counted: 500, topup: 0, note: "" } } : {}),
  });
  const cases: Array<{ name: string; company: string; staff: string; day: string; config?: Record<string, string>; f: Figures }> = [
    {
      name: "cstore, credit and debit (before ePOS), pot untouched",
      company: "cstore",
      staff: "S_003",
      day: OLD_DAY,
      f: { cash: 612.4, credit: 540.1, debit: 388.25, miscCash: 12, miscCredit: 4.5, miscDebit: 1.25, miscNotes: "Phone cards", count: 794.13, lotto: { counted: 500, topup: 0, note: "" } },
    },
    {
      name: "cstore, credit and debit, a payout from the pot and a refill",
      company: "cstore",
      staff: "S_003",
      day: OLD_DAY,
      f: { cash: -310.5, credit: 820, debit: 101.99, miscCash: 0, miscCredit: 0, miscDebit: 0, miscNotes: "", count: 129.5, lotto: { counted: 310, topup: 40, note: "Paid $230 winning ticket" } },
    },
    {
      name: "cstore, one card total (after ePOS), pot untouched",
      company: "cstore",
      staff: "S_003",
      day: DAY,
      f: { cash: 455.55, card: 1837.5, miscCash: 2, miscCard: 7.25, miscNotes: "", count: 707.55, lotto: { counted: 500, topup: 0, note: "" } },
    },
    {
      name: "cstore, one card total, pot short with no refill",
      company: "cstore",
      staff: "S_003",
      day: DAY,
      f: { cash: 120, card: 990.01, miscCash: 0, miscCard: 0, miscNotes: "", count: 430, lotto: { counted: 455, topup: 0, note: "Not enough cash to refill" } },
    },
    { name: "vape, credit and debit", company: "vape", staff: "S_004", day: DAY, f: { ...VAPE_F, count: 1250.07 } },
    {
      name: "vape, one card total (vape_card_split false)",
      company: "vape",
      staff: "S_004",
      day: DAY,
      config: { ...CONFIG, vape_card_split: "false" },
      f: { cash: 210.3, card: 444.4, miscCash: 5, miscCard: 1, miscNotes: "Coil sample", count: 310.3 },
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      // World A: the real close, with the right figures.
      await reset(c.config);
      await seedReserve(470);
      const a = await openClose(c.staff, c.company, c.day, c.f);
      const sessionA = figuresOf(await sessRow(a));
      const salesA = figuresOf(await salesRow(a));

      // World B: the real close with wrong figures, then the correction to the right ones.
      await reset(c.config);
      await seedReserve(470);
      const b = await openClose(c.staff, c.company, c.day, WRONG(c.f));
      expect(figuresOf(await sessRow(b))).not.toEqual(sessionA);
      const out = await fix(correctionOf(b, c.f));
      expect(out.changed.length).toBeGreaterThan(0);

      expect(b).toBe(a);
      expect(figuresOf(await sessRow(b))).toEqual(sessionA);
      expect(figuresOf(await salesRow(b))).toEqual(salesA);
    });
  }
});

// ── The worked example ─────────────────────────────────────

describe("the worked example: a cash count typed as 1,520.00 that was 1,250.00", () => {
  const deps0 = async () => ({ config: await loadConfig(db), now: NOW });
  const holding = async (staffId: string) => (await cashHandling.getOutstandingForStaff(db, staffId, NOW)).totalOutstanding;
  const dayTotal = async () => {
    const d = await salesDashboard.getDashboard(db, { startDate: DAY, endDate: DAY });
    return (d.daily.find((x: any) => x.dateStr === DAY) as any).total;
  };

  it("moves the variance, its status, cash removed and what the cashier holds; the sales screens follow a card fix", async () => {
    await seedReserve(500);
    const vape = await openClose("S_004", "vape", DAY, VAPE_F);
    // The cstore card total has a slipped digit: 1,873.50 for 1,837.50.
    const cstore = await openClose("S_003", "cstore", DAY, { cash: 600, card: 1873.5, miscCash: 0, miscCard: 0, miscNotes: "", count: 850, lotto: { counted: 500, topup: 0, note: "" } });

    expect(await sessRow(vape)).toMatchObject({ expected_cash: 1250, closing_variance: 270, variance_status: "investigate", cash_removed_at_close: 1420 });
    expect(await holding("S_004")).toBe(1420);
    expect(await dayTotal()).toBe(4123.5);
    const recon0 = (await publicReport.build(db, 14, await deps0())) as any;
    expect(recon0.cash.total).toBe(2020);
    const pubSales0 = (await publicReport.buildSales(db, 30, await deps0())) as any;
    expect(pubSales0.daily.find((d: any) => d.dateStr === DAY).total).toBe(4123.5);

    const v = await view(vape);
    const out = await fix({ ...correctionOf(vape, VAPE_F), closingCashCounted: 1250, notes: v.session.notes, reason: "Count typed as 1,520.00; it was 1,250.00" });
    expect(out).toMatchObject({ varianceBefore: 270, varianceAfter: 0, cashRemovedBefore: 1420, cashRemovedAfter: 1150, totalBefore: 1650, totalAfter: 1650 });
    expect(out.changed).toEqual([
      { field: "closingCashCounted", before: 1520, after: 1250 },
      { field: "closingVariance", before: 270, after: 0 },
      { field: "varianceStatus", before: "investigate", after: "OK" },
      { field: "cashRemovedAtClose", before: 1420, after: 1150 },
    ]);
    expect(await sessRow(vape)).toMatchObject({ closing_cash_counted: 1250, expected_cash: 1250, closing_variance: 0, variance_status: "OK", cash_removed_at_close: 1150, status: "closed" });
    // What the cashier holds moved by exactly the difference; nothing else moved with it.
    expect(await holding("S_004")).toBe(1420 - 270);
    const recon1 = (await publicReport.build(db, 14, await deps0())) as any;
    expect(recon1.cash.total).toBe(2020 - 270);
    expect(recon1.cash.holders.find((h: any) => h.name === "Dara Vance").total).toBe(1150);
    expect(await dayTotal()).toBe(4123.5);

    const c = await fix({ ...correctionOf(cstore, { cash: 600, card: 1837.5, miscCash: 0, miscCard: 0, miscNotes: "", count: 850, lotto: { counted: 500, topup: 0, note: "" } }), reason: "Card total had a slipped digit" });
    expect(c).toMatchObject({ totalBefore: 2473.5, totalAfter: 2437.5, varianceBefore: 0, varianceAfter: 0 });
    expect(c.changed).toEqual([
      { field: "cardTotalSales", before: 1873.5, after: 1837.5 },
      { field: "total", before: 2473.5, after: 2437.5 },
    ]);
    expect(await dayTotal()).toBe(4087.5);
    const pubSales1 = (await publicReport.buildSales(db, 30, await deps0())) as any;
    expect(pubSales1.daily.find((d: any) => d.dateStr === DAY).total).toBe(4087.5);
  });
});

// ── Who may call ───────────────────────────────────────────

describe("who may call: the real router with the merged contract", () => {
  const contract = parseRpcContract(
    mergeOpsContract(
      JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
      JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
    ),
  );
  const router = () =>
    createRpcRouter({ contract, handlers, openDb: () => connect(testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env: {}, now: () => NOW, log: () => undefined });
  async function call(name: string, args: unknown[]) {
    const res = await router()(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
    return (await res.json()) as { ok: boolean; result?: any; error?: { message: string } };
  }
  const tokenOf = async (staffId: string) => (await createSession(db, staffId, Config.fromRows([]), NOW)).token;
  let id: string;
  beforeEach(async () => {
    id = await openClose("S_004", "vape", DAY, VAPE_F);
  });
  const input = (extra: Record<string, unknown> = {}) => ({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250, ...extra });

  it("the contract lists both as admin only, needing a session", () => {
    expect(contract.get("rpcGetTillCorrection")).toMatchObject({ params: ["token", "sessionId"], roles: ["admin"], needs_session: true, migrate: true });
    expect(contract.get("rpcCorrectTillSession")).toMatchObject({ params: ["token", "input"], roles: ["admin"], needs_session: true, migrate: true });
  });

  it("both answer an admin", async () => {
    const t = await tokenOf("S_001");
    expect((await call("rpcGetTillCorrection", [t, id])).result).toMatchObject({ session: { sessionId: id, staffName: "Dara Vance" }, canCorrect: true });
    const out = await call("rpcCorrectTillSession", [t, input()]);
    expect(out.ok).toBe(true);
    expect(out.result).toMatchObject({ varianceBefore: 270, varianceAfter: 0 });
  });

  it("both refuse a manager, a payroll admin and an employee, and change nothing", async () => {
    for (const [sid2, role] of [["S_002", "manager"], ["S_006", "payroll_admin"], ["S_004", "employee"]]) {
      const t = await tokenOf(sid2 as string);
      expect((await call("rpcGetTillCorrection", [t, id])).error?.message).toBe(`FORBIDDEN: requires admin, got ${role}`);
      expect((await call("rpcCorrectTillSession", [t, input()])).error?.message).toBe(`FORBIDDEN: requires admin, got ${role}`);
    }
    expect((await sessRow(id)).closing_cash_counted).toBe(1520);
    expect(await audits()).toEqual([]);
  });

  it("both refuse a call with no token or an unknown one", async () => {
    for (const t of [undefined, "", "nope"]) {
      expect((await call("rpcGetTillCorrection", [t, id])).error?.message).toBe("NOT_LOGGED_IN");
      expect((await call("rpcCorrectTillSession", [t, input()])).error?.message).toBe("NOT_LOGGED_IN");
    }
    expect((await sessRow(id)).closing_cash_counted).toBe(1520);
  });

  it("a role or actorId planted in the input changes nothing: the audit row names the session's person", async () => {
    const manager = await tokenOf("S_002");
    expect((await call("rpcCorrectTillSession", [manager, input({ role: "admin", actorId: "S_001" })])).error?.message).toBe("FORBIDDEN: requires admin, got manager");
    const admin = await tokenOf("S_001");
    expect((await call("rpcCorrectTillSession", [admin, input({ role: "employee", actorId: "S_006", staffId: "S_003", status: "open", company: "cstore" })])).ok).toBe(true);
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0].actor_id).toBe("S_001");
    expect(await sessRow(id)).toMatchObject({ staff_id: "S_004", status: "closed", company: "vape" });
  });

  it("the handlers check the role themselves too (a defence if the contract file were wrong)", async () => {
    for (const who of [session("S_002", "manager"), session("S_006", "payroll_admin"), session("S_004", "employee")]) {
      await expect(rpc(rpcCorrectTillSession, who, [input()])).rejects.toThrow(`FORBIDDEN: requires admin, got ${who.role}`);
      await expect(rpc(rpcGetTillCorrection, who, [id])).rejects.toThrow(`FORBIDDEN: requires admin, got ${who.role}`);
    }
    await expect(rpc(rpcCorrectTillSession, null, [input()])).rejects.toThrow("NOT_LOGGED_IN");
    await expect(rpc(rpcGetTillCorrection, null, [id])).rejects.toThrow("NOT_LOGGED_IN");
    await expect(rpc(rpcCorrectTillSession, ADMIN, [null])).rejects.toThrow("input is required");
    await expect(rpc(rpcCorrectTillSession, ADMIN, [[1]])).rejects.toThrow("input is required");
  });
});

// ── The rules, in order ────────────────────────────────────

describe("the rules, in order", () => {
  it("1. the session exists and is closed or validated; an open till is refused", async () => {
    await expect(fix({ ...correctionOf("VAP-X", VAPE_F) })).rejects.toThrow("Session not found: VAP-X");
    await expect(fix({ ...correctionOf("", VAPE_F) })).rejects.toThrow("Session not found: ");
    const openAt = new Date(`${DAY}T13:00:00Z`);
    await withTransaction(db, async (tx) => ts.open(tx, { staffId: "S_004", company: "vape", openingCount: 100, actorId: "S_004" }, await deps(tx, openAt)));
    await expect(fix(correctionOf(sid("vape", DAY, "S_004"), VAPE_F))).rejects.toThrow("This till is still open: close it instead.");
    // A validated session can be corrected, and stays validated.
    await insertClosed("CST-20260910-S_003", "S_003", "cstore", "2026-09-10", { status: "validated", opening_float: 250, cash_left_in_till: 250, lotto_reserve_counted: 500, lotto_topup_from_till: 0 }, { cash_sales: 100, card_total_sales: 50, misc_card_sales: 0, misc_cash_sales: 0 });
    const out = await fix(correctionOf("CST-20260910-S_003", { cash: 100, card: 60, miscCash: 0, miscCard: 0, miscNotes: "", count: 350, lotto: { counted: 500, topup: 0, note: "" } }));
    expect(out.session.status).toBe("validated");
    expect((await sessRow("CST-20260910-S_003")).status).toBe("validated");
  });

  it("2. a reason of 3 to 300 characters after trimming, no control characters", async () => {
    const id = await openClose("S_004", "vape", DAY, VAPE_F);
    const at = (reason: unknown) => fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250, reason });
    for (const r of [undefined, null, "", "  ab  ", "x".repeat(301), 42]) await expect(at(r)).rejects.toThrow("A reason is required: 3 to 300 characters.");
    await expect(at("line\nbreak")).rejects.toThrow("The reason cannot contain control characters (such as a line break).");
    expect(await audits()).toEqual([]);
    expect((await at("  abc  ")).session.notes).toBe("Corrected: abc");
    expect((await at("y".repeat(300))).session.notes).toBe("Corrected: " + "y".repeat(300));
  });

  it("3. not more than 370 days ago", async () => {
    // NOW is 2026-09-20 in Toronto: 2025-09-15 is 370 days back, 2025-09-14 is 371.
    await insertClosed("VAP-20250915-S_004", "S_004", "vape", "2025-09-15", {}, { cash_sales: 300, credit_card_sales: 0, debit_card_sales: 0, misc_cash_sales: 0, misc_credit_sales: 0, misc_debit_sales: 0 });
    await insertClosed("VAP-20250914-S_004", "S_004", "vape", "2025-09-14", {}, { cash_sales: 300, credit_card_sales: 0, debit_card_sales: 0, misc_cash_sales: 0 });
    const f: Figures = { cash: 300, credit: 10, debit: 0, miscCash: 0, miscCredit: 0, miscDebit: 0, miscNotes: "", count: 400 };
    await expect(fix(correctionOf("VAP-20250914-S_004", f))).rejects.toThrow("Cannot correct a till from more than 370 days ago.");
    expect((await fix(correctionOf("VAP-20250915-S_004", f))).changed).toEqual([
      { field: "creditCardSales", before: 0, after: 10 },
      { field: "total", before: 300, after: 310 },
    ]);
  });

  describe("4. each figure is checked as the close checks it, and rounded to cents", () => {
    let id: string;
    beforeEach(async () => {
      id = await openClose("S_004", "vape", DAY, VAPE_F);
    });
    const at = (extra: Record<string, unknown>) => fix({ ...correctionOf(id, VAPE_F), ...extra });

    it("the cash counted: required, 0 or more (the close's message)", async () => {
      for (const v of [null, "", undefined, -1]) await expect(at({ closingCashCounted: v })).rejects.toThrow("physicalCount required (non-negative number)");
      expect((await at({ closingCashCounted: 0 })).session.closingCashCounted).toBe(0);
    });

    it("the opening float: required, 0 or more", async () => {
      for (const v of [null, "", -0.01]) await expect(at({ openingFloat: v })).rejects.toThrow("The opening float must be a number, 0 or more.");
      const out = await at({ openingFloat: 120, reason: "Float was 120" });
      // A float of 120 counted at the open: expected cash and the variance follow, cash removed does not (it is what is left over the float the drawer keeps).
      expect(out.session).toMatchObject({ openingFloat: 120, expectedCash: 1270, closingVariance: 250, cashRemovedAtClose: 1420 });
    });

    it("cash sales cannot be negative on vape (the close's message); on cstore a payout can make them negative", async () => {
      await expect(at({ cashSales: -5 })).rejects.toThrow("Cash sales cannot be negative on vape — there is no lotto reserve on this till to fund a payout.");
      await seedReserve(500);
      const c = await openClose("S_003", "cstore", DAY, { cash: 20, card: 100, miscCash: 0, miscCard: 0, miscNotes: "", count: 270, lotto: { counted: 500, topup: 0, note: "" } });
      const out = await fix(correctionOf(c, { cash: -80, card: 100, miscCash: 0, miscCard: 0, miscNotes: "", count: 270, lotto: { counted: 400, topup: 0, note: "Paid $200 ticket" } }));
      // The pot fed the drawer 100: expected 250 - 80 + 100.
      expect(out.session).toMatchObject({ expectedCash: 270, closingVariance: 0, lottoReserveCounted: 400 });
    });

    it("expected cash below zero is refused (the close's message)", async () => {
      await seedReserve(500);
      const c = await openClose("S_003", "cstore", DAY, { cash: 20, card: 100, miscCash: 0, miscCard: 0, miscNotes: "", count: 270, lotto: { counted: 500, topup: 0, note: "" } });
      await expect(fix(correctionOf(c, { cash: -400, card: 100, miscCash: 0, miscCard: 0, miscNotes: "", count: 0, lotto: { counted: 500, topup: 0, note: "" } }))).rejects.toThrow(
        /^Expected cash works out to \$-150\.00, which no drawer can hold/,
      );
    });

    it("a reserve count away from the expected balance needs its reason (the close's message); a vape till has no reserve", async () => {
      await seedReserve(500);
      const c = await openClose("S_003", "cstore", DAY, { cash: 20, card: 100, miscCash: 0, miscCard: 0, miscNotes: "", count: 270, lotto: { counted: 500, topup: 0, note: "" } });
      await expect(fix(correctionOf(c, { cash: 20, card: 100, miscCash: 0, miscCard: 0, miscNotes: "", count: 270, lotto: { counted: 450, topup: 0, note: "" } }))).rejects.toThrow(
        "Lotto reserve counted 450, expected 500. Please provide a reason.",
      );
      await expect(at({ lottoReserveCounted: 500 })).rejects.toThrow("A vape till has no lotto reserve.");
    });

    it("a figure that is not a number, or too large to store, is refused; cents are rounded", async () => {
      await expect(at({ cashSales: "1150" })).rejects.toThrow("Cash sales must be a number, or blank.");
      await expect(at({ creditCardSales: Number.NaN })).rejects.toThrow("Credit card sales must be a number, or blank.");
      await expect(at({ debitCardSales: 1e10 })).rejects.toThrow("Debit card sales is too large.");
      await expect(at({ miscNotes: 5 })).rejects.toThrow("Misc notes must be text.");
      const out = await at({ creditCardSales: 300.004, closingCashCounted: 1250.001 });
      expect(out.sales.creditCardSales).toBe(300);
      expect(out.session.closingCashCounted).toBe(1250);
      expect(out.session.closingVariance).toBe(0);
    });

    it("a blank figure is stored NULL, never 0, and sums as 0 (every figure a close may leave blank)", async () => {
      await seedReserve(500);
      const c = await openClose("S_003", "cstore", DAY, { cash: 20, card: 100, miscCash: 1, miscCard: 2, miscNotes: "x", count: 270, lotto: { counted: 500, topup: 0, note: "" } });
      const out = await fix({ ...correctionOf(c, { cash: 0, card: 0, miscCash: 0, miscCard: 0, miscNotes: "", count: 250 }), cashSales: null, cardTotalSales: null, miscCashSales: "", miscCardSales: null, miscNotes: "", lottoReserveCounted: null, lottoTopupFromTill: null, lottoReserveNote: "" });
      expect(await salesRow(c)).toMatchObject({ cash_sales: null, card_total_sales: null, misc_cash_sales: null, misc_card_sales: null, misc_notes: null, credit_card_sales: null, debit_card_sales: null });
      // Not counted: no count, nothing fed from the pot; expected cash is the float alone.
      expect(await sessRow(c)).toMatchObject({ lotto_reserve_counted: null, lotto_topup_from_till: null, lotto_reserve_note: null, expected_cash: 250, closing_variance: 0 });
      expect(out.sales.total).toBe(0);

      const v = id;
      await fix({ ...correctionOf(v, VAPE_F), creditCardSales: null, debitCardSales: null, miscCreditSales: null, miscDebitSales: null, miscCashSales: null, closingCashCounted: 1250 });
      expect(await salesRow(v)).toMatchObject({ credit_card_sales: null, debit_card_sales: null, misc_credit_sales: null, misc_debit_sales: null, misc_cash_sales: null, cash_sales: 1150, card_total_sales: null, misc_card_sales: null });
      expect((await view(v)).cardShape).toBe("split");
    });
  });

  describe("5. one card shape; a row changes shape only to its till's shape that day", () => {
    it("both shapes, or neither, is refused", async () => {
      const id = await openClose("S_004", "vape", DAY, VAPE_F);
      await expect(fix({ ...correctionOf(id, VAPE_F), cardTotalSales: 650 })).rejects.toThrow("Send one card shape.");
      await expect(fix({ ...correctionOf(id, VAPE_F), miscCardSales: 0 })).rejects.toThrow("Send one card shape.");
      const { creditCardSales: _a, debitCardSales: _b, miscCreditSales: _c, miscDebitSales: _d, ...neither } = correctionOf(id, VAPE_F);
      await expect(fix(neither)).rejects.toThrow("Send one card shape.");
      expect(await audits()).toEqual([]);
    });

    it("cstore around cstore_epos_from: before it the till reports credit and debit, from it one card total", async () => {
      // Before ePOS, a split row: changing it to one total is refused.
      await seedReserve(500);
      const before = await openClose("S_003", "cstore", OLD_DAY, { cash: 50, credit: 60, debit: 40, miscCash: 0, miscCredit: 0, miscDebit: 0, miscNotes: "", count: 300, lotto: { counted: 500, topup: 0, note: "" } });
      const single = { cash: 50, card: 100, miscCash: 0, miscCard: 0, miscNotes: "", count: 300, lotto: { counted: 500, topup: 0, note: "" } };
      await expect(fix(correctionOf(before, single))).rejects.toThrow("On 2026-08-20 the cstore till reports credit and debit: send credit and debit.");
      // On the ePOS day itself a row recorded split (the setting lagged) may become one total; the split columns go NULL.
      const on = await openClose("S_003", "cstore", EPOS_FROM, { cash: 50, credit: 60, debit: 40, miscCash: 0, miscCredit: 1, miscDebit: 0, miscNotes: "", count: 300, lotto: { counted: 500, topup: 0, note: "" } });
      const out = await fix(correctionOf(on, { ...single, miscCard: 1 }));
      expect(out.sales.total).toBe(151);
      expect(await salesRow(on)).toMatchObject({ credit_card_sales: null, debit_card_sales: null, misc_credit_sales: null, misc_debit_sales: null, card_total_sales: 100, misc_card_sales: 1 });
      // ...and a single row on that day cannot go back to split.
      await expect(fix(correctionOf(on, { cash: 50, credit: 60, debit: 40, miscCash: 0, miscCredit: 0, miscDebit: 0, miscNotes: "", count: 300, lotto: { counted: 500, topup: 0, note: "" } }))).rejects.toThrow(
        "On 2026-09-01 the cstore till reports one card total: send one card total.",
      );
      // A row keeps its own shape even where it is not the day's shape (here a single row before ePOS, hand-made).
      await insertClosed("CST-20260815-S_005", "S_005", "cstore", "2026-08-15", { opening_float: 250, cash_left_in_till: 250, lotto_reserve_counted: 500, lotto_topup_from_till: 0 }, { cash_sales: 10, card_total_sales: 20, misc_card_sales: 0 });
      expect((await view("CST-20260815-S_005")).cardShape).toBe("single");
      expect((await fix(correctionOf("CST-20260815-S_005", { cash: 10, card: 25, miscCash: 0, miscCard: 0, miscNotes: "", count: 260, lotto: { counted: 500, topup: 0, note: "" } }))).sales.cardTotalSales).toBe(25);
    });

    it("vape on both sides of that date: its own setting decides, not cstore_epos_from", async () => {
      const early = await openClose("S_004", "vape", OLD_DAY, VAPE_F);
      const late = await openClose("S_004", "vape", DAY, VAPE_F);
      const single: Figures = { cash: 1150, card: 500, miscCash: 0, miscCard: 0, miscNotes: "", count: 1250 };
      await expect(fix(correctionOf(early, single))).rejects.toThrow("On 2026-08-20 the vape till reports credit and debit: send credit and debit.");
      await expect(fix(correctionOf(late, single))).rejects.toThrow("On 2026-09-12 the vape till reports credit and debit: send credit and debit.");
      await setConfig({ ...CONFIG, vape_card_split: "false" });
      expect((await fix(correctionOf(early, single))).sales).toMatchObject({ cardTotalSales: 500, creditCardSales: null, debitCardSales: null });
      expect((await fix(correctionOf(late, single))).sales).toMatchObject({ cardTotalSales: 500, creditCardSales: null });
    });
  });

  it("6. who and when never change; status stays; the float left is the one that close left", async () => {
    const id = await openClose("S_004", "vape", DAY, VAPE_F);
    const before = await sessRow(id);
    // The configured float has changed since that day: the correction keeps the float that close left.
    await setConfig({ ...CONFIG, vape_default_opening_float: "150" });
    await fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250 });
    const after = await sessRow(id);
    for (const k of ["attendance_id", "staff_id", "company", "date", "status", "start_time", "end_time", "expected_opening", "opening_note", "cash_left_in_till", "store_id"]) expect(after[k]).toEqual(before[k]);
    expect(after.cash_removed_at_close).toBe(1150);
  });

  describe("7. cash already handed over", () => {
    const handOver = (amount: number, now = NOW) => withTransaction(db, async (tx) => cashHandling.record(tx, await loadConfig(tx), { fromStaffId: "S_004", amount, actorId: "S_002", notes: "part" }, now));
    it("refused while the corrected cash removed would be less than what was handed over; allowed once the handover is voided", async () => {
      const id = await openClose("S_004", "vape", DAY, VAPE_F);
      const h = await handOver(1420);
      await expect(fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250 })).rejects.toThrow("Cannot correct: $1420.00 from this till has already been handed over. Void the handover first.");
      expect((await sessRow(id)).closing_cash_counted).toBe(1520);
      expect((await view(id)).handedOver).toBe(1420);
      await withTransaction(db, (tx) => cashHandling.voidHandover(tx, h.handoverId, "S_001", NOW));
      expect((await view(id)).handedOver).toBe(0);
      expect((await fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250 })).cashRemovedAfter).toBe(1150);
    });
    it("a part handed over that the corrected cash still covers is allowed; raising the count is always allowed", async () => {
      const id = await openClose("S_004", "vape", DAY, VAPE_F);
      await handOver(1000);
      expect((await fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250 })).cashRemovedAfter).toBe(1150);
      await expect(fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1099.99, notes: "x" })).rejects.toThrow("Cannot correct: $1000.00 from this till has already been handed over.");
      expect((await fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1600, notes: "y" })).cashRemovedAfter).toBe(1500);
      expect((await cashHandling.getOutstandingForStaff(db, "S_004", NOW)).totalOutstanding).toBe(500);
    });
  });

  it("8. a session with no sales row: the correction writes the row a close would have written", async () => {
    await insertClosed("VAP-20260905-S_004", "S_004", "vape", "2026-09-05", { opening_float: 100, closing_cash_counted: 400, cash_left_in_till: 100, cash_removed_at_close: 300, expected_cash: 100, closing_variance: 300, variance_status: "investigate" });
    expect(await salesRow("VAP-20260905-S_004")).toBeNull();
    const v = await view("VAP-20260905-S_004");
    expect(v).toMatchObject({ sales: null, cardShape: "split" });
    const out = await fix(correctionOf("VAP-20260905-S_004", { cash: 300, credit: 80, debit: 20, miscCash: 0, miscCredit: 0, miscDebit: 0, miscNotes: "", count: 400 }));
    expect(out).toMatchObject({ totalBefore: null, totalAfter: 400, varianceBefore: 300, varianceAfter: 0 });
    expect(await salesRow("VAP-20260905-S_004")).toMatchObject({
      sales_id: "VAP-20260905-S_004",
      staff_id: "S_004",
      company: "vape",
      date: "2026-09-05",
      cash_sales: 300,
      credit_card_sales: 80,
      debit_card_sales: 20,
      cashback_paid: 0,
      hst_collected: 0,
      bottle_deposit: 0,
      round_off: 0,
      misc_cash_sales: 0,
      misc_credit_sales: 0,
      misc_debit_sales: 0,
      misc_notes: null,
      card_total_sales: null,
      misc_card_sales: null,
    });
    const a = await audits();
    expect(JSON.parse(a[0].before).sales).toBeNull();
    expect(JSON.parse(a[0].after).sales.sales_id).toBe("VAP-20260905-S_004");
  });

  it("9. one audit row: the whole session and sales row before and after, the reason in details, instants as ISO strings", async () => {
    const id = await openClose("S_004", "vape", DAY, VAPE_F);
    const sBefore = await sessRow(id);
    const rBefore = await salesRow(id);
    const n = (await allAudits()).length;
    await fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250, reason: "Count typed wrong" });
    expect((await allAudits()).length).toBe(n + 1);
    const [a] = await audits();
    expect(a).toMatchObject({ actor_id: "S_001", action: "till.correct", target_type: "till_sessions", target_id: id, details: "Count typed wrong" });
    const before = JSON.parse(a.before);
    const after = JSON.parse(a.after);
    expect(before.session).toEqual({ ...sBefore, start_time: sBefore.start_time.toISOString(), end_time: sBefore.end_time.toISOString() });
    expect(before.sales).toEqual(rBefore);
    const sAfter = await sessRow(id);
    expect(after.session).toEqual({ ...sAfter, start_time: sAfter.start_time.toISOString(), end_time: sAfter.end_time.toISOString() });
    expect(after.sales).toEqual(await salesRow(id));
    expect(Object.keys(after.session)).toContain("lotto_reserve_counted");
  });

  it("10. the reason is appended to the notes; the notes are capped, keeping the newest text", async () => {
    const id = await openClose("S_004", "vape", DAY, VAPE_F);
    await fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250, notes: "Busy night", reason: "Count typed wrong" });
    expect((await sessRow(id)).notes).toBe("Busy night | Corrected: Count typed wrong");
    const long = "n".repeat(1990);
    await fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1251, notes: long, reason: "One more dollar found" });
    const notes = (await sessRow(id)).notes as string;
    expect(notes.length).toBe(2000);
    expect(notes.startsWith("…")).toBe(true);
    expect(notes.endsWith(" | Corrected: One more dollar found")).toBe(true);
  });

  it("11. nothing else moves: no other table changes, the sales row keeps its id and seq, no message is attempted", async () => {
    const id = await openClose("S_004", "vape", DAY, VAPE_F);
    await withTransaction(db, async (tx) => cashHandling.record(tx, await loadConfig(tx), { fromStaffId: "S_004", amount: 300, actorId: "S_002", notes: "part" }, NOW));
    await owner.query("insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method) values ('P_9','S_004','2026-09-13',10,'cash')");
    await owner.query("insert into ops.payment_items (item_id, payment_id, item_type, ref_id, amount) values ('I_9','P_9','shift','A_20260912_S_004',10)");
    await owner.query("insert into ops.commission_runs (run_id, week_start, week_end, staff_count, bonuses_created, total_commission_amount) values ('CR_1', '2026-09-07', '2026-09-13', 1, 1, 12)");
    await owner.query("insert into ops.bonuses (bonus_id, staff_id, date, type, amount, reason, status, source_run_id) values ('B_1', 'S_004', '2026-09-13', 'commission', 12, 'vape', 'proposed', 'CR_1')");
    await owner.query("insert into ops.validation_results (validation_id, business_date, companies, session_ids, status, mode) values ('VR_1', $1, 'vape', $2, 'OK', 'auto')", [DAY, id]);
    const snap = async () => {
      const out: Record<string, unknown> = {};
      for (const t of ["attendance", "payments", "payment_items", "bonuses", "cash_handovers", "cash_handover_items", "commission_runs", "validation_results"]) out[t] = await db.query(`select * from ops.${t} order by 1`);
      return JSON.stringify(out);
    };
    const notices = (await allAudits()).filter((x) => x.action.startsWith("notify")).length;
    const before = await snap();
    const seqBefore = (await salesRow(id)).seq;
    const sessions = await db.one<{ n: number }>("select count(*)::int as n from ops.till_sessions");
    await fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250, creditCardSales: 310, reason: "Both typed wrong" });
    expect(await snap()).toBe(before);
    expect(await salesRow(id)).toMatchObject({ sales_id: id, seq: seqBefore, credit_card_sales: 310 });
    expect(await db.one<{ n: number }>("select count(*)::int as n from ops.sales")).toEqual({ n: 1 });
    expect(await db.one<{ n: number }>("select count(*)::int as n from ops.till_sessions")).toEqual(sessions);
    expect(fetched).toEqual([]);
    expect((await allAudits()).filter((x) => x.action.startsWith("notify")).length).toBe(notices);
  });

  it("12. a correction that changes nothing writes nothing and answers changed: []", async () => {
    const id = await openClose("S_004", "vape", DAY, VAPE_F);
    const s = await sessRow(id);
    const r = await salesRow(id);
    const out = await fix(correctionOf(id, VAPE_F));
    expect(out).toMatchObject({ changed: [], varianceBefore: 270, varianceAfter: 270, totalBefore: 1650, totalAfter: 1650, staleReconcile: false, commissionRunsTouched: [] });
    expect(await sessRow(id)).toEqual(s);
    expect(await salesRow(id)).toEqual(r);
    expect(await audits()).toEqual([]);
  });
});

// ── What goes stale ────────────────────────────────────────

describe("staleReconcile and commissionRunsTouched", () => {
  it("false and empty when the day has no reconcile result and no run", async () => {
    const id = await openClose("S_004", "vape", DAY, VAPE_F);
    const out = await fix({ ...correctionOf(id, VAPE_F), creditCardSales: 310 });
    expect(out).toMatchObject({ staleReconcile: false, commissionRunsTouched: [], nextLottoSession: null });
    expect(await view(id)).toMatchObject({ reconciled: false, commissionRunsTouched: [] });
  });

  it("true and listed when a reconcile result and a run cover the day; a run is listed only when the sales figures changed", async () => {
    const id = await openClose("S_004", "vape", DAY, VAPE_F);
    await owner.query("insert into ops.validation_results (validation_id, business_date, companies, session_ids, status, mode) values ('VR_1', $1, 'vape', $2, 'OK', 'auto')", [DAY, id]);
    await owner.query("insert into ops.commission_runs (run_id, week_start, week_end, staff_count, bonuses_created, total_commission_amount) values ('CR_1', '2026-09-07', '2026-09-13', 1, 1, 12)");
    await owner.query("insert into ops.commission_runs (run_id, week_start, week_end) values ('CR_0', '2026-08-31', '2026-09-06')");
    await owner.query("insert into ops.bonuses (bonus_id, staff_id, date, type, amount, reason, status, source_run_id) values ('B_1', 'S_004', '2026-09-13', 'commission', 12, 'vape', 'pending', 'CR_1')");
    expect(await view(id)).toMatchObject({ reconciled: true, commissionRunsTouched: [{ runId: "CR_1", weekEnd: "2026-09-13", status: "approved" }] });
    const count = await fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250 });
    expect(count).toMatchObject({ staleReconcile: true, commissionRunsTouched: [] });
    const card = await fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250, creditCardSales: 310 });
    expect(card).toMatchObject({ staleReconcile: true, commissionRunsTouched: [{ runId: "CR_1", weekEnd: "2026-09-13", status: "approved" }] });
    // A reconcile result of another till that day does not make this one stale.
    await owner.query("update ops.validation_results set session_ids = 'CST-20260912-S_003', companies = 'cstore'");
    expect((await fix({ ...correctionOf(id, VAPE_F), closingCashCounted: 1240, creditCardSales: 310 })).staleReconcile).toBe(false);
  });

  it("a changed reserve count names the next cstore close, whose expected cash was measured against it", async () => {
    await seedReserve(500);
    const first = await openClose("S_003", "cstore", "2026-09-10", { cash: 100, card: 10, miscCash: 0, miscCard: 0, miscNotes: "", count: 350, lotto: { counted: 500, topup: 0, note: "" } });
    await openClose("S_005", "cstore", DAY, { cash: 100, card: 10, miscCash: 0, miscCard: 0, miscNotes: "", count: 350, lotto: { counted: 500, topup: 0, note: "" } });
    const out = await fix(correctionOf(first, { cash: 100, card: 10, miscCash: 0, miscCard: 0, miscNotes: "", count: 350, lotto: { counted: 480, topup: 0, note: "Sold $20 of tickets from the pot" } }));
    expect(out.nextLottoSession).toEqual({ sessionId: sid("cstore", DAY, "S_005"), date: DAY });
    // The pot fed the drawer 20 on the corrected day (500 before, 480 after).
    expect(out.session).toMatchObject({ expectedCash: 370, closingVariance: -20, varianceStatus: "minor" });
    expect((await view(sid("cstore", DAY, "S_005"))).lotto).toEqual({ expected: 500, previousCount: 480 });
  });
});

// ── The reader ─────────────────────────────────────────────

describe("rpcGetTillCorrection", () => {
  it("answers every field: the session with blanks as null, the sales row and its total, the shape, what was handed over", async () => {
    await seedReserve(470);
    const id = await openClose("S_003", "cstore", DAY, { cash: 600, card: 1873.5, miscCash: 0, miscCard: 0, miscNotes: "", count: 850, lotto: { counted: 500, topup: 0, note: "" } });
    const v = await view(id);
    expect(v).toEqual({
      session: {
        sessionId: id,
        company: "cstore",
        staffId: "S_003",
        staffName: "Cleo Marsh",
        date: DAY,
        startTime: `${DAY}T13:00:00.000Z`,
        endTime: `${DAY}T21:00:00.000Z`,
        status: "closed",
        openingFloat: 250,
        closingCashCounted: 850,
        expectedCash: 820,
        closingVariance: 30,
        varianceStatus: "minor",
        cashRemovedAtClose: 600,
        cashLeftInTill: 250,
        lottoReserveCounted: 500,
        lottoTopupFromTill: 0,
        lottoReserveNote: null,
        notes: null,
      },
      sales: {
        salesId: id,
        cashSales: 600,
        creditCardSales: null,
        debitCardSales: null,
        cardTotalSales: 1873.5,
        cashbackPaid: 0,
        hstCollected: 0,
        bottleDeposit: 0,
        roundOff: 0,
        miscCashSales: 0,
        miscCreditSales: null,
        miscDebitSales: null,
        miscCardSales: 0,
        miscNotes: null,
        total: 2473.5,
      },
      cardShape: "single",
      dateShape: "single",
      handedOver: 0,
      reconciled: false,
      commissionRunsTouched: [],
      lotto: { expected: 500, previousCount: 470 },
      canCorrect: true,
      blockedBy: null,
    });
    // A vape session has no lotto fields.
    const vape = await view(await openClose("S_004", "vape", DAY, VAPE_F));
    expect(vape.session).not.toHaveProperty("lottoReserveCounted");
    expect(vape.lotto).toBeNull();
    expect(vape.cardShape).toBe("split");
  });

  it("canCorrect false with the reason: an open till, a till too old; an unknown session is refused", async () => {
    await withTransaction(db, async (tx) => ts.open(tx, { staffId: "S_004", company: "vape", openingCount: 100, actorId: "S_004" }, await deps(tx, new Date(`${DAY}T13:00:00Z`))));
    expect(await view(sid("vape", DAY, "S_004"))).toMatchObject({ canCorrect: false, blockedBy: "This till is still open: close it instead.", sales: null });
    await insertClosed("VAP-20250914-S_004", "S_004", "vape", "2025-09-14");
    expect(await view("VAP-20250914-S_004")).toMatchObject({ canCorrect: false, blockedBy: "Cannot correct a till from more than 370 days ago." });
    await expect(view("VAP-NOPE")).rejects.toThrow("Session not found: VAP-NOPE");
    await expect(view(null)).rejects.toThrow("Session not found: null");
  });

  it("handedOver counts this session's items only, and not a voided handover", async () => {
    const a = await openClose("S_004", "vape", OLD_DAY, { ...VAPE_F, count: 300 }); // 200 removed
    const b = await openClose("S_004", "vape", DAY, VAPE_F); // 1420 removed
    const rec = (amount: number) => withTransaction(db, async (tx) => cashHandling.record(tx, await loadConfig(tx), { fromStaffId: "S_004", amount, actorId: "S_002", notes: "part" }, NOW));
    const h1 = await rec(500); // 200 from a, 300 from b
    await rec(100); // 100 from b
    expect((await view(a)).handedOver).toBe(200);
    expect((await view(b)).handedOver).toBe(400);
    await withTransaction(db, (tx) => cashHandling.voidHandover(tx, h1.handoverId, "S_001", NOW));
    expect((await view(a)).handedOver).toBe(0);
    // An item keeps the session it settled: the second handover's 100 stays against b.
    expect((await view(b)).handedOver).toBe(100);
  });
});

// ── At the same moment ─────────────────────────────────────

describe("at the same moment", () => {
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
  const correctOn = (input: Record<string, unknown>, now: Date) => async (tx: any) => corrections.correct(tx, input as any, "S_001", await loadConfig(tx), now);
  const handOn = (amount: number, now: Date) => async (tx: any) => cashHandling.record(tx, await loadConfig(tx), { fromStaffId: "S_004", amount, actorId: "S_002", notes: "part" }, now);
  const T2 = new Date(NOW.getTime() + 1000);

  it("two corrections of one session: both complete, the second sees the first's result, two audit rows that chain", async () => {
    const id = await openClose("S_004", "vape", DAY, VAPE_F);
    const [one, two] = await overlap(
      correctOn({ ...correctionOf(id, VAPE_F), closingCashCounted: 1300, reason: "First recount" }, NOW),
      correctOn({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250, creditCardSales: 310, reason: "Second recount" }, T2),
    );
    expect(one.status).toBe("fulfilled");
    expect(two.status).toBe("fulfilled");
    expect((two as PromiseFulfilledResult<any>).value).toMatchObject({ varianceBefore: 50, cashRemovedBefore: 1200, varianceAfter: 0, cashRemovedAfter: 1150 });
    expect(await sessRow(id)).toMatchObject({ closing_cash_counted: 1250, closing_variance: 0 });
    const a = await audits();
    expect(a).toHaveLength(2);
    expect(JSON.parse(a[1].before).session).toEqual(JSON.parse(a[0].after).session);
  });

  it("a handover first, a correction meanwhile: the correction waits, then is refused for the cash handed over", async () => {
    const id = await openClose("S_004", "vape", DAY, VAPE_F);
    const [h, c] = await overlap(handOn(1420, NOW), correctOn({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250 }, T2));
    expect(h.status).toBe("fulfilled");
    expect(c.status).toBe("rejected");
    expect(String((c as PromiseRejectedResult).reason.message)).toBe("Cannot correct: $1420.00 from this till has already been handed over. Void the handover first.");
    expect((await sessRow(id)).closing_cash_counted).toBe(1520);
  });

  it("a correction first, a handover meanwhile: the handover waits, then sees the corrected cash", async () => {
    const id = await openClose("S_004", "vape", DAY, VAPE_F);
    const [c, h] = await overlap(correctOn({ ...correctionOf(id, VAPE_F), closingCashCounted: 1250 }, NOW), handOn(1420, T2));
    expect(c.status).toBe("fulfilled");
    expect(h.status).toBe("rejected");
    expect(String((h as PromiseRejectedResult).reason.message)).toBe("Dara Vance is holding $1150.00, so $1420.00 cannot be handed over.");
    const [c2, h2] = await overlap(correctOn({ ...correctionOf(id, VAPE_F), closingCashCounted: 1260, reason: "Found $10" }, NOW), handOn(1160, T2));
    expect(c2.status).toBe("fulfilled");
    expect(h2.status).toBe("fulfilled");
    expect((await cashHandling.getOutstandingForStaff(db, "S_004", NOW)).totalOutstanding).toBe(0);
  });
});
