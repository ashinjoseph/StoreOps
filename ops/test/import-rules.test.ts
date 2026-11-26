// The rules of the import tool (card P4-02), each alone: what the Sheet's history needs
// done to a row before it is loaded. The first half is pure (no database); the second loads
// a small hand-made Sheet into a real Postgres through the same hooks the tool uses.
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { verifyPin } from "../src/auth/pin";
import { ImportRefused } from "../src/import/errors";
import { loadTabs, readContract, type LoadResult } from "../src/import/load";
import {
  addPinHashes,
  blankOpenSessionClosing,
  checkPepper,
  createRules,
  dropPlaceholders,
  EXTRA_COLUMNS,
  leftOutConfigKeys,
  rejectDuplicateKeys,
  rekeyDuplicateItems,
  type RulesReport,
} from "../src/import/rules";
import { translateTab, type SheetTab, type TranslatedTab } from "../src/import/sheet-to-db";
import { createTestDb, type TestDb } from "./helpers/db";

const contract = readContract();
const PEPPER = "unit-test-pepper-0123456789";

/** Translate one tab the way loadTabs does. */
function tr(tab: string, header: string[], rows: unknown[][]): TranslatedTab {
  const r = translateTab(tab, header, rows, { contract });
  if (r.status !== "ok") throw new Error(`${tab} is not migrated`);
  return r;
}
const raw = (tab: string, header: unknown[], rows: unknown[][]): SheetTab => ({ tab, header, rows });

// ── Duplicate item ids ───────────────────────────────────────

describe("duplicate item ids are re-keyed, never rejected", () => {
  const H = ["item_id", "payment_id", "item_type", "ref_id", "amount"];
  const row = (id: string, ref: string, amount: number): unknown[] => [id, "P1", "shift", ref, amount];

  it("three items sharing one id become X, X-d2, X-d3 and are all kept, in order, and listed with their Sheet rows", () => {
    const tab = tr("payment_items", H, [row("ITM_1", "A_1", 10), row("ITM_1", "A_2", 20.5), row("OTHER", "A_9", 1), row("ITM_1", "A_3", 30)]);
    const rekeyed = rekeyDuplicateItems(tab, "item_id");
    expect(tab.rows.map((r) => r["item_id"])).toEqual(["ITM_1", "ITM_1-d2", "OTHER", "ITM_1-d3"]);
    expect(tab.rows.map((r) => r["amount"])).toEqual([10, 20.5, 1, 30]); // every row, every amount
    expect(rekeyed).toEqual([
      { table: "payment_items", originalId: "ITM_1", newId: "ITM_1-d2", row: 4 },
      { table: "payment_items", originalId: "ITM_1", newId: "ITM_1-d3", row: 6 },
    ]);
    expect(tab.rejects).toEqual([]);
    expect(tab.rejectedRows).toBe(0);
  });

  it("a new id is never one another row already has", () => {
    const tab = tr("payment_items", H, [row("X", "A_1", 1), row("X-d2", "A_2", 2), row("X", "A_3", 3)]);
    rekeyDuplicateItems(tab, "item_id");
    expect(tab.rows.map((r) => r["item_id"])).toEqual(["X", "X-d2", "X-d3"]);
  });

  it("the same for cash_handover_items, and a tab without repeats is left alone", () => {
    const h = ["item_id", "handover_id", "session_id", "amount"];
    const tab = tr("cash_handover_items", h, [["I1", "H1", "S1", 5], ["I1", "H1", "S2", 6]]);
    expect(rekeyDuplicateItems(tab, "item_id").map((k) => k.newId)).toEqual(["I1-d2"]);
    const clean = tr("cash_handover_items", h, [["I1", "H1", "S1", 5], ["I2", "H1", "S2", 6]]);
    expect(rekeyDuplicateItems(clean, "item_id")).toEqual([]);
  });

  // Orchestrator's ruling on landing (Nov 26): the audit log too. Its ids are the same one-second
  // stamp plus three random characters, a close writes four rows at once, and the schema's own
  // header says the Sheet held repeats. A rejected audit row would be a lost record of who did what.
  it("audit rows sharing one id are all kept, the later ones re-keyed, in the order written", () => {
    const h = ["log_id", "timestamp", "actor_id", "action", "target_type", "target_id"];
    const at = new Date("2026-03-02T15:00:00Z");
    const logs = tr("audit_log", h, [["LOG_1", at, "S_1", "till.close", "session", "A"], ["LOG_1", at, "S_1", "sales.create", "sales", "B"], ["LOG_2", at, "S_1", "x", "y", "C"], ["LOG_1", at, "S_1", "attendance.complete", "attendance", "D"]]);
    const { report, prepare } = createRules({ openSessionsBlank: false, pepper: PEPPER });
    return prepare({ translated: new Map([["audit_log", logs]]), tabs: [], contract }).then(() => {
      expect(logs.rows.map((r) => [r["log_id"], r["target_id"]])).toEqual([["LOG_1", "A"], ["LOG_1-d2", "B"], ["LOG_2", "C"], ["LOG_1-d3", "D"]]);
      expect(report.rekeyed.map((k) => [k.table, k.originalId, k.newId, k.row])).toEqual([["audit_log", "LOG_1", "LOG_1-d2", 4], ["audit_log", "LOG_1", "LOG_1-d3", 6]]);
      expect(logs.rejects).toEqual([]);
      expect(report.duplicateKeyRejects).toEqual({});
    });
  });

  it("the rules apply it to the two item tables and the audit log only, and reject a repeat anywhere else", () => {
    const items = tr("payment_items", H, [row("I", "A", 1), row("I", "B", 2)]);
    const pays = tr("payments", ["payment_id", "staff_id", "paid_on", "total_amount", "method"], [["P1", "S_1", "2026-03-02", 10, "cash"], ["P1", "S_1", "2026-03-03", 99, "cash"]]);
    const map = new Map([["payment_items", items], ["payments", pays]]);
    const { report, prepare } = createRules({ openSessionsBlank: false, pepper: PEPPER });
    return prepare({ translated: map, tabs: [], contract }).then(() => {
      expect(report.rekeyed).toHaveLength(1);
      expect(items.rows).toHaveLength(2);
      expect(pays.rows).toHaveLength(1);
      expect(report.duplicateKeyRejects).toEqual({ payments: 1 });
    });
  });
});

