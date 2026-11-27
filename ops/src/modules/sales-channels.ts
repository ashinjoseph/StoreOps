// Sales by channel (card P5-03b): the vape till's own figures for a range of days, in its three channels
// (in store, online, delivery), shown BESIDE what cashiers typed at close, never mixed with it.
// A NEW ability of the Operations app (ADR-0023, ADR-0024): nothing in the Apps Script app does this, so
// ops/test/sales-channels.test.ts is its specification.
//
// Two parts:
//   - the pure part (`summarise`, `parseRange`): the till's rows in, the answer's figures out. Money is
//     added in whole cents (`cents` from the till rules), never as floats, and written out as numbers
//     with two decimals made from cents. A channel the till did not report is null ("no figures"), never
//     0; a channel reported as 0 is 0.
//   - the thin part (`get`): one live, read-only call to the till for the range, inside the same 8-second
//     budget P5-02b keeps, and the app's own vape total for the same days from the existing sales reader.
//
// Nothing is stored and nothing is written: no row of the database changes and nothing is sent to the till.
// The store asked of the till is the one matched in `ops.till_stores`, never a value from the input.
// When the till cannot be read `get` still answers (a state and a message in P5-02b's words, no figures);
// only a request that makes no sense (a bad or future date) throws, before any call.
//
// The rows are the till's, kept as sent. What the arithmetic rules (till/rules.ts) say of them:
//   - checkDailyRow's warning (the takings do not add up to the sales total: the till's "To check"): the
//     row is counted as the till reports it and its day is listed in `toCheck`.
//   - any rule's error (net or total do not add up, a method's net, a refund with the wrong sign, a
//     delivery object on another channel, a second row for one day and channel, a day outside the range
//     asked for): the row is still counted exactly as sent, `brokenRows` is true and one line is logged.
//     Nothing is dropped and nothing is corrected.
import type { Db } from "../db/client";
import type { Config } from "../lib/config";
import { maybeSecret } from "../lib/config";
import { addDays, daysBetween, isRealDay, torontoDay } from "../till/days";
import { tillBaseUrl } from "../till/address";
import { MAX_SPAN_DAYS } from "../till/client";
import { tillClientFor } from "../till/index";
import { cents, checkDailyRow, checkDailyRows } from "../till/rules";
import type { DailyRow } from "../till/types";
import { BUDGET_MS, CLIENT_MAX_WAIT_MS, CLIENT_TIMEOUT_MS, MESSAGES, explain, type TillDeps, type TillState } from "./till-link";
import * as sales from "./sales";
import * as dashboard from "./sales-dashboard";

/** A little under the budget, so a sleep that returns early is told from the budget running out. */
const DEADLINE_SLACK_MS = 20;
/** The business the till's figures are for. The app's own total is the same business's. */
export const COMPANY = "vape";

export type ChannelsState = TillState | "no_store";

export const NO_STORE_MESSAGE = "The till's store is not matched to this store yet (Staff, Till logins).";

// ── Money, in cents ────────────────────────────────────────

/** Whole cents as a number with two decimals (-5 -> -0.05). Never -0. */
export function fromCents(c: number): number {
  return c === 0 ? 0 : Number((c / 100).toFixed(2));
}

// ── The figures ────────────────────────────────────────────

/**
 * What is shown for one channel over some days. Chosen from the contract's SalesSummary and Takings:
 *   total       what customers paid, less refunds, after HST: the till's own "total"
 *   net         after discounts, before HST (before the card surcharge and cash rounding as well)
 *   hst         the HST in it
 *   refunds     refunds in money (the takings' refunds_total over the five methods): zero or negative
 *   count       sales
 *   refundCount refunds
 *   days        how many days reported this channel
 * Delivery adds `orders` and `fees` (the fees are before HST and are INSIDE net and total).
 */
export interface Figures {
  total: number;
  net: number;
  hst: number;
  refunds: number;
  count: number;
  refundCount: number;
  days: number;
}
export interface DeliveryFigures extends Figures {
  orders: number;
  fees: number;
}
export interface ChannelSet {
  till: Figures | null;
  online: Figures | null;
  delivery: DeliveryFigures | null;
  all: Figures | null;
}

interface Acc {
  rows: number;
  days: Set<string>;
  total: number;
  net: number;
  hst: number;
  refunds: number;
  count: number;
  refundCount: number;
  orders: number;
  fees: number;
}
const acc = (): Acc => ({ rows: 0, days: new Set(), total: 0, net: 0, hst: 0, refunds: 0, count: 0, refundCount: 0, orders: 0, fees: 0 });

const METHODS = ["cash", "credit", "debit", "etransfer", "other"] as const;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

