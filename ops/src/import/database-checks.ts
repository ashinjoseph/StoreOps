// What the import tool checks about the database before it writes a row (card P4-02).
// All of it runs inside the import's own transaction, on its own connection, and only reads.
// Each check throws ImportRefused, with everything it found of its kind in one message.
//
// SQL takes values as parameters; table and column names come from the parsed contract.
import type pg from "pg";
import { DEFAULT_MIGRATIONS_DIR, readMigrationFiles } from "../db/migrate";
import { ImportRefused } from "./errors";
import type { Contract } from "./sheet-to-db";

const IDENT = /^[a-z_]+$/;
const quoted = (name: string): string => {
  if (!IDENT.test(name)) throw new Error(`unsafe table name in the contract: ${name}`);
  return `"${name}"`;
};

/** Every file of ops/migrations is applied, unchanged, and nothing else is. */
export async function checkMigrations(db: pg.Client, dir: string = DEFAULT_MIGRATIONS_DIR): Promise<void> {
  const files = readMigrationFiles(dir);
  const present = await db.query<{ present: boolean }>("select to_regclass('ops.schema_migrations') is not null as present");
  const applied = new Map<number, { name: string; checksum: string }>();
  if (present.rows[0]?.present === true) {
    const res = await db.query<{ version: number; name: string; checksum: string }>("select version, name, checksum from ops.schema_migrations order by version");
    for (const r of res.rows) applied.set(r.version, r);
  }
  const notApplied = files.filter((f) => !applied.has(f.version)).map((f) => f.id);
  if (notApplied.length > 0) {
    throw new ImportRefused(`the database is not fully migrated: ${notApplied.length} migration(s) not applied (${notApplied.join(", ")}). Run \`npm --prefix ops run db:migrate\` first.`);
  }
  const different: string[] = [];
  for (const [version, row] of applied) {
    const file = files.find((f) => f.version === version);
    if (!file || file.name !== row.name || file.checksum !== row.checksum) different.push(`${String(version).padStart(4, "0")}_${row.name}`);
  }
  if (different.length > 0) {
    throw new ImportRefused(`the database was migrated with migration files that differ from ops/migrations (${different.join(", ")}). Use the checkout the database was migrated from.`);
  }
}

/**
 * The database's columns are the contract's, plus the columns the importer writes beyond it
 * (`extra`), plus columns it can leave to a default (nullable, a default, or an identity).
 * A table with any other column would refuse every row, or take a row the importer never meant.
 */
export async function checkSchemaShape(db: pg.Client, contract: Contract, tables: readonly string[], extra: Readonly<Record<string, readonly string[]>>): Promise<void> {
  const res = await db.query<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null; is_identity: string }>(
    "select table_name, column_name, is_nullable, column_default, is_identity from information_schema.columns where table_schema = 'ops' and table_name = any($1::text[])",
    [tables],
  );
  const byTable = new Map<string, Map<string, (typeof res.rows)[number]>>();
  for (const r of res.rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Map());
    byTable.get(r.table_name)?.set(r.column_name, r);
  }
  const problems: string[] = [];
  for (const name of tables) {
    const have = byTable.get(name);
    const table = contract.tables[name];
    if (!have || !table) {
      problems.push(`table ${name} does not exist`);
      continue;
    }
    const known = new Set([...table.columns.map((c) => c.name), ...(extra[name] ?? [])]);
    for (const c of known) if (!have.has(c)) problems.push(`${name}.${c} does not exist in the database`);
    for (const [c, info] of have) {
      if (known.has(c)) continue;
      const leavesToDefault = info.is_nullable === "YES" || info.column_default !== null || info.is_identity === "YES";
      if (!leavesToDefault) problems.push(`${name}.${c} is required by the database and unknown to the importer`);
    }
  }
  if (problems.length > 0) throw new ImportRefused(`the database does not have the schema this importer was written for: ${problems.join("; ")}.`);
}

/** The store every row is filed under exists. */
export async function checkStore(db: pg.Client, storeId: string): Promise<void> {
  const res = await db.query("select 1 from ops.stores where id = $1", [storeId]);
  if (res.rowCount !== 1) throw new ImportRefused(`the database has no store "${storeId}": every imported row belongs to it. Apply the migrations (they seed it).`);
}

/** Every table the import loads into holds no rows. The tool never deletes, so a non-empty table stops it. */
export async function checkEmpty(db: pg.Client, tables: readonly string[]): Promise<void> {
  const full: string[] = [];
  for (const name of tables) {
    const res = await db.query<{ full: boolean }>(`select exists (select 1 from ops.${quoted(name)}) as full`);
    if (res.rows[0]?.full === true) full.push(name);
  }
  if (full.length > 0) {
    throw new ImportRefused(
      `these tables already hold rows: ${full.join(", ")}. The import loads only into empty tables and never deletes anything: ` +
        "start from an empty ops schema (the cutover runbook says how).",
    );
  }
}

/** After the inserts, before the commit: every table holds exactly the rows the load counted. */
export async function checkCounts(db: pg.Client, inserted: Readonly<Record<string, number>>): Promise<void> {
  const wrong: string[] = [];
  for (const [name, n] of Object.entries(inserted)) {
    const res = await db.query<{ n: number }>(`select count(*)::int as n from ops.${quoted(name)}`);
    if (res.rows[0]?.n !== n) wrong.push(name);
  }
  if (wrong.length > 0) throw new Error(`after the load, ${wrong.join(", ")} did not hold the rows the load counted; nothing was kept`);
}
