// Parity cases for the Staff module's three read RPCs (card P3-01).
//
// All three are reads, so no case declares `writes` and they share one pair of
// worlds. The parity worlds have one person of each of the four roles and one
// inactive person (old-world.ts PARITY_EXTRA_PEOPLE), so the login list's
// "active only" rule and every role's answer are compared. Nobody has a blank
// rate or a single company: ops/test/staff.test.ts covers those shapes.
//
// rpcGetActiveStaffForLogin takes no session: the login screen calls it before
// anyone is signed in, so it has one case with no caller at all.
import { parityCase, type ParityCase } from "../case";

const ROLES = ["admin", "manager", "employee", "payroll_admin"] as const;

export const staffCases: ParityCase[] = [
  parityCase("rpcGetActiveStaffForLogin", { title: "rpcGetActiveStaffForLogin: the login screen's list, with no session" }),

  // The two session RPCs: every role the fixture has, and a call with no token.
  ...ROLES.map((role) => parityCase("rpcGetStaffDirectory", { as: role })),
  parityCase("rpcGetStaffDirectory", { as: null, title: "rpcGetStaffDirectory: no token is refused" }),

  // Admin only: every other role is refused, and the refusal text is compared.
  ...ROLES.map((role) => parityCase("rpcGetAllStaff", { as: role })),
  parityCase("rpcGetAllStaff", { as: null, title: "rpcGetAllStaff: no token is refused" }),
];
