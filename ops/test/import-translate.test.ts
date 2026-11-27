import { readFileSync } from "node:fs";
// Pure tests of the Sheet-to-database translation: no database, no Sheet.
import { describe, expect, it } from "vitest";
import { readContract } from "../src/import/load";
import { parseContract, translateTab, type TranslateOptions } from "../src/import/sheet-to-db";

const contract = readContract();
const opts = (extra: Partial<TranslateOptions> = {}): TranslateOptions => ({ contract, ...extra });

// A valid minimal row per tab: every NOT NULL column filled.
const BASE: Record<string, Record<string, unknown>> = {
  sales: { sales_id: "SAL1", session_id: "CST-1", staff_id: "S_001", company: "cstore", date: "2026-03-02" },
  staff: { staff_id: "S_001", name: "Fictional Person", role: "employee", active: true },
  attendance: { attendance_id: "A1", staff_id: "S_001", date: "2026-03-02", status: "worked" },
  till_sessions: {
    session_id: "CST-1",
    attendance_id: "A1",
    staff_id: "S_001",
    company: "cstore",
    date: "2026-03-02",
    status: "closed",
  },
  commission_runs: { run_id: "R1" },
  commission_rules: {
    rule_id: "CR1",
    name: "Rule",
    applies_to: "all_staff",
    company: "vape",
    active: true,
    rule_type: "percentage",
  },
  config: { key: "k", value: "v", description: "d" },
};

/** Translate the base row of `tab` with `col` set to `cell`; returns the result. */
function one(tab: string, col: string, cell: unknown, extra: Partial<TranslateOptions> = {}) {
  const base = { ...BASE[tab], [col]: cell };
  const header = Object.keys(base);
  return translateTab(tab, header, [header.map((h) => base[h])], opts(extra));
}
/** The translated value of `col`, or "REJECT". */
function value(tab: string, col: string, cell: unknown): unknown {
  const r = one(tab, col, cell);
  if (r.status !== "ok") throw new Error("not migrated");
  if (r.rejects.length) return "REJECT";
  return r.rows[0]?.[col];
}

const D = (iso: string) => new Date(iso);

describe("numeric columns", () => {
  const MONEY = ["sales", "cash_sales"] as const;
  const cases: [string, unknown, unknown][] = [
    ["a number", 12.3, 12.3],
    ["a number with two decimals", 12.34, 12.34],
    ["zero stays zero", 0, 0],
    ["a negative number", -5.5, -5.5],
    ["a third decimal does not round-trip", 12.345, "REJECT"],
    ["a float artefact is a reject", 0.1 + 0.2, "REJECT"],
    ["empty string is blank", "", null],
    ["null is blank", null, null],
    ["undefined is blank", undefined, null],
    ["a numeric string", "12.50", 12.5],
    ["a padded numeric string", " 7 ", 7],
    ["a numeric string with a third decimal", "12.345", "REJECT"],
    ["text", "abc", "REJECT"],
    ["a currency string", "$12", "REJECT"],
    ["a boolean", true, "REJECT"],
    ["a date", D("2026-03-02T12:00:00Z"), "REJECT"],
    ["NaN", Number.NaN, "REJECT"],
    ["Infinity", Number.POSITIVE_INFINITY, "REJECT"],
    ["too big for numeric(12,2)", 1e10, "REJECT"],
    ["the biggest that fits", 9999999999.99, 9999999999.99],
  ];
  it.each(cases)("money: %s", (_n, cell, expected) => {
    expect(value(MONEY[0], MONEY[1], cell)).toEqual(expected);
  });

  it("a rate keeps four decimals, not five", () => {
    expect(value("staff", "hourly_rate", 17.1234)).toBe(17.1234);
    expect(value("staff", "hourly_rate", 17.12345)).toBe("REJECT");
    expect(value("staff", "hourly_rate", "")).toBeNull();
  });

  it("a count must be a whole number", () => {
    expect(value("commission_runs", "staff_count", 3)).toBe(3);
    expect(value("commission_runs", "staff_count", 3.5)).toBe("REJECT");
    expect(value("commission_runs", "staff_count", "")).toBeNull();
  });
});

