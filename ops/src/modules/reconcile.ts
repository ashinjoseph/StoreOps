// Reconcile: the port of src/Reconcile.gs, every function. The day's closed tills, cash counted
// against expected and cards against Clover; one validation_results row per merchant group; the
// WhatsApp close report; and the history the dashboard and the public report read.
//
// Exported, under the old names without the underscore: reconcileDay, getRecent,
// hasOpenSessionsToday (the old public three), and the pure builders the old tests reach through
// reconcileDay: signed, hhmm, mark, describeSend, blank, numOrNull, opKeyFor, shapeFor, staffParam,
// inHandParam, lottoParam, statusParam, reconParams, destination, reserveLines, formatMessage,
// reportUrl. A builder that read a setting takes the settings snapshot as its first argument.
//
// What a run does (Reconcile.gs reconcileDay_, lines 90-306), in the old order:
//   1. "the day" is today in Toronto; its sessions are TillSessions.getForDateRange(today).
//   2. auto: any session still open → { ready:false, openCount } and nothing else happens.
//   3. closed = status 'closed' or 'validated' (exact case). auto: minus the session ids already in
//      a validation_results row of today; manual (force): all of them. None → { ready:true, empty:true }.
//   4. group by Clover merchant id ('NOCONFIG:<company>' when there is none); per group sum the
//      sales rows' card and cash figures and the sessions' cash figures (blank reads as 0 there).
//   5. per group, in order: Clover's card totals for the group's window (when enabled), the status,
//      the record. Then ONE insert of every group's row.
//   6. the WhatsApp report, one message per group (Notifier.sendOp with the template's own shape).
//   7. one audit row `reconcile.day` naming the mode, the send outcome and the whole plain text.
//
// Same as the old code, deliberately (each is in the card's report): the sales and session figures
// read a blank as 0 when they are SUMMED (ADR-0004 allows sums); the history reads a blank
// cashier_card, cash_sales, cash_counted and cash_variance as 0 (`Number(x) || 0`); a Clover payment
// with no amount counts as $0; the minor variance band is "investigate" here (one threshold).
//
// Deliberate differences: the run takes a transaction-scoped advisory lock on the business date
// before it reads what is already reconciled, so two runs at once write the day once; a mode other
// than 'auto' or 'manual', or a figure the table cannot hold, is refused with a plain message before
// anything is written (the Sheet took either).
//
// Writes go through the caller's transaction (the router's). The outbound requests (Clover, then
// WhatsApp) are made inside it, in the old order, so the transaction is held open while they run:
// at worst (50 Clover pages + one WhatsApp request per recipient) × 10 seconds per merchant group.
//
// Order of the history (getRecent): the Sheet sorted by validated_at, newest first, ties in the
// order the rows were appended: `seq` (migration 0008).
import type { Db } from "../db/client";
import { DbError } from "../db/client";
import type { Tx } from "../db/tx";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import type { ConfigKey } from "../lib/config-keys";
import { endOfDay, formatDate, todayMidnight, wallClock } from "../lib/dates";
import { newId } from "../lib/ids";
import { formatMoney, roundMoney } from "../lib/money";
import * as cashHandling from "./cash-handling";
import * as clover from "./clover";
import * as notifier from "./notifier";
import * as sales from "./sales";
import * as staff from "./staff";
import * as tillSessions from "./till-sessions";

export interface ReconcileDeps {
  config: Config;
  /** The Worker's bindings: the Clover and WhatsApp tokens live here. */
  env: Readonly<Record<string, unknown>>;
  /** Outbound HTTP (Clover, Meta). Never the global `fetch`. */
  fetch: typeof fetch;
  now: Date;
  /** The random part of the row ids (tests pin it). Default: crypto. */
  random?: () => number;
}

export type Mode = "auto" | "manual";

export interface LottoLine {
  balance: number | null;
  expected: number;
  shortfall: number;
  note: string;
}

/** One merchant group's result, as Reconcile.gs built `rec` (windowStart/End are Dates, sent as ISO strings). */
export interface ReconRecord {
  merchant: string;
  companies: string[];
  windowStart: Date;
  windowEnd: Date;
  sessionIds: string[];
  cardSplit: boolean;
  cloverNA: boolean;
  cardsVerified: boolean;
  cashierCredit: number | null;
  cloverCredit: number | null;
  creditDiff: number | null;
  cashierDebit: number | null;
  cloverDebit: number | null;
  debitDiff: number | null;
  cashierCard: number;
  cloverCard: number | null;
  cardDiff: number | null;
  cashSales: number;
  cashCounted: number;
  cashVariance: number;
  openingFloat: number;
  cashBanked: number;
  floatLeft: number;
  lottoTopup: number;
  staffNames: string[];
  tookCash: { name: string; amount: number }[];
  cashOutTotal: number | null;
  cashOutHolders: { name: string; total: number }[] | null;
  cashOutStale: number;
  lotto: LottoLine | null;
  cloverOk: boolean;
  cloverError: string;
  status: "OK" | "investigate" | "clover_unavailable";
}

