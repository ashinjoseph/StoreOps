/// <reference types="node" />
/**
 * The old purchase list as history (card P5-16; docs/guides/import-the-old-purchase-list.md).
 *
 *   npm --prefix ops run import:purchases -- <workbook.xlsx> --as <staff id> [--tab "Purchase Invoices"]
 *                                            [--dry-run] [--report <dir>] [--replace-file <sha256>]
 *
 * Reads ONE tab of the owner's workbook (the headings in row 1: Date, Supplier Name, Amount, Item, found by
 * what they say, never by position) and writes every row that can be history into ops.legacy_purchases, in
 * one transaction, as the application's role (ops_app: it cannot delete). The old list is NOT turned into
 * receipts: no row gets a business, a supplier or an invoice. See ops/src/receipts/legacy.ts for the rules.
 * It reads, from the environment only (never from arguments, never printed):
 *
 *   OPS_DB_APP_URL   postgres://ops_app:...@127.0.0.1:port/db   the database to load
 *
 * It refuses a database that is not on this computer (127.0.0.1 or localhost) unless it is given
 * --yes-load-into-a-database-that-is-not-on-this-computer. --as is the staff id of an ACTIVE ADMIN: this is a
 * local tool the owner runs on their own computer, and the audit row says so.
 *
 * The same file (SHA-256) again adds nothing and says so. A changed file is refused while another is in the
 * app, unless --replace-file <the old file's SHA-256> says which it replaces: the old rows are then marked
 * replaced (never deleted) and their business and supplier links carry over to the new rows that match.
 * --dry-run does everything and rolls back.
 *
 * It NEVER prints a cell value and never writes one into a report: the lines it prints and the files it
 * writes (import-report.json, rejects.csv in --report <dir>, default ./purchases-report-<UTC time>-<dry-run|import>)
 * hold counts, row numbers and reasons only. It never modifies the workbook and never contacts anyone.
 *
 * Exit code: 0 done (a dry run: would have kept it; or nothing to add), 1 refused or failed, 2 wrong usage or environment.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isLocalUrl } from "../src/backup/restore.ts";
import { connect } from "../src/db/client.ts";
import { withTransaction } from "../src/db/tx.ts";
import { readWorkbook, XlsxError, type XlsxSheet } from "../src/export/xlsx.ts";
import { formatDate } from "../src/lib/dates.ts";
import { cleanFileName, findColumns, LegacyRefused, loadFile, readRows, type LoadOutcome, type ReadResult, type Reject } from "../src/receipts/legacy.ts";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}
export interface Deps {
  /** The instant of the run: the import's day and every time written. */
  now?: () => Date;
}

/** The flag that allows a database that is not on this computer. Named as a warning on purpose (the same words as restore:nightly). */
export const REMOTE_FLAG = "--yes-load-into-a-database-that-is-not-on-this-computer";
export const DEFAULT_TAB = "Purchase Invoices";
export const REPORT_FORMAT = "storeops-legacy-purchases-report/1";

interface Args {
  file: string;
  as: string;
  tab: string;
  dryRun: boolean;
  report: string | undefined;
  replaceFile: string | null;
  allowRemote: boolean;
}

const USAGE =
  'usage: npm --prefix ops run import:purchases -- <workbook.xlsx> --as <staff id> [--tab "Purchase Invoices"] [--dry-run] [--report <dir>] [--replace-file <sha256>]\n' +
  "environment: OPS_DB_APP_URL (the database, as the ops_app role, on this computer)";

