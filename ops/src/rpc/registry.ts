// Every RPC handler the new app has so far, and how the router resolves a
// session. A card that ports a module adds its handlers here and nowhere else.
// The router answers NOT_PORTED for a contract entry with no handler yet.
import { validateSession } from "../auth/sessions";
import type { Session } from "../auth/types";
import type { Tx } from "../db/tx";
import { loadConfig } from "../lib/config";
import { rpcCreateAssistantKey, rpcGetAssistantKeys, rpcRevokeAssistantKey } from "./handlers/assistants";
import { rpcAdjustAttendanceHours, rpcCancelScheduledShift, rpcEditAttendanceTimes, rpcGetWeekSchedule, rpcScheduleShift } from "./handlers/attendance";
import { rpcCorrectAttendance, rpcGetAttendanceDay } from "./handlers/attendance-corrections";
import { rpcGetMe, rpcLogin, rpcLogout } from "./handlers/auth";
import { rpcApproveBonus, rpcCancelBonus, rpcCreateBonus, rpcGetProposedBonuses } from "./handlers/bonuses";
import { rpcGetBootstrap, rpcGetMyShiftState } from "./handlers/bootstrap";
import { rpcGetCashHandoverHistory, rpcGetCashOutstandingFor, rpcGetCashPosition, rpcRecordCashHandover, rpcVoidCashHandover } from "./handlers/cash-handling";
import { rpcCreateCommissionRule, rpcGetCommissionRules, rpcUpdateCommissionRule } from "./handlers/commission-rules";
import { rpcGetCommissionRuns, rpcRunCommissionEngine } from "./handlers/commissions";
import { rpcCheckWhatsApp } from "./handlers/notifier";
import { rpcGetReconciliation, rpcReconcileDay } from "./handlers/reconcile";
import { rpcGetSalesDashboard } from "./handlers/sales-dashboard";
import { rpcGetSettings, rpcUpdateSetting } from "./handlers/settings";
import { rpcCreateStaff, rpcGetStaffAdmin, rpcPreviewRateChange, rpcSetStaffPin, rpcUpdateStaff } from "./handlers/staff-admin";
import { rpcCloseShift, rpcNotifyShiftOpen, rpcOpenShift } from "./handlers/shifts";
import { rpcCorrectTillSession, rpcGetTillCorrection } from "./handlers/till-corrections";
import { rpcGetMyOwedSummary, rpcGetOwedSummary, rpcGetPaymentHistory, rpcGetPayrollOverview, rpcPayBonus, rpcPayShifts, rpcUndoPayment } from "./handlers/payments";
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
  rpcGetAttendanceDay,
  rpcCorrectAttendance,
  rpcCheckWhatsApp,
  rpcGetProposedBonuses,
  rpcApproveBonus,
  rpcCancelBonus,
  rpcCreateBonus,
  rpcGetCommissionRules,
  rpcCreateCommissionRule,
  rpcUpdateCommissionRule,
  rpcGetCommissionRuns,
  rpcRunCommissionEngine,
  rpcOpenShift,
  rpcCloseShift,
  rpcNotifyShiftOpen,
  rpcGetPayrollOverview,
  rpcGetOwedSummary,
  rpcGetMyOwedSummary,
  rpcPayShifts,
  rpcPayBonus,
  rpcUndoPayment,
  rpcGetPaymentHistory,
  rpcGetSalesDashboard,
  rpcGetCashPosition,
  rpcRecordCashHandover,
  rpcVoidCashHandover,
  rpcGetCashOutstandingFor,
  rpcGetCashHandoverHistory,
  rpcGetBootstrap,
  rpcGetMyShiftState,
  rpcReconcileDay,
  rpcGetReconciliation,
  rpcGetSettings,
  rpcUpdateSetting,
  rpcGetStaffAdmin,
  rpcCreateStaff,
  rpcUpdateStaff,
  rpcPreviewRateChange,
  rpcSetStaffPin,
  rpcGetTillCorrection,
  rpcCorrectTillSession,
  rpcGetAssistantKeys,
  rpcCreateAssistantKey,
  rpcRevokeAssistantKey,
};

/** What the router calls for every RPC the contract marks `needs_session`. Throws Error("NOT_LOGGED_IN"). */
export async function resolveSession(db: Tx, token: unknown, now: Date): Promise<Session> {
  return validateSession(db, token as string, await loadConfig(db), now);
}

/**
 * RPCs whose old function wrapped every error as "<rpcName>: <message>" (a try/catch around the
 * whole body in WebApp.gs, so refusals such as NOT_LOGGED_IN and FORBIDDEN carry it too). The
 * page shows that text, so the router keeps it: it adds the prefix to every message meant for the
 * person, for these names only. Handlers never add it themselves.
 */
export const ERROR_PREFIXED: ReadonlySet<string> = new Set([
  "rpcGetMyShiftState",
  "rpcOpenShift",
  "rpcCloseShift",
  "rpcGetPayrollOverview",
  "rpcGetOwedSummary",
  "rpcPayShifts",
  "rpcPayBonus",
  "rpcGetProposedBonuses",
  "rpcGetCommissionRuns",
  "rpcGetPaymentHistory",
]);
