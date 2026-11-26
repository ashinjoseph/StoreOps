// Parity cases for CommissionRules (card P3-10a): rpcGetCommissionRules, rpcCreateCommissionRule and
// rpcUpdateCommissionRule.
//
// The fixture (frozen at Friday 20 November 2026) holds three rules, written through the old API:
//   CR_001  Cstore weekly, all staff, cstore, threshold 6000, 3%, active, from 2026-09-11, no end
//   CR_002  Vape weekly, all staff, vape, threshold 1200, 5%, active, from 2026-09-11, no end
//   CR_003  Management fee, S_002 only, cstore, fixed 120, threshold 0, percentage 0, active, from 2026-09-11
// S_001 admin, S_002 manager, S_003 to S_005 employees, S_006 payroll admin, S_007 inactive.
//
// Every write case declares commission_rules and audit_log: any other table that changes on either
// side fails the case.
//
// Deliberately NOT here (the new app refuses what the Sheet took; ops/test/commission-rules.test.ts
// covers each): an unreadable effectiveFrom / effectiveTo, a percentage that is not a number (the old
// RPC stored NaN for a missing one), a percentage outside 0 to 100 on update, a figure too large for
// the money column.
import { parityCase, paritySequence, resultOf, step, type ParityCase } from "../case";

const WRITES = ["commission_rules", "audit_log"];

const PCT = "CR_001";
const VAPE = "CR_002";
const FEE = "CR_003";

const list = (as = "admin") => step("rpcGetCommissionRules", { as });
const create = (input: unknown, as = "admin") => step("rpcCreateCommissionRule", { as, args: [input] });
const update = (input: unknown, as = "admin") => step("rpcUpdateCommissionRule", { as, args: [input] });
const pct = (extra: Record<string, unknown> = {}) => ({ name: "Parity percentage", appliesTo: "all_staff", company: "cstore", threshold: 1000, percentage: 4, effectiveFrom: "2026-11-23", ...extra });
const fixed = (extra: Record<string, unknown> = {}) => ({ name: "Parity fee", appliesTo: "specific_staff", staffId: "S_003", company: "vape", threshold: 0, ruleType: "fixed", fixedAmount: 75, effectiveFrom: "2026-11-23", ...extra });

/** One create that must be refused, and the list after it (nothing was written). */
const refused = (title: string, input: unknown): ParityCase => paritySequence(`rpcCreateCommissionRule: ${title}`, { writes: WRITES }, [create(input), list()]);

