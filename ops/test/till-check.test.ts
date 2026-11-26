import { describe, expect, it } from "vitest";
import { createTillClient, runTillCheck } from "../tools/till-check";
import { fixture } from "./fixtures/till/load";

const NOW = new Date("2026-11-26T15:00:00Z"); // 10:00 in Toronto: yesterday is 2026-11-25
const BASE = "https://till.test/ops/v1";
const MARKER_NAME = "MARKERNAME";
const MARKER_KEY = "MARKERKEY-9f3a77";

type Call = { method: string; path: string; query: URLSearchParams; headers: Record<string, string> };
type Answer = unknown | ((call: Call) => Response | Promise<Response>);

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function harness(answers: Record<string, Answer> = {}, opts: { key?: string | undefined } = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const lines: string[] = [];
  const defaults: Record<string, Answer> = {
    "/stores": fixture("stores"),
    "/staff": fixture("staff"),
    "/shifts": fixture("shifts"),
    "/sales/daily": fixture("sales-daily"),
    "/products": fixture("products"),
    "/suppliers": fixture("suppliers"),
    "/orders": fixture("orders"),
  };
  const table = { ...defaults, ...answers };
  const fetch = async (url: string, init: { method: string; headers: Record<string, string> }) => {
    const u = new URL(url);
    const call: Call = {
      method: init.method,
      path: u.pathname.replace("/ops/v1", ""),
      query: u.searchParams,
      headers: init.headers,
    };
    calls.push(call);
    const a = table[call.path];
    if (typeof a === "function") return (a as (c: Call) => Response | Promise<Response>)(call);
    return json(200, a);
  };
  const run = async () => {
    const code = await runTillCheck({
      baseUrl: BASE,
      key: "key" in opts ? opts.key : "test-key-1",
      fetch,
      now: () => NOW,
      sleep: async (ms) => void sleeps.push(ms),
      log: (l) => void lines.push(l),
    });
    return { code, out: lines.join("\n"), calls, sleeps };
  };
  return { run, calls };
}

describe("till-check: a valid set of answers", () => {
  it("makes the 7 kinds of call, all GET, and exits 0", async () => {
    const { run } = harness();
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c.path)).toEqual([
      "/stores",
      "/staff",
      "/shifts",
      "/sales/daily",
      "/products",
      "/suppliers",
      "/orders",
    ]);
    expect(new Set(r.calls.map((c) => c.method))).toEqual(new Set(["GET"]));
    expect(r.calls[1]?.query.get("store_id")).toBe("5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e01");
    expect(r.calls[2]?.query.get("day")).toBe("2026-11-25");
    expect(r.calls[3]?.query.get("from")).toBe("2026-11-19");
    expect(r.calls[3]?.query.get("to")).toBe("2026-11-25");
    expect(r.out).toMatch(/GET \/stores\b.* 200 .*1 item.* 0 differences/);
    expect(r.out).toMatch(/GET \/orders\b.* 200 .*1 item/);
  });

  it("waits at least 1.1 seconds between requests", async () => {
    const r = await harness().run();
    expect(r.sleeps).toHaveLength(6);
    expect(Math.min(...r.sleeps)).toBeGreaterThanOrEqual(1100);
  });

  it("handles a store at a time: two stores are two rounds of the six calls", async () => {
    const stores = fixture("stores");
    stores.stores.push({ ...stores.stores[0], store_id: "5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e09", code: "FIC2" });
    const r = await harness({ "/stores": stores }).run();
    expect(r.calls).toHaveLength(13);
    expect(r.code).toBe(0);
  });
});

