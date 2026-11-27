// The audit log screen's one call (card P4-13). It exists only in the Operations app (ADR-0023;
// ops/contracts/rpc-ops.json). Who may call is the contract's `roles` (admin), applied by the router before
// this runs; the check is made here as well, in case the contract is ever wrong. Identity is ctx.session,
// never an argument: a `role` or `actorId` in the page's input is only ever read as a filter on the log.
// The module reads and writes nothing else and takes no lock; reading the log is not itself logged.
import { requireRole } from "../../auth/roles";
import * as auditView from "../../modules/audit-view";
import type { RpcHandler } from "../types";

/** Admin only: one page of the audit log, newest first, filtered as `input` says. */
export const rpcGetAuditLog: RpcHandler = async (ctx, input) => {
  requireRole(ctx.session, "admin");
  return auditView.page(ctx.db, input);
};
