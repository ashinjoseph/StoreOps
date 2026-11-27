/// <reference types="node" />
/**
 * Restore a nightly copy into an empty local database (card P4-06a; docs/guides/restore-a-nightly-copy.md).
 *
 *   npm --prefix ops run restore:nightly -- <folder> [--dry-run]
 *
 * <folder> is one copy's folder, downloaded whole from the BACKUPS bucket onto this computer (the tool never
 * contacts the bucket, or any hosted database). It reads, from the environment only (never from arguments,
 * never printed), the database to load, which must be EMPTY and freshly migrated:
 *
 *   OPS_DB_OWNER_URL       postgres://ops_owner:...@127.0.0.1:port/db   (preferred), or
 *   OPS_DB_SUPERUSER_URL   a superuser's URL for the same database
 *
 * The owner (or a superuser), not ops_app: a restore must set the identity counters so new rows continue
 * after the restored ones, and the app role may not do that.
 *
 * Before it writes anything it refuses (exit 1, nothing written) when the folder has no manifest.json, a file
 * is missing, extra, or differs by one byte (length and SHA-256 are checked), the database is not on this
 * computer, is not migrated up to the copy's newest migration, or holds any row. It then loads every table in
 * one transaction, sets the identity counters, reads every table back out and compares row counts, money
 * sums per month and the SHA-256 of every part with the manifest, and keeps the result only if every table
 * matches. --dry-run does all of it and rolls back.
 *
 * It ends with ONE line: "every table matches ..." or "NOT RESTORED: ...". Nothing it prints is a row's value.
 *
 * Exit code: 0 done (a dry run: would have kept it), 1 refused, failed or a table differs, 2 wrong usage or environment.
 */
import { pathToFileURL } from "node:url";
import { isLocalUrl, restoreNightly, RestoreRefused } from "../src/backup/restore.ts";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

/** The flag that allows a database that is not on this computer. Named as a warning on purpose. */
export const REMOTE_FLAG = "--yes-load-into-a-database-that-is-not-on-this-computer";

interface Args {
  dir: string;
  dryRun: boolean;
  allowRemote: boolean;
}

const USAGE =
  "usage: npm --prefix ops run restore:nightly -- <folder> [--dry-run]\n" +
  "environment: OPS_DB_OWNER_URL (or OPS_DB_SUPERUSER_URL): an EMPTY, freshly migrated database on this computer";

/** The arguments, or the line that says what is wrong. */
export function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { dir: "", dryRun: false, allowRemote: false };
  const positional: string[] = [];
  for (const a of argv) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a === REMOTE_FLAG) args.allowRemote = true;
    else if (a.startsWith("-")) return `unknown option ${a.slice(0, 40)}`;
    else positional.push(a);
  }
  if (positional.length !== 1) return "give exactly one folder: the copy's folder, downloaded whole";
  args.dir = positional[0] as string;
  return args;
}

/** A line about a failure that never quotes a value: a database error is its code and names, not its message. */
export function describeFailure(e: unknown): string {
  if (e instanceof RestoreRefused) return `${e.message} Nothing was written.`;
  const o = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
  if (typeof o["code"] === "string" || typeof o["kind"] === "string") {
    const bits = [
      typeof o["table"] === "string" && o["table"] !== "" ? `table ${o["table"]}` : "",
      typeof o["constraint"] === "string" && o["constraint"] !== "" ? `constraint ${o["constraint"]}` : "",
      typeof o["column"] === "string" && o["column"] !== "" ? `column ${o["column"]}` : "",
    ].filter((s) => s !== "");
    return `the database refused a statement (${String(o["code"] ?? o["kind"])}${bits.length > 0 ? `, ${bits.join(", ")}` : ""}). Nothing was kept.`;
  }
  return e instanceof Error ? `${e.message} Nothing was kept.` : "failed. Nothing was kept.";
}

/** Returns the process exit code. */
export async function main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: Io): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    io.err(`restore-nightly: ${args}`);
    io.err(USAGE);
    return 2;
  }
  const url = env["OPS_DB_OWNER_URL"] || env["OPS_DB_SUPERUSER_URL"];
  if (!url) {
    io.err("restore-nightly: OPS_DB_OWNER_URL (or OPS_DB_SUPERUSER_URL) is not set: the empty, freshly migrated database to load.");
    io.err(USAGE);
    return 2;
  }
  if (!args.allowRemote && !isLocalUrl(url)) {
    io.err("restore-nightly: that database is not on this computer (127.0.0.1 or localhost). Nothing was written. A restore loads into a database you have just made here.");
    return 1;
  }
  try {
    const report = await restoreNightly({ dir: args.dir, databaseUrl: url, dryRun: args.dryRun, allowRemote: args.allowRemote, out: (l) => io.out(l) });
    return report.outcome === "not-restored" ? 1 : 0;
  } catch (e) {
    io.err(`restore-nightly: ${describeFailure(e)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env, {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
  });
}
