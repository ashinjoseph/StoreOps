// Till corrections: an admin sets a closed till's figures to what was really counted and sold (card
// P4-12a). NEW in the Operations app (ADR-0023): in the Apps Script app an admin edited the
// till_sessions and sales tabs by hand, often without recomputing what depends on them, so there is
// nothing to port and nothing for the parity harness to compare; the unit tests in
// ops/test/till-corrections.test.ts are the specification.
//
// A correction sets the session and its sales row to exactly what a close with the corrected
// figures would have stored: the derived figures come from till-sessions.ts closeFigures, the very
// function `close` calls, so the two cannot drift. The page sends every entered figure, prefilled.
// What a close works out from settings or history is taken from the session itself:
//   - the float left in the drawer is the session's cash_left_in_till (what that close left), the
//     configured float only when the row has none;
//   - the pot's previous count is the count of the cstore close before this one (not the latest
//     count, which may be this session's own or a later one);
//   - the variance thresholds and the pot's expected balance are today's settings (nothing records
//     the ones in force that day).
//
// Blank is not zero (ADR-0004): an entered figure sent blank is stored NULL, never 0. The arithmetic
// treats it as 0 where it is summed (expected cash), as ADR-0004 allows; a blank reserve count is
// "not counted": NULL, with nothing fed from the pot.
//
// Locks, in this order, inside the router's one transaction: the session row, its sales row, then
// the cashier's staff row. CashHandling.record locks the cashier's staff row before it reads what
// they hold, so a correction and a handover of the same person are serialised: either the handover
// reads the corrected cash, or the correction sees the handover and is refused by rule 7. Two
// corrections of one session wait on the session row: the second sees the first's result.
//
// Never touched: attendance, payments, payment items, bonuses, cash handovers and their items,
// commission runs, reconcile results; no message is sent. Nothing is deleted: the sales row is
// updated in place (it keeps its id and seq), or created when the session never had one. The answer
// says what has gone stale (the day's reconcile, the commission runs over the day, the next cstore
// close when the pot's count changed) so the page can tell the admin.
import type { Db } from "../db/client";
import { lockRow, type Tx } from "../db/tx";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import { formatDate, TZ } from "../lib/dates";
import { roundMoney } from "../lib/money";
import { capNotes, REASON_MAX, REASON_MIN } from "./attendance-corrections";
import * as sales from "./sales";
import * as tillSessions from "./till-sessions";

/** How far back a till can be corrected. */
export const MAX_DAYS_BACK = 370;
/** numeric(12,2) holds less than 10^10. */
const MONEY_LIMIT = 1e10;
const HALF_CENT = 0.005;

export type CardShape = "split" | "single";

export interface TillCorrectionInput {
  sessionId?: unknown;
  openingFloat?: unknown;
  closingCashCounted?: unknown;
  cashSales?: unknown;
  creditCardSales?: unknown;
  debitCardSales?: unknown;
  cardTotalSales?: unknown;
  miscCashSales?: unknown;
  miscCreditSales?: unknown;
  miscDebitSales?: unknown;
  miscCardSales?: unknown;
  miscNotes?: unknown;
  lottoReserveCounted?: unknown;
  lottoTopupFromTill?: unknown;
  lottoReserveNote?: unknown;
  notes?: unknown;
  reason?: unknown;
}

/** The session as the sheet shows it: blanks are null, instants ISO strings. */
export interface SessionView {
  sessionId: string;
  company: string;
  staffId: string;
  staffName: string;
  date: string;
  startTime: string | null;
  endTime: string | null;
  status: string;
  openingFloat: number | null;
  closingCashCounted: number | null;
  expectedCash: number | null;
  closingVariance: number | null;
  varianceStatus: string | null;
  cashRemovedAtClose: number | null;
  cashLeftInTill: number | null;
  /** cstore only (the lotto till). */
  lottoReserveCounted?: number | null;
  lottoTopupFromTill?: number | null;
  lottoReserveNote?: string | null;
  notes: string | null;
}

