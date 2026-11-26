/// <reference types="node" />
/**
 * Reconcile report (card P4-03): the proof, at cutover, that the move from the Sheet to the
 * database lost nothing and changed nothing.
 *
 *   npm --prefix ops run reconcile:import -- <export-dir> --import-report <import-report.json> [--out <dir>]
 *
 * It compares the export directory (what the Sheet held: tools/export-sheet.ts) with the database
 * (what tools/import.ts loaded), table by table:
 *   - row counts (tab rows = database rows + rows the import report rejected + rows it left out);
 *   - per month, rows and the exact sum (integer cents, never floating point) of every figure
 *     column, Sheet beside database, with blank counts on both sides (a blank that became 0 is
 *     a difference even when the sum is unchanged);
 *   - every row, every compared column (money to the cent, dates by their Toronto day,
 *     instants to the microsecond, text exactly, enums without case);
 *   - the order of the tables that keep one (seq);
 *   - rows only the database has; tables only the new app has (counted, not compared);
 *   - what must NOT have been loaded: secret config keys, plain-text login codes, deprecated tabs;
 *   - the import report itself: every reject and left-out row it lists must be a real row of the
 *     export, and its totals must add up. A row it explains is listed as "not loaded, per the
 *     import report", with the money it carries; it is not a difference.
 * The Sheet side is computed here from the raw exported cells, by this tool's own plain rules,
 * not by the importer's translation (src/cutover/compare.ts says which rules).
 *
 * It reads, and only reads:
 *   the export directory (checked against its manifest: every checksum, before anything is read);
 *   the import report (import-report.json) and the rejects.csv beside it;
 *   the database, from the environment:  OPS_DB_READ_URL   postgres://ops_read:...@host:port/db
 *     as ops_read (select only), in one `repeatable read, read only` transaction. The URL is
 *     never printed or stored.
 * It refuses (exit 1, nothing written) when the manifest or a tab file does not match, when the
 * import report is not the one for this export (workbook SHA-256) or is not of a committed import.
 *
 * Writes, into a new or empty directory (--out; default ./reconcile-report-<UTC time>), and never
 * into the export directory: reconcile-report.md (for a person) and reconcile-report.json. The
 * printed summary is names and counts. No text, name, pay-rate, login or phone value is printed
 * or written ("differs"); a money difference is a size in cents; money sums per month are.
 *
 * Exit code: 0 there is NO unexplained difference; 1 there is at least one, or an input was
 * refused; 2 wrong usage or no OPS_DB_READ_URL.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { compareExportToDatabase, parseImportReport, reportBelongsToExport, reportJson, reportMarkdown, ReconcileRefused, summaryLines } from "../src/cutover/compare.ts";
import { readDatabase } from "../src/cutover/read-db.ts";
import { ImportRefused } from "../src/import/errors.ts";
import { readExportDir } from "../src/import/export-dir.ts";
import { readContract } from "../src/import/load.ts";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

interface Args {
  dir: string;
  importReport: string;
  out: string | undefined;
}

const USAGE =
  "usage: npm --prefix ops run reconcile:import -- <export-dir> --import-report <import-report.json> [--out <dir>]\n" +
  "environment: OPS_DB_READ_URL (the database, as the ops_read role)";

/** The arguments, or the line that says what is wrong. */
export function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { dir: "", importReport: "", out: undefined };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const take = (name: string): string | undefined => (a === name ? argv[++i] : a.slice(name.length + 1));
    if (a === "--import-report" || a.startsWith("--import-report=")) {
      const v = take("--import-report");
      if (v === undefined || v === "" || v.startsWith("--")) return "--import-report needs the import-report.json of the import";
      args.importReport = v;
    } else if (a === "--out" || a.startsWith("--out=")) {
      const v = take("--out");
      if (v === undefined || v === "" || v.startsWith("--")) return "--out needs a directory";
      args.out = v;
    } else if (a.startsWith("-")) return `unknown option ${a.slice(0, 40)}`;
    else positional.push(a);
  }
  if (positional.length !== 1) return "give exactly one export directory";
  if (args.importReport === "") return "--import-report <import-report.json> is required";
  args.dir = positional[0] as string;
  return args;
}

