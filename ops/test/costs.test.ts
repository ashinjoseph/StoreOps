// What each item costs, from each supplier, over time, and a flag when a cost rises (card P5-15;
// ADR-0030). NEW in the Operations app (ADR-0023): these tests are its specification. A real database;
// the RPCs through the REAL router and merged contract; receipts are taken from an original to CONFIRMED
// with the review card's own RPCs. The pure parts (the item key, the unit cost, "more than N percent",
// the flags of a history) are tested as tables on their own. Invented shops, suppliers, items and figures only.
import { readFileSync, rmSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "../src/auth/sessions";
import { restoreNightly } from "../src/backup/restore";
import { memoryBackupBucket } from "../src/backup/storage";
import { connect } from "../src/db/client";
import { withTransaction, type Tx } from "../src/db/tx";
import { Config, loadConfig } from "../src/lib/config";
import * as costs from "../src/receipts/costs";
import * as originals from "../src/receipts/originals";
import { bucketStorage } from "../src/receipts/storage";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import { copyNow, downloadFolder, dumpAll } from "./helpers/backup";
import { createTestDb } from "./helpers/db";
import { makeWorld, setConfig, setDoor, type McpWorld } from "./helpers/mcp";

// A fault the tests can switch on inside the two calls review.ts makes, to see the confirm and the void fail as a
// whole. (A fault inside a database statement is also covered below; this one is a plain error before any statement.)
const fault = vi.hoisted(() => ({ observe: false, unobserve: false }));
vi.mock("../src/receipts/costs", async (original) => {
  const real = await original<typeof import("../src/receipts/costs")>();
  return {
    ...real,
    observeReceipt: (...a: Parameters<typeof real.observeReceipt>) => (fault.observe ? Promise.reject(new Error("injected: cannot observe")) : real.observeReceipt(...a)),
    unobserveReceipt: (...a: Parameters<typeof real.unobserveReceipt>) => (fault.unobserve ? Promise.reject(new Error("injected: cannot un-count")) : real.unobserveReceipt(...a)),
  };
});

// 2026-11-27 10:00 in Toronto.
const NOW = new Date("2026-11-27T15:00:00.000Z");
let w: McpWorld;
const T: Record<string, string> = {};
const ADMIN = "S_001";
const MANAGER = "S_002";
const EMPLOYEE = "S_003";
const PAYROLL = "S_004";
type Biz = "cstore" | "vape";

beforeAll(async () => {
  w = await makeWorld(NOW);
});
afterAll(async () => {
  await w?.close();
});
beforeEach(async () => {
  w.clock.now = NOW;
  fault.observe = false;
  fault.unobserve = false;
  for (const t of ["price_flags", "item_costs", "receipt_observations", "supplier_items", "business_signs", "supplier_names", "purchase_receipt_lines", "purchase_receipts", "suppliers", "receipt_upload_tickets", "receipt_originals", "assistant_calls", "audit_log", "sessions", "config"]) {
    await w.owner.query(`delete from ops.${t}`);
  }
  await w.owner.query("drop trigger if exists test_break_costs on ops.item_costs");
  await w.owner.query("update ops.staff set active = (staff_id <> 'S_005')");
  await setDoor(w, true);
  await setConfig(w, "cstore_business_name", "Fictional Corner Mart");
  await setConfig(w, "vape_business_name", "Fictional Vape Co");
  for (const id of [ADMIN, MANAGER, EMPLOYEE, PAYROLL]) T[id] = (await createSession(w.db, id, Config.fromRows([]), NOW)).token;
});

// ── Helpers (the review card's own, kept in step with ops/test/receipt-review.test.ts) ──

let serial = 0;
const tick = () => {
  w.clock.now = new Date(w.clock.now.getTime() + 1000);
};
async function original(): Promise<string> {
  tick();
  const bytes = new TextEncoder().encode(`%PDF-1.4\n% fictional receipt for costs ${++serial} ${Math.random()}\n%%EOF\n`);
  const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const r = await withTransaction(w.db, (tx) =>
    originals.add(tx, bucketStorage(w.bucket), { bytes, sha256, contentType: "application/pdf", business: null, source: "upload", fileName: `r${serial}.pdf`, note: null }, { staffId: EMPLOYEE, role: "employee" }, w.clock.now),
  );
  return (r.record as { id: string }).id;
}
const contract = parseRpcContract(
  mergeOpsContract(
    JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
    JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
  ),
);
type Answer = { ok: boolean; result?: any; error?: { message: string } };
async function rpc(name: string, args: unknown[]): Promise<Answer> {
  tick();
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
async function newSupplier(name: string): Promise<string> {
  return (await ok("rpcCreateReceiptSupplier", [T[MANAGER], { displayName: name }])).supplier.id;
}
const reviewOf = (id: string, by = MANAGER) => ok("rpcGetReceiptReview", [T[by], { id }]);
async function correct(id: string, fields: Record<string, unknown>, opts: { business: string; supplierId: string; by: string }): Promise<any> {
  const r = await reviewOf(id, opts.by);
  return ok("rpcSaveReceiptCorrection", [T[opts.by], { original_id: id, draft_id: r.draft.id, business: opts.business, supplier_id: opts.supplierId, ...fields }]);
}
async function confirmIt(id: string, by: string, reason: string | undefined): Promise<Answer> {
  const r = await reviewOf(id, by);
  return rpc("rpcConfirmReceipt", [T[by], { originalId: id, draftId: r.draft?.id, reason, learnSigns: [], rememberSpelling: false }]);
}

interface L {
  description: string;
  code?: string | null;
  quantity?: string | number | null;
  unit_price?: string | number | null;
  total?: string | number | null;
  taxed?: boolean;
}
interface Made {
  originalId: string;
  id: string;
  costs: any;
  result: any;
}
/** A receipt taken from an original to CONFIRMED on `business`'s books, through the RPCs. */
async function receipt(o: { business?: Biz; supplierId: string; date: string; lines: L[]; by?: string; total?: string }): Promise<Made> {
  const by = o.by ?? MANAGER;
  const id = await original();
  const body = { supplier: { name: "Fictional Wholesale Ltd" }, invoice_number: `INV-${++serial}`, date: o.date, paid: { how: "cash" }, amounts: { total: o.total ?? "99.00" }, kind: "stock", lines: o.lines };
  await ok("rpcEnterReceiptDraft", [T[by], { original_id: id, ...body }]);
  await correct(id, body, { business: o.business ?? "cstore", supplierId: o.supplierId, by });
  const c = await confirmIt(id, by, "fictional figures typed for the test");
  if (!c.ok) throw new Error(`confirm: ${c.error?.message}`);
  return { originalId: id, id: c.result.receipt.id, costs: c.result.costs, result: c.result };
}
const cola = (price: string | number, extra: Partial<L> = {}): L => ({ description: "Cola 12-pack", code: "CK12", quantity: 2, unit_price: price, ...extra });
const flagList = async (business: Biz, state?: string, by = MANAGER): Promise<any> => ok("rpcGetPriceFlags", [T[by], { business, ...(state === undefined ? {} : { state }) }]);
const itemsOf = async (business: Biz, extra: Record<string, unknown> = {}, by = MANAGER): Promise<any> => ok("rpcFindItems", [T[by], { business, ...extra }]);
const history = (itemId: string, by = MANAGER) => ok("rpcGetItemCosts", [T[by], { itemId }]);
const count = async (t: string) => (await w.owner.one<{ n: number }>(`select count(*)::int as n from ops.${t}`)).n;
const audits = (like: string) => w.owner.query<any>(`select actor_id, action, target_type, target_id, "before", "after" from ops.audit_log where action like $1 order by seq`, [like]);
const tables = ["supplier_items", "item_costs", "price_flags", "receipt_observations"];
const counts = async () => {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = await count(t);
  return out;
};

// ── The pure parts, as tables ─────────────────────────────

describe("the item key", () => {
  it.each([
    ["the supplier's code wins over the description", "CK12", "Cola 12-pack", "c:ck12"],
    ["spacing and case do not matter in a code", " ck 12 ", "Cola 12-pack", "c:ck12"],
    ["dashes do not matter in a code", "CK-12", "anything", "c:ck12"],
    ["a blank code falls back to the description", "", "Cola 12-pack", "d:cola12pack"],
    ["a code of spaces falls back to the description", "   ", "Cola 12-Pack", "d:cola12pack"],
    ["no code at all", null, "COLA  12 - PACK", "d:cola12pack"],
    ["a code of nothing but dashes falls back", "--", "Cola", "d:cola"],
    ["full-width characters are normalised", "ＣＫ１２", "x", "c:ck12"],
  ] as Array<[string, string | null, string, string]>)("%s", (_n, code, description, key) => {
    expect(costs.itemKey(code, description)).toBe(key);
  });
  it("a code and a description of the same letters are different items", () => {
    expect(costs.itemKey("cola", "x")).not.toBe(costs.itemKey(null, "cola"));
  });
  it("a line with nothing to identify it has no key", () => {
    expect(costs.itemKey(null, " - - ")).toBeNull();
    expect(costs.itemKey("", "—")).toBeNull();
  });
});

describe("the unit cost of a line", () => {
  const line = (quantity: number | null, unitPrice: number | null, total: number | null) => costs.unitCostOf({ quantity, unitPrice, total });
  it.each([
    ["a printed unit price is the cost, as stored", 2000, 12000, 24000, { cost: 12000, how: "printed" }],
    ["a four-decimal printed price", 1000, 3333, 3333, { cost: 3333, how: "printed" }],
    ["a printed price wins over a total that disagrees", 3000, 15000, 100, { cost: 15000, how: "printed" }],
    ["a printed price with no quantity and no total", null, 14590, null, { cost: 14590, how: "printed" }],
    ["worked out: 6.00 for 2 is 3.0000", 2000, null, 600, { cost: 30000, how: "worked_out" }],
    ["worked out: 10.00 for 3 is 3.3333 (rounded down)", 3000, null, 1000, { cost: 33333, how: "worked_out" }],
    ["worked out: 20.00 for 3 is 6.6667 (rounded up)", 3000, null, 2000, { cost: 66667, how: "worked_out" }],
    ["worked out exactly: 0.01 for 0.016 is 0.6250", 16, null, 1, { cost: 6250, how: "worked_out" }],
    ["worked out at exactly the half rounds up: 0.01 for 8 is 0.00125 -> 0.0013", 8000, null, 1, { cost: 13, how: "worked_out" }],
    ["worked out at the half: 0.05 for 8 is 0.00625 -> 0.0063", 8000, null, 5, { cost: 63, how: "worked_out" }],
    ["worked out just under the half: 0.05 for 8.001 is 0.0062492 -> 0.0062", 8001, null, 5, { cost: 62, how: "worked_out" }],
    ["a three-decimal quantity: 60.24 for 41.287 litres is 1.45905... -> 1.4591", 41287, null, 6024, { cost: 14591, how: "worked_out" }],
    ["a large total keeps every digit (beyond 2^53 before the division)", 1000, null, 999999999999, { cost: 99999999999900, how: "worked_out" }],
  ] as Array<[string, number | null, number | null, number | null, { cost: number; how: string }]>)("%s", (_n, q, u, t, want) => {
    expect(line(q, u, t)).toEqual(want);
  });
  it.each([
    ["no unit price, no total", 2000, null, null],
    ["a total but no quantity", null, null, 600],
    ["a quantity but no total", 2000, null, null],
    ["a quantity of zero", 0, null, 600],
    ["a quantity of zero with a printed price", 0, 12000, null],
    ["a negative quantity (a return)", -2000, 12000, null],
    ["a total of zero (a free item)", 2000, null, 0],
    ["a negative total (a discount)", 2000, null, -600],
    ["a printed price of zero", 1000, 0, null],
    ["a negative printed price", 1000, -5000, null],
    ["a printed price with a negative total (a return)", 1000, 5000, -5000],
    ["nothing at all", null, null, null],
    ["a worked-out cost that rounds to nothing", 999999999, null, 1],
  ] as Array<[string, number | null, number | null, number | null]>)("no cost: %s", (_n, q, u, t) => {
    expect(line(q, u, t)).toBeNull();
  });
  it("a cost the column cannot hold gives none, never a wrong one", () => {
    expect(line(null, costs.COST_MAX + 1, null)).toBeNull();
    expect(line(1, null, 999999999999)).toBeNull();
  });
  it("is not rounded to cents", () => {
    expect(line(3000, null, 1000)).toEqual({ cost: 33333, how: "worked_out" });
    expect(costs.costText(33333)).toBe("3.3333");
  });
});

describe("is b more than N percent above a (integers, no division)", () => {
  // N in hundredths of a percent. Rows chosen so that the usual floating-point forms get them wrong:
  // b > a * (1 + N/100) says yes for 1.0010 at 0.1% (exactly 0.1%, so NO), and (b/a - 1) * 100 > N says no for 1.0500 at 5%.
  it.each([
    // N = 0.1 (10)
    [10, 1000, 1001, false],
    [10, 10000, 10010, false],
    [10, 10000, 10011, true],
    [10, 10000, 10009, false],
    [10, 20000, 20020, false],
    [10, 20000, 20021, true],
    // N = 5 (500)
    [500, 1000, 1050, false],
    [500, 10000, 10500, false],
    [500, 10000, 10501, true],
    [500, 10000, 10499, false],
    [500, 10200, 10710, false],
    [500, 10200, 10711, true],
    // N = 12.5 (1250)
    [1250, 80000, 90000, false],
    [1250, 80000, 90001, true],
    [1250, 80000, 89999, false],
    [1250, 1200, 1350, false],
    [1250, 1200, 1351, true],
    // N = 500 (50000)
    [50000, 10000, 60000, false],
    [50000, 10000, 60001, true],
    [50000, 10000, 59999, false],
    [50000, 3333, 19998, false],
    [50000, 3333, 19999, true],
  ] as Array<[number, number, number, boolean]>)("N=%i hundredths, %i -> %i: %s", (n, a, b, want) => {
    expect(costs.isMoreThanPercentAbove(a, b, n)).toBe(want);
  });
  it("the two usual float forms really are wrong on those rows (so the table has teeth)", () => {
    const f1 = (a: number, b: number, n: number) => b > a * (1 + n / 10000);
    const f2 = (a: number, b: number, n: number) => (b / a - 1) * 100 > n / 100;
    expect(f1(1000, 1001, 10)).toBe(true);
    expect(costs.isMoreThanPercentAbove(1000, 1001, 10)).toBe(false);
    expect(f2(1000, 1050, 500)).toBe(true);
    expect(costs.isMoreThanPercentAbove(1000, 1050, 500)).toBe(false);
  });
  it("a fall, an equal cost and a rise from nothing raise nothing", () => {
    expect(costs.isMoreThanPercentAbove(10000, 9000, 10)).toBe(false);
    expect(costs.isMoreThanPercentAbove(10000, 10000, 10)).toBe(false);
    expect(costs.isMoreThanPercentAbove(0, 10000, 10)).toBe(false);
  });
  it("handles costs beyond what a float keeps exactly", () => {
    const a = 99_999_999_999_990;
    expect(costs.isMoreThanPercentAbove(a, a + 1, 10)).toBe(false);
    expect(costs.isMoreThanPercentAbove(1, 99_999_999_999_999, 50000)).toBe(true);
  });
});

describe("the rise as a percentage to one decimal", () => {
  it.each([
    [6000, 6720, "12.0"],
    [12000, 13500, "12.5"],
    [10000, 10001, "0.0"],
    [30000, 30010, "0.0"],
    [30000, 30015, "0.1"],
    [1, 99_999_999_999_999, "9999999999999800.0"],
    [3333, 3334, "0.0"],
    [1000, 1005, "0.5"],
    [1000, 1006, "0.6"],
  ] as Array<[number, number, string]>)("%i -> %i is %s", (a, b, want) => {
    expect(costs.tenthsText(costs.riseTenths(a, b))).toBe(want);
  });
  it("rounds half up at one decimal", () => {
    // 1.0005 / 1.0000: 0.05% -> 0.1 ; 1.00049 is below the half
    expect(costs.tenthsText(costs.riseTenths(20000, 20010))).toBe("0.1");
    expect(costs.tenthsText(costs.riseTenths(200000, 200099))).toBe("0.0");
    expect(costs.tenthsText(costs.riseTenths(200000, 200100))).toBe("0.1");
  });
});

describe("the flags of one history", () => {
  const H = (...costs_: number[]) => costs_.map((cost) => ({ cost, hundredths: 500 }));
  const at = (hist: ReturnType<typeof H>) => costs.flagsOfHistory(hist).map((f) => [f.prev, f.index]);
  it("a rise over the threshold is flagged on the later observation, against the one just before", () => {
    expect(at(H(10000, 10000, 11200))).toEqual([[1, 2]]);
  });
  it("a fall raises nothing", () => {
    expect(at(H(10000, 8000))).toEqual([]);
  });
  it("a rise after a fall is measured from the fall, not from the highest or the lowest", () => {
    expect(at(H(10000, 8000, 8500))).toEqual([[1, 2]]);
    expect(at(H(10000, 8000, 8300))).toEqual([]);
    expect(at(H(10000, 8000, 10400))).toEqual([[1, 2]]);
  });
  it("three rises in a row make three flags", () => {
    expect(at(H(10000, 11000, 12100, 13300))).toEqual([[0, 1], [1, 2], [2, 3]]);
  });
  it("equal costs raise nothing", () => {
    expect(at(H(10000, 10000, 10000))).toEqual([]);
  });
  it("a single observation, and none, raise nothing", () => {
    expect(at(H(10000))).toEqual([]);
    expect(at(H())).toEqual([]);
  });
  it("each observation is judged by the percentage it was made under", () => {
    const hist = [
      { cost: 10000, hundredths: 500 },
      { cost: 10800, hundredths: 1000 },
      { cost: 11800, hundredths: 500 },
    ];
    expect(at(hist)).toEqual([[1, 2]]);
  });
  it("carries the exact rise", () => {
    expect(costs.flagsOfHistory(H(6000, 6720))[0]?.riseTenths).toBe(120n);
  });
});

describe("the setting as hundredths of a percent", () => {
  const cfg = (v: string | null) => Config.fromRows(v === null ? [] : [{ key: "price_rise_flag_percent", value: v }]);
  it.each([
    [null, 500],
    ["", 500],
    ["5", 500],
    ["0.1", 10],
    ["12.5", 1250],
    ["500", 50000],
    ["7.25", 725],
    ["0.09", 500],
    ["0", 500],
    ["500.01", 500],
    ["12.555", 500],
    ["-3", 500],
    ["five", 500],
  ] as Array<[string | null, number]>)("%s is %i", (v, want) => {
    expect(costs.thresholdHundredths(cfg(v))).toBe(want);
  });
});

// ── The owner's story, end to end ─────────────────────────

describe("the owner's story: three receipts, a rise, a manager marks it", () => {
  it("the third receipt is 12% dearer on one line: one new flag, then a manager marks it price raised; a fourth at the same cost raises nothing", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    const r1 = await receipt({ supplierId: sp, date: "2026-09-20", lines: [cola("6.00"), { description: "Fictional Chips 40g", code: "CH40", quantity: 10, unit_price: "0.80" }] });
    expect(r1.costs).toMatchObject({ done: true, lines: 2, observed: 2, noCost: 0, flagsRaised: 0, flagsWithdrawn: 0, noLines: false });
    expect(r1.costs.message).toBe("2 lines added to the cost history; no price rise flagged.");
    const r2 = await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("6.00"), { description: "Fictional Chips 40g", code: "CH40", quantity: 10, unit_price: "0.80" }] });
    expect((await flagList("cstore")).flags).toEqual([]);
    const r3 = await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("6.72"), { description: "Fictional Chips 40g", code: "CH40", quantity: 10, unit_price: "0.80" }] });
    expect(r3.costs).toMatchObject({ observed: 2, flagsRaised: 1 });
    expect(r3.costs.message).toBe("2 lines added to the cost history; 1 price rise flagged.");
    const list = await flagList("cstore");
    expect(list.counts).toEqual({ new: 1, seen: 0, price_raised: 0, withdrawn: 0 });
    expect(list.flags).toHaveLength(1);
    expect(list.flags[0]).toMatchObject({
      state: "new",
      business: "cstore",
      item: { code: "CK12", name: "Cola 12-pack", joined: false },
      supplier: { name: "Fictional Wholesale Ltd" },
      from: { cost: "6.00", date: "2026-10-20", receiptId: r2.id, how: "printed" },
      to: { cost: "6.72", date: "2026-11-20", receiptId: r3.id, how: "printed" },
      risePercent: "12.0",
      thresholdPercent: "5",
      raisedBecause: "confirm",
      mark: null,
      withdrawn: null,
    });
    // The manager marks it: price raised, with a note.
    const flagId = list.flags[0].id;
    const marked = await ok("rpcSetPriceFlag", [T[MANAGER], { flagId, state: "price_raised", note: "Cola now $8.49 on both tills" }]);
    expect(marked).toMatchObject({ changed: true, flag: { state: "price_raised", mark: { by: "Bram Hale", note: "Cola now $8.49 on both tills" } } });
    const after = await flagList("cstore");
    expect(after.counts).toEqual({ new: 0, seen: 0, price_raised: 1, withdrawn: 0 });
    expect((await flagList("cstore", "new")).flags).toEqual([]);
    // A fourth receipt at the same higher cost raises nothing.
    const r4 = await receipt({ supplierId: sp, date: "2026-11-25", lines: [cola("6.72")] });
    expect(r4.costs).toMatchObject({ observed: 1, flagsRaised: 0 });
    expect((await flagList("cstore")).counts).toEqual({ new: 0, seen: 0, price_raised: 1, withdrawn: 0 });
    // The item's history reads in order with the flag on the observation that rose.
    const item = (await itemsOf("cstore", { text: "cola" })).items[0];
    expect(item).toMatchObject({ code: "CK12", name: "Cola 12-pack", observations: 4, joinedCount: 0, latest: { cost: "6.72", date: "2026-11-25" } });
    const h = await history(item.id);
    expect(h.history.map((x: any) => [x.date, x.cost, x.how, x.flag?.risePercent ?? null])).toEqual([
      ["2026-09-20", "6.00", "printed", null],
      ["2026-10-20", "6.00", "printed", null],
      ["2026-11-20", "6.72", "printed", "12.0"],
      ["2026-11-25", "6.72", "printed", null],
    ]);
    expect(h.notCounted).toEqual([]);
    expect(await count("price_flags")).toBe(1);
  });

  it("a flag can be marked seen, price raised and new again; a note rides with the mark; the state is audited", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("5.00")] });
    await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("6.00")] });
    const id = (await flagList("cstore")).flags[0].id;
    expect(await ok("rpcSetPriceFlag", [T[ADMIN], { flagId: id, state: "seen" }])).toMatchObject({ changed: true, flag: { state: "seen", mark: { by: "Ada Quill", note: null } } });
    expect(await ok("rpcSetPriceFlag", [T[ADMIN], { flagId: id, state: "seen" }])).toMatchObject({ changed: false });
    expect(await ok("rpcSetPriceFlag", [T[MANAGER], { flagId: id, state: "price_raised", note: "  raised   at both tills " }])).toMatchObject({ flag: { state: "price_raised", mark: { by: "Bram Hale", note: "raised at both tills" } } });
    expect(await ok("rpcSetPriceFlag", [T[MANAGER], { flagId: id, state: "new" }])).toMatchObject({ flag: { state: "new", mark: null } });
    const a = await audits("costs.flag_state");
    expect(a.map((x) => [x.actor_id, JSON.parse(x.before).state, JSON.parse(x.after).state])).toEqual([
      [ADMIN, "new", "seen"],
      [MANAGER, "seen", "price_raised"],
      [MANAGER, "price_raised", "new"],
    ]);
  });

  it("refuses a bad state, a long or multi-line note, a note on new, an unknown flag", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("5.00")] });
    await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("6.00")] });
    const id = (await flagList("cstore")).flags[0].id;
    expect(await refused("rpcSetPriceFlag", [T[MANAGER], { flagId: id, state: "withdrawn" }])).toMatch(/seen, price raised or new/);
    expect(await refused("rpcSetPriceFlag", [T[MANAGER], { flagId: id, state: "seen", note: "x".repeat(301) }])).toMatch(/at most 300/);
    expect(await refused("rpcSetPriceFlag", [T[MANAGER], { flagId: id, state: "seen", note: "a\nb" }])).toMatch(/line break/);
    expect(await refused("rpcSetPriceFlag", [T[MANAGER], { flagId: id, state: "new", note: "no" }])).toMatch(/no note/);
    expect(await refused("rpcSetPriceFlag", [T[MANAGER], { flagId: "pf" + "0".repeat(20), state: "seen" }])).toMatch(/No such flag/);
    expect(await refused("rpcSetPriceFlag", [T[MANAGER], { flagId: "nope", state: "seen" }])).toMatch(/No such flag/);
    expect((await flagList("cstore")).flags[0].state).toBe("new");
  });
});

