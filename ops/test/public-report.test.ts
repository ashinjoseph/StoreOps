// PublicReport: modules/public-report.ts, the payloads of the two no-login pages, against a real
// database with invented people.
//
// Ported here from the old suites, assertion for assertion (server side):
//   - tests/suites/public-report.js: the sales payload publishes aggregates and nothing else (no
//     session rows, no staff name / id, no session / sales id, no cashier-typed notes; a day carries
//     only dateStr, total, sessionCount, byCompany) and enough to draw the page (totals, companies,
//     the session count as a count, the insights, the window, when it was built); the window is the
//     last N days ending today (60 → 2026-09-22..2026-11-20, 7 starts later); junk and 0 mean 60;
//     the rows are never fetched (the dashboard is asked for one row, page 1, over the window); a
//     section that cannot load says so (the payload still comes back, the window survives, the
//     failure is named, no totals invented); a card figure nothing measured is omitted, not zeroed
//     (cardMeasured and cardVar null, the claim still published); a measured day reports measured
//     minus claimed; newest day first, clean and flagged days counted; days outside the window are
//     not published; an empty window explains itself; every section is wrapped (each names its
//     problem, the header still says when and over what window).
//   - tests/suites/parity.js (the app and the public page agree): the public sales payload's totals
//     and daily figures are the dashboard's own, for the same window.
//   - tests/suites/reconcile.js, the three PublicReport.build assertions reconcile.test.ts left for
//     this card: the real reconcile rows through the real report, blank stays blank (null, not 0).
// Plus the rules of this card: what the public payload holds and nothing else (a walk over every key
// and value, over a database planted with distinctive private values), the fields it does expose
// (names, notes, per-person cash: kept, as the old payload had them), the query count per page (no
// query per row), and a section's failure never publishing the error's text.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, type Db } from "../src/db/client";
import { Config, loadConfig } from "../src/lib/config";
import * as dashboard from "../src/modules/sales-dashboard";
import * as pr from "../src/modules/public-report";
import { createTestDb, type TestDb } from "./helpers/db";

vi.mock("../src/modules/sales-dashboard", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/modules/sales-dashboard")>();
  return { ...m, getDashboard: vi.fn(m.getDashboard) };
});

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

// Friday 20 November 2026, 10:30 Toronto (UTC-5).
const NOW = new Date("2026-11-20T15:30:00Z");

/** Distinctive private values planted around the report's data: none may reach a public payload. */
const PRIVATE = {
  rate: 47.1234,
  owedRate: 52.9876,
  pinHash: "pbkdf2-sha256$100000$PRIVSALTq8$PRIVHASHz3",
  email: "avery.private@example.test",
  staffNote: "PRIVATE-STAFF-NOTE-7Q",
  phone: "14165550199",
  merchant: "MERCHANT-PRIV-77",
  reportUrl: "https://private.example.test/exec?k=PRIVURL",
  audit: "AUDIT-PRIV-TEXT-9X",
  miscNote: "MISC-PRIV-NOTE-4K",
  openingNote: "OPENING-PRIV-NOTE-2M",
  sessionNote: "SESSION-PRIV-NOTE-5T",
  tokenHex: "ab".repeat(32),
  validatedBy: "S_PRIV_VALIDATOR",
};
const STAFF_IDS = ["S_PA", "S_PB", "S_PC"];

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

const TABLES = ["audit_log", "sessions", "validation_results", "cash_handover_items", "cash_handovers", "sales", "till_sessions", "attendance", "staff", "config"];

async function setConfig(rows: Record<string, string>): Promise<void> {
  await owner.query("delete from ops.config");
  for (const [k, v] of Object.entries(rows)) await owner.query("insert into ops.config (key, value) values ($1, $2)", [k, v]);
}

