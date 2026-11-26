// The reconcile comparison (card P4-03), as pure functions over a small made-up contract:
// every kind of difference is planted, one at a time, and must be reported; every thing the
// import report explains must not be. A few figures are chosen so that floating-point
// addition, a blank read as 0, a sums-only comparison, or an unchecked import report would
// each get a test wrong.
import { describe, expect, it } from "vitest";
import {
  compareExportToDatabase,
  formatUnits,
  LIST_CAP,
  parseImportReport,
  reportBelongsToExport,
  reportJson,
  reportMarkdown,
  ReconcileRefused,
  summaryLines,
  toUnits,
  torontoDay,
  type DbSnapshot,
  type Diff,
  type ImportEvidence,
  type ReconcileResult,
  type SheetTabIn,
} from "../src/cutover/compare";
import { parseContract } from "../src/import/sheet-to-db";

const CONTRACT = parseContract(`
create table ops.config (key text primary key, value text, description text);
create table ops.staff (
  staff_id text primary key,
  name text not null,
  hourly_rate numeric(10,4),
  active boolean not null,
  role text not null check (role in ('admin', 'employee')),
  start_date date,
  created_at timestamptz,
  notes text
);
create table ops.till_sessions (
  session_id text primary key,
  date date not null,
  status text not null check (status in ('open', 'closed')),
  closing_cash_counted numeric(12,2),
  expected_cash numeric(12,2),
  store_id text not null default 'store_main' references ops.stores (id)
);
create table ops.sales (
  sales_id text primary key,
  staff_id text not null,
  date date not null,
  cash_sales numeric(12,2),
  card_total numeric(12,2),
  tax_basis integer,
  status text check (status in ('open', 'closed', 'validated')),
  store_id text not null default 'store_main' references ops.stores (id)
);
create table ops.payments (
  payment_id text primary key,
  paid_on date not null,
  total_amount numeric(12,2) not null,
  store_id text not null default 'store_main' references ops.stores (id)
);
-- Left out, and why
--    tab    shopping_list    deprecated: shopping list
--    column staff.login_code the plaintext PIN
`);
const TABLES = ["config", "staff", "till_sessions", "sales", "payments"];
const COLS: Record<string, string[]> = Object.fromEntries(TABLES.map((t) => [t, (CONTRACT.tables[t]?.columns ?? []).map((c) => c.name).filter((c) => c !== "store_id")]));

type Obj = Record<string, unknown>;
const HASH = `pbkdf2-sha256$100000$${Buffer.alloc(16, 7).toString("base64")}$${Buffer.alloc(32, 9).toString("base64")}`;

interface World {
  /** Sheet rows by table, as objects keyed by column (a missing key is a blank cell). */
  sheet?: Record<string, Obj[]>;
  /** Database rows by table, as text values (a missing key is NULL). */
  db?: Record<string, Record<string, string | null>[]>;
  evidence?: Partial<ImportEvidence>;
  /** Tables whose database rows are in `seq` order. */
  seq?: string[];
  extraTabs?: SheetTabIn[];
}

const allEmpty = (cells: unknown[]): boolean => cells.every((c) => c === "" || c === null || c === undefined);

/** The comparison of a world; the honest import report is derived from the world unless overridden. */
function run(w: World): ReconcileResult {
  const sheet = w.sheet ?? {};
  const tabs: SheetTabIn[] = TABLES.map((t) => {
    const header = t === "staff" ? [...(COLS[t] as string[]), "login_code"] : (COLS[t] as string[]);
    const rows = (sheet[t] ?? []).map((o) => header.map((h) => (h in o ? (o[h] as unknown) : "")));
    return { name: t, header, rows };
  });
  const db: DbSnapshot = { tables: {}, allTables: [...TABLES], opsOnlyCounts: {} };
  for (const t of TABLES) {
    const cols = [...(COLS[t] as string[]), ...(CONTRACT.tables[t]?.columns.some((c) => c.name === "store_id") ? ["store_id"] : []), ...(t === "staff" ? ["pin_hash"] : [])];
    const rows = (w.db?.[t] ?? []).map((o) => {
      const r: Record<string, string | null> = {};
      for (const c of cols) r[c] = c in o ? (o[c] as string | null) : c === "store_id" ? "store_main" : null;
      return r;
    });
    db.tables[t] = { present: true, columns: cols, hasSeq: (w.seq ?? []).includes(t), rows };
  }
  const given = w.evidence ?? {};
  const rejects = given.rejects ?? [];
  const rekeyed = given.rekeyed ?? [];
  const leftOutRows = given.leftOutRows ?? [];
  const configKeysLeftOut = given.configKeysLeftOut ?? [];
  const staffTab = tabs.find((t) => t.name === "staff") as SheetTabIn;
  const codeAt = staffTab.header.indexOf("login_code");
  const staffIdAt = staffTab.header.indexOf("staff_id");
  const coded = staffTab.rows.filter((r) => String(r[codeAt] ?? "").trim() !== "");
  const evidence: ImportEvidence = {
    mode: "import",
    outcome: "committed",
    workbookSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    tabSha256: {},
    acceptRejects: null,
    openSessionsBlank: false,
    rowsWithClosingFigures: 0,
    tables: tabs.map((t) => ({
      table: t.name,
      tabRows: t.rows.length,
      loaded: (db.tables[t.name]?.rows ?? []).length,
      rejected: new Set(rejects.filter((r) => r.tab === t.name).map((r) => r.row)).size,
      reKeyed: rekeyed.filter((r) => r.table === t.name).length,
      blankKey: t.rows.filter(allEmpty).length,
      leftOut: leftOutRows.filter((r) => r.table === t.name).length + (t.name === "config" ? configKeysLeftOut.length : 0),
    })),
    rejects,
    rekeyed,
    leftOutRows,
    configKeysLeftOut,
    pinsHashed: coded.length,
    pinsBlank: staffTab.rows.filter((r) => String(r[codeAt] ?? "").trim() === "").map((r) => ({ staffId: String(r[staffIdAt]), row: 3 + staffTab.rows.indexOf(r) })),
    skippedTabs: [],
    rejectCount: rejects.length,
    ...given,
  };
  if (given.tables) evidence.tables = given.tables;
  return compareExportToDatabase({ contract: CONTRACT, tabs: [...tabs, ...(w.extraTabs ?? [])], db, evidence });
}

