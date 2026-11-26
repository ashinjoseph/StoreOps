/// <reference types="node" />
/**
 * Sheet import tool (card P4-02): the cutover's data move.
 *
 *   npm --prefix ops run import:sheet -- <export-dir> [--dry-run] [--report <dir>]
 *                                        [--accept-rejects <n>] [--open-sessions-blank]
 *
 * Loads the directory export:sheet wrote (card P4-01) into the Operations database, in one
 * transaction, in foreign-key order, every tab top to bottom. It reads, from the environment
 * only (never from arguments, never printed):
 *
 *   OPS_DB_APP_URL   postgres://ops_app:...@host:port/db   the database to load
 *   PIN_PEPPER       the Worker's PIN_PEPPER secret: staff.login_code is hashed with it
 *
 * It connects as ops_app, the application's role: insert, update and select on the tables,
 * insert and select only on audit_log, and no delete anywhere it loads. The import needs no
 * more, and the database itself then refuses what the tool promises never to do. The owner
 * role is for migrations and is never used here.
 *
 * Before it writes anything it refuses (exit 1, nothing written to the database) when:
 *   - the manifest, a tab file, or the set of files does not match (every tab file's SHA-256
 *     is compared with the manifest before the file is read);
 *   - a tab is neither loaded nor listed as deprecated in ops/contracts/schema.sql, or a tab
 *     the contract loads is missing, or a loaded tab has error cells;
 *   - a migration of ops/migrations is not applied, or any table it loads into has a row
 *     (there is no --force; it never deletes or truncates);
 *   - PIN_PEPPER is missing or shorter than 16 characters.
 *
 * Rows that cannot be loaded are not fatal: each goes to rejects.csv (tab, Sheet row number,
 * column, reason; never a cell value) and the rest loads. The transaction commits only when
 * the number of rejects is exactly the number given to --accept-rejects (none given: zero),
 * so a reject can never pass unnoticed. --dry-run does everything and rolls back.
 *
 * Files, in --report <dir> (default ./import-report-<UTC time>-<dry-run|import>): rejects.csv
 * and import-report.json. The directory must be new or empty, and outside the export.
 * The printed table is counts only.
 *
 * Exit code: 0 done (a dry run: would have committed), 1 refused, failed, or rejects not accepted,
 * 2 wrong usage or environment.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { ImportRefused } from "../src/import/errors.ts";
import { buildReport, rejectsCsv, summaryLines } from "../src/import/report.ts";
import { runImport, type RunResult } from "../src/import/run.ts";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

interface Args {
  dir: string;
  dryRun: boolean;
  report: string | undefined;
  acceptRejects: number | null;
  openSessionsBlank: boolean;
}

const USAGE =
  "usage: npm --prefix ops run import:sheet -- <export-dir> [--dry-run] [--report <dir>] [--accept-rejects <n>] [--open-sessions-blank]\n" +
  "environment: OPS_DB_APP_URL (the database), PIN_PEPPER (the Worker's PIN secret)";

/** The arguments, or the line that says what is wrong. */
export function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { dir: "", dryRun: false, report: undefined, acceptRejects: null, openSessionsBlank: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const value = (name: string): string | undefined => {
      if (a === name) return argv[++i];
      return a.slice(name.length + 1);
    };
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--open-sessions-blank") args.openSessionsBlank = true;
    else if (a === "--report" || a.startsWith("--report=")) {
      const v = value("--report");
      if (v === undefined || v === "" || v.startsWith("--")) return "--report needs a directory";
      args.report = v;
    } else if (a === "--accept-rejects" || a.startsWith("--accept-rejects=")) {
      const v = value("--accept-rejects");
      if (v === undefined || !/^(0|[1-9][0-9]{0,8})$/.test(v)) return "--accept-rejects needs a whole number: the exact number of rejects you have seen in the dry run";
      args.acceptRejects = Number(v);
    } else if (a.startsWith("-")) return `unknown option ${a.slice(0, 40)}`;
    else positional.push(a);
  }
  if (positional.length !== 1) return "give exactly one export directory";
  args.dir = positional[0] as string;
  return args;
}

