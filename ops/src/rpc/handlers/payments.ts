// The seven RPCs of the Payroll, My Pay and History screens (card P3-09b). Thin: each calls the
// Payments module and shapes the answer the way the old rpc* function in WebApp.gs did. Who may call
// is the contract's `roles`, applied by the router before these run; identity is ctx.session, never
// an argument (an `actorId` in the page's input is ignored, as the old RPCs built their own). Five of
// the old functions wrapped every error as "<rpcName>: <message>"; the router adds that prefix
// (registry.ts ERROR_PREFIXED), so nothing is wrapped here. rpcGetMyOwedSummary and rpcUndoPayment
// had no wrapper.
import * as payments from "../../modules/payments";
import type { OwedSummary, PaymentDeps, PaymentRecord } from "../../modules/payments";
import * as staff from "../../modules/staff";
import type { Session } from "../../auth/types";
import type { RpcContext, RpcHandler } from "../types";

function who(ctx: RpcContext): Session {
  if (ctx.session === null) throw new Error("NOT_LOGGED_IN");
  return ctx.session;
}

/**
 * `input.key` as the old code read it: a missing or null input object fails with the engine's own
 * message, which the page has always shown. (A plain Error: the router passes its message on.)
 */
function field(input: unknown, key: string): unknown {
  if (input === undefined || input === null) throw new Error(`Cannot read properties of ${String(input)} (reading '${key}')`);
  return (input as Record<string, unknown>)[key];
}

async function deps(ctx: RpcContext): Promise<PaymentDeps> {
  return { config: await ctx.config(), env: ctx.env, fetch: ctx.fetch, now: ctx.now };
}

/**
 * The fields a summary ADDS when the person has worked days with no rate set (ADR-0031), and nothing
 * otherwise, so that for everyone else the answer is exactly the old one.
 */
function noRateFields(o: Partial<OwedSummary>): { noRateDayCount?: number; noRateDays?: OwedSummary["noRateDays"] } {
  return o.noRateDays && o.noRateDays.length > 0 ? { noRateDayCount: o.noRateDays.length, noRateDays: o.noRateDays } : {};
}

/** Admin or payroll admin: every active person and what they are owed. Five queries for everyone. */
export const rpcGetPayrollOverview: RpcHandler = async (ctx) => {
  who(ctx);
  const people = await staff.getActive(ctx.db);
  const ids = people.map((s) => s.staffId);
  const owed = await payments.getOwedSummaries(ctx.db, ids);
  // The rate as stored: null when blank ("no rate set"), where the old answer had 0 (ADR-0031).
  const rates = await staff.hourlyRatesOf(ctx.db, ids);
  return people.map((s) => {
    const o: Partial<OwedSummary> = owed.get(s.staffId) ?? {};
    return {
      staffId: s.staffId,
      staffName: s.name,
      hourlyRate: rates.has(s.staffId) ? (rates.get(s.staffId) as number | null) : s.hourlyRate,
      shiftsOwed: o.shiftsOwed || 0,
      bonusesOwed: o.bonusesOwed || 0,
      totalOwed: o.totalOwed || 0,
      unpaidShiftCount: (o.unpaidShifts || []).length,
      pendingBonusCount: (o.pendingBonuses || []).length,
      hasMismatch: !!o.hasMismatch,
      mismatchCount: o.mismatchCount || 0,
      ...noRateFields(o),
    };
  });
};

/** Admin or payroll admin: what one person is owed. */
export const rpcGetOwedSummary: RpcHandler = async (ctx, staffId) => {
  who(ctx);
  const result = await payments.getOwedSummary(ctx.db, staffId);
  return {
    staffId: result.staffId || staffId,
    shiftsOwed: result.shiftsOwed || 0,
    bonusesOwed: result.bonusesOwed || 0,
    totalOwed: result.totalOwed || 0,
    unpaidShifts: result.unpaidShifts || [],
    pendingBonuses: result.pendingBonuses || [],
    hasMismatch: !!result.hasMismatch,
    mismatchCount: result.mismatchCount || 0,
    ...noRateFields(result),
  };
};

/** Anyone signed in: what they themselves are owed. Only the session says who; arguments are ignored. */
export const rpcGetMyOwedSummary: RpcHandler = async (ctx) => {
  const session = who(ctx);
  // The rate as stored: null when blank ("no rate set"), where the old answer had 0 (ADR-0031). No row: 0, as before.
  const rates = await staff.hourlyRatesOf(ctx.db, [session.staffId]);
  const summary = await payments.getOwedSummary(ctx.db, session.staffId);
  return {
    staffId: session.staffId,
    staffName: session.name,
    hourlyRate: rates.has(session.staffId) ? (rates.get(session.staffId) as number | null) : 0,
    shiftsOwed: summary.shiftsOwed,
    bonusesOwed: summary.bonusesOwed,
    totalOwed: summary.totalOwed,
    unpaidShifts: summary.unpaidShifts,
    pendingBonuses: summary.pendingBonuses,
    ...noRateFields(summary),
  };
};

