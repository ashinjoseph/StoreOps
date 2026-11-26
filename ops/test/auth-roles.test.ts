// requireRole: the port of Auth.require_ (src/Auth.gs:182-189), checked against the real old code.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { requireRole } from "../src/auth/roles";
import type { Session } from "../src/auth/types";

const AUTH_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/Auth.gs");
const OldAuth = new Function(
  "PropertiesService", "CacheService", "SpreadsheetApp", "SHEETS", "Util", "AuditLog", "Staff",
  readFileSync(AUTH_SRC, "utf8") + "\n;return Auth;",
)({}, {}, {}, {}, {}, {}, {}) as { require: (s: unknown, r: unknown) => void };

const session = (role: Session["role"]): Session => ({ staffId: "S1", name: "Asha Example", role, companiesAuthorized: [], expiresAt: 1 });
const messageOf = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe("requireRole", () => {
  it("passes an allowed role, from a list or a single string", () => {
    expect(() => requireRole(session("admin"), ["admin", "payroll_admin"])).not.toThrow();
    expect(() => requireRole(session("payroll_admin"), ["admin", "payroll_admin"])).not.toThrow();
    expect(() => requireRole(session("manager"), "manager")).not.toThrow();
  });

  it("a wrong role throws the exact old message", () => {
    expect(messageOf(() => requireRole(session("employee"), ["admin", "payroll_admin"]))).toBe("FORBIDDEN: requires admin or payroll_admin, got employee");
    expect(messageOf(() => requireRole(session("employee"), "manager"))).toBe("FORBIDDEN: requires manager, got employee");
  });

  it("a null or undefined session throws NOT_LOGGED_IN", () => {
    expect(messageOf(() => requireRole(null, ["admin"]))).toBe("NOT_LOGGED_IN");
    expect(messageOf(() => requireRole(undefined, "admin"))).toBe("NOT_LOGGED_IN");
  });

  it("matches the real old Auth.require on every role and shape", () => {
    const roles = ["admin", "manager", "employee", "payroll_admin"] as const;
    const allowedSets: Array<string | string[]> = ["admin", ["admin"], ["admin", "manager"], ["payroll_admin", "admin", "manager"], [], "employee"];
    for (const role of roles) {
      for (const allowed of allowedSets) {
        const s = session(role);
        const oldMsg = messageOf(() => OldAuth.require(s, allowed));
        expect(messageOf(() => requireRole(s, allowed)), `${role} / ${JSON.stringify(allowed)}`).toBe(oldMsg);
      }
    }
    expect(messageOf(() => requireRole(null, "admin"))).toBe(messageOf(() => OldAuth.require(null, "admin")));
  });
});