// ── Order: by receipt date, not by when it was confirmed ──

describe("order by receipt date", () => {
  it("confirming an OLDER receipt after a newer one puts it in its place and creates a flag between the neighbours", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    const nov = await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("6.00")] });
    expect(nov.costs.flagsRaised).toBe(0);
    const oct = await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("5.00")] });
    expect(oct.costs).toMatchObject({ observed: 1, flagsRaised: 1, flagsWithdrawn: 0 });
    const f = (await flagList("cstore")).flags;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ from: { cost: "5.00", date: "2026-10-20", receiptId: oct.id }, to: { cost: "6.00", date: "2026-11-20", receiptId: nov.id }, risePercent: "20.0", raisedBecause: "confirm" });
  });

  it("an older receipt that changes the neighbour: the flag is withdrawn and a new one written against the new previous cost", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-08-20", lines: [cola("5.00")] });
    const nov = await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("5.60")] });
    const before = (await flagList("cstore")).flags;
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ from: { cost: "5.00" }, to: { cost: "5.60" }, risePercent: "12.0" });
    await ok("rpcSetPriceFlag", [T[MANAGER], { flagId: before[0].id, state: "seen" }]);
    // A cheaper receipt in October: Aug 5.00 -> Oct 4.00 is a fall, Oct 4.00 -> Nov 5.60 is a 40% rise.
    const oct = await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("4.00")] });
    expect(oct.costs).toMatchObject({ flagsRaised: 1, flagsWithdrawn: 1 });
    const live = (await flagList("cstore")).flags;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ state: "new", from: { cost: "4.00", receiptId: oct.id }, to: { cost: "5.60", receiptId: nov.id }, risePercent: "40.0" });
    const gone = (await flagList("cstore", "withdrawn")).flags;
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ id: before[0].id, state: "withdrawn", withdrawn: { reason: "history_changed" }, mark: { by: "Bram Hale" } });
  });

  it("an older receipt that sits between two costs can withdraw a flag and raise none", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-08-20", lines: [cola("5.00")] });
    await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("5.30")] });
    expect((await flagList("cstore")).counts.new).toBe(1);
    const oct = await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("5.15")] });
    expect(oct.costs).toMatchObject({ flagsRaised: 0, flagsWithdrawn: 1 });
    expect(oct.costs.message).toBe("1 line added to the cost history; no price rise flagged; 1 flag withdrawn.");
    expect((await flagList("cstore")).counts).toEqual({ new: 0, seen: 0, price_raised: 0, withdrawn: 1 });
  });

  it("two receipts of one date are ordered by when they were confirmed", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    const a = await receipt({ supplierId: sp, date: "2026-11-10", lines: [cola("5.00")] });
    const b = await receipt({ supplierId: sp, date: "2026-11-10", lines: [cola("6.00")] });
    const f = (await flagList("cstore")).flags;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ from: { receiptId: a.id, cost: "5.00" }, to: { receiptId: b.id, cost: "6.00" } });
    // The other way round: the dearer one confirmed first. A fall raises nothing.
    const sp2 = await newSupplier("Other Fictional Wholesale");
    await receipt({ supplierId: sp2, date: "2026-11-10", lines: [cola("6.00")] });
    await receipt({ supplierId: sp2, date: "2026-11-10", lines: [cola("5.00")] });
    expect((await flagList("cstore")).flags).toHaveLength(1);
  });
});

