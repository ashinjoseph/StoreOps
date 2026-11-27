// Restoring a nightly copy into an empty database (card P4-06a; ADR-0028; docs/guides/restore-a-nightly-copy.md).
// Node only (it reads a folder and talks to a database over TCP); the Worker never imports this file.
//
// The person downloads a copy's folder from the bucket to their own computer and runs the tool
// (ops/tools/restore-nightly.ts) against a database on that computer. This code never contacts the bucket.
//
// BEFORE anything is loaded it checks, and refuses (nothing written) when:
//   - the folder has no manifest.json (the copy that made it never finished), or the manifest is not one;
//   - a file the manifest lists is missing, or a file it does not list is there (a stray file, a sub-folder);
//   - a file's length or SHA-256 is not the manifest's, or its line count is not the rows the manifest says;
//   - the database is not on this computer (unless the caller says so with a flag whose name is a warning);
//   - the database is not migrated, or its newest migration is older than the copy's (or the same number but
//     a different file), or a table or column of the copy is missing or of another type;
//   - the database holds any row. (A freshly migrated database holds the few rows its migrations insert:
//     stores store_main and businesses cstore and vape. They are tolerated, and the copy's rows replace them.)
//
// THEN, in ONE transaction: every table is loaded in an order the foreign keys allow (rows in the file's order,
// identity columns' own values kept), identity columns are set to continue after the highest restored value, and
// every table is read back out of the database with the same reader the copy was made with and compared with the
// manifest: its row count, its money and whole-number sums per month (the cutover reconcile's measures, totals.ts)
// and the SHA-256 of each part re-encoded from what the database now holds. The transaction is kept only when
// every table matches and this is not a dry run. Any refusal, any error, any difference: nothing is kept.
//
// Which database role loads: the OWNER (or a superuser). The app role can insert but cannot set an identity
// sequence, and a restore that cannot do that would give the next new row a number already used.
// Nothing here prints a value of a row; failures name tables, columns and codes, never data.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { connect, type Db } from "../db/client";
import { withTransaction } from "../db/tx";
import { decodeLine, quoteIdent, splitLines, type FileColumn, type Param } from "./encode";
import type { Manifest, ManifestFile, ManifestTable } from "./nightly";
import { MANIFEST_FORMAT, MANIFEST_NAME } from "./nightly";
import { BackupError, EXCLUDED, loadOrder, readCatalogue, readTableInParts, type ColumnInfo, type Part, type TableInfo } from "./snapshot";

export class RestoreRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreRefused";
  }
}

/** Rows a freshly migrated database holds: the migrations insert them. The copy's rows with these keys replace them. */
export const MIGRATION_SEEDS: Readonly<Record<string, { column: string; keys: readonly string[] }>> = {
  stores: { column: "id", keys: ["store_main"] },
  businesses: { column: "business", keys: ["cstore", "vape"] },
};

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
/** True when the URL's host is this computer. */
export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

