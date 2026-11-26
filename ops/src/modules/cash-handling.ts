// Cash handling: who is holding the store's cash, and the ledger of handovers that moves it on. The
// port of src/CashHandling.gs, every function it exports: sheetsExist, cashManager,
// getOutstandingForStaff, getAllOutstanding, getHistory, getPosition, record, voidHandover.
//
// A close takes cash out of the drawer (till_sessions.cash_removed_at_close); the cashier holds it until a
// handover (cash_handovers, with one cash_handover_items row per shift it settles) says it moved. A
// handover is never deleted: a void flips its status and the items stop counting (hard rule 9).
//
// How much a person holds (CashHandling.gs getOutstandingForStaff_, lines 200-240 of the old file):
//   for every closed or validated session of theirs:
//     cashTaken = roundMoney(cash_removed_at_close)       (a blank reads as 0, so it is not held)
//     remaining = roundMoney(cashTaken - settled)         settled = the items of handovers that are not voided
//     held when cashTaken > 0.005 and remaining > 0.005
//   total = the sum of the remaining, rounded at each step; the shifts are listed oldest first.
//
// Same as the old code, deliberately (each is in the card's report):
//   - a blank cash_removed_at_close reads as 0 (TillSessions: `numOrNull_(x) || 0`): that shift is not held;
//   - a blank method reads as 'cash', a blank status as 'recorded', blank notes / voided_by as '';
//   - a handover to oneself, to an inactive person, or from someone who holds nothing but with a recipient
//     named, is allowed; the cash manager is whoever cash_manager_staff_id names, with no check of their role;
//   - handedOn that cannot be read is today (not an error);
//   - the answers' dates are ISO strings (as before): a shift's `date` and a handover's `handedOn` are the
//     Toronto midnight of the stored day. The Sheet kept the time of day too; the table holds the date only.
//
// Where the Sheet took something the database refuses, the call is refused with a plain message after every
// refusal the old code had (deliberate differences, listed in the card's report): a method other than
// cash / bank / etransfer / other, a note with a NUL character, a handedOn the database cannot store.
//
// Writes: in the caller's transaction. `record` locks the cashier's staff row before it reads what they
// hold, so two handovers for one person at the same moment cannot both hand over the same cash: the second
// waits, then sees the first. `voidHandover` locks the handover's row before it reads it. Time is `now`.
//
// Order: the Sheet listed handovers in the order they were appended and sorted the history by the time
// recorded, newest first, ties newest-appended first. Here: `recorded_at desc` (blank last), then the
// order written (`seq desc`, migration 0006). A handover's items are listed in the order they were allocated: the shift's
// date, then start time, then id (the order `record` walks the shifts in).
import type { Db } from "../db/client";
import { lockRow, type Tx } from "../db/tx";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import { formatDate, parseDate, wallClock } from "../lib/dates";
import { newId } from "../lib/ids";
import { formatMoney, roundMoney } from "../lib/money";
import * as staff from "./staff";
import type { StaffRecord } from "./staff";
import * as tillSessions from "./till-sessions";
import type { TillSessionRecord } from "./till-sessions";

/** The methods the table accepts (its CHECK); the Sheet took any text, and the page only ever sends cash. */
export const METHODS: readonly string[] = ["cash", "bank", "etransfer", "other"];
const DAY_MS = 86_400_000;
const HALF_CENT = 0.005;

export interface UnsettledSession {
  sessionId: string;
  company: string;
  /** ISO instant of the shift's Toronto midnight, or null. */
  date: string | null;
  /** "YYYY-MM-DD", or ''. */
  dateStr: string;
  cashTaken: number;
  settled: number;
  remaining: number;
  ageDays: number;
}

export interface Outstanding {
  /** As given: a staff id that matches nobody is echoed back with nothing held. */
  staffId: unknown;
  totalOutstanding: number;
  unsettledSessions: UnsettledSession[];
}

export interface Holder {
  staffId: string;
  name: string;
  total: number;
  byCompany: Record<string, number>;
  shifts: number;
  shiftsByCompany: Record<string, number>;
  oldest: string;
  oldestAge: number;
}

export interface StaleShift {
  staffId: string;
  name: string;
  sessionId: string;
  company: string;
  dateStr: string;
  remaining: number;
  ageDays: number;
}

export interface AllOutstanding {
  holders: Holder[];
  grandTotal: number;
  grandByCompany: Record<string, number>;
  stale: StaleShift[];
  staleDays: number;
}

