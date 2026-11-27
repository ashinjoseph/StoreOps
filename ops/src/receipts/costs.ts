// What each item costs, from each supplier, over time, and a flag when a cost rises (card P5-15;
// ADR-0030). NEW in the Operations app (ADR-0023); ops/test/costs.test.ts is the specification.
//
// AN ITEM is a supplier's own line: one business, one supplier, and the supplier's printed code for the
// line when there is one, otherwise the line's description, both in the normal form of businesses.ts
// `normalise`. The app does not hold the cstore's product list and never changes a price, so it never
// matches a line to a product: the output is a list for a person to act on. A person can say two items
// are the same (a join); nothing moves and nothing is erased, and a join can be undone.
//
// A COST IS OBSERVED when a receipt is CONFIRMED (review.ts calls observeReceipt inside its transaction),
// for each line that gives a unit cost EXACTLY (ADR-0004: a cost that cannot be known is absent, never
// 0 and never guessed):
//   - a unit price is printed: that is the cost (up to four decimals, as stored);
//   - no unit price, but a line total and a quantity above zero: total / quantity, in integers, rounded
//     half up to four decimals, marked "worked out";
//   - anything else, and any line with a quantity or a total of zero or less (a return, a free item): no
//     observation, counted in the answer as "lines with no cost".
// Costs are as printed, before tax. A voided receipt's observations stop counting (marked, kept).
//
// THE ORDER is by the receipt's date, then the receipt's confirmation time, then its id and the line: a
// receipt confirmed late slots into its place. A FLAG is raised on an observation when its cost is more
// than a percentage above the counted observation just before it. "More than N percent" is exact, in
// integers, with no division: with N in hundredths of a percent, b is more than N percent above a when
//     (b - a) * 10000 > a * N
// (a rise is never a fall: b must be above a first). The percentage in force when an observation is made
// is kept on it, so changing the setting never rewrites an older flag. Flags are always WORKED OUT FROM
// THE HISTORY (flagsOfHistory) and reconciled with what is stored: a flag that still holds is left as it
// is (with its state), one that no longer holds is withdrawn (marked, kept), a new one is written.
//
// Every write takes one advisory lock first, is audited, and takes its time from the caller. SQL takes
// values as parameters only; no statement is run per line (one for the items and one for the
// observations of a receipt, whatever its size). Nothing is erased.
import type { Db } from "../db/client";
import type { Tx } from "../db/tx";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import { type Business, checkLine, isBusiness, normalise } from "./businesses";
import { parseMoney, parseQuantity, parseUnitPrice, unitPriceText } from "./drafts";

export const READ_ROLES: readonly string[] = ["admin", "manager", "payroll_admin"];
export const ACT_ROLES: readonly string[] = ["admin", "manager"];
export const CATCH_UP_ROLES: readonly string[] = ["admin"];
export const PAGE_MAX = 50;
export const PAGE_DEFAULT = 20;
export const REASON_MIN = 3;
export const REASON_MAX = 300;
export const NOTE_MAX = 300;
/** The setting's default, bounds and unit: hundredths of a percent (5 is 500, 0.1 is 10, 500 is 50000). */
export const DEFAULT_HUNDREDTHS = 500;
export const MIN_HUNDREDTHS = 10;
export const MAX_HUNDREDTHS = 50000;
/** The largest unit cost the column holds: ten digits and four decimals, in ten-thousandths. */
export const COST_MAX = 99_999_999_999_999;
/** The longest identity key the table holds. */
export const KEY_MAX = 2000;
/** Receipts one click of "Work out costs for earlier receipts" covers. */
export const CATCH_UP_BATCH = 200;
/** Most observations an item's history answers (the newest ones). */
export const HISTORY_MAX = 500;

export const FLAG_STATES = ["new", "seen", "price_raised", "withdrawn"] as const;
export type FlagState = (typeof FLAG_STATES)[number];
export type Why = "confirm" | "void" | "join" | "unjoin" | "catch_up";

export interface Actor {
  staffId: string;
  role: string;
}

const LOCK = "select pg_advisory_xact_lock(hashtextextended('ops.cost_history', 0))";
const ITEM_ID = /^it[0-9a-f]{20}$/;
const FLAG_ID = /^pf[0-9a-f]{20}$/;
const SUPPLIER_ID = /^sp[0-9a-f]{20}$/;
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const newId = (prefix: "it" | "ic" | "pf"): string => prefix + hex(crypto.getRandomValues(new Uint8Array(10)));
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// ── The pure parts ─────────────────────────────────────────

/**
 * The identity of a line within one business and supplier: `c:` and the supplier's printed code in its
 * normal form when there is one, otherwise `d:` and the description in its normal form. null when neither
 * leaves anything (a code or a description of nothing but dashes and spaces), or the key would be too long
 * to keep: such a line has no identity and gives no observation.
 */
export function itemKey(code: string | null, description: string): string | null {
  const c = code === null ? "" : normalise(code);
  const key = c !== "" ? `c:${c}` : `d:${normalise(description)}`;
  return key.length <= 2 || key.length > KEY_MAX ? null : key;
}

export interface LineFigures {
  /** Thousandths, or null when the line does not say. */
  quantity: number | null;
  /** Ten-thousandths, or null when no unit price is printed. */
  unitPrice: number | null;
  /** Cents, or null when the line has no total. */
  total: number | null;
}

export interface Cost {
  /** Ten-thousandths of a dollar, above zero. */
  cost: number;
  how: "printed" | "worked_out";
}

/**
 * The unit cost a line gives, or null (no observation). A quantity or a total of zero or less (a return,
 * a free item) gives none; a printed unit price above zero is the cost as printed; otherwise a total and a
 * quantity give total / quantity worked out exactly: in ten-thousandths that is
 * total_cents * 100000 / quantity_thousandths, rounded half up with integers only.
 */
export function unitCostOf(l: LineFigures): Cost | null {
  if (l.quantity !== null && l.quantity <= 0) return null;
  if (l.total !== null && l.total <= 0) return null;
  if (l.unitPrice !== null) return l.unitPrice > 0 && l.unitPrice <= COST_MAX ? { cost: l.unitPrice, how: "printed" } : null;
  if (l.total === null || l.quantity === null) return null;
  const num = BigInt(l.total) * 100000n;
  const den = BigInt(l.quantity);
  const cost = (2n * num + den) / (2n * den);
  return cost > 0n && cost <= BigInt(COST_MAX) ? { cost: Number(cost), how: "worked_out" } : null;
}

