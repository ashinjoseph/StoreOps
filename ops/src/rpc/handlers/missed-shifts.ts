// The two RPCs of missed shifts (card P4-12b), the Operations app's own (ADR-0023; listed in
// ops/contracts/rpc-ops.json). Admin only: the router applies the contract's role rule before these
// run, and each handler checks again, so a mistake in the contract file cannot open them. Identity
// is ctx.session, never an argument: an `actorId` or `role` in the input is dropped.
import { requireRole } from "../../auth/roles";
import * as missed from "../../modules/missed-shifts";
import type { RpcContext, RpcHandler } from "../types";

function admin(ctx: RpcContext): string {
  requireRole(ctx.session, "admin");
  return (ctx.session as NonNullable<RpcContext["session"]>).staffId;
}

/** What the entry sheet may send; anything else in the input is dropped. */
const FIELDS = [
  "staffId",
  "company",
  "date",
  "startTime",
  "endTime",
  "openingFloat",
  "closingCashCounted",
  "cashSales",
  "creditCardSales",
  "debitCardSales",
  "cardTotalSales",
  "miscCashSales",
  "miscCreditSales",
  "miscDebitSales",
  "miscCardSales",
  "miscNotes",
  "lottoReserveCounted",
  "lottoTopupFromTill",
  "lottoReserveNote",
  "notes",
  "reason",
] as const;

function pick(input: unknown): missed.MissedShiftInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("input is required");
  const i = input as Record<string, unknown>;
  const picked: missed.MissedShiftInput = {};
  for (const k of FIELDS) if (Object.prototype.hasOwnProperty.call(i, k) && i[k] !== undefined) picked[k] = i[k];
  return picked;
}

/** Admin: what entering this shift would write and answer, writing nothing. */
export const rpcPreviewMissedShift: RpcHandler = async (ctx, input) => {
  const actorId = admin(ctx);
  return missed.preview(ctx.db, pick(input), actorId, await ctx.config(), ctx.now);
};

/** Admin: enter a shift that was never opened or closed in the app. */
export const rpcEnterMissedShift: RpcHandler = async (ctx, input) => {
  const actorId = admin(ctx);
  return missed.enter(ctx.db, pick(input), actorId, await ctx.config(), ctx.now);
};
