// Port of src/AuditLog.gs: the append-only event log (ADR-0014).
//
// Every important write calls `write` (or `writeMany` for a bulk import), inside
// the same transaction as the change it describes, so the row commits or rolls
// back with it. The app role can insert and read ops.audit_log but never change
// or remove a row (ops/contracts/roles.sql), so there is no update or delete here.
//
// What is stored, as the old toRow_ wrote it:
//   - log_id: newId("LOG"), i.e. LOG_<yyyyMMdd>_<HHmmss>_<xxx> in Toronto time.
//   - timestamp: the instant the entry was written.
//   - actor_id, target_type, target_id, action, details: a falsy value (`x || ''`)
//     is a blank cell, stored as NULL; a truthy one is stored as its text. The one
//     exception is action, which is NOT NULL in the table: a blank action is ''.
//   - before, after: a truthy value is JSON.stringify'd; a falsy one is blank (NULL).
//   - details: NOT JSON'd. The old code wrote the value into the cell as it was,
//     so text is String(value) (an object becomes "[object Object]").
//
// Each function takes a Db, so a transaction handle works too.
import type { Db } from "../db/client";
import { newId } from "./ids";

export interface AuditEntry {
  actorId?: string | number | null;
  /** Required. A missing action is written as '' (the old code did that too), never refused. */
  action: string;
  targetType?: string | number | null;
  targetId?: string | number | null;
  before?: unknown;
  after?: unknown;
  details?: unknown;
}

export interface AuditDeps {
  now?: Date;
  random?: () => number;
}

export interface AuditFilters {
  actorId?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
}

/** One stored row, as `recent` returns it. Blank text columns come back as null. */
export interface AuditRecord {
  logId: string;
  timestamp: Date;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  before: string | null;
  after: string | null;
  details: string | null;
}

type Params = [
  logId: string,
  timestamp: Date,
  actorId: string | null,
  action: string,
  targetType: string | null,
  targetId: string | null,
  before: string | null,
  after: string | null,
  details: string | null,
];

const COLUMNS = `log_id, "timestamp", actor_id, action, target_type, target_id, "before", "after", details`;
const WIDTH = 9;

/** Old `x || ''`, then a cell: a falsy value is blank; a truthy one is its text. */
function textOrNull(v: unknown): string | null {
  return v ? String(v) : null;
}

/** Old `x ? JSON.stringify(x) : ''`. JSON.stringify gives undefined for a function, which the sheet wrote as blank. */
function jsonOrNull(v: unknown): string | null {
  if (!v) return null;
  const s = JSON.stringify(v) as string | undefined;
  return s === undefined ? null : s;
}

function toRow(entry: AuditEntry, deps: AuditDeps): Params {
  const now = deps.now ?? new Date();
  return [
    newId("LOG", { now, random: deps.random }),
    now,
    textOrNull(entry.actorId),
    entry.action || "",
    textOrNull(entry.targetType),
    textOrNull(entry.targetId),
    jsonOrNull(entry.before),
    jsonOrNull(entry.after),
    textOrNull(entry.details),
  ];
}

/** Append one row. Returns its log id. */
export async function write(db: Db, entry: AuditEntry, deps: AuditDeps = {}): Promise<string> {
  const row = toRow(entry, deps);
  await db.query(`insert into ops.audit_log (${COLUMNS}) values (${placeholders(0)})`, row);
  return row[0];
}

/**
 * Append many rows in ONE insert statement (a bulk import logs a row per product;
 * one statement each is what the old code's batching was for). Returns the ids in order.
 */
export async function writeMany(db: Db, entries: readonly AuditEntry[], deps: AuditDeps = {}): Promise<string[]> {
  if (entries.length === 0) return [];
  const rows = entries.map((e) => toRow(e, deps));
  const values = rows.map((_, i) => `(${placeholders(i * WIDTH)})`).join(", ");
  await db.query(`insert into ops.audit_log (${COLUMNS}) values ${values}`, rows.flat());
  return rows.map((r) => r[0]);
}

/** `$n+1 … $n+9` as text: placeholders only, never a value. */
function placeholders(offset: number): string {
  const out: string[] = [];
  for (let k = 1; k <= WIDTH; k++) out.push(`$${offset + k}`);
  return out.join(", ");
}

/**
 * The newest `limit` rows (default 50) matching `filters`, newest first. As before,
 * the filters apply to the newest `limit * 4` rows only, so an older match may not
 * be returned. An empty filter value is ignored.
 */
export async function recent(db: Db, limit?: number, filters: AuditFilters = {}): Promise<AuditRecord[]> {
  const n = limit || 50;
  return db.query<AuditRecord>(
    `select * from (
       select log_id as "logId", "timestamp" as "timestamp", actor_id as "actorId", action,
              target_type as "targetType", target_id as "targetId",
              "before" as "before", "after" as "after", details
         from ops.audit_log
        order by "timestamp" desc, log_id desc
        limit $1
     ) w
     where ($2::text is null or "actorId" = $2)
       and ($3::text is null or action = $3)
       and ($4::text is null or "targetType" = $4)
       and ($5::text is null or "targetId" = $5)
     order by "timestamp" desc, "logId" desc
     limit $6`,
    [n * 4, filters.actorId || null, filters.action || null, filters.targetType || null, filters.targetId || null, n],
  );
}