/** Is `b` more than `hundredths` hundredths of a percent above `a`? Integers only: (b - a) * 10000 > a * hundredths. */
export function isMoreThanPercentAbove(a: number, b: number, hundredths: number): boolean {
  if (!(a > 0) || b <= a) return false;
  return (BigInt(b) - BigInt(a)) * 10000n > BigInt(a) * BigInt(hundredths);
}

/** The rise from a to b in tenths of a percent, rounded half up, in integers: (b - a) * 1000 / a. */
export function riseTenths(a: number, b: number): bigint {
  const A = BigInt(a);
  return (2n * (BigInt(b) - A) * 1000n + A) / (2n * A);
}

/** Tenths of a percent as text with one decimal: 125n is "12.5", 3n is "0.3". */
export const tenthsText = (t: bigint): string => `${t / 10n}.${t % 10n}`;

/** Ten-thousandths as the stored text with four decimals: 12000 is "1.2000". Above zero only. */
export const costText = (n: number): string => {
  const s = String(n).padStart(5, "0");
  return `${s.slice(0, -4)}.${s.slice(-4)}`;
};

export interface Observed {
  cost: number;
  /** The percentage in force when it was observed, in hundredths. */
  hundredths: number;
}
export interface FlagOf {
  /** Index in the history of the observation that costs more. */
  index: number;
  /** The index of the counted one just before it. */
  prev: number;
  riseTenths: bigint;
}

/** The flags of one ordered history of counted observations: each one whose cost is more than its own percentage above the one before it. A fall raises nothing. */
export function flagsOfHistory(history: readonly Observed[]): FlagOf[] {
  const out: FlagOf[] = [];
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1] as Observed;
    const b = history[i] as Observed;
    if (isMoreThanPercentAbove(a.cost, b.cost, b.hundredths)) out.push({ index: i, prev: i - 1, riseTenths: riseTenths(a.cost, b.cost) });
  }
  return out;
}

/** The setting price_rise_flag_percent in hundredths of a percent: 0.1 to 500 with at most two decimals, else 5. Read as exact text. */
export function thresholdHundredths(config: Config): number {
  const milli = parseQuantity(config.value("price_rise_flag_percent", ""));
  if (milli === null || milli % 10 !== 0) return DEFAULT_HUNDREDTHS;
  const h = milli / 10;
  return h < MIN_HUNDREDTHS || h > MAX_HUNDREDTHS ? DEFAULT_HUNDREDTHS : h;
}

// ── What a write answers ───────────────────────────────────

export interface CostSummary {
  receiptId: string;
  /** False when this receipt had already been observed (nothing was done). */
  done: boolean;
  /** The receipt has no lines at all. */
  noLines: boolean;
  lines: number;
  /** Lines added to the cost history. */
  observed: number;
  /** Lines that gave no cost: never stored, never guessed. */
  noCost: number;
  /** Observations that stopped counting (a void). */
  uncounted: number;
  flagsRaised: number;
  flagsWithdrawn: number;
  message: string;
}

function observedWords(s: Omit<CostSummary, "message">): string {
  if (!s.done) return "The cost history already had this receipt.";
  if (s.noLines) return "This receipt has no lines, so nothing was added to the cost history.";
  const parts = [`${plural(s.observed, "line", "lines")} added to the cost history`];
  if (s.noCost > 0) parts.push(`${plural(s.noCost, "line", "lines")} with no cost (not guessed)`);
  parts.push(s.flagsRaised > 0 ? `${plural(s.flagsRaised, "price rise", "price rises")} flagged` : "no price rise flagged");
  if (s.flagsWithdrawn > 0) parts.push(`${plural(s.flagsWithdrawn, "flag", "flags")} withdrawn`);
  return `${parts.join("; ")}.`;
}

function unobservedWords(s: Omit<CostSummary, "message">): string {
  if (!s.done) return "This receipt had no costs in the cost history.";
  const parts = [`${plural(s.uncounted, "cost", "costs")} no longer counted in the cost history`];
  parts.push(s.flagsWithdrawn > 0 ? `${plural(s.flagsWithdrawn, "flag", "flags")} withdrawn` : "no flag withdrawn");
  if (s.flagsRaised > 0) parts.push(`${plural(s.flagsRaised, "price rise", "price rises")} flagged again from the costs either side`);
  return `${parts.join("; ")}.`;
}

// ── Reconciling the flags with the histories ───────────────

interface HistoryRow {
  cost_id: string;
  item_id: string;
  root: string;
  business: Business;
  supplier_id: string;
  unit_cost: string;
  flag_hundredths: number;
  receipt_date: string;
  receipt_confirmed_at: Date;
}

/** The ten-thousandths of a stored unit cost ("1.2000"), exactly. */
function tenThousandths(text: string): number {
  const v = parseUnitPrice(text);
  if (v === null) throw new Error(`a stored cost is not a cost: ${text}`);
  return v;
}

/**
 * Bring the stored flags of the given groups (a root item and everything joined into it) into line with
 * their histories. Returns the flags written and withdrawn. `why` says what made the history change.
 */
