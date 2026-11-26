// The Sales module (src/Sales.gs without the dashboard), against a real database with invented people.
//
// Ports the assertions of tests/suites/sales-cards.js that concern the module itself (the two card
// shapes, one continuous total, the commission feed, cardSplitFor). The dashboard assertions of that
// suite (getDashboard's totals, rows, daily series, byCompany slices) belong to the dashboard card and
// are not here. Expected values are what Sales.gs returns and stores.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { Config } from "../src/lib/config";
import * as sales from "../src/modules/sales";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };
const NOW = new Date("2026-09-01T20:00:00Z");

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

/** A closed session row for each sales row (sales.session_id references it). */
async function session(id: string, company: string, date: string, staffId = "S_1"): Promise<void> {
  await owner.query(
    "insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status) values ($1, $2, $3, $4, $5, 'closed')",
    [id, `A_${date.replace(/-/g, "")}_${staffId}`, staffId, company, date],
  );
}

beforeEach(async () => {
  for (const t of ["audit_log", "sales", "till_sessions", "attendance", "staff"]) await owner.query(`delete from ops.${t}`);
  await owner.query("insert into ops.staff (staff_id, name, hourly_rate, active, role, companies_authorized) values ('S_1', 'Ash Fernly', 17, true, 'employee', 'cstore,vape'), ('S_2', 'Bea Lund', 18, true, 'employee', 'vape')");
  for (const [d, s] of [["2026-09-01", "S_1"], ["2026-09-02", "S_1"], ["2026-09-01", "S_2"]] as const) {
    await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ($1, $2, $3, 'worked')", [`A_${d.replace(/-/g, "")}_${s}`, s, d]);
  }
});

const write = (input: sales.SalesInput, actor: string | null = "S_1") => withTransaction(db, (tx) => sales.write(tx, input, actor, NOW));
const raw = (id: string) => db.one<any>("select * from ops.sales where sales_id = $1", [id]);
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after" from ops.audit_log order by log_id`);

