// CommissionRules: what the weekly engine is told to pay. The port of src/CommissionRules.gs: the
// three RPCs of the Rules screen (rpcGetCommissionRules, rpcCreateCommissionRule,
// rpcUpdateCommissionRule) plus the readers the engine will call (getActiveOn, getRulesFor, getById,
// getAll). A rule only decides what the engine PROPOSES; nothing is payable until a person approves
// the bonus (ADR-0011, ADR-0013).
//
// A rule says one of two things:
//   percentage  for a person (or all staff) at a company, when the week's sales pass `threshold`, pay
//               `percentage` (5 means 5%, not 0.05) of the sales above it
//   fixed       pay `fixedAmount` for the week; a threshold above zero makes it "once sales clear it"
// A blank rule type has always meant `percentage` (the column here is NOT NULL and defaults to it).
// A rule is never deleted: it is switched off (`active`) or given an end date (`effectiveTo`).
//
// Records have the field names and shapes CommissionRules.gs rowToRecord_ returns, with these
// differences: no _rowIndex (a Sheet row number means nothing here), and the three date fields are
// "YYYY-MM-DD" text (`effectiveFrom`, `effectiveTo`: a Date at Toronto midnight in the old app), except
// `createdAt`, which is a Date. The comparisons the engine makes (getActiveOn) are made on the same
// Toronto-midnight instants the old Dates held, so a rule ends exactly when it used to.
//
// Same as the old code, deliberately (ADR-0004 warns about each; parity decides, so they are kept and
// listed in the card's report):
//   - a blank threshold, percentage or fixed amount reads as 0 (`Number(x) || 0`), and a blank staff
//     id, creator or note reads as '' (never null);
//   - a threshold that is not a number reaches create as NaN (the RPC does Number(input.threshold)), the
//     "must be non-negative" check lets NaN through, and roundMoney stores 0: a rule with no threshold
//     is a rule with a threshold of 0;
//   - create writes 0 (not blank) into `percentage` of a fixed rule and into `fixed_amount` of a
//     percentage rule;
//   - a percentage of 0 is accepted (a rule that pays nothing); an end date before the start is
//     accepted; update does not check a threshold (a negative one is stored) or a name (a blank one is
//     stored); update accepts a percentage or a patch of any fields on either shape;
//   - update changes name, threshold, percentage, active, effectiveTo, notes and fixedAmount only: never
//     the id, the creator, who the rule applies to, its company, its start, or its type.
//
// Where the Sheet took something this database refuses, the check is made first and the refusal is a
// plain Error the page can show, never SERVER_ERROR (the card's "Rules of this port"; each is a
// deliberate difference, covered by unit tests and with no parity case):
//   - an unreadable effectiveFrom or effectiveTo (the Sheet stored an invalid date cell);
//   - a percentage that is not a number, or outside 0 to 100, on create (the old RPC stored NaN for a
//     missing one) and on update (the old code stored anything);
//   - a threshold or amount too big for numeric(12,2).
// And one difference that follows from the router running a call in ONE transaction: the old update
// wrote its fields one cell at a time and could throw on fixedAmount after name, threshold, percentage,
// active, effectiveTo and notes were already written. Here every check is made before the first write,
// so a refused patch writes nothing.
//
// Writes: in the caller's transaction. The rule row is locked before it is read (update), and the next
// id is computed under a transaction-scoped advisory lock (create), so two admins cannot both win. The
// audit row is written with the action, target, before and after the old code wrote. The time is the
// call's `now`.
//
// Order: the Sheet returned rows in the order they were appended, which is id order (CR_001, CR_002...).
// SQL has no implicit order, so every list says `order by` the number in the id.
import type { Db } from "../db/client";
import type { Tx } from "../db/tx";
import * as audit from "../lib/audit";
import { formatDate, parseDate } from "../lib/dates";
import { roundMoney } from "../lib/money";
import * as staff from "./staff";

