// What the rest of the app knows about who is calling. Decided once, here:
// the login card (P2-06) produces it, the RPC router (P2-07) consumes it, and
// every ported module reads identity and role from it and from nowhere else
// (AGENTS.md hard rule 5: roles come from the session only).

export const ROLES = ["admin", "manager", "employee", "payroll_admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * The signed-in person, as the old `Auth.validate(token)` returned it.
 * Unlike the old app, it is read from the staff row on every request, so a
 * role change or a deactivation takes effect at once, not at the next login.
 */
export interface Session {
  staffId: string;
  name: string;
  role: Role;
  /** The staff row's comma list ("cstore,vape") split and trimmed, as Staff.gs returns it: ["cstore", "vape"]. */
  companiesAuthorized: string[];
  /** When the session ends, in ms since the epoch (rolling: see P2-06). */
  expiresAt: number;
}

/** Thrown, with exactly these messages, where the old app threw them: the page checks the text. */
export const NOT_LOGGED_IN = "NOT_LOGGED_IN";
export const FORBIDDEN_PREFIX = "FORBIDDEN";
