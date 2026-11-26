// The export tool (card P4-01), end to end: a workbook of the fictional fixture
// in, one file per tab out, and every cell read back equal to what the Sheet held.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportWorkbook, safeFileName } from "../tools/export-sheet";
import { readTabFile } from "../src/export/tab-file";
import { readContract } from "../src/import/load";
import type { SheetTab } from "../src/import/sheet-to-db";
import { bootFixture, loadFixture, type BootedFixture } from "./helpers/fixture";
import { createTestDb, type TestDb } from "./helpers/db";
import { buildWorkbook, type WCell, type WSheet } from "./helpers/xlsx-write";

const TOOL = fileURLToPath(new URL("../tools/export-sheet.ts", import.meta.url));
const OPS = fileURLToPath(new URL("..", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "p401-"));
let seq = 0;
const fresh = (name = "out"): string => join(root, `${name}-${++seq}`);
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[]) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", TOOL, ...args], { cwd: OPS, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}
function save(sheets: WSheet[], over: Record<string, unknown> = {}): string {
  const p = join(root, `book-${++seq}.xlsx`);
  writeFileSync(p, buildWorkbook({ sheets, ...over }));
  return p;
}

// ── The card's done-when ─────────────────────────────────────

/** A fixture tab as a worksheet: banner row, header row, rows; a blank is a missing cell. */
function asSheet(t: SheetTab): WSheet {
  const cell = (v: unknown): WCell => (v === "" || v === null || v === undefined ? undefined : (v as WCell));
  return {
    name: t.tab,
    hidden: t.tab.startsWith("_"), // the staging tabs, to prove hidden ones are exported too
    grid: [[`StoreOps ${t.tab}`], t.header.map(cell), ...t.rows.map((r) => r.map(cell))],
  };
}

describe("the fictional fixture, as a workbook", () => {
  let boot: BootedFixture;
  let book: string;
  let out: string;
  let back: ReturnType<typeof readTabFile>[];

  beforeAll(() => {
    boot = bootFixture();
    book = save(boot.tabs.map(asSheet));
    out = fresh("fixture");
    exportWorkbook(book, out);
    back = readdirSync(out)
      .filter((f) => f !== "manifest.json")
      .sort()
      .map((f) => readTabFile(readFileSync(join(out, f), "utf8")));
  }, 120_000);

  it("has every tab, deprecated and hidden ones included, in the workbook's order", () => {
    expect(boot.tabs.length).toBeGreaterThanOrEqual(26);
    expect(back.map((t) => t.tab)).toEqual(boot.tabs.map((t) => t.tab));
    expect(back.filter((t) => t.hidden).map((t) => t.tab)).toEqual(boot.tabs.filter((t) => t.tab.startsWith("_")).map((t) => t.tab));
    expect(back.map((t) => t.index)).toEqual(boot.tabs.map((_, i) => i + 1));
  });

  it("matches the Sheet row for row and cell for cell (dates by instant)", () => {
    for (const [i, want] of boot.tabs.entries()) {
      const got = back[i] as ReturnType<typeof readTabFile>;
      expect(got.rows.length, `${want.tab} rows`).toBe(want.rows.length);
      expect(got.header, `${want.tab} header`).toEqual(want.header);
      expect(got.title, `${want.tab} title`).toEqual([`StoreOps ${want.tab}`, ...want.header.slice(1).map(() => "")]);
      expect(got.rows, `${want.tab} cells`).toEqual(want.rows);
    }
  });

  it("read back blank-for-blank: where the Sheet held '' the file holds '', never 0 or null", () => {
    let blanks = 0, zeros = 0, dates = 0;
    for (const [i, want] of boot.tabs.entries()) {
      const got = back[i] as ReturnType<typeof readTabFile>;
      want.rows.forEach((r, ri) =>
        r.forEach((v, ci) => {
          const g = (got.rows[ri] as unknown[])[ci];
          if (v === "") {
            blanks++;
            expect(g).toBe("");
          }
          if (v === 0) {
            zeros++;
            expect(g).toBe(0);
          }
          if (v instanceof Date) {
            dates++;
            expect((g as Date).getTime()).toBe(v.getTime());
          }
        }),
      );
    }
    expect(blanks).toBeGreaterThan(100);
    expect(zeros).toBeGreaterThan(100);
    expect(dates).toBeGreaterThan(1000);
  });

  it("the manifest lists every tab with counts and the SHA-256 of its file and of the workbook", () => {
    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(m.workbook).toEqual({ file: book.split("/").pop(), sha256: sha(readFileSync(book)), bytes: statSync(book).size });
    expect(m.timeZone).toBe("America/Toronto");
    expect(m.format).toBe("storeops-sheet-export-manifest/1");
    expect(m.tabs).toHaveLength(boot.tabs.length);
    for (const [i, t] of m.tabs.entries()) {
      const want = boot.tabs[i] as SheetTab;
      expect(t.name).toBe(want.tab);
      expect(t.rows).toBe(want.rows.length);
      expect(t.columns).toBe(want.header.length);
      expect(t.hidden).toBe(want.tab.startsWith("_"));
      expect(t.formulaCells).toBe(0);
      expect(t.sha256).toBe(sha(readFileSync(join(out, t.file))));
      expect(t.file).toBe(`${String(i + 1).padStart(2, "0")}-${safeFileName(want.tab)}.json`);
    }
  });
});