const emptyEvidence = (): ImportEvidence => ({
  mode: "import",
  outcome: "committed",
  workbookSha256: "",
  manifestSha256: "",
  tabSha256: {},
  acceptRejects: null,
  openSessionsBlank: false,
  rowsWithClosingFigures: 0,
  tables: TABLES.map((t) => ({ table: t, tabRows: 0, loaded: 0, rejected: 0, reKeyed: 0, blankKey: 0, leftOut: 0 })),
  rejects: [],
  rekeyed: [],
  leftOutRows: [],
  configKeysLeftOut: [],
  pinsHashed: 0,
  pinsBlank: [],
  skippedTabs: [],
  rejectCount: 0,
});

const sale = (n: number, extra: Obj = {}): Obj => ({ sales_id: `S${n}`, staff_id: "S_001", date: "2026-11-02", cash_sales: 10, ...extra });
const dbSale = (n: number, extra: Record<string, string | null> = {}): Record<string, string | null> => ({ sales_id: `S${n}`, staff_id: "S_001", date: "2026-11-02", cash_sales: "10.00", ...extra });
const diffs = (r: ReconcileResult, table?: string): Diff[] => [...r.tables.flatMap((t) => t.differences), ...r.otherDifferences].filter((d) => table === undefined || d.table === table);
const kinds = (r: ReconcileResult, table?: string): string[] => diffs(r, table).map((d) => d.kind);
const everything = (r: ReconcileResult): string => JSON.stringify(reportJson(r, { startedAt: "t", workbookSha256: "w", manifestSha256: "m" })) + reportMarkdown(r, { startedAt: "t", workbookSha256: "w", manifestSha256: "m" }) + summaryLines(r).join("\n");

describe("exact arithmetic", () => {
  it("reads a figure exactly, in units of the column's scale, and refuses more decimals than it holds", () => {
    expect(toUnits("12.5", 2)).toBe(1250n);
    expect(toUnits("12.50", 2)).toBe(1250n);
    expect(toUnits("-0.07", 2)).toBe(-7n);
    expect(toUnits("1e-7", 9)).toBe(100n);
    expect(toUnits("1.5e2", 2)).toBe(15000n);
    expect(toUnits("12.505", 2)).toBeNull();
    expect(toUnits("1e-7", 2)).toBeNull();
    expect(toUnits("12.500", 2)).toBe(1250n);
    expect(toUnits("abc", 2)).toBeNull();
    expect(toUnits("", 2)).toBeNull();
    expect(toUnits("5", 0)).toBe(5n);
    expect(toUnits("5.5", 0)).toBeNull();
    expect(formatUnits(1250n, 2)).toBe("12.50");
    expect(formatUnits(-7n, 2)).toBe("-0.07");
    expect(formatUnits(5n, 0)).toBe("5");
    expect(formatUnits(0n, 4)).toBe("0.0000");
  });

  it("a Toronto day is the day on a Toronto wall clock, summer and winter", () => {
    expect(torontoDay(new Date("2026-11-21T03:00:00Z"))).toBe("2026-11-20"); // 22:00 EST the day before
    expect(torontoDay(new Date("2026-11-21T05:00:00Z"))).toBe("2026-11-21");
    expect(torontoDay(new Date("2026-07-01T03:30:00Z"))).toBe("2026-06-30"); // 23:30 EDT the day before
    expect(torontoDay(new Date("2026-07-01T04:00:00Z"))).toBe("2026-07-01");
  });
});