const BASE_CONFIG = {
  cash_manager_staff_id: "S_PB",
  cash_handover_stale_days: "7",
  lotto_reserve_default: "500",
  whatsapp_target_number: PRIVATE.phone,
  clover_vape_merchant_id: PRIVATE.merchant,
  public_report_url: PRIVATE.reportUrl,
};

interface Sess {
  id: string;
  staff: string;
  company: "cstore" | "vape";
  date: string;
  removed: number;
  lotto?: number | null;
  topup?: number | null;
  note?: string | null;
  end: string;
}

async function sess(o: Sess): Promise<void> {
  const att = `A_${o.date.replace(/-/g, "")}_${o.staff}`;
  await owner.query(
    "insert into ops.attendance (attendance_id, staff_id, date, status, rate_at_attendance) values ($1, $2, $3, 'worked', $4) on conflict do nothing",
    [att, o.staff, o.date, PRIVATE.owedRate],
  );
  await owner.query(
    `insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status, start_time, end_time, expected_opening, opening_float, opening_note,
       closing_cash_counted, cash_left_in_till, cash_removed_at_close, expected_cash, closing_variance, variance_status, notes, lotto_reserve_counted, lotto_topup_from_till, lotto_reserve_note)
     values ($1,$2,$3,$4,$5,'closed',$6,$7,100,100,$8,$9,100,$10,$9,0,'OK',$11,$12,$13,$14)`,
    [o.id, att, o.staff, o.company, o.date, new Date(new Date(o.end).getTime() - 8 * 3_600_000), o.end, PRIVATE.openingNote, 100 + o.removed, o.removed, PRIVATE.sessionNote, o.lotto ?? null, o.topup ?? null, o.note ?? null],
  );
}

async function sale(id: string, sessionId: string, staff: string, company: string, date: string, f: Record<string, number | string | null>): Promise<void> {
  const cols = Object.keys(f);
  await owner.query(
    `insert into ops.sales (sales_id, session_id, staff_id, company, date, ${cols.join(", ")}) values ($1,$2,$3,$4,$5,${cols.map((_, i) => `$${i + 6}`).join(",")})`,
    [id, sessionId, staff, company, date, ...cols.map((c) => f[c])],
  );
}

async function vr(id: string, date: string, f: { companies: string; counted: number; variance: number; card: number; clover: number | null; status: string; at: string }): Promise<void> {
  await owner.query(
    `insert into ops.validation_results (validation_id, business_date, merchant, companies, cashier_card, clover_card, card_variance, cash_counted, cash_variance, status, mode, validated_at, validated_by, cash_sales, session_ids)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'auto',$11,$12,$8,'X')`,
    [id, date, PRIVATE.merchant, f.companies, f.card, f.clover, f.clover === null ? null : f.clover - f.card, f.counted, f.variance, f.status, f.at, PRIVATE.validatedBy],
  );
}

