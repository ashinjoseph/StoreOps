// Probes: new-side stand-ins for old RPCs that are not ported yet, so a case can
// look at the state the RPC under test leaves behind.
//
// The sign-in cases must prove a token is alive or dead on both sides. Two
// designs were possible: compare each side's "is this token valid" directly
// (Auth.peek on the old side, a query of ops.sessions on the new), or make a
// session-needing call on both sides. The second is used: it goes through the
// real router and the real resolveSession, exactly as the page's next call
// would, and its answer is compared like any other answer. (The token state is
// ALSO compared directly: cases that log in declare "sessions", and writes.ts
// compares old session:<token> properties with ops.sessions rows.)
//
// rpcGetMe is the old one-liner over Auth.validate (src/WebApp.gs):
//   function rpcGetMe(token) { const session = _session(token);
//     return { staffId, name, role, companiesAuthorized } of that session; }
// PROBES.rpcGetMe is the same over ctx.session, which the router has already
// resolved (or answered NOT_LOGGED_IN for). A probe is used only where the
// registry has no handler: once rpcGetMe is ported, these cases run the real
// one. A probe never counts as a handler, nor as coverage, in the gate.
import type { RpcHandler } from "../src/rpc/types";

export const PROBES: Readonly<{ rpcGetMe: RpcHandler }> = Object.freeze({
  rpcGetMe: (ctx) => {
    const s = ctx.session;
    if (s === null) throw new Error("NOT_LOGGED_IN");
    return { staffId: s.staffId, name: s.name, role: s.role, companiesAuthorized: s.companiesAuthorized };
  },
});