/** RULE_APPLIES in src/Setup.gs. */
export const RULE_APPLIES: readonly string[] = ["all_staff", "specific_staff"];
/** COMPANIES in src/Setup.gs. */
export const COMPANIES: readonly string[] = ["cstore", "vape"];
const RULE_TYPES_LIST = ["percentage", "fixed"];
/** The two shapes of a rule. (CommissionRules.RULE_TYPES: a copy each time, as before.) */
export const RULE_TYPES: readonly string[] = RULE_TYPES_LIST.slice();

/** numeric(12,2) holds up to 9,999,999,999.99. */
const MONEY_LIMIT = 1e10;

export interface RuleRecord {
  ruleId: string;
  name: string;
  appliesTo: string;
  /** '' when the rule applies to all staff. */
  staffId: string;
  company: string;
  /** Dollars. A blank reads as 0, as in the old app. */
  threshold: number;
  /** 5 means 5%. A blank reads as 0. */
  percentage: number;
  active: boolean;
  /** "YYYY-MM-DD", or null. A Date (Toronto midnight) in the old app. */
  effectiveFrom: string | null;
  /** "YYYY-MM-DD", or null (open-ended). A Date in the old app. */
  effectiveTo: string | null;
  createdBy: string;
  createdAt: Date | null;
  notes: string;
  /** 'percentage' or 'fixed'. */
  ruleType: string;
  /** Dollars paid per week by a fixed rule. A blank reads as 0. */
  fixedAmount: number;
}

interface RuleRow {
  rule_id: string;
  name: string;
  applies_to: string;
  staff_id: string | null;
  company: string;
  threshold: number | null;
  percentage: number | null;
  active: boolean;
  effective_from: string | null;
  effective_to: string | null;
  created_by: string | null;
  created_at: Date | null;
  notes: string | null;
  rule_type: string | null;
  fixed_amount: number | null;
}

const COLUMNS = "rule_id, name, applies_to, staff_id, company, threshold, percentage, active, effective_from, effective_to, created_by, created_at, notes, rule_type, fixed_amount";
// The Sheet's row order: the number in the id (CR_999 before CR_1000), then when it was made, then the id.
const ORDER = `(regexp_match(btrim(rule_id), '^CR_([0-9]+)$'))[1]::numeric nulls last, created_at nulls last, rule_id collate "C"`;
const trimmed = (v: string | null): string => (v || "").toString().trim();

/** Old normalizeRuleType_: anything that is not 'fixed' (case and spaces aside) is a percentage rule. */
function normalizeRuleType(v: unknown): string {
  const t = (v == null ? "" : String(v)).trim().toLowerCase();
  return t === "fixed" ? "fixed" : "percentage";
}

function toRecord(r: RuleRow): RuleRecord {
  return {
    ruleId: trimmed(r.rule_id),
    name: (r.name || "").toString(),
    appliesTo: trimmed(r.applies_to),
    staffId: trimmed(r.staff_id),
    company: trimmed(r.company),
    threshold: Number(r.threshold) || 0,
    percentage: Number(r.percentage) || 0,
    active: r.active === true,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    createdBy: (r.created_by || "").toString(),
    createdAt: r.created_at,
    notes: (r.notes || "").toString(),
    ruleType: normalizeRuleType(r.rule_type),
    fixedAmount: Number(r.fixed_amount) || 0,
  };
}

/** The Toronto-midnight instant of a stored day: what the old Date cell held. */
export function instantOf(day: string | null): Date | null {
  return day ? parseDate(day) : null;
}

// ── Reads ──────────────────────────────────────────────────

/** Every rule, in the order the rows were created; the placeholder row of a fresh sheet is left out. (CommissionRules.getAll) */
export async function getAll(db: Db): Promise<RuleRecord[]> {
  const rows = await db.query<RuleRow>(`select ${COLUMNS} from ops.commission_rules order by ${ORDER}`);
  return rows.map(toRecord).filter((r) => r.ruleId && !r.ruleId.startsWith("CR_PLACEHOLDER"));
}

