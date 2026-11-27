// What the Settings screen says about the nightly copy (card P4-06a): one line, worked out from the audit
// log's own rows (backup.nightly and backup.failed), so there is no second place to keep it.
//
//   never    no copy has been made and none has failed yet           a warning: there is no copy at all
//   ok       the newest run was good and is not older than 36 hours  "Last copy: <when>, <n> tables, <rows> rows"
//   stale    the newest good copy is more than 36 hours old          a warning
//   failed   the newest run failed (newer than the newest good one)  a warning, with the reason
//
// 36 hours: a copy every night is never more than about 24 hours old; a day and a half late means a night
// was missed. The words and `warn` are decided here, once; the page shows them as they are.
// Times are Toronto, from the clock the caller hands in.
import type { Db } from "../db/client";
import { formatDateTime } from "../lib/dates";
import { AUDIT_FAILED, AUDIT_OK, AUDIT_TARGET_TYPE } from "./nightly";

export const STALE_HOURS = 36;

export type BackupState = "never" | "ok" | "stale" | "failed";

export interface LastBackup {
  state: BackupState;
  /** The sentence the Settings screen shows. */
  message: string;
  warn: boolean;
  /** The newest good copy: when (ISO), its folder, tables and rows. Null before the first. */
  lastGood: { at: string; folder: string; tables: number; rows: number } | null;
  /** The newest failed run: when (ISO) and why. Null if none. */
  lastFailure: { at: string; reason: string } | null;
}

interface AuditRow {
  at: Date;
  after: string | null;
}

const newest = (db: Db, action: string): Promise<AuditRow[]> =>
  db.query<AuditRow>(`select "timestamp" as at, "after" from ops.audit_log where target_type = $1 and action = $2 order by "timestamp" desc, seq desc limit 1`, [AUDIT_TARGET_TYPE, action]);

function parse(text: string | null): Record<string, unknown> {
  try {
    const v: unknown = text === null ? null : JSON.parse(text);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export async function lastBackup(db: Db, now: Date): Promise<LastBackup> {
  const [ok] = await newest(db, AUDIT_OK);
  const [bad] = await newest(db, AUDIT_FAILED);
  const lastGood = ok
    ? (() => {
        const a = parse(ok.after);
        return { at: ok.at.toISOString(), folder: typeof a["folder"] === "string" ? a["folder"] : "", tables: num(a["tables"]), rows: num(a["rows"]) };
      })()
    : null;
  const lastFailure = bad
    ? { at: bad.at.toISOString(), reason: typeof parse(bad.after)["reason"] === "string" ? (parse(bad.after)["reason"] as string) : "the reason was not recorded" }
    : null;
  const goodWhen = ok ? formatDateTime(ok.at) : "";
  const goodLine = lastGood ? `The newest good copy is from ${goodWhen} (${lastGood.tables} tables, ${lastGood.rows} rows).` : "There is no good copy yet.";

  if (lastFailure && (!ok || (bad as AuditRow).at.getTime() > ok.at.getTime())) {
    return {
      state: "failed",
      warn: true,
      lastGood,
      lastFailure,
      message: `The last copy failed on ${formatDateTime((bad as AuditRow).at)}: ${lastFailure.reason}. ${goodLine} Press "Make a copy now" to try again.`,
    };
  }
  if (!lastGood || !ok) {
    return {
      state: "never",
      warn: true,
      lastGood: null,
      lastFailure,
      message: 'Last copy: no copy yet. The first one is made at 3 in the morning, or press "Make a copy now".',
    };
  }
  const ageHours = (now.getTime() - ok.at.getTime()) / 3_600_000;
  if (ageHours > STALE_HOURS) {
    return {
      state: "stale",
      warn: true,
      lastGood,
      lastFailure,
      message: `The newest good copy is more than ${STALE_HOURS} hours old (${goodWhen}, ${lastGood.tables} tables, ${lastGood.rows} rows). A night was missed: press "Make a copy now".`,
    };
  }
  return { state: "ok", warn: false, lastGood, lastFailure, message: `Last copy: ${goodWhen}, ${lastGood.tables} tables, ${lastGood.rows} rows` };
}
