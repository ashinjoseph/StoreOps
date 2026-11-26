// The three read RPCs of Staff. Thin: each calls the module and shapes the answer
// the way the old rpc* function in WebApp.gs did. Who may call is the contract's
// `roles`, applied by the router before these run.
import * as staff from "../../modules/staff";
import type { RpcHandler } from "../types";

/** Pre-auth, so the login screen can fill its dropdown. Like the old one, it answers { success: false, error } instead of throwing. */
export const rpcGetActiveStaffForLogin: RpcHandler = async (ctx) => {
  try {
    return { success: true, staff: (await staff.getActive(ctx.db)).map((s) => ({ staffId: s.staffId, name: s.name })) };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
};

/** Any signed-in person: { staffId, name, active } for everyone, sorted by name. */
export const rpcGetStaffDirectory: RpcHandler = (ctx) => staff.directory(ctx.db);

/** Admin only. No PIN (the old one stripped it too). */
export const rpcGetAllStaff: RpcHandler = async (ctx) =>
  (await staff.getAll(ctx.db)).map((s) => ({
    staffId: s.staffId,
    name: s.name,
    hourlyRate: s.hourlyRate,
    active: s.active,
    role: s.role,
    companiesAuthorized: s.companiesAuthorized,
    email: s.email,
    // A Date in the old app, which google.script.run cannot carry: the page has always received null.
    startDate: null,
  }));