// ── Void ──────────────────────────────────────────────────

describe("void", () => {
  it("observations stop counting, the flag that rested on them is withdrawn, the neighbours' flag is worked out again; the redo observes afresh; nothing is deleted", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    const a = await receipt({ supplierId: sp, date: "2026-09-20", lines: [cola("5.00")] });
    const b = await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("6.00")] });
    const c = await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("6.10")] });
    const start = (await flagList("cstore")).flags;
    expect(start.map((f: any) => [f.from.receiptId, f.to.receiptId])).toEqual([[a.id, b.id]]);
    const c0 = await counts();
    // Void the middle receipt.
    const v = await ok("rpcVoidReceipt", [T[MANAGER], { receiptId: b.id, reason: "wrong supplier invoice" }]);
    expect(v.costs).toMatchObject({ done: true, uncounted: 1, flagsWithdrawn: 1, flagsRaised: 1 });
    expect(v.costs.message).toBe("1 cost no longer counted in the cost history; 1 flag withdrawn; 1 price rise flagged again from the costs either side.");
    const c1 = await counts();
    for (const t of tables) expect(c1[t], `${t} never falls`).toBeGreaterThanOrEqual(c0[t] as number);
    const live = (await flagList("cstore")).flags;
    expect(live.map((f: any) => [f.from.receiptId, f.to.receiptId])).toEqual([[a.id, c.id]]);
    expect(live[0].risePercent).toBe("22.0");
    const gone = (await flagList("cstore", "withdrawn")).flags;
    expect(gone.map((f: any) => [f.from.receiptId, f.to.receiptId, f.withdrawn.reason])).toEqual([[a.id, b.id, "receipt_voided"]]);
    const item = (await itemsOf("cstore")).items[0];
    const h = await history(item.id);
    expect(h.history.map((x: any) => x.receiptId)).toEqual([a.id, c.id]);
    expect(h.notCounted.map((x: any) => [x.receiptId, x.cost, x.notCounted.reason])).toEqual([[b.id, "6.00", "receipt_voided"]]);
    expect(item.observations).toBe(2);
    // The corrected receipt is confirmed again: its lines are observed afresh (new rows), and the history is whole again.
    const redo = await confirmIt(b.originalId, MANAGER, "fictional figures typed for the test");
    expect(redo.ok, redo.error?.message).toBe(true);
    expect(redo.result.costs).toMatchObject({ done: true, observed: 1, flagsRaised: 1, flagsWithdrawn: 1 });
    const h2 = await history(item.id);
    expect(h2.history.map((x: any) => [x.date, x.cost])).toEqual([["2026-09-20", "5.00"], ["2026-10-20", "6.00"], ["2026-11-20", "6.10"]]);
    expect(h2.history.map((x: any) => x.receiptId)).not.toContain(b.id);
    expect(h2.notCounted).toHaveLength(1);
    const c2 = await counts();
    for (const t of tables) expect(c2[t], `${t} never falls`).toBeGreaterThanOrEqual(c1[t] as number);
    expect(c2["item_costs"]).toBe((c0["item_costs"] as number) + 1);
    expect((await flagList("cstore")).counts).toEqual({ new: 1, seen: 0, price_raised: 0, withdrawn: 2 });
    expect(await count("supplier_items")).toBe(1);
  });

  it("a flag a person had marked is withdrawn when its receipt is voided, and keeps who marked it", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("5.00")] });
    const b = await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("6.00")] });
    const id = (await flagList("cstore")).flags[0].id;
    await ok("rpcSetPriceFlag", [T[MANAGER], { flagId: id, state: "price_raised", note: "done" }]);
    await ok("rpcVoidReceipt", [T[ADMIN], { receiptId: b.id, reason: "a duplicate scan" }]);
    const gone = (await flagList("cstore", "withdrawn")).flags;
    expect(gone[0]).toMatchObject({ id, state: "withdrawn", mark: { by: "Bram Hale", note: "done" }, withdrawn: { reason: "receipt_voided" } });
    expect(await refused("rpcSetPriceFlag", [T[MANAGER], { flagId: id, state: "seen" }])).toMatch(/withdrawn/);
  });

  it("voiding a receipt with no cost history says so and changes nothing", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    const r = await receipt({ supplierId: sp, date: "2026-10-20", lines: [] });
    const v = await ok("rpcVoidReceipt", [T[MANAGER], { receiptId: r.id, reason: "no lines on it" }]);
    expect(v.costs).toMatchObject({ done: true, uncounted: 0, flagsWithdrawn: 0 });
  });
});

