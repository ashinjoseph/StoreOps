// The fake till (ops/src/till/fake.ts): built from the contract so later cards can test against it.
// What is held down here:
//   - in its normal state EVERY answer validates against the contract, with no error and no warning,
//     and passes the arithmetic rules (apart from the one day the contract lets break one);
//   - it holds the cases later cards need: an auto_closed shift with nothing counted, the nil uuid, a
//     "To check" day, door cash, all three channels, a day with none, a staff list with a stranger;
//   - its switches do what they say, and its record of requests never holds the key;
//   - nothing here touches the network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadContract } from "../src/till/contract";
import { noGlobalFetch } from "./helpers/no-network";
import { FAKE_BASE_URL, FAKE_DAYS, FAKE_HIDDEN_STORE_ID, FAKE_KEY, FAKE_PEOPLE, FAKE_START, FAKE_STORE_ID, createFakeClock, createFakeTill, type FakeTill } from "../src/till/fake";
import { checkDailyRow, checkDailyRows, checkProducts, checkShift, type Difference } from "../src/till/rules";
import type { DailySalesAnswer, ShiftsAnswer } from "../src/till/types";
import { NIL_STAFF_ID } from "../src/till/types";

const contract = loadContract();

const { reached } = noGlobalFetch();

const auth = (key = FAKE_KEY): RequestInit => ({ method: "GET", headers: { Authorization: `Bearer ${key}` }, redirect: "manual" });

/** GET path?query as JSON (the body parsed), with the right key unless told otherwise. */
async function ask(till: FakeTill, path: string, query: Record<string, string> = {}, init: RequestInit = auth()): Promise<{ status: number; body: any; headers: Headers }> {
  const qs = new URLSearchParams(query).toString();
  const res = await till.fetch(`${FAKE_BASE_URL}${path}${qs ? `?${qs}` : ""}`, init);
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}
const store = { store_id: FAKE_STORE_ID };

describe("every normal answer validates against the contract", () => {
  it("each endpoint, asked the way the contract says, with no error and no warning", async () => {
    const till = createFakeTill();
    const answers: Array<[string, { status: number; body: unknown }]> = [
      ["/stores", await ask(till, "/stores")],
      ["/staff", await ask(till, "/staff", store)],
      ["/products", await ask(till, "/products", store)],
      ["/suppliers", await ask(till, "/suppliers", store)],
      ["/orders", await ask(till, "/orders", store)],
      ["/orders", await ask(till, "/orders", { ...store, status: "open" })],
      ["/sales/daily", await ask(till, "/sales/daily", { ...store, from: "2026-11-20", to: "2026-11-27" })],
      ["/sales/daily", await ask(till, "/sales/daily", { ...store, from: "2026-11-27", to: "2026-11-27" })],
      ["/sales/daily", await ask(till, "/sales/daily", { ...store, from: "2026-08-27", to: "2026-11-26" })],
    ];
    for (const day of ["2026-11-21", ...Object.values(FAKE_DAYS), "2026-11-27"]) answers.push(["/shifts", await ask(till, "/shifts", { ...store, day })]);
    for (const [name, a] of answers) {
      expect(a.status, name).toBe(200);
      expect(contract.validate(name, a.body), name).toEqual([]);
    }
  });

  it("every shift also validates as a Shift on its own, and every daily row as a DailyRow", () => {
    const till = createFakeTill();
    const shifts = Object.values(till.state.data.shifts).flat();
    expect(shifts.length).toBeGreaterThanOrEqual(4);
    for (const s of shifts) expect(contract.validate("Shift", s)).toEqual([]);
    for (const r of till.state.data.sales) expect(contract.validate("DailyRow", r)).toEqual([]);
    for (const p of till.state.data.products) expect(contract.validate("Product", p)).toEqual([]);
    for (const p of till.state.data.orders) expect(contract.validate("PurchaseOrder", p)).toEqual([]);
  });

  it("a field the contract does not have IS noticed (the check has teeth)", async () => {
    const till = createFakeTill();
    (till.state.data.shifts[FAKE_DAYS.open]![0] as any).till_color = "blue";
    const a = await ask(till, "/shifts", { ...store, day: FAKE_DAYS.open });
    const d = contract.validate("/shifts", a.body);
    expect(d.map((x) => [x.severity, x.path])).toEqual([["warning", "shifts[0].till_color"]]);
  });

  it("serves every GET endpoint the contract has (the proposal lookup answers not_found: nothing creates a proposal here)", async () => {
    const doc = (await import("yaml")).parse(readFileSync(new URL("../contracts/till-api.v1.yaml", import.meta.url), "utf8")) as { paths: Record<string, { get?: unknown }> };
    const till = createFakeTill();
    const gets = Object.entries(doc.paths).filter(([, v]) => v.get !== undefined).map(([p]) => p);
    expect(gets.sort()).toEqual(["/orders", "/products", "/proposals/{proposal_id}", "/sales/daily", "/shifts", "/staff", "/stores", "/suppliers"]);
    for (const p of gets.filter((g) => !g.includes("{"))) {
      const q = p === "/shifts" ? { ...store, day: "2026-11-25" } : p === "/sales/daily" ? { ...store, from: "2026-11-25", to: "2026-11-25" } : p === "/stores" ? {} : store;
      expect((await ask(till, p, q)).status, p).toBe(200);
    }
    const proposal = await ask(till, "/proposals/6b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e77");
    expect(proposal.status).toBe(404);
    expect(proposal.body).toEqual({ error: { code: "not_found", message: "no such endpoint" } });
  });
});

