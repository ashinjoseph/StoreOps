// Port of Auth.login_ and Auth.logout_ (src/Auth.gs:44-140, 191-227).
//
// Same answers to the page, same audit rows, same order of checks. The deliberate
// differences, each marked "DIFFERENCE" below:
//   1. failed attempts are rows in ops.login_failures, not script properties;
//   2. the PIN is checked with verifyPin against staff.pin_hash (no plain-text code);
//   3. an unknown name still costs one verifyPin, so it is not faster than a wrong PIN;
//   4. (Postgres text cannot hold a NUL character) a NUL in a typed name is shown as U+FFFD
//      in the failure key and the audit row; it still matches nobody.
// Nothing here reads the clock or the environment: config, pepper and time come in.
import type { Db } from "../db/client";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import { verifyPin } from "./pin";
import { companiesOf, createSession, hashToken } from "./sessions";
import type { Role } from "./types";

export interface LoginDeps {
  db: Db;
  config: Config;
  /** The Worker secret PIN_PEPPER. */
  pepper: string;
  now: Date;
}

export type LoginResult =
  | { success: false; error: string }
  | { success: true; token: string; staffId: string; name: string; role: Role; companiesAuthorized: string[] };

/**
 * A valid hash of a PIN nobody has, under a pepper nobody uses. Checked when the
 * name is unknown or the person has no PIN, so those paths cost one verifyPin
 * (about the same time) like a wrong PIN does. Its result is never used.
 */
const DUMMY_HASH = "pbkdf2-sha256$100000$9duz7ygeHKdOoEz9UPgINg==$4OHBtHnJe/FzcDmidapyIlyjF3MjxHdXkbAyMerEd20=";

interface StaffRow {
  staff_id: string;
  name: string;
  active: boolean;
  role: string;
  companies_authorized: string | null;
  pin_hash: string | null;
}

const MIN_MS = 60 * 1000;

/** Staff.getByName_: the typed name (trimmed) against each name (trimmed), exact and case-sensitive; first match wins. */
async function findByName(db: Db, trimmedName: string): Promise<StaffRow | null> {
  const all = await db.query<StaffRow>(
    "select staff_id, name, active, role, companies_authorized, pin_hash from ops.staff where btrim(staff_id) <> '' order by staff_id",
  );
  return all.find((s) => s.name.toString().trim() === trimmedName) ?? null;
}

// ---- lockout: Auth.gs:192-227, over ops.login_failures -------------------------------------------
// DIFFERENCE 1: one row per failure instead of {count, firstFailAt} in a script property. The old
// record is "count since firstFailAt"; here that is the number of rows for the key and the oldest
// row's time, which gives the same lockout, the same window (fixed from the first failure of the
// current run) and the same minutes arithmetic.

// The failure key is the typed name lower-cased and trimmed BY POSTGRES, with the same expression
// the table's CHECK uses. JavaScript's toLowerCase and Postgres's lower() disagree for some
// characters (and, under a C locale, for every accented one): a key lower-cased in JavaScript
// could be refused by the CHECK, and that name's failures would then never be counted.
const KEY_SQL = "lower(btrim($1))";

/**
 * One sign-in attempt at a time per name. Without this, attempts sent at the same moment each
 * read the failure count before any of them has added to it, and all get a guess: the limit
 * would be "max fails plus however many requests arrive together". The lock is held until the
 * call's transaction ends (the router wraps every call in one), so each attempt sees the ones
 * before it. The old app had this gap. Outside a transaction the lock is released at once
 * and protects nothing; that is safe, only weaker.
 */
const lockName = (db: Db, typed: string) =>
  db.query(`select pg_advisory_xact_lock(hashtextextended('ops.login:' || ${KEY_SQL}, 0))`, [typed]);

async function failureState(db: Db, key: string): Promise<{ count: number; firstFailAt: Date | null }> {
  const row = await db.one<{ n: number; first: Date | null }>(
    `select count(*)::int as n, min(failed_at) as first from ops.login_failures where name_key = ${KEY_SQL}`,
    [key],
  );
  return { count: row.n, firstFailAt: row.first };
}

const clearFailures = (db: Db, key: string) => db.query(`delete from ops.login_failures where name_key = ${KEY_SQL}`, [key]);

async function checkLockout(db: Db, config: Config, key: string, now: Date): Promise<{ lockedOut: false } | { lockedOut: true; minutesRemaining: number }> {
  const { count, firstFailAt } = await failureState(db, key);
  if (count === 0 || firstFailAt === null) return { lockedOut: false };
  const maxFails = config.number("login_max_fails", 5);
  const lockoutMs = config.number("login_lockout_mins", 60) * MIN_MS;
  if (count < maxFails) return { lockedOut: false };
  const elapsed = now.getTime() - firstFailAt.getTime();
  if (elapsed >= lockoutMs) {
    await clearFailures(db, key);
    return { lockedOut: false };
  }
  return { lockedOut: true, minutesRemaining: Math.ceil((lockoutMs - elapsed) / MIN_MS) };
}

