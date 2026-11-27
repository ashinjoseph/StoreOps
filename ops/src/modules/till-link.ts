// The till link, as people use it (card P5-02b): match each Operations person to their till login, match
// the till's store to Operations' store, and warn before the till's key expires. The first code that calls
// the till from a request. A NEW ability of the Operations app (ADR-0023, ADR-0024): nothing in the Apps
// Script app does this, so ops/test/till-link.test.ts is its specification.
//
// The till is only READ. Nothing here sends anything to it: every call is one of the client's GETs
// (`listStores`, `listStaff`), made through `tillClientFor`, the one place that holds the key and the
// rules for using it. This file never sees the key, never builds an address and never names a method.
// Everything it keeps is in Operations' own database: `ops.till_stores` and `ops.till_staff_links`
// (migration 0011). Nothing is deleted: a match is ended, with who and when, and the row stays.
//
// What is matched, and by whom: a person at the screen decides; the app only suggests (equal names,
// ignoring case and repeated spaces). Nothing is matched automatically, and nothing is created from the
// till's side: a till person with no match is listed from the live answer and stays the till's business.
// Sign-in stays Operations' own (name and PIN): the till has no part in it.
//
// When the till cannot be read (switched off, not set up, down, slow, refusing the key, answering
// nonsense) `get` still answers: a state and a message in plain words, the stored matches, no matching.
// It never throws for the till's sake. One call to the till per endpoint per RPC, all inside one time
// budget (BUDGET_MS) that covers waiting out a 429 as well. The writes that need the till to be read NOW
// (matching a store, matching a person) refuse with that same message, and write nothing.
//
// Locks (inside the router's one transaction): a person's matching locks their staff row FIRST (as
// staff-admin and payments do), then one advisory lock for the whole link (LINK_LOCK), then reads what it
// checks and writes. Two admins matching the same till login to two different people hold different
// staff rows, so the advisory lock is what makes the second read the first's committed row. The partial
// unique indexes of the tables are the last guard; they should never be what refuses.
//
// Time is the caller's `now` plus `elapsedMs()` for the budget; no clock, timer, environment or
// randomness is read here, and SQL takes values as parameters only. The caller supplies `sleep`.
import type { Tx } from "../db/tx";
import { lockRow } from "../db/tx";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import { formatDate } from "../lib/dates";
import type { Sleep } from "../till/client";
import { daysBetween, isRealDay } from "../till/days";
import { tillClientFor } from "../till/index";
import { NIL_STAFF_ID, type StaffMember, type Store, type TillError } from "../till/types";

/** The whole RPC, from the first call to the till to the answer. */
export const BUDGET_MS = 8_000;
/** One request to the till: a little under the budget, so its own timeout answers before the budget's. */
export const CLIENT_TIMEOUT_MS = 7_500;
/** What the client may wait out of a 429 (Retry-After), in all. */
export const CLIENT_MAX_WAIT_MS = 3_000;
/** The warning starts this many days before the key's day. */
export const WARN_DAYS = 14;
const DEADLINE_SLACK_MS = 20;

export const REASON_MIN = 3;
export const REASON_MAX = 300;

const LINK_LOCK = "select pg_advisory_xact_lock(hashtextextended('ops.till_link', 0))";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// ── The key's expiry ───────────────────────────────────────

export interface KeyExpiry {
  /** The day typed into the setting `till_key_expires_on`, or null (blank, or not a real date). */
  day: string | null;
  /** Toronto calendar days from today to `day` (0 on the day, negative after). Null when no day. */
  daysLeft: number | null;
  /** Show the warning: from 14 days before the day, on it and after it; or no date while the link is on. */
  warn: boolean;
  /** A real date is recorded. */
  recorded: boolean;
  /** The sentence for the screen when `warn`, else null. */
  message: string | null;
}

const NEW_KEY = "Make a new key in the till's Office and install it, then change the date in Settings.";

/**
 * The warning about the till key's expiry. Pure: the setting and "now" are the only inputs. Days are
 * Toronto calendar days (so a clock-change day is one day, not 23 or 25 hours). 14 days before: warn;
 * 15: not. The day itself and after: warn. A blank (or unreadable) date warns only while the link is
 * switched on. No message is sent anywhere: this is shown on screens.
 */