/** Admin or payroll admin: pay an amount against one person's unpaid shifts, oldest first. */
export const rpcPayShifts: RpcHandler = async (ctx, input) => {
  const actorId = who(ctx).staffId;
  const result = await payments.payShifts(
    ctx.db,
    {
      staffId: field(input, "staffId"),
      amount: Number(field(input, "amount")),
      method: field(input, "method") || "cash",
      notes: field(input, "notes") || "",
      overrideMismatch: field(input, "overrideMismatch") === true,
      actorId,
    },
    await deps(ctx),
  );
  return {
    paymentId: result.paymentId,
    totalAmount: Number(result.totalAmount) || 0,
    kind: result.kind || "shifts",
    itemsCreated: (result.itemsCreated || []).map((it) => ({
      itemId: it.itemId,
      attendanceId: it.attendanceId,
      dateStr: it.dateStr || "",
      amount: Number(it.amount) || 0,
      isPartial: !!it.isPartial,
    })),
    summary: {
      shiftsOwedBefore: Number(result.summary.shiftsOwedBefore) || 0,
      shiftsOwedAfter: Number(result.summary.shiftsOwedAfter) || 0,
      fullyPaidCount: Number(result.summary.fullyPaidCount) || 0,
      partialCount: Number(result.summary.partialCount) || 0,
    },
    // ADDED only when days with no rate set were skipped (ADR-0031): they are never paid, and named.
    ...(result.skippedNoRate && result.skippedNoRate.length > 0 ? { skippedNoRate: result.skippedNoRate } : {}),
  };
};

/** Admin or payroll admin: pay one pending bonus, in full or in part. */
export const rpcPayBonus: RpcHandler = async (ctx, input) => {
  const actorId = who(ctx).staffId;
  const result = await payments.payBonus(
    ctx.db,
    {
      bonusId: field(input, "bonusId"),
      amount: Number(field(input, "amount")),
      method: field(input, "method") || "cash",
      notes: field(input, "notes") || "",
      actorId,
    },
    await deps(ctx),
  );
  return {
    paymentId: result.paymentId,
    bonusId: result.bonusId,
    amount: Number(result.amount) || 0,
    isPartial: !!result.isPartial,
    newBonusStatus: result.newBonusStatus || "pending",
    kind: "bonus",
  };
};

/**
 * Admin or payroll admin: undo a payment. It is voided, never deleted; a reason, when the page sends
 * one after the id (the old RPC took none), is kept with it.
 */
export const rpcUndoPayment: RpcHandler = async (ctx, paymentId, reason) => {
  const actorId = who(ctx).staffId;
  return payments.undo(ctx.db, paymentId, actorId, { now: ctx.now }, typeof reason === "string" ? reason : null);
};

/**
 * Anyone signed in. An employee sees only their own payments (by the session, whatever is passed);
 * a manager, payroll admin or admin sees everyone's. `limit` is `Number(limit) || 25`, then
 * JavaScript's slice (a negative limit drops that many of the oldest).
 */
export const rpcGetPaymentHistory: RpcHandler = async (ctx, limitArg) => {
  const session = who(ctx);
  const limit = Number(limitArg) || 25;

  let list: PaymentRecord[];
  let nameOf: (p: PaymentRecord) => string;
  if (session.role === "employee") {
    list = (await payments.getPaymentsForStaff(ctx.db, session.staffId)).slice(0, limit);
    nameOf = () => session.name;
  } else {
    list = await payments.getRecent(ctx.db, limit);
    const names = new Map((await staff.getAll(ctx.db)).map((s) => [s.staffId, s.name]));
    nameOf = (p) => names.get(p.staffId) || p.staffId;
  }
  const items = await payments.getItemsForPayments(
    ctx.db,
    list.map((p) => p.paymentId),
  );
  return list.map((p, i) => {
    const at = payments.instantOf(p);
    return {
      paymentId: p.paymentId,
      staffId: p.staffId,
      staffName: nameOf(p),
      paidOn: at ? at.toISOString() : null,
      totalAmount: p.totalAmount || 0,
      method: p.method || "",
      recordedBy: p.recordedBy || "",
      notes: p.notes || "",
      items: (items[i] ?? []).map((it) => ({
        itemId: it.itemId,
        paymentId: it.paymentId,
        itemType: it.itemType,
        refId: it.refId,
        amount: it.amount || 0,
        notes: it.notes || "",
      })),
    };
  });
};
