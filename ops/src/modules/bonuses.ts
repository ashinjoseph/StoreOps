// Bonuses: money owed to a person on top of their shifts (a bonus, commission, incentive,
// deduction, tip or adjustment). The port of src/Bonuses.gs: the four RPCs of the Commissions
// screen (rpcGetProposedBonuses, rpcApproveBonus, rpcCancelBonus, rpcCreateBonus) plus the
// functions other modules call (Commissions: propose, existsCommissionFor; Payments: markPaid,
// revertToPending; getForStaff for the pay screens).
//
// Lifecycle (ADR-0011: nothing is payable until a person approves it):
//   proposed   made by the commission engine; not payable
//   pending    approved, or added by an admin; payable
//   paid       fully paid through Payments
//   cancelled  never to be paid (a status: a bonus is never deleted)
//
//   from \ action   approve                     cancel                          markPaid                 revertToPending
//   proposed        -> pending                  -> cancelled                    refused                  returned as it is
//   pending         refused                     -> cancelled                    -> paid                  returned as it is
//   paid            refused                     refused                         refused                  -> pending
//   cancelled       refused                     returned as it is, no write     refused                  returned as it is
//   (unknown id)    refused                     refused                         refused                  null
//
// Records have the field names and shapes Bonuses.gs rowToRecord_ returns, with these
// differences: no _rowIndex (a Sheet row number means nothing here), and the date fields are
// "YYYY-MM-DD" text (a Date in the old app), except `createdAt`, which is a Date.
//
// Same as the old code, deliberately (ADR-0004 warns about each; parity decides, so they are kept
// and listed in the card's report):
//   - a blank reason, company, source run, source rule or note reads as '' (never null);
//   - a blank amount reads as 0 (`Number(x) || 0`; the column is NOT NULL here, so it cannot occur);
//   - an amount that is not a number (NaN) is accepted by create and stored as 0 (roundMoney
//     turns it into 0 after the "must be a number" and "cannot be zero" checks);
//   - create does not check the company against the two real ones (the Sheet took any text; this
//     schema refuses anything else, as a database error);
//   - propose does not check that the person exists (the schema does: a foreign key).
//
// Writes: one statement per row changed, in the caller's transaction, the row locked before it is
// read (lockRow) so two admins acting on one bonus cannot both win, and the audit row written with
// the action, target, before and after the old code wrote. The time is the call's `now`.
//
// Order: the Sheet returned rows in the order they were appended, and the lists sorted by `date`,
// which in the Sheet is the instant of creation. The date column here holds the day only, so the
// order is rebuilt from `date`, then `created_at` (the instant a row was appended), then, for rows
// written in one instant, the order the engine writes them in: rule (it loops rules, then people),
// then person, then id.
import type { Db } from "../db/client";
import { lockRow, type Tx } from "../db/tx";
import * as audit from "../lib/audit";
import { endOfDay, formatDate, parseDate } from "../lib/dates";
import { newId } from "../lib/ids";
import { roundMoney } from "../lib/money";
import * as staff from "./staff";

/** BONUS_TYPES in src/Setup.gs. */
export const BONUS_TYPES: readonly string[] = ["bonus", "commission", "incentive", "deduction", "tip", "adjustment"];
/** COMPANIES in src/Setup.gs. */
export const COMPANIES: readonly string[] = ["cstore", "vape"];

export interface BonusRecord {
  bonusId: string;
  staffId: string;
  /** "YYYY-MM-DD" (the day the bonus was made or dated), or null. A Date in the old app. */
  date: string | null;
  type: string;
  /** Rounded to cents. May be negative (a deduction). */
  amount: number;
  reason: string;
  status: string;
  /** "YYYY-MM-DD", or null. A Date in the old app. */
  periodStart: string | null;
  periodEnd: string | null;
  /** '' when blank, as in the old app. */
  company: string;
  sourceRunId: string;
  sourceRuleId: string;
  createdBy: string;
  createdAt: Date | null;
  notes: string;
}

interface BonusRow {
  bonus_id: string;
  staff_id: string;
  date: string | null;
  type: string;
  amount: number | null;
  reason: string | null;
  status: string;
  period_start: string | null;
  period_end: string | null;
  company: string | null;
  source_run_id: string | null;
  source_rule_id: string | null;
  created_by: string | null;
  created_at: Date | null;
  notes: string | null;
}