/** The arguments, or the line that says what is wrong. */
export function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { file: "", as: "", tab: DEFAULT_TAB, dryRun: false, report: undefined, replaceFile: null, allowRemote: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (name: string): string | undefined => (a === name ? argv[++i] : a.slice(name.length + 1));
    const named = (name: string): boolean => a === name || a.startsWith(`${name}=`);
    if (a === "--dry-run") args.dryRun = true;
    else if (a === REMOTE_FLAG) args.allowRemote = true;
    else if (named("--as")) {
      const v = value("--as");
      if (v === undefined || v === "" || v.startsWith("--")) return "--as needs a staff id: an active admin";
      args.as = v;
    } else if (named("--tab")) {
      const v = value("--tab");
      if (v === undefined || v.trim() === "" || v.startsWith("--")) return "--tab needs the tab's name";
      args.tab = v;
    } else if (named("--report")) {
      const v = value("--report");
      if (v === undefined || v === "" || v.startsWith("--")) return "--report needs a directory";
      args.report = v;
    } else if (named("--replace-file")) {
      const v = value("--replace-file");
      if (v === undefined || !/^[0-9a-fA-F]{64}$/.test(v)) return "--replace-file needs the old file's SHA-256: 64 letters and digits, as the first import printed it";
      args.replaceFile = v.toLowerCase();
    } else if (a.startsWith("-")) return `unknown option ${a.slice(0, 40)}`;
    else positional.push(a);
  }
  if (positional.length !== 1) return "give exactly one workbook (.xlsx)";
  if (args.as === "") return "--as <staff id> is required: the active admin this import is recorded under";
  args.file = positional[0] as string;
  return args;
}

/** A line about a failure that never quotes a value: a database error is its code and names, not its message. */
export function describeFailure(e: unknown): string {
  if (e instanceof LegacyRefused || e instanceof XlsxError) return e.message;
  const o = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
  if (typeof o["code"] === "string") {
    const names = [
      typeof o["table"] === "string" && o["table"] !== "" ? `table ${o["table"]}` : "",
      typeof o["constraint"] === "string" && o["constraint"] !== "" ? `constraint ${o["constraint"]}` : "",
      typeof o["column"] === "string" && o["column"] !== "" ? `column ${o["column"]}` : "",
    ].filter((s) => s !== "");
    const what = o["code"] === "42501" ? "permission denied" : "the database refused a statement";
    return `${what} (${o["code"]}${names.length > 0 ? `, ${names.join(", ")}` : ""}). Nothing was kept.`;
  }
  return e instanceof Error ? `${e.message} Nothing was kept.` : "failed. Nothing was kept.";
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** The report directory: new or empty. */
function planReportDir(arg: string | undefined, dryRun: boolean, now: Date): string {
  const dir = resolve(arg ?? `purchases-report-${stamp(now)}-${dryRun ? "dry-run" : "import"}`);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new LegacyRefused(`${dir} exists and is not a directory.`);
    if (readdirSync(dir).length > 0) throw new LegacyRefused(`${dir} is not empty: a report is never overwritten. Use a new directory.`);
  }
  return dir;
}