export interface SalesView {
  salesId: string;
  cashSales: number | null;
  creditCardSales: number | null;
  debitCardSales: number | null;
  cardTotalSales: number | null;
  cashbackPaid: number | null;
  hstCollected: number | null;
  bottleDeposit: number | null;
  roundOff: number | null;
  miscCashSales: number | null;
  miscCreditSales: number | null;
  miscDebitSales: number | null;
  miscCardSales: number | null;
  miscNotes: string | null;
  total: number;
}

export interface RunTouched {
  runId: string;
  weekEnd: string | null;
  /** From the run's bonuses: "paid" (any paid), "approved" (any approved, none paid), "proposed", or "nothing proposed". */
  status: string;
}

export interface TillCorrectionView {
  session: SessionView;
  sales: SalesView | null;
  cardShape: CardShape;
  /** The shape this till reports on that business date (the shape a changed row must take). */
  dateShape: CardShape;
  handedOver: number;
  reconciled: boolean;
  commissionRunsTouched: RunTouched[];
  /** cstore: the pot's expected balance and the count at the close before this one. */
  lotto: { expected: number; previousCount: number | null } | null;
  canCorrect: boolean;
  blockedBy: string | null;
}

export interface Change {
  field: string;
  before: number | string | null;
  after: number | string | null;
}

export interface TillCorrectionResult {
  session: SessionView;
  sales: SalesView | null;
  changed: Change[];
  varianceBefore: number | null;
  varianceAfter: number | null;
  cashRemovedBefore: number | null;
  cashRemovedAfter: number | null;
  totalBefore: number | null;
  totalAfter: number | null;
  staleReconcile: boolean;
  commissionRunsTouched: RunTouched[];
  /** The next cstore close, whose expected cash was worked out from this session's old reserve count; null unless that count changed. */
  nextLottoSession: { sessionId: string; date: string } | null;
}

export interface SessionRow {
  session_id: string;
  attendance_id: string;
  staff_id: string;
  company: string;
  date: string;
  status: string;
  start_time: Date | null;
  end_time: Date | null;
  expected_opening: number | null;
  opening_float: number | null;
  opening_note: string | null;
  closing_cash_counted: number | null;
  cash_left_in_till: number | null;
  cash_removed_at_close: number | null;
  expected_cash: number | null;
  closing_variance: number | null;
  variance_status: string | null;
  notes: string | null;
  lotto_reserve_counted: number | null;
  lotto_topup_from_till: number | null;
  lotto_reserve_note: string | null;
  store_id: string;
}

