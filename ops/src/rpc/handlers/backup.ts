// "Make a copy now" on the Settings screen (card P4-06a; ADR-0023, ADR-0028). It exists only in the Operations
// app. Admin only: the contract's `roles` are applied by the router before this runs, and the check is made
// here as well, in case the contract is ever wrong. Identity is ctx.session, never an argument.
//
// The copy reads the whole database in one read-only transaction of its OWN connection (the router's
// transaction for this call stays idle and commits empty), writes the files to the BACKUPS bucket, and writes
// its one audit row. The page is told in words: what was copied, or why not. A copy already running is
// refused with a readable message (a plain Error: the router shows its message as it is).
import { requireRole } from "../../auth/roles";
import { runBackup } from "../../backup/nightly";
import { backupStorage, isBackupBucket } from "../../backup/storage";
import { connect } from "../../db/client";
import { connectionString, type ConnectionEnv } from "../../db/connection";
import type { RpcContext, RpcHandler } from "../types";

export const BUSY_MESSAGE = "A copy is already being made. Wait a few minutes, then look at the line at the top of this screen.";

function admin(ctx: RpcContext): { staffId: string } {
  requireRole(ctx.session, "admin");
  return ctx.session as { staffId: string };
}

/** Admin only. Answers `{ folder, tables, rows, bytes, files, seconds, message }`, or throws a message for the person. */
export const rpcRunBackupNow: RpcHandler = async (ctx) => {
  const actorId = admin(ctx).staffId;
  const env = ctx.env;
  // The call's start plus the time that has passed since (performance.now only moves forward), so the audit row can say how long it took.
  const t0 = performance.now();
  const result = await runBackup({
    openDb: async () => connect(connectionString(env as ConnectionEnv)),
    storage: isBackupBucket(env["BACKUPS"]) ? backupStorage(env["BACKUPS"]) : null,
    now: () => new Date(ctx.now.getTime() + (performance.now() - t0)),
    log: (entry) => console.error(entry),
    actorId,
  });
  if (!result.ok && result.busy) throw new Error(BUSY_MESSAGE);
  if (!result.ok) throw new Error(`The copy did not finish: ${result.reason}. No copy was made from this try.`);
  return {
    folder: result.folder,
    tables: result.tables,
    rows: result.rows,
    bytes: result.bytes,
    files: result.files,
    seconds: result.seconds,
    message: `Copy made: ${result.tables} tables, ${result.rows} rows, in the folder ${result.folder}.`,
  };
};
