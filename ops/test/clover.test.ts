// Clover: modules/clover.ts, with a fake fetch (no test reaches Clover).
//
// The old app had no Clover suite of its own (tests/suites/reconcile.js stubbed Clover entirely), so
// these hold down Clover.gs as written: what counts as a card payment, credit vs debit, the paging,
// the rounding, and every failure as an answer rather than a throw. Plus the security rules of the
// port (card P3-07): the token goes only to Clover's own hosts, a 10-second limit, the merchant id
// encoded, and the token never in an answer.
import { describe, expect, it } from "vitest";
import { Config } from "../src/lib/config";
import * as clover from "../src/modules/clover";

type Reply = { status: number; body?: unknown } | { throws: string } | { hang: true };
interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  signal: AbortSignal | null | undefined;
  body: unknown;
}

function fakeFetch(replies: Reply[]): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const queue = [...replies];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    seen.push({ url: String(input), method: init?.method ?? "GET", headers, signal: init?.signal, body: init?.body });
    const r = queue.shift();
    if (!r) throw new Error("unscripted request");
    if ("throws" in r) throw new Error(r.throws);
    if ("hang" in r) return new Promise<Response>(() => undefined);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? null), { status: r.status });
  }) as typeof fetch;
  return { fetch: f, seen };
}

const TOKEN = "test-clover-token-7Qz";
const merchant = (over: Partial<{ merchantId: string; baseUrl: string; token: string }> = {}): clover.Merchant => {
  const m = { merchantId: over.merchantId ?? "MVAPE0001", baseUrl: over.baseUrl ?? "https://api.clover.com" } as clover.Merchant;
  Object.defineProperty(m, "token", { value: over.token ?? TOKEN, enumerable: false });
  return m;
};
const pay = (amount: unknown, kind: "credit" | "debit", extra: Record<string, unknown> = {}) => ({
  amount,
  result: "SUCCESS",
  cardTransaction: { type: kind === "debit" ? "DEBIT" : "CREDIT" },
  tender: { label: kind === "debit" ? "Debit Card" : "Credit Card" },
  ...extra,
});
const page = (elements: unknown[]): Reply => ({ status: 200, body: { elements } });
const START = 1795188600000;
const END = 1795222800000;

describe("settings", () => {
  it("is enabled only by 'true', any case (Clover.gs isEnabled_)", () => {
    for (const [v, want] of [["true", true], ["TRUE", true], ["True", true], ["false", false], ["1", false], ["yes", false], [" true", false]] as const) {
      expect(clover.isEnabled(Config.fromRows([{ key: "clover_enabled", value: v }]))).toBe(want);
    }
    expect(clover.isEnabled(Config.fromRows([]))).toBe(false);
  });

  it("takes the merchant id from settings and the token only from the Worker binding", () => {
    const config = Config.fromRows([
      { key: "clover_vape_merchant_id", value: "MV1" },
      { key: "clover_cstore_merchant_id", value: "MC1" },
      { key: "clover_vape_token", value: "test-from-the-table" },
    ]);
    const env = { CLOVER_VAPE_TOKEN: "test-vape-binding", CLOVER_CSTORE_TOKEN: "test-cstore-binding" };
    const v = clover.merchantFor({ config, env }, "vape");
    expect([v.merchantId, v.token, v.baseUrl]).toEqual(["MV1", "test-vape-binding", "https://api.clover.com"]);
    const c = clover.merchantFor({ config, env }, "cstore");
    expect([c.merchantId, c.token]).toEqual(["MC1", "test-cstore-binding"]);
    // Anything that is not 'vape' is cstore, as before.
    expect(clover.merchantFor({ config, env }, "grocery").merchantId).toBe("MC1");
    // No binding: a blank token (not configured), never the table's value.
    expect(clover.merchantFor({ config, env: {} }, "vape").token).toBe("");
  });

  it("never puts the token in a JSON or a log of a merchant", () => {
    const m = clover.merchantFor({ config: Config.fromRows([{ key: "clover_vape_merchant_id", value: "MV1" }]), env: { CLOVER_VAPE_TOKEN: TOKEN } }, "vape");
    expect(m.token).toBe(TOKEN);
    expect(JSON.stringify(m)).not.toContain(TOKEN);
    expect(Object.keys(m)).toEqual(["merchantId", "baseUrl"]);
    expect(String({ ...m })).not.toContain(TOKEN);
  });

  it("uses the configured base URL, default https://api.clover.com", () => {
    const config = Config.fromRows([{ key: "clover_base_url", value: "https://apisandbox.dev.clover.com" }]);
    expect(clover.merchantFor({ config, env: {} }, "vape").baseUrl).toBe("https://apisandbox.dev.clover.com");
    expect(clover.merchantFor({ config: Config.fromRows([{ key: "clover_base_url", value: "" }]), env: {} }, "vape").baseUrl).toBe("https://api.clover.com");
  });
});

