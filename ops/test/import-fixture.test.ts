// The repo's fictional fixture (about 120 days of the old server's own data),
// translated and loaded into a real Postgres, and checked against the Sheet
// cell by cell: counts, sums to the cent, nulls, dates, zeros.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatDate } from "../src/lib/dates";
import { configKeyLeftOut, type Column, type Contract, type SheetTab } from "../src/import/sheet-to-db";
import { readContract } from "../src/import/load";
import { bootFixture, loadFixture, type BootedFixture, type FixtureLoad } from "./helpers/fixture";
import { createTestDb, type TestDb } from "./helpers/db";

const contract: Contract = readContract();
const IDENT = /^[a-z_]+$/;

let boot: BootedFixture;
let dbA: TestDb;
let dbB: TestDb;
let dbC: TestDb;
let a: FixtureLoad;
let b: FixtureLoad;
let clientA: pg.Client;
let clientB: pg.Client;

beforeAll(async () => {
  boot = bootFixture();
  dbA = await createTestDb();
  dbB = await createTestDb();
  dbC = await createTestDb();
  a = await loadFixture(dbA, boot);
  b = await loadFixture(dbB, boot);
  clientA = new pg.Client({ connectionString: dbA.appUrl });
  clientB = new pg.Client({ connectionString: dbB.appUrl });
  await clientA.connect();
  await clientB.connect();
}, 180_000);

afterAll(async () => {
  await clientA?.end();
  await clientB?.end();
  await Promise.all([dbA?.drop(), dbB?.drop(), dbC?.drop()]);
});

const blank = (v: unknown): boolean => v === "" || v === null || v === undefined;
const isNumericType = (c: Column): boolean => c.type === "numeric" || c.type === "integer";

/** The Sheet rows that must be in the database: a primary key, and not a left-out config row. */
function keptRows(tab: SheetTab): unknown[][] {
  const table = contract.tables[tab.tab];
  if (!table) return [];
  const pk = table.columns.find((c) => c.primaryKey);
  const at = tab.header.findIndex((h) => String(h).trim() === pk?.name);
  const keyAt = tab.header.findIndex((h) => String(h).trim() === "key");
  return tab.rows.filter((r) => {
    if (blank(r[at]) || String(r[at]).trim() === "") return false;
    if (tab.tab === "config" && configKeyLeftOut(String(r[keyAt]))) return false;
    return true;
  });
}
const migratedTabs = (): SheetTab[] => boot.tabs.filter((t) => contract.tables[t.tab] !== undefined);
const cellsOf = (tab: SheetTab, col: string): unknown[] => {
  const at = tab.header.findIndex((h) => String(h).trim() === col);
  return keptRows(tab).map((r) => r[at]);
};

/** scaled integer to "123.45" the way Postgres prints numeric(_, scale). */
function fmt(scaled: bigint, scale: number): string {
  const neg = scaled < 0n;
  const digits = (neg ? -scaled : scaled).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  return (neg ? "-" : "") + (scale ? `${whole}.${digits.slice(-scale)}` : whole);
}

async function query(c: pg.Client, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await c.query(sql, params)).rows as Record<string, unknown>[];
}

async function allSums(c: pg.Client): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const tab of migratedTabs()) {
    const t = contract.tables[tab.tab];
    if (!t || !IDENT.test(t.name)) continue;
    out[`${t.name}.count`] = (await query(c, `select count(*)::int as n from ops."${t.name}"`))[0]?.["n"];
    for (const col of t.columns.filter(isNumericType)) {
      if (!IDENT.test(col.name)) continue;
      out[`${t.name}.${col.name}`] = (
        await query(c, `select sum("${col.name}")::text as s, count(*) filter (where "${col.name}" is null)::int as n from ops."${t.name}"`)
      )[0];
    }
  }
  return out;
}