const COLUMNS = "bonus_id, staff_id, date, type, amount, reason, status, period_start, period_end, company, source_run_id, source_rule_id, created_by, created_at, notes";
// The engine writes its rows in this order: rules, then people. Blank rule ids (admin-made rows) sort last.
const TIE = `source_rule_id collate "C" nulls last, staff_id collate "C", bonus_id collate "C"`;
const ORDER = `created_at nulls last, ${TIE}`;
const trimmed = (v: string | null): string => (v || "").toString().trim();

function toRecord(r: BonusRow): BonusRecord {
  return {
    bonusId: trimmed(r.bonus_id),
    staffId: trimmed(r.staff_id),
    date: r.date,
    type: trimmed(r.type),
    amount: Number(r.amount) || 0,
    reason: (r.reason || "").toString(),
    status: trimmed(r.status),
    periodStart: r.period_start,
    periodEnd: r.period_end,
    company: trimmed(r.company),
    sourceRunId: trimmed(r.source_run_id),
    sourceRuleId: trimmed(r.source_rule_id),
    createdBy: trimmed(r.created_by),
    createdAt: r.created_at,
    notes: (r.notes || "").toString(),
  };
}

// ── Reads ──────────────────────────────────────────────────

/** Every bonus, in the order the rows were created. (Bonuses.getAll) */
export async function getAll(db: Db): Promise<BonusRecord[]> {
  const rows = await db.query<BonusRow>(`select ${COLUMNS} from ops.bonuses order by ${ORDER}`);
  return rows.map(toRecord).filter((b) => b.bonusId);
}

/** One bonus by its id, or null. (Bonuses.getById) */
export async function getById(db: Db, bonusId: string): Promise<BonusRecord | null> {
  if (typeof bonusId !== "string") return null; // the old comparison was ===, so a non-string never matched
  const row = await db.maybeOne<BonusRow>(`select ${COLUMNS} from ops.bonuses where bonus_id = $1`, [bonusId]);
  return row ? toRecord(row) : null;
}

/** One person's bonuses, newest first, optionally of one status. (Bonuses.getForStaff) */
export async function getForStaff(db: Db, staffId: string, statusFilter?: string | null): Promise<BonusRecord[]> {
  if (typeof staffId !== "string") return [];
  const params: unknown[] = [staffId];
  let where = "staff_id = $1";
  if (statusFilter) {
    params.push(String(statusFilter));
    where += ` and status = $${params.length}`;
  }
  const rows = await db.query<BonusRow>(`select ${COLUMNS} from ops.bonuses where ${where} order by date desc, created_at desc nulls last, ${TIE}`, params);
  return rows.map(toRecord);
}

/** The bonuses waiting for approval, oldest first. (Bonuses.getProposed) */
export async function getProposed(db: Db): Promise<BonusRecord[]> {
  const rows = await db.query<BonusRow>(`select ${COLUMNS} from ops.bonuses where status = 'proposed' order by date, ${ORDER}`);
  return rows.map(toRecord);
}

export interface ExistsOptions {
  /** Only a bonus produced by this rule counts. */
  sourceRuleId?: string | null;
  /** Only a bonus produced by one of these rules counts, and one written before rules were recorded (no rule at all). */
  blockingRuleIds?: readonly string[] | null;
}

/**
 * Is there already a commission for this person, company and period? A cancelled one does not
 * count. A period that is not two Dates is "no". See the options for the two narrower questions;
 * with none the answer is what it has always been. (Bonuses.existsCommissionFor)
 */
export async function existsCommissionFor(db: Db, staffId: string, company: string, periodStart: unknown, periodEnd: unknown, opts?: ExistsOptions | null): Promise<boolean> {
  if (!(periodStart instanceof Date) || !(periodEnd instanceof Date)) return false;
  const o = opts || {};
  const params: unknown[] = [String(staffId), String(company ?? ""), formatDate(periodStart), formatDate(periodEnd)];
  let rule = "";
  if (o.sourceRuleId) {
    params.push(String(o.sourceRuleId));
    rule = `and btrim(coalesce(source_rule_id, '')) = $${params.length}`;
  } else if (o.blockingRuleIds) {
    params.push([...o.blockingRuleIds].map(String));
    rule = `and (btrim(coalesce(source_rule_id, '')) = '' or btrim(source_rule_id) = any($${params.length}::text[]))`;
  }
  const row = await db.one<{ found: boolean }>(
    `select exists (
       select 1 from ops.bonuses
        where type = 'commission'
          and btrim(staff_id) = $1
          and btrim(coalesce(company, '')) = $2
          and status <> 'cancelled'
          and period_start = $3 and period_end = $4
          ${rule}
     ) as found`,
    params,
  );
  return row.found;
}

