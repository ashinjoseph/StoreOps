// The two RPCs of the Settings screen (card P4-09). They exist only in the Operations app (ADR-0023;
// ops/contracts/rpc-ops.json). Who may call is the contract's `roles` (admin), applied by the router
// before these run; the check is made here as well, in case the contract is ever wrong. Identity is
// ctx.session, never an argument: an `actorId` or `role` in the page's input is ignored.
import { requireRole } from "../../auth/roles";
import * as settings from "../../modules/settings";
import type { RpcContext, RpcHandler } from "../types";

function admin(ctx: RpcContext): { staffId: string } {
  requireRole(ctx.session, "admin");
  return ctx.session as { staffId: string };
}

/** Admin only: every setting with its default and how it is read, the unknown rows, the secrets (by name and set/not set only), and the till key's expiry warning. */
export const rpcGetSettings: RpcHandler = async (ctx) => {
  admin(ctx);
  return settings.list(ctx.db, ctx.env, ctx.now);
};

/** Admin only: `{ key, value }`. A blank value goes back to the default. Answers `{ key, value, isDefault, changed }`. */
export const rpcUpdateSetting: RpcHandler = async (ctx, input) => {
  const actorId = admin(ctx).staffId;
  const o = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  return settings.update(ctx.db, { key: o["key"], value: o["value"], actorId }, { now: ctx.now });
};