export function keyExpiryWarning(config: Config, now: Date): KeyExpiry {
  const text = config.value("till_key_expires_on").trim();
  const enabled = config.boolean("till_enabled");
  if (!isRealDay(text)) {
    return {
      day: null,
      daysLeft: null,
      warn: enabled,
      recorded: false,
      message: !enabled
        ? null
        : text === ""
          ? "The key's expiry date is not recorded: type it into Settings (Till) when a key is installed."
          : "The key's expiry date in Settings is not a real date: type it again as yyyy-mm-dd.",
    };
  }
  const daysLeft = daysBetween(formatDate(now), text);
  const warn = daysLeft <= WARN_DAYS;
  if (!warn) return { day: text, daysLeft, warn, recorded: true, message: null };
  const message =
    daysLeft > 1
      ? `The till's key expires on ${text} (in ${daysLeft} days). ${NEW_KEY}`
      : daysLeft === 1
        ? `The till's key expires tomorrow (${text}). ${NEW_KEY}`
        : daysLeft === 0
          ? `The till's key expires today (${text}). ${NEW_KEY}`
          : `The till's key expired on ${text} (${-daysLeft} ${daysLeft === -1 ? "day" : "days"} ago): the link will not work until a new one is installed. ${NEW_KEY}`;
  return { day: text, daysLeft, warn, recorded: true, message };
}

// ── Reading the till ───────────────────────────────────────

export type TillState = "off" | "not_configured" | "ok" | "unreachable" | "refused" | "bad_answer";

/** Everything the module needs from outside, so a test sees all of it. */
export interface TillDeps {
  config: Config;
  env: Readonly<Record<string, unknown>>;
  /** Outbound HTTP (ctx.fetch). Never the global `fetch`. */
  fetch: typeof fetch;
  /** The instant the call started (ctx.now). */
  now: Date;
  /** Waits `ms` or until the signal aborts; never rejects (a setTimeout in the Worker, the fake clock in a test). */
  sleep: Sleep;
  /** Milliseconds since the call started: how the budget is kept. */
  elapsedMs: () => number;
}

const MESSAGES = {
  off: "The link to the till is switched off (Settings, Till). Sign-in and everything else work as usual.",
  not_configured: "The link to the till is switched on but not set up: it needs the till's address in Settings and the key installed.",
  ok: "The till answered.",
  budget: "The till did not answer in time (8 seconds). What is saved is shown; try again later.",
  badAnswer: "The till answered with something this app does not understand. Nothing was changed; tell whoever looks after the till link.",
} as const;

/**
 * Each kind of error the client can answer, and the state and words the screen gets for it.
 *   not_configured, bad_address ......... not_configured  (no request was made)
 *   timeout, network, server ............ unreachable     (down, slow, failing)
 *   rate_limited ........................ unreachable     ("slow down", with the seconds the till asked for)
 *   unauthorized ........................ refused         (the key was not accepted: expired, withdrawn, wrong)
 *   forbidden ........................... refused         (the key may not see the stored till store)
 *   not_found, rejected ................. refused         (the till said no)
 *   bad_answer, bad_input ............... bad_answer      (not what the contract says)
 * The till's own text is never shown: only these words.
 */
export function explain(error: TillError): { state: Exclude<TillState, "off" | "ok">; message: string } {
  switch (error.kind) {
    case "not_configured":
    case "bad_address":
      return { state: "not_configured", message: MESSAGES.not_configured };
    case "timeout":
      return { state: "unreachable", message: "The till did not answer in time. What is saved is shown; try again later." };
    case "network":
    case "server":
      return { state: "unreachable", message: "The till could not be reached just now (it may be down). What is saved is shown; try again later." };
    case "rate_limited":
      return { state: "unreachable", message: `The till asked us to slow down${error.retryAfterSeconds !== undefined ? ` (try again in ${error.retryAfterSeconds} seconds)` : ""}. What is saved is shown; try again shortly.` };
    case "unauthorized":
      return { state: "refused", message: "The till did not accept the key. It may have expired or been withdrawn: install a new one." };
    case "forbidden":
      return { state: "refused", message: "The till's key may not see the till store matched here. Check which store the key was made for." };
    case "not_found":
    case "rejected":
      return { state: "refused", message: "The till refused the request. Nothing was changed." };
    default:
      return { state: "bad_answer", message: MESSAGES.badAnswer };
  }
}

interface Read {
  state: TillState;
  message: string;
  stores: Store[] | null;
  staff: StaffMember[] | null;
}

const unread = (state: Exclude<TillState, "ok">, message: string): Read => ({ state, message, stores: null, staff: null });