// ── Lines that give no cost ───────────────────────────────

describe("lines that give no cost", () => {
  it("are counted and never stored as 0; a worked-out cost says so and is not rounded to cents", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    const r = await receipt({
      supplierId: sp,
      date: "2026-11-20",
      lines: [
        { description: "Mystery sweets" },
        { description: "Voided scan", quantity: 0, total: "5.00" },
        { description: "Returned crisps", code: "RT1", quantity: -2, unit_price: "3.00" },
        { description: "Free sample", code: "FR1", quantity: 1, unit_price: "0.00" },
        { description: "Loose total only", total: "12.00" },
        { description: "Discount", code: "DC1", total: "-3.00" },
        { description: "Bulk lollies", code: "BL3", quantity: 3, total: "10.00" },
        { description: "Diesel (fictional)", code: "FUEL", quantity: "41.287", unit_price: "1.459" },
        { description: "Priced pack", code: "PP1", quantity: 6, unit_price: "0.3333" },
      ],
    });
    expect(r.costs).toMatchObject({ lines: 9, observed: 3, noCost: 6, flagsRaised: 0 });
    expect(r.costs.message).toBe("3 lines added to the cost history; 6 lines with no cost (not guessed); no price rise flagged.");
    expect(await count("item_costs")).toBe(3);
    expect((await w.owner.one<{ n: number }>("select count(*)::int as n from ops.item_costs where unit_cost <= 0")).n).toBe(0);
    const rows = await w.owner.query<any>("select line_description, unit_cost::text as cost, how, quantity::text as q from ops.item_costs order by line_no");
    expect(rows.map((x) => [x.line_description, x.cost, x.how, x.q])).toEqual([
      ["Bulk lollies", "3.3333", "worked_out", "3.000"],
      ["Diesel (fictional)", "1.4590", "printed", "41.287"],
      ["Priced pack", "0.3333", "printed", "6.000"],
    ]);
    // Items exist only for the lines that gave a cost.
    expect(await count("supplier_items")).toBe(3);
    const lol = (await itemsOf("cstore", { text: "lollies" })).items[0];
    expect((await history(lol.id)).history[0]).toMatchObject({ cost: "3.3333", how: "worked_out", quantity: "3", lineTotal: "10.00" });
    expect((await history((await itemsOf("cstore", { text: "diesel" })).items[0].id)).history[0].cost).toBe("1.459");
  });

  it("a receipt with no lines observes nothing and says so", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    const r = await receipt({ supplierId: sp, date: "2026-11-20", lines: [] });
    expect(r.costs).toMatchObject({ done: true, noLines: true, lines: 0, observed: 0, noCost: 0, flagsRaised: 0 });
    expect(r.costs.message).toBe("This receipt has no lines, so nothing was added to the cost history.");
    expect(await count("item_costs")).toBe(0);
    expect(await count("receipt_observations")).toBe(1);
  });

  it("a worked-out cost that rounds at the half goes up, exactly", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-11-20", lines: [{ description: "Tiny", code: "TN", quantity: 8, total: "0.05" }, { description: "Tiny2", code: "TN2", quantity: 3, total: "20.00" }] });
    const rows = await w.owner.query<any>("select line_code, unit_cost::text as cost from ops.item_costs order by line_no");
    expect(rows.map((x) => [x.line_code, x.cost])).toEqual([["TN", "0.0063"], ["TN2", "6.6667"]]);
  });

  it("the same item twice on one receipt is two observations of one item", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("6.00"), cola("6.00", { description: "Cola 12-pack (second pallet)" })] });
    expect(await count("supplier_items")).toBe(1);
    expect(await count("item_costs")).toBe(2);
  });
});

// ── Joining ───────────────────────────────────────────────