describe("the arithmetic rules hold on the normal data", () => {
  it("shifts, daily rows, the row set and the product list pass the rules, except the one 'To check' day", async () => {
    const till = createFakeTill();
    const diffs: Difference[] = [];
    for (const [day, shifts] of Object.entries(till.state.data.shifts)) shifts.forEach((s, i) => diffs.push(...checkShift(s, `${day}[${i}]`)));
    expect(diffs).toEqual([]);

    const sales = (await ask(till, "/sales/daily", { ...store, from: "2026-11-01", to: "2026-11-27" })).body as DailySalesAnswer;
    expect(checkDailyRows(sales.days, "2026-11-01", "2026-11-27", "days")).toEqual([]);
    const perRow = sales.days.flatMap((r, i) => checkDailyRow(r, `days[${i}]`));
    expect(perRow.filter((d) => d.severity === "error")).toEqual([]);
    // The one gap the contract allows: the till sale whose payments did not cover its total.
    expect(perRow.map((d) => [d.severity, d.path, d.expected, d.actual])).toEqual([["warning", "days[0].takings", "90.40", "86.40"]]);
    expect(sales.days[0]!.business_day).toBe(FAKE_DAYS.toCheck);

    const { products, suppliers } = till.state.data;
    expect(checkProducts(products, suppliers, "products")).toEqual([]);
  });
});