/**
 * Read the till once per endpoint asked for, inside the budget. Never throws. Off (the setting) makes no
 * request and builds no client; anything else goes through `tillClientFor`, which answers `not_configured`
 * itself when the address or the key is missing.
 */
async function readTill(deps: TillDeps, want: { stores?: boolean; staffOf?: string | null }): Promise<Read> {
  if (!deps.config.boolean("till_enabled")) return unread("off", MESSAGES.off);
  const client = tillClientFor(deps.env, deps.config, {
    fetch: deps.fetch,
    sleep: deps.sleep,
    now: () => new Date(deps.now.getTime() + deps.elapsedMs()),
    timeoutMs: CLIENT_TIMEOUT_MS,
    maxWaitMs: CLIENT_MAX_WAIT_MS,
  });
  const stop = new AbortController();
  try {
    const work = Promise.all([want.stores ? client.listStores() : Promise.resolve(null), want.staffOf ? client.listStaff(want.staffOf) : Promise.resolve(null)]);
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
    const [stores, staff] = first;
    for (const r of [stores, staff]) {
      if (r !== null && !r.ok) {
        const why = explain(r.error);
        return unread(why.state, why.message);
      }
    }
    return { state: "ok", message: MESSAGES.ok, stores: stores !== null && stores.ok ? stores.data.stores : null, staff: staff !== null && staff.ok ? staff.data.staff : null };
  } catch {
    // Nothing above should throw (the client never does); if something does, the answer is still an answer.
    return unread("bad_answer", MESSAGES.badAnswer);
  } finally {
    stop.abort();
  }
}

/** A write that needs the till read now: the reason it cannot be, as a message for the person. */
function needTill(read: Read): never {
  throw new Error(`${read.message} Nothing was changed.`);
}

// ── Names ──────────────────────────────────────────────────

/** Equal names, ignoring case and repeated spaces. */
export const nameKey = (s: string): string => s.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

const lower = (s: string): string => s.toLowerCase();

// ── Reading: the screen's data ─────────────────────────────

export interface LinkView {
  tillStaffId: string;
  tillName: string;
  tillRole: string;
  matchedAt: string;
  lastSeenAt: string | null;
  /** True when the till's list holds them now, false when it does not, null when the till could not be read. */
  inTillList: boolean | null;
}

export interface TillLinkView {
  state: TillState;
  message: string;
  keyExpiry: KeyExpiry;
  stores: Array<{ storeId: string; name: string; tillStore: { id: string; name: string } | null }>;
  tillStores: Array<{ id: string; name: string; code: string; active: boolean }>;
  people: Array<{ staffId: string; name: string; active: boolean; link: LinkView | null; suggestion: { tillStaffId: string; tillName: string } | null }>;
  unmatchedTillPeople: Array<{ tillStaffId: string; name: string; role: string; active: boolean }>;
}

interface StoreRow {
  id: string;
  name: string;
}
interface TillStoreRow {
  store_id: string;
  till_store_id: string;
  till_name: string;
}
interface PersonRow {
  staff_id: string;
  name: string;
  active: boolean;
}
interface LinkRow {
  link_id: number;
  staff_id: string;
  till_store_id: string;
  till_staff_id: string;
  till_name: string;
  till_role: string;
  matched_at: Date;
  last_seen_at: Date | null;
}

const LINK_COLUMNS = "link_id, staff_id, till_store_id::text as till_store_id, till_staff_id::text as till_staff_id, till_name, till_role, matched_at, last_seen_at";

/**
 * What the Staff screen's "Till logins" section shows. The people are Operations' own list (who they are:
 * name and whether active: nothing about pay, PIN or contact), their stored match if any, and, when the
 * till answered, a suggestion and the till people nobody is matched to. Makes at most one call to each of
 * `GET /stores` and `GET /staff`, together, inside the budget. Never throws for the till's sake.
 */
