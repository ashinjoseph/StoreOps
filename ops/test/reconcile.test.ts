// Reconcile: modules/reconcile.ts and handlers/reconcile.ts, against a real database with invented
// people and a fake network (no test reaches Clover or Meta).
//
// Ported here from the old suites, assertion for assertion (server side):
//   - tests/suites/reconcile.js: not configured is not unavailable (cloverNA, no card diff, no
//     Clover figure invented, blank cashier credit, the card figure kept); a genuine outage still
//     warns; a clean unverified day reports no variance (the five parameter checks); card checks
//     cannot fire without a measurement (OK at a zero threshold, "✅ Cash matched"); a real cash
//     shortfall still surfaces; each template gets its own count (11 / 12, no lotto line on vape);
//     the shape follows the TEMPLATE even when Clover state disagrees; unset keys fall back to the
//     shared template and its 13-parameter shape; a failed send says why (till, template, count,
//     FAILED); the plain-text fallback matches its shape; blank survives the round trip (getRecent
//     reads null, a measured zero stays 0); with Clover switched off the automatic reconcile still
//     runs and sends, and cards are out of scope rather than an outage.
//     NOT ported here: the three PublicReport.build assertions (the public page is the PublicReport
//     card's port; getRecent's nulls, which those assertions depend on, are held down below).
//     The old suite stubbed Clover, Sales, Staff, CashHandling and the Notifier; these run the real
//     modules over a fake fetch, so "the params sent" are read from the request body sent to Meta.
//   - tests/suites/link.js: no link when blank or absent (and no orphan label, the message still
//     sent and signed off); ?v=sales appended; &v=sales after an existing query (one "?"); sales,
//     not recon; trimmed; the link after the cash lines and before the sign-off.
// Plus the rules of the port: the advisory lock (two runs at once write the day once), the token
// never leaking, clover_enabled never gating a message, a failed send reported in the answer and
// the audit row, the foreign Clover host, the refusals (mode, a figure too large to store), the
// history's limits and order, and the two RPCs' arguments.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { Config, loadConfig } from "../src/lib/config";
import * as reconcile from "../src/modules/reconcile";
import { rpcGetReconciliation, rpcReconcileDay } from "../src/rpc/handlers/reconcile";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let db2: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

// Friday 20 November 2026, 22:05 Toronto (UTC-5).
const NOW = new Date("2026-11-21T03:05:00Z");
const DAY = "2026-11-20";
const WA_TOKEN = "test-wa-token-Hk2";
const CLOVER_TOKEN = "test-clover-vape-Zq81xV";
const META_URL = "https://graph.facebook.com/v21.0/100000000000001/messages";

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
  notifier_enabled: "TRUE",
  whatsapp_api_url: META_URL,
  whatsapp_target_number: "14165550100",
  cstore_card_split: "false",
  // Clover on, for vape only (cstore is on ePOS): as the old suite's stub.
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

beforeEach(async () => {
  for (const t of ["audit_log", "validation_results", "cash_handover_items", "cash_handovers", "sales", "till_sessions", "attendance", "staff", "config"]) await owner.query(`delete from ops.${t}`);
  for (const [id, name, role] of [
    ["S_001", "Ada Quill", "admin"],
    ["S_002", "Bram Hale", "manager"],
    ["S_004", "Ashin Vale", "employee"],
    ["S_005", "Meera Stone", "employee"],
    ["S_006", "Fay Ortega", "payroll_admin"],
  ]) {
    await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized) values ($1,$2,17,true,$3,'cstore,vape')", [id, name, role]);
  }
  await setConfig();
});

// ── The day's data (the old suite's sess(), saleSplit(), saleTotal()) ──

