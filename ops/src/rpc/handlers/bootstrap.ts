// The two reads the page makes first on every load (card P3-05c): rpcGetBootstrap and
// rpcGetMyShiftState. Thin: who is calling comes from ctx.session (never an argument), the work is
// modules/shift-state.ts.
//
// rpcGetMyShiftState's errors carry the old "rpcGetMyShiftState: " prefix; the router adds it
// (ERROR_PREFIXED), so this handler does not. The old rpcGetBootstrap wraps nothing: its only
// refusal is a bare NOT_LOGGED_IN, so it is not in that set.
//
// Neither answer carries a Date, and neither says anything about the shopping list, suppliers, the
// order catalogue or the product master (the deprecated features): the old answers do not either.
import { DbError } from "../../db/client";
import { getMyShiftState } from "../../modules/shift-state";
import type { RpcContext, RpcHandler } from "../types";
import type { Session } from "../../auth/types";

function who(ctx: RpcContext): Session {
  if (ctx.session === null) throw new Error("NOT_LOGGED_IN");
  return ctx.session;
}

async function shiftState(ctx: RpcContext, s: Session) {
  return getMyShiftState(ctx.db, s, { config: await ctx.config(), now: ctx.now });
}

/** Any signed-in person: the tills, today's attendance, recent sessions, the lotto pot, cash in hand. */
export const rpcGetMyShiftState: RpcHandler = async (ctx) => shiftState(ctx, who(ctx));

/**
 * Any signed-in person: `me` plus the shift state in one call. If the shift state fails to build,
 * `me` is still returned with `shift: null` (the page retries it). A database error is not
 * swallowed: it has already ended the call's transaction.
 */
export const rpcGetBootstrap: RpcHandler = async (ctx) => {
  const s = who(ctx);
  let shift: unknown = null;
  try {
    shift = await shiftState(ctx, s);
  } catch (e) {
    if (e instanceof DbError) throw e;
  }
  return { me: { staffId: s.staffId, name: s.name, role: s.role, companiesAuthorized: s.companiesAuthorized }, shift };
};
