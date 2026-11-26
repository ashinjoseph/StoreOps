// The CommissionRules module and its three RPCs, against a real database with invented people.
//
// The parity cases (ops/parity/cases/commission-rules.ts) compare what the old app and this one answer
// and store for the fixture's three rules. What the fixture lacks is covered here: the old unit
// assertions of tests/suites/commission-fixed.js that concern rules (validation, the two shapes, a blank
// type reading as a percentage rule, a fixed amount only on a fixed rule, the type never changing),
// what counts as active and effective on a date, the next id (gaps, placeholders, concurrency), what
// the audit rows hold, and every refusal the new app adds where the Sheet took something the database
// would not (an unreadable date, a percentage that is not a number or is out of range, a figure too
// big for the money column). Expected values are what src/CommissionRules.gs and the rpc* functions in
// src/WebApp.gs return and store.
//
// Left to the engine card (Commissions.gs, not this module): every assertion of commission-fixed.js
// that calls Commissions.runForWeek (a fixed rule pays with no sales, fee and commission both pay and
// in either order, once per week, stops when the rule ends, an inactive rule pays nothing, a deleted
// rule stops blocking, legacy rows still block, a threshold makes a fee conditional, the bonus records
// its rule).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../src/auth/types";
import { connect, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { parseDate } from "../src/lib/dates";
import * as rules from "../src/modules/commission-rules";
import { rpcCreateCommissionRule, rpcGetCommissionRules, rpcUpdateCommissionRule } from "../src/rpc/handlers/commission-rules";
import type { RpcContext } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
// The app role cannot delete money or audit rows (by design), so the fixture rows are reset as the owner.
let owner: Db & { close(): Promise<void> };

// Toronto is UTC-5 in November: 09:00 local is 14:00Z.
const NOW = new Date("2026-11-20T14:00:00Z");
const LATER = new Date("2026-11-20T16:30:00Z");

const STAFF: Array<[string, string, boolean, string]> = [
  ["S_001", "Ada Quill", true, "admin"],
  ["S_002", "Bram Hale", true, "manager"],
  ["S_003", "Cleo Marsh", true, "employee"],
  ["S_004", "Dara Vance", false, "employee"],
];

interface Seed {
  id: string;
  name?: string;
  applies?: string;
  staff?: string | null;
  company?: string;
  threshold?: number | null;
  percentage?: number | null;
  active?: boolean;
  from?: string | null;
  to?: string | null;
  by?: string | null;
  at?: string | null;
  notes?: string | null;
  type?: string;
  fixed?: number | null;
}

async function seed(s: Seed): Promise<void> {
  await owner.query(
    `insert into ops.commission_rules (rule_id, name, applies_to, staff_id, company, threshold, percentage, active,
                                       effective_from, effective_to, created_by, created_at, notes, rule_type, fixed_amount)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      s.id,
      s.name ?? s.id,
      s.applies ?? "all_staff",
      s.staff ?? null,
      s.company ?? "cstore",
      s.threshold === undefined ? 0 : s.threshold,
      s.percentage === undefined ? 0 : s.percentage,
      s.active ?? true,
      s.from === undefined ? "2026-01-01" : s.from,
      s.to ?? null,
      s.by === undefined ? "S_001" : s.by,
      s.at === undefined ? "2026-01-01T15:00:00Z" : s.at,
      s.notes ?? null,
      s.type ?? "percentage",
      s.fixed === undefined ? 0 : s.fixed,
    ],
  );
}

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

beforeEach(async () => {
  for (const t of ["audit_log", "bonuses", "commission_runs", "commission_rules", "staff"]) await owner.query(`delete from ops.${t}`);
  for (const s of STAFF) await owner.query("insert into ops.staff (staff_id, name, active, role) values ($1,$2,$3,$4)", s);
});

const session = (staffId: string, role: Session["role"]): Session => ({ staffId, name: "x", role, companiesAuthorized: ["cstore"], expiresAt: 0 });
const ADMIN = session("S_001", "admin");
const PAYROLL = session("S_006", "payroll_admin");

async function rpc(handler: (ctx: RpcContext, ...a: unknown[]) => unknown, who: Session | null, args: unknown[], now = NOW): Promise<any> {
  return withTransaction(db, async (tx) => handler({ db: tx, session: who, config: () => Promise.reject(new Error("no config")), env: {}, fetch, now }, ...args));
}
const inTx = <T>(fn: (tx: Parameters<Parameters<typeof withTransaction>[1]>[0]) => Promise<T>): Promise<T> => withTransaction(db, fn);
const row = (id: string) => db.one<any>("select * from ops.commission_rules where rule_id = $1", [id]);
const count = async () => (await db.one<{ n: number }>("select count(*)::int as n from ops.commission_rules")).n;
const audits = () => db.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details, "timestamp" from ops.audit_log order by log_id`);
const create = (input: Record<string, unknown>, now = NOW) => inTx((tx) => rules.create(tx, { actorId: "S_001", ...input }, now));
const update = (input: Record<string, unknown>, now = NOW) => inTx((tx) => rules.update(tx, { actorId: "S_001", ...input }, now));

/** What the page sends for a percentage rule, as the old module received it after rpcCreateCommissionRule's Number() calls. */
const pct = (extra: Record<string, unknown> = {}) => ({
  name: "Cstore weekly",
  appliesTo: "all_staff",
  company: "cstore",
  threshold: 6000,
  percentage: 3,
  ruleType: "percentage",
  fixedAmount: 0,
  active: true,
  effectiveFrom: parseDate("2026-11-23"),
  effectiveTo: null,
  notes: "",
  ...extra,
});
const fixed = (extra: Record<string, unknown> = {}) => pct({ name: "Fee", appliesTo: "specific_staff", staffId: "S_003", threshold: 0, percentage: NaN, ruleType: "fixed", fixedAmount: 120, ...extra });

describe("reads", () => {
  it("getAll returns the old record shape: trimmed text, blanks as '' or 0, dates as days, in id order", async () => {
    await seed({ id: "CR_002", name: "  Vape  ", company: "vape", threshold: 1200, percentage: 5, from: "2026-09-11", to: "2026-12-31", by: " S_001 ", notes: "n" });
    await seed({ id: "CR_001", name: "Fee", applies: "specific_staff", staff: "S_002", type: "fixed", fixed: 120, percentage: 0, from: "2026-09-11" });
    await seed({ id: "CR_010", threshold: null, percentage: null, fixed: null, from: null, to: null, by: null, at: null, notes: null, active: false });
    expect(await rules.getAll(db)).toEqual([
      {
        ruleId: "CR_001",
        name: "Fee",
        appliesTo: "specific_staff",
        staffId: "S_002",
        company: "cstore",
        threshold: 0,
        percentage: 0,
        active: true,
        effectiveFrom: "2026-09-11",
        effectiveTo: null,
        createdBy: "S_001",
        createdAt: new Date("2026-01-01T15:00:00Z"),
        notes: "",
        ruleType: "fixed",
        fixedAmount: 120,
      },
      {
        ruleId: "CR_002",
        name: "  Vape  ",
        appliesTo: "all_staff",
        staffId: "",
        company: "vape",
        threshold: 1200,
        percentage: 5,
        active: true,
        effectiveFrom: "2026-09-11",
        effectiveTo: "2026-12-31",
        createdBy: " S_001 ",
        createdAt: new Date("2026-01-01T15:00:00Z"),
        notes: "n",
        ruleType: "percentage",
        fixedAmount: 0,
      },
      {
        ruleId: "CR_010",
        name: "CR_010",
        appliesTo: "all_staff",
        staffId: "",
        company: "cstore",
        threshold: 0, // a blank threshold reads as 0, as in the old app
        percentage: 0,
        active: false,
        effectiveFrom: null,
        effectiveTo: null,
        createdBy: "",
        createdAt: null,
        notes: "",
        ruleType: "percentage",
        fixedAmount: 0,
      },
    ]);
  });

  it("orders by the number in the id, so CR_1000 comes after CR_999, and leaves placeholder rows out", async () => {
    for (const id of ["CR_1000", "CR_999", "CR_PLACEHOLDER_1", "CR_002"]) await seed({ id });
    expect((await rules.getAll(db)).map((r) => r.ruleId)).toEqual(["CR_002", "CR_999", "CR_1000"]);
  });

  it("getById finds one, or null; a padded or non-string id finds nothing (the old comparison was ===)", async () => {
    await seed({ id: "CR_001", name: "One" });
    expect((await rules.getById(db, "CR_001"))?.name).toBe("One");
    expect(await rules.getById(db, "CR_009")).toBeNull();
    expect(await rules.getById(db, " CR_001 ")).toBeNull();
    expect(await rules.getById(db, 1 as unknown as string)).toBeNull();
    expect(await rules.getById(db, undefined as unknown as string)).toBeNull();
    await seed({ id: "CR_PLACEHOLDER_X" });
    expect(await rules.getById(db, "CR_PLACEHOLDER_X")).toBeNull();
  });

  it("getActiveOn: active, started, and not ended; the end date's own midnight still counts, the rest of that day does not", async () => {
    await seed({ id: "CR_001", from: "2026-11-23", to: null });
    await seed({ id: "CR_002", from: "2026-11-23", to: "2026-11-29" });
    await seed({ id: "CR_003", from: "2026-11-23", active: false });
    await seed({ id: "CR_004", from: null });
    await seed({ id: "CR_005", from: "2026-11-24" });
    const ids = async (d: Date) => (await rules.getActiveOn(db, d, NOW)).map((r) => r.ruleId);
    expect(await ids(parseDate("2026-11-23")!)).toEqual(["CR_001", "CR_002"]); // the start day's midnight
    expect(await ids(parseDate("2026-11-22")!)).toEqual([]);
    expect(await ids(parseDate("2026-11-24")!)).toEqual(["CR_001", "CR_002", "CR_005"]);
    expect(await ids(parseDate("2026-11-29")!)).toEqual(["CR_001", "CR_002", "CR_005"]); // the end day's midnight
    expect(await ids(new Date("2026-11-29T15:00:00Z"))).toEqual(["CR_001", "CR_005"]); // 10:00 on the end day: ended
    expect(await ids(parseDate("2026-11-30")!)).toEqual(["CR_001", "CR_005"]);
  });

  it("getActiveOn with something that is not a Date uses the call's time", async () => {
    await seed({ id: "CR_001", from: "2026-11-20", to: "2026-11-20" });
    expect((await rules.getActiveOn(db, "2026-11-20", parseDate("2026-11-20")!)).map((r) => r.ruleId)).toEqual(["CR_001"]);
    expect(await rules.getActiveOn(db, undefined, NOW)).toEqual([]); // 09:00 on the end day: ended
  });

  it("getRulesFor: the company must match; all-staff rules apply to everyone, specific ones to their person", async () => {
    await seed({ id: "CR_001", company: "cstore" });
    await seed({ id: "CR_002", company: "vape" });
    await seed({ id: "CR_003", company: "cstore", applies: "specific_staff", staff: "S_002" });
    await seed({ id: "CR_004", company: "vape", applies: "specific_staff", staff: "S_003" });
    const week = parseDate("2026-11-16")!;
    const ids = async (staff: string, company: string) => (await rules.getRulesFor(db, staff, company, week, NOW)).map((r) => r.ruleId);
    expect(await ids("S_002", "cstore")).toEqual(["CR_001", "CR_003"]);
    expect(await ids("S_003", "cstore")).toEqual(["CR_001"]);
    expect(await ids("S_003", "vape")).toEqual(["CR_002", "CR_004"]);
    expect(await ids("S_002", "grocery")).toEqual([]);
  });

  it("RULE_TYPES is the two shapes", () => {
    expect(rules.RULE_TYPES).toEqual(["percentage", "fixed"]);
  });
});

describe("create: the two shapes (commission-fixed.js, 'A valid fixed rule is written the way the engine reads it')", () => {
  it("a percentage rule is stored as one: its percentage, no fixed amount, a threshold rounded to cents", async () => {
    const made = await create(pct({ threshold: 5000.005, percentage: 5 }));
    expect(made).toMatchObject({ ruleId: "CR_001", ruleType: "percentage", percentage: 5, fixedAmount: 0, threshold: 5000.01, active: true, appliesTo: "all_staff", staffId: "", company: "cstore" });
    expect(await row("CR_001")).toMatchObject({ rule_type: "percentage", percentage: 5, fixed_amount: 0, threshold: 5000.01, effective_from: "2026-11-23", effective_to: null, staff_id: null, notes: null, created_by: "S_001", created_at: NOW, active: true });
  });

  it("a fixed rule is stored as fixed, with its amount rounded and no percentage to confuse the list", async () => {
    const made = await create(fixed({ fixedAmount: 120.456 }));
    expect(made).toMatchObject({ ruleType: "fixed", fixedAmount: 120.46, percentage: 0, staffId: "S_003", appliesTo: "specific_staff" });
    expect(await row("CR_001")).toMatchObject({ rule_type: "fixed", fixed_amount: 120.46, percentage: 0, staff_id: "S_003" });
  });

  it("a rule type is read case-insensitively and trimmed; a blank one is a percentage rule", async () => {
    expect((await create(fixed({ ruleType: " FIXED " }))).ruleType).toBe("fixed");
    expect((await create(pct({ ruleType: "Percentage" }))).ruleType).toBe("percentage");
    expect((await create(pct({ ruleType: "" }))).ruleType).toBe("percentage");
    expect((await create(pct({ ruleType: undefined }))).ruleType).toBe("percentage");
    expect((await create(pct({ ruleType: null }))).ruleType).toBe("percentage");
  });

  it("an all-staff rule keeps no person even if one was sent; its audit row still shows what was sent", async () => {
    await create(pct({ staffId: "S_004" }));
    expect((await row("CR_001")).staff_id).toBeNull();
    expect(JSON.parse((await audits())[0].after).staffId).toBe("S_004");
  });

  it("every optional field blank: blanks are stored as NULL, a blank threshold as 0 (the old roundMoney(NaN))", async () => {
    await create({ name: "Bare", appliesTo: "all_staff", company: "vape", threshold: NaN, percentage: 1, effectiveFrom: parseDate("2026-11-23") });
    expect(await row("CR_001")).toMatchObject({ threshold: 0, active: true, effective_to: null, notes: null, staff_id: null, rule_type: "percentage", fixed_amount: 0 });
  });

  it("active is true unless it is exactly false", async () => {
    await create(pct({ active: false }));
    await create(pct({ active: undefined }));
    expect((await row("CR_001")).active).toBe(false);
    expect((await row("CR_002")).active).toBe(true);
  });

  it("the end date is stored as its Toronto day; an end before the start is accepted, as before", async () => {
    await create(pct({ effectiveFrom: parseDate("2026-12-01"), effectiveTo: parseDate("2026-11-01") }));
    expect(await row("CR_001")).toMatchObject({ effective_from: "2026-12-01", effective_to: "2026-11-01" });
  });
});

describe("create: validation, in the old order, with the old text", () => {
  const refused = async (input: Record<string, unknown>, message: string) => {
    await expect(create(input)).rejects.toThrow(new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    expect(await count()).toBe(0);
    expect(await audits()).toEqual([]);
  };

  it("name, appliesTo, person, company", async () => {
    await refused(pct({ name: "" }), "name required");
    await refused(pct({ name: undefined }), "name required");
    await refused(pct({ appliesTo: "" }), "appliesTo required");
    await refused(pct({ appliesTo: "everyone" }), "Invalid appliesTo: everyone");
    await refused(pct({ appliesTo: "specific_staff" }), "staffId required when appliesTo=specific_staff");
    await refused(pct({ appliesTo: "specific_staff", staffId: "S_999" }), "Staff not found: S_999");
    await refused(pct({ appliesTo: "specific_staff", staffId: " S_003 " }), "Staff not found:  S_003 ");
    await refused(pct({ company: undefined }), "Invalid company: undefined");
    await refused(pct({ company: "grocery" }), "Invalid company: grocery");
    await refused(pct({ company: "Vape" }), "Invalid company: Vape");
  });

  it("an inactive person can still have a rule; a person is looked up only for a specific-staff rule", async () => {
    expect((await create(pct({ appliesTo: "specific_staff", staffId: "S_004" }))).staffId).toBe("S_004");
    expect((await create(pct({ appliesTo: "all_staff", staffId: "S_999" }))).appliesTo).toBe("all_staff");
  });

  it("threshold: a number, not negative (commission-fixed.js refuses nothing here, but the old module does)", async () => {
    await refused(pct({ threshold: -1 }), "threshold must be a non-negative number");
    await refused(pct({ threshold: undefined }), "threshold must be a non-negative number");
    await refused(pct({ threshold: "5" }), "threshold must be a non-negative number");
    await refused(pct({ threshold: null }), "threshold must be a non-negative number");
  });

  it("a rule type that is not one of the two (commission-fixed.js: 'an unknown rule type')", async () => {
    await refused(pct({ ruleType: "magic", fixedAmount: 120 }), "Invalid ruleType: magic (expected one of: percentage, fixed)");
    await refused(pct({ ruleType: 5 }), "Invalid ruleType: 5 (expected one of: percentage, fixed)");
  });

  it("a rule that would pay nothing: a fixed rule with no, zero, negative or non-numeric amount (commission-fixed.js)", async () => {
    const msg = "fixedAmount must be a positive number for a fixed rule";
    await refused(fixed({ fixedAmount: undefined }), msg);
    await refused(fixed({ fixedAmount: 0 }), msg);
    await refused(fixed({ fixedAmount: -120 }), msg);
    await refused(fixed({ fixedAmount: NaN }), msg);
    await refused(fixed({ fixedAmount: "120" }), msg);
  });

  it("a percentage rule needs a percentage from 0 to 100 (commission-fixed.js: 'a percentage rule with no percentage')", async () => {
    const msg = "percentage must be between 0 and 100";
    await refused(pct({ percentage: undefined }), msg); // as the old module was called directly
    await refused(pct({ percentage: -0.01 }), msg);
    await refused(pct({ percentage: 100.01 }), msg);
    await refused(pct({ percentage: "5" }), msg);
    expect((await create(pct({ percentage: 0 }))).percentage).toBe(0); // 0 is accepted, as before: it pays nothing, and nobody was told
    expect((await create(pct({ percentage: 100 }))).percentage).toBe(100);
  });

  it("the actor is required, then the dates", async () => {
    await refused(pct({ actorId: "" }), "actorId required");
    await refused(pct({ effectiveFrom: null }), "effectiveFrom is required and must be a valid date");
    await refused(pct({ effectiveFrom: undefined }), "effectiveFrom is required and must be a valid date");
  });

  it("the first failing check wins: the order is name, appliesTo, person, company, threshold, type, amount, actor, date", async () => {
    await expect(create({ actorId: "" })).rejects.toThrow("name required");
    await expect(create({ actorId: "", name: "n" })).rejects.toThrow("appliesTo required");
    await expect(create({ actorId: "", name: "n", appliesTo: "all_staff" })).rejects.toThrow("Invalid company: undefined");
    await expect(create({ actorId: "", name: "n", appliesTo: "all_staff", company: "vape" })).rejects.toThrow("threshold must be a non-negative number");
    await expect(create({ actorId: "", name: "n", appliesTo: "all_staff", company: "vape", threshold: 0 })).rejects.toThrow("percentage must be between 0 and 100");
    await expect(create({ actorId: "", name: "n", appliesTo: "all_staff", company: "vape", threshold: 0, percentage: 1 })).rejects.toThrow("actorId required");
    await expect(create({ name: "n", appliesTo: "all_staff", company: "vape", threshold: 0, percentage: 1, actorId: "S_001" })).rejects.toThrow("effectiveFrom is required and must be a valid date");
  });
});

describe("create: what the Sheet took and this database refuses (deliberate differences)", () => {
  it("an unreadable start or end date is refused in plain words and nothing is written", async () => {
    await expect(create(pct({ effectiveFrom: new Date(NaN) }))).rejects.toThrow("effectiveFrom is required and must be a valid date");
    await expect(create(pct({ effectiveTo: new Date(NaN) }))).rejects.toThrow("effectiveTo must be a valid date");
    expect(await count()).toBe(0);
    expect(await audits()).toEqual([]);
  });

  it("a percentage that is not a number (the old RPC stored NaN for a missing one) is refused like one out of range", async () => {
    await expect(create(pct({ percentage: NaN }))).rejects.toThrow("percentage must be between 0 and 100");
    await expect(create(pct({ percentage: Infinity }))).rejects.toThrow("percentage must be between 0 and 100");
    expect(await count()).toBe(0);
  });

  it("a threshold or fixed amount too big for the money column is refused in plain words", async () => {
    await expect(create(pct({ threshold: 1e10 }))).rejects.toThrow("threshold is too large");
    await expect(create(pct({ threshold: Infinity }))).rejects.toThrow("threshold is too large");
    await expect(create(fixed({ fixedAmount: 1e10 }))).rejects.toThrow("fixedAmount is too large");
    expect((await create(pct({ threshold: 9999999999.99 }))).threshold).toBe(9999999999.99);
    expect(await count()).toBe(1);
  });
});

describe("create: ids, audit, and who may do it", () => {
  it("the first rule is CR_001; the next is one past the highest, gaps and placeholders ignored", async () => {
    expect((await create(pct())).ruleId).toBe("CR_001");
    await seed({ id: "CR_007" });
    await seed({ id: "CR_PLACEHOLDER_9" });
    await seed({ id: "CR_X12" });
    expect((await create(pct())).ruleId).toBe("CR_008");
    await seed({ id: "CR_999" });
    expect((await create(pct())).ruleId).toBe("CR_1000");
  });

  it("writes the audit row the old code wrote: action, target, and the figures as asked (not as rounded)", async () => {
    await create(pct({ threshold: 5000.005, percentage: 5 }));
    await create(fixed({ fixedAmount: 20.456, threshold: 10 }));
    const [a, b] = await audits();
    expect(a).toMatchObject({ actor_id: "S_001", action: "commission_rule.create", target_type: "commission_rules", target_id: "CR_001", before: null, details: null, timestamp: NOW });
    expect(JSON.parse(a.after)).toEqual({ name: "Cstore weekly", appliesTo: "all_staff", company: "cstore", threshold: 5000.005, percentage: 5, ruleType: "percentage", fixedAmount: 0 });
    // a fixed rule: the percentage was NaN, which JSON writes as null; the amount is as asked
    expect(JSON.parse(b.after)).toEqual({ name: "Fee", appliesTo: "specific_staff", staffId: "S_003", company: "cstore", threshold: 10, percentage: null, ruleType: "fixed", fixedAmount: 20.456 });
  });

  it("two rules made at once get two ids: the second waits for the first to commit", async () => {
    const a = await connect(testDb.appUrl);
    const b = await connect(testDb.appUrl);
    try {
      let release!: () => void;
      let written!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      const didWrite = new Promise<void>((r) => (written = r));
      const first = withTransaction(a, async (tx) => {
        const r = await rules.create(tx, { actorId: "S_001", ...pct() }, NOW);
        written();
        await hold;
        return r.ruleId;
      });
      await didWrite;
      let settled = false;
      const second = withTransaction(b, (tx) => rules.create(tx, { actorId: "S_002", ...pct({ name: "Second" }) }, LATER)).finally(() => (settled = true));
      second.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // waiting for the id
      release();
      expect(await first).toBe("CR_001");
      expect((await second).ruleId).toBe("CR_002");
      expect(await count()).toBe(2);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("a rule is never deleted: the app role has no delete on commission_rules", async () => {
    await create(pct());
    await expect(db.query("delete from ops.commission_rules where rule_id = 'CR_001'")).rejects.toThrow(/permission denied/);
    expect(await count()).toBe(1);
  });
});

describe("update", () => {
  beforeEach(async () => {
    await seed({ id: "CR_001", name: "Cstore weekly", threshold: 6000, percentage: 3, from: "2026-09-11", notes: "orig" });
    await seed({ id: "CR_002", name: "Fee", applies: "specific_staff", staff: "S_002", type: "fixed", fixed: 120, from: "2026-09-11", to: "2026-12-31" });
  });

  it("changes each field, rounding money and keeping the rest", async () => {
    expect(await update({ ruleId: "CR_001", name: "Renamed" })).toMatchObject({ name: "Renamed", threshold: 6000, percentage: 3 });
    expect(await update({ ruleId: "CR_001", threshold: 7500.126 })).toMatchObject({ threshold: 7500.13 });
    expect(await update({ ruleId: "CR_001", percentage: 3.5 })).toMatchObject({ percentage: 3.5 });
    expect(await update({ ruleId: "CR_001", active: false })).toMatchObject({ active: false });
    expect(await update({ ruleId: "CR_001", effectiveTo: parseDate("2026-12-31") })).toMatchObject({ effectiveTo: "2026-12-31" });
    expect(await update({ ruleId: "CR_001", notes: "A note" })).toMatchObject({ notes: "A note", name: "Renamed", active: false });
    expect(await row("CR_001")).toMatchObject({ name: "Renamed", threshold: 7500.13, percentage: 3.5, active: false, effective_to: "2026-12-31", notes: "A note", effective_from: "2026-09-11", created_by: "S_001" });
  });

  it("active is true only when exactly true; effectiveTo of null clears the end; notes of null or '' clear the note", async () => {
    await update({ ruleId: "CR_001", active: false });
    await update({ ruleId: "CR_001", active: "yes" });
    expect((await row("CR_001")).active).toBe(false);
    await update({ ruleId: "CR_001", active: true });
    expect((await row("CR_001")).active).toBe(true);
    await update({ ruleId: "CR_002", effectiveTo: null });
    expect((await row("CR_002")).effective_to).toBeNull();
    await update({ ruleId: "CR_001", notes: null });
    expect((await row("CR_001")).notes).toBeNull();
    await update({ ruleId: "CR_001", notes: "x" });
    await update({ ruleId: "CR_001", notes: "" });
    expect((await row("CR_001")).notes).toBeNull();
  });

  it("a patch cannot change the id, the creator, the shape or what the rule applies to", async () => {
    await update({ ruleId: "CR_001", newRuleId: "CR_777", createdBy: "S_003", appliesTo: "specific_staff", staffId: "S_003", company: "vape", effectiveFrom: parseDate("2020-01-01"), ruleType: "fixed", name: "x" });
    expect(await row("CR_001")).toMatchObject({ rule_id: "CR_001", created_by: "S_001", applies_to: "all_staff", staff_id: null, company: "cstore", effective_from: "2026-09-11", rule_type: "percentage", name: "x" });
    expect(await count()).toBe(2);
  });

  it("a fixed rule's type never changes under it (commission-fixed.js: 'its type never changes under it')", async () => {
    await update({ ruleId: "CR_002", ruleType: "percentage" });
    expect((await rules.getById(db, "CR_002"))?.ruleType).toBe("fixed");
  });

  it("a flat amount: only on a fixed rule, and positive (commission-fixed.js)", async () => {
    await expect(update({ ruleId: "CR_001", fixedAmount: 50 })).rejects.toThrow("fixedAmount only applies to a fixed rule; CR_001 is a percentage rule");
    await expect(update({ ruleId: "CR_002", fixedAmount: 0 })).rejects.toThrow("fixedAmount must be a positive number");
    await expect(update({ ruleId: "CR_002", fixedAmount: -3 })).rejects.toThrow("fixedAmount must be a positive number");
    await expect(update({ ruleId: "CR_002", fixedAmount: NaN })).rejects.toThrow("fixedAmount must be a positive number");
    expect((await row("CR_002")).fixed_amount).toBe(120);
    expect(await update({ ruleId: "CR_002", fixedAmount: 150.555 })).toMatchObject({ fixedAmount: 150.56 });
    expect((await rules.getById(db, "CR_002"))?.fixedAmount).toBe(150.56);
  });

  it("a refused patch writes nothing at all: not the fields before the bad one, and no audit row", async () => {
    await expect(update({ ruleId: "CR_002", name: "Changed", fixedAmount: 0 })).rejects.toThrow("fixedAmount must be a positive number");
    expect((await row("CR_002")).name).toBe("Fee");
    expect(await audits()).toEqual([]);
  });

  it("a blank or non-numeric figure becomes 0 for a threshold, as the old roundMoney did; a negative threshold is accepted", async () => {
    await update({ ruleId: "CR_001", threshold: NaN });
    expect((await row("CR_001")).threshold).toBe(0);
    await update({ ruleId: "CR_001", threshold: -5 });
    expect((await row("CR_001")).threshold).toBe(-5);
  });

  it("validation, in the old order: the id, the actor, then the rule", async () => {
    await expect(update({ ruleId: "", actorId: "" })).rejects.toThrow("ruleId required");
    await expect(update({ ruleId: "CR_001", actorId: "" })).rejects.toThrow("actorId required");
    await expect(update({ ruleId: "CR_999", name: "x" })).rejects.toThrow("Rule not found: CR_999");
    await expect(update({ ruleId: " CR_001 ", name: "x" })).rejects.toThrow("Rule not found:  CR_001 ");
    await expect(update({ ruleId: undefined })).rejects.toThrow("ruleId required");
    await expect(update({ ruleId: 5 })).rejects.toThrow("Rule not found: 5");
    expect(await audits()).toEqual([]);
  });

  it("a placeholder row cannot be updated: it is not found", async () => {
    await seed({ id: "CR_PLACEHOLDER_1" });
    await expect(update({ ruleId: "CR_PLACEHOLDER_1", name: "x" })).rejects.toThrow("Rule not found: CR_PLACEHOLDER_1");
  });

  it("writes the audit row the old code wrote: the before figures, and only what was asked for after", async () => {
    await update({ ruleId: "CR_002", name: "Fee 2", threshold: 10.005, percentage: 2, active: false, effectiveTo: parseDate("2027-01-31"), notes: "not audited", fixedAmount: 99 }, LATER);
    const [a] = await audits();
    expect(a).toMatchObject({ actor_id: "S_001", action: "commission_rule.update", target_type: "commission_rules", target_id: "CR_002", details: null, timestamp: LATER });
    expect(JSON.parse(a.before)).toEqual({ name: "Fee", threshold: 0, percentage: 0, active: true, effectiveTo: parseDate("2026-12-31")!.toISOString(), fixedAmount: 120 });
    // the figures as asked, not as stored; no notes or fixedAmount
    expect(JSON.parse(a.after)).toEqual({ name: "Fee 2", threshold: 10.005, percentage: 2, active: false, effectiveTo: parseDate("2027-01-31")!.toISOString() });
  });

  it("an empty patch still writes an audit row, with an empty after, and changes nothing", async () => {
    const before = await row("CR_001");
    await update({ ruleId: "CR_001" });
    expect(await row("CR_001")).toEqual(before);
    const [a] = await audits();
    expect(JSON.parse(a.after)).toEqual({});
    expect(JSON.parse(a.before)).toEqual({ name: "Cstore weekly", threshold: 6000, percentage: 3, active: true, effectiveTo: null, fixedAmount: 0 });
  });

  it("an end date cleared with null shows as null in the audit after", async () => {
    await update({ ruleId: "CR_002", effectiveTo: null });
    expect(JSON.parse((await audits())[0].after)).toEqual({ effectiveTo: null });
  });

  it("deactivate switches a rule off, as an update", async () => {
    const r = await inTx((tx) => rules.deactivate(tx, "CR_001", "S_002", LATER));
    expect(r.active).toBe(false);
    const [a] = await audits();
    expect(a).toMatchObject({ actor_id: "S_002", action: "commission_rule.update", target_id: "CR_001" });
    expect(JSON.parse(a.after)).toEqual({ active: false });
  });

  it("an unreadable end date, a percentage outside 0 to 100 or not a number, and a threshold too big are refused in plain words, writing nothing", async () => {
    await expect(update({ ruleId: "CR_001", effectiveTo: new Date(NaN) })).rejects.toThrow("effectiveTo must be a valid date");
    await expect(update({ ruleId: "CR_001", percentage: 101 })).rejects.toThrow("percentage must be between 0 and 100");
    await expect(update({ ruleId: "CR_001", percentage: -1 })).rejects.toThrow("percentage must be between 0 and 100");
    await expect(update({ ruleId: "CR_001", percentage: NaN })).rejects.toThrow("percentage must be between 0 and 100");
    await expect(update({ ruleId: "CR_001", threshold: 1e10 })).rejects.toThrow("threshold is too large");
    await expect(update({ ruleId: "CR_002", fixedAmount: 1e10 })).rejects.toThrow("fixedAmount is too large");
    expect(await audits()).toEqual([]);
    expect(await row("CR_001")).toMatchObject({ percentage: 3, threshold: 6000 });
  });

  it("a percentage on a fixed rule is accepted, as before", async () => {
    expect(await update({ ruleId: "CR_002", percentage: 4 })).toMatchObject({ ruleType: "fixed", percentage: 4 });
  });

  it("two admins at once: the second waits for the first, then works on the first's result", async () => {
    const a = await connect(testDb.appUrl);
    const b = await connect(testDb.appUrl);
    try {
      let release!: () => void;
      let written!: () => void;
      const hold = new Promise<void>((r) => (release = r));
      const didWrite = new Promise<void>((r) => (written = r));
      const first = withTransaction(a, async (tx) => {
        await rules.update(tx, { ruleId: "CR_001", actorId: "S_001", active: false }, NOW);
        written();
        await hold;
      });
      await didWrite;
      let settled = false;
      const second = withTransaction(b, (tx) => rules.update(tx, { ruleId: "CR_001", actorId: "S_006", name: "Second" }, LATER)).finally(() => (settled = true));
      second.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // waiting on the row lock
      release();
      await first;
      expect(await second).toMatchObject({ name: "Second", active: false });
      const logs = await audits();
      expect(logs.map((x: any) => x.actor_id)).toEqual(["S_001", "S_006"]);
      // the second one's before saw the first one's write
      expect(JSON.parse(logs[1].before).active).toBe(false);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("the three RPCs", () => {
  beforeEach(async () => {
    await seed({ id: "CR_001", name: "Cstore weekly", threshold: 6000, percentage: 3, from: "2026-09-11", notes: "orig" });
    await seed({ id: "CR_002", name: "Fee", applies: "specific_staff", staff: "S_002", type: "fixed", fixed: 120, from: "2026-09-11", to: "2026-12-31", company: "vape" });
    await seed({ id: "CR_003", threshold: null, percentage: null, fixed: null, from: null, to: null, by: null, at: null, notes: null, active: false });
    await seed({ id: "CR_PLACEHOLDER_1" });
  });

  it("rpcGetCommissionRules: the list the page has always had, dates as ISO instants of Toronto midnight, no placeholder", async () => {
    const list = await rpc(rpcGetCommissionRules, ADMIN, []);
    expect(list).toEqual([
      { ruleId: "CR_001", name: "Cstore weekly", appliesTo: "all_staff", staffId: "", company: "cstore", threshold: 6000, percentage: 3, ruleType: "percentage", fixedAmount: 0, active: true, effectiveFrom: "2026-09-11T04:00:00.000Z", effectiveTo: null, notes: "orig" },
      { ruleId: "CR_002", name: "Fee", appliesTo: "specific_staff", staffId: "S_002", company: "vape", threshold: 0, percentage: 0, ruleType: "fixed", fixedAmount: 120, active: true, effectiveFrom: "2026-09-11T04:00:00.000Z", effectiveTo: "2026-12-31T05:00:00.000Z", notes: "" },
      { ruleId: "CR_003", name: "CR_003", appliesTo: "all_staff", staffId: "", company: "cstore", threshold: 0, percentage: 0, ruleType: "percentage", fixedAmount: 0, active: false, effectiveFrom: null, effectiveTo: null, notes: "" },
    ]);
  });

  it("rpcCreateCommissionRule: converts the page's input as the old function did, ignores an actorId, and answers with null dates", async () => {
    const made = await rpc(rpcCreateCommissionRule, PAYROLL, [
      { name: "From the page", appliesTo: "specific_staff", staffId: "S_003", company: "vape", threshold: "2500.499", percentage: "7.5", ruleType: "", fixedAmount: "", active: undefined, effectiveFrom: "2026-11-23", effectiveTo: "", notes: null, actorId: "S_003", createdBy: "S_003", ruleId: "CR_900" },
    ]);
    expect(made).toEqual({
      ruleId: "CR_004",
      name: "From the page",
      appliesTo: "specific_staff",
      staffId: "S_003",
      company: "vape",
      threshold: 2500.5,
      percentage: 7.5,
      active: true,
      effectiveFrom: null, // a Date in the old app: google.script.run sent null
      effectiveTo: null,
      createdBy: "S_006",
      createdAt: null,
      notes: "",
      ruleType: "percentage",
      fixedAmount: 0,
    });
    expect(await row("CR_004")).toMatchObject({ created_by: "S_006", effective_from: "2026-11-23", effective_to: null, notes: null, created_at: NOW });
    expect((await audits())[0].actor_id).toBe("S_006");
  });

  it("rpcCreateCommissionRule: a missing percentage on the page's form is refused (the old RPC stored NaN: deliberate)", async () => {
    await expect(rpc(rpcCreateCommissionRule, ADMIN, [{ name: "n", appliesTo: "all_staff", company: "cstore", threshold: 0, effectiveFrom: "2026-11-23" }])).rejects.toThrow("percentage must be between 0 and 100");
    await expect(rpc(rpcCreateCommissionRule, ADMIN, [{ name: "n", appliesTo: "all_staff", company: "cstore", percentage: "abc", effectiveFrom: "2026-11-23" }])).rejects.toThrow("percentage must be between 0 and 100");
  });

  it("rpcCreateCommissionRule: a fixed rule with the amount typed as text; a bad date is refused in words", async () => {
    const made = await rpc(rpcCreateCommissionRule, ADMIN, [{ name: "Fee", appliesTo: "all_staff", company: "cstore", threshold: 0, ruleType: "fixed", fixedAmount: "75.5", effectiveFrom: "2026-11-23" }]);
    expect(made).toMatchObject({ ruleType: "fixed", fixedAmount: 75.5, percentage: 0 });
    await expect(rpc(rpcCreateCommissionRule, ADMIN, [{ name: "n", appliesTo: "all_staff", company: "cstore", threshold: 0, percentage: 1, effectiveFrom: "23/11/2026" }])).rejects.toThrow("effectiveFrom is required and must be a valid date");
    await expect(rpc(rpcCreateCommissionRule, ADMIN, [{ name: "n", appliesTo: "all_staff", company: "cstore", threshold: 0, percentage: 1, effectiveFrom: "2026-11-23", effectiveTo: "soon" }])).rejects.toThrow("effectiveTo must be a valid date");
  });

  it("rpcCreateCommissionRule: an input that is not an object fails with the engine's own message", async () => {
    await expect(rpc(rpcCreateCommissionRule, ADMIN, [])).rejects.toThrow("Cannot read properties of undefined (reading 'name')");
    await expect(rpc(rpcCreateCommissionRule, ADMIN, [null])).rejects.toThrow("Cannot read properties of null (reading 'name')");
    await expect(rpc(rpcCreateCommissionRule, ADMIN, [{}])).rejects.toThrow("name required");
  });

  it("rpcUpdateCommissionRule: converts the page's patch, ignores an actorId, and answers with null dates", async () => {
    const r = await rpc(rpcUpdateCommissionRule, PAYROLL, [{ ruleId: "CR_001", threshold: "7000", percentage: "4", active: false, effectiveTo: "2026-12-24", actorId: "S_003" }], LATER);
    expect(r).toMatchObject({ ruleId: "CR_001", threshold: 7000, percentage: 4, active: false, effectiveFrom: null, effectiveTo: null, createdAt: null, createdBy: "S_001" });
    expect(await row("CR_001")).toMatchObject({ threshold: 7000, percentage: 4, active: false, effective_to: "2026-12-24" });
    const [a] = await audits();
    expect(a).toMatchObject({ actor_id: "S_006", timestamp: LATER });
    expect(JSON.parse(a.after)).toEqual({ threshold: 7000, percentage: 4, active: false, effectiveTo: parseDate("2026-12-24")!.toISOString() });
  });

  it("rpcUpdateCommissionRule: a null or blank threshold, and a blank end date, as the old function turned them", async () => {
    await rpc(rpcUpdateCommissionRule, ADMIN, [{ ruleId: "CR_002", threshold: null, effectiveTo: "" }]);
    expect(await row("CR_002")).toMatchObject({ threshold: 0, effective_to: null });
    await rpc(rpcUpdateCommissionRule, ADMIN, [{ ruleId: "CR_002", fixedAmount: "99" }]);
    expect((await row("CR_002")).fixed_amount).toBe(99);
    await expect(rpc(rpcUpdateCommissionRule, ADMIN, [{ ruleId: "CR_002", fixedAmount: null }])).rejects.toThrow("fixedAmount must be a positive number");
    await expect(rpc(rpcUpdateCommissionRule, ADMIN, [{ ruleId: "CR_002", effectiveTo: "soon" }])).rejects.toThrow("effectiveTo must be a valid date");
  });

  it("rpcUpdateCommissionRule: an input that is not an object fails with the engine's own message", async () => {
    await expect(rpc(rpcUpdateCommissionRule, ADMIN, [])).rejects.toThrow("Cannot read properties of undefined (reading 'ruleId')");
    await expect(rpc(rpcUpdateCommissionRule, ADMIN, [null])).rejects.toThrow("Cannot read properties of null (reading 'ruleId')");
    await expect(rpc(rpcUpdateCommissionRule, ADMIN, [{}])).rejects.toThrow("ruleId required");
  });

  it("a call with no session is refused", async () => {
    for (const h of [rpcGetCommissionRules, rpcCreateCommissionRule, rpcUpdateCommissionRule]) await expect(rpc(h, null, [{}])).rejects.toThrow("NOT_LOGGED_IN");
  });
});