describe("date columns", () => {
  it.each<[string, unknown, unknown]>([
    // 2026-03-02 00:00 Toronto (EST, UTC-5) is 05:00Z; a UTC midnight is the evening before in Toronto.
    ["a Date at Toronto midnight", D("2026-03-02T05:00:00Z"), "2026-03-02"],
    ["a Date at 23:59:59 Toronto", D("2026-03-03T04:59:59Z"), "2026-03-02"],
    ["a Date at UTC midnight is the evening before in Toronto", D("2026-03-02T00:00:00Z"), "2026-03-01"],
    ["summer time (EDT, UTC-4)", D("2026-07-01T04:00:00Z"), "2026-07-01"],
    ["a day string", "2026-03-02", "2026-03-02"],
    ["a day that does not exist", "2026-02-30", "REJECT"],
    ["another format", "03/02/2026", "REJECT"],
    ["an invalid Date", new Date(Number.NaN), "REJECT"],
    ["a number", 46083, "REJECT"],
  ])("sales.date: %s", (_n, cell, expected) => {
    expect(value("sales", "date", cell)).toEqual(expected);
  });

  it("a blank in a nullable date column is null", () => {
    expect(value("staff", "start_date", "")).toBeNull();
    expect(value("staff", "start_date", null)).toBeNull();
  });
  it("a blank in a NOT NULL date column is a reject", () => {
    expect(value("sales", "date", "")).toBe("REJECT");
  });
});

describe("timestamptz columns", () => {
  it.each<[string, unknown, unknown]>([
    ["a Date is that instant", D("2026-03-02T13:30:00Z"), D("2026-03-02T13:30:00Z")],
    ["an ISO string with Z", "2026-03-02T13:30:00Z", D("2026-03-02T13:30:00Z")],
    ["an ISO string with an offset", "2026-03-02T08:30:00-05:00", D("2026-03-02T13:30:00Z")],
    ["an ISO string with no offset is ambiguous", "2026-03-02T08:30:00", "REJECT"],
    ["words", "yesterday", "REJECT"],
    ["an invalid Date", new Date(Number.NaN), "REJECT"],
    ["a number", 5, "REJECT"],
    ["blank", "", null],
  ])("attendance.actual_start: %s", (_n, cell, expected) => {
    expect(value("attendance", "actual_start", cell)).toEqual(expected);
  });
});

describe("boolean columns", () => {
  it.each<[unknown, unknown]>([
    [true, true],
    [false, false],
    ["TRUE", true],
    ["true", true],
    ["False", false],
    ["FALSE", false],
    ["yes", "REJECT"],
    [1, "REJECT"],
  ])("staff.active %j", (cell, expected) => {
    expect(value("staff", "active", cell)).toEqual(expected);
  });

  it("a blank staff.active and commission_rules.active is false (the old code reads blank as not active)", () => {
    for (const blank of ["", null, undefined]) {
      expect(value("staff", "active", blank)).toBe(false);
      expect(value("commission_rules", "active", blank)).toBe(false);
    }
  });

  it("a blank boolean anywhere else is null", () => {
    const mini = parseContract(`
      create table ops.t (
        id text primary key,
        flag boolean
      );`);
    const r = translateTab("t", ["id", "flag"], [["a", ""], ["b", null], ["c", "TRUE"]], { contract: mini });
    expect(r.status === "ok" && r.rows).toEqual([
      { id: "a", flag: null },
      { id: "b", flag: null },
      { id: "c", flag: true },
    ]);
  });
});

describe("text columns", () => {
  it.each<[string, unknown, unknown]>([
    ["a string as it is, spaces and all", "  hello  ", "  hello  "],
    ["a number is its string form", 42, "42"],
    ["a boolean is its string form", true, "true"],
    ["blank", "", null],
    ["null", null, null],
    ["a Date does not belong in a text column", D("2026-03-02T05:00:00Z"), "REJECT"],
  ])("sales.misc_notes: %s", (_n, cell, expected) => {
    expect(value("sales", "misc_notes", cell)).toEqual(expected);
  });

  it("IDs are trimmed and nothing else is", () => {
    expect(value("sales", "sales_id", "  SAL9 ")).toBe("SAL9");
    expect(value("sales", "staff_id", " S_002")).toBe("S_002");
    expect(value("attendance", "created_by", " SYSTEM ")).toBe("SYSTEM");
    expect(value("sales", "misc_notes", " keep me ")).toBe(" keep me ");
    expect(value("config", "key", " cash_manager_staff_id ")).toBe("cash_manager_staff_id");
    expect(value("config", "value", " 5 ")).toBe(" 5 ");
  });

  it("a blank config value is NULL: a blank means use the default", () => {
    expect(value("config", "value", "")).toBeNull();
  });
});