describe("a duplicate key anywhere else rejects the later row", () => {
  it("keeps the first, rejects the second with its Sheet row and the key column, and never the key", () => {
    const tab = tr("payments", ["payment_id", "staff_id", "paid_on", "total_amount", "method"], [
      ["PAY-SECRET-77", "S_1", "2026-03-02", 10, "cash"],
      ["PAY_2", "S_1", "2026-03-03", 20, "cash"],
      ["PAY-SECRET-77", "S_1", "2026-03-04", 30, "bank"],
    ]);
    expect(rejectDuplicateKeys(tab, "payment_id")).toBe(1);
    expect(tab.rows.map((r) => r["total_amount"])).toEqual([10, 20]);
    expect(tab.rowNumbers).toEqual([3, 4]);
    expect(tab.rejects).toHaveLength(1);
    expect(tab.rejects[0]).toMatchObject({ tab: "payments", row: 5, column: "payment_id" });
    expect(JSON.stringify(tab.rejects)).not.toContain("SECRET");
    expect(tab.rejectedRows).toBe(1);
    expect(tab.read).toBe(3);
    expect(tab.rows.length + tab.skipped + tab.rejectedRows + tab.leftOut).toBe(tab.read);
  });
});

// ── Placeholders ─────────────────────────────────────────────