describe("write: the card shape comes from what was sent, and the other shape is blank", () => {
  it("a split close (no card total sent) stores credit/debit, card total blank", async () => {
    await session("VAP-1", "vape", "2026-09-01");
    const r = await write({ sessionId: "VAP-1", staffId: "S_1", company: "vape", date: "2026-09-01", cashSales: 100, creditCardSales: 150, debitCardSales: 50, miscCreditSales: 0, miscDebitSales: 0 });
    const row = await raw("VAP-1");
    expect(row).toMatchObject({ session_id: "VAP-1", date: "2026-09-01", cash_sales: 100, credit_card_sales: 150, debit_card_sales: 50, misc_credit_sales: 0, misc_debit_sales: 0, card_total_sales: null, misc_card_sales: null, cashback_paid: 0, hst_collected: 0, bottle_deposit: 0, round_off: 0, misc_cash_sales: 0, misc_notes: null });
    expect(r).toMatchObject({ cardSplit: true, creditCardSales: 150, cardTotalSales: null, miscCardSales: null });
  });
  it("a single-total close stores the total, credit/debit blank (not zero)", async () => {
    await session("CST-1", "cstore", "2026-09-01");
    const r = await write({ sessionId: "CST-1", staffId: "S_1", company: "cstore", date: "2026-09-01", cashSales: 600, cardTotalSales: 1240, miscCardSales: 0, creditCardSales: 0, debitCardSales: 0 });
    const row = await raw("CST-1");
    expect(row).toMatchObject({ credit_card_sales: null, debit_card_sales: null, misc_credit_sales: null, misc_debit_sales: null, card_total_sales: 1240, misc_card_sales: 0 });
    expect(r).toMatchObject({ cardSplit: false, creditCardSales: null, debitCardSales: null, cardTotalSales: 1240 });
  });
  it("a split row with nothing on debit is 0, not null: it split and took nothing", async () => {
    await session("CST-2", "cstore", "2026-09-01");
    const r = await write({ sessionId: "CST-2", staffId: "S_1", company: "cstore", date: "2026-09-01", cashSales: 600, creditCardSales: 1240, debitCardSales: 0 });
    expect(r?.debitCardSales).toBe(0);
    expect(r?.cardTotalSales).toBeNull();
  });
  it("only a misc card figure is enough to make the row single-total", async () => {
    await session("VAP-2", "vape", "2026-09-01");
    await write({ sessionId: "VAP-2", staffId: "S_1", company: "vape", date: "2026-09-01", miscCardSales: 5 });
    expect(await raw("VAP-2")).toMatchObject({ credit_card_sales: null, card_total_sales: 0, misc_card_sales: 5 });
  });
  it("rounds with roundMoney before writing: 1.005 is stored as 1 (a database would make it 1.01)", async () => {
    await session("VAP-3", "vape", "2026-09-01");
    await write({ sessionId: "VAP-3", staffId: "S_1", company: "vape", date: "2026-09-01", cashSales: 1.005, debitCardSales: -0.005 });
    expect(await raw("VAP-3")).toMatchObject({ cash_sales: 1, debit_card_sales: 0 });
  });
  it("a date given as a Date is stored as its Toronto day", async () => {
    await session("VAP-4", "vape", "2026-09-01");
    await write({ sessionId: "VAP-4", staffId: "S_1", company: "vape", date: new Date("2026-09-01T04:00:00Z") });
    expect((await raw("VAP-4")).date).toBe("2026-09-01");
  });
  it("audits sales.create with the old values, '' for a blank card cell; a second write updates in place (sales.update, with a before)", async () => {
    await session("CST-3", "cstore", "2026-09-01");
    await write({ sessionId: "CST-3", staffId: "S_1", company: "cstore", date: "2026-09-01", cashSales: 10, cardTotalSales: 20 });
    await write({ sessionId: "CST-3", staffId: "S_1", company: "cstore", date: "2026-09-01", cashSales: 11, creditCardSales: 3, debitCardSales: 4, cashbackPaid: 1 }, null);
    expect(await db.query("select count(*)::int as n from ops.sales")).toEqual([{ n: 1 }]);
    expect(await raw("CST-3")).toMatchObject({ cash_sales: 11, credit_card_sales: 3, card_total_sales: null });
    const a = await audits();
    expect(a).toHaveLength(2);
    expect(a.map((x) => [x.action, x.actor_id, x.target_type, x.target_id])).toEqual(
      expect.arrayContaining([
        ["sales.create", "S_1", "sales", "CST-3"],
        ["sales.update", "SYSTEM", "sales", "CST-3"],
      ]),
    );
    const create = a.find((x) => x.action === "sales.create");
    expect(JSON.parse(create.after)).toEqual({ cashSales: 10, creditCardSales: "", debitCardSales: "", cashbackPaid: 0 });
    expect(create.before).toBeNull();
    const update = a.find((x) => x.action === "sales.update");
    expect(JSON.parse(update.before)).toEqual({ cashSales: 10, creditCardSales: null, debitCardSales: null });
  });
  it("refuses a missing session, staff, company or date, and an unreadable date", async () => {
    await expect(write({ staffId: "S_1", company: "vape", date: "2026-09-01" })).rejects.toThrow("sessionId required");
    await expect(write({ sessionId: "X", company: "vape", date: "2026-09-01" })).rejects.toThrow("staffId required");
    await expect(write({ sessionId: "X", staffId: "S_1", date: "2026-09-01" })).rejects.toThrow("company required");
    await expect(write({ sessionId: "X", staffId: "S_1", company: "vape" })).rejects.toThrow("date required");
    await expect(write({ sessionId: "X", staffId: "S_1", company: "vape", date: "next tuesday" })).rejects.toThrow("date is not a readable date");
  });
});