describe("the fixture, through the importer's own load path", () => {
  let dbA: TestDb;
  let dbB: TestDb;
  beforeAll(async () => {
    dbA = await createTestDb();
    dbB = await createTestDb();
  }, 120_000);
  afterAll(async () => {
    await Promise.all([dbA?.drop(), dbB?.drop()]);
  });

  it("loading the read-back tabs gives the same result and the same tables as loading the fixture directly", async () => {
    const boot = bootFixture();
    const book = save(boot.tabs.map(asSheet));
    const out = fresh("load");
    exportWorkbook(book, out);
    const tabs: SheetTab[] = readdirSync(out)
      .filter((f) => f !== "manifest.json")
      .sort()
      .map((f) => readTabFile(readFileSync(join(out, f), "utf8")));

    const direct = await loadFixture(dbA, boot);
    const viaExport = await loadFixture(dbB, { api: boot.api, tabs });
    expect(viaExport.counts).toEqual(direct.counts);
    expect(viaExport.rejects).toEqual(direct.rejects);
    expect(viaExport.headerIssues).toEqual(direct.headerIssues);
    expect(Object.keys(direct.counts).length).toBeGreaterThan(10);

    const dump = async (url: string): Promise<Record<string, string[]>> => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        const out: Record<string, string[]> = {};
        for (const t of Object.keys(readContract().tables)) {
          const r = await c.query(`select to_jsonb(x)::text as j from ops."${t}" x order by 1`);
          out[t] = r.rows.map((x: { j: string }) => x.j);
        }
        return out;
      } finally {
        await c.end();
      }
    };
    const [a, b] = [await dump(dbA.appUrl), await dump(dbB.appUrl)];
    expect(b).toEqual(a);
    expect(Object.values(a).reduce((n, rows) => n + rows.length, 0)).toBeGreaterThan(1000);
  }, 180_000);
});

// ── The tool ─────────────────────────────────────────────────

