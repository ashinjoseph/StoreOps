// The reconcile tool (card P4-03), end to end: a workbook of the fictional fixture is written
// with the test .xlsx writer, exported with the real export tool, imported with the real import
// tool, and then reconciled by this one, as the ops_read role. Differences are planted in the
// database afterwards, as the owner role, one at a time; each must be reported and exit 1.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPS_ONLY_TABLES } from "../src/cutover/compare";
import { readContract } from "../src/import/load";
import type { SheetTab } from "../src/import/sheet-to-db";
import { exportWorkbook } from "../tools/export-sheet";
import { main as importMain } from "../tools/import";
import { main, parseArgs } from "../tools/reconcile-import";
import { superuserUrl, type TestDb, createTestDb } from "./helpers/db";
import { bootFixture, type BootedFixture } from "./helpers/fixture";
import { buildWorkbook, type WCell, type WSheet } from "./helpers/xlsx-write";

const PEPPER = "reconcile-test-pepper-0123456789";
const TOOL = fileURLToPath(new URL("../tools/reconcile-import.ts", import.meta.url));
const LOADER = fileURLToPath(new URL("../tools/ts-resolve.mjs", import.meta.url));
const OPS = fileURLToPath(new URL("..", import.meta.url));
const contract = readContract();
const SHEET_TABLES = Object.keys(contract.tables).filter((t) => !OPS_ONLY_TABLES.includes(t));
const SEQ_TABLES = ["audit_log", "payments", "sales", "cash_handovers", "commission_runs", "validation_results"];

