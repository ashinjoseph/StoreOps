// The five RPCs of the Cash Handling tab (card P3-06). Thin: each does what the old rpc* function in
// WebApp.gs did around the module call, and the module does the rest. The contract gives all five to any
// signed-in person; the rules that follow are the old code's own, applied here:
//   privileged = an admin, or the person named in cash_manager_staff_id (a plain manager is not);
//   position    anyone; the roster only if privileged;
//   record      for yourself, or for anyone if privileged (the module then needs the actor to be a party or an admin);
//   void        privileged only;
//   outstanding yours, or anyone's if privileged;
//   history     yours, or anyone's / everyone's if privileged.
// Identity is ctx.session, never an argument: an `actorId`, `recordedBy` or role in the page's input is ignored.
//
// None of the old five wrapped its body in a try/catch that prefixed the error, so none is in ERROR_PREFIXED.
// None of the answers carries a Date: every date is already an ISO string (or '' / null), as before.
import type { Session } from "../../auth/types";
import * as cashHandling from "../../modules/cash-handling";
import type { RpcContext, RpcHandler } from "../types";

function who(ctx: RpcContext): Session {
  if (ctx.session === null) throw new Error("NOT_LOGGED_IN");
  return ctx.session;
}

/** WebApp.gs _isCashPrivileged: an admin, or the configured cash manager. */
async function isPrivileged(ctx: RpcContext, session: Session): Promise<boolean> {
  if (session.role === "admin") return true;
  const manager = await cashHandling.cashManager(ctx.db, await ctx.config());
  return !!(manager && manager.staffId === session.staffId);
}

/** Everyone: your balance, your recent handovers, and for the privileged the roster of who holds what. */
export const rpcGetCashPosition: RpcHandler = async (ctx) => {
  const session = who(ctx);
  if (!(await cashHandling.sheetsExist(ctx.db))) return { enabled: false };
  return cashHandling.getPosition(ctx.db, await ctx.config(), session.staffId, await isPrivileged(ctx, session), ctx.now);
};

/**
 * Record a handover from the cashier (default: yourself) to the cash manager (default) or a named person.
 * Someone else's cash only if privileged. The module checks the rest and audits.
 */
export const rpcRecordCashHandover: RpcHandler = async (ctx, rawInput) => {
  const session = who(ctx);
  const input = (rawInput || {}) as Record<string, unknown>;
  // The module re-checks this against the resolved recipient; repeating it here fails before anything is read.
  const fromStaffId = String(input["fromStaffId"] || session.staffId);
  if (fromStaffId !== session.staffId && !(await isPrivileged(ctx, session))) {
    throw new Error("FORBIDDEN: only the cashier, the cash manager, or an admin can record this handover");
  }
  return cashHandling.record(
    ctx.db,
    await ctx.config(),
    {
      fromStaffId,
      amount: Number(input["amount"]),
      handedOn: input["handedOn"] || null,
      toStaffId: input["toStaffId"] || null,
      method: input["method"] || "cash",
      notes: input["notes"] || "",
      actorId: session.staffId,
    },
    ctx.now,
  );
};

/** The cash manager or an admin: void a handover (never delete it); its cash returns to the holder. */
export const rpcVoidCashHandover: RpcHandler = async (ctx, handoverId) => {
  const session = who(ctx);
  if (!(await isPrivileged(ctx, session))) throw new Error("FORBIDDEN: only the cash manager or an admin can void a handover");
  return cashHandling.voidHandover(ctx.db, handoverId as string, session.staffId, ctx.now);
};

/** One cashier's balance and per-shift breakdown: yours, or anyone's if privileged. */
export const rpcGetCashOutstandingFor: RpcHandler = async (ctx, staffId) => {
  const session = who(ctx);
  if (!(await cashHandling.sheetsExist(ctx.db))) return { enabled: false };
  if (staffId !== session.staffId && !(await isPrivileged(ctx, session))) {
    throw new Error("FORBIDDEN: only the cash manager or an admin can view another cashier's balance");
  }
  const o = await cashHandling.getOutstandingForStaff(ctx.db, staffId, ctx.now);
  return { ...o, enabled: true };
};

/** The ledger: newest first; a person who is not privileged is pinned to their own rows whatever they ask for. */
export const rpcGetCashHandoverHistory: RpcHandler = async (ctx, limit, staffId) => {
  const session = who(ctx);
  if (!(await cashHandling.sheetsExist(ctx.db))) return { enabled: false, handovers: [] };
  const scope = (await isPrivileged(ctx, session)) ? staffId || null : session.staffId;
  return { enabled: true, handovers: await cashHandling.getHistory(ctx.db, Number(limit) || 25, scope) };
};
