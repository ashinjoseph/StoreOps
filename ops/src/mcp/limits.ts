// The door's limits and its record of calls (card P5-11).
//
// Per key, counted from ops.assistant_calls:
//   - calls per minute (setting assistant_calls_per_minute, 1 to 600, default 30): the tool calls in the
//     last 60 seconds that were not themselves refused for the limit. Over it, the call is refused and
//     told how many seconds until the oldest of them leaves the window.
//   - proposals per day (setting assistant_proposals_per_day, 1 to 5000, default 200): allowed proposals
//     since midnight in Toronto (a 23- or 25-hour day on a clock change is still midnight to midnight).
// Both are counted while the call's transaction holds the key's row lock (keys.lockKey), so two calls
// at the same instant, on two connections, are counted one after the other: only one gets the last slot.
//
// Refused sign-ins (no key, a malformed or unknown key, a wrong secret, an expired or withdrawn key, an
// inactive person) are recorded too, but a flood of them must not fill the table: at most
// FLOOD_PER_ADDRESS a minute from one caller address and FLOOD_TOTAL a minute in all are recorded. Beyond
// that the caller still gets the same 401, and no row. A refused PUT to the receipt ticket route (an
// unknown, used or expired ticket, card P5-12b) counts in the same two limits. The address is the one Cloudflare gives the Worker
// (CF-Connecting-IP), kept only as a SHA-256. Those counts run under one transaction-scoped advisory
// lock, so concurrent floods cannot slip past them either.
//
// Nothing here reads the clock: `now` comes in.
import type { Tx } from "../db/tx";
import type { Config } from "../lib/config";
import { addDays, todayMidnight } from "../lib/dates";

export const MINUTE_MS = 60_000;
export const FLOOD_PER_ADDRESS = 20;
export const FLOOD_TOTAL = 120;
const AUTH_REASONS = ["bad_key", "expired", "withdrawn", "person_inactive"] as const;
/** Any fixed 63-bit number: the advisory lock taken while refused sign-ins are counted and recorded. */
const FLOOD_LOCK = "7020251101";

/** Refused PUTs to the receipt ticket route (card P5-12b): counted with refused sign-ins in the flood limit. */
const TICKET_REASONS = ["bad_ticket", "ticket_used", "ticket_expired"] as const;

export type Refusal = (typeof AUTH_REASONS)[number] | (typeof TICKET_REASONS)[number] | "no_right" | "rate_limited" | "unknown_tool" | "bad_input" | "failed";

export interface CallRecord {
  keyId: string | null;
  tool: string;
  at: Date;
  allowed: boolean;
  refusal: Refusal | null;
  tookMs: number | null;
  proposal: boolean;
  callerHash: Uint8Array | null;
}

/** Append one row to ops.assistant_calls. Never arguments, never an answer. */
export async function recordCall(tx: Tx, r: CallRecord): Promise<void> {
  await tx.query(
    "insert into ops.assistant_calls (key_id, tool, at, allowed, refusal, took_ms, proposal, caller_hash) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [r.keyId, [...r.tool].slice(0, 100).join(""), r.at, r.allowed, r.refusal, r.tookMs === null ? null : Math.max(0, Math.round(r.tookMs)), r.proposal, r.callerHash],
  );
}

/** A whole number setting kept inside its range (the Settings screen refuses anything else; this guards a hand-edited row). */
function bounded(config: Config, key: "assistant_calls_per_minute" | "assistant_proposals_per_day", min: number, max: number): number {
  const n = Math.floor(config.number(key));
  return Math.min(max, Math.max(min, n));
}
export const callsPerMinute = (config: Config): number => bounded(config, "assistant_calls_per_minute", 1, 600);
export const proposalsPerDay = (config: Config): number => bounded(config, "assistant_proposals_per_day", 1, 5000);

export type LimitAnswer = { ok: true } | { ok: false; message: string };

/** The per-minute limit for a key whose row the caller has locked. */
export async function checkCallLimit(tx: Tx, keyId: string, now: Date, limit: number): Promise<LimitAnswer> {
  const since = new Date(now.getTime() - MINUTE_MS);
  const row = await tx.one<{ n: number; oldest: Date | null }>(
    "select count(*)::int as n, min(at) as oldest from ops.assistant_calls where key_id = $1 and at > $2 and refusal is distinct from 'rate_limited'",
    [keyId, since],
  );
  if (row.n < limit) return { ok: true };
  // The slot frees when the oldest counted call leaves the window. With more counted calls than the
  // limit (the setting was lowered) it is later; this is the earliest it can be.
  const wait = row.oldest === null ? MINUTE_MS : row.oldest.getTime() + MINUTE_MS - now.getTime();
  const seconds = Math.max(1, Math.ceil(wait / 1000));
  return { ok: false, message: `Too many calls: this key may make ${limit} calls a minute. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.` };
}

/** The per-day proposal limit (Toronto day) for a key whose row the caller has locked. */
export async function checkProposalLimit(tx: Tx, keyId: string, now: Date, limit: number): Promise<LimitAnswer> {
  const midnight = todayMidnight(now);
  const row = await tx.one<{ n: number }>("select count(*)::int as n from ops.assistant_calls where key_id = $1 and proposal and allowed and at >= $2", [keyId, midnight]);
  if (row.n < limit) return { ok: true };
  const next = todayMidnight(addDays(midnight, 1));
  const hours = Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 3_600_000));
  return {
    ok: false,
    message: `Too many proposals: this key may make ${limit} proposals a day. Try again after midnight in Toronto (in about ${hours} hour${hours === 1 ? "" : "s"}).`,
  };
}

/** SHA-256 of the caller's address as the Worker sees it ("unknown" when there is none). */
export async function callerHash(address: string | null): Promise<Uint8Array> {
  const text = `ops.mcp.caller:${address === null || address === "" ? "unknown" : address}`;
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Whether one more refused sign-in may be recorded. Takes the flood lock for the rest of the transaction. */
export async function floodAllows(tx: Tx, caller: Uint8Array, now: Date): Promise<boolean> {
  await tx.query("select pg_advisory_xact_lock($1::bigint)", [FLOOD_LOCK]);
  const since = new Date(now.getTime() - MINUTE_MS);
  const row = await tx.one<{ mine: number; total: number }>(
    `select count(*) filter (where caller_hash = $1)::int as mine, count(*)::int as total
       from ops.assistant_calls
      where at > $2 and refusal in ('bad_key', 'expired', 'withdrawn', 'person_inactive', 'bad_ticket', 'ticket_used', 'ticket_expired')`,
    [caller, since],
  );
  return row.mine < FLOOD_PER_ADDRESS && row.total < FLOOD_TOTAL;
}