describe("the fixture loads", () => {
  it("with zero rejects, and with no header the contract does not know", () => {
    expect(a.rejects).toEqual([]);
    expect(a.headerIssues).toEqual([]);
    expect(b.rejects).toEqual([]);
  });

  it("hands back the old runtime's api", () => {
    const util = a.api["Util"] as { formatDate?: unknown } | undefined;
    expect(typeof util?.formatDate).toBe("function");
    expect(typeof a.api["rpcLogin"]).toBe("function");
  });

  it("covers every migrated tab, and counts every left-out tab as left out", () => {
    const names = boot.tabs.map((t) => t.tab);
    for (const tab of names) expect(a.counts[tab], tab).toBeDefined();
    for (const left of ["suppliers", "shopping_list", "product_master", "product_vape_detail"]) {
      const c = a.counts[left];
      expect(c?.inserted).toBe(0);
      expect(c?.leftOut).toBe(c?.read);
    }
    expect(a.counts["config"]?.leftOut).toBeGreaterThan(0);
  });

  it("counts add up: read = inserted + skipped + rejected + left out", () => {
    for (const [tab, c] of Object.entries(a.counts)) {
      expect(c.inserted + c.skipped + c.rejected + c.leftOut, tab).toBe(c.read);
    }
  });

  it("no secret reached the database", async () => {
    const rows = await query(clientA, "select key from ops.config");
    const keys = rows.map((r) => String(r["key"]));
    expect(keys.some((k) => /_token$|_secret$|_api_key$|password/i.test(k))).toBe(false);
    expect(keys).not.toContain("whatsapp_template_shopping_list");
    expect(keys).toContain("cash_manager_staff_id");
    const staff = await query(clientA, "select column_name from information_schema.columns where table_schema = 'ops' and table_name = 'staff'");
    expect(staff.map((r) => r["column_name"])).not.toContain("login_code");
  });
});

describe("row counts", () => {
  it("every migrated tab has the Sheet's non-blank-key rows in Postgres", async () => {
    const checked: string[] = [];
    for (const tab of migratedTabs()) {
      const n = (await query(clientA, `select count(*)::int as n from ops."${tab.tab}"`))[0]?.["n"];
      expect(n, tab.tab).toBe(keptRows(tab).length);
      expect(a.counts[tab.tab]?.inserted, tab.tab).toBe(keptRows(tab).length);
      checked.push(tab.tab);
    }
    expect(checked).toContain("sales");
    expect(checked).toContain("audit_log");
    expect(checked.length).toBeGreaterThanOrEqual(12);
  });
});

describe("numeric columns", () => {
  it("every numeric column's sum is the Sheet's to the cent, and its NULL count is the Sheet's blank count", async () => {
    let columns = 0;
    for (const tab of migratedTabs()) {
      const t = contract.tables[tab.tab];
      if (!t) continue;
      for (const col of t.columns.filter(isNumericType)) {
        if (!tab.header.some((h) => String(h).trim() === col.name)) continue;
        const scale = col.scale ?? 0;
        const cells = cellsOf(tab, col.name);
        let sum = 0n;
        let seen = false;
        let blanks = 0;
        for (const v of cells) {
          if (blank(v)) {
            blanks++;
            continue;
          }
          seen = true;
          sum += BigInt(Math.round(Number(v) * 10 ** scale));
        }
        const got = (
          await query(clientA, `select sum("${col.name}")::text as s, count(*) filter (where "${col.name}" is null)::int as n from ops."${t.name}"`)
        )[0];
        expect(got?.["s"], `${t.name}.${col.name} sum`).toBe(seen ? fmt(sum, scale) : null);
        expect(got?.["n"], `${t.name}.${col.name} nulls`).toBe(blanks);
        columns++;
      }
    }
    expect(columns).toBeGreaterThan(40);
  });
});

describe("date columns", () => {
  it("min and max of every date column are the Sheet's, as Toronto days", async () => {
    let columns = 0;
    for (const tab of migratedTabs()) {
      const t = contract.tables[tab.tab];
      if (!t) continue;
      for (const col of t.columns.filter((c) => c.type === "date")) {
        if (!tab.header.some((h) => String(h).trim() === col.name)) continue;
        const days = cellsOf(tab, col.name)
          .filter((v) => !blank(v))
          .map((v) => (v instanceof Date ? formatDate(v) : String(v)))
          .sort();
        const got = (await query(clientA, `select min("${col.name}")::text as lo, max("${col.name}")::text as hi from ops."${t.name}"`))[0];
        expect(got?.["lo"], `${t.name}.${col.name} min`).toBe(days[0] ?? null);
        expect(got?.["hi"], `${t.name}.${col.name} max`).toBe(days[days.length - 1] ?? null);
        columns++;
      }
    }
    expect(columns).toBeGreaterThan(10);
  });

  it("the fixture's dates are Toronto days, not UTC days (the old server runs in Toronto)", async () => {
    const att = migratedTabs().find((t) => t.tab === "attendance");
    expect(att).toBeDefined();
    const day = cellsOf(att as SheetTab, "date")[0];
    expect(day).toBeInstanceOf(Date);
    const wall = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", hourCycle: "h23" }).format(day as Date);
    expect(wall).toBe("00");
  });
});

