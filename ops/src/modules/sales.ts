// Sales: one row per till session, written at the close. The port of src/Sales.gs except the
// dashboard (getDashboard_, buildInsights_ and their helpers: a later card).
//
// Records have the field names and shapes Sales.gs rowToRecord_ returns, with two differences:
// no _rowIndex (a Sheet row number), and `date` is "YYYY-MM-DD" (a Date in the old app).
//
// Blank is not zero on the card columns (ADR-0004, ADR-0005): credit_card_sales, debit_card_sales,
// misc_credit_sales, misc_debit_sales, card_total_sales and misc_card_sales read back as null when
// blank. Every other money column reads blank as 0 (`Number(x) || 0`), as before.
//
// write: the row's card shape is decided by what the caller SENT (a card total or misc card
// figure present → the single-total shape), never by config; the shape not reported is written
// blank (NULL). Every figure is rounded with roundMoney before it is written, at exactly the points
// the old code rounded, so the database never rounds (numeric(12,2) rounds half away from zero;
// roundMoney(1.005) is 1).
//
// Order: the Sheet listed rows in the order they were appended (the order of the closes). That
// is sales.seq here (migration 0005), and every list is in that order.
import type { Db } from "../db/client";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import { addDays, formatDate, parseDate } from "../lib/dates";
import { roundMoney } from "../lib/money";

export interface SalesRecord {
  salesId: string;
  sessionId: string;
  staffId: string;
  company: string;
  /** "YYYY-MM-DD", or null. (A Date in the old app.) */
  date: string | null;
  cashSales: number;
  creditCardSales: number | null;
  debitCardSales: number | null;
  cashbackPaid: number;
  hstCollected: number;
  bottleDeposit: number;
  roundOff: number;
  miscCashSales: number;
  miscCreditSales: number | null;
  miscDebitSales: number | null;
  miscNotes: string;
  cardTotalSales: number | null;
  miscCardSales: number | null;
  /** True when the row carries a credit/debit breakdown: from the row itself, never from config. */
  cardSplit: boolean;
}

interface SalesRow {
  sales_id: string;
  session_id: string;
  staff_id: string;
  company: string;
  date: string | null;
  cash_sales: number | null;
  credit_card_sales: number | null;
  debit_card_sales: number | null;
  cashback_paid: number | null;
  hst_collected: number | null;
  bottle_deposit: number | null;
  round_off: number | null;
  misc_cash_sales: number | null;
  misc_credit_sales: number | null;
  misc_debit_sales: number | null;
  misc_notes: string | null;
  card_total_sales: number | null;
  misc_card_sales: number | null;
}

const COLUMNS =
  "sales_id, session_id, staff_id, company, date, cash_sales, credit_card_sales, debit_card_sales, cashback_paid, hst_collected, bottle_deposit, round_off, misc_cash_sales, misc_credit_sales, misc_debit_sales, misc_notes, card_total_sales, misc_card_sales";
const ORDER = "order by seq";
const trimmed = (v: string | null): string => (v || "").toString().trim();
const num0 = (v: number | null): number => Number(v) || 0;
/** Sales.gs numOrNull_: a blank cell (NULL here) is null. */
const numOrNull = (v: number | null): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

function toRecord(r: SalesRow): SalesRecord {
  return {
    salesId: trimmed(r.sales_id),
    sessionId: trimmed(r.session_id),
    staffId: trimmed(r.staff_id),
    company: trimmed(r.company),
    date: r.date,
    cashSales: num0(r.cash_sales),
    creditCardSales: numOrNull(r.credit_card_sales),
    debitCardSales: numOrNull(r.debit_card_sales),
    cashbackPaid: num0(r.cashback_paid),
    hstCollected: num0(r.hst_collected),
    bottleDeposit: num0(r.bottle_deposit),
    roundOff: num0(r.round_off),
    miscCashSales: num0(r.misc_cash_sales),
    miscCreditSales: numOrNull(r.misc_credit_sales),
    miscDebitSales: numOrNull(r.misc_debit_sales),
    miscNotes: (r.misc_notes || "").toString(),
    cardTotalSales: numOrNull(r.card_total_sales),
    miscCardSales: numOrNull(r.misc_card_sales),
    cardSplit: numOrNull(r.credit_card_sales) !== null || numOrNull(r.debit_card_sales) !== null,
  };
}

// ── Settings ───────────────────────────────────────────────

/**
 * Does this till report credit and debit separately? True unless the trimmed, lower-cased setting is
 * "false"; a blank or missing setting is true for EVERY company (Sales.gs defaults it to true; the
 * settings registry says false for cstore, which this deliberately does not use). (Sales.cardSplitFor)
 */
export function cardSplitFor(config: Config, company: string): boolean {
  const key = `${company}_card_split`;
  if (key !== "cstore_card_split" && key !== "vape_card_split") return true; // a till with no setting: the default
  return String(config.value(key, "true")).trim().toLowerCase() !== "false";
}