/** One rule by its id, or null. (CommissionRules.getById) */
export async function getById(db: Db, ruleId: string): Promise<RuleRecord | null> {
  if (typeof ruleId !== "string") return null; // the old comparison was ===, so a non-string never matched
  const row = await db.maybeOne<RuleRow>(`select ${COLUMNS} from ops.commission_rules where rule_id = $1`, [ruleId]);
  if (!row) return null;
  const rec = toRecord(row);
  return rec.ruleId && !rec.ruleId.startsWith("CR_PLACEHOLDER") && rec.ruleId === ruleId ? rec : null;
}

/**
 * The rules that are on and apply on `forDate`: started on or before it, not ended before it. A rule
 * with no start date never applies. Compared as instants, as before: a rule ending on a day still
 * applies at that day's midnight but not later that day. `forDate` that is not a Date means `now`.
 * (CommissionRules.getActiveOn)
 */
export async function getActiveOn(db: Db, forDate: unknown, now: Date): Promise<RuleRecord[]> {
  const date = forDate instanceof Date ? forDate : now;
  return (await getAll(db)).filter((r) => {
    if (!r.active) return false;
    const from = instantOf(r.effectiveFrom);
    if (!from) return false;
    if (from > date) return false;
    const to = instantOf(r.effectiveTo);
    if (to && to < date) return false;
    return true;
  });
}

/**
 * The rules that apply to one person at one company on a date: the company must match; an all-staff
 * rule applies to everyone, a specific-staff rule to its person. (CommissionRules.getRulesFor)
 */
export async function getRulesFor(db: Db, staffId: string, company: string, forDate: unknown, now: Date): Promise<RuleRecord[]> {
  return (await getActiveOn(db, forDate, now)).filter((r) => {
    if (r.company !== company) return false;
    if (r.appliesTo === "all_staff") return true;
    if (r.appliesTo === "specific_staff") return r.staffId === staffId;
    return false;
  });
}

/** The next id: one past the highest CR_<n>, at least three digits. Call it under the id lock (create does). */
async function nextRuleId(db: Db): Promise<string> {
  const row = await db.one<{ max: number }>(
    `select coalesce(max((regexp_match(btrim(rule_id), '^CR_([0-9]+)$'))[1]::numeric), 0) as max from ops.commission_rules`,
  );
  return "CR_" + String(Number(row.max) + 1).padStart(3, "0");
}

// ── Checks shared by create and update ─────────────────────

/** Old `x ? (x instanceof Date ? x : Util.parseDate(x)) : ''`, refusing what the database cannot hold. */
function endDateOf(v: unknown): Date | null {
  if (!v) return null;
  const d = v instanceof Date ? v : parseDate(v);
  if (!d || Number.isNaN(d.getTime())) throw new Error("effectiveTo must be a valid date");
  return d;
}

/** Money as the old code stored it: Util.roundMoney; refused only when numeric(12,2) could not hold it. */
function moneyOf(v: unknown, label: string): number {
  const n = roundMoney(v);
  if (!Number.isFinite(n) || Math.abs(n) >= MONEY_LIMIT) throw new Error(`${label} is too large`);
  return n;
}

/** A percentage the database holds: a real number from 0 to 100 (the Sheet took anything, NaN included). */
function checkPercentage(n: number): number {
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("percentage must be between 0 and 100");
  return n;
}

/** A text cell: '' (and anything falsy) is a blank cell, stored as NULL. */
const cell = (v: unknown): string | null => (v ? String(v) : null);

// ── Create ─────────────────────────────────────────────────

export interface CreateInput {
  name?: unknown;
  appliesTo?: unknown;
  staffId?: unknown;
  company?: unknown;
  threshold?: unknown;
  percentage?: unknown;
  ruleType?: unknown;
  fixedAmount?: unknown;
  active?: unknown;
  effectiveFrom?: unknown;
  effectiveTo?: unknown;
  notes?: unknown;
  actorId?: unknown;
}

/**
 * An admin or payroll admin adds a rule. Checks, in the old order, with the old text: name,
 * appliesTo, the person (for a specific-staff rule, who must exist), company, threshold, rule type, then
 * the amount that makes the rule pay something (a fixed rule: a positive fixedAmount; a percentage rule: a
 * percentage from 0 to 100), the actor, the start date. Answers the rule as stored. (CommissionRules.create)
 */