/** The planted store: two cashiers holding cash, a cash manager, a week of reconciliations, a lotto note, one live and one voided handover. */
async function plant(): Promise<void> {
  for (const t of TABLES) await owner.query(`delete from ops.${t}`);
  await setConfig(BASE_CONFIG);
  for (const [id, name, role] of [
    ["S_PA", "Avery Fictional", "employee"],
    ["S_PB", "Blake Fictional", "manager"],
    ["S_PC", "Casey Fictional", "employee"],
  ]) {
    await owner.query(
      "insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized, email, notes, pin_hash) values ($1,$2,$3,true,$4,'cstore,vape',$5,$6,$7)",
      [id, name, PRIVATE.rate, role, PRIVATE.email, PRIVATE.staffNote, PRIVATE.pinHash],
    );
  }
  await sess({ id: "CST-20261119-S_PA", staff: "S_PA", company: "cstore", date: "2026-11-19", removed: 345.67, lotto: 480, topup: 0, note: "paid a winner", end: "2026-11-20T03:00:00Z" });
  await sess({ id: "VAP-20261118-S_PA", staff: "S_PA", company: "vape", date: "2026-11-18", removed: 120, end: "2026-11-19T01:00:00Z" });
  await sess({ id: "CST-20261117-S_PC", staff: "S_PC", company: "cstore", date: "2026-11-17", removed: 210.5, lotto: 500, topup: 25, end: "2026-11-18T03:00:00Z" });
  await sale("SL_PRIV_1", "CST-20261119-S_PA", "S_PA", "cstore", "2026-11-19", { cash_sales: 600, card_total_sales: 900, misc_notes: PRIVATE.miscNote });
  await sale("SL_PRIV_2", "VAP-20261118-S_PA", "S_PA", "vape", "2026-11-18", { cash_sales: 150, credit_card_sales: 60, debit_card_sales: 40, misc_notes: PRIVATE.miscNote });
  await sale("SL_PRIV_3", "CST-20261117-S_PC", "S_PC", "cstore", "2026-11-17", { cash_sales: 500, card_total_sales: 700 });
  await vr("VR_P1", "2026-11-19", { companies: "cstore", counted: 700, variance: -10, card: 1240, clover: null, status: "OK", at: "2026-11-20T03:05:00Z" });
  await vr("VR_P2", "2026-11-18", { companies: "vape", counted: 300, variance: 0, card: 400, clover: 395, status: "investigate", at: "2026-11-19T03:05:00Z" });
  await vr("VR_P3", "2026-11-17", { companies: "vape", counted: 250, variance: 0, card: 100, clover: 100, status: "OK", at: "2026-11-18T03:05:00Z" });
  await vr("VR_P4", "2026-08-01", { companies: "cstore", counted: 1, variance: 0, card: 1, clover: 1, status: "OK", at: "2026-08-02T03:05:00Z" });
  await owner.query(
    `insert into ops.cash_handovers (handover_id, from_staff_id, to_staff_id, amount, handed_on, recorded_by, recorded_at, method, status, notes)
     values ('H_P1','S_PA','S_PB',50,'2026-11-19','S_PB','2026-11-19T20:00:00Z','cash','recorded','handed at close'),
            ('H_P2','S_PC','S_PB',10,'2026-11-18','S_PB','2026-11-18T20:00:00Z','cash','voided','typed in error'),
            ('H_P3','S_PC','S_PB',75,'2026-10-01','S_PB','2026-10-01T20:00:00Z','cash','recorded','long ago')`,
  );
  await owner.query("insert into ops.cash_handover_items (item_id, handover_id, session_id, amount) values ('I_P1','H_P1','VAP-20261118-S_PA',50)");
  await owner.query("insert into ops.audit_log (log_id, actor_id, action, details) values ('L_P1','S_PA','login.success',$1)", [PRIVATE.audit]);
  await owner.query("insert into ops.sessions (token_hash, staff_id, created_at, expires_at) values (decode($1, 'hex'), 'S_PA', $2, $3)", [PRIVATE.tokenHex, "2026-11-20T10:00:00Z", "2026-11-21T10:00:00Z"]);
}

async function deps(now = NOW): Promise<pr.PublicDeps> {
  return { config: await loadConfig(db), now };
}

/** Every key and every scalar value in `v`, with its path. */
function walk(v: unknown, path = "$", out: { path: string; key?: string; value?: unknown }[] = []) {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, out));
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push({ path: `${path}.${k}`, key: k });
      walk(x, `${path}.${k}`, out);
    }
  } else out.push({ path, value: v });
  return out;
}

/** Every leaf path of `v` with the array indices replaced by [], deduplicated: the payload's shape. */
function shape(v: unknown): string[] {
  const paths = walk(v)
    .filter((e) => e.key === undefined)
    .map((e) => e.path.replace(/\[\d+\]/g, "[]"));
  return [...new Set(paths)].sort();
}