// Found on the owner's first dry run on real data (Nov 27): 303 audit rows rejected as "not text".
// The app writes each day's reconcile entry with the day as its target ("2026-11-21"), and Google
// Sheets turns text that looks like a date into a date cell.
describe("text that Google Sheets turned into a date", () => {
  const LOG = ["log_id", "timestamp", "actor_id", "action", "target_type", "target_id", "details"];
  const row = (target: unknown, details: unknown = "x"): unknown[] => ["LOG_1", new Date("2026-11-22T03:10:00Z"), "S_1", "reconcile.day", "validation_results", target, details];
  const tr = (cells: unknown[]) => translateTab("audit_log", LOG, [cells], opts());

  it("an audit row's target that is a date cell at midnight in Toronto is read back as the day the app wrote", () => {
    const winter = tr(row(new Date("2026-11-21T05:00:00Z"))); // 00:00 EST
    expect(winter.rejects).toEqual([]);
    expect(winter.rows[0]?.["target_id"]).toBe("2026-11-21");
    const summer = tr(row(new Date("2026-07-04T04:00:00Z"))); // 00:00 EDT
    expect(summer.rows[0]?.["target_id"]).toBe("2026-07-04");
    expect(winter.status === "ok" && winter.retyped).toEqual([{ row: 3, column: "target_id" }]);
  });
  it("a target that is text is left alone and not counted", () => {
    const r = tr(row("2026-11-21"));
    expect(r.rows[0]?.["target_id"]).toBe("2026-11-21");
    expect(r.status === "ok" && r.retyped).toEqual([]);
  });
  it("a date cell with a time of day is still a reject: what the app wrote cannot be known", () => {
    const r = tr(row(new Date("2026-11-21T15:30:00Z")));
    expect(r.rows).toEqual([]);
    expect(r.rejects).toEqual([{ tab: "audit_log", row: 3, column: "target_id", reason: "not text (a date with a time of day)" }]);
  });
  it("a date cell in any other text column is still a reject, and the reason says what the cell is", () => {
    const r = tr(row("VAP-1", new Date("2026-11-21T05:00:00Z")));
    expect(r.rejects).toEqual([{ tab: "audit_log", row: 3, column: "details", reason: "not text (a date)" }]);
    const note = one("sales", "misc_notes", new Date("2026-11-21T05:00:00Z"));
    expect(note.rejects.map((x) => x.reason)).toEqual(["not text (a date)"]);
  });
  it("an invalid date is a reject", () => {
    expect(tr(row(new Date(NaN))).rejects.map((x) => x.reason)).toEqual(["not text (a date)"]);
  });
});

describe("enum columns", () => {
  it.each<[string, string, unknown, unknown]>([
    ["till_sessions", "status", "Closed", "closed"],
    ["till_sessions", "status", "CLOSED", "closed"],
    ["till_sessions", "status", "  Closed\t", "closed"],
    ["till_sessions", "status", "   ", "REJECT"],
    ["till_sessions", "variance_status", "  ", null],
    ["till_sessions", "variance_status", " Pending_Validation ", "pending_validation"],
    ["till_sessions", "status", "validated", "validated"],
    ["till_sessions", "status", "bogus", "REJECT"],
    ["till_sessions", "status", "", "REJECT"],
    ["till_sessions", "status", "close d", "REJECT"],
    ["till_sessions", "variance_status", "ok", "OK"],
    ["till_sessions", "variance_status", "Investigate", "investigate"],
    ["till_sessions", "variance_status", "", null],
    ["till_sessions", "company", "Vape", "vape"],
    ["staff", "role", "Admin", "admin"],
    ["staff", "role", "owner", "REJECT"],
    ["attendance", "hours_basis", "Actual", "actual"],
    ["attendance", "hours_basis", "", null],
  ])("%s.%s %j", (tab, col, cell, expected) => {
    expect(value(tab, col, cell)).toEqual(expected);
  });

  it("a blank rule_type is percentage, as the contract says a blank cell always meant", () => {
    expect(value("commission_rules", "rule_type", "")).toBe("percentage");
    expect(value("commission_rules", "rule_type", "Fixed")).toBe("fixed");
  });
});