async function recordFailure(db: Db, config: Config, key: string, now: Date): Promise<void> {
  const { firstFailAt } = await failureState(db, key);
  const lockoutMs = config.number("login_lockout_mins", 60) * MIN_MS;
  if (firstFailAt !== null && now.getTime() - firstFailAt.getTime() > lockoutMs) {
    await clearFailures(db, key); // the old window is over: start counting again
  }
  await db.query(`insert into ops.login_failures (name_key, failed_at) values (${KEY_SQL}, $2)`, [key, now]);
}

// ---- login ---------------------------------------------------------------------------------------

/** Auth.login_. The name and code are whatever the page sent; identity and role come only from the staff row. */
export async function login(deps: LoginDeps, name: string, code: string): Promise<LoginResult> {
  const { db, config, pepper, now } = deps;
  const trimmedName = (name || "").toString().trim();
  if (!trimmedName) return { success: false, error: "Name is required" };
  // DIFFERENCE 4: what goes into SQL text. A NUL never matches a staff name (the lookup uses trimmedName).
  const typed = trimmedName.replaceAll("\u0000", "�");
  const key = typed; // lower-cased and trimmed in SQL (KEY_SQL), the same way the table's CHECK does
  const auditDeps = { now };

  await lockName(db, typed);

  const lockoutCheck = await checkLockout(db, config, key, now);
  if (lockoutCheck.lockedOut) {
    await audit.write(db, { actorId: "SYSTEM", action: "login.fail", targetType: "staff", targetId: typed, details: "rate_limited: " + lockoutCheck.minutesRemaining + "min" }, auditDeps);
    return { success: false, error: "Too many failed attempts. Try again in " + lockoutCheck.minutesRemaining + " minutes." };
  }

  const staff = await findByName(db, trimmedName);
  if (!staff) {
    // DIFFERENCE 3: spend one PIN check so an unknown name is not faster than a wrong PIN.
    await verifyPin(code, DUMMY_HASH, pepper);
    await recordFailure(db, config, key, now);
    await audit.write(db, { actorId: "SYSTEM", action: "login.fail", targetType: "staff", targetId: typed, details: "unknown_name" }, auditDeps);
    return { success: false, error: "Invalid name or code" };
  }
  if (staff.active !== true) {
    // As today: an inactive person is told so, and the attempt is not counted as a failure.
    await audit.write(db, { actorId: "SYSTEM", action: "login.fail", targetType: "staff", targetId: staff.staff_id.trim(), details: "inactive" }, auditDeps);
    return { success: false, error: "Account is inactive" };
  }

  // DIFFERENCE 2: the PIN is checked against the stored hash. No hash = no PIN set = cannot sign in;
  // the dummy check keeps that path as slow as a wrong PIN, and its answer is thrown away.
  const hasPin = typeof staff.pin_hash === "string" && staff.pin_hash !== "";
  const matches = await verifyPin(code, hasPin ? (staff.pin_hash as string) : DUMMY_HASH, pepper);
  if (!hasPin || !matches) {
    await recordFailure(db, config, key, now);
    await audit.write(db, { actorId: "SYSTEM", action: "login.fail", targetType: "staff", targetId: staff.staff_id.trim(), details: "wrong_code" }, auditDeps);
    return { success: false, error: "Invalid name or code" };
  }

  // Success
  await clearFailures(db, key);
  const staffId = staff.staff_id.trim();
  const { token } = await createSession(db, staff.staff_id, config, now);
  await audit.write(db, { actorId: staffId, action: "login.success", targetType: "staff", targetId: staffId, details: "session created" }, auditDeps);

  return {
    success: true,
    token,
    staffId,
    name: staff.name.toString().trim(),
    role: staff.role as Role,
    companiesAuthorized: companiesOf(staff.companies_authorized),
  };
}

// ---- logout --------------------------------------------------------------------------------------

/** Auth.logout_: no token is fine; the session goes; if it was a live one, audit it by token prefix only. */
export async function logout(deps: Pick<LoginDeps, "db" | "now">, token: string): Promise<{ success: true }> {
  const { db, now } = deps;
  if (!token || typeof token !== "string") return { success: true };
  const hash = await hashToken(token);
  // peek_: an expired session counts as none (and is removed below, as peek_ removes it).
  const row = await db.maybeOne<{ staff_id: string; expires_at: Date }>("select staff_id, expires_at from ops.sessions where token_hash = $1", [hash]);
  const live = row !== null && !(now.getTime() > row.expires_at.getTime());
  await db.query("delete from ops.sessions where token_hash = $1", [hash]);
  if (row && live) {
    await audit.write(db, { actorId: row.staff_id, action: "login.logout", targetType: "session", targetId: token.substring(0, 8) + "...", details: "" }, { now });
  }
  return { success: true };
}