describe("the seeded placeholders", () => {
  const RH = ["rule_id", "name", "applies_to", "company", "active", "rule_type"];
  const BH = ["bonus_id", "staff_id", "date", "type", "amount", "status", "source_run_id", "source_rule_id"];
  const rules = (active: boolean): TranslatedTab => tr("commission_rules", RH, [["CR_001", "Placeholder", "all_staff", "cstore", active, "percentage"], ["CR_002", "Real", "all_staff", "vape", true, "percentage"]]);
  const runs = (): TranslatedTab => tr("commission_runs", ["run_id", "week_start", "week_end"], [["CRN_PLACEHOLDER_001", "2026-03-02", "2026-03-08"], ["CRN_20260309_x", "2026-03-09", "2026-03-15"]]);
  const bonuses = (rule: string, run: string): TranslatedTab => tr("bonuses", BH, [["B1", "S_1", "2026-03-02", "commission", 5, "proposed", run, rule]]);

  it("CR_001 is left out when it is inactive and no bonus refers to it, and counted as left out", () => {
    const rs = rules(false);
    const out = dropPlaceholders(new Map([["commission_rules", rs]]));
    expect(rs.rows.map((r) => r["rule_id"])).toEqual(["CR_002"]);
    expect(rs.leftOut).toBe(1);
    expect(out).toEqual([expect.objectContaining({ table: "commission_rules", id: "CR_001", row: 3 })]);
  });
  it("CR_001 is kept when it is active", () => {
    const rs = rules(true);
    expect(dropPlaceholders(new Map([["commission_rules", rs]]))).toEqual([]);
    expect(rs.rows).toHaveLength(2);
  });
  it("CR_001 is kept when a bonus refers to it, even inactive", () => {
    const rs = rules(false);
    expect(dropPlaceholders(new Map([["commission_rules", rs], ["bonuses", bonuses("CR_001", "R1")]]))).toEqual([]);
    expect(rs.rows).toHaveLength(2);
  });
  it("another inactive rule is never touched", () => {
    const rs = tr("commission_rules", RH, [["CR_007", "Retired", "all_staff", "cstore", false, "percentage"]]);
    dropPlaceholders(new Map([["commission_rules", rs]]));
    expect(rs.rows).toHaveLength(1);
  });
  it("the CRN_PLACEHOLDER run is left out unless a bonus refers to it", () => {
    const a = runs();
    dropPlaceholders(new Map([["commission_runs", a]]));
    expect(a.rows.map((r) => r["run_id"])).toEqual(["CRN_20260309_x"]);
    expect(a.leftOut).toBe(1);
    const b = runs();
    dropPlaceholders(new Map([["commission_runs", b], ["bonuses", bonuses("", "CRN_PLACEHOLDER_001")]]));
    expect(b.rows).toHaveLength(2);
  });
});

// ── Open tills ───────────────────────────────────────────────

describe("an open till's closing columns (the owner's open question; off by default)", () => {
  const H = ["session_id", "attendance_id", "staff_id", "company", "date", "status", "opening_float", "closing_cash_counted", "cash_left_in_till", "cash_removed_at_close", "expected_cash", "closing_variance"];
  const sessions = (): TranslatedTab =>
    tr("till_sessions", H, [
      ["CST-1", "A1", "S_1", "cstore", "2026-03-02", "Open", 250, 0, 0, 0, 0, 0],
      ["CST-2", "A2", "S_1", "cstore", "2026-03-02", "closed", 250, 412.5, 100, 312.5, 400, 12.5],
      ["VAP-3", "A3", "S_1", "vape", "2026-03-02", "open", 100, "", "", "", "", ""],
    ]);

  it("without the flag the zeros are copied as they are, and the rows it would touch are counted", () => {
    const t = sessions();
    const rep = blankOpenSessionClosing(t, false);
    expect(t.rows[0]).toMatchObject({ closing_cash_counted: 0, cash_left_in_till: 0, closing_variance: 0 });
    expect(rep).toMatchObject({ flag: false, openRows: 2, rowsWithClosingFigures: 1 });
  });
  it("with the flag an open row's closing columns are NULL; a closed row and the opening float are not touched", () => {
    const t = sessions();
    const rep = blankOpenSessionClosing(t, true);
    expect(t.rows[0]).toMatchObject({ opening_float: 250, closing_cash_counted: null, cash_left_in_till: null, cash_removed_at_close: null, expected_cash: null, closing_variance: null });
    expect(t.rows[1]).toMatchObject({ closing_cash_counted: 412.5, cash_left_in_till: 100, closing_variance: 12.5 });
    expect(rep).toMatchObject({ flag: true, openRows: 2, rowsWithClosingFigures: 1 });
  });
  it("is a flag of createRules, off unless asked for", async () => {
    for (const flag of [false, true]) {
      const t = sessions();
      const { report, prepare } = createRules({ openSessionsBlank: flag, pepper: PEPPER });
      await prepare({ translated: new Map([["till_sessions", t]]), tabs: [], contract });
      expect(t.rows[0]?.["closing_cash_counted"]).toBe(flag ? null : 0);
      expect(report.openSessions.flag).toBe(flag);
    }
  });
});

// ── Config secrets ───────────────────────────────────────────

