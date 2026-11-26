// Commissions: the weekly engine that PROPOSES each person's commission. The port of src/Commissions.gs
// (card P3-10b). Nothing here makes anything payable: every bonus the engine writes is `proposed`, and a
// person with the right role must approve it (ADR-0011, AGENTS.md hard rule 10).
//
// What a run does (Commissions.gs:runForWeek_):
//   1. takes the week (Monday 00:00 to Sunday 23:59:59.999, Toronto);
//   2. unless forced, stops if a run for that week already exists (the run is found by the week's Toronto
//      date, not by its id) and says so, writing nothing;
//   3. sums last week's sales per person and till (Sales.aggregateByStaffCompany: cash and every card
//      column of both shapes, per person per company, rounded to cents);
//   4. for every rule that is on and effective on the week's first day, and every active person it covers,
//      works out what the rule pays and proposes it as a bonus, unless the person already has a bonus of
//      that kind for the week (below);
//   5. writes one commission_runs row with the totals, and notifies (an audit row; no message is sent).
// A week with no active rule still gets a run row, with a note, and no audit row and no notice.
//
// The rules of the arithmetic, each ported exactly (line numbers are src/Commissions.gs):
//   - a percentage rule needs a sales row and sales above threshold + 0.005 (:151-155); it pays
//     round(round(sales - threshold) * percentage / 100) (:171-172);
//   - a fixed rule with a threshold above zero needs sales above threshold + 0.005; with none it pays
//     whatever the sales, even none at all (:146-150); it pays round(fixedAmount) (:165);
//   - an amount of half a cent or less is not proposed (:178);
//   - a rule for all staff covers every ACTIVE person; any other rule covers the one active person it
//     names (:131-133); a person who is not active is never paid;
//   - several rules matching one person: a percentage rule is blocked by any non-cancelled commission of
//     that person, till and week from another PERCENTAGE rule or with no rule recorded (a legacy row); a
//     fixed rule is blocked only by its own earlier bonus. So a fee and a sales commission both pay, two
//     percentage rules do not (the first by rule number pays), two fees each pay (:136-141, :155-160).
//     The same question is asked of the bonuses this run has just proposed, as the Sheet saw them;
//   - a person with sales at both tills is looked at once per rule: a rule has one till.
//
// Idempotence: a second run of the same week is skipped unless forced. A forced run does NOT cancel or
// change anything the earlier run proposed: the guards above still see those bonuses (a cancelled one does
// not count, so a cancelled proposal is proposed again; a proposed, pending or paid one blocks). New here:
// the week is locked (a transaction-scoped advisory lock on the week) BEFORE the existing run is looked
// for, so two runs that start at once for one week cannot both propose; the second finds the first's run.
//
// Not ported: installWeeklyTrigger, removeWeeklyTrigger, isTriggerInstalled (and the top-level
// commissionsTriggerHandler). An Apps Script time trigger has no equivalent here; the Cloudflare cron
// (ops/wrangler.toml [triggers], ops/src/cron.ts) replaces it, and there is nothing to install.
//
// Same as the old code, deliberately (ADR-0004 warns about each; parity decides, so they are kept):
//   - a run row's staff count, bonuses created and total read as 0 when blank, its notes and who computed
//     it as '' (never null), as `Number(x) || 0` / `(x || '').toString()` did;
//   - the engine writes 0 (not blank) for a staff count, a bonuses count and a total of nothing, and '' (a
//     blank cell, NULL here) for the notes of an ordinary run;
//   - a rule whose till is not cstore or vape makes the run fail ("Invalid company") after the guards, as
//     Bonuses.propose did; the old run had already written the bonuses before it, this one writes none
//     (the router runs a call in one transaction), and the schema does not allow such a rule anyway.
//
// Records: the field names and shapes Commissions.gs runRowToRecord_ returns, except that there is no
// _rowIndex, and the two week dates are "YYYY-MM-DD" text (a Date at Toronto midnight in the old app);
// `computedAt` stays a Date.
//
// Writes, all in the caller's transaction: every bonus in ONE statement, the audit rows (one per bonus
// and the run's) in ONE statement, the run row, and the notice. The time is the call's `now`.
import type { Db } from "../db/client";
import type { Tx } from "../db/tx";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import { formatDate, getPreviousWeekRange, parseDate } from "../lib/dates";
import { newId } from "../lib/ids";
import { formatMoney, roundMoney } from "../lib/money";
import * as commissionRules from "./commission-rules";
import * as notifier from "./notifier";
import * as sales from "./sales";
import * as staff from "./staff";

