// The three RPCs of the Rules screen (card P3-10a). Thin: each calls the module and shapes the answer
// the way the old rpc* function in WebApp.gs did. Who may call is the contract's `roles`, applied by
// the router before these run; identity is ctx.session, never an argument (an `actorId` or
// `createdBy` in the page's input is ignored, as the old RPCs built their own).
import { parseDate } from "../../lib/dates";
import * as rules from "../../modules/commission-rules";
import type { RuleRecord } from "../../modules/commission-rules";
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
 * What the page receives for a record from create or update: its date fields are Dates in the old
 * app, which google.script.run cannot carry, so the page has always received null there. Whether to
 * send the real dates is the owner's call later. (The old record also carried `_rowIndex`.)
 */
function pageRecord(r: RuleRecord) {
  return { ...r, effectiveFrom: null, effectiveTo: null, createdAt: null };
}

/** Admin, manager or payroll admin: every rule, with its dates as ISO instants (Toronto midnight), as the old list sent them. */
export const rpcGetCommissionRules: RpcHandler = async (ctx) => {
  who(ctx);
  return (await rules.getAll(ctx.db)).map((r) => ({
    ruleId: r.ruleId,
    name: r.name,
    appliesTo: r.appliesTo,
    staffId: r.staffId,
    company: r.company,
    threshold: r.threshold,
    percentage: r.percentage,
    ruleType: r.ruleType,
    fixedAmount: r.fixedAmount,
    active: r.active,
    effectiveFrom: rules.instantOf(r.effectiveFrom)?.toISOString() ?? null,
    effectiveTo: rules.instantOf(r.effectiveTo)?.toISOString() ?? null,
    notes: r.notes,
  }));
};

/** Admin or payroll admin: add a rule. Reads the input in the order the old function did. */
export const rpcCreateCommissionRule: RpcHandler = async (ctx, input) => {
  const actorId = who(ctx).staffId;
  const name = field(input, "name");
  const appliesTo = field(input, "appliesTo");
  const staffId = field(input, "staffId");
  const company = field(input, "company");
  const threshold = Number(field(input, "threshold"));
  const percentage = Number(field(input, "percentage"));
  const ruleType = field(input, "ruleType") || "percentage";
  const fixedAmount = Number(field(input, "fixedAmount")) || 0;
  const active = field(input, "active") !== false;
  const effectiveFrom = parseDate(field(input, "effectiveFrom"));
  const effectiveTo = field(input, "effectiveTo") ? parseDate(field(input, "effectiveTo")) : null;
  const notes = field(input, "notes") || "";
  return pageRecord(await rules.create(ctx.db, { name, appliesTo, staffId, company, threshold, percentage, ruleType, fixedAmount, active, effectiveFrom, effectiveTo, notes, actorId }, ctx.now));
};

/** Admin or payroll admin: patch a rule. A key the page leaves out stays as it is. */
export const rpcUpdateCommissionRule: RpcHandler = async (ctx, input) => {
  const actorId = who(ctx).staffId;
  const ruleId = field(input, "ruleId");
  const name = field(input, "name");
  const num = (key: string): number | undefined => (field(input, key) !== undefined ? Number(field(input, key)) : undefined);
  const threshold = num("threshold");
  const percentage = num("percentage");
  const fixedAmount = num("fixedAmount");
  const active = field(input, "active");
  const effectiveTo = field(input, "effectiveTo") !== undefined ? (field(input, "effectiveTo") ? parseDate(field(input, "effectiveTo")) : null) : undefined;
  const notes = field(input, "notes");
  return pageRecord(await rules.update(ctx.db, { ruleId, name, threshold, percentage, fixedAmount, active, effectiveTo, notes, actorId }, ctx.now));
};
