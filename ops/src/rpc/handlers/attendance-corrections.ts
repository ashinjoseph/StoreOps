// The two RPCs of attendance corrections (card P4-10), the Operations app's own (ADR-0023; listed in
// ops/contracts/rpc-ops.json). Admin only: the router applies the contract's role rule before these
// run, and each handler checks again, so a mistake in the contract file cannot open them. Identity
// is ctx.session, never an argument: an `actorId` or `role` in the input is ignored.
import { requireRole } from "../../auth/roles";
import * as corrections from "../../modules/attendance-corrections";
import type { RpcContext, RpcHandler } from "../types";

function admin(ctx: RpcContext): string {
  requireRole(ctx.session, "admin");
  return (ctx.session as NonNullable<RpcContext["session"]>).staffId;
}

/** Admin: one person's day as the correction sheet shows it. */
export const rpcGetAttendanceDay: RpcHandler = (ctx, staffId, date) => {
  admin(ctx);
  return corrections.getDay(ctx.db, staffId, date, ctx.now);
};

/** Admin: set one person's past day to what really happened. */
export const rpcCorrectAttendance: RpcHandler = (ctx, input) => {
  const actorId = admin(ctx);
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("input is required");
  const i = input as Record<string, unknown>;
  return corrections.correct(
    ctx.db,
    { staffId: i["staffId"], date: i["date"], status: i["status"], scheduledStart: i["scheduledStart"], scheduledEnd: i["scheduledEnd"], actualStart: i["actualStart"], actualEnd: i["actualEnd"], reason: i["reason"] },
    actorId,
    ctx.now,
  );
};