/** A send's outcome per group: what was attempted, then the Notifier's answer. */
export type GroupSend = { companies: string; template: string; params: number } & ({ sent: boolean } & Record<string, unknown>);
export interface SendSummary {
  sent: boolean;
  perGroup?: GroupSend[];
  reason?: string;
  detail?: string;
}

export type ReconcileResult =
  | { ready: false; openCount: number }
  | { ready: true; empty: true }
  | { ready: true; mode: string; date: string; merchants: ReconRecord[]; whatsapp: SendSummary; whatsappSummary: string };

/** The same shape as the record the old builders read; tests build these by hand. */
export type MessageRecord = Partial<ReconRecord> & { companies: string[] };

// ── Small helpers (Reconcile.gs lines 46-56, 325-332) ──────

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number): string => String(n).padStart(2, "0");

/** Utilities.formatDate(d, 'America/Toronto', 'EEE d MMM yyyy'): "Fri 20 Nov 2026". */
function friendlyDate(d: Date): string {
  const w = wallClock(d);
  return `${DOW[w.dow]} ${w.day} ${MON[w.month - 1]} ${w.year}`;
}

/** "+$1.50" / "-$40.00", rounded first. */
export function signed(n: unknown): string {
  const r = roundMoney(n);
  return (r < 0 ? "-" : "+") + "$" + Math.abs(r).toFixed(2);
}

/** "HH:mm" in Toronto for a Date, "—" for anything else. */
export function hhmm(d: unknown): string {
  if (!(d instanceof Date)) return "—";
  const w = wallClock(d);
  return `${p2(w.hour)}:${p2(w.minute)}`;
}

/** ✅ when |d| is within card_variance_threshold (`Number(x) || 1`), else ⚠️. */
export function mark(config: Config, d: unknown): string {
  const threshold = config.number("card_variance_threshold", 1);
  return Math.abs(roundMoney(d)) <= threshold ? "✅" : "⚠️";
}

/** null → an empty cell (NULL here). Zero would claim a measurement that never happened. */
export function blank<T>(v: T | null | undefined): T | null {
  return v === null || v === undefined ? null : v;
}