const root = mkdtempSync(join(tmpdir(), "p403-"));
let counter = 0;
const fresh = (name: string): string => join(root, `${name}-${++counter}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

let boot: BootedFixture;
beforeAll(() => {
  boot = bootFixture();
}, 120_000);

// ── helpers (the same as import-tool.test.ts builds a world) ──

function asSheet(t: SheetTab): WSheet {
  const cell = (v: unknown): WCell => (v === "" || v === null || v === undefined ? undefined : (v as WCell));
  return { name: t.tab, hidden: t.tab.startsWith("_"), grid: [[`StoreOps ${t.tab}`], t.header.map(cell), ...t.rows.map((r) => r.map(cell))] };
}

/** Export these tabs (the real export tool, from a real workbook file) into a new directory. */
function exportTabs(tabs: SheetTab[]): string {
  const book = join(root, `book-${++counter}.xlsx`);
  writeFileSync(book, buildWorkbook({ sheets: tabs.map(asSheet) }));
  const dir = fresh("export");
  exportWorkbook(book, dir);
  return dir;
}

/** A copy of the fixture's tabs, changed by `edit`. */
function variant(edit: (tab: (name: string) => SheetTab, col: (name: string, column: string) => number) => void): SheetTab[] {
  const tabs: SheetTab[] = structuredClone(boot.tabs);
  const tab = (name: string): SheetTab => {
    const t = tabs.find((x) => x.tab === name);
    if (!t) throw new Error(`no tab ${name}`);
    return t;
  };
  const col = (name: string, column: string): number => {
    const at = tab(name).header.findIndex((h) => String(h).trim() === column);
    if (at < 0) throw new Error(`no column ${name}.${column}`);
    return at;
  };
  edit(tab, col);
  return tabs;
}

const dbs: TestDb[] = [];
async function newDb(): Promise<TestDb> {
  const d = await createTestDb();
  dbs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(dbs.map((d) => d.drop().catch(() => undefined)));
});

async function sql(url: string, text: string, params: unknown[] = []): Promise<Record<string, any>[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query(text, params)).rows as Record<string, any>[];
  } finally {
    await c.end();
  }
}

/** A copy of a database that nobody is connected to (a new database from it as a template). */
async function cloneDb(src: TestDb): Promise<TestDb> {
  const name = `ops_t_${Math.random().toString(16).slice(2, 14)}`;
  const admin = superuserUrl();
  for (let attempt = 0; ; attempt++) {
    try {
      await sql(admin, `create database "${name}" template "${src.name}"`);
      break;
    } catch (e) {
      if ((e as { code?: string }).code === "55006" && attempt < 50) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      throw e;
    }
  }
  const swap = (u: string): string => {
    const x = new URL(u);
    x.pathname = `/${name}`;
    return x.toString();
  };
  const d: TestDb = {
    name,
    ownerUrl: swap(src.ownerUrl),
    appUrl: swap(src.appUrl),
    readUrl: swap(src.readUrl),
    drop: () => sql(admin, `drop database if exists "${name}" with (force)`).then(() => undefined),
  };
  dbs.push(d);
  return d;
}

interface Imported {
  db: TestDb;
  dir: string;
  report: string;
  code: number;
  err: string;
}
/** Export `tabs`, import them into a new database with the real tool. */
async function importWorld(tabs: SheetTab[], args: string[] = [], dir: string = exportTabs(tabs)): Promise<Imported> {
  const db = await newDb();
  const report = fresh("import-report");
  const err: string[] = [];
  const code = await importMain([dir, ...args, "--report", report], { OPS_DB_APP_URL: db.appUrl, PIN_PEPPER: PEPPER }, { out: () => undefined, err: (l) => err.push(l) });
  return { db, dir, report, code, err: err.join("\n") };
}

interface Ran {
  code: number;
  out: string;
  err: string;
  outDir: string;
  json: () => Record<string, any>;
  md: () => string;
  all: () => string;
}
async function reconcile(db: { readUrl: string }, dir: string, report: string, args: string[] = [], env: Record<string, string | undefined> = {}): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const hasOut = args.includes("--out");
  const outDir = hasOut ? (args[args.indexOf("--out") + 1] as string) : fresh("reconcile");
  const code = await main(
    [dir, "--import-report", join(report, "import-report.json"), ...args, ...(hasOut ? [] : ["--out", outDir])],
    { OPS_DB_READ_URL: db.readUrl, ...env },
    { out: (l) => out.push(l), err: (l) => err.push(l) },
  );
  const files = (): string[] => (existsSync(outDir) ? readdirSync(outDir).map((f) => readFileSync(join(outDir, f), "utf8")) : []);
  return {
    code,
    out: out.join("\n"),
    err: err.join("\n"),
    outDir,
    json: () => JSON.parse(readFileSync(join(outDir, "reconcile-report.json"), "utf8")),
    md: () => readFileSync(join(outDir, "reconcile-report.md"), "utf8"),
    all: () => [out.join("\n"), err.join("\n"), ...files()].join("\n"),
  };
}

// ── The fixture, imported once; each test plants in a copy ───

let loaded: Imported;
beforeAll(async () => {
  loaded = await importWorld(boot.tabs);
  expect(loaded.code, loaded.err).toBe(0);
}, 180_000);

const sheetRow = (table: string, id: string): number => {
  const tab = boot.tabs.find((t) => t.tab === table) as SheetTab;
  const pk = contract.tables[table]!.columns.find((c) => c.primaryKey)!.name;
  const at = tab.header.findIndex((h) => String(h).trim() === pk);
  const i = tab.rows.findIndex((r) => String(r[at]).trim() === id);
  if (i < 0) throw new Error(`no ${table} row ${id}`);
  return i + 3;
};

type Json = { tables: { table: string; differences: { kind: string; row?: number; column?: string; message: string }[]; differenceCount: number }[]; otherDifferences: { kind: string; message: string }[]; unexplainedDifferences: number };
const diffsOf = (j: Json, table: string): Json["tables"][number]["differences"] => j.tables.find((t) => t.table === table)!.differences;

/** Plant `statements` (as the owner role) in a copy of the loaded fixture, reconcile, and return the run. */
async function planted(statements: string[] | ((db: TestDb) => Promise<void>)): Promise<{ r: Ran; j: Json; db: TestDb }> {
  const db = await cloneDb(loaded.db);
  if (typeof statements === "function") await statements(db);
  else for (const s of statements) await sql(db.ownerUrl, s);
  const r = await reconcile(db, loaded.dir, loaded.report);
  return { r, j: r.json() as Json, db };
}

// ── The card's done-when ─────────────────────────────────────

describe("the fictional fixture, taken through the real path and reconciled", () => {
  it("reports zero differences, exits 0, and the monthly totals are what plain SQL over the database says", async () => {
    const r = await reconcile(loaded.db, loaded.dir, loaded.report);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("RESULT: no unexplained difference.");
    const j = r.json() as Json & { tables: { table: string; dateColumn: string | null; sumColumns: string[]; months: { month: string; sheetRows: number; dbRows: number; columns: Record<string, { sheetSum: string; dbSum: string; diff: string; sheetBlank: number; dbBlank: number }> }[] }[] };
    expect(j.unexplainedDifferences).toBe(0);
    expect(j.tables.map((t) => t.table)).toEqual(expect.arrayContaining(SHEET_TABLES));
    let compared = 0;
    for (const t of j.tables) {
      expect(t.differenceCount, t.table).toBe(0);
      const table = contract.tables[t.table]!;
      const dateCol = t.dateColumn ? table.columns.find((c) => c.name === t.dateColumn) : undefined;
      const group = !dateCol ? "'all'" : dateCol.type === "date" ? `to_char("${dateCol.name}", 'YYYY-MM')` : `to_char("${dateCol.name}" at time zone 'America/Toronto', 'YYYY-MM')`;
      const noDate = dateCol ? `coalesce(${group}, 'no date')` : group;
      const columns = t.sumColumns.length > 0 ? t.sumColumns.map((c) => `sum("${c}")::text as "s_${c}"`).join(", ") + ", " : "";
      const rows = await sql(loaded.db.readUrl, `select ${noDate} as m, ${columns}count(*)::int as n from ops."${t.table}" group by 1 order by 1`);
      const byMonth = new Map(rows.map((x) => [x["m"] as string, x]));
      expect([...byMonth.keys()].sort(), t.table).toEqual(t.months.map((m) => m.month).sort());
      for (const m of t.months) {
        const x = byMonth.get(m.month)!;
        expect(m.dbRows, `${t.table} ${m.month}`).toBe(x["n"]);
        expect(m.sheetRows, `${t.table} ${m.month}`).toBe(x["n"]);
        for (const c of t.sumColumns) {
          const sqlSum = (x[`s_${c}`] as string | null) ?? (m.columns[c]!.dbSum.includes(".") ? `0.${"0".repeat(m.columns[c]!.dbSum.split(".")[1]!.length)}` : "0");
          expect(m.columns[c]!.dbSum, `${t.table}.${c} ${m.month}`).toBe(sqlSum);
          expect(m.columns[c]!.sheetSum, `${t.table}.${c} ${m.month}`).toBe(sqlSum);
          expect(m.columns[c]!.diff).toMatch(/^0(\.0+)?$/);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(150);
    // the tables only the new app has are counted, not compared; the checks are all ok
    expect((r.json() as { opsOnlyTables: { table: string }[] }).opsOnlyTables.map((o) => o.table).sort()).toEqual([...OPS_ONLY_TABLES].sort());
    expect((r.json() as { checks: { ok: boolean }[] }).checks.every((c) => c.ok)).toBe(true);
    // the four config secrets were not loaded, and the report lists them under "not loaded"
    expect(r.md()).toMatch(/Not loaded, per the import report[\s\S]*### config[\s\S]*4 left-out rows/);
    // the deprecated tabs
    expect((r.json() as { deprecatedTabs: unknown[] }).deprecatedTabs).toHaveLength(13);
  }, 120_000);

  it("names, per table, the date column it grouped by, the columns it compared and the ones it did not", async () => {
    const j = (await reconcile(loaded.db, loaded.dir, loaded.report)).json() as { tables: { table: string; dateColumn: string | null; comparedColumns: string[]; notCompared: { column: string; reason: string }[] }[] };
    const by = Object.fromEntries(j.tables.map((t) => [t.table, t]));
    expect(by["sales"]!.dateColumn).toBe("date");
    expect(by["payments"]!.dateColumn).toBe("paid_on");
    expect(by["cash_handovers"]!.dateColumn).toBe("handed_on");
    expect(by["audit_log"]!.dateColumn).toBe("timestamp");
    expect(by["config"]!.dateColumn).toBeNull();
    expect(by["sales"]!.comparedColumns).toEqual(expect.arrayContaining(["cash_sales", "credit_card_sales", "card_total_sales", "store_id"]));
    expect(by["staff"]!.notCompared.map((c) => c.column)).toEqual(expect.arrayContaining(["login_code", "pin_hash"]));
    expect(by["sales"]!.notCompared.map((c) => c.column)).toContain("seq");
    expect(by["payments"]!.notCompared.map((c) => c.column)).toEqual(expect.arrayContaining(["seq", "voided_at"]));
  });

  it("is read only, as ops_read: one repeatable-read read-only transaction, one select per table, and the role cannot write", async () => {
    const orig = pg.Client.prototype.query;
    const log: string[] = [];
    (pg.Client.prototype as unknown as { query: unknown }).query = function (this: pg.Client, ...a: unknown[]) {
      log.push(typeof a[0] === "string" ? a[0] : String((a[0] as { text?: string })?.text ?? ""));
      return (orig as (...x: unknown[]) => unknown).apply(this, a);
    };
    let r: Ran;
    try {
      r = await reconcile(loaded.db, loaded.dir, loaded.report);
    } finally {
      (pg.Client.prototype as unknown as { query: unknown }).query = orig;
    }
    expect(r.code).toBe(0);
    expect(log[0]).toBe("begin isolation level repeatable read read only");
    expect(log.at(-1)).toBe("rollback");
    expect(log.every((q) => /^(begin isolation level repeatable read read only|rollback|select )/.test(q.trim()))).toBe(true);
    for (const t of SHEET_TABLES) {
      const q = log.filter((x) => x.includes(`from ops."${t}"`));
      expect(q, t).toHaveLength(1);
      expect(q[0], t).toContain(SEQ_TABLES.includes(t) ? 'order by "seq"' : `order by "${contract.tables[t]!.columns.find((c) => c.primaryKey)!.name}"`);
    }
    expect(log.some((q) => /\b(insert|update|delete|truncate|drop|alter|create)\b/i.test(q.replace(/'[^']*'/g, "")))).toBe(false);
    // the role really is select-only
    await expect(sql(loaded.db.readUrl, "insert into ops.config (key, value) values ('x', 'y')")).rejects.toMatchObject({ code: "42501" });
    await expect(sql(loaded.db.readUrl, "update ops.sales set cash_sales = 0")).rejects.toMatchObject({ code: "42501" });
  });
});

// ── A planted difference is reported ─────────────────────────

describe("a one-cent change", () => {
  it("is named: table, Sheet row, key column, column and '1 cent'; the month's sum differs by 1 cent; exit 1", async () => {
    const sales = boot.tabs.find((t) => t.tab === "sales") as SheetTab;
    const idAt = sales.header.indexOf("sales_id");
    const id = String(sales.rows[4]![idAt]).trim();
    const month = (await sql(loaded.db.readUrl, `select to_char(date, 'YYYY-MM') as m from ops.sales where sales_id = $1`, [id]))[0]!["m"] as string;
    const { r, j } = await planted([`update ops.sales set cash_sales = cash_sales + 0.01 where sales_id = '${id}'`]);
    expect(r.code).toBe(1);
    const row = sheetRow("sales", id);
    expect(diffsOf(j, "sales").find((d) => d.kind === "value")).toMatchObject({ row, column: "cash_sales", message: "differs by 1 cent" });
    expect(diffsOf(j, "sales").find((d) => d.kind === "month_sum")!.message).toMatch(new RegExp(`^${month}: the sum of cash_sales differs by 1 cent`));
    expect(j.unexplainedDifferences).toBe(2);
    expect(r.md()).toMatch(new RegExp(`value \\(Sheet row ${row}, key column sales_id, column cash_sales\\): differs by 1 cent`));
    expect(r.out).toContain("RESULT: 2 unexplained differences.");
    expect(r.err).toMatch(/2 unexplained difference\(s\)/);
    // a row difference gives the size, not the figures
    expect(diffsOf(j, "sales").find((d) => d.kind === "value")!.message).not.toMatch(/\d\.\d/);
  });
});

describe("each of these, planted alone, is reported and exits 1", () => {
  const firstSale = (): string => String((boot.tabs.find((t) => t.tab === "sales") as SheetTab).rows[10]![0]);

  it("a row deleted from the database", async () => {
    const id = firstSale();
    const { r, j } = await planted([`delete from ops.sales where sales_id = '${id}'`]);
    expect(r.code).toBe(1);
    expect(diffsOf(j, "sales").map((d) => d.kind)).toEqual(expect.arrayContaining(["row_count", "missing_from_database", "month_rows", "month_sum"]));
    expect(diffsOf(j, "sales").find((d) => d.kind === "missing_from_database")).toMatchObject({ row: sheetRow("sales", id) });
  });

  it("an extra row inserted", async () => {
    const { r, j } = await planted(["insert into ops.config (key, value) values ('zz_extra_key', '1')"]);
    expect(r.code).toBe(1);
    expect(diffsOf(j, "config").map((d) => d.kind)).toEqual(expect.arrayContaining(["row_count", "extra_in_database"]));
    expect(diffsOf(j, "config").find((d) => d.kind === "extra_in_database")!.message).toMatch(/zz_extra_key/);
  });

  it("a blank turned into 0: the sum is unchanged; the blank count and the row comparison catch it", async () => {
    const id = firstSale();
    const { r, j } = await planted([`update ops.sales set round_off = 0 where sales_id = '${id}' and round_off is null`]);
    expect(r.code).toBe(1);
    const kinds = diffsOf(j, "sales").map((d) => d.kind);
    expect(kinds).toEqual(expect.arrayContaining(["value", "blank_count", "month_blank"]));
    expect(kinds).not.toContain("month_sum");
    expect(diffsOf(j, "sales").find((d) => d.kind === "value")).toMatchObject({ row: sheetRow("sales", id), column: "round_off" });
    expect(diffsOf(j, "sales").find((d) => d.kind === "blank_count")!.message).toMatch(/round_off: blank in 360 Sheet row\(s\) but NULL in 359 database row\(s\)/);
  });

  it("a 0 turned into NULL", async () => {
    const id = firstSale();
    const { r, j } = await planted([`update ops.sales set cashback_paid = null where sales_id = '${id}'`]);
    expect(r.code).toBe(1);
    expect(diffsOf(j, "sales").find((d) => d.kind === "value")).toMatchObject({ row: sheetRow("sales", id), column: "cashback_paid", message: expect.stringMatching(/the Sheet holds a figure, the database is blank/) });
    expect(diffsOf(j, "sales").map((d) => d.kind)).toContain("blank_count");
    expect(diffsOf(j, "sales").map((d) => d.kind)).not.toContain("month_sum");
  });

  it("a date moved by one day (both sides shown)", async () => {
    const id = firstSale();
    const was = (await sql(loaded.db.readUrl, `select to_char(date, 'YYYY-MM-DD') as d, to_char(date + 1, 'YYYY-MM-DD') as n from ops.sales where sales_id = $1`, [id]))[0]!;
    const { r, j } = await planted([`update ops.sales set date = date + 1 where sales_id = '${id}'`]);
    expect(r.code).toBe(1);
    expect(diffsOf(j, "sales").find((d) => d.kind === "value")).toMatchObject({ row: sheetRow("sales", id), column: "date", message: `Sheet ${was["d"]}, database ${was["n"]}` });
  });

  it("a timestamptz moved by one second", async () => {
    const att = boot.tabs.find((t) => t.tab === "attendance") as SheetTab;
    const id = String(att.rows[7]![att.header.indexOf("attendance_id")]).trim();
    const { r, j } = await planted([`update ops.attendance set actual_start = actual_start + interval '1 second' where attendance_id = '${id}' and actual_start is not null`]);
    expect(r.code).toBe(1);
    const d = diffsOf(j, "attendance").find((x) => x.kind === "value")!;
    expect(d).toMatchObject({ row: sheetRow("attendance", id), column: "actual_start" });
    expect(d.message).toMatch(/^Sheet \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z, database \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
    const [a, b] = d.message.match(/\d{4}-[0-9T:.-]+Z/g) as [string, string];
    expect(new Date(`${b.slice(0, 23)}Z`).getTime() - new Date(`${a.slice(0, 23)}Z`).getTime()).toBe(1000);
  });

  it("two rows' amounts swapped: every sum is unchanged", async () => {
    const pair = (await sql(loaded.db.readUrl, "select a.sales_id as x, b.sales_id as y from ops.sales a join ops.sales b on to_char(a.date, 'YYYY-MM') = to_char(b.date, 'YYYY-MM') and a.cash_sales <> b.cash_sales and a.sales_id < b.sales_id order by a.sales_id limit 1"))[0]!;
    const { r, j } = await planted([
      `update ops.sales a set cash_sales = b.cash_sales from ops.sales b where (a.sales_id = '${pair["x"]}' and b.sales_id = '${pair["y"]}') or (a.sales_id = '${pair["y"]}' and b.sales_id = '${pair["x"]}')`,
    ]);
    expect(r.code).toBe(1);
    const d = diffsOf(j, "sales");
    expect(d.map((x) => x.kind)).toEqual(["value", "value"]);
    expect(d.map((x) => x.row).sort()).toEqual([sheetRow("sales", pair["x"]), sheetRow("sales", pair["y"])].sort());
    expect(d.every((x) => x.column === "cash_sales" && /^differs by \d+ cents?$/.test(x.message))).toBe(true);
  });

  it("a text value changed: 'differs', and neither value is in any output", async () => {
    const staff = boot.tabs.find((t) => t.tab === "staff") as SheetTab;
    const id = String(staff.rows[1]![0]).trim();
    const was = String(staff.rows[1]![staff.header.indexOf("name")]);
    const { r, j } = await planted([`update ops.staff set name = 'Changedname-Planted' where staff_id = '${id}'`]);
    expect(r.code).toBe(1);
    expect(diffsOf(j, "staff").find((d) => d.kind === "value")).toMatchObject({ row: sheetRow("staff", id), column: "name", message: "differs" });
    expect(r.all()).not.toContain("Changedname-Planted");
    expect(r.all()).not.toContain(was);
  });

  it("an enum changed to another allowed word", async () => {
    const { r, j } = await planted(["update ops.bonuses set status = 'paid' where bonus_id = (select bonus_id from ops.bonuses where status = 'pending' order by bonus_id limit 1)"]);
    expect(r.code).toBe(1);
    const d = diffsOf(j, "bonuses").find((x) => x.kind === "value")!;
    expect(d).toMatchObject({ column: "status", message: "Sheet pending, database paid" });
  });

  it("two rows of a seq table swapped in order (recreated in the other order)", async () => {
    const { r, j } = await planted(async (db) => {
      const ids = (await sql(db.ownerUrl, "select validation_id as id from ops.validation_results order by seq desc limit 2")).map((x) => x["id"] as string); // the last two: [last, last but one]
      const cols = (await sql(db.ownerUrl, "select column_name as c from information_schema.columns where table_schema = 'ops' and table_name = 'validation_results' and column_name <> 'seq' order by ordinal_position")).map((x) => `"${x["c"]}"`).join(", ");
      const c = new pg.Client({ connectionString: db.ownerUrl });
      await c.connect();
      try {
        await c.query("begin");
        await c.query(`create temp table keep as select * from ops.validation_results where validation_id = any($1)`, [ids]);
        await c.query("delete from ops.validation_results where validation_id = any($1)", [ids]);
        for (const id of ids) await c.query(`insert into ops.validation_results (${cols}) select ${cols} from keep where validation_id = $1`, [id]);
        await c.query("commit");
      } finally {
        await c.end();
      }
    });
    expect(r.code).toBe(1);
    expect(diffsOf(j, "validation_results").map((d) => d.kind)).toEqual(["order"]);
    expect(diffsOf(j, "validation_results")[0]!.message).toMatch(/2 of 240 positions differ; first at position 239: the Sheet has row \d+ there, the database has row \d+/);
  });

  it("a secret key inserted into ops.config", async () => {
    const { r, j } = await planted(["insert into ops.config (key, value) values ('whatsapp_api_token', 'tok-planted-9911')"]);
    expect(r.code).toBe(1);
    expect(j.otherDifferences.find((d) => d.kind === "secret_config")!.message).toMatch(/whatsapp_api_token/);
    expect(r.all()).not.toContain("tok-planted-9911");
  });

  it("a pin_hash cleared", async () => {
    const staff = boot.tabs.find((t) => t.tab === "staff") as SheetTab;
    const id = String(staff.rows[2]![0]).trim();
    const { r, j } = await planted([`update ops.staff set pin_hash = null where staff_id = '${id}'`]);
    expect(r.code).toBe(1);
    expect(j.otherDifferences.find((d) => d.kind === "pin_hash")!.message).toBe(`staff row ${sheetRow("staff", id)}: the Sheet has a login code, but pin_hash is not set`);
    expect(r.out).toMatch(/FAIL pin_hash is set for exactly the people the import report says/);
  });

  it("a pin_hash replaced by the plain login code", async () => {
    const staff = boot.tabs.find((t) => t.tab === "staff") as SheetTab;
    const code = String(staff.rows[0]![staff.header.indexOf("login_code")]).trim();
    const id = String(staff.rows[0]![0]).trim();
    const { r, j } = await planted([`update ops.staff set pin_hash = '${code}' where staff_id = '${id}'`]);
    expect(r.code).toBe(1);
    expect(j.otherDifferences.find((d) => d.kind === "pin_hash")!.message).toMatch(/not in the form pbkdf2-sha256/);
    expect(r.all()).not.toContain(`'${code}'`);
  });

  it("a payment voided in the database", async () => {
    const { r, j } = await planted(["update ops.payments set voided_at = now(), voided_by = 'S_001' where payment_id = (select payment_id from ops.payments order by payment_id limit 1)"]);
    expect(r.code).toBe(1);
    expect(diffsOf(j, "payments").find((d) => d.kind === "database_only")!.message).toMatch(/1 payment\(s\) are voided in the database/);
  });

  it("a table the contract does not have", async () => {
    const { r, j } = await planted(["create table ops.shopping_list (x int)"]);
    expect(r.code).toBe(1);
    expect(j.otherDifferences.map((d) => d.message).join("\n")).toMatch(/deprecated tab shopping_list has a table/);
  });
});

// ── Explained, not differences ───────────────────────────────

describe("what the import report explains", () => {
  it("a workbook with one broken row: rejected, accepted with --accept-rejects 1; exit 0, and the row is listed with its money", async () => {
    const sales = boot.tabs.find((t) => t.tab === "sales") as SheetTab;
    const cashAt = sales.header.indexOf("cash_sales");
    const row = sales.rows[4]!;
    const tabs = variant((tab, col) => void (tab("sales").rows[4]![col("sales", "cash_sales")] = "n/a-BROKEN-77"));
    const w = await importWorld(tabs, ["--accept-rejects", "1"]);
    expect(w.code, w.err).toBe(0);
    const r = await reconcile(w.db, w.dir, w.report);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const j = r.json() as { tables: { table: string; notLoaded: { rejected: { row: number; columns: string[]; reasons: string[] }[]; sums: Record<string, string>; unreadableFigures: number }; rows: Record<string, number> }[]; explained: Record<string, number> };
    const t = j.tables.find((x) => x.table === "sales")!;
    expect(t.notLoaded.rejected).toEqual([{ row: 7, columns: ["cash_sales"], reasons: ["not a number"] }]);
    expect(t.notLoaded.unreadableFigures).toBe(1);
    const money = (name: string): string => {
      const v = row[sales.header.indexOf(name)];
      return typeof v === "number" ? v.toFixed(2) : "0.00";
    };
    for (const c of ["credit_card_sales", "debit_card_sales", "card_total_sales", "cashback_paid"]) expect(t.notLoaded.sums[c], c).toBe(money(c));
    expect(Number(money("credit_card_sales")) + Number(money("debit_card_sales")) + Number(money("card_total_sales"))).toBeGreaterThan(0); // it carries money
    expect(t.rows).toMatchObject({ withId: 360, inDatabase: 359, rejected: 1 });
    expect(r.md()).toMatch(/### sales[\s\S]*1 rejected row: row 7 \(cash_sales: not a number\)[\s\S]*The Sheet money in those rows: .*credit_card_sales/);
    expect(r.md()).toMatch(/1 unreadable|1 cell in those rows cannot be read as a figure/);
    expect(r.out).toMatch(/not loaded, per the import report: 1 rejected row, 4 left-out rows/);
    expect(r.all()).not.toContain("BROKEN-77");
    void cashAt;
  }, 120_000);

  it("a rejected payment takes its items with it: the explained rows are rows of two tables, and the rest reconciles", async () => {
    const tabs = variant((tab, col) => void (tab("payments").rows[1]![col("payments", "method")] = "Cheque"));
    const dry = await importWorld(tabs, ["--dry-run"]);
    const n = readFileSync(join(dry.report, "rejects.csv"), "utf8").trim().split("\n").length - 1;
    expect(n).toBeGreaterThan(1);
    const w = await importWorld(tabs, ["--accept-rejects", String(n)]);
    expect(w.code, w.err).toBe(0);
    const r = await reconcile(w.db, w.dir, w.report);
    expect(r.code, r.out).toBe(0);
    const j = r.json() as { tables: { table: string; rows: { rejected: number } }[] };
    expect(j.tables.find((t) => t.table === "payments")!.rows.rejected).toBe(1);
    expect(j.tables.find((t) => t.table === "payment_items")!.rows.rejected).toBe(n - 1);
  }, 120_000);

  it("the seeded placeholder rule left out, and the secret config keys: exit 0, listed", async () => {
    const tabs = variant((tab, col) => {
      const rules = tab("commission_rules");
      (rules.rows.find((r) => r[col("commission_rules", "rule_id")] === "CR_001") as unknown[])[col("commission_rules", "active")] = false;
      for (const r of tab("bonuses").rows) if (r[col("bonuses", "source_rule_id")] === "CR_001") r[col("bonuses", "source_rule_id")] = "";
    });
    const w = await importWorld(tabs);
    expect(w.code, w.err).toBe(0);
    const r = await reconcile(w.db, w.dir, w.report);
    expect(r.code, r.out).toBe(0);
    const j = r.json() as { tables: { table: string; notLoaded: { leftOut: { row: number; why: string }[] } }[] };
    expect(j.tables.find((t) => t.table === "commission_rules")!.notLoaded.leftOut).toEqual([{ row: 3, why: "placeholder CR_001" }]);
    expect(j.tables.find((t) => t.table === "config")!.notLoaded.leftOut.map((x) => x.why).sort()).toEqual(
      ["secret key clover_cstore_token", "secret key clover_vape_token", "secret key whatsapp_api_token", "secret key whatsapp_template_shopping_list"].sort(),
    );
  }, 120_000);

  it("three payment items sharing one id are re-keyed by the import, and match their three Sheet rows; a one-cent change on the third is found there", async () => {
    const tabs = variant((tab) => {
      const first = tab("payment_items").rows[0] as unknown[];
      tab("payment_items").rows.push([...first], [...first]);
    });
    const w = await importWorld(tabs);
    expect(w.code, w.err).toBe(0);
    const r = await reconcile(w.db, w.dir, w.report);
    expect(r.code, r.out).toBe(0);
    expect((r.json() as { tables: { table: string; rows: { reKeyed: number } }[] }).tables.find((t) => t.table === "payment_items")!.rows.reKeyed).toBe(2);
    expect(r.out).toMatch(/2 re-keyed ids/);
    const n = boot.tabs.find((t) => t.tab === "payment_items")!.rows.length;
    const original = String((boot.tabs.find((t) => t.tab === "payment_items")!.rows[0] as unknown[])[0]);
    const copy = await cloneDb(w.db);
    await sql(copy.ownerUrl, `update ops.payment_items set amount = amount + 0.01 where item_id = '${original}-d3'`);
    const bad = await reconcile(copy, w.dir, w.report);
    expect(bad.code).toBe(1);
    expect(diffsOf(bad.json() as Json, "payment_items").find((d) => d.kind === "value")).toMatchObject({ row: n + 4, column: "amount", message: "differs by 1 cent" });
  }, 120_000);

  it("an open till's closing zeros blanked by --open-sessions-blank are listed as done on purpose; the same database without the flag differs", async () => {
    const tabs = variant((tab, col) => {
      const open = tab("till_sessions").rows.find((r) => r[col("till_sessions", "status")] === "open") as unknown[];
      for (const c of ["closing_cash_counted", "cash_left_in_till", "cash_removed_at_close", "expected_cash", "closing_variance"]) open[col("till_sessions", c)] = 0;
    });
    const dir = exportTabs(tabs);
    const blank = await importWorld(tabs, ["--open-sessions-blank"], dir);
    expect(blank.code, blank.err).toBe(0);
    const ok = await reconcile(blank.db, dir, blank.report);
    expect(ok.code, ok.out).toBe(0);
    expect((ok.json() as { tables: { table: string; openBlanked: { rows: number } | null }[] }).tables.find((t) => t.table === "till_sessions")!.openBlanked).toMatchObject({ rows: 1 });
    expect(ok.md()).toMatch(/Open till rows blanked on purpose/);
    const plain = await importWorld(tabs, [], dir);
    expect((await reconcile(plain.db, dir, plain.report)).code).toBe(0);
    // the blanked database, but a report that says the flag was not given: the zeros are missing
    const wrong = JSON.parse(readFileSync(join(blank.report, "import-report.json"), "utf8"));
    wrong.rules.openSessions.flag = false;
    const wrongDir = fresh("wrong-report");
    mkdirSync(wrongDir);
    writeFileSync(join(wrongDir, "import-report.json"), JSON.stringify(wrong));
    writeFileSync(join(wrongDir, "rejects.csv"), readFileSync(join(blank.report, "rejects.csv")));
    const bad = await reconcile(blank.db, dir, wrongDir);
    expect(bad.code).toBe(1);
    expect(diffsOf(bad.json() as Json, "till_sessions").map((d) => d.column).filter(Boolean)).toContain("closing_cash_counted");
  }, 180_000);
});

// ── Inputs that do not check out ─────────────────────────────

describe("a tampered or mismatched input refuses", () => {
  async function refuses(dir: string, report: string, message: RegExp, db: { readUrl: string } = loaded.db): Promise<Ran> {
    const r = await reconcile(db, dir, report);
    expect(r.code, `${r.out}\n${r.err}`).toBe(1);
    expect(r.err).toMatch(message);
    expect(r.err).not.toMatch(/\n\s+at .*\.ts:\d+/);
    expect(existsSync(join(r.outDir, "reconcile-report.md"))).toBe(false);
    return r;
  }
  const copyExport = (): string => exportTabs(boot.tabs);

  it("an import report from a different export", async () => {
    const other = exportTabs(variant((tab, col) => void (tab("sales").rows[0]![col("sales", "cash_sales")] = 1.11)));
    await refuses(other, loaded.report, /this import report is not for this export, nothing was compared: the import report was made from a different workbook/);
  });

  it("a tab file edited after the export (the checksum is compared first)", async () => {
    const dir = copyExport();
    const file = join(dir, readdirSync(dir).find((f) => /sales/.test(f) && f !== "manifest.json") as string);
    writeFileSync(file, readFileSync(file, "utf8").replace(/\n\]/, "\n\n]"));
    await refuses(dir, loaded.report, /does not match its checksum in manifest\.json/);
  });

  it("an export directory that is missing a file, and one with no manifest", async () => {
    const dir = copyExport();
    rmSync(join(dir, readdirSync(dir).find((f) => /payments/.test(f) && !/items/.test(f)) as string));
    await refuses(dir, loaded.report, /missing 1 file/);
    const none = copyExport();
    rmSync(join(none, "manifest.json"));
    await refuses(none, loaded.report, /no manifest\.json/);
  });

  it("an import report of a dry run, and one of a run that was not committed", async () => {
    const dry = await importWorld(boot.tabs, ["--dry-run"], loaded.dir);
    await refuses(loaded.dir, dry.report, /is of a "dry-run" run, not a real import/);
    const broken = variant((tab, col) => void (tab("sales").rows[4]![col("sales", "cash_sales")] = "n/a"));
    const w = await importWorld(broken); // 1 reject, not accepted: rolled back
    expect(w.code).toBe(1);
    await refuses(w.dir, w.report, /was not committed/);
  });

  it("an import report with no rejects.csv beside it, an unreadable one, and one in another shape", async () => {
    const d1 = fresh("rep");
    mkdirSync(d1);
    writeFileSync(join(d1, "import-report.json"), readFileSync(join(loaded.report, "import-report.json")));
    await refuses(loaded.dir, d1, /cannot read rejects\.csv beside the import report/);
    const d2 = fresh("rep");
    mkdirSync(d2);
    writeFileSync(join(d2, "import-report.json"), "{not json");
    await refuses(loaded.dir, d2, /not valid JSON/);
    const d3 = fresh("rep");
    mkdirSync(d3);
    writeFileSync(join(d3, "import-report.json"), JSON.stringify({ format: "x" }));
    writeFileSync(join(d3, "rejects.csv"), "tab,row,column,reason\n");
    await refuses(loaded.dir, d3, /not in the shape tools\/import\.ts writes/);
    await refuses(loaded.dir, join(root, "nowhere"), /cannot read the import report/);
  });

  it("an import report edited to claim what is not so: a phantom reject, and wrong totals", async () => {
    const editReport = (edit: (j: any, csv: string) => string): string => {
      const d = fresh("rep");
      mkdirSync(d);
      const j = JSON.parse(readFileSync(join(loaded.report, "import-report.json"), "utf8"));
      const csv = edit(j, readFileSync(join(loaded.report, "rejects.csv"), "utf8"));
      writeFileSync(join(d, "import-report.json"), JSON.stringify(j));
      writeFileSync(join(d, "rejects.csv"), csv);
      return d;
    };
    // a reject for a Sheet row that does not exist (the totals are left alone, so only the row check can notice)
    const phantom = editReport((j, csv) => {
      j.rejects.count = 1;
      return `${csv}sales,9999,cash_sales,not a number\n`;
    });
    const r = await reconcile(loaded.db, loaded.dir, phantom);
    expect(r.code).toBe(1);
    expect(diffsOf(r.json() as Json, "sales").map((d) => d.message).join("\n")).toMatch(/lists a rejected row 9999, but the tab's rows end at 362/);
    // loaded counts that are not the database's
    const wrong = editReport((j, csv) => {
      j.tables.find((t: { table: string }) => t.table === "sales").loaded = 359;
      return csv;
    });
    const r2 = await reconcile(loaded.db, loaded.dir, wrong);
    expect(r2.code).toBe(1);
    expect(diffsOf(r2.json() as Json, "sales").map((d) => d.message).join("\n")).toMatch(/the import report says 359 loaded rows; this check finds 360/);
  });

  it("no OPS_DB_READ_URL is a usage error (exit 2); so is a bad argument; an output directory that is not empty or inside the export is refused", async () => {
    const out: string[] = [];
    const code = await main([loaded.dir, "--import-report", join(loaded.report, "import-report.json")], {}, { out: () => undefined, err: (l) => out.push(l) });
    expect(code).toBe(2);
    expect(out.join("\n")).toMatch(/OPS_DB_READ_URL is not set/);
    expect(typeof parseArgs([])).toBe("string");
    expect(typeof parseArgs(["d"])).toBe("string"); // no --import-report
    expect(typeof parseArgs(["d", "--import-report"])).toBe("string");
    expect(typeof parseArgs(["a", "b", "--import-report", "x"])).toBe("string");
    expect(typeof parseArgs(["d", "--import-report", "x", "--force"])).toBe("string");
    expect(parseArgs(["d", "--import-report", "x", "--out", "o"])).toEqual({ dir: "d", importReport: "x", out: "o" });
    expect(parseArgs(["d", "--import-report=x", "--out=o"])).toEqual({ dir: "d", importReport: "x", out: "o" });
    const full = fresh("full");
    mkdirSync(full);
    writeFileSync(join(full, "x"), "x");
    await refuses2(["--out", full], /is not empty: a report is never overwritten/);
    await refuses2(["--out", join(loaded.dir, "inside")], /inside the export directory/);
    async function refuses2(extra: string[], message: RegExp): Promise<void> {
      const r = await reconcile(loaded.db, loaded.dir, loaded.report, extra);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(message);
    }
  });

  it("a database that cannot be reached: exit 1, and neither the URL nor its password is printed", async () => {
    const r = await reconcile({ readUrl: "postgres://ops_read:Secret-PW-4242@127.0.0.1:1/nodb" }, loaded.dir, loaded.report);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/could not use the database connection/);
    expect(r.all()).not.toMatch(/Secret-PW-4242|127\.0\.0\.1|nodb/);
  });

  it("a database with no migrations: the missing tables are differences", async () => {
    const empty = await newDb();
    await sql(empty.ownerUrl, "drop table ops.bonuses cascade");
    const r = await reconcile(empty, loaded.dir, loaded.report);
    expect(r.code).toBe(1);
    expect(diffsOf(r.json() as Json, "bonuses").map((d) => d.message).join("\n")).toMatch(/the database has no table bonuses/);
  });

  it("the database is the empty one: every table says its rows are missing, and exit is 1", async () => {
    const empty = await newDb();
    const r = await reconcile(empty, loaded.dir, loaded.report);
    expect(r.code).toBe(1);
    expect((r.json() as Json).tables.find((t) => t.table === "sales")!.differenceCount).toBeGreaterThanOrEqual(360);
    expect(diffsOf(r.json() as Json, "sales")).toHaveLength(50); // listed: capped
    expect(r.md()).toMatch(/\.\.\. and \d+ more \(not listed\)/);
    expect(r.out).toMatch(/RESULT: \d+ unexplained differences\./);
  });
});

// ── Nothing personal is printed or written ───────────────────

describe("no planted personal value appears in the output or in either file", () => {
  const NAME = "Zelda Plantedname";
  const NAME2 = "Zelda Changedname";
  const RATE = "87654.321";
  const RATE2 = "87654.3211";
  const PIN = "40937";
  const PHONE = "+1-416-555-0199";
  const PHONE2 = "+1-416-555-0100";
  const NOTE = "Plantednote-xyz-77";
  const NOTE2 = "Plantednote-CHANGED-88";
  const SALEHINT = "7654321.99";

  it("not on a clean run, not on a run full of differences, not on a refusal", async () => {
    const tabs = variant((tab, col) => {
      const staff = tab("staff");
      staff.rows[0]![col("staff", "name")] = NAME;
      staff.rows[0]![col("staff", "hourly_rate")] = Number(RATE);
      staff.rows[0]![col("staff", "login_code")] = PIN;
      staff.rows[0]![col("staff", "notes")] = NOTE;
      const config = tab("config");
      const keyAt = col("config", "key");
      const valueAt = col("config", "value");
      const row = config.rows.find((r) => r[keyAt] === "whatsapp_target_number");
      if (row) row[valueAt] = PHONE;
      else config.rows.push(["whatsapp_target_number", PHONE, ""]);
    });
    const w = await importWorld(tabs);
    expect(w.code, w.err).toBe(0);
    const clean = await reconcile(w.db, w.dir, w.report);
    expect(clean.code, clean.out).toBe(0);
    const copy = await cloneDb(w.db);
    const id = String(tabs.find((t) => t.tab === "staff")!.rows[0]![0]).trim();
    await sql(copy.ownerUrl, `update ops.staff set name = '${NAME2}', hourly_rate = ${RATE2}, notes = '${NOTE2}' where staff_id = '${id}'`);
    await sql(copy.ownerUrl, `update ops.config set value = '${PHONE2}' where key = 'whatsapp_target_number'`);
    await sql(copy.ownerUrl, "update ops.sales set cash_sales = 7654321.99 where sales_id = (select sales_id from ops.sales order by sales_id limit 1)");
    const dirty = await reconcile(copy, w.dir, w.report);
    expect(dirty.code).toBe(1);
    const j = dirty.json() as Json;
    for (const [table, column] of [["staff", "name"], ["staff", "hourly_rate"], ["staff", "notes"], ["config", "value"]] as const) {
      expect(diffsOf(j, table).find((d) => d.column === column && d.kind === "value")?.message, `${table}.${column}`).toBe("differs");
    }
    const refused = await reconcile(copy, loaded.dir, w.report); // another export: refused
    expect(refused.code).toBe(1);
    const unreachable = await reconcile({ readUrl: "postgres://ops_read:pw@127.0.0.1:1/x" }, w.dir, w.report);
    const text = [clean.all(), dirty.all(), refused.all(), unreachable.all()].join("\n");
    for (const planted of [NAME, NAME2, "Plantedname", "Changedname", RATE, RATE2, "87654", PIN, PHONE, PHONE2, "555-0199", NOTE, NOTE2, "Plantednote", SALEHINT, PEPPER, "local-only-read", "tester-pw", copy.name, "127.0.0.1"]) {
      expect(text, planted).not.toContain(planted);
    }
    // what it does say: the money sums per month, and that a text differs
    expect(text).toMatch(/\| 2026-\d\d \| \d+ \| \d+ \| cash_sales \| \d+\.\d\d \| \d+\.\d\d \| /);
    expect(text).toMatch(/differs by \d+ cents/); // a money difference is a size, not a figure
  }, 180_000);
});

// ── Independence ─────────────────────────────────────────────

describe("the comparison does not use the importer's translation", () => {
  const FILES = ["../src/cutover/compare.ts", "../src/cutover/read-db.ts"];
  const importStatements = (text: string): { names: string; from: string; isType: boolean }[] =>
    [...text.matchAll(/^import\s+(type\s+)?([\s\S]*?)\s+from\s+"([^"]+)";/gm)].map((m) => ({ isType: m[1] !== undefined, names: m[2] as string, from: m[3] as string }));

  it("compare.ts and read-db.ts import no translation: not translateTab, translateCell, loadTabs, nor anything from rules.ts", () => {
    for (const f of FILES) {
      const text = readFileSync(new URL(f, import.meta.url), "utf8");
      const imports = importStatements(text);
      expect(imports.length, f).toBeGreaterThan(0);
      for (const i of imports) {
        for (const banned of ["translateTab", "translateCell", "loadTabs", "numberCell", "dateCell", "textCell", "instantCell", "configKeyLeftOut", "readContract", "parseContract"]) {
          expect(i.names, `${f} imports ${banned}`).not.toMatch(new RegExp(`\\b${banned}\\b`));
        }
        expect(i.from, f).not.toMatch(/import\/(rules|load|run|report|database-checks|export-dir)/);
        expect(i.from, f).not.toMatch(/(^|\/)rules$/);
        // from src/import: the contract's TYPES, and nothing else
        if (i.from.includes("/import/")) {
          expect(i.from, f).toBe("../import/sheet-to-db");
          expect(i.isType, `${f}: ${i.from} must be a type-only import`).toBe(true);
        }
      }
      // and the identifiers are not used in code either (comments aside)
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/\b(translateTab|translateCell|loadTabs|configKeyLeftOut|numberCell|textCell)\b/);
    }
  });

  it("the tool takes from src/import only the reading of the export directory and the contract's reader", () => {
    const text = readFileSync(new URL("../tools/reconcile-import.ts", import.meta.url), "utf8");
    const from = importStatements(text).map((i) => i.from).filter((f) => f.includes("/import/")).sort();
    expect(from).toEqual(["../src/import/errors.ts", "../src/import/export-dir.ts", "../src/import/load.ts"]);
    const load = importStatements(text).find((i) => i.from.endsWith("load.ts"))!;
    expect(load.names.replace(/[{}\s]/g, "")).toBe("readContract");
  });
});

// ── The command, run as a process ────────────────────────────

describe("the command, run as a process", () => {
  function cli(args: string[], env: Record<string, string | undefined>) {
    const r = spawnSync(process.execPath, ["--import", LOADER, "--experimental-strip-types", "--no-warnings", TOOL, ...args], {
      cwd: OPS,
      encoding: "utf8",
      env: { PATH: process.env["PATH"], ...env } as NodeJS.ProcessEnv,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  it("package.json has the one script line", () => {
    const pkg = JSON.parse(readFileSync(join(OPS, "package.json"), "utf8"));
    expect(pkg.scripts["reconcile:import"]).toBe("node --import ./tools/ts-resolve.mjs --experimental-strip-types tools/reconcile-import.ts");
  });

  it("prints usage and exits 2 with no arguments, and exits 2 with no database URL", () => {
    const a = cli([], {});
    expect(a.code).toBe(2);
    expect(a.err).toMatch(/usage: npm --prefix ops run reconcile:import/);
    const b = cli([loaded.dir, "--import-report", join(loaded.report, "import-report.json")], {});
    expect(b.code).toBe(2);
    expect(b.err).toMatch(/OPS_DB_READ_URL is not set/);
  });

  it("runs end to end with only OPS_DB_READ_URL in its environment: exit 0 on the fixture, exit 1 with a cent planted, the URL never printed", async () => {
    const out = fresh("cli-out");
    const ok = cli([loaded.dir, "--import-report", join(loaded.report, "import-report.json"), "--out", out], { OPS_DB_READ_URL: loaded.db.readUrl });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toMatch(/table\s+tab rows\s+in db\s+rejected\s+left out\s+differences/);
    expect(ok.out).toMatch(/sales\s+360\s+360\s+0\s+0\s+0/);
    expect(ok.out).toContain("RESULT: no unexplained difference.");
    expect(readdirSync(out).sort()).toEqual(["reconcile-report.json", "reconcile-report.md"]);
    const copy = await cloneDb(loaded.db);
    await sql(copy.ownerUrl, "update ops.sales set cash_sales = cash_sales + 0.01 where sales_id = (select sales_id from ops.sales order by sales_id limit 1)");
    const bad = cli([loaded.dir, "--import-report", join(loaded.report, "import-report.json"), "--out", fresh("cli-out")], { OPS_DB_READ_URL: copy.readUrl });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("RESULT: 2 unexplained differences.");
    for (const secret of [loaded.db.readUrl, "local-only-read", "127.0.0.1"]) expect(`${ok.out}${ok.err}${bad.out}${bad.err}`).not.toContain(secret);
  }, 120_000);
});
