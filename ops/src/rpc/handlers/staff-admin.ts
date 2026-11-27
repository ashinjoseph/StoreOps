// The five RPCs of the Staff screen (card P4-11), the Operations app's own (ADR-0023; listed in
// ops/contracts/rpc-ops.json). The router applies the contract's roles before these run (list and add:
// admin and manager; change, rate preview and PIN: admin), and each handler checks again, so a mistake in
// the contract file cannot open them. Identity and role are ctx.session's, never an argument: a `role`,
// `actorId` or `viewerRole` in the input is ignored.
import { requireRole } from "../../auth/roles";
import type { Session } from "../../auth/types";
import * as staffAdmin from "../../modules/staff-admin";
import type { RpcContext, RpcHandler } from "../types";
import { pinPepper } from "./auth";

function caller(ctx: RpcContext, roles: readonly string[]): Session {
  requireRole(ctx.session, roles);
  return ctx.session as Session;
}
const viewer = (s: Session): staffAdmin.Viewer => ({ staffId: s.staffId, role: s.role });

/** Admin or manager: everyone; an admin sees every field, a manager only name, role, tills, active and whether a PIN is set. */
export const rpcGetStaffAdmin: RpcHandler = async (ctx) => {
  const s = caller(ctx, ["admin", "manager"]);
  return staffAdmin.list(ctx.db, await ctx.config(), viewer(s), ctx.now);
};

/** Admin or manager: add a person. A manager may add an employee only, with no rate, email or notes. */
export const rpcCreateStaff: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, ["admin", "manager"]);
  if (input === null || typeof input !== "object") throw new Error("input is required");
  return staffAdmin.create(ctx.db, input, viewer(s), { pepper: pinPepper(ctx.env), config: await ctx.config(), now: ctx.now });
};

/** Admin: change a person (every field), deactivate or reactivate them, and optionally give unpaid days a new rate. */
export const rpcUpdateStaff: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, ["admin"]);
  if (input === null || typeof input !== "object") throw new Error("input is required");
  return staffAdmin.update(ctx.db, input, viewer(s), { config: await ctx.config(), now: ctx.now });
};

/** Admin: what a new rate from a date would do to unpaid days. Changes nothing. */
export const rpcPreviewRateChange: RpcHandler = async (ctx, input) => {
  caller(ctx, ["admin"]);
  if (input === null || typeof input !== "object") throw new Error("input is required");
  return staffAdmin.previewRateChange(ctx.db, input, ctx.now);
};

/** Admin: set anyone's PIN (their own included). Their other sessions end and a lockout is lifted. */
export const rpcSetStaffPin: RpcHandler = async (ctx, input) => {
  const s = caller(ctx, ["admin"]);
  if (input === null || typeof input !== "object") throw new Error("input is required");
  return staffAdmin.setStaffPin(ctx.db, input, { ...viewer(s), expiresAt: s.expiresAt }, { pepper: pinPepper(ctx.env), config: await ctx.config(), now: ctx.now });
};
