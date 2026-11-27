// Missed shifts (card P4-12b): an admin enters a shift that was worked but never opened or closed in
// the app. A NEW ability of the Operations app (ADR-0023): nothing in the Apps Script app to compare
// with, so these tests are its specification. Against a real database, with invented people and
// figures.
//
// First the promise the card makes (an entered shift stores what the real open and close would
// have), then what reads it downstream, who may call, each rule in order, the lotto chain, the
// preview, the audit row, what is never touched, and the races.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/sessions";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction, type Tx } from "../src/db/tx";
import { Config, loadConfig } from "../src/lib/config";
import * as cashHandling from "../src/modules/cash-handling";
import * as missed from "../src/modules/missed-shifts";
import * as payments from "../src/modules/payments";
import * as publicReport from "../src/modules/public-report";
import * as salesDashboard from "../src/modules/sales-dashboard";
import * as ts from "../src/modules/till-sessions";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { rpcEnterMissedShift, rpcPreviewMissedShift } from "../src/rpc/handlers/missed-shifts";
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
const REASON = "Worked it; the tablet was down";

const STAFF: Array<[string, string, number | null, string, string, boolean]> = [
  ["S_001", "Ada Quill", 25, "admin", "cstore,vape", true],
  ["S_002", "Bram Hale", 21, "manager", "cstore,vape", true],
  ["S_003", "Cleo Marsh", 18, "employee", "cstore,vape", true],
  ["S_004", "Dara Vance", 17.5, "employee", "cstore,vape", true],
  ["S_005", "Eli Stone", 17, "employee", "cstore,vape", true],
  ["S_006", "Fay Ruiz", 22, "payroll_admin", "cstore,vape", true],
  ["S_007", "Gus Orr", null, "employee", "vape", true],
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
const ALL_TABLES = [
  "audit_log",
  "attendance",
  "till_sessions",
  "sales",
  "payments",
  "payment_items",
  "bonuses",
  "cash_handovers",
  "cash_handover_items",
  "commission_runs",
  "validation_results",
  "staff",
  "sessions",
  "config",
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

async function setConfig(rows: Record<string, string>): Promise<void> {
  await owner.query("delete from ops.config");
  for (const [k, v] of Object.entries(rows)) await owner.query("insert into ops.config (key, value) values ($1, $2)", [k, v]);
}

async function reset(config: Record<string, string> = CONFIG) {
  for (const t of ["audit_log", "cash_handover_items", "cash_handovers", "payment_items", "payments", "bonuses", "commission_runs", "validation_results", "sales", "till_sessions", "attendance", "sessions", "staff"]) {
    await owner.query(`delete from ops.${t}`);
  }
  for (const s of STAFF) await owner.query("insert into ops.staff (staff_id, name, hourly_rate, role, companies_authorized, active) values ($1,$2,$3,$4,$5,$6)", s);
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
const enter = (input: Record<string, unknown>, now = NOW) => rpc(rpcEnterMissedShift, ADMIN, [input], now);
const preview = (input: Record<string, unknown>, now = NOW) => rpc(rpcPreviewMissedShift, ADMIN, [input], now);

const sessRow = (id: string) => db.maybeOne<any>("select * from ops.till_sessions where session_id = $1", [id]);
const salesRow = (id: string) => db.maybeOne<any>("select * from ops.sales where session_id = $1", [id]);
const attRow = (id: string) => db.maybeOne<any>("select * from ops.attendance where attendance_id = $1", [id]);
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details from ops.audit_log where action = 'till.enter_missed' order by seq`);
const allAudits = () => db.query<any>(`select action from ops.audit_log order by seq`);
const snapshot = async (tables = ALL_TABLES) => {
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = await db.query(`select * from ops.${t} order by 1`);
  return JSON.stringify(out);
};

const deps = async (tx: Tx, now: Date) => ({ config: await loadConfig(tx), now });
const sid = (company: string, day: string, staffId: string) => `${company === "cstore" ? "CST" : "VAP"}-${day.replace(/-/g, "")}-${staffId}`;
const aid = (day: string, staffId: string) => `A_${day.replace(/-/g, "")}_${staffId}`;
/** An instant on Toronto's clock in summer time (EDT, -04:00). */
const at = (day: string, hhmm: string, off = "-04:00") => `${day}T${hhmm}:00${off}`;

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

/** Open a till through the real open at `openAt` (default 09:00 Toronto) and close it at `closeAt` (17:00). */
async function openClose(staffId: string, company: string, day: string, f: Figures, openAt = new Date(`${day}T13:00:00Z`), closeAt = new Date(`${day}T21:00:00Z`)): Promise<string> {
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

/** The entry input for figures `f`, as the sheet sends it. */
function entryOf(staffId: string, company: string, day: string, f: Figures, start = at(day, "09:00"), end = at(day, "17:00"), extra: Record<string, unknown> = {}): Record<string, unknown> {
  const split = f.card === undefined;
  return {
    staffId,
    company,
    date: day,
    startTime: start,
    endTime: end,
    openingFloat: company === "cstore" ? 250 : 100,
    closingCashCounted: f.count,
    cashSales: f.cash,
    ...(split ? { creditCardSales: f.credit, debitCardSales: f.debit, miscCreditSales: f.miscCredit, miscDebitSales: f.miscDebit } : { cardTotalSales: f.card, miscCardSales: f.miscCard }),
    miscCashSales: f.miscCash,
    miscNotes: f.miscNotes,
    ...(f.lotto ? { lottoReserveCounted: f.lotto.counted, lottoTopupFromTill: f.lotto.topup, lottoReserveNote: f.lotto.note } : {}),
    notes: null,
    reason: REASON,
    ...extra,
  };
}

/** A closed cstore session with a reserve count, written straight in: the close before the ones under test. */
async function seedReserve(counted: number, date = "2026-08-01", id = "CST-20260801-S_005") {
  const att = aid(date, "S_005");
  await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ($1, 'S_005', $2, 'worked') on conflict do nothing", [att, date]);
  await owner.query(
    `insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time, end_time, lotto_reserve_counted, lotto_topup_from_till)
     values ($1, $2, 'S_005', 'cstore', $3, 'closed', $4, $5, $6, 0)`,
    [id, att, date, `${date}T12:00:00Z`, `${date}T23:59:00Z`, counted],
  );
}

const omit = (row: Record<string, unknown> | null, keys: string[]) => {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!keys.includes(k)) out[k] = v;
  return out;
};
// Columns that record who entered it or when, not the shift (see the card's report):
//   till_sessions.notes   the entry appends "Entered after the fact: <reason>" (checked on its own);
//   sales.seq             the order rows were written in: an entry made today is written after every close before it;
//   attendance.created_by / created_at / modified_by / modified_at: who wrote the day and when.
const SESSION_EXCLUDED = ["notes"];
const SALES_EXCLUDED = ["seq"];
const ATT_EXCLUDED = ["created_by", "created_at", "modified_by", "modified_at"];

const VAPE_F: Figures = { cash: 1150, credit: 300, debit: 200, miscCash: 0, miscCredit: 0, miscDebit: 0, miscNotes: "", count: 1250 };

// ── The promise: an entered shift stores what the real open and close would have ──

describe("entered-equals-worked: an entered shift stores exactly what the real open and close store", () => {
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
    { name: "vape, credit and debit (no lotto figures)", company: "vape", staff: "S_004", day: DAY, f: { ...VAPE_F, count: 1250.07 } },
    {
      name: "vape, one card total (vape_card_split false; no lotto figures)",
      company: "vape",
      staff: "S_004",
      day: DAY,
      config: { ...CONFIG, vape_card_split: "false" },
      f: { cash: 210.3, card: 444.4, miscCash: 5, miscCard: 1, miscNotes: "Coil sample", count: 310.3 },
    },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      // World A: the real open and close.
      await reset(c.config);
      await seedReserve(470);
      const a = await openClose(c.staff, c.company, c.day, c.f);
      const worked = { s: await sessRow(a), r: await salesRow(a), d: await attRow(aid(c.day, c.staff)) };

      // World B: nothing was put in; the admin enters it after the fact.
      await reset(c.config);
      await seedReserve(470);
      const out = await enter(entryOf(c.staff, c.company, c.day, c.f));
      expect(out.session.sessionId).toBe(a);
      const entered = { s: await sessRow(a), r: await salesRow(a), d: await attRow(aid(c.day, c.staff)) };

      expect(omit(entered.s, SESSION_EXCLUDED)).toEqual(omit(worked.s, SESSION_EXCLUDED));
      expect(omit(entered.r, SALES_EXCLUDED)).toEqual(omit(worked.r, SALES_EXCLUDED));
      expect(omit(entered.d, ATT_EXCLUDED)).toEqual(omit(worked.d, ATT_EXCLUDED));
      expect(worked.s.notes).toBeNull();
      expect(entered.s.notes).toBe("Entered after the fact: " + REASON);
      expect(entered.d).toMatchObject({ created_by: "S_001", created_at: NOW, modified_by: null, modified_at: null });
      // The answer is the stored rows' own figures.
      expect(out).toMatchObject({ variance: worked.s.closing_variance, varianceStatus: worked.s.variance_status, cashRemoved: worked.s.cash_removed_at_close, attendanceChange: "created" });
    });
  }

  it("a difference on purpose: a cstore close sent no reserve count stores the expected balance; an entry with a blank count stores it blank (not counted)", async () => {
    await seedReserve(470);
    const f: Figures = { cash: 100, card: 50, miscCash: 0, miscCard: 0, miscNotes: "", count: 350 };
    const a = await openClose("S_003", "cstore", DAY, f);
    expect((await sessRow(a)).lotto_reserve_counted).toBe(500);
    await reset();
    await seedReserve(470);
    await enter(entryOf("S_003", "cstore", DAY, f, undefined, undefined, { lottoReserveCounted: null, lottoTopupFromTill: null, lottoReserveNote: "" }));
    // Not counted: nothing fed from the pot, expected cash is the float plus cash sales.
    expect(await sessRow(a)).toMatchObject({ lotto_reserve_counted: null, lotto_topup_from_till: null, lotto_reserve_note: null, expected_cash: 350, closing_variance: 0 });
  });
});

// ── Everything downstream sees it ──────────────────────────

describe("everything downstream sees it", () => {
  const deps0 = async () => ({ config: await loadConfig(db), now: NOW });
  const holding = async (staffId: string) => (await cashHandling.getOutstandingForStaff(db, staffId, NOW)).totalOutstanding;
  const owed = async (staffId: string) => (await payments.getOwedSummary(db, staffId)).shiftsOwed;
  const dayTotal = async () => {
    const d = await salesDashboard.getDashboard(db, { startDate: DAY, endDate: DAY });
    const x = d.daily.find((y: any) => y.dateStr === DAY) as any;
    return x ? x.total : 0;
  };
  const pubDay = async () => {
    const p = (await publicReport.buildSales(db, 30, await deps0())) as any;
    const x = p.daily.find((d: any) => d.dateStr === DAY);
    return x ? x.total : 0;
  };

  it("a new day: the sales dashboard and the public report include it, the cashier holds its cash removed, owed rises by hours x rate", async () => {
    await seedReserve(500);
    await openClose("S_003", "cstore", DAY, { cash: 600, card: 1837.5, miscCash: 0, miscCard: 0, miscNotes: "", count: 850, lotto: { counted: 500, topup: 0, note: "" } });
    const [t0, p0, h0, o0] = [await dayTotal(), await pubDay(), await holding("S_004"), await owed("S_004")];
    const recon0 = ((await publicReport.build(db, 14, await deps0())) as any).cash.total;
    expect([t0, p0, h0, o0]).toEqual([2437.5, 2437.5, 0, 0]);

    const out = await enter(entryOf("S_004", "vape", DAY, { ...VAPE_F, count: 1520 }));
    expect(out).toMatchObject({ total: 1650, cashRemoved: 1420, variance: 270, varianceStatus: "investigate", attendanceChange: "created" });
    expect(out.attendance).toMatchObject({ status: "worked", hoursWorked: 8, rateAtAttendance: 17.5, owed: 140 });
    expect(await dayTotal()).toBe(t0 + 1650);
    expect(await pubDay()).toBe(p0 + 1650);
    expect(await holding("S_004")).toBe(h0 + 1420);
    expect(((await publicReport.build(db, 14, await deps0())) as any).cash.total).toBe(recon0 + 1420);
    expect(await owed("S_004")).toBe(o0 + 8 * 17.5);
  });

  it("a day already worked: owed does not move, the hours are left, and the answer says so with the span both shifts make", async () => {
    await seedReserve(500);
    await openClose("S_003", "cstore", DAY, { cash: 600, card: 1837.5, miscCash: 0, miscCard: 0, miscNotes: "", count: 850, lotto: { counted: 500, topup: 0, note: "" } });
    const o0 = await owed("S_003");
    expect(o0).toBe(8 * 18);
    const dayBefore = await attRow(aid(DAY, "S_003"));
    const out = await enter(entryOf("S_003", "vape", DAY, VAPE_F, at(DAY, "17:00"), at(DAY, "21:00")));
    expect(out.attendanceChange).toBe("left");
    expect(out.hoursLeft).toEqual({
      recorded: 8,
      span: 12,
      message: "The day's hours were left at 8: correct the day on the Schedule screen if they should change (the day's shifts would span 12 hours).",
    });
    expect(await attRow(aid(DAY, "S_003"))).toEqual(dayBefore);
    expect((await sessRow(sid("vape", DAY, "S_003"))).attendance_id).toBe(aid(DAY, "S_003"));
    expect(await owed("S_003")).toBe(o0);
    expect(await holding("S_003")).toBe(600 + 1150);
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
    createRpcRouter({ contract, handlers, openDb: () => connect(testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env: {}, now: () => NOW, log: () => undefined, fetch: fetchSpy });
  async function call(name: string, args: unknown[]) {
    const res = await router()(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
    return (await res.json()) as { ok: boolean; result?: any; error?: { message: string } };
  }
  const tokenOf = async (staffId: string) => (await createSession(db, staffId, Config.fromRows([]), NOW)).token;
  const input = (extra: Record<string, unknown> = {}) => ({ ...entryOf("S_004", "vape", DAY, VAPE_F), ...extra });

  it("the contract lists both as admin only, needing a session", () => {
    expect(contract.get("rpcPreviewMissedShift")).toMatchObject({ params: ["token", "input"], roles: ["admin"], needs_session: true, migrate: true });
    expect(contract.get("rpcEnterMissedShift")).toMatchObject({ params: ["token", "input"], roles: ["admin"], needs_session: true, migrate: true });
  });

  it("both answer an admin", async () => {
    const t = await tokenOf("S_001");
    const p = await call("rpcPreviewMissedShift", [t, input()]);
    expect(p.result).toMatchObject({ session: { sessionId: sid("vape", DAY, "S_004"), staffName: "Dara Vance" }, variance: 0 });
    expect(await sessRow(sid("vape", DAY, "S_004"))).toBeNull();
    const out = await call("rpcEnterMissedShift", [t, input()]);
    expect(out.ok).toBe(true);
    expect(out.result).toEqual(p.result);
    expect(await sessRow(sid("vape", DAY, "S_004"))).toMatchObject({ status: "closed" });
  });

  it("both refuse a manager, a payroll admin and an employee, and change nothing", async () => {
    const before = await snapshot(ALL_TABLES.filter((t) => t !== "sessions"));
    for (const [sid2, role] of [["S_002", "manager"], ["S_006", "payroll_admin"], ["S_004", "employee"]]) {
      const t = await tokenOf(sid2 as string);
      expect((await call("rpcPreviewMissedShift", [t, input()])).error?.message).toBe(`FORBIDDEN: requires admin, got ${role}`);
      expect((await call("rpcEnterMissedShift", [t, input()])).error?.message).toBe(`FORBIDDEN: requires admin, got ${role}`);
    }
    expect(await snapshot(ALL_TABLES.filter((t) => t !== "sessions"))).toBe(before);
  });

  it("both refuse a call with no token or an unknown one", async () => {
    for (const t of [undefined, "", "nope"]) {
      expect((await call("rpcPreviewMissedShift", [t, input()])).error?.message).toBe("NOT_LOGGED_IN");
      expect((await call("rpcEnterMissedShift", [t, input()])).error?.message).toBe("NOT_LOGGED_IN");
    }
    expect(await sessRow(sid("vape", DAY, "S_004"))).toBeNull();
  });

  it("a role or actorId planted in the input changes nothing: the audit row and the day name the session's admin", async () => {
    const manager = await tokenOf("S_002");
    expect((await call("rpcEnterMissedShift", [manager, input({ role: "admin", actorId: "S_001" })])).error?.message).toBe("FORBIDDEN: requires admin, got manager");
    const admin = await tokenOf("S_001");
    expect((await call("rpcEnterMissedShift", [admin, input({ role: "employee", actorId: "S_006", sessionId: "VAP-X", status: "open" })])).ok).toBe(true);
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0].actor_id).toBe("S_001");
    expect(await attRow(aid(DAY, "S_004"))).toMatchObject({ created_by: "S_001" });
    expect(await sessRow(sid("vape", DAY, "S_004"))).toMatchObject({ staff_id: "S_004", status: "closed", company: "vape" });
  });

  it("the handlers check the role themselves too (a defence if the contract file were wrong)", async () => {
    for (const who of [session("S_002", "manager"), session("S_006", "payroll_admin"), session("S_004", "employee")]) {
      await expect(rpc(rpcEnterMissedShift, who, [input()])).rejects.toThrow(`FORBIDDEN: requires admin, got ${who.role}`);
      await expect(rpc(rpcPreviewMissedShift, who, [input()])).rejects.toThrow(`FORBIDDEN: requires admin, got ${who.role}`);
    }
    await expect(rpc(rpcEnterMissedShift, null, [input()])).rejects.toThrow("NOT_LOGGED_IN");
    await expect(rpc(rpcPreviewMissedShift, null, [input()])).rejects.toThrow("NOT_LOGGED_IN");
    await expect(rpc(rpcEnterMissedShift, ADMIN, [null])).rejects.toThrow("input is required");
    await expect(rpc(rpcPreviewMissedShift, ADMIN, [[1]])).rejects.toThrow("input is required");
    expect(await sessRow(sid("vape", DAY, "S_004"))).toBeNull();
  });
});

// ── The rules, in order ────────────────────────────────────

describe("the rules, in order", () => {
  const vape = (staffId: string, extra: Record<string, unknown> = {}, start = at(DAY, "09:00"), end = at(DAY, "17:00")) => entryOf(staffId, "vape", DAY, VAPE_F, start, end, extra);

  it("1. the person exists; an inactive person is allowed", async () => {
    await expect(enter(vape("S_X"))).rejects.toThrow("Staff not found: S_X");
    await expect(enter(vape(""))).rejects.toThrow("Staff not found: ");
    await expect(preview({ ...vape("S_004"), staffId: 4 })).rejects.toThrow("Staff not found: 4");
    await owner.query("update ops.staff set active = false where staff_id = 'S_005'");
    expect((await enter(vape("S_005"))).session).toMatchObject({ staffId: "S_005", staffName: "Eli Stone", status: "closed" });
  });

  it("2. the till is cstore or vape; a person not authorised for it now is allowed, and the answer says so", async () => {
    await expect(enter({ ...vape("S_004"), company: "bakery" })).rejects.toThrow("The till must be cstore or vape.");
    expect((await enter(vape("S_004"))).notAuthorised).toBe(false);
    // Gus is authorised for vape only.
    const out = await enter(entryOf("S_007", "cstore", DAY, { cash: 100, card: 50, miscCash: 0, miscCard: 0, miscNotes: "", count: 350, lotto: { counted: 500, topup: 0, note: "" } }, at(DAY, "18:00"), at(DAY, "20:00")));
    expect(out.notAuthorised).toBe(true);
  });

  it("3. a real day, before today in Toronto, not more than 370 days back", async () => {
    await expect(enter({ ...vape("S_004"), date: "2026-02-30" })).rejects.toThrow("date is not a readable date");
    await expect(enter({ ...vape("S_004"), date: 20260912 })).rejects.toThrow("date is not a readable date");
    // NOW is 14:00 on 2026-09-20 in Toronto: today is refused even for a shift that has ended.
    await expect(enter(entryOf("S_004", "vape", "2026-09-20", VAPE_F, at("2026-09-20", "06:00"), at("2026-09-20", "12:00")))).rejects.toThrow("Open and close today's till on the Shift screen.");
    await expect(enter(entryOf("S_004", "vape", "2026-09-21", VAPE_F, at("2026-09-21", "06:00"), at("2026-09-21", "12:00")))).rejects.toThrow("A shift cannot be entered for a day that has not happened yet.");
    await expect(enter(entryOf("S_004", "vape", "2025-09-14", VAPE_F, at("2025-09-14", "09:00"), at("2025-09-14", "17:00")))).rejects.toThrow("Cannot enter a shift from more than 370 days ago.");
    expect((await enter(entryOf("S_004", "vape", "2025-09-15", VAPE_F, at("2025-09-15", "09:00"), at("2025-09-15", "17:00")))).session.date).toBe("2025-09-15");
    // Yesterday is the latest day an entry takes.
    expect((await enter(entryOf("S_005", "vape", "2026-09-19", VAPE_F, at("2026-09-19", "09:00"), at("2026-09-19", "17:00")))).session.date).toBe("2026-09-19");
  });

  describe("4. the times", () => {
    it("instants with a zone; the end after the start; at most 24 hours; the end not in the future", async () => {
      await expect(enter(vape("S_004", {}, "2026-09-12T09:00:00"))).rejects.toThrow("The start must be a date and time with its zone, such as 2026-06-01T09:00:00-04:00.");
      await expect(enter(vape("S_004", {}, at(DAY, "09:00"), "5pm"))).rejects.toThrow("The end must be a date and time with its zone");
      await expect(enter(vape("S_004", {}, at(DAY, "09:00"), at(DAY, "09:00")))).rejects.toThrow("The end must be after the start.");
      await expect(enter(vape("S_004", {}, at(DAY, "09:00"), at("2026-09-13", "09:01")))).rejects.toThrow("A shift cannot be longer than 24 hours.");
      await expect(enter(entryOf("S_004", "vape", "2026-09-19", VAPE_F, at("2026-09-19", "22:00"), at("2026-09-20", "14:01")))).rejects.toThrow("The end cannot be in the future.");
      expect((await enter(entryOf("S_004", "vape", "2026-09-19", VAPE_F, at("2026-09-19", "22:00"), at("2026-09-20", "14:00")))).attendance.hoursWorked).toBe(16);
    });

    it("the start on that business date in Toronto, or within 6 hours of it; 23:30 to 07:30 stays on its date", async () => {
      await expect(enter(vape("S_004", {}, at("2026-09-11", "17:59"), at(DAY, "02:00")))).rejects.toThrow("The start must be on 2026-09-12 (Toronto time), or within 6 hours of it.");
      await expect(enter(vape("S_004", {}, at("2026-09-13", "06:00"), at("2026-09-13", "08:00")))).rejects.toThrow("The start must be on 2026-09-12 (Toronto time), or within 6 hours of it.");
      const late = await enter(vape("S_004", {}, at(DAY, "23:30"), at("2026-09-13", "07:30")));
      expect(late.session).toMatchObject({ date: DAY, startTime: "2026-09-13T03:30:00.000Z", endTime: "2026-09-13T11:30:00.000Z" });
      expect(late.attendance).toMatchObject({ date: DAY, hoursWorked: 8 });
      const early = await enter(entryOf("S_005", "vape", DAY, VAPE_F, at("2026-09-11", "18:00"), at("2026-09-11", "23:00")));
      expect(early.session.date).toBe(DAY);
    });

    it("both clock-change days: the hours are the time that passed, not the wall clock's", async () => {
      // 2026-03-08: Toronto springs forward at 02:00 (EST -05:00 to EDT -04:00).
      const spring = await enter(entryOf("S_004", "vape", "2026-03-08", VAPE_F, "2026-03-08T00:00:00-05:00", "2026-03-08T12:00:00-04:00"));
      expect(spring.attendance.hoursWorked).toBe(11);
      // 2025-11-02: it falls back at 02:00 (EDT -04:00 to EST -05:00).
      const fall = await enter(entryOf("S_004", "vape", "2025-11-02", VAPE_F, "2025-11-02T00:00:00-04:00", "2025-11-02T12:00:00-05:00"));
      expect(fall.attendance.hoursWorked).toBe(13);
    });
  });

  it("5. a reason of 3 to 300 characters after trimming, no control characters; the preview takes none", async () => {
    for (const r of [undefined, null, "", "  ab  ", "x".repeat(301), 42]) await expect(enter(vape("S_004", { reason: r }))).rejects.toThrow("A reason is required: 3 to 300 characters.");
    await expect(enter(vape("S_004", { reason: "line\nbreak" }))).rejects.toThrow("The reason cannot contain control characters (such as a line break).");
    await expect(preview(vape("S_004", { reason: "ab" }))).rejects.toThrow("A reason is required: 3 to 300 characters.");
    expect((await preview(vape("S_004", { reason: undefined }))).variance).toBe(0);
    expect(await audits()).toEqual([]);
    expect((await enter(vape("S_004", { reason: "  abc  " }))).session.notes).toBe("Entered after the fact: abc");
  });

  describe("6. no overlap on the till", () => {
    it("touching ends are allowed; one minute of overlap is refused with the other shift's times and person", async () => {
      await openClose("S_004", "vape", DAY, VAPE_F); // 09:00 to 17:00
      expect((await enter(vape("S_005", {}, at(DAY, "17:00"), at(DAY, "21:00")))).session.sessionId).toBe(sid("vape", DAY, "S_005"));
      await expect(enter(vape("S_003", {}, at(DAY, "16:59"), at(DAY, "17:30")))).rejects.toThrow("The vape till already has a shift from 09:00 to 17:00 that day (Dara Vance).");
      await expect(enter(vape("S_003", {}, at(DAY, "20:59"), at(DAY, "22:00")))).rejects.toThrow("The vape till already has a shift from 17:00 to 21:00 that day (Eli Stone).");
      await expect(enter(vape("S_003", {}, at(DAY, "08:00"), at(DAY, "22:00")))).rejects.toThrow("The vape till already has a shift from 09:00 to 17:00 that day (Dara Vance).");
      expect((await enter(vape("S_003", {}, at(DAY, "06:00"), at(DAY, "09:00")))).session.sessionId).toBe(sid("vape", DAY, "S_003"));
      // Two shifts of one person on one till on one day: one shift per person per till per day.
      await expect(enter(vape("S_003", {}, at(DAY, "21:00"), at(DAY, "22:00")))).rejects.toThrow(
        "Cleo Marsh already has a vape shift on 2026-09-12 (VAP-20260912-S_003): one shift per person per till per day. Correct that till instead.",
      );
      // The other till is a different till.
      expect((await enter(entryOf("S_003", "cstore", DAY, { cash: 10, card: 0, miscCash: 0, miscCard: 0, miscNotes: "", count: 260, lotto: { counted: 500, topup: 0, note: "" } }))).session.company).toBe("cstore");
    });

    it("an OPEN session overlapping is refused; before its start is allowed", async () => {
      await withTransaction(db, async (tx) => ts.open(tx, { staffId: "S_004", company: "vape", openingCount: 100, actorId: "S_004" }, await deps(tx, new Date(`${DAY}T13:00:00Z`))));
      await expect(enter(vape("S_005", {}, at(DAY, "10:00"), at(DAY, "11:00")))).rejects.toThrow("The vape till already has a shift from 09:00 (still open) that day (Dara Vance).");
      await expect(enter(vape("S_005", {}, at(DAY, "20:00"), at(DAY, "23:00")))).rejects.toThrow("from 09:00 (still open)");
      expect((await enter(vape("S_005", {}, at(DAY, "07:00"), at(DAY, "09:00")))).session.status).toBe("closed");
    });
  });

  it("7. the same person on the other till at the same time is allowed, and reported", async () => {
    const cst = await openClose("S_004", "cstore", DAY, { cash: 100, card: 50, miscCash: 0, miscCard: 0, miscNotes: "", count: 350, lotto: { counted: 500, topup: 0, note: "" } });
    const out = await enter(vape("S_004", {}, at(DAY, "12:00"), at(DAY, "20:00")));
    expect(out.otherTill).toEqual([{ sessionId: cst, company: "cstore", status: "closed", startTime: `${DAY}T13:00:00.000Z`, endTime: `${DAY}T21:00:00.000Z` }]);
    expect(out.attendanceChange).toBe("left");
    // Not overlapping: not reported.
    const later = await enter(entryOf("S_005", "vape", "2026-09-13", VAPE_F, at("2026-09-13", "09:00"), at("2026-09-13", "17:00")));
    expect(later.otherTill).toEqual([]);
  });

  describe("8. the figures: read and derived as a correction reads and derives them", () => {
    it("the card shape that till reports on that date; the other shape, both or neither are refused", async () => {
      const single = { cash: 50, card: 100, miscCash: 0, miscCard: 0, miscNotes: "", count: 300, lotto: { counted: 500, topup: 0, note: "" } };
      const split = { cash: 50, credit: 60, debit: 40, miscCash: 0, miscCredit: 0, miscDebit: 0, miscNotes: "", count: 300, lotto: { counted: 500, topup: 0, note: "" } };
      await expect(enter(entryOf("S_003", "cstore", OLD_DAY, single))).rejects.toThrow("On 2026-08-20 the cstore till reports credit and debit: send credit and debit.");
      await expect(enter(entryOf("S_003", "cstore", DAY, split))).rejects.toThrow("On 2026-09-12 the cstore till reports one card total: send one card total.");
      await expect(enter(entryOf("S_003", "cstore", EPOS_FROM, split))).rejects.toThrow("On 2026-09-01 the cstore till reports one card total: send one card total.");
      await expect(enter(vape("S_004", { cardTotalSales: 500 }))).rejects.toThrow("Send one card shape.");
      const { creditCardSales: _a, debitCardSales: _b, miscCreditSales: _c, miscDebitSales: _d, ...neither } = vape("S_004");
      await expect(enter(neither)).rejects.toThrow("Send one card shape.");
      await expect(enter(entryOf("S_004", "vape", DAY, { cash: 1150, card: 500, miscCash: 0, miscCard: 0, miscNotes: "", count: 1250 }))).rejects.toThrow("On 2026-09-12 the vape till reports credit and debit: send credit and debit.");
      expect((await enter(entryOf("S_003", "cstore", OLD_DAY, split))).sales).toMatchObject({ creditCardSales: 60, debitCardSales: 40, cardTotalSales: null });
      expect(await audits()).toHaveLength(1);
    });

    it("the opening float and the cash counted are required; the close's own refusals apply", async () => {
      for (const v of [null, "", -0.01]) await expect(enter(vape("S_004", { openingFloat: v }))).rejects.toThrow("The opening float must be a number, 0 or more.");
      for (const v of [null, "", -1]) await expect(enter(vape("S_004", { closingCashCounted: v }))).rejects.toThrow("physicalCount required (non-negative number)");
      await expect(enter(vape("S_004", { cashSales: -5 }))).rejects.toThrow("Cash sales cannot be negative on vape — there is no lotto reserve on this till to fund a payout.");
      await expect(enter(vape("S_004", { lottoReserveCounted: 500 }))).rejects.toThrow("A vape till has no lotto reserve.");
      await expect(enter(vape("S_004", { cashSales: "1150" }))).rejects.toThrow("Cash sales must be a number, or blank.");
      await seedReserve(500);
      await expect(enter(entryOf("S_003", "cstore", DAY, { cash: 20, card: 100, miscCash: 0, miscCard: 0, miscNotes: "", count: 270, lotto: { counted: 450, topup: 0, note: "" } }))).rejects.toThrow(
        "Lotto reserve counted 450, expected 500. Please provide a reason.",
      );
      await expect(enter(entryOf("S_003", "cstore", DAY, { cash: -400, card: 100, miscCash: 0, miscCard: 0, miscNotes: "", count: 0, lotto: { counted: 500, topup: 0, note: "" } }))).rejects.toThrow(
        /^Expected cash works out to \$-150\.00, which no drawer can hold/,
      );
      const out = await enter(vape("S_004", { openingFloat: 120.004, closingCashCounted: 1270.001 }));
      expect(out.session).toMatchObject({ openingFloat: 120, closingCashCounted: 1270, expectedCash: 1270, closingVariance: 0 });
      expect(await audits()).toHaveLength(1);
    });

    it("a blank figure is stored NULL, never 0, and sums as 0", async () => {
      await enter(vape("S_004", { creditCardSales: null, debitCardSales: "", miscCreditSales: null, miscDebitSales: null, miscCashSales: null, miscNotes: "" }));
      expect(await salesRow(sid("vape", DAY, "S_004"))).toMatchObject({ cash_sales: 1150, credit_card_sales: null, debit_card_sales: null, misc_credit_sales: null, misc_debit_sales: null, misc_cash_sales: null, misc_notes: null, card_total_sales: null });
      expect(await sessRow(sid("vape", DAY, "S_004"))).toMatchObject({ expected_cash: 1250, closing_variance: 0, lotto_reserve_counted: null, lotto_topup_from_till: null });
    });
  });

  it("9. the session: closed, the open's id, the float left from today's setting (and the answer says so), the notes", async () => {
    await setConfig({ ...CONFIG, vape_default_opening_float: "150" });
    const out = await enter(vape("S_004", { notes: "Tablet down all day", closingCashCounted: 1250 }));
    const row = await sessRow(sid("vape", DAY, "S_004"));
    expect(row).toMatchObject({
      session_id: "VAP-20260912-S_004",
      attendance_id: "A_20260912_S_004",
      status: "closed",
      expected_opening: 150,
      opening_float: 100,
      opening_note: null,
      cash_left_in_till: 150,
      cash_removed_at_close: 1100,
      notes: "Tablet down all day | Entered after the fact: " + REASON,
      store_id: "store_main",
    });
    expect(out).toMatchObject({ floatLeft: 150, cashRemoved: 1100, floatNote: "The float left in the drawer is today's setting for the vape till ($150.00): nothing records the one in force that day." });
    // The notes are capped as a correction's are, keeping the newest text.
    const long = await enter(entryOf("S_005", "vape", "2026-09-13", VAPE_F, at("2026-09-13", "09:00"), at("2026-09-13", "17:00"), { notes: "n".repeat(1990) }));
    expect(long.session.notes.length).toBe(2000);
    expect(long.session.notes.startsWith("…")).toBe(true);
    expect(long.session.notes.endsWith(" | Entered after the fact: " + REASON)).toBe(true);
  });

  it("10. the sales row is the one a close writes: id = the session's, 0 in the figures the close sheet no longer asks for", async () => {
    await enter(vape("S_004"));
    expect(await salesRow(sid("vape", DAY, "S_004"))).toMatchObject({
      sales_id: "VAP-20260912-S_004",
      session_id: "VAP-20260912-S_004",
      staff_id: "S_004",
      company: "vape",
      date: DAY,
      cash_sales: 1150,
      credit_card_sales: 300,
      debit_card_sales: 200,
      cashback_paid: 0,
      hst_collected: 0,
      bottle_deposit: 0,
      round_off: 0,
      card_total_sales: null,
      misc_card_sales: null,
    });
  });

  describe("11. the day's attendance", () => {
    const schedule = (staffId: string, status: string, rate: number | null, extra = "") =>
      owner.query(`insert into ops.attendance (attendance_id, staff_id, date, scheduled_start, scheduled_end, hours_worked, rate_at_attendance, status, notes, created_by, created_at${extra ? ", hours_basis" : ""})
                   values ($1, $2, $3, '10:00', '18:00', 0, $4, $5, 'Planned', 'S_002', '2026-09-01T12:00:00Z'${extra ? ", $6" : ""})`, extra ? [aid(DAY, staffId), staffId, DAY, rate, status, extra] : [aid(DAY, staffId), staffId, DAY, rate, status]);

    it("none: created worked, with the shift's times, the span's hours and the person's current rate", async () => {
      const out = await enter(vape("S_004"));
      expect(out.attendanceChange).toBe("created");
      expect(await attRow(aid(DAY, "S_004"))).toMatchObject({
        status: "worked",
        actual_start: new Date(`${DAY}T13:00:00Z`),
        actual_end: new Date(`${DAY}T21:00:00Z`),
        hours_worked: 8,
        rate_at_attendance: 17.5,
        scheduled_start: null,
        created_by: "S_001",
        created_at: NOW,
        hours_basis: null,
      });
    });

    it("scheduled: becomes worked; the scheduled times are kept; a 0 rate takes the current one, a rate above 0 is kept", async () => {
      await schedule("S_004", "scheduled", 0);
      await schedule("S_005", "scheduled", 19);
      const a = await enter(vape("S_004"));
      const b = await enter(entryOf("S_005", "vape", DAY, VAPE_F, at(DAY, "17:00"), at(DAY, "20:30")));
      expect([a.attendanceChange, b.attendanceChange]).toEqual(["promoted", "promoted"]);
      expect(await attRow(aid(DAY, "S_004"))).toMatchObject({ status: "worked", scheduled_start: "10:00", scheduled_end: "18:00", hours_worked: 8, rate_at_attendance: 17.5, notes: "Planned", created_by: "S_002", modified_by: "S_001", modified_at: NOW });
      expect(await attRow(aid(DAY, "S_005"))).toMatchObject({ status: "worked", hours_worked: 3.5, rate_at_attendance: 19 });
      expect(b.attendance.owed).toBe(66.5);
    });

    it("cancelled: becomes worked with the shift's times", async () => {
      await schedule("S_004", "cancelled", 0);
      expect((await enter(vape("S_004"))).attendance).toMatchObject({ status: "worked", hoursWorked: 8, rateAtAttendance: 17.5, scheduledStart: "10:00" });
    });

    it("worked: the hours are not changed, the session is attached (see also 'everything downstream')", async () => {
      await openClose("S_004", "cstore", DAY, { cash: 100, card: 50, miscCash: 0, miscCard: 0, miscNotes: "", count: 350, lotto: { counted: 500, topup: 0, note: "" } });
      const before = await attRow(aid(DAY, "S_004"));
      const out = await enter(vape("S_004", {}, at(DAY, "06:00"), at(DAY, "09:00")));
      expect(out.attendanceChange).toBe("left");
      expect(out.hoursLeft).toMatchObject({ recorded: 8, span: 11 });
      expect(await attRow(aid(DAY, "S_004"))).toEqual(before);
    });

    it("in progress: refused", async () => {
      await withTransaction(db, async (tx) => ts.open(tx, { staffId: "S_004", company: "cstore", openingCount: 250, actorId: "S_004" }, await deps(tx, new Date(`${DAY}T13:00:00Z`))));
      await expect(enter(vape("S_004", {}, at(DAY, "18:00"), at(DAY, "20:00")))).rejects.toThrow("Close Dara Vance's till first.");
      await expect(preview(vape("S_004", {}, at(DAY, "18:00"), at(DAY, "20:00")))).rejects.toThrow("Close Dara Vance's till first.");
    });

    it("a blank current rate is stored NULL and the day owes null, never 0", async () => {
      const out = await enter(entryOf("S_007", "vape", DAY, VAPE_F));
      expect((await attRow(aid(DAY, "S_007"))).rate_at_attendance).toBeNull();
      expect(out.attendance).toMatchObject({ rateAtAttendance: null, hoursWorked: 8, owed: null });
      expect((await payments.getOwedSummary(db, "S_007")).shiftsOwed).toBe(0);
    });

    it("a worked day with money paid against it is untouched", async () => {
      await openClose("S_004", "cstore", DAY, { cash: 100, card: 50, miscCash: 0, miscCard: 0, miscNotes: "", count: 350, lotto: { counted: 500, topup: 0, note: "" } });
      await withTransaction(db, (tx) => payments.payShifts(tx, { staffId: "S_004", amount: 140, method: "cash", notes: "", actorId: "S_001" }, { config: Config.fromRows([]), env: {}, fetch: fetchSpy, now: NOW }));
      const before = await snapshot(["attendance", "payments", "payment_items"]);
      const out = await enter(vape("S_004", {}, at(DAY, "17:00"), at(DAY, "22:00")));
      expect(out.attendanceChange).toBe("left");
      expect(await snapshot(["attendance", "payments", "payment_items"])).toBe(before);
      expect((await payments.getOwedSummary(db, "S_004")).shiftsOwed).toBe(0);
    });

    it("a scheduled day with money against it (not reachable by the app) is refused, not changed", async () => {
      await schedule("S_004", "scheduled", 0);
      await owner.query("insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method) values ('P_9','S_004','2026-09-13',10,'cash')");
      await owner.query("insert into ops.payment_items (item_id, payment_id, item_type, ref_id, amount) values ('I_9','P_9','shift',$1,10)", [aid(DAY, "S_004")]);
      await expect(enter(vape("S_004"))).rejects.toThrow("Cannot enter: $10.00 has been paid against this day. Undo the payment first.");
    });
  });

  it("12. one audit row: till.enter_missed, before null, the whole session, sales row and day after, the reason in details", async () => {
    const n = (await allAudits()).length;
    await enter(vape("S_004"));
    expect((await allAudits()).length).toBe(n + 1);
    const [a] = await audits();
    expect(a).toMatchObject({ actor_id: "S_001", action: "till.enter_missed", target_type: "till_sessions", target_id: "VAP-20260912-S_004", before: null, details: REASON });
    const after = JSON.parse(a.after);
    const s = await sessRow("VAP-20260912-S_004");
    const r = await salesRow("VAP-20260912-S_004");
    const d = await attRow(aid(DAY, "S_004"));
    expect(after.session).toEqual({ ...s, start_time: s.start_time.toISOString(), end_time: s.end_time.toISOString() });
    expect(after.sales).toEqual(r);
    expect(after.attendance).toEqual({ ...d, actual_start: d.actual_start.toISOString(), actual_end: d.actual_end.toISOString(), created_at: d.created_at.toISOString() });
    expect(after.attendanceChange).toBe("created");
  });

  it("13. the answer: what goes stale (a reconcile result, commission runs over the day)", async () => {
    let out = await enter(vape("S_004"));
    expect(out).toMatchObject({ staleReconcile: false, commissionRunsTouched: [], nextLottoSession: null, lotto: null, cardShape: "split" });
    await owner.query("insert into ops.validation_results (validation_id, business_date, companies, session_ids, status, mode) values ('VR_1', $1, 'cstore', 'CST-20260913-S_003', 'OK', 'auto')", ["2026-09-13"]);
    await owner.query("insert into ops.commission_runs (run_id, week_start, week_end, staff_count, bonuses_created, total_commission_amount) values ('CR_1', '2026-09-07', '2026-09-13', 1, 1, 12)");
    await owner.query("insert into ops.bonuses (bonus_id, staff_id, date, type, amount, reason, status, source_run_id) values ('B_1', 'S_004', '2026-09-13', 'commission', 12, 'vape', 'pending', 'CR_1')");
    // A cstore-only reconcile that day does not cover a vape shift.
    out = await enter(entryOf("S_004", "vape", "2026-09-13", VAPE_F, at("2026-09-13", "09:00"), at("2026-09-13", "17:00")));
    expect(out).toMatchObject({ staleReconcile: false, commissionRunsTouched: [{ runId: "CR_1", weekEnd: "2026-09-13", status: "approved" }] });
    await owner.query("update ops.validation_results set companies = 'cstore+vape'");
    out = await enter(entryOf("S_005", "vape", "2026-09-13", VAPE_F, at("2026-09-13", "17:00"), at("2026-09-13", "21:00")));
    expect(out.staleReconcile).toBe(true);
  });
});

// ── The lotto chain ────────────────────────────────────────

describe("the lotto chain", () => {
  it("an entry between two cstore closes takes its previous count from the one before it and names the one after it", async () => {
    await seedReserve(500);
    const first = await openClose("S_003", "cstore", "2026-09-10", { cash: 100, card: 10, miscCash: 0, miscCard: 0, miscNotes: "", count: 350, lotto: { counted: 480, topup: 0, note: "Sold $20 of tickets" } });
    const after = await openClose("S_005", "cstore", DAY, { cash: 100, card: 10, miscCash: 0, miscCard: 0, miscNotes: "", count: 350, lotto: { counted: 500, topup: 0, note: "" } });
    expect((await sessRow(first)).lotto_reserve_counted).toBe(480);
    const input = entryOf("S_004", "cstore", "2026-09-11", { cash: 100, card: 10, miscCash: 0, miscCard: 0, miscNotes: "", count: 360, lotto: { counted: 470, topup: 0, note: "Paid $10 ticket" } }, at("2026-09-11", "09:00"), at("2026-09-11", "17:00"));
    const p = await preview(input);
    expect(p.lotto).toEqual({ expected: 500, previousCount: 480 });
    expect(p.nextLottoSession).toEqual({ sessionId: after, date: DAY });
    const out = await enter(input);
    // The pot fed the drawer 10 (480 before, 470 after): expected 250 + 100 + 10.
    expect(out.session).toMatchObject({ expectedCash: 360, closingVariance: 0, lottoReserveCounted: 470 });
    expect(out.nextLottoSession).toEqual({ sessionId: after, date: DAY });
    // The lotto log lists it by when it closed, between the two.
    const log = await ts.getLottoLog(db, 30, { config: await loadConfig(db), now: NOW });
    expect(log.entries.map((e) => e.sessionId)).toEqual([after, sid("cstore", "2026-09-11", "S_004"), first]);
  });

  it("an entry after the newest close names none and takes the newest count", async () => {
    await seedReserve(470);
    const out = await enter(entryOf("S_004", "cstore", DAY, { cash: 100, card: 10, miscCash: 0, miscCard: 0, miscNotes: "", count: 320, lotto: { counted: 500, topup: 0, note: "" } }));
    expect(out).toMatchObject({ lotto: { expected: 500, previousCount: 470 }, nextLottoSession: null });
    expect(out.session.expectedCash).toBe(320);
  });
});

// ── The preview ────────────────────────────────────────────

describe("the preview", () => {
  it("writes nothing (every table identical) and answers what the entry then answers", async () => {
    await seedReserve(500);
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, scheduled_start, scheduled_end, hours_worked, rate_at_attendance, status) values ($1, 'S_004', $2, '09:00', '17:00', 0, 0, 'scheduled')", [aid(DAY, "S_004"), DAY]);
    for (const input of [
      entryOf("S_004", "vape", DAY, VAPE_F),
      entryOf("S_003", "cstore", DAY, { cash: 100, card: 10, miscCash: 0, miscCard: 0, miscNotes: "", count: 350, lotto: { counted: 480, topup: 0, note: "Paid $20" } }),
    ]) {
      const before = await snapshot();
      const p = await preview(input);
      expect(await snapshot()).toBe(before);
      const out = await enter(input);
      expect(out).toEqual(p);
    }
  });

  it("refuses what the entry refuses, with the same message", async () => {
    await openClose("S_004", "vape", DAY, VAPE_F);
    const input = entryOf("S_005", "vape", DAY, VAPE_F, at(DAY, "16:00"), at(DAY, "18:00"));
    await expect(preview(input)).rejects.toThrow("The vape till already has a shift from 09:00 to 17:00 that day (Dara Vance).");
    await expect(enter(input)).rejects.toThrow("The vape till already has a shift from 09:00 to 17:00 that day (Dara Vance).");
  });
});

// ── Nothing else moves ─────────────────────────────────────

describe("nothing else moves", () => {
  it("payments, items, bonuses, handovers, commission runs and reconcile results are identical; no message is attempted", async () => {
    const id = await openClose("S_004", "vape", OLD_DAY, VAPE_F);
    await withTransaction(db, async (tx) => cashHandling.record(tx, await loadConfig(tx), { fromStaffId: "S_004", amount: 300, actorId: "S_002", notes: "part" }, NOW));
    await owner.query("insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method) values ('P_9','S_004','2026-09-13',10,'cash')");
    await owner.query("insert into ops.payment_items (item_id, payment_id, item_type, ref_id, amount) values ('I_9','P_9','shift',$1,10)", [aid(OLD_DAY, "S_004")]);
    await owner.query("insert into ops.commission_runs (run_id, week_start, week_end, staff_count, bonuses_created, total_commission_amount) values ('CR_1', '2026-09-07', '2026-09-13', 1, 1, 12)");
    await owner.query("insert into ops.bonuses (bonus_id, staff_id, date, type, amount, reason, status, source_run_id) values ('B_1', 'S_004', '2026-09-13', 'commission', 12, 'vape', 'proposed', 'CR_1')");
    await owner.query("insert into ops.validation_results (validation_id, business_date, companies, session_ids, status, mode) values ('VR_1', $1, 'vape', $2, 'OK', 'auto')", [DAY, id]);
    const tables = ["payments", "payment_items", "bonuses", "cash_handovers", "cash_handover_items", "commission_runs", "validation_results", "staff", "config"];
    const before = await snapshot(tables);
    const otherSession = await sessRow(id);
    const otherSales = await salesRow(id);
    const n = (await allAudits()).length;
    const out = await enter(entryOf("S_004", "vape", DAY, VAPE_F));
    expect(out.staleReconcile).toBe(true);
    expect(await snapshot(tables)).toBe(before);
    expect(await sessRow(id)).toEqual(otherSession);
    expect(await salesRow(id)).toEqual(otherSales);
    expect(fetched).toEqual([]);
    expect((await allAudits()).slice(n).map((a) => a.action)).toEqual(["till.enter_missed"]);
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
  const enterOn = (input: Record<string, unknown>) => async (tx: any) => missed.enter(tx, input as any, "S_001", await loadConfig(tx), NOW);
  const message = (r: PromiseSettledResult<unknown>) => String((r as PromiseRejectedResult).reason?.message);

  it("two entries for the same till and overlapping times on two connections: exactly one succeeds", async () => {
    const [one, two] = await overlap(enterOn(entryOf("S_004", "vape", DAY, VAPE_F)), enterOn(entryOf("S_005", "vape", DAY, VAPE_F, at(DAY, "12:00"), at(DAY, "20:00"))));
    expect([one.status, two.status]).toEqual(["fulfilled", "rejected"]);
    expect(message(two)).toBe("The vape till already has a shift from 09:00 to 17:00 that day (Dara Vance).");
    expect(await db.query("select session_id from ops.till_sessions where company = 'vape'")).toEqual([{ session_id: sid("vape", DAY, "S_004") }]);
  });

  // A real open is for today; an entry's day is before today. They can overlap only around midnight: an entry
  // for yesterday 22:00 to 02:00 and an open at 01:00 today.
  const YESTERDAY = "2026-09-19";
  const lateEntry = entryOf("S_004", "vape", YESTERDAY, VAPE_F, at(YESTERDAY, "22:00"), at("2026-09-20", "02:00"));
  const openAt1am = async (tx: any) => ts.open(tx, { staffId: "S_005", company: "vape", openingCount: 100, actorId: "S_005" }, await deps(tx, new Date("2026-09-20T05:00:00Z")));

  it("an open first, an entry meanwhile: the entry waits for the open, then sees it and is refused", async () => {
    const [o, e] = await overlap(openAt1am, enterOn(lateEntry));
    expect(o.status).toBe("fulfilled");
    expect(e.status).toBe("rejected");
    expect(message(e)).toBe("The vape till already has a shift from 01:00 (still open) that day (Eli Stone).");
  });

  it("an entry first, an open meanwhile: the open waits for the entry, then opens (an open checks only for a till still open)", async () => {
    const [e, o] = await overlap(enterOn(lateEntry), openAt1am);
    expect([e.status, o.status]).toEqual(["fulfilled", "fulfilled"]);
    expect((await sessRow(sid("vape", "2026-09-20", "S_005"))).status).toBe("open");
    expect((await sessRow(sid("vape", YESTERDAY, "S_004"))).status).toBe("closed");
  });

  describe("an entry racing a payment of the same person: safe either way (both lock the person first)", () => {
    const payOn = (amount: number) => (tx: any) => payments.payShifts(tx, { staffId: "S_004", amount, method: "cash", notes: "", actorId: "S_001" }, { config: Config.fromRows([]), env: {}, fetch: fetchSpy, now: NOW });
    beforeEach(async () => {
      await openClose("S_004", "vape", OLD_DAY, VAPE_F); // a worked day owed 140
    });

    it("the entry first: the payment waits, then sees the new day and can pay both", async () => {
      const [e, p] = await overlap(enterOn(entryOf("S_004", "vape", DAY, VAPE_F)), payOn(280));
      expect([e.status, p.status]).toEqual(["fulfilled", "fulfilled"]);
      expect((await payments.getOwedSummary(db, "S_004")).shiftsOwed).toBe(0);
    });

    it("the payment first: the entry waits, then adds a day the payment did not see", async () => {
      const [p, e] = await overlap(payOn(140), enterOn(entryOf("S_004", "vape", DAY, VAPE_F)));
      expect([p.status, e.status]).toEqual(["fulfilled", "fulfilled"]);
      const owed = await payments.getOwedSummary(db, "S_004");
      expect(owed.shiftsOwed).toBe(140);
      expect(owed.unpaidShifts.map((s) => s.attendanceId)).toEqual([aid(DAY, "S_004")]);
    });
  });
});