// ── Create ─────────────────────────────────────────────────

/** A cell value as the Sheet kept it: '' is a blank cell (NULL), anything else its text. */
const cell = (v: unknown): string | null => (v === "" || v === null || v === undefined ? null : String(v));

interface NewBonus {
  staffId: string;
  type: string;
  amount: number;
  reason: string;
  date: Date;
  status: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  company: string;
  sourceRunId: string;
  sourceRuleId: string;
  notes: string;
  actorId: string;
  auditAction: string;
}

async function writeRow(db: Db, rec: NewBonus, now: Date): Promise<BonusRecord> {
  // Ten random characters, not three: the engine makes a bonus per person per rule in one second.
  const bonusId = newId("B", { now, chars: 10 });
  await db.query(
    `insert into ops.bonuses (bonus_id, staff_id, date, type, amount, reason, status, period_start, period_end, company,
                              source_run_id, created_by, created_at, notes, source_rule_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      bonusId,
      rec.staffId,
      formatDate(rec.date),
      rec.type,
      rec.amount,
      rec.reason,
      rec.status,
      rec.periodStart ? formatDate(rec.periodStart) : null,
      rec.periodEnd ? formatDate(rec.periodEnd) : null,
      cell(rec.company),
      cell(rec.sourceRunId),
      rec.actorId,
      now,
      cell(rec.notes),
      cell(rec.sourceRuleId),
    ],
  );
  await audit.write(
    db,
    {
      actorId: rec.actorId,
      action: rec.auditAction,
      targetType: "bonuses",
      targetId: bonusId,
      after: { staffId: rec.staffId, type: rec.type, amount: rec.amount, status: rec.status, reason: String(rec.reason).substring(0, 100) },
    },
    { now },
  );
  return mustGet(db, bonusId);
}

async function mustGet(db: Db, id: string): Promise<BonusRecord> {
  const rec = await getById(db, id);
  if (!rec) throw new Error("Bonus not found: " + String(id));
  return rec;
}

export interface CreateInput {
  staffId?: unknown;
  type?: unknown;
  amount?: unknown;
  reason?: unknown;
  date?: unknown;
  company?: unknown;
  notes?: unknown;
  actorId?: unknown;
}

/**
 * An admin adds a bonus, deduction, tip or adjustment. It starts `pending`: payable. A negative
 * amount is allowed (a deduction); zero is not. `date` is a Date or, when it is not one, now.
 * (Bonuses.create)
 */
export async function create(db: Db, input: CreateInput, now: Date): Promise<BonusRecord> {
  if (!input.staffId) throw new Error("staffId required");
  if (!input.type) throw new Error("type required");
  if (BONUS_TYPES.indexOf(input.type as string) === -1) {
    throw new Error("Invalid type: " + String(input.type) + ". Must be one of: " + BONUS_TYPES.join(", "));
  }
  if (typeof input.amount !== "number") throw new Error("amount must be a number");
  if (input.amount === 0) throw new Error("amount cannot be zero");
  if (!input.reason) throw new Error("reason required");
  if (!input.actorId) throw new Error("actorId required");

  const person = typeof input.staffId === "string" ? await staff.getById(db, input.staffId) : null;
  if (!person) throw new Error("Staff not found: " + String(input.staffId));

  // Two things the Sheet took and this database refuses (review of P3-09a). The old app stored an
  // unreadable date and any text as a company; here the date column holds real dates only and the
  // company is cstore, vape or blank. Refuse with a message the person can read, before the insert,
  // rather than let the database fault through as SERVER_ERROR.
  if (input.date instanceof Date && Number.isNaN(input.date.getTime())) throw new Error("Invalid date");
  const company = String(input.company || "");
  if (company !== "" && COMPANIES.indexOf(company) === -1) throw new Error("Invalid company: " + company);

  return writeRow(
    db,
    {
      staffId: input.staffId as string,
      type: input.type as string,
      amount: roundMoney(input.amount),
      reason: String(input.reason),
      date: input.date instanceof Date ? input.date : now,
      status: "pending",
      periodStart: null,
      periodEnd: null,
      company: String(input.company || ""),
      sourceRunId: "",
      sourceRuleId: "",
      notes: String(input.notes || ""),
      actorId: String(input.actorId),
      auditAction: "bonus.created",
    },
    now,
  );
}

export interface ProposeInput {
  staffId?: unknown;
  amount?: unknown;
  reason?: unknown;
  periodStart?: unknown;
  periodEnd?: unknown;
  company?: unknown;
  sourceRunId?: unknown;
  sourceRuleId?: unknown;
  actorId?: unknown;
}

/**
 * The commission engine makes this. It starts `proposed`: an admin must approve it before it is
 * payable. The amount must be above zero. The run it came from may be written after it (the
 * database checks that link at commit). (Bonuses.propose)
 */
export async function propose(db: Db, input: ProposeInput, now: Date): Promise<BonusRecord> {
  if (!input.staffId) throw new Error("staffId required");
  if (typeof input.amount !== "number" || input.amount <= 0) throw new Error("amount must be a positive number");
  if (!input.reason) throw new Error("reason required");
  if (!(input.periodStart instanceof Date)) throw new Error("periodStart Date required");
  if (!(input.periodEnd instanceof Date)) throw new Error("periodEnd Date required");
  if (!input.company || COMPANIES.indexOf(input.company as string) === -1) throw new Error("Invalid company: " + String(input.company));
  if (!input.actorId) throw new Error("actorId required");

  return writeRow(
    db,
    {
      staffId: String(input.staffId),
      type: "commission",
      amount: roundMoney(input.amount),
      reason: String(input.reason),
      date: now,
      status: "proposed",
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      company: input.company as string,
      sourceRunId: String(input.sourceRunId || ""),
      sourceRuleId: String(input.sourceRuleId || ""),
      notes: "",
      actorId: String(input.actorId),
      auditAction: "bonus.proposed",
    },
    now,
  );
}

// ── Status moves ───────────────────────────────────────────

/** Lock the bonus row (when the id can be one), then read it. Absent is null. */
async function lockAndGet(db: Tx, bonusId: unknown): Promise<BonusRecord | null> {
  if (typeof bonusId === "string") await lockRow(db, "bonuses", bonusId);
  return getById(db, bonusId as string);
}

/** An admin approves a proposed bonus: `proposed` becomes `pending`. Anything else is refused. (Bonuses.approve) */
export async function approve(db: Tx, bonusId: unknown, actorId: unknown, now: Date): Promise<BonusRecord> {
  if (!bonusId) throw new Error("bonusId required");
  if (!actorId) throw new Error("actorId required");

  const id = bonusId as string; // a found bonus was looked up by a string
  const bonus = await lockAndGet(db, bonusId);
  if (!bonus) throw new Error("Bonus not found: " + String(bonusId));
  if (bonus.status !== "proposed") throw new Error("Can only approve proposed bonuses (current: " + bonus.status + ")");

  await db.query("update ops.bonuses set status = 'pending' where bonus_id = $1", [id]);
  await audit.write(
    db,
    { actorId: String(actorId), action: "bonus.approved", targetType: "bonuses", targetId: id, before: { status: "proposed" }, after: { status: "pending" } },
    { now },
  );
  return mustGet(db, id);
}

/**
 * Cancel a bonus from any status except `paid` (undo the payment first). Cancelling one that is
 * already cancelled answers it as it is and writes nothing. A reason is added to the note after
 * " | ". (Bonuses.cancel)
 */
export async function cancel(db: Tx, bonusId: unknown, actorId: unknown, reason: unknown, now: Date): Promise<BonusRecord> {
  if (!bonusId) throw new Error("bonusId required");
  if (!actorId) throw new Error("actorId required");

  const id = bonusId as string; // a found bonus was looked up by a string
  const bonus = await lockAndGet(db, bonusId);
  if (!bonus) throw new Error("Bonus not found: " + String(bonusId));
  if (bonus.status === "paid") throw new Error("Cannot cancel a paid bonus — undo the payment first");
  if (bonus.status === "cancelled") return bonus;

  if (reason) {
    const notes = bonus.notes + (bonus.notes ? " | " : "") + "Cancelled: " + String(reason);
    await db.query("update ops.bonuses set status = 'cancelled', notes = $2 where bonus_id = $1", [id, cell(notes)]);
  } else {
    await db.query("update ops.bonuses set status = 'cancelled' where bonus_id = $1", [id]);
  }
  await audit.write(
    db,
    {
      actorId: String(actorId),
      action: "bonus.cancelled",
      targetType: "bonuses",
      targetId: id,
      before: { status: bonus.status },
      after: { status: "cancelled", reason: reason || "" },
    },
    { now },
  );
  return mustGet(db, id);
}

/** Payments.payBonus calls this when a bonus is fully paid: `pending` becomes `paid`. Anything else is refused. (Bonuses.markPaid) */
export async function markPaid(db: Tx, bonusId: unknown, actorId: unknown, now: Date): Promise<BonusRecord> {
  const id = bonusId as string; // a found bonus was looked up by a string
  const bonus = await lockAndGet(db, bonusId);
  if (!bonus) throw new Error("Bonus not found: " + String(bonusId));
  if (bonus.status !== "pending") throw new Error("Can only pay pending bonuses (current: " + bonus.status + ")");

  await db.query("update ops.bonuses set status = 'paid' where bonus_id = $1", [id]);
  await audit.write(
    db,
    { actorId: actorId ? String(actorId) : "SYSTEM", action: "bonus.paid", targetType: "bonuses", targetId: id, before: { status: "pending" }, after: { status: "paid" } },
    { now },
  );
  return mustGet(db, id);
}

/**
 * Payments.undo calls this when a payment that included the bonus is reversed: `paid` becomes
 * `pending`. An unknown bonus is null; one that is not paid is returned as it is. (Bonuses.revertToPending)
 */
export async function revertToPending(db: Tx, bonusId: unknown, actorId: unknown, now: Date): Promise<BonusRecord | null> {
  const id = bonusId as string; // a found bonus was looked up by a string
  const bonus = await lockAndGet(db, bonusId);
  if (!bonus) return null;
  if (bonus.status !== "paid") return bonus;

  await db.query("update ops.bonuses set status = 'pending' where bonus_id = $1", [id]);
  await audit.write(
    db,
    {
      actorId: actorId ? String(actorId) : "SYSTEM",
      action: "bonus.reverted",
      targetType: "bonuses",
      targetId: id,
      before: { status: "paid" },
      after: { status: "pending" },
      details: "Reverted due to payment undo",
    },
    { now },
  );
  return mustGet(db, id);
}

// ── What rpcGetProposedBonuses sends ───────────────────────

/**
 * The instants the old answer carried. The database holds days, not instants, so they are rebuilt:
 *   date          the moment the bonus was made when that was on the stored day (what the engine and an
 *                 un-dated create wrote), else midnight Toronto of the stored day (an admin's typed date);
 *   periodStart   midnight Toronto of the stored day;
 *   periodEnd     23:59:59 Toronto of the stored day (the engine's week end).
 * Not exact for a typed date that is today (the old instant was midnight) or a period end that had
 * milliseconds; both are reported with the card.
 */
export function instantsOf(b: Pick<BonusRecord, "date" | "createdAt" | "periodStart" | "periodEnd">): { date: string | null; periodStart: string | null; periodEnd: string | null } {
  const midnight = (day: string | null): Date | null => (day ? parseDate(day) : null);
  const dateMidnight = midnight(b.date);
  const sameDay = b.createdAt !== null && b.date !== null && formatDate(b.createdAt) === b.date;
  const end = midnight(b.periodEnd);
  return {
    date: sameDay && b.createdAt ? b.createdAt.toISOString() : dateMidnight ? dateMidnight.toISOString() : null,
    periodStart: midnight(b.periodStart)?.toISOString() ?? null,
    periodEnd: end ? new Date(endOfDay(end).getTime() - 999).toISOString() : null,
  };
}