/** A line about a failure that never quotes a value or the database URL. */
export function describeFailure(e: unknown): string {
  if (e instanceof ImportRefused || e instanceof ReconcileRefused) return e.message;
  const o = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
  if (typeof o["code"] === "string") {
    const code = o["code"];
    const what = code === "42501" ? "permission denied for the ops_read role" : /^[0-9A-Z]{5}$/.test(code) ? "the database refused a statement" : /^E[A-Z]+$/.test(code) ? "could not use the database connection" : "failed";
    return `${what} (${code}).`;
  }
  return "failed.";
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** The output directory: new or empty, and never inside the export. */
function planOutDir(arg: string | undefined, exportDir: string, now: Date): string {
  const dir = resolve(arg ?? `reconcile-report-${stamp(now)}`);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new ReconcileRefused(`${dir} exists and is not a directory.`);
    if (readdirSync(dir).length > 0) throw new ReconcileRefused(`${dir} is not empty: a report is never overwritten. Use a new directory.`);
  }
  const rel = relative(resolve(exportDir), dir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new ReconcileRefused("the output directory is inside the export directory; choose another, so the export stays exactly as it was exported.");
  return dir;
}

/** Read the import report and the rejects.csv that sits beside it. */
function readImportReport(path: string): ReturnType<typeof parseImportReport> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ReconcileRefused(`cannot read the import report ${path}.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ReconcileRefused("the import report is not valid JSON.");
  }
  const named = (json as { rejects?: { file?: unknown } } | null)?.rejects?.file;
  const file = typeof named === "string" && /^[^/\\\0]+$/.test(named) && named !== ".." && named !== "." ? named : "rejects.csv";
  let csv: string;
  try {
    csv = readFileSync(join(dirname(resolve(path)), file), "utf8");
  } catch {
    throw new ReconcileRefused(`cannot read ${file} beside the import report: the rejects of the import are listed there, and without them no rejected row can be explained.`);
  }
  return parseImportReport(json, csv);
}

/** Returns the process exit code. */
export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: Io): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.err(`reconcile-import: ${args}`);
    io.err(USAGE);
    return 2;
  }
  const url = env["OPS_DB_READ_URL"];
  if (!url) {
    io.err("reconcile-import: OPS_DB_READ_URL is not set (the database to check, as the ops_read role).");
    return 2;
  }
  try {
    const startedAt = new Date();
    const outDir = planOutDir(args.out, args.dir, startedAt);
    const exported = readExportDir(args.dir);
    const evidence = readImportReport(args.importReport);
    const tabSha256 = Object.fromEntries(exported.manifest.tabs.map((t) => [t.name, t.sha256]));
    const problems = reportBelongsToExport(evidence, { workbookSha256: exported.manifest.workbook.sha256, manifestSha256: exported.manifestSha256, tabSha256 });
    if (problems.length > 0) {
      throw new ReconcileRefused(`this import report is not for this export, nothing was compared: ${problems.join("; ")}.`);
    }
    const contract = readContract();

    const client = new pg.Client({ connectionString: url });
    // An idle connection the server drops would otherwise crash the process on an unhandled 'error'.
    client.on("error", () => undefined);
    await client.connect();
    let snapshot: Awaited<ReturnType<typeof readDatabase>>;
    try {
      snapshot = await readDatabase(client, contract);
    } finally {
      await client.end().catch(() => undefined);
    }

    const result = compareExportToDatabase({
      contract,
      tabs: exported.tabs.map((t) => ({ name: t.entry.name, header: t.sheet.header, rows: t.sheet.rows })),
      db: snapshot,
      evidence,
    });
    const facts = { startedAt: startedAt.toISOString(), workbookSha256: exported.manifest.workbook.sha256, manifestSha256: exported.manifestSha256 };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "reconcile-report.md"), reportMarkdown(result, facts), { flag: "wx" });
    writeFileSync(join(outDir, "reconcile-report.json"), `${JSON.stringify(reportJson(result, facts), null, 2)}\n`, { flag: "wx" });
    for (const line of summaryLines(result)) io.out(line);
    io.out(`report written to ${outDir}`);
    if (result.unexplained > 0) io.err(`reconcile-import: ${result.unexplained} unexplained difference(s). See reconcile-report.md.`);
    return result.unexplained === 0 ? 0 : 1;
  } catch (e) {
    io.err(`reconcile-import: ${describeFailure(e)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}