/** Adds one row into an accumulator; a figure that is not a number is left out (and the caller says so). */
function add(a: Acc, row: DailyRow): boolean {
  let clean = true;
  a.rows += 1;
  a.days.add(row.business_day);
  const s: Record<string, unknown> = isObj(row.sales_summary) ? (row.sales_summary as unknown as Record<string, unknown>) : {};
  for (const [field, key] of [["total", "total"], ["net", "net"], ["hst", "hst"]] as const) {
    const c = cents(s[field]);
    if (c === null) clean = false;
    else a[key] += c;
  }
  const count = whole(s.count);
  const refundCount = whole(s.refund_count);
  if (count === null || refundCount === null) clean = false;
  else {
    a.count += count;
    a.refundCount += refundCount;
  }
  const t: Record<string, unknown> = isObj(row.takings) ? (row.takings as unknown as Record<string, unknown>) : {};
  for (const m of METHODS) {
    const c = isObj(t[m]) ? cents((t[m] as Record<string, unknown>).refunds_total) : null;
    if (c === null) clean = false;
    else a.refunds += c;
  }
  if (row.channel === "delivery" && isObj(row.delivery)) {
    const orders = whole(row.delivery.orders);
    const fees = cents(row.delivery.fees);
    if (orders === null || fees === null) clean = false;
    else {
      a.orders += orders;
      a.fees += fees;
    }
  }
  return clean;
}

const figures = (a: Acc): Figures | null =>
  a.rows === 0 ? null : { total: fromCents(a.total), net: fromCents(a.net), hst: fromCents(a.hst), refunds: fromCents(a.refunds), count: a.count, refundCount: a.refundCount, days: a.days.size };
const deliveryFigures = (a: Acc): DeliveryFigures | null => {
  const f = figures(a);
  return f === null ? null : { ...f, orders: a.orders, fees: fromCents(a.fees) };
};

function tally(rows: readonly DailyRow[]): { set: ChannelSet; clean: boolean } {
  const by = { till: acc(), online: acc(), delivery: acc(), all: acc() };
  let clean = true;
  for (const row of rows) {
    const target = row.channel === "till" || row.channel === "online" || row.channel === "delivery" ? by[row.channel] : null;
    if (target === null) {
      clean = false; // a channel this app does not know: not counted anywhere, and said so
      continue;
    }
    if (!add(target, row)) clean = false;
    add(by.all, row);
  }
  return { set: { till: figures(by.till), online: figures(by.online), delivery: deliveryFigures(by.delivery), all: figures(by.all) }, clean };
}

export interface Summary {
  channels: ChannelSet;
  /** The same figures for `day` alone, or null when no day was asked for. */
  day: ChannelSet | null;
  /** Days (ascending) with a row whose takings do not add up to its total. */
  toCheck: string[];
  /** A rule's error was found in some row. The row is still counted as sent. */
  brokenRows: boolean;
  /** Where (paths into the till's answer, no values): for the one log line. */
  brokenPaths: string[];
}

/**
 * The till's rows as the answer's figures. Pure. `from` and `to` are the range asked of the till (the
 * rows are checked against it); `day` is the selected day or null.
 */
export function summarise(rows: readonly DailyRow[], range: { from: string; to: string }, day: string | null): Summary {
  const toCheck = new Set<string>();
  const brokenPaths: string[] = [];
  rows.forEach((row, i) => {
    for (const d of checkDailyRow(row, `days[${i}]`)) {
      if (d.severity === "warning") toCheck.add(row.business_day);
      else brokenPaths.push(d.path);
    }
  });
  for (const d of checkDailyRows(rows, range.from, range.to, "days")) if (d.severity === "error") brokenPaths.push(d.path);

  const all = tally(rows);
  const one = day === null ? null : tally(rows.filter((r) => r.business_day === day));
  return {
    channels: all.set,
    day: one === null ? null : one.set,
    toCheck: [...toCheck].sort(),
    brokenRows: brokenPaths.length > 0 || !all.clean || (one !== null && !one.clean),
    brokenPaths: [...new Set(brokenPaths)],
  };
}

// ── The range ──────────────────────────────────────────────

export interface Range {
  from: string;
  to: string;
  /** The range asked for was longer than the till answers in one request: it was cut at the start. */
  clamped: boolean;
}

/**
 * The range as it will be asked of the till, or a message for the person. The contract: `to` not after
 * today, and `to` at most 91 days after `from` (92 days in all). A longer range keeps the NEWEST 92 days
 * (the start moves up) and says so (`clamped`), because the days the screen is for are the recent ones.
 * `day`, when given, must lie in the range asked for; if the cut has taken it off the front, it is null.
 */
export function parseRange(input: { from: string; to: string; day: string | null }, today: string): { range: Range; day: string | null } {
  if (!isRealDay(input.from) || !isRealDay(input.to)) throw new Error("The dates must be real days written yyyy-mm-dd.");
  if (input.day !== null && !isRealDay(input.day)) throw new Error("The day must be a real day written yyyy-mm-dd.");
  if (input.from > input.to) throw new Error("The start date is after the end date.");
  if (input.to > today) throw new Error(`The end date is in the future (today is ${today}); the till has no figures for days to come.`);
  if (input.day !== null && (input.day < input.from || input.day > input.to)) throw new Error("The day must be inside the range.");
  const clamped = daysBetween(input.from, input.to) > MAX_SPAN_DAYS;
  const from = clamped ? addDays(input.to, -MAX_SPAN_DAYS) : input.from;
  const day = input.day !== null && input.day < from ? null : input.day;
  return { range: { from, to: input.to, clamped }, day };
}