describe("a Sheet and a database that agree", () => {
  it("reports no difference, and the monthly figures are the exact sums", () => {
    const r = run({ sheet: { sales: [sale(1, { cash_sales: 4417.25 }), sale(2, { cash_sales: "0.75" })] }, db: { sales: [dbSale(1, { cash_sales: "4417.25" }), dbSale(2, { cash_sales: "0.75" })] } });
    expect(diffs(r)).toEqual([]);
    expect(r.unexplained).toBe(0);
    const sales = r.tables.find((t) => t.table === "sales")!;
    expect(sales.dateColumn).toBe("date");
    expect(sales.months).toHaveLength(1);
    expect(sales.months[0]).toMatchObject({ month: "2026-11", sheetRows: 2, dbRows: 2 });
    expect(sales.months[0]!.columns["cash_sales"]).toMatchObject({ sheetSum: "4418.00", dbSum: "4418.00", diff: "0.00" });
    expect(sales.comparedColumns).toContain("cash_sales");
    expect(sales.sumColumns).toEqual(["cash_sales", "card_total", "tax_basis"]);
  });

  it("figures chosen so that floating-point addition disagrees with itself: sums in cents agree, however the rows are ordered", () => {
    // 0.1 + 0.2 + 0.3 is 0.6000000000000001 one way and 0.6 the other: the database reads in key order, the Sheet in tab order.
    const sheet = [0.1, 0.2, 0.3].map((v, i) => ({ payment_id: `P${i + 1}`, paid_on: "2026-11-02", total_amount: v }));
    const db = [3, 2, 1].map((n) => ({ payment_id: `P${n}`, paid_on: "2026-11-02", total_amount: ["0.10", "0.20", "0.30"][n - 1] as string }));
    const r = run({ sheet: { payments: sheet }, db: { payments: db } });
    expect(diffs(r)).toEqual([]);
    expect(r.tables.find((t) => t.table === "payments")!.months[0]!.columns["total_amount"]).toMatchObject({ sheetSum: "0.60", dbSum: "0.60", diff: "0.00" });
    // many x.x5 figures, summed in opposite orders
    const many = Array.from({ length: 400 }, (_, i) => (i * 7 + 5) / 100 + 0.05);
    const cents = (v: number): string => (Math.round(v * 100) / 100).toFixed(2);
    const sheet2 = many.map((v, i) => ({ payment_id: `P${String(i).padStart(4, "0")}`, paid_on: "2026-11-02", total_amount: Math.round(v * 100) / 100 }));
    const db2 = [...sheet2].reverse().map((o) => ({ payment_id: o.payment_id, paid_on: "2026-11-02", total_amount: cents(o.total_amount) }));
    const r2 = run({ sheet: { payments: sheet2 }, db: { payments: db2 } });
    expect(diffs(r2)).toEqual([]);
  });

  it("a Date cell is its Toronto day, a text id is trimmed, an enum is read without case, a blank active is false", () => {
    const r = run({
      sheet: {
        staff: [{ staff_id: " S_9 ", name: "Pat", active: "", role: " Employee ", start_date: new Date("2026-11-21T03:00:00Z"), created_at: new Date("2026-11-21T03:00:00.250Z") }],
      },
      db: { staff: [{ staff_id: "S_9", name: "Pat", active: "false", role: "employee", start_date: "2026-11-20", created_at: "2026-11-21T03:00:00.250000Z" }] },
    });
    expect(diffs(r, "staff").filter((d) => d.kind !== "pin_hash")).toEqual([]);
  });
});

