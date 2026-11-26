// Payments: what each person is owed, and what they were paid. The port of src/Payments.gs (every
// exported function) plus Attendance.getUnpaidForStaff, for the seven RPCs of the Payroll, My Pay
// and History screens (card P3-09b).
//
// A payment pays one person on one occasion: an amount spread over their unpaid shifts oldest first
// (payShifts), or put on one bonus (payBonus). Each allocation is a payment_items row whose ref_id
// is an attendance id (item_type 'shift') or a bonus id ('bonus').
//
// Undo is a void, not a delete (AGENTS.md hard rule 9; the app role cannot delete money rows): the
// old app deleted the payment and its items, this one sets voided_at, voided_by and void_reason and
// keeps both. Every read below goes through LIVE_PAYMENTS / LIVE_ITEMS, the one place that leaves a
// voided payment and its items out, so each answer is the old answer after its delete, and a voided
// id is "not found" everywhere.
//
// The arithmetic is the old arithmetic, rounding (roundMoney, in code, before any write) at exactly
// the points the old code rounds:
//   value of a shift   roundMoney(hours_worked x rate_at_attendance)          Attendance.gs:112, Payments.gs:195
//   paid on a shift    each item added and rounded in turn                     Payments.gs:145
//   remaining          roundMoney(value - paid); owed only when > 0.005        Payments.gs:197
//   shifts owed        rounded after each shift is added                       Payments.gs:221
//   the walk           oldest first; each takes roundMoney(min(its remaining, what is left)),
//                      partial when it takes less than its remaining - 0.005  Payments.gs:352
//   overpayment        refused when the rounded amount > owed + 0.005          Payments.gs:322
//
// Same as the old code, deliberately (each is listed in the card's report):
//   - a blank hours_worked or rate_at_attendance counts as 0 (`Number(x) || 0` in Attendance.gs), so
//     a worked day with a blank rate is owed nothing and never appears;
//   - an amount that is not a number (NaN: '', 'abc' or a missing amount reaches here as NaN from the
//     RPC's Number()) passes the "positive number" check and rounds to 0: a $0.00 payment with no
//     items is recorded, audited and announced. So is an amount under half a cent (0.004);
//   - the schedule-mismatch guard never fires: the record the old code checked
//     (getUnpaidForStaff's) carries no scheduled or actual times, so scheduledHours, actualHours and
//     hoursBasis were always 0, 0 and '' (Payments.gs:202). The guard is ported as it is;
//   - a deduction (a negative bonus) cannot be paid: its remainder is below 0.005 ("Bonus already
//     fully paid");
//   - payShifts and payBonus are always dated now: the RPCs never passed a paidOn.
//
// One payment is one unit, one at a time per person: before anything is read for a payment or an
// undo, the person's staff row is locked, then the rows that will change. A second payment to the
// same person waits, then reads the first one's items. The router's transaction holds the locks.
//
// Records have the old field names and shapes, with these differences: no _rowIndex (a Sheet row
// number), and paidOn is "YYYY-MM-DD" (the column holds the day; a Date in the old app; instantOf
// rebuilds the instant the history answers with).
//
// Order. The old lists sorted by the paidOn instant, newest first, and kept the Sheet's order among
// equal instants (an array sort is stable). Here the instant is rebuilt from the payment id's stamp
// (instantOf), and "the Sheet's order" is the order the rows were written: the `seq` column, which
// the database numbers as each row is inserted (migration 0004). An item list is in its payment's walk order: shift
// items oldest day first (an attendance id holds its day), then the id.
import type { Db } from "../db/client";
import { lockRow, type Tx } from "../db/tx";
import * as audit from "../lib/audit";
import { formatDate, parseDate } from "../lib/dates";
import { newId } from "../lib/ids";
import { formatMoney, roundMoney } from "../lib/money";
import * as attendance from "./attendance";
import * as bonuses from "./bonuses";
import type { BonusRecord } from "./bonuses";
import { notify, type NotifierDeps, type NotifyPayload } from "./notifier";
import * as staff from "./staff";

/** PAYMENT_METHODS in src/Setup.gs. */
export const PAYMENT_METHODS: readonly string[] = ["cash", "bank", "etransfer", "other"];

/** What a write needs besides the database: the clock, and what the Notifier is given. */
export type PaymentDeps = Omit<NotifierDeps, "db">;

