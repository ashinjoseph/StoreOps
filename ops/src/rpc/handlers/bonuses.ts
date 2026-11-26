// The four RPCs of the Commissions screen's bonus list (card P3-09a). Thin: each calls the module and
// shapes the answer the way the old rpc* function in WebApp.gs did. Who may call is the contract's
// `roles`, applied by the router before these run; identity is ctx.session, never an argument (an
// `actorId` or `createdBy` in the page's input is ignored, as the old RPCs built their own).
import { parseDate } from "../../lib/dates";
import * as bonuses from "../../modules/bonuses";
import type { BonusRecord } from "../../modules/bonuses";
import * as staff from "../../modules/staff";
import type { RpcContext, RpcHandler } from "../types";

function who(ctx: RpcContext): { staffId: string } {
  if (ctx.session === null) throw new Error("NOT_LOGGED_IN");
  return ctx.session;
}

/**
 * `input.key` as the old code read it: a missing or null input object fails with the engine's own
 * message, which the page has always shown. (A plain Error: the router passes its message on; a
 * TypeError would be answered as a fault.)
 */
function field(input: unknown, key: string): unknown {
  if (input === undefined || input === null) throw new Error(`Cannot read properties of ${String(input)} (reading '${key}')`);
  return (input as Record<string, unknown>)[key];
}

/**
 * What the page receives for a record: its date fields are Dates in the old app, which
 * google.script.run cannot carry, so the page has always received null there. Whether to send the
 * real dates is the owner's call later. (The old record also carried `_rowIndex`, a Sheet row number.)
 */
function pageRecord(r: BonusRecord) {
  return { ...r, date: null, periodStart: null, periodEnd: null, createdAt: null };
}

/**
 * Admin or payroll admin: the bonuses waiting for approval, oldest first. The old function wrapped every
 * failure, a refusal included, as "rpcGetProposedBonuses: <message>": the router adds that prefix
 * (registry.ts ERROR_PREFIXED), so nothing is wrapped here.
 */
export const rpcGetProposedBonuses: RpcHandler = async (ctx) => {
  who(ctx);
  const names = new Map((await staff.getAll(ctx.db)).map((s) => [s.staffId, s.name]));
  return (await bonuses.getProposed(ctx.db)).map((b) => {
    const at = bonuses.instantsOf(b);
    return {
      bonusId: b.bonusId,
      staffId: b.staffId,
      staffName: names.get(b.staffId) || b.staffId,
      type: b.type,
      amount: b.amount || 0,
      reason: b.reason || "",
      date: at.date,
      status: b.status,
      periodStart: at.periodStart,
      periodEnd: at.periodEnd,
      company: b.company || "",
      sourceRunId: b.sourceRunId || "",
      notes: b.notes || "",
    };
  });
};

/** Admin or payroll admin: a proposed bonus becomes pending. */
export const rpcApproveBonus: RpcHandler = async (ctx, bonusId) => {
  const actorId = who(ctx).staffId;
  return pageRecord(await bonuses.approve(ctx.db, bonusId, actorId, ctx.now));
};

/** Admin or payroll admin: cancel a bonus that is not paid. */
export const rpcCancelBonus: RpcHandler = async (ctx, bonusId, reason) => {
  const actorId = who(ctx).staffId;
  return pageRecord(await bonuses.cancel(ctx.db, bonusId, actorId, reason || "", ctx.now));
};

/** Admin only: add a bonus, deduction, tip or adjustment; it is pending (payable). */
export const rpcCreateBonus: RpcHandler = async (ctx, input) => {
  const actorId = who(ctx).staffId;
  const staffId = field(input, "staffId");
  const type = field(input, "type");
  const amount = Number(field(input, "amount"));
  const reason = field(input, "reason");
  const date = field(input, "date") ? parseDate(field(input, "date")) : ctx.now;
  const company = field(input, "company") || "";
  const notes = field(input, "notes") || "";
  return pageRecord(await bonuses.create(ctx.db, { staffId, type, amount, reason, date, company, notes, actorId }, ctx.now));
};