async function reconcile(tx: Tx, roots: readonly string[], why: Why, now: Date): Promise<{ raised: string[]; withdrawn: string[] }> {
  if (roots.length === 0) return { raised: [], withdrawn: [] };
  const history = await tx.query<HistoryRow>(
    `select c.cost_id, c.item_id, coalesce(i.joined_into, i.item_id) as root, c.business, c.supplier_id, c.unit_cost::text as unit_cost,
            c.flag_hundredths, c.receipt_date::text as receipt_date, c.receipt_confirmed_at
       from ops.item_costs c
       join ops.supplier_items i on i.item_id = c.item_id
      where c.counted and coalesce(i.joined_into, i.item_id) = any($1::text[])
      order by coalesce(i.joined_into, i.item_id), c.receipt_date, c.receipt_confirmed_at, c.receipt_id, c.line_no`,
    [roots],
  );
  const live = await tx.query<{ flag_id: string; cost_id: string; prev_cost_id: string; cur_counted: boolean; prev_counted: boolean }>(
    `select f.flag_id, f.cost_id, f.prev_cost_id, c.counted as cur_counted, p.counted as prev_counted
       from ops.price_flags f
       join ops.supplier_items i on i.item_id = f.item_id
       join ops.item_costs c on c.cost_id = f.cost_id
       join ops.item_costs p on p.cost_id = f.prev_cost_id
      where f.state <> 'withdrawn' and coalesce(i.joined_into, i.item_id) = any($1::text[])`,
    [roots],
  );
  const groups = new Map<string, HistoryRow[]>();
  for (const r of history) {
    const g = groups.get(r.root);
    if (g === undefined) groups.set(r.root, [r]);
    else g.push(r);
  }
  const desired: Array<{ cur: HistoryRow; prev: HistoryRow; tenths: bigint }> = [];
  for (const rows of groups.values()) {
    for (const f of flagsOfHistory(rows.map((r) => ({ cost: tenThousandths(r.unit_cost), hundredths: r.flag_hundredths })))) desired.push({ cur: rows[f.index] as HistoryRow, prev: rows[f.prev] as HistoryRow, tenths: f.riseTenths });
  }
  const wanted = new Set(desired.map((d) => `${d.cur.cost_id}|${d.prev.cost_id}`));
  const have = new Set(live.map((f) => `${f.cost_id}|${f.prev_cost_id}`));
  const gone = live.filter((f) => !wanted.has(`${f.cost_id}|${f.prev_cost_id}`));
  const fresh = desired.filter((d) => !have.has(`${d.cur.cost_id}|${d.prev.cost_id}`));
  const reasonOf = (f: { cur_counted: boolean; prev_counted: boolean }): string => (!f.cur_counted || !f.prev_counted ? "receipt_voided" : why === "join" ? "joined" : why === "unjoin" ? "unjoined" : "history_changed");
  if (gone.length > 0) {
    await tx.query(
      `update ops.price_flags f set state = 'withdrawn', withdrawn_reason = w.reason, withdrawn_at = $3
         from unnest($1::text[], $2::text[]) as w(id, reason) where f.flag_id = w.id`,
      [gone.map((f) => f.flag_id), gone.map(reasonOf), now],
    );
  }
  const ids = fresh.map(() => newId("pf"));
  if (fresh.length > 0) {
    await tx.query(
      `insert into ops.price_flags (flag_id, business, supplier_id, item_id, cost_id, prev_cost_id, unit_cost, prev_unit_cost, rise_percent, threshold_hundredths, cost_date, cost_confirmed_at, raised_because, raised_at)
       select w.id, w.business, w.supplier, w.item, w.cost, w.prev, w.unit_cost::numeric, w.prev_cost::numeric, w.rise::numeric, w.hundredths, w.cost_date::date, w.confirmed_at::timestamptz, $13, $14
         from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::int[], $11::text[], $12::text[])
              as w(id, business, supplier, item, cost, prev, unit_cost, prev_cost, rise, hundredths, cost_date, confirmed_at)`,
      [
        ids,
        fresh.map((d) => d.cur.business),
        fresh.map((d) => d.cur.supplier_id),
        fresh.map((d) => d.cur.item_id),
        fresh.map((d) => d.cur.cost_id),
        fresh.map((d) => d.prev.cost_id),
        fresh.map((d) => d.cur.unit_cost),
        fresh.map((d) => d.prev.unit_cost),
        fresh.map((d) => tenthsText(d.tenths)),
        fresh.map((d) => d.cur.flag_hundredths),
        fresh.map((d) => d.cur.receipt_date),
        fresh.map((d) => d.cur.receipt_confirmed_at.toISOString()),
        why,
        now,
      ],
    );
  }
  return { raised: ids, withdrawn: gone.map((f) => f.flag_id) };
}

// ── Observing a receipt (called by review.confirm) ─────────

interface ReceiptRow {
  status: string;
  business: Business | null;
  supplier_id: string | null;
  receipt_date: string | null;
  confirmed_at: Date | null;
}
interface LineRow {
  line_no: number;
  description: string;
  item_code: string | null;
  quantity: string | null;
  unit_price: string | null;
  line_total: string | null;
  taxed: boolean | null;
}

/**
 * Write the cost observations of one CONFIRMED receipt (one statement for its items, one for its
 * observations, whatever its size), work out the flags of the histories it touched, and audit. A receipt
 * already observed is left alone. Called inside review.confirm's transaction, and by the catch-up:
 * anything that throws here fails the confirm with it.
 */