export interface PaymentRecord {
  paymentId: string;
  staffId: string;
  /** "YYYY-MM-DD". A Date (the moment it was recorded) in the old app: see instantOf. */
  paidOn: string | null;
  totalAmount: number;
  method: string;
  recordedBy: string;
  notes: string;
}

export interface ItemRecord {
  itemId: string;
  paymentId: string;
  itemType: string;
  refId: string;
  amount: number;
  notes: string;
}

/** One unpaid worked day, as Attendance.getUnpaidForStaff returned it. */
export interface UnpaidShift {
  attendanceId: string;
  /** "YYYY-MM-DD" (a Date in the old app). */
  date: string;
  dateStr: string;
  staffId: string;
  hoursWorked: number;
  rateAtAttendance: number;
  value: number;
  paid: number;
  remaining: number;
}

export interface OwedShift {
  attendanceId: string;
  /** The ISO instant of Toronto midnight of the day, as the old answer had it. */
  date: string | null;
  dateStr: string;
  hoursWorked: number;
  rate: number;
  value: number;
  paid: number;
  remaining: number;
  scheduledHours: number;
  actualHours: number;
  hoursBasis: string;
  mismatch: boolean;
}

export interface OwedBonus {
  bonusId: string;
  type: string;
  amount: number;
  paid: number;
  remaining: number;
  date: string | null;
  dateStr: string;
  reason: string;
  company: string;
}

export interface OwedSummary {
  staffId: string;
  shiftsOwed: number;
  bonusesOwed: number;
  totalOwed: number;
  unpaidShifts: OwedShift[];
  pendingBonuses: OwedBonus[];
  mismatchCount: number;
  hasMismatch: boolean;
}

// ── The one place a voided payment is left out ────────────

/** Payments that stand: not voided. With the order the rows were written (see the header). */
const LIVE_PAYMENTS = `(select p.payment_id, p.staff_id, p.paid_on, p.total_amount, p.method, p.recorded_by, p.notes,
                               p.seq
                          from ops.payments p
                         where p.voided_at is null)`;
/** Items of payments that stand. */
const LIVE_ITEMS = `(select i.item_id, i.payment_id, i.item_type, i.ref_id, i.amount, i.notes
                       from ops.payment_items i
                       join ops.payments p on p.payment_id = i.payment_id
                      where p.voided_at is null)`;

const P_COLUMNS = "payment_id, staff_id, paid_on, total_amount, method, recorded_by, notes";
const P_ORDER = "order by seq";
const I_COLUMNS = "item_id, payment_id, item_type, ref_id, amount, notes";
const I_ORDER = `order by ref_id collate "C", item_id collate "C"`;

interface PaymentRow {
  payment_id: string;
  staff_id: string;
  paid_on: string | null;
  total_amount: number | null;
  method: string | null;
  recorded_by: string | null;
  notes: string | null;
}
interface ItemRow {
  item_id: string;
  payment_id: string;
  item_type: string;
  ref_id: string;
  amount: number | null;
  notes: string | null;
}

const trimmed = (v: string | null): string => (v || "").toString().trim();
/** A cell value as the Sheet kept it: '' is a blank cell (NULL), anything else its text. */
const cell = (v: unknown): string | null => (v === "" || v === null || v === undefined ? null : String(v));

function toPayment(r: PaymentRow): PaymentRecord {
  return {
    paymentId: trimmed(r.payment_id),
    staffId: trimmed(r.staff_id),
    paidOn: r.paid_on,
    totalAmount: Number(r.total_amount) || 0,
    method: (r.method || "").toString(),
    recordedBy: (r.recorded_by || "").toString(),
    notes: (r.notes || "").toString(),
  };
}

function toItem(r: ItemRow): ItemRecord {
  return {
    itemId: trimmed(r.item_id),
    paymentId: trimmed(r.payment_id),
    itemType: trimmed(r.item_type),
    refId: trimmed(r.ref_id),
    amount: Number(r.amount) || 0,
    notes: (r.notes || "").toString(),
  };
}

const STAMP = /^P_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})_/;

/**
 * The instant the old paidOn held. The old app wrote the current time when it recorded the payment, and
 * made the id from the same clock (P_<yyyyMMdd>_<HHmmss>_…, Toronto). The column keeps the day, so:
 * the id's stamp when it is on the stored day, else Toronto midnight of the stored day. Exact to the
 * second (the old instant had milliseconds; the parity clock has none).
 */