describe("the cases later cards need", () => {
  const till = createFakeTill();
  const shiftsOn = async (day: string) => ((await ask(till, "/shifts", { ...store, day })).body as ShiftsAnswer).shifts;

  it("an auto_closed shift has an empty `counted` (null, never 0) and no expected, variance or z number", async () => {
    const auto = (await shiftsOn(FAKE_DAYS.allChannels)).find((s) => s.status === "auto_closed")!;
    expect(auto).toBeDefined();
    expect(auto.counted).toBeNull();
    expect(auto.expected).toBeNull();
    expect(auto.variance).toBeNull();
    expect(auto.z_number).toBeNull();
    expect(auto.closed_at).not.toBeNull();
    expect(auto.door_cash.orders).toBeGreaterThan(0);
  });

  it("a closed shift has door cash inside `expected`", async () => {
    const closed = (await shiftsOn(FAKE_DAYS.allChannels)).find((s) => s.status === "closed")!;
    expect(closed.door_cash).toEqual({ orders: 1, total: 28.25 });
    // float + cash taken + door cash
    expect(Math.round(closed.expected! * 100)).toBe(Math.round((closed.opening_float + closed.takings.cash.net_total + closed.door_cash.total) * 100));
    expect(closed.variance).toBe(0);
  });

  it("staff_takings carry the nil uuid, 'Not known'", async () => {
    const [shift] = await shiftsOn(FAKE_DAYS.closedWithNotKnown);
    const nil = shift!.staff_takings.find((t) => t.staff_id === NIL_STAFF_ID)!;
    expect(nil).toMatchObject({ name: "Not known", count: 1, net: 25 });
    expect(shift!.staff_takings.reduce((n, t) => n + Math.round(t.net * 100), 0)).toBe(Math.round(shift!.sales_summary.net * 100));
  });

  it("an open shift has every closing field null", async () => {
    const [open] = await shiftsOn(FAKE_DAYS.open);
    expect(open).toMatchObject({ status: "open", z_number: null, closed_at: null, closed_by: null, expected: null, counted: null, variance: null });
  });

  it("a day with no shifts answers 200 with an empty list", async () => {
    expect(await shiftsOn(FAKE_DAYS.empty)).toEqual([]);
  });

  it("all three channels on one day, and a day with none", async () => {
    const sales = (await ask(till, "/sales/daily", { ...store, from: "2026-11-20", to: "2026-11-27" })).body as DailySalesAnswer;
    expect(sales.days.filter((r) => r.business_day === FAKE_DAYS.allChannels).map((r) => r.channel)).toEqual(["till", "online", "delivery"]);
    const delivery = sales.days.find((r) => r.channel === "delivery")!;
    expect(delivery.delivery).toEqual({ orders: 1, fees: 5 });
    expect(sales.days.filter((r) => r.channel !== "delivery").every((r) => r.delivery === undefined)).toBe(true);
    expect(sales.days.some((r) => r.business_day === FAKE_DAYS.empty)).toBe(false);
  });

  it("the 'To check' day: takings are short of the total", async () => {
    const row = till.state.data.sales.find((r) => r.business_day === FAKE_DAYS.toCheck)!;
    const takenCents = Object.values(row.takings).reduce((n, m) => n + Math.round(m.net_total * 100), 0);
    expect(takenCents).toBe(8640);
    expect(Math.round(row.sales_summary.total * 100)).toBe(9040);
  });

  it("the staff list holds people who match Operations by name, and one who does not", async () => {
    const staff = ((await ask(till, "/staff", store)).body as { staff: Array<{ display_name: string; staff_id: string }> }).staff;
    const names = staff.map((s) => s.display_name);
    expect(names).toEqual(["Priya Nair", "Daniel Okafor", "Maya Chen", "Casey Lindqvist"]);
    expect(staff.map((s) => s.staff_id)).not.toContain(NIL_STAFF_ID);
    const fixtures = readFileSync(new URL("../../scripts/docs/fixtures.js", import.meta.url), "utf8");
    for (const p of [FAKE_PEOPLE.priya, FAKE_PEOPLE.daniel, FAKE_PEOPLE.maya]) expect(fixtures, p.name).toContain(`'${p.name}'`);
    expect(fixtures).not.toContain(FAKE_PEOPLE.casey.name);
  });

  it("uses only invented names: nobody outside the fixture's people and the one stranger", async () => {
    const text = JSON.stringify(till.state.data);
    const found = [...text.matchAll(/"(?:name|display_name)":"([^"]+)"/g)].map((m) => m[1]);
    const allowed = new Set([...Object.values(FAKE_PEOPLE).map((p) => p.name), "Not known", "Fictional Corner Store", "Mango Ice 10ml", "Cool Mint 10ml", "Berry Blast 10ml", "Acme Wholesale (fictional)", "Beta Imports (fictional)"]);
    for (const n of found) expect(allowed.has(n!), n).toBe(true);
  });
});

describe("what the fake refuses, as the till does", () => {
  const till = createFakeTill();

  it("a missing key and a wrong key are 401 unauthorized, and neither answer holds a key", async () => {
    const none = await ask(till, "/stores", {}, { method: "GET" });
    expect([none.status, none.body.error.code]).toEqual([401, "unauthorized"]);
    const wrong = await ask(till, "/stores", {}, auth("test-key-not-real-9999"));
    expect([wrong.status, wrong.body.error.code]).toEqual([401, "unauthorized"]);
    expect(JSON.stringify([none.body, wrong.body])).not.toContain("9999");
    expect(JSON.stringify([none.body, wrong.body])).not.toContain(FAKE_KEY);
  });

  it("a store the key may not see, or does not exist, is 403 forbidden_store", async () => {
    for (const id of [FAKE_HIDDEN_STORE_ID, "5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4eff"]) {
      for (const [path, extra] of [["/staff", {}], ["/shifts", { day: "2026-11-25" }], ["/sales/daily", { from: "2026-11-25", to: "2026-11-25" }], ["/products", {}], ["/suppliers", {}], ["/orders", {}]] as const) {
        const a = await ask(till, path, { store_id: id, ...extra });
        expect([path, a.status, a.body.error.code]).toEqual([path, 403, "forbidden_store"]);
      }
    }
  });

  it("only the visible store is listed", async () => {
    const stores = (await ask(till, "/stores")).body.stores as Array<{ store_id: string }>;
    expect(stores.map((s) => s.store_id)).toEqual([FAKE_STORE_ID]);
  });

  it("a bad parameter is 400 bad_request", async () => {
    const bad: Array<[string, Record<string, string>]> = [
      ["/staff", {}],
      ["/staff", { store_id: "nope" }],
      ["/shifts", { ...store }],
      ["/shifts", { ...store, day: "2026-02-30" }],
      ["/shifts", { ...store, day: "2026-11-28" }],
      ["/sales/daily", { ...store, from: "2026-11-01" }],
      ["/sales/daily", { ...store, from: "2026-11-05", to: "2026-11-01" }],
      ["/sales/daily", { ...store, from: "2026-11-20", to: "2026-11-28" }],
      ["/sales/daily", { ...store, from: "2026-08-26", to: "2026-11-26" }],
      ["/orders", { ...store, status: "closed" }],
    ];
    for (const [path, q] of bad) {
      const a = await ask(till, path, q);
      expect([path, JSON.stringify(q), a.status, a.body.error?.code]).toEqual([path, JSON.stringify(q), 400, "bad_request"]);
    }
  });

  it("an unknown path is 404, and anything but a GET is refused", async () => {
    expect((await ask(till, "/nothing", store)).body.error.code).toBe("not_found");
    const post = await ask(till, "/proposals", {}, { method: "POST", headers: { Authorization: `Bearer ${FAKE_KEY}` }, body: "{}" });
    expect([post.status, post.body.error.code]).toEqual([404, "not_found"]);
  });

  it("a host that is not the till's does not answer (and the request is recorded)", async () => {
    const t = createFakeTill();
    await expect(t.fetch("https://evil.test/ops/v1/stores", auth())).rejects.toThrow(TypeError);
    expect(t.requests.map((r) => r.url)).toEqual(["https://evil.test/ops/v1/stores"]);
  });

  it("every answer is JSON with a content type", async () => {
    const res = await till.fetch(`${FAKE_BASE_URL}/stores`, auth());
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });
});