export async function observeReceipt(tx: Tx, receiptId: string, actor: { staffId: string }, config: Config, now: Date, source: "confirm" | "catch_up" = "confirm"): Promise<CostSummary> {
  await tx.query(LOCK);
  const done = await tx.maybeOne<{ receipt_id: string }>("select receipt_id from ops.receipt_observations where receipt_id = $1", [receiptId]);
  const blank = { receiptId, done: false, noLines: false, lines: 0, observed: 0, noCost: 0, uncounted: 0, flagsRaised: 0, flagsWithdrawn: 0 };
  if (done !== null) return { ...blank, message: observedWords(blank) };
  const receipt = await tx.one<ReceiptRow>("select status, business, supplier_id, receipt_date::text as receipt_date, confirmed_at from ops.purchase_receipts where purchase_id = $1", [receiptId]);
  if (receipt.status !== "confirmed" || receipt.business === null || receipt.supplier_id === null || receipt.receipt_date === null || receipt.confirmed_at === null) throw new Error("Only a receipt on the books has costs to observe.");
  const lines = await tx.query<LineRow>(
    "select line_no, description, item_code, quantity::text as quantity, unit_price::text as unit_price, line_total::text as line_total, taxed from ops.purchase_receipt_lines where purchase_id = $1 order by line_no",
    [receiptId],
  );
  const hundredths = thresholdHundredths(config);
  const obs: Array<{ line: LineRow; key: string; cost: Cost }> = [];
  for (const l of lines) {
    const key = itemKey(l.item_code, l.description);
    const cost = unitCostOf({
      quantity: l.quantity === null ? null : parseQuantity(l.quantity),
      unitPrice: l.unit_price === null ? null : parseUnitPrice(l.unit_price),
      total: l.line_total === null ? null : parseMoney(l.line_total),
    });
    if (key !== null && cost !== null) obs.push({ line: l, key, cost });
  }
  let roots: string[] = [];
  if (obs.length > 0) {
    // One statement for the items: each distinct key is inserted when new; the answer holds every item's id.
    const firsts = new Map<string, LineRow>();
    for (const o of obs) if (!firsts.has(o.key)) firsts.set(o.key, o.line);
    const keys = [...firsts.keys()];
    const found = await tx.query<{ item_id: string; item_key: string; root: string }>(
      `with want as (
         select * from unnest($1::text[], $2::text[], $3::text[], $4::text[]) as w(item_id, item_key, item_code, item_name)
       ), ins as (
         insert into ops.supplier_items (item_id, business, supplier_id, item_code, item_name, item_key, first_seen_at, created_from_receipt)
         select w.item_id, $5, $6, w.item_code, w.item_name, w.item_key, $7, $8 from want w
         on conflict (business, supplier_id, item_key) do nothing
         returning item_id, item_key, item_id as root
       )
       select item_id, item_key, root from ins
       union all
       select i.item_id, i.item_key, coalesce(i.joined_into, i.item_id) as root
         from ops.supplier_items i join want w on w.item_key = i.item_key
        where i.business = $5 and i.supplier_id = $6`,
      [keys.map(() => newId("it")), keys, keys.map((k) => (firsts.get(k) as LineRow).item_code), keys.map((k) => (firsts.get(k) as LineRow).description), receipt.business, receipt.supplier_id, now, receiptId],
    );
    const byKey = new Map(found.map((f) => [f.item_key, f]));
    roots = [...new Set(found.map((f) => f.root))];
    const ids = obs.map(() => newId("ic"));
    await tx.query(
      `insert into ops.item_costs (cost_id, item_id, business, supplier_id, receipt_id, line_no, receipt_date, receipt_confirmed_at, unit_cost, how, quantity, line_total, taxed, line_code, line_description, flag_hundredths, observed_at, observed_by)
       select w.id, w.item, $2, $3, $1, w.line_no, $4::date, $5, w.cost::numeric, w.how, w.quantity::numeric, w.line_total::numeric, w.taxed, w.code, w.description, $6, $7, $8
         from unnest($9::text[], $10::text[], $11::int[], $12::text[], $13::text[], $14::text[], $15::text[], $16::boolean[], $17::text[], $18::text[])
              as w(id, item, line_no, cost, how, quantity, line_total, taxed, code, description)`,
      [
        receiptId,
        receipt.business,
        receipt.supplier_id,
        receipt.receipt_date,
        receipt.confirmed_at,
        hundredths,
        now,
        actor.staffId,
        ids,
        obs.map((o) => (byKey.get(o.key) as { item_id: string }).item_id),
        obs.map((o) => o.line.line_no),
        obs.map((o) => costText(o.cost.cost)),
        obs.map((o) => o.cost.how),
        obs.map((o) => o.line.quantity),
        obs.map((o) => o.line.line_total),
        obs.map((o) => o.line.taxed),
        obs.map((o) => o.line.item_code),
        obs.map((o) => o.line.description),
      ],
    );
  }
  await tx.query(
    "insert into ops.receipt_observations (receipt_id, business, lines, lines_observed, lines_no_cost, source, observed_at, observed_by) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [receiptId, receipt.business, lines.length, obs.length, lines.length - obs.length, source, now, actor.staffId],
  );
  const flags = await reconcile(tx, roots, source === "catch_up" ? "catch_up" : "confirm", now);
  const parts = { receiptId, done: true, noLines: lines.length === 0, lines: lines.length, observed: obs.length, noCost: lines.length - obs.length, uncounted: 0, flagsRaised: flags.raised.length, flagsWithdrawn: flags.withdrawn.length };
  await audit.write(
    tx,
    { actorId: actor.staffId, action: "costs.observe", targetType: "purchase_receipts", targetId: receiptId, after: { source, business: receipt.business, lines: parts.lines, observed: parts.observed, noCost: parts.noCost, thresholdHundredths: hundredths, flagsRaised: flags.raised, flagsWithdrawn: flags.withdrawn } },
    { now },
  );
  return { ...parts, message: observedWords(parts) };
}

/** A receipt was voided: its observations stop counting (marked, kept), and the flags of the items they touched are worked out again. Called by review.voidReceipt. */
export async function unobserveReceipt(tx: Tx, receiptId: string, actor: { staffId: string }, now: Date): Promise<CostSummary> {
  await tx.query(LOCK);
  const blank = { receiptId, done: false, noLines: false, lines: 0, observed: 0, noCost: 0, uncounted: 0, flagsRaised: 0, flagsWithdrawn: 0 };
  const seen = await tx.maybeOne<{ lines: number; lines_observed: number; lines_no_cost: number }>(
    "update ops.receipt_observations set unobserved_at = $2 where receipt_id = $1 and unobserved_at is null returning lines, lines_observed, lines_no_cost",
    [receiptId, now],
  );
  if (seen === null) return { ...blank, message: unobservedWords(blank) };
  const touched = await tx.query<{ item_id: string }>("update ops.item_costs set counted = false, uncounted_reason = 'receipt_voided', uncounted_at = $2 where receipt_id = $1 and counted returning item_id", [receiptId, now]);
  const roots = touched.length === 0 ? [] : (await tx.query<{ root: string }>("select distinct coalesce(joined_into, item_id) as root from ops.supplier_items where item_id = any($1::text[])", [touched.map((t) => t.item_id)])).map((r) => r.root);
  const flags = await reconcile(tx, roots, "void", now);
  const parts = { receiptId, done: true, noLines: seen.lines === 0, lines: seen.lines, observed: 0, noCost: seen.lines_no_cost, uncounted: touched.length, flagsRaised: flags.raised.length, flagsWithdrawn: flags.withdrawn.length };
  await audit.write(
    tx,
    { actorId: actor.staffId, action: "costs.unobserve", targetType: "purchase_receipts", targetId: receiptId, after: { uncounted: parts.uncounted, flagsRaised: flags.raised, flagsWithdrawn: flags.withdrawn } },
    { now },
  );
  return { ...parts, message: unobservedWords(parts) };
}

// ── The catch-up for receipts confirmed before this card (decision 9) ──

export interface CatchUp {
  receipts: number;
  lines: number;
  observed: number;
  noCost: number;
  flagsRaised: number;
  /** More receipts are still waiting: run it again. */
  more: boolean;
  message: string;
}