export async function create(db: Tx, input: CreateInput, now: Date): Promise<RuleRecord> {
  if (!input.name) throw new Error("name required");
  if (!input.appliesTo) throw new Error("appliesTo required");
  if (RULE_APPLIES.indexOf(input.appliesTo as string) === -1) throw new Error("Invalid appliesTo: " + String(input.appliesTo));
  if (input.appliesTo === "specific_staff" && !input.staffId) throw new Error("staffId required when appliesTo=specific_staff");
  if (input.appliesTo === "specific_staff") {
    const person = typeof input.staffId === "string" ? await staff.getById(db, input.staffId) : null;
    if (!person) throw new Error("Staff not found: " + String(input.staffId));
  }
  if (!input.company || COMPANIES.indexOf(input.company as string) === -1) throw new Error("Invalid company: " + String(input.company));
  if (typeof input.threshold !== "number" || input.threshold < 0) throw new Error("threshold must be a non-negative number");
  const threshold = moneyOf(input.threshold, "threshold");
  // Validate what was ASKED FOR, not what it normalises to: normalising first turns a typo into a
  // percentage rule and accepts it silently. A blank is still allowed (a caller from before the field).
  const askedType = (input.ruleType == null ? "" : String(input.ruleType)).trim().toLowerCase();
  if (askedType && RULE_TYPES_LIST.indexOf(askedType) === -1) {
    throw new Error("Invalid ruleType: " + String(input.ruleType) + " (expected one of: " + RULE_TYPES_LIST.join(", ") + ")");
  }
  const ruleType = normalizeRuleType(askedType);
  let percentage = 0;
  let fixedAmount = 0;
  if (ruleType === "fixed") {
    // The flat amount IS the rule: a zero would look configured and quietly pay nothing every week.
    if (typeof input.fixedAmount !== "number" || !(input.fixedAmount > 0)) throw new Error("fixedAmount must be a positive number for a fixed rule");
    fixedAmount = moneyOf(input.fixedAmount, "fixedAmount");
  } else {
    percentage = checkPercentage(typeof input.percentage === "number" ? input.percentage : NaN);
  }
  if (!input.actorId) throw new Error("actorId required");

  const effectiveFrom = input.effectiveFrom instanceof Date ? input.effectiveFrom : parseDate(input.effectiveFrom);
  if (!effectiveFrom || Number.isNaN(effectiveFrom.getTime())) throw new Error("effectiveFrom is required and must be a valid date");
  const effectiveTo = endDateOf(input.effectiveTo);

  // Two rules made at once must not get one id: the second waits here until the first commits.
  await db.query("select pg_advisory_xact_lock(hashtext('ops.commission_rules.rule_id'))");
  const ruleId = await nextRuleId(db);
  const specific = input.appliesTo === "specific_staff";
  await db.query(
    `insert into ops.commission_rules (rule_id, name, applies_to, staff_id, company, threshold, percentage, active,
                                       effective_from, effective_to, created_by, created_at, notes, rule_type, fixed_amount)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      ruleId,
      String(input.name),
      input.appliesTo,
      specific ? String(input.staffId) : null,
      input.company,
      threshold,
      percentage,
      input.active !== false,
      formatDate(effectiveFrom),
      effectiveTo ? formatDate(effectiveTo) : null,
      String(input.actorId),
      now,
      cell(input.notes),
      ruleType,
      fixedAmount,
    ],
  );
  await audit.write(
    db,
    {
      actorId: String(input.actorId),
      action: "commission_rule.create",
      targetType: "commission_rules",
      targetId: ruleId,
      after: {
        name: input.name,
        appliesTo: input.appliesTo,
        staffId: input.staffId,
        company: input.company,
        threshold: input.threshold,
        percentage: input.percentage,
        ruleType,
        fixedAmount: ruleType === "fixed" ? input.fixedAmount : 0,
      },
    },
    { now },
  );
  return mustGet(db, ruleId);
}

async function mustGet(db: Db, id: string): Promise<RuleRecord> {
  const rec = await getById(db, id);
  if (!rec) throw new Error("Rule not found: " + String(id));
  return rec;
}

// ── Update ─────────────────────────────────────────────────

export interface UpdateInput {
  ruleId?: unknown;
  name?: unknown;
  threshold?: unknown;
  percentage?: unknown;
  fixedAmount?: unknown;
  active?: unknown;
  /** A Date sets the end; null (or any falsy value) clears it; undefined leaves it. */
  effectiveTo?: unknown;
  notes?: unknown;
  actorId?: unknown;
}

/**
 * Patch a rule's mutable fields: name, threshold, percentage, fixedAmount, active, effectiveTo, notes.
 * The id, creator, who it applies to, company, start and type are not patchable (switching a live rule
 * between shapes silently changes what it pays; end it and write a new one). A field left undefined is
 * left alone. (CommissionRules.update)
 */
export async function update(db: Tx, input: UpdateInput, now: Date): Promise<RuleRecord> {
  if (!input.ruleId) throw new Error("ruleId required");
  if (!input.actorId) throw new Error("actorId required");

  const id = input.ruleId as string; // a found rule was looked up by a string
  if (typeof input.ruleId === "string") await db.query("select 1 from ops.commission_rules where rule_id = $1 for update", [input.ruleId]);
  const existing = await getById(db, input.ruleId as string);
  if (!existing) throw new Error("Rule not found: " + String(input.ruleId));

  // Every check before the first write: a refused patch writes nothing.
  const sets: Array<[string, unknown]> = [];
  if (input.name !== undefined) sets.push(["name", input.name == null ? "" : String(input.name)]);
  if (input.threshold !== undefined) sets.push(["threshold", moneyOf(input.threshold, "threshold")]);
  if (input.percentage !== undefined) sets.push(["percentage", checkPercentage(Number(input.percentage))]);
  if (input.active !== undefined) sets.push(["active", input.active === true]);
  if (input.effectiveTo !== undefined) {
    const end = endDateOf(input.effectiveTo);
    sets.push(["effective_to", end ? formatDate(end) : null]);
  }
  if (input.notes !== undefined) sets.push(["notes", cell(input.notes)]);
  if (input.fixedAmount !== undefined) {
    // Only meaningful on a fixed rule, and a zero there is a rule that pays nothing: refuse it as on create.
    if (existing.ruleType !== "fixed") {
      throw new Error("fixedAmount only applies to a fixed rule; " + String(input.ruleId) + " is a " + existing.ruleType + " rule");
    }
    const amount = Number(input.fixedAmount);
    if (!(amount > 0)) throw new Error("fixedAmount must be a positive number");
    sets.push(["fixed_amount", moneyOf(amount, "fixedAmount")]);
  }

  const before = {
    name: existing.name,
    threshold: existing.threshold,
    percentage: existing.percentage,
    active: existing.active,
    effectiveTo: existing.effectiveTo ? instantOf(existing.effectiveTo) : null,
    fixedAmount: existing.fixedAmount,
  };
  if (sets.length > 0) {
    // Column names come from the fixed list above, never from the caller.
    const assignments = sets.map(([col], i) => `${col} = $${i + 2}`).join(", ");
    await db.query(`update ops.commission_rules set ${assignments} where rule_id = $1`, [id, ...sets.map(([, v]) => v)]);
  }
  await audit.write(
    db,
    {
      actorId: String(input.actorId),
      action: "commission_rule.update",
      targetType: "commission_rules",
      targetId: id,
      before,
      after: { name: input.name, threshold: input.threshold, percentage: input.percentage, active: input.active, effectiveTo: input.effectiveTo },
    },
    { now },
  );
  return mustGet(db, id);
}

/** Switch a rule off: active = false, as an update, so the audit trail is kept. (CommissionRules.deactivate) */
export async function deactivate(db: Tx, ruleId: unknown, actorId: unknown, now: Date): Promise<RuleRecord> {
  return update(db, { ruleId, active: false, actorId }, now);
}