export interface HandoverItem {
  sessionId: string;
  amount: number;
  notes: string;
}

export interface Handover {
  handoverId: string;
  fromStaffId: string;
  fromName: string;
  toStaffId: string;
  toName: string;
  amount: number;
  handedOn: string | null;
  handedOnStr: string;
  recordedBy: string;
  recordedByName: string;
  recordedAt: string | null;
  method: string;
  status: string;
  notes: string;
  voidedBy: string;
  voidedByName: string;
  items: HandoverItem[];
}

export interface Position {
  enabled: boolean;
  cashManager?: { staffId: string; name: string } | null;
  isCashManager?: boolean;
  mine?: Outstanding;
  recent?: Handover[];
  holders?: Holder[];
  grandTotal?: number;
  grandByCompany?: Record<string, number>;
  stale?: StaleShift[];
  staleDays?: number;
  allRecent?: Handover[];
}

export interface RecordInput {
  fromStaffId?: unknown;
  amount?: unknown;
  actorId?: unknown;
  /** A day ("yyyy-MM-dd") or a date-time; blank or unreadable is today. */
  handedOn?: unknown;
  /** Defaults to the configured cash manager. */
  toStaffId?: unknown;
  /** Defaults to 'cash'. */
  method?: unknown;
  /** Required when the amount is short of the balance. */
  notes?: unknown;
}

export interface ItemCreated {
  itemId: string;
  sessionId: string;
  dateStr: string;
  company: string;
  amount: number;
  isPartial: boolean;
}

export interface RecordResult {
  handoverId: string;
  amount: number;
  itemsCreated: ItemCreated[];
  outstandingBefore: number;
  outstandingAfter: number;
}

interface HandoverRow {
  handover_id: string;
  from_staff_id: string;
  to_staff_id: string;
  amount: number | null;
  handed_on: string | null;
  recorded_by: string | null;
  recorded_at: Date | null;
  method: string | null;
  status: string | null;
  notes: string | null;
  voided_by: string | null;
  voided_at: Date | null;
}

interface ItemRow {
  handover_id: string;
  session_id: string;
  amount: number | null;
  notes: string | null;
}

const HANDOVER_COLUMNS = "handover_id, from_staff_id, to_staff_id, amount, handed_on, recorded_by, recorded_at, method, status, notes, voided_by, voided_at";
const trimmed = (v: string | null): string => (v || "").toString().trim();
const num0 = (v: number | null): number => Number(v) || 0;

/** A handover as the old hRowToRecord_ read it. */
interface HandoverRecord {
  handoverId: string;
  fromStaffId: string;
  toStaffId: string;
  amount: number;
  /** "YYYY-MM-DD", or null. */
  handedOn: string | null;
  recordedBy: string;
  recordedAt: Date | null;
  method: string;
  status: string;
  notes: string;
  voidedBy: string;
}

function toRecord(r: HandoverRow): HandoverRecord {
  return {
    handoverId: trimmed(r.handover_id),
    fromStaffId: trimmed(r.from_staff_id),
    toStaffId: trimmed(r.to_staff_id),
    amount: num0(r.amount),
    handedOn: r.handed_on,
    recordedBy: trimmed(r.recorded_by),
    recordedAt: r.recorded_at,
    method: (r.method || "cash").toString().trim(),
    status: (r.status || "recorded").toString().trim().toLowerCase(),
    notes: (r.notes || "").toString(),
    voidedBy: trimmed(r.voided_by),
  };
}

/** Text a database column can hold: a NUL character is refused by Postgres, and no id has one. */
const hasNul = (v: string): boolean => v.includes("\u0000");

/** Staff.getById for an id of any type: only a text id without a NUL can match. */
async function staffById(db: Db, id: unknown): Promise<StaffRecord | null> {
  if (typeof id !== "string" || hasNul(id)) return null;
  return staff.getById(db, id);
}

/** The Toronto midnight of a stored day, or null. */
function dayStart(day: string | null): Date | null {
  return day ? parseDate(day) : null;
}

// ── Settings and the feature flag ──────────────────────────

/**
 * Both tables exist. (The old flag was false until a Sheet menu item added the two tabs; the tables here come
 * with the schema, so this is always true. Kept so a caller reads as before.)
 */
export async function sheetsExist(_db: Db): Promise<boolean> {
  return true;
}

/**
 * The person who holds the business cash: cash_manager_staff_id, trimmed. Null when unset or pointing at
 * nobody on the staff list. (CashHandling.cashManager)
 */