describe("rows", () => {
  it("a header in another column order gives the same rows", () => {
    const header = ["company", "sales_id", "date", "cash_sales", "staff_id", "session_id"];
    const cells = ["cstore", "SAL1", "2026-03-02", 10.5, "S_001", "CST-1"];
    const shuffled = ["session_id", "staff_id", "cash_sales", "date", "sales_id", "company"];
    const byName = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    const a = translateTab("sales", header, [cells], opts());
    const b = translateTab("sales", shuffled, [shuffled.map((h) => byName[h])], opts());
    expect(a.status).toBe("ok");
    expect(a.rows).toEqual(b.rows);
    expect(a.rows[0]).toMatchObject({ sales_id: "SAL1", cash_sales: 10.5, store_id: "store_main" });
  });

  it("an unknown header and a missing column are each reported once, not per row", () => {
    const header = ["sales_id", "session_id", "staff_id", "company", "date", "mystery"];
    const rows = Array.from({ length: 50 }, (_v, i) => [`SAL${i}`, `C${i}`, "S_001", "cstore", "2026-03-02", "x"]);
    const r = translateTab("sales", header, rows, opts());
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.rows).toHaveLength(50);
    const unknown = r.headerIssues.filter((i) => i.kind === "unknown_header");
    expect(unknown).toEqual([{ tab: "sales", kind: "unknown_header", column: "mystery" }]);
    const missing = r.headerIssues.filter((i) => i.kind === "missing_column").map((i) => i.column);
    expect(missing).toContain("cash_sales");
    expect(missing).toContain("misc_card_sales");
    expect(missing).not.toContain("store_id");
    expect(new Set(missing).size).toBe(missing.length);
    expect(r.rejects).toEqual([]);
    expect(r.rows[0]).not.toHaveProperty("mystery");
    expect(r.rows[0]).not.toHaveProperty("cash_sales");
  });

  it("a blank primary key is skipped silently and counted, not rejected", () => {
    const header = ["sales_id", "session_id", "staff_id", "company", "date"];
    const rows = [
      ["SAL1", "C1", "S_001", "cstore", "2026-03-02"],
      ["", "", "", "", ""],
      ["   ", null, null, null, null],
      ["SAL2", "C2", "S_001", "cstore", "2026-03-03"],
    ];
    const r = translateTab("sales", header, rows, opts());
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.rows.map((x) => x["sales_id"])).toEqual(["SAL1", "SAL2"]);
    expect(r.skipped).toBe(2);
    expect(r.rejects).toEqual([]);
    expect(r.read).toBe(4);
  });

  it("a row with a blank key but other values is a reject, never skipped: it may be money", () => {
    const header = ["sales_id", "session_id", "staff_id", "company", "date", "cash_sales"];
    const rows = [
      ["SAL1", "C1", "S_001", "cstore", "2026-03-02", 10],
      ["", "C2", "S_001", "cstore", "2026-03-03", 55555.55],
      ["  ", "", "", "", "", ""],
      ["", "", "", "", "", 0],
    ];
    const r = translateTab("sales", header, rows, opts());
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.rows.map((x) => x["sales_id"])).toEqual(["SAL1"]);
    expect(r.skipped).toBe(1); // only the row with nothing in it
    expect(r.rejects.map(({ tab, row, column }) => ({ tab, row, column }))).toEqual([
      { tab: "sales", row: 4, column: "sales_id" },
      { tab: "sales", row: 6, column: "sales_id" },
    ]);
    expect(r.rejectedRows).toBe(2);
    expect(r.rows.length + r.skipped + r.rejectedRows + r.leftOut).toBe(r.read);
    expect(JSON.stringify(r.rejects)).not.toContain("55555");
  });

  it("a reject carries tab, Sheet row number and column, never the value; the row is left out whole", () => {
    const SECRET = 987654.321;
    const header = ["sales_id", "session_id", "staff_id", "company", "date", "cash_sales", "misc_notes"];
    const rows = [
      ["SAL1", "C1", "S_001", "cstore", "2026-03-02", 10, "fine"],
      ["SAL2", "C2", "S_001", "cstore", "2026-03-03", SECRET, "fine"],
      ["SAL3", "C3", "S_001", "cstore", "not-a-date-DISTINCT-77", 5, "fine"],
      ["SAL4", "C4", "S_001", "Bogus-Company-DISTINCT-88", "2026-03-04", 5, "fine"],
    ];
    const r = translateTab("sales", header, rows, opts());
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.rows.map((x) => x["sales_id"])).toEqual(["SAL1"]);
    expect(r.rejects.map(({ tab, row, column }) => ({ tab, row, column }))).toEqual([
      { tab: "sales", row: 4, column: "cash_sales" },
      { tab: "sales", row: 5, column: "date" },
      { tab: "sales", row: 6, column: "company" },
    ]);
    expect(r.rejectedRows).toBe(3);
    const json = JSON.stringify(r.rejects);
    for (const leak of ["987654", "DISTINCT", "not-a-date", "Bogus"]) expect(json).not.toContain(leak);
    for (const rej of r.rejects) expect(Object.keys(rej).sort()).toEqual(["column", "reason", "row", "tab"]);
  });

  it("the first data row is Sheet row 3, or options.firstRow", () => {
    const r = one("sales", "cash_sales", 1.234);
    expect(r.rejects[0]?.row).toBe(3);
    const r2 = one("sales", "cash_sales", 1.234, { firstRow: 10 });
    expect(r2.rejects[0]?.row).toBe(10);
  });

  it("both card shapes on one sales row are copied as they are", () => {
    const header = ["sales_id", "session_id", "staff_id", "company", "date", "credit_card_sales", "debit_card_sales", "card_total_sales"];
    const r = translateTab("sales", header, [["SAL1", "C1", "S_001", "vape", "2026-03-02", 10, 20, 30]], opts());
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.rejects).toEqual([]);
    expect(r.rows[0]).toMatchObject({ credit_card_sales: 10, debit_card_sales: 20, card_total_sales: 30 });
  });

  it("a blank in the unused card shape stays NULL, a zero stays a zero", () => {
    const header = ["sales_id", "session_id", "staff_id", "company", "date", "credit_card_sales", "card_total_sales", "cash_sales"];
    const r = translateTab("sales", header, [["SAL1", "C1", "S_001", "cstore", "2026-03-02", "", 55, 0]], opts());
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.rows[0]).toMatchObject({ credit_card_sales: null, card_total_sales: 55, cash_sales: 0 });
  });

  it("store_id is filled from options, default store_main, on tables that have it", () => {
    const a = one("sales", "cash_sales", 1);
    expect(a.status === "ok" && a.rows[0]?.["store_id"]).toBe("store_main");
    const b = one("sales", "cash_sales", 1, { storeId: "store_two" });
    expect(b.status === "ok" && b.rows[0]?.["store_id"]).toBe("store_two");
    const c = one("staff", "name", "N", { storeId: "store_two" });
    expect(c.status === "ok" && c.rows[0]).not.toHaveProperty("store_id");
  });

  it("only the faithful copy exists", () => {
    expect(() => one("sales", "cash_sales", 1, { faithful: false })).toThrow(/faithful/);
  });
});