describe("config secrets are reported by key name only", () => {
  it("lists the credential keys of the registry and the secret-looking ones, with their rows, and never a value", () => {
    const tab = raw("config", ["key", "value", "description"], [
      ["cash_manager_staff_id", "S_002", ""],
      ["whatsapp_api_token", "TOKEN-VALUE-1", ""],
      ["clover_cstore_token", "TOKEN-VALUE-2", ""],
      ["clover_vape_token", "TOKEN-VALUE-3", ""],
      ["partner_api_key", "TOKEN-VALUE-4", ""],
      ["whatsapp_template_shopping_list", "x", ""],
      ["weird key with TOKEN-VALUE-5 password", "x", ""],
    ]);
    const found = leftOutConfigKeys(tab);
    expect(found.map((f) => f.key)).toEqual(["whatsapp_api_token", "clover_cstore_token", "clover_vape_token", "partner_api_key", "whatsapp_template_shopping_list", "(unusual name)"]);
    expect(found.map((f) => f.row)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(JSON.stringify(found)).not.toContain("TOKEN-VALUE");
  });
  it("the translation leaves exactly those rows out", () => {
    const t = tr("config", ["key", "value", "description"], [["whatsapp_api_token", "v", ""], ["clover_vape_token", "v", ""], ["timezone", "America/Toronto", ""]]);
    expect(t.rows.map((r) => r["key"])).toEqual(["timezone"]);
    expect(t.leftOut).toBe(2);
  });
});

// ── PINs ─────────────────────────────────────────────────────

describe("staff.login_code becomes pin_hash", () => {
  const H = ["staff_id", "name", "active", "role", "login_code"];
  const rows = [
    ["S_1", "Asha Example", true, "admin", "4821"],
    ["S_2", "Ben Sample", true, "employee", ""],
    ["S_3", "Cy Placeholder", true, "employee", 7305], // a number cell
    ["S_4", "Di Fictional", true, "employee", " 123456 "],
    ["S_5", "Ed Made-up", true, "employee", "abc"],
    ["S_6", "Flo Invented", true, "employee", new Date("2026-03-02T05:00:00Z")],
  ];

  it("each code verifies against its hash, with the pepper and only with it; the old trim is kept; blank leaves NULL", async () => {
    const staff = tr("staff", H, rows);
    const rep = await addPinHashes(staff, raw("staff", H, rows), PEPPER);
    const hash = (id: string): string | null => (staff.rows.find((r) => r["staff_id"] === id)?.["pin_hash"] as string | null | undefined) ?? null;
    expect(await verifyPin("4821", hash("S_1") as string, PEPPER)).toBe(true);
    expect(await verifyPin("4821", hash("S_1") as string, `${PEPPER}x`)).toBe(false);
    expect(await verifyPin("4822", hash("S_1") as string, PEPPER)).toBe(false);
    expect(hash("S_2")).toBeNull();
    expect(await verifyPin("7305", hash("S_3") as string, PEPPER)).toBe(true);
    expect(await verifyPin("123456", hash("S_4") as string, PEPPER)).toBe(true);
    expect(await verifyPin("abc", hash("S_5") as string, PEPPER)).toBe(true);
    expect(hash("S_6")).toBeNull();
    expect(rep.hashed).toBe(4);
    expect(rep.blank.map((b) => b.staffId)).toEqual(["S_2", "S_6"]);
    expect(rep.blank[0]).toEqual({ staffId: "S_2", row: 4 });
    expect(rep.unreadable).toBe(1);
    expect(rep.notFourToEightDigits).toBe(1);
    expect(staff.rows.every((r) => !("login_code" in r))).toBe(true);
  });

  it("the plaintext appears nowhere in the rows, the report or anything thrown", async () => {
    const staff = tr("staff", H, rows);
    const rep = await addPinHashes(staff, raw("staff", H, rows), PEPPER);
    const everything = JSON.stringify([staff.rows, rep]);
    for (const code of ["4821", "7305", "123456", "abc"]) expect(everything).not.toContain(`"${code}"`);
    expect(everything).not.toContain("4821");
    expect(everything).not.toContain(PEPPER);
  });

  it("a Sheet with no login_code column leaves every pin_hash NULL and reports everyone as blank", async () => {
    const staff = tr("staff", ["staff_id", "name", "active", "role"], [["S_1", "A", true, "admin"]]);
    const rep = await addPinHashes(staff, raw("staff", ["staff_id", "name", "active", "role"], [["S_1", "A", true, "admin"]]), PEPPER);
    expect(staff.rows[0]?.["pin_hash"]).toBeNull();
    expect(rep.blank).toHaveLength(1);
  });

  it("a missing or short pepper is refused, and nothing is hashed", async () => {
    expect(() => checkPepper(undefined)).toThrow(ImportRefused);
    expect(() => checkPepper("")).toThrow(/PIN_PEPPER/);
    expect(() => checkPepper("short")).toThrow(/shorter than 16/);
    expect(checkPepper(PEPPER)).toBe(PEPPER);
    const staff = tr("staff", H, rows);
    await expect(addPinHashes(staff, raw("staff", H, rows), "short")).rejects.toThrow(ImportRefused);
    expect(staff.rows.some((r) => "pin_hash" in r)).toBe(false);
    expect(() => createRules({ openSessionsBlank: false, pepper: "" })).toThrow(ImportRefused);
  });
});

// ── Dates ────────────────────────────────────────────────────

describe("a date-time in a date column keeps only its Toronto day", () => {
  const week = (cell: unknown): unknown => tr("commission_runs", ["run_id", "week_end"], [["R1", cell]]).rows[0]?.["week_end"];
  it("week_end, stored as Sunday 23:59:59 or 23:59:59.999", () => {
    expect(week(new Date("2026-03-02T04:59:59.000Z"))).toBe("2026-03-01"); // Sunday 1 March, 23:59:59 EST
    expect(week(new Date("2026-03-02T04:59:59.999Z"))).toBe("2026-03-01");
    expect(week(new Date("2026-11-02T04:59:59.999Z"))).toBe("2026-11-01"); // the Sunday the clocks went back
    expect(week(new Date("2026-07-06T03:59:59.999Z"))).toBe("2026-07-05"); // summer time (EDT)
    expect(week(new Date("2026-03-02T05:00:00.000Z"))).toBe("2026-03-02"); // the next midnight is the next day
  });
  it("a cash handover's handed_on, whatever the time of day", () => {
    const handed = (cell: unknown): unknown =>
      tr("cash_handovers", ["handover_id", "from_staff_id", "to_staff_id", "amount", "handed_on", "recorded_by", "status"], [["H1", "S_1", "S_2", 5, cell, "S_1", "recorded"]]).rows[0]?.["handed_on"];
    expect(handed(new Date("2026-03-03T15:00:00Z"))).toBe("2026-03-03"); // 10:00 Toronto
    expect(handed(new Date("2026-03-04T04:30:00Z"))).toBe("2026-03-03"); // 23:30 Toronto
  });
});

// ── Against a database ───────────────────────────────────────

const STAFF = raw("staff", ["staff_id", "name", "hourly_rate", "active", "role", "login_code"], [
  ["S_001", "Asha Example", 17.5, true, "admin", "4821"],
  ["S_002", "Ben Sample", "", true, "employee", ""],
]);
const ATT = raw("attendance", ["attendance_id", "staff_id", "date", "status"], [
  ["A_1", "S_001", "2026-03-02", "worked"],
  ["A_2", "S_002", "2026-03-02", "worked"],
]);
const SESS = raw("till_sessions", ["session_id", "attendance_id", "staff_id", "company", "date", "status", "closing_cash_counted", "cash_left_in_till"], [
  ["CST-C", "A_1", "S_001", "cstore", "2026-03-02", "Closed", 100, 50],
  ["CST-A", "A_1", "S_001", "cstore", "2026-03-03", " closed ", 200, 60],
  ["VAP-B", "A_2", "S_002", "vape", "2026-03-02", "open", 0, 0],
]);
const SALES = raw("sales", ["sales_id", "session_id", "staff_id", "company", "date", "cash_sales"], [
  ["SAL_9", "CST-C", "S_001", "cstore", "2026-03-02", 10],
  ["SAL_1", "CST-A", "S_001", "cstore", "2026-03-03", 20],
  ["SAL_5", "VAP-B", "S_002", "vape", "2026-03-02", 30],
]);
const PAYMENTS = raw("payments", ["payment_id", "staff_id", "paid_on", "total_amount", "method"], [
  ["PAY_Z", "S_001", "2026-03-04", 60, "cash"],
  ["PAY_B", "S_002", "2026-03-04", 25, "Bank"],
  ["PAY_M", "S_001", "2026-03-05", 5, "cash"],
]);
const ITEMS = raw("payment_items", ["item_id", "payment_id", "item_type", "ref_id", "amount"], [
  ["ITM_X", "PAY_Z", "shift", "A_1", 10],
  ["ITM_X", "PAY_Z", "shift", "A_2", 20],
  ["ITM_X", "PAY_B", "shift", "A_1", 25],
]);
const config = (): SheetTab => raw("config", ["key", "value", "description"], [["timezone", "America/Toronto", ""], ["whatsapp_api_token", "TOKEN-VALUE-9", ""]]);
const mini = (...extra: SheetTab[]): SheetTab[] => [config(), STAFF, ATT, SESS, SALES, PAYMENTS, ITEMS, ...extra];

describe("rules against a database", () => {
  const dbs: TestDb[] = [];
  const clients: pg.Client[] = [];
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
    await Promise.all(dbs.map((d) => d.drop()));
  });

  async function load(tabs: SheetTab[], opts: { open?: boolean; batchRows?: number } = {}): Promise<{ result: LoadResult; report: RulesReport; q: (sql: string, p?: unknown[]) => Promise<Record<string, unknown>[]> }> {
    const db = await createTestDb();
    dbs.push(db);
    const c = new pg.Client({ connectionString: db.appUrl });
    await c.connect();
    clients.push(c);
    const { report, prepare } = createRules({ openSessionsBlank: opts.open ?? false, pepper: PEPPER });
    const result = await loadTabs(c, tabs, {
      contract,
      extraColumns: EXTRA_COLUMNS,
      prepare,
      ...(opts.batchRows !== undefined ? { batchRows: opts.batchRows } : {}),
    });
    return { result, report, q: async (sql, p = []) => (await c.query(sql, p)).rows as Record<string, unknown>[] };
  }

  it("rows are inserted in tab order, so the seq columns reproduce the Sheet's order (ids are not sorted)", async () => {
    const { result, q } = await load(mini(), { batchRows: 2 });
    expect(result.rejects).toEqual([]);
    expect((await q("select sales_id from ops.sales order by seq")).map((r) => r["sales_id"])).toEqual(["SAL_9", "SAL_1", "SAL_5"]);
    expect((await q("select payment_id from ops.payments order by seq")).map((r) => r["payment_id"])).toEqual(["PAY_Z", "PAY_B", "PAY_M"]);
    // the order survives a refused row in the middle of a batch
    const withBad = raw("sales", SALES.header, [
      ["SAL_9", "CST-C", "S_001", "cstore", "2026-03-02", 10],
      ["SAL_BAD", "NO-SUCH-SESSION", "S_001", "cstore", "2026-03-02", 99],
      ["SAL_1", "CST-A", "S_001", "cstore", "2026-03-03", 20],
      ["SAL_5", "VAP-B", "S_002", "vape", "2026-03-02", 30],
    ]);
    const b = await load(mini().map((t) => (t.tab === "sales" ? withBad : t)), { batchRows: 4 });
    expect((await b.q("select sales_id from ops.sales order by seq")).map((r) => r["sales_id"])).toEqual(["SAL_9", "SAL_1", "SAL_5"]);
  });

  it("three items sharing one id are all loaded, the later ones re-keyed and reported", async () => {
    const { report, q } = await load(mini());
    expect(await q("select item_id, amount::float8 as amount from ops.payment_items order by item_id")).toEqual([
      { item_id: "ITM_X", amount: 10 },
      { item_id: "ITM_X-d2", amount: 20 },
      { item_id: "ITM_X-d3", amount: 25 },
    ]);
    expect(report.rekeyed.map((k) => [k.originalId, k.newId, k.row])).toEqual([["ITM_X", "ITM_X-d2", 4], ["ITM_X", "ITM_X-d3", 5]]);
  });

  it("blank is NULL and zero is zero in the database; enums are normalised; voided columns are NULL", async () => {
    const { q } = await load(mini());
    expect((await q("select hourly_rate from ops.staff where staff_id = 'S_002'"))[0]?.["hourly_rate"]).toBeNull();
    expect((await q("select status from ops.till_sessions order by session_id")).map((r) => r["status"])).toEqual(["closed", "closed", "open"]);
    expect((await q("select method from ops.payments where payment_id = 'PAY_B'"))[0]?.["method"]).toBe("bank");
    expect((await q("select closing_cash_counted::float8 as v from ops.till_sessions where session_id = 'VAP-B'"))[0]?.["v"]).toBe(0);
    expect((await q("select count(*)::int as n from ops.payments where voided_at is null and voided_by is null and void_reason is null"))[0]?.["n"]).toBe(3);
  });

  it("--open-sessions-blank: the open row's closing columns are NULL, the closed rows keep theirs", async () => {
    const { q, report } = await load(mini(), { open: true });
    const r = await q("select session_id, closing_cash_counted::float8 as c, cash_left_in_till::float8 as l from ops.till_sessions order by session_id");
    expect(r).toEqual([
      { session_id: "CST-A", c: 200, l: 60 },
      { session_id: "CST-C", c: 100, l: 50 },
      { session_id: "VAP-B", c: null, l: null },
    ]);
    expect(report.openSessions).toMatchObject({ flag: true, openRows: 1, rowsWithClosingFigures: 1 });
  });

  it("pin_hash is written (and login_code and the secret config row are not), the other added columns take their defaults", async () => {
    const { q } = await load(mini());
    const staff = await q("select staff_id, pin_hash from ops.staff order by staff_id");
    expect(await verifyPin("4821", staff[0]?.["pin_hash"] as string, PEPPER)).toBe(true);
    expect(staff[1]?.["pin_hash"]).toBeNull();
    expect((await q("select key from ops.config order by key")).map((r) => r["key"])).toEqual(["timezone"]);
    expect(JSON.stringify(await q("select to_jsonb(x) from ops.staff x"))).not.toContain("login_code");
  });

  it("a row whose parent was rejected is rejected too, naming the parent's table and column, and the import goes on", async () => {
    const att = raw("attendance", ATT.header, [["A_1", "S_001", "2026-03-02", "worked"], ["A_2", "S_002", "2026-03-02", "NOT-A-STATUS"]]);
    const { result, q } = await load(mini().map((t) => (t.tab === "attendance" ? att : t)));
    const byTab = (tab: string) => result.rejects.filter((r) => r.tab === tab).map((r) => ({ row: r.row, column: r.column, reason: r.reason }));
    expect(byTab("attendance")).toEqual([{ row: 4, column: "status", reason: expect.stringContaining("not one of") }]);
    expect(byTab("till_sessions")).toEqual([{ row: 5, column: "attendance_id", reason: "its attendance_id refers to a row of attendance.attendance_id that was rejected or is missing" }]);
    expect(byTab("sales")).toEqual([{ row: 5, column: "session_id", reason: "its session_id refers to a row of till_sessions.session_id that was rejected or is missing" }]);
    expect((await q("select count(*)::int as n from ops.sales"))[0]?.["n"]).toBe(2);
    expect((await q("select count(*)::int as n from ops.payments"))[0]?.["n"]).toBe(3);
    expect(JSON.stringify(result.rejects)).not.toContain("NOT-A-STATUS");
  });

  it("a bonus whose run is missing is that row's reject, not a failed commit (the key is deferrable in the contract)", async () => {
    const bonuses = raw("bonuses", ["bonus_id", "staff_id", "date", "type", "amount", "status", "source_run_id"], [
      ["B_1", "S_001", "2026-03-02", "commission", 5, "proposed", "RUN_MISSING"],
      ["B_2", "S_001", "2026-03-02", "bonus", 7, "proposed", ""],
    ]);
    const { result, q } = await load(mini(bonuses));
    expect(result.rejects.filter((r) => r.tab === "bonuses")).toEqual([
      { tab: "bonuses", row: 3, column: "source_run_id", reason: "its source_run_id refers to a row of commission_runs.run_id that was rejected or is missing" },
    ]);
    expect((await q("select bonus_id from ops.bonuses"))).toEqual([{ bonus_id: "B_2" }]);
  });

  it("a figure that does not survive the round trip is a reject, never rounded", async () => {
    const sales = raw("sales", SALES.header, [["SAL_9", "CST-C", "S_001", "cstore", "2026-03-02", 12.345]]);
    const { result, q } = await load(mini().map((t) => (t.tab === "sales" ? sales : t)));
    expect(result.rejects).toEqual([{ tab: "sales", row: 3, column: "cash_sales", reason: "has more than 2 decimal places" }]);
    expect((await q("select count(*)::int as n from ops.sales"))[0]?.["n"]).toBe(0);
  });
});
