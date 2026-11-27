// Assistant keys (card P5-11): made, hashed, looked up, withdrawn and listed.
//
// A key is `ops_<key id>_<secret>`: the key id is "ak" and 16 hex characters (8 random bytes), the
// secret 32 random bytes as base64url (43 characters), both from crypto.getRandomValues. The key is
// shown once, in the answer that makes it. The table keeps the key id and the SHA-256 of the WHOLE key,
// never the key or its secret. A presented key is looked up by its key id; then the hashes are compared
// in constant time.
//
// What a wrong key learns: nothing. `authenticate` does the same work for a missing, malformed or
// unknown key as for a known one (one lookup by id, one hash, one 32-byte comparison) and the door
// answers every refusal with the same 401. The reason goes only into the call record.
//
// A key belongs to one active person. It stops working at once when it expires, is withdrawn, or its
// person is deactivated (the staff row is read on every call, as sessions do).
//
// Time is the caller's `now`; SQL takes values as parameters only; nothing is deleted.
import type { Db } from "../db/client";
import { lockRow, type Tx } from "../db/tx";
import * as audit from "../lib/audit";
import { addDays, todayMidnight } from "../lib/dates";

export const RIGHTS = ["read", "propose"] as const;
export type Right = (typeof RIGHTS)[number];

export type AuthRefusal = "bad_key" | "expired" | "withdrawn" | "person_inactive";

/** What the door and the tools know about the key in use. */
export interface KeyInfo {
  keyId: string;
  staffId: string;
  staffName: string;
  label: string;
  right: Right;
  personalDetails: boolean;
  expiresAt: Date;
}

export type AuthResult = { ok: true; key: KeyInfo } | { ok: false; reason: AuthRefusal; keyId: string | null };

/** What the Assistants screen shows. Never a hash, never a key. */
export interface KeyRecord {
  keyId: string;
  staffId: string;
  staffName: string;
  label: string;
  right: Right;
  personalDetails: boolean;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  withdrawnAt: string | null;
  withdrawnBy: string | null;
  withdrawnReason: string | null;
  lastUsedAt: string | null;
  status: "live" | "expired" | "withdrawn" | "person_inactive";
  /** Whole days until it expires (rounded up); 0 once expired. */
  daysLeft: number;
  callsToday: number;
}

export const KEY_PREFIX = "ops_";
const KEY_RE = /^ops_(ak[0-9a-f]{16})_([A-Za-z0-9_-]{43})$/;
/** Looked up when the presented key has no usable key id, so that path does the same work. */
const DUMMY_ID = "ak0000000000000000";
const DUMMY_HASH = new Uint8Array(32);
const DAY_MS = 86_400_000;
export const DEFAULT_DAYS = 90;
export const MAX_DAYS = 365;
export const LABEL_MAX = 60;
export const REASON_MIN = 3;
export const REASON_MAX = 300;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A new key and its id, from crypto. */
export function newKey(): { keyId: string; key: string } {
  const id = new Uint8Array(8);
  const secret = new Uint8Array(32);
  crypto.getRandomValues(id);
  crypto.getRandomValues(secret);
  const keyId = `ak${hex(id)}`;
  return { keyId, key: `${KEY_PREFIX}${keyId}_${base64url(secret)}` };
}

/** SHA-256 of the whole key text: the 32 bytes the table stores. */
export async function hashKey(key: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
}

/** Byte-for-byte equality whose time does not depend on where the bytes differ. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** The key in an `Authorization: Bearer <key>` header, and its id; null when the header is missing or not that shape. */
export function parseAuthorization(header: string | null): { keyId: string; key: string } | null {
  if (typeof header !== "string") return null;
  const m = /^Bearer ([^\s]+)$/.exec(header.trim());
  if (!m) return null;
  const key = m[1] as string;
  const k = KEY_RE.exec(key);
  return k ? { keyId: k[1] as string, key } : null;
}

interface AuthRow {
  key_id: string;
  staff_id: string;
  name: string;
  active: boolean;
  label: string;
  key_right: string;
  personal_details: boolean;
  key_hash: Uint8Array;
  expires_at: Date;
  withdrawn_at: Date | null;
}

const AUTH_SQL = `select k.key_id, k.staff_id, s.name, s.active, k.label, k.key_right, k.personal_details, k.key_hash, k.expires_at, k.withdrawn_at
                    from ops.assistant_keys k join ops.staff s on s.staff_id = k.staff_id
                   where k.key_id = $1`;

function judge(row: AuthRow | null, now: Date): AuthRefusal | null {
  if (row === null) return "bad_key";
  if (row.withdrawn_at !== null) return "withdrawn";
  if (now.getTime() >= row.expires_at.getTime()) return "expired";
  if (row.active !== true) return "person_inactive";
  return null;
}

function toInfo(row: AuthRow): KeyInfo {
  return {
    keyId: row.key_id,
    staffId: row.staff_id.trim(),
    staffName: row.name.trim(),
    label: row.label,
    right: row.key_right === "propose" ? "propose" : "read",
    personalDetails: row.personal_details === true,
    expiresAt: row.expires_at,
  };
}

