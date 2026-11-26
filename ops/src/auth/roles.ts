// Port of Auth.require_ (src/Auth.gs:182-189). Roles come from the session only,
// never from anything the client sent (AGENTS.md hard rule 5).
import { FORBIDDEN_PREFIX, NOT_LOGGED_IN, type Session } from "./types";

/** Throws `NOT_LOGGED_IN` for no session, `FORBIDDEN: requires a or b, got role` for a wrong role. */
export function requireRole(session: Session | null | undefined, allowed: string | readonly string[]): void {
  if (!session) throw new Error(NOT_LOGGED_IN);
  const roles: readonly string[] = typeof allowed === "string" ? [allowed] : allowed;
  if (!roles.includes(session.role)) {
    throw new Error(`${FORBIDDEN_PREFIX}: requires ${roles.join(" or ")}, got ${session.role}`);
  }
}