interface Sess {
  id: string;
  company: "cstore" | "vape";
  staff?: string;
  float: number;
  counted: number;
  expected: number;
  lotto?: number | null;
  topup?: number;
  status?: string;
  start?: string | null;
  end?: string | null;
  date?: string;
}
/** A till session of today, 09:00 to 21:20 Toronto unless said otherwise. */
async function sess(o: Sess): Promise<void> {
  const staff = o.staff ?? "S_004";
  const date = o.date ?? DAY;
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
      o.start === undefined ? "2026-11-20T14:00:00Z" : o.start,
      o.end === undefined ? "2026-11-21T02:20:00Z" : o.end,
      o.float,
      o.counted,
      Math.round((o.counted - o.float - (o.topup ?? 0)) * 100) / 100,
      o.expected,
      Math.round((o.counted - o.expected) * 100) / 100,
      cstore ? (o.lotto === undefined ? 500 : o.lotto) : null,
      cstore ? (o.topup ?? 0) : null,
    ],
  );
}
type SaleFig = { cash: number; credit?: number | null; debit?: number | null; total?: number | null; miscCash?: number; miscCredit?: number | null; miscDebit?: number | null; miscCard?: number | null };
async function sale(sessionId: string, company: string, f: SaleFig, staff = "S_004", date = DAY): Promise<void> {
  await owner.query(
    `insert into ops.sales (sales_id, session_id, staff_id, company, date, cash_sales, credit_card_sales, debit_card_sales, misc_cash_sales, misc_credit_sales, misc_debit_sales, card_total_sales, misc_card_sales)
     values ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [sessionId, staff, company, date, f.cash, f.credit ?? null, f.debit ?? null, f.miscCash ?? 0, f.miscCredit ?? null, f.miscDebit ?? null, f.total ?? null, f.miscCard ?? null],
  );
}
/** Split shape (vape): credit + debit, no single total. */
const saleSplit = (id: string, c: string, cash: number, cr: number, dr: number) => sale(id, c, { cash, credit: cr, debit: dr, miscCredit: 0, miscDebit: 0 });
/** Single-total shape (cstore on ePOS): blank credit/debit. */
const saleTotal = (id: string, c: string, cash: number, card: number) => sale(id, c, { cash, total: card });

const CST = (over: Partial<Sess> = {}) => sess({ id: "CST-1", company: "cstore", float: 250, counted: 850, expected: 850, ...over });
const VAP = (over: Partial<Sess> = {}) => sess({ id: "VAP-1", company: "vape", float: 60, counted: 111, expected: 111, ...over });

// ── The network ────────────────────────────────────────────

type Reply = { status: number; body?: unknown } | { throws: string };
interface Sent {
  url: string;
  method: string;
  authorization: string | undefined;
  json: any;
}
/** Clover answers from `clover` in order; Meta answers `meta` (default 200) to every send. */
function net(clover: Reply[] = [], meta: Reply | ((n: number) => Reply) = { status: 200, body: { messages: [{ id: "wamid.T" }] } }) {
  const sent: Sent[] = [];
  const queue = [...clover];
  let metaCount = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    sent.push({ url, method: init?.method ?? "GET", authorization: headers.get("authorization") ?? undefined, json: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const r = new URL(url).hostname === "graph.facebook.com" ? (typeof meta === "function" ? meta(metaCount++) : meta) : queue.shift();
    if (!r) throw new Error("unscripted request to " + url);
    if ("throws" in r) throw new Error(r.throws);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null), { status: r.status });
  }) as typeof fetch;
  const meta_ = () => sent.filter((s) => s.url.startsWith("https://graph.facebook.com/"));
  return {
    fetch: f,
    sent,
    clover: () => sent.filter((s) => !s.url.startsWith("https://graph.facebook.com/")),
    /** What each WhatsApp send carried, as the old suite's SENT: { op (the template name), params, plain }. */
    messages: () =>
      meta_().map((s) => ({
        op: s.json.type === "template" ? (s.json.template.name as string) : null,
        params: s.json.type === "template" ? ((s.json.template.components[0]?.parameters ?? []) as { text: string }[]).map((p) => p.text) : [],
        plain: s.json.type === "text" ? (s.json.text.body as string) : null,
      })),
  };
}
type Net = ReturnType<typeof net>;
const card = (cents: number, kind: "credit" | "debit") => ({ amount: cents, result: "SUCCESS", cardTransaction: { type: kind.toUpperCase() }, tender: { label: kind } });
/** The old stub's vapeOk answer: credit 1, debit 50, total 51. */
const VAPE_OK: Reply = { status: 200, body: { elements: [card(100, "credit"), card(5000, "debit")] } };

async function run(n: Net, mode: "auto" | "manual" = "manual", opts: { env?: Record<string, string>; now?: Date; actor?: string; on?: Db } = {}): Promise<any> {
  return withTransaction(opts.on ?? db, async (tx) => reconcile.reconcileDay(tx, { config: await loadConfig(tx), env: opts.env ?? ENV, fetch: n.fetch, now: opts.now ?? NOW }, opts.actor ?? "S_004", mode));
}
const rows = () => db.query<any>("select * from ops.validation_results order by window_start, validation_id");
const audits = () => db.query<any>("select actor_id, action, target_type, target_id, details from ops.audit_log order by seq");

// ── 1. Not configured is not unavailable ────────────────────

describe("a till with no Clover is out of scope, not broken (old: reconcile.js §1)", () => {
  it("flags not-applicable and invents nothing", async () => {
    await CST();
    await saleTotal("CST-1", "cstore", 600, 1240);
    const n = net();
    const res = await run(n);
    const rec = res.merchants[0];
    expect(rec.cloverNA).toBe(true);
    expect(rec.cardsVerified).toBe(false);
    expect(rec.status).toBe("OK");
    expect(rec.cardDiff).toBe(null);
    expect(rec.cloverCard).toBe(null);
    expect(rec.cashierCredit).toBe(null);
    expect(rec.cashierCard).toBe(1240);
    // No merchant id: no Clover request at all.
    expect(n.clover()).toHaveLength(0);
  });

  it("a genuine Clover outage still warns", async () => {
    await VAP();
    await saleSplit("VAP-1", "vape", 51, 1, 50);
    const res = await run(net([{ status: 500, body: "oops" }]));
    expect(res.merchants[0].status).toBe("clover_unavailable");
    expect(res.merchants[0].cloverNA).toBe(false);
    expect(res.merchants[0].cloverError).toBe("http_500");
  });
});

// ── 2. No fictional variance ────────────────────────────────

describe("no fictional variance (old: reconcile.js §2)", () => {
  it("a clean unverified day reports no variance", async () => {
    await setConfig({ whatsapp_template_shift_close_cstore: "shift_close_cstore" });
    await CST();
    await saleTotal("CST-1", "cstore", 600, 1240);
    const n = net();
    await run(n);
    const p = n.messages()[0]!.params;
    expect(p[4]!.indexOf("var")).toBe(-1);
    expect(/cash \$600\.00/.test(p[4]!) && /card \$1240\.00/.test(p[4]!)).toBe(true);
    expect(p[4]!.indexOf("$1840.00")).toBe(0);
    expect(/var \+\$0\.00/.test(p[5]!)).toBe(true);
    expect(p[4]!.indexOf("-$1240")).toBe(-1);
  });

  it("card checks cannot fire without a measurement", async () => {
    await setConfig({ card_variance_threshold: "0", whatsapp_template_shift_close_cstore: "shift_close_cstore" });
    await CST();
    await saleTotal("CST-1", "cstore", 600, 1240);
    const n = net();
    const res = await run(n);
    expect(res.merchants[0].status).toBe("OK");
    expect(n.messages()[0]!.params[10]).toBe("✅ Cash matched");
  });

  it("a real cash shortfall still surfaces", async () => {
    await setConfig({ whatsapp_template_shift_close_cstore: "shift_close_cstore" });
    await CST({ counted: 810, expected: 850 });
    await saleTotal("CST-1", "cstore", 600, 1240);
    const n = net();
    const res = await run(n);
    expect(res.merchants[0].status).toBe("investigate");
    expect(/cash short \$40\.00/.test(n.messages()[0]!.params[10]!)).toBe(true);
  });
});

// ── 3. Shape follows the template ───────────────────────────

describe("shape follows the template (old: reconcile.js §3, ADR-0007)", () => {
  it("each template gets the count it expects", async () => {
    await setConfig({ whatsapp_template_shift_close_cstore: "shift_close_cstore" });
    await CST();
    await saleTotal("CST-1", "cstore", 600, 1240);
    let n = net();
    await run(n);
    expect(n.messages()[0]!.op).toBe("shift_close_cstore");
    expect(n.messages()[0]!.params).toHaveLength(11);

    await owner.query("delete from ops.validation_results");
    await owner.query("delete from ops.sales");
    await owner.query("delete from ops.till_sessions");
    await setConfig({ whatsapp_template_shift_close_vape: "shift_close_vape" });
    await VAP();
    await saleSplit("VAP-1", "vape", 51, 1, 50);
    n = net([VAPE_OK]);
    await run(n);
    expect(n.messages()[0]!.op).toBe("shift_close_vape");
    expect(n.messages()[0]!.params).toHaveLength(12);
    expect(n.messages()[0]!.params.some((x) => /not tracked on this till/.test(x))).toBe(false);
  });

  it("follows the TEMPLATE even when Clover state disagrees (cstore with a merchant that answers)", async () => {
    await setConfig({ whatsapp_template_shift_close_cstore: "shift_close_cstore", clover_cstore_merchant_id: "STILL_SET" });
    await CST();
    await saleTotal("CST-1", "cstore", 600, 1240);
    const n = net([{ status: 200, body: { elements: [card(60000, "credit"), card(64000, "debit")] } }]);
    const res = await run(n, "manual", { env: { ...ENV, CLOVER_CSTORE_TOKEN: "test-x" } });
    expect(res.merchants[0].cloverNA).toBe(false);
    expect(n.messages()[0]!.op).toBe("shift_close_cstore");
    expect(n.messages()[0]!.params).toHaveLength(11);
  });

  it("unset keys fall back to the shared template AND its shape", async () => {
    await VAP();
    await saleSplit("VAP-1", "vape", 51, 1, 50);
    let n = net([VAPE_OK]);
    await run(n);
    expect(n.messages()[0]!.op).toBe("shift_close_v2");
    expect(n.messages()[0]!.params).toHaveLength(13);
    expect(/not tracked on this till/.test(n.messages()[0]!.params[8]!)).toBe(true);

    await owner.query("delete from ops.validation_results");
    await owner.query("delete from ops.sales");
    await owner.query("delete from ops.till_sessions");
    await CST();
    await saleTotal("CST-1", "cstore", 600, 1240);
    n = net();
    await run(n);
    expect(n.messages()[0]!.op).toBe("shift_close_v2");
    expect(n.messages()[0]!.params).toHaveLength(13);
  });

  it("a failed send says why, instead of looking like success", async () => {
    await setConfig({ whatsapp_template_shift_close_cstore: "shift_close_cstore" });
    await CST();
    await saleTotal("CST-1", "cstore", 600, 1240);
    const res = await run(net([], { status: 400, body: { error: { message: "(#132000) Number of parameters does not match the expected number of params" } } }));
    expect(typeof res.whatsappSummary === "string" && res.whatsappSummary.length > 0).toBe(true);
    expect(res.whatsappSummary).toMatch(/cstore/);
    expect(res.whatsappSummary).toMatch(/shift_close_cstore/);
    expect(res.whatsappSummary).toMatch(/\(11\)/);
    expect(res.whatsappSummary).toMatch(/FAILED/);
  });

  it("the plain-text fallback matches the shape it describes", async () => {
    await setConfig({ whatsapp_template_shift_close: null });
    await CST();
    await saleTotal("CST-1", "cstore", 600, 1240);
    const n = net();
    await run(n);
    const plain = n.messages()[0]!.plain!;
    expect(plain.indexOf("Credit  ")).toBe(-1);
    expect(plain.indexOf("Debit   ")).toBe(-1);
    expect(plain).toMatch(/not verified/);
    expect(plain).toMatch(/Cash - recorded \/ counted/);
    expect(plain.indexOf("Clover unavailable")).toBe(-1);
  });
});

// ── 4. Blank survives the round trip ────────────────────────

describe("what was not measured reads back as not measured (old: reconcile.js §3b, ADR-0004)", () => {
  it("stores NULL and reads null; a measured zero stays 0", async () => {
    await CST();
    await VAP();
    await saleTotal("CST-1", "cstore", 600, 1240);
    await saleSplit("VAP-1", "vape", 51, 1, 50);
    await run(net([VAPE_OK]));
    const back = await reconcile.getRecent(db, 10);
    const cst = back.find((r) => r.companies === "cstore")!;
    const vap = back.find((r) => r.companies === "vape")!;
    expect(cst.cloverCard).toBe(null);
    expect(cst.cardVariance).toBe(null);
    expect(cst.cashierCredit).toBe(null);
    expect(cst.cashierCard).toBe(1240);
    expect(vap.cloverCard).toBe(51);
    expect(vap.cardVariance).toBe(0);
    // And in the table itself: NULL, never 0.
    const c = (await rows()).find((r) => r.companies === "cstore");
    expect([c.cashier_credit, c.clover_credit, c.cashier_debit, c.clover_debit, c.clover_card, c.card_variance]).toEqual([null, null, null, null, null, null]);
    expect(c.cashier_card).toBe(1240);
  });
});

// ── 5. Clover off does not switch the message off ───────────

describe("switching Clover off does not switch the close message off (old: reconcile.js §4)", () => {
  it("the automatic reconcile still runs and sends through the till's own template", async () => {
    await setConfig({ clover_enabled: "false", whatsapp_template_shift_close_cstore: "shift_close_cstore" });
    await CST();
    await saleTotal("CST-1", "cstore", 600, 1240);
    const n = net();
    const res = await run(n, "auto");
    expect(res.ready === true && !res.disabled).toBe(true);
    expect(n.messages()).toHaveLength(1);
    expect(n.messages()[0]!.op).toBe("shift_close_cstore");
  });

  it("cards on a till with Clover switched off are out of scope, not an outage", async () => {
    await setConfig({ clover_enabled: "false" });
    await VAP();
    await saleSplit("VAP-1", "vape", 51, 1, 50);
    const n = net();
    const res = await run(n);
    const rec = res.merchants[0];
    expect(rec).toBeTruthy();
    expect(rec.status).not.toBe("clover_unavailable");
    expect(rec.cloverNA).toBe(true);
    expect(rec.cloverCard).toBe(null);
    // Clover was not asked at all.
    expect(n.clover()).toHaveLength(0);
  });
});

// ── link.js: the dashboard link ─────────────────────────────

describe("the public dashboard link (old: link.js)", () => {
  async function bodyWith(url: string | undefined): Promise<string> {
    await owner.query("delete from ops.audit_log");
    await owner.query("delete from ops.validation_results");
    await owner.query("delete from ops.sales");
    await owner.query("delete from ops.till_sessions");
    await setConfig({ whatsapp_template_shift_close: null, public_report_url: url === undefined ? null : url });
    await CST();
    await saleTotal("CST-1", "cstore", 600, 1240);
    const n = net();
    await run(n);
    return n.messages()[0]?.plain ?? "";
  }
  const linkIn = (body: string) => (/Sales dashboard: (\S+)/.exec(body) || [])[1] || null;

  it("nothing configured means no link, not a dead one", async () => {
    const body = await bodyWith("");
    expect(linkIn(body)).toBe(null);
    expect(body.indexOf("Sales dashboard")).toBe(-1);
    expect(body.length > 0).toBe(true);
    expect(body).toMatch(/StoreOps · automated/);
    expect(linkIn(await bodyWith(undefined))).toBe(null);
  });

  it("a plain deployment URL gets the view appended; a query is kept; sales, not recon; trimmed", async () => {
    expect(linkIn(await bodyWith("https://script.google.com/macros/s/AKfy123/exec"))).toBe("https://script.google.com/macros/s/AKfy123/exec?v=sales");
    const q = linkIn(await bodyWith("https://script.google.com/macros/s/AKfy123/exec?foo=1"))!;
    expect(q).toBe("https://script.google.com/macros/s/AKfy123/exec?foo=1&v=sales");
    expect((q.match(/\?/g) || []).length).toBe(1);
    expect(linkIn(await bodyWith("https://x.test/exec"))).toMatch(/v=sales/);
    expect(linkIn(await bodyWith("https://x.test/exec"))).not.toMatch(/v=recon/);
    expect(linkIn(await bodyWith("  https://x.test/exec  "))).toBe("https://x.test/exec?v=sales");
  });

  it("the link sits at the end, after the figures", async () => {
    const body = await bodyWith("https://x.test/exec");
    expect(body.indexOf("Sales dashboard")).toBeGreaterThan(body.indexOf("Cash"));
    expect(body.indexOf("Sales dashboard")).toBeLessThan(body.indexOf("StoreOps · automated"));
  });
});

// ── The run: which sessions, groups, figures ────────────────

describe("which sessions belong to the run", () => {
  it("auto waits while a till is still open; manual does not", async () => {
    await CST();
    await VAP({ status: "open" });
    await saleTotal("CST-1", "cstore", 600, 1240);
    const n = net();
    expect(await run(n, "auto")).toEqual({ ready: false, openCount: 1 });
    expect(await rows()).toHaveLength(0);
    const res = await run(n, "manual");
    expect(res.merchants.map((m: any) => m.sessionIds)).toEqual([["CST-1"]]);
  });

  it("auto skips what is already reconciled today; manual re-checks the whole day", async () => {
    await CST();
    await saleTotal("CST-1", "cstore", 600, 1240);
    const n = net();
    expect((await run(n, "auto")).merchants).toHaveLength(1);
    expect(await run(n, "auto")).toEqual({ ready: true, empty: true });
    await VAP();
    await saleSplit("VAP-1", "vape", 51, 1, 50);
    const third = await run(net([VAPE_OK]), "auto");
    expect(third.merchants.map((m: any) => m.sessionIds)).toEqual([["VAP-1"]]);
    const manual = await run(net([VAPE_OK]), "manual");
    expect(manual.merchants.map((m: any) => m.sessionIds)).toEqual([["CST-1"], ["VAP-1"]]);
    expect((await rows()).map((r) => `${r.companies}:${r.mode}`).sort()).toEqual(["cstore:auto", "cstore:manual", "vape:auto", "vape:manual"]);
  });

  it("nothing closed today is empty; yesterday's sessions are not today's", async () => {
    await sess({ id: "CST-0", company: "cstore", float: 250, counted: 850, expected: 850, date: "2026-11-19", start: "2026-11-19T14:00:00Z", end: "2026-11-20T02:00:00Z" });
    expect(await run(net(), "manual")).toEqual({ ready: true, empty: true });
    expect(await reconcile.hasOpenSessionsToday(db, NOW)).toBe(false);
    await VAP({ status: "open" });
    expect(await reconcile.hasOpenSessionsToday(db, NOW)).toBe(true);
  });

  it("a validated session counts as closed", async () => {
    await CST({ status: "validated" });
    const res = await run(net());
    expect(res.merchants[0].sessionIds).toEqual(["CST-1"]);
  });

  it("two tills on one merchant are one group, one Clover request, one row", async () => {
    await setConfig({ clover_cstore_merchant_id: "VAPE1" });
    await CST();
    await VAP({ start: "2026-11-20T15:00:00Z", end: "2026-11-21T01:00:00Z" });
    await saleTotal("CST-1", "cstore", 600, 1240);
    await saleSplit("VAP-1", "vape", 51, 1, 50);
    const n = net([{ status: 200, body: { elements: [card(124100, "credit"), card(5000, "debit")] } }]);
    const res = await run(n, "manual", { env: { ...ENV, CLOVER_CSTORE_TOKEN: "test-cstore" } });
    expect(res.merchants).toHaveLength(1);
    const m = res.merchants[0];
    expect(m.companies).toEqual(["cstore", "vape"]);
    expect(m.merchant).toBe("VAPE1");
    // The group's window: earliest start to latest end.
    expect([m.windowStart.toISOString(), m.windowEnd.toISOString()]).toEqual(["2026-11-20T14:00:00.000Z", "2026-11-21T02:20:00.000Z"]);
    // cstore came first, so the group uses cstore's connection (its token).
    expect(n.clover()).toHaveLength(1);
    expect(n.clover()[0]!.authorization).toBe("Bearer test-cstore");
    // cstore's single total makes the group unsplit: no credit/debit halves, but the total counts.
    expect(m.cardSplit).toBe(false);
    expect([m.cashierCredit, m.cashierDebit, m.creditDiff, m.debitDiff]).toEqual([null, null, null, null]);
    expect(m.cashierCard).toBe(1291);
    expect(m.cloverCard).toBe(1291);
    expect(m.cardDiff).toBe(0);
    expect((await rows()).map((r) => r.companies)).toEqual(["cstore+vape"]);
  });

  it("a session with no times falls back to the day's midnight and now", async () => {
    await CST({ start: null, end: null });
    const res = await run(net());
    expect(res.merchants[0].windowStart.toISOString()).toBe("2026-11-20T05:00:00.000Z");
    expect(res.merchants[0].windowEnd.toISOString()).toBe(NOW.toISOString());
  });
});

describe("the card comparison (ADR-0005: credit + debit + card_total + the misc three)", () => {
  it("compares a split till's credit, debit and total, cashier minus Clover", async () => {
    await VAP();
    await sale("VAP-1", "vape", { cash: 51, credit: 10, debit: 40, miscCredit: 2.5, miscDebit: 1.25 });
    const res = await run(net([{ status: 200, body: { elements: [card(1000, "credit"), card(4000, "debit")] } }]));
    const m = res.merchants[0];
    expect([m.cashierCredit, m.cloverCredit, m.creditDiff]).toEqual([12.5, 10, 2.5]);
    expect([m.cashierDebit, m.cloverDebit, m.debitDiff]).toEqual([41.25, 40, 1.25]);
    expect([m.cashierCard, m.cloverCard, m.cardDiff]).toEqual([53.75, 50, 3.75]);
    expect(m.status).toBe("investigate");
  });

  it("compares a single-total till on its card total and misc card figure", async () => {
    await VAP();
    await sale("VAP-1", "vape", { cash: 51, total: 45.5, miscCard: 5.5 });
    const res = await run(net([VAPE_OK]));
    const m = res.merchants[0];
    expect(m.cardSplit).toBe(false);
    expect(m.cashierCard).toBe(51);
    expect(m.cardDiff).toBe(0);
    expect(m.status).toBe("OK");
  });

  it("within the card threshold is OK; just over it is investigate", async () => {
    await VAP();
    await saleSplit("VAP-1", "vape", 51, 2, 50);
    expect((await run(net([VAPE_OK]))).merchants[0].status).toBe("OK"); // off by $1.00
    await owner.query("delete from ops.validation_results");
    await owner.query("update ops.sales set credit_card_sales = 2.01");
    expect((await run(net([VAPE_OK]))).merchants[0].status).toBe("investigate"); // off by $1.01
  });

  it("the cash band: within variance_ok_threshold is OK, over it is investigate (one threshold here)", async () => {
    await setConfig({ clover_enabled: "false" });
    await VAP({ counted: 112, expected: 111 });
    expect((await run(net())).merchants[0].status).toBe("OK");
    await owner.query("delete from ops.validation_results");
    await owner.query("update ops.till_sessions set closing_variance = 12.4");
    expect((await run(net())).merchants[0].status).toBe("investigate");
  });
});

describe("the lotto reserve and where the cash went", () => {
  it("hangs the pot off the cstore group only, with the shortfall and the reason", async () => {
    await CST({ lotto: 450 });
    await owner.query("update ops.till_sessions set lotto_reserve_note = 'paid a winning ticket' where session_id = 'CST-1'");
    await VAP();
    const n = net([VAPE_OK]);
    const res = await run(n);
    const [c, v] = res.merchants;
    expect(c.lotto).toEqual({ balance: 450, expected: 500, shortfall: 50, note: "paid a winning ticket" });
    expect(v.lotto).toBe(null);
    expect(reconcile.lottoParam(c)).toBe("$450.00 - short $50.00 - paid a winning ticket");
    expect(reconcile.reserveLines(c)).toEqual(["\u{1F39F} *Lotto reserve*   $450.00   ⚠️ short $50.00", "\u{21B3} paid a winning ticket"]);
  });

  it("a drawer that closed below its float says so, and nothing is in hand", () => {
    expect(reconcile.destination({ cashBanked: -50, floatLeft: 250, lottoTopup: 0 })).toBe("drawer closed $50.00 below the $250.00 float · nothing in hand");
    expect(reconcile.destination({ cashBanked: 600, floatLeft: 250, lottoTopup: 100 })).toBe("float $250.00 back · reserve $100.00 · $600.00 in hand");
  });

  it("in hand: the standing balance by name, stale shifts, else today's takings", () => {
    expect(reconcile.inHandParam({ cashOutHolders: [{ name: "Ada", total: 12 }], cashOutStale: 1, tookCash: [] })).toBe("Ada $12.00 · ⚠️ 1 shift held over the limit");
    expect(reconcile.inHandParam({ cashOutHolders: [], cashOutStale: 0, tookCash: [] })).toBe("nobody is holding cash");
    expect(reconcile.inHandParam({ cashOutHolders: null, cashOutStale: 0, tookCash: [{ name: "Ada", amount: 5 }] })).toBe("Ada $5.00 (today)");
    expect(reconcile.inHandParam({ cashOutHolders: null, cashOutStale: 0, tookCash: [] })).toBe("nothing taken out today");
  });
});

describe("what is written", () => {
  it("one row per group with the old columns, and one audit row", async () => {
    await CST();
    await VAP();
    await saleTotal("CST-1", "cstore", 600, 1240);
    await saleSplit("VAP-1", "vape", 51, 1, 50);
    const res = await run(net([VAPE_OK]), "manual", { actor: "S_002" });
    const all = await rows();
    const c = all.find((r) => r.companies === "cstore");
    const v = all.find((r) => r.companies === "vape");
    expect(c.validation_id).toMatch(/^VR_20261120_220500_[a-z0-9]{10}$/);
    expect(c).toMatchObject({ business_date: DAY, merchant: "(not configured)", companies: "cstore", cashier_card: 1240, cash_counted: 850, cash_variance: 0, status: "OK", mode: "manual", session_ids: "CST-1", validated_by: "S_002", cash_sales: 600 });
    expect(v).toMatchObject({ merchant: "VAPE1", companies: "vape", cashier_credit: 1, clover_credit: 1, cashier_debit: 50, clover_debit: 50, cashier_card: 51, clover_card: 51, card_variance: 0, status: "OK" });
    expect(c.validated_at.toISOString()).toBe(NOW.toISOString());
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_id: "S_002", action: "reconcile.day", target_type: "validation_results", target_id: DAY });
    expect(a[0].details.startsWith("mode=manual; whatsapp=cstore → shift_close(13) sent ; vape → shift_close(13) sent; \u{1F9FE} *Shift Reconciliation* | ")).toBe(true);
    expect(a[0].details).not.toContain("\n");
    expect(res.date).toBe(DAY);
  });

  it("a blank actor is SYSTEM", async () => {
    await CST();
    await run(net(), "manual", { actor: "" });
    expect((await rows())[0].validated_by).toBe("SYSTEM");
    expect((await audits())[0].actor_id).toBe("SYSTEM");
  });

  it("DELIBERATE DIFFERENCE: a mode other than auto or manual is refused before anything happens", async () => {
    await CST();
    const n = net();
    await expect(run(n, "nightly" as "auto")).rejects.toThrow("Reconcile: mode must be 'auto' or 'manual'");
    expect(n.sent).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it("DELIBERATE DIFFERENCE: a figure the table cannot hold is refused with a plain message, and nothing is written", async () => {
    await CST();
    await sess({ id: "CST-2", company: "cstore", float: 250, counted: 9_999_999_999, expected: 9_999_999_999, staff: "S_005", start: "2026-11-20T20:00:00Z" });
    const n = net();
    await expect(run(n)).rejects.toThrow(/^Reconcile: cash counted \(\d+\) is too large to store$/);
    expect(n.sent).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });
});

describe("two runs of the same day at once (the advisory lock)", () => {
  it("write the day's rows once: the second waits for the first, then finds nothing new", async () => {
    await setConfig({ notifier_enabled: "false" });
    await CST();
    await saleTotal("CST-1", "cstore", 600, 1240);
    // A slow first run: its Clover-free run holds the lock while the second starts on another connection.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = withTransaction(db, async (tx) => {
      const r = await reconcile.reconcileDay(tx, { config: await loadConfig(tx), env: ENV, fetch: net().fetch, now: NOW }, "S_004", "auto");
      await gate; // keep the transaction (and the lock) open
      return r;
    });
    await new Promise((r) => setTimeout(r, 150));
    const second = run(net(), "auto", { on: db2, actor: "S_005" });
    await new Promise((r) => setTimeout(r, 150));
    const waiting = await owner.query<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted");
    expect(waiting[0]!.n).toBe(1);
    release();
    const [a, b] = await Promise.all([slow, second]);
    expect((a as { merchants?: unknown[] }).merchants).toHaveLength(1);
    expect(b).toEqual({ ready: true, empty: true });
    expect(await rows()).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it("two runs at once of different days do not wait for each other", async () => {
    await setConfig({ notifier_enabled: "false" });
    await CST();
    const otherDay = new Date("2026-11-22T03:05:00Z");
    const [a, b] = await Promise.all([run(net(), "auto"), run(net(), "auto", { on: db2, now: otherDay })]);
    expect(a.merchants).toHaveLength(1);
    expect(b).toEqual({ ready: true, empty: true });
  });
});

// ── Security ───────────────────────────────────────────────

describe("the Clover token goes only to Clover", () => {
  it("DELIBERATE DIFFERENCE: a clover_base_url on another host is not configured; nothing is sent there; the message still goes", async () => {
    for (const base of ["https://example.test", "https://api.clover.com.example.test", "http://api.clover.com", "https://api.clover.com:8443"]) {
      await owner.query("delete from ops.validation_results");
      await owner.query("delete from ops.sales");
      await owner.query("delete from ops.till_sessions");
      await setConfig({ clover_base_url: base });
      await VAP();
      await saleSplit("VAP-1", "vape", 51, 1, 50);
      const n = net([VAPE_OK]);
      const res = await run(n);
      expect(n.clover(), base).toHaveLength(0);
      expect(n.sent.every((s) => new URL(s.url).hostname === "graph.facebook.com")).toBe(true);
      expect(n.sent.some((s) => s.authorization?.includes(CLOVER_TOKEN))).toBe(false);
      expect(res.merchants[0].cloverNA).toBe(true);
      expect(res.merchants[0].status).toBe("OK");
      expect(n.messages()).toHaveLength(1);
    }
  });

  it("the Clover URL carries the merchant id encoded, and the token only as the Authorization header", async () => {
    await setConfig({ clover_vape_merchant_id: "V 1/../x?y=1" });
    await VAP();
    const n = net([VAPE_OK]);
    await run(n);
    const c = n.clover()[0]!;
    expect(c.url.startsWith("https://api.clover.com/v3/merchants/V%201%2F..%2Fx%3Fy%3D1/payments?")).toBe(true);
    expect(c.url).not.toContain(CLOVER_TOKEN);
    expect(c.authorization).toBe("Bearer " + CLOVER_TOKEN);
  });

  it("the token never appears in an audit row, a stored row, an answer or a thrown message", async () => {
    // Clover answers with the token in its error body; Meta's error echoes it too; the request fails.
    const answers: string[] = [];
    for (const reply of [
      { status: 401, body: "bad token " + CLOVER_TOKEN },
      { status: 200, body: "not json " + CLOVER_TOKEN },
      { throws: "connect ECONNREFUSED " + CLOVER_TOKEN },
    ] as Reply[]) {
      await owner.query("delete from ops.validation_results");
      await owner.query("delete from ops.sales");
      await owner.query("delete from ops.till_sessions");
      await VAP();
      await saleSplit("VAP-1", "vape", 51, 1, 50);
      const res = await run(net([reply], { status: 400, body: { error: { message: "echo " + WA_TOKEN } } }));
      expect(res.merchants[0].status).toBe("clover_unavailable");
      answers.push(JSON.stringify(res));
      // Through the RPC too.
      await owner.query("delete from ops.validation_results");
      const viaRpc = await withTransaction(db, async (tx) => rpcReconcileDay(ctxFor(tx, EMPLOYEE, net([reply]).fetch), true));
      answers.push(JSON.stringify(viaRpc));
    }
    // A reconcile that fails after Clover was asked with the token.
    await sess({ id: "VAP-2", company: "vape", float: 60, counted: 9_999_999_999, expected: 9_999_999_999, staff: "S_005", start: "2026-11-20T20:00:00Z" });
    let thrown = "";
    try {
      await run(net([{ status: 401, body: CLOVER_TOKEN }]));
    } catch (e) {
      thrown = e instanceof Error ? e.message + "\n" + (e.stack ?? "") : String(e);
    }
    expect(thrown).toMatch(/too large to store/);
    const everything = [
      ...answers,
      thrown,
      JSON.stringify(await db.query("select * from ops.audit_log")),
      JSON.stringify(await db.query("select * from ops.validation_results")),
      JSON.stringify(await reconcile.getRecent(db, 100)),
    ].join("\n");
    expect(everything).not.toContain(CLOVER_TOKEN);
    expect(everything).not.toContain(WA_TOKEN);
  });
});

describe("a failed WhatsApp send is reported, never swallowed (ADR-0007)", () => {
  it("in the answer and in the audit row, with Meta's own reason", async () => {
    await setConfig({ whatsapp_template_shift_close_cstore: "shift_close_cstore" });
    await CST();
    await saleTotal("CST-1", "cstore", 600, 1240);
    const res = await run(net([], { status: 400, body: { error: { message: "(#133010) Account not registered" } } }));
    expect(res.whatsapp.sent).toBe(false);
    expect(res.whatsapp.perGroup[0]).toMatchObject({ companies: "cstore", template: "shift_close_cstore", params: 11, sent: false, sentCount: 0, total: 1 });
    expect(res.whatsapp.perGroup[0].results[0]).toMatchObject({ to: "14165550100", sent: false, reason: "http_400", detail: "(#133010) Account not registered" });
    expect(res.whatsappSummary).toBe("cstore → shift_close_cstore(11) FAILED not sent — (#133010) Account not registered");
    expect((await audits())[0].details).toContain("whatsapp=cstore → shift_close_cstore(11) FAILED not sent — (#133010) Account not registered;");
    // The day is still reconciled.
    expect(await rows()).toHaveLength(1);
  });

  it("a network failure is reported the same way", async () => {
    await CST();
    const res = await run(net([], { throws: "Address unavailable" }));
    expect(res.whatsappSummary).toBe("cstore → shift_close(13) FAILED not sent — Address unavailable");
  });

  it("the notifier switched off, or no recipients, says so", async () => {
    await setConfig({ notifier_enabled: "false" });
    await CST();
    const n = net();
    const res = await run(n);
    expect(n.sent).toHaveLength(0);
    expect(res.whatsapp).toEqual({ sent: false, perGroup: [{ companies: "cstore", template: "shift_close", params: 13, sent: false, reason: "disabled" }] });
    expect(res.whatsappSummary).toBe("cstore → shift_close(13) FAILED disabled");
  });
});

// ── The pure builders ──────────────────────────────────────

describe("builders", () => {
  const cfg = Config.fromRows([]);
  it("signed, hhmm, mark, blank, numOrNull, shapeFor", () => {
    expect([reconcile.signed(1.005), reconcile.signed(-40), reconcile.signed(0), reconcile.signed(-0.004)]).toEqual(["+$1.00", "-$40.00", "+$0.00", "+$0.00"]);
    expect(reconcile.hhmm(new Date("2026-11-20T14:02:00Z"))).toBe("09:02");
    expect(reconcile.hhmm(null)).toBe("—");
    expect([reconcile.mark(cfg, 1), reconcile.mark(cfg, -1.004), reconcile.mark(cfg, 1.01)]).toEqual(["✅", "✅", "⚠️"]);
    expect([reconcile.blank(null), reconcile.blank(undefined), reconcile.blank(0)]).toEqual([null, null, 0]);
    expect([reconcile.numOrNull(""), reconcile.numOrNull(null), reconcile.numOrNull("x"), reconcile.numOrNull("0"), reconcile.numOrNull(2.5)]).toEqual([null, null, null, 0, 2.5]);
    expect([reconcile.shapeFor("shift_close_cstore"), reconcile.shapeFor("shift_close_vape"), reconcile.shapeFor("shift_close")]).toEqual(["cards_unverified", "cards_checked", "legacy"]);
  });

  it("opKeyFor: a single till's own key when set, else shift_close", () => {
    const set = Config.fromRows([{ key: "whatsapp_template_shift_close_vape", value: "v1" }]);
    expect(reconcile.opKeyFor(set, { companies: ["vape"] })).toBe("shift_close_vape");
    expect(reconcile.opKeyFor(set, { companies: ["cstore"] })).toBe("shift_close");
    expect(reconcile.opKeyFor(set, { companies: ["cstore", "vape"] })).toBe("shift_close");
    expect(reconcile.opKeyFor(set, { companies: ["grocery"] })).toBe("shift_close");
  });

  it("statusParam names what is wrong", () => {
    expect(reconcile.statusParam(cfg, { cardsVerified: false, cloverNA: false })).toBe("⚠️ Clover unavailable - cards not verified");
    expect(reconcile.statusParam(cfg, { cardsVerified: true, cloverNA: false, cashVariance: -40, cardDiff: 3 })).toBe("⚠️ cash short $40.00 · cards off $3.00");
    expect(reconcile.statusParam(cfg, { cardsVerified: true, cloverNA: false, cashVariance: 0.5, cardDiff: 0 })).toBe("✅ All matched");
    expect(reconcile.statusParam(cfg, { cardsVerified: false, cloverNA: true, cashVariance: 2 })).toBe("⚠️ cash over $2.00");
  });

  it("describeSend", () => {
    expect(reconcile.describeSend(null)).toBe("no result");
    expect(reconcile.describeSend({ sent: false, reason: "exception", detail: "x" })).toBe("exception");
    expect(reconcile.describeSend({ sent: false })).toBe("nothing to send");
    expect(reconcile.describeSend({ sent: true, perGroup: [{ companies: "vape", template: "shift_close_vape", params: 12, sent: true }] })).toBe("vape → shift_close_vape(12) sent");
  });

  it("reconParams for a till checked against Clover: measured minus claimed", () => {
    const m: reconcile.MessageRecord = {
      companies: ["vape"],
      windowStart: new Date("2026-11-20T15:30:00Z"),
      windowEnd: new Date("2026-11-21T01:00:00Z"),
      staffNames: ["Ashin Vale"],
      cloverOk: true,
      cardsVerified: true,
      cloverNA: false,
      cashSales: 150,
      cashierCard: 100,
      cashCounted: 250,
      cashVariance: 0,
      openingFloat: 100,
      cashierCredit: 60,
      cloverCredit: 55,
      creditDiff: 5,
      cashierDebit: 40,
      cloverDebit: 40,
      debitDiff: 0,
      cloverCard: 95,
      cardDiff: 5,
      cashBanked: 150,
      floatLeft: 100,
      lottoTopup: 0,
      cashOutHolders: [],
      cashOutStale: 0,
      tookCash: [],
      lotto: null,
    };
    expect(reconcile.reconParams(cfg, new Date("2026-11-20T05:00:00Z"), m, "cards_checked")).toEqual([
      "Fri 20 Nov 2026",
      "vape",
      "10:30–20:00",
      "Ashin Vale",
      "reported $250.00 / counted $245.00 (var -$5.00) ⚠️",
      "$250.00 / $250.00 (var +$0.00) ✅",
      "float $100.00 back · $150.00 in hand",
      "nobody is holding cash",
      "$60.00 / $55.00 (var -$5.00) ⚠️",
      "$40.00 / $40.00 (var +$0.00) ✅",
      "$100.00 / $95.00 (var -$5.00) ⚠️",
      "⚠️ cards off $5.00",
    ]);
    expect(reconcile.reconParams(cfg, new Date("2026-11-20T05:00:00Z"), m, "legacy")).toHaveLength(13);
  });
});

// ── The history ────────────────────────────────────────────

describe("getRecent and rpcGetReconciliation", () => {
  async function seedRows(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await owner.query(
        `insert into ops.validation_results (validation_id, business_date, window_start, window_end, merchant, companies, cashier_card, cash_counted, cash_variance, status, mode, session_ids, validated_at, validated_by, cash_sales)
         values ($1, $2, $3, $3, 'm', 'vape', null, null, null, 'OK', 'auto', 'X', $4, 'SYSTEM', null)`,
        [`VR_${i}`, "2026-11-01", `2026-11-01T1${i % 10}:00:00Z`, new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()],
      );
    }
  }

  it("newest first; blank cashier_card, cash figures read as 0 (kept); blank text as ''", async () => {
    await seedRows(3);
    await owner.query("update ops.validation_results set merchant = null, status = null, mode = null, validated_by = null where validation_id = 'VR_0'");
    const r = await reconcile.getRecent(db);
    expect(r.map((x) => x.validatedAt)).toEqual(["2026-11-01T00:02:00.000Z", "2026-11-01T00:01:00.000Z", "2026-11-01T00:00:00.000Z"]);
    expect(r[2]).toMatchObject({ businessDate: "2026-11-01", merchant: "", status: "", mode: "", validatedBy: "", cashierCard: 0, cashSales: 0, cashCounted: 0, cashVariance: 0, cloverCard: null, cardVariance: null });
    expect(Object.keys(r[0]!)).not.toContain("_ts");
  });

  it("limits as slice(0, limit): none is 60, a decimal is cut, a negative drops the oldest", async () => {
    await seedRows(65);
    expect(await reconcile.getRecent(db)).toHaveLength(60);
    expect(await reconcile.getRecent(db, 0)).toHaveLength(60);
    expect(await reconcile.getRecent(db, 2.9)).toHaveLength(2);
    expect(await reconcile.getRecent(db, 0.5)).toHaveLength(0);
    expect(await reconcile.getRecent(db, -1)).toHaveLength(64);
    expect((await reconcile.getRecent(db, -64)).map((x) => x.validatedAt)).toEqual(["2026-11-01T01:04:00.000Z"]);
    expect(await reconcile.getRecent(db, -100)).toHaveLength(0);
    expect(await reconcile.getRecent(db, Infinity)).toHaveLength(65);
  });

  it("a tie on validated_at (one run's rows) is broken by the window start", async () => {
    await CST({ start: "2026-11-20T13:00:00Z" });
    await VAP({ start: "2026-11-20T16:00:00Z" });
    await run(net([VAPE_OK]));
    expect((await reconcile.getRecent(db)).map((x) => x.companies)).toEqual(["cstore", "vape"]);
  });

  it("the RPC: Number(limit) || 60", async () => {
    await seedRows(65);
    const call = (limit: unknown) => withTransaction(db, async (tx) => rpcGetReconciliation(ctxFor(tx, MANAGER), limit)) as Promise<unknown[]>;
    expect(await call(undefined)).toHaveLength(60);
    expect(await call("abc")).toHaveLength(60);
    expect(await call("5")).toHaveLength(5);
    expect(await call(null)).toHaveLength(60);
    expect(await call(1)).toHaveLength(1);
  });
});

// ── rpcReconcileDay ────────────────────────────────────────

const session = (staffId: string, role: Session["role"]): Session => ({ staffId, name: staffId, role, companiesAuthorized: ["cstore", "vape"], expiresAt: 0 });
const EMPLOYEE = session("S_005", "employee");
const MANAGER = session("S_002", "manager");
function ctxFor(tx: any, who: Session | null, f: typeof fetch = net().fetch): RpcContext {
  return { db: tx, session: who, config: () => loadConfig(tx), env: ENV, fetch: f, now: NOW };
}

describe("rpcReconcileDay", () => {
  it("anyone signed in; force === true is manual, anything else auto; the actor is the session", async () => {
    await CST();
    await VAP({ status: "open" });
    const call = (force: unknown, who: Session | null = EMPLOYEE) => withTransaction(db, async (tx) => rpcReconcileDay(ctxFor(tx, who), force)) as Promise<any>;
    for (const f of [false, undefined, "true", 1, null]) expect(await call(f)).toEqual({ ready: false, openCount: 1 });
    const r = await call(true);
    expect(r.mode).toBe("manual");
    // The answer is JSON: the window instants are ISO strings.
    expect(r.merchants[0].windowStart).toBe("2026-11-20T14:00:00.000Z");
    expect((await rows())[0].validated_by).toBe("S_005");
    await expect(call(true, null)).rejects.toThrow("NOT_LOGGED_IN");
  });
});
