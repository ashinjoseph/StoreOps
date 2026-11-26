// The commission engine (src/Commissions.gs) and its two RPCs, against a real database with invented people.
//
// Ports every engine assertion of tests/suites/commission-fixed.js: a fee pays with or without sales, a fee
// and a commission both pay, the order of the rules does not decide, a fee pays once a week, an existing fee
// does not block a commission, a deleted fee rule stops blocking, a legacy row with no rule still blocks, a
// threshold makes a fee conditional, percentage rules are unchanged, each bonus names its rule, the fee comes
// round every week, once per week (skipped, and a forced re-run proposes nothing new), it stops when the rule
// does, an inactive rule pays nothing, a rule that runs forever keeps paying. The last five sections of that
// suite (a rule that would pay nothing is refused; a valid fixed rule is written the way the engine reads
// it; the two shapes cannot be mixed up; a blank rule_type) are CommissionRules and are ported in
// commission-rules.test.ts.
//
// Where the suite stubbed Sales, Staff, Notifier and AuditLog these use the real modules over real rows.
// "A deleted fee rule": bonuses.source_rule_id is a foreign key, so a rule can no longer be deleted out from
// under its bonus; the test keeps the fee rule switched off, which is the same to the engine (it is not in the
// rules it is given and, being fixed, not in the list that may block a percentage rule).
//
// What the parity cases cannot reach is here: the two-at-once lock, the exact threshold, how many statements a
// run makes, the audit rows, the blank readings, and the RPC shapes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction, type Tx } from "../src/db/tx";
import { Config } from "../src/lib/config";
import { parseDate } from "../src/lib/dates";
import * as commissions from "../src/modules/commissions";
import { ERROR_PREFIXED, handlers } from "../src/rpc/registry";
import { rpcGetCommissionRuns, rpcRunCommissionEngine } from "../src/rpc/handlers/commissions";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

// Toronto is UTC-4 in September: this is Wednesday 30 September, 10:00 local.
const NOW = new Date("2026-09-30T14:00:00Z");
const WEEK_START = parseDate("2026-09-21") as Date; // Monday
const WEEK_END = new Date(parseDate("2026-09-28")!.getTime() - 1); // Sunday 23:59:59.999
const deps = (now: Date = NOW) => ({ config: Config.fromRows([]), env: {}, fetch, now });

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

const STAFF: Array<[string, string, boolean, string]> = [
  ["S_ASH", "Ashin Quill", true, "employee"],
  ["S_MEE", "Meera Hale", true, "employee"],
  ["S_OLD", "Olu Vance", false, "employee"],
  ["S_BOS", "Bo Stone", true, "manager"],
];

beforeEach(async () => {
  for (const t of ["audit_log", "bonuses", "commission_runs", "commission_rules", "sales", "till_sessions", "attendance", "staff"]) await owner.query(`delete from ops.${t}`);
  for (const s of STAFF) await owner.query("insert into ops.staff (staff_id, name, active, role, companies_authorized) values ($1,$2,$3,$4,'cstore,vape')", s);
});

interface RuleSpec {
  id: string;
  staffId?: string;
  company?: string;
  threshold?: number;
  percentage?: number;
  active?: boolean;
  from?: string;
  to?: string | null;
  type?: "fixed" | "percentage" | null;
  fixedAmount?: number;
  name?: string;
}

async function addRule(r: RuleSpec): Promise<void> {
  await owner.query(
    `insert into ops.commission_rules (rule_id, name, applies_to, staff_id, company, threshold, percentage, active, effective_from, effective_to, created_by, created_at, rule_type, fixed_amount)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'S_ADM','2026-01-01T00:00:00Z',$11,$12)`,
    [r.id, r.name ?? r.id, r.staffId ? "specific_staff" : "all_staff", r.staffId ?? null, r.company ?? "cstore", r.threshold ?? 0, r.percentage ?? 0, r.active ?? true, r.from ?? "2026-01-01", r.to ?? null, r.type === null ? "percentage" : (r.type ?? "percentage"), r.fixedAmount ?? 0],
  );
}

let saleSeq = 0;
/** One closed till with its takings: `total` is cash only, so a person's sales for the week are the sum of these. */
async function addSale(staffId: string, company: string, date: string, total: number, extra: { card?: number } = {}): Promise<void> {
  saleSeq++;
  const att = `A_${date.replace(/-/g, "")}_${staffId}_${saleSeq}`;
  const sid = `T${saleSeq}`;
  await owner.query("insert into ops.attendance (attendance_id, staff_id, date, status) values ($1,$2,$3,'worked')", [att, staffId, date]);
  await owner.query("insert into ops.till_sessions (session_id, attendance_id, staff_id, company, date, status) values ($1,$2,$3,$4,$5,'closed')", [sid, att, staffId, company, date]);
  await owner.query("insert into ops.sales (sales_id, session_id, staff_id, company, date, cash_sales, card_total_sales) values ($1,$2,$3,$4,$5,$6,$7)", [`S${saleSeq}`, sid, staffId, company, date, total, extra.card ?? null]);
}

async function addBonus(o: { id?: string; staff?: string; company?: string; status?: string; rule?: string | null; run?: string; ps?: string; pe?: string; type?: string; amount?: number }): Promise<void> {
  await owner.query("insert into ops.commission_runs (run_id) values ($1) on conflict do nothing", [o.run ?? "CRN_OLD"]);
  await owner.query(
    `insert into ops.bonuses (bonus_id, staff_id, date, type, amount, reason, status, period_start, period_end, company, source_run_id, created_by, created_at, source_rule_id)
     values ($1,$2,'2026-09-21',$3,$4,'old',$5,$6,$7,$8,$9,'S_ADM','2026-09-21T13:00:00Z',$10)`,
    [o.id ?? "B_1", o.staff ?? "S_ASH", o.type ?? "commission", o.amount ?? 120, o.status ?? "proposed", o.ps ?? "2026-09-21", o.pe ?? "2026-09-27", o.company ?? "cstore", o.run ?? "CRN_OLD", o.rule === undefined ? "CR_001" : o.rule],
  );
}