export interface SalesRow {
  sales_id: string;
  session_id: string;
  staff_id: string;
  company: string;
  date: string;
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
  store_id: string;
  seq: number;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const textOrNull = (v: string | null): string | null => (v === null || v === "" ? null : v);
const isClosed = (status: string | null): boolean => {
  const st = (status || "").trim().toLowerCase();
  return st === "closed" || st === "validated";
};

// ── Reads ──────────────────────────────────────────────────

async function readSession(db: Db, id: string): Promise<SessionRow | null> {
  return db.maybeOne<SessionRow>("select * from ops.till_sessions where session_id = $1", [id]);
}

async function readSales(db: Db, id: string, forUpdate: boolean): Promise<SalesRow | null> {
  return db.maybeOne<SalesRow>(`select * from ops.sales where session_id = $1${forUpdate ? " for update" : ""}`, [id]);
}

async function staffName(db: Db, staffId: string): Promise<string> {
  const row = await db.maybeOne<{ name: string | null }>("select name from ops.staff where staff_id = $1", [staffId]);
  return row && row.name ? row.name : staffId;
}

/** Cash from this session already handed over: its items in handovers that are not voided. */
async function handedOverFrom(db: Db, sessionId: string): Promise<number> {
  const row = await db.one<{ total: number }>(
    `select coalesce(sum(i.amount), 0) as total
       from ops.cash_handover_items i
       join ops.cash_handovers h on h.handover_id = i.handover_id
      where i.session_id = $1 and lower(btrim(h.status)) <> 'voided'`,
    [sessionId],
  );
  return roundMoney(row.total);
}

/** A reconcile result for that day covers this till: it names the session, or (with no list of sessions) the till. */
async function isReconciled(db: Db, s: SessionRow): Promise<boolean> {
  const rows = await db.query<{ session_ids: string | null; companies: string | null }>("select session_ids, companies from ops.validation_results where business_date = $1", [s.date]);
  return rows.some((r) => {
    const ids = (r.session_ids || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (ids.length) return ids.includes(s.session_id);
    return (r.companies || "").split("+").map((x) => x.trim()).includes(s.company);
  });
}

/** The commission runs whose week contains the day, in the order they were made, each with what became of its proposals. */
export async function runsCovering(db: Db, day: string): Promise<RunTouched[]> {
  const rows = await db.query<{ run_id: string; week_end: string | null; statuses: string[] | null }>(
    `select r.run_id, r.week_end,
            (select array_agg(distinct b.status) from ops.bonuses b where b.source_run_id = r.run_id) as statuses
       from ops.commission_runs r
      where r.week_start <= $1 and r.week_end >= $1
      order by r.seq`,
    [day],
  );
  return rows.map((r) => {
    const st = r.statuses || [];
    const status = st.includes("paid") ? "paid" : st.includes("pending") ? "approved" : st.includes("proposed") ? "proposed" : "nothing proposed";
    return { runId: r.run_id, weekEnd: r.week_end, status };
  });
}

const CLOSE_KEY = `coalesce(s.end_time, s.date::timestamp at time zone $2)`;

/**
 * The pot's count at the cstore close before this one, in the order lastReserveCount reads closes
 * (when it ended, then when it started, then id): the count this session's close was measured against.
 */
async function previousReserveCount(db: Db, sessionId: string): Promise<number | null> {
  const row = await db.maybeOne<{ counted: number }>(
    `with me as (select coalesce(end_time, date::timestamp at time zone $2) as k, coalesce(start_time, '-infinity'::timestamptz) as st
                   from ops.till_sessions where session_id = $1)
     select s.lotto_reserve_counted as counted from ops.till_sessions s, me
      where s.company = $3 and lower(s.status) in ('closed', 'validated') and s.lotto_reserve_counted is not null and s.session_id <> $1
        and (${CLOSE_KEY}, coalesce(s.start_time, '-infinity'::timestamptz), s.session_id collate "C") < (me.k, me.st, $1 collate "C")
      order by ${CLOSE_KEY} desc, coalesce(s.start_time, '-infinity'::timestamptz) desc, s.session_id collate "C" desc
      limit 1`,
    [sessionId, TZ, tillSessions.LOTTO_COMPANY],
  );
  return row ? roundMoney(row.counted) : null;
}

/** The next counted cstore close after this one: its expected cash was measured against this session's count. */
async function nextReserveSession(db: Db, sessionId: string): Promise<{ sessionId: string; date: string } | null> {
  const row = await db.maybeOne<{ session_id: string; date: string }>(
    `with me as (select coalesce(end_time, date::timestamp at time zone $2) as k, coalesce(start_time, '-infinity'::timestamptz) as st
                   from ops.till_sessions where session_id = $1)
     select s.session_id, s.date from ops.till_sessions s, me
      where s.company = $3 and lower(s.status) in ('closed', 'validated') and s.lotto_reserve_counted is not null and s.session_id <> $1
        and (${CLOSE_KEY}, coalesce(s.start_time, '-infinity'::timestamptz), s.session_id collate "C") > (me.k, me.st, $1 collate "C")
      order by ${CLOSE_KEY}, coalesce(s.start_time, '-infinity'::timestamptz), s.session_id collate "C"
      limit 1`,
    [sessionId, TZ, tillSessions.LOTTO_COMPANY],
  );
  return row ? { sessionId: row.session_id, date: row.date } : null;
}

// ── Shapes, dates, views ───────────────────────────────────

/** The row's card shape from its own columns; null when it carries no card figure at all. */
function rowShape(r: SalesRow | null): CardShape | null {
  if (!r) return null;
  if (r.credit_card_sales !== null || r.debit_card_sales !== null || r.misc_credit_sales !== null || r.misc_debit_sales !== null) return "split";
  if (r.card_total_sales !== null || r.misc_card_sales !== null) return "single";
  return null;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The shape a till reports on a business date. cstore with cstore_epos_from set to a real day: a
 * credit/debit split before that day, one card figure from it on. Otherwise the till's
 * <company>_card_split setting as Sales.cardSplitFor reads it.
 */
export function shapeForDate(config: Config, company: string, day: string): CardShape {
  if (company === "cstore") {
    const from = String(config.value("cstore_epos_from", "") || "").trim();
    if (DAY.test(from)) return day < from ? "split" : "single";
  }
  return sales.cardSplitFor(config, company) ? "split" : "single";
}

function daysBetween(a: string, b: string): number {
  const ms = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

const OPEN_REFUSAL = "This till is still open: close it instead.";
const AGE_REFUSAL = `Cannot correct a till from more than ${MAX_DAYS_BACK} days ago.`;
const handedRefusal = (amount: number): string => "Cannot correct: $" + amount.toFixed(2) + " from this till has already been handed over. Void the handover first.";

function blockedReason(s: SessionRow, now: Date): string | null {
  if (!isClosed(s.status)) return OPEN_REFUSAL;
  if (daysBetween(s.date, formatDate(now)) > MAX_DAYS_BACK) return AGE_REFUSAL;
  return null;
}

export function sessionView(s: SessionRow, name: string): SessionView {
  const v: SessionView = {
    sessionId: s.session_id,
    company: s.company,
    staffId: s.staff_id,
    staffName: name,
    date: s.date,
    startTime: iso(s.start_time),
    endTime: iso(s.end_time),
    status: (s.status || "").trim(),
    openingFloat: s.opening_float,
    closingCashCounted: s.closing_cash_counted,
    expectedCash: s.expected_cash,
    closingVariance: s.closing_variance,
    varianceStatus: textOrNull(s.variance_status),
    cashRemovedAtClose: s.cash_removed_at_close,
    cashLeftInTill: s.cash_left_in_till,
    notes: textOrNull(s.notes),
  };
  if (s.company === tillSessions.LOTTO_COMPANY) {
    v.lottoReserveCounted = s.lotto_reserve_counted;
    v.lottoTopupFromTill = s.lotto_topup_from_till;
    v.lottoReserveNote = textOrNull(s.lotto_reserve_note);
  }
  return v;
}

function salesTotal(r: SalesRow): number {
  return sales.totalForRow({
    cashSales: r.cash_sales ?? 0,
    creditCardSales: r.credit_card_sales,
    debitCardSales: r.debit_card_sales,
    cardTotalSales: r.card_total_sales,
    miscCashSales: r.misc_cash_sales ?? 0,
    miscCreditSales: r.misc_credit_sales,
    miscDebitSales: r.misc_debit_sales,
    miscCardSales: r.misc_card_sales,
  });
}

export function salesView(r: SalesRow | null): SalesView | null {
  if (!r) return null;
  return {
    salesId: r.sales_id,
    cashSales: r.cash_sales,
    creditCardSales: r.credit_card_sales,
    debitCardSales: r.debit_card_sales,
    cardTotalSales: r.card_total_sales,
    cashbackPaid: r.cashback_paid,
    hstCollected: r.hst_collected,
    bottleDeposit: r.bottle_deposit,
    roundOff: r.round_off,
    miscCashSales: r.misc_cash_sales,
    miscCreditSales: r.misc_credit_sales,
    miscDebitSales: r.misc_debit_sales,
    miscCardSales: r.misc_card_sales,
    miscNotes: textOrNull(r.misc_notes),
    total: salesTotal(r),
  };
}

/** The whole row as the audit row holds it: every column, instants as ISO strings. */
function whole<T extends object>(r: T | null): Record<string, unknown> | null {
  if (!r) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out;
}

// ── Checks ─────────────────────────────────────────────────

const isBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

export function checkReason(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < REASON_MIN || text.length > REASON_MAX) throw new Error(`A reason is required: ${REASON_MIN} to ${REASON_MAX} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) throw new Error("The reason cannot contain control characters (such as a line break).");
  return text;
}

/** An entered money figure: blank is null; otherwise a finite number the table can hold, rounded to cents. */
export function money(value: unknown, label: string): number | null {
  if (isBlank(value)) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a number, or blank.`);
  if (Math.abs(value) >= MONEY_LIMIT) throw new Error(`${label} is too large.`);
  return roundMoney(value);
}

/** Entered text: blank is null; no NUL (the database cannot hold one). */
export function text(value: unknown, label: string): string | null {
  if (isBlank(value)) return null;
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  if (value.includes("\u0000")) throw new Error(`${label} cannot contain a null character.`);
  return value.trim();
}

const has = (input: TillCorrectionInput, key: keyof TillCorrectionInput): boolean => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;

export const SHAPE_WORDS: Record<CardShape, string> = { split: "credit and debit", single: "one card total" };

// ── The two calls ──────────────────────────────────────────

/** What the correction sheet shows before anything is changed. (rpcGetTillCorrection) */
export async function getCorrection(db: Db, sessionId: unknown, config: Config, now: Date): Promise<TillCorrectionView> {
  const s = typeof sessionId === "string" && sessionId !== "" ? await readSession(db, sessionId) : null;
  if (!s) throw new Error("Session not found: " + String(sessionId));
  const row = await readSales(db, s.session_id, false);
  const dateShape = shapeForDate(config, s.company, s.date);
  const lottoOn = s.company === tillSessions.LOTTO_COMPANY;
  const blockedBy = blockedReason(s, now);
  return {
    session: sessionView(s, await staffName(db, s.staff_id)),
    sales: salesView(row),
    cardShape: rowShape(row) || dateShape,
    dateShape,
    handedOver: await handedOverFrom(db, s.session_id),
    reconciled: await isReconciled(db, s),
    commissionRunsTouched: await runsCovering(db, s.date),
    lotto: lottoOn ? { expected: tillSessions.getLottoExpected(config), previousCount: await previousReserveCount(db, s.session_id) } : null,
    canCorrect: blockedBy === null,
    blockedBy,
  };
}

/** Set a closed till's figures to what was really counted and sold, and everything the close derives from them. (rpcCorrectTillSession) */
export async function correct(db: Tx, input: TillCorrectionInput, actorId: string, config: Config, now: Date): Promise<TillCorrectionResult> {
  if (!actorId) throw new Error("actorId required");

  // 1. The session, locked first, then its sales row, then the cashier (whom handovers lock).
  const id = input.sessionId;
  const exists = typeof id === "string" && id !== "" && (await lockRow(db, "till_sessions", id));
  const before = exists ? await readSession(db, id as string) : null;
  if (!before) throw new Error("Session not found: " + String(id));
  if (!isClosed(before.status)) throw new Error(OPEN_REFUSAL);
  const salesBefore = await readSales(db, before.session_id, true);
  await lockRow(db, "staff", before.staff_id);

  // 2. Why.
  const reason = checkReason(input.reason);

  // 3. Not too long ago.
  if (daysBetween(before.date, formatDate(now)) > MAX_DAYS_BACK) throw new Error(AGE_REFUSAL);

  // 4. The figures, each blank or a number, rounded to cents (the close's own checks follow in 6).
  const lottoOn = before.company === tillSessions.LOTTO_COMPANY;
  const openingFloat = money(input.openingFloat, "The opening float");
  if (openingFloat === null || openingFloat < 0) throw new Error("The opening float must be a number, 0 or more.");
  const count = money(input.closingCashCounted, "The cash counted");
  const cash = money(input.cashSales, "Cash sales");
  const credit = money(input.creditCardSales, "Credit card sales");
  const debit = money(input.debitCardSales, "Debit card sales");
  const cardTotal = money(input.cardTotalSales, "Card sales");
  const miscCash = money(input.miscCashSales, "Misc cash");
  const miscCredit = money(input.miscCreditSales, "Misc credit");
  const miscDebit = money(input.miscDebitSales, "Misc debit");
  const miscCard = money(input.miscCardSales, "Misc card");
  const miscNotes = text(input.miscNotes, "Misc notes");
  const notesIn = text(input.notes, "Notes");
  const lottoCounted = money(input.lottoReserveCounted, "Reserve counted");
  const lottoTopupIn = money(input.lottoTopupFromTill, "Moving from till into reserve");
  const lottoNoteIn = text(input.lottoReserveNote, "The reserve reason");
  if (!lottoOn && (lottoCounted !== null || lottoTopupIn !== null || lottoNoteIn !== null)) throw new Error("A " + before.company + " till has no lotto reserve.");

  // 5. One card shape (ADR-0005): what was sent; a row changes shape only to its till's shape that day.
  const sentSplit = has(input, "creditCardSales") || has(input, "debitCardSales") || has(input, "miscCreditSales") || has(input, "miscDebitSales");
  const sentSingle = has(input, "cardTotalSales") || has(input, "miscCardSales");
  if (sentSplit === sentSingle) throw new Error("Send one card shape.");
  const shape: CardShape = sentSplit ? "split" : "single";
  const current = rowShape(salesBefore);
  const dateShape = shapeForDate(config, before.company, before.date);
  if (shape !== current && shape !== dateShape) {
    throw new Error("On " + before.date + " the " + before.company + " till reports " + SHAPE_WORDS[dateShape] + ": send " + SHAPE_WORDS[dateShape] + ".");
  }
  const split = shape === "split";

  // 6. Everything the close derives, by the close's own arithmetic (and its refusals).
  const floatLeft = before.cash_left_in_till !== null ? Number(before.cash_left_in_till) : tillSessions.getExpectedFloat(config, before.company);
  const prevReserve = lottoOn ? await previousReserveCount(db, before.session_id) : null;
  const cashback = salesBefore ? salesBefore.cashback_paid : null;
  const f = tillSessions.closeFigures(config, {
    company: before.company,
    openingFloat,
    floatAmount: floatLeft,
    lottoExpected: tillSessions.getLottoExpected(config),
    prevReserveCounted: prevReserve,
    physicalCount: count === null ? undefined : count,
    cashSales: cash,
    cashback,
    miscCash,
    ...(split ? { creditCard: credit ?? 0, debitCard: debit ?? 0, miscCredit: miscCredit ?? 0, miscDebit: miscDebit ?? 0 } : { cardTotal: cardTotal ?? 0, miscCard: miscCard ?? 0 }),
    miscNotes,
    lottoCounted: lottoOn ? lottoCounted : 0,
    lottoTopupFromTill: lottoTopupIn,
    lottoNote: lottoNoteIn,
  });

  // What is stored: the close's figures, with a blank entered figure NULL (never 0).
  const keep = (entered: number | null, derived: unknown): number | null => (entered === null ? null : roundMoney(derived));
  const after: SessionRow = {
    ...before,
    opening_float: openingFloat,
    closing_cash_counted: f.countStored,
    cash_left_in_till: f.floatStored,
    cash_removed_at_close: f.cashRemoved,
    expected_cash: roundMoney(f.expectedCash),
    closing_variance: f.variance,
    variance_status: f.varianceStatus,
    notes: capNotes(notesIn, reason),
    ...(lottoOn
      ? { lotto_reserve_counted: lottoCounted === null ? null : roundMoney(f.lottoCounted), lotto_topup_from_till: keep(lottoTopupIn, f.lottoTopup), lotto_reserve_note: f.lottoNote === "" ? null : f.lottoNote }
      : {}),
  };
  const s = f.sales;
  const salesAfter: SalesRow = {
    ...(salesBefore || {
      sales_id: before.session_id,
      session_id: before.session_id,
      staff_id: before.staff_id,
      company: before.company,
      date: before.date,
      // A close writes 0 in the figures its sheet no longer asks for.
      cashback_paid: 0,
      hst_collected: 0,
      bottle_deposit: 0,
      round_off: 0,
      store_id: before.store_id,
      seq: 0,
    }),
    cash_sales: keep(cash, s.cashSales),
    credit_card_sales: split ? keep(credit, s.creditCardSales) : null,
    debit_card_sales: split ? keep(debit, s.debitCardSales) : null,
    misc_cash_sales: keep(miscCash, s.miscCashSales),
    misc_credit_sales: split ? keep(miscCredit, s.miscCreditSales) : null,
    misc_debit_sales: split ? keep(miscDebit, s.miscDebitSales) : null,
    misc_notes: miscNotes,
    card_total_sales: split ? null : keep(cardTotal, s.cardTotalSales),
    misc_card_sales: split ? null : keep(miscCard, s.miscCardSales),
  } as SalesRow;

  // What differs, entered and derived (the reason appended to the notes is not a change by itself).
  const changed: Change[] = [];
  const diff = (field: string, a: number | string | null, b: number | string | null) => {
    if (a !== b) changed.push({ field, before: a, after: b });
  };
  diff("openingFloat", before.opening_float, after.opening_float);
  diff("closingCashCounted", before.closing_cash_counted, after.closing_cash_counted);
  const sb = salesBefore;
  diff("cashSales", sb ? sb.cash_sales : null, salesAfter.cash_sales);
  diff("creditCardSales", sb ? sb.credit_card_sales : null, salesAfter.credit_card_sales);
  diff("debitCardSales", sb ? sb.debit_card_sales : null, salesAfter.debit_card_sales);
  diff("cardTotalSales", sb ? sb.card_total_sales : null, salesAfter.card_total_sales);
  diff("miscCashSales", sb ? sb.misc_cash_sales : null, salesAfter.misc_cash_sales);
  diff("miscCreditSales", sb ? sb.misc_credit_sales : null, salesAfter.misc_credit_sales);
  diff("miscDebitSales", sb ? sb.misc_debit_sales : null, salesAfter.misc_debit_sales);
  diff("miscCardSales", sb ? sb.misc_card_sales : null, salesAfter.misc_card_sales);
  diff("miscNotes", sb ? textOrNull(sb.misc_notes) : null, salesAfter.misc_notes);
  if (lottoOn) {
    diff("lottoReserveCounted", before.lotto_reserve_counted, after.lotto_reserve_counted);
    diff("lottoTopupFromTill", before.lotto_topup_from_till, after.lotto_topup_from_till);
    diff("lottoReserveNote", textOrNull(before.lotto_reserve_note), after.lotto_reserve_note);
  }
  diff("notes", textOrNull(before.notes), notesIn);
  diff("expectedCash", before.expected_cash, after.expected_cash);
  diff("closingVariance", before.closing_variance, after.closing_variance);
  diff("varianceStatus", textOrNull(before.variance_status), after.variance_status);
  diff("cashRemovedAtClose", before.cash_removed_at_close, after.cash_removed_at_close);
  diff("cashLeftInTill", before.cash_left_in_till, after.cash_left_in_till);
  const totalBefore = sb ? salesTotal(sb) : null;
  const totalAfter = salesTotal(salesAfter);
  diff("total", totalBefore, totalAfter);

  // 7. Cash already handed over from this session may not exceed what the corrected close took out.
  const handed = await handedOverFrom(db, before.session_id);
  if (handed > HALF_CENT && (after.cash_removed_at_close as number) < handed - HALF_CENT) throw new Error(handedRefusal(handed));

  const name = await staffName(db, before.staff_id);
  const reconciled = await isReconciled(db, before);
  const salesChanged = changed.some((c) => ["cashSales", "creditCardSales", "debitCardSales", "cardTotalSales", "miscCashSales", "miscCreditSales", "miscDebitSales", "miscCardSales", "total"].includes(c.field));
  const summary = {
    varianceBefore: before.closing_variance,
    cashRemovedBefore: before.cash_removed_at_close,
    totalBefore,
  };

  // 12. Nothing differs: nothing is written.
  if (changed.length === 0) {
    return {
      session: sessionView(before, name),
      sales: salesView(salesBefore),
      changed,
      ...summary,
      varianceAfter: before.closing_variance,
      cashRemovedAfter: before.cash_removed_at_close,
      totalAfter: totalBefore,
      staleReconcile: false,
      commissionRunsTouched: [],
      nextLottoSession: null,
    };
  }

  // 8, 10 and 11. Write the session and the sales row in place (or the row a close would have written).
  await db.query(
    `update ops.till_sessions set opening_float = $2, closing_cash_counted = $3, cash_left_in_till = $4, cash_removed_at_close = $5,
       expected_cash = $6, closing_variance = $7, variance_status = $8, notes = $9, lotto_reserve_counted = $10, lotto_topup_from_till = $11,
       lotto_reserve_note = $12
     where session_id = $1`,
    [
      before.session_id,
      after.opening_float,
      after.closing_cash_counted,
      after.cash_left_in_till,
      after.cash_removed_at_close,
      after.expected_cash,
      after.closing_variance,
      after.variance_status,
      after.notes,
      after.lotto_reserve_counted,
      after.lotto_topup_from_till,
      after.lotto_reserve_note,
    ],
  );
  const figures = [
    salesAfter.cash_sales,
    salesAfter.credit_card_sales,
    salesAfter.debit_card_sales,
    salesAfter.misc_cash_sales,
    salesAfter.misc_credit_sales,
    salesAfter.misc_debit_sales,
    salesAfter.misc_notes,
    salesAfter.card_total_sales,
    salesAfter.misc_card_sales,
  ];
  if (salesBefore) {
    await db.query(
      `update ops.sales set cash_sales = $2, credit_card_sales = $3, debit_card_sales = $4, misc_cash_sales = $5, misc_credit_sales = $6,
         misc_debit_sales = $7, misc_notes = $8, card_total_sales = $9, misc_card_sales = $10
       where sales_id = $1`,
      [salesBefore.sales_id, ...figures],
    );
  } else {
    await db.query(
      `insert into ops.sales (sales_id, session_id, staff_id, company, date, cash_sales, credit_card_sales, debit_card_sales, misc_cash_sales,
         misc_credit_sales, misc_debit_sales, misc_notes, card_total_sales, misc_card_sales, cashback_paid, hst_collected, bottle_deposit, round_off)
       values ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, 0, 0, 0)`,
      [before.session_id, before.staff_id, before.company, before.date, ...figures],
    );
  }
  const sessionNow = (await readSession(db, before.session_id)) as SessionRow;
  const salesNow = (await readSales(db, before.session_id, false)) as SalesRow;

  // 9. One audit row: the whole session and sales row before and after, the reason in details.
  await audit.write(
    db,
    {
      actorId,
      action: "till.correct",
      targetType: "till_sessions",
      targetId: before.session_id,
      before: { session: whole(before), sales: whole(salesBefore) },
      after: { session: whole(sessionNow), sales: whole(salesNow) },
      details: reason,
    },
    { now },
  );

  const lottoChanged = changed.some((c) => c.field === "lottoReserveCounted");
  return {
    session: sessionView(sessionNow, name),
    sales: salesView(salesNow),
    changed,
    ...summary,
    varianceAfter: sessionNow.closing_variance,
    cashRemovedAfter: sessionNow.cash_removed_at_close,
    totalAfter: salesTotal(salesNow),
    staleReconcile: reconciled,
    commissionRunsTouched: salesChanged ? await runsCovering(db, before.date) : [],
    nextLottoSession: lottoChanged ? await nextReserveSession(db, before.session_id) : null,
  };
}