/** Observe every confirmed receipt that has not been (up to CATCH_UP_BATCH a time). Safe to run twice. Admin. */
export async function observeEarlierReceipts(tx: Tx, actor: Actor, config: Config, now: Date, batchSize: number = CATCH_UP_BATCH): Promise<CatchUp> {
  if (!CATCH_UP_ROLES.includes(actor.role)) throw new Error("Only an admin can work out costs for earlier receipts.");
  await tx.query(LOCK);
  const waiting = await tx.query<{ purchase_id: string }>(
    `select p.purchase_id from ops.purchase_receipts p
      where p.status = 'confirmed' and not exists (select 1 from ops.receipt_observations o where o.receipt_id = p.purchase_id)
      order by p.receipt_date, p.confirmed_at, p.purchase_id limit $1`,
    [batchSize + 1],
  );
  const batch = waiting.slice(0, batchSize);
  let lines = 0;
  let observed = 0;
  let noCost = 0;
  let flagsRaised = 0;
  for (const r of batch) {
    const s = await observeReceipt(tx, r.purchase_id, actor, config, now, "catch_up");
    lines += s.lines;
    observed += s.observed;
    noCost += s.noCost;
    flagsRaised += s.flagsRaised;
  }
  const more = waiting.length > batchSize;
  const message =
    batch.length === 0
      ? "Every receipt on the books has already been worked out. Nothing to do."
      : `Worked out ${plural(batch.length, "earlier receipt", "earlier receipts")}: ${plural(observed, "line", "lines")} added to the cost history, ${plural(noCost, "line", "lines")} with no cost (not guessed), ${plural(flagsRaised, "price rise", "price rises")} flagged.${more ? " More are waiting: run it again." : ""}`;
  await audit.write(tx, { actorId: actor.staffId, action: "costs.catch_up", targetType: "receipt_observations", targetId: null, after: { receipts: batch.length, lines, observed, noCost, flagsRaised, more } }, { now });
  return { receipts: batch.length, lines, observed, noCost, flagsRaised, more, message };
}

// ── Reading ────────────────────────────────────────────────

const businessOf = (v: unknown): Business => {
  if (!isBusiness(v)) throw new Error("Choose cstore or vape: costs are shown for one business at a time.");
  return v;
};
const likeOf = (text: string): string => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const limitOf = (v: unknown): number => {
  if (v === undefined || v === null) return PAGE_DEFAULT;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new Error(`The limit is a whole number from 1 to ${PAGE_MAX}.`);
  return Math.min(v, PAGE_MAX);
};
const costOut = (stored: string): string => unitPriceText(stored);

export interface FlagView {
  id: string;
  business: Business;
  state: FlagState;
  item: { id: string; code: string | null; name: string; printedAs: string; joined: boolean };
  supplier: { id: string; name: string };
  from: { costId: string; cost: string; date: string; receiptId: string; how: string };
  to: { costId: string; cost: string; date: string; receiptId: string; how: string };
  risePercent: string;
  thresholdPercent: string;
  raisedBecause: Why;
  raisedAt: string;
  mark: { by: string; at: string; note: string | null } | null;
  withdrawn: { reason: string; at: string } | null;
}

interface FlagRow {
  flag_id: string;
  business: Business;
  state: FlagState;
  rise_percent: string;
  threshold_hundredths: number;
  raised_because: Why;
  raised_at: Date;
  state_by: string | null;
  state_by_name: string | null;
  state_at: Date | null;
  state_note: string | null;
  withdrawn_reason: string | null;
  withdrawn_at: Date | null;
  cur_item: string;
  root_id: string;
  root_code: string | null;
  root_name: string;
  supplier_id: string;
  supplier_name: string;
  to_cost_id: string;
  to_cost: string;
  to_date: string;
  to_receipt: string;
  to_how: string;
  to_description: string;
  from_cost_id: string;
  from_cost: string;
  from_date: string;
  from_receipt: string;
  from_how: string;
}

const percentText = (hundredths: number): string => {
  const whole = Math.floor(hundredths / 100);
  const frac = String(hundredths % 100).padStart(2, "0").replace(/0+$/, "");
  return frac === "" ? String(whole) : `${whole}.${frac}`;
};

function flagView(r: FlagRow): FlagView {
  return {
    id: r.flag_id,
    business: r.business,
    state: r.state,
    item: { id: r.root_id, code: r.root_code, name: r.root_name, printedAs: r.to_description, joined: r.cur_item !== r.root_id },
    supplier: { id: r.supplier_id, name: r.supplier_name },
    from: { costId: r.from_cost_id, cost: costOut(r.from_cost), date: r.from_date, receiptId: r.from_receipt, how: r.from_how },
    to: { costId: r.to_cost_id, cost: costOut(r.to_cost), date: r.to_date, receiptId: r.to_receipt, how: r.to_how },
    risePercent: r.rise_percent,
    thresholdPercent: percentText(r.threshold_hundredths),
    raisedBecause: r.raised_because,
    raisedAt: r.raised_at.toISOString(),
    mark: r.state_by === null || r.state_at === null ? null : { by: (r.state_by_name ?? r.state_by).trim(), at: r.state_at.toISOString(), note: r.state_note },
    withdrawn: r.withdrawn_at === null || r.withdrawn_reason === null ? null : { reason: r.withdrawn_reason, at: r.withdrawn_at.toISOString() },
  };
}

const FLAG_SELECT = `
  select f.flag_id, f.business, f.state, f.rise_percent::text as rise_percent, f.threshold_hundredths, f.raised_because, f.raised_at,
         f.state_by, sb.name as state_by_name, f.state_at, f.state_note, f.withdrawn_reason, f.withdrawn_at, f.item_id as cur_item,
         r.item_id as root_id, r.item_code as root_code, r.item_name as root_name, f.supplier_id, s.display_name as supplier_name,
         c.cost_id as to_cost_id, c.unit_cost::text as to_cost, c.receipt_date::text as to_date, c.receipt_id as to_receipt, c.how as to_how, c.line_description as to_description,
         p.cost_id as from_cost_id, p.unit_cost::text as from_cost, p.receipt_date::text as from_date, p.receipt_id as from_receipt, p.how as from_how
    from ops.price_flags f
    join ops.supplier_items i on i.item_id = f.item_id
    join ops.supplier_items r on r.item_id = coalesce(i.joined_into, i.item_id)
    join ops.suppliers s on s.supplier_id = f.supplier_id
    join ops.item_costs c on c.cost_id = f.cost_id
    join ops.item_costs p on p.cost_id = f.prev_cost_id
    left join ops.staff sb on sb.staff_id = f.state_by`;