// ── The answer ─────────────────────────────────────────────

export interface SalesByChannel {
  state: ChannelsState;
  message: string;
  range: Range;
  /** Null unless the till answered. When it did, a channel with no rows is null: "no figures", not zeros. */
  channels: ChannelSet | null;
  day: ChannelSet | null;
  /** What cashiers entered at close for the vape till over the same days (null total: no closes). */
  enteredAtClose: { total: number | null; days: number };
  toCheck: string[];
  brokenRows: boolean;
}

export interface SalesChannelsDeps extends TillDeps {
  /** One line, no audit row: nothing was done. Default: none. */
  log?: (entry: object) => void;
}

/** The app's own vape sales for the days, from the existing reader, added in cents. */
async function enteredAtClose(db: Db, range: Range): Promise<{ total: number | null; days: number }> {
  const rows = await dashboard.readRows(db, range.from, range.to, { company: COMPANY });
  let total = 0;
  const days = new Set<string>();
  for (const r of rows) {
    total += cents(sales.totalForRow(r)) ?? 0;
    if (r.date !== null) days.add(r.date);
  }
  return { total: rows.length === 0 ? null : fromCents(total), days: days.size };
}

interface TillStoreRow {
  till_store_id: string;
}

function isSetUp(config: Config, env: Readonly<Record<string, unknown>>): boolean {
  return tillBaseUrl(config.value("till_api_url")) !== null && maybeSecret(env, "till_api_key") !== null;
}

type Read = { state: Exclude<ChannelsState, "ok">; message: string; rows: null } | { state: "ok"; message: string; rows: DailyRow[] };

async function readDaily(deps: TillDeps, storeId: string, range: Range): Promise<Read> {
  const client = tillClientFor(deps.env, deps.config, {
    fetch: deps.fetch,
    sleep: deps.sleep,
    now: () => new Date(deps.now.getTime() + deps.elapsedMs()),
    timeoutMs: CLIENT_TIMEOUT_MS,
    maxWaitMs: CLIENT_MAX_WAIT_MS,
  });
  const stop = new AbortController();
  const unread = (state: Exclude<ChannelsState, "ok">, message: string): Read => ({ state, message, rows: null });
  try {
    const work = client.dailySales({ storeId, from: range.from, to: range.to });
    work.catch(() => undefined); // the client never rejects; if the budget wins, a late answer is not news
    const budget = deps.sleep(BUDGET_MS, stop.signal).then(
      () => "budget" as const,
      () => "budget" as const,
    );
    let first: Awaited<typeof work> | "budget" = await Promise.race([work, budget]);
    // A sleep that returns before the time is up (a stub that does not wait) is not the budget running out.
    while (first === "budget") {
      if (deps.elapsedMs() >= BUDGET_MS - DEADLINE_SLACK_MS) return unread("unreachable", MESSAGES.budget);
      first = await work;
    }
    if (!first.ok) {
      const why = explain(first.error);
      return unread(why.state, why.message);
    }
    return { state: "ok", message: MESSAGES.ok, rows: first.data.days };
  } catch {
    return unread("bad_answer", MESSAGES.badAnswer);
  } finally {
    stop.abort();
  }
}

/**
 * The vape till's sales by channel for `input.from`..`input.to` (and `input.day`), beside what was typed
 * at close. Throws (a message for the person) only for a request that makes no sense; never for the
 * till's sake.
 */
export async function get(db: Db, input: { from: string; to: string; day: string | null }, deps: SalesChannelsDeps): Promise<SalesByChannel> {
  const { range, day } = parseRange(input, torontoDay(deps.now));
  const entered = await enteredAtClose(db, range);
  const base = { range, channels: null, day: null, enteredAtClose: entered, toCheck: [] as string[], brokenRows: false };
  const answer = (state: Exclude<ChannelsState, "ok">, message: string): SalesByChannel => ({ ...base, state, message });

  if (!deps.config.boolean("till_enabled")) return answer("off", MESSAGES.off);
  if (!isSetUp(deps.config, deps.env)) return answer("not_configured", explain({ kind: "not_configured", message: "" }).message);
  // One till store is used today (Operations has one store): the first match made, as the Staff screen reads it.
  const matched = (await db.query<TillStoreRow>("select till_store_id::text as till_store_id from ops.till_stores where ended_at is null order by matched_at, match_id limit 1"))[0];
  if (matched === undefined) return answer("no_store", NO_STORE_MESSAGE);

  const read = await readDaily(deps, matched.till_store_id.toLowerCase(), range);
  if (read.state !== "ok") return answer(read.state, read.message);

  const s = summarise(read.rows, range, day);
  if (s.brokenRows && deps.log !== undefined) deps.log({ event: "sales_channels.rows_rejected", from: range.from, to: range.to, where: s.brokenPaths.slice(0, 20) });
  return { ...base, state: "ok", message: read.message, channels: s.channels, day: s.day, toCheck: s.toCheck, brokenRows: s.brokenRows };
}