export async function get(db: Tx, deps: TillDeps): Promise<TillLinkView> {
  const keyExpiry = keyExpiryWarning(deps.config, deps.now);
  const stores = await db.query<StoreRow>("select id, name from ops.stores where active order by name, id");
  const matches = await db.query<TillStoreRow>("select store_id, till_store_id::text as till_store_id, till_name from ops.till_stores where ended_at is null order by matched_at, match_id");
  const people = await db.query<PersonRow>("select staff_id, name, active from ops.staff order by active desc, lower(name), staff_id");
  const live = await db.query<LinkRow>(`select ${LINK_COLUMNS} from ops.till_staff_links where ended_at is null order by link_id`);

  // One till store is used today (Operations has one store): the first match made.
  const matched = matches[0] ?? null;
  const read = await readTill(deps, { stores: true, staffOf: matched === null ? null : matched.till_store_id });
  const tillList = read.state === "ok" ? (read.staff ?? []).filter((s) => lower(s.staff_id) !== NIL_STAFF_ID) : null;
  const inList = new Set((tillList ?? []).map((s) => lower(s.staff_id)));

  // "Last seen": the stored matches the till's list holds now. The one write of a read, bookkeeping only.
  const seen = tillList === null ? [] : live.filter((l) => matched !== null && lower(l.till_store_id) === lower(matched.till_store_id) && inList.has(lower(l.till_staff_id)));
  if (seen.length > 0) {
    await db.query("update ops.till_staff_links set last_seen_at = $1 where link_id = any($2::bigint[]) and ended_at is null", [deps.now, seen.map((l) => l.link_id)]);
  }
  const seenIds = new Set(seen.map((l) => l.link_id));

  const linkOf = new Map(live.map((l) => [l.staff_id, l]));
  const matchedTillIds = new Set(live.map((l) => lower(l.till_staff_id)));
  const free = (tillList ?? []).filter((s) => !matchedTillIds.has(lower(s.staff_id)));
  const byName = new Map<string, StaffMember[]>();
  for (const s of free) byName.set(nameKey(s.display_name), [...(byName.get(nameKey(s.display_name)) ?? []), s]);

  return {
    state: read.state,
    message: read.message,
    keyExpiry,
    stores: stores.map((s) => {
      const m = matches.find((x) => x.store_id === s.id) ?? null;
      return { storeId: s.id, name: s.name, tillStore: m === null ? null : { id: lower(m.till_store_id), name: m.till_name } };
    }),
    tillStores: (read.stores ?? []).map((s) => ({ id: lower(s.store_id), name: s.name, code: s.code, active: s.active })),
    people: people.map((p) => {
      const l = linkOf.get(p.staff_id) ?? null;
      let suggestion: { tillStaffId: string; tillName: string } | null = null;
      if (l === null && matched !== null) {
        const same = byName.get(nameKey(p.name)) ?? [];
        if (same.length === 1) suggestion = { tillStaffId: lower(same[0]!.staff_id), tillName: same[0]!.display_name };
      }
      return {
        staffId: p.staff_id,
        name: p.name,
        active: p.active === true,
        link:
          l === null
            ? null
            : {
                tillStaffId: lower(l.till_staff_id),
                tillName: l.till_name,
                tillRole: l.till_role,
                matchedAt: l.matched_at.toISOString(),
                lastSeenAt: seenIds.has(l.link_id) ? deps.now.toISOString() : l.last_seen_at === null ? null : l.last_seen_at.toISOString(),
                inTillList: tillList === null ? null : inList.has(lower(l.till_staff_id)),
              },
        suggestion,
      };
    }),
    unmatchedTillPeople: free.map((s) => ({ tillStaffId: lower(s.staff_id), name: s.display_name, role: s.role, active: s.active })),
  };
}

// ── Writing ────────────────────────────────────────────────