/** A line about a failure that never quotes a value: a database error is its code and names, not its message. */
export function describeFailure(e: unknown): string {
  if (e instanceof ImportRefused) return e.message;
  const o = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
  if (typeof o["code"] === "string") {
    const table = typeof o["table"] === "string" && o["table"] !== "" ? o["table"] : o["importTable"];
    const names = [
      typeof table === "string" ? `table ${table}` : "",
      typeof o["constraint"] === "string" && o["constraint"] !== "" ? `constraint ${o["constraint"]}` : "",
      typeof o["column"] === "string" && o["column"] !== "" ? `column ${o["column"]}` : "",
    ].filter((s) => s !== "");
    const what = o["code"] === "42501" ? "permission denied" : "the database refused a statement";
    return `${what} (${o["code"]}${names.length > 0 ? `, ${names.join(", ")}` : ""}). Nothing was kept.`;
  }
  return e instanceof Error ? `${e.message} Nothing was kept.` : "failed. Nothing was kept.";
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** The report directory: must be new or empty, and must not be inside the export (extra files would stop the next import). */
function planReportDir(arg: string | undefined, exportDir: string, dryRun: boolean, now: Date): string {
  const dir = resolve(arg ?? `import-report-${stamp(now)}-${dryRun ? "dry-run" : "import"}`);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new ImportRefused(`${dir} exists and is not a directory.`);
    if (readdirSync(dir).length > 0) throw new ImportRefused(`${dir} is not empty: a report is never overwritten. Use a new directory.`);
  }
  const rel = relative(resolve(exportDir), dir);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) throw new ImportRefused("the report directory is inside the export directory; choose another, so the export stays exactly as it was exported.");
  return dir;
}

function writeReport(dir: string, run: RunResult): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/rejects.csv`, rejectsCsv(run.rejects), { flag: "wx" });
  writeFileSync(`${dir}/import-report.json`, `${JSON.stringify(buildReport(run), null, 2)}\n`, { flag: "wx" });
}

/** Returns the process exit code. */
export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: Io): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.err(`import-sheet: ${args}`);
    io.err(USAGE);
    return 2;
  }
  const url = env["OPS_DB_APP_URL"];
  if (!url) {
    io.err("import-sheet: OPS_DB_APP_URL is not set (the database to load, as the ops_app role).");
    return 2;
  }
  try {
    const reportDir = planReportDir(args.report, args.dir, args.dryRun, new Date());
    const run = await runImport({
      dir: args.dir,
      dryRun: args.dryRun,
      acceptRejects: args.acceptRejects,
      openSessionsBlank: args.openSessionsBlank,
      databaseUrl: url,
      pepper: env["PIN_PEPPER"],
    });
    writeReport(reportDir, run);
    for (const line of summaryLines(run, reportDir)) io.out(line);
    if (run.outcome === "dry-run") io.out("dry run: everything was done and rolled back; nothing was kept.");
    if (run.outcome === "committed") io.out("committed.");
    if (!run.rejectsAccepted) {
      const n = run.rejects.length;
      io.err(
        args.acceptRejects === null
          ? `import-sheet: ${n} row(s) were rejected (see rejects.csv). ${run.outcome === "dry-run" ? "" : "Nothing was kept. "}To load the rest with exactly these rejected, give --accept-rejects ${n}.`
          : `import-sheet: ${n} row(s) were rejected but --accept-rejects ${args.acceptRejects} was given. ${run.outcome === "dry-run" ? "" : "Nothing was kept. "}Look at rejects.csv; accept only the number you have seen.`,
      );
      return 1;
    }
    return 0;
  } catch (e) {
    io.err(`import-sheet: ${describeFailure(e)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}