const NAME = /^[a-z_][a-z0-9_]*$/;
const FILE = /^([a-z_][a-z0-9_]*)\.(\d{4})\.ndjson$/;
const KINDS = new Set(["text", "integer", "bigint", "numeric", "boolean", "date", "instant", "bytea", "json", "other"]);
const SAFE_TYPE = /^[A-Za-z0-9_ ,()."[\]]+$/;
const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The manifest, checked for shape (not yet against the files). */
export function parseManifest(text: string): Manifest {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    throw new RestoreRefused("manifest.json is not valid JSON, so this folder cannot be restored.");
  }
  const bad = (what: string): never => {
    throw new RestoreRefused(`manifest.json is not a nightly copy's manifest (${what}).`);
  };
  if (!isObj(m) || m["format"] !== MANIFEST_FORMAT) return bad("its format is not " + MANIFEST_FORMAT);
  const db = m["database"];
  if (!isObj(db) || !isObj(db["newestMigration"]) || !whole(db["newestMigration"]["version"]) || typeof db["newestMigration"]["checksum"] !== "string") return bad("database.newestMigration");
  if (!Array.isArray(m["files"]) || !Array.isArray(m["tables"]) || !isObj(m["partLimits"])) return bad("files, tables or partLimits");
  const names = new Set<string>();
  for (const t of m["tables"] as unknown[]) {
    if (!isObj(t) || typeof t["name"] !== "string" || !NAME.test(t["name"]) || !Array.isArray(t["columns"]) || !Array.isArray(t["orderBy"]) || !whole(t["rows"]) || !whole(t["parts"]) || !isObj(t["totals"])) return bad("a table entry");
    if (names.has(t["name"])) return bad("a table is listed twice");
    names.add(t["name"]);
    if (t["columns"].length === 0) return bad("a table without columns");
    for (const c of t["columns"] as unknown[]) {
      if (!isObj(c) || typeof c["name"] !== "string" || c["name"] === "" || typeof c["type"] !== "string" || typeof c["kind"] !== "string" || !KINDS.has(c["kind"])) return bad("a column entry");
    }
  }
  const seen = new Set<string>();
  for (const f of m["files"] as unknown[]) {
    if (!isObj(f) || typeof f["file"] !== "string" || typeof f["table"] !== "string" || !whole(f["part"]) || !whole(f["rows"]) || !whole(f["bytes"]) || typeof f["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(f["sha256"])) return bad("a file entry");
    const match = FILE.exec(f["file"]);
    if (!match || match[1] !== f["table"] || Number(match[2]) !== f["part"] || !names.has(f["table"])) return bad("a file entry's name");
    if (seen.has(f["file"])) return bad("a file is listed twice");
    seen.add(f["file"]);
  }
  return m as unknown as Manifest;
}

export interface FolderCheck {
  manifest: Manifest;
  /** The table's files, in part order. */
  filesOf: (table: string) => ManifestFile[];
}

/** Check the folder against its manifest, byte for byte, before anything is loaded. Throws RestoreRefused. */
export function checkFolder(dir: string): FolderCheck {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new RestoreRefused("that folder cannot be read (does it exist? is it the folder of one copy?).");
  }
  if (!entries.includes(MANIFEST_NAME)) {
    throw new RestoreRefused(`this folder has no ${MANIFEST_NAME}: it is an incomplete copy (the copy that made it never finished) and cannot be restored. Use another copy.`);
  }
  const manifest = parseManifest(readFileSync(join(dir, MANIFEST_NAME), "utf8"));
  const listed = new Set(manifest.files.map((f) => f.file));
  for (const f of manifest.files) {
    if (!entries.includes(f.file)) throw new RestoreRefused(`the file ${f.file} is missing from the folder (the manifest lists it). Download the whole folder again.`);
  }
  for (const e of entries) {
    if (e !== MANIFEST_NAME && !listed.has(e)) throw new RestoreRefused(`the folder holds ${e.slice(0, 80)}, which the manifest does not list. Only a copy's own files may be in the folder.`);
  }
  for (const f of manifest.files) {
    const path = join(dir, f.file);
    if (!statSync(path).isFile()) throw new RestoreRefused(`${f.file} is not a file.`);
    const bytes = readFileSync(path);
    if (bytes.byteLength !== f.bytes) throw new RestoreRefused(`${f.file} is ${bytes.byteLength} bytes long; the manifest says ${f.bytes}. The file is damaged or incomplete.`);
    if (sha256(bytes) !== f.sha256) throw new RestoreRefused(`${f.file} has the right length but its SHA-256 is not the manifest's: the file was changed or damaged.`);
    const lines = bytes.byteLength === 0 ? 0 : bytes.toString("utf8").split("\n").length - 1;
    if (lines !== f.rows) throw new RestoreRefused(`${f.file} holds ${lines} rows; the manifest says ${f.rows}.`);
  }
  for (const t of manifest.tables) {
    const files = manifest.files.filter((f) => f.table === t.name).sort((a, b) => a.part - b.part);
    if (files.length !== t.parts || files.some((f, i) => f.part !== i + 1)) throw new RestoreRefused(`the files of ${t.name} are not parts 1 to ${t.parts} in a row.`);
    if (files.reduce((n, f) => n + f.rows, 0) !== t.rows) throw new RestoreRefused(`the files of ${t.name} do not add up to the ${t.rows} rows the manifest says.`);
  }
  return { manifest, filesOf: (table) => manifest.files.filter((f) => f.table === table).sort((a, b) => a.part - b.part) };
}

export interface TableCheck {
  table: string;
  manifestRows: number;
  restoredRows: number;
  rowsMatch: boolean;
  /** Per money or whole-number column: the manifest's total and the restored total. */
  sums: { column: string; manifest: string; restored: string; match: boolean }[];
  sumsMatch: boolean;
  /** Every part re-encoded from the restored table has the SHA-256 the manifest records. */
  contentMatch: boolean;
}

export interface RestoreReport {
  outcome: "committed" | "dry-run" | "not-restored";
  folder: string;
  snapshotAt: string;
  tables: TableCheck[];
  rows: number;
  /** Tables that do not match, with what differs. Empty when every table matches. */
  differences: string[];
  /** The one line the tool ends with. */
  finalLine: string;
}

export interface RestoreOptions {
  dir: string;
  databaseUrl: string;
  dryRun?: boolean;
  /** The caller has said (with a flag named as a warning) that a database not on this computer is meant. */
  allowRemote?: boolean;
  out?: (line: string) => void;
}

/** Thrown inside the transaction to roll it back while still returning the report. */
class Discard extends Error {
  readonly report: RestoreReport;
  constructor(report: RestoreReport) {
    super("discard");
    this.report = report;
  }
}

function asColumns(table: ManifestTable, target: TableInfo): ColumnInfo[] {
  return table.columns.map((c) => {
    const have = target.columns.find((x) => x.name === c.name);
    if (have === undefined) throw new RestoreRefused(`the database's table ${table.name} has no column ${c.name.slice(0, 60)}: its migrations are not the copy's.`);
    if (have.type !== c.type) throw new RestoreRefused(`the database's column ${table.name}.${c.name.slice(0, 60)} is ${have.type}, the copy's is ${c.type}: its migrations are not the copy's.`);
    return { ...have, kind: c.kind as ColumnInfo["kind"] };
  });
}

async function checkMigrations(db: Db, manifest: Manifest): Promise<void> {
  let rows: { version: number; name: string; checksum: string }[];
  try {
    rows = await db.query("select version, name, checksum from ops.schema_migrations order by version desc limit 1");
  } catch {
    throw new RestoreRefused("this database has not been migrated (no ops.schema_migrations). Run the migrations first: npm --prefix ops run db:migrate.");
  }
  const mine = rows[0];
  const theirs = manifest.database.newestMigration;
  if (mine === undefined) throw new RestoreRefused("this database has not been migrated (ops.schema_migrations is empty). Run the migrations first.");
  if (mine.version < theirs.version) {
    throw new RestoreRefused(`this database's newest migration is ${mine.version}, older than the copy's ${theirs.version}. Run the migrations first (npm --prefix ops run db:migrate), then restore.`);
  }
  if (mine.version === theirs.version && mine.checksum !== theirs.checksum) {
    throw new RestoreRefused(`this database's migration ${mine.version} is not the same file as the copy's (the checksums differ). Use the same version of the app that made the copy.`);
  }
}

/** Every table of the database that holds a row it should not (a freshly migrated database holds only its seeds). */
async function nonEmptyTables(db: Db, all: readonly TableInfo[]): Promise<string[]> {
  const found: string[] = [];
  for (const t of all) {
    if (t.name === "schema_migrations") continue;
    const seed = MIGRATION_SEEDS[t.name];
    const sql = seed
      ? `select count(*)::int as n from ops.${quoteIdent(t.name)} where ${quoteIdent(seed.column)} <> all($1::text[])`
      : `select (exists (select 1 from ops.${quoteIdent(t.name)}))::int as n`;
    const r = await db.one<{ n: number }>(sql, seed ? [seed.keys] : []);
    if (r.n > 0) found.push(t.name);
  }
  return found;
}

async function insertRows(db: Db, table: TableInfo, columns: readonly ColumnInfo[], rows: readonly Param[][]): Promise<void> {
  if (rows.length === 0) return;
  const loadable = columns.map((c, i) => ({ c, i })).filter(({ c }) => !c.generated);
  const names = loadable.map(({ c }) => quoteIdent(c.name)).join(", ");
  const perStatement = Math.max(1, Math.min(500, Math.floor(60000 / loadable.length)));
  const override = loadable.some(({ c }) => c.identity === "a") ? " overriding system value" : "";
  const seed = MIGRATION_SEEDS[table.name];
  const conflict = seed
    ? ` on conflict (${quoteIdent(seed.column)}) do update set ${loadable.filter(({ c }) => c.name !== seed.column).map(({ c }) => `${quoteIdent(c.name)} = excluded.${quoteIdent(c.name)}`).join(", ")}`
    : "";
  for (let at = 0; at < rows.length; at += perStatement) {
    const chunk = rows.slice(at, at + perStatement);
    const params: Param[] = [];
    const tuples = chunk.map((row) => {
      const marks = loadable.map(({ c, i }) => {
        if (!SAFE_TYPE.test(c.type)) throw new RestoreRefused(`the type of ${table.name}.${c.name.slice(0, 60)} is not one this tool can load.`);
        params.push(row[i] as Param);
        return `$${params.length}::${c.type}`;
      });
      return `(${marks.join(", ")})`;
    });
    await db.query(`insert into ops.${quoteIdent(table.name)} (${names})${override} values ${tuples.join(", ")}${conflict}`, params);
  }
}

async function loadTable(db: Db, dir: string, folder: FolderCheck, table: ManifestTable, target: TableInfo, columns: readonly ColumnInfo[]): Promise<void> {
  const fileColumns: FileColumn[] = columns.map((c) => ({ name: c.name, kind: c.kind }));
  for (const f of folder.filesOf(table.name)) {
    const bytes = readFileSync(join(dir, f.file));
    if (sha256(bytes) !== f.sha256) throw new RestoreRefused(`${f.file} changed while it was being restored.`);
    const params = splitLines(bytes.toString("utf8")).map((line) => decodeLine(fileColumns, line));
    await insertRows(db, target, columns, params);
  }
}

/** Set every identity column of the table so the next new row's number is after the highest restored one. */
async function continueIdentities(db: Db, table: string, columns: readonly ColumnInfo[]): Promise<void> {
  for (const c of columns) {
    if (c.identity === "") continue;
    await db.query(
      `select setval(pg_get_serial_sequence($1, $2), m)::text as next_value from (select max(${quoteIdent(c.name)}) as m from ops.${quoteIdent(table)}) x where m is not null`,
      [`ops.${quoteIdent(table)}`, c.name],
    );
  }
}

async function checkTable(db: Db, folder: FolderCheck, table: ManifestTable, target: TableInfo, columns: readonly ColumnInfo[]): Promise<TableCheck> {
  const read = { ...target, orderBy: table.orderBy };
  const parts: Part[] = [];
  const seen = await readTableInParts(db, read, columns, async (p) => void parts.push({ ...p, bytes: new Uint8Array(0) }), folder.manifest.partLimits);
  const files = folder.filesOf(table.name);
  const contentMatch = parts.length === files.length && parts.every((p, i) => p.sha256 === (files[i] as ManifestFile).sha256 && p.rows === (files[i] as ManifestFile).rows);
  const wanted = table.totals as { rows?: unknown; sums?: unknown; months?: unknown };
  const sums = Object.entries(seen.totals.sums).map(([column, restored]) => {
    const manifest = isObj(wanted.sums) && typeof wanted.sums[column] === "string" ? (wanted.sums[column] as string) : "(not in the manifest)";
    return { column, manifest, restored, match: manifest === restored };
  });
  for (const column of isObj(wanted.sums) ? Object.keys(wanted.sums) : []) {
    if (!(column in seen.totals.sums)) sums.push({ column, manifest: String((wanted.sums as Record<string, unknown>)[column]), restored: "(missing)", match: false });
  }
  const monthsMatch = JSON.stringify(seen.totals.months ?? null) === JSON.stringify(wanted.months ?? null);
  return {
    table: table.name,
    manifestRows: table.rows,
    restoredRows: seen.rows,
    rowsMatch: seen.rows === table.rows,
    sums,
    sumsMatch: sums.every((s) => s.match) && monthsMatch,
    contentMatch,
  };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Restore the folder into the database. Refusals throw RestoreRefused; a difference is reported, and nothing is kept. */
export async function restoreNightly(opts: RestoreOptions): Promise<RestoreReport> {
  const out = opts.out ?? (() => undefined);
  if (!opts.allowRemote && !isLocalUrl(opts.databaseUrl)) {
    throw new RestoreRefused("the database is not on this computer (127.0.0.1 or localhost). A restore loads into an empty database you have just made here; see the guide.");
  }
  const folder = checkFolder(opts.dir);
  const manifest = folder.manifest;
  out(`copy: ${manifest.folder}, snapshot ${manifest.snapshotAt}, ${plural(manifest.tables.length, "table")}, ${manifest.totals.rows} rows, newest migration ${manifest.database.newestMigration.version}`);
  out(`files: ${plural(manifest.files.length, "file")} checked: every length and SHA-256 is the manifest's.`);

  const conn = await connect(opts.databaseUrl);
  try {
    let report: RestoreReport;
    try {
      report = await withTransaction(conn, async (tx): Promise<RestoreReport> => {
        await checkMigrations(tx, manifest);
        const catalogue = await readCatalogue(tx);
        const byName = new Map(catalogue.map((t) => [t.name, t]));
        const columnsOf = new Map<string, ColumnInfo[]>();
        for (const t of manifest.tables) {
          const target = byName.get(t.name);
          if (target === undefined) throw new RestoreRefused(`the database has no table ${t.name}: its migrations are not the copy's.`);
          columnsOf.set(t.name, asColumns(t, target));
        }
        const dirty = await nonEmptyTables(tx, catalogue);
        if (dirty.length > 0) {
          throw new RestoreRefused(`this database is not empty (${dirty.slice(0, 6).join(", ")}${dirty.length > 6 ? ", ..." : ""} hold rows). A restore only loads into a freshly migrated, empty database: make a new one.`);
        }
        const known = new Set([...manifest.tables.map((t) => t.name), ...manifest.excluded.map((e) => e.table), ...Object.keys(EXCLUDED)]);
        const unknown = catalogue.filter((t) => !known.has(t.name)).map((t) => t.name);
        if (unknown.length > 0) out(`note: the database has tables the copy does not know (${unknown.join(", ")}): its migrations are newer than the copy. They stay empty.`);

        await tx.query("set constraints all deferred");
        const order = loadOrder(manifest.tables.map((t) => byName.get(t.name) as TableInfo));
        const tableOf = new Map(manifest.tables.map((t) => [t.name, t]));
        for (const target of order) {
          const t = tableOf.get(target.name) as ManifestTable;
          const columns = columnsOf.get(t.name) as ColumnInfo[];
          await loadTable(tx, opts.dir, folder, t, target, columns);
          await continueIdentities(tx, t.name, columns);
        }

        const checks: TableCheck[] = [];
        for (const t of manifest.tables) {
          checks.push(await checkTable(tx, folder, t, byName.get(t.name) as TableInfo, columnsOf.get(t.name) as ColumnInfo[]));
        }
        const differences: string[] = [];
        for (const c of checks) {
          if (!c.rowsMatch) differences.push(`${c.table}: ${c.restoredRows} rows restored, ${c.manifestRows} in the copy`);
          const badSums = c.sums.filter((s) => !s.match).map((s) => s.column);
          if (badSums.length > 0) differences.push(`${c.table}: sums differ in ${badSums.join(", ")}`);
          else if (!c.sumsMatch) differences.push(`${c.table}: the per-month totals differ`);
          if (!c.contentMatch) differences.push(`${c.table}: the restored rows are not the copy's rows (a part's SHA-256 differs)`);
        }
        const rows = checks.reduce((n, c) => n + c.restoredRows, 0);
        const tail = `${plural(checks.length, "table")}, ${rows} rows`;
        const base = { folder: manifest.folder, snapshotAt: manifest.snapshotAt, tables: checks, rows, differences };
        if (differences.length > 0) {
          throw new Discard({ ...base, outcome: "not-restored", finalLine: `NOT RESTORED: ${plural(differences.length, "difference")}: ${differences.join("; ")}. Nothing was kept.` });
        }
        if (opts.dryRun) {
          throw new Discard({ ...base, outcome: "dry-run", finalLine: `dry run: every table matches (${tail}); everything was done and rolled back, nothing was kept.` });
        }
        return { ...base, outcome: "committed", finalLine: `every table matches: ${tail}, restored and kept.` };
      });
    } catch (err) {
      if (!(err instanceof Discard)) throw err;
      report = err.report;
    }
    for (const c of report.tables) {
      out(`${c.table.padEnd(24)} rows ${String(c.restoredRows).padStart(7)} of ${String(c.manifestRows).padEnd(7)} ${c.rowsMatch && c.sumsMatch && c.contentMatch ? "ok" : "DIFFERS"}`);
      for (const s of c.sums) out(`    ${s.column.padEnd(28)} ${s.restored.padStart(16)}  copy ${s.manifest}${s.match ? "" : "  DIFFERS"}`);
    }
    out(report.finalLine);
    return report;
  } finally {
    await conn.close().catch(() => undefined);
  }
}

export { BackupError };
