// The import tool (card P4-02), end to end: a workbook of the fictional fixture is written
// with the test .xlsx writer, exported with the real export tool, and imported with this one.
// Every guard has a test that shows it refusing and the database untouched.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPin } from "../src/auth/pin";
import { MANIFEST_FORMAT } from "../src/import/export-dir";
import { readContract } from "../src/import/load";
import type { SheetTab } from "../src/import/sheet-to-db";
import { exportWorkbook, MANIFEST_FORMAT as EXPORT_MANIFEST_FORMAT } from "../tools/export-sheet";
import { main, parseArgs } from "../tools/import";
import { createTestDb, type TestDb } from "./helpers/db";
import { bootFixture, loadFixture, type BootedFixture } from "./helpers/fixture";
import { buildWorkbook, type WCell, type WSheet } from "./helpers/xlsx-write";

const PEPPER = "tool-test-pepper-0123456789";
const TOOL = fileURLToPath(new URL("../tools/import.ts", import.meta.url));
const LOADER = fileURLToPath(new URL("../tools/ts-resolve.mjs", import.meta.url));
const OPS = fileURLToPath(new URL("..", import.meta.url));
const contract = readContract();
const ALL_TABLES = Object.keys(contract.tables);

const root = mkdtempSync(join(tmpdir(), "p402-"));
let counter = 0;
const fresh = (name: string): string => join(root, `${name}-${++counter}`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

let boot: BootedFixture;
beforeAll(() => {
  boot = bootFixture();
}, 120_000);

// ── helpers ──────────────────────────────────────────────────

/** A fixture tab as a worksheet: banner row, header row, rows; a blank is a missing cell. */
function asSheet(t: SheetTab): WSheet {
  const cell = (v: unknown): WCell => (v === "" || v === null || v === undefined ? undefined : (v as WCell));
  return { name: t.tab, hidden: t.tab.startsWith("_"), grid: [[`StoreOps ${t.tab}`], t.header.map(cell), ...t.rows.map((r) => r.map(cell))] };
}

/** Export these tabs (the real export tool, from a real workbook file) into a new directory. */
function exportTabs(tabs: SheetTab[], extra: WSheet[] = []): string {
  const book = join(root, `book-${++counter}.xlsx`);
  writeFileSync(book, buildWorkbook({ sheets: [...tabs.map(asSheet), ...extra] }));
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

let fixtureExport: string;
const fixtureDir = (): string => (fixtureExport ??= exportTabs(boot.tabs));

interface Ran {
  code: number;
  out: string;
  err: string;
  report: string;
  json: () => Record<string, any>;
  rejectsCsv: () => string;
}
async function run(db: TestDb, dir: string, args: string[] = [], env: Record<string, string | undefined> = {}): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const hasReport = args.includes("--report");
  const report = hasReport ? (args[args.indexOf("--report") + 1] as string) : fresh("report");
  const code = await main([dir, ...args, ...(hasReport ? [] : ["--report", report])], { OPS_DB_APP_URL: db.appUrl, PIN_PEPPER: PEPPER, ...env }, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return {
    code,
    out: out.join("\n"),
    err: err.join("\n"),
    report,
    json: () => JSON.parse(readFileSync(join(report, "import-report.json"), "utf8")),
    rejectsCsv: () => readFileSync(join(report, "rejects.csv"), "utf8"),
  };
}

const dbs: TestDb[] = [];
async function newDb(): Promise<TestDb> {
  const d = await createTestDb();
  dbs.push(d);
  return d;
}
afterAll(async () => {
  await Promise.all(dbs.map((d) => d.drop()));
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
const count = async (db: TestDb, table: string): Promise<number> => ((await sql(db.appUrl, `select count(*)::int as n from ops."${table}"`))[0] as { n: number }).n;
async function isEmpty(db: TestDb): Promise<boolean> {
  for (const t of ALL_TABLES) if (t !== "stores" && (await count(db, t)) !== 0) return false;
  return true;
}
/** Every table, every row, as text; the same rows give the same dump. `pin_hash` is left out when asked. */
async function dump(db: TestDb, withoutPin = false): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of ALL_TABLES) {
    const minus = withoutPin && t === "staff" ? " - 'pin_hash'" : "";
    const r = await sql(db.appUrl, `select (to_jsonb(x)${minus})::text as j from ops."${t}" x`);
    out[t] = r.map((x) => x["j"] as string).sort();
  }
  return out;
}

// ── The card's done-when ─────────────────────────────────────

describe("the fictional fixture, exported through the real path and imported", () => {
  it("imports with zero rejects, and the database equals what loadFixture produces directly (PIN hashes apart)", async () => {
    const direct = await newDb();
    await loadFixture(direct, boot);
    const db = await newDb();
    const r = await run(db, fixtureDir());
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("committed.");
    const report = r.json();
    expect(report.rejects.count).toBe(0);
    expect(report.outcome).toBe("committed");
    expect(r.rejectsCsv()).toBe("tab,row,column,reason\n");

    const a = await dump(direct, true);
    const b = await dump(db, true);
    expect(b).toEqual(a);
    const total = Object.values(b).reduce((n, rows) => n + rows.length, 0);
    expect(total).toBeGreaterThan(1500);
    // the report's loaded counts are the database's
    for (const t of report.tables) expect(t.loaded, t.table).toBe(await count(db, t.table));
    expect(report.totals.loaded + report.totals.leftOut + report.totals.blankKey).toBe(report.totals.tabRows);

    // row order: `seq` numbers the rows as the Sheet had them (the tab's own order, not the ids' order)
    for (const [table, pk] of [["audit_log", "log_id"], ["payments", "payment_id"], ["sales", "sales_id"], ["cash_handovers", "handover_id"], ["commission_runs", "run_id"], ["validation_results", "validation_id"]] as const) {
      const tab = boot.tabs.find((t) => t.tab === table) as SheetTab;
      const at = tab.header.indexOf(pk);
      const inSheet = tab.rows.map((r) => String(r[at]).trim()).filter((k) => k !== "");
      const inDb = (await sql(db.appUrl, `select "${pk}" as k from ops.${table} order by seq`)).map((x) => x["k"]);
      expect(inDb, table).toEqual(inSheet);
      expect(inSheet.length, table).toBeGreaterThan(2);
    }

    // pin_hash: NULL when loaded directly; here each fixture person's own code verifies, no other does
    const staffTab = boot.tabs.find((t) => t.tab === "staff") as SheetTab;
    const idAt = staffTab.header.indexOf("staff_id");
    const codeAt = staffTab.header.indexOf("login_code");
    const hashes = await sql(db.appUrl, "select staff_id, pin_hash from ops.staff");
    expect(hashes).toHaveLength(staffTab.rows.length);
    let verified = 0;
    for (const row of staffTab.rows) {
      const h = hashes.find((x) => x["staff_id"] === String(row[idAt]).trim());
      const code = String(row[codeAt]).trim();
      expect(h?.["pin_hash"], "a hash").toMatch(/^pbkdf2-sha256\$/);
      expect(await verifyPin(code, h?.["pin_hash"], PEPPER)).toBe(true);
      expect(await verifyPin(`${code}0`, h?.["pin_hash"], PEPPER)).toBe(false);
      verified++;
    }
    expect(verified).toBeGreaterThanOrEqual(5);
    expect((await sql(direct.appUrl, "select count(*)::int as n from ops.staff where pin_hash is not null"))[0]?.["n"]).toBe(0);
  }, 180_000);

  it("skips the deprecated tabs, with their row counts, and they are not rejects", async () => {
    const db = await newDb();
    const r = await run(db, fixtureDir());
    const report = r.json();
    const skipped = Object.fromEntries(report.skippedTabs.map((s: { tab: string; rows: number }) => [s.tab, s.rows]));
    expect(skipped["suppliers"]).toBe(3);
    expect(skipped["product_master"]).toBe(14);
    expect(skipped["product_vape_detail"]).toBe(8);
    expect(skipped["shopping_list"]).toBe(6);
    expect(Object.keys(skipped).sort()).toEqual([...contract.leftTabs.keys()].sort());
    expect(r.out).toContain("suppliers: 3 rows");
    expect(r.rejectsCsv()).toBe("tab,row,column,reason\n");
  });

  it("reports the rules, the time zone, and that voided payments do not exist in the Sheet", async () => {
    const db = await newDb();
    const report = (await run(db, fixtureDir())).json();
    expect(report.format).toBe("storeops-import-report/1");
    expect(report.timeZone).toEqual({ export: "America/Toronto", businessDates: "America/Toronto" });
    expect(report.notes.join(" ")).toMatch(/Voided payments do not exist in the Sheet/);
    expect(report.export.tabs).toHaveLength(boot.tabs.length);
    expect(report.export.tabs[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.export.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.rules.configKeysLeftOut.map((k: { key: string }) => k.key)).toEqual(expect.arrayContaining(["whatsapp_api_token", "clover_cstore_token", "clover_vape_token"]));
    expect(report.rules.pins.hashed).toBe(5);
    expect(report.rules.openSessions).toMatchObject({ flag: false, openRows: 1 });
    expect(report.tables.find((t: { table: string }) => t.table === "payment_items")).toMatchObject({ loaded: 332, rejected: 0, reKeyed: 0 });
  });

  it("the manifest format the importer reads is the one the exporter writes", () => {
    expect(MANIFEST_FORMAT).toBe(EXPORT_MANIFEST_FORMAT);
  });
});

// ── One broken row ───────────────────────────────────────────

describe("a workbook with one broken row", () => {
  let dir: string;
  let cleanSales: number;
  beforeAll(() => {
    dir = exportTabs(variant((tab, col) => void (tab("sales").rows[4]![col("sales", "cash_sales")] = "n/a-BROKEN-77")));
    cleanSales = boot.tabs.find((t) => t.tab === "sales")!.rows.length;
  });

  it("produces exactly one reject (sheet row, column, reason; no value) and loads the rest", async () => {
    const db = await newDb();
    const r = await run(db, dir, ["--accept-rejects", "1"]);
    expect(r.code, r.err).toBe(0);
    expect(r.rejectsCsv()).toBe("tab,row,column,reason\nsales,7,cash_sales,not a number\n");
    expect(await count(db, "sales")).toBe(cleanSales - 1);
    expect(await count(db, "till_sessions")).toBe(boot.tabs.find((t) => t.tab === "till_sessions")!.rows.length);
    expect(r.json().rejects).toEqual({ count: 1, accepted: 1, file: "rejects.csv" });
    expect(r.json().tables.find((t: { table: string }) => t.table === "sales")).toMatchObject({ loaded: cleanSales - 1, rejected: 1 });
  });

  it("exits non-zero without --accept-rejects, says how many and what to give, and keeps nothing", async () => {
    const db = await newDb();
    const r = await run(db, dir);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/1 row\(s\) were rejected/);
    expect(r.err).toMatch(/--accept-rejects 1/);
    expect(r.err).toMatch(/Nothing was kept/);
    expect(await isEmpty(db)).toBe(true);
    expect(r.rejectsCsv()).toContain("sales,7,cash_sales");
  });

  it("refuses --accept-rejects 2 (and 0) when there is exactly one, and keeps nothing", async () => {
    for (const n of ["2", "0"]) {
      const db = await newDb();
      const r = await run(db, dir, ["--accept-rejects", n]);
      expect(r.code, n).toBe(1);
      expect(r.err, n).toMatch(/Nothing was kept/);
      expect(await isEmpty(db), n).toBe(true);
    }
  });

  it("--accept-rejects with no rejects at all must be 0: 1 is refused", async () => {
    const db = await newDb();
    const r = await run(db, fixtureDir(), ["--accept-rejects", "1"]);
    expect(r.code).toBe(1);
    expect(await isEmpty(db)).toBe(true);
  });

  it("a dry run with a reject exits 1 too, and still writes both files", async () => {
    const db = await newDb();
    const r = await run(db, dir, ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(readFileSync(join(r.report, "rejects.csv"), "utf8")).toContain("sales,7,cash_sales");
    expect(existsSync(join(r.report, "import-report.json"))).toBe(true);
    expect(await isEmpty(db)).toBe(true);
  });

  it("the arguments: --accept-rejects takes only a whole number", () => {
    expect(parseArgs(["d", "--accept-rejects", "1"])).toMatchObject({ acceptRejects: 1 });
    expect(parseArgs(["d", "--accept-rejects=3"])).toMatchObject({ acceptRejects: 3 });
    for (const bad of [["d", "--accept-rejects"], ["d", "--accept-rejects", "-1"], ["d", "--accept-rejects", "1.5"], ["d", "--accept-rejects", "all"], ["d", "--force"], [], ["a", "b"], ["d", "--report"]]) {
      expect(typeof parseArgs(bad), JSON.stringify(bad)).toBe("string");
    }
  });
});

// ── --dry-run ────────────────────────────────────────────────

describe("--dry-run", () => {
  it("does everything inside the transaction and rolls back: every table stays empty, both files are written", async () => {
    const db = await newDb();
    const before = await dump(db);
    const r = await run(db, fixtureDir(), ["--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/dry run: everything was done and rolled back/);
    expect(await dump(db)).toEqual(before);
    expect(await isEmpty(db)).toBe(true);
    const report = r.json();
    expect(report.mode).toBe("dry-run");
    expect(report.outcome).toMatch(/rolled back/);
    expect(report.totals.loaded).toBeGreaterThan(1500); // the counts are of what it did before rolling back
    expect(r.rejectsCsv()).toBe("tab,row,column,reason\n");
    // and the real run after it works
    const real = await run(db, fixtureDir());
    expect(real.code).toBe(0);
    expect(await count(db, "sales")).toBe(report.tables.find((t: { table: string }) => t.table === "sales").loaded);
  }, 120_000);
});

// ── The guards ───────────────────────────────────────────────

describe("what the tool refuses, with a readable message and nothing written to the database", () => {
  async function refuses(dir: string, message: RegExp, args: string[] = [], env: Record<string, string | undefined> = {}, db?: TestDb): Promise<Ran> {
    const d = db ?? (await newDb());
    const before = await dump(d);
    const r = await run(d, dir, args, env);
    expect(r.code, `${r.out}\n${r.err}`).toBe(1);
    expect(r.err).toMatch(message);
    expect(r.err).not.toMatch(/\n\s+at .*\.ts:\d+/); // a message, not a stack trace
    expect(await dump(d)).toEqual(before);
    return r;
  }
  /** A fresh copy of the fixture export that the test may damage. */
  const copyExport = (): string => exportTabs(boot.tabs);
  const manifestOf = (dir: string): { path: string; m: any } => ({ path: join(dir, "manifest.json"), m: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) });

  it("a tab file edited by one byte (the checksum is compared before the file is read)", async () => {
    const dir = copyExport();
    const file = readdirSync(dir).find((f) => f.includes("-sales.json")) as string;
    const text = readFileSync(join(dir, file), "utf8");
    // one digit of one figure inside the rows: the file is still a valid tab file with the same counts
    const from = text.indexOf('"rows": [');
    const head = text.slice(0, from);
    const body = text.slice(from).replace(/(\d),/, (_m, d: string) => `${(Number(d) + 1) % 10},`);
    expect(body).not.toBe(text.slice(from));
    writeFileSync(join(dir, file), head + body);
    const r = await refuses(dir, /sales\.json.*does not match its checksum/s);
    expect(r.err).toMatch(/Export the workbook again/);
    expect(existsSync(join(r.report, "rejects.csv"))).toBe(false); // refused before any work: no report
  });

  it("a tab file that is not even JSON is refused on its checksum first, not on a parse error", async () => {
    const dir = copyExport();
    const file = readdirSync(dir).find((f) => f.includes("-staff.json")) as string;
    writeFileSync(join(dir, file), "not json at all");
    await refuses(dir, /checksum/);
  });

  it("a tab file that is missing", async () => {
    const dir = copyExport();
    rmSync(join(dir, readdirSync(dir).find((f) => f.includes("-payments.json")) as string));
    await refuses(dir, /missing 1 file\(s\).*payments\.json/);
  });

  it("a file the manifest does not list", async () => {
    const dir = copyExport();
    writeFileSync(join(dir, "99-extra.json"), "{}");
    await refuses(dir, /does not list: 99-extra\.json/);
  });

  it("a tab named twice in the manifest", async () => {
    const dir = copyExport();
    const { path, m } = manifestOf(dir);
    m.tabs[1].name = m.tabs[0].name;
    writeFileSync(path, JSON.stringify(m));
    await refuses(dir, /named twice/);
  });

  it("a manifest that names a file outside the directory, or the wrong format, or no manifest", async () => {
    const a = copyExport();
    const ma = manifestOf(a);
    ma.m.tabs[0].file = "../../etc/passwd";
    writeFileSync(ma.path, JSON.stringify(ma.m));
    await refuses(a, /not a plain file name/);
    const b = copyExport();
    const mb = manifestOf(b);
    mb.m.format = "storeops-sheet-export-manifest/2";
    writeFileSync(mb.path, JSON.stringify(mb.m));
    await refuses(b, /format is not storeops-sheet-export-manifest\/1/);
    const c = copyExport();
    rmSync(join(c, "manifest.json"));
    await refuses(c, /no manifest\.json/);
    await refuses(join(root, "does-not-exist"), /cannot read the export directory/);
  });

  it("a tab that is neither loaded nor listed as deprecated stops the import", async () => {
    const dir = exportTabs(boot.tabs, [{ name: "Scratch notes", grid: [["x"], ["a"], ["b"]] }]);
    await refuses(dir, /neither loads nor lists as deprecated: Scratch notes/);
  });

  it("a tab the contract loads that the export lacks", async () => {
    const dir = exportTabs(boot.tabs.filter((t) => t.tab !== "payments"));
    await refuses(dir, /no tab for: payments/);
  });

  it("an error cell in a tab it loads", async () => {
    const book = join(root, `err-${++counter}.xlsx`);
    const sheets = boot.tabs.map(asSheet);
    const sales = sheets.find((s) => s.name === "sales") as WSheet;
    (sales.grid as WCell[][])[3]![5] = { error: "#REF!" };
    writeFileSync(book, buildWorkbook({ sheets }));
    const dir = fresh("export");
    exportWorkbook(book, dir);
    await refuses(dir, /error cells.*sales \(1\)/);
  });

  it("a table that already holds a row: they are listed, nothing is deleted, nothing is added", async () => {
    const db = await newDb();
    await sql(db.ownerUrl, "insert into ops.staff (staff_id, name, active, role) values ('S_OLD', 'Existing Person', true, 'admin')");
    await sql(db.ownerUrl, "insert into ops.config (key, value) values ('k', 'v')");
    const r = await refuses(fixtureDir(), /already hold rows: config, staff\./, [], {}, db);
    expect(r.err).toMatch(/never deletes/);
    expect(await count(db, "staff")).toBe(1);
    expect(await count(db, "sales")).toBe(0);
  });

  it("a second run after a real one is refused, and changes nothing", async () => {
    const db = await newDb();
    expect((await run(db, fixtureDir())).code).toBe(0);
    const after = await dump(db);
    const again = await run(db, fixtureDir());
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already hold rows/);
    expect(await dump(db)).toEqual(after);
  }, 120_000);

  it("a migration that is not applied", async () => {
    const db = await newDb();
    await sql(db.ownerUrl, "delete from ops.schema_migrations where version = 7");
    await refuses(fixtureDir(), /not fully migrated: 1 migration\(s\) not applied \(0007_commission_runs_written_order\)/, [], {}, db);
  });

  it("a database migrated with a file that has since changed", async () => {
    const db = await newDb();
    await sql(db.ownerUrl, "update ops.schema_migrations set checksum = 'x' where version = 2");
    await refuses(fixtureDir(), /differ from ops\/migrations \(0002_staff_pin_hash\)/, [], {}, db);
  });

  it("a database with a required column the importer does not know", async () => {
    const db = await newDb();
    await sql(db.ownerUrl, "alter table ops.sales add column surprise text not null default 'x'");
    await sql(db.ownerUrl, "alter table ops.sales add column needed text");
    // nullable and defaulted columns are fine: left to their defaults
    expect((await run(db, fixtureDir(), ["--dry-run"])).code).toBe(0);
    await sql(db.ownerUrl, "alter table ops.sales alter column needed set not null, alter column needed drop default");
    const r = await run(db, fixtureDir(), ["--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/sales\.needed is required by the database and unknown to the importer/);
  });

  it("a missing or short PIN_PEPPER", async () => {
    await refuses(fixtureDir(), /PIN_PEPPER is not set/, [], { PIN_PEPPER: undefined });
    await refuses(fixtureDir(), /PIN_PEPPER is not set/, [], { PIN_PEPPER: "" });
    const r = await refuses(fixtureDir(), /shorter than 16/, [], { PIN_PEPPER: "short" });
    expect(r.err).not.toContain("short\n");
  });

  it("no database URL is a usage error (exit 2), and a report directory that is not empty is refused", async () => {
    const db = await newDb();
    const noUrl = await run(db, fixtureDir(), [], { OPS_DB_APP_URL: undefined });
    expect(noUrl.code).toBe(2);
    expect(noUrl.err).toMatch(/OPS_DB_APP_URL is not set/);
    const busy = fresh("report");
    mkdirSync(busy);
    writeFileSync(join(busy, "keep.txt"), "mine");
    const r = await run(db, fixtureDir(), ["--report", busy]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not empty/);
    expect(readdirSync(busy)).toEqual(["keep.txt"]);
    const inside = join(fixtureDir(), "report-here");
    const r2 = await run(db, fixtureDir(), ["--report", inside]);
    expect(r2.code).toBe(1);
    expect(r2.err).toMatch(/inside the export directory/);
    expect(existsSync(inside)).toBe(false);
    expect(await isEmpty(db)).toBe(true);
  });

  it("a failure part-way leaves the database exactly as it was: a planted failure in the last table", async () => {
    const db = await newDb();
    await sql(db.ownerUrl, "revoke insert on ops.audit_log from ops_app");
    const before = await dump(db);
    const r = await run(db, fixtureDir());
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/permission denied \(42501, table audit_log\)\. Nothing was kept\./);
    expect(await dump(db)).toEqual(before);
    expect(await isEmpty(db)).toBe(true); // staff, sales, payments... all rolled back too
    // and once the fault is gone the same database imports
    await sql(db.ownerUrl, "grant insert on ops.audit_log to ops_app");
    expect((await run(db, fixtureDir())).code).toBe(0);
  }, 120_000);
});

// ── Rules, through the tool ──────────────────────────────────

describe("rules, through the tool", () => {
  it("three payment items sharing one id: all loaded, two re-keyed, never a reject, listed in the report", async () => {
    const dir = exportTabs(
      variant((tab, col) => {
        const items = tab("payment_items");
        const id = col("payment_items", "item_id");
        const first = items.rows[0] as unknown[];
        items.rows.push([...first], [...first]); // rows 334+: the same item id twice more
        void id;
      }),
    );
    const db = await newDb();
    const r = await run(db, dir);
    expect(r.code, r.err).toBe(0);
    const report = r.json();
    const original = (boot.tabs.find((t) => t.tab === "payment_items")!.rows[0] as unknown[])[0] as string;
    const n = boot.tabs.find((t) => t.tab === "payment_items")!.rows.length;
    expect(report.rules.duplicateKeys.reKeyed).toEqual([
      { table: "payment_items", originalId: original, newId: `${original}-d2`, row: n + 3 },
      { table: "payment_items", originalId: original, newId: `${original}-d3`, row: n + 4 },
    ]);
    expect(report.tables.find((t: { table: string }) => t.table === "payment_items")).toMatchObject({ tabRows: n + 2, loaded: n + 2, rejected: 0, reKeyed: 2 });
    expect((await sql(db.appUrl, "select item_id from ops.payment_items where item_id like $1 order by item_id", [`${original}%`])).map((x) => x["item_id"])).toEqual([original, `${original}-d2`, `${original}-d3`]);
    expect(r.out).toMatch(/ids re-keyed: 2/);
  });

  it("an open till's closing zeros: copied by default (and counted), NULL with --open-sessions-blank", async () => {
    const dir = exportTabs(
      variant((tab, col) => {
        const t = tab("till_sessions");
        const status = col("till_sessions", "status");
        const open = t.rows.find((r) => r[status] === "open") as unknown[];
        for (const c of ["closing_cash_counted", "cash_left_in_till", "cash_removed_at_close", "expected_cash", "closing_variance"]) open[col("till_sessions", c)] = 0;
      }),
    );
    const plain = await newDb();
    const a = await run(plain, dir);
    expect(a.code, a.err).toBe(0);
    expect(a.json().rules.openSessions).toMatchObject({ flag: false, openRows: 1, rowsWithClosingFigures: 1 });
    expect(a.out).toMatch(/--open-sessions-blank would change 1/);
    expect((await sql(plain.appUrl, "select closing_cash_counted::float8 as c, closing_variance::float8 as v from ops.till_sessions where status = 'open'"))[0]).toEqual({ c: 0, v: 0 });

    const blank = await newDb();
    const b = await run(blank, dir, ["--open-sessions-blank"]);
    expect(b.code, b.err).toBe(0);
    expect(b.json().rules.openSessions).toMatchObject({ flag: true, openRows: 1, rowsWithClosingFigures: 1 });
    expect(b.out).toMatch(/imported as NULL for 1/);
    expect((await sql(blank.appUrl, "select closing_cash_counted as c, closing_variance as v from ops.till_sessions where status = 'open'"))[0]).toEqual({ c: null, v: null });
    expect((await sql(blank.appUrl, "select count(*)::int as n from ops.till_sessions where status <> 'open' and closing_cash_counted is null"))[0]?.["n"]).toBe(
      (await sql(plain.appUrl, "select count(*)::int as n from ops.till_sessions where status <> 'open' and closing_cash_counted is null"))[0]?.["n"],
    );
  });

  it("the seeded placeholder rule is left out when inactive and unused, and reported", async () => {
    const dir = exportTabs(
      variant((tab, col) => {
        const rules = tab("commission_rules");
        const active = col("commission_rules", "active");
        const id = col("commission_rules", "rule_id");
        (rules.rows.find((r) => r[id] === "CR_001") as unknown[])[active] = false;
        const bonuses = tab("bonuses");
        const ref = col("bonuses", "source_rule_id");
        for (const r of bonuses.rows) if (r[ref] === "CR_001") r[ref] = "";
      }),
    );
    const db = await newDb();
    const r = await run(db, dir);
    expect(r.code, r.err).toBe(0);
    expect((await sql(db.appUrl, "select rule_id from ops.commission_rules order by rule_id")).map((x) => x["rule_id"])).toEqual(["CR_002", "CR_003"]);
    expect(r.json().rules.placeholders.leftOut).toEqual([expect.objectContaining({ table: "commission_rules", id: "CR_001", row: 3 })]);
    expect(r.json().tables.find((t: { table: string }) => t.table === "commission_rules")).toMatchObject({ tabRows: 3, loaded: 2, leftOut: 1 });
  });

  it("a row with no id but a figure is a reject, not a quiet skip; an entirely empty row is skipped and counted", async () => {
    const dir = exportTabs(
      variant((tab, col) => {
        const sales = tab("sales");
        const width = sales.header.length;
        const noId: unknown[] = Array.from({ length: width }, () => "");
        noId[col("sales", "cash_sales")] = 123.45;
        sales.rows.push(Array.from({ length: width }, () => ""), noId);
      }),
    );
    const n = boot.tabs.find((t) => t.tab === "sales")!.rows.length;
    const db = await newDb();
    const r = await run(db, dir, ["--accept-rejects", "1"]);
    expect(r.code, r.err).toBe(0);
    expect(r.rejectsCsv()).toBe(`tab,row,column,reason\nsales,${n + 4},sales_id,"blank key, but the row holds other values"\n`);
    expect(r.json().tables.find((t: { table: string }) => t.table === "sales")).toMatchObject({ tabRows: n + 2, loaded: n, rejected: 1, blankKey: 1 });
  });

  it("an enum the Sheet wrote in its own case is loaded in the contract's; one outside the set is one reject", async () => {
    const dir = exportTabs(
      variant((tab, col) => {
        const b = tab("bonuses");
        b.rows[0]![col("bonuses", "status")] = " Cancelled ";
        b.rows[1]![col("bonuses", "status")] = "Cheque";
      }),
    );
    const db = await newDb();
    const r = await run(db, dir, ["--accept-rejects", "1"]);
    expect(r.code, r.err).toBe(0);
    expect(r.rejectsCsv()).toBe('tab,row,column,reason\nbonuses,4,status,"not one of: proposed, pending, paid, cancelled"\n');
    expect(await count(db, "bonuses")).toBe(boot.tabs.find((t) => t.tab === "bonuses")!.rows.length - 1);
    const first = boot.tabs.find((t) => t.tab === "bonuses")!.rows[0]![0];
    expect((await sql(db.appUrl, "select status from ops.bonuses where bonus_id = $1", [first]))[0]?.["status"]).toBe("cancelled");
  });

  it("a payment that is rejected takes its items with it: each is a reject naming payments.payment_id, and the rest loads", async () => {
    const dir = exportTabs(variant((tab, col) => void (tab("payments").rows[1]![col("payments", "method")] = "Cheque")));
    const db = await newDb();
    const probe = await run(db, dir, ["--dry-run"]);
    const rejects = probe.rejectsCsv().trim().split("\n").slice(1);
    expect(rejects[0]).toContain('payments,4,method,"not one of: cash, bank, etransfer, other"');
    const itemRejects = rejects.filter((l) => l.startsWith("payment_items,"));
    expect(itemRejects.length).toBeGreaterThan(0);
    expect(itemRejects.every((l) => l.endsWith(",payment_id,its payment_id refers to a row of payments.payment_id that was rejected or is missing"))).toBe(true);
    const real = await run(db, dir, ["--accept-rejects", String(rejects.length)]);
    expect(real.code, real.err).toBe(0);
    expect(await count(db, "payments")).toBe(boot.tabs.find((t) => t.tab === "payments")!.rows.length - 1);
  });
});

// ── Nothing sensitive is printed or written ──────────────────

describe("no planted cell value appears in the output or in either file", () => {
  const PAY = "87654.3210";
  const NAME = "Zelda Plantedname";
  const PIN = "40937";
  const TOKEN = "tok-PLANTED-5521";
  const BAD = "bad-PLANTED-figure";
  const ENUM = "Strange-PLANTED-status";
  const PLANTED = [PAY, NAME, PIN, TOKEN, BAD, ENUM, "87654.321"];

  it("not on success, not on rejects, not on a failure", async () => {
    const tabs = variant((tab, col) => {
      const staff = tab("staff");
      staff.rows[0]![col("staff", "name")] = NAME;
      staff.rows[0]![col("staff", "hourly_rate")] = 87654.321;
      staff.rows[0]![col("staff", "login_code")] = PIN;
      const config = tab("config");
      config.rows.push(["whatsapp_api_token", TOKEN, ""]);
      tab("sales").rows[2]![col("sales", "cash_sales")] = BAD;
      tab("bonuses").rows[0]![col("bonuses", "status")] = ENUM;
    });
    const dir = exportTabs(tabs);
    const everything: string[] = [];
    const collect = (r: Ran): void => {
      everything.push(r.out, r.err);
      if (existsSync(r.report)) for (const f of readdirSync(r.report)) everything.push(readFileSync(join(r.report, f), "utf8"));
    };
    const db = await newDb();
    collect(await run(db, dir, ["--dry-run"]));
    collect(await run(db, dir, ["--accept-rejects", "1"])); // refused: there are 2 rejects
    const ok = await run(db, dir, ["--accept-rejects", "2"]);
    expect(ok.code, ok.err).toBe(0);
    collect(ok);
    const failing = await newDb();
    await sql(failing.ownerUrl, "revoke insert on ops.audit_log from ops_app");
    const f = await run(failing, dir, ["--accept-rejects", "2"]);
    expect(f.code).toBe(1);
    collect(f);
    const text = everything.join("\n");
    for (const planted of [...PLANTED, PEPPER, "local-only-app", "tester-pw"]) expect(text, planted).not.toContain(planted);
    // and the files do say something
    expect(text).toContain("whatsapp_api_token"); // the key name, by design
    expect(text).toMatch(/bonuses,3,status/);
    expect(text).toMatch(/sales,5,cash_sales/);
    // the database has the person but never the PIN
    const rows = (await sql(db.appUrl, "select to_jsonb(x)::text as j from ops.staff x")).map((x) => x["j"]);
    expect(rows.join("")).toContain(NAME); // data belongs in the database
    expect(rows.join("")).not.toContain(PIN);
  }, 180_000);
});

// ── The command line ─────────────────────────────────────────

describe("the command, run as a process", () => {
  function cli(args: string[], env: Record<string, string | undefined>) {
    const r = spawnSync(process.execPath, ["--import", LOADER, "--experimental-strip-types", "--no-warnings", TOOL, ...args], {
      cwd: OPS,
      encoding: "utf8",
      env: { PATH: process.env["PATH"], ...env } as NodeJS.ProcessEnv,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  }

  it("npm's script runs the tool through the loader, and nothing else was added to package.json", () => {
    const pkg = JSON.parse(readFileSync(join(OPS, "package.json"), "utf8"));
    expect(pkg.scripts["import:sheet"]).toBe("node --import ./tools/ts-resolve.mjs --experimental-strip-types tools/import.ts");
  });

  it("prints usage and exits 2 with no arguments, and exits 2 with no database URL", () => {
    const a = cli([], {});
    expect(a.code).toBe(2);
    expect(a.err).toMatch(/usage: npm --prefix ops run import:sheet/);
    const b = cli([fixtureDir()], { PIN_PEPPER: PEPPER });
    expect(b.code).toBe(2);
    expect(b.err).toMatch(/OPS_DB_APP_URL is not set/);
  });

  it("runs end to end: dry run, then the real import, printing counts only", async () => {
    const db = await newDb();
    const env = { OPS_DB_APP_URL: db.appUrl, PIN_PEPPER: PEPPER };
    const dry = cli([fixtureDir(), "--dry-run", "--report", fresh("report")], env);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toMatch(/table\s+tab rows\s+loaded\s+rejected\s+re-keyed/);
    expect(dry.out).toMatch(/dry run: everything was done and rolled back/);
    expect(await isEmpty(db)).toBe(true);
    const real = cli([fixtureDir(), "--report", fresh("report")], env);
    expect(real.code, real.err).toBe(0);
    expect(real.out).toMatch(/sales\s+360\s+360\s+0\s+0/);
    expect(real.out).toMatch(/committed\./);
    expect(await count(db, "sales")).toBe(360);
    for (const secret of [PEPPER, db.appUrl, "local-only-app"]) expect(`${real.out}${real.err}${dry.out}`).not.toContain(secret);
  }, 120_000);
});