describe("export-sheet: files, names, manifest", () => {
  const SECRET = "ZZ-SECRET-4417.25";
  const sheets = (): WSheet[] => [
    { name: "sales", grid: [["Sales"], ["id", "amount", "note"], ["a1", 4417.25, SECRET], ["a2", 0, { inline: "Pat Fictional" }]] },
    { name: "a/b c: Ünï", hidden: true, grid: [["T"], ["k"], [{ formula: "1+1", value: 2 }], [{ error: "#REF!" }]] },
    { name: "a b/c", grid: [["T"], ["k"], [new Date("2026-03-08T07:30:00.000Z")]] },
    { name: "empty" },
  ];

  it("writes <NN>-<tab>.json per tab and a manifest, and leaves the workbook alone", () => {
    const book = save(sheets());
    const before = { bytes: readFileSync(book), mtime: statSync(book).mtimeMs };
    const out = fresh();
    const r = exportWorkbook(book, out);
    expect(listing(out)).toEqual(["01-sales.json", "02-a_b_c_Ünï.json", "03-a_b_c.json", "04-empty.json", "manifest.json"]);
    expect(r.manifest.tabs.map((t) => t.file)).toEqual(listing(out).slice(0, 4));
    expect(readFileSync(book).equals(before.bytes)).toBe(true);
    expect(statSync(book).mtimeMs).toBe(before.mtime);

    const m = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
    expect(Object.keys(m).sort()).toEqual(["format", "timeZone", "tabs", "workbook"].sort());
    expect(m.tabs[1]).toEqual({
      index: 2, name: "a/b c: Ünï", hidden: true, file: "02-a_b_c_Ünï.json", rows: 2, columns: 1,
      formulaCells: 1, dates: 0, errors: 1, sha256: sha(readFileSync(join(out, "02-a_b_c_Ünï.json"))),
    });
    expect(m.tabs[3]).toMatchObject({ name: "empty", rows: 0, columns: 1, hidden: false });
    const t = readTabFile(readFileSync(join(out, "01-sales.json"), "utf8"));
    expect(t.rows).toEqual([["a1", 4417.25, SECRET], ["a2", 0, "Pat Fictional"]]);
    expect(readTabFile(readFileSync(join(out, "03-a_b_c.json"), "utf8")).rows[0]![0]).toEqual(new Date("2026-03-08T07:30:00.000Z"));
    expect(readTabFile(readFileSync(join(out, "04-empty.json"), "utf8"))).toMatchObject({ header: [""], title: [""], rows: [] });
  });

  it("two tab names that make the same safe name still get two files; the real name is in the file", () => {
    expect(safeFileName("a/b c")).toBe(safeFileName("a b/c"));
    expect(safeFileName("..")).not.toMatch(/^\.+$/);
    expect(safeFileName("x".repeat(500)).length).toBeLessThanOrEqual(80);
    expect(safeFileName("CON:*?\"<>|\\")).toMatch(/^[\p{L}\p{N}._-]+$/u);
    const out = fresh();
    exportWorkbook(save(sheets()), out);
    expect(readTabFile(readFileSync(join(out, "02-a_b_c_Ünï.json"), "utf8")).tab).toBe("a/b c: Ünï");
    expect(readTabFile(readFileSync(join(out, "03-a_b_c.json"), "utf8")).tab).toBe("a b/c");
  });

  it("creates the output directory (nested), and accepts an existing empty one", () => {
    const book = save(sheets());
    const nested = join(fresh(), "deep", "er");
    exportWorkbook(book, nested);
    expect(listing(nested)).toHaveLength(5);
    const empty = fresh();
    mkdirSync(empty);
    exportWorkbook(book, empty);
    expect(listing(empty)).toHaveLength(5);
  });

  it("refuses a non-empty output directory and writes nothing into it", () => {
    const book = save(sheets());
    const out = fresh();
    mkdirSync(out);
    writeFileSync(join(out, "keep.txt"), "mine");
    expect(() => exportWorkbook(book, out)).toThrow(/not empty/i);
    expect(listing(out)).toEqual(["keep.txt"]);
    expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("mine");
    // and not a second run into the first run's output
    const done = fresh();
    exportWorkbook(book, done);
    const files = listing(done);
    expect(() => exportWorkbook(book, done)).toThrow(/not empty/i);
    expect(listing(done)).toEqual(files);
  });

  it("refuses an output path that is a file", () => {
    const book = save(sheets());
    const f = join(root, `afile-${++seq}`);
    writeFileSync(f, "x");
    expect(() => exportWorkbook(book, f)).toThrow(/directory/i);
    expect(readFileSync(f, "utf8")).toBe("x");
  });

  it("a bad workbook writes nothing: no files, and no directory created", () => {
    const bads: Record<string, string> = {
      "not a zip": (() => {
        const p = join(root, `text-${++seq}.xlsx`);
        writeFileSync(p, "a,b,c\n1,2,3\n");
        return p;
      })(),
      "no workbook.xml": save([{ name: "x" }], { omit: ["xl/workbook.xml"] }),
      "missing sheet": save([{ name: "x" }, { name: "y" }], { omit: ["xl/worksheets/sheet2.xml"] }),
      "formula without value": save([{ name: "x", grid: [["t"], ["h"], [{ formula: "1", value: null }]] }]),
    };
    for (const [label, p] of Object.entries(bads)) {
      const out = join(fresh(), "never");
      expect(() => exportWorkbook(p, out), label).toThrow();
      expect(existsSync(out), label).toBe(false);
      const existing = fresh();
      mkdirSync(existing);
      expect(() => exportWorkbook(p, existing), label).toThrow();
      expect(listing(existing), label).toEqual([]);
    }
  });

  it("a workbook that does not exist", () => {
    expect(() => exportWorkbook(join(root, "nope.xlsx"), fresh())).toThrow(/nope\.xlsx|cannot read/i);
  });
});