describe("a difference planted one at a time is reported", () => {
  const base = { sheet: { sales: [sale(1), sale(2, { cash_sales: 20.5 }), sale(3, { cash_sales: 30 })] }, db: { sales: [dbSale(1), dbSale(2, { cash_sales: "20.50" }), dbSale(3, { cash_sales: "30.00" })] } };
  const withDb = (mut: (rows: Record<string, string | null>[]) => void): ReconcileResult => {
    const rows = structuredClone(base.db.sales);
    mut(rows);
    return run({ sheet: base.sheet, db: { sales: rows } });
  };

  it("the control: the base world has no difference", () => {
    expect(run(base).unexplained).toBe(0);
  });

  it("a one-cent change: the table, the Sheet row, the column and 1 cent; the month's sum differs by 1 cent", () => {
    const r = withDb((rows) => (rows[1]!["cash_sales"] = "20.51"));
    const v = diffs(r, "sales").find((d) => d.kind === "value")!;
    expect(v).toMatchObject({ table: "sales", row: 4, keyColumn: "sales_id", column: "cash_sales", message: "differs by 1 cent" });
    const m = diffs(r, "sales").find((d) => d.kind === "month_sum")!;
    expect(m.message).toMatch(/2026-11: the sum of cash_sales differs by 1 cent \(Sheet 60\.50, database 60\.51\)/);
    expect(r.unexplained).toBe(2);
    // and the figures themselves are not in a row difference
    expect(v.message).not.toMatch(/20\.5/);
  });

  it("two cents is '2 cents'", () => {
    expect(diffs(withDb((rows) => (rows[0]!["cash_sales"] = "10.02")), "sales")[0]!.message).toMatch(/2 cents/);
  });

  it("a row deleted from the database", () => {
    const r = withDb((rows) => void rows.splice(1, 1));
    expect(kinds(r, "sales")).toEqual(expect.arrayContaining(["row_count", "missing_from_database", "month_rows", "month_sum"]));
    expect(diffs(r, "sales").find((d) => d.kind === "missing_from_database")).toMatchObject({ row: 4 });
  });

  it("an extra row in the database", () => {
    const r = withDb((rows) => void rows.push(dbSale(9, { cash_sales: "1.00" })));
    expect(kinds(r, "sales")).toEqual(expect.arrayContaining(["row_count", "extra_in_database", "month_rows"]));
    expect(diffs(r, "sales").find((d) => d.kind === "extra_in_database")!.message).toMatch(/S9/);
  });

  it("a blank turned into 0: the sum is unchanged, the blank count and the row comparison catch it", () => {
    const sheet = { sales: [sale(1, { card_total: "" }), sale(2, { card_total: 5 })] };
    const r = run({ sheet, db: { sales: [dbSale(1, { card_total: "0.00" }), dbSale(2, { card_total: "5.00" })] } });
    expect(kinds(r, "sales")).not.toContain("month_sum");
    expect(kinds(r, "sales")).toEqual(expect.arrayContaining(["value", "blank_count", "month_blank"]));
    expect(diffs(r, "sales").find((d) => d.kind === "value")).toMatchObject({ row: 3, column: "card_total" });
    expect(diffs(r, "sales").find((d) => d.kind === "blank_count")!.message).toMatch(/card_total: blank in 1 Sheet row\(s\) but NULL in 0 database row\(s\)/);
  });

  it("a 0 turned into NULL", () => {
    const r = run({ sheet: { sales: [sale(1, { card_total: 0 }), sale(2, { card_total: 5 })] }, db: { sales: [dbSale(1, { card_total: null }), dbSale(2, { card_total: "5.00" })] } });
    expect(kinds(r, "sales")).toEqual(expect.arrayContaining(["value", "blank_count"]));
    expect(kinds(r, "sales")).not.toContain("month_sum");
    expect(diffs(r, "sales").find((d) => d.kind === "value")).toMatchObject({ row: 3, column: "card_total" });
  });

  it("a date moved by one day: both sides are shown, a date is not personal", () => {
    const r = withDb((rows) => (rows[2]!["date"] = "2026-11-03"));
    expect(diffs(r, "sales").find((d) => d.kind === "value")).toMatchObject({ row: 5, column: "date", message: "Sheet 2026-11-02, database 2026-11-03" });
  });

  it("a moment moved by one second", () => {
    const r = run({
      sheet: { staff: [{ staff_id: "S_1", name: "Pat", active: true, role: "admin", created_at: new Date("2026-11-21T14:00:00.000Z") }] },
      db: { staff: [{ staff_id: "S_1", name: "Pat", active: "true", role: "admin", created_at: "2026-11-21T14:00:01.000000Z" }] },
    });
    expect(diffs(r, "staff").find((d) => d.kind === "value")).toMatchObject({ row: 3, column: "created_at", message: "Sheet 2026-11-21T14:00:00.000000Z, database 2026-11-21T14:00:01.000000Z" });
  });

  it("two rows' amounts swapped: every sum is unchanged, the row comparison finds both", () => {
    const r = withDb((rows) => {
      rows[0]!["cash_sales"] = "20.50";
      rows[1]!["cash_sales"] = "10.00";
    });
    expect(kinds(r, "sales").filter((k) => k !== "value")).toEqual([]);
    expect(diffs(r, "sales").map((d) => [d.row, d.column])).toEqual([
      [3, "cash_sales"],
      [4, "cash_sales"],
    ]);
  });

  it("a text value changed: it says 'differs', and neither value is in the report", () => {
    const r = run({
      sheet: { staff: [{ staff_id: "S_1", name: "Zelda Plantedname", notes: "plantednote-alpha", active: true, role: "admin" }] },
      db: { staff: [{ staff_id: "S_1", name: "Zelda Plantedname", notes: "plantednote-BETA", active: "true", role: "admin" }] },
    });
    expect(diffs(r, "staff").find((d) => d.kind === "value")).toMatchObject({ row: 3, column: "notes", message: "differs" });
    for (const secret of ["Zelda", "plantednote"]) expect(everything(r), secret).not.toContain(secret);
  });

  it("a pay rate changed: 'differs', no figure, and rates are not summed", () => {
    const r = run({
      sheet: { staff: [{ staff_id: "S_1", name: "Pat", hourly_rate: 87654.321, active: true, role: "admin" }] },
      db: { staff: [{ staff_id: "S_1", name: "Pat", hourly_rate: "87654.3211", active: "true", role: "admin" }] },
    });
    expect(diffs(r, "staff").find((d) => d.kind === "value")).toMatchObject({ column: "hourly_rate", message: "differs" });
    expect(everything(r)).not.toMatch(/87654/);
    expect(r.tables.find((t) => t.table === "staff")!.sumColumns).not.toContain("hourly_rate");
  });

  it("an enum changed to another allowed word", () => {
    const r = run({ sheet: { sales: [sale(1, { status: "closed" })] }, db: { sales: [dbSale(1, { status: "validated" })] } });
    expect(diffs(r, "sales").find((d) => d.kind === "value")).toMatchObject({ column: "status", message: "Sheet closed, database validated" });
  });

  it("an enum the Sheet spelled in its own case is not a difference", () => {
    const r = run({ sheet: { sales: [sale(1, { status: " Closed " })] }, db: { sales: [dbSale(1, { status: "closed" })] } });
    expect(diffs(r)).toEqual([]);
  });

  it("the order of a table that keeps one: two rows swapped", () => {
    const sheet = { sales: [sale(1), sale(2), sale(3), sale(4)] };
    const inOrder = [dbSale(1), dbSale(2), dbSale(3), dbSale(4)];
    expect(run({ sheet, db: { sales: inOrder }, seq: ["sales"] }).unexplained).toBe(0);
    const swapped = [dbSale(1), dbSale(3), dbSale(2), dbSale(4)];
    const r = run({ sheet, db: { sales: swapped }, seq: ["sales"] });
    expect(kinds(r, "sales")).toEqual(["order"]);
    expect(diffs(r, "sales")[0]!.message).toMatch(/2 of 4 positions differ; first at position 2: the Sheet has row 4 there, the database has row 5/);
    // a table with no seq is read in key order: no order claim
    expect(run({ sheet, db: { sales: swapped } }).unexplained).toBe(0);
  });

  it("a secret key in ops.config, and one the Sheet never had", () => {
    const r = run({ sheet: { config: [{ key: "a", value: "1" }] }, db: { config: [{ key: "a", value: "1" }, { key: "clover_cstore_token", value: "x" }] } });
    expect(kinds(r)).toEqual(expect.arrayContaining(["secret_config", "extra_in_database", "row_count"]));
    expect(r.checks.find((c) => c.name.includes("secret"))!.ok).toBe(false);
    expect(everything(r)).not.toContain('"x"');
  });

  it("a deprecated tab with a table; a table the contract does not have; a tab it does not know", () => {
    const r = compareExportToDatabase({
      contract: CONTRACT,
      tabs: TABLES.map((t) => ({ name: t, header: COLS[t] as string[], rows: [] })).concat([{ name: "Scratch", header: ["x"], rows: [] }]),
      db: {
        tables: Object.fromEntries(TABLES.map((t) => [t, { present: true, columns: [...(COLS[t] as string[]), "store_id", ...(t === "staff" ? ["pin_hash"] : [])], hasSeq: false, rows: [] }])),
        allTables: [...TABLES, "shopping_list", "mystery"],
        opsOnlyCounts: {},
      },
      evidence: emptyEvidence(),
    });
    const msgs = r.otherDifferences.map((d) => d.message).join("\n");
    expect(msgs).toMatch(/deprecated tab shopping_list has a table/);
    expect(msgs).toMatch(/table mystery that the contract does not have/);
    expect(msgs).toMatch(/tab "Scratch" that is neither loaded nor listed as deprecated/);
  });

  it("a Sheet tab with no column for the key, and a database table that lacks a column", () => {
    const r = compareExportToDatabase({
      contract: CONTRACT,
      tabs: TABLES.map((t) => ({ name: t, header: t === "payments" ? ["paid_on"] : (COLS[t] as string[]), rows: [] })),
      db: { tables: Object.fromEntries(TABLES.map((t) => [t, { present: t !== "sales", columns: (COLS[t] as string[]).filter((c) => !(t === "till_sessions" && c === "expected_cash")), hasSeq: false, rows: [] }])), allTables: TABLES, opsOnlyCounts: {} },
      evidence: { ...emptyEvidence(), tables: [] },
    });
    const msgs = diffs(r).map((d) => `${d.table}: ${d.message}`).join("\n");
    expect(msgs).toMatch(/payments: the tab has no "payment_id" column/);
    expect(msgs).toMatch(/sales: the database has no table sales/);
    expect(msgs).toMatch(/till_sessions: the database table till_sessions has no column expected_cash/);
  });

  it("more than LIST_CAP differences in a table: only LIST_CAP are listed, the number is whole, the report says how many more", () => {
    const n = LIST_CAP + 7;
    const sheet = { sales: Array.from({ length: n }, (_, i) => sale(i + 1, { cash_sales: 1 })) };
    const db = { sales: Array.from({ length: n }, (_, i) => dbSale(i + 1, { cash_sales: "1.01" })) };
    const r = run({ sheet, db });
    const t = r.tables.find((x) => x.table === "sales")!;
    expect(t.differenceCount).toBe(n + 1); // every row, and the month's sum
    expect(t.differences.filter((d) => d.kind === "value")).toHaveLength(n);
    const j = reportJson(r, { startedAt: "t", workbookSha256: "w", manifestSha256: "m" }) as { tables: { table: string; differences: unknown[]; differencesNotListed: number }[] };
    const js = j.tables.find((x) => x.table === "sales")!;
    expect(js.differences).toHaveLength(LIST_CAP);
    expect(js.differencesNotListed).toBe(n + 1 - LIST_CAP);
    expect(reportMarkdown(r, { startedAt: "t", workbookSha256: "w", manifestSha256: "m" })).toContain(`and ${n + 1 - LIST_CAP} more (not listed)`);
    expect(r.unexplained).toBe(n + 1);
  });
});