describe("what the contract leaves out", () => {
  it("a left-out tab is an explicit not-migrated result, not an error", () => {
    for (const tab of ["suppliers", "shopping_list", "product_master", "_pm_beer_staging", "pos_extracted", "clover_batches", "order_catalog", "product_beer_detail", "product_cigarettes_detail", "product_vape_detail", "_pm_cig_staging", "_pm_vape_staging", "_pm_other_staging"]) {
      const r = translateTab(tab, ["a"], [["x"], ["y"]], opts());
      expect(r.status).toBe("not_migrated");
      expect(r.rows).toEqual([]);
      expect(r.rejects).toEqual([]);
      if (r.status === "not_migrated") {
        expect(r.reason.length).toBeGreaterThan(0);
        expect(r.read).toBe(2);
      }
    }
  });

  it("a tab nobody has heard of is not-migrated too, with its own reason", () => {
    const r = translateTab("some_new_tab", ["a"], [["x"]], opts());
    expect(r.status).toBe("not_migrated");
  });

  it("staff.login_code is dropped without a reject or a warning, and never reaches a row", () => {
    const header = ["staff_id", "name", "login_code", "role", "active"];
    const r = translateTab("staff", header, [["S_001", "Fictional Person", "1234", "admin", true]], opts());
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.rows[0]).not.toHaveProperty("login_code");
    expect(JSON.stringify(r.rows)).not.toContain("1234");
    expect(r.rejects).toEqual([]);
    expect(r.headerIssues.filter((i) => i.column === "login_code")).toEqual([]);
  });

  it("config secrets and the shopping-list template are left out and counted", () => {
    const header = ["key", "value", "description"];
    const rows = [
      ["cash_manager_staff_id", "S_002", ""],
      ["whatsapp_api_token", "tok-123", ""],
      ["clover_cstore_token", "tok-456", ""],
      ["some_SECRET", "x", ""],
      ["clover_api_key", "x", ""],
      ["admin_password_hint", "x", ""],
      ["Login_Password", "x", ""],
      ["whatsapp_template_shopping_list", "shopping_list", ""],
      ["whatsapp_api_url", "https://example.invalid/v1", ""],
      ["token_expiry_note", "ok", ""],
    ];
    const r = translateTab("config", header, rows, opts());
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.rows.map((x) => x["key"])).toEqual(["cash_manager_staff_id", "whatsapp_api_url", "token_expiry_note"]);
    expect(r.leftOut).toBe(7);
    expect(JSON.stringify(r)).not.toContain("tok-");
  });
});