describe("export-sheet: the command", () => {
  const SECRET = "ZZ-SECRET-4417.25";
  const grid: WCell[][] = [["Sales"], ["id", "amount", "who", "when"], ["a1", 4417.25, SECRET, new Date("2026-11-21T14:00:00.000Z")], ["a2", 98765.43, "Pat Fictional", { formula: "NOW()", value: 46347.5 } as WCell]];

  it("prints a table of tab, rows, columns, dates, formulas, errors - and never a cell value", () => {
    const book = save([{ name: "sales", grid }, { name: "old stuff", hidden: true, grid: [["T"], ["k"], [{ error: "#N/A" }]] }]);
    const out = fresh();
    const r = run([book, out]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/tab\s+rows\s+columns\s+dates\s+formulas\s+errors/i);
    expect(r.out).toMatch(/sales\s+2\s+4\s+1\s+1\s+0/);
    expect(r.out).toMatch(/old stuff.*hidden|hidden.*old stuff/i);
    for (const planted of [SECRET, "4417.25", "98765.43", "Pat Fictional", "2026-11-21", "#N/A"]) expect(r.out, planted).not.toContain(planted);
    expect(listing(out)).toEqual(["01-sales.json", "02-old_stuff.json", "manifest.json"]);
  });

  it("prints no cell value when it fails either", () => {
    const book = save([{ name: "sales", grid: [["t"], ["h"], [SECRET, { formula: "1", value: null }]] }]);
    const r = run([book, fresh()]);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain(SECRET);
    expect(r.out).toMatch(/formula/i);
  });

  it("exits 1 with a readable line on a problem, 2 on wrong usage", () => {
    const r = run([join(root, "none.xlsx"), fresh()]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/none\.xlsx/);
    expect(r.stderr).not.toMatch(/\bat .*\.ts:\d+/); // no stack trace
    expect(run([]).code).toBe(2);
    expect(run(["only-one-arg.xlsx"]).code).toBe(2);
    expect(run(["a", "b", "c"]).code).toBe(2);
  });

  it("exits 1 on a non-empty directory", () => {
    const book = save([{ name: "x", grid: [["t"]] }]);
    const out = fresh();
    mkdirSync(out);
    writeFileSync(join(out, "old.json"), "{}");
    const r = run([book, out]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not empty/i);
    expect(listing(out)).toEqual(["old.json"]);
  });
});
