// The reconcile RPCs (card P3-07): rpcReconcileDay and rpcGetReconciliation. Thin: each shapes the
// page's arguments as WebApp.gs did and calls modules/reconcile.ts.
//
// Who may call (the old bodies decide, with the contract):
//   rpcReconcileDay        anyone signed in (the auto path runs after any cashier's close); the
//                          body checks no role. `force === true` (exactly) is the manual whole-day
//                          check; anything else is auto. The actor is ctx.session, never an argument.
//   rpcGetReconciliation   admin, manager, payroll_admin: the contract's roles, applied by the router.
//
// Neither old function wrapped its errors with its own name, so neither is in ERROR_PREFIXED.
// rpcReconcileDay's answer went through JSON.parse(JSON.stringify(...)) in the old body (its window
// Dates become ISO strings); so does this one.
import * as reconcile from "../../modules/reconcile";
import type { RpcContext, RpcHandler } from "../types";
import type { Session } from "../../auth/types";

function who(ctx: RpcContext): Session {
  if (ctx.session === null) throw new Error("NOT_LOGGED_IN");
  return ctx.session;
}

/** Reconcile today: the shift that just closed (auto), or the whole day with force (manual). */
export const rpcReconcileDay: RpcHandler = async (ctx, force) => {
  const session = who(ctx);
  const r = await reconcile.reconcileDay(ctx.db, { config: await ctx.config(), env: ctx.env, fetch: ctx.fetch, now: ctx.now }, session.staffId, force === true ? "manual" : "auto");
  return JSON.parse(JSON.stringify(r || {})) as unknown;
};

/** Recent reconciliations, newest first: `Number(limit) || 60` of them. */
export const rpcGetReconciliation: RpcHandler = async (ctx, limit) => {
  who(ctx);
  return reconcile.getRecent(ctx.db, Number(limit) || 60);
};