// ── Reads ──────────────────────────────────────────────────

/** Every row. (Sales.getAll) */
export async function getAll(db: Db): Promise<SalesRecord[]> {
  const rows = await db.query<SalesRow>(`select ${COLUMNS} from ops.sales ${ORDER}`);
  return rows.map(toRecord).filter((r) => r.salesId);
}

/** The row of one till session, or null. (Sales.getForSession) */
export async function getForSession(db: Db, sessionId: string): Promise<SalesRecord | null> {
  if (typeof sessionId !== "string") return null;
  const rows = await db.query<SalesRow>(`select ${COLUMNS} from ops.sales where session_id = $1 ${ORDER} limit 1`, [sessionId]);
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * Rows from `start` to `end` inclusive (a row counts when its Toronto midnight is not before `start`
 * and not after `end`), optionally one person's and/or one till's. A blank bound gives []; an
 * unreadable one is no bound (the old comparisons with it were all false). (Sales.getForDateRange)
 */
export async function getForDateRange(db: Db, startDate: Date | string, endDate: Date | string, filters?: { staffId?: string | null; company?: string | null } | null): Promise<SalesRecord[]> {
  const start = startDate instanceof Date ? startDate : parseDate(startDate);
  const end = endDate instanceof Date ? endDate : parseDate(endDate);
  if (!start || !end) return [];
  const where: string[] = ["date is not null"];
  const params: unknown[] = [];
  if (!Number.isNaN(start.getTime())) {
    const first = formatDate(start);
    const midnight = parseDate(first) as Date;
    params.push(midnight.getTime() >= start.getTime() ? first : formatDate(addDays(midnight, 1)));
    where.push(`date >= $${params.length}`);
  }
  if (!Number.isNaN(end.getTime())) {
    params.push(formatDate(end));
    where.push(`date <= $${params.length}`);
  }
  if (filters && filters.staffId) {
    params.push(String(filters.staffId));
    where.push(`staff_id = $${params.length}`);
  }
  if (filters && filters.company) {
    params.push(String(filters.company));
    where.push(`company = $${params.length}`);
  }
  const rows = await db.query<SalesRow>(`select ${COLUMNS} from ops.sales where ${where.join(" and ")} ${ORDER}`, params);
  return rows.map(toRecord);
}

// ── Totals ─────────────────────────────────────────────────

type Totalled = Pick<SalesRecord, "cashSales" | "creditCardSales" | "debitCardSales" | "cardTotalSales" | "miscCashSales" | "miscCreditSales" | "miscDebitSales" | "miscCardSales">;

/** Cash + every card column of both shapes + the misc four, rounded (cashback excluded). (Sales.totalForRow) */
export function totalForRow(row: Totalled | null | undefined): number {
  if (!row) return 0;
  return roundMoney(
    (row.cashSales || 0) +
      (row.creditCardSales || 0) +
      (row.debitCardSales || 0) +
      (row.cardTotalSales || 0) +
      (row.miscCashSales || 0) +
      (row.miscCreditSales || 0) +
      (row.miscDebitSales || 0) +
      (row.miscCardSales || 0),
  );
}

export interface StaffCompanyTotal {
  staffId: string;
  company: string;
  total: number;
  cashTotal: number;
  cardTotal: number;
  cashbackTotal: number;
  sessionCount: number;
}

/** Sums by (person, till) over a date range, for the commission engine and the dashboard. (Sales.aggregateByStaffCompany) */
export async function aggregateByStaffCompany(db: Db, startDate: Date | string, endDate: Date | string): Promise<StaffCompanyTotal[]> {
  const rows = await getForDateRange(db, startDate, endDate, null);
  const map = new Map<string, StaffCompanyTotal>();
  for (const r of rows) {
    const key = r.staffId + "|" + r.company;
    let v = map.get(key);
    if (!v) {
      v = { staffId: r.staffId, company: r.company, total: 0, cashTotal: 0, cardTotal: 0, cashbackTotal: 0, sessionCount: 0 };
      map.set(key, v);
    }
    v.total += totalForRow(r);
    v.cashTotal += (r.cashSales || 0) + (r.miscCashSales || 0);
    v.cardTotal += (r.creditCardSales || 0) + (r.debitCardSales || 0) + (r.cardTotalSales || 0) + (r.miscCreditSales || 0) + (r.miscDebitSales || 0) + (r.miscCardSales || 0);
    v.cashbackTotal += r.cashbackPaid || 0;
    v.sessionCount += 1;
  }
  return [...map.values()].map((v) => ({
    ...v,
    total: roundMoney(v.total),
    cashTotal: roundMoney(v.cashTotal),
    cardTotal: roundMoney(v.cardTotal),
    cashbackTotal: roundMoney(v.cashbackTotal),
  }));
}

// ── Write ──────────────────────────────────────────────────

export interface SalesInput {
  sessionId?: unknown;
  staffId?: unknown;
  company?: unknown;
  /** A Date or "YYYY-MM-DD". */
  date?: unknown;
  cashSales?: number | null;
  creditCardSales?: number | null;
  debitCardSales?: number | null;
  cashbackPaid?: number | null;
  hstCollected?: number | null;
  bottleDeposit?: number | null;
  roundOff?: number | null;
  miscCashSales?: number | null;
  miscCreditSales?: number | null;
  miscDebitSales?: number | null;
  miscNotes?: unknown;
  /** Present (even 0) only on a till that reports one card figure. */
  cardTotalSales?: number | null;
  miscCardSales?: number | null;
}

/** A money figure to store: rounded here (never by the database), and refused if it is not a finite number (the schema cannot hold one). */
function stored(name: string, v: number): number {
  const r = roundMoney(v);
  if (!Number.isFinite(r)) throw new Error(name + " is not a number");
  return r;
}

/**
 * Write the sales row of a till session (sales_id = session_id). A second write for the same session
 * updates the row in place ("sales.update", with a before) instead of adding one ("sales.create").
 * Returns the row as stored. (Sales.write)
 */
export async function write(db: Db, input: SalesInput, actorId: string | null | undefined, now: Date): Promise<SalesRecord | null> {
  if (!input.sessionId) throw new Error("sessionId required");
  if (!input.staffId) throw new Error("staffId required");
  if (!input.company) throw new Error("company required");
  if (!input.date) throw new Error("date required");

  const day = input.date instanceof Date ? input.date : parseDate(input.date);
  if (!day || Number.isNaN(day.getTime())) throw new Error("date is not a readable date");
  const dateText = formatDate(day);

  // Which card shape did the caller send? Presence, not config.
  const split = input.cardTotalSales == null && input.miscCardSales == null;
  const m = (name: string, v: number | null | undefined) => stored(name, v || 0);

  // The old row exactly, '' for a blank cell: the audit row carries these values as they were.
  const values = {
    cash: m("cashSales", input.cashSales),
    credit: split ? m("creditCardSales", input.creditCardSales) : ("" as const),
    debit: split ? m("debitCardSales", input.debitCardSales) : ("" as const),
    cashback: m("cashbackPaid", input.cashbackPaid),
    hst: m("hstCollected", input.hstCollected),
    bottle: m("bottleDeposit", input.bottleDeposit),
    round: m("roundOff", input.roundOff),
    miscCash: m("miscCashSales", input.miscCashSales),
    miscCredit: split ? m("miscCreditSales", input.miscCreditSales) : ("" as const),
    miscDebit: split ? m("miscDebitSales", input.miscDebitSales) : ("" as const),
    miscNotes: input.miscNotes || "",
    cardTotal: split ? ("" as const) : m("cardTotalSales", input.cardTotalSales),
    miscCard: split ? ("" as const) : m("miscCardSales", input.miscCardSales),
  };
  const cell = <T>(v: T | ""): T | null => (v === "" ? null : v);
  const sessionId = String(input.sessionId);
  const params = [
    sessionId,
    String(input.staffId),
    String(input.company),
    dateText,
    values.cash,
    cell(values.credit),
    cell(values.debit),
    values.cashback,
    values.hst,
    values.bottle,
    values.round,
    values.miscCash,
    cell(values.miscCredit),
    cell(values.miscDebit),
    values.miscNotes === "" ? null : String(values.miscNotes),
    cell(values.cardTotal),
    cell(values.miscCard),
  ];

  const existing = await getForSession(db, sessionId);
  let action: string;
  let before: unknown;
  if (existing) {
    action = "sales.update";
    before = { cashSales: existing.cashSales, creditCardSales: existing.creditCardSales, debitCardSales: existing.debitCardSales };
    await db.query(
      `update ops.sales set sales_id = $1, staff_id = $2, company = $3, date = $4, cash_sales = $5, credit_card_sales = $6, debit_card_sales = $7,
         cashback_paid = $8, hst_collected = $9, bottle_deposit = $10, round_off = $11, misc_cash_sales = $12, misc_credit_sales = $13,
         misc_debit_sales = $14, misc_notes = $15, card_total_sales = $16, misc_card_sales = $17
       where sales_id = $18`,
      [...params, existing.salesId],
    );
  } else {
    action = "sales.create";
    before = null;
    await db.query(`insert into ops.sales (${COLUMNS}) values ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`, params);
  }

  await audit.write(
    db,
    {
      actorId: actorId || "SYSTEM",
      action,
      targetType: "sales",
      targetId: sessionId,
      before,
      after: { cashSales: values.cash, creditCardSales: values.credit, debitCardSales: values.debit, cashbackPaid: values.cashback },
    },
    { now },
  );
  return getForSession(db, sessionId);
}