/** The tab by its name: exactly, or else ignoring capitals and spaces around it. Never guessed beyond that. */
function pickTab(sheets: readonly XlsxSheet[], name: string): XlsxSheet {
  const exact = sheets.find((s) => s.name === name);
  if (exact !== undefined) return exact;
  const loose = sheets.filter((s) => s.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (loose.length === 1) return loose[0] as XlsxSheet;
  throw new LegacyRefused(`The workbook has no tab named "${name}". Its tabs are: ${sheets.map((s) => `"${s.name}"`).join(", ")}. Give the right one with --tab. Nothing was written.`);
}

/** rejects.csv: the row number as a person sees it, the column's heading and the reason. Never a value. */
export function rejectsCsv(rejects: readonly Reject[]): string {
  return ["row,column,reason", ...rejects.map((r) => `${r.sheetRow},${r.column},${r.reason}`)].join("\n") + "\n";
}

/** How many rejects there are for each reason: a count, never a value. */
export function reasonCounts(rejects: readonly Reject[]): Array<{ column: string; reason: string; count: number }> {
  const m = new Map<string, { column: string; reason: string; count: number }>();
  for (const r of rejects) {
    const k = `${r.column}|${r.reason}`;
    const e = m.get(k);
    if (e) e.count++;
    else m.set(k, { column: r.column, reason: r.reason, count: 1 });
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

class DryRun extends Error {}

/** Returns the process exit code. */
export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: Io, deps: Deps = {}): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.err(`import-purchases: ${args}`);
    io.err(USAGE);
    return 2;
  }
  const url = env["OPS_DB_APP_URL"];
  if (!url) {
    io.err("import-purchases: OPS_DB_APP_URL is not set (the database to load, as the ops_app role).");
    return 2;
  }
  if (!args.allowRemote && !isLocalUrl(url)) {
    io.err("import-purchases: that database is not on this computer (127.0.0.1 or localhost). Nothing was written. The old list is loaded into a database you run here; see the guide.");
    return 1;
  }
  const now = (deps.now ?? (() => new Date()))();
  let db: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const reportDir = planReportDir(args.report, args.dryRun, now);
    let bytes: Buffer;
    try {
      bytes = readFileSync(args.file);
    } catch (e) {
      throw new LegacyRefused(`cannot read the workbook: ${(e as NodeJS.ErrnoException).code ?? "unreadable"}`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const sheet = pickTab(readWorkbook(bytes, { headerRow: 1 }).sheets, args.tab);
    const table = sheet.table as NonNullable<XlsxSheet["table"]>;
    const cols = findColumns(table.header);
    const read: ReadResult = readRows(table.rows, cols, formatDate(now));
    const fileName = cleanFileName(basename(args.file));

    db = await connect(url);
    let outcome: LoadOutcome | undefined;
    try {
      await withTransaction(db, async (tx) => {
        outcome = await loadFile(tx, { sha256, fileName, tab: sheet.name, result: read, staffId: args.as, replaces: args.replaceFile, now });
        if (args.dryRun) throw new DryRun();
      });
    } catch (e) {
      if (!(e instanceof DryRun)) throw e;
    }
    const done = outcome as LoadOutcome;
    const c = read.counts;
    const word = args.dryRun ? "dry-run" : done.outcome === "already" ? "already-imported" : "imported";

    const lines: string[] = [];
    lines.push(`file: ${fileName}, SHA-256 ${sha256}`);
    lines.push(`tab: ${sheet.name}; columns found by their headings: Date, Supplier Name, Amount, Item`);
    lines.push(`rows read: ${c.read}${c.empty > 0 ? ` (and ${c.empty} empty row${c.empty === 1 ? "" : "s"} skipped)` : ""}`);
    lines.push(`kept: ${c.kept}`);
    lines.push(`rejected: ${c.rejected}${c.rejected > 0 ? " (NOT imported: see rejects.csv for each row number and reason)" : ""}`);
    for (const r of reasonCounts(read.rejects)) lines.push(`  ${r.count} x ${r.column}: ${r.reason}`);
    lines.push(`kept with no supplier written: ${c.noSupplier}; with no item: ${c.noNote}; with an amount of zero: ${c.zero}; below zero (refunds): ${c.negative}`);
    lines.push(`repeats of an earlier row (same date, supplier and amount; all kept): ${c.repeats}`);
    lines.push(`supplier spellings: ${c.spellings}`);
    if (done.outcome === "already") {
      lines.push(done.supersededBy === null ? "This file was imported before. Nothing was added." : "This file was imported before, and has since been replaced by a newer file. Nothing was added.");
    } else if (done.replaced !== null) {
      lines.push(`replaced the old file's ${done.replaced.oldRows} rows (marked replaced, never deleted); business and supplier choices carried over to the matching new rows: ${done.replaced.carriedOver}; not carried over: ${done.replaced.notCarried}`);
    }

    if (done.outcome === "imported" || args.dryRun) {
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(`${reportDir}/rejects.csv`, rejectsCsv(read.rejects), { flag: "wx" });
      writeFileSync(
        `${reportDir}/import-report.json`,
        `${JSON.stringify(
          {
            format: REPORT_FORMAT,
            outcome: word,
            workbook: { file: fileName, sha256, bytes: bytes.length },
            tab: sheet.name,
            counts: c,
            rejectsByReason: reasonCounts(read.rejects),
            replaced: done.outcome === "imported" ? done.replaced : null,
            note: "Counts, row numbers and reasons only: no cell value is written here.",
          },
          null,
          2,
        )}\n`,
        { flag: "wx" },
      );
      lines.push(`report: ${reportDir} (import-report.json, rejects.csv)`);
    }
    for (const l of lines) io.out(l);
    if (args.dryRun) io.out(done.outcome === "already" ? "dry run: nothing would be added." : "dry run: everything was done and rolled back; nothing was kept.");
    else if (done.outcome === "imported") io.out(`committed: ${done.rows} rows are in the old purchase list.`);
    return 0;
  } catch (e) {
    io.err(`import-purchases: ${describeFailure(e)}`);
    return 1;
  } finally {
    await db?.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}
