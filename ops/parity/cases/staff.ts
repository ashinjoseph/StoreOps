// Parity cases for the Staff module's three read RPCs (card P3-01).
//
// All three are reads, so no case declares `writes` and they share one pair of
// worlds. The fixture has an admin, a manager and three employees, all active,
// all with a rate and both companies; it has no payroll_admin, no inactive
// person and no blank rate, so those shapes are covered by ops/test/staff.test.ts
// instead.
//
// rpcGetActiveStaffForLogin takes no session: the login screen calls it before
// anyone is signed in, so it has one case with no caller at all.
import { parityCase, type ParityCase } from "../case";

const ROLES = ["admin", "manager", "employee"] as const;

export const staffCases: ParityCase[] = [
  parityCase("rpcGetActiveStaffForLogin", { title: "rpcGetActiveStaffForLogin: the login screen's list, with no session" }),

  // The two session RPCs: every role the fixture has, and a call with no token.
  ...ROLES.map((role) => parityCase("rpcGetStaffDirectory", { as: role })),
  parityCase("rpcGetStaffDirectory", { as: null, title: "rpcGetStaffDirectory: no token is refused" }),

  // Admin only: the manager and the employee are refused, and the refusal text is compared.
  ...ROLES.map((role) => parityCase("rpcGetAllStaff", { as: role })),
  parityCase("rpcGetAllStaff", { as: null, title: "rpcGetAllStaff: no token is refused" }),
];