function assertNothingPrivate(payload: unknown): void {
  const entries = walk(payload);
  const text = JSON.stringify(payload);
  for (const id of [...STAFF_IDS, PRIVATE.validatedBy]) expect(text, `staff id ${id}`).not.toContain(id);
  for (const s of [PRIVATE.pinHash, "PRIVSALT", "PRIVHASH", "pbkdf2", PRIVATE.email, PRIVATE.staffNote, PRIVATE.phone, PRIVATE.merchant, PRIVATE.reportUrl, "PRIVURL", PRIVATE.audit, PRIVATE.miscNote, PRIVATE.openingNote, PRIVATE.sessionNote, PRIVATE.tokenHex, "SL_PRIV", "H_P", "I_P", "VR_P", "CST-2026", "VAP-2026", "A_2026", "login.success"]) {
    expect(text, s).not.toContain(s);
  }
  for (const e of entries) {
    if (typeof e.value === "number") {
      expect(e.value, `${e.path} is a pay rate`).not.toBe(PRIVATE.rate);
      expect(e.value, `${e.path} is an owed rate`).not.toBe(PRIVATE.owedRate);
    }
    if (e.key !== undefined) expect(e.key, e.path).not.toMatch(/staff_?id|session_?id|sales_?id|handover_?id|token|^pin|pinhash|^rate|rate$|hourly|phone|email|merchant|audit|wage|owed|password|secret/i);
  }
}

