import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LATER_OPS_TABLES } from "../src/cutover/compare";
import { DEFAULT_MIGRATIONS_DIR, migrate, readMigrationFiles } from "../src/db/migrate";
import { createEmptyDb, createTestDb, type TestDb } from "./helpers/db";

const CONTRACT = new URL("../contracts/schema.sql", import.meta.url);
const MIGRATIONS = new URL("../migrations/", import.meta.url);

const contractTables = [...readFileSync(CONTRACT, "utf8").matchAll(/^create table ops\.(\w+)/gm)]
  .map((m) => m[1] as string)
  .sort();

async function rows<T extends pg.QueryResultRow>(url: string, sql: string): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(sql)).rows;
  } finally {
    await c.end();
  }
}

const tablesIn = async (url: string) =>
  (
    await rows<{ t: string }>(
      url,
      "select table_name as t from information_schema.tables where table_schema = 'ops' order by 1",
    )
  ).map((r) => r.t);

function tempMigrations(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ops-mig-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
const init = readFileSync(new URL("0001_init.sql", MIGRATIONS), "utf8");
// The real migrations, however many there are by now: these tests must not
// need editing each time a card adds one.
const REAL = readMigrationFiles(DEFAULT_MIGRATIONS_DIR);
const REAL_IDS = REAL.map((f) => f.id);
const realFiles = (): Record<string, string> => Object.fromEntries(REAL.map((f) => [`${f.id}.sql`, f.sql]));
const nextNumber = String(REAL.length + 1).padStart(4, "0");

describe("migration files", () => {
  it("0001_init.sql is byte-for-byte the frozen contract", () => {
    expect(readFileSync(new URL("0001_init.sql", MIGRATIONS)).equals(readFileSync(CONTRACT))).toBe(true);
  });
  it("every file in ops/migrations is named NNNN_name.sql", () => {
    for (const f of readdirSync(MIGRATIONS)) expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });
});

describe("migrate()", () => {
  const dbs: TestDb[] = [];
  const dirs: string[] = [];
  const fresh = async () => {
    const db = await createEmptyDb();
    dbs.push(db);
    return db;
  };
  const dir = (files: Record<string, string>) => {
    const d = tempMigrations(files);
    dirs.push(d);
    return d;
  };
  afterAll(async () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    for (const db of dbs) await db.drop();
  });

  it("an empty database gets every contract table and one schema_migrations row per migration", async () => {
    const db = await fresh();
    const result = await migrate(db.ownerUrl);
    expect(result.applied).toEqual(REAL_IDS);
    expect(REAL_IDS[0]).toBe("0001_init");
    const tables = (await tablesIn(db.ownerUrl)).filter((t) => t !== "schema_migrations");
    // The contract's tables, plus the Operations-only tables later migrations add (and the cutover tools skip).
    expect(tables).toEqual([...contractTables, ...LATER_OPS_TABLES].sort());
    expect(contractTables.length).toBeGreaterThan(15);
    const recorded = await rows<{ version: number; name: string; checksum: string; applied_at: Date }>(
      db.ownerUrl,
      "select version, name, checksum, applied_at from ops.schema_migrations order by version",
    );
    expect(recorded).toHaveLength(REAL.length);
    expect(recorded[0]).toMatchObject({ version: 1, name: "init" });
    expect(recorded[0]!.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded[0]!.applied_at).toBeInstanceOf(Date);
  });

  it("a second run changes nothing and reports nothing applied", async () => {
    const db = await fresh();
    await migrate(db.ownerUrl);
    const before = await rows(db.ownerUrl, "select * from ops.schema_migrations");
    const again = await migrate(db.ownerUrl);
    expect(again.applied).toEqual([]);
    expect(await rows(db.ownerUrl, "select * from ops.schema_migrations")).toEqual(before);
  });

  it("a second file applies after the first, in order", async () => {
    const db = await fresh();
    const d = dir({
      "0001_init.sql": init,
      "0002_extra.sql": "create table ops.extra_a (id int primary key);",
      "0003_more.sql": "create table ops.extra_b (id int references ops.extra_a (id));",
    });
    const first = await migrate(db.ownerUrl, { dir: d });
    expect(first.applied).toEqual(["0001_init", "0002_extra", "0003_more"]);
    const again = await migrate(db.ownerUrl, { dir: d });
    expect(again.applied).toEqual([]);
    const v = await rows<{ version: number }>(db.ownerUrl, "select version from ops.schema_migrations order by applied_at, version");
    expect(v.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(await tablesIn(db.ownerUrl)).toEqual(expect.arrayContaining(["extra_a", "extra_b"]));
  });

  it("applies only the new file when one is added later", async () => {
    const db = await fresh();
    await migrate(db.ownerUrl);
    const d = dir({ ...realFiles(), [`${nextNumber}_extra.sql`]: "create table ops.later (id int);" });
    expect((await migrate(db.ownerUrl, { dir: d })).applied).toEqual([`${nextNumber}_extra`]);
  });

  it("a failing statement rolls the whole file back and leaves the first applied", async () => {
    const db = await fresh();
    const d = dir({
      "0001_init.sql": init,
      "0002_bad.sql": "create table ops.half_done (id int);\ninsert into ops.nope values (1);",
    });
    await expect(migrate(db.ownerUrl, { dir: d })).rejects.toThrow(/0002_bad/);
    expect(await tablesIn(db.ownerUrl)).not.toContain("half_done");
    const v = await rows<{ version: number }>(db.ownerUrl, "select version from ops.schema_migrations");
    expect(v.map((r) => r.version)).toEqual([1]);
  });

  it("refuses an applied file that was edited", async () => {
    const db = await fresh();
    const d = dir({ "0001_init.sql": init, "0002_extra.sql": "create table ops.e1 (id int);" });
    await migrate(db.ownerUrl, { dir: d });
    writeFileSync(join(d, "0002_extra.sql"), "create table ops.e1 (id int, sneaky int);");
    writeFileSync(join(d, "0003_next.sql"), "create table ops.e3 (id int);");
    await expect(migrate(db.ownerUrl, { dir: d })).rejects.toThrow(/0002_extra.*(changed|edited|checksum)/i);
    // nothing after the edited file ran
    expect(await tablesIn(db.ownerUrl)).not.toContain("e3");
  });

  it("refuses a gap in the numbers", async () => {
    const db = await fresh();
    const d = dir({ "0001_init.sql": init, "0003_skip.sql": "select 1;" });
    await expect(migrate(db.ownerUrl, { dir: d })).rejects.toThrow(/gap|missing|0002/i);
    expect(await tablesIn(db.ownerUrl)).toEqual([]);
  });

  it("refuses a duplicate number", async () => {
    const db = await fresh();
    const d = dir({ "0001_init.sql": init, "0002_a.sql": "select 1;", "0002_b.sql": "select 2;" });
    await expect(migrate(db.ownerUrl, { dir: d })).rejects.toThrow(/duplicate/i);
    expect(await tablesIn(db.ownerUrl)).toEqual([]);
  });

  it("refuses when an applied migration's file has disappeared", async () => {
    const db = await fresh();
    await migrate(db.ownerUrl);
    const d = dir({});
    await expect(migrate(db.ownerUrl, { dir: d })).rejects.toThrow(/0001/);
  });
});

describe("test databases", () => {
  let a: TestDb;
  let b: TestDb;
  beforeAll(async () => {
    a = await createTestDb();
    b = await createTestDb();
  });
  afterAll(async () => {
    await a?.drop();
    await b?.drop();
  });

  it("start migrated, with one schema_migrations row per migration", async () => {
    const r = await rows<{ n: string }>(a.readUrl, "select count(*) as n from ops.schema_migrations");
    expect(r[0]!.n).toBe(String(REAL.length));
  });

  it("don't see each other's rows", async () => {
    await rows(
      a.appUrl,
      "insert into ops.staff (staff_id, name, active, role) values ('only-in-a', 'Fictional A', true, 'employee')",
    );
    const inA = await rows(a.readUrl, "select 1 from ops.staff where staff_id = 'only-in-a'");
    const inB = await rows(b.readUrl, "select 1 from ops.staff where staff_id = 'only-in-a'");
    expect(inA).toHaveLength(1);
    expect(inB).toHaveLength(0);
  });
});

// Found on the owner's first dry run (Nov 27): Git on Windows checks files out with CRLF line
// ends. A checksum over the file's bytes would then differ between a Windows checkout and the
// deploy's, and the same migration would look "changed".
describe("a migration's checksum does not depend on the checkout's line endings", () => {
  it("the same file with CRLF gives the same checksum and the same SQL text", () => {
    const d = mkdtempSync(join(tmpdir(), "ops-mig-eol-"));
    const unix = "-- a migration\ncreate table ops.e (id int);\n";
    writeFileSync(join(d, "0001_a.sql"), unix);
    const a = readMigrationFiles(d)[0]!;
    writeFileSync(join(d, "0001_a.sql"), unix.replace(/\n/g, "\r\n"));
    const b = readMigrationFiles(d)[0]!;
    expect(b.checksum).toBe(a.checksum);
    expect(b.sql).toBe(unix);
    // A real change is still a change.
    writeFileSync(join(d, "0001_a.sql"), unix.replace("int", "bigint"));
    expect(readMigrationFiles(d)[0]!.checksum).not.toBe(a.checksum);
  });
  it("the real migrations keep the checksums they had (files with LF are read as they are)", () => {
    for (const f of REAL) expect(f.sql.includes("\r")).toBe(false);
  });
});
