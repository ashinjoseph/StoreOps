// The one small read the Commissions screen makes to say "The Monday run is paused (Settings)." (card P4-13).
// It exists only in the Operations app (ADR-0023; ops/contracts/rpc-ops.json). Settings are for admins only
// (rpcGetSettings), but the people who open the Commissions screen are an admin, a manager and a payroll
// admin, and all three should be told the run is paused; this answers that one yes or no and nothing else.
// Who may call is the contract's `roles`, applied by the router before this runs; the check is made here as
// well. The value is the setting commission_run_paused, read the way the Monday run reads it.
import { requireRole } from "../../auth/roles";
import type { RpcHandler } from "../types";

export const rpcGetCommissionRunPaused: RpcHandler = async (ctx) => {
  requireRole(ctx.session, ["admin", "manager", "payroll_admin"]);
  return { paused: (await ctx.config()).boolean("commission_run_paused") };
};
