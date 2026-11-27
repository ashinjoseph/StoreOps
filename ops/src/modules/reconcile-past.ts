// Reconcile a past day again (card P4-12c): rpcReconcilePastDay. A NEW ability of the Operations app
// (ADR-0023): after an admin corrects a closed till (till-corrections.ts) the day's earlier reconcile
// was made on the old figures, and today's "Reconcile today" can only reconcile today.
//
// The computation is the reconcile's own, not a copy of it: `reconcile.buildRecords` turns one
// business day's closed sessions into the result rows (the figures, Clover's totals for each group's
// window, the status), and `reconcile.writeRows` stores them. reconcileDay calls the same two with
// today; this module calls them with the day asked for. So the two cannot drift apart: what differs
// is only what is decided around them.
//
// What differs from a manual run of today:
//   - the day is asked for, before today in Toronto and at most 370 days back, with a reason;
//   - a day with a till still open is refused (a manual run of today goes ahead with open tills;
//     that is today's, where the till may still close; a past day's open till is a loose end to fix);
//   - a group none of whose sessions has an end time ends at the end of THAT day (today's run: now);
//   - NO message is sent. A second message for a past day would confuse the group. This module does
//     not import the notifier or any message builder, and a test reads its source to keep it so;
//   - the audit row is `reconcile.past_day`, carrying the reason and each till's verdict.
//
// Same as a manual run of today, deliberately:
//   - every till with a closed or validated session of the day is reconciled (the whole day), from
//     the figures as they stand now (so, after a till correction, the corrected ones);
//   - the cards are asked of Clover for each group's window (earliest start to latest end of the
//     group's sessions that day), inside the same time budget. Off, unreachable, out of time, or
//     refusing a past day: recorded as not verified (blank, never matching, never 0);
//   - the sessions' status is not touched (a run of today does not touch it either);
//   - the rows go in with mode 'manual' (the table's check allows only 'auto' and 'manual').
//
// How a re-run is marked: there is no notes column and the mode cannot say it, and this card adds no
// column. A row is a re-run when its validated_at falls on a LATER Toronto day than its business_date
// (an ordinary run is validated on the day it reconciles, so for it the two are the same day). The
// reason is in the audit row, which also lists the new rows' ids; the page reads the mark from the
// two dates it is already given.
//
// Earlier results are kept: new rows are inserted; nothing is updated or deleted.
//
// One run of a day at a time: the same transaction-scoped advisory lock on the business date that
// reconcileDay takes, before anything is read. A second re-run waits for the first to commit, then
// sees its rows (so `previous` counts them) and writes its own set; the rows of one run are
// contiguous in `seq`. The day's till sessions are also locked FOR SHARE, so a till correction in
// flight is waited for (its figures are read whole, not half) and a correction that starts during a
// re-run waits for the re-run to end (at most the Clover time budget).
import type { Tx } from "../db/tx";
import * as audit from "../lib/audit";
import { endOfDay, formatDate, parseDate } from "../lib/dates";
import { REASON_MAX, REASON_MIN } from "./attendance-corrections";
import * as reconcile from "./reconcile";
import * as staff from "./staff";
import * as tillSessions from "./till-sessions";
import { MAX_DAYS_BACK } from "./till-corrections";

export interface PastDayInput {
  date?: unknown;
  reason?: unknown;
}

export interface PastDayResult {
  ready: true;
  mode: "manual";
  date: string;
  merchants: reconcile.ReconRecord[];
  whatsapp: reconcile.SendSummary;
  whatsappSummary: string;
  rerun: true;
  sent: false;
  /** How many result rows the day already had (every earlier run, this and any other kind). */
  previous: number;
}

export const NOT_SENT = "not sent: a re-run of a past day sends no message";

const DATE_FORMAT = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written YYYY-MM-DD, or a plain refusal (no rolling over: 2026-02-30 is not a date). */
function checkDate(value: unknown): string {
  const m = typeof value === "string" ? DATE_FORMAT.exec(value) : null;
  const bad = (): never => {
    throw new Error("Enter the date as YYYY-MM-DD.");
  };
  if (!m) return bad();
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d || y < 1) return bad();
  return value as string;
}