describe("the recon payload (PublicReport.build)", () => {
  beforeEach(plant);

  it("has exactly the old payload's shape, every field (the fields the public sees today)", async () => {
    const p = await pr.build(db, 7, await deps());
    expect(Object.keys(p)).toEqual(["days", "fromStr", "toStr", "generatedAt", "reserve", "cash", "reconcile"]);
    expect(shape(p)).toEqual(
      [
        "$.days", "$.fromStr", "$.toStr", "$.generatedAt",
        "$.reserve.expected", "$.reserve.current", "$.reserve.currentDate", "$.reserve.shortfall", "$.reserve.movedIn",
        "$.reserve.rows[].dateStr", "$.reserve.rows[].counted", "$.reserve.rows[].topup", "$.reserve.rows[].shortfall", "$.reserve.rows[].note", "$.reserve.rows[].traded",
        "$.cash.total", "$.cash.holders[].name", "$.cash.holders[].total", "$.cash.holders[].shifts", "$.cash.holders[].oldest", "$.cash.holders[].oldestAge",
        "$.cash.staleDays", "$.cash.cashManager",
        "$.cash.moves[].dateStr", "$.cash.moves[].from", "$.cash.moves[].to", "$.cash.moves[].amount", "$.cash.moves[].recordedBy", "$.cash.moves[].notes",
        "$.cash.movedTotal", "$.cash.byDay[].dateStr", "$.cash.byDay[].movedIn",
        "$.reconcile.rows[].dateStr", "$.reconcile.rows[].companies", "$.reconcile.rows[].cashClaimed", "$.reconcile.rows[].cashMeasured", "$.reconcile.rows[].cashVar",
        "$.reconcile.rows[].cardClaimed", "$.reconcile.rows[].cardMeasured", "$.reconcile.rows[].cardVar", "$.reconcile.rows[].status",
        "$.reconcile.okCount", "$.reconcile.flagged",
      ].sort(),
    );
  });

  it("holds no staff id, PIN hash, pay rate, phone number, token, config text, audit text, merchant id or recipient", async () => {
    for (const days of [1, 7, 31]) assertNothingPrivate(await pr.build(db, days, await deps()));
  });

  it("PUBLIC TODAY: names who holds cash and how much, who handed what to whom, and the notes people typed", async () => {
    const p = (await pr.build(db, 7, await deps())) as any;
    expect(p.cash.holders.map((h: any) => [h.name, h.total, h.shifts, h.oldest, h.oldestAge])).toEqual([
      ["Avery Fictional", 415.67, 2, "2026-11-18", 2],
      ["Casey Fictional", 210.5, 1, "2026-11-17", 3],
    ]);
    expect(p.cash.total).toBe(626.17);
    expect(p.cash.cashManager).toBe("Blake Fictional");
    expect(p.cash.moves).toEqual([{ dateStr: "2026-11-19", from: "Avery Fictional", to: "Blake Fictional", amount: 50, recordedBy: "Blake Fictional", notes: "handed at close" }]);
    // The lotto note a cashier typed, as typed.
    expect(p.reserve.rows.filter((r: any) => r.note).map((r: any) => r.note)).toEqual(["paid a winner"]);
  });

  it("a voided handover and one before the window are not published", async () => {
    const p = (await pr.build(db, 7, await deps())) as any;
    expect(JSON.stringify(p.cash)).not.toContain("typed in error");
    expect(JSON.stringify(p.cash)).not.toContain("long ago");
    expect(p.cash.movedTotal).toBe(50);
    expect(p.cash.byDay.map((d: any) => d.movedIn)).toEqual([0, 0, 0, 0, 0, 50, 0]);
  });

  it("the reserve: one row per day of the window; a count is filed under the day before its own (the old dayKey_ reads 'yyyy-MM-dd' as UTC)", async () => {
    const p = (await pr.build(db, 7, await deps())) as any;
    expect(p.reserve.rows.map((r: any) => r.dateStr)).toEqual(["2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
    // The 19th's count (480, short 20) is under the 18th, the 17th's under the 16th: as the old page shows them.
    expect(p.reserve.rows[4]).toEqual({ dateStr: "2026-11-18", counted: 480, topup: 0, shortfall: 20, note: "paid a winner", traded: true });
    expect(p.reserve.rows[2]).toEqual({ dateStr: "2026-11-16", counted: 500, topup: 25, shortfall: 0, note: "", traded: true });
    // A day nobody counted is null (not 0), and not traded.
    expect(p.reserve.rows[5]).toEqual({ dateStr: "2026-11-19", counted: null, topup: 0, shortfall: 0, note: "", traded: false });
    expect(p.reserve).toMatchObject({ expected: 500, current: 480, currentDate: "2026-11-18", shortfall: 20, movedIn: 25 });
  });

  it("no count ever: current and shortfall are null, not 0", async () => {
    await owner.query("update ops.till_sessions set lotto_reserve_counted = null");
    const p = (await pr.build(db, 7, await deps())) as any;
    expect(p.reserve.current).toBeNull();
    expect(p.reserve.shortfall).toBeNull();
    expect(p.reserve.currentDate).toBe("");
    expect(p.reserve.rows.every((r: any) => r.counted === null && r.traded === false)).toBe(true);
  });

  it("a card figure nothing measured is omitted, not zeroed (blank stays blank through the real reconcile rows)", async () => {
    const r = (await pr.build(db, 7, await deps())).reconcile as any;
    const unmeasured = r.rows.find((x: any) => x.dateStr === "2026-11-19");
    expect(unmeasured.cardMeasured).toBeNull();
    expect(unmeasured.cardVar).toBeNull();
    expect(unmeasured.cardClaimed).toBe(1240);
    expect(unmeasured.cardMeasured !== 0 && unmeasured.cardVar !== -1240).toBe(true);
    expect(unmeasured).toMatchObject({ cashClaimed: 710, cashMeasured: 700, cashVar: -10, companies: "cstore", status: "OK" });
  });

  it("a day that was measured reports measured minus claimed", async () => {
    const r = (await pr.build(db, 7, await deps())).reconcile as any;
    const measured = r.rows.find((x: any) => x.dateStr === "2026-11-18");
    expect(measured.cardMeasured).toBe(395);
    expect(measured.cardVar).toBe(-5);
  });

  it("says whether the window was clean: newest first, clean and flagged counted", async () => {
    const r = (await pr.build(db, 7, await deps())).reconcile as any;
    expect(r.rows.map((x: any) => x.dateStr)).toEqual(["2026-11-19", "2026-11-18", "2026-11-17"]);
    expect(r.okCount).toBe(2);
    expect(r.flagged).toBe(1);
  });

  it("days outside the window are not published", async () => {
    const r = (await pr.build(db, 7, await deps())).reconcile as any;
    expect(r.rows.every((x: any) => x.dateStr >= "2026-11-14")).toBe(true);
    const one = (await pr.build(db, 1, await deps())) as any;
    expect(one.fromStr).toBe("2026-11-20");
    expect(one.reconcile).toEqual({ rows: [], note: "Nothing reconciled in this window yet." });
  });

  it("an empty window explains itself", async () => {
    await owner.query("delete from ops.validation_results");
    const r = (await pr.build(db, 7, await deps())).reconcile as any;
    expect(r.rows).toEqual([]);
    expect(r.note).toBe("Nothing reconciled in this window yet.");
  });

  it("the window: the last N days ending today in Toronto; the days echoed; junk, 0 and null are 7", async () => {
    const p = await pr.build(db, 7, await deps());
    expect([p.fromStr, p.toStr, p.days, p.generatedAt]).toEqual(["2026-11-14", "2026-11-20", 7, "2026-11-20 10:30:00"]);
    for (const junk of ["abc", 0, null, undefined]) expect((await pr.build(db, junk, await deps())).days).toBe(7);
    expect((await pr.build(db, "14", await deps())).days).toBe(14);
    // 23:59 Toronto is still the 20th; 00:30 Toronto on the 21st is the 21st.
    expect((await pr.build(db, 7, await deps(new Date("2026-11-21T04:59:00Z")))).toStr).toBe("2026-11-20");
    expect((await pr.build(db, 7, await deps(new Date("2026-11-21T05:30:00Z")))).toStr).toBe("2026-11-21");
  });

  it("a negative window has no first day: it throws as the old code did (the page never passes one)", async () => {
    await expect(pr.build(db, -3, await deps())).rejects.toThrow("Cannot read properties of undefined (reading 'key')");
  });

  it("every section is wrapped: one failing never takes the page, and its error text is never published", async () => {
    const leaky = new Error('relation "ops.secret_table" does not exist: SECRET-VALUE-42');
    const failing: Db = {
      query: async () => {
        throw leaky;
      },
      one: async () => {
        throw leaky;
      },
      maybeOne: async () => {
        throw leaky;
      },
    };
    const logged: unknown[] = [];
    const half = (await pr.build(failing, 7, { ...(await deps()), log: (e) => logged.push(e) })) as any;
    expect(half.reserve).toEqual({ unavailable: "not available" });
    expect(half.cash).toEqual({ unavailable: "not available" });
    expect(half.reconcile).toEqual({ unavailable: "not available" });
    expect(half.generatedAt).toBe("2026-11-20 10:30:00");
    expect(half.days).toBe(7);
    expect(JSON.stringify(half)).not.toMatch(/secret_table|SECRET-VALUE|relation/);
    expect(logged).toHaveLength(3);
    expect(logged[0]).toEqual({ event: "public_report.section_failed", section: "reserve", errorClass: "Error", message: leaky.message });
  });

  it("one section failing leaves the others whole", async () => {
    const onlyReconcileFails: Db = {
      query: (t, p) => (/validation_results/.test(t) ? Promise.reject(new Error("boom")) : db.query(t, p)),
      one: (t, p) => db.one(t, p),
      maybeOne: (t, p) => db.maybeOne(t, p),
    };
    const p = (await pr.build(onlyReconcileFails, 7, await deps())) as any;
    expect(p.reconcile).toEqual({ unavailable: "not available" });
    expect(p.cash.total).toBe(626.17);
    expect(p.reserve.current).toBe(480);
  });
});

describe("the sales payload (PublicReport.buildSales)", () => {
  beforeEach(plant);

  it("publishes aggregates and nothing else", async () => {
    const p = (await pr.buildSales(db, 60, await deps())) as any;
    const blob = JSON.stringify(p);
    expect(p.rows).toBeUndefined();
    for (const k of ["staffName", "staffId", "sessionId", "salesId", "miscNotes"]) expect(blob).not.toContain(k);
    expect(blob).not.toContain("Avery");
    expect(Object.keys(p.daily[0]).sort()).toEqual(["byCompany", "dateStr", "sessionCount", "total"]);
    expect(Object.keys(p)).toEqual(["days", "generatedAt", "fromStr", "toStr", "totals", "companies", "sessionCount", "daily", "insights"]);
    assertNothingPrivate(p);
  });

  it("…and enough to draw the page", async () => {
    const p = (await pr.buildSales(db, 60, await deps())) as any;
    expect(p.totals.total).toBe(2950); // 600 + 900, 150 + 60 + 40, 500 + 700
    expect(p.companies).toEqual(["cstore", "vape"]);
    expect(p.sessionCount).toBe(3);
    expect(p.insights).toBeTruthy();
    expect(p.fromStr && p.toStr && p.generatedAt).toBeTruthy();
  });

  it("the window is the last N days ending today; the days echoed; junk and 0 are 60", async () => {
    let p = (await pr.buildSales(db, 60, await deps())) as any;
    expect([p.fromStr, p.toStr, p.days]).toEqual(["2026-09-22", "2026-11-20", 60]);
    p = await pr.buildSales(db, 7, await deps());
    expect(p.fromStr).toBe("2026-11-14");
    expect(((await pr.buildSales(db, "abc", await deps())) as any).days).toBe(60);
    expect(((await pr.buildSales(db, 0, await deps())) as any).days).toBe(60);
  });

  it("the rows are never fetched, only the aggregates: the dashboard is asked for one row, page 1, over the window", async () => {
    const spy = vi.mocked(dashboard.getDashboard);
    spy.mockClear();
    await pr.buildSales(db, 60, await deps());
    expect(spy).toHaveBeenCalledTimes(1);
    const q = spy.mock.calls[0]![1];
    expect(q.pageSize).toBe(1);
    expect(q.page).toBe(1);
    expect(q.startDate).toEqual(new Date("2026-09-22T04:00:00Z")); // Toronto midnight (EDT)
    expect(q.endDate).toEqual(new Date("2026-11-21T04:59:59Z")); // 23:59:59 Toronto, as the old code
  });

  it("agrees with the dashboard the app shows, figure for figure (parity.js)", async () => {
    const p = (await pr.buildSales(db, 7, await deps())) as any;
    const d = await dashboard.getDashboard(db, { startDate: "2026-11-14", endDate: "2026-11-20", pageSize: 500 });
    expect(p.totals).toEqual(d.totals);
    expect(p.daily.map((x: any) => [x.dateStr, x.total])).toEqual(d.daily.map((x) => [x.dateStr, x.total]));
    expect(p.totals.cardAll).toBe(1700); // credit + debit + card_total (hard rule 3)
    expect(p.totals.cash).toBe(1250);
  });

  it("a section that cannot load says so instead of taking the page down, and names no internal error", async () => {
    vi.mocked(dashboard.getDashboard).mockRejectedValueOnce(new Error("Sales sheet is missing: SECRET-SALES"));
    const broken = (await pr.buildSales(db, 60, await deps())) as any;
    expect(broken.days).toBe(60);
    expect(broken.unavailable).toBe("not available");
    expect(broken.totals).toBeUndefined();
    expect(JSON.stringify(broken)).not.toContain("SECRET");
  });
});

describe("cost: queries per page", () => {
  beforeEach(plant);

  const counting = (inner: Db) => {
    const seen: string[] = [];
    const wrap: Db = {
      query: (t, p) => (seen.push(t), inner.query(t, p)),
      one: (t, p) => (seen.push(t), inner.one(t, p)),
      maybeOne: (t, p) => (seen.push(t), inner.maybeOne(t, p)),
    };
    return { wrap, seen };
  };

  // Recon: the lotto log 2 (the window's cstore sessions; the last count), cash 7 (staff, settled
  // items, every session; the cash manager; staff, handovers, their items), reconcile 1. The heaviest
  // are the two reads of every till session (getAllOutstanding's, as the old code read the tab).
  it("recon: 10 queries, whatever the data and the window (none per row)", async () => {
    const config = await loadConfig(db);
    const a = counting(db);
    await pr.build(a.wrap, 7, { config, now: NOW });
    expect(a.seen).toHaveLength(10);
    // More rows, a longer window: the same number of queries.
    for (let i = 1; i <= 20; i++) {
      const d = `2026-10-${String(i).padStart(2, "0")}`;
      await sess({ id: `CST-${d.replace(/-/g, "")}-S_PC`, staff: "S_PC", company: "cstore", date: d, removed: 10, lotto: 500, end: `${d}T23:00:00Z` });
      await vr(`VR_X${i}`, d, { companies: "cstore", counted: 1, variance: 0, card: 1, clover: null, status: "OK", at: `${d}T23:30:00Z` });
    }
    const b = counting(db);
    await pr.build(b.wrap, 31, { config, now: NOW });
    expect(b.seen).toHaveLength(10);
  });

  it("recon with no lotto count ever: one more (the old diagnostic reads every session)", async () => {
    await owner.query("update ops.till_sessions set lotto_reserve_counted = null");
    const a = counting(db);
    await pr.build(a.wrap, 7, { config: await loadConfig(db), now: NOW });
    expect(a.seen).toHaveLength(11);
  });

  it("sales: 2 queries", async () => {
    const a = counting(db);
    await pr.buildSales(a.wrap, 365, { config: await loadConfig(db), now: NOW });
    expect(a.seen).toHaveLength(2);
  });
});

describe("settings that change the payload", () => {
  beforeEach(plant);

  it("no cash manager: null; one who matches nobody: null", async () => {
    await owner.query("update ops.config set value = '' where key = 'cash_manager_staff_id'");
    expect(((await pr.build(db, 7, await deps())).cash as any).cashManager).toBeNull();
    await owner.query("update ops.config set value = 'S_NOBODY' where key = 'cash_manager_staff_id'");
    expect(((await pr.build(db, 7, await deps())).cash as any).cashManager).toBeNull();
  });

  it("stale after 2 days: the older shifts are listed by name", async () => {
    await owner.query("update ops.config set value = '2' where key = 'cash_handover_stale_days'");
    const c = (await pr.build(db, 7, await deps())).cash as any;
    expect(c.staleDays).toBe(2);
    expect(c.stale).toEqual([
      { name: "Casey Fictional", dateStr: "2026-11-17", remaining: 210.5, ageDays: 3 },
      { name: "Avery Fictional", dateStr: "2026-11-18", remaining: 70, ageDays: 2 },
    ]);
  });

  it("the lotto reserve expected: every shortfall follows it", async () => {
    await owner.query("update ops.config set value = '650' where key = 'lotto_reserve_default'");
    const r = (await pr.build(db, 7, await deps())).reserve as any;
    expect(r.expected).toBe(650);
    expect(r.shortfall).toBe(170);
  });
});

describe("Config.fromRows works for a payload with no settings at all", () => {
  it("builds with the defaults", async () => {
    await plant();
    const p = await pr.build(db, 7, { config: Config.fromRows([]), now: NOW });
    expect((p.cash as any).cashManager).toBeNull();
    expect((p.reserve as any).expected).toBe(500);
  });
});