describe("joining two items into one", () => {
  async function twoSpellings(): Promise<{ sp: string; x: any; y: any }> {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-08-20", lines: [{ description: "Cola 12-pack", quantity: 2, unit_price: "5.00" }] });
    await receipt({ supplierId: sp, date: "2026-09-20", lines: [{ description: "Cola 12-pack", quantity: 2, unit_price: "5.00" }] });
    await receipt({ supplierId: sp, date: "2026-10-20", lines: [{ description: "COLA 12PK TRAY", quantity: 2, unit_price: "6.00" }] });
    await receipt({ supplierId: sp, date: "2026-11-20", lines: [{ description: "COLA 12PK TRAY", quantity: 2, unit_price: "6.00" }] });
    const items = (await itemsOf("cstore")).items;
    expect(items.map((i: any) => i.name)).toEqual(["Cola 12-pack", "COLA 12PK TRAY"]);
    return { sp, x: items[0], y: items[1] };
  }

  it("their histories read as one in order; a flag appears across the join; un-joining restores both and withdraws it", async () => {
    const { x, y } = await twoSpellings();
    expect((await flagList("cstore")).flags).toEqual([]);
    const j = await ok("rpcJoinItems", [T[MANAGER], { itemId: y.id, intoItemId: x.id, reason: "the supplier renamed the line" }]);
    expect(j).toMatchObject({ flagsRaised: 1, flagsWithdrawn: 0, item: { id: y.id, joinedInto: x.id } });
    expect(j.message).toMatch(/worked out again over the joined history/);
    // The list now has one item, with all four observations.
    const items = (await itemsOf("cstore")).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: x.id, observations: 4, joinedCount: 1, latest: { cost: "6.00", date: "2026-11-20" } });
    // Asking for the joined item's history answers the one it was joined into.
    const h = await history(y.id);
    expect(h.item.id).toBe(x.id);
    expect(h.askedFor).toEqual({ id: y.id, joinedInto: x.id });
    expect(h.members.map((m: any) => [m.name, m.root, m.join?.by ?? null])).toEqual([["Cola 12-pack", true, null], ["COLA 12PK TRAY", false, "Bram Hale"]]);
    expect(h.history.map((c: any) => [c.date, c.cost, c.printedAs.description])).toEqual([
      ["2026-08-20", "5.00", "Cola 12-pack"],
      ["2026-09-20", "5.00", "Cola 12-pack"],
      ["2026-10-20", "6.00", "COLA 12PK TRAY"],
      ["2026-11-20", "6.00", "COLA 12PK TRAY"],
    ]);
    // The flag crosses the join, and says it was found by joining.
    const f = (await flagList("cstore")).flags;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ item: { id: x.id, name: "Cola 12-pack", printedAs: "COLA 12PK TRAY", joined: true }, from: { cost: "5.00", date: "2026-09-20" }, to: { cost: "6.00", date: "2026-10-20" }, risePercent: "20.0", raisedBecause: "join" });
    // Nothing moved, nothing was deleted.
    expect(await count("supplier_items")).toBe(2);
    expect(await count("item_costs")).toBe(4);
    // Undo: both read on their own again, and the flag across the join is withdrawn.
    const u = await ok("rpcJoinItems", [T[ADMIN], { itemId: y.id, intoItemId: null, reason: "they are different packs after all" }]);
    expect(u).toMatchObject({ flagsRaised: 0, flagsWithdrawn: 1, item: { id: y.id, joinedInto: null } });
    expect((await itemsOf("cstore")).items.map((i: any) => [i.name, i.observations, i.joinedCount])).toEqual([["Cola 12-pack", 2, 0], ["COLA 12PK TRAY", 2, 0]]);
    expect((await flagList("cstore")).counts).toEqual({ new: 0, seen: 0, price_raised: 0, withdrawn: 1 });
    expect((await flagList("cstore", "withdrawn")).flags[0].withdrawn.reason).toBe("unjoined");
    const a = await audits("costs.%join");
    expect(a.map((r) => [r.actor_id, r.action, r.target_id])).toEqual([[MANAGER, "costs.join", y.id], [ADMIN, "costs.unjoin", y.id]]);
    expect(JSON.parse(a[0].after)).toMatchObject({ joinedInto: x.id, reason: "the supplier renamed the line", flagsRaised: [expect.stringMatching(/^pf/)] });
  });

  it("a flag a person marked is kept when its history is unchanged by a later join", async () => {
    const { x, y } = await twoSpellings();
    await ok("rpcJoinItems", [T[MANAGER], { itemId: y.id, intoItemId: x.id, reason: "same line, renamed" }]);
    const id = (await flagList("cstore")).flags[0].id;
    await ok("rpcSetPriceFlag", [T[MANAGER], { flagId: id, state: "seen" }]);
    await receipt({ supplierId: (await itemsOf("cstore")).items[0].supplier.id, date: "2026-11-25", lines: [{ description: "COLA 12PK TRAY", quantity: 2, unit_price: "6.00" }] });
    const f = (await flagList("cstore")).flags;
    expect(f.map((x: any) => [x.id, x.state])).toEqual([[id, "seen"]]);
  });

  it("is refused for a different supplier, a different business, into a joined item, into itself, an item others are joined into, twice, and with no reason", async () => {
    const { sp, x, y } = await twoSpellings();
    const sp2 = await newSupplier("Other Fictional Wholesale");
    await receipt({ supplierId: sp2, date: "2026-11-20", lines: [{ description: "Cola 12-pack", quantity: 2, unit_price: "5.00" }] });
    await receipt({ business: "vape", supplierId: sp, date: "2026-11-20", lines: [{ description: "Cola 12-pack", quantity: 2, unit_price: "5.00" }] });
    const other = (await itemsOf("cstore", { supplierId: sp2 })).items[0];
    const vapeItem = (await itemsOf("vape")).items[0];
    const j = (itemId: string, intoItemId: string | null, reason: unknown = "they are the same") => refused("rpcJoinItems", [T[MANAGER], { itemId, intoItemId, reason }]);
    const before = await w.owner.query<any>("select item_id, joined_into from ops.supplier_items order by item_id");
    expect(await j(y.id, other.id)).toMatch(/different suppliers/);
    expect(await j(y.id, vapeItem.id)).toMatch(/different businesses/);
    expect(await j(y.id, y.id)).toMatch(/into itself/);
    expect(await j(y.id, x.id, "")).toMatch(/reason/i);
    expect(await j(y.id, x.id, "ab")).toMatch(/at least 3/);
    expect(await j(y.id, x.id, "x".repeat(301))).toMatch(/at most 300/);
    expect(await j(y.id, "it" + "0".repeat(20))).toMatch(/No such item/);
    expect(await j("nope", x.id)).toMatch(/No such item/);
    expect(await j(x.id, null)).toMatch(/not joined into another item/);
    expect(await w.owner.query<any>("select item_id, joined_into from ops.supplier_items order by item_id")).toEqual(before);
    await ok("rpcJoinItems", [T[MANAGER], { itemId: y.id, intoItemId: x.id, reason: "the same line" }]);
    expect(await j(y.id, x.id)).toMatch(/already joined/);
    expect(await j(x.id, y.id)).toMatch(/itself joined|Other items are joined into/);
    // A third spelling cannot be joined into the joined one, and the one with followers cannot be joined away.
    await receipt({ supplierId: sp, date: "2026-11-22", lines: [{ description: "Cola twelve pack", quantity: 2, unit_price: "6.00" }] });
    const third = (await itemsOf("cstore", { supplierId: sp, text: "twelve" })).items[0];
    expect(await j(third.id, y.id)).toMatch(/itself joined into another item/);
    expect(await j(x.id, third.id)).toMatch(/Other items are joined into/);
    expect(await refused("rpcJoinItems", [T[MANAGER], { itemId: y.id }])).toMatch(/Nothing was joined/);
  });

  it("the database refuses a chain even when the code is bypassed", async () => {
    const { x, y } = await twoSpellings();
    const sp = (await itemsOf("cstore")).items[0].supplier.id;
    await receipt({ supplierId: sp, date: "2026-11-22", lines: [{ description: "Cola twelve pack", quantity: 2, unit_price: "6.00" }] });
    const third = (await itemsOf("cstore", { text: "twelve" })).items[0];
    await w.owner.query("update ops.supplier_items set joined_into = $1, joined_by = 'S_001', joined_at = now(), join_reason = 'x yz' where item_id = $2", [x.id, y.id]);
    await expect(w.owner.query("update ops.supplier_items set joined_into = $1, joined_by = 'S_001', joined_at = now(), join_reason = 'x yz' where item_id = $2", [y.id, third.id])).rejects.toThrow();
    await expect(w.owner.query("update ops.supplier_items set joined_into = $1, joined_by = 'S_001', joined_at = now(), join_reason = 'x yz' where item_id = $2", [third.id, x.id])).rejects.toThrow();
  });
});

// ── The setting ───────────────────────────────────────────

describe("the setting price_rise_flag_percent", () => {
  const set = (value: string) => ok("rpcUpdateSetting", [T[ADMIN], { key: "price_rise_flag_percent", value }]);
  it("a rise under the threshold raises nothing; changing the setting does not rewrite old flags", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-09-20", lines: [cola("5.00")] });
    // 4% under the default 5: nothing.
    const r2 = await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("5.20")] });
    expect(r2.costs.flagsRaised).toBe(0);
    // 8% over the default: a flag.
    const r3 = await receipt({ supplierId: sp, date: "2026-11-01", lines: [cola("5.62")] });
    expect(r3.costs.flagsRaised).toBe(1);
    const flagId = (await flagList("cstore")).flags[0].id;
    // Raise the threshold to 20: the old flag stays; an 8% rise after the change raises nothing.
    await set("20");
    expect((await flagList("cstore")).flags.map((f: any) => f.id)).toEqual([flagId]);
    const r4 = await receipt({ supplierId: sp, date: "2026-11-10", lines: [cola("6.07")] });
    expect(r4.costs.flagsRaised).toBe(0);
    // An older receipt confirmed now re-works the history, but every observation keeps the percentage it was made under.
    const r0 = await receipt({ supplierId: sp, date: "2026-08-20", lines: [cola("5.00")] });
    expect(r0.costs).toMatchObject({ flagsRaised: 0, flagsWithdrawn: 0 });
    expect((await flagList("cstore")).flags.map((f: any) => [f.id, f.thresholdPercent])).toEqual([[flagId, "5"]]);
    // Lowered to 0.1: a 1% rise is now flagged, and the older flag is not changed.
    await set("0.1");
    const r5 = await receipt({ supplierId: sp, date: "2026-11-15", lines: [cola("6.15")] });
    expect(r5.costs.flagsRaised).toBe(1);
    const fl = (await flagList("cstore")).flags;
    expect(fl.map((f: any) => f.thresholdPercent)).toEqual(["0.1", "5"]);
  });

  it("accepts 0.1 to 500 with at most two decimals, for an admin only", async () => {
    for (const good of ["0.1", "5", "12.5", "500", "7.25"]) expect((await rpc("rpcUpdateSetting", [T[ADMIN], { key: "price_rise_flag_percent", value: good }])).ok, good).toBe(true);
    for (const bad of ["0", "0.09", "500.01", "-1", "12.555", "5%", "five"]) expect((await rpc("rpcUpdateSetting", [T[ADMIN], { key: "price_rise_flag_percent", value: bad }])).ok, bad).toBe(false);
    expect((await rpc("rpcUpdateSetting", [T[MANAGER], { key: "price_rise_flag_percent", value: "9" }])).error?.message).toMatch(/^FORBIDDEN/);
    const list = await ok("rpcGetSettings", [T[ADMIN]]);
    expect(list.settings.find((s: any) => s.key === "price_rise_flag_percent")).toMatchObject({ default: "5", group: "Other", read: "number" });
  });
});

// ── The two businesses are never mixed ────────────────────