export async function cashManager(db: Db, config: Config): Promise<StaffRecord | null> {
  const id = String(config.value("cash_manager_staff_id", "") || "").trim();
  if (!id) return null;
  return (await staffById(db, id)) || null;
}

/** cash_handover_stale_days: its own rule, a negative, zero or unreadable value is 7 (not `config.number`). */
function staleDays(config: Config): number {
  const n = Number(config.value("cash_handover_stale_days", "7"));
  return Number.isNaN(n) || n <= 0 ? 7 : n;
}

// ── What is settled ────────────────────────────────────────

/** How much has been handed over against each session; a voided handover counts for nothing. */
async function settledBySession(db: Db): Promise<Map<string, number>> {
  const rows = await db.query<{ session_id: string; amount: number | null }>(
    `select i.session_id, i.amount
       from ops.cash_handover_items i
       join ops.cash_handovers h on h.handover_id = i.handover_id
      where lower(btrim(h.status)) <> 'voided'
      order by i.item_id collate "C"`,
  );
  const map = new Map<string, number>();
  for (const it of rows) map.set(it.session_id, roundMoney((map.get(it.session_id) || 0) + num0(it.amount)));
  return map;
}

const isClosed = (s: TillSessionRecord): boolean => {
  const st = (s.status || "").toLowerCase();
  return st === "closed" || st === "validated";
};

function daysBetween(from: Date | null, to: Date): number {
  if (!from) return 0;
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}

/** One person's shifts still holding cash, oldest first, from sessions and settlements already read. */
function holding(sessions: readonly TillSessionRecord[], settled: ReadonlyMap<string, number>, staffId: unknown, now: Date): Outstanding {
  const unsettled: Array<UnsettledSession & { at: number }> = [];
  let total = 0;
  for (const s of sessions) {
    if (s.staffId !== staffId || !isClosed(s)) continue;
    // A session that removed nothing, or came up short of its float (negative), is skipped: counting it
    // would let a shortfall quietly reduce what the cashier owes.
    const cashTaken = roundMoney(s.cashRemovedAtClose || 0);
    if (cashTaken <= HALF_CENT) continue;
    const done = settled.get(s.sessionId) || 0;
    const remaining = roundMoney(cashTaken - done);
    if (remaining <= HALF_CENT) continue;
    const day = dayStart(s.date);
    unsettled.push({
      sessionId: s.sessionId,
      company: s.company,
      date: day ? day.toISOString() : null,
      dateStr: s.date ? s.date : "",
      cashTaken,
      settled: done,
      remaining,
      ageDays: daysBetween(day, now),
      at: day ? day.getTime() : 0,
    });
    total = roundMoney(total + remaining);
  }
  // Oldest first, the order the allocation walks; the sort is stable, so shifts of one day stay in the order they were opened.
  unsettled.sort((a, b) => a.at - b.at);
  return { staffId, totalOutstanding: total, unsettledSessions: unsettled.map(({ at: _at, ...s }) => s) };
}

// ── Balances ───────────────────────────────────────────────

/**
 * What `staffId` is still carrying, and which shifts it came from, oldest first. A blank id is refused.
 * (CashHandling.getOutstandingForStaff)
 */
export async function getOutstandingForStaff(db: Db, staffId: unknown, now: Date): Promise<Outstanding> {
  if (!staffId) throw new Error("staffId required");
  const settled = await settledBySession(db);
  const sessions = await tillSessions.getAll(db);
  return holding(sessions, settled, staffId, now);
}

/**
 * Every person holding cash, largest first, plus the shifts out for cash_handover_stale_days or longer.
 * Read once and worked out in memory. (CashHandling.getAllOutstanding)
 */