describe("till-check: differences from the contract", () => {
  it("reports a removed required field with its path and exits 1", async () => {
    const shifts = fixture("shifts");
    delete shifts.shifts[0].opened_by;
    const r = await harness({ "/shifts": shifts }).run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("shifts[0].opened_by");
    expect(r.out).toMatch(/GET \/shifts\b.* 1 differences/);
  });

  it("reports a wrong enum, a wrong type and a disallowed null", async () => {
    const shifts = fixture("shifts");
    shifts.shifts[0].status = "weird";
    shifts.shifts[0].opening_float = "100";
    shifts.shifts[0].register = null;
    const r = await harness({ "/shifts": shifts }).run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("shifts[0].status");
    expect(r.out).toContain("weird");
    expect(r.out).toContain("shifts[0].opening_float");
    expect(r.out).toContain("shifts[0].register");
  });

  it("reports an extra field as a warning and still exits 0", async () => {
    const shifts = fixture("shifts");
    shifts.shifts[0].surprise = 1;
    const r = await harness({ "/shifts": shifts }).run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/WARNING .*shifts\[0\]\.surprise/);
    expect(r.out).not.toMatch(/ERROR/);
  });

  it("reports a broken arithmetic rule with expected and actual, exits 1", async () => {
    const shifts = fixture("shifts");
    shifts.shifts[0].variance = -0.49;
    const r = await harness({ "/shifts": shifts }).run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ERROR .*shifts\[0\]\.variance.*expected -0\.50.*actual -0\.49/);
  });

  it("reports daily takings that do not add up as a warning, exit 0", async () => {
    const daily = fixture("sales-daily");
    daily.days[0].takings.cash = { sales_total: 40, refunds_total: -5, net_total: 35 };
    const r = await harness({ "/sales/daily": daily }).run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/WARNING .*days\[0\]\.takings/);
  });

  it("cross-checks product vendors against the suppliers list", async () => {
    const products = fixture("products");
    products.products[0].suppliers[0].vendor = "GHOST";
    const r = await harness({ "/products": products }).run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("products[0].suppliers[0].vendor");
  });
});

describe("till-check: transport", () => {
  it("stops after a 401, says unauthorized without the key, exits 1", async () => {
    const { run } = harness({
      "/staff": () => json(401, { error: { code: "unauthorized", message: `bad key ${MARKER_KEY}` } }),
    }, { key: MARKER_KEY });
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.calls.map((c) => c.path)).toEqual(["/stores", "/staff"]);
    expect(r.out).toContain("unauthorized");
    expect(r.out).not.toContain(MARKER_KEY);
  });

  it("retries once after a 429 using Retry-After, then succeeds", async () => {
    let n = 0;
    const { run } = harness({
      "/stores": () =>
        ++n === 1
          ? json(429, { error: { code: "rate_limited", message: "slow" } }, { "Retry-After": "1" })
          : json(200, fixture("stores")),
    });
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.calls.filter((c) => c.path === "/stores")).toHaveLength(2);
    expect(r.sleeps).toContain(1100); // Retry-After 1 s, but never closer than 1.1 s
    expect(r.out).toMatch(/GET \/stores\b.* 200/);
  });

  it("waits as long as Retry-After says when that is longer", async () => {
    let n = 0;
    const { run } = harness({
      "/stores": () =>
        ++n === 1 ? json(429, { error: { code: "rate_limited", message: "x" } }, { "Retry-After": "3" }) : json(200, fixture("stores")),
    });
    const r = await run();
    expect(r.sleeps).toContain(3000);
    expect(r.code).toBe(0);
  });

  it("gives up and exits 1 when the retry is also 429", async () => {
    const { run } = harness({
      "/stores": () => json(429, { error: { code: "rate_limited", message: "slow" } }, { "Retry-After": "1" }),
    });
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.calls.filter((c) => c.path === "/stores")).toHaveLength(2);
    expect(r.out).toContain("rate_limited");
  });

  it("reports an unreachable till without a stack trace, exits 1", async () => {
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const { run, calls } = harness({
      "/stores": () => {
        throw err;
      },
    });
    const r = await run();
    expect(r.code).toBe(1);
    expect(calls).toHaveLength(1);
    expect(r.out).toMatch(/unreachable/i);
    expect(r.out).toContain("ECONNREFUSED");
    expect(r.out).not.toMatch(/\n\s+at /);
    expect(r.out).not.toContain("TypeError");
  });

  it("reports a non-JSON answer as a difference and carries on", async () => {
    const { run } = harness({ "/suppliers": () => new Response("<html>", { status: 200 }) });
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/not JSON/i);
  });

  it("reports an unexpected status and carries on to the next call", async () => {
    const { run, calls } = harness({
      "/staff": () => json(403, { error: { code: "forbidden_store", message: `no ${MARKER_NAME}` } }),
    });
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/GET \/staff\b.* 403/);
    expect(r.out).toContain("forbidden_store");
    expect(r.out).not.toContain(MARKER_NAME);
    expect(calls.length).toBeGreaterThan(2);
  });
});