describe("the switches", () => {
  it("down(): the request fails like a network error, with a cause code", async () => {
    const t = createFakeTill();
    t.down();
    const e = await t.fetch(`${FAKE_BASE_URL}/stores`, auth()).catch((x) => x);
    expect(e).toBeInstanceOf(TypeError);
    expect((e as { cause: { code: string } }).cause.code).toBe("ECONNREFUSED");
  });

  it("slow(ms): the answer waits for the clock, not for real time; an abort cuts it short", async () => {
    const t = createFakeTill();
    t.clock.auto = false;
    t.slow(5000);
    let done = false;
    const p = t.fetch(`${FAKE_BASE_URL}/stores`, auth()).then((r) => {
      done = true;
      return r;
    });
    await Promise.resolve();
    await t.clock.advance(4999);
    expect(done).toBe(false);
    await t.clock.advance(1);
    expect((await p).status).toBe(200);
    expect(t.clock.waits).toEqual([]); // what the fake spends is in neither list
    expect(t.clock.deadlines).toEqual([]);

    const ctl = new AbortController();
    const cut = t.fetch(`${FAKE_BASE_URL}/stores`, { ...auth(), signal: ctl.signal });
    cut.catch(() => undefined);
    ctl.abort();
    await expect(cut).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rateLimit(n, retryAfter): the next n requests are 429 with that Retry-After, then normal", async () => {
    const t = createFakeTill();
    t.rateLimit(2, 7);
    for (let i = 0; i < 2; i++) {
      const a = await ask(t, "/stores");
      expect([a.status, a.body.error.code, a.headers.get("retry-after")]).toEqual([429, "rate_limited", "7"]);
    }
    expect((await ask(t, "/stores")).status).toBe(200);
    t.rateLimit(1, "Fri, 27 Nov 2026 15:00:05 GMT");
    expect((await ask(t, "/stores")).headers.get("retry-after")).toBe("Fri, 27 Nov 2026 15:00:05 GMT");
    t.rateLimit(1);
    expect((await ask(t, "/stores")).headers.get("retry-after")).toBeNull();
  });

  it("serverError(): 500 with the till's error shape", async () => {
    const t = createFakeTill();
    t.serverError();
    const a = await ask(t, "/stores");
    expect([a.status, a.body.error.code]).toEqual([500, "server_error"]);
  });

  it("garbage(): 200 with something that is not JSON", async () => {
    const t = createFakeTill();
    t.garbage();
    const a = await ask(t, "/stores");
    expect(a.status).toBe(200);
    expect(typeof a.body).toBe("string");
  });

  it("redirect(to): 302 with a Location when asked not to follow; a caller that follows makes a second, recorded request", async () => {
    const t = createFakeTill();
    t.redirect("https://evil.test/steal");
    const manual = await t.fetch(`${FAKE_BASE_URL}/stores`, { ...auth(), redirect: "manual" });
    expect([manual.status, manual.headers.get("location")]).toEqual([302, "https://evil.test/steal"]);
    expect(t.requests).toHaveLength(1);
    await t.fetch(`${FAKE_BASE_URL}/stores`, { ...auth(), redirect: "follow" });
    expect(t.requests.map((r) => r.url)).toEqual([`${FAKE_BASE_URL}/stores`, `${FAKE_BASE_URL}/stores`, "https://evil.test/steal"]);
    await expect(t.fetch(`${FAKE_BASE_URL}/stores`, { ...auth(), redirect: "error" })).rejects.toThrow(TypeError);
  });

  it("echoKey(): a 500 whose message quotes the Authorization header it received, and the key", async () => {
    const t = createFakeTill();
    t.echoKey();
    const a = await ask(t, "/stores");
    expect(a.status).toBe(500);
    expect(a.body.error.message).toContain(`Bearer ${FAKE_KEY}`);
  });

  it("reset() switches everything off and puts the data back", async () => {
    const t = createFakeTill();
    t.down();
    t.serverError();
    t.state.data.stores = [];
    t.reset();
    const a = await ask(t, "/stores");
    expect(a.status).toBe(200);
    expect(a.body.stores).toHaveLength(1);
  });

  it("an answer is a copy: changing it does not change the fake", async () => {
    const t = createFakeTill();
    const first = (await ask(t, "/stores")).body;
    first.stores[0].name = "Changed";
    expect((await ask(t, "/stores")).body.stores[0].name).toBe("Fictional Corner Store");
  });
});

