// The migration runner: applies ops/migrations/NNNN_name.sql in numeric order,
// each file in its own transaction, as the connection string's role (ops_owner).
// Node only (the `pg` driver over TCP); the Worker never imports this file.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

export interface MigrateOptions {
  /** Folder of NNNN_name.sql files. Defaults to ops/migrations. */
  dir?: string;
  /** Called with one line per applied file (the CLI prints them). */
  log?: (line: string) => void;
}

export interface MigrateResult {
  /** Names (without .sql) applied by this call, in order. Empty if up to date. */
  applied: string[];
}

interface MigrationFile {
  version: number;
  name: string;
  /** "0001_init" */
  id: string;
  sql: string;
  checksum: string;
}

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
// Any stable 63-bit key: one runner at a time per database.
const LOCK_KEY = "7020250001";

const sha256 = (text: Buffer): string => createHash("sha256").update(text).digest("hex");

/** Read and validate the folder: names, no duplicates, numbers 1..N with no gap. */
export function readMigrationFiles(dir: string): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const m = FILE_RE.exec(file);
    if (!m) throw new Error(`Migration file "${file}" is not named NNNN_name.sql (four digits, lower-case name).`);
    // A checkout on Windows has CRLF line ends (Git's default there). The SQL and its checksum are
    // those of the file with LF, so the same migration has the same checksum on every machine.
    const sql = readFileSync(join(dir, file)).toString("utf8").replace(/\r\n/g, "\n");
    files.push({
      version: Number(m[1]),
      name: m[2] as string,
      id: file.slice(0, -4),
      sql,
      checksum: sha256(Buffer.from(sql, "utf8")),
    });
  }
  files.sort((a, b) => a.version - b.version);
  files.forEach((f, i) => {
    const prev = files[i - 1];
    if (prev && prev.version === f.version) {
      throw new Error(`Duplicate migration number ${f.version}: ${prev.id}.sql and ${f.id}.sql.`);
    }
    const expected = i + 1;
    if (f.version !== expected) {
      throw new Error(
        `Gap in migration numbers: expected ${String(expected).padStart(4, "0")} but found ${f.id}.sql.`,
      );
    }
  });
  return files;
}

export async function migrate(connectionString: string, options: MigrateOptions = {}): Promise<MigrateResult> {
  const dir = options.dir ?? DEFAULT_MIGRATIONS_DIR;
  const log = options.log ?? (() => {});

  // Validate the folder before touching the database.
  const files = readMigrationFiles(dir);

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1::bigint)", [LOCK_KEY]);

    await client.query(`create table if not exists ops.schema_migrations (
      version     integer primary key,
      name        text not null,
      checksum    text not null,
      applied_at  timestamptz not null default now()
    )`);
    // The default privileges would let ops_app write this table; the runner is its only writer.
    await client.query(`do $g$ begin
      if exists (select 1 from pg_roles where rolname = 'ops_app') then
        revoke insert, update, delete on ops.schema_migrations from ops_app;
      end if;
      if exists (select 1 from pg_roles where rolname = 'ops_read') then
        revoke insert, update, delete on ops.schema_migrations from ops_read;
      end if;
    end $g$`);

    const applied = new Map<number, { name: string; checksum: string }>();
    const res = await client.query<{ version: number; name: string; checksum: string }>(
      "select version, name, checksum from ops.schema_migrations order by version",
    );
    for (const r of res.rows) applied.set(r.version, r);

    // Every applied migration must still be here, unchanged, before anything new runs.
    for (const [version, row] of applied) {
      const file = files.find((f) => f.version === version);
      const id = `${String(version).padStart(4, "0")}_${row.name}`;
      if (!file) {
        throw new Error(`Migration ${id} is recorded as applied but its file is missing from ${dir}.`);
      }
      if (file.name !== row.name) {
        throw new Error(`Migration ${String(version).padStart(4, "0")} was applied as "${row.name}" but the file is now "${file.name}".`);
      }
      if (file.checksum !== row.checksum) {
        throw new Error(
          `Migration ${file.id} was already applied but the file has changed (checksum differs). ` +
            `Never edit an applied migration; add a new numbered one.`,
        );
      }
    }

    const done: string[] = [];
    for (const file of files) {
      if (applied.has(file.version)) continue;
      try {
        await client.query("begin");
        await client.query(file.sql);
        await client.query("insert into ops.schema_migrations (version, name, checksum) values ($1, $2, $3)", [
          file.version,
          file.name,
          file.checksum,
        ]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${file.id} failed and was rolled back: ${msg}`, { cause: err });
      }
      done.push(file.id);
      log(`applied ${file.id}`);
    }
    return { applied: done };
  } finally {
    await client.end();
  }
}