/**
 * Check the `Authorization` header. Every path does one lookup, one hash and one comparison. A wrong
 * secret is `bad_key` (with the key id, which is real); a key that matches but cannot be used says why.
 */
export async function authenticate(db: Db, authorization: string | null, now: Date): Promise<AuthResult> {
  const parsed = parseAuthorization(authorization);
  const row = await db.maybeOne<AuthRow>(AUTH_SQL, [parsed?.keyId ?? DUMMY_ID]);
  const presented = await hashKey(parsed?.key ?? DUMMY_ID);
  const stored = row !== null && row.key_hash instanceof Uint8Array && row.key_hash.length === 32 ? new Uint8Array(row.key_hash) : DUMMY_HASH;
  const matches = equalBytes(presented, stored);
  if (parsed === null || row === null) return { ok: false, reason: "bad_key", keyId: null };
  if (!matches) return { ok: false, reason: "bad_key", keyId: row.key_id };
  const refusal = judge(row, now);
  if (refusal !== null) return { ok: false, reason: refusal, keyId: row.key_id };
  return { ok: true, key: toInfo(row) };
}

/**
 * Lock the key's row for the rest of the call's transaction and check it is still usable (it may have
 * been withdrawn, or its person deactivated, since the request was let in). Every count of the limits
 * is made under this lock, so two calls with one key cannot both take the last slot.
 */
export async function lockKey(tx: Tx, keyId: string, now: Date): Promise<{ ok: true; key: KeyInfo } | { ok: false; reason: AuthRefusal }> {
  const row = await tx.maybeOne<AuthRow>(`${AUTH_SQL} for update of k`, [keyId]);
  const refusal = judge(row, now);
  if (refusal !== null || row === null) return { ok: false, reason: refusal ?? "bad_key" };
  return { ok: true, key: toInfo(row) };
}

/** The key has been used (an allowed tool call). The row is already locked. */
export async function markUsed(tx: Tx, keyId: string, now: Date): Promise<void> {
  await tx.query("update ops.assistant_keys set last_used_at = $2 where key_id = $1", [keyId, now]);
}

// ── The screen's side ──────────────────────────────────────

interface ListRow {
  key_id: string;
  staff_id: string;
  name: string;
  active: boolean;
  label: string;
  key_right: string;
  personal_details: boolean;
  created_at: Date;
  creator: string | null;
  created_by: string;
  expires_at: Date;
  withdrawn_at: Date | null;
  withdrawer: string | null;
  withdrawn_by: string | null;
  withdrawn_reason: string | null;
  last_used_at: Date | null;
  calls_today: number;
}

const LIST_SQL = `select k.key_id, k.staff_id, s.name, s.active, k.label, k.key_right, k.personal_details,
                         k.created_at, c.name as creator, k.created_by, k.expires_at,
                         k.withdrawn_at, wd.name as withdrawer, k.withdrawn_by, k.withdrawn_reason, k.last_used_at,
                         (select count(*)::int from ops.assistant_calls a where a.key_id = k.key_id and a.at >= $1) as calls_today
                    from ops.assistant_keys k
                    join ops.staff s on s.staff_id = k.staff_id
                    left join ops.staff c on c.staff_id = k.created_by
                    left join ops.staff wd on wd.staff_id = k.withdrawn_by`;

function toRecord(r: ListRow, now: Date): KeyRecord {
  const expired = now.getTime() >= r.expires_at.getTime();
  const status: KeyRecord["status"] = r.withdrawn_at !== null ? "withdrawn" : expired ? "expired" : r.active !== true ? "person_inactive" : "live";
  return {
    keyId: r.key_id,
    staffId: r.staff_id.trim(),
    staffName: r.name.trim(),
    label: r.label,
    right: r.key_right === "propose" ? "propose" : "read",
    personalDetails: r.personal_details === true,
    createdAt: r.created_at.toISOString(),
    createdBy: (r.creator ?? r.created_by).trim(),
    expiresAt: r.expires_at.toISOString(),
    withdrawnAt: r.withdrawn_at === null ? null : r.withdrawn_at.toISOString(),
    withdrawnBy: r.withdrawn_at === null ? null : (r.withdrawer ?? r.withdrawn_by ?? "").trim(),
    withdrawnReason: r.withdrawn_reason,
    lastUsedAt: r.last_used_at === null ? null : r.last_used_at.toISOString(),
    status,
    daysLeft: expired ? 0 : Math.ceil((r.expires_at.getTime() - now.getTime()) / DAY_MS),
    callsToday: r.calls_today,
  };
}

/** Every key, newest first. */
export async function listKeys(db: Db, now: Date): Promise<KeyRecord[]> {
  const rows = await db.query<ListRow>(`${LIST_SQL} order by k.created_at desc, k.key_id`, [todayMidnight(now)]);
  return rows.map((r) => toRecord(r, now));
}

async function getRecord(db: Db, keyId: string, now: Date): Promise<KeyRecord | null> {
  const row = await db.maybeOne<ListRow>(`${LIST_SQL} where k.key_id = $2`, [todayMidnight(now), keyId]);
  return row === null ? null : toRecord(row, now);
}