/** The flags of ONE business, newest rise first (the later receipt's date), with the counts per state. `{ business, state?, before?, limit? }`: with no state, every flag that is not withdrawn. */
export async function getPriceFlags(db: Db, input: { business?: unknown; state?: unknown; before?: unknown; limit?: unknown }): Promise<{ business: Business; flags: FlagView[]; counts: Record<FlagState, number>; next: string | null }> {
  const business = businessOf(input.business);
  const state = input.state === undefined || input.state === null ? null : input.state;
  if (state !== null && !(FLAG_STATES as readonly unknown[]).includes(state)) throw new Error("The state is new, seen, price_raised or withdrawn.");
  const before = input.before === undefined || input.before === null ? null : input.before;
  if (before !== null && !(typeof before === "string" && FLAG_ID.test(before))) throw new Error("before is the id of the last flag shown.");
  const limit = limitOf(input.limit);
  const rows = await db.query<FlagRow>(
    `${FLAG_SELECT}
      where f.business = $1 and (f.state = $2 or ($2::text is null and f.state <> 'withdrawn'))
        and ($3::text is null or (f.cost_date, f.cost_confirmed_at, f.flag_id) < (select b.cost_date, b.cost_confirmed_at, b.flag_id from ops.price_flags b where b.flag_id = $3 and b.business = $1))
      order by f.cost_date desc, f.cost_confirmed_at desc, f.flag_id desc
      limit $4`,
    [business, state, before, limit + 1],
  );
  const counts: Record<FlagState, number> = { new: 0, seen: 0, price_raised: 0, withdrawn: 0 };
  for (const c of await db.query<{ state: FlagState; n: number }>("select state, count(*)::int as n from ops.price_flags where business = $1 group by state", [business])) counts[c.state] = c.n;
  const page = rows.slice(0, limit);
  return { business, flags: page.map(flagView), counts, next: rows.length > limit ? (page[page.length - 1] as FlagRow).flag_id : null };
}

export interface ItemSummary {
  id: string;
  business: Business;
  supplier: { id: string; name: string };
  code: string | null;
  name: string;
  joinedCount: number;
  observations: number;
  latest: { cost: string; date: string; how: string; receiptId: string } | null;
}

/** The items of ONE business with their latest cost and how many observations count: `{ business, supplierId?, text?, before?, limit? }`; and the suppliers that have items in that business (for the page's choice). */
export async function findItems(db: Db, input: { business?: unknown; supplierId?: unknown; text?: unknown; before?: unknown; limit?: unknown }): Promise<{ business: Business; items: ItemSummary[]; next: string | null; suppliers: Array<{ id: string; name: string }> }> {
  const business = businessOf(input.business);
  const supplier = input.supplierId === undefined || input.supplierId === null || input.supplierId === "" ? null : input.supplierId;
  if (supplier !== null && !(typeof supplier === "string" && SUPPLIER_ID.test(supplier))) throw new Error("No such supplier.");
  const text = checkLine(input.text, "The search text", 1, 100, false);
  const before = input.before === undefined || input.before === null ? null : input.before;
  if (before !== null && !(typeof before === "string" && ITEM_ID.test(before))) throw new Error("before is the id of the last item shown.");
  const limit = limitOf(input.limit);
  const rows = await db.query<{
    item_id: string;
    item_code: string | null;
    item_name: string;
    supplier_id: string;
    supplier_name: string;
    joined_count: number;
    n: number;
    last_cost: string | null;
    last_date: string | null;
    last_how: string | null;
    last_receipt: string | null;
  }>(
    `select r.item_id, r.item_code, r.item_name, r.supplier_id, s.display_name as supplier_name,
            (select count(*)::int from ops.supplier_items j where j.joined_into = r.item_id) as joined_count,
            coalesce(agg.n, 0) as n, last.unit_cost::text as last_cost, last.receipt_date::text as last_date, last.how as last_how, last.receipt_id as last_receipt
       from ops.supplier_items r
       join ops.suppliers s on s.supplier_id = r.supplier_id
       left join lateral (
         select count(*)::int as n from ops.item_costs c join ops.supplier_items i on i.item_id = c.item_id
          where c.counted and coalesce(i.joined_into, i.item_id) = r.item_id) agg on true
       left join lateral (
         select c.unit_cost, c.receipt_date, c.how, c.receipt_id from ops.item_costs c join ops.supplier_items i on i.item_id = c.item_id
          where c.counted and coalesce(i.joined_into, i.item_id) = r.item_id
          order by c.receipt_date desc, c.receipt_confirmed_at desc, c.receipt_id desc, c.line_no desc limit 1) last on true
      where r.business = $1 and r.joined_into is null
        and ($2::text is null or r.supplier_id = $2)
        and ($3::text is null or r.item_name ilike $3 escape '\\' or r.item_code ilike $3 escape '\\'
             or exists (select 1 from ops.supplier_items j where j.joined_into = r.item_id and (j.item_name ilike $3 escape '\\' or j.item_code ilike $3 escape '\\')))
        and ($4::text is null or (lower(r.item_name) collate "C", r.item_id collate "C") > (select lower(b.item_name) collate "C", b.item_id collate "C" from ops.supplier_items b where b.item_id = $4 and b.business = $1))
      order by lower(r.item_name) collate "C", r.item_id collate "C"
      limit $5`,
    [business, supplier, text === null ? null : likeOf(text), before, limit + 1],
  );
  const page = rows.slice(0, limit);
  const suppliers = await db.query<{ supplier_id: string; display_name: string }>(
    `select s.supplier_id, s.display_name from ops.suppliers s
      where exists (select 1 from ops.supplier_items i where i.supplier_id = s.supplier_id and i.business = $1)
      order by lower(s.display_name) collate "C", s.supplier_id collate "C"`,
    [business],
  );
  return {
    business,
    suppliers: suppliers.map((s) => ({ id: s.supplier_id, name: s.display_name })),
    items: page.map((r) => ({
      id: r.item_id,
      business,
      supplier: { id: r.supplier_id, name: r.supplier_name },
      code: r.item_code,
      name: r.item_name,
      joinedCount: r.joined_count,
      observations: r.n,
      latest: r.last_cost === null || r.last_date === null || r.last_how === null || r.last_receipt === null ? null : { cost: costOut(r.last_cost), date: r.last_date, how: r.last_how, receiptId: r.last_receipt },
    })),
    next: rows.length > limit ? (page[page.length - 1] as { item_id: string }).item_id : null,
  };
}

export interface CostRow {
  costId: string;
  itemId: string;
  /** The line as this receipt printed it. */
  printedAs: { code: string | null; description: string };
  receiptId: string;
  invoiceNumber: string | null;
  line: number;
  date: string;
  cost: string;
  how: "printed" | "worked_out";
  quantity: string | null;
  lineTotal: string | null;
  taxed: boolean | null;
  /** The live flag on this observation, if any. */
  flag: { id: string; state: FlagState; risePercent: string } | null;
  notCounted: { reason: string; at: string } | null;
}