describe("the two businesses", () => {
  it("a call with no business, or a bad one, is refused", async () => {
    for (const name of ["rpcGetPriceFlags", "rpcFindItems"]) {
      for (const input of [{}, { business: null }, { business: "both" }, { business: "" }, { business: ["cstore", "vape"] }]) {
        expect(await refused(name, [T[MANAGER], input]), `${name} ${JSON.stringify(input)}`).toMatch(/cstore or vape/);
      }
    }
  });

  it("flags, items and histories of one business never show the other's (a mixed set, checked against a model)", async () => {
    // A small deterministic generator: 16 receipts over two businesses, two suppliers, three codes, shared names.
    let seed = 20261127;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const suppliers = [await newSupplier("Fictional Wholesale Ltd"), await newSupplier("Other Fictional Wholesale")];
    const codes = ["A1", "B2", "C3"];
    const prices = ["1.00", "1.04", "1.10", "1.50", "1.52", "2.00", "2.40", "3.00"];
    const days = Array.from({ length: 16 }, (_, i) => i + 1).sort(() => rnd(3) - 1);
    const model = new Map<string, Array<{ date: string; at: number; cost: number }>>();
    let at = 0;
    const made: Array<{ business: Biz; supplier: string; id: string }> = [];
    for (const day of days) {
      const business: Biz = rnd(2) === 0 ? "cstore" : "vape";
      const supplierId = suppliers[rnd(2)] as string;
      const lines = codes.filter(() => rnd(3) > 0).map((code) => ({ description: `Fictional item ${code}`, code, quantity: 1, unit_price: prices[rnd(prices.length)] as string }));
      if (lines.length === 0) lines.push({ description: "Fictional item A1", code: "A1", quantity: 1, unit_price: "1.00" });
      const date = `2026-10-${String(day).padStart(2, "0")}`;
      const r = await receipt({ business, supplierId, date, lines });
      made.push({ business, supplier: supplierId, id: r.id });
      at++;
      for (const l of lines) {
        const key = `${business}|${supplierId}|${l.code}`;
        const list = model.get(key) ?? [];
        list.push({ date, at, cost: Math.round(Number(l.unit_price) * 10000) });
        model.set(key, list);
      }
    }
    for (const business of ["cstore", "vape"] as Biz[]) {
      const other = business === "cstore" ? "vape" : "cstore";
      let want = 0;
      for (const [key, list] of model) {
        if (!key.startsWith(`${business}|`)) continue;
        list.sort((a, b) => (a.date === b.date ? a.at - b.at : a.date < b.date ? -1 : 1));
        want += costs.flagsOfHistory(list.map((o) => ({ cost: o.cost, hundredths: 500 }))).length;
      }
      const flags = await flagList(business, undefined);
      expect(flags.counts.new, `${business} flag count against the model`).toBe(want);
      const ownReceipts = new Set(made.filter((m) => m.business === business).map((m) => m.id));
      const otherReceipts = new Set(made.filter((m) => m.business === other).map((m) => m.id));
      for (const f of flags.flags) {
        expect(f.business).toBe(business);
        expect(ownReceipts.has(f.from.receiptId) && ownReceipts.has(f.to.receiptId)).toBe(true);
        expect(otherReceipts.has(f.from.receiptId) || otherReceipts.has(f.to.receiptId)).toBe(false);
      }
      const items = (await itemsOf(business)).items;
      expect(items.length).toBe([...model.keys()].filter((k) => k.startsWith(`${business}|`)).length);
      for (const it of items) {
        expect(it.business).toBe(business);
        const h = await history(it.id);
        expect(h.business).toBe(business);
        for (const row of [...h.history, ...h.notCounted]) {
          expect(ownReceipts.has(row.receiptId), `${row.receiptId} belongs to ${business}`).toBe(true);
          expect(otherReceipts.has(row.receiptId)).toBe(false);
        }
      }
    }
    // The same code at the same supplier in the two businesses is two items.
    const dup = await w.owner.query<any>("select business, supplier_id, item_key, count(*)::int as n from ops.supplier_items group by 1, 2, 3 having count(*) > 1");
    expect(dup).toEqual([]);
    expect(await count("supplier_items")).toBe(model.size);
  });
});

// ── Atomicity ─────────────────────────────────────────────

describe("confirm and void fail as a whole when observing fails", () => {
  it("a failure while observing leaves the receipt unconfirmed, its original drafted and nothing written", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await w.owner.query(`create or replace function ops.test_break_costs() returns trigger language plpgsql as $$ begin raise exception 'injected failure' using errcode = 'check_violation'; end $$`);
    await w.owner.query("create trigger test_break_costs before insert on ops.item_costs for each row execute function ops.test_break_costs()");
    const id = await original();
    const body = { supplier: { name: "Fictional Wholesale Ltd" }, invoice_number: "INV-X", date: "2026-11-20", paid: { how: "cash" }, amounts: { total: "9.00" }, kind: "stock", lines: [cola("6.00")] };
    await ok("rpcEnterReceiptDraft", [T[MANAGER], { original_id: id, ...body }]);
    await correct(id, body, { business: "cstore", supplierId: sp, by: MANAGER });
    const c = await confirmIt(id, MANAGER, "fictional figures typed for the test");
    expect(c.ok).toBe(false);
    expect((await w.owner.one<any>("select status from ops.receipt_originals where receipt_id = $1", [id])).status).toBe("drafted");
    expect((await w.owner.query<any>("select status from ops.purchase_receipts where original_id = $1 and status in ('confirmed', 'voided')", [id])).length).toBe(0);
    expect((await w.owner.query<any>("select status from ops.purchase_receipts where original_id = $1 and status = 'draft'", [id])).length).toBe(1);
    expect(await counts()).toEqual({ supplier_items: 0, item_costs: 0, price_flags: 0, receipt_observations: 0 });
    expect((await audits("receipt.confirm")).length).toBe(0);
    // Once the fault is gone the same receipt confirms.
    await w.owner.query("drop trigger test_break_costs on ops.item_costs");
    const again = await confirmIt(id, MANAGER, "fictional figures typed for the test");
    expect(again.ok, again.error?.message).toBe(true);
    expect(again.result.costs.observed).toBe(1);
  });

  it("a plain error from the observer fails the confirm as a whole, and it is not swallowed", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    const id = await original();
    const body = { supplier: { name: "Fictional Wholesale Ltd" }, invoice_number: "INV-Y", date: "2026-11-20", paid: { how: "cash" }, amounts: { total: "9.00" }, kind: "stock", lines: [cola("6.00")] };
    await ok("rpcEnterReceiptDraft", [T[MANAGER], { original_id: id, ...body }]);
    await correct(id, body, { business: "cstore", supplierId: sp, by: MANAGER });
    fault.observe = true;
    const c = await confirmIt(id, MANAGER, "fictional figures typed for the test");
    expect(c.ok).toBe(false);
    expect(c.error?.message).toMatch(/injected: cannot observe/);
    expect((await w.owner.one<any>("select status from ops.receipt_originals where receipt_id = $1", [id])).status).toBe("drafted");
    expect((await w.owner.query<any>("select 1 from ops.purchase_receipts where original_id = $1 and status in ('confirmed', 'voided')", [id])).length).toBe(0);
    expect((await audits("receipt.confirm")).length).toBe(0);
    expect(await counts()).toEqual({ supplier_items: 0, item_costs: 0, price_flags: 0, receipt_observations: 0 });
    fault.observe = false;
    expect((await confirmIt(id, MANAGER, "fictional figures typed for the test")).ok).toBe(true);
  });

  it("a plain error from the un-counter fails the void as a whole", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    const b = await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("6.00")] });
    fault.unobserve = true;
    const v = await rpc("rpcVoidReceipt", [T[MANAGER], { receiptId: b.id, reason: "will not happen" }]);
    expect(v.ok).toBe(false);
    expect(v.error?.message).toMatch(/injected: cannot un-count/);
    expect((await w.owner.one<any>("select status from ops.purchase_receipts where purchase_id = $1", [b.id])).status).toBe("confirmed");
    expect((await w.owner.one<any>("select status from ops.receipt_originals where receipt_id = $1", [b.originalId])).status).toBe("confirmed");
    expect((await audits("receipt.void")).length).toBe(0);
    expect((await w.owner.one<any>("select count(*)::int as n from ops.item_costs where counted")).n).toBe(1);
  });

  it("a failure while un-counting leaves the receipt confirmed, with its costs still counting", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("5.00")] });
    const b = await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("6.00")] });
    await w.owner.query(`create or replace function ops.test_break_costs() returns trigger language plpgsql as $$ begin raise exception 'injected failure' using errcode = 'check_violation'; end $$`);
    await w.owner.query("create trigger test_break_costs before update on ops.item_costs for each row execute function ops.test_break_costs()");
    expect((await rpc("rpcVoidReceipt", [T[MANAGER], { receiptId: b.id, reason: "will not happen" }])).ok).toBe(false);
    await w.owner.query("drop trigger test_break_costs on ops.item_costs");
    expect((await w.owner.one<any>("select status from ops.purchase_receipts where purchase_id = $1", [b.id])).status).toBe("confirmed");
    expect((await w.owner.one<any>("select count(*)::int as n from ops.item_costs where counted")).n).toBe(2);
    expect((await flagList("cstore")).counts.new).toBe(1);
  });
});

// ── The catch-up for receipts confirmed before the card ───