export const commissionRulesCases: ParityCase[] = [
  // ── rpcGetCommissionRules ───────────────────────────────
  parityCase("rpcGetCommissionRules", { as: "admin" }),
  parityCase("rpcGetCommissionRules", { as: "manager" }),
  parityCase("rpcGetCommissionRules", { as: "employee" }),
  parityCase("rpcGetCommissionRules", { as: "payroll_admin" }),
  parityCase("rpcGetCommissionRules", { as: null, title: "rpcGetCommissionRules: no token is refused" }),

  // ── rpcCreateCommissionRule: what is accepted ───────────
  paritySequence("rpcCreateCommissionRule: an admin makes a percentage rule for all staff, and it shows in the list", { writes: WRITES }, [create(pct()), list()]),
  paritySequence("rpcCreateCommissionRule: a payroll admin makes a fixed-amount rule for one person", { writes: WRITES }, [create(fixed(), "payroll_admin"), list("payroll_admin")]),
  paritySequence("rpcCreateCommissionRule: a fixed rule for all staff with a threshold, and a rule for each company", { writes: WRITES }, [
    create({ name: "Everyone's fee", appliesTo: "all_staff", company: "cstore", threshold: 5000, ruleType: "fixed", fixedAmount: 20.456, effectiveFrom: "2026-11-23" }),
    create(pct({ company: "vape", name: "Vape rule" })),
    create(fixed({ staffId: "S_007", name: "Inactive person's fee" })),
    list(),
  ]),
  paritySequence("rpcCreateCommissionRule: with an end date, with a past start, and with an end date of today", { writes: WRITES }, [
    create(pct({ effectiveTo: "2026-12-31", name: "Ends" })),
    create(pct({ effectiveFrom: "2026-01-01", effectiveTo: "2026-11-20", name: "Ended today" })),
    create(pct({ effectiveFrom: "2027-03-01", name: "Starts later" })),
    list(),
  ]),
  paritySequence("rpcCreateCommissionRule: an end date before the start is accepted", { writes: WRITES }, [create(pct({ effectiveFrom: "2026-12-01", effectiveTo: "2026-11-01" })), list()]),
  paritySequence("rpcCreateCommissionRule: with every optional field blank", { writes: WRITES }, [
    create({ name: "Bare", appliesTo: "all_staff", company: "cstore", threshold: 0, percentage: 1, effectiveFrom: "2026-11-23", effectiveTo: "", notes: "", staffId: "", ruleType: "", active: true }),
    create({ name: "Bare fixed", appliesTo: "all_staff", company: "vape", threshold: "", ruleType: "fixed", fixedAmount: 10, effectiveFrom: "2026-11-23", effectiveTo: null, notes: null }),
    list(),
  ]),
  paritySequence("rpcCreateCommissionRule: no threshold, notes, active flag or end date at all", { writes: WRITES }, [
    create({ name: "Minimal", appliesTo: "all_staff", company: "cstore", percentage: 2, effectiveFrom: "2026-11-23" }),
    create({ name: "Notes and off", appliesTo: "all_staff", company: "cstore", threshold: 10, percentage: 2, effectiveFrom: "2026-11-23", notes: "  padded note  ", active: false }),
    create(pct({ active: "false" })),
    create(pct({ active: 0 })),
    list(),
  ]),
  paritySequence("rpcCreateCommissionRule: amounts are rounded to cents; a percentage keeps its decimals", { writes: WRITES }, [
    create(pct({ threshold: 1000.005, percentage: 3.25 })),
    create(pct({ threshold: "2500.499", percentage: "7.5" })),
    create(pct({ threshold: 0.004, percentage: 100 })),
    create(fixed({ fixedAmount: 99.995 })),
    create(fixed({ fixedAmount: "120.5" })),
    list(),
  ]),
  paritySequence("rpcCreateCommissionRule: a percentage of 0 and of 100 are accepted; a name and notes with punctuation", { writes: WRITES }, [
    create(pct({ percentage: 0, name: "Zero percent" })),
    create(pct({ percentage: 100, name: "Quotes \" ' and ünïcode — <b>html</b>", notes: "Line one\nline two" })),
    list(),
  ]),
  paritySequence("rpcCreateCommissionRule: the rule type is read case-insensitively; a percentage given on a fixed rule is ignored", { writes: WRITES }, [
    create(fixed({ ruleType: " FIXED ", percentage: 9 })),
    create(pct({ ruleType: "Percentage", fixedAmount: 50 })),
    create(pct({ appliesTo: "all_staff", staffId: "S_004" })),
    list(),
  ]),
  paritySequence("rpcCreateCommissionRule: ids count on from the highest, three in one second", { writes: WRITES }, [create(pct()), create(pct({ name: "Second" })), create(fixed()), list()]),
  paritySequence("rpcCreateCommissionRule: an actorId or createdBy in the input is ignored; the session decides", { writes: WRITES }, [
    create(pct({ actorId: "S_003", createdBy: "S_003", ruleId: "CR_900", active: true })),
    list(),
  ]),

  // ── rpcCreateCommissionRule: what is refused ────────────
  refused("a missing name", pct({ name: undefined })),
  refused("a blank name", pct({ name: "" })),
  refused("a missing appliesTo", pct({ appliesTo: undefined })),
  refused("an unknown appliesTo", pct({ appliesTo: "everyone" })),
  refused("appliesTo in the wrong case", pct({ appliesTo: "All_Staff" })),
  refused("a specific-staff rule with no person", pct({ appliesTo: "specific_staff" })),
  refused("a specific-staff rule with a blank person", pct({ appliesTo: "specific_staff", staffId: "" })),
  refused("a specific-staff rule for an unknown person", pct({ appliesTo: "specific_staff", staffId: "S_999" })),
  refused("a specific-staff rule for a person in the wrong case", pct({ appliesTo: "specific_staff", staffId: "s_003" })),
  refused("a specific-staff rule for a padded id", pct({ appliesTo: "specific_staff", staffId: " S_003 " })),
  refused("a missing company", pct({ company: undefined })),
  refused("an unknown company", pct({ company: "grocery" })),
  refused("a company in the wrong case", pct({ company: "Vape" })),
  refused("a negative threshold", pct({ threshold: -1 })),
  refused("a negative threshold on a fixed rule", fixed({ threshold: -0.01 })),
  refused("an unknown rule type", pct({ ruleType: "magic" })),
  refused("a rule type that is not text", pct({ ruleType: 5 })),
  refused("a fixed rule with no amount", fixed({ fixedAmount: undefined })),
  refused("a fixed rule with a zero amount", fixed({ fixedAmount: 0 })),
  refused("a fixed rule with a negative amount", fixed({ fixedAmount: -120 })),
  refused("a fixed rule with an amount that is not a number", fixed({ fixedAmount: "abc" })),
  refused("a percentage over 100", pct({ percentage: 100.01 })),
  refused("a negative percentage", pct({ percentage: -0.5 })),
  refused("a missing effectiveFrom", pct({ effectiveFrom: undefined })),
  refused("a blank effectiveFrom", pct({ effectiveFrom: "" })),
  paritySequence("rpcCreateCommissionRule: an input that is not an object", { writes: WRITES }, [
    step("rpcCreateCommissionRule", { as: "admin", args: [] }),
    step("rpcCreateCommissionRule", { as: "admin", args: [null] }),
    step("rpcCreateCommissionRule", { as: "admin", args: ["text"] }),
    step("rpcCreateCommissionRule", { as: "admin", args: [{}] }),
    list(),
  ]),
  parityCase("rpcCreateCommissionRule", { as: "manager", args: [pct()], writes: WRITES, title: "rpcCreateCommissionRule: a manager is refused" }),
  parityCase("rpcCreateCommissionRule", { as: "employee", args: [pct()], writes: WRITES, title: "rpcCreateCommissionRule: an employee is refused" }),
  parityCase("rpcCreateCommissionRule", { as: null, args: [pct()], writes: WRITES, title: "rpcCreateCommissionRule: no token is refused" }),

  // ── rpcUpdateCommissionRule ─────────────────────────────
  paritySequence("rpcUpdateCommissionRule: each field of a percentage rule, one at a time", { writes: WRITES }, [
    update({ ruleId: PCT, name: "Renamed" }),
    update({ ruleId: PCT, threshold: 7500.126 }),
    update({ ruleId: PCT, percentage: 3.5 }),
    update({ ruleId: PCT, active: false }),
    update({ ruleId: PCT, effectiveTo: "2026-12-31" }),
    update({ ruleId: PCT, notes: "A note" }),
    list(),
  ]),
  paritySequence("rpcUpdateCommissionRule: every field at once, by a payroll admin", { writes: WRITES }, [
    update({ ruleId: VAPE, name: "All changed", threshold: 900, percentage: 6, active: false, effectiveTo: "2027-01-31", notes: "Everything" }, "payroll_admin"),
    list("payroll_admin"),
  ]),
  paritySequence("rpcUpdateCommissionRule: a fixed rule's amount, and a percentage on it", { writes: WRITES }, [
    update({ ruleId: FEE, fixedAmount: 150.555 }),
    update({ ruleId: FEE, fixedAmount: "99" }),
    update({ ruleId: FEE, percentage: 4 }),
    list(),
  ]),
  paritySequence("rpcUpdateCommissionRule: switch a rule off and on again", { writes: WRITES }, [
    update({ ruleId: PCT, active: false }),
    update({ ruleId: PCT, active: true }),
    update({ ruleId: PCT, active: "yes" }),
    update({ ruleId: PCT, active: true }),
    update({ ruleId: PCT, active: null }),
    list(),
  ]),
  paritySequence("rpcUpdateCommissionRule: set an end date, then clear it three ways", { writes: WRITES }, [
    update({ ruleId: PCT, effectiveTo: "2026-12-31" }),
    update({ ruleId: PCT, effectiveTo: "" }),
    update({ ruleId: PCT, effectiveTo: "2026-12-24" }),
    update({ ruleId: PCT, effectiveTo: null }),
    update({ ruleId: PCT, effectiveTo: "2026-12-24" }),
    update({ ruleId: PCT, effectiveTo: 0 }),
    update({ ruleId: PCT, effectiveTo: "2026-01-01" }),
    list(),
  ]),
  paritySequence("rpcUpdateCommissionRule: blank figures and notes", { writes: WRITES }, [
    update({ ruleId: PCT, notes: "something" }),
    update({ ruleId: PCT, notes: "" }),
    update({ ruleId: PCT, notes: null }),
    update({ ruleId: PCT, threshold: "" }),
    update({ ruleId: PCT, threshold: null }),
    update({ ruleId: PCT, threshold: "abc" }),
    update({ ruleId: PCT, threshold: -5 }),
    update({ ruleId: PCT, percentage: "" }),
    update({ ruleId: PCT, percentage: null }),
    list(),
  ]),
  paritySequence("rpcUpdateCommissionRule: changing the type is ignored", { writes: WRITES }, [
    update({ ruleId: FEE, ruleType: "percentage" }),
    update({ ruleId: PCT, ruleType: "fixed", name: "Still a percentage rule" }),
    list(),
  ]),
  paritySequence("rpcUpdateCommissionRule: a patch that tries to change the id, who made it, or what it applies to", { writes: WRITES }, [
    update({ ruleId: PCT, newRuleId: "CR_777", rule_id: "CR_778", createdBy: "S_003", created_by: "S_003", createdAt: "2020-01-01", appliesTo: "specific_staff", staffId: "S_004", company: "vape", effectiveFrom: "2020-01-01" }),
    update({ ruleId: PCT, actorId: "S_003", name: "Name only" }),
    list(),
  ]),
  paritySequence("rpcUpdateCommissionRule: an empty patch changes nothing but is still logged", { writes: WRITES }, [update({ ruleId: VAPE }), update({ ruleId: FEE, name: undefined }), list()]),
  paritySequence("rpcUpdateCommissionRule: a fixed amount on a percentage rule, and a bad one on a fixed rule", { writes: WRITES }, [
    update({ ruleId: PCT, fixedAmount: 50 }),
    update({ ruleId: FEE, fixedAmount: 0 }),
    update({ ruleId: FEE, fixedAmount: -3 }),
    update({ ruleId: FEE, fixedAmount: "abc" }),
    update({ ruleId: FEE, fixedAmount: null }),
    list(),
  ]),
  paritySequence("rpcUpdateCommissionRule: an unknown, blank and odd id", { writes: WRITES }, [
    update({ ruleId: "CR_999", name: "x" }),
    update({ ruleId: "", name: "x" }),
    update({ name: "x" }),
    update({ ruleId: null, name: "x" }),
    update({ ruleId: ` ${PCT} `, name: "x" }),
    update({ ruleId: PCT.toLowerCase(), name: "x" }),
    update({ ruleId: 1, name: "x" }),
    update({ ruleId: [PCT], name: "x" }),
    list(),
  ]),
  paritySequence("rpcUpdateCommissionRule: an input that is not an object", { writes: WRITES }, [
    step("rpcUpdateCommissionRule", { as: "admin", args: [] }),
    step("rpcUpdateCommissionRule", { as: "admin", args: [null] }),
    step("rpcUpdateCommissionRule", { as: "admin", args: ["text"] }),
    list(),
  ]),
  parityCase("rpcUpdateCommissionRule", { as: "manager", args: [{ ruleId: PCT, name: "x" }], writes: WRITES, title: "rpcUpdateCommissionRule: a manager is refused" }),
  parityCase("rpcUpdateCommissionRule", { as: "employee", args: [{ ruleId: PCT, name: "x" }], writes: WRITES, title: "rpcUpdateCommissionRule: an employee is refused" }),
  parityCase("rpcUpdateCommissionRule", { as: null, args: [{ ruleId: PCT, name: "x" }], writes: WRITES, title: "rpcUpdateCommissionRule: no token is refused" }),

  // ── Sequences ───────────────────────────────────────────
  paritySequence("a rule is created, updated twice, and listed", { writes: WRITES }, [
    create(pct({ name: "Sequence", notes: "first" })),
    update({ ruleId: resultOf(1, "$.ruleId"), threshold: 2000, percentage: 5, notes: "second" }),
    step("rpcUpdateCommissionRule", { as: "payroll_admin", args: [{ ruleId: resultOf(1, "$.ruleId"), active: false, effectiveTo: "2026-12-31" }], advance: { minutes: 20 } }),
    list(),
  ]),
  paritySequence("a fixed rule is created, its amount changed, switched off and on, and listed", { writes: WRITES }, [
    create(fixed()),
    update({ ruleId: resultOf(1, "$.ruleId"), fixedAmount: 90 }),
    update({ ruleId: resultOf(1, "$.ruleId"), active: false }),
    step("rpcUpdateCommissionRule", { as: "admin", args: [{ ruleId: resultOf(1, "$.ruleId"), active: true }], advance: { hours: 2 } }),
    list(),
  ]),
];
