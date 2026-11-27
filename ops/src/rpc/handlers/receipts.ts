// The RPCs of the Receipts and Businesses screens (card P5-12a), the Operations app's own (ADR-0023;
// listed in ops/contracts/rpc-ops.json). The router applies the contract's roles before these run, and
// each handler checks again, so a mistake in the contract file cannot open them. Identity and role are
// ctx.session's, never an argument: a `role`, `actorId`, `addedBy` or `staffId` in the input is ignored.
// Adding an original is not an RPC: it is PUT /files/receipt-original (receipts/routes.ts).
import { requireRole } from "../../auth/roles";
import { NOT_LOGGED_IN, type Session } from "../../auth/types";
import * as businesses from "../../receipts/businesses";
import * as originals from "../../receipts/originals";
import type { RpcContext, RpcHandler } from "../types";

function caller(ctx: RpcContext, roles: readonly string[] | null): Session {
  if (!ctx.session) throw new Error(NOT_LOGGED_IN);
  if (roles !== null) requireRole(ctx.session, roles);
  return ctx.session;
}
const fields = (input: unknown): Record<string, unknown> => (typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {});
const viewer = (s: Session): originals.Viewer => ({ staffId: s.staffId, role: s.role });

/** Anyone signed in. Admin, manager, payroll admin: a page of one status, with counts. An employee: their own of the last 7 days. */
export const rpcGetReceiptInbox: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, null);
  const o = fields(input);
  const inbox = await originals.inbox(ctx.db, viewer(s), { status: o["status"], before: o["before"], limit: o["limit"] }, ctx.now);
  return { ...inbox, maxMb: originals.maxBytes(await ctx.config()) / originals.MB };
};

/** Admin or manager: `{ id, aside, reason }`. */
export const rpcSetReceiptAside: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, originals.SET_ASIDE_ROLES);
  const o = fields(input);
  return originals.setAside(ctx.db, { id: o["id"], aside: o["aside"], reason: o["reason"] }, viewer(s), ctx.now);
};

/** Admin or manager: `{ id, business }`, business cstore, vape or null, on a waiting original. */
export const rpcSetReceiptBusiness: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, originals.SET_ASIDE_ROLES);
  const o = fields(input);
  return originals.setBusiness(ctx.db, { id: o["id"], business: o["business"] }, viewer(s), ctx.now);
};

/** Admin, manager, payroll admin: both businesses and their live signs. Only an admin may change them. */
export const rpcGetBusinesses: RpcHandler = async (ctx) => {
  const s = caller(ctx, ["admin", "manager", "payroll_admin"]);
  return { canEdit: s.role === "admin", businesses: await businesses.list(ctx.db, await ctx.config()) };
};

/** Admin: `{ business, legalName, hstNumber, notes }`. */
export const rpcUpdateBusiness: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, ["admin"]);
  const o = fields(input);
  return businesses.update(ctx.db, { business: o["business"], legalName: o["legalName"], hstNumber: o["hstNumber"], notes: o["notes"] }, { staffId: s.staffId }, await ctx.config(), ctx.now);
};

/** Admin: `{ business, kind, value, supplier }`. */
export const rpcAddBusinessSign: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, ["admin"]);
  const o = fields(input);
  return businesses.addSign(ctx.db, { business: o["business"], kind: o["kind"], value: o["value"], supplier: o["supplier"] }, { staffId: s.staffId }, await ctx.config(), ctx.now);
};

/** Admin: `{ id }`. The sign is marked removed and kept. */
export const rpcRemoveBusinessSign: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, ["admin"]);
  return businesses.removeSign(ctx.db, { id: fields(input)["id"] }, { staffId: s.staffId }, await ctx.config(), ctx.now);
};