describe("work out costs for earlier receipts", () => {
  /** Make receipts, then remove their observations as if they were confirmed before this card existed. */
  async function earlier(): Promise<{ sp: string }> {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-09-20", lines: [cola("5.00"), { description: "Mystery" }] });
    await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("6.00")] });
    await receipt({ business: "vape", supplierId: sp, date: "2026-10-21", lines: [] });
    for (const t of ["price_flags", "item_costs", "receipt_observations", "supplier_items"]) await w.owner.query(`delete from ops.${t}`);
    return { sp };
  }
  it("observes receipts that have none, says how many receipts and lines, and is idempotent", async () => {
    await earlier();
    const r = await ok("rpcObserveEarlierReceipts", [T[ADMIN]]);
    expect(r).toMatchObject({ receipts: 3, lines: 3, observed: 2, noCost: 1, flagsRaised: 1, more: false });
    expect(r.message).toBe("Worked out 3 earlier receipts: 2 lines added to the cost history, 1 line with no cost (not guessed), 1 price rise flagged.");
    expect(await counts()).toEqual({ supplier_items: 1, item_costs: 2, price_flags: 1, receipt_observations: 3 });
    const f = (await flagList("cstore")).flags;
    expect(f[0]).toMatchObject({ raisedBecause: "catch_up", risePercent: "20.0" });
    const again = await ok("rpcObserveEarlierReceipts", [T[ADMIN]]);
    expect(again).toMatchObject({ receipts: 0, lines: 0, observed: 0, flagsRaised: 0 });
    expect(again.message).toMatch(/already been worked out/);
    expect(await counts()).toEqual({ supplier_items: 1, item_costs: 2, price_flags: 1, receipt_observations: 3 });
    const a = await audits("costs.catch_up");
    expect(a.map((x) => [x.actor_id, JSON.parse(x.after).receipts])).toEqual([[ADMIN, 3], [ADMIN, 0]]);
  });
  it("leaves a voided receipt and a receipt already observed alone", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    const a = await receipt({ supplierId: sp, date: "2026-09-20", lines: [cola("5.00")] });
    await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("6.00")] });
    await ok("rpcVoidReceipt", [T[ADMIN], { receiptId: a.id, reason: "a duplicate of another scan" }]);
    const c0 = await counts();
    const r = await ok("rpcObserveEarlierReceipts", [T[ADMIN]]);
    expect(r.receipts).toBe(0);
    expect(await counts()).toEqual(c0);
  });
  it("only an admin", async () => {
    await earlier();
    expect(await refused("rpcObserveEarlierReceipts", [T[MANAGER]])).toMatch(/^FORBIDDEN/);
    expect(await refused("rpcObserveEarlierReceipts", [T[PAYROLL]])).toMatch(/^FORBIDDEN/);
    expect(await refused("rpcObserveEarlierReceipts", [T[EMPLOYEE]])).toMatch(/^FORBIDDEN/);
    expect(await count("receipt_observations")).toBe(0);
  });
  it("works in batches: a batch of two leaves the third for the next click, and says so", async () => {
    await earlier();
    const first = await withTransaction(w.db, async (tx) => costs.observeEarlierReceipts(tx, { staffId: ADMIN, role: "admin" }, await loadConfig(tx), w.clock.now, 2));
    expect(first).toMatchObject({ receipts: 2, more: true });
    expect(first.message).toMatch(/More are waiting: run it again\.$/);
    const second = await ok("rpcObserveEarlierReceipts", [T[ADMIN]]);
    expect(second).toMatchObject({ receipts: 1, more: false });
    expect(await count("receipt_observations")).toBe(3);
    expect(costs.CATCH_UP_BATCH).toBe(200);
  });
});

// ── Who may ───────────────────────────────────────────────

describe("who may", () => {
  async function world(): Promise<{ flagId: string; itemId: string; x: string; y: string }> {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("5.00"), { description: "Alt name", quantity: 1, unit_price: "1.00" }] });
    await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("6.00"), { description: "ALT NAME 2", quantity: 1, unit_price: "1.00" }] });
    const items = (await itemsOf("cstore")).items;
    return { flagId: (await flagList("cstore")).flags[0].id, itemId: items[0].id, x: items.find((i: any) => i.name === "Alt name").id, y: items.find((i: any) => i.name === "ALT NAME 2").id };
  }
  it("admin and manager see and act; payroll admin reads; an employee sees nothing; no token sees nothing", async () => {
    const ids = await world();
    const reads = (token: string | null) => [
      ["rpcGetPriceFlags", [token, { business: "cstore" }]],
      ["rpcGetItemCosts", [token, { itemId: ids.itemId }]],
      ["rpcFindItems", [token, { business: "cstore" }]],
    ] as Array<[string, unknown[]]>;
    for (const who of [ADMIN, MANAGER, PAYROLL]) for (const [n, a] of reads(T[who] as string)) expect((await rpc(n, a)).ok, `${who} ${n}`).toBe(true);
    for (const who of [EMPLOYEE]) for (const [n, a] of reads(T[who] as string)) expect(await refused(n, a), `${who} ${n}`).toMatch(/^FORBIDDEN/);
    for (const [n, a] of reads(null)) expect(await refused(n, a), `no token ${n}`).toMatch(/NOT_LOGGED_IN/);
    for (const [n, a] of reads("not-a-token")) expect(await refused(n, a), `bad token ${n}`).toMatch(/NOT_LOGGED_IN/);
    const writes = (token: string | null): Array<[string, unknown[]]> => [
      ["rpcSetPriceFlag", [token, { flagId: ids.flagId, state: "seen" }]],
      ["rpcJoinItems", [token, { itemId: ids.y, intoItemId: ids.x, reason: "the same line, renamed" }]],
    ];
    for (const who of [PAYROLL, EMPLOYEE]) for (const [n, a] of writes(T[who] as string)) expect(await refused(n, a), `${who} ${n}`).toMatch(/^FORBIDDEN/);
    for (const [n, a] of writes(null)) expect(await refused(n, a), `no token ${n}`).toMatch(/NOT_LOGGED_IN/);
    expect((await flagList("cstore")).flags[0].state).toBe("new");
    expect(await count("audit_log")).toBeGreaterThan(0);
    expect((await audits("costs.%")).filter((a) => a.action !== "costs.observe")).toEqual([]);
    for (const [n, a] of writes(T[MANAGER] as string)) expect((await rpc(n, a)).ok, `manager ${n}`).toBe(true);
    expect((await rpc("rpcSetPriceFlag", [T[ADMIN], { flagId: ids.flagId, state: "seen" }])).ok, "admin rpcSetPriceFlag").toBe(true);
    expect((await rpc("rpcJoinItems", [T[ADMIN], { itemId: ids.y, intoItemId: null, reason: "an admin undoes it" }])).ok, "admin rpcJoinItems").toBe(true);
  });

  it("a planted role, actorId or business in the input changes nothing: identity comes from the session", async () => {
    const ids = await world();
    // An employee who plants an admin's role and id.
    for (const [n, input] of [
      ["rpcGetPriceFlags", { business: "cstore", role: "admin", actorId: ADMIN, staffId: ADMIN }],
      ["rpcSetPriceFlag", { flagId: ids.flagId, state: "seen", role: "admin", actorId: ADMIN, staffId: ADMIN }],
      ["rpcJoinItems", { itemId: ids.y, intoItemId: ids.x, reason: "planted attempt", role: "admin", actorId: ADMIN }],
      ["rpcFindItems", { business: "cstore", role: "manager" }],
    ] as Array<[string, Record<string, unknown>]>) expect(await refused(n, [T[EMPLOYEE], input]), n).toMatch(/^FORBIDDEN/);
    // A manager who plants the admin's id: the audit row names the manager, and the catch-up stays an admin's.
    await ok("rpcSetPriceFlag", [T[MANAGER], { flagId: ids.flagId, state: "seen", actorId: ADMIN, staffId: ADMIN, role: "admin", markedBy: ADMIN }]);
    const a = await audits("costs.flag_state");
    expect(a.map((x) => x.actor_id)).toEqual([MANAGER]);
    expect((await flagList("cstore")).flags[0].mark.by).toBe("Bram Hale");
    expect(await refused("rpcObserveEarlierReceipts", [T[MANAGER], { role: "admin", actorId: ADMIN }])).toMatch(/^FORBIDDEN/);
    // A planted business in the join or flag inputs has no field to land in: the flag keeps its own business.
    await ok("rpcSetPriceFlag", [T[MANAGER], { flagId: ids.flagId, state: "price_raised", business: "vape" }]);
    expect((await flagList("cstore")).flags[0]).toMatchObject({ state: "price_raised", business: "cstore" });
    expect((await flagList("vape")).flags).toEqual([]);
    // The business of a read is the one asked for, never the caller's.
    expect((await flagList("vape")).business).toBe("vape");
  });

  it("the contract lists every RPC with its roles and needs a session", () => {
    const by = new Map(contract.entries.map((r) => [r.name, r]));
    for (const n of ["rpcGetPriceFlags", "rpcGetItemCosts", "rpcFindItems"]) expect(by.get(n)).toMatchObject({ needs_session: true, roles: ["admin", "manager", "payroll_admin"] });
    for (const n of ["rpcSetPriceFlag", "rpcJoinItems"]) expect(by.get(n)).toMatchObject({ needs_session: true, roles: ["admin", "manager"] });
    expect(by.get("rpcObserveEarlierReceipts")).toMatchObject({ needs_session: true, roles: ["admin"] });
  });
});

// ── Audit, cost of a call, what is never touched, the copy ──

