// Parity cases for sign-in: rpcLogin and rpcLogout (ported in P2-06).
//
// Every case runs on a fresh pair of worlds (each declares `writes`), so the
// lockout counters and sessions of one case never reach another.
//
// Who signs in comes from the fixture (scripts/docs/fixtures.js), never typed
// here: nameOf("manager") / codeOf("manager") are that person's name and login
// code as the old staff tab holds them. The docs fixture has one admin, one
// manager and three employees, all active; the harness adds a payroll admin
// (nameOf("payroll_admin")) and an inactive employee (named by id, S_007; a role
// never picks an inactive person) to its own worlds (PARITY_EXTRA_PEOPLE).
//
// The follow-up call that proves a token is alive or dead is rpcGetMe (ported in P3-05a;
// before that the new side answered it with a probe, ops/parity/probes.ts). It goes
// through the real router and session, like the page's next call.
import { codeOf, nameOf, parityCase, paritySequence, resultOf, step, type ParityCase } from "../case";

/** A successful sign-in writes an audit row and a session; a failed one an audit row and a failure count. */
const SIGN_IN = ["audit_log", "sessions"];
const FAILED = ["audit_log", "login_failures"];
/** The harness-added inactive employee, named by id: a role never picks an inactive person. */
const INACTIVE = "S_007";

const loginAs = (role: string): ParityCase =>
  paritySequence(`rpcLogin: the right PIN signs in a ${role}, and the token opens a session call`, { writes: SIGN_IN }, [
    step("rpcLogin", { args: [nameOf(role), codeOf(role)] }),
    step("rpcGetMe", { as: { token: resultOf(1, "$.token") } }),
  ]);

