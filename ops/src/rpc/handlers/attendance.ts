// The five RPCs of Schedule and attendance (card P3-05a; rpcGetMe is in handlers/auth.ts). Thin: each calls the module and shapes
// the answer the way the old rpc* function in WebApp.gs did. Who may call is the contract's
// `roles`, applied by the router before these run; identity is ctx.session, never an argument
// (an `actorId` in the page's input is ignored, as the old RPCs built their own).
import * as attendance from "../../modules/attendance";
import type { AttendanceRecord } from "../../modules/attendance";
import type { RpcContext, RpcHandler } from "../types";

function who(ctx: RpcContext): { staffId: string } {
  if (ctx.session === null) throw new Error("NOT_LOGGED_IN");
  return ctx.session;
}

/**
 * `input.key` as the old code read it: a missing or null input object fails with the engine's own
 * message, which the page has always shown. (A plain Error: the router passes its message on; a
 * TypeError would be answered as a fault.)
 */
function field(input: unknown, key: string): unknown {
  if (input === undefined || input === null) throw new Error(`Cannot read properties of ${String(input)} (reading '${key}')`);
  return (input as Record<string, unknown>)[key];
}

/**
 * What the page receives for a record: every date field is a Date in the old app, which
 * google.script.run cannot carry, so the page has always received null there. Whether to send the
 * real dates is the owner's call later. (The old record also carried `_rowIndex`, a Sheet row number.)
 */
function pageRecord(r: AttendanceRecord) {
  return { ...r, date: null, actualStart: null, actualEnd: null, createdAt: null, modifiedAt: null };
}

/** Any signed-in person: the week's grid. */
export const rpcGetWeekSchedule: RpcHandler = (ctx, weekStartStr) => {
  who(ctx);
  return attendance.weekSchedule(ctx.db, weekStartStr, ctx.now);
};

/** Admin or manager. */
export const rpcScheduleShift: RpcHandler = async (ctx, input) => {
  const actorId = who(ctx).staffId;
  const staffId = field(input, "staffId");
  const date = field(input, "date");
  const scheduledStart = field(input, "scheduledStart") || "";
  const scheduledEnd = field(input, "scheduledEnd") || "";
  return pageRecord(await attendance.schedule(ctx.db, { staffId, date, scheduledStart, scheduledEnd, actorId }, ctx.now));
};

/** Admin or manager. */
export const rpcCancelScheduledShift: RpcHandler = async (ctx, attendanceId, reason) => {
  const actorId = who(ctx).staffId;
  return pageRecord(await attendance.cancel(ctx.db, attendanceId as string, actorId, reason || "", ctx.now));
};

/** Admin or manager. basis is "scheduled" or "actual". */
export const rpcAdjustAttendanceHours: RpcHandler = async (ctx, attendanceId, basis) => {
  const actorId = who(ctx).staffId;
  return pageRecord(await attendance.adjustHours(ctx.db, attendanceId as string, basis, actorId, ctx.now));
};

/** Admin only. */
export const rpcEditAttendanceTimes: RpcHandler = async (ctx, input) => {
  const actorId = who(ctx).staffId;
  const attendanceId = field(input, "attendanceId") as string;
  const start = attendance.parseInstant(field(input, "actualStart"));
  const end = attendance.parseInstant(field(input, "actualEnd"));
  return pageRecord(await attendance.editActualTimes(ctx.db, attendanceId, start, end, actorId, ctx.now));
};
