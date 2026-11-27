// rpcGetSalesByChannel (card P5-03b): the Sales screen's "From the till" section. The Operations app's
// own (ADR-0023; listed in ops/contracts/rpc-ops.json), read only, with the same roles as the Sales
// screen's own call (rpcGetSalesDashboard): the router applies the contract's roles before this runs and
// the handler checks again, so a mistake in the contract file cannot open it to another role. Identity is
// ctx.session, never an argument: a `role`, `actorId` or `storeId` in the input is ignored (the store asked
// of the till is the one matched in Settings, read by the module).
//
// This file reads the shape of the input: `{ from, to, day }`, each a real day written yyyy-mm-dd (`day`
// optional). The module decides what the range may be. The timer and the clock the module cannot have in
// a Worker are the same two P5-02b's handler gives (`sleep`, `elapsedMs`); a rejected row is one log line
// and no audit row (nothing was done).
import { requireRole } from "../../auth/roles";
import * as channels from "../../modules/sales-channels";
import { isRealDay } from "../../till/days";
import type { RpcContext, RpcHandler } from "../types";
import { sleep } from "./till-link";

const ROLES = ["admin", "manager", "payroll_admin"] as const;

function dayOf(input: Record<string, unknown>, key: string, label: string, optional: boolean): string | null {
  const v = input[key];
  if (optional && (v === undefined || v === null || v === "")) return null;
  if (!isRealDay(v)) throw new Error(`The ${label} must be a real day written yyyy-mm-dd.`);
  return v;
}

export const rpcGetSalesByChannel: RpcHandler = async (ctx: RpcContext, inputArg) => {
  requireRole(ctx.session, ROLES);
  const input = (typeof inputArg === "object" && inputArg !== null && !Array.isArray(inputArg) ? inputArg : {}) as Record<string, unknown>;
  const from = dayOf(input, "from", "start date", false) as string;
  const to = dayOf(input, "to", "end date", false) as string;
  const day = dayOf(input, "day", "day", true);
  const began = performance.now();
  const deps: channels.SalesChannelsDeps = {
    config: await ctx.config(),
    env: ctx.env,
    fetch: ctx.fetch,
    now: ctx.now,
    sleep,
    elapsedMs: () => performance.now() - began,
    log: (entry) => console.warn(JSON.stringify({ rpc: "rpcGetSalesByChannel", ...entry })),
  };
  return channels.get(ctx.db, { from, to, day }, deps);
};
