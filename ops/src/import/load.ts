// Load translated Sheet tabs into Postgres (card P2-09a).
//
// One transaction on a connection the caller owns. Tables go in foreign-key
// order; each table is written with parameterised multi-row inserts in
// batches, never row by row. SQL takes values only as parameters; table and
// column names come only from the contract file.
import { readFileSync } from "node:fs";
import type pg from "pg";
import {
  parseContract,
  translateTab,
  type Contract,
  type HeaderIssue,
  type Reject,
  type SheetTab,
  type Table,
  type TranslatedTab,
  type Value,
} from "./sheet-to-db";

export type { SheetTab };

/** What a `prepare` hook sees: every tab translated, before anything is written. It may change them in place. */
export interface PrepareContext {
  translated: Map<string, TranslatedTab>;
  tabs: readonly SheetTab[];
  contract: Contract;
}

export interface LoadOptions {
  /** Default: ops/contracts/schema.sql, read from disk. */
  contract?: Contract;
  storeId?: string;
  faithful?: boolean;
  /** Most rows in one INSERT. Default: as many as fit in 60,000 parameters, at most 1000. */
  batchRows?: number;
  /**
   * Columns the database has that schema.sql does not (added by migrations), per table, that the
   * translated rows may carry. Rows are inserted with the contract's columns and these; any
   * other column of the database is left to its default.
   */
  extraColumns?: Readonly<Record<string, readonly string[]>>;
  /** Run after every tab is translated and before the transaction begins. The import tool's rules go here. */
  prepare?: (ctx: PrepareContext) => void | Promise<void>;
  /** Run inside the transaction, right after it begins, on the same connection. Throw to refuse: nothing is kept. */
  afterBegin?: (db: pg.Client) => Promise<void>;
  /** Run inside the transaction after the last insert, before the decision to commit. Throw to roll back. */
  beforeFinish?: (db: pg.Client, result: LoadResult) => Promise<void>;
  /** "commit" (the default), "rollback" (a dry run: everything is done, nothing is kept), or a decision made from the result. */
  finish?: "commit" | "rollback" | ((result: LoadResult) => "commit" | "rollback");
}

export interface TableCounts {
  read: number;
  inserted: number;
  skipped: number;
  rejected: number;
  leftOut: number;
}

export interface LoadResult {
  counts: Record<string, TableCounts>;
  rejects: Reject[];
  headerIssues: HeaderIssue[];
}

/** Parse ops/contracts/schema.sql (or the file at `path`). */
export function readContract(path: URL | string = new URL("../../contracts/schema.sql", import.meta.url)): Contract {
  return parseContract(readFileSync(path, "utf8"));
}

/** Tables in an order where every table comes after the ones it references. */
function foreignKeyOrder(contract: Contract): string[] {
  const done = new Set<string>();
  const order: string[] = [];
  const visit = (t: Table, trail: string[]): void => {
    if (done.has(t.name)) return;
    if (trail.includes(t.name)) return; // a cycle: the deferrable ones are checked at commit
    for (const c of t.columns) {
      const parent = c.references ? contract.tables[c.references] : undefined;
      if (parent && parent.name !== t.name) visit(parent, [...trail, t.name]);
    }
    done.add(t.name);
    order.push(t.name);
  };
  for (const t of Object.values(contract.tables)) visit(t, []);
  return order;
}

interface PgError {
  code: string;
  detail?: string;
  column?: string;
  constraint?: string;
}
const asPgError = (e: unknown): PgError | undefined =>
  typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "string" ? (e as PgError) : undefined;

/** A row's own fault, as opposed to a broken connection: integrity (23) and data (22) errors. */
const isRowError = (e: PgError | undefined): e is PgError => e !== undefined && /^2[23]/.test(e.code);

const REASONS: Record<string, string> = {
  "22003": "number out of range for the column",
  "22001": "text too long for the column",
  "22P02": "value is not valid for the column type",
  "23502": "a required value is missing",
  "23503": "refers to a row that does not exist",
  "23505": "duplicates another row's key",
  "23514": "breaks a check constraint of the contract",
};