describe("parseContract", () => {
  // Found on the owner's first dry run (Nov 27): Git on Windows checks files out with CRLF line
  // ends. The list of deprecated tabs was then read as empty, and the import refused all 13.
  it("reads the same contract from a checkout with Windows line endings", () => {
    const lf = readFileSync(new URL("../contracts/schema.sql", import.meta.url), "utf8");
    expect(lf.includes("\r")).toBe(false);
    const fromCrlf = parseContract(lf.replace(/\n/g, "\r\n"));
    const fromLf = parseContract(lf);
    expect(fromCrlf.leftTabs.size).toBe(13);
    expect([...fromCrlf.leftTabs]).toEqual([...fromLf.leftTabs]);
    expect([...fromCrlf.leftColumns]).toEqual([...fromLf.leftColumns]);
    expect(fromCrlf.tables).toEqual(fromLf.tables);
    for (const reason of fromCrlf.leftTabs.values()) expect(reason.endsWith("\r")).toBe(false);
  });

  it("reads types, scales, enums, primary keys, defaults and foreign keys from the real contract", () => {
    const c = contract.tables;
    expect(c["sales"]?.columns.find((x) => x.name === "cash_sales")).toMatchObject({ type: "numeric", precision: 12, scale: 2, notNull: false });
    expect(c["staff"]?.columns.find((x) => x.name === "hourly_rate")).toMatchObject({ scale: 4 });
    expect(c["staff"]?.columns.find((x) => x.name === "role")?.enumValues).toEqual(["admin", "manager", "employee", "payroll_admin"]);
    expect(c["staff"]?.columns.find((x) => x.name === "staff_id")).toMatchObject({ primaryKey: true, notNull: true });
    expect(c["commission_rules"]?.columns.find((x) => x.name === "rule_type")).toMatchObject({ defaultText: "percentage", notNull: true });
    expect(c["till_sessions"]?.columns.find((x) => x.name === "attendance_id")?.references).toBe("attendance");
    expect(c["audit_log"]?.columns.find((x) => x.name === "timestamp")).toMatchObject({ type: "timestamptz" });
    expect(c["commission_rules"]?.columns.find((x) => x.name === "percentage")?.enumValues).toBeUndefined();
    expect(contract.leftTabs.has("suppliers")).toBe(true);
    expect(contract.leftColumns.has("staff.login_code")).toBe(true);
  });
});
