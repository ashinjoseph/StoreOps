// The import, from an export directory to the database (card P4-02).
//
//   readExportDir      the manifest and every tab file, checksummed before it is read
//   sort the tabs      migrated, deprecated (skipped, counted) or unknown (the import stops)
//   loadTabs           one transaction, foreign-key order, each tab top to bottom, with the
//                      rules of rules.ts; every check on the database runs inside it
//   decide             commit only for a real run whose rejects are exactly the number the
//                      person accepted; otherwise roll back. Nothing is ever deleted.
//
// The caller (tools/import.ts) owns the process: arguments, environment, printing, files.
import pg from "pg";
import { checkCounts, checkEmpty, checkMigrations, checkSchemaShape, checkStore } from "./database-checks";
import { ImportRefused } from "./errors";
import { readExportDir, type ExportDir } from "./export-dir";
import { loadTabs, readContract, type LoadResult } from "./load";
import { checkPepper, createRules, EXTRA_COLUMNS, OPS_ONLY_TABLES, type RulesReport } from "./rules";
import type { HeaderIssue, Reject, SheetTab, Contract } from "./sheet-to-db";

export interface RunOptions {
  dir: string;
  dryRun: boolean;
  /** --accept-rejects: the exact number of rejects the person has seen and accepts. null: none accepted. */
  acceptRejects: number | null;
  openSessionsBlank: boolean;
  databaseUrl: string;
  pepper: string | undefined;
  contract?: Contract;
  migrationsDir?: string;
  storeId?: string;
}

export type Outcome = "committed" | "dry-run" | "not-committed";

export interface SkippedTab {
  tab: string;
  rows: number;
  reason: string;
}

export interface TableRow {
  table: string;
  /** Data rows in the tab. */
  tabRows: number;
  loaded: number;
  rejected: number;
  reKeyed: number;
  /** Rows with a blank key (empty trailing rows), not loaded and not rejects. */
  blankKey: number;
  /** Rows a rule left out (config secrets, the seeded placeholders). */
  leftOut: number;
}

export interface RunResult {
  outcome: Outcome;
  startedAt: Date;
  finishedAt: Date;
  options: { dryRun: boolean; acceptRejects: number | null; openSessionsBlank: boolean };
  exportDir: ExportDir;
  skippedTabs: SkippedTab[];
  tables: TableRow[];
  rejects: Reject[];
  headerIssues: HeaderIssue[];
  rules: RulesReport;
  /** True when the number of rejects is the number the person accepted (0 when none was given). */
  rejectsAccepted: boolean;
}

/** Tabs of the Sheet: every table of the contract except those that exist only in Operations. */
export function sheetTables(contract: Contract): string[] {
  return Object.keys(contract.tables).filter((t) => !OPS_ONLY_TABLES.includes(t));
}

/** Sort the export's tabs: those to load, those skipped as deprecated, and refuse the rest. */
export function classifyTabs(contract: Contract, exported: ExportDir): { load: SheetTab[]; skipped: SkippedTab[] } {
  const tables = new Set(sheetTables(contract));
  const load: SheetTab[] = [];
  const skipped: SkippedTab[] = [];
  const unknown: string[] = [];
  const withErrors: string[] = [];
  for (const { entry, sheet } of exported.tabs) {
    const deprecated = contract.leftTabs.get(entry.name);
    if (deprecated !== undefined) skipped.push({ tab: entry.name, rows: entry.rows, reason: deprecated });
    else if (tables.has(entry.name)) {
      load.push(sheet);
      if (entry.errors > 0) withErrors.push(`${entry.name} (${entry.errors})`);
    } else unknown.push(entry.name);
  }
  if (unknown.length > 0) {
    throw new ImportRefused(
      `the export has ${unknown.length} tab(s) this importer neither loads nor lists as deprecated: ${unknown.join(", ")}. ` +
        "Nothing is guessed: delete them from the Sheet (or have the contract list them) and export again.",
    );
  }
  const missing = [...tables].filter((t) => !load.some((s) => s.tab === t));
  if (missing.length > 0) {
    throw new ImportRefused(`the export has no tab for: ${missing.join(", ")}. The Sheet must have them (an empty tab is fine); a tab missing from the export would be records lost.`);
  }
  if (withErrors.length > 0) {
    throw new ImportRefused(`tabs with error cells (#REF!, #N/A ...): ${withErrors.join(", ")}. An error cell is not data; fix them in the Sheet and export again.`);
  }
  return { load, skipped };
}

/** The tables in the order of the export's tabs, for a stable report. */
const rank = (exported: ExportDir): Map<string, number> => new Map(exported.tabs.map((t) => [t.entry.name, t.entry.index]));

export async function runImport(options: RunOptions): Promise<RunResult> {
  const startedAt = new Date();
  const pepper = checkPepper(options.pepper);
  const contract = options.contract ?? readContract();
  const exported = readExportDir(options.dir);
  const { load, skipped } = classifyTabs(contract, exported);
  const storeId = options.storeId ?? "store_main";
  const accepted = options.acceptRejects ?? 0;
  const { report: rules, prepare } = createRules({ openSessionsBlank: options.openSessionsBlank, pepper });
  const tableNames = sheetTables(contract);

  const client = new pg.Client({ connectionString: options.databaseUrl });
  // An idle connection the server drops would otherwise crash the process on an unhandled 'error'.
  client.on("error", () => undefined);
  await client.connect();
  let result: LoadResult;
  let committed = false;
  try {
    result = await loadTabs(client, load, {
      contract,
      storeId,
      extraColumns: EXTRA_COLUMNS,
      prepare,
      afterBegin: async (db) => {
        await checkMigrations(db, options.migrationsDir);
        await checkSchemaShape(db, contract, tableNames, EXTRA_COLUMNS);
        await checkStore(db, storeId);
        await checkEmpty(db, tableNames);
      },
      beforeFinish: async (db, r) => {
        await checkCounts(db, Object.fromEntries(tableNames.map((t) => [t, r.counts[t]?.inserted ?? 0])));
      },
      finish: (r) => {
        committed = !options.dryRun && r.rejects.length === accepted;
        return committed ? "commit" : "rollback";
      },
    });
  } finally {
    await client.end().catch(() => undefined);
  }

  const order = rank(exported);
  const rekeyedBy = new Map<string, number>();
  for (const k of rules.rekeyed) rekeyedBy.set(k.table, (rekeyedBy.get(k.table) ?? 0) + 1);
  const tables: TableRow[] = tableNames.map((table) => {
    const c = result.counts[table];
    return {
      table,
      tabRows: c?.read ?? 0,
      loaded: c?.inserted ?? 0,
      rejected: c?.rejected ?? 0,
      reKeyed: rekeyedBy.get(table) ?? 0,
      blankKey: c?.skipped ?? 0,
      leftOut: c?.leftOut ?? 0,
    };
  });
  const rejects = [...result.rejects].sort((a, b) => (order.get(a.tab) ?? 0) - (order.get(b.tab) ?? 0) || a.row - b.row || a.column.localeCompare(b.column));
  return {
    outcome: options.dryRun ? "dry-run" : committed ? "committed" : "not-committed",
    startedAt,
    finishedAt: new Date(),
    options: { dryRun: options.dryRun, acceptRejects: options.acceptRejects, openSessionsBlank: options.openSessionsBlank },
    exportDir: exported,
    skippedTabs: skipped,
    tables,
    rejects,
    headerIssues: result.headerIssues,
    rules,
    rejectsAccepted: rejects.length === accepted,
  };
}
