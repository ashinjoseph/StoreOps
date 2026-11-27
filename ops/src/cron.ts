// The Monday commission cron (card P3-10b): src/Commissions.gs's weekly trigger, as a plain function the
// Worker's `scheduled` handler calls (index.ts only wires it). It takes its clock, its connection, its
// bindings and its logger as dependencies, so a test runs it without a Worker.
//
// When: the old trigger fired every Monday at the hour in config commission_run_hour (9 by default, which
// is the value the shop has), in the Sheet's time zone, America/Toronto. A Cloudflare cron has no time
// zone, only UTC, and Toronto's hour moves with daylight saving: 09:00 is 13:00Z in summer time and 14:00Z
// in winter time. So the Worker is scheduled for BOTH (ops/wrangler.toml [triggers]) and this function does
// nothing unless the Toronto wall clock reads Monday, RUN_HOUR o'clock: of the two firings on a Monday
// exactly one passes, and it is 09:00 in Toronto whichever side of a clock change the Monday falls. A
// firing that does nothing opens no connection.
//   The hour is a constant here, not read from the config key commission_run_hour: a cron's hours are
//   fixed in wrangler.toml, so the key could not move them. To change the hour, change RUN_HOUR and the
//   two UTC hours together.
//
// What: the engine for the week before this one, acting as SYSTEM_TRIGGER (what the old trigger passed),
// NEVER forced (a retry the same Monday finds the run and proposes nothing). One connection, one
// transaction, closed in every case. The engine only proposes: every bonus is `proposed`, and a person
// approves it (ADR-0011).
//
// Paused (card P4-13): when the setting commission_run_paused is true, the run does nothing but write ONE
// audit row, commissions.run_skipped (actor SYSTEM), and says so in its result. In the Sheet an admin paused the
// run by removing the trigger; here the schedule is part of the app, so the pause is a setting. It is read in
// the run's own transaction, after the hour has matched. It stops THIS function only: "Run engine" on the
// Commissions screen is a person pressing a button and never reads the setting.
//
// When it fails: one log line, then the error is thrown so the platform records the failure. The old
// trigger swallowed the error and wrote an audit row (commission.trigger_error, actor SYSTEM); that row is
// kept, written on the connection after the transaction has rolled back (the failure rolled back the run's
// own rows), and best effort: if it cannot be written, the failure is still thrown.
import type { Db } from "./db/client";
import { withTransaction } from "./db/tx";
import * as audit from "./lib/audit";
import { loadConfig } from "./lib/config";
import { formatDate, getPreviousWeekRange, wallClock } from "./lib/dates";
import * as commissions from "./modules/commissions";

/** The two UTC hours of a Monday that can be 09:00 in Toronto (summer time, winter time). Must match wrangler.toml. */
export const CRON_SCHEDULES: readonly string[] = ["0 13 * * 1", "0 14 * * 1"];
/** Monday, as Date.getDay numbers it. */
export const RUN_DAY = 1;
/** The Toronto hour the old trigger ran at (config commission_run_hour's default and the shop's value). */
export const RUN_HOUR = 9;

export interface CronDeps {
  /** One connection for the run; the cron closes it. */
  openDb: () => Promise<Db & { close(): Promise<void> }>;
  /** The clock: read once. */
  now: () => Date;
  env: Readonly<Record<string, unknown>>;
  fetch: typeof fetch;
  /** Receives one entry per failure. */
  log: (entry: object) => void;
}

/** Why a firing that matched the hour still did nothing: the pause, with the week it would have run for. */
export interface CronPaused {
  ran: false;
  paused: true;
  reason: string;
  weekStart: string;
  weekEnd: string;
}

export type CronResult = { ran: false; reason: string } | CronPaused | { ran: true; result: commissions.RunResult };

/** The details of the audit row a paused run writes. */
export const PAUSED_DETAILS = "paused in Settings (commission_run_paused)";

function describe(err: unknown): { errorClass: string; message: string } {
  if (err instanceof Error) {
    const ctor: unknown = Object.getPrototypeOf(err)?.constructor;
    return { errorClass: typeof ctor === "function" && ctor.name ? ctor.name : err.name, message: err.message };
  }
  return { errorClass: err === null ? "null" : typeof err, message: "" };
}

export async function runWeeklyCommissions(deps: CronDeps): Promise<CronResult> {
  const now = deps.now();
  const w = wallClock(now);
  if (w.dow !== RUN_DAY || w.hour !== RUN_HOUR) return { ran: false, reason: "not Monday at " + RUN_HOUR + ":00 in Toronto" };

  const fail = (err: unknown): void => {
    try {
      deps.log({ event: "commissions.cron.failed", ...describe(err) });
    } catch {
      // A failing logger must not hide the failure.
    }
  };

  let conn: Db & { close(): Promise<void> };
  try {
    conn = await deps.openDb();
  } catch (err) {
    fail(err);
    throw err;
  }
  try {
    const outcome = await withTransaction(conn, async (tx): Promise<CronResult> => {
      const config = await loadConfig(tx);
      if (config.boolean("commission_run_paused")) {
        const range = getPreviousWeekRange(now);
        const weekStart = formatDate(range.start);
        const weekEnd = formatDate(range.end);
        await audit.write(
          tx,
          { actorId: "SYSTEM", action: "commissions.run_skipped", targetType: "commission_week", targetId: weekStart, after: { weekStart, weekEnd }, details: PAUSED_DETAILS },
          { now },
        );
        return { ran: false, paused: true, reason: PAUSED_DETAILS, weekStart, weekEnd };
      }
      const result = await commissions.runForPreviousWeek(tx, commissions.TRIGGER_ACTOR, false, { config, env: deps.env, fetch: deps.fetch, now });
      return { ran: true, result };
    });
    return outcome;
  } catch (err) {
    fail(err);
    try {
      await audit.write(
        conn,
        { actorId: "SYSTEM", action: "commission.trigger_error", targetType: "trigger", targetId: "commissionsTriggerHandler", details: describe(err).message },
        { now },
      );
    } catch {
      // Best effort: the failure itself is what is thrown.
    }
    throw err;
  } finally {
    await conn.close().catch(() => undefined);
  }
}