export interface ItemHistory {
  business: Business;
  /** The item asked for resolved to the one it was joined into (the same when it is not joined). */
  item: { id: string; code: string | null; name: string; supplier: { id: string; name: string } };
  askedFor: { id: string; joinedInto: string | null };
  /** Every item in this history: the root first, then those joined into it. */
  members: Array<{ id: string; code: string | null; name: string; root: boolean; join: { by: string; at: string; reason: string } | null }>;
  history: CostRow[];
  /** Counted observations older than the newest HISTORY_MAX are not shown. */
  earlierNotShown: number;
  notCounted: CostRow[];
}

/** An item's counted history in order, with what is joined into it; the not-counted ones apart with why. `{ itemId }`. */
export async function getItemCosts(db: Db, input: { itemId?: unknown }): Promise<ItemHistory> {
  const id = typeof input.itemId === "string" && ITEM_ID.test(input.itemId) ? input.itemId : null;
  const asked = id === null ? null : await db.maybeOne<{ item_id: string; joined_into: string | null }>("select item_id, joined_into from ops.supplier_items where item_id = $1", [id]);
  if (asked === null) throw new Error("No such item.");
  const rootId = asked.joined_into ?? asked.item_id;
  const members = await db.query<{ item_id: string; item_code: string | null; item_name: string; business: Business; supplier_id: string; supplier_name: string; joined_by: string | null; joined_by_name: string | null; joined_at: Date | null; join_reason: string | null }>(
    `select i.item_id, i.item_code, i.item_name, i.business, i.supplier_id, s.display_name as supplier_name, i.joined_by, st.name as joined_by_name, i.joined_at, i.join_reason
       from ops.supplier_items i join ops.suppliers s on s.supplier_id = i.supplier_id left join ops.staff st on st.staff_id = i.joined_by
      where coalesce(i.joined_into, i.item_id) = $1
      order by (i.item_id = $1) desc, i.first_seen_at, i.item_id`,
    [rootId],
  );
  const root = members[0] as (typeof members)[number];
  const costs = await db.query<{
    cost_id: string;
    item_id: string;
    line_code: string | null;
    line_description: string;
    receipt_id: string;
    invoice_number: string | null;
    line_no: number;
    receipt_date: string;
    unit_cost: string;
    how: "printed" | "worked_out";
    quantity: string | null;
    line_total: string | null;
    taxed: boolean | null;
    counted: boolean;
    uncounted_reason: string | null;
    uncounted_at: Date | null;
    flag_id: string | null;
    flag_state: FlagState | null;
    flag_rise: string | null;
  }>(
    `select c.cost_id, c.item_id, c.line_code, c.line_description, c.receipt_id, p.invoice_number, c.line_no, c.receipt_date::text as receipt_date,
            c.unit_cost::text as unit_cost, c.how, c.quantity::text as quantity, c.line_total::text as line_total, c.taxed, c.counted, c.uncounted_reason, c.uncounted_at,
            f.flag_id, f.state as flag_state, f.rise_percent::text as flag_rise
       from ops.item_costs c
       join ops.supplier_items i on i.item_id = c.item_id
       join ops.purchase_receipts p on p.purchase_id = c.receipt_id
       left join ops.price_flags f on f.cost_id = c.cost_id and f.state <> 'withdrawn'
      where coalesce(i.joined_into, i.item_id) = $1
      order by c.receipt_date, c.receipt_confirmed_at, c.receipt_id, c.line_no`,
    [rootId],
  );
  const row = (c: (typeof costs)[number]): CostRow => ({
    costId: c.cost_id,
    itemId: c.item_id,
    printedAs: { code: c.line_code, description: c.line_description },
    receiptId: c.receipt_id,
    invoiceNumber: c.invoice_number,
    line: c.line_no,
    date: c.receipt_date,
    cost: costOut(c.unit_cost),
    how: c.how,
    quantity: c.quantity === null ? null : c.quantity.replace(/\.?0+$/, ""),
    lineTotal: c.line_total,
    taxed: c.taxed,
    flag: c.flag_id === null || c.flag_state === null || c.flag_rise === null ? null : { id: c.flag_id, state: c.flag_state, risePercent: c.flag_rise },
    notCounted: c.counted || c.uncounted_at === null || c.uncounted_reason === null ? null : { reason: c.uncounted_reason, at: c.uncounted_at.toISOString() },
  });
  const counted = costs.filter((c) => c.counted).map(row);
  return {
    business: root.business,
    item: { id: root.item_id, code: root.item_code, name: root.item_name, supplier: { id: root.supplier_id, name: root.supplier_name } },
    askedFor: { id: asked.item_id, joinedInto: asked.joined_into },
    members: members.map((m) => ({
      id: m.item_id,
      code: m.item_code,
      name: m.item_name,
      root: m.item_id === rootId,
      join: m.joined_at === null || m.joined_by === null || m.join_reason === null ? null : { by: (m.joined_by_name ?? m.joined_by).trim(), at: m.joined_at.toISOString(), reason: m.join_reason },
    })),
    history: counted.slice(-HISTORY_MAX),
    earlierNotShown: Math.max(0, counted.length - HISTORY_MAX),
    notCounted: costs.filter((c) => !c.counted).map(row),
  };
}

// ── Acting: flag states and joins (admin, manager) ─────────

const mayAct = (actor: Actor): void => {
  if (!ACT_ROLES.includes(actor.role)) throw new Error("Only an admin or a manager can do that.");
};

