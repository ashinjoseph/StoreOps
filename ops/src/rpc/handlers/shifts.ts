// The open and the close (card P3-05b): rpcOpenShift, rpcCloseShift, rpcNotifyShiftOpen. Thin: each
// shapes the page's input the way the old rpc* function in WebApp.gs did, calls the module, and
// shapes the answer. The contract gives all three to any signed-in person; identity is ctx.session,
// never an argument (an `actorId` in the page's input is ignored, as before).
//
// The old rpcOpenShift and rpcCloseShift prefixed every error with "rpcOpenShift: " /
// "rpcCloseShift: ". These handlers do not: the router adds that prefix for the RPCs that had it
// (orchestrator's ruling), so it is not done twice.
//
// None of the three answers carries a Date: rpcOpenShift sends startTime as an ISO string, as before.
import { DbError } from "../../db/client";
import { wallClock } from "../../lib/dates";
import * as audit from "../../lib/audit";
import * as notifier from "../../modules/notifier";
import * as tillSessions from "../../modules/till-sessions";
import type { RpcContext, RpcHandler } from "../types";
import type { Session } from "../../auth/types";

function who(ctx: RpcContext): Session {
  if (ctx.session === null) throw new Error("NOT_LOGGED_IN");
  return ctx.session;
}

/** `input.key` as the old code read it: a missing or null input object fails with the engine's own message. */
function field(input: unknown, key: string): unknown {
  if (input === undefined || input === null) throw new Error(`Cannot read properties of ${String(input)} (reading '${key}')`);
  return (input as Record<string, unknown>)[key];
}

/** WebApp.gs num_: absent or '' is null (not sent), anything else `Number(v) || 0`. */
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v) || 0);

/**
 * Any signed-in person opens their own till. An admin may name someone else (input.staffId); the
 * actor is still the admin. A manager may not.
 */
export const rpcOpenShift: RpcHandler = async (ctx, input) => {
  const session = who(ctx);
  const staffId = field(input, "staffId") || session.staffId;
  if (staffId !== session.staffId && session.role !== "admin") throw new Error("FORBIDDEN: can only open your own shift");
  const result = await tillSessions.open(
    ctx.db,
    {
      staffId,
      company: field(input, "company"),
      openingCount: Number(field(input, "openingCount")),
      openingNote: field(input, "openingNote") || "",
      actorId: session.staffId,
    },
    { config: await ctx.config(), now: ctx.now },
  );
  if (!result) throw new Error("TillSessions.open returned null");
  return {
    sessionId: result.sessionId,
    company: result.company,
    staffId: result.staffId,
    status: result.status,
    openingFloat: Number(result.openingFloat) || 0,
    startTime: result.startTime ? result.startTime.toISOString() : null,
  };
};

/** The cashier who opened closes; a manager or admin may close anyone's. */
export const rpcCloseShift: RpcHandler = async (ctx, input) => {
  const session = who(ctx);
  const sessionId = field(input, "sessionId");
  const target = await tillSessions.getById(ctx.db, sessionId);
  if (!target) throw new Error("Session not found: " + String(sessionId));
  if (target.staffId !== session.staffId && session.role !== "admin" && session.role !== "manager") {
    throw new Error("FORBIDDEN: only the cashier who opened, or an admin/manager, can close this shift");
  }
  const i = input as Record<string, unknown>;
  const result = await tillSessions.close(
    ctx.db,
    {
      sessionId: i["sessionId"],
      cashSales: Number(i["cashSales"]) || 0,
      // null, not 0, when the page did not send it: the row's card shape follows presence.
      creditCard: num(i["creditCardSales"]),
      debitCard: num(i["debitCardSales"]),
      cashback: Number(i["cashbackPaid"]) || 0,
      miscCash: Number(i["miscCashSales"]) || 0,
      miscCredit: num(i["miscCreditSales"]),
      miscDebit: num(i["miscDebitSales"]),
      cardTotal: num(i["cardTotalSales"]),
      miscCard: num(i["miscCardSales"]),
      miscNotes: i["miscNotes"] || "",
      physicalCount: Number(i["physicalCount"]),
      // null means "the page didn't ask", read as "still at the expected balance".
      lottoCounted: i["lottoCounted"] == null ? null : Number(i["lottoCounted"]),
      lottoTopupFromTill: Number(i["lottoTopupFromTill"]) || 0,
      lottoNote: i["lottoNote"] || "",
      notes: i["closingNote"] || "",
      actorId: session.staffId,
    },
    { config: await ctx.config(), now: ctx.now },
  );
  return {
    sessionId: result.session ? result.session.sessionId : i["sessionId"],
    expectedCash: Number(result.expectedCash) || 0,
    counted: Number(result.counted) || 0,
    variance: Number(result.variance) || 0,
    cashRemoved: Number(result.cashRemoved) || 0,
    floatLeft: Number(result.floatLeft) || 0,
    varianceStatus: result.varianceStatus || "OK",
    lottoReserveCounted: result.lottoReserveCounted,
    lottoReserveShort: Number(result.lottoReserveShort) || 0,
  };
};

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number): string => String(n).padStart(2, "0");

/** Utilities.formatDate(now, 'America/Toronto', 'EEE d MMM, HH:mm'): "Sat 21 Nov, 09:00". */
function shortWhen(d: Date): string {
  const w = wallClock(d);
  return `${DOW[w.dow]} ${w.day} ${MON[w.month - 1]}, ${p2(w.hour)}:${p2(w.minute)}`;
}

/**
 * Any signed-in person: the WhatsApp "shift opened" notice (name, till, time), sent by the page
 * after an open. A failed send (anything but "switched off") leaves a notify.shift_open_failed audit
 * row and is returned to the page; it never fails the call. The old code does not check that the
 * caller has an open session, and neither does this.
 */
export const rpcNotifyShiftOpen: RpcHandler = async (ctx, company) => {
  const session = who(ctx);
  const label = company === "vape" ? "Vape" : company === "cstore" ? "Cstore" : String(company || "");
  const when = shortWhen(ctx.now);
  const params = [session.name, label, when];
  const plain = "🟢 " + session.name + " opened the " + label + " till\n🕐 " + when;
  let r: notifier.SendResult | { sent: false; reason: "exception"; detail: string };
  try {
    r = await notifier.sendOp({ config: await ctx.config(), env: ctx.env, fetch: ctx.fetch, db: ctx.db, now: ctx.now }, "shift_open", params, plain);
  } catch (e) {
    if (e instanceof DbError) throw e;
    r = { sent: false, reason: "exception", detail: e instanceof Error ? e.message : String(e) };
  }
  if (r && !r.sent && !("reason" in r && r.reason === "disabled")) {
    const rows = "results" in r ? r.results : [];
    const why = rows
      .filter((x) => !x.sent)
      .map((x) => x.to + " " + x.reason + (x.detail ? ": " + x.detail : ""))
      .join("; ");
    const detail = "detail" in r ? r.detail : undefined;
    const reason = "reason" in r ? r.reason : undefined;
    await audit.write(
      ctx.db,
      {
        actorId: session.staffId,
        action: "notify.shift_open_failed",
        targetType: "notification",
        targetId: label,
        details: "WhatsApp shift-open NOT sent — " + (why || reason || "no reason") + (detail ? " (" + detail + ")" : ""),
      },
      { now: ctx.now },
    );
  }
  return r;
};
