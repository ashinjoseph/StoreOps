// The three RPCs of the Assistants screen (card P5-11): list, make and withdraw the keys AI assistants
// use at /mcp. They exist only in the Operations app (ADR-0023; ops/contracts/rpc-ops.json). Who may
// call is the contract's `roles` (admin), applied by the router before these run; the check is made
// here as well, in case the contract is ever wrong. Identity is ctx.session, never an argument.
//
// The key itself is in exactly one answer: the one of rpcCreateAssistantKey that makes it.
import { requireRole } from "../../auth/roles";
import * as keys from "../../mcp/keys";
import type { RpcContext, RpcHandler } from "../types";

function admin(ctx: RpcContext): { staffId: string } {
  requireRole(ctx.session, "admin");
  return ctx.session as { staffId: string };
}
const fields = (input: unknown): Record<string, unknown> => (typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {});

/** Admin only: every key (never a hash), whether the door is on, and the people a key can be made for. */
export const rpcGetAssistantKeys: RpcHandler = async (ctx) => {
  admin(ctx);
  const config = await ctx.config();
  return {
    enabled: config.boolean("assistants_enabled"),
    address: "/mcp",
    keys: await keys.listKeys(ctx.db, ctx.now),
    people: await keys.people(ctx.db),
  };
};

/** Admin only: `{ staffId, label, right, personalDetails, days }`. Answers `{ record, key }`; the key is never shown again. */
export const rpcCreateAssistantKey: RpcHandler = async (ctx, input) => {
  const actorId = admin(ctx).staffId;
  const o = fields(input);
  return keys.createKey(ctx.db, { staffId: o["staffId"], label: o["label"], right: o["right"], personalDetails: o["personalDetails"], days: o["days"], actorId }, { now: ctx.now });
};

/** Admin only: `{ keyId, reason }`. Withdrawn at once; withdrawing again changes nothing. Answers the record. */
export const rpcRevokeAssistantKey: RpcHandler = async (ctx, input) => {
  const actorId = admin(ctx).staffId;
  const o = fields(input);
  return keys.revokeKey(ctx.db, { keyId: o["keyId"], reason: o["reason"], actorId }, { now: ctx.now });
};