/** Whole days from `a` to `b` (both YYYY-MM-DD). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86_400_000);
}

function checkReason(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < REASON_MIN || text.length > REASON_MAX) throw new Error(`A reason is required: ${REASON_MIN} to ${REASON_MAX} characters.`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(text)) throw new Error("The reason cannot contain control characters (such as a line break).");
  return text;
}

/** One till group's cash and card verdict, in the words the audit row keeps. */
function verdicts(config: reconcile.ReconcileDeps["config"], m: reconcile.ReconRecord): { cash: string; cards: string } {
  const cashThreshold = config.number("variance_ok_threshold", 1);
  const cardThreshold = config.number("card_variance_threshold", 1);
  const cash = Math.abs(m.cashVariance) > cashThreshold ? (m.cashVariance < 0 ? "short" : "over") : "OK";
  const cards = !m.cardsVerified || m.cardDiff === null ? "not verified" : Math.abs(m.cardDiff) > cardThreshold ? "off" : "matched";
  return { cash, cards };
}

/**
 * Reconcile every till of `input.date` again, from the figures as they stand now, and keep the
 * earlier results. `db` is the caller's transaction (the router's). Never throws for Clover (it is
 * reported in the rows); sends nothing.
 */
export async function reconcilePastDay(db: Tx, deps: reconcile.ReconcileDeps, actorId: string, input: PastDayInput): Promise<PastDayResult> {
  if (!actorId) throw new Error("actorId required");
  const now = deps.now;
  const config = deps.config;

  // 1. The date: real, before today in Toronto, not too long ago.
  const dateStr = checkDate(input.date);
  const todayStr = formatDate(now);
  if (dateStr === todayStr) throw new Error("Use Reconcile today for today.");
  if (dateStr > todayStr) throw new Error("That day has not happened yet.");
  if (daysBetween(dateStr, todayStr) > MAX_DAYS_BACK) throw new Error(`Cannot reconcile a day from more than ${MAX_DAYS_BACK} days ago.`);
  // 2. Why.
  const reason = checkReason(input.reason);

  // One run of the day at a time (the key reconcileDay takes for the same day), taken before reading.
  await db.query("select pg_advisory_xact_lock(hashtextextended('ops.reconcile.day:' || $1, 0))", [dateStr]);
  // A till correction in flight finishes first; one that starts now waits for this run.
  await db.query("select 1 from ops.till_sessions where date = $1 for share", [dateStr]);

  const day = parseDate(dateStr) as Date;
  const sessions = (await tillSessions.getForDateRange(db, day, endOfDay(day))) || [];

  // 3. Every till of the day is closed.
  const open = sessions.find((s) => s.status === "open");
  if (open) {
    const name = (await staff.getAll(db)).find((p) => p.staffId === open.staffId)?.name || open.staffId;
    throw new Error(`${name}'s ${open.company} till from that day is still open: close it first.`);
  }
  // 4. And there is at least one.
  const closed = reconcile.closedSessions(sessions);
  if (closed.length === 0) throw new Error(`No closed till on ${dateStr}.`);

  // 5-6. The whole day's rows, from the figures as they stand, Clover asked for the day's own windows.
  const merchants = await reconcile.buildRecords(db, deps, day, closed, endOfDay(day).getTime());

  // 7. New rows beside the old.
  const previous = Number((await db.one<{ n: string }>("select count(*) as n from ops.validation_results where business_date = $1", [dateStr])).n);
  const ids = await reconcile.writeRows(db, day, merchants, "manual", actorId, now, deps.random);

  // 10. One audit row: the reason, the tills covered, each one's cash and card verdict.
  await audit.write(
    db,
    {
      actorId,
      action: "reconcile.past_day",
      targetType: "validation_results",
      targetId: dateStr,
      after: {
        date: dateStr,
        reason,
        previous,
        sent: false,
        tills: merchants.map((m, i) => ({
          validationId: ids[i],
          merchant: m.merchant,
          companies: m.companies,
          sessionIds: m.sessionIds,
          cashCounted: m.cashCounted,
          cashVariance: m.cashVariance,
          cash: verdicts(config, m).cash,
          cardsVerified: m.cardsVerified,
          cardDiff: m.cardDiff,
          cards: verdicts(config, m).cards,
          status: m.status,
        })),
      },
      details: reason,
    },
    { now },
  );

  // 11. What a manual run answers, and that this was a re-run and sent nothing.
  return {
    ready: true,
    mode: "manual",
    date: dateStr,
    merchants,
    whatsapp: { sent: false, reason: "past_day_rerun" },
    whatsappSummary: NOT_SENT,
    rerun: true,
    sent: false,
    previous,
  };
}