/** The column a database error is about: never the value, which the error's detail also holds. */
function columnOf(table: Table, e: PgError): string {
  const names = new Set(table.columns.map((c) => c.name));
  if (e.column && names.has(e.column)) return e.column;
  const key = e.detail ? /^Key \(([a-z_]+)/.exec(e.detail) : null;
  if (key && names.has(key[1] as string)) return key[1] as string;
  if (e.constraint) {
    const m = new RegExp(`^${table.name}_(.+?)_(?:fkey|check|key)$`).exec(e.constraint);
    if (m && names.has(m[1] as string)) return m[1] as string;
    return `(constraint ${e.constraint})`;
  }
  return "(row)";
}

/** Why the database refused a row: the kind of fault, and for a missing parent, the parent's table and column (never its value). */
function reasonOf(contract: Contract, table: Table, column: string, e: PgError): string {
  if (e.code === "23503") {
    const parentName = table.columns.find((c) => c.name === column)?.references;
    const parent = parentName ? contract.tables[parentName] : undefined;
    const pk = parent?.columns.find((c) => c.primaryKey)?.name;
    if (parent && pk) return `its ${column} refers to a row of ${parent.name}.${pk} that was rejected or is missing`;
  }
  return REASONS[e.code] ?? `refused by the database (${e.code})`;
}

async function insertTable(
  db: pg.Client,
  contract: Contract,
  table: Table,
  tab: TranslatedTab,
  batchRows: number | undefined,
  extra: readonly string[],
): Promise<{ inserted: number; rejects: Reject[] }> {
  const first = tab.rows[0];
  if (!first) return { inserted: 0, rejects: [] };
  // Names written into SQL come only from the contract (and the caller's own extra list), never from a row.
  const cols = [...table.columns.map((c) => c.name), ...extra.filter((n) => /^[a-z_]+$/.test(n))].filter((c) => c in first);
  const quoted = cols.map((c) => `"${c}"`).join(", ");
  const perBatch = Math.max(1, Math.min(batchRows ?? 1000, Math.floor(60000 / cols.length)));
  const items = tab.rows.map((row, i) => ({ row, rowNo: tab.rowNumbers[i] as number }));
  const rejects: Reject[] = [];
  let inserted = 0;

  const insertChunk = async (chunk: typeof items): Promise<PgError | undefined> => {
    const params: Value[] = [];
    const groups = chunk.map((it) => `(${cols.map((c) => `$${params.push(it.row[c] ?? null)}`).join(", ")})`);
    // A savepoint, so a refused batch leaves the transaction usable.
    await db.query("savepoint import_batch");
    try {
      await db.query(`insert into ops."${table.name}" (${quoted}) values ${groups.join(", ")}`, params);
      await db.query("release savepoint import_batch");
      return undefined;
    } catch (err) {
      await db.query("rollback to savepoint import_batch");
      await db.query("release savepoint import_batch");
      const e = asPgError(err);
      if (!isRowError(e)) {
        // A fault of the connection or the grants, not of a row: it ends the import. Say which table (a permission error does not).
        if (typeof err === "object" && err !== null) (err as Record<string, unknown>)["importTable"] ??= table.name;
        throw err;
      }
      return e;
    }
  };

  // On a refusal, halve the batch until the offending row stands alone. Only
  // the failure path pays for this; a clean load is one statement per batch.
  const write = async (chunk: typeof items): Promise<void> => {
    const err = await insertChunk(chunk);
    if (!err) {
      inserted += chunk.length;
      return;
    }
    if (chunk.length === 1) {
      const one = chunk[0] as (typeof items)[number];
      const column = columnOf(table, err);
      rejects.push({ tab: tab.tab, row: one.rowNo, column, reason: reasonOf(contract, table, column, err) });
      return;
    }
    const mid = chunk.length >> 1;
    await write(chunk.slice(0, mid));
    await write(chunk.slice(mid));
  };

  for (let i = 0; i < items.length; i += perBatch) await write(items.slice(i, i + perBatch));
  return { inserted, rejects };
}

/**
 * Translate and insert `tabs`. All or nothing: any error other than a row the
 * database refuses (which becomes a reject) rolls everything back and is
 * rethrown. `db` must be a connected client that is not already in a transaction.
 */
export async function loadTabs(db: pg.Client, tabs: readonly SheetTab[], options: LoadOptions = {}): Promise<LoadResult> {
  const contract = options.contract ?? readContract();
  const counts: Record<string, TableCounts> = {};
  const rejects: Reject[] = [];
  const headerIssues: HeaderIssue[] = [];
  const translated = new Map<string, TranslatedTab>();

  for (const t of tabs) {
    const r = translateTab(t.tab, t.header, t.rows, {
      contract,
      ...(options.storeId !== undefined ? { storeId: options.storeId } : {}),
      ...(options.faithful !== undefined ? { faithful: options.faithful } : {}),
    });
    if (r.status === "not_migrated") {
      counts[t.tab] = { read: r.read, inserted: 0, skipped: 0, rejected: 0, leftOut: r.read };
      continue;
    }
    translated.set(t.tab, r);
  }
  await options.prepare?.({ translated, tabs, contract });
  for (const [name, r] of translated) {
    rejects.push(...r.rejects);
    headerIssues.push(...r.headerIssues);
    counts[name] = { read: r.read, inserted: 0, skipped: r.skipped, rejected: r.rejectedRows, leftOut: r.leftOut };
  }

  await db.query("begin");
  try {
    // A deferrable foreign key (bonuses.source_run_id) would otherwise fail the whole commit for one
    // bad row. Checked at each statement, a missing parent is that row's reject like any other.
    await db.query("set constraints all immediate");
    await options.afterBegin?.(db);
    for (const name of foreignKeyOrder(contract)) {
      const tab = translated.get(name);
      const table = contract.tables[name];
      if (!tab || !table) continue;
      const res = await insertTable(db, contract, table, tab, options.batchRows, options.extraColumns?.[name] ?? []);
      const c = counts[name] as TableCounts;
      c.inserted = res.inserted;
      c.rejected += res.rejects.length;
      rejects.push(...res.rejects);
    }
    const result: LoadResult = { counts, rejects, headerIssues };
    await options.beforeFinish?.(db, result);
    const how = typeof options.finish === "function" ? options.finish(result) : (options.finish ?? "commit");
    await db.query(how === "commit" ? "commit" : "rollback");
  } catch (err) {
    await db.query("rollback");
    throw err;
  }
  return { counts, rejects, headerIssues };
}
