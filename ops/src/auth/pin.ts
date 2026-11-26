// PIN hashing for sign-in (P2-06). Web Crypto only, so the same code runs in a
// Cloudflare Worker and in Node 22.
//
// What is stored (one text field, ops.staff.pin_hash):
//   pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>
// where hash = PBKDF2-HMAC-SHA-256(password = HMAC-SHA-256(key = pepper, message = PIN),
//                                  salt = 16 random bytes, iterations, 32 bytes out).
// The pepper is a Worker secret (PIN_PEPPER) the caller passes in: a database
// leak alone is not enough to try PINs offline, and a PIN is never hashed without it.
// 100,000 iterations is the most a Worker allows PBKDF2; the count is read back
// from the stored value, so it can be raised wherever more is possible.
//
// Nothing here logs, throws or returns the PIN, the pepper or a hash in a message.
import type { Db } from "../db/client";
import * as audit from "../lib/audit";

export const PIN_ALGORITHM = "pbkdf2-sha256";
/** The most PBKDF2 iterations a Cloudflare Worker accepts. */
export const PIN_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
/** A stored value asking for more than this is refused rather than burning CPU. */
const MAX_ITERATIONS = 10_000_000;

export interface HashOptions {
  /** Default 100,000. */
  iterations?: number;
  /** Default: 16 random bytes. Tests pin it. */
  salt?: Uint8Array;
}

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** Strict base64 (canonical padding) to bytes, or null. */
function fromBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  try {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function requirePepper(pepper: unknown): string {
  if (typeof pepper !== "string" || pepper === "") {
    throw new Error("PIN pepper is missing or empty: PINs are never hashed without it (Worker secret PIN_PEPPER)");
  }
  return pepper;
}

/** The submitted code as the old code reads it: `(code || '').toString().trim()`. */
function normalisePin(pin: unknown): string {
  return (pin || "").toString().trim();
}

async function derive(pin: string, pepper: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const hmacKey = await crypto.subtle.importKey("raw", encoder.encode(pepper), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const peppered = await crypto.subtle.sign("HMAC", hmacKey, encoder.encode(pin));
  const base = await crypto.subtle.importKey("raw", peppered, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, base, HASH_BYTES * 8);
  return new Uint8Array(bits);
}

/** Hash a PIN (trimmed first) with a fresh random salt. Throws on an empty pepper. */
export async function hashPin(pin: string, pepper: string, opts: HashOptions = {}): Promise<string> {
  const key = requirePepper(pepper);
  const iterations = opts.iterations ?? PIN_ITERATIONS;
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(normalisePin(pin), key, salt, iterations);
  return `${PIN_ALGORITHM}$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Equal-length byte arrays compared without an early exit. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/**
 * Does `pin` (trimmed) match the stored value? A malformed, empty or missing
 * stored value is `false`, never an error. An empty pepper throws: that is a
 * configuration fault, not a wrong PIN.
 */
export async function verifyPin(pin: string, stored: string, pepper: string): Promise<boolean> {
  const key = requirePepper(pepper);
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== PIN_ALGORITHM) return false;
  const [, iterText, saltText, hashText] = parts as [string, string, string, string];
  if (!/^[1-9][0-9]{0,8}$/.test(iterText)) return false;
  const iterations = Number(iterText);
  if (iterations > MAX_ITERATIONS) return false;
  const salt = fromBase64(saltText);
  const expected = fromBase64(hashText);
  if (!salt || salt.length === 0 || !expected || expected.length !== HASH_BYTES) return false;
  try {
    const actual = await derive(normalisePin(pin), key, salt, iterations);
    return constantTimeEqual(actual, expected);
  } catch {
    return false; // e.g. a Worker refusing an iteration count above its cap
  }
}

/**
 * Set a person's PIN: 4 to 8 digits (after trimming), stored only as a hash,
 * and an audit row `staff.pin_set` that holds neither the PIN nor the hash.
 * `actorId` (who changed it) and `now` are optional.
 */
export async function setPin(db: Db, staffId: string, pin: string, pepper: string, opts: { actorId?: string; now?: Date } = {}): Promise<void> {
  const text = typeof pin === "string" ? pin.trim() : "";
  if (!/^[0-9]{4,8}$/.test(text)) throw new Error("PIN must be 4 to 8 digits");
  const stored = await hashPin(text, pepper);
  const rows = await db.query<{ staff_id: string }>("update ops.staff set pin_hash = $1 where staff_id = $2 returning staff_id", [stored, staffId]);
  if (rows.length === 0) throw new Error("No such staff member");
  await audit.write(
    db,
    { actorId: opts.actorId ?? null, action: "staff.pin_set", targetType: "staff", targetId: staffId, details: "" },
    opts.now ? { now: opts.now } : {},
  );
}