describe("classifyPayment", () => {
  it("is debit when 'debit' appears in the tender or the card transaction, else credit", () => {
    expect(clover.classifyPayment({ tender: { labelKey: "com.clover.tender.debit_card" } })).toBe("debit");
    expect(clover.classifyPayment({ tender: { label: "DEBIT CARD" } })).toBe("debit");
    expect(clover.classifyPayment({ cardTransaction: { type: "DEBIT" } })).toBe("debit");
    expect(clover.classifyPayment({ cardTransaction: { entryType: "debit swipe" } })).toBe("debit");
    expect(clover.classifyPayment({ tender: { label: "Credit Card" } })).toBe("credit");
    // Unknown is credit, so credit + debit = total.
    expect(clover.classifyPayment({ tender: { label: "Gift" }, cardTransaction: { type: "AUTH" } })).toBe("credit");
    expect(clover.classifyPayment({ tender: null })).toBe("credit");
    expect(clover.classifyPayment({})).toBe("credit");
    // labelKey wins over label; type over entryType.
    expect(clover.classifyPayment({ tender: { labelKey: "credit", label: "debit" } })).toBe("credit");
  });
});

describe("isCloverUrl (the token goes only to Clover)", () => {
  it("accepts Clover's own API hosts over https", () => {
    for (const h of clover.CLOVER_HOSTS) expect(clover.isCloverUrl(`https://${h}/v3/merchants/M/payments`)).toBe(true);
    expect(clover.isCloverUrl("https://api.clover.com:443/v3")).toBe(true);
    expect(clover.isCloverUrl("https://API.CLOVER.COM/v3")).toBe(true);
  });
  it("refuses everything else", () => {
    for (const url of [
      "http://api.clover.com/v3",
      "https://api.clover.com:8443/v3",
      "https://user:pw@api.clover.com/v3",
      "https://user@api.clover.com/v3",
      "https://api.clover.com.example.test/v3",
      "https://example.test/api.clover.com/v3",
      "https://api.clover.com@example.test/v3",
      "https://clover.com/v3",
      "https://evil-api.clover.com/v3",
      "ftp://api.clover.com/v3",
      "api.clover.com/v3",
      "",
      "not a url",
    ]) {
      expect(clover.isCloverUrl(url), url).toBe(false);
    }
  });
});