export interface Actor {
  staffId: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function inputOf(v: unknown): Record<string, unknown> {
  if (!isObj(v)) throw new Error("input is required");
  return v;
}
const textOf = (v: unknown): string => (typeof v === "string" ? v : "");

export interface StoreResult {
  storeId: string;
  tillStore: { id: string; name: string } | null;
  changed: boolean;
}

/**
 * Match Operations' store to one of the till's stores, or (`tillStoreId` null) end the match. A match
 * needs the till to list that store NOW. Changing a match is two steps (end it, then match again), and
 * a match cannot be ended while people are matched through it: end theirs first.
 */
export async function setStore(db: Tx, input: unknown, actor: Actor, deps: TillDeps): Promise<StoreResult> {
  const o = inputOf(input);
  const storeId = textOf(o["storeId"]);
  const store = storeId === "" ? null : await db.maybeOne<StoreRow>("select id, name from ops.stores where id = $1", [storeId]);
  if (store === null) throw new Error("There is no such store.");
  const ending = o["tillStoreId"] === null || o["tillStoreId"] === undefined || o["tillStoreId"] === "";

  if (ending) {
    await db.query(LINK_LOCK);
    const current = await db.maybeOne<TillStoreRow & { match_id: number }>("select match_id, store_id, till_store_id::text as till_store_id, till_name from ops.till_stores where store_id = $1 and ended_at is null for update", [store.id]);
    if (current === null) return { storeId: store.id, tillStore: null, changed: false };
    const people = (await db.one<{ n: number }>("select count(*)::int as n from ops.till_staff_links where till_store_id = $1::uuid and ended_at is null", [current.till_store_id])).n;
    if (people > 0) throw new Error(`${people} ${people === 1 ? "person is" : "people are"} matched through it: end ${people === 1 ? "their match" : "their matches"} first.`);
    await db.query("update ops.till_stores set ended_by = $2, ended_at = $3 where match_id = $1", [current.match_id, actor.staffId, deps.now]);
    await audit.write(db, { actorId: actor.staffId, action: "till_link.store_ended", targetType: "store", targetId: store.id, before: { tillStoreId: lower(current.till_store_id), tillName: current.till_name }, after: null }, { now: deps.now });
    return { storeId: store.id, tillStore: null, changed: true };
  }

  const wanted = typeof o["tillStoreId"] === "string" && UUID.test(o["tillStoreId"]) ? lower(o["tillStoreId"]) : null;
  if (wanted === null) throw new Error("Choose a store from the till's list.");
  const read = await readTill(deps, { stores: true });
  if (read.state !== "ok") needTill(read);
  const listed = (read.stores ?? []).find((s) => lower(s.store_id) === wanted);
  if (listed === undefined) throw new Error("The till does not list that store.");

  await db.query(LINK_LOCK);
  const mine = await db.maybeOne<TillStoreRow>("select store_id, till_store_id::text as till_store_id, till_name from ops.till_stores where store_id = $1 and ended_at is null for update", [store.id]);
  if (mine !== null) {
    if (lower(mine.till_store_id) === wanted) return { storeId: store.id, tillStore: { id: wanted, name: mine.till_name }, changed: false };
    throw new Error(`${store.name} is already matched to ${mine.till_name}: end that match first.`);
  }
  const other = await db.maybeOne<TillStoreRow & { store_name: string }>(
    "select t.store_id, t.till_store_id::text as till_store_id, t.till_name, s.name as store_name from ops.till_stores t join ops.stores s on s.id = t.store_id where t.till_store_id = $1::uuid and t.ended_at is null",
    [wanted],
  );
  if (other !== null) throw new Error(`${listed.name} is already matched to ${other.store_name}.`);
  await db.query("insert into ops.till_stores (store_id, till_store_id, till_name, matched_by, matched_at) values ($1, $2::uuid, $3, $4, $5)", [store.id, wanted, listed.name, actor.staffId, deps.now]);
  await audit.write(db, { actorId: actor.staffId, action: "till_link.store_matched", targetType: "store", targetId: store.id, before: null, after: { tillStoreId: wanted, tillName: listed.name } }, { now: deps.now });
  return { storeId: store.id, tillStore: { id: wanted, name: listed.name }, changed: true };
}

export interface LinkResult {
  staffId: string;
  name: string;
  link: LinkView;
}

/**
 * Match one Operations person (active or not) to one till login from the till's list as it is NOW for the
 * matched store. Refused: no store matched yet; the nil uuid; a person the till does not list; a till
 * login already matched to someone; a person already matched. Needs the till to be read.
 */
export async function linkStaff(db: Tx, input: unknown, actor: Actor, deps: TillDeps): Promise<LinkResult> {
  const o = inputOf(input);
  const staffId = textOf(o["staffId"]);
  const person = staffId === "" ? null : await db.maybeOne<PersonRow>("select staff_id, name, active from ops.staff where staff_id = $1", [staffId]);
  if (person === null) throw new Error("There is no such person.");
  const given = o["tillStaffId"];
  if (typeof given !== "string" || !UUID.test(given)) throw new Error("Choose the person in the till to match.");
  const tillStaffId = lower(given);
  if (tillStaffId === NIL_STAFF_ID) throw new Error('"Not known" is the till\'s name for no one: it cannot be matched to a person.');

  const matches = await db.query<TillStoreRow>("select store_id, till_store_id::text as till_store_id, till_name from ops.till_stores where ended_at is null order by matched_at, match_id");
  const wantedStore = textOf(o["storeId"]);
  const store = wantedStore === "" ? matches[0] : matches.find((m) => m.store_id === wantedStore);
  if (store === undefined) throw new Error("Match the till's store to this store first.");
  const tillStoreId = lower(store.till_store_id);

  const read = await readTill(deps, { staffOf: tillStoreId });
  if (read.state !== "ok") needTill(read);
  const there = (read.staff ?? []).find((s) => lower(s.staff_id) === tillStaffId);
  if (there === undefined) throw new Error("That person is not in the till's list for this store now.");

  // Staff row first, then the one link lock, then what is checked and written.
  await lockRow(db, "staff", person.staff_id);
  await db.query(LINK_LOCK);
  const still = await db.maybeOne<{ n: number }>("select 1 as n from ops.till_stores where store_id = $1 and till_store_id = $2::uuid and ended_at is null", [store.store_id, tillStoreId]);
  if (still === null) throw new Error("The store match changed while this was being made: try again.");
  const mine = await db.maybeOne<{ till_name: string }>("select till_name from ops.till_staff_links where staff_id = $1 and till_store_id = $2::uuid and ended_at is null", [person.staff_id, tillStoreId]);
  if (mine !== null) throw new Error(`${person.name.trim()} is already matched to ${mine.till_name}: end that match first.`);
  const theirs = await db.maybeOne<{ name: string }>(
    "select s.name from ops.till_staff_links l join ops.staff s on s.staff_id = l.staff_id where l.till_staff_id = $1::uuid and l.ended_at is null",
    [tillStaffId],
  );
  if (theirs !== null) throw new Error(`${there.display_name} is already matched to ${theirs.name.trim()}.`);

  await db.query(
    "insert into ops.till_staff_links (staff_id, till_store_id, till_staff_id, till_name, till_role, matched_by, matched_at, last_seen_at) values ($1, $2::uuid, $3::uuid, $4, $5, $6, $7, $7)",
    [person.staff_id, tillStoreId, tillStaffId, there.display_name, there.role, actor.staffId, deps.now],
  );
  await audit.write(
    db,
    {
      actorId: actor.staffId,
      action: "till_link.staff_linked",
      targetType: "staff",
      targetId: person.staff_id,
      before: null,
      after: { tillStoreId, tillStaffId, tillName: there.display_name, tillRole: there.role },
    },
    { now: deps.now },
  );
  return {
    staffId: person.staff_id,
    name: person.name.trim(),
    link: { tillStaffId, tillName: there.display_name, tillRole: there.role, matchedAt: deps.now.toISOString(), lastSeenAt: deps.now.toISOString(), inTillList: true },
  };
}

export interface UnlinkResult {
  staffId: string;
  name: string;
  ended: true;
  tillStaffId: string;
  tillName: string;
}

/** End a person's match, with a reason (3 to 300 characters). Needs no till: it works while the till is down. */
export async function unlinkStaff(db: Tx, input: unknown, actor: Actor, deps: { now: Date }): Promise<UnlinkResult> {
  const o = inputOf(input);
  const staffId = textOf(o["staffId"]);
  const person = staffId === "" ? null : await db.maybeOne<PersonRow>("select staff_id, name, active from ops.staff where staff_id = $1", [staffId]);
  if (person === null) throw new Error("There is no such person.");
  const reason = textOf(o["reason"]).trim();
  if ([...reason].length < REASON_MIN || [...reason].length > REASON_MAX || CONTROL.test(reason)) {
    throw new Error(`A reason is needed: ${REASON_MIN} to ${REASON_MAX} characters, on one line.`);
  }
  await lockRow(db, "staff", person.staff_id);
  await db.query(LINK_LOCK);
  const l = await db.maybeOne<LinkRow>(`select ${LINK_COLUMNS} from ops.till_staff_links where staff_id = $1 and ended_at is null for update`, [person.staff_id]);
  if (l === null) throw new Error(`${person.name.trim()} is not matched to anyone in the till.`);
  await db.query("update ops.till_staff_links set ended_by = $2, ended_at = $3, ended_reason = $4 where link_id = $1", [l.link_id, actor.staffId, deps.now, reason]);
  await audit.write(
    db,
    {
      actorId: actor.staffId,
      action: "till_link.staff_unlinked",
      targetType: "staff",
      targetId: person.staff_id,
      before: { tillStoreId: lower(l.till_store_id), tillStaffId: lower(l.till_staff_id), tillName: l.till_name, tillRole: l.till_role },
      after: null,
      details: reason,
    },
    { now: deps.now },
  );
  return { staffId: person.staff_id, name: person.name.trim(), ended: true, tillStaffId: lower(l.till_staff_id), tillName: l.till_name };
}