/** The inverse of blank: an empty cell is "not measured", not zero. */
export function numOrNull(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** `Number(x) || 0` (kept: the history reads these four columns that way). */
const num0 = (v: unknown): number => Number(v) || 0;

/** A DB error inside the transaction cannot be swallowed: the commit would fail anyway. */
function rethrowDb(e: unknown): void {
  if (e instanceof DbError) throw e;
}

// ── Open sessions and what is already reconciled (lines 58-83) ──

/** Is any till still open today? (Reconcile.hasOpenSessionsToday) */
export async function hasOpenSessionsToday(db: Db, now: Date): Promise<boolean> {
  const today = todayMidnight(now);
  const sessions = (await tillSessions.getForDateRange(db, today, endOfDay(today))) || [];
  return sessions.some((s) => s.status === "open");
}

/** Session ids already covered by a row of `dateStr` (so the next auto run skips them). */
async function reconciledSessionIds(db: Db, dateStr: string): Promise<Set<string>> {
  const rows = await db.query<{ session_ids: string | null }>("select session_ids from ops.validation_results where business_date = $1", [dateStr]);
  const set = new Set<string>();
  for (const r of rows) {
    for (const id of (r.session_ids || "").toString().split(",")) {
      const t = id.trim();
      if (t) set.add(t);
    }
  }
  return set;
}

// ── The run (lines 85-306) ─────────────────────────────────

interface Group {
  merchant: clover.Merchant;
  companies: Record<string, true>;
  sessionIds: string[];
  cashierCredit: number;
  cashierDebit: number;
  cashierCardOnly: number;
  anyUnsplit: boolean;
  cashSales: number;
  cashCounted: number;
  cashVariance: number;
  openingFloat: number;
  cashBanked: number;
  floatLeft: number;
  lottoTopup: number;
  tookCash: Record<string, number>;
  staff: Record<string, true>;
  startMs: number;
  endMs: number;
}

/** numeric(12,2) holds less than 10^10. */
const MONEY_LIMIT = 1e10;

/** A money figure the table can hold, or a plain refusal (the Sheet held anything). */
function storable(name: string, v: number | null): number | null {
  if (v === null) return null;
  if (!Number.isFinite(v) || Math.abs(v) >= MONEY_LIMIT) throw new Error(`Reconcile: ${name} (${v}) is too large to store`);
  return v;
}

const INSERT_COLUMNS =
  "validation_id, business_date, window_start, window_end, merchant, companies, cashier_credit, clover_credit, cashier_debit, clover_debit, cashier_card, clover_card, card_variance, cash_counted, cash_variance, status, mode, session_ids, validated_at, validated_by, cash_sales";
const INSERT_WIDTH = 21;

/**
 * Reconcile the shift that just closed (auto) or the whole day (manual). (Reconcile.reconcileDay)
 * `db` is the caller's transaction. Never throws for Clover or WhatsApp: both are reported.
 */
export async function reconcileDay(db: Tx, deps: ReconcileDeps, actorId: string | null | undefined, mode: string): Promise<ReconcileResult> {
  // No Clover gate here. The close message reports CASH for every till and cards only where
  // Clover measures them; notifier_enabled is the switch for messages, clover_enabled only decides
  // whether cards are checked (Reconcile.gs lines 91-95).
  if (mode !== "auto" && mode !== "manual") throw new Error("Reconcile: mode must be 'auto' or 'manual'");
  const config = deps.config;
  const now = deps.now;
  const today = todayMidnight(now);
  const todayEnd = endOfDay(today);
  const dateStr = formatDate(today);

  // DELIBERATE ADDITION: one run of a day at a time. Taken before anything is read, so a second
  // run waits here and then sees the first one's rows (auto skips them).
  await db.query("select pg_advisory_xact_lock(hashtextextended('ops.reconcile.day:' || $1, 0))", [dateStr]);

  const sessions = (await tillSessions.getForDateRange(db, today, todayEnd)) || [];
  const openCount = sessions.filter((s) => s.status === "open").length;
  if (mode !== "manual" && openCount > 0) return { ready: false, openCount };

  let closed = sessions.filter((s) => s.status === "closed" || s.status === "validated");
  // Auto: only the sessions not yet reconciled (this shift). Manual: all.
  if (mode !== "manual") {
    const done = await reconciledSessionIds(db, dateStr);
    closed = closed.filter((s) => !done.has(s.sessionId));
  }
  if (closed.length === 0) return { ready: true, empty: true };

  // Card per session from the sales rows (1:1 with sessions; a later row wins, as before).
  const salesById = new Map<string, sales.SalesRecord>();
  for (const r of (await sales.getForDateRange(db, today, todayEnd, null)) || []) salesById.set(r.sessionId, r);

  // Group the in-scope sessions by Clover merchant.
  const groups = new Map<string, Group>();
  for (const s of closed) {
    const m = clover.merchantFor({ config, env: deps.env }, s.company);
    const key = m.merchantId || "NOCONFIG:" + s.company;
    let g = groups.get(key);
    if (!g) {
      g = {
        merchant: m,
        companies: {},
        sessionIds: [],
        cashierCredit: 0,
        cashierDebit: 0,
        cashierCardOnly: 0,
        anyUnsplit: false,
        cashSales: 0,
        cashCounted: 0,
        cashVariance: 0,
        openingFloat: 0,
        cashBanked: 0,
        floatLeft: 0,
        lottoTopup: 0,
        tookCash: {},
        staff: {},
        startMs: Infinity,
        endMs: 0,
      };
      groups.set(key, g);
    }
    g.companies[s.company] = true;
    g.sessionIds.push(s.sessionId);
    g.staff[s.staffId] = true;
    // Who walked out with what, today (the standing balance is CashHandling's question).
    if ((s.cashRemovedAtClose || 0) > 0.005) {
      g.tookCash[s.staffId] = roundMoney((g.tookCash[s.staffId] || 0) + s.cashRemovedAtClose);
    }
    const sale = salesById.get(s.sessionId);
    if (sale) {
      g.cashierCredit += (sale.creditCardSales || 0) + (sale.miscCreditSales || 0);
      g.cashierDebit += (sale.debitCardSales || 0) + (sale.miscDebitSales || 0);
      // A till that doesn't split reports one card figure: it counts toward the card total only.
      g.cashierCardOnly += (sale.cardTotalSales || 0) + (sale.miscCardSales || 0);
      if (sale.cardSplit === false) g.anyUnsplit = true;
      g.cashSales += (sale.cashSales || 0) + (sale.miscCashSales || 0);
    }
    g.cashCounted += s.closingCashCounted || 0;
    g.cashVariance += s.closingVariance || 0;
    g.openingFloat += s.openingFloat || 0;
    // Where the counted cash went: flows, so they add up across sessions.
    g.cashBanked += s.cashRemovedAtClose || 0;
    g.floatLeft += s.cashLeftInTill || 0;
    g.lottoTopup += s.lottoTopupFromTill || 0;
    if (s.startTime instanceof Date) g.startMs = Math.min(g.startMs, s.startTime.getTime());
    if (s.endTime instanceof Date) g.endMs = Math.max(g.endMs, s.endTime.getTime());
  }

  const threshold = config.number("card_variance_threshold", 1);
  const merchants: ReconRecord[] = [];

  // The lotto pot is one balance held by the store, read once and hung off the group holding cstore.
  let lotto: Awaited<ReturnType<typeof tillSessions.getLottoLog>> | null = null;
  try {
    const log = await tillSessions.getLottoLog(db, 14, { config, now });
    if (log && log.enabled) lotto = log;
  } catch (e) {
    rethrowDb(e);
  }

  // Standing cash-in-hand across the whole business, read once.
  let cashOut: cashHandling.AllOutstanding | null = null;
  try {
    if (await cashHandling.sheetsExist(db)) cashOut = await cashHandling.getAllOutstanding(db, config, now);
  } catch (e) {
    rethrowDb(e);
  }

  // staff_id → display name, for the "who worked" line.
  const staffNames: Record<string, string> = {};
  try {
    for (const st of await staff.getAll(db)) staffNames[st.staffId] = st.name;
  } catch (e) {
    rethrowDb(e);
  }

  const cloverOn = clover.isEnabled(config);
  for (const g of groups.values()) {
    // Fall back to the day if a session is missing a timestamp.
    const startMs = Number.isFinite(g.startMs) ? g.startMs : today.getTime();
    const endMs = g.endMs > 0 ? g.endMs : now.getTime();

    const cashierCredit = roundMoney(g.cashierCredit);
    const cashierDebit = roundMoney(g.cashierDebit);
    const cashierCard = roundMoney(cashierCredit + cashierDebit + g.cashierCardOnly);
    const cardSplit = !g.anyUnsplit;

    const totals: clover.CardTotals = cloverOn ? await clover.getCardTotals({ fetch: deps.fetch }, g.merchant, startMs, endMs) : { ok: false, error: "disabled" };

    // "Not configured" is not "unavailable"; switched off is the same as not configured.
    const cloverNA = !totals.ok && (totals.error === "not_configured" || totals.error === "disabled");
    const cardsVerified = totals.ok;

    // Nothing to compare against: blank rather than 0 (ADR-0004).
    const cloverCredit = totals.ok ? totals.credit : null;
    const cloverDebit = totals.ok ? totals.debit : null;
    const cloverCard = totals.ok ? totals.total : null;
    const cardDiff = totals.ok ? roundMoney(cashierCard - totals.total) : null;

    // The roll-up covers the CASH too.
    const cashThreshold = config.number("variance_ok_threshold", 1);
    const cashOff = Math.abs(roundMoney(g.cashVariance)) > cashThreshold;
    const cardsOff = cardsVerified && Math.abs(cardDiff as number) > threshold;
    const status: ReconRecord["status"] = cloverNA ? (cashOff ? "investigate" : "OK") : !totals.ok ? "clover_unavailable" : cashOff || cardsOff ? "investigate" : "OK";

    const companies = Object.keys(g.companies);
    merchants.push({
      merchant: g.merchant.merchantId || "(not configured)",
      companies,
      windowStart: new Date(startMs),
      windowEnd: new Date(endMs),
      sessionIds: g.sessionIds.slice(),
      cardSplit,
      cloverNA,
      cardsVerified,
      cashierCredit: cardSplit ? cashierCredit : null,
      cloverCredit,
      creditDiff: cardsVerified && cardSplit ? roundMoney(cashierCredit - (cloverCredit as number)) : null,
      cashierDebit: cardSplit ? cashierDebit : null,
      cloverDebit,
      debitDiff: cardsVerified && cardSplit ? roundMoney(cashierDebit - (cloverDebit as number)) : null,
      cashierCard,
      cloverCard,
      cardDiff,
      cashSales: roundMoney(g.cashSales),
      cashCounted: roundMoney(g.cashCounted),
      cashVariance: roundMoney(g.cashVariance),
      openingFloat: roundMoney(g.openingFloat),
      cashBanked: roundMoney(g.cashBanked),
      floatLeft: roundMoney(g.floatLeft),
      lottoTopup: roundMoney(g.lottoTopup),
      staffNames: Object.keys(g.staff)
        .map((id) => staffNames[id] || id)
        .sort(),
      tookCash: Object.keys(g.tookCash)
        .map((id) => ({ name: staffNames[id] || id, amount: g.tookCash[id] as number }))
        .sort((a, b) => b.amount - a.amount),
      // Business-wide; null (not []) means the tables aren't there.
      cashOutTotal: cashOut ? cashOut.grandTotal : null,
      cashOutHolders: cashOut ? cashOut.holders.map((h) => ({ name: h.name, total: h.total })) : null,
      cashOutStale: cashOut ? cashOut.stale.length : 0,
      // Only the group that actually holds cstore carries the pot.
      lotto:
        lotto && g.companies[tillSessions.LOTTO_COMPANY]
          ? {
              balance: lotto.lastCounted,
              expected: lotto.expected,
              shortfall: roundMoney(lotto.expected - (lotto.lastCounted || 0)),
              note: (lotto.entries[0] && lotto.entries[0].note) || "",
            }
          : null,
      cloverOk: !!totals.ok,
      cloverError: totals.ok ? "" : totals.error || "",
      status,
    });
  }

  await writeRows(db, today, merchants, mode, actorId, now, deps.random);

  const message = formatMessage(config, today, merchants);
  let whatsapp: SendSummary = { sent: false, reason: "not_attempted" };
  try {
    whatsapp = await sendNotifications(db, deps, today, merchants);
  } catch (e) {
    rethrowDb(e);
    whatsapp = { sent: false, reason: "exception", detail: e instanceof Error ? e.message : String(e) };
  }

  await audit.write(
    db,
    {
      actorId: actorId || "SYSTEM",
      action: "reconcile.day",
      targetType: "validation_results",
      targetId: dateStr,
      details: "mode=" + mode + "; whatsapp=" + describeSend(whatsapp) + "; " + message.replace(/\n/g, " | "),
    },
    { now },
  );

  return { ready: true, mode, date: dateStr, merchants, whatsapp, whatsappSummary: describeSend(whatsapp) };
}

/** Every group's row, in one statement. (writeRow_, lines 334-349) */
async function writeRows(db: Tx, today: Date, merchants: readonly ReconRecord[], mode: Mode, actorId: string | null | undefined, now: Date, random?: () => number): Promise<void> {
  if (merchants.length === 0) return;
  const dateStr = formatDate(today);
  const params: unknown[] = [];
  for (const rec of merchants) {
    params.push(
      newId("VR", { now, random, chars: 10 }),
      dateStr,
      rec.windowStart,
      rec.windowEnd,
      rec.merchant,
      rec.companies.join("+"),
      // Blank, not 0, wherever a figure was not measured.
      storable("cashier credit", blank(rec.cashierCredit)),
      storable("Clover credit", blank(rec.cloverCredit)),
      storable("cashier debit", blank(rec.cashierDebit)),
      storable("Clover debit", blank(rec.cloverDebit)),
      storable("cashier card", rec.cashierCard),
      storable("Clover card", blank(rec.cloverCard)),
      storable("card variance", blank(rec.cardDiff)),
      storable("cash counted", rec.cashCounted),
      storable("cash variance", rec.cashVariance),
      rec.status,
      mode,
      rec.sessionIds.join(","),
      now,
      actorId || "SYSTEM",
      storable("cash sales", rec.cashSales),
    );
  }
  const values = merchants.map((_, i) => "(" + Array.from({ length: INSERT_WIDTH }, (_x, k) => `$${i * INSERT_WIDTH + k + 1}`).join(", ") + ")").join(", ");
  await db.query(`insert into ops.validation_results (${INSERT_COLUMNS}) values ${values}`, params);
}

// ── The WhatsApp report (lines 308-396) ────────────────────

/**
 * One readable line about the send, for the audit row and the page. Names the template and the
 * parameter count on a failure. (describeSend_)
 */
export function describeSend(w: SendSummary | null | undefined): string {
  if (!w) return "no result";
  const groups = (w.perGroup || []).map((g) => {
    const head = g.companies + " → " + g.template + "(" + g.params + ")";
    if (g.sent) return head + " sent";
    const why = (g["reason"] as string | undefined) || "not sent";
    const results = (g["results"] as { detail?: string }[] | undefined) || [];
    const detail = results.map((x) => x.detail).filter(Boolean)[0];
    return head + " FAILED " + why + (detail ? " — " + detail : "");
  });
  return groups.length ? groups.join(" ; ") : w.reason || "nothing to send";
}

/** The template setting of a close message for one till, if there is one in the registry. */
function closeTemplateKey(company: string): ConfigKey | null {
  if (company === "cstore") return "whatsapp_template_shift_close_cstore";
  if (company === "vape") return "whatsapp_template_shift_close_vape";
  return null;
}

/**
 * Which close template this group uses: a single till's own when its key is set, else the shared
 * shift_close. (opKeyFor_)
 */
export function opKeyFor(config: Config, m: Pick<MessageRecord, "companies">): notifier.OpKey {
  if (m.companies && m.companies.length === 1) {
    const company = m.companies[0] as string;
    const key = closeTemplateKey(company);
    if (key && config.value(key, "")) return ("shift_close_" + company) as notifier.OpKey;
  }
  return "shift_close";
}

async function sendNotifications(db: Tx, deps: ReconcileDeps, dateObj: Date, merchants: readonly ReconRecord[]): Promise<SendSummary> {
  let anySent = false;
  const perGroup: GroupSend[] = [];
  for (const m of merchants) {
    const opKey = opKeyFor(deps.config, m);
    const params = reconParams(deps.config, dateObj, m, shapeFor(opKey));
    const plain = formatMessage(deps.config, dateObj, [m]);
    let r: notifier.SendResult | { sent: false; reason: "exception"; detail: string };
    try {
      r = await notifier.sendOp({ config: deps.config, env: deps.env, fetch: deps.fetch, db, now: deps.now }, opKey, params, plain);
    } catch (e) {
      rethrowDb(e);
      r = { sent: false, reason: "exception", detail: e instanceof Error ? e.message : String(e) };
    }
    if (r && r.sent) anySent = true;
    // Carry what was ATTEMPTED alongside the outcome (template name and parameter count).
    perGroup.push(Object.assign({ companies: m.companies.join("+"), template: opKey, params: params.length }, r || {}) as GroupSend);
  }
  return { sent: anySent, perGroup };
}

/** Who worked this till today. */
export function staffParam(m: Pick<MessageRecord, "staffNames">): string {
  const names = m.staffNames || [];
  return names.length ? names.join(", ") : "no staff recorded";
}

/** Who is carrying cash, by name: the standing balance, else today's takings. */
export function inHandParam(m: Pick<MessageRecord, "cashOutHolders" | "cashOutStale" | "tookCash">): string {
  if (m.cashOutHolders && m.cashOutHolders.length) {
    const parts = m.cashOutHolders.map((h) => h.name + " " + formatMoney(h.total));
    if (m.cashOutStale) {
      parts.push("⚠️ " + m.cashOutStale + (m.cashOutStale === 1 ? " shift" : " shifts") + " held over the limit");
    }
    return parts.join(" · ");
  }
  if (m.cashOutHolders) return "nobody is holding cash";
  const took = m.tookCash || [];
  return took.length ? took.map((t) => t.name + " " + formatMoney(t.amount)).join(" · ") + " (today)" : "nothing taken out today";
}

/** The pot, as one line. A till without a reserve says so. */
export function lottoParam(m: Pick<MessageRecord, "lotto" | "lottoTopup">): string {
  if (!m.lotto) return "not tracked on this till";
  const short = Number(m.lotto.shortfall) || 0;
  let s = m.lotto.balance == null ? "not counted yet" : formatMoney(m.lotto.balance);
  if ((m.lottoTopup || 0) > 0.01) s += " (+" + formatMoney(m.lottoTopup) + " moved in)";
  if (short > 0.01) {
    s += " - short " + formatMoney(short);
    if (m.lotto.note) s += " - " + m.lotto.note;
  }
  return s;
}

/** The bottom line, naming what is wrong. */
export function statusParam(config: Config, m: Pick<MessageRecord, "cardsVerified" | "cloverNA" | "cashVariance" | "cardDiff">): string {
  if (!m.cardsVerified && !m.cloverNA) return "⚠️ Clover unavailable - cards not verified";
  const cashThreshold = config.number("variance_ok_threshold", 1);
  const cardThreshold = config.number("card_variance_threshold", 1);
  const problems: string[] = [];
  const cashVar = Number(m.cashVariance) || 0;
  if (Math.abs(cashVar) > cashThreshold) {
    problems.push("cash " + (cashVar < 0 ? "short " : "over ") + formatMoney(Math.abs(cashVar)));
  }
  const cardVar = m.cardsVerified ? Number(m.cardDiff) || 0 : 0;
  if (m.cardsVerified && Math.abs(cardVar) > cardThreshold) {
    problems.push("cards off " + formatMoney(Math.abs(cardVar)));
  }
  if (problems.length) return "⚠️ " + problems.join(" · ");
  return m.cardsVerified ? "✅ All matched" : "✅ Cash matched";
}

export type Shape = "cards_unverified" | "cards_checked" | "legacy";

/** The parameter shape a template expects: a property of the TEMPLATE, never of runtime state (ADR-0007). */
export function shapeFor(opKey: string): Shape {
  if (opKey === "shift_close_cstore") return "cards_unverified"; // 11
  if (opKey === "shift_close_vape") return "cards_checked"; // 12
  return "legacy"; // 13
}

/** The ordered body parameters of a close template, sized by `shape`. (reconParams_) */
export function reconParams(config: Config, dateObj: Date, m: MessageRecord, shape: Shape): string[] {
  const legacy = shape === "legacy";
  const friendly = friendlyDate(dateObj);
  const windowStr = hhmm(m.windowStart) + "–" + hhmm(m.windowEnd);
  const companies = m.companies.join(" + ");
  const cashCounted = m.cashCounted as number;
  const cashVariance = m.cashVariance as number;
  const cashSales = m.cashSales as number;
  const cashierCard = m.cashierCard as number;
  const recorded = roundMoney(cashCounted - cashVariance);
  const reported = roundMoney(cashSales + cashierCard);

  const cashLine = formatMoney(recorded) + " / " + formatMoney(cashCounted) + " (var " + signed(cashVariance) + ") " + mark(config, cashVariance);

  // No card verification (cstore on ePOS): eleven parameters.
  if (shape === "cards_unverified") {
    const revenue = roundMoney(cashSales + cashierCard);
    return [
      friendly, // {{1}}
      companies, // {{2}}
      windowStr, // {{3}}
      staffParam(m), // {{4}}
      formatMoney(revenue) + " — cash " + formatMoney(cashSales) + " · card " + formatMoney(cashierCard), // {{5}}
      cashLine, // {{6}}
      destination(m), // {{7}}
      inHandParam(m), // {{8}}
      lottoParam(m), // {{9}}
      formatMoney(cashierCard) + " — single total, not independently verified", // {{10}}
      statusParam(config, m), // {{11}}
    ];
  }

  let totalLine: string;
  let credit: string;
  let debit: string;
  let total: string;
  if (m.cloverOk) {
    // Measured MINUS claimed, so negative always means money missing.
    const openingFloat = m.openingFloat as number;
    const cloverCard = m.cloverCard as number;
    const counted = roundMoney(cashCounted - openingFloat + cloverCard);
    const totalDiff = roundMoney(counted - reported);
    totalLine = "reported " + formatMoney(reported) + " / counted " + formatMoney(counted) + " (var " + signed(totalDiff) + ") " + mark(config, totalDiff);
    const cc = m.cloverCredit as number;
    const cd = m.cloverDebit as number;
    credit = formatMoney(m.cashierCredit) + " / " + formatMoney(cc) + " (var " + signed(cc - (m.cashierCredit as number)) + ") " + mark(config, m.creditDiff);
    debit = formatMoney(m.cashierDebit) + " / " + formatMoney(cd) + " (var " + signed(cd - (m.cashierDebit as number)) + ") " + mark(config, m.debitDiff);
    total = formatMoney(cashierCard) + " / " + formatMoney(cloverCard) + " (var " + signed(cloverCard - cashierCard) + ") " + mark(config, m.cardDiff);
  } else {
    totalLine = "reported " + formatMoney(reported) + " (no Clover)";
    credit = formatMoney(m.cashierCredit) + " (cashier, no Clover)";
    debit = formatMoney(m.cashierDebit) + " (cashier, no Clover)";
    total = formatMoney(cashierCard) + " (cashier, no Clover)";
  }
  const status = statusParam(config, m);

  const base = [
    friendly, // {{1}}
    companies, // {{2}}
    windowStr, // {{3}}
    staffParam(m), // {{4}}
    totalLine, // {{5}}
    cashLine, // {{6}}
    destination(m), // {{7}}
    inHandParam(m), // {{8}}
  ];
  // {{9}} only where a pot exists, except on the shared template, which has a fixed slot for it.
  if (legacy || (shape !== "cards_checked" && m.lotto)) base.push(lottoParam(m));
  return base.concat([credit, debit, total, status]);
}

/** Where the counted cash went, on one line. (destination_) */
export function destination(m: Pick<MessageRecord, "cashBanked" | "floatLeft" | "lottoTopup">): string {
  const banked = m.cashBanked || 0;
  if (banked < -0.01) {
    return "drawer closed " + formatMoney(-banked) + " below the " + formatMoney(m.floatLeft || 0) + " float · nothing in hand";
  }
  const parts = ["float " + formatMoney(m.floatLeft || 0) + " back"];
  if ((m.lottoTopup || 0) > 0.01) parts.push("reserve " + formatMoney(m.lottoTopup));
  parts.push(formatMoney(banked) + " in hand");
  return parts.join(" · ");
}

/** The lotto pot's lines in the plain-text message. (reserveLines_) */
export function reserveLines(m: Pick<MessageRecord, "lotto" | "lottoTopup">): string[] {
  if (!m.lotto) return [];
  const l = m.lotto;
  if (l.balance == null) {
    return ["\u{1F39F} *Lotto reserve*   no count on record yet"];
  }
  const short = Number(l.shortfall) || 0;
  const out = ["\u{1F39F} *Lotto reserve*   " + formatMoney(l.balance) + (short > 0.01 ? "   ⚠️ short " + formatMoney(short) : "")];
  if ((m.lottoTopup || 0) > 0.01) {
    out.push("\u{21B3} " + formatMoney(m.lottoTopup) + " moved in from till today");
  }
  if (short > 0.01 && l.note) out.push("\u{21B3} " + l.note);
  return out;
}

/** The plain-text message (the fallback body, and the audit row's text). (formatMessage_) */
export function formatMessage(config: Config, dateObj: Date, merchants: readonly MessageRecord[]): string {
  const friendly = friendlyDate(dateObj);

  const lines = ["\u{1F9FE} *Shift Reconciliation*", "\u{1F4C5} " + friendly, ""];
  for (const m of merchants) {
    const cashSales = m.cashSales as number;
    const cashierCard = m.cashierCard as number;
    const cashCounted = m.cashCounted as number;
    lines.push("\u{1F3EA} *" + m.companies.join(" + ") + "*   \u{23F0} " + hhmm(m.windowStart) + "–" + hhmm(m.windowEnd));
    lines.push("\u{1F464} " + staffParam(m));
    lines.push("");
    const reported = roundMoney(cashSales + cashierCard);
    if (m.cloverOk) {
      const counted = roundMoney(cashCounted - (m.openingFloat as number) + (m.cloverCard as number));
      const totalDiff = roundMoney(counted - reported);
      lines.push("Σ *Total sales*  reported " + formatMoney(reported) + " / counted " + formatMoney(counted) + "   var " + signed(totalDiff) + " " + mark(config, totalDiff));
    } else if (m.cloverNA) {
      // Descriptive, not comparative: the cash line below carries the verdict.
      lines.push("Σ *Total sales*  " + formatMoney(reported) + "   cash " + formatMoney(cashSales) + " · card " + formatMoney(cashierCard));
    } else {
      lines.push("Σ *Total sales*  reported " + formatMoney(reported) + "   (no Clover)");
    }
    lines.push("");
    lines.push("\u{1F4B5} *Cash - recorded / counted*");
    const recorded = roundMoney(cashCounted - (m.cashVariance as number));
    lines.push(formatMoney(recorded) + " / " + formatMoney(cashCounted) + "   var " + signed(m.cashVariance));
    lines.push("\u{21B3} " + destination(m));
    lines.push("");
    lines.push("\u{1F91D} *Cash in hand*");
    lines.push("\u{21B3} " + inHandParam(m));
    lines.push("");
    const reserve = reserveLines(m);
    if (reserve.length) {
      for (const l of reserve) lines.push(l);
      lines.push("");
    }
    if (m.cloverOk) {
      const cc = m.cloverCredit as number;
      const cd = m.cloverDebit as number;
      const ct = m.cloverCard as number;
      lines.push("\u{1F4B3} *Cards - cashier / Clover*");
      lines.push("Credit  " + formatMoney(m.cashierCredit) + " / " + formatMoney(cc) + "   var " + signed(cc - (m.cashierCredit as number)) + " " + mark(config, m.creditDiff));
      lines.push("Debit   " + formatMoney(m.cashierDebit) + " / " + formatMoney(cd) + "   var " + signed(cd - (m.cashierDebit as number)) + " " + mark(config, m.debitDiff));
      lines.push("Total   " + formatMoney(cashierCard) + " / " + formatMoney(ct) + "   var " + signed(ct - cashierCard) + " " + mark(config, m.cardDiff));
      lines.push("");
      lines.push("*" + statusParam(config, m) + "*");
    } else if (m.cloverNA) {
      // No Clover by design. Report the figure; claim no check.
      lines.push("\u{1F4B3} *Cards*  " + formatMoney(cashierCard) + "   (single total, not verified)");
      lines.push("");
      lines.push("*" + statusParam(config, m) + "*");
    } else {
      lines.push("\u{1F4B3} *Cards*  cashier " + formatMoney(cashierCard) + "   ⚠️ Clover unavailable");
    }
    lines.push("");
  }
  // Plain text has no buttons, so the link goes in as a line; omitted when unconfigured.
  const url = reportUrl(config);
  if (url) {
    lines.push("\u{1F4C8} Sales dashboard: " + url);
    lines.push("");
  }
  lines.push("_StoreOps · automated_");
  return lines.join("\n").trim();
}

/** The public SALES report link (`?v=sales` appended), or '' when not configured. (reportUrl_) */
export function reportUrl(config: Config): string {
  const base = (config.value("public_report_url", "") || "").toString().trim();
  if (!base) return "";
  return base + (base.indexOf("?") === -1 ? "?v=sales" : "&v=sales");
}

// ── The history (lines 714-756) ────────────────────────────

/** One reconciliation as the dashboard and the public report read it. */
export interface RecentRow {
  businessDate: string;
  windowStart: string | null;
  windowEnd: string | null;
  merchant: string;
  companies: string;
  cashierCredit: number | null;
  cloverCredit: number | null;
  cashierDebit: number | null;
  cloverDebit: number | null;
  cashierCard: number;
  cloverCard: number | null;
  cardVariance: number | null;
  cashSales: number;
  cashCounted: number;
  cashVariance: number;
  status: string;
  mode: string;
  validatedAt: string | null;
  validatedBy: string;
}

interface VrRow {
  business_date: string | null;
  window_start: Date | null;
  window_end: Date | null;
  merchant: string | null;
  companies: string | null;
  cashier_credit: number | null;
  clover_credit: number | null;
  cashier_debit: number | null;
  clover_debit: number | null;
  cashier_card: number | null;
  clover_card: number | null;
  card_variance: number | null;
  cash_counted: number | null;
  cash_variance: number | null;
  status: string | null;
  mode: string | null;
  validated_at: Date | null;
  validated_by: string | null;
  cash_sales: number | null;
}

const RECENT_COLUMNS =
  "business_date, window_start, window_end, merchant, companies, cashier_credit, clover_credit, cashier_debit, clover_debit, cashier_card, clover_card, card_variance, cash_counted, cash_variance, status, mode, validated_at, validated_by, cash_sales";
const RECENT_ORDER = "order by validated_at desc nulls last, seq";

const iso = (d: Date | null): string | null => (d instanceof Date ? d.toISOString() : null);
const text = (v: string | null): string => (v || "").toString();

/**
 * Recent reconciliations, newest first (by validated_at), `limit || 60` of them, cut as
 * `slice(0, limit)` cuts: a decimal is truncated, a negative drops rows from the oldest end.
 * Blank card figures read back as null, never 0. (Reconcile.getRecent)
 */
export async function getRecent(db: Db, limit?: number | null): Promise<RecentRow[]> {
  const n = limit || 60;
  // A positive finite limit is the query's own; anything else (a negative, Infinity) needs every row.
  const bounded = Number.isFinite(n) && n > 0;
  const rows = bounded
    ? await db.query<VrRow>(`select ${RECENT_COLUMNS} from ops.validation_results ${RECENT_ORDER} limit $1`, [Math.trunc(n)])
    : await db.query<VrRow>(`select ${RECENT_COLUMNS} from ops.validation_results ${RECENT_ORDER}`);
  const all = rows.map(
    (r): RecentRow => ({
      businessDate: text(r.business_date),
      windowStart: iso(r.window_start),
      windowEnd: iso(r.window_end),
      merchant: text(r.merchant),
      companies: text(r.companies),
      cashierCredit: numOrNull(r.cashier_credit),
      cloverCredit: numOrNull(r.clover_credit),
      cashierDebit: numOrNull(r.cashier_debit),
      cloverDebit: numOrNull(r.clover_debit),
      cashierCard: num0(r.cashier_card),
      cloverCard: numOrNull(r.clover_card),
      cardVariance: numOrNull(r.card_variance),
      cashSales: num0(r.cash_sales),
      cashCounted: num0(r.cash_counted),
      cashVariance: num0(r.cash_variance),
      status: text(r.status),
      mode: text(r.mode),
      validatedAt: iso(r.validated_at),
      validatedBy: text(r.validated_by),
    }),
  );
  return bounded ? all : all.slice(0, n);
}
