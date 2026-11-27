// The two RPCs of till corrections (card P4-12a), the Operations app's own (ADR-0023; listed in
// ops/contracts/rpc-ops.json). Admin only: the router applies the contract's role rule before these
// run, and each handler checks again, so a mistake in the contract file cannot open them. Identity
// is ctx.session, never an argument: an `actorId` or `role` in the input is ignored.
import { requireRole } from "../../auth/roles";
import * as corrections from "../../modules/till-corrections";
import type { RpcContext, RpcHandler } from "../types";

function admin(ctx: RpcContext): string {
  requireRole(ctx.session, "admin");
  return (ctx.session as NonNullable<RpcContext["session"]>).staffId;
}

/** The figures the correction sheet may send; anything else in the input is dropped. */
const FIELDS = [
  "sessionId",
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

/** Admin: one closed till as the correction sheet shows it. */
export const rpcGetTillCorrection: RpcHandler = async (ctx, sessionId) => {
  admin(ctx);
  return corrections.getCorrection(ctx.db, sessionId, await ctx.config(), ctx.now);
};

/** Admin: set a closed till's figures to what was really counted and sold. */
export const rpcCorrectTillSession: RpcHandler = async (ctx, input) => {
  const actorId = admin(ctx);
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("input is required");
  const i = input as Record<string, unknown>;
  const picked: corrections.TillCorrectionInput = {};
  for (const k of FIELDS) if (Object.prototype.hasOwnProperty.call(i, k) && i[k] !== undefined) picked[k] = i[k];
  return corrections.correct(ctx.db, picked, actorId, await ctx.config(), ctx.now);
};
