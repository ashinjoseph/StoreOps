// The nightly copy (card P4-06a; ADR-0028): every table of the database written, as dated files, to the
// BACKUPS bucket, from ONE consistent picture, with a manifest written last.
//
// ONE PICTURE. The whole copy is read inside a single read-only, repeatable-read transaction, so every table
// is as of the same instant however long the copy takes and whatever the store commits meanwhile. It takes
// no lock that blocks the store (the one advisory lock it takes, to run one copy at a time, is a private key
// nothing else asks for) and it writes nothing to the database except one audit row at the end, in a
// transaction of its own.
//
// FILES. <folder>/<table>.<NNNN>.ndjson, parts of at most MAX_PART_ROWS rows (snapshot.ts), then
// <folder>/manifest.json LAST. A folder without a manifest is an incomplete copy: the restore refuses it.
// The folder is nightly/<Toronto day>; a second copy the same day goes to nightly/<day>-<HHmmss> (and a
// third to -2, ...): a folder that has anything in it is never written into again. The app has no way to
// delete or overwrite (storage.ts), so a failed copy's partial folder stays until the bucket's 90-day
// lifecycle rule removes it.
//
// WHEN. Nightly at 03:00 Toronto (the cron fires at both UTC hours that can be 03:00 there, and
// `runScheduledBackup` does nothing unless it is 03:00 in Toronto), and on demand by an admin
// (`runBackup`, the "Make a copy now" button). One at a time: a second request while one runs is refused.
//
// IT REPORTS ITSELF. One audit row per run: backup.nightly (folder, tables, rows, bytes, files, how long) or
// backup.failed (what failed; never a row's content: the reason is a message this code or the database
// driver wrote, and the driver's errors carry names and codes, not values). Nothing is sent anywhere.
//
// A FAILURE part-way leaves no manifest, writes backup.failed, and is returned, never thrown, so the
// scheduled handler never fails because of it: each scheduled job is independent of the others.
//
// The clock is the caller's `now`; there is no environment or randomness here.
import { DbError, type Db } from "../db/client";
import { withTransaction } from "../db/tx";
import * as audit from "../lib/audit";
import { formatDate, wallClock } from "../lib/dates";
import { EncodeError } from "./encode";
import { BackupKeyTakenError, type BackupStorage } from "./storage";
import {
  BackupError,
  DEFAULT_LIMITS,
  planCopy,
  readCatalogue,
  readTableInParts,
  sha256Hex,
  type ColumnInfo,
  type Part,
  type PartLimits,
  type TableInfo,
} from "./snapshot";
import type { TableTotals } from "./totals";

/** The two UTC hours of a day that can be 03:00 in Toronto (summer time, winter time). Must match wrangler.toml. */
export const BACKUP_SCHEDULES: readonly string[] = ["0 7 * * *", "0 8 * * *"];
/** The Toronto hour the nightly copy is made at: the store is shut and nobody is closing a till. */
export const BACKUP_HOUR = 3;
export const BACKUP_PREFIX = "nightly";
export const MANIFEST_FORMAT = "storeops-nightly-copy/1";
export const MANIFEST_NAME = "manifest.json";
export const AUDIT_OK = "backup.nightly";
export const AUDIT_FAILED = "backup.failed";
export const AUDIT_TARGET_TYPE = "backup";
/** One copy at a time: the key of the transaction-level advisory lock. */
const LOCK_KEY = "7020260406";
const CONTENT_TYPE = "application/x-ndjson";

export interface NightlyDeps {
  openDb: () => Promise<Db & { close(): Promise<void> }>;
  /** Null when the Worker has no BACKUPS binding: the run fails, and says so. */
  storage: BackupStorage | null;
  now: () => Date;
  /** Receives one entry per failure (never a row's content). */
  log: (entry: object) => void;
  /** Who the audit row names: a staff id for "Make a copy now", "SYSTEM" for the cron. */
  actorId: string;
  limits?: PartLimits;
  /** For tests: called after each table has been read and written. */
  hooks?: { afterTable?: (table: string) => Promise<void> | void };
}