export const authCases: ParityCase[] = [
  loginAs("admin"),
  loginAs("manager"),
  loginAs("employee"),
  loginAs("payroll_admin"),

  paritySequence("rpcLogin: an inactive person with the right PIN is refused and not counted", { writes: ["audit_log", "login_failures", "sessions"] }, [
    step("rpcLogin", { args: [nameOf(INACTIVE), codeOf(INACTIVE)] }),
    step("rpcGetMe", { as: { token: resultOf(1, "$.token") } }),
    // Still not counted: the answer stays the same however often it is asked.
    step("rpcLogin", { args: [nameOf(INACTIVE), codeOf(INACTIVE)], advance: { minutes: 1 } }),
  ]),
  paritySequence("rpcLogin: an inactive person with a wrong PIN, five times, is told inactive each time and is never locked", { writes: ["audit_log", "login_failures", "sessions"] }, [
    step("rpcLogin", { args: [nameOf(INACTIVE), "0000"] }),
    step("rpcLogin", { args: [nameOf(INACTIVE), "0001"], advance: { minutes: 1 } }),
    step("rpcLogin", { args: [nameOf(INACTIVE), "0002"], advance: { minutes: 1 } }),
    step("rpcLogin", { args: [nameOf(INACTIVE), "0003"], advance: { minutes: 1 } }),
    step("rpcLogin", { args: [nameOf(INACTIVE), "0004"], advance: { minutes: 1 } }),
    step("rpcLogin", { args: [nameOf(INACTIVE), codeOf(INACTIVE)], advance: { minutes: 1 } }),
  ]),
  paritySequence("rpcGetMe: a payroll admin's session names them and their role", { writes: SIGN_IN }, [step("rpcGetMe", { as: "payroll_admin" })]),

  paritySequence("rpcLogin: a wrong PIN is refused, and gives no session", { writes: FAILED }, [
    step("rpcLogin", { args: [nameOf("employee"), "0000"] }),
    step("rpcGetMe", { as: { token: resultOf(1, "$.token") } }),
  ]),
  parityCase("rpcLogin", { title: "rpcLogin: an unknown name is refused (and counted)", args: ["Nobody Atall", "1234"], writes: FAILED }),
  parityCase("rpcLogin", { title: "rpcLogin: a blank name is refused before anything is written", args: ["   ", "1234"], writes: [] }),
  parityCase("rpcLogin", { title: "rpcLogin: no arguments at all", args: [], writes: [] }),
  parityCase("rpcLogin", {
    title: "rpcLogin: the name is trimmed, and its case matters",
    args: [nameOf("manager", { pad: true }), codeOf("manager")],
    writes: SIGN_IN,
  }),
  parityCase("rpcLogin", { title: "rpcLogin: a name in other case is unknown", args: [nameOf("manager", { upper: true }), codeOf("manager")], writes: FAILED }),

  paritySequence("rpcLogin: lockout after login_max_fails wrong PINs, then the window passes", { writes: [...FAILED, "sessions"] }, [
    step("rpcLogin", { args: [nameOf("employee"), "0000"] }),
    step("rpcLogin", { args: [nameOf("employee"), "0001"], advance: { minutes: 1 } }),
    step("rpcLogin", { args: [nameOf("employee"), "0002"], advance: { minutes: 1 } }),
    step("rpcLogin", { args: [nameOf("employee"), "0003"], advance: { minutes: 1 } }),
    step("rpcLogin", { args: [nameOf("employee"), "0004"], advance: { minutes: 1 } }),
    // Locked: even the right PIN is refused, with the minutes left.
    step("rpcLogin", { args: [nameOf("employee"), codeOf("employee")] }),
    step("rpcLogin", { args: [nameOf("employee"), codeOf("employee")], advance: { minutes: 29, seconds: 30 } }),
    // A different person is not locked out by someone else's failures.
    step("rpcLogin", { args: [nameOf("manager"), codeOf("manager")] }),
    // One minute short of 60 after the first failure: still locked. At 60 the lock lifts.
    step("rpcLogin", { args: [nameOf("employee"), codeOf("employee")], advance: { minutes: 25, seconds: 30 } }),
    step("rpcLogin", { args: [nameOf("employee"), codeOf("employee")], advance: { minutes: 1 } }),
    step("rpcGetMe", { as: { token: resultOf(10, "$.token") } }),
  ]),

  paritySequence("rpcLogout: after a login the token dies, and only that one", { writes: SIGN_IN }, [
    step("rpcLogin", { args: [nameOf("employee"), codeOf("employee")] }),
    step("rpcGetMe", { as: { token: resultOf(1, "$.token") } }),
    step("rpcLogout", { args: [resultOf(1, "$.token")] }),
    step("rpcGetMe", { as: { token: resultOf(1, "$.token") } }),
    step("rpcGetMe", { as: "manager" }),
    // Logging out twice is still fine, and writes nothing more.
    step("rpcLogout", { args: [resultOf(1, "$.token")] }),
  ]),
  paritySequence("rpcLogout: a nonsense token is fine and ends nobody's session", { writes: [] }, [
    step("rpcLogout", { args: ["not-a-token"] }),
    step("rpcGetMe", { as: { token: "not-a-token" } }),
    step("rpcGetMe", { as: "employee" }),
  ]),
  paritySequence("rpcLogout: no token at all is fine", { writes: [] }, [
    step("rpcLogout", { args: [] }),
    step("rpcLogout", { args: [""] }),
    step("rpcGetMe", { as: null }),
    step("rpcGetMe", { as: "employee" }),
  ]),

  paritySequence("sessions: a token past its hours is dead on both sides", { writes: SIGN_IN }, [
    step("rpcLogin", { args: [nameOf("employee"), codeOf("employee")] }),
    step("rpcGetMe", { as: { token: resultOf(1, "$.token") }, advance: { hours: 24, seconds: 1 } }),
  ]),
  paritySequence("sessions: a call in the second half of the window renews the session", { writes: SIGN_IN }, [
    step("rpcLogin", { args: [nameOf("employee"), codeOf("employee")] }),
    step("rpcGetMe", { as: { token: resultOf(1, "$.token") }, advance: { hours: 13 } }),
    step("rpcGetMe", { as: { token: resultOf(1, "$.token") }, advance: { hours: 23 } }),
  ]),
];