describe("what the import report explains is not a difference, and the report is checked, not trusted", () => {
  const sheet = { sales: [sale(1), sale(2, { cash_sales: 20.5, card_total: 3.25 }), sale(3, { cash_sales: 30 })] };
  const csvReject = (tab: string, row: number, column: string): { tab: string; row: number; column: string; reason: string } => ({ tab, row, column, reason: "not a number" });

  it("a rejected row is listed 'not loaded', with the money it carries, and is not a difference", () => {
    const r = run({ sheet, db: { sales: [dbSale(1), dbSale(3, { cash_sales: "30.00" })] }, evidence: { rejects: [csvReject("sales", 4, "cash_sales")], acceptRejects: 1 } });
    expect(diffs(r)).toEqual([]);
    const t = r.tables.find((x) => x.table === "sales")!;
    expect(t.notLoaded.rejected).toEqual([{ row: 4, columns: ["cash_sales"], reasons: ["not a number"] }]);
    expect(t.notLoaded.sums["cash_sales"]).toBe("20.50");
    expect(t.notLoaded.sums["card_total"]).toBe("3.25");
    expect(t.rows).toMatchObject({ withId: 3, inDatabase: 2, rejected: 1 });
    // the month's table compares what should have loaded: 2 rows each side
    expect(t.months[0]).toMatchObject({ sheetRows: 2, dbRows: 2 });
    expect(reportMarkdown(r, { startedAt: "t", workbookSha256: "w", manifestSha256: "m" })).toMatch(/Not loaded, per the import report[\s\S]*row 4 \(cash_sales: not a number\)[\s\S]*cash_sales 20\.50, card_total 3\.25/);
  });

  it("a row missing from the database that the report does not explain is a difference, even when others are explained", () => {
    const r = run({ sheet, db: { sales: [dbSale(3, { cash_sales: "30.00" })] }, evidence: { rejects: [csvReject("sales", 4, "cash_sales")] } });
    expect(diffs(r, "sales").find((d) => d.kind === "missing_from_database")).toMatchObject({ row: 3 });
  });

  it("a row the report says was rejected, yet the database holds, is an extra row", () => {
    const r = run({ sheet, db: { sales: [dbSale(1), dbSale(2, { cash_sales: "20.50", card_total: "3.25" }), dbSale(3, { cash_sales: "30.00" })] }, evidence: { rejects: [csvReject("sales", 4, "cash_sales")] } });
    expect(kinds(r, "sales")).toContain("extra_in_database");
    expect(diffs(r, "sales").find((d) => d.kind === "extra_in_database")!.message).toMatch(/the import report says the Sheet row with that id was rejected/);
  });

  it("a reject the report lists for a row the tab does not have is a difference (the report is not trusted)", () => {
    const full = { sales: [dbSale(1), dbSale(2, { cash_sales: "20.50", card_total: "3.25" }), dbSale(3, { cash_sales: "30.00" })] };
    const r = run({ sheet, db: full, evidence: { rejects: [csvReject("sales", 99, "cash_sales")] } });
    expect(diffs(r, "sales").find((d) => d.kind === "report_integrity" && d.row === 99)!.message).toMatch(/lists a rejected row 99, but the tab's rows end at 5/);
    expect(r.unexplained).toBeGreaterThan(0);
  });

  it("a reject listed for an empty Sheet row, and a left-out row the tab does not have", () => {
    const r = run({ sheet: { sales: [sale(1), {}] }, db: { sales: [dbSale(1)] }, evidence: { rejects: [csvReject("sales", 4, "sales_id")], leftOutRows: [{ table: "payments", id: "P1", row: 40 }] } });
    const msgs = diffs(r).map((d) => d.message).join("\n");
    expect(msgs).toMatch(/lists row 4 as rejected, but that Sheet row is empty/);
    expect(msgs).toMatch(/lists a left-out row 40 .*but the tab's rows end at 2/);
  });

  it("the report's own totals must add up and match the tab and the database", () => {
    const honest = run({ sheet, db: { sales: [dbSale(1), dbSale(2, { cash_sales: "20.50", card_total: "3.25" }), dbSale(3, { cash_sales: "30.00" })] } });
    expect(honest.unexplained).toBe(0);
    const lines = (loaded: number): ImportEvidence["tables"] => TABLES.map((t) => ({ table: t, tabRows: t === "sales" ? 3 : 0, loaded: t === "sales" ? loaded : 0, rejected: 0, reKeyed: 0, blankKey: 0, leftOut: 0 }));
    const r = run({ sheet, db: { sales: [dbSale(1), dbSale(2, { cash_sales: "20.50", card_total: "3.25" }), dbSale(3, { cash_sales: "30.00" })] }, evidence: { tables: lines(2) } });
    const msgs = diffs(r, "sales").map((d) => d.message).join("\n");
    expect(msgs).toMatch(/the import report says 2 loaded rows; this check finds 3/);
    expect(msgs).toMatch(/totals do not add up/);
  });

  it("the report's reject count must be rejects.csv's", () => {
    const r = run({ sheet, db: { sales: [dbSale(1), dbSale(2, { cash_sales: "20.50", card_total: "3.25" }), dbSale(3, { cash_sales: "30.00" })] }, evidence: { rejectCount: 2 } });
    expect(r.otherDifferences.map((d) => d.message).join("\n")).toMatch(/says 2 reject\(s\); rejects.csv lists 0/);
  });

  it("three rows sharing an id, re-keyed: the three database rows match their three Sheet rows; a change on the third is found at its Sheet row", () => {
    const sheetP = { payments: [1, 2, 3].map(() => ({ payment_id: "P1", paid_on: "2026-11-02", total_amount: 5 })) };
    const rk = [
      { table: "payments", originalId: "P1", newId: "P1-d2", row: 4 },
      { table: "payments", originalId: "P1", newId: "P1-d3", row: 5 },
    ];
    const dbP = (id: string, amount = "5.00"): Record<string, string | null> => ({ payment_id: id, paid_on: "2026-11-02", total_amount: amount });
    const ok = run({ sheet: sheetP, db: { payments: [dbP("P1"), dbP("P1-d2"), dbP("P1-d3")] }, evidence: { rekeyed: rk } });
    expect(diffs(ok)).toEqual([]);
    expect(ok.tables.find((t) => t.table === "payments")!.rows.reKeyed).toBe(2);
    const bad = run({ sheet: sheetP, db: { payments: [dbP("P1"), dbP("P1-d2"), dbP("P1-d3", "5.01")] }, evidence: { rekeyed: rk } });
    expect(diffs(bad, "payments").find((d) => d.kind === "value")).toMatchObject({ row: 5, column: "total_amount", message: "differs by 1 cent" });
    // a repeat the report did not re-key
    const unkeyed = run({ sheet: sheetP, db: { payments: [dbP("P1"), dbP("P1-d2"), dbP("P1-d3")] }, evidence: { rekeyed: [rk[0]!] } });
    expect(kinds(unkeyed, "payments")).toEqual(expect.arrayContaining(["sheet_id", "extra_in_database"]));
  });

  it("a re-key the Sheet does not bear out", () => {
    const r = run({
      sheet: { payments: [{ payment_id: "P1", paid_on: "2026-11-02", total_amount: 5 }, { payment_id: "P2", paid_on: "2026-11-02", total_amount: 5 }] },
      db: { payments: [{ payment_id: "P1", paid_on: "2026-11-02", total_amount: "5.00" }, { payment_id: "P2-d2", paid_on: "2026-11-02", total_amount: "5.00" }] },
      evidence: { rekeyed: [{ table: "payments", originalId: "P2", newId: "P2-d2", row: 4 }] },
    });
    expect(diffs(r, "payments").map((d) => d.message).join("\n")).toMatch(/re-keys row 4, but that Sheet row is not a later repeat/);
  });

  it("placeholders and secret config keys: left out per the report, counted, and checked to be what they say", () => {
    const r = run({
      sheet: { config: [{ key: "notifier_enabled", value: "false" }, { key: "whatsapp_api_token", value: "tok-123" }] },
      db: { config: [{ key: "notifier_enabled", value: "false" }] },
      evidence: { configKeysLeftOut: [{ row: 4, key: "whatsapp_api_token" }] },
    });
    expect(diffs(r)).toEqual([]);
    expect(r.tables.find((t) => t.table === "config")!.notLoaded.leftOut).toEqual([{ row: 4, why: "secret key whatsapp_api_token" }]);
    expect(everything(r)).not.toContain("tok-123");
    const lie = run({
      sheet: { config: [{ key: "notifier_enabled", value: "false" }, { key: "cash_manager_staff_id", value: "S_1" }] },
      db: { config: [{ key: "notifier_enabled", value: "false" }] },
      evidence: { configKeysLeftOut: [{ row: 4, key: "cash_manager_staff_id" }] },
    });
    expect(diffs(lie, "config").map((d) => d.message).join("\n")).toMatch(/as a secret, but its key does not look like one/);
  });

  it("a blank-key row with values must be a reject; one with nothing is only counted", () => {
    const r = run({ sheet: { sales: [sale(1), { cash_sales: 12 }, {}] }, db: { sales: [dbSale(1)] } });
    expect(diffs(r, "sales").map((d) => d.message).join("\n")).toMatch(/row 4 has no id but holds values, and the import report does not list it as rejected/);
    const ok = run({ sheet: { sales: [sale(1), { cash_sales: 12 }, {}] }, db: { sales: [dbSale(1)] }, evidence: { rejects: [csvReject("sales", 4, "sales_id")] } });
    expect(diffs(ok)).toEqual([]);
    expect(ok.tables.find((t) => t.table === "sales")!.rows).toMatchObject({ tab: 3, withId: 1, empty: 1, keylessWithValues: 1, rejected: 1 });
    // the money in a keyless row is counted under "not loaded"
    const t = ok.tables.find((x) => x.table === "sales")!;
    expect(t.notLoaded.rejected.map((x) => x.row)).toEqual([4]);
    expect(t.notLoaded.sums["cash_sales"]).toBe("12.00");
  });

  it("--open-sessions-blank blanks an open till's closing columns on purpose; without it the same database is a difference", () => {
    const sheetT = { till_sessions: [{ session_id: "T1", date: "2026-11-02", status: "open", closing_cash_counted: 0, expected_cash: 0 }] };
    const dbT = { till_sessions: [{ session_id: "T1", date: "2026-11-02", status: "open", closing_cash_counted: null, expected_cash: null }] };
    const withFlag = run({ sheet: sheetT, db: dbT, evidence: { openSessionsBlank: true, rowsWithClosingFigures: 1 } });
    expect(diffs(withFlag)).toEqual([]);
    expect(withFlag.tables.find((t) => t.table === "till_sessions")!.openBlanked).toEqual({ rows: 1, cellsByColumn: { closing_cash_counted: 1, expected_cash: 1 } });
    expect(kinds(run({ sheet: sheetT, db: dbT }), "till_sessions")).toEqual(expect.arrayContaining(["value", "blank_count"]));
    // a closed till is never blanked by the flag
    const closed = { till_sessions: [{ session_id: "T2", date: "2026-11-02", status: "closed", closing_cash_counted: 0, expected_cash: 0 }] };
    const dbClosed = { till_sessions: [{ session_id: "T2", date: "2026-11-02", status: "closed", closing_cash_counted: null, expected_cash: null }] };
    expect(kinds(run({ sheet: closed, db: dbClosed, evidence: { openSessionsBlank: true } }), "till_sessions")).toContain("value");
    // and the report's count must be the Sheet's
    expect(diffs(run({ sheet: sheetT, db: dbT, evidence: { openSessionsBlank: true, rowsWithClosingFigures: 3 } })).map((d) => d.message).join("\n")).toMatch(/changed 3 open till row\(s\); the Sheet has 1/);
  });
});

describe("PIN hashes", () => {
  const staff = (code: unknown): Obj => ({ staff_id: "S_1", name: "Pat", active: true, role: "admin", login_code: code });
  const dbStaff = (hash: string | null): Record<string, string | null> => ({ staff_id: "S_1", name: "Pat", active: "true", role: "admin", pin_hash: hash });
  const pinMsgs = (r: ReconcileResult): string[] => diffs(r).filter((d) => d.kind === "pin_hash").map((d) => d.message);

  it("a hash of the right form for a person with a code; none for a person without one", () => {
    expect(pinMsgs(run({ sheet: { staff: [staff("4093")] }, db: { staff: [dbStaff(HASH)] } }))).toEqual([]);
    expect(pinMsgs(run({ sheet: { staff: [staff("")] }, db: { staff: [dbStaff(null)] } }))).toEqual([]);
    expect(pinMsgs(run({ sheet: { staff: [staff(4093)] }, db: { staff: [dbStaff(HASH)] } }))).toEqual([]);
  });

  it("a cleared pin_hash, a hash for a person with no code, the code itself, and a malformed hash", () => {
    expect(pinMsgs(run({ sheet: { staff: [staff("4093")] }, db: { staff: [dbStaff(null)] } })).join("\n")).toMatch(/the Sheet has a login code, but pin_hash is not set/);
    expect(pinMsgs(run({ sheet: { staff: [staff("")] }, db: { staff: [dbStaff(HASH)] } })).join("\n")).toMatch(/the Sheet has no login code, but pin_hash is set/);
    expect(pinMsgs(run({ sheet: { staff: [staff("4093")] }, db: { staff: [dbStaff("4093")] } })).join("\n")).toMatch(/not in the form pbkdf2-sha256/);
    expect(pinMsgs(run({ sheet: { staff: [staff("4093")] }, db: { staff: [dbStaff("pbkdf2-sha256$100000$AAAA$AAAA")] } })).join("\n")).toMatch(/32-byte hash/);
    const r = run({ sheet: { staff: [staff("4093")] }, db: { staff: [dbStaff(null)] } });
    expect(everything(r)).not.toContain("4093");
  });

  it("the report's list of people without a PIN must be true", () => {
    const r = run({ sheet: { staff: [staff("4093")] }, db: { staff: [dbStaff(HASH)] }, evidence: { pinsBlank: [{ staffId: "S_1", row: 3 }], pinsHashed: 1 } });
    expect(pinMsgs(r).join("\n")).toMatch(/the import report says a person has no PIN \(staff row 3\), but pin_hash is set/);
    const r2 = run({ sheet: { staff: [staff("4093")] }, db: { staff: [dbStaff(HASH)] }, evidence: { pinsHashed: 4 } });
    expect(pinMsgs(r2).join("\n")).toMatch(/says 4 PIN\(s\) were hashed; 1 staff rows/);
  });
});

describe("reading the import report, and whether it belongs to the export", () => {
  const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    format: "storeops-import-report/1",
    mode: "import",
    outcome: "committed",
    options: { acceptRejects: 1, openSessionsBlank: false },
    export: { manifestSha256: "m".repeat(64), workbook: { file: "x.xlsx", sha256: "w".repeat(64), bytes: 1 }, tabs: [{ name: "sales", sha256: "s".repeat(64) }] },
    tables: [{ table: "sales", tabRows: 3, loaded: 2, rejected: 1, reKeyed: 0, blankKey: 0, leftOut: 0 }],
    rejects: { count: 1, accepted: 1, file: "rejects.csv" },
    rules: { duplicateKeys: { reKeyed: [] }, placeholders: { leftOut: [] }, pins: { hashed: 0, blank: [] }, openSessions: { flag: false, rowsWithClosingFigures: 0 }, configKeysLeftOut: [] },
    skippedTabs: [],
    ...over,
  });
  const csv = 'tab,row,column,reason\nsales,4,cash_sales,"not one of: a, b"\n';

  it("reads what the importer writes, including a quoted reason with commas", () => {
    const e = parseImportReport(report(), csv);
    expect(e.rejects).toEqual([{ tab: "sales", row: 4, column: "cash_sales", reason: "not one of: a, b" }]);
    expect(e.workbookSha256).toBe("w".repeat(64));
    expect(e.tables[0]).toMatchObject({ table: "sales", loaded: 2 });
  });

  it("refuses a report in another shape, and a rejects.csv that is not the importer's", () => {
    expect(() => parseImportReport({ format: "other" }, csv)).toThrow(ReconcileRefused);
    expect(() => parseImportReport(report({ tables: "x" }), csv)).toThrow(/tables/);
    expect(() => parseImportReport(report(), "a,b\n")).toThrow(/header line/);
    expect(() => parseImportReport(report(), "tab,row,column,reason\nsales,x,y,z\n")).toThrow(/line 2/);
  });

  it("belongs to this export only if the workbook, the manifest and every tab have the same SHA-256, and it was a committed import", () => {
    const e = parseImportReport(report(), csv);
    const mine = { workbookSha256: "w".repeat(64), manifestSha256: "m".repeat(64), tabSha256: { sales: "s".repeat(64) } };
    expect(reportBelongsToExport(e, mine)).toEqual([]);
    expect(reportBelongsToExport(e, { ...mine, workbookSha256: "x".repeat(64) }).join()).toMatch(/different workbook/);
    expect(reportBelongsToExport(e, { ...mine, manifestSha256: "x".repeat(64) }).join()).toMatch(/different export/);
    expect(reportBelongsToExport(e, { ...mine, tabSha256: { sales: "x".repeat(64) } }).join()).toMatch(/tab "sales" with a different checksum/);
    expect(reportBelongsToExport(e, { ...mine, tabSha256: { sales: "s".repeat(64), extra: "e" } }).join()).toMatch(/tab "extra"|different checksum/);
    expect(reportBelongsToExport(parseImportReport(report({ mode: "dry-run" }), csv), mine).join()).toMatch(/not a real import/);
    expect(reportBelongsToExport(parseImportReport(report({ outcome: "rolled back: the number of rejects is not the number given to --accept-rejects" }), csv), mine).join()).toMatch(/not committed/);
  });
});