/** Mark a flag seen, price raised (with an optional note), or new again. A withdrawn flag cannot be marked. `{ flagId, state, note? }`. */
export async function setFlagState(tx: Tx, input: { flagId?: unknown; state?: unknown; note?: unknown }, actor: Actor, now: Date): Promise<{ flag: FlagView; changed: boolean; message: string }> {
  const fail = (m: string): Error => new Error(`${m} Nothing was changed.`);
  mayAct(actor);
  const id = typeof input.flagId === "string" && FLAG_ID.test(input.flagId) ? input.flagId : null;
  if (id === null) throw fail("No such flag.");
  if (input.state !== "seen" && input.state !== "price_raised" && input.state !== "new") throw fail("A flag is marked seen, price raised or new.");
  const state = input.state;
  let note: string | null = null;
  try {
    note = checkLine(input.note, "The note", 1, NOTE_MAX, false);
  } catch (e) {
    throw fail((e as Error).message);
  }
  if (state === "new" && note !== null) throw fail("A flag marked new has no note.");
  await tx.query(LOCK);
  const was = await tx.maybeOne<{ state: FlagState; state_note: string | null; business: Business }>("select state, state_note, business from ops.price_flags where flag_id = $1 for update", [id]);
  if (was === null) throw fail("No such flag.");
  if (was.state === "withdrawn") throw fail("That flag was withdrawn (the receipts it rested on changed): there is nothing to mark.");
  const same = was.state === state && (state === "new" || was.state_note === note);
  if (!same) {
    if (state === "new") await tx.query("update ops.price_flags set state = 'new', state_by = null, state_at = null, state_note = null where flag_id = $1", [id]);
    else await tx.query("update ops.price_flags set state = $2, state_by = $3, state_at = $4, state_note = $5 where flag_id = $1", [id, state, actor.staffId, now, note]);
    await audit.write(tx, { actorId: actor.staffId, action: "costs.flag_state", targetType: "price_flags", targetId: id, before: { state: was.state, note: was.state_note }, after: { state, note, business: was.business } }, { now });
  }
  const view = await tx.one<FlagRow>(`${FLAG_SELECT} where f.flag_id = $1`, [id]);
  return { flag: flagView(view), changed: !same, message: state === "price_raised" ? "Marked: price raised." : state === "seen" ? "Marked: seen." : "Marked new again." };
}

interface JoinView {
  id: string;
  code: string | null;
  name: string;
  joinedInto: string | null;
}

/**
 * Join `itemId` into `intoItemId` (the same business and supplier; the target is not itself joined; the
 * item has nothing joined into it), or undo the join with null. Nothing moves and nothing is erased:
 * the flags of the group are worked out again from the joined history, and the answer says so.
 * `{ itemId, intoItemId, reason }`.
 */
export async function joinItems(tx: Tx, input: { itemId?: unknown; intoItemId?: unknown; reason?: unknown }, actor: Actor, now: Date): Promise<{ item: JoinView; flagsRaised: number; flagsWithdrawn: number; message: string }> {
  const undoing = input.intoItemId === null;
  const fail = (m: string): Error => new Error(`${m} Nothing was ${undoing ? "undone" : "joined"}.`);
  mayAct(actor);
  const id = typeof input.itemId === "string" && ITEM_ID.test(input.itemId) ? input.itemId : null;
  if (id === null) throw fail("No such item.");
  const into = input.intoItemId === null ? null : typeof input.intoItemId === "string" && ITEM_ID.test(input.intoItemId) ? input.intoItemId : "";
  if (into === "") throw fail("No such item to join it into.");
  let reason: string;
  try {
    reason = checkLine(input.reason, "The reason", REASON_MIN, REASON_MAX, true) as string;
  } catch (e) {
    throw fail((e as Error).message);
  }
  await tx.query(LOCK);
  const item = await tx.maybeOne<{ item_id: string; business: Business; supplier_id: string; item_code: string | null; item_name: string; joined_into: string | null }>(
    "select item_id, business, supplier_id, item_code, item_name, joined_into from ops.supplier_items where item_id = $1 for update",
    [id],
  );
  if (item === null) throw fail("No such item.");
  const label = (n: string): string => `"${n}"`;
  if (into === null) {
    if (item.joined_into === null) throw fail(`${label(item.item_name)} is not joined into another item.`);
    await tx.query("update ops.supplier_items set joined_into = null, joined_by = null, joined_at = null, join_reason = null where item_id = $1", [id]);
    const flags = await reconcile(tx, [item.item_id, item.joined_into], "unjoin", now);
    await audit.write(tx, { actorId: actor.staffId, action: "costs.unjoin", targetType: "supplier_items", targetId: id, before: { joinedInto: item.joined_into }, after: { joinedInto: null, reason, business: item.business, flagsRaised: flags.raised, flagsWithdrawn: flags.withdrawn } }, { now });
    return {
      item: { id: item.item_id, code: item.item_code, name: item.item_name, joinedInto: null },
      flagsRaised: flags.raised.length,
      flagsWithdrawn: flags.withdrawn.length,
      message: `Separated again. Each item's history reads on its own, and its flags were worked out again (${plural(flags.withdrawn.length, "withdrawn", "withdrawn")}, ${plural(flags.raised.length, "raised", "raised")}).`,
    };
  }
  if (into === id) throw fail("An item cannot be joined into itself.");
  const target = await tx.maybeOne<{ item_id: string; business: Business; supplier_id: string; item_name: string; joined_into: string | null }>("select item_id, business, supplier_id, item_name, joined_into from ops.supplier_items where item_id = $1 for update", [into]);
  if (target === null) throw fail("No such item to join it into.");
  if (target.business !== item.business) throw fail(`These items belong to different businesses (${item.business} and ${target.business}): the two businesses' costs are never mixed.`);
  if (target.supplier_id !== item.supplier_id) throw fail("These items come from different suppliers: an item belongs to one supplier. Only a supplier's own spellings of one line can be joined.");
  if (item.joined_into !== null) throw fail(`${label(item.item_name)} is already joined into another item: undo that first.`);
  if (target.joined_into !== null) throw fail(`${label(target.item_name)} is itself joined into another item: join into that one instead.`);
  const followers = await tx.maybeOne<{ n: number }>("select count(*)::int as n from ops.supplier_items where joined_into = $1", [id]);
  if ((followers?.n ?? 0) > 0) throw fail(`Other items are joined into ${label(item.item_name)}: join those into ${label(target.item_name)} instead, or undo them first.`);
  await tx.query("update ops.supplier_items set joined_into = $2, joined_by = $3, joined_at = $4, join_reason = $5 where item_id = $1", [id, into, actor.staffId, now, reason]);
  const flags = await reconcile(tx, [into], "join", now);
  await audit.write(tx, { actorId: actor.staffId, action: "costs.join", targetType: "supplier_items", targetId: id, before: { joinedInto: null }, after: { joinedInto: into, reason, business: item.business, flagsRaised: flags.raised, flagsWithdrawn: flags.withdrawn } }, { now });
  return {
    item: { id: item.item_id, code: item.item_code, name: item.item_name, joinedInto: into },
    flagsRaised: flags.raised.length,
    flagsWithdrawn: flags.withdrawn.length,
    message: `Joined: ${label(item.item_name)} now reads as one with ${label(target.item_name)}. Its flags were worked out again over the joined history (${plural(flags.raised.length, "raised", "raised")}, ${plural(flags.withdrawn.length, "withdrawn", "withdrawn")}). Nothing was moved or erased, and it can be undone.`,
  };
}
