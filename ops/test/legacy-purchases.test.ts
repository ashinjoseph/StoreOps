// The old purchase list brought in as history (card P5-16). NEW in the Operations app (ADR-0023):
// these tests are its specification. A real database; the tool run through its own main() and once as a
// real process; the RPCs through the REAL router and merged contract.
// The workbook is BUILT HERE from invented shops, notes and amounts (the test .xlsx writer): no file from
// outside is ever read, and nothing here is, or resembles, a real supplier, person or figure.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/sessions";
import { memoryBackupBucket } from "../src/backup/storage";
import { restoreNightly } from "../src/backup/restore";
import { connect, type Db } from "../src/db/client";
import { withTransaction, type Tx } from "../src/db/tx";
import { readWorkbook, torontoWallToInstant, type SheetCell } from "../src/export/xlsx";
import { Config } from "../src/lib/config";
import { normalise } from "../src/receipts/businesses";
import * as drafts from "../src/receipts/drafts";
import * as legacy from "../src/receipts/legacy";
import * as originals from "../src/receipts/originals";
import { bucketStorage } from "../src/receipts/storage";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import { TOOLS } from "../src/mcp/tools";
import { LATER_OPS_TABLES } from "../src/cutover/compare";
import { main, parseArgs, REMOTE_FLAG } from "../tools/import-purchases";
import { copyNow, downloadFolder, dumpAll } from "./helpers/backup";
import { createTestDb } from "./helpers/db";
import { makeWorld, type McpWorld } from "./helpers/mcp";
import { buildWorkbook, type WCell, type WSheet } from "./helpers/xlsx-write";

// 2026-11-27 10:00 in Toronto.
const NOW = new Date("2026-11-27T15:00:00.000Z");
const TODAY = "2026-11-27";
const ADMIN = "S_001";
const MANAGER = "S_002";
const EMPLOYEE = "S_003";
const PAYROLL = "S_004";
const INACTIVE_ADMIN = "S_006";
const TOOL = fileURLToPath(new URL("../tools/import-purchases.ts", import.meta.url));
const LOADER = fileURLToPath(new URL("../tools/ts-resolve.mjs", import.meta.url));
const OPS = fileURLToPath(new URL("..", import.meta.url));

let w: McpWorld;
const T: Record<string, string> = {};
const root = mkdtempSync(join(tmpdir(), "p516-"));
let seq = 0;
const fresh = (name: string): string => join(root, `${name}-${++seq}`);

beforeAll(async () => {
  w = await makeWorld(NOW);
  await w.owner.query("insert into ops.staff (staff_id, name, active, role, companies_authorized) values ($1, 'Fenn Ashby', false, 'admin', 'cstore,vape')", [INACTIVE_ADMIN]);
  for (const id of [ADMIN, MANAGER, EMPLOYEE, PAYROLL]) T[id] = (await createSession(w.db, id, Config.fromRows([]), NOW)).token;
});
afterAll(async () => {
  await w?.close();
  rmSync(root, { recursive: true, force: true });
});
const RECEIPT_TABLES = ["business_signs", "supplier_names", "purchase_receipt_lines", "purchase_receipts", "suppliers", "receipt_upload_tickets", "receipt_originals"];
beforeEach(async () => {
  w.clock.now = NOW;
  // The cost history (card P5-15) hangs off a confirmed receipt and its supplier: its rows go first.
  for (const t of ["legacy_purchases", "legacy_purchase_files", "price_flags", "item_costs", "receipt_observations", "supplier_items", ...RECEIPT_TABLES, "assistant_calls", "audit_log"]) await w.owner.query(`delete from ops.${t}`);
});

// ── The fictional workbook ────────────────────────────────

interface Line {
  /** A day, null (a blank cell) or { text } (a date typed as text). */
  date: string | null | { text: string };
  supplier: string | null;
  amount: number | string | null;
  item: string | null;
}
/** Row 2 is the first; null is a row with nothing in it. Invented shops, notes and amounts. */
const SHEET: Array<Line | null> = [
  /* 2 */ { date: "2026-03-02", supplier: "Maplefield Grocer", amount: 120.5, item: null },
  /* 3 */ { date: "2026-02-11", supplier: "maplefield grocer", amount: 45.1, item: "for Marta" },
  /* 4 */ { date: "2026-02-11", supplier: "Maplefield  Grocer ", amount: 45.1, item: null },
  /* 5 */ { date: "2026-02-12", supplier: "Maplefield Grocery", amount: 33.33, item: null },
  /* 6 */ { date: "2026-02-12", supplier: "Maplefield Grocery", amount: 33.33, item: null }, // an exact repeat
  /* 7 */ { date: "2026-01-20", supplier: "Maplefeild Grocer", amount: 18, item: "Harbour Road" },
  /* 8 */ { date: "2026-01-19", supplier: "Maplefield Grocer tobacco", amount: 210, item: null },
  /* 9 */ { date: "2026-01-18", supplier: "Maplefield-Grocer", amount: 9.99, item: null },
  /* 10 */ { date: "2026-04-01", supplier: "Oakridge Wholesale", amount: 1234.56, item: "<script>alert('x')</script>" },
  /* 11 */ { date: "2026-04-02", supplier: "Oakridge Wholesale", amount: -15.25, item: '=HYPERLINK("http://example.invalid","click")' },
  /* 12 */ { date: "2026-04-03", supplier: null, amount: 7.75, item: null }, // no supplier written
  /* 13 */ { date: null, supplier: "Pinebrook Supply", amount: 20, item: null }, // rejected: no date
  /* 14 */ { date: "2026-04-05", supplier: "Pinebrook Supply", amount: null, item: null }, // rejected: no amount
  /* 15 */ { date: "2026-04-06", supplier: "Pinebrook Supply", amount: "12.50", item: null }, // rejected: a text amount
  /* 16 */ { date: "1999-12-31", supplier: "Pinebrook Supply", amount: 5, item: null }, // rejected: before 2000
  /* 17 */ { date: "2027-01-15", supplier: "Pinebrook Supply", amount: 6, item: null }, // rejected: after the import
  /* 18 */ { date: { text: "2026-04-07" }, supplier: "Pinebrook Supply", amount: 8, item: null }, // rejected: a date typed as text
  /* 19 */ { date: "2026-04-08", supplier: "Pinebrook Supply", amount: 10.005, item: null }, // rejected: fractions of a cent
  /* 20 */ null,
  /* 21 */ { date: "2026-04-09", supplier: "Pinebrook Supply", amount: 0, item: null }, // zero: kept
  /* 22 */ { date: "2026-05-01", supplier: "Oakridge Wholesale", amount: 99.99, item: null },
  /* 23 */ { date: "2026-05-01", supplier: "Pinebrook Supply", amount: 640.4, item: "Lakeview" },
];
const KEPT_ROWS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 21, 22, 23];
const REJECTED: Array<[number, string, string]> = [
  [13, "date", "no date"],
  [14, "amount", "no amount"],
  [15, "amount", "the amount is not a number"],
  [16, "date", "the date is before 2000"],
  [17, "date", "the date is after the day of the import"],
  [18, "date", "the date is text, not a date"],
  [19, "amount", "the amount has fractions of a cent"],
];
/** Every name, note and amount of the fixture: none may appear in anything the tool prints or writes. */
const SECRETS = [
  "Maplefield", "Maplefeild", "Oakridge", "Pinebrook", "Marta", "Harbour", "Lakeview", "script", "HYPERLINK", "example.invalid",
  "120.5", "45.1", "33.33", "1234.56", "15.25", "7.75", "99.99", "640.4", "9.99", "12.50", "10.005",
];

const dateCell = (day: string): WCell => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return torontoWallToInstant(y, m, d, 0, 0, 0, 0);
};
function gridOf(lines: ReadonlyArray<Line | null>, order: readonly number[] = [0, 1, 2, 3], heads: readonly string[] = ["Date", "Supplier Name ", "Amount", "Item"]): WCell[][] {
  const cell = (l: Line, col: number): WCell => {
    if (col === 0) return l.date === null ? undefined : typeof l.date === "string" ? dateCell(l.date) : l.date.text;
    if (col === 1) return l.supplier ?? undefined;
    if (col === 2) return l.amount ?? undefined;
    return l.item ?? undefined;
  };
  return [order.map((c) => heads[c] as string), ...lines.map((l) => (l === null ? [] : order.map((c) => cell(l, c))))];
}
const ATM: WSheet = { name: "ATM DEPOSIT", grid: [["Date", "Amount"], [dateCell("2026-03-03"), 5000.55], [dateCell("2026-03-10"), 4000.65]] };
function save(sheets: WSheet[], name = "purchases.xlsx"): string {
  const dir = fresh("book");
  mkdirSync(dir);
  const p = join(dir, name);
  writeFileSync(p, buildWorkbook({ sheets }));
  return p;
}
const bookOf = (lines: ReadonlyArray<Line | null> = SHEET, more: WSheet[] = [ATM]): string => save([{ name: "Purchase Invoices", grid: gridOf(lines) }, ...more]);
/** A list of n invented, valid lines. */
const manyLines = (n: number): Line[] => Array.from({ length: n }, (_, i) => ({ date: `2026-0${1 + (i % 9)}-${String(1 + (i % 27)).padStart(2, "0")}`, supplier: `Shop ${i % 7}`, amount: 10 + i, item: i % 3 === 0 ? `note ${i}` : null }));