describe("months", () => {
  it("a row with a blank date is its own group, 'no date', after the months; a table with no date column is one group", () => {
    const r = run({
      sheet: { staff: [{ staff_id: "S_1", name: "A", active: true, role: "admin", start_date: "2026-03-05" }, { staff_id: "S_2", name: "B", active: true, role: "admin" }, { staff_id: "S_3", name: "C", active: true, role: "admin", start_date: "2025-12-31" }] },
      db: { staff: [{ staff_id: "S_1", name: "A", active: "true", role: "admin", start_date: "2026-03-05" }, { staff_id: "S_2", name: "B", active: "true", role: "admin" }, { staff_id: "S_3", name: "C", active: "true", role: "admin", start_date: "2025-12-31" }] },
      evidence: { pinsBlank: [], pinsHashed: 0 },
    });
    const staff = r.tables.find((t) => t.table === "staff")!;
    expect(staff.months.map((m) => [m.month, m.sheetRows, m.dbRows])).toEqual([["2025-12", 1, 1], ["2026-03", 1, 1], ["no date", 1, 1]]);
    expect(r.tables.find((t) => t.table === "config")!.dateColumn).toBeNull();
    // a date moved into another month shows in both months
    const moved = run({
      sheet: { sales: [sale(1, { date: "2026-10-31" })] },
      db: { sales: [dbSale(1, { date: "2026-11-01" })] },
    });
    expect(diffs(moved, "sales").filter((d) => d.kind === "month_rows")).toHaveLength(2);
    expect(diffs(moved, "sales").filter((d) => d.kind === "month_sum")).toHaveLength(2);
  });
});

describe("the summary", () => {
  it("says the result in one line, and counts", () => {
    const ok = run({ sheet: { sales: [sale(1)] }, db: { sales: [dbSale(1)] } });
    expect(summaryLines(ok).at(-1)).toBe("RESULT: no unexplained difference.");
    const bad = run({ sheet: { sales: [sale(1)] }, db: { sales: [dbSale(1, { cash_sales: "10.01" })] } });
    expect(summaryLines(bad).at(-1)).toBe("RESULT: 2 unexplained differences.");
  });
});