describe("till-check: looking back for a day with shifts", () => {
  const dayOf = (c: Call) => c.query.get("day");

  it("steps back a day at a time until a day has a shift", async () => {
    const { run } = harness({
      "/shifts": (c: Call) => {
        const body = dayOf(c) === "2026-11-22" ? fixture("shifts") : fixture("shifts-empty");
        body.business_day = dayOf(c);
        return json(200, body);
      },
    });
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.calls.filter((c) => c.path === "/shifts").map(dayOf)).toEqual([
      "2026-11-25",
      "2026-11-24",
      "2026-11-23",
      "2026-11-22",
    ]);
  });

  it("stops at 7 days when none has a shift, and that is not an error", async () => {
    const { run } = harness({
      "/shifts": (c: Call) => json(200, { ...fixture<Record<string, unknown>>("shifts-empty"), business_day: dayOf(c) }),
    });
    const r = await run();
    const asked = r.calls.filter((c) => c.path === "/shifts").map(dayOf);
    expect(asked).toHaveLength(7);
    expect(asked[0]).toBe("2026-11-25");
    expect(asked[6]).toBe("2026-11-19");
    expect(r.code).toBe(0);
  });
});

describe("till-check: the key", () => {
  it("sends no Authorization header when there is no key", async () => {
    const r = await harness({}, { key: undefined }).run();
    for (const c of r.calls) {
      expect(Object.keys(c.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
    }
    expect(r.code).toBe(0);
  });

  it("sends exactly Bearer <key> on every call when there is one", async () => {
    const r = await harness({}, { key: "test-key-1" }).run();
    for (const c of r.calls) expect(c.headers["Authorization"]).toBe("Bearer test-key-1");
  });

  it("treats an empty key as no key", async () => {
    const r = await harness({}, { key: "" }).run();
    for (const c of r.calls) expect(Object.keys(c.headers).map((h) => h.toLowerCase())).not.toContain("authorization");
  });
});

describe("till-check: usage", () => {
  it("exits 2 with one usage line when there is no base URL", async () => {
    const lines: string[] = [];
    const code = await runTillCheck({
      baseUrl: "",
      key: "k",
      fetch: async () => {
        throw new Error("must not be called");
      },
      now: () => NOW,
      sleep: async () => {},
      log: (l) => void lines.push(l),
    });
    expect(code).toBe(2);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("TILL_API_BASE_URL");
  });
});

describe("till-check: only GET", () => {
  it("refuses any other method before anything is sent", async () => {
    let sent = 0;
    const client = createTillClient({
      baseUrl: BASE,
      key: "k",
      fetch: async () => {
        sent++;
        return json(200, {});
      },
      sleep: async () => {},
    });
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "get"]) {
      await expect(client.request(method, "/stores", {})).rejects.toThrow(/only GET/i);
    }
    expect(sent).toBe(0);
    await expect(client.request("GET", "/stores", {})).resolves.toMatchObject({ status: 200 });
    expect(sent).toBe(1);
  });
});

describe("till-check: privacy of the output", () => {
  it("never prints a name, a staff id, the key or an Authorization header", async () => {
    const staff = fixture("staff");
    staff.staff[0].display_name = `${MARKER_NAME} Staff`;
    staff.staff[1].role = MARKER_NAME; // an enum violation whose actual value is a name-like string
    const shifts = fixture("shifts");
    shifts.shifts[0].opened_by.name = MARKER_NAME;
    shifts.shifts[0].closed_by.name = 42; // wrong type on a name
    shifts.shifts[0].staff_takings[0].name = MARKER_NAME;
    shifts.shifts[0].variance = -0.49;
    shifts.shifts[0].extra_person = MARKER_NAME;
    const { run } = harness({ "/staff": staff, "/shifts": shifts }, { key: MARKER_KEY });
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("staff[1].role"); // the difference is reported...
    expect(r.out).toContain("shifts[0].closed_by.name");
    for (const secret of [
      MARKER_NAME,
      MARKER_KEY,
      "Testa Fictional",
      "Pat Invented",
      "11111111-aaaa-4aaa-8aaa-000000000001",
      "11111111-aaaa-4aaa-8aaa-000000000002",
    ]) {
      expect(r.out, secret).not.toContain(secret);
    }
    expect(r.out.toLowerCase()).not.toContain("authorization");
    expect(r.out.toLowerCase()).not.toContain("bearer");
  });
});