interface Run {
  code: number;
  out: string;
  err: string;
  all: string;
  report: string;
}
async function runTool(file: string, args: string[] = [], over: { url?: string; as?: string; report?: string; now?: Date } = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const report = over.report ?? fresh("report");
  const argv = [file, "--as", over.as ?? ADMIN, "--report", report, ...args];
  const code = await main(argv, { OPS_DB_APP_URL: over.url ?? w.testDb.appUrl }, { out: (l) => out.push(l), err: (l) => err.push(l) }, { now: () => over.now ?? NOW });
  return { code, out: out.join("\n"), err: err.join("\n"), all: [...out, ...err].join("\n"), report };
}
const fileSha = async (file: string): Promise<string> => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(readFileSync(file)).digest("hex");
};

const count = async (t: string): Promise<number> => (await w.owner.one<{ n: number }>(`select count(*)::int as n from ops.${t}`)).n;
const liveRows = () => w.owner.query<any>("select * from ops.legacy_purchases where superseded_at is null order by sheet_row");
const audits = (like: string) => w.owner.query<any>(`select actor_id, action, target_type, target_id, "before", "after", details from ops.audit_log where action like $1 order by seq`, [like]);
const dump = (tables: readonly string[]) => dumpAll(w.testDb.ownerUrl, tables);

// ── RPC through the real router ───────────────────────────

