// The two RPCs of the Commissions screen's run list (card P3-10b): rpcGetCommissionRuns and
// rpcRunCommissionEngine. Thin: each shapes the answer the way the old rpc* function in WebApp.gs did.
// Who may call is the contract's `roles`, applied by the router before these run; identity is
// ctx.session, never an argument.
//
// The old rpcGetCommissionRuns wrapped every failure, a refusal included, as "rpcGetCommissionRuns:
// <message>": the router adds that prefix (registry.ts ERROR_PREFIXED), so nothing is wrapped here.
// rpcRunCommissionEngine had no such wrapper.
//
// Dates: rpcGetCommissionRuns sent weekStart, weekEnd and computedAt as ISO text (toISOString), so they
// are real values on the page today, not null. rpcRunCommissionEngine's answer went through a JSON round
// trip, so its week dates are ISO text too.
import { endOfDay, getPreviousWeekRange, parseDate } from "../../lib/dates";
import * as commissions from "../../modules/commissions";
import * as staff from "../../modules/staff";
import type { RpcContext, RpcHandler } from "../types";
import type { Session } from "../../auth/types";

function who(ctx: RpcContext): Session {
  if (ctx.session === null) throw new Error("NOT_LOGGED_IN");
  return ctx.session;
}

/**
 * The instants the old answer carried: a week's first day is Toronto midnight, its last is 23:59:59 (the
 * Sheet kept whole seconds; the engine's .999 did not survive being written to a cell). The database
 * holds the days only, so the instants are rebuilt.
 */
function weekInstants(r: commissions.RunRecord): { weekStart: string | null; weekEnd: string | null } {
  const start = r.weekStart ? parseDate(r.weekStart) : null;
  const end = r.weekEnd ? parseDate(r.weekEnd) : null;
  return {
    weekStart: start ? start.toISOString() : null,
    weekEnd: end ? new Date(endOfDay(end).getTime() - 999).toISOString() : null,
  };
}

/** Admin, manager or payroll admin: the commission runs, newest computed first, at most `limit` (12 when it is missing, zero or not a number). */
export const rpcGetCommissionRuns: RpcHandler = async (ctx, limit) => {
  who(ctx);
  const count = Number(limit) || 12;
  const names = new Map((await staff.getAll(ctx.db)).map((s) => [s.staffId, s.name]));
  return (await commissions.getAllRuns(ctx.db))
    .sort((a, b) => (b.computedAt ? b.computedAt.getTime() : 0) - (a.computedAt ? a.computedAt.getTime() : 0))
    .slice(0, count)
    .map((r) => ({
      runId: r.runId,
      ...weekInstants(r),
      staffCount: r.staffCount || 0,
      bonusesCreated: r.bonusesCreated || 0,
      totalCommissionAmount: r.totalCommissionAmount || 0,
      computedAt: r.computedAt ? r.computedAt.toISOString() : null,
      computedBy: r.computedBy || "",
      computedByName: names.get(r.computedBy) || r.computedBy || "",
      notes: r.notes || "",
    }));
};

/**
 * Admin or payroll admin: run the engine for the week before this one, as the person signed in. Only the
 * boolean true forces a re-run of a week that has run. The engine proposes; nothing it writes is payable
 * until someone approves it.
 */
export const rpcRunCommissionEngine: RpcHandler = async (ctx, force) => {
  const session = who(ctx);
  const range = getPreviousWeekRange(ctx.now);
  const result = await commissions.runForWeek(
    ctx.db,
    { weekStart: range.start, weekEnd: range.end, actorId: session.staffId, force: force === true },
    { config: await ctx.config(), env: ctx.env, fetch: ctx.fetch, now: ctx.now },
  );
  // The old answer went through a JSON round trip (a Date does not cross google.script.run): dates become ISO text.
  return JSON.parse(JSON.stringify(result || {}));
};