describe("getCardTotals", () => {
  it("sums the card payments by credit and debit, cents to dollars, rounded once", async () => {
    const net = fakeFetch([page([pay(1050, "credit"), pay(333, "debit"), pay(1, "credit"), pay(2, "credit")])]);
    expect(await clover.getCardTotals({ fetch: net.fetch }, merchant(), START, END)).toEqual({ ok: true, credit: 10.53, debit: 3.33, total: 13.86, count: 4 });
  });

  it("asks for the window with the merchant id encoded, the token as a bearer, a GET with no body", async () => {
    const net = fakeFetch([page([])]);
    await clover.getCardTotals({ fetch: net.fetch }, merchant({ merchantId: "M V/1?&x=1" }), START, END);
    expect(net.seen).toHaveLength(1);
    const s = net.seen[0]!;
    expect(s.url).toBe(
      "https://api.clover.com/v3/merchants/M%20V%2F1%3F%26x%3D1/payments?filter=createdTime%3E%3D1795188600000&filter=createdTime%3C%3D1795222800000&expand=cardTransaction%2Ctender&limit=1000&offset=0",
    );
    expect(s.method).toBe("GET");
    expect(s.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
    expect(s.body).toBeUndefined();
    // The limit is enforced with an AbortSignal handed to the fetch.
    expect(s.signal).toBeInstanceOf(AbortSignal);
  });

  it("strips trailing slashes from the base URL", async () => {
    const net = fakeFetch([page([])]);
    await clover.getCardTotals({ fetch: net.fetch }, merchant({ baseUrl: "https://sandbox.dev.clover.com///" }), START, END);
    expect(net.seen[0]!.url.startsWith("https://sandbox.dev.clover.com/v3/merchants/")).toBe(true);
  });

  it("skips voided and failed payments and payments with no card transaction; a missing result counts", async () => {
    const net = fakeFetch([
      page([pay(1000, "credit", { result: "VOIDED" }), pay(500, "debit", { result: "FAIL" }), { amount: 2000, result: "SUCCESS", tender: { label: "Cash" } }, pay(700, "credit", { result: undefined }), pay(300, "debit", { result: "" })]),
    ]);
    expect(await clover.getCardTotals({ fetch: net.fetch }, merchant(), START, END)).toEqual({ ok: true, credit: 7, debit: 3, total: 10, count: 2 });
  });

  it("counts a payment with no readable amount as $0 (kept from the old code)", async () => {
    const net = fakeFetch([page([pay(undefined, "credit"), pay("abc", "debit"), pay(250, "credit")])]);
    expect(await clover.getCardTotals({ fetch: net.fetch }, merchant(), START, END)).toEqual({ ok: true, credit: 2.5, debit: 0, total: 2.5, count: 3 });
  });

  it("an empty answer, or one with no elements, is $0 measured (Clover answered)", async () => {
    for (const body of [{ elements: [] }, {}, null]) {
      const net = fakeFetch([{ status: 200, body }]);
      expect(await clover.getCardTotals({ fetch: net.fetch }, merchant(), START, END)).toEqual({ ok: true, credit: 0, debit: 0, total: 0, count: 0 });
    }
  });

  it("pages by 1,000 until a short page", async () => {
    const full = Array.from({ length: 1000 }, () => pay(10, "credit"));
    const net = fakeFetch([page(full), page(full), page([pay(5, "debit")])]);
    expect(await clover.getCardTotals({ fetch: net.fetch }, merchant(), START, END)).toEqual({ ok: true, credit: 200, debit: 0.05, total: 200.05, count: 2001 });
    expect(net.seen.map((s) => new URL(s.url).searchParams.get("offset"))).toEqual(["0", "1000", "2000"]);
  });

  it("stops after 50 full pages and answers what it has (the old cap)", async () => {
    const full = Array.from({ length: 1000 }, () => pay(1, "credit"));
    const net = fakeFetch(Array.from({ length: 51 }, () => page(full)));
    const r = await clover.getCardTotals({ fetch: net.fetch }, merchant(), START, END);
    expect(net.seen).toHaveLength(50);
    expect(r).toEqual({ ok: true, credit: 500, debit: 0, total: 500, count: 50000 });
  });

  it("is not configured with no merchant id or no token, and asks nothing", async () => {
    const net = fakeFetch([]);
    expect(await clover.getCardTotals({ fetch: net.fetch }, merchant({ merchantId: "" }), START, END)).toEqual({ ok: false, error: "not_configured" });
    expect(await clover.getCardTotals({ fetch: net.fetch }, merchant({ token: "" }), START, END)).toEqual({ ok: false, error: "not_configured" });
    expect(await clover.getCardTotals({ fetch: net.fetch }, null, START, END)).toEqual({ ok: false, error: "not_configured" });
    expect(net.seen).toHaveLength(0);
  });

  it("DELIBERATE DIFFERENCE: a base URL that is not Clover's is not configured, and the token is sent nowhere", async () => {
    for (const baseUrl of ["https://example.test", "http://api.clover.com", "https://api.clover.com:8443", "https://x@api.clover.com", "https://api.clover.com.example.test", "https://api.clover.com@example.test"]) {
      const net = fakeFetch([page([pay(100, "credit")])]);
      expect(await clover.getCardTotals({ fetch: net.fetch }, merchant({ baseUrl }), START, END), baseUrl).toEqual({ ok: false, error: "not_configured" });
      expect(net.seen, baseUrl).toHaveLength(0);
    }
  });

  it("reports an HTTP error with the first 300 characters of the body, and never the token", async () => {
    const net = fakeFetch([{ status: 401, body: "Unauthorized: " + TOKEN + " " + "z".repeat(500) }]);
    const r = await clover.getCardTotals({ fetch: net.fetch }, merchant(), START, END);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe("http_401");
    expect(r.detail).toContain("Unauthorized: <secret>");
    expect(r.detail).not.toContain(TOKEN);
    for (const code of [300, 404, 500, 503]) {
      const n = fakeFetch([{ status: code, body: "x" }]);
      expect(((await clover.getCardTotals({ fetch: n.fetch }, merchant(), START, END)) as { error: string }).error).toBe("http_" + code);
    }
  });

  it("reports a body that is not JSON, a failed request and a broken page as an exception, never a throw", async () => {
    for (const reply of [{ status: 200, body: "<html>nope</html>" }, { throws: "getaddrinfo ENOTFOUND " + TOKEN }, { status: 200, body: { elements: "not a list" } }, { status: 200, body: { elements: [null] } }] as Reply[]) {
      const net = fakeFetch([reply]);
      const r = await clover.getCardTotals({ fetch: net.fetch }, merchant(), START, END);
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toBe("exception");
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });

  it("gives up on a request after its limit (10 seconds by default) and reports it as an exception", async () => {
    expect(clover.REQUEST_TIMEOUT_MS).toBe(10_000);
    const net = fakeFetch([{ hang: true }]);
    const started = Date.now();
    const r = await clover.getCardTotals({ fetch: net.fetch, timeoutMs: 50 }, merchant(), START, END);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r).toEqual({ ok: false, error: "exception", detail: "timed out after 0.05 seconds" });
    expect(net.seen[0]!.signal?.aborted).toBe(true);
  });
});