/** The people a key can be made for: active staff, by name. */
export async function people(db: Db): Promise<Array<{ staffId: string; name: string }>> {
  const rows = await db.query<{ staff_id: string; name: string }>("select staff_id, name from ops.staff where active = true and btrim(staff_id) <> '' order by name, staff_id");
  return rows.map((r) => ({ staffId: r.staff_id.trim(), name: r.name.trim() }));
}

export interface CreateInput {
  staffId: unknown;
  label: unknown;
  right?: unknown;
  personalDetails?: unknown;
  days?: unknown;
  actorId: string;
}

function checkLabel(raw: unknown): string {
  if (typeof raw !== "string") throw new Error(`label must be text, 1 to ${LABEL_MAX} characters`);
  const label = raw.trim();
  if (CONTROL.test(label)) throw new Error("label cannot contain a line break or other control character");
  const n = [...label].length;
  if (n < 1 || n > LABEL_MAX) throw new Error(`label must be 1 to ${LABEL_MAX} characters`);
  return label;
}

/**
 * Make a key for an active person. Runs in the caller's transaction. Answers the record and the key;
 * the key is never seen again. The person's row is locked so two keys with one label cannot be made at once.
 */
export async function createKey(tx: Tx, input: CreateInput, deps: { now: Date }): Promise<{ record: KeyRecord; key: string }> {
  const { now } = deps;
  const label = checkLabel(input.label);
  const right = input.right === undefined || input.right === null ? "read" : input.right;
  if (right !== "read" && right !== "propose") throw new Error("right must be read or propose");
  const personalDetails = input.personalDetails === undefined || input.personalDetails === null ? false : input.personalDetails;
  if (typeof personalDetails !== "boolean") throw new Error("personalDetails must be true or false");
  const days = input.days === undefined || input.days === null ? DEFAULT_DAYS : input.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw new Error(`days must be a whole number from 1 to ${MAX_DAYS}`);

  const staffId = typeof input.staffId === "string" ? input.staffId.trim() : "";
  if (staffId === "" || !(await lockRow(tx, "staff", staffId))) throw new Error(`${staffId || "That"} is not an active person on the staff list`);
  const person = await tx.one<{ name: string; active: boolean }>("select name, active from ops.staff where staff_id = $1", [staffId]);
  if (person.active !== true) throw new Error(`${staffId} is not an active person on the staff list`);
  const clash = await tx.maybeOne(
    "select 1 as found from ops.assistant_keys where staff_id = $1 and label = $2 and withdrawn_at is null and expires_at > $3",
    [staffId, label, now],
  );
  if (clash !== null) throw new Error(`${person.name.trim()} already has a working key called ${label}`);

  const { keyId, key } = newKey();
  const expiresAt = addDays(now, days);
  await tx.query(
    `insert into ops.assistant_keys (key_id, staff_id, label, key_right, personal_details, key_hash, created_by, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [keyId, staffId, label, right, personalDetails, await hashKey(key), input.actorId, now, expiresAt],
  );
  await audit.write(
    tx,
    {
      actorId: input.actorId,
      action: "assistant_key.create",
      targetType: "assistant_key",
      targetId: keyId,
      after: { staffId, label, right, personalDetails, expiresAt: expiresAt.toISOString() },
    },
    { now },
  );
  const record = await getRecord(tx, keyId, now);
  if (record === null) throw new TypeError("the key just made was not found");
  return { record, key };
}

/** Withdraw a key, at once and for good. Withdrawing a withdrawn key changes nothing and writes nothing. */
export async function revokeKey(tx: Tx, input: { keyId: unknown; reason: unknown; actorId: string }, deps: { now: Date }): Promise<KeyRecord> {
  const { now } = deps;
  const keyId = typeof input.keyId === "string" ? input.keyId : "";
  if (typeof input.reason !== "string") throw new Error(`reason must be ${REASON_MIN} to ${REASON_MAX} characters`);
  const reason = input.reason.trim();
  if (CONTROL.test(reason)) throw new Error("reason cannot contain a line break or other control character");
  const n = [...reason].length;
  if (n < REASON_MIN || n > REASON_MAX) throw new Error(`reason must be ${REASON_MIN} to ${REASON_MAX} characters`);
  const row = keyId === "" ? null : await tx.maybeOne<{ withdrawn_at: Date | null }>("select withdrawn_at from ops.assistant_keys where key_id = $1 for update", [keyId]);
  if (row === null) throw new Error("No such key");
  if (row.withdrawn_at === null) {
    await tx.query("update ops.assistant_keys set withdrawn_at = $2, withdrawn_by = $3, withdrawn_reason = $4 where key_id = $1", [keyId, now, input.actorId, reason]);
    await audit.write(tx, { actorId: input.actorId, action: "assistant_key.revoke", targetType: "assistant_key", targetId: keyId, details: reason }, { now });
  }
  const record = await getRecord(tx, keyId, now);
  if (record === null) throw new TypeError("the key was not found");
  return record;
}
