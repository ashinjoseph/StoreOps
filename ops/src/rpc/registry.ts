// Every RPC handler the new app has so far, and how the router resolves a
// session. A card that ports a module adds its handlers here and nowhere else.
// The router answers NOT_PORTED for a contract entry with no handler yet.
import { validateSession } from "../auth/sessions";
import type { Session } from "../auth/types";
import type { Tx } from "../db/tx";
import { loadConfig } from "../lib/config";
import { rpcAdjustAttendanceHours, rpcCancelScheduledShift, rpcEditAttendanceTimes, rpcGetWeekSchedule, rpcScheduleShift } from "./handlers/attendance";
import { rpcGetMe, rpcLogin, rpcLogout } from "./handlers/auth";
import { rpcCheckWhatsApp } from "./handlers/notifier";
import { rpcGetActiveStaffForLogin, rpcGetAllStaff, rpcGetStaffDirectory } from "./handlers/staff";
import type { RpcHandlers } from "./types";

export const handlers: RpcHandlers = {
  rpcLogin,
  rpcLogout,
  rpcGetActiveStaffForLogin,
  rpcGetStaffDirectory,
  rpcGetAllStaff,
  rpcGetMe,
  rpcGetWeekSchedule,
  rpcScheduleShift,
  rpcCancelScheduledShift,
  rpcAdjustAttendanceHours,
  rpcEditAttendanceTimes,
  rpcCheckWhatsApp,
};

/** What the router calls for every RPC the contract marks `needs_session`. Throws Error("NOT_LOGGED_IN"). */
export async function resolveSession(db: Tx, token: unknown, now: Date): Promise<Session> {
  return validateSession(db, token as string, await loadConfig(db), now);
}