describe("reads and totals (sales-cards)", () => {
  async function split(id: string, date: string, company: string, cash: number, credit: number, debit: number, staffId = "S_1") {
    await session(id, company, date, staffId);
    await owner.query("insert into ops.sales (sales_id, session_id, staff_id, company, date, cash_sales, credit_card_sales, debit_card_sales) values ($1,$1,$2,$3,$4,$5,$6,$7)", [id, staffId, company, date, cash, credit, debit]);
  }
  async function total(id: string, date: string, company: string, cash: number, card: number) {
    await session(id, company, date);
    await owner.query("insert into ops.sales (sales_id, session_id, staff_id, company, date, cash_sales, card_total_sales) values ($1,$1,'S_1',$2,$3,$4,$5)", [id, company, date, cash, card]);
  }

  it("a single-total row reads credit and debit as null, a blank cash or cashback as 0", async () => {
    await total("T1", "2026-09-01", "cstore", 600, 1240);
    const r = await sales.getForSession(db, "T1");
    expect(r).toMatchObject({ creditCardSales: null, debitCardSales: null, miscCreditSales: null, cardTotalSales: 1240, miscCardSales: null, cashbackPaid: 0, miscCashSales: 0, cardSplit: false });
  });
  it("the same money totals the same whichever shape recorded it", async () => {
    await split("S1", "2026-09-01", "cstore", 600, 1240, 0);
    await total("T1", "2026-09-02", "cstore", 600, 1240);
    expect(sales.totalForRow(await sales.getForSession(db, "S1"))).toBe(1840);
    expect(sales.totalForRow(await sales.getForSession(db, "T1"))).toBe(1840);
    expect(sales.totalForRow(null)).toBe(0);
  });
  it("a range spanning the migration sums every tender once", async () => {
    await split("S1", "2026-09-01", "cstore", 600, 1000, 0);
    await total("T1", "2026-09-02", "cstore", 700, 1100);
    const rows = await sales.getForDateRange(db, "2026-09-01", "2026-09-02");
    expect(rows.reduce((a, r) => a + sales.totalForRow(r), 0)).toBe(3400);
    const agg = await sales.aggregateByStaffCompany(db, "2026-09-01", "2026-09-02");
    expect(agg).toEqual([{ staffId: "S_1", company: "cstore", total: 3400, cashTotal: 1300, cardTotal: 2100, cashbackTotal: 0, sessionCount: 2 }]);
  });
  it("the commission feed sees card revenue in the single-total shape", async () => {
    await total("T1", "2026-09-01", "cstore", 600, 1240);
    const agg = await sales.aggregateByStaffCompany(db, new Date("2026-09-01T04:00:00Z"), new Date("2026-09-02T03:59:59Z"));
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({ cardTotal: 1240, total: 1840 });
  });
  it("mixed shapes add up per company; filters narrow by person and till", async () => {
    await split("S1", "2026-09-01", "vape", 100, 150, 50, "S_2");
    await total("T1", "2026-09-01", "cstore", 600, 1240);
    const all = await sales.getForDateRange(db, "2026-09-01", "2026-09-01");
    expect(all.reduce((a, r) => a + sales.totalForRow(r), 0)).toBe(2140);
    expect((await sales.getForDateRange(db, "2026-09-01", "2026-09-01", { company: "cstore" })).map((r) => r.salesId)).toEqual(["T1"]);
    expect((await sales.getForDateRange(db, "2026-09-01", "2026-09-01", { staffId: "S_2" })).map((r) => r.salesId)).toEqual(["S1"]);
    expect(await sales.getForDateRange(db, "", "2026-09-01")).toEqual([]);
    expect((await sales.getAll(db)).map((r) => r.salesId)).toEqual(["S1", "T1"]);
  });
});

describe("cardSplitFor (true unless the trimmed, lower-cased setting is 'false'; Sales.gs's default, true, for both tills)", () => {
  const cfg = (rows: Record<string, string | null>) => Config.fromRows(Object.entries(rows).map(([key, value]) => ({ key, value })));
  it("an unset setting splits, for cstore too (the registry's 'false' default for cstore is not used)", () => {
    expect(sales.cardSplitFor(cfg({}), "cstore")).toBe(true);
    expect(sales.cardSplitFor(cfg({}), "vape")).toBe(true);
    expect(sales.cardSplitFor(cfg({ cstore_card_split: "" }), "cstore")).toBe(true);
  });
  it("an unknown till defaults to splitting", () => {
    expect(sales.cardSplitFor(cfg({}), "newtill")).toBe(true);
  });
  it("reads 'false' for cstore without touching vape; whitespace and case are tolerated", () => {
    const c = cfg({ cstore_card_split: "false", vape_card_split: "true" });
    expect(sales.cardSplitFor(c, "cstore")).toBe(false);
    expect(sales.cardSplitFor(c, "vape")).toBe(true);
    expect(sales.cardSplitFor(cfg({ vape_card_split: " False " }), "vape")).toBe(false);
    expect(sales.cardSplitFor(cfg({ vape_card_split: "no" }), "vape")).toBe(true);
  });
});