describe("audited, bounded, and nothing else moves", () => {
  it("confirm, void, flag marks, joins and the catch-up each leave an audit row naming the person", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("5.00")], by: MANAGER });
    const b = await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("6.00")], by: ADMIN });
    const o = await audits("costs.observe");
    expect(o.map((x) => [x.actor_id, x.target_id === b.id ? "b" : "a"])).toEqual([[MANAGER, "a"], [ADMIN, "b"]]);
    expect(JSON.parse(o[1].after)).toMatchObject({ source: "confirm", business: "cstore", lines: 1, observed: 1, noCost: 0, thresholdHundredths: 500, flagsRaised: [expect.stringMatching(/^pf/)], flagsWithdrawn: [] });
    await ok("rpcVoidReceipt", [T[MANAGER], { receiptId: b.id, reason: "the audit test" }]);
    const u = await audits("costs.unobserve");
    expect(u.map((x) => [x.actor_id, x.target_id])).toEqual([[MANAGER, b.id]]);
    expect(JSON.parse(u[0].after)).toMatchObject({ uncounted: 1, flagsWithdrawn: [expect.stringMatching(/^pf/)] });
    expect(JSON.stringify(await audits("costs.%"))).not.toMatch(/PDF-1\.4|sha256|storage_key/i);
  });

  it("the statements a confirm runs for the costs do not grow with the number of lines", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    async function statements(n: number): Promise<number> {
      const lines = Array.from({ length: n }, (_, i) => ({ description: `Fictional item ${n}-${i}`, code: `K${n}-${i}`, quantity: 2, unit_price: "1.00" }));
      const made = await receipt({ supplierId: sp, date: "2026-11-20", lines });
      // Take its costs away, then observe it again under a counting handle.
      await w.owner.query("delete from ops.price_flags where cost_id in (select cost_id from ops.item_costs where receipt_id = $1)", [made.id]);
      await w.owner.query("delete from ops.item_costs where receipt_id = $1", [made.id]);
      await w.owner.query("delete from ops.receipt_observations where receipt_id = $1", [made.id]);
      let calls = 0;
      await withTransaction(w.db, async (tx) => {
        const counting = {
          query: (t: string, p?: readonly unknown[]) => (calls++, tx.query(t, p)),
          one: (t: string, p?: readonly unknown[]) => (calls++, tx.one(t, p)),
          maybeOne: (t: string, p?: readonly unknown[]) => (calls++, tx.maybeOne(t, p)),
        } as unknown as Tx;
        const s = await costs.observeReceipt(counting, made.id, { staffId: MANAGER }, await loadConfig(tx), w.clock.now);
        expect(s.observed).toBe(n);
      });
      return calls;
    }
    const small = await statements(3);
    const large = await statements(60);
    expect(large).toBe(small);
    expect(small).toBeLessThan(15);
  });

  it("till_sessions, sales, payments, attendance, staff and every receipt row are identical before and after any call here", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    const a = await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("5.00"), { description: "Alt A", quantity: 1, unit_price: "1.00" }] });
    await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("6.00"), { description: "Alt B", quantity: 1, unit_price: "1.00" }] });
    const snap = async () => {
      const out: Record<string, unknown> = {};
      for (const t of ["till_sessions", "sales", "payments", "attendance", "staff", "purchase_receipts", "purchase_receipt_lines", "receipt_originals", "suppliers", "business_signs", "supplier_names"]) out[t] = await w.owner.query(`select * from ops.${t} order by 1`);
      return JSON.stringify(out);
    };
    const before = await snap();
    const flag = (await flagList("cstore")).flags[0];
    await ok("rpcSetPriceFlag", [T[MANAGER], { flagId: flag.id, state: "price_raised", note: "done" }]);
    const items = (await itemsOf("cstore")).items;
    await history(items[0].id);
    const alt = items.filter((i: any) => i.name.startsWith("Alt"));
    await ok("rpcJoinItems", [T[MANAGER], { itemId: alt[1].id, intoItemId: alt[0].id, reason: "same thing, renamed" }]);
    await ok("rpcJoinItems", [T[MANAGER], { itemId: alt[1].id, intoItemId: null, reason: "not the same after all" }]);
    await ok("rpcObserveEarlierReceipts", [T[ADMIN]]);
    await flagList("vape");
    expect(await snap()).toBe(before);
    expect(a.id).toBeTruthy();
  });

  it("the migration's app role may insert and read, and may not delete or rewrite a figure", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-10-20", lines: [cola("5.00")] });
    await receipt({ supplierId: sp, date: "2026-11-20", lines: [cola("6.00")] });
    for (const t of tables) await expect(w.db.query(`delete from ops.${t}`), `delete from ${t}`).rejects.toThrow(/permission denied/);
    await expect(w.db.query("update ops.item_costs set unit_cost = 1")).rejects.toThrow(/permission denied/);
    await expect(w.db.query("update ops.price_flags set unit_cost = 1")).rejects.toThrow(/permission denied/);
    await expect(w.db.query("update ops.supplier_items set item_name = 'x'")).rejects.toThrow(/permission denied/);
    await expect(w.db.query("update ops.receipt_observations set lines = 9")).rejects.toThrow(/permission denied/);
    // A withdrawn flag stays withdrawn, even to the owner.
    const f = (await flagList("cstore")).flags[0];
    await w.owner.query("update ops.price_flags set state = 'withdrawn', withdrawn_reason = 'history_changed', withdrawn_at = now() where flag_id = $1", [f.id]);
    await expect(w.owner.query("update ops.price_flags set state = 'new', withdrawn_reason = null, withdrawn_at = null where flag_id = $1", [f.id])).rejects.toThrow(/price_flags_final/);
  });

  it("a nightly copy and restore round-trips a database holding items, observations, a join and withdrawn flags", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    await receipt({ supplierId: sp, date: "2026-08-20", lines: [{ description: "Cola 12-pack", quantity: 2, unit_price: "5.00" }, { description: "Mystery" }] });
    await receipt({ supplierId: sp, date: "2026-10-20", lines: [{ description: "COLA 12PK TRAY", quantity: 2, unit_price: "6.00" }] });
    const nov = await receipt({ supplierId: sp, date: "2026-11-20", lines: [{ description: "COLA 12PK TRAY", quantity: 2, unit_price: "7.50" }] });
    const items = (await itemsOf("cstore")).items;
    await ok("rpcJoinItems", [T[MANAGER], { itemId: items[1].id, intoItemId: items[0].id, reason: "renamed by the supplier" }]);
    await ok("rpcSetPriceFlag", [T[MANAGER], { flagId: (await flagList("cstore")).flags[0].id, state: "seen", note: "looked at" }]);
    await ok("rpcVoidReceipt", [T[MANAGER], { receiptId: nov.id, reason: "for the copy" }]);
    expect(await count("price_flags")).toBeGreaterThan(1);
    expect((await w.owner.one<any>("select count(*)::int as n from ops.price_flags where state = 'withdrawn'")).n).toBeGreaterThan(0);
    expect((await w.owner.one<any>("select count(*)::int as n from ops.item_costs where not counted")).n).toBe(1);
    const bucket = memoryBackupBucket();
    const res = await copyNow(w.testDb, bucket);
    const dir = downloadFolder(bucket, res.folder);
    const target = await createTestDb();
    try {
      const report = await restoreNightly({ dir, databaseUrl: target.ownerUrl, out: () => undefined });
      expect(report.outcome).toBe("committed");
      const only = ["supplier_items", "item_costs", "receipt_observations", "price_flags", "purchase_receipts", "purchase_receipt_lines"];
      expect(await dumpAll(target.ownerUrl, only)).toEqual(await dumpAll(w.testDb.ownerUrl, only));
    } finally {
      await target.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── What the page needs to read ───────────────────────────

describe("reading", () => {
  it("lists flags newest rise first, a page at a time, and filters by state", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    for (const [i, code] of ["A", "B", "C"].entries()) {
      await receipt({ supplierId: sp, date: `2026-09-1${i + 1}`, lines: [{ description: `Item ${code}`, code, quantity: 1, unit_price: "1.00" }] });
      await receipt({ supplierId: sp, date: `2026-10-1${i + 1}`, lines: [{ description: `Item ${code}`, code, quantity: 1, unit_price: "2.00" }] });
    }
    const all = await ok("rpcGetPriceFlags", [T[MANAGER], { business: "cstore", limit: 2 }]);
    expect(all.flags.map((f: any) => f.item.code)).toEqual(["C", "B"]);
    expect(all.next).toBe(all.flags[1].id);
    const rest = await ok("rpcGetPriceFlags", [T[MANAGER], { business: "cstore", limit: 2, before: all.next }]);
    expect(rest.flags.map((f: any) => f.item.code)).toEqual(["A"]);
    expect(rest.next).toBeNull();
    expect(all.counts).toEqual({ new: 3, seen: 0, price_raised: 0, withdrawn: 0 });
    await ok("rpcSetPriceFlag", [T[MANAGER], { flagId: all.flags[0].id, state: "seen" }]);
    expect((await flagList("cstore", "new")).flags).toHaveLength(2);
    expect((await flagList("cstore", "seen")).flags.map((f: any) => f.item.code)).toEqual(["C"]);
    expect(await refused("rpcGetPriceFlags", [T[MANAGER], { business: "cstore", state: "weird" }])).toMatch(/state is new/);
    expect(await refused("rpcGetPriceFlags", [T[MANAGER], { business: "cstore", before: "x" }])).toMatch(/before/);
  });
  it("finds items by supplier and text, ignoring wildcards, a page at a time", async () => {
    const sp = await newSupplier("Fictional Wholesale Ltd");
    const sp2 = await newSupplier("Other Fictional Wholesale");
    await receipt({ supplierId: sp, date: "2026-10-20", lines: [{ description: "Cola 100% fruit", code: "C1", quantity: 1, unit_price: "1.00" }, { description: "Chips_BBQ", code: "H1", quantity: 1, unit_price: "1.00" }, { description: "Gum", code: "G1", quantity: 1, unit_price: "1.00" }] });
    await receipt({ supplierId: sp2, date: "2026-10-20", lines: [{ description: "Cola zero", code: "C9", quantity: 1, unit_price: "1.00" }] });
    expect((await itemsOf("cstore", { text: "cola" })).items.map((i: any) => i.name).sort()).toEqual(["Cola 100% fruit", "Cola zero"]);
    expect((await itemsOf("cstore", { text: "cola", supplierId: sp2 })).items.map((i: any) => i.name)).toEqual(["Cola zero"]);
    expect((await itemsOf("cstore", { text: "%" })).items.map((i: any) => i.name)).toEqual(["Cola 100% fruit"]);
    expect((await itemsOf("cstore", { text: "_" })).items.map((i: any) => i.name)).toEqual(["Chips_BBQ"]);
    expect((await itemsOf("cstore", { text: "c1" })).items.map((i: any) => i.name)).toEqual(["Cola 100% fruit"]);
    const p1 = await itemsOf("cstore", { limit: 2 });
    const p2 = await itemsOf("cstore", { limit: 2, before: p1.next });
    expect([...p1.items, ...p2.items].map((i: any) => i.name)).toEqual(["Chips_BBQ", "Cola 100% fruit", "Cola zero", "Gum"]);
    expect(p2.next).toBeNull();
    // The suppliers offered are the ones with items in THIS business.
    await receipt({ business: "vape", supplierId: sp2, date: "2026-10-21", lines: [{ description: "Vape thing", code: "V1", quantity: 1, unit_price: "2.00" }] });
    expect((await itemsOf("cstore")).suppliers.map((x: any) => x.name)).toEqual(["Fictional Wholesale Ltd", "Other Fictional Wholesale"]);
    expect((await itemsOf("vape")).suppliers.map((x: any) => x.name)).toEqual(["Other Fictional Wholesale"]);
    expect(await refused("rpcFindItems", [T[MANAGER], { business: "cstore", supplierId: "nope" }])).toMatch(/No such supplier/);
    expect(await refused("rpcGetItemCosts", [T[MANAGER], { itemId: "it" + "1".repeat(20) }])).toMatch(/No such item/);
  });
});