const contract = parseRpcContract(
  mergeOpsContract(
    JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
    JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
  ),
);
type Answer = { ok: boolean; result?: any; error?: { message: string } };
async function rpc(name: string, args: unknown[]): Promise<Answer> {
  const router = createRpcRouter({ contract, handlers, openDb: () => connect(w.testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env: {}, now: () => w.clock.now, log: () => undefined });
  const res = await router(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
  return (await res.json()) as Answer;
}
async function ok(name: string, args: unknown[]): Promise<any> {
  const r = await rpc(name, args);
  if (!r.ok) throw new Error(`${name}: ${r.error?.message}`);
  return r.result;
}
async function refused(name: string, args: unknown[]): Promise<string> {
  const r = await rpc(name, args);
  expect(r.ok, `${name} should be refused`).toBe(false);
  return r.error?.message ?? "";
}
const list = (business: string, more: Record<string, unknown> = {}, by = ADMIN) => ok("rpcGetLegacyPurchases", [T[by], { business, ...more }]);
const spellings = (by = ADMIN) => ok("rpcGetLegacySpellings", [T[by]]);
const setBiz = (input: Record<string, unknown>, by = ADMIN) => ok("rpcSetLegacyBusiness", [T[by], input]);
const link = (input: Record<string, unknown>, by = ADMIN) => ok("rpcLinkLegacySupplier", [T[by], input]);
async function newSupplier(name: string, by = MANAGER): Promise<string> {
  return (await ok("rpcCreateReceiptSupplier", [T[by], { displayName: name }])).supplier.id;
}
const KEY = { grocer: "maplefieldgrocer", grocery: "maplefieldgrocery", oak: "oakridgewholesale", pine: "pinebrooksupply", blank: "" };

/** The fixture imported for real, through the tool. */
async function imported(lines: ReadonlyArray<Line | null> = SHEET): Promise<{ file: string; run: Run }> {
  const file = bookOf(lines);
  const run = await runTool(file);
  expect(run.code, run.all).toBe(0);
  return { file, run };
}

// ── The rules, as a table (pure) ──────────────────────────

describe("the row rules", () => {
  const cols: legacy.Columns = { date: 0, supplier: 1, amount: 2, item: 3 };
  const day = (d: string): Date => dateCell(d) as Date;
  const judge = (cells: SheetCell[]) => legacy.judgeRow(cells, cols, 7, TODAY);
  const rejectedWith = (cells: SheetCell[]): string[] => {
    const r = judge(cells);
    return r.kind === "rejected" ? r.rejects.map((x) => `${x.column}: ${x.reason}`) : [`not rejected: ${r.kind}`];
  };

  it("keeps a good row exactly as it was: the day, the text with its odd spacing, the amount in cents", () => {
    expect(judge([day("2026-03-02"), "  Maplefield  Grocer ", 120.5, " for Marta "])).toEqual({ kind: "kept", row: { sheetRow: 7, date: "2026-03-02", supplier: "  Maplefield  Grocer ", key: "maplefieldgrocer", cents: 12050, note: " for Marta " } });
  });
  it("a blank supplier is kept, as blank; a blank note too", () => {
    expect(judge([day("2026-03-02"), "", 5, ""])).toMatchObject({ kind: "kept", row: { supplier: "", key: "", note: "" } });
  });
  it("a zero and a negative amount are kept as they are", () => {
    expect(judge([day("2026-03-02"), "x", 0, ""])).toMatchObject({ kind: "kept", row: { cents: 0 } });
    expect(judge([day("2026-03-02"), "x", -15.25, ""])).toMatchObject({ kind: "kept", row: { cents: -1525 } });
  });
  it("an amount keeps its cents however the float falls: 1.005 is refused, 0.29 and 1234567.89 are kept exactly", () => {
    expect(judge([day("2026-03-02"), "x", 0.29, ""])).toMatchObject({ row: { cents: 29 } });
    expect(judge([day("2026-03-02"), "x", 1234567.89, ""])).toMatchObject({ row: { cents: 123456789 } });
    expect(judge([day("2026-03-02"), "x", 0.1 + 0.2, ""])).toMatchObject({ row: { cents: 30 } });
    expect(rejectedWith([day("2026-03-02"), "x", 1.005, ""])).toEqual(["amount: the amount has fractions of a cent"]);
  });
  it("what is rejected, and why (never the value)", () => {
    expect(rejectedWith(["", "x", 5, ""])).toEqual(["date: no date"]);
    expect(rejectedWith([day("2026-03-02"), "x", "", ""])).toEqual(["amount: no amount"]);
    expect(rejectedWith([day("2026-03-02"), "x", "12.50", ""])).toEqual(["amount: the amount is not a number"]);
    expect(rejectedWith([day("2026-03-02"), "x", "$12.50", ""])).toEqual(["amount: the amount is not a number"]);
    expect(rejectedWith([day("2026-03-02"), "x", true, ""])).toEqual(["amount: the amount is not a number"]);
    expect(rejectedWith([day("2026-03-02"), "x", { error: "#N/A" }, ""])).toEqual(["amount: the amount is not a number"]);
    expect(rejectedWith([day("2026-03-02"), "x", 1e10, ""])).toEqual(["amount: the amount is too large"]);
    expect(rejectedWith([day("1999-12-31"), "x", 5, ""])).toEqual(["date: the date is before 2000"]);
    expect(rejectedWith([day("2026-11-28"), "x", 5, ""])).toEqual(["date: the date is after the day of the import"]);
    expect(rejectedWith(["2026-03-02", "x", 5, ""])).toEqual(["date: the date is text, not a date"]);
    expect(rejectedWith([45000, "x", 5, ""])).toEqual(["date: the date is not a date"]);
    expect(rejectedWith([day("2026-03-02"), day("2026-03-03"), 5, ""])).toEqual(["supplier name: the supplier is not text"]);
    expect(rejectedWith([day("2026-03-02"), "x", 5, true])).toEqual(["item: the item is not text"]);
    expect(rejectedWith([day("2026-03-02"), "a\u0000b", 5, ""])).toEqual(["supplier name: the supplier holds a character the database cannot keep"]);
    // every reason is listed, so one pass over the sheet fixes them all
    expect(rejectedWith(["", "x", "", ""])).toEqual(["date: no date", "amount: no amount"]);
  });
  it("the day of the import itself is allowed; the first day of 2000 too", () => {
    expect(judge([day(TODAY), "x", 1, ""]).kind).toBe("kept");
    expect(judge([day("2000-01-01"), "x", 1, ""]).kind).toBe("kept");
  });
  it("a row with nothing in the four columns is not a row of the list; a number in the supplier column is its digits", () => {
    expect(judge(["", "", "", ""]).kind).toBe("empty");
    expect(judge([])).toEqual({ kind: "empty" });
    expect(judge([day("2026-03-02"), 7, 1, ""])).toMatchObject({ row: { supplier: "7", key: "7" } });
  });
  it("centsText is exact integer arithmetic", () => {
    expect([12050, -1525, 5, 0, -5, 100].map(legacy.centsText)).toEqual(["120.50", "-15.25", "0.05", "0.00", "-0.05", "1.00"]);
  });
});

describe("the columns are found by their headings, never by position", () => {
  it("whatever their order, their capitals and the spaces around them", () => {
    expect(legacy.findColumns(["Date", "Supplier Name ", "Amount", "Item"])).toEqual({ date: 0, supplier: 1, amount: 2, item: 3 });
    expect(legacy.findColumns(["  item", "AMOUNT ", "supplier   name", "DATE"])).toEqual({ date: 3, supplier: 2, amount: 1, item: 0 });
    expect(legacy.findColumns(["Notes", "Item", "Amount", "Total", "Date", "Supplier Name"])).toEqual({ date: 4, supplier: 5, amount: 2, item: 1 });
  });
  it("refuses, in plain words and quoting nothing of the tab, when one is missing or two share a heading", () => {
    expect(() => legacy.findColumns(["Date", "Supplier", "Amount", "Item"])).toThrow(/no column headed "supplier name".*Nothing was written/);
    expect(() => legacy.findColumns(["Date", "Amount"])).toThrow(/"supplier name", "item"/);
    expect(() => legacy.findColumns(["Date", "Supplier Name", "Amount", "Item", "date"])).toThrow(/More than one column is headed "date"/);
    expect(() => legacy.findColumns([])).toThrow(legacy.LegacyRefused);
    let said = "";
    try {
      legacy.findColumns(["Maplefield Grocer", "120.50", "x", "y"]);
    } catch (e) {
      said = (e as Error).message;
    }
    expect(said).not.toMatch(/Maplefield|120/);
  });
  it("readRows counts what it kept and rejected, in the spreadsheet's own row numbers", () => {
    const wb = readWorkbook(readFileSync(bookOf()), { headerRow: 1 });
    const sheet = wb.sheets.find((s) => s.name === "Purchase Invoices")!;
    const cols = legacy.findColumns(sheet.table!.header);
    const r = legacy.readRows(sheet.table!.rows, cols, TODAY);
    expect(r.rows.map((x) => x.sheetRow)).toEqual(KEPT_ROWS);
    expect(r.rejects.map((x) => [x.sheetRow, x.column, x.reason])).toEqual(REJECTED);
    expect(r.counts).toMatchObject({ read: 21, kept: 14, rejected: 7, empty: 1, noSupplier: 1, zero: 1, negative: 1, repeats: 1 });
    expect(r.counts.kept + r.counts.rejected).toBe(r.counts.read);
    expect(r.counts.noNote).toBe(14 - 5);
  });
});

describe("the workbook reader", () => {
  it("its default mode is exactly what it was: no table, the banner layout untouched", () => {
    const wb = readWorkbook(readFileSync(bookOf()));
    expect(wb.sheets[0]!.table).toBeUndefined();
    expect("table" in wb.sheets[0]!).toBe(false);
  });
  it("with the header in row 1 it hands over the header and every row below with its own row number, empty ones included", () => {
    const sheet = readWorkbook(readFileSync(bookOf()), { headerRow: 1 }).sheets[0]!;
    expect(sheet.table!.header).toEqual(["Date", "Supplier Name ", "Amount", "Item"]);
    expect(sheet.table!.rows[0]!.row).toBe(2);
    expect(sheet.table!.rows.at(-1)!.row).toBe(23);
    expect(sheet.table!.rows.find((r) => r.row === 20)!.cells.every((c) => c === "")).toBe(true);
    expect(sheet.table!.rows.find((r) => r.row === 3)!.cells[1]).toBe("maplefield grocer");
    expect(sheet.table!.rows.find((r) => r.row === 4)!.cells[1]).toBe("Maplefield  Grocer ");
    expect(sheet.table!.rows.find((r) => r.row === 3)!.cells[0]).toBeInstanceOf(Date);
  });
  it("with the banner layout asked for, the header is row 2", () => {
    const book = save([{ name: "T", grid: [["banner"], ["h1", "h2"], ["a", "b"]] }]);
    const t = readWorkbook(readFileSync(book), { headerRow: 2 }).sheets[0]!.table!;
    expect(t.header).toEqual(["h1", "h2"]);
    expect(t.rows).toEqual([{ row: 3, cells: ["a", "b"] }]);
  });
});

// ── The tool ──────────────────────────────────────────────

describe("the tool: usage and refusals", () => {
  it("needs --as, one workbook and a known option; a bad --replace-file is a usage error", () => {
    expect(parseArgs(["a.xlsx"])).toMatch(/--as/);
    expect(parseArgs(["--as", "S_001"])).toMatch(/exactly one workbook/);
    expect(parseArgs(["a.xlsx", "--as", "S_001", "--wat"])).toMatch(/unknown option/);
    expect(parseArgs(["a.xlsx", "--as", "S_001", "--replace-file", "abc"])).toMatch(/64 letters and digits/);
    expect(parseArgs(["a.xlsx", "--as", "S_001", "--tab", "Other", "--dry-run", "--report", "r"])).toMatchObject({ tab: "Other", dryRun: true, report: "r", replaceFile: null });
  });
  it("a database that is not on this computer is refused unless the alarming flag is given; nothing is written", async () => {
    const file = bookOf();
    const r = await runTool(file, [], { url: "postgres://ops_app:x@db.example.invalid:5432/ops" });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not on this computer \(127\.0\.0\.1 or localhost\). Nothing was written/);
    expect(readdirSyncSafe(r.report)).toEqual([]);
    expect(REMOTE_FLAG).toBe("--yes-load-into-a-database-that-is-not-on-this-computer");
    // with the flag it gets as far as connecting, and fails there (nothing resolves that name)
    const flagged = await runTool(file, [REMOTE_FLAG], { url: "postgres://ops_app:x@db.example.invalid:5432/ops" });
    expect(flagged.err).not.toMatch(/not on this computer/);
    expect(flagged.code).toBe(1);
    expect(await count("legacy_purchases")).toBe(0);
  });
  it("a localhost name is local too", async () => {
    const u = new URL(w.testDb.appUrl);
    u.hostname = "localhost";
    const r = await runTool(bookOf(), ["--dry-run"], { url: u.toString() });
    expect(r.err).not.toMatch(/not on this computer/);
  });
  it("--as must be an active admin: a manager, an employee, an inactive admin and a stranger are refused, and nothing is written", async () => {
    for (const who of [MANAGER, EMPLOYEE, INACTIVE_ADMIN, "S_999"]) {
      const r = await runTool(bookOf(), [], { as: who });
      expect(r.code, who).toBe(1);
      expect(r.err).toMatch(/--as must be the staff id of an active admin. Nothing was written/);
    }
    expect(await count("legacy_purchase_files")).toBe(0);
    expect(await count("audit_log")).toBe(0);
  });
  it("a missing column or tab is refused in plain words, never guessed by position", async () => {
    const noItem = save([{ name: "Purchase Invoices", grid: [["Date", "Supplier Name", "Amount", "Memo"], [dateCell("2026-03-02"), "x", 5, "y"]] }]);
    const r = await runTool(noItem);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/no column headed "item"/);
    const wrongTab = await runTool(bookOf(), ["--tab", "Invoices 2026"]);
    expect(wrongTab.code).toBe(1);
    expect(wrongTab.err).toMatch(/no tab named "Invoices 2026". Its tabs are: "Purchase Invoices", "ATM DEPOSIT"/);
    // a tab found by name, ignoring capitals and spaces around it
    const loose = await runTool(bookOf(), ["--tab", " purchase invoices ", "--dry-run"]);
    expect(loose.code, loose.all).toBe(0);
    expect(await count("legacy_purchases")).toBe(0);
  });
  it("a workbook that is not one, and one that cannot be read, say so without a value", async () => {
    const dir = fresh("junk");
    mkdirSync(dir);
    writeFileSync(join(dir, "x.xlsx"), "not a workbook");
    const r = await runTool(join(dir, "x.xlsx"));
    expect(r.code).toBe(1);
    const missing = await runTool(join(dir, "none.xlsx"));
    expect(missing.err).toMatch(/cannot read the workbook: ENOENT/);
  });
  it("the report directory must be new or empty", async () => {
    const dir = fresh("full");
    mkdirSync(dir);
    writeFileSync(join(dir, "old.txt"), "x");
    const r = await runTool(bookOf(), [], { report: dir });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/is not empty/);
    expect(await count("legacy_purchases")).toBe(0);
  });
});

const readdirSyncSafe = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