/** The actor of a run nobody asked for: the weekly cron (the old trigger's SYSTEM_TRIGGER). */
export const TRIGGER_ACTOR = "SYSTEM_TRIGGER";

export interface RunRecord {
  runId: string;
  /** "YYYY-MM-DD", or null. A Date in the old app. */
  weekStart: string | null;
  weekEnd: string | null;
  /** A blank reads as 0, as in the old app. */
  staffCount: number;
  bonusesCreated: number;
  totalCommissionAmount: number;
  computedAt: Date | null;
  computedBy: string;
  notes: string;
}

interface RunRow {
  run_id: string;
  week_start: string | null;
  week_end: string | null;
  staff_count: number | null;
  bonuses_created: number | null;
  total_commission_amount: number | null;
  computed_at: Date | null;
  computed_by: string | null;
  notes: string | null;
}

const RUN_COLUMNS = "run_id, week_start, week_end, staff_count, bonuses_created, total_commission_amount, computed_at, computed_by, notes";
// The Sheet returned runs in the order they were appended: that is `seq` (migration 0007).
const RUN_ORDER = "seq";

function toRun(r: RunRow): RunRecord {
  return {
    runId: (r.run_id || "").toString().trim(),
    weekStart: r.week_start,
    weekEnd: r.week_end,
    staffCount: Number(r.staff_count) || 0,
    bonusesCreated: Number(r.bonuses_created) || 0,
    totalCommissionAmount: Number(r.total_commission_amount) || 0,
    computedAt: r.computed_at,
    computedBy: (r.computed_by || "").toString(),
    notes: (r.notes || "").toString(),
  };
}

/** Every run, in the order they were made; the placeholder row of a fresh sheet is left out. (Commissions.getAllRuns) */
export async function getAllRuns(db: Db): Promise<RunRecord[]> {
  const rows = await db.query<RunRow>(`select ${RUN_COLUMNS} from ops.commission_runs order by ${RUN_ORDER}`);
  return rows.map(toRun).filter((r) => r.runId && !r.runId.startsWith("CRN_PLACEHOLDER"));
}

/** The first run whose week starts on the Toronto date of `weekStart`, or null. (Commissions.findRunForWeek) */
export async function findRunForWeek(db: Db, weekStart: Date): Promise<RunRecord | null> {
  const rows = await db.query<RunRow>(`select ${RUN_COLUMNS} from ops.commission_runs where week_start = $1 order by ${RUN_ORDER}`, [formatDate(weekStart)]);
  const runs = rows.map(toRun).filter((r) => r.runId && !r.runId.startsWith("CRN_PLACEHOLDER"));
  return runs[0] ?? null;
}

// ── The engine ─────────────────────────────────────────────

export interface RunInput {
  /** Monday 00:00 of the week: a Date, or "YYYY-MM-DD" (Util.parseDate). Required. */
  weekStart?: Date | string | null;
  /** Sunday 23:59:59 of the week. Required. */
  weekEnd?: Date | string | null;
  /** Only the boolean true forces. */
  force?: unknown;
  /** Who ran it; the cron's SYSTEM_TRIGGER when nobody is named. */
  actorId?: string | null;
}

export interface EngineDeps {
  config: Config;
  env: Readonly<Record<string, unknown>>;
  fetch: typeof fetch;
  /** The clock: when the run is stamped and which day the bonuses are dated. */
  now: Date;
  /** For the ids; the default is the platform's crypto. */
  random?: () => number;
}