export function instantOf(p: Pick<PaymentRecord, "paymentId" | "paidOn">): Date | null {
  if (!p.paidOn) return null;
  const m = STAMP.exec(p.paymentId);
  if (m && `${m[1]}-${m[2]}-${m[3]}` === p.paidOn) {
    const at = attendance.parseInstant(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
    if (!Number.isNaN(at.getTime()) && formatDate(at) === p.paidOn) return at;
  }
  return parseDate(p.paidOn);
}

/** Newest first by the paidOn instant; equal instants keep the order given (the order written). */
function newestFirst(list: PaymentRecord[]): PaymentRecord[] {
  const t = new Map(list.map((p) => [p, instantOf(p)?.getTime() ?? 0]));
  return [...list].sort((a, b) => (t.get(b) as number) - (t.get(a) as number));
}

// ── Reads ──────────────────────────────────────────────────

/** Every payment that stands, in the order written. (Payments.getAllPayments) */
export async function getAllPayments(db: Db): Promise<PaymentRecord[]> {
  const rows = await db.query<PaymentRow>(`select ${P_COLUMNS} from ${LIVE_PAYMENTS} p ${P_ORDER}`);
  return rows.map(toPayment).filter((r) => r.paymentId && !r.paymentId.startsWith("P_PLACEHOLDER"));
}

/** Every item of a payment that stands. (Payments.getAllItems) */
export async function getAllItems(db: Db): Promise<ItemRecord[]> {
  const rows = await db.query<ItemRow>(`select ${I_COLUMNS} from ${LIVE_ITEMS} i ${I_ORDER}`);
  return rows.map(toItem).filter((r) => r.itemId && !r.itemId.startsWith("IT_PLACEHOLDER"));
}

/** One payment that stands, or null (a voided one is null, as a deleted one was). (Payments.getPaymentById) */
export async function getPaymentById(db: Db, paymentId: unknown): Promise<PaymentRecord | null> {
  if (typeof paymentId !== "string") return null; // the old comparison was ===
  const row = await db.maybeOne<PaymentRow>(`select ${P_COLUMNS} from ${LIVE_PAYMENTS} p where payment_id = $1`, [paymentId]);
  return row ? toPayment(row) : null;
}

/** The items of one payment that stands, in walk order. (Payments.getItemsForPayment) */
export async function getItemsForPayment(db: Db, paymentId: unknown): Promise<ItemRecord[]> {
  return (await getItemsForPayments(db, [paymentId]))[0] as ItemRecord[];
}

/** The items of several payments in one query, a list per id in the order given. */
export async function getItemsForPayments(db: Db, paymentIds: readonly unknown[]): Promise<ItemRecord[][]> {
  const ids = paymentIds.filter((x): x is string => typeof x === "string");
  const rows = ids.length === 0 ? [] : await db.query<ItemRow>(`select ${I_COLUMNS} from ${LIVE_ITEMS} i where payment_id = any($1::text[]) ${I_ORDER}`, [ids]);
  const by = new Map<string, ItemRecord[]>();
  for (const it of rows.map(toItem).filter((r) => r.itemId && !r.itemId.startsWith("IT_PLACEHOLDER"))) by.set(it.paymentId, [...(by.get(it.paymentId) ?? []), it]);
  return paymentIds.map((id) => (typeof id === "string" ? (by.get(id) ?? []) : []));
}

/** One person's payments that stand, newest first. (Payments.getPaymentsForStaff) */
export async function getPaymentsForStaff(db: Db, staffId: unknown): Promise<PaymentRecord[]> {
  if (typeof staffId !== "string") return [];
  const rows = await db.query<PaymentRow>(`select ${P_COLUMNS} from ${LIVE_PAYMENTS} p where staff_id = $1 ${P_ORDER}`, [staffId]);
  return newestFirst(rows.map(toPayment).filter((r) => r.paymentId && !r.paymentId.startsWith("P_PLACEHOLDER")));
}

/** The newest `limit` payments of everyone (a falsy limit is 50; JavaScript's slice: a negative one drops that many oldest). (Payments.getRecent) */
export async function getRecent(db: Db, limit?: number): Promise<PaymentRecord[]> {
  const n = limit || 50;
  return newestFirst(await getAllPayments(db)).slice(0, n);
}

/** Paid so far through `type` items of payments that stand, by ref id: each item added and rounded in turn. */
async function paidAmounts(db: Db, type: "shift" | "bonus", refIds: readonly unknown[]): Promise<Record<string, number>> {
  const ids = [...new Set(refIds.filter((x): x is string => typeof x === "string"))];
  if (ids.length === 0) return {};
  const rows = await db.query<{ ref_id: string; amount: number | null }>(`select ref_id, amount from ${LIVE_ITEMS} i where item_type = $1 and ref_id = any($2::text[]) ${I_ORDER}`, [type, ids]);
  const map: Record<string, number> = {};
  for (const r of rows) map[r.ref_id] = roundMoney((map[r.ref_id] || 0) + (Number(r.amount) || 0));
  return map;
}

/** { attendanceId: paid so far } for the ids that have any. (Payments.getAttendancePaidAmounts) */
export function getAttendancePaidAmounts(db: Db, attendanceIds: readonly unknown[] | null | undefined): Promise<Record<string, number>> {
  return paidAmounts(db, "shift", attendanceIds || []);
}

/** { bonusId: paid so far } for the ids that have any. (Payments.getBonusPaidAmounts) */
export function getBonusPaidAmounts(db: Db, bonusIds: readonly unknown[] | null | undefined): Promise<Record<string, number>> {
  return paidAmounts(db, "bonus", bonusIds || []);
}

// ── What is owed ───────────────────────────────────────────

interface WorkedRow {
  attendance_id: string;
  staff_id: string;
  date: string;
  hours_worked: number | null;
  rate_at_attendance: number | null;
  status: string | null;
}

/** Unpaid worked days of several people (two queries), oldest first per person. */
async function unpaidFor(db: Db, staffIds: readonly string[]): Promise<Map<string, UnpaidShift[]>> {
  const out = new Map<string, UnpaidShift[]>(staffIds.map((s) => [s, []]));
  if (staffIds.length === 0) return out;
  const rows = await db.query<WorkedRow>(
    `select attendance_id, staff_id, date, hours_worked, rate_at_attendance, status from ops.attendance
      where staff_id = any($1::text[]) order by date, created_at nulls last, attendance_id collate "C"`,
    [[...staffIds]],
  );
  // Attendance.gs rowToRecord_: trimmed text, a blank status is 'scheduled', blank numbers are 0 (kept).
  const worked = rows
    .map((r) => ({ attendanceId: trimmed(r.attendance_id), staffId: trimmed(r.staff_id), date: r.date, hoursWorked: Number(r.hours_worked) || 0, rateAtAttendance: Number(r.rate_at_attendance) || 0, status: trimmed(r.status) || "scheduled" }))
    .filter((a) => a.attendanceId && a.staffId && a.status === "worked");
  const paidMap = await getAttendancePaidAmounts(db, worked.map((a) => a.attendanceId));
  for (const r of worked) {
    const value = roundMoney(r.hoursWorked * r.rateAtAttendance);
    const paid = roundMoney(paidMap[r.attendanceId] || 0);
    const remaining = roundMoney(value - paid);
    if (remaining > 0.005) {
      out.get(r.staffId)?.push({ attendanceId: r.attendanceId, date: r.date, dateStr: r.date, staffId: r.staffId, hoursWorked: r.hoursWorked, rateAtAttendance: r.rateAtAttendance, value, paid, remaining });
    }
  }
  return out;
}

/**
 * One person's worked days with something left to pay, oldest first (fully paid ones left out).
 * Ported here, not in attendance.ts: it is the allocation walk's input and needs the paid amounts,
 * and the payroll overview needs it for everyone at once. (Attendance.getUnpaidForStaff)
 */
export async function getUnpaidForStaff(db: Db, staffId: unknown): Promise<UnpaidShift[]> {
  if (typeof staffId !== "string") return []; // the old comparison was ===
  return (await unpaidFor(db, [staffId])).get(staffId) ?? [];
}

const ms = (d: Date | null): number => (d ? d.getTime() : 0);

/**
 * Bonuses.getForStaff's order (newest `date` instant first; equal instants in the order the rows were
 * written), as a total order so that one person's list and everyone's give the same: the instant,
 * then the moment the row was made, then its period (the engine writes older weeks first), then the
 * engine's own order within a run (bonuses.ts: rule, person, id).
 */
function bonusOrder(a: BonusRecord, b: BonusRecord): number {
  const da = ms(dateInstant(a));
  const dbb = ms(dateInstant(b));
  if (da !== dbb) return dbb - da;
  const ca = a.createdAt ? a.createdAt.getTime() : Number.POSITIVE_INFINITY;
  const cb = b.createdAt ? b.createdAt.getTime() : Number.POSITIVE_INFINITY;
  if (ca !== cb) return ca < cb ? -1 : 1;
  for (const [x, y] of [
    [a.periodStart ?? "", b.periodStart ?? ""],
    [a.sourceRuleId || "￿", b.sourceRuleId || "￿"],
    [a.staffId, b.staffId],
    [a.bonusId, b.bonusId],
  ] as const) {
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function dateInstant(b: BonusRecord): Date | null {
  const iso = bonuses.instantsOf(b).date;
  return iso ? new Date(iso) : null;
}

/** The summary of one person from what was read (Payments.getOwedSummary_ lines 189-260). */
function summarise(staffId: string, unpaid: readonly UnpaidShift[], ownBonuses: readonly BonusRecord[], bonusPaidMap: Record<string, number>): OwedSummary {
  const unpaidShifts: OwedShift[] = [];
  let shiftsOwed = 0;
  for (const a of unpaid) {
    const value = roundMoney(a.hoursWorked * a.rateAtAttendance);
    const paid = a.paid;
    const remaining = roundMoney(value - paid);
    if (remaining > 0.005) {
      // The old code asked Attendance.scheduledHours / actualHours of this record, which carries no
      // scheduled or actual times, and read its (absent) hours_basis: always 0, 0 and '', so no shift
      // is ever a mismatch (kept; a finding). The comparison is ported as it was.
      const scheduledHours = 0;
      const actualHours = 0;
      const hoursBasis = "";
      const mismatch = scheduledHours > 0 && actualHours > 0 && Math.abs(scheduledHours - actualHours) >= 0.01 && !hoursBasis;
      const midnight = parseDate(a.date);
      unpaidShifts.push({
        attendanceId: a.attendanceId,
        date: midnight ? midnight.toISOString() : null,
        dateStr: a.date ? formatDate(midnight as Date) : "",
        hoursWorked: a.hoursWorked,
        rate: a.rateAtAttendance,
        value,
        paid,
        remaining,
        scheduledHours,
        actualHours,
        hoursBasis,
        mismatch,
      });
      shiftsOwed = roundMoney(shiftsOwed + remaining);
    }
  }
  const mismatchCount = unpaidShifts.filter((s) => s.mismatch).length;

  const pendingBonuses: OwedBonus[] = [...ownBonuses]
    .sort(bonusOrder)
    .filter((b) => b.status === "pending")
    .map((b) => {
      const paid = bonusPaidMap[b.bonusId] || 0;
      const remaining = roundMoney(b.amount - paid);
      const at = dateInstant(b);
      return { bonusId: b.bonusId, type: b.type, amount: b.amount, paid, remaining, date: at ? at.toISOString() : null, dateStr: at ? formatDate(at) : "", reason: b.reason, company: b.company };
    })
    .filter((b) => b.remaining > 0.005);
  const bonusesOwed = roundMoney(pendingBonuses.reduce((s, b) => s + b.remaining, 0));

  return { staffId, shiftsOwed, bonusesOwed, totalOwed: roundMoney(shiftsOwed + bonusesOwed), unpaidShifts, pendingBonuses, mismatchCount, hasMismatch: mismatchCount > 0 };
}

/**
 * What one person is owed: unpaid shifts oldest first, pending bonuses, totals. An id that is not
 * text, or names nobody, is owed nothing. (Payments.getOwedSummary)
 */
export async function getOwedSummary(db: Db, staffId: unknown): Promise<OwedSummary> {
  if (!staffId) throw new Error("staffId required");
  const id = staffId as string; // used only when it is text; anything else matched no row in the old code
  const isText = typeof staffId === "string";
  const unpaid = isText ? await getUnpaidForStaff(db, id) : [];
  const own = isText ? await bonuses.getForStaff(db, id) : [];
  const paid = await getBonusPaidAmounts(db, own.map((b) => b.bonusId));
  return summarise(id, unpaid, own, paid);
}

/** getOwedSummary for several people in a fixed number of queries (four), whatever their number. */
export async function getOwedSummaries(db: Db, staffIds: readonly string[]): Promise<Map<string, OwedSummary>> {
  const unpaid = await unpaidFor(db, staffIds);
  const wanted = new Set(staffIds);
  const all = (await bonuses.getAll(db)).filter((b) => wanted.has(b.staffId));
  const paid = await getBonusPaidAmounts(db, all.map((b) => b.bonusId));
  const out = new Map<string, OwedSummary>();
  for (const s of staffIds) {
    out.set(
      s,
      summarise(
        s,
        unpaid.get(s) ?? [],
        all.filter((b) => b.staffId === s),
        paid,
      ),
    );
  }
  return out;
}

// ── Writes ─────────────────────────────────────────────────

async function insertPayment(db: Db, row: { paymentId: string; staffId: string; now: Date; amount: number; method: string; actorId: string; notes: string }): Promise<void> {
  await db.query(`insert into ops.payments (${P_COLUMNS}) values ($1, $2, $3, $4, $5, $6, $7)`, [row.paymentId, row.staffId, formatDate(row.now), row.amount, row.method, cell(row.actorId), cell(row.notes)]);
}

/** Every item in one statement. */
async function insertItems(db: Db, items: readonly ItemRecord[]): Promise<void> {
  if (items.length === 0) return;
  const params: unknown[] = [];
  const groups = items.map((it) => {
    params.push(it.itemId, it.paymentId, it.itemType, it.refId, it.amount, cell(it.notes));
    const n = params.length;
    return `($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
  });
  await db.query(`insert into ops.payment_items (${I_COLUMNS}) values ${groups.join(", ")}`, params);
}

/** Item ids end in ten random characters, not three: one payment writes many in one second, and item_id is a primary key. */
const itemId = (now: Date): string => newId("IT", { now, chars: 10 });

/** The method as the old code checked it (after the amount checks): blank is cash, anything else must be one of the four. */
function checkMethod(method: unknown): string {
  const m = (method || "cash") as string;
  if (PAYMENT_METHODS.indexOf(m) === -1) throw new Error("Invalid payment method: " + String(m));
  return m;
}

export interface PayShiftsInput {
  staffId?: unknown;
  amount?: unknown;
  method?: unknown;
  notes?: unknown;
  overrideMismatch?: unknown;
  actorId?: unknown;
}

export interface PayShiftsResult {
  paymentId: string;
  totalAmount: number;
  kind: "shifts";
  itemsCreated: Array<{ itemId: string; attendanceId: string; dateStr: string; amount: number; isPartial: boolean }>;
  summary: { shiftsOwedBefore: number; shiftsOwedAfter: number; fullyPaidCount: number; partialCount: number };
}

/**
 * Pay `amount` against one person's unpaid shifts, oldest first, filling each before the next; the
 * last may be part-paid. More than is owed is refused with what is owed. Bonuses are not touched.
 * Dated now. (Payments.payShifts)
 */
export async function payShifts(db: Tx, input: PayShiftsInput, deps: PaymentDeps): Promise<PayShiftsResult> {
  if (!input.staffId) throw new Error("staffId required");
  if (typeof input.amount !== "number" || input.amount <= 0) throw new Error("amount must be a positive number");
  if (!input.actorId) throw new Error("actorId required");
  const actorId = String(input.actorId);
  const now = deps.now;

  // One payment at a time per person: lock them before anything is read.
  const person = typeof input.staffId === "string" && (await lockRow(db, "staff", input.staffId)) ? await staff.getById(db, input.staffId) : null;
  if (!person) throw new Error("Staff not found: " + String(input.staffId));
  const staffId = input.staffId as string;

  const override = input.overrideMismatch === true;
  let owed = await getOwedSummary(db, staffId);

  // The schedule-mismatch guard (never true: see the header). Kept as the old code had it.
  const mism = owed.unpaidShifts.filter((s) => s.mismatch);
  if (mism.length) {
    if (!override) {
      const dates = mism.map((s) => s.dateStr + " (sched " + s.scheduledHours.toFixed(2) + "h ≠ actual " + s.actualHours.toFixed(2) + "h)").join("; ");
      throw new Error("SCHEDULE_MISMATCH: " + person.name + " has unreconciled shifts — " + dates + ". Reconcile recorded hours on the Schedule tab, or override to pay per actual.");
    }
    for (const s of mism) await attendance.adjustHours(db, s.attendanceId, "actual", actorId, now);
    owed = await getOwedSummary(db, staffId);
  }

  const amount = override && mism.length ? owed.shiftsOwed : roundMoney(input.amount);

  if (owed.shiftsOwed <= 0.005) throw new Error("No unpaid shifts for " + person.name + ". Nothing to pay.");
  if (amount > owed.shiftsOwed + 0.005) {
    throw new Error(
      "Overpayment rejected: trying to pay " +
        formatMoney(amount) +
        " but only " +
        formatMoney(owed.shiftsOwed) +
        " owed in unpaid shifts for " +
        person.name +
        ". " +
        (owed.bonusesOwed > 0 ? "To pay a bonus (" + formatMoney(owed.bonusesOwed) + " pending), use the bonus flow." : ""),
    );
  }
  const method = checkMethod(input.method);

  const paymentId = newId("P", { now });
  await insertPayment(db, { paymentId, staffId, now, amount, method, actorId, notes: String(input.notes || "") });

  // The walk: oldest first.
  const items: ItemRecord[] = [];
  const itemsCreated: PayShiftsResult["itemsCreated"] = [];
  let remaining = amount;
  for (const s of owed.unpaidShifts) {
    if (remaining <= 0.005) break;
    const toApply = roundMoney(Math.min(s.remaining, remaining));
    const isPartial = toApply < s.remaining - 0.005;
    const id = itemId(now);
    items.push({ itemId: id, paymentId, itemType: "shift", refId: s.attendanceId, amount: toApply, notes: isPartial ? "Partial — " + formatMoney(toApply) + " of " + formatMoney(s.remaining) : "" });
    itemsCreated.push({ itemId: id, attendanceId: s.attendanceId, dateStr: s.dateStr, amount: toApply, isPartial });
    remaining = roundMoney(remaining - toApply);
  }
  await insertItems(db, items);

  if (remaining > 0.005) {
    // Should be impossible given the overpayment guard, but make noise if so (as the old code did).
    await audit.write(db, { actorId, action: "payment.allocation_error", targetType: "payments", targetId: paymentId, details: "Unallocated " + formatMoney(remaining) + " after walking shifts — INVESTIGATE" }, { now });
  }
  await audit.write(
    db,
    { actorId, action: "payment.shifts", targetType: "payments", targetId: paymentId, after: { staffId, amount, itemCount: itemsCreated.length, attendanceIds: itemsCreated.map((i) => i.attendanceId) } },
    { now },
  );
  const payload: NotifyPayload & Record<string, unknown> = { staffId, staffName: person.name, amount, kind: "shifts", itemCount: itemsCreated.length };
  await notify({ ...deps, db }, "payment.recorded", payload);

  return {
    paymentId,
    totalAmount: amount,
    kind: "shifts",
    itemsCreated,
    summary: {
      shiftsOwedBefore: owed.shiftsOwed,
      shiftsOwedAfter: roundMoney(owed.shiftsOwed - amount),
      fullyPaidCount: itemsCreated.filter((i) => !i.isPartial).length,
      partialCount: itemsCreated.filter((i) => i.isPartial).length,
    },
  };
}

export interface PayBonusInput {
  bonusId?: unknown;
  amount?: unknown;
  method?: unknown;
  notes?: unknown;
  actorId?: unknown;
}

export interface PayBonusResult {
  paymentId: string;
  bonusId: string;
  amount: number;
  isPartial: boolean;
  newBonusStatus: "pending" | "paid";
  kind: "bonus";
}

/**
 * Pay one pending bonus, in full or in part; paid in full, it becomes `paid`. More than what is left
 * is refused. Dated now. (Payments.payBonus)
 */
export async function payBonus(db: Tx, input: PayBonusInput, deps: PaymentDeps): Promise<PayBonusResult> {
  if (!input.bonusId) throw new Error("bonusId required");
  if (typeof input.amount !== "number" || input.amount <= 0) throw new Error("amount must be a positive number");
  if (!input.actorId) throw new Error("actorId required");
  const actorId = String(input.actorId);
  const now = deps.now;

  // Whose bonus it is decides which person to lock; then the bonus row; then read it again.
  let bonus = typeof input.bonusId === "string" ? await bonuses.getById(db, input.bonusId) : null;
  if (bonus) {
    await lockRow(db, "staff", bonus.staffId);
    await lockRow(db, "bonuses", bonus.bonusId);
    bonus = await bonuses.getById(db, bonus.bonusId);
  }
  if (!bonus) throw new Error("Bonus not found: " + String(input.bonusId));
  if (bonus.status !== "pending") {
    throw new Error(
      "Bonus is not pending (status=" +
        bonus.status +
        "). " +
        (bonus.status === "proposed" ? "Approve it first." : bonus.status === "paid" ? "Already paid." : "Cannot pay a " + bonus.status + " bonus."),
    );
  }
  const person = await staff.getById(db, bonus.staffId);
  if (!person) throw new Error("Staff not found: " + bonus.staffId);

  const amount = roundMoney(input.amount);
  const alreadyPaid = (await getBonusPaidAmounts(db, [bonus.bonusId]))[bonus.bonusId] || 0;
  const remaining = roundMoney(bonus.amount - alreadyPaid);
  if (remaining <= 0.005) throw new Error("Bonus already fully paid");
  if (amount > remaining + 0.005) throw new Error("Overpayment rejected: trying to pay " + formatMoney(amount) + " but only " + formatMoney(remaining) + " remaining on this bonus.");
  const method = checkMethod(input.method);

  const paymentId = newId("P", { now });
  await insertPayment(db, { paymentId, staffId: bonus.staffId, now, amount, method, actorId, notes: String(input.notes || "Bonus: " + (bonus.reason || bonus.type)) });

  const isPartial = amount < remaining - 0.005;
  await insertItems(db, [{ itemId: itemId(now), paymentId, itemType: "bonus", refId: bonus.bonusId, amount, notes: isPartial ? "Partial — " + formatMoney(amount) + " of " + formatMoney(remaining) : "" }]);

  if (!isPartial) await bonuses.markPaid(db, bonus.bonusId, actorId, now);

  await audit.write(
    db,
    { actorId, action: "payment.bonus", targetType: "payments", targetId: paymentId, after: { staffId: bonus.staffId, bonusId: bonus.bonusId, amount, bonusType: bonus.type, fullyPaid: !isPartial } },
    { now },
  );
  const payload: NotifyPayload & Record<string, unknown> = { staffId: bonus.staffId, staffName: person.name, amount, kind: "bonus", bonusType: bonus.type };
  await notify({ ...deps, db }, "payment.recorded", payload);

  return { paymentId, bonusId: bonus.bonusId, amount, isPartial, newBonusStatus: isPartial ? "pending" : "paid", kind: "bonus" };
}

export interface UndoResult {
  success: true;
  removedPaymentId: string;
  removedItemCount: number;
}

/**
 * Undo one payment: void it (who, when, why), keep it and its items, and turn a bonus it had fully
 * paid back to `pending`. A voided or unknown id is "Payment not found". (Payments.undo)
 */
export async function undo(db: Tx, paymentId: unknown, actorId: unknown, deps: { now: Date }, reason?: unknown): Promise<UndoResult> {
  if (!paymentId) throw new Error("paymentId required");
  if (!actorId) throw new Error("actorId required");
  const actor = String(actorId);
  const now = deps.now;

  let payment = await getPaymentById(db, paymentId);
  if (payment) {
    await lockRow(db, "staff", payment.staffId);
    await lockRow(db, "payments", payment.paymentId);
    payment = await getPaymentById(db, payment.paymentId); // voided meanwhile: not found
  }
  if (!payment) throw new Error("Payment not found: " + String(paymentId));
  const id = payment.paymentId;
  const items = await getItemsForPayment(db, id);

  // A bonus this payment helped pay in full is no longer fully paid: back to pending. What was paid
  // is read with this payment's items still counted, as the old code read it before its delete.
  const bonusItems = items.filter((i) => i.itemType === "bonus");
  const paidMap = await getBonusPaidAmounts(db, bonusItems.map((i) => i.refId));
  for (const item of bonusItems) {
    const b = await bonuses.getById(db, item.refId); // one per bonus item; a payment has at most one
    if (!b || b.status !== "paid") continue;
    const totalPaid = paidMap[b.bonusId] || 0;
    const willRemain = roundMoney(totalPaid - item.amount);
    if (willRemain < b.amount - 0.005) await bonuses.revertToPending(db, b.bonusId, actor, now);
  }

  await db.query("update ops.payments set voided_at = $2, voided_by = $3, void_reason = $4 where payment_id = $1 and voided_at is null", [id, now, actor, cell(reason)]);

  await audit.write(db, { actorId: actor, action: "payment.undo", targetType: "payments", targetId: id, before: { staffId: payment.staffId, amount: payment.totalAmount, itemCount: items.length } }, { now });
  return { success: true, removedPaymentId: id, removedItemCount: items.length };
}

/** Undo the newest payment of one person. (Payments.undoLastForStaff) */
export async function undoLastForStaff(db: Tx, staffId: unknown, actorId: unknown, deps: { now: Date }, reason?: unknown): Promise<UndoResult> {
  if (typeof staffId === "string") await lockRow(db, "staff", staffId);
  const list = await getPaymentsForStaff(db, staffId);
  const newest = list[0];
  if (!newest) throw new Error("No payments to undo for " + String(staffId));
  return undo(db, newest.paymentId, actorId, deps, reason);
}