describe("requests, and the key", () => {
  it("records method, URL, whether an Authorization header came, and the redirect mode: never its value", async () => {
    const t = createFakeTill();
    await ask(t, "/stores");
    await ask(t, "/stores", {}, { method: "GET" });
    await ask(t, "/staff", store, auth("test-key-not-real-9999"));
    expect(t.requests).toEqual([
      { method: "GET", url: `${FAKE_BASE_URL}/stores`, hasAuthorization: true, redirect: "manual" },
      { method: "GET", url: `${FAKE_BASE_URL}/stores`, hasAuthorization: false, redirect: null },
      { method: "GET", url: `${FAKE_BASE_URL}/staff?store_id=${FAKE_STORE_ID}`, hasAuthorization: true, redirect: "manual" },
    ]);
    const text = JSON.stringify(t.requests);
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain("9999");
    expect(text).not.toContain("Bearer");
  });

  it("takes another key and another address", async () => {
    const t = createFakeTill({ key: "test-key-not-real-1234", baseUrl: "https://office.scarbromart.ca/ops/v1/" });
    expect(t.baseUrl).toBe("https://office.scarbromart.ca/ops/v1");
    expect((await t.fetch(`${t.baseUrl}/stores`, auth("test-key-not-real-1234"))).status).toBe(200);
    expect((await t.fetch(`${t.baseUrl}/stores`, auth())).status).toBe(401);
  });
});

describe("the fake clock", () => {
  it("starts where it says, and an awaited sleep moves it without real waiting", async () => {
    const clock = createFakeClock();
    expect(clock.now().toISOString()).toBe(new Date(FAKE_START).toISOString());
    const t0 = performance.now();
    await clock.sleep(3000);
    await clock.sleep(7000);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(clock.now().getTime() - new Date(FAKE_START).getTime()).toBe(10_000);
    expect(clock.waits).toEqual([3000, 7000]);
    expect(clock.deadlines).toEqual([]);
  });

  it("a sleep with a signal is a deadline: it is listed apart, and an abort ends it at once", async () => {
    const clock = createFakeClock();
    const ctl = new AbortController();
    const p = clock.sleep(8000, ctl.signal);
    ctl.abort();
    await p;
    expect(clock.deadlines).toEqual([8000]);
    expect(clock.waits).toEqual([]);
    expect(clock.now().toISOString()).toBe(new Date(FAKE_START).toISOString());
    await clock.sleep(1, AbortSignal.abort());
  });

  it("with auto off, time moves only by advance(), in order", async () => {
    const clock = createFakeClock();
    clock.auto = false;
    const order: number[] = [];
    void clock.sleep(300).then(() => order.push(300));
    void clock.sleep(100).then(() => order.push(100));
    await clock.advance(99);
    expect(order).toEqual([]);
    await clock.advance(1);
    expect(order).toEqual([100]);
    await clock.advance(500);
    expect(order).toEqual([100, 300]);
    expect(clock.now().getTime() - new Date(FAKE_START).getTime()).toBe(600);
  });
});

describe("nothing reaches the network", () => {
  it("the global fetch was not called by anything above (and the file fails if it was)", () => {
    expect(reached).not.toHaveBeenCalled();
  });
});