export async function getAllOutstanding(db: Db, config: Config, now: Date): Promise<AllOutstanding> {
  const limit = staleDays(config);
  const everyone = await staff.getAll(db);
  const settled = await settledBySession(db);
  const sessions = await tillSessions.getAll(db);
  const holders: Holder[] = [];
  const stale: StaleShift[] = [];
  const grandByCompany: Record<string, number> = {};
  let grandTotal = 0;

  for (const st of everyone) {
    const o = holding(sessions, settled, st.staffId, now);
    if (o.totalOutstanding <= HALF_CENT) continue;
    // A reporting split of what is in hand; settlement still walks every company's shifts oldest first.
    const byCompany: Record<string, number> = {};
    for (const s of o.unsettledSessions) {
      if (!s.company) continue;
      byCompany[s.company] = roundMoney((byCompany[s.company] || 0) + s.remaining);
      grandByCompany[s.company] = roundMoney((grandByCompany[s.company] || 0) + s.remaining);
    }
    const shiftsByCompany: Record<string, number> = {};
    for (const s of o.unsettledSessions) if (s.company) shiftsByCompany[s.company] = (shiftsByCompany[s.company] || 0) + 1;
    const first = o.unsettledSessions[0];
    holders.push({
      staffId: st.staffId,
      name: st.name,
      total: o.totalOutstanding,
      byCompany,
      shifts: o.unsettledSessions.length,
      shiftsByCompany,
      oldest: first ? first.dateStr : "",
      oldestAge: first ? first.ageDays : 0,
    });
    grandTotal = roundMoney(grandTotal + o.totalOutstanding);
    for (const s of o.unsettledSessions) {
      if (s.ageDays >= limit) {
        stale.push({ staffId: st.staffId, name: st.name, sessionId: s.sessionId, company: s.company, dateStr: s.dateStr, remaining: s.remaining, ageDays: s.ageDays });
      }
    }
  }

  holders.sort((a, b) => b.total - a.total);
  stale.sort((a, b) => b.ageDays - a.ageDays);
  return { holders, grandTotal, grandByCompany, stale, staleDays: limit };
}

// ── History ────────────────────────────────────────────────

/**
 * The newest handovers first (`limit || 25` of them, cut as `slice(0, limit)` cut: a decimal is truncated,
 * a negative drops rows from the end), each with names and its items, optionally those a person is a party
 * to. (CashHandling.getHistory)
 */
export async function getHistory(db: Db, limit?: number | null, staffId?: unknown): Promise<Handover[]> {
  const names = new Map((await staff.getAll(db)).map((s) => [s.staffId, s.name]));
  const rows = (
    await db.query<HandoverRow>(`select ${HANDOVER_COLUMNS} from ops.cash_handovers order by recorded_at desc nulls last, seq desc`)
  )
    .map(toRecord)
    .filter((h) => h.handoverId);
  const mine = staffId ? rows.filter((h) => h.fromStaffId === staffId || h.toStaffId === staffId) : rows;
  const chosen = mine.slice(0, limit || 25);

  const items = new Map<string, HandoverItem[]>();
  if (chosen.length) {
    const found = await db.query<ItemRow>(
      `select i.handover_id, i.session_id, i.amount, i.notes
         from ops.cash_handover_items i
         left join ops.till_sessions s on s.session_id = i.session_id
        where i.handover_id = any($1::text[])
        order by s.date nulls first, s.start_time nulls last, i.session_id collate "C", i.item_id collate "C"`,
      [chosen.map((h) => h.handoverId)],
    );
    for (const it of found) {
      const list = items.get(it.handover_id) || [];
      list.push({ sessionId: trimmed(it.session_id), amount: num0(it.amount), notes: (it.notes || "").toString() });
      items.set(it.handover_id, list);
    }
  }
  const name = (id: string): string => names.get(id) || id;
  return chosen.map((h) => {
    const day = dayStart(h.handedOn);
    return {
      handoverId: h.handoverId,
      fromStaffId: h.fromStaffId,
      fromName: name(h.fromStaffId),
      toStaffId: h.toStaffId,
      toName: name(h.toStaffId),
      amount: h.amount,
      handedOn: day ? day.toISOString() : null,
      handedOnStr: h.handedOn ? h.handedOn : "",
      recordedBy: h.recordedBy,
      recordedByName: name(h.recordedBy),
      recordedAt: h.recordedAt ? h.recordedAt.toISOString() : null,
      method: h.method,
      status: h.status,
      notes: h.notes,
      voidedBy: h.voidedBy,
      voidedByName: h.voidedBy ? name(h.voidedBy) : "",
      items: items.get(h.handoverId) || [],
    };
  });
}

// ── The page's payload ─────────────────────────────────────

/**
 * Everything the Cash Handling tab needs in one round trip. `privileged` decides whether the roster comes
 * back: the caller resolves it from the session, never from the client. (CashHandling.getPosition)
 */