describe("the load", () => {
  it("every kept row is the workbook's cell for cell: date, text as typed with its odd spacing, amount to the cent, the spreadsheet's row number; repeats kept; the second tab ignored", async () => {
    await imported();
    const rows = await liveRows();
    expect(rows.map((r) => r.sheet_row)).toEqual(KEPT_ROWS);
    for (const r of rows) {
      const l = SHEET[r.sheet_row - 2] as Line;
      expect((await w.owner.one<{ d: string }>("select purchase_date::text as d from ops.legacy_purchases where row_id = $1", [r.row_id])).d, `row ${r.sheet_row}`).toBe(l.date);
      expect(r.supplier_text, `row ${r.sheet_row}`).toBe(l.supplier ?? "");
      expect(r.spelling_key).toBe(normalise(l.supplier ?? ""));
      expect(Math.round(Number(r.amount) * 100), `row ${r.sheet_row}`).toBe(Math.round((l.amount as number) * 100));
      expect(r.note).toBe(l.item ?? "");
      expect(r.business).toBeNull();
      expect(r.supplier_id).toBeNull();
      expect(r.superseded_at).toBeNull();
    }
    expect(rows.find((r) => r.sheet_row === 4)!.supplier_text).toBe("Maplefield  Grocer ");
    expect(Number(rows.find((r) => r.sheet_row === 11)!.amount)).toBe(-15.25);
    expect((await w.owner.one<{ a: string }>("select amount::text as a from ops.legacy_purchases where file_id = $1 and sheet_row = 21", [rows[0].file_id])).a).toBe("0.00");
    expect(rows.filter((r) => r.sheet_row === 5 || r.sheet_row === 6)).toHaveLength(2); // the exact repeat
    // the ATM tab is nowhere: every row came from the one tab
    expect(new Set(rows.map((r) => r.file_id)).size).toBe(1);
    expect((await w.owner.one<{ n: number }>("select count(*)::int as n from ops.legacy_purchases")).n).toBe(14);
    const f = await w.owner.one<any>("select file_name, tab, rows_read, rows_kept, rows_rejected, encode(file_sha256, 'hex') as sha, imported_by, superseded_at from ops.legacy_purchase_files");
    expect(f).toMatchObject({ file_name: "purchases.xlsx", tab: "Purchase Invoices", rows_read: 21, rows_kept: 14, rows_rejected: 7, imported_by: ADMIN, superseded_at: null });
    expect(f.rows_kept + f.rows_rejected).toBe(f.rows_read);
  });

  it("the rejects are listed with the right row numbers and reasons, and the counts add up; the file's own sha is recorded", async () => {
    const { file, run } = await imported();
    const csv = readFileSync(join(run.report, "rejects.csv"), "utf8").trim().split("\n");
    expect(csv[0]).toBe("row,column,reason");
    expect(csv.slice(1)).toEqual(REJECTED.map(([row, col, why]) => `${row},${col},${why}`));
    const rep = JSON.parse(readFileSync(join(run.report, "import-report.json"), "utf8"));
    expect(rep).toMatchObject({ outcome: "imported", tab: "Purchase Invoices", counts: { read: 21, kept: 14, rejected: 7, empty: 1, noSupplier: 1, zero: 1, negative: 1, repeats: 1, spellings: 7 } });
    expect(rep.counts.kept + rep.counts.rejected).toBe(rep.counts.read);
    expect(Object.values(rep.counts).every((v) => Number.isInteger(v)), "the counts are whole numbers: no date, no amount").toBe(true);
    expect(JSON.stringify(rep)).not.toMatch(/2026-0|20\d\d-\d\d-\d\d(?!T)/);
    expect(rep.workbook.sha256).toBe(await fileSha(file));
    expect(run.out).toMatch(/rows read: 21 \(and 1 empty row skipped\)/);
    expect(run.out).toMatch(/kept: 14/);
    expect(run.out).toMatch(/rejected: 7 \(NOT imported/);
    expect(run.out).toMatch(/committed: 14 rows/);
    expect(run.out).toContain(`SHA-256 ${await fileSha(file)}`);
  });

  it("ONE insert holds every row: the statements for 30 rows and for 300 are the same", async () => {
    const counting = (): { db: Db; log: string[] } => {
      const log: string[] = [];
      const db: Db = {
        query: (t, p) => (log.push(t), w.db.query(t, p)),
        one: (t, p) => (log.push(t), w.db.one(t, p)),
        maybeOne: (t, p) => (log.push(t), w.db.maybeOne(t, p)),
      };
      return { db, log };
    };
    const load = async (n: number, sha: string): Promise<string[]> => {
      const { db, log } = counting();
      const table = gridOf(manyLines(n)).slice(1).map((cells, i) => ({ row: i + 2, cells: cells as SheetCell[] }));
      const result = legacy.readRows(table, { date: 0, supplier: 1, amount: 2, item: 3 }, TODAY);
      expect(result.counts.kept).toBe(n);
      await withTransaction(db, (tx) => legacy.loadFile(tx, { sha256: sha, fileName: "n.xlsx", tab: "Purchase Invoices", result, staffId: ADMIN, replaces: null, now: NOW }));
      return log;
    };
    const small = await load(30, "a".repeat(64));
    expect(await count("legacy_purchases")).toBe(30);
    for (const t of ["legacy_purchases", "legacy_purchase_files", "audit_log"]) await w.owner.query(`delete from ops.${t}`);
    const big = await load(300, "b".repeat(64));
    expect(await count("legacy_purchases")).toBe(300);
    expect(big.length).toBe(small.length);
    expect(big.filter((s) => /insert into ops\.legacy_purchases\b/.test(s))).toHaveLength(1);
    expect(small.filter((s) => /insert into ops\.legacy_purchases\b/.test(s))).toHaveLength(1);
  });

  it("running the same file again adds nothing, and says so; a second dry run too; the audit has one import", async () => {
    const { file } = await imported();
    const before = await dump(["legacy_purchases", "legacy_purchase_files", "audit_log"]);
    const again = await runTool(file);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/This file was imported before. Nothing was added./);
    expect(again.out).not.toMatch(/committed/);
    expect(await dump(["legacy_purchases", "legacy_purchase_files", "audit_log"])).toEqual(before);
    const dry = await runTool(file, ["--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/nothing would be added/);
    expect((await liveRows()).length).toBe(14);
    expect(await count("legacy_purchase_files")).toBe(1);
    expect((await audits("legacy_purchases.%")).length).toBe(1);
  });

  it("--dry-run does all of it and leaves the database as it was, byte for byte; a real run after it then works", async () => {
    const file = bookOf();
    const before = await dump(["legacy_purchases", "legacy_purchase_files", "audit_log", "staff", "suppliers", "supplier_names"]);
    const dry = await runTool(file, ["--dry-run"]);
    expect(dry.code, dry.all).toBe(0);
    expect(dry.out).toMatch(/dry run: everything was done and rolled back; nothing was kept./);
    expect(dry.out).toMatch(/kept: 14/);
    expect(JSON.parse(readFileSync(join(dry.report, "import-report.json"), "utf8")).outcome).toBe("dry-run");
    expect(await dump(["legacy_purchases", "legacy_purchase_files", "audit_log", "staff", "suppliers", "supplier_names"])).toEqual(before);
    const real = await runTool(file);
    expect(real.code).toBe(0);
    expect(await count("legacy_purchases")).toBe(14);
  });

  it("a changed file is refused without --replace-file, naming the old file's fingerprint; nothing changes", async () => {
    const { file } = await imported();
    const changed = bookOf(SHEET.map((l, i) => (i === 0 && l ? { ...l, amount: 121.5 } : l)));
    const before = await dump(["legacy_purchases", "legacy_purchase_files"]);
    const r = await runTool(changed);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/A different file is already in the app/);
    expect(r.err).toContain(`--replace-file ${await fileSha(file)}`);
    expect(r.err).toMatch(/Nothing was written/);
    expect(await dump(["legacy_purchases", "legacy_purchase_files"])).toEqual(before);
  });

  it("with --replace-file the old rows are marked replaced (never deleted), their business and supplier carry over to the rows that match, and the counts are reported", async () => {
    const { file } = await imported();
    const sp = await newSupplier("Maplefield Grocer");
    await setBiz({ spellingKey: KEY.oak, business: "cstore" });
    await setBiz({ spellingKey: KEY.pine, business: "vape" });
    await link({ spellingKey: KEY.grocery, supplierId: sp });
    // the owner fixed row 10's amount and row 23's date, and added a row 24
    const fixed = SHEET.map((l, i) => (l && i === 8 ? { ...l, amount: 1234.57 } : l && i === 21 ? { ...l, date: "2026-05-02" } : l));
    fixed.push({ date: "2026-05-03", supplier: "Oakridge Wholesale", amount: 5, item: null });
    const next = bookOf(fixed);
    const before = await count("legacy_purchases");
    const old = await w.owner.one<{ file_id: string }>("select file_id from ops.legacy_purchase_files");
    const r = await runTool(next, ["--replace-file", await fileSha(file)]);
    expect(r.code, r.all).toBe(0);
    // old rows 4 with a business (oak 3 rows + pine 2 kept... counted below) and the grocery link (2 rows)
    const owed = 3 + 3 + 2; // oak: rows 10, 11, 22 · pine: rows 21, 23 · grocery link: rows 5, 6 (the oak and pine rows have a business; grocery rows a supplier)
    void owed;
    expect(await count("legacy_purchases")).toBe(before + 15); // nothing deleted; fifteen new rows
    const oldFile = await w.owner.one<any>("select superseded_by, superseded_at from ops.legacy_purchase_files where file_id = $1", [old.file_id]);
    expect(oldFile.superseded_by).not.toBeNull();
    expect(oldFile.superseded_at).not.toBeNull();
    expect((await w.owner.query<any>("select 1 from ops.legacy_purchases where file_id = $1 and superseded_at is null", [old.file_id])).length).toBe(0);
    expect((await w.owner.query<any>("select 1 from ops.legacy_purchases where file_id = $1", [old.file_id])).length).toBe(14);
    const live = await liveRows();
    expect(live).toHaveLength(15);
    const byRow = (n: number) => live.find((x) => x.sheet_row === n)!;
    expect(byRow(11).business).toBe("cstore"); // unchanged line: carried
    expect(byRow(10).business).toBeNull(); // its amount changed: not carried
    expect(byRow(21).business).toBe("vape");
    expect(byRow(23).business).toBeNull(); // its date changed: not carried
    expect(byRow(5).supplier_id).toBe(sp);
    expect(byRow(6).supplier_id).toBe(sp);
    expect(byRow(24).business).toBeNull();
    expect(byRow(24).supplier_id).toBeNull();
    // old rows with a choice: oak 3 (10, 11, 22), pine 2 (21, 23), grocery link 2 (5, 6) = 7; two did not carry (10 and 23)
    expect(r.out).toMatch(/business and supplier choices carried over to the matching new rows: 5; not carried over: 2/);
    expect(JSON.parse(readFileSync(join(r.report, "import-report.json"), "utf8")).replaced).toMatchObject({ oldRows: 14, carriedOver: 5, notCarried: 2 });
    // the readers now show the live rows only
    expect((await spellings()).spellings.reduce((n: number, s: any) => n + s.rows, 0)).toBe(15);
    expect(JSON.parse((await audits("legacy_purchases.replace"))[0].after)).toMatchObject({ carriedOver: 5, notCarried: 2 });
    // the same new file again adds nothing; the old file again is "replaced"
    expect((await runTool(next)).out).toMatch(/Nothing was added/);
    expect((await runTool(file)).out).toMatch(/has since been replaced by a newer file/);
    // replacing the old (already replaced) file again is refused
    const third = bookOf(fixed.map((l, i) => (i === 0 && l ? { ...l, amount: 3 } : l)));
    const r3 = await runTool(third, ["--replace-file", await fileSha(file)]);
    expect(r3.err).toMatch(/already been replaced/);
    const r4 = await runTool(third, ["--replace-file", "c".repeat(64)]);
    expect(r4.err).toMatch(/never imported here/);
    expect(await count("legacy_purchases")).toBe(before + 15);
  });

  it("no cell value leaks: the tool's whole output (stdout and stderr, as a real process too), import-report.json and rejects.csv hold none of the fixture's names, notes or amounts", async () => {
    const file = bookOf();
    const real = await runTool(file);
    const dry = await runTool(file, ["--dry-run"]); // "already": still output
    const wrong = await runTool(file, ["--tab", "Nope"]);
    const spawn = (args: string[]) => spawnSync(process.execPath, ["--import", LOADER, "--experimental-strip-types", "--no-warnings", TOOL, ...args], { cwd: OPS, encoding: "utf8", env: { ...process.env, OPS_DB_APP_URL: w.testDb.appUrl } });
    const proc = spawn([file, "--as", ADMIN, "--dry-run", "--report", fresh("proc")]);
    const proc2 = spawn([file, "--as", "S_002", "--report", fresh("proc")]);
    expect(proc.status, proc.stderr).toBe(0);
    expect(proc2.status).toBe(1);
    const files = [real.report, proc.stdout.includes("report:") ? /report: (.*?) \(/.exec(proc.stdout)![1]! : ""].filter(Boolean).flatMap((d) => readdirSync(d).map((f) => readFileSync(join(d, f), "utf8")));
    expect(files.length).toBe(4);
    const everything = [real.all, dry.all, wrong.all, proc.stdout, proc.stderr, proc2.stdout, proc2.stderr, ...files].join("\n");
    for (const s of SECRETS) expect(everything, `"${s}" must not appear`).not.toContain(s);
    // and a failing database statement quotes no value either
    for (const s of SECRETS) expect(JSON.stringify(await audits("legacy_purchases.%"))).not.toContain(s);
  });
});

// ── Business ───────────────────────────────────────────────

describe("which business: a person says, nothing guesses", () => {
  it("every row arrives with none; the readers show them all as not sorted", async () => {
    await imported();
    expect((await liveRows()).every((r) => r.business === null && r.business_set_by === null)).toBe(true);
    const u = await list("unsorted");
    expect(u.totals.count).toBe(14);
    expect(u.counts).toEqual({ unsorted: 14, cstore: 0, vape: 0 });
    expect((await list("cstore")).totals.count).toBe(0);
  });

  it("set for one row, changed, cleared; audited; a row that is not there or a bad value is refused", async () => {
    await imported();
    const id = (await list("unsorted", { spellingKey: KEY.oak })).items[0].id;
    const a = await setBiz({ rowId: id, business: "cstore" }, MANAGER);
    expect(a).toMatchObject({ rows: 1, changed: 1, business: "cstore" });
    expect(await w.owner.one<any>("select business, business_set_by from ops.legacy_purchases where row_id = $1", [id])).toEqual({ business: "cstore", business_set_by: MANAGER });
    expect((await setBiz({ rowId: id, business: "cstore" })).changed).toBe(0);
    await setBiz({ rowId: id, business: "vape" });
    const cleared = await setBiz({ rowId: id, business: null });
    expect(cleared).toMatchObject({ changed: 1, business: null });
    expect((await w.owner.one<any>("select business, business_set_by from ops.legacy_purchases where row_id = $1", [id])).business).toBeNull();
    const log = await audits("legacy_purchase.set_business");
    expect(log.map((x) => x.actor_id)).toEqual([MANAGER, ADMIN, ADMIN]);
    expect(JSON.parse(log[1].before)).toEqual({ business: "cstore" });
    expect(await refused("rpcSetLegacyBusiness", [T[ADMIN], { rowId: "lp" + "0".repeat(24), business: "cstore" }])).toMatch(/No such row/);
    expect(await refused("rpcSetLegacyBusiness", [T[ADMIN], { rowId: id, business: "both" }])).toMatch(/cstore, vape, or null/);
    expect(await refused("rpcSetLegacyBusiness", [T[ADMIN], { business: "vape" }])).toMatch(/one row \(rowId\) or every row written one way/);
    expect(await refused("rpcSetLegacyBusiness", [T[ADMIN], { rowId: id, spellingKey: KEY.oak, business: "vape" }])).toMatch(/not both/);
  });

  it("set for a spelling: all and only its rows, in ONE statement, one audit row with counts and the key; it can be cleared again", async () => {
    await imported();
    const log: string[] = [];
    const counting: Db = { query: (t, p) => (log.push(t), w.db.query(t, p)), one: (t, p) => (log.push(t), w.db.one(t, p)), maybeOne: (t, p) => (log.push(t), w.db.maybeOne(t, p)) };
    const r = await withTransaction(counting, (tx) => legacy.setBusiness(tx, { spellingKey: KEY.grocer, business: "cstore" }, { staffId: ADMIN, role: "admin" }, NOW));
    expect(r).toMatchObject({ rows: 4, changed: 4, business: "cstore" });
    expect(r.message).toBe("4 rows written this way are now cstore.");
    expect(log.filter((s) => /update ops\.legacy_purchases/.test(s))).toHaveLength(1);
    const rows = await liveRows();
    expect(rows.filter((x) => x.business === "cstore").map((x) => x.sheet_row)).toEqual([2, 3, 4, 9]);
    expect(rows.filter((x) => x.business !== "cstore").every((x) => x.business === null)).toBe(true);
    const a = await audits("legacy_purchase.set_business");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ target_type: "legacy_purchase_spellings", target_id: KEY.grocer });
    expect(JSON.parse(a[0].after)).toEqual({ business: "cstore", rows: 4, changed: 4 });
    // a row set by hand to vape is moved by the spelling choice (explicit), and the counts say so
    const one = rows.find((x) => x.sheet_row === 3)!;
    await setBiz({ rowId: one.row_id, business: "vape" });
    expect((await setBiz({ spellingKey: KEY.grocer, business: "cstore" })).message).toBe("4 rows written this way are now cstore (1 changed; the rest already were).");
    expect((await setBiz({ spellingKey: KEY.grocer, business: null })).changed).toBe(4);
    expect((await liveRows()).every((x) => x.business === null)).toBe(true);
    expect(await refused("rpcSetLegacyBusiness", [T[ADMIN], { spellingKey: "nothing-like-this", business: "cstore" }])).toMatch(/No row in the old list is written that way/);
    // "supplier not written" is a spelling like any other
    expect((await setBiz({ spellingKey: KEY.blank, business: "vape" })).rows).toBe(1);
  });

  it("nothing ever sets it by itself: after linking a spelling to a supplier whose confirmed receipts are all vape, the rows are still unsorted", async () => {
    await imported();
    const sp = await newSupplier("Maplefield Grocer");
    await onTheBooks("vape", sp);
    await link({ spellingKey: KEY.grocer, supplierId: sp });
    await link({ spellingKey: KEY.grocery, supplierId: sp });
    expect((await liveRows()).every((x) => x.business === null)).toBe(true);
    expect((await list("unsorted")).totals.count).toBe(14);
    expect((await list("vape")).totals.count).toBe(0);
    // and the import itself: a supplier that already exists does not make the rows anyone's
    expect(await w.owner.one<{ n: number }>("select count(*)::int as n from ops.legacy_purchases where business is not null")).toEqual({ n: 0 });
  });

  it("the unsorted, cstore and vape views never overlap and together are every live row; the totals move with a choice", async () => {
    await imported();
    await setBiz({ spellingKey: KEY.grocer, business: "cstore" });
    await setBiz({ spellingKey: KEY.oak, business: "vape" });
    const [u, c, v] = [await list("unsorted", { limit: 100 }), await list("cstore", { limit: 100 }), await list("vape", { limit: 100 })];
    const ids = [...u.items, ...c.items, ...v.items].map((x: any) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(14);
    expect([u.totals.count, c.totals.count, v.totals.count]).toEqual([7, 4, 3]);
    expect(u.counts).toEqual({ unsorted: 7, cstore: 4, vape: 3 });
    expect(c.totals.totalCents).toBe(12050 + 4510 + 4510 + 999);
    expect(v.totals.totalCents).toBe(123456 - 1525 + 9999);
    expect(u.totals.totalCents + c.totals.totalCents + v.totals.totalCents).toBe(
      KEPT_ROWS.reduce((n, r) => n + Math.round(((SHEET[r - 2] as Line).amount as number) * 100), 0),
    );
  });
});

// ── Supplier links ─────────────────────────────────────────

describe("linking a spelling to a supplier", () => {
  it("links every row of the spelling, keeps the text as typed, learns the spelling (old_list) so the Receipts card's matching finds the supplier for a new draft printed that way", async () => {
    await imported();
    const sp = await newSupplier("Maplefield Grocer");
    expect((await drafts.matchSupplier(w.db, "Maplefield Grocery"))).toBeNull();
    const before = (await liveRows()).map((r) => r.supplier_text);
    const r = await link({ spellingKey: KEY.grocery, supplierId: sp }, MANAGER);
    expect(r).toMatchObject({ rows: 2, spellingAdded: true, supplier: { id: sp, name: "Maplefield Grocer" } });
    expect(r.message).toMatch(/2 rows written this way are linked to Maplefield Grocer\. A receipt printed that way will now be matched to it\. The text as typed stays on each row\./);
    expect((await liveRows()).map((x) => x.supplier_text)).toEqual(before);
    expect((await liveRows()).filter((x) => x.supplier_id === sp).map((x) => x.sheet_row)).toEqual([5, 6]);
    const name = await w.owner.one<any>("select learnt_from, supplier_id, name, added_by from ops.supplier_names where name_key = $1 and removed_at is null", [KEY.grocery]);
    expect(name).toEqual({ learnt_from: "old_list", supplier_id: sp, name: "Maplefield Grocery", added_by: MANAGER });
    expect(await drafts.matchSupplier(w.db, "MAPLEFIELD  grocery")).toEqual({ id: sp, displayName: "Maplefield Grocer" });
    // a spelling the supplier already has (its own name) is linked, and no second spelling is made
    const same = await link({ spellingKey: KEY.grocer, supplierId: sp });
    expect(same).toMatchObject({ rows: 4, spellingAdded: false });
    expect((await w.owner.query("select 1 from ops.supplier_names where name_key = $1", [KEY.grocer])).length).toBe(1);
    const a = await audits("legacy_purchase.link_supplier");
    expect(JSON.parse(a[0].after)).toMatchObject({ supplierId: sp, rows: 2, spellingAdded: true });
    expect(a[0].target_id).toBe(KEY.grocery);
    expect((await audits("supplier_name.add")).length).toBeGreaterThan(0);
    // the spellings table shows the link
    const s = (await spellings()).spellings;
    expect(s.find((x: any) => x.key === KEY.grocery)).toMatchObject({ supplier: { id: sp, name: "Maplefield Grocer" }, partlyLinked: false, rows: 2 });
  });

  it("refuses a spelling that already belongs to another supplier, in the Receipts card's own words; nothing is linked", async () => {
    await imported();
    const a = await newSupplier("Maplefield Grocer");
    const b = await newSupplier("Another Supplier");
    await link({ spellingKey: KEY.grocery, supplierId: a });
    const said = await refused("rpcLinkLegacySupplier", [T[ADMIN], { spellingKey: KEY.grocery, supplierId: b }]);
    expect(said).toMatch(/^"Maplefield Grocery" is already a spelling of Maplefield Grocer: a spelling belongs to one supplier\./);
    // The Receipts card's "Untick it." is about a tick box on its confirm sheet; here there is none.
    expect(said).not.toContain("Untick");
    expect(said).toContain("Link this spelling to that supplier instead, or leave it unlinked. Nothing was linked.");
    expect((await liveRows()).filter((x) => x.supplier_id === b)).toHaveLength(0);
    expect(await refused("rpcLinkLegacySupplier", [T[ADMIN], { spellingKey: KEY.grocery, supplierId: "sp" + "0".repeat(20) }])).toMatch(/No such supplier/);
    await ok("rpcUpdateReceiptSupplier", [T[ADMIN], { id: b, active: false }]);
    expect(await refused("rpcLinkLegacySupplier", [T[ADMIN], { spellingKey: KEY.pine, supplierId: b }])).toMatch(/not an active supplier/);
    expect(await refused("rpcLinkLegacySupplier", [T[ADMIN], { spellingKey: KEY.blank, supplierId: a }])).toMatch(/nothing to link/);
    expect(await refused("rpcLinkLegacySupplier", [T[ADMIN], { spellingKey: "no such", supplierId: a }])).toMatch(/No row in the old list/);
  });

  it("unlinking takes the supplier off the rows, leaves the learnt spelling in place, and says so", async () => {
    await imported();
    const sp = await newSupplier("Maplefield Grocer");
    await link({ spellingKey: KEY.grocery, supplierId: sp });
    const r = await link({ spellingKey: KEY.grocery, supplierId: null });
    expect(r.supplier).toBeNull();
    expect(r.message).toBe("2 rows unlinked. The spelling stays a known spelling of Maplefield Grocer, so receipts printed that way are still matched to it.");
    expect((await liveRows()).every((x) => x.supplier_id === null)).toBe(true);
    expect((await w.owner.one<any>("select learnt_from from ops.supplier_names where name_key = $1 and removed_at is null", [KEY.grocery])).learnt_from).toBe("old_list");
    expect(await drafts.matchSupplier(w.db, "Maplefield Grocery")).toMatchObject({ id: sp });
    expect((await link({ spellingKey: KEY.grocery, supplierId: null })).message).toBe("It was not linked to a supplier.");
  });

  it("a spelling longer than a supplier's spelling may be is refused, not cut", async () => {
    const long = "L".repeat(130);
    await imported([{ date: "2026-03-02", supplier: long, amount: 1, item: null }]);
    const sp = await newSupplier("Some Supplier");
    expect(await refused("rpcLinkLegacySupplier", [T[ADMIN], { spellingKey: normalise(long), supplierId: sp }])).toMatch(/longer than 120 characters/);
  });
});

// ── The readers ────────────────────────────────────────────

describe("the readers", () => {
  it("the spellings table: biggest first, with rows, total, how they are sorted and who they are linked to", async () => {
    await imported();
    await setBiz({ spellingKey: KEY.oak, business: "cstore" });
    await setBiz({ rowId: (await list("cstore", { spellingKey: KEY.oak })).items[0].id, business: "vape" });
    const s = await spellings();
    expect(s.imported).toBe(true);
    expect(s.canEdit).toBe(true);
    expect(s.label).toBe("from the old list: no original on file");
    expect(s.files).toMatchObject([{ name: "purchases.xlsx", tab: "Purchase Invoices", rowsKept: 14, rowsRejected: 7 }]);
    const keys = s.spellings.map((x: any) => x.key);
    expect(keys[0]).toBe(KEY.grocer);
    expect(s.spellings.map((x: any) => x.rows)).toEqual([...s.spellings.map((x: any) => x.rows)].sort((a: number, b: number) => b - a));
    expect(s.spellings.find((x: any) => x.key === KEY.grocer)).toMatchObject({ rows: 4, totalCents: 12050 + 4510 + 4510 + 999, variants: 4, unsorted: 4, cstore: 0, vape: 0, supplier: null });
    expect(s.spellings.find((x: any) => x.key === KEY.oak)).toMatchObject({ rows: 3, totalCents: 123456 - 1525 + 9999, cstore: 2, vape: 1, unsorted: 0 });
    expect(s.spellings.find((x: any) => x.key === KEY.blank)).toMatchObject({ rows: 1, text: "", totalCents: 775 });
    expect(s.spellings.reduce((n: number, x: any) => n + x.rows, 0)).toBe(14);
    const grocer = s.spellings.find((x: any) => x.key === KEY.grocer);
    expect(["Maplefield Grocer", "Maplefield  Grocer ", "maplefield grocer", "Maplefield-Grocer"]).toContain(grocer.text);
  });

  it("the rows: newest date first, filters (dates, spelling, text), a stable cursor, totals in cents equal to the sum of the pages; a business set between two pages loses and repeats nothing", async () => {
    await imported(manyLines(40));
    const all: any[] = [];
    let before: string | undefined;
    let sumCents = 0;
    let first: any;
    for (let page = 0; page < 20; page++) {
      const r = await list("unsorted", { limit: 7, ...(before ? { before } : {}) });
      first ??= r;
      all.push(...r.items);
      sumCents += r.items.reduce((n: number, x: any) => n + x.amountCents, 0);
      if (page === 1) await setBiz({ rowId: r.items[3].id, business: "cstore" }); // between two pages: one of the rows already shown
      if (page === 2) await setBiz({ rowId: r.next ? r.items[0].id : r.items[0].id, business: "vape" });
      if (!r.next) break;
      before = r.next;
    }
    expect(new Set(all.map((x) => x.id)).size).toBe(all.length); // no row twice
    const dates = all.map((x) => x.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(all.length).toBe(40);
    expect(first.totals).toEqual({ count: 40, totalCents: sumCents });
    // the rows set aside moved views; each view's total equals the sum of its own pages
    for (const v of ["cstore", "vape", "unsorted"]) {
      let n = 0;
      let cents = 0;
      let cur: string | undefined;
      let totals: any;
      for (;;) {
        const r = await list(v, { limit: 5, ...(cur ? { before: cur } : {}) });
        totals = r.totals;
        n += r.items.length;
        cents += r.items.reduce((a: number, x: any) => a + x.amountCents, 0);
        if (!r.next) break;
        cur = r.next;
      }
      expect(totals).toEqual({ count: n, totalCents: cents });
    }
    const ranged = await list("unsorted", { from: "2026-02-01", to: "2026-03-31", limit: 100 });
    expect(ranged.items.every((x: any) => x.date >= "2026-02-01" && x.date <= "2026-03-31")).toBe(true);
    expect((await list("unsorted", { spellingKey: "shop3", limit: 100 })).items.every((x: any) => x.spellingKey === "shop3")).toBe(true);
    const found = await list("unsorted", { text: "NOTE 3", limit: 100 });
    expect(found.items.length).toBeGreaterThan(0);
    expect(found.items.every((x: any) => /note 3/i.test(x.note))).toBe(true);
    expect((await list("unsorted", { text: "100%", limit: 100 })).totals.count).toBe(0); // % is not a wildcard
    expect((await list("unsorted", { limit: 1000 })).items.length).toBe(Math.min(100, (await list("unsorted", { limit: 1000 })).items.length));
  });

  it("each row carries its date, supplier as typed, linked supplier, amount, note, business and spreadsheet row; hostile text comes back as typed", async () => {
    await imported();
    const sp = await newSupplier("Oakridge Wholesale Ltd");
    await link({ spellingKey: KEY.oak, supplierId: sp });
    const r = await list("unsorted", { spellingKey: KEY.oak });
    const row = r.items.find((x: any) => x.sheetRow === 10);
    expect(row).toMatchObject({ date: "2026-04-01", supplier: "Oakridge Wholesale", amount: "1234.56", amountCents: 123456, note: "<script>alert('x')</script>", business: null, linked: { id: sp, name: "Oakridge Wholesale Ltd" } });
    expect(r.items.find((x: any) => x.sheetRow === 11).note).toBe('=HYPERLINK("http://example.invalid","click")');
    expect(r.items.find((x: any) => x.sheetRow === 11).amount).toBe("-15.25");
    expect(r.label).toBe("from the old list: no original on file");
    expect(r.imported).toBe(true);
    expect(await refused("rpcGetLegacyPurchases", [T[ADMIN], { business: "both" }])).toMatch(/Choose cstore, vape or not sorted/);
    expect(await refused("rpcGetLegacyPurchases", [T[ADMIN], { business: "vape", from: "last week" }])).toMatch(/YYYY-MM-DD/);
    expect(await refused("rpcGetLegacyPurchases", [T[ADMIN], { business: "vape", before: "zzz" }])).toMatch(/cannot be found/);
  });

  it("before anything is imported they say so", async () => {
    const s = await spellings();
    expect(s).toMatchObject({ imported: false, spellings: [], files: [] });
    expect(await list("unsorted")).toMatchObject({ imported: false, items: [], totals: { count: 0, totalCents: 0 } });
  });
});

// ── Never among the receipts ───────────────────────────────

let serial = 0;
async function original(): Promise<string> {
  w.clock.now = new Date(w.clock.now.getTime() + 1000);
  const bytes = new TextEncoder().encode(`%PDF-1.4\n% fictional receipt ${++serial} ${Math.random()}\n%%EOF\n`);
  const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const r = await withTransaction(w.db, (tx) =>
    originals.add(tx, bucketStorage(w.bucket), { bytes, sha256, contentType: "application/pdf", business: null, source: "upload", fileName: `r${serial}.pdf`, note: null }, { staffId: EMPLOYEE, role: "employee" }, w.clock.now),
  );
  return (r.record as { id: string }).id;
}
const FULL = { supplier: { name: "Fictional Grocer" }, invoice_number: "FG-1001", date: "2026-11-20", paid: { how: "cash" }, amounts: { subtotal: "10.00", hst: "1.30", total: "11.30" }, kind: "supplies" };
async function onTheBooks(business: "cstore" | "vape", supplierId: string): Promise<void> {
  const id = await original();
  const full = { ...FULL, invoice_number: `FG-${++serial}` };
  await ok("rpcEnterReceiptDraft", [T[MANAGER], { original_id: id, ...full }]);
  const rv = await ok("rpcGetReceiptReview", [T[MANAGER], { id }]);
  await ok("rpcSaveReceiptCorrection", [T[MANAGER], { original_id: id, draft_id: rv.draft.id, business, supplier_id: supplierId, ...full }]);
  const rv2 = await ok("rpcGetReceiptReview", [T[MANAGER], { id }]);
  await ok("rpcConfirmReceipt", [T[MANAGER], { originalId: id, draftId: rv2.draft.id, learnSigns: [], rememberSpelling: false }]);
}

describe("never among the receipts", () => {
  it("the books' rows and totals are identical before and after an import, a business choice and a link", async () => {
    const fg = await newSupplier("Fictional Grocer");
    await onTheBooks("cstore", fg);
    await onTheBooks("vape", fg);
    const books = async () => JSON.stringify([await ok("rpcGetReceiptBooks", [T[ADMIN], { business: "cstore" }]), await ok("rpcGetReceiptBooks", [T[ADMIN], { business: "vape" }]), await ok("rpcGetReceiptInbox", [T[ADMIN], { status: "confirmed" }])]);
    const before = await books();
    expect(JSON.parse(before)[0].totals.count).toBe(1);
    const receiptsBefore = await count("purchase_receipts");
    await imported();
    await setBiz({ spellingKey: KEY.oak, business: "cstore" });
    await setBiz({ spellingKey: KEY.pine, business: "vape" });
    const sp = await newSupplier("Oakridge Wholesale");
    await link({ spellingKey: KEY.oak, supplierId: sp });
    expect(await books()).toBe(before);
    expect(await count("purchase_receipts")).toBe(receiptsBefore);
    expect(await count("receipt_originals")).toBe(2);
  });

  it("till_sessions, sales, payments, attendance, staff and every receipt table are identical before and after an import and a business choice", async () => {
    const fg = await newSupplier("Fictional Grocer");
    await onTheBooks("cstore", fg);
    const tables = ["till_sessions", "sales", "payments", "payment_items", "attendance", "staff", "config", ...RECEIPT_TABLES, "assistant_keys"];
    const before = await dump(tables);
    await imported();
    await setBiz({ spellingKey: KEY.grocer, business: "vape" });
    await setBiz({ rowId: (await liveRows())[0].row_id, business: "cstore" });
    expect(await dump(tables)).toEqual(before);
  });

  it("no assistant tool reads the table: no MCP source mentions it, and no tool is named for it", () => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f)));
    };
    walk(join(OPS, "src", "mcp"));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/legacy|old purchase|old_list/i);
    expect(TOOLS.map((t) => t.name).join(" ")).not.toMatch(/legacy|old/i);
    // and the receipts' own readers never touch it: the books query does not name it
    expect(readFileSync(join(OPS, "src", "receipts", "review.ts"), "utf8")).not.toMatch(/legacy_purchase/);
  });
});

