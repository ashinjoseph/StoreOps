// The reconcile-a-past-day RPC (card P4-12c), the Operations app's own (ADR-0023; listed in
// ops/contracts/rpc-ops.json). An admin, a manager or a payroll admin may call it: the people the
// Reconcile screen offers it to. (rpcReconcileDay, the ported call for today, is open to any signed-in
// person, as the old app's was; a re-run of a past day is not a cashier's job, so this one is narrower.)
// The router applies the contract's rule before this runs, and the handler checks again. Identity is
// ctx.session, never an argument: an `actorId`, `role` or `staffId` in the input is ignored (only
// `date` and `reason` are read).
import { requireRole } from "../../auth/roles";
import * as pastDay from "../../modules/reconcile-past";
import type { RpcContext, RpcHandler } from "../types";

/** Who may run a past day again. The contract (rpc-ops.json) lists the same three. */
export const MAY_RERUN = ["admin", "manager", "payroll_admin"] as const;

function who(ctx: RpcContext): string {
  requireRole(ctx.session, MAY_RERUN);
  return (ctx.session as NonNullable<RpcContext["session"]>).staffId;
}

/** Reconcile every till of a past day again, keeping the earlier results; sends no message. */
export const rpcReconcilePastDay: RpcHandler = async (ctx, input) => {
  const actorId = who(ctx);
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("input is required");
  const i = input as Record<string, unknown>;
  // How long this call has run, for the module's time budget for Clover (as rpcReconcileDay).
  const began = performance.now();
  const elapsedMs = (): number => performance.now() - began;
  const r = await pastDay.reconcilePastDay(ctx.db, { config: await ctx.config(), env: ctx.env, fetch: ctx.fetch, now: ctx.now, elapsedMs }, actorId, { date: i["date"], reason: i["reason"] });
  return JSON.parse(JSON.stringify(r)) as unknown;
};