export interface ProposedLine {
  bonusId: string;
  staffId: string;
  staffName: string;
  company: string;
  ruleId: string;
  ruleType: string;
  sales: number;
  threshold: number;
  percentage: number;
  fixedAmount: number;
  amount: number;
}

export interface RunDone {
  runId: string;
  weekStart: Date;
  weekEnd: Date;
  bonusesProposed: ProposedLine[];
  totalAmount: number;
  staffCount: number;
  skipped: false;
}

export interface RunSkipped {
  skipped: true;
  existingRunId: string;
  weekStart: Date;
  weekEnd: Date;
  reason: string;
}

export type RunResult = RunDone | RunSkipped;

const COMPANIES = commissionRules.COMPANIES;
/** The bonus's own audit text is cut at 100 characters, as Bonuses.writeRow_ did. */
const REASON_AUDIT_LENGTH = 100;

/** The statement that writes a run row. A blank note is a blank cell (NULL). */
async function writeRun(
  db: Db,
  runId: string,
  r: { weekStart: Date; weekEnd: Date; staffCount: number; bonusesCreated: number; totalAmount: number; computedBy: string; notes: string },
  now: Date,
): Promise<void> {
  await db.query(
    `insert into ops.commission_runs (run_id, week_start, week_end, staff_count, bonuses_created, total_commission_amount, computed_at, computed_by, notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [runId, formatDate(r.weekStart), formatDate(r.weekEnd), r.staffCount || 0, r.bonusesCreated || 0, roundMoney(r.totalAmount || 0), now, r.computedBy || TRIGGER_ACTOR, r.notes || null],
  );
}

/** Dates in the input: a Date as it is, anything else read as "YYYY-MM-DD" (Util.parseDate). */
function dateOf(v: Date | string): Date {
  const d = v instanceof Date ? v : parseDate(v);
  if (!d || Number.isNaN(d.getTime())) throw new Error("weekStart and weekEnd must be valid dates");
  return d;
}

interface Taken {
  ruleId: string;
}

/**
 * Run the engine for one week. See the header. `db` must be the call's transaction: the week's lock is
 * released at its end, and everything written commits or rolls back together.
 */
export async function runForWeek(db: Tx, input: RunInput, deps: EngineDeps): Promise<RunResult> {
  if (!input || !input.weekStart || !input.weekEnd) throw new Error("weekStart and weekEnd required");
  const weekStart = dateOf(input.weekStart);
  const weekEnd = dateOf(input.weekEnd);
  const actorId = input.actorId || TRIGGER_ACTOR;
  const force = input.force === true;
  const { now } = deps;
  const idDeps = { now, ...(deps.random ? { random: deps.random } : {}), chars: 10 };

  // One run of a week at a time. The lock comes before the question "has it run?", so a second run that
  // starts at once waits here and then finds the first one's run row.
  const weekDay = formatDate(weekStart);
  await db.query("select pg_advisory_xact_lock(hashtextextended('ops.commissions.run:' || $1::text, 0))", [weekDay]);

  // Idempotency check
  const existingRun = await findRunForWeek(db, weekStart);
  if (existingRun && !force) {
    return {
      skipped: true,
      existingRunId: existingRun.runId,
      weekStart,
      weekEnd,
      reason: "Run already exists for this week (" + existingRun.runId + "). Pass force=true to re-run.",
    };
  }

  // Sales by 'staffId|company' for the window.
  const salesMap = new Map<string, sales.StaffCompanyTotal>();
  for (const s of await sales.aggregateByStaffCompany(db, weekStart, weekEnd)) salesMap.set(s.staffId + "|" + s.company, s);

  // The rules in force on the week's first day.
  const rules = await commissionRules.getActiveOn(db, weekStart, now);
  if (rules.length === 0) {
    // No rules: still write a run row so we have history
    const runId = newId("CRN", idDeps);
    await writeRun(db, runId, { weekStart, weekEnd, staffCount: 0, bonusesCreated: 0, totalAmount: 0, computedBy: actorId, notes: "No active rules for this week" }, now);
    return { runId, weekStart, weekEnd, bonusesProposed: [], totalAmount: 0, staffCount: 0, skipped: false };
  }

  const runId = newId("CRN", idDeps);
  const allStaff = await staff.getActive(db);

  // Which rules may block a percentage rule: the other percentage rules. Named this way round on purpose
  // (ADR-0013): a fee whose rule was ended stops blocking anything.
  const percentageRuleIds = new Set((await commissionRules.getAll(db)).filter((r) => r.ruleType !== "fixed").map((r) => r.ruleId));

  // What each person already has this week: every commission that is not cancelled, read once. (The old
  // code asked Bonuses.existsCommissionFor per person and rule; the Sheet showed it what the run had
  // already written, so what this run proposes is added to the list as it goes.)
  const periodStart = weekDay;
  const periodEnd = formatDate(weekEnd);
  const have = new Map<string, Taken[]>();
  const note = (staffId: string, company: string, ruleId: string): void => {
    const k = staffId + "|" + company;
    const list = have.get(k);
    if (list) list.push({ ruleId });
    else have.set(k, [{ ruleId }]);
  };
  const existing = await db.query<{ staff_id: string; company: string | null; source_rule_id: string | null }>(
    `select staff_id, company, source_rule_id from ops.bonuses
      where type = 'commission' and status <> 'cancelled' and period_start = $1 and period_end = $2`,
    [periodStart, periodEnd],
  );
  for (const b of existing) note((b.staff_id || "").trim(), (b.company || "").trim(), (b.source_rule_id || "").trim());

  const lines: ProposedLine[] = [];
  const staffWithCommission = new Set<string>();
  let totalAmount = 0;
  // What is written for each line, in the order proposed.
  const written: Array<{ line: ProposedLine; reason: string }> = [];

  for (const rule of rules) {
    // Determine which staff this rule covers
    const targetStaff = rule.appliesTo === "all_staff" ? allStaff : allStaff.filter((s) => s.staffId === rule.staffId);
    const isFixed = rule.ruleType === "fixed";

    for (const person of targetStaff) {
      const key = person.staffId + "|" + rule.company;
      const row = salesMap.get(key);
      const salesTotal = row ? row.total : 0;

      // A percentage rule needs sales above the threshold to earn anything. A fixed rule only consults the
      // threshold when one is set (ADR-0013).
      if (isFixed) {
        if (rule.threshold > 0 && salesTotal <= rule.threshold + 0.005) continue;
      } else if (!row || salesTotal <= rule.threshold + 0.005) {
        continue;
      }

      // Layered rules of the same kind must not double-pay. A fee asks only whether IT has already paid
      // this week; a percentage rule ignores rows a fee produced, so the two can both land.
      const mine = have.get(key) ?? [];
      const already = isFixed ? mine.some((b) => b.ruleId === rule.ruleId) : mine.some((b) => !b.ruleId || percentageRuleIds.has(b.ruleId));
      if (already) continue;

      let amount: number;
      let reason: string;
      if (isFixed) {
        amount = roundMoney(rule.fixedAmount);
        reason =
          "Weekly fixed amount: " +
          rule.name +
          (rule.threshold > 0
            ? " (" + rule.company + " sales of " + formatMoney(salesTotal) + " over " + formatMoney(rule.threshold) + " threshold)"
            : " (" + rule.company + ", not tied to sales)");
      } else {
        const excess = roundMoney(salesTotal - rule.threshold);
        amount = roundMoney((excess * rule.percentage) / 100);
        reason = "Weekly commission: " + rule.company + " sales of " + formatMoney(salesTotal) + " over " + formatMoney(rule.threshold) + " threshold @ " + rule.percentage + "%";
      }
      if (amount <= 0.005) continue;

      // What Bonuses.propose refuses, refused here (it ran after the guards, as this does).
      if (!rule.company || COMPANIES.indexOf(rule.company) === -1) throw new Error("Invalid company: " + rule.company);

      const line: ProposedLine = {
        bonusId: newId("B", idDeps),
        staffId: person.staffId,
        staffName: person.name,
        company: rule.company,
        ruleId: rule.ruleId,
        ruleType: rule.ruleType,
        sales: salesTotal,
        threshold: rule.threshold,
        percentage: isFixed ? 0 : rule.percentage,
        fixedAmount: isFixed ? rule.fixedAmount : 0,
        amount,
      };
      lines.push(line);
      written.push({ line, reason });
      note(person.staffId, rule.company, rule.ruleId);
      staffWithCommission.add(person.staffId);
      totalAmount = roundMoney(totalAmount + amount);
    }
  }

  // Every proposal in one statement, status proposed (never pending, never paid).
  if (written.length > 0) {
    await db.query(
      `insert into ops.bonuses (bonus_id, staff_id, date, type, amount, reason, status, period_start, period_end, company,
                                source_run_id, created_by, created_at, notes, source_rule_id)
       select u.bonus_id, u.staff_id, $1::date, 'commission', u.amount, u.reason, 'proposed', $2::date, $3::date, u.company,
              $4, $5, $6::timestamptz, null, u.rule_id
         from unnest($7::text[], $8::text[], $9::numeric[], $10::text[], $11::text[], $12::text[]) as u(bonus_id, staff_id, amount, reason, company, rule_id)`,
      [
        formatDate(now),
        periodStart,
        periodEnd,
        runId,
        actorId,
        now,
        written.map((w) => w.line.bonusId),
        written.map((w) => w.line.staffId),
        written.map((w) => w.line.amount),
        written.map((w) => w.reason),
        written.map((w) => w.line.company),
        written.map((w) => w.line.ruleId),
      ],
    );
  }

  // Now write the commission_runs row with computed totals
  await writeRun(
    db,
    runId,
    {
      weekStart,
      weekEnd,
      staffCount: staffWithCommission.size,
      bonusesCreated: lines.length,
      totalAmount,
      computedBy: actorId,
      notes: force && existingRun ? "Forced re-run (previous: " + existingRun.runId + ")" : "",
    },
    now,
  );

  // The audit rows, in one statement: one per bonus (Bonuses.propose's), then the run's.
  await audit.writeMany(
    db,
    [
      ...written.map(({ line, reason }) => ({
        actorId,
        action: "bonus.proposed",
        targetType: "bonuses",
        targetId: line.bonusId,
        after: { staffId: line.staffId, type: "commission", amount: line.amount, status: "proposed", reason: String(reason).substring(0, REASON_AUDIT_LENGTH) },
      })),
      {
        actorId,
        action: "commission.run",
        targetType: "commission_runs",
        targetId: runId,
        after: { weekStart: formatDate(weekStart), weekEnd: formatDate(weekEnd), bonusesCreated: lines.length, totalAmount, staffCount: staffWithCommission.size },
      },
    ],
    { now, ...(deps.random ? { random: deps.random } : {}) },
  );

  await notifier.notify({ config: deps.config, env: deps.env, fetch: deps.fetch, db, now }, "commission.computed", {
    bonusesCreated: lines.length,
    totalAmount,
    ...({ weekStart: formatDate(weekStart), weekEnd: formatDate(weekEnd) } as object),
  });

  return { runId, weekStart, weekEnd, bonusesProposed: lines, totalAmount, staffCount: staffWithCommission.size, skipped: false };
}

/**
 * Run for the previous calendar week (Monday to Sunday, Toronto, the week before the one `now` is in).
 * `force` is only the boolean true. (Commissions.runForPreviousWeek)
 */
export async function runForPreviousWeek(db: Tx, actorId: string | null | undefined, force: unknown, deps: EngineDeps): Promise<RunResult> {
  const range = getPreviousWeekRange(deps.now);
  return runForWeek(db, { weekStart: range.start, weekEnd: range.end, actorId: actorId || TRIGGER_ACTOR, force: force === true }, deps);
}