// ── Who may ────────────────────────────────────────────────

describe("who may", () => {
  const CALLS: Array<[string, (t: string | null) => unknown[], string[]]> = [
    ["rpcGetLegacyPurchases", (t) => [t, { business: "unsorted" }], ["admin", "manager", "payroll_admin"]],
    ["rpcGetLegacySpellings", (t) => [t], ["admin", "manager", "payroll_admin"]],
    ["rpcSetLegacyBusiness", (t) => [t, { spellingKey: KEY.oak, business: "cstore" }], ["admin", "manager"]],
    ["rpcLinkLegacySupplier", (t) => [t, { spellingKey: KEY.oak, supplierId: null }], ["admin", "manager"]],
  ];
  const WHO: Array<[string, string]> = [["admin", ADMIN], ["manager", MANAGER], ["payroll_admin", PAYROLL], ["employee", EMPLOYEE]];
  it("every RPC, per role: the three read, admin and manager change, an employee gets nothing; no token gets nothing", async () => {
    await imported();
    for (const [name, args, allowed] of CALLS) {
      for (const [role, id] of WHO) {
        const r = await rpc(name, args(T[id] as string));
        expect(r.ok, `${name} as ${role}`).toBe(allowed.includes(role));
      }
      expect((await rpc(name, args(null))).ok, `${name} with no token`).toBe(false);
      expect((await rpc(name, args("not-a-token"))).ok).toBe(false);
    }
    // what an employee is told carries no row
    const msg = await refused("rpcGetLegacyPurchases", [T[EMPLOYEE], { business: "unsorted" }]);
    expect(msg).not.toMatch(/Maplefield|Oakridge/);
    // the payroll admin could read but changed nothing: only the admin's and the manager's choices are on the rows
    expect((await liveRows()).filter((x) => x.business_set_by === PAYROLL || x.business_set_by === EMPLOYEE)).toHaveLength(0);
  });
  it("identity and role come from the session: a planted role, actorId or staffId changes nothing", async () => {
    await imported();
    const r = await rpc("rpcSetLegacyBusiness", [T[PAYROLL], { spellingKey: KEY.oak, business: "cstore", role: "admin", actorId: ADMIN, staffId: ADMIN }]);
    expect(r.ok).toBe(false);
    const e = await rpc("rpcGetLegacyPurchases", [T[EMPLOYEE], { business: "unsorted", role: "admin", actorId: ADMIN }]);
    expect(e.ok).toBe(false);
    const m = await ok("rpcSetLegacyBusiness", [T[MANAGER], { spellingKey: KEY.oak, business: "cstore", actorId: ADMIN, staffId: ADMIN, role: "admin" }]);
    expect(m.changed).toBe(3);
    expect((await audits("legacy_purchase.set_business"))[0].actor_id).toBe(MANAGER);
    expect((await w.owner.one<any>("select business_set_by from ops.legacy_purchases where spelling_key = $1 limit 1", [KEY.oak])).business_set_by).toBe(MANAGER);
  });
  it("the module itself refuses a role the router would have stopped", async () => {
    await imported();
    await expect(withTransaction(w.db, (tx) => legacy.setBusiness(tx, { spellingKey: KEY.oak, business: "cstore" }, { staffId: EMPLOYEE, role: "employee" }, NOW))).rejects.toThrow(/Only an admin or a manager/);
    await expect(legacy.getPurchases(w.db, { business: "unsorted" }, { staffId: EMPLOYEE, role: "employee" })).rejects.toThrow(/Only an admin, a manager or a payroll admin/);
    await expect(withTransaction(w.db, (tx) => legacy.linkSupplier(tx, { spellingKey: KEY.oak, supplierId: null }, { staffId: PAYROLL, role: "payroll_admin" }, NOW))).rejects.toThrow(/Only an admin or a manager/);
  });
});

