// The four RPCs of the till link (card P5-02b), the Operations app's own (ADR-0023; listed in
// ops/contracts/rpc-ops.json), all admin only: the router applies the contract's roles before these run and
// each handler checks again, so a mistake in the contract file cannot open them. Identity is ctx.session,
// never an argument: a `role`, `actorId` or `matchedBy` in the input is ignored.
//
// The till is reached only through modules/till-link.ts (and so through the one client, ADR-0024). What
// the module cannot know in a Worker is supplied here:
//   - `sleep`: a setTimeout that resolves after `ms`, or at once when its signal aborts (clearing the
//     timer). It never rejects. The client uses it for each request's deadline and to wait out a 429; the
//     module uses it for the budget of the whole RPC. It lives here, not in the client, so the client
//     stays free of timers (and a test gives it the fake clock instead).
//   - `elapsedMs`: how long this call has run (performance.now), because `ctx.now` is the instant the call
//     STARTED. The budget (8 seconds for the whole RPC) is kept against it.
// The connection and the transaction stay open while the till is read (at most the budget); only
// the admin screen's one RPC does this, and nothing it holds is locked until the till has answered.
import { requireRole } from "../../auth/roles";
import type { Session } from "../../auth/types";
import * as tillLink from "../../modules/till-link";
import type { Sleep } from "../../till/client";
import type { RpcContext, RpcHandler } from "../types";

function admin(ctx: RpcContext): Session {
  requireRole(ctx.session, "admin");
  return ctx.session as Session;
}

/** Resolves after `ms`, or as soon as `signal` aborts (the timer is cleared either way). Never rejects. */
export const sleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
  });

async function depsOf(ctx: RpcContext): Promise<tillLink.TillDeps> {
  const began = performance.now();
  return { config: await ctx.config(), env: ctx.env, fetch: ctx.fetch, now: ctx.now, sleep, elapsedMs: () => performance.now() - began };
}

/** Admin: the Staff screen's till section: the state of the link, the stored matches, and (when the till answers) who to match. Never fails for the till's sake. */
export const rpcGetTillLink: RpcHandler = async (ctx) => {
  admin(ctx);
  return tillLink.get(ctx.db, await depsOf(ctx));
};

/** Admin: `{ storeId, tillStoreId | null }`: match Operations' store to a store the till lists now, or end the match. */
export const rpcSetTillStore: RpcHandler = async (ctx, input) => {
  const s = admin(ctx);
  return tillLink.setStore(ctx.db, input, { staffId: s.staffId }, await depsOf(ctx));
};

/** Admin: `{ staffId, tillStaffId }`: match one person to one till login the till lists now. */
export const rpcLinkTillStaff: RpcHandler = async (ctx, input) => {
  const s = admin(ctx);
  return tillLink.linkStaff(ctx.db, input, { staffId: s.staffId }, await depsOf(ctx));
};

/** Admin: `{ staffId, reason }`: end a person's match. Works with the till down. */
export const rpcUnlinkTillStaff: RpcHandler = async (ctx, input) => {
  const s = admin(ctx);
  return tillLink.unlinkStaff(ctx.db, input, { staffId: s.staffId }, { now: ctx.now });
};
