// Sessions: the port of Auth.gs's session half (login_ creation, peek_, validate_, logout_'s delete).
//
// A session is a row in ops.sessions keyed by sha256(token): the token itself is
// never stored, so a copy of the table cannot be replayed as a login.
//
// Deliberate difference from the old code: the old session was a snapshot of the
// person taken at sign-in, so a deactivation or a role change took effect only at
// the next login. Here the Session is built from the staff row on EVERY call, so
// a deactivated person's session stops working at once and a new role applies at once.
import type { Db } from "../db/client";
import { newToken } from "../lib/ids";
import type { Config } from "../lib/config";
import { NOT_LOGGED_IN, ROLES, type Role, type Session } from "./types";

const HOUR_MS = 3600 * 1000;

/** sha256(token) as the 32 bytes the table stores. */
export async function hashToken(token: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

/** Auth.gs:97 / 169: `Number(configValue_('session_hours', 24)) || 24`, in ms. */
function windowMs(config: Config): number {
  return config.number("session_hours", 24) * HOUR_MS;
}

/** Make a session for a person (the caller has checked the PIN). Returns the token to hand to the page, once. */
export async function createSession(db: Db, staffId: string, config: Config, now: Date): Promise<{ token: string; expiresAt: number }> {
  const token = newToken();
  const expiresAt = now.getTime() + windowMs(config);
  await db.query("insert into ops.sessions (token_hash, staff_id, created_at, expires_at, last_seen_at) values ($1, $2, $3, $4, $3)", [
    await hashToken(token),
    staffId,
    now,
    new Date(expiresAt),
  ]);
  return { token, expiresAt };
}

interface SessionRow {
  expires_at: Date;
  staff_id: string;
  name: string;
  active: boolean;
  role: string;
  companies_authorized: string | null;
}

const isRole = (r: string): r is Role => (ROLES as readonly string[]).includes(r);

/** Staff.gs rowToRecord_: trimmed strings; the companies list split on commas, trimmed, empties dropped. */
export function companiesOf(raw: string | null): string[] {
  const text = (raw || "").toString().trim();
  return text ? text.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Validate a token and renew it (rolling), as Auth.validate_ does. Throws
 * `new Error("NOT_LOGGED_IN")` for a missing, unknown or expired token (the
 * expired row is left for `purgeExpired`), and for a staff row that is missing or inactive.
 * Renewal: only when LESS than half the window remains, to `now + window`.
 */
export async function validateSession(db: Db, token: string, config: Config, now: Date): Promise<Session> {
  if (typeof token !== "string" || token === "") throw new Error(NOT_LOGGED_IN);
  const hash = await hashToken(token);
  const row = await db.maybeOne<SessionRow>(
    `select s.expires_at, st.staff_id, st.name, st.active, st.role, st.companies_authorized
       from ops.sessions s
       join ops.staff st on st.staff_id = s.staff_id
      where s.token_hash = $1`,
    [hash],
  );
  if (!row) throw new Error(NOT_LOGGED_IN);

  let expiresAt = row.expires_at.getTime();
  if (now.getTime() > expiresAt) {
    // Auth.gs:150: strictly past expiry. The old code also deleted the session here. This one
    // does not: the call is about to fail with NOT_LOGGED_IN, the router rolls a failed call
    // back, and the delete would be undone with it. An expired row is refused every time and
    // is removed by purgeExpired (found by the parity harness, card P2-09).
    throw new Error(NOT_LOGGED_IN);
  }
  // New: read from the staff row each time (see the header). A deactivated person is signed out.
  if (row.active !== true || !isRole(row.role)) throw new Error(NOT_LOGGED_IN);

  // Auth.gs:171: extend only when less than half the window remains.
  const fullMs = windowMs(config);
  if (expiresAt - now.getTime() < fullMs / 2) {
    expiresAt = now.getTime() + fullMs;
    await db.query("update ops.sessions set expires_at = $2, last_seen_at = $3 where token_hash = $1", [hash, new Date(expiresAt), now]);
  }

  return {
    staffId: row.staff_id.trim(),
    name: row.name.trim(),
    role: row.role,
    companiesAuthorized: companiesOf(row.companies_authorized),
    expiresAt,
  };
}

/** Delete one session. An unknown or empty token is fine. */
export async function destroySession(db: Db, token: string): Promise<void> {
  if (typeof token !== "string" || token === "") return;
  await db.query("delete from ops.sessions where token_hash = $1", [await hashToken(token)]);
}

/** Delete every session past its end. (A later cron card calls this.) Returns how many went. */
export async function purgeExpired(db: Db, now: Date): Promise<number> {
  const rows = await db.query<{ staff_id: string }>("delete from ops.sessions where expires_at < $1 returning staff_id", [now]);
  return rows.length;
}