describe("blank is not zero, zero is not blank", () => {
  function first(pred: (v: unknown) => boolean): { tab: string; col: string; key: unknown } | undefined {
    for (const tab of migratedTabs()) {
      const t = contract.tables[tab.tab];
      const pk = t?.columns.find((c) => c.primaryKey);
      if (!t || !pk) continue;
      for (const col of t.columns.filter((c) => c.type === "numeric" && c.scale === 2)) {
        const at = tab.header.findIndex((h) => String(h).trim() === col.name);
        const kAt = tab.header.findIndex((h) => String(h).trim() === pk.name);
        if (at < 0) continue;
        for (const r of keptRows(tab)) if (pred(r[at])) return { tab: tab.tab, col: col.name, key: r[kAt] };
      }
    }
    return undefined;
  }

  it("the first blank money cell is NULL in Postgres", async () => {
    const hit = first(blank);
    expect(hit).toBeDefined();
    const h = hit as { tab: string; col: string; key: unknown };
    const pk = contract.tables[h.tab]?.columns.find((c) => c.primaryKey)?.name ?? "";
    const rows = await query(clientA, `select "${h.col}" as v from ops."${h.tab}" where "${pk}" = $1`, [String(h.key).trim()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["v"]).toBeNull();
  });

  it("the first zero money cell is 0.00 in Postgres, not NULL", async () => {
    const hit = first((v) => v === 0);
    expect(hit).toBeDefined();
    const h = hit as { tab: string; col: string; key: unknown };
    const pk = contract.tables[h.tab]?.columns.find((c) => c.primaryKey)?.name ?? "";
    const rows = await query(clientA, `select "${h.col}"::text as v from ops."${h.tab}" where "${pk}" = $1`, [String(h.key).trim()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["v"]).toBe("0.00");
  });

  it("the unused card shape is NULL on every cstore ePOS row and the used one is not", async () => {
    const r = await query(
      clientA,
      `select count(*) filter (where card_total_sales is not null and credit_card_sales is null and debit_card_sales is null)::int as single,
              count(*) filter (where credit_card_sales is not null and card_total_sales is null)::int as split,
              count(*) filter (where card_total_sales is not null and credit_card_sales is not null)::int as both
         from ops.sales`,
    );
    expect(r[0]?.["single"]).toBeGreaterThan(0);
    expect(r[0]?.["split"]).toBeGreaterThan(0);
    expect(r[0]?.["both"]).toBe(0);
  });
});

describe("two loads of the same fixture", () => {
  it("give identical counts and sums", async () => {
    expect(b.counts).toEqual(a.counts);
    expect(await allSums(clientB)).toEqual(await allSums(clientA));
  });
});

describe("a tampered fixture", () => {
  it("loads everything else and rejects exactly the three bad cells", async () => {
    const tabs: SheetTab[] = structuredClone(boot.tabs);
    const sheetOf = (name: string): SheetTab => {
      const t = tabs.find((x) => x.tab === name);
      if (!t) throw new Error(`no tab ${name}`);
      return t;
    };
    const set = (tab: string, idx: number, col: string, v: unknown): void => {
      const t = sheetOf(tab);
      const at = t.header.findIndex((h) => String(h).trim() === col);
      const row = t.rows[idx];
      if (at < 0 || !row) throw new Error("bad tamper target");
      row[at] = v;
    };
    set("sales", 5, "cash_sales", 12.345); // not a whole cent
    set("validation_results", 7, "status", "bogus_status_zz"); // not an enum value
    set("sales", 9, "staff_id", "S_404_ghost"); // no such staff

    const t = await loadFixture(dbC, { ...boot, tabs });
    const got = t.rejects.map(({ tab, row, column }) => ({ tab, row, column })).sort((x, y) => x.row - y.row);
    expect(got).toEqual([
      { tab: "sales", row: 8, column: "cash_sales" },
      { tab: "validation_results", row: 10, column: "status" },
      { tab: "sales", row: 12, column: "staff_id" },
    ]);
    const json = JSON.stringify(t.rejects);
    for (const leak of ["12.345", "bogus_status_zz", "S_404_ghost"]) expect(json).not.toContain(leak);

    for (const [tab, c] of Object.entries(t.counts)) {
      const clean = a.counts[tab];
      if (tab === "sales") {
        expect(c.rejected).toBe(2);
        expect(c.inserted).toBe((clean?.inserted ?? 0) - 2);
      } else if (tab === "validation_results") {
        expect(c.rejected).toBe(1);
        expect(c.inserted).toBe((clean?.inserted ?? 0) - 1);
      } else {
        expect(c, tab).toEqual(clean);
      }
    }
    const c = new pg.Client({ connectionString: dbC.appUrl });
    await c.connect();
    try {
      expect((await query(c, "select count(*)::int as n from ops.sales"))[0]?.["n"]).toBe((a.counts["sales"]?.inserted ?? 0) - 2);
      expect((await query(c, "select count(*)::int as n from ops.till_sessions"))[0]?.["n"]).toBe(a.counts["till_sessions"]?.inserted);
    } finally {
      await c.end();
    }
  }, 120_000);
});