const run = (input: Partial<commissions.RunInput> = {}, now = NOW) =>
  withTransaction(db, (tx) => commissions.runForWeek(tx, { weekStart: WEEK_START, weekEnd: WEEK_END, actorId: "S_ADM", ...input }, deps(now)));
const proposals = (r: Awaited<ReturnType<typeof run>>) => ("bonusesProposed" in r ? r.bonusesProposed : []);
const forStaff = (r: Awaited<ReturnType<typeof run>>, id: string) => proposals(r).filter((b) => b.staffId === id);
const byRule = (r: Awaited<ReturnType<typeof run>>, id: string) => proposals(r).find((b) => b.ruleId === id);
const bonusRows = () => db.query<any>("select * from ops.bonuses order by bonus_id");
const runRows = () => db.query<any>("select * from ops.commission_runs order by run_id");
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details, "timestamp" from ops.audit_log order by log_id`);

const FEE: RuleSpec = { id: "CR_001", staffId: "S_ASH", type: "fixed", fixedAmount: 120 };
const COMMISSION: RuleSpec = { id: "CR_002", percentage: 5, threshold: 5000 };

describe("a fixed rule is not tied to sales (commission-fixed.js)", () => {
  it("pays with no sales at all: one bonus, for the named person, at the flat amount, and the run total matches", async () => {
    await addRule(FEE);
    const r = await run();
    expect(proposals(r)).toHaveLength(1);
    expect(proposals(r)[0]).toMatchObject({ staffId: "S_ASH", amount: 120, ruleId: "CR_001", ruleType: "fixed", sales: 0, threshold: 0, percentage: 0, fixedAmount: 120 });
    expect(r).toMatchObject({ totalAmount: 120, staffCount: 1, skipped: false });
    expect((await bonusRows())[0].reason).toMatch(/not tied to sales/);
  });

  it("pays the same flat amount when there are sales", async () => {
    await addRule(FEE);
    await addSale("S_ASH", "cstore", "2026-09-22", 9000);
    expect(proposals(await run())[0]).toMatchObject({ amount: 120, sales: 9000 });
  });

  it("a fee and a sales commission both pay (370 in total), whichever rule is listed first", async () => {
    await addRule(FEE);
    await addRule(COMMISSION);
    await addSale("S_ASH", "cstore", "2026-09-22", 9000);
    await addSale("S_MEE", "cstore", "2026-09-22", 6000);
    const r = await run();
    expect(forStaff(r, "S_ASH")).toHaveLength(2);
    expect(byRule(r, "CR_001")?.amount).toBe(120);
    expect(byRule(r, "CR_002")?.amount).toBe(200);
    expect(forStaff(r, "S_MEE")).toHaveLength(1);
    expect(forStaff(r, "S_MEE")[0]?.amount).toBe(50);
    expect(proposals(r)).toHaveLength(3);
    expect(r).toMatchObject({ totalAmount: 370, staffCount: 2 });
  });

  it("order does not decide who gets paid (the rule ids the other way round)", async () => {
    await addRule({ ...COMMISSION, id: "CR_001" });
    await addRule({ ...FEE, id: "CR_002" });
    await addSale("S_ASH", "cstore", "2026-09-22", 9000);
    const r = await run();
    expect(forStaff(r, "S_ASH")).toHaveLength(2);
    expect(r).toMatchObject({ totalAmount: 320 });
  });

  it("a fee does not pay twice for the same week: a forced re-run proposes nothing and the total is zero", async () => {
    await addRule(FEE);
    await addBonus({ run: "CRN_OLD", rule: "CR_001" });
    const r = await run({ force: true });
    expect(proposals(r)).toHaveLength(0);
    expect(r).toMatchObject({ totalAmount: 0, staffCount: 0 });
  });

  it("an existing fee does not block the sales commission", async () => {
    await addRule({ ...FEE, active: false }); // the fee's rule is ended or gone: it is not in play
    await addRule(COMMISSION);
    await addBonus({ rule: "CR_001" });
    await addSale("S_ASH", "cstore", "2026-09-22", 9000);
    const r = await run({ force: true });
    expect(proposals(r)).toHaveLength(1);
    expect(proposals(r)[0]?.amount).toBe(200);
  });

  it("a fee whose rule is switched off stops blocking anything (the 'deleted rule': a rule row cannot be deleted under a bonus here)", async () => {
    await addRule({ ...FEE, active: false });
    await addRule(COMMISSION);
    await addBonus({ rule: "CR_001" });
    await addSale("S_ASH", "cstore", "2026-09-22", 9000);
    expect(proposals(await run({ force: true }))).toHaveLength(1);
  });

  it("a legacy bonus with no rule id still blocks, as it always did", async () => {
    await addRule(COMMISSION);
    await addBonus({ rule: null });
    await addSale("S_ASH", "cstore", "2026-09-22", 9000);
    expect(proposals(await run({ force: true }))).toHaveLength(0);
  });

  it("a threshold turns a fee into a conditional one: below it, or with no sales, nothing; above it, the full amount and the reason names the threshold", async () => {
    await addRule({ id: "CR_003", staffId: "S_ASH", type: "fixed", fixedAmount: 120, threshold: 5000 });
    expect(proposals(await run())).toHaveLength(0); // no sales at all
    await addSale("S_ASH", "cstore", "2026-09-22", 4000);
    expect(proposals(await run({ force: true }))).toHaveLength(0);
    await addSale("S_ASH", "cstore", "2026-09-23", 2000);
    const r = await run({ force: true });
    expect(proposals(r)[0]?.amount).toBe(120);
    expect((await bonusRows())[0].reason).toMatch(/over \$5000\.00 threshold/);
    expect((await bonusRows())[0].reason).toBe("Weekly fixed amount: CR_003 (cstore sales of $6000.00 over $5000.00 threshold)");
  });

  it("percentage rules are untouched: 5% of the excess, recorded as a percentage rule; below the threshold and with no sales nothing", async () => {
    await addRule(COMMISSION);
    expect(proposals(await run())).toHaveLength(0); // no sales
    await addSale("S_ASH", "cstore", "2026-09-22", 4000);
    expect(proposals(await run({ force: true }))).toHaveLength(0);
    await addSale("S_ASH", "cstore", "2026-09-23", 5000);
    const r = await run({ force: true });
    expect(proposals(r)[0]).toMatchObject({ amount: 200, ruleType: "percentage", sales: 9000, threshold: 5000, percentage: 5, fixedAmount: 0 });
    expect((await bonusRows())[0].reason).toBe("Weekly commission: cstore sales of $9000.00 over $5000.00 threshold @ 5%");
  });

  it("each bonus records the rule that produced it", async () => {
    await addRule(FEE);
    await addRule(COMMISSION);
    await addSale("S_ASH", "cstore", "2026-09-22", 9000);
    await run();
    const rows = await bonusRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((b) => b.source_rule_id)).toBe(true);
    expect(rows.find((b) => b.amount === 120).source_rule_id).toBe("CR_001");
    expect(rows.find((b) => b.amount === 200).source_rule_id).toBe("CR_002");
  });
});

describe("the fee comes round every week (commission-fixed.js, recurrence)", () => {
  const week = (monday: string) => {
    const start = parseDate(monday) as Date;
    const nextMonday = parseDate(monday.replace(/\d\d$/, (d) => String(Number(d) + 7).padStart(2, "0"))) as Date;
    return { weekStart: start, weekEnd: new Date(nextMonday.getTime() - 1) };
  };

  it("three consecutive weeks each pay it, each against its own week, with no sales anywhere; a second run of a week is skipped; even a forced one proposes nothing", async () => {
    await addRule({ ...FEE, from: "2026-09-01" });
    const wk1 = await run(week("2026-09-07"));
    const wk2 = await run(week("2026-09-14"));
    const wk3 = await run(week("2026-09-21"));
    expect([wk1, wk2, wk3].map((r) => proposals(r).length)).toEqual([1, 1, 1]);
    expect([wk1, wk2, wk3].map((r) => proposals(r)[0]?.amount)).toEqual([120, 120, 120]);
    expect((await bonusRows()).map((b) => b.period_start).sort()).toEqual(["2026-09-07", "2026-09-14", "2026-09-21"]);

    const again = await run(week("2026-09-21"));
    expect(again).toMatchObject({ skipped: true });
    expect(await bonusRows()).toHaveLength(3);
    const forced = await run({ ...week("2026-09-21"), force: true });
    expect(proposals(forced)).toHaveLength(0);
    expect(await bonusRows()).toHaveLength(3);
  });

  it("it stops when the rule does: nothing before it starts, paid inside its window, nothing after it ends", async () => {
    await addRule({ ...FEE, from: "2026-09-14", to: "2026-09-20" });
    expect(proposals(await run(week("2026-09-07")))).toHaveLength(0);
    expect(proposals(await run(week("2026-09-14")))).toHaveLength(1);
    expect(proposals(await run(week("2026-09-21")))).toHaveLength(0);
    expect(await bonusRows()).toHaveLength(1);
  });

  it("an inactive rule pays nothing at all", async () => {
    await addRule({ ...FEE, from: "2026-09-01", active: false });
    expect(proposals(await run(week("2026-09-07")))).toHaveLength(0);
    expect(proposals(await run(week("2026-09-14")))).toHaveLength(0);
  });

  it("a rule that runs forever keeps paying, the total being the fee each week", async () => {
    await addRule({ ...FEE, from: "2026-09-01", to: null });
    const many = [] as Awaited<ReturnType<typeof run>>[];
    for (const m of ["2026-09-07", "2026-09-14", "2026-09-21"]) many.push(await run(week(m)));
    expect(many.map((r) => proposals(r).length)).toEqual([1, 1, 1]);
    expect(many.map((r) => ("totalAmount" in r ? r.totalAmount : null))).toEqual([120, 120, 120]);
  });
});

describe("the arithmetic", () => {
  it("a percentage rule pays only when sales are above the threshold; a fixed rule with a threshold the same; equal to the threshold pays nothing (src/Commissions.gs:151-157)", async () => {
    await addRule({ id: "CR_001", percentage: 100, threshold: 5000 });
    await addRule({ id: "CR_002", staffId: "S_MEE", type: "fixed", fixedAmount: 40, threshold: 5000 });
    await addSale("S_ASH", "cstore", "2026-09-22", 5000); // exactly the threshold
    await addSale("S_MEE", "cstore", "2026-09-22", 5000);
    expect(proposals(await run())).toHaveLength(0);
    await addSale("S_ASH", "cstore", "2026-09-23", 0.01);
    await addSale("S_MEE", "cstore", "2026-09-23", 0.01);
    const r = await run({ force: true });
    expect(r).toMatchObject({ totalAmount: 40.02 });
    expect(forStaff(r, "S_ASH").map((b) => b.amount)).toEqual([0.01]); // 100% of one cent over
    expect(forStaff(r, "S_MEE").map((b) => [b.ruleId, b.amount])).toEqual([["CR_001", 0.01], ["CR_002", 40]]); // the percentage rule and the fee both pay
  });

  it("the sales counted are cash and every card column, per person per till (the card revenue rule): the card total shape counts as well as cash", async () => {
    await addRule({ id: "CR_001", percentage: 10, threshold: 1000 });
    await addSale("S_ASH", "cstore", "2026-09-22", 600, { card: 900 }); // cash 600 + card total 900
    await addSale("S_ASH", "cstore", "2026-09-24", 500, { card: 0 });
    const r = await run();
    expect(proposals(r)[0]).toMatchObject({ sales: 2000, amount: 100 });
  });

  it("rounding: the excess is rounded to cents, then the commission; the run total is rounded as it is added; an amount of half a cent or less is not proposed", async () => {
    await addRule({ id: "CR_001", percentage: 3.333, threshold: 1000.5 });
    await addRule({ id: "CR_002", staffId: "S_MEE", percentage: 0.0001, threshold: 0, company: "vape" });
    await addSale("S_ASH", "cstore", "2026-09-22", 7777.77);
    await addSale("S_MEE", "vape", "2026-09-22", 7777.77);
    const r = await run();
    // (7777.77 - 1000.5) = 6777.27; * 3.333 / 100 = 225.8...; 7777.77 * 0.0001 / 100 = 0.0078 rounds to 0.01
    expect(forStaff(r, "S_ASH").find((b) => b.ruleId === "CR_001")?.amount).toBe(225.89);
    expect(forStaff(r, "S_MEE").find((b) => b.ruleId === "CR_002")?.amount).toBe(0.01);
    await owner.query("delete from ops.audit_log");
    await addRule({ id: "CR_003", staffId: "S_BOS", percentage: 0.0001, threshold: 0 });
    await addSale("S_BOS", "cstore", "2026-09-22", 1000); // 1000 * 0.0001 / 100 = 0.001: rounds to 0
    const r2 = await run({ force: true });
    expect(forStaff(r2, "S_BOS")).toHaveLength(0);
  });

  it("a fixed amount is rounded to cents, and a fixed rule whose amount rounds to nothing pays nothing", async () => {
    await addRule({ id: "CR_001", staffId: "S_ASH", type: "fixed", fixedAmount: 20.456 });
    await addRule({ id: "CR_002", staffId: "S_MEE", type: "fixed", fixedAmount: 0.004 });
    const r = await run();
    expect(proposals(r).map((b) => [b.staffId, b.amount])).toEqual([["S_ASH", 20.46]]);
  });

  it("a rule for everyone covers the active people only; a rule for one person who is inactive pays nothing", async () => {
    await addRule({ id: "CR_001", type: "fixed", fixedAmount: 10 });
    await addRule({ id: "CR_002", staffId: "S_OLD", type: "fixed", fixedAmount: 99 });
    const r = await run();
    expect(proposals(r).map((b) => b.staffId)).toEqual(["S_ASH", "S_BOS", "S_MEE"]);
    expect(proposals(r).every((b) => b.staffName)).toBe(true);
    expect(forStaff(r, "S_OLD")).toHaveLength(0);
  });

  it("a person with sales at both tills earns at each; a rule covers one till only", async () => {
    await addRule({ id: "CR_001", percentage: 10, threshold: 100, company: "cstore" });
    await addRule({ id: "CR_002", percentage: 10, threshold: 100, company: "vape" });
    await addSale("S_ASH", "cstore", "2026-09-22", 1100);
    await addSale("S_ASH", "vape", "2026-09-22", 600);
    const r = await run();
    expect(proposals(r).map((b) => [b.company, b.sales, b.amount])).toEqual([["cstore", 1100, 100], ["vape", 600, 50]]);
    expect(r).toMatchObject({ totalAmount: 150, staffCount: 1 });
  });

  it("several percentage rules matching one person at one till: only the first pays (the others see its bonus)", async () => {
    await addRule({ id: "CR_001", percentage: 10, threshold: 0 });
    await addRule({ id: "CR_002", percentage: 50, threshold: 0 });
    await addRule({ id: "CR_003", staffId: "S_ASH", percentage: 90, threshold: 0 });
    await addSale("S_ASH", "cstore", "2026-09-22", 1000);
    const r = await run();
    expect(forStaff(r, "S_ASH").map((b) => [b.ruleId, b.amount])).toEqual([["CR_001", 100]]);
  });

  it("sales outside the week do not count; sales on its first and last day do", async () => {
    await addRule({ id: "CR_001", percentage: 10, threshold: 0 });
    await addSale("S_ASH", "cstore", "2026-09-20", 1000); // the Sunday before
    await addSale("S_ASH", "cstore", "2026-09-21", 100); // Monday
    await addSale("S_ASH", "cstore", "2026-09-27", 200); // Sunday
    await addSale("S_ASH", "cstore", "2026-09-28", 1000); // the Monday after
    expect(proposals(await run())[0]).toMatchObject({ sales: 300, amount: 30 });
  });

  it("a week with no active rule still writes a run row, with a note, and no bonus, no commission.run audit, no notification", async () => {
    await addRule({ id: "CR_001", percentage: 10, threshold: 0, from: "2026-09-22" }); // starts after the week's first day
    const r = await run();
    expect(r).toMatchObject({ skipped: false, bonusesProposed: [], totalAmount: 0, staffCount: 0 });
    const runs = await runRows();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ week_start: "2026-09-21", week_end: "2026-09-27", staff_count: 0, bonuses_created: 0, total_commission_amount: 0, computed_by: "S_ADM", notes: "No active rules for this week" });
    expect(await audits()).toEqual([]);
  });
});

describe("what a run writes", () => {
  it("proposed bonuses only: status proposed, type commission, created by the actor, dated and stamped now, tied to the run and the rule; a run row; the audit rows", async () => {
    await addRule(FEE);
    await addRule(COMMISSION);
    await addSale("S_MEE", "cstore", "2026-09-22", 6000);
    const r = (await run()) as Extract<Awaited<ReturnType<typeof run>>, { skipped: false }>;
    const rows = await bonusRows();
    expect(rows).toHaveLength(2);
    for (const b of rows) {
      expect(b).toMatchObject({ status: "proposed", type: "commission", created_by: "S_ADM", date: "2026-09-30", period_start: "2026-09-21", period_end: "2026-09-27", company: "cstore", source_run_id: r.runId, notes: null });
      expect(b.created_at.toISOString()).toBe(NOW.toISOString());
      expect(b.bonus_id).toMatch(/^B_20260930_100000_[a-z0-9]{1,10}$/);
    }
    expect(rows.map((b) => b.source_rule_id).sort()).toEqual(["CR_001", "CR_002"]);
    expect(await db.query("select 1 from ops.bonuses where status in ('pending', 'paid')")).toEqual([]);
    expect(r.runId).toMatch(/^CRN_20260930_100000_[a-z0-9]{1,10}$/);
    expect(await runRows()).toEqual([
      expect.objectContaining({ run_id: r.runId, week_start: "2026-09-21", week_end: "2026-09-27", staff_count: 2, bonuses_created: 2, total_commission_amount: 170, computed_by: "S_ADM", notes: null }),
    ]);
    const log = await audits();
    expect(log.map((a) => a.action).sort()).toEqual(["bonus.proposed", "bonus.proposed", "commission.run", "notify.commission.computed"]);
    const runAudit = log.find((a) => a.action === "commission.run");
    expect(runAudit).toMatchObject({ actor_id: "S_ADM", target_type: "commission_runs", target_id: r.runId, before: null });
    expect(JSON.parse(runAudit.after)).toEqual({ weekStart: "2026-09-21", weekEnd: "2026-09-27", bonusesCreated: 2, totalAmount: 170, staffCount: 2 });
    const notice = log.find((a) => a.action === "notify.commission.computed");
    expect(notice).toMatchObject({ actor_id: "SYSTEM", target_type: "notification", target_id: null, details: "🎯 Commission run: 2 bonus(es), $170.00 total" });
    const bonusAudit = log.filter((a) => a.action === "bonus.proposed")[0];
    expect(bonusAudit).toMatchObject({ actor_id: "S_ADM", target_type: "bonuses" });
    expect(JSON.parse(bonusAudit.after)).toMatchObject({ type: "commission", status: "proposed" });
    expect(log.every((a) => a.timestamp.toISOString() === NOW.toISOString())).toBe(true);
  });

  it("the actor is whoever it is given, and SYSTEM_TRIGGER when nobody is named", async () => {
    await addRule(FEE);
    await run({ actorId: undefined });
    expect((await runRows())[0]?.computed_by).toBe("SYSTEM_TRIGGER");
    expect((await bonusRows())[0]?.created_by).toBe("SYSTEM_TRIGGER");
  });

  it("the weekStart and weekEnd are required", async () => {
    await expect(run({ weekStart: undefined })).rejects.toThrow("weekStart and weekEnd required");
    await expect(run({ weekEnd: undefined })).rejects.toThrow("weekStart and weekEnd required");
    await expect(withTransaction(db, (tx) => commissions.runForWeek(tx, undefined as never, deps()))).rejects.toThrow("weekStart and weekEnd required");
  });

  it("dates may be given as text (Util.parseDate); the answer carries the dates as given", async () => {
    await addRule(FEE);
    const r = await run({ weekStart: "2026-09-21", weekEnd: "2026-09-27" });
    expect(proposals(r)).toHaveLength(1);
    expect((await runRows())[0]).toMatchObject({ week_start: "2026-09-21", week_end: "2026-09-27" });
  });

  it("a skipped run answers the first run's id and the reason, and writes nothing", async () => {
    await addRule(FEE);
    const first = (await run()) as { runId: string };
    await owner.query("delete from ops.audit_log");
    const again = await run({}, new Date(NOW.getTime() + 60_000));
    expect(again).toEqual({
      skipped: true,
      existingRunId: first.runId,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      reason: `Run already exists for this week (${first.runId}). Pass force=true to re-run.`,
    });
    expect(await runRows()).toHaveLength(1);
    expect(await audits()).toEqual([]);
  });

  it("a forced re-run notes which run it follows (the first one of that week); force does not touch the earlier bonuses", async () => {
    await addRule(FEE);
    await addRule(COMMISSION);
    await addSale("S_ASH", "cstore", "2026-09-22", 9000);
    const first = (await run()) as { runId: string };
    await owner.query("update ops.bonuses set status = 'pending' where staff_id = 'S_ASH' and amount = 200");
    const second = (await run({ force: true, actorId: "S_BOS" }, new Date(NOW.getTime() + 60_000))) as { runId: string; bonusesProposed: unknown[] };
    const third = (await run({ force: true }, new Date(NOW.getTime() + 120_000))) as { runId: string };
    expect(second.bonusesProposed).toEqual([]);
    const runs = await runRows();
    expect(runs).toHaveLength(3);
    expect(runs.find((r) => r.run_id === second.runId)).toMatchObject({ bonuses_created: 0, staff_count: 0, total_commission_amount: 0, computed_by: "S_BOS", notes: `Forced re-run (previous: ${first.runId})` });
    expect(runs.find((r) => r.run_id === third.runId)?.notes).toBe(`Forced re-run (previous: ${first.runId})`);
    const rows = await bonusRows();
    expect(rows.map((b) => [b.amount, b.status, b.source_run_id]).sort()).toEqual([[120, "proposed", first.runId], [200, "pending", first.runId]]);
  });

  it("force is only the boolean true", async () => {
    await addRule(FEE);
    await run();
    for (const force of ["true", 1, "yes", null, [true]]) {
      expect(await run({ force: force as never })).toMatchObject({ skipped: true });
    }
    expect(await runRows()).toHaveLength(1);
  });

  it("force fills in a cancelled bonus only: proposed, pending and paid ones still block", async () => {
    await addRule({ id: "CR_001", percentage: 10, threshold: 0 });
    await addSale("S_ASH", "cstore", "2026-09-22", 1000);
    await addSale("S_MEE", "cstore", "2026-09-22", 1000);
    await addSale("S_BOS", "cstore", "2026-09-22", 1000);
    await run();
    const ids = Object.fromEntries((await bonusRows()).map((b) => [b.staff_id, b.bonus_id]));
    await owner.query("update ops.bonuses set status = 'pending' where bonus_id = $1", [ids["S_ASH"]]);
    await owner.query("update ops.bonuses set status = 'paid' where bonus_id = $1", [ids["S_BOS"]]);
    await owner.query("update ops.bonuses set status = 'cancelled' where bonus_id = $1", [ids["S_MEE"]]);
    const r = await run({ force: true }, new Date(NOW.getTime() + 60_000));
    expect(proposals(r).map((b) => b.staffId)).toEqual(["S_MEE"]);
    expect((await bonusRows()).map((b) => [b.staff_id, b.status]).sort()).toEqual([["S_ASH", "pending"], ["S_BOS", "paid"], ["S_MEE", "cancelled"], ["S_MEE", "proposed"]]);
  });

  it("a person's bonuses for another week or another till do not block this one", async () => {
    await addRule({ id: "CR_001", percentage: 10, threshold: 0 });
    await addSale("S_ASH", "cstore", "2026-09-22", 1000);
    await addBonus({ ps: "2026-09-14", pe: "2026-09-20", run: "CRN_A", rule: "CR_001" });
    await addBonus({ id: "B_2", company: "vape", run: "CRN_B", rule: "CR_001" });
    await addBonus({ id: "B_3", type: "bonus", run: "CRN_C", rule: null }); // an admin's bonus is not a commission
    expect(proposals(await run())).toHaveLength(1);
  });

  it("two runs of one week that start at once: only one proposes (the week is locked before it is read)", async () => {
    await addRule(FEE);
    const other = await connect(testDb.appUrl);
    const slow = (tx: Tx): Tx => {
      const wait = async (text: string): Promise<void> => {
        if (/from ops\.commission_runs/.test(text)) await new Promise((r) => setTimeout(r, 400)); // both would have read "no run yet" by now
      };
      return {
        ...tx,
        query: async (t: string, p?: readonly unknown[]) => (await wait(t), tx.query(t, p)),
        one: async (t: string, p?: readonly unknown[]) => (await wait(t), tx.one(t, p)),
        maybeOne: async (t: string, p?: readonly unknown[]) => (await wait(t), tx.maybeOne(t, p)),
      } as Tx;
    };
    try {
      const go = (conn: Db) => withTransaction(conn, (tx) => commissions.runForWeek(slow(tx), { weekStart: WEEK_START, weekEnd: WEEK_END, actorId: "S_ADM" }, deps()));
      const results = await Promise.all([go(db), go(other)]);
      expect(results.filter((r) => "skipped" in r && r.skipped === true)).toHaveLength(1);
      expect(results.filter((r) => "bonusesProposed" in r && r.bonusesProposed.length === 1)).toHaveLength(1);
      expect(await runRows()).toHaveLength(1);
      expect(await bonusRows()).toHaveLength(1);
    } finally {
      await other.close();
    }
  });

  it("two runs of different weeks do not wait for each other", async () => {
    await addRule({ ...FEE, from: "2026-01-01" });
    const other = await connect(testDb.appUrl);
    try {
      const a = withTransaction(db, async (tx) => {
        const r = await commissions.runForWeek(tx, { weekStart: WEEK_START, weekEnd: WEEK_END, actorId: "S_ADM" }, deps());
        await new Promise((res) => setTimeout(res, 300)); // holds its lock
        return r;
      });
      const started = Date.now();
      const b = await withTransaction(other, (tx) =>
        commissions.runForWeek(tx, { weekStart: parseDate("2026-09-14") as Date, weekEnd: new Date((parseDate("2026-09-21") as Date).getTime() - 1), actorId: "S_ADM" }, deps()),
      );
      expect(Date.now() - started).toBeLessThan(290);
      expect("bonusesProposed" in b).toBe(true);
      await a;
    } finally {
      await other.close();
    }
  });

  it("the number of statements does not grow with the number of people, and ids made in one second are all different", async () => {
    await addRule({ id: "CR_001", percentage: 10, threshold: 0 });
    await addRule({ id: "CR_002", type: "fixed", fixedAmount: 5 });
    const count = async (): Promise<number> => {
      let n = 0;
      const spy = (tx: Tx): Tx => ({ ...tx, query: async (t, p) => (n++, tx.query(t, p)), one: async (t, p) => (n++, tx.one(t, p)), maybeOne: async (t, p) => (n++, tx.maybeOne(t, p)) }) as Tx;
      await withTransaction(db, (tx) => commissions.runForWeek(spy(tx), { weekStart: WEEK_START, weekEnd: WEEK_END, actorId: "S_ADM", force: true }, deps()));
      return n;
    };
    for (const s of ["S_ASH", "S_MEE", "S_BOS"]) await addSale(s, "cstore", "2026-09-22", 1000);
    const small = await count();
    for (let i = 0; i < 40; i++) {
      await owner.query("insert into ops.staff (staff_id, name, active, role, companies_authorized) values ($1,$2,true,'employee','cstore')", [`S_X${i}`, `Person ${i}`]);
      await addSale(`S_X${i}`, "cstore", "2026-09-22", 1000 + i);
    }
    await owner.query("delete from ops.commission_runs where run_id not in (select source_run_id from ops.bonuses where source_run_id is not null)");
    const large = await count();
    expect(large).toBe(small);
    const rows = await bonusRows();
    expect(rows.length).toBeGreaterThan(80);
    expect(new Set(rows.map((b) => b.bonus_id)).size).toBe(rows.length);
  });

  it("an engine that fails writes nothing: its bonuses roll back with it", async () => {
    await addRule(FEE);
    const broken = (tx: Tx): Tx => ({ ...tx, query: async (t: string, p?: readonly unknown[]) => (/insert into ops\.commission_runs/.test(t) ? Promise.reject(new Error("boom")) : tx.query(t, p)), one: tx.one, maybeOne: tx.maybeOne }) as Tx;
    await expect(withTransaction(db, (tx) => commissions.runForWeek(broken(tx), { weekStart: WEEK_START, weekEnd: WEEK_END, actorId: "S_ADM" }, deps()))).rejects.toThrow("boom");
    expect(await bonusRows()).toEqual([]);
    expect(await runRows()).toEqual([]);
    expect(await audits()).toEqual([]);
  });
});

describe("which week", () => {
  // Monday to Sunday in Toronto, the week before the one containing `now`.
  const weekFor = async (now: string) => {
    await owner.query("delete from ops.commission_runs");
    const r = (await withTransaction(db, (tx) => commissions.runForPreviousWeek(tx, "S_ADM", false, deps(new Date(now))))) as { weekStart: Date; weekEnd: Date };
    return [r.weekStart.toISOString(), r.weekEnd.toISOString()];
  };
  beforeEach(() => addRule({ ...FEE, from: "2026-01-01" }));

  it("on the Monday morning: the week that ended last night", async () => {
    expect(await weekFor("2026-09-28T13:00:00Z")).toEqual(["2026-09-21T04:00:00.000Z", "2026-09-28T03:59:59.999Z"]);
  });
  it("on the Sunday evening it is still the week before this one (a Sunday belongs to the week it ends)", async () => {
    expect(await weekFor("2026-09-28T02:30:00Z")).toEqual(["2026-09-14T04:00:00.000Z", "2026-09-21T03:59:59.999Z"]);
  });
  it("across a clock change the week keeps its Toronto midnights (Monday 2 November 2026, after the clocks went back)", async () => {
    expect(await weekFor("2026-11-02T14:00:00Z")).toEqual(["2026-10-26T04:00:00.000Z", "2026-11-02T04:59:59.999Z"]);
  });
  it("across a month end", async () => {
    expect(await weekFor("2026-10-05T13:00:00Z")).toEqual(["2026-09-28T04:00:00.000Z", "2026-10-05T03:59:59.999Z"]);
  });
  it("a plain run for the previous week is skipped when one exists; forced it runs", async () => {
    await weekFor("2026-09-28T13:00:00Z");
    const again = await withTransaction(db, (tx) => commissions.runForPreviousWeek(tx, "S_ADM", false, deps(new Date("2026-09-28T13:00:00Z"))));
    expect(again).toMatchObject({ skipped: true });
    const forced = await withTransaction(db, (tx) => commissions.runForPreviousWeek(tx, "S_ADM", true, deps(new Date("2026-09-28T13:00:00Z"))));
    expect(forced).toMatchObject({ skipped: false });
  });
});

describe("reading the runs", () => {
  it("a blank run row reads as zeros and empty text (kept from the old record), not as a number that was measured", async () => {
    await owner.query("insert into ops.commission_runs (run_id) values ('CRN_BLANK')");
    expect(await commissions.getAllRuns(db)).toEqual([
      { runId: "CRN_BLANK", weekStart: null, weekEnd: null, staffCount: 0, bonusesCreated: 0, totalCommissionAmount: 0, computedAt: null, computedBy: "", notes: "" },
    ]);
  });

  it("the placeholder run of a fresh sheet is left out, text is trimmed, and rows come in the order they were written (not by time or id)", async () => {
    await owner.query(
      `insert into ops.commission_runs (run_id, week_start, week_end, staff_count, bonuses_created, total_commission_amount, computed_at, computed_by, notes) values
       ('CRN_PLACEHOLDER_1', null, null, null, null, null, null, null, null),
       ('  CRN_B  ', '2026-09-14', '2026-09-20', 2, 3, 40.5, '2026-09-21T13:00:00Z', ' S_ADM ', 'n'),
       ('CRN_A', '2026-09-07', '2026-09-13', 1, 1, 10, '2026-09-14T13:00:00Z', 'SYSTEM_TRIGGER', null)`,
    );
    const runs = await commissions.getAllRuns(db);
    expect(runs.map((r) => r.runId)).toEqual(["CRN_B", "CRN_A"]);
    expect(runs[0]).toEqual({ runId: "CRN_B", weekStart: "2026-09-14", weekEnd: "2026-09-20", staffCount: 2, bonusesCreated: 3, totalCommissionAmount: 40.5, computedAt: new Date("2026-09-21T13:00:00Z"), computedBy: " S_ADM ", notes: "n" });
  });

  it("findRunForWeek answers the first run written for that week (by its Toronto date), or null", async () => {
    await owner.query(
      `insert into ops.commission_runs (run_id, week_start, computed_at) values ('CRN_2', '2026-09-21', '2026-09-30T15:00:00Z'), ('CRN_1', '2026-09-21', '2026-09-30T14:00:00Z')`,
    );
    expect((await commissions.findRunForWeek(db, WEEK_START))?.runId).toBe("CRN_2");
    expect(await commissions.findRunForWeek(db, parseDate("2026-09-14") as Date)).toBeNull();
  });
});

describe("the two RPCs", () => {
  const session = (staffId: string, role: Session["role"]): Session => ({ staffId, name: "x", role, companiesAuthorized: ["cstore"], expiresAt: 0 });
  const ADMIN = session("S_BOS", "admin");

  async function rpc(handler: (ctx: RpcContext, ...a: unknown[]) => unknown, who: Session | null, args: unknown[], now = NOW): Promise<any> {
    return withTransaction(db, async (tx) => handler({ db: tx, session: who, config: async () => Config.fromRows([]), env: {}, fetch, now }, ...args));
  }

  it("rpcRunCommissionEngine runs the week before this one as the signed-in person, and answers JSON: dates as ISO text", async () => {
    await addRule({ ...FEE, from: "2026-01-01" });
    const r = await rpc(rpcRunCommissionEngine, ADMIN, [], new Date("2026-09-28T13:00:00Z"));
    expect(r).toMatchObject({ skipped: false, totalAmount: 120, staffCount: 1, weekStart: "2026-09-21T04:00:00.000Z", weekEnd: "2026-09-28T03:59:59.999Z" });
    expect(r.runId).toMatch(/^CRN_20260928_090000_/);
    expect(r.bonusesProposed[0]).toMatchObject({ staffId: "S_ASH", staffName: "Ashin Quill", company: "cstore", ruleId: "CR_001", ruleType: "fixed", sales: 0, threshold: 0, percentage: 0, fixedAmount: 120, amount: 120 });
    expect((await runRows())[0]?.computed_by).toBe("S_BOS");
  });

  it("rpcRunCommissionEngine skips a second run, and forces only on true; a skipped answer has its dates as ISO text", async () => {
    await addRule({ ...FEE, from: "2026-01-01" });
    const now = new Date("2026-09-28T13:00:00Z");
    const first = await rpc(rpcRunCommissionEngine, ADMIN, [], now);
    const skipped = await rpc(rpcRunCommissionEngine, ADMIN, ["true"], now);
    expect(skipped).toEqual({ skipped: true, existingRunId: first.runId, weekStart: "2026-09-21T04:00:00.000Z", weekEnd: "2026-09-28T03:59:59.999Z", reason: `Run already exists for this week (${first.runId}). Pass force=true to re-run.` });
    expect(await rpc(rpcRunCommissionEngine, ADMIN, [true], now)).toMatchObject({ skipped: false, bonusesProposed: [] });
  });

  it("rpcGetCommissionRuns: newest first by when it was computed, the limit as Number(limit) || 12, names looked up, dates as ISO text", async () => {
    for (let i = 1; i <= 14; i++) {
      await owner.query(
        "insert into ops.commission_runs (run_id, week_start, week_end, staff_count, bonuses_created, total_commission_amount, computed_at, computed_by, notes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
        [`CRN_${String(i).padStart(2, "0")}`, `2026-0${i < 10 ? 8 : 9}-${String((i % 9) + 1).padStart(2, "0")}`, "2026-09-20", i, i, i * 1.5, new Date(Date.UTC(2026, 8, i, 13)), i === 3 ? "S_ASH" : "SYSTEM_TRIGGER", i === 5 ? "note" : null],
      );
    }
    const all = await rpc(rpcGetCommissionRuns, ADMIN, []);
    expect(all.map((r: any) => r.runId)).toEqual(["CRN_14", "CRN_13", "CRN_12", "CRN_11", "CRN_10", "CRN_09", "CRN_08", "CRN_07", "CRN_06", "CRN_05", "CRN_04", "CRN_03"]);
    const three = (await rpc(rpcGetCommissionRuns, ADMIN, [1, 2, 3].length ? [3] : []))[2];
    expect(three).toEqual({ runId: "CRN_12", weekStart: "2026-09-04T04:00:00.000Z", weekEnd: "2026-09-21T03:59:59.000Z", staffCount: 12, bonusesCreated: 12, totalCommissionAmount: 18, computedAt: "2026-09-12T13:00:00.000Z", computedBy: "SYSTEM_TRIGGER", computedByName: "SYSTEM_TRIGGER", notes: "" });
    expect((await rpc(rpcGetCommissionRuns, ADMIN, [100])).length).toBe(14);
    expect((await rpc(rpcGetCommissionRuns, ADMIN, [2])).map((r: any) => r.runId)).toEqual(["CRN_14", "CRN_13"]);
    expect((await rpc(rpcGetCommissionRuns, ADMIN, [0])).length).toBe(12);
    expect((await rpc(rpcGetCommissionRuns, ADMIN, ["abc"])).length).toBe(12);
    expect((await rpc(rpcGetCommissionRuns, ADMIN, [-1])).length).toBe(13);
    expect((await rpc(rpcGetCommissionRuns, ADMIN, ["2"])).length).toBe(2);
    const named = (await rpc(rpcGetCommissionRuns, ADMIN, [20])).find((r: any) => r.runId === "CRN_03");
    expect(named).toMatchObject({ computedBy: "S_ASH", computedByName: "Ashin Quill" });
    expect((await rpc(rpcGetCommissionRuns, ADMIN, [20])).find((r: any) => r.runId === "CRN_05").notes).toBe("note");
  });

  it("rpcGetCommissionRuns: a run with no dates answers null for them, and no row index is sent", async () => {
    await owner.query("insert into ops.commission_runs (run_id) values ('CRN_BLANK')");
    const [r] = await rpc(rpcGetCommissionRuns, ADMIN, []);
    expect(r).toEqual({ runId: "CRN_BLANK", weekStart: null, weekEnd: null, staffCount: 0, bonusesCreated: 0, totalCommissionAmount: 0, computedAt: null, computedBy: "", computedByName: "", notes: "" });
    expect(r).not.toHaveProperty("_rowIndex");
  });

  it("the registry has both handlers; only rpcGetCommissionRuns had its errors prefixed with its own name", () => {
    expect(handlers["rpcGetCommissionRuns"]).toBe(rpcGetCommissionRuns);
    expect(handlers["rpcRunCommissionEngine"]).toBe(rpcRunCommissionEngine);
    expect(ERROR_PREFIXED.has("rpcGetCommissionRuns")).toBe(true);
    expect(ERROR_PREFIXED.has("rpcRunCommissionEngine")).toBe(false);
  });
});