export async function getPosition(db: Db, config: Config, staffId: string, privileged: boolean, now: Date): Promise<Position> {
  if (!(await sheetsExist(db))) return { enabled: false };
  const manager = await cashManager(db, config);
  const mine = await getOutstandingForStaff(db, staffId, now);
  const out: Position = {
    enabled: true,
    cashManager: manager ? { staffId: manager.staffId, name: manager.name } : null,
    isCashManager: !!(manager && manager.staffId === staffId),
    mine,
    recent: await getHistory(db, 10, staffId),
  };
  if (privileged) {
    const all = await getAllOutstanding(db, config, now);
    out.holders = all.holders;
    out.grandTotal = all.grandTotal;
    out.grandByCompany = all.grandByCompany;
    out.stale = all.stale;
    out.staleDays = all.staleDays;
    out.allRecent = await getHistory(db, 25, null);
  }
  return out;
}

// ── Record ─────────────────────────────────────────────────

/**
 * What the old toDate_ made of a handedOn: a Date as it is, a day ("yyyy-MM-dd") as its Toronto midnight,
 * any other text as `new Date(text)` reads it, and anything else, blank or unreadable as null. A date-time
 * with no zone is read as Toronto wall-clock time (as the old code, which ran in Toronto, read it).
 */
function readDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  let d: Date | null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d = parseDate(s);
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) d = parseDate(s.slice(0, 10));
  else d = new Date(s);
  return d === null || Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Record cash moving from a cashier to the cash manager (or a named recipient). Oldest shifts are settled
 * first, each filled before the next. The cashier's staff row is locked first, so a second handover for the
 * same person waits for this one to commit and then sees what it settled. (CashHandling.record)
 *
 * Refuses, in this order: no cashier, no actor, an amount that is not positive, an unknown cashier, no
 * recipient (and no cash manager configured), an unknown recipient, an actor who is neither party nor an
 * admin, more than is held, a part-handover with no reason; then (new) a method, note or date the database
 * cannot hold.
 */
export async function record(db: Tx, config: Config, input: RecordInput | null | undefined, now: Date, random?: () => number): Promise<RecordResult> {
  const inp: RecordInput = input || {};
  if (!inp.fromStaffId) throw new Error("fromStaffId required");
  if (!inp.actorId) throw new Error("actorId required");
  const amount = roundMoney(Number(inp.amount) || 0);
  if (amount <= 0) throw new Error("amount must be a positive number");

  // Serialise handovers for one person: everything below reads what they hold and then writes against it.
  if (typeof inp.fromStaffId === "string" && !hasNul(inp.fromStaffId)) await lockRow(db, "staff", inp.fromStaffId);
  const from = await staffById(db, inp.fromStaffId);
  if (!from) throw new Error("Staff not found: " + String(inp.fromStaffId));

  const manager = await cashManager(db, config);
  const toStaffId = String(inp.toStaffId || (manager && manager.staffId) || "").trim();
  if (!toStaffId) {
    throw new Error("No cash manager configured — set cash_manager_staff_id in the config tab to the staff_id of whoever holds the business cash.");
  }
  const to = await staffById(db, toStaffId);
  if (!to) throw new Error("Recipient not found: " + toStaffId);

  // Either party may record it; an admin can record on anyone's behalf.
  const actor = await staffById(db, inp.actorId);
  const actorIsParty = inp.actorId === inp.fromStaffId || inp.actorId === toStaffId;
  if (!actorIsParty && (!actor || actor.role !== "admin")) {
    throw new Error("Only " + from.name + ", the cash manager, or an admin can record this handover");
  }

  const before = await getOutstandingForStaff(db, inp.fromStaffId, now);
  if (amount > before.totalOutstanding + HALF_CENT) {
    throw new Error(from.name + " is holding " + formatMoney(before.totalOutstanding) + ", so " + formatMoney(amount) + " cannot be handed over.");
  }

  const notes = String(inp.notes || "").trim();
  const leftover = roundMoney(before.totalOutstanding - amount);
  if (leftover > HALF_CENT && !notes) {
    throw new Error(formatMoney(leftover) + " would stay in " + from.name + "'s hands. Please give a reason.");
  }

  const handedOn = readDate(inp.handedOn) || now;
  const handoverId = newId("H", { now, random, chars: 10 });

  // Allocate oldest first, filling each shift before moving on.
  const itemsCreated: ItemCreated[] = [];
  const itemRows: Array<[string, string, string, number]> = [];
  let remaining = amount;
  for (let i = 0; i < before.unsettledSessions.length && remaining > HALF_CENT; i++) {
    const s = before.unsettledSessions[i] as UnsettledSession;
    const take = roundMoney(Math.min(remaining, s.remaining));
    if (take <= HALF_CENT) continue;
    const itemId = newId("CI", { now, random, chars: 10 });
    itemRows.push([itemId, handoverId, s.sessionId, take]);
    itemsCreated.push({ itemId, sessionId: s.sessionId, dateStr: s.dateStr, company: s.company, amount: take, isPartial: take < s.remaining - HALF_CENT });
    remaining = roundMoney(remaining - take);
  }
  if (remaining > HALF_CENT) {
    // Unreachable (the guard above covers it), but a silent unallocated remainder is the bug worth shouting about.
    throw new Error("Could not allocate " + formatMoney(remaining) + " — nothing to apply it to");
  }

  // What the Sheet took and the table cannot hold.
  const method = inp.method || "cash";
  if (typeof method !== "string" || !METHODS.includes(method)) throw new Error("method must be cash, bank, etransfer or other");
  if (hasNul(notes)) throw new Error("notes cannot contain a null character");
  const year = wallClock(handedOn).year;
  const utcYear = handedOn.getUTCFullYear();
  if (!(year >= 1 && year <= 9999 && utcYear >= 1 && utcYear <= 9999)) throw new Error("handedOn is not a date this app can store");
  const actorId = String(inp.actorId);
  if (hasNul(actorId)) throw new Error("actorId cannot contain a null character");

  await db.query(
    `insert into ops.cash_handovers (${HANDOVER_COLUMNS})
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'recorded', $9, null, null)`,
    [handoverId, inp.fromStaffId, toStaffId, amount, formatDate(handedOn), actorId, now, method, notes === "" ? null : notes],
  );
  if (itemRows.length) {
    const values = itemRows.map((_, i) => `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, null)`).join(", ");
    await db.query(`insert into ops.cash_handover_items (item_id, handover_id, session_id, amount, notes) values ${values}`, itemRows.flat());
  }

  await audit.write(
    db,
    {
      actorId,
      action: "cash.handover",
      targetType: "cash_handovers",
      targetId: handoverId,
      after: { from: inp.fromStaffId, to: toStaffId, amount, sessions: itemsCreated.length, stillOut: leftover, notes },
      details:
        from.name +
        " → " +
        to.name +
        " " +
        formatMoney(amount) +
        ", recorded by " +
        ((actor && actor.name) || actorId) +
        (leftover > HALF_CENT ? ", " + formatMoney(leftover) + " still out" : ""),
    },
    { now },
  );

  return { handoverId, amount, itemsCreated, outstandingBefore: before.totalOutstanding, outstandingAfter: leftover };
}