// ── The database ───────────────────────────────────────────

describe("the database itself", () => {
  it("the app role cannot delete either table, nor change a figure, a date, a text or a file; it may set the business, the link and the superseded mark", async () => {
    await imported();
    const id = (await liveRows())[0].row_id;
    for (const sql of [
      "delete from ops.legacy_purchases",
      "delete from ops.legacy_purchase_files",
      "update ops.legacy_purchases set amount = 1",
      "update ops.legacy_purchases set purchase_date = purchase_date",
      "update ops.legacy_purchases set supplier_text = 'x'",
      "update ops.legacy_purchases set spelling_key = 'x'",
      "update ops.legacy_purchases set note = 'x'",
      "update ops.legacy_purchases set sheet_row = 99",
      "update ops.legacy_purchases set file_id = file_id",
      "update ops.legacy_purchase_files set file_name = 'x'",
      "update ops.legacy_purchase_files set rows_kept = 1",
      "update ops.legacy_purchase_files set file_sha256 = '\\x00'",
    ]) await expect(w.db.query(sql), sql).rejects.toThrow(/permission denied/);
    await w.db.query("update ops.legacy_purchases set business = 'vape', business_set_by = 'S_001', business_set_at = $2 where row_id = $1", [id, NOW]);
    // the checks: a business with nobody who set it, a date before 2000, a repeated sheet row, a file that adds up wrongly
    await expect(w.db.query("update ops.legacy_purchases set business = 'cstore', business_set_by = null, business_set_at = null where row_id = $1", [id])).rejects.toThrow(/legacy_purchases_business_set/);
    await expect(w.owner.query("update ops.legacy_purchases set purchase_date = '1999-12-31' where row_id = $1", [id])).rejects.toThrow(/check/);
    await expect(w.owner.query("insert into ops.legacy_purchases (row_id, file_id, sheet_row, purchase_date, supplier_text, spelling_key, amount, note) select 'lp' || repeat('1', 24), file_id, sheet_row, purchase_date, '', '', 1, '' from ops.legacy_purchases where row_id = $1", [id])).rejects.toThrow(/legacy_purchases_file_row/);
    await expect(w.owner.query("update ops.legacy_purchase_files set rows_kept = rows_kept + 1")).rejects.toThrow(/legacy_purchase_files_counts/);
    await expect(w.owner.query("insert into ops.legacy_purchase_files (file_id, file_sha256, file_name, tab, rows_read, rows_kept, rows_rejected, imported_by, imported_at) values ('lf' || repeat('2', 20), '\\x00', 'x', 't', 0, 0, 0, 'S_001', now())")).rejects.toThrow(/check/);
  });
  it("a spelling's learnt_from accepts old_list and still refuses anything else; the new tables are listed as later Operations-only tables", async () => {
    expect(LATER_OPS_TABLES).toEqual(expect.arrayContaining(["legacy_purchase_files", "legacy_purchases"]));
    const sp = await newSupplier("Some Supplier");
    await expect(w.owner.query("insert into ops.supplier_names (name_id, supplier_id, name, name_key, learnt_from, added_by, added_at) values ('sn' || repeat('3', 20), $1, 'z', 'z', 'guess', 'S_001', now())", [sp])).rejects.toThrow(/supplier_names_learnt_from_check/);
    await w.owner.query("insert into ops.supplier_names (name_id, supplier_id, name, name_key, learnt_from, added_by, added_at) values ('sn' || repeat('3', 20), $1, 'z', 'z', 'old_list', 'S_001', now())", [sp]);
  });
  it("audit rows: the import says it was the owner's local tool and holds counts only; a business choice and a link hold counts and the key, never one entry a row", async () => {
    await imported();
    const sp = await newSupplier("Oakridge Wholesale");
    await setBiz({ spellingKey: KEY.oak, business: "cstore" });
    await link({ spellingKey: KEY.oak, supplierId: sp });
    const imp = await audits("legacy_purchases.import");
    expect(imp).toHaveLength(1);
    expect(imp[0]).toMatchObject({ actor_id: ADMIN, target_type: "legacy_purchase_files" });
    expect(imp[0].details).toMatch(/owner's local import tool .* their own computer; the staff id is the one given with --as/);
    expect(JSON.parse(imp[0].after)).toMatchObject({ rowsRead: 21, rowsKept: 14, rowsRejected: 7, tab: "Purchase Invoices" });
    expect(await audits("legacy_purchase.%")).toHaveLength(2);
    expect(await audits("legacy_purchases.%")).toHaveLength(1);
  });
  it("the nightly copy takes both tables, with rows (a superseded file too), and a restore reads every one back", async () => {
    const { file } = await imported();
    const sp = await newSupplier("Maplefield Grocer");
    await setBiz({ spellingKey: KEY.oak, business: "cstore" });
    await link({ spellingKey: KEY.grocery, supplierId: sp });
    const next = bookOf(SHEET.map((l, i) => (l && i === 0 ? { ...l, amount: 121.5 } : l)));
    expect((await runTool(next, ["--replace-file", await fileSha(file)])).code).toBe(0);
    expect(await count("legacy_purchase_files")).toBe(2);
    const bucket = memoryBackupBucket();
    const res = await copyNow(w.testDb, bucket);
    const dir = downloadFolder(bucket, res.folder);
    const target = await createTestDb();
    try {
      const report = await restoreNightly({ dir, databaseUrl: target.ownerUrl, out: () => undefined });
      expect(report.outcome).toBe("committed");
      const only = ["legacy_purchase_files", "legacy_purchases", "suppliers", "supplier_names"];
      const got = await dumpAll(target.ownerUrl, only);
      expect(got["legacy_purchases"]!.length).toBe(28);
      expect(got).toEqual(await dumpAll(w.testDb.ownerUrl, only));
    } finally {
      await target.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

void (null as unknown as Tx);