export interface ManifestFile {
  /** The file's name inside the folder. */
  file: string;
  table: string;
  part: number;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface ManifestTable {
  name: string;
  columns: { name: string; type: string; kind: string }[];
  orderBy: string[];
  /** The columns that are identity columns (a restore continues their numbering after the highest restored). */
  identity: string[];
  rows: number;
  parts: number;
  bytes: number;
  totals: TableTotals;
}

export interface Manifest {
  format: string;
  folder: string;
  /** The Toronto business day the copy was made on. */
  businessDay: string;
  /** The instant the snapshot was taken. */
  snapshotAt: string;
  finishedAt: string;
  database: { newestMigration: { version: number; name: string; checksum: string }; migrations: number };
  partLimits: PartLimits;
  excluded: { table: string; reason: string }[];
  files: ManifestFile[];
  tables: ManifestTable[];
  totals: { tables: number; rows: number; files: number; bytes: number };
}

export type NightlyResult =
  | { ok: true; folder: string; tables: number; rows: number; bytes: number; files: number; seconds: number; snapshotAt: string }
  | { ok: false; busy: true }
  | { ok: false; busy: false; reason: string };

/** What to tell a person about a failure: a message this code wrote, or the database driver's (names and codes only). */
export function reasonOf(err: unknown): string {
  if (err instanceof BackupError || err instanceof EncodeError || err instanceof BackupKeyTakenError || err instanceof DbError) return err.message.slice(0, 300);
  const name = err instanceof Error ? err.name : typeof err;
  return `${name} (details withheld)`;
}

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/** The folder for a copy made at `now`: nightly/<day>, or nightly/<day>-<HHmmss>[-n] when that day's folder already has anything in it. */
export async function chooseFolder(storage: BackupStorage, now: Date): Promise<string> {
  const base = `${BACKUP_PREFIX}/${formatDate(now)}`;
  if (!(await storage.anyUnder(`${base}/`))) return base;
  const w = wallClock(now);
  const stamp = `${pad(w.hour, 2)}${pad(w.minute, 2)}${pad(w.second, 2)}`;
  for (let n = 1; n <= 50; n++) {
    const folder = n === 1 ? `${base}-${stamp}` : `${base}-${stamp}-${n}`;
    if (!(await storage.anyUnder(`${folder}/`))) return folder;
  }
  throw new BackupError("a free folder name could not be found for today's copy");
}

const fileName = (table: string, part: number): string => `${table}.${pad(part, 4)}.ndjson`;

/** Write one object, naming what failed (the key and the error's name and numeric code, never its text and never a row) if the bucket refuses. */
async function putOnce(storage: BackupStorage, key: string, bytes: Uint8Array, sha256: string, contentType: string): Promise<void> {
  try {
    await storage.put(key, bytes, sha256, contentType);
  } catch (err) {
    if (err instanceof BackupKeyTakenError) throw err;
    const name = err instanceof Error ? err.name : typeof err;
    // R2's own errors end in a code such as (10001); that is kept, the rest of the text is not.
    const code = err instanceof Error ? /\((\d{3,6})\)\s*$/.exec(err.message)?.[1] : undefined;
    throw new BackupError(`the bucket refused ${key}: ${name}${code ? ` (${code})` : ""}`);
  }
}

interface Done {
  folder: string;
  snapshotAt: string;
  tables: number;
  rows: number;
  bytes: number;
  files: number;
}

async function copyAll(tx: Db, deps: NightlyDeps, storage: BackupStorage): Promise<Done | "busy"> {
  await tx.query("set transaction isolation level repeatable read read only");
  const lock = await tx.one<{ got: boolean }>("select pg_try_advisory_xact_lock($1::bigint) as got", [LOCK_KEY]);
  if (!lock.got) return "busy";
  const snapshotAt = deps.now();

  const catalogue = await readCatalogue(tx);
  const { copy, excluded } = planCopy(catalogue);
  const migrations = await tx.query<{ version: number; name: string; checksum: string }>(
    "select version, name, checksum from ops.schema_migrations order by version desc",
  );
  const newest = migrations[0];
  if (newest === undefined) throw new BackupError("the database has no migrations recorded, so a restore could not tell what shape these files are");

  const folder = await chooseFolder(storage, snapshotAt);
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const files: ManifestFile[] = [];
  const tables: ManifestTable[] = [];
  let bytes = 0;
  let rows = 0;
  for (const table of copy) {
    const columns: ColumnInfo[] = table.columns;
    const sink = async (part: Part): Promise<void> => {
      const name = fileName(table.name, part.number);
      await putOnce(storage, `${folder}/${name}`, part.bytes, part.sha256, CONTENT_TYPE);
      files.push({ file: name, table: table.name, part: part.number, rows: part.rows, bytes: part.bytes.byteLength, sha256: part.sha256 });
    };
    const read = await readTableInParts(tx, table, columns, sink, limits);
    tables.push(manifestTable(table, read));
    bytes += read.bytes;
    rows += read.rows;
    await deps.hooks?.afterTable?.(table.name);
  }

  const finishedAt = deps.now();
  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    folder,
    businessDay: formatDate(snapshotAt),
    snapshotAt: snapshotAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    database: { newestMigration: { version: newest.version, name: newest.name, checksum: newest.checksum }, migrations: migrations.length },
    partLimits: { ...limits },
    excluded,
    files,
    tables,
    totals: { tables: tables.length, rows, files: files.length, bytes },
  };
  const body = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  // LAST: a folder without this file is an incomplete copy.
  await putOnce(storage, `${folder}/${MANIFEST_NAME}`, body, await sha256Hex(body), "application/json");
  return { folder, snapshotAt: manifest.snapshotAt, tables: tables.length, rows, bytes: bytes + body.byteLength, files: files.length + 1 };
}