// ── Void ───────────────────────────────────────────────────

/**
 * Reverse a handover without erasing it: the row stays, its status flips, and its items stop counting, so the
 * balance returns to exactly what it was with the mistake still legible. The handover's row is locked first,
 * so two voids at once leave one audit row and the second is told it is already voided. (CashHandling.voidHandover)
 */
export async function voidHandover(db: Tx, handoverId: string | null | undefined, actorId: string | null | undefined, now: Date): Promise<{ handoverId: string; status: "voided"; amount: number }> {
  if (!handoverId) throw new Error("handoverId required");
  if (!actorId) throw new Error("actorId required");
  const id: unknown = handoverId;

  let h: HandoverRecord | null = null;
  if (typeof id === "string" && !hasNul(id)) {
    await lockRow(db, "cash_handovers", id);
    const row = await db.maybeOne<HandoverRow>(`select ${HANDOVER_COLUMNS} from ops.cash_handovers where handover_id = $1`, [id]);
    h = row ? toRecord(row) : null;
  }
  if (!h) throw new Error("Handover not found: " + String(id));
  if (h.status === "voided") throw new Error("Handover is already voided");

  const by = String(actorId);
  if (hasNul(by)) throw new Error("actorId cannot contain a null character");
  await db.query("update ops.cash_handovers set status = 'voided', voided_by = $2, voided_at = $3 where handover_id = $1", [id, by, now]);

  await audit.write(
    db,
    {
      actorId: by,
      action: "cash.handover.void",
      targetType: "cash_handovers",
      targetId: id as string,
      before: { amount: h.amount, from: h.fromStaffId, to: h.toStaffId, recordedBy: h.recordedBy },
      details: "Voided " + formatMoney(h.amount) + " handover recorded by " + h.recordedBy,
    },
    { now },
  );

  return { handoverId: id as string, status: "voided", amount: h.amount };
}