function manifestTable(table: TableInfo, read: { rows: number; parts: number; bytes: number; totals: TableTotals }): ManifestTable {
  return {
    name: table.name,
    columns: table.columns.map((c) => ({ name: c.name, type: c.type, kind: c.kind })),
    orderBy: table.orderBy,
    identity: table.columns.filter((c) => c.identity !== "").map((c) => c.name),
    rows: read.rows,
    parts: read.parts,
    bytes: read.bytes,
    totals: read.totals,
  };
}

/** Make one copy now. Never throws: a failure is audited and returned. */
export async function runBackup(deps: NightlyDeps): Promise<NightlyResult> {
  const started = deps.now();
  const fail = async (err: unknown, conn: (Db & { close(): Promise<void> }) | null): Promise<NightlyResult> => {
    const reason = reasonOf(err);
    try {
      deps.log({ event: "backup.failed", reason });
    } catch {
      // A failing logger must not hide the failure.
    }
    const seconds = Math.max(0, Math.round((deps.now().getTime() - started.getTime()) / 1000));
    const entry = { actorId: deps.actorId, action: AUDIT_FAILED, targetType: AUDIT_TARGET_TYPE, targetId: "nightly", after: { reason, seconds }, details: reason };
    let written = false;
    if (conn !== null) {
      try {
        await withTransaction(conn, (tx) => audit.write(tx, entry, { now: deps.now() }));
        written = true;
      } catch {
        // The connection may be the thing that failed: try a fresh one below.
      }
    }
    if (!written) {
      let fresh: (Db & { close(): Promise<void> }) | null = null;
      try {
        fresh = await deps.openDb();
        const again = fresh;
        await withTransaction(again, (tx) => audit.write(tx, entry, { now: deps.now() }));
      } catch {
        try {
          deps.log({ event: "backup.failed.unrecorded" });
        } catch {
          // Nothing more can be done.
        }
      } finally {
        await fresh?.close().catch(() => undefined);
      }
    }
    return { ok: false, busy: false, reason };
  };

  let conn: (Db & { close(): Promise<void> }) | null = null;
  try {
    conn = await deps.openDb();
  } catch (err) {
    return fail(err, null);
  }
  try {
    const storage = deps.storage;
    if (storage === null) throw new BackupError("the Worker has no BACKUPS bucket bound (wrangler.toml [[r2_buckets]] BACKUPS), so there is nowhere to put a copy");
    const out = await withTransaction(conn, (tx) => copyAll(tx, deps, storage));
    if (out === "busy") return { ok: false, busy: true };
    const seconds = Math.max(0, Math.round((deps.now().getTime() - started.getTime()) / 1000));
    await withTransaction(conn, (tx) =>
      audit.write(
        tx,
        {
          actorId: deps.actorId,
          action: AUDIT_OK,
          targetType: AUDIT_TARGET_TYPE,
          targetId: out.folder,
          after: { folder: out.folder, tables: out.tables, rows: out.rows, bytes: out.bytes, files: out.files, seconds },
          details: `${out.tables} tables, ${out.rows} rows, ${out.bytes} bytes in ${out.files} files, ${seconds} s`,
        },
        { now: deps.now() },
      ),
    );
    return { ok: true, folder: out.folder, tables: out.tables, rows: out.rows, bytes: out.bytes, files: out.files, seconds, snapshotAt: out.snapshotAt };
  } catch (err) {
    return fail(err, conn);
  } finally {
    await conn.close().catch(() => undefined);
  }
}

/** True when `cron` is one of the nightly copy's two schedules. */
export function isBackupCron(cron: string | undefined): boolean {
  return cron !== undefined && BACKUP_SCHEDULES.includes(cron);
}

/** The cron's job: does nothing unless it is BACKUP_HOUR in Toronto (so exactly one of the two firings a day counts), and opens no connection then. */
export async function runScheduledBackup(deps: NightlyDeps): Promise<NightlyResult | { ran: false; reason: string }> {
  if (wallClock(deps.now()).hour !== BACKUP_HOUR) return { ran: false, reason: `not ${BACKUP_HOUR}:00 in Toronto` };
  return runBackup(deps);
}
