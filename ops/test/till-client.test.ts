// The till client (ops/src/till/client.ts) against the fake till (ops/src/till/fake.ts): no test reaches
// the real till or any network. What is held down:
//   - it never throws: every function answers { ok, data } or { ok: false, error: { kind, ... } }, and
//     every kind of error is reached through the fake's switches;
//   - the key goes only to the till's own addresses (isTillUrl), only in the Authorization header, and is
//     in no answer, no error, no log line and no record of requests, even when the till echoes it back;
//   - a redirect is never followed; a 429 is waited for (with the injected sleep) at most twice and at
//     most maxWaitMs in all; a slow request times out through the injected clock;
//   - inputs are refused before any request; the answer is checked lightly;
//   - the hand-written types and the shapes the client checks match the contract;
//   - it has exactly two callers, named in this file (card P5-02b): the till link's module and handler.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { Config } from "../src/lib/config";
import { CONFIG_KEYS } from "../src/lib/config-keys";
import { TILL_SERVERS, isTillUrl, tillBaseUrl } from "../src/till/address";
import { DEFAULT_MAX_WAIT_MS, DEFAULT_TIMEOUT_MS, MAX_RETRIES, MAX_SPAN_DAYS, SHAPES, createTillClient, retryAfterSeconds, type TillClient, type TillClientOptions } from "../src/till/client";
import { FAKE_DAYS, FAKE_HIDDEN_STORE_ID, FAKE_KEY, FAKE_STORE_ID, createFakeClock, createFakeTill, type FakeTill } from "../src/till/fake";
import { tillClientFor } from "../src/till/index";
import type { TillErrorKind, TillResult } from "../src/till/types";
import { noGlobalFetch } from "./helpers/no-network";

const { reached } = noGlobalFetch();

const ALL_KINDS: TillErrorKind[] = ["not_configured", "bad_address", "bad_input", "timeout", "network", "rate_limited", "unauthorized", "forbidden", "not_found", "server", "bad_answer", "rejected"];

function setup(over: Partial<TillClientOptions> = {}, till: FakeTill = createFakeTill()): { till: FakeTill; client: TillClient } {
  const client = createTillClient({ baseUrl: till.baseUrl, key: till.key, fetch: till.fetch, sleep: till.clock.sleep, now: till.clock.now, ...over });
  return { till, client };
}
const kindOf = (r: TillResult<unknown>): string => (r.ok ? "ok" : r.error.kind);
const errorOf = (r: TillResult<unknown>) => {
  if (r.ok) throw new Error("expected an error, got data");
  return r.error;
};
const dataOf = <T>(r: TillResult<T>): T => {
  if (!r.ok) throw new Error(`expected data, got ${r.error.kind}: ${r.error.message}`);
  return r.data;
};
const everyCall = (client: TillClient): Array<[string, () => Promise<TillResult<unknown>>]> => [
  ["listStores", () => client.listStores()],
  ["listStaff", () => client.listStaff(FAKE_STORE_ID)],
  ["listShifts", () => client.listShifts({ storeId: FAKE_STORE_ID, day: FAKE_DAYS.allChannels })],
  ["dailySales", () => client.dailySales({ storeId: FAKE_STORE_ID, from: "2026-11-20", to: "2026-11-27" })],
  ["listProducts", () => client.listProducts(FAKE_STORE_ID)],
  ["listSuppliers", () => client.listSuppliers(FAKE_STORE_ID)],
  ["listOrders", () => client.listOrders(FAKE_STORE_ID)],
];

/** A fetch that answers with one fixed reply, and keeps what it was asked. */
function reply(status: number, body: unknown, headers: Record<string, string> = {}): { fetch: typeof fetch; seen: Array<{ url: string; init: RequestInit }> } {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    if ([204, 205, 304].includes(status)) return new Response(null, { status, headers });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { fetch: f, seen };
}
const BASE = "https://staging--scarbromart-office.netlify.app/ops/v1";

// ── Where the key may go ───────────────────────────────────

describe("isTillUrl: the key goes only to the till's own addresses", () => {
  const doc = parse(readFileSync(new URL("../contracts/till-api.v1.yaml", import.meta.url), "utf8")) as { servers: Array<{ url: string }> };

  it("the hosts and base paths are the contract's `servers`, exactly", () => {
    expect(TILL_SERVERS.map((s) => `https://${s.host}${s.basePath}`).sort()).toEqual(doc.servers.map((s) => s.url).sort());
  });

  it("accepts each server, its base path and anything under it, in any letter case", () => {
    for (const s of TILL_SERVERS) {
      expect(isTillUrl(`https://${s.host}${s.basePath}`)).toBe(true);
      expect(isTillUrl(`https://${s.host}${s.basePath}/`)).toBe(true);
      expect(isTillUrl(`https://${s.host}${s.basePath}/stores`)).toBe(true);
      expect(isTillUrl(`https://${s.host}${s.basePath}/shifts?store_id=5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e01&day=2026-11-25`)).toBe(true);
      expect(isTillUrl(`HTTPS://${s.host.toUpperCase()}${s.basePath}/stores`)).toBe(true);
    }
  });

  it("refuses everything else", () => {
    const prod = "office.scarbromart.ca";
    const stage = "staging--scarbromart-office.netlify.app";
    const bad: Array<[string, unknown]> = [
      ["http", `http://${prod}/ops/v1`],
      ["ftp", `ftp://${prod}/ops/v1`],
      ["no scheme", `${prod}/ops/v1`],
      ["scheme-relative", `//${prod}/ops/v1`],
      ["a look-alike host after the real one", `https://${prod}.evil.test/ops/v1`],
      ["the real host as a path", `https://evil.test/${prod}/ops/v1`],
      ["a look-alike before it", `https://evil-${prod}/ops/v1`],
      ["a host as a sub-domain of another", `https://${prod}.${stage}/ops/v1`],
      ["a sub-domain of the real host", `https://x.${prod}/ops/v1`],
      ["the parent domain", "https://scarbromart.ca/ops/v1"],
      ["the netlify parent", "https://netlify.app/ops/v1"],
      ["staging without its own name", "https://scarbromart-office.netlify.app/ops/v1"],
      ["user and password", `https://user:pw@${prod}/ops/v1`],
      ["user only", `https://user@${prod}/ops/v1`],
      ["the real host as user name", `https://${prod}@evil.test/ops/v1`],
      ["a user name in front of the real host", `https://evil.test@${prod}/ops/v1`],
      ["a backslash trick", `https://${prod}\\@evil.test/ops/v1`],
      ["an odd port", `https://${prod}:8443/ops/v1`],
      ["the https port, written", `https://${prod}:443/ops/v1`],
      ["an empty port", `https://${prod}:/ops/v1`],
      ["an IPv4 address", "https://203.0.113.5/ops/v1"],
      ["an IPv6 address", "https://[::1]/ops/v1"],
      ["a decimal IP", "https://3405803781/ops/v1"],
      ["a trailing dot", `https://${prod}./ops/v1`],
      ["a trailing dot on staging", `https://${stage}./ops/v1`],
      ["a Cyrillic letter in the host", "https://оffice.scarbromart.ca/ops/v1"],
      ["a full-width dot", "https://office。scarbromart.ca/ops/v1"],
      ["a punycode look-alike", "https://xn--ffice-8cd.scarbromart.ca/ops/v1"],
      ["a percent-encoded host", "https://office%2escarbromart.ca/ops/v1"],
      ["no path", `https://${prod}`],
      ["the root", `https://${prod}/`],
      ["a path that is not the base", `https://${prod}/ops`],
      ["a path that only starts the same", `https://${prod}/ops/v10/stores`],
      ["a path that continues the base's last word", `https://${prod}/ops/v1x`],
      ["the next version", `https://${prod}/ops/v2/stores`],
      ["the base inside another path", `https://${prod}/other/ops/v1`],
      ["a dot-dot climbing out", `https://${prod}/ops/v1/../v2/stores`],
      ["an encoded dot-dot", `https://${prod}/ops/v1/%2e%2e/v2/stores`],
      ["a fragment", `https://${prod}/ops/v1/stores#x`],
      ["a space in front", ` https://${prod}/ops/v1`],
      ["a space behind", `https://${prod}/ops/v1 `],
      ["a line break", `https://${prod}/ops/v1\n`],
      ["empty", ""],
      ["not a url", "not a url"],
      ["undefined", undefined],
      ["null", null],
      ["a number", 5],
      ["an object", { href: `https://${prod}/ops/v1` }],
    ];
    for (const [why, url] of bad) expect(isTillUrl(url), why).toBe(false);
  });

  it("tillBaseUrl: the same rule, no trailing slash, and no query", () => {
    expect(tillBaseUrl("https://office.scarbromart.ca/ops/v1///")).toBe("https://office.scarbromart.ca/ops/v1");
    expect(tillBaseUrl("https://office.scarbromart.ca/ops/v1?x=1")).toBeNull();
    expect(tillBaseUrl("https://evil.test/ops/v1")).toBeNull();
    expect(tillBaseUrl("")).toBeNull();
  });

  it("a client given any other address makes no request, whatever it is asked", async () => {
    for (const baseUrl of ["https://evil.test/ops/v1", "http://office.scarbromart.ca/ops/v1", `https://user:pw@office.scarbromart.ca/ops/v1`, "https://office.scarbromart.ca:8443/ops/v1", "https://office.scarbromart.ca/ops/v1?x=1", "https://office.scarbromart.ca/other"]) {
      const { till, client } = setup({ baseUrl });
      for (const [name, call] of everyCall(client)) {
        const r = await call();
        expect([baseUrl, name, kindOf(r)]).toEqual([baseUrl, name, "bad_address"]);
      }
      expect(till.requests, baseUrl).toEqual([]);
    }
  });

  it("an address that is the till's, with a trailing slash, works", async () => {
    const { till, client } = setup({ baseUrl: `${BASE}///` });
    expect(dataOf(await client.listStores()).stores).toHaveLength(1);
    expect(till.requests[0]?.url).toBe(`${BASE}/stores`);
  });
});

// ── Not set up ─────────────────────────────────────────────

describe("not_configured: no address or no key, no request", () => {
  it.each([
    ["no address", { baseUrl: "" }],
    ["a blank address", { baseUrl: "   " }],
    ["a missing address", { baseUrl: undefined }],
    ["a null address", { baseUrl: null }],
    ["no key", { key: "" }],
    ["a missing key", { key: undefined }],
    ["a null key", { key: null }],
    ["a key with a space", { key: "test key" }],
    ["a key with a line break", { key: "test-key\r\nX-Evil: 1" }],
    ["a key with a letter outside ASCII", { key: "test-kéy-not-real" }],
  ] as Array<[string, Partial<TillClientOptions>]>)("%s", async (_why, over) => {
    const { till, client } = setup(over);
    for (const [name, call] of everyCall(client)) {
      const r = await call();
      expect([name, kindOf(r)]).toEqual([name, "not_configured"]);
    }
    expect(till.requests).toEqual([]);
  });

  it("an unusable key is never printed in the message", async () => {
    const { client } = setup({ key: "test key\nsecret-part" });
    expect(JSON.stringify(await client.listStores())).not.toContain("secret-part");
  });
});

describe("tillClientFor: off unless the flag is on AND the address is the till's AND the key is bound", () => {
  const rows = (over: Record<string, string | null> = {}) =>
    Config.fromRows(Object.entries({ till_enabled: "true", till_api_url: BASE, ...over }).map(([key, value]) => ({ key, value })));
  const deps = (till: FakeTill) => ({ fetch: till.fetch, sleep: till.clock.sleep, now: till.clock.now });

  it("the defaults are off, blank and blank", () => {
    expect(CONFIG_KEYS.till_enabled.default).toBe("false");
    expect(CONFIG_KEYS.till_api_url.default).toBe("");
    expect(CONFIG_KEYS.till_key_expires_on.default).toBe("");
    expect(CONFIG_KEYS.till_api_key.kind).toBe("secret");
  });

  it.each([
    ["the flag is off", rows({ till_enabled: "false" }), { TILL_API_KEY: FAKE_KEY }],
    ["the flag is not set at all", Config.fromRows([{ key: "till_api_url", value: BASE }]), { TILL_API_KEY: FAKE_KEY }],
    ["the flag is something but true", rows({ till_enabled: "yes" }), { TILL_API_KEY: FAKE_KEY }],
    ["the address is blank", rows({ till_api_url: null }), { TILL_API_KEY: FAKE_KEY }],
    ["the address is not the till's", rows({ till_api_url: "https://evil.test/ops/v1" }), { TILL_API_KEY: FAKE_KEY }],
    ["the address has a user name", rows({ till_api_url: "https://u:p@staging--scarbromart-office.netlify.app/ops/v1" }), { TILL_API_KEY: FAKE_KEY }],
    ["the key is not bound", rows(), {}],
    ["the key is empty", rows(), { TILL_API_KEY: "" }],
    ["the key is not text", rows(), { TILL_API_KEY: 12345 }],
  ] as Array<[string, Config, Record<string, unknown>]>)("%s: not_configured, no request", async (_why, config, env) => {
    const till = createFakeTill();
    const client = tillClientFor(env, config, deps(till));
    for (const [name, call] of everyCall(client)) expect([name, kindOf(await call())]).toEqual([name, "not_configured"]);
    expect(till.requests).toEqual([]);
  });

  it("with all three, it works, and sends the key from the binding", async () => {
    const till = createFakeTill();
    const client = tillClientFor({ TILL_API_KEY: FAKE_KEY }, rows({ till_enabled: "TRUE" }), deps(till));
    expect(dataOf(await client.listStores()).stores[0]?.store_id).toBe(FAKE_STORE_ID);
    expect(till.requests).toEqual([{ method: "GET", url: `${BASE}/stores`, hasAuthorization: true, redirect: "manual" }]);
  });

  it("the key is read from the binding only: a row of the table named like it is ignored", async () => {
    const till = createFakeTill();
    const client = tillClientFor({}, rows({ till_api_key: FAKE_KEY }), deps(till));
    expect(kindOf(await client.listStores())).toBe("not_configured");
    expect(till.requests).toEqual([]);
  });
});

// ── Every kind of error, through the switches ──────────────

describe("every kind of error is reached", () => {
  it("through the fake's switches and the client's own checks", async () => {
    const got: Record<string, TillResult<unknown>> = {};

    got.not_configured = await setup({ key: "" }).client.listStores();
    got.bad_address = await setup({ baseUrl: "https://evil.test/ops/v1" }).client.listStores();
    got.bad_input = await setup().client.listStaff("not-a-uuid");
    {
      const { till, client } = setup();
      till.slow(60_000);
      got.timeout = await client.listStores();
    }
    {
      const { till, client } = setup();
      till.down();
      got.network = await client.listStores();
    }
    {
      const { till, client } = setup();
      till.rateLimit(99, 1);
      got.rate_limited = await client.listStores();
    }
    got.unauthorized = await setup({ key: "test-key-not-real-9999" }).client.listStores();
    got.forbidden = await setup().client.listStaff(FAKE_HIDDEN_STORE_ID);
    got.not_found = await setup({ baseUrl: `${BASE}/nowhere` }).client.listStores();
    {
      const { till, client } = setup();
      till.serverError();
      got.server = await client.listStores();
    }
    {
      const { till, client } = setup();
      till.garbage();
      got.bad_answer = await client.listStores();
    }
    // The client believes it is a day later than the till does: the till refuses the date.
    got.rejected = await setup({ now: () => new Date("2026-11-28T15:00:00Z") }).client.listShifts({ storeId: FAKE_STORE_ID, day: "2026-11-28" });

    for (const kind of ALL_KINDS) expect(kindOf(got[kind]!), kind).toBe(kind);
    expect(Object.keys(got).sort()).toEqual([...ALL_KINDS].sort());
  });

  it("carries the HTTP status and the till's own code, and a message a person can read", async () => {
    const e = async (setupFn: () => Promise<TillResult<unknown>>) => errorOf(await setupFn());
    expect(await e(() => setup({ key: "test-key-not-real-9999" }).client.listStores())).toMatchObject({ kind: "unauthorized", status: 401, code: "unauthorized" });
    expect(await e(() => setup().client.listStaff(FAKE_HIDDEN_STORE_ID))).toMatchObject({ kind: "forbidden", status: 403, code: "forbidden_store" });
    expect(await e(() => setup({ baseUrl: `${BASE}/nowhere` }).client.listStores())).toMatchObject({ kind: "not_found", status: 404, code: "not_found" });
    const s = setup();
    s.till.serverError();
    expect(await e(() => s.client.listStores())).toMatchObject({ kind: "server", status: 500, code: "server_error", message: "the till failed" });
    expect(await e(() => setup({ now: () => new Date("2026-11-28T15:00:00Z") }).client.listShifts({ storeId: FAKE_STORE_ID, day: "2026-11-28" }))).toMatchObject({ kind: "rejected", status: 400, code: "bad_request", message: "day is after today" });
    const r = setup();
    r.till.rateLimit(99, 4);
    expect(await e(() => r.client.listStores())).toMatchObject({ kind: "rate_limited", status: 429, code: "rate_limited", retryAfterSeconds: 4 });
  });

  it("other statuses: 409 and 422 are rejected with the till's code; 503 is a server error; an unknown code is dropped", async () => {
    const asks = (status: number, body: unknown) => {
      const r = reply(status, body);
      return createTillClient({ baseUrl: BASE, key: FAKE_KEY, fetch: r.fetch, sleep: async () => undefined, now: () => new Date("2026-11-27T15:00:00Z") }).listStores();
    };
    expect(errorOf(await asks(409, { error: { code: "conflict", message: "idempotency key reused" } }))).toEqual({ kind: "rejected", status: 409, code: "conflict", message: "idempotency key reused" });
    expect(errorOf(await asks(422, { error: { code: "rejected", message: "unknown SKU" } }))).toEqual({ kind: "rejected", status: 422, code: "rejected", message: "unknown SKU" });
    expect(errorOf(await asks(503, { error: { code: "unavailable", message: "database did not answer" } }))).toEqual({ kind: "server", status: 503, code: "unavailable", message: "database did not answer" });
    expect(errorOf(await asks(500, { error: { code: "made_up", message: "x" } }))).toEqual({ kind: "server", status: 500, message: "x" });
    // No JSON body at all: the status alone speaks, and nothing of the body is shown.
    expect(errorOf(await asks(502, "<html>Bad gateway SENTINEL-BODY</html>"))).toEqual({ kind: "server", status: 502, message: "the till failed (502)" });
    expect(errorOf(await asks(418, "teapot"))).toEqual({ kind: "rejected", status: 418, message: "the till refused the request (418)" });
  });

  it("a status that is neither an answer nor an error is bad_answer", async () => {
    for (const status of [201, 204, 301, 304]) {
      const r = reply(status, status === 204 ? "" : {});
      const client = createTillClient({ baseUrl: BASE, key: FAKE_KEY, fetch: r.fetch, sleep: async () => undefined, now: () => new Date("2026-11-27T15:00:00Z") });
      expect([status, kindOf(await client.listStores())]).toEqual([status, "bad_answer"]);
    }
  });
});

// ── Never throws ───────────────────────────────────────────

describe("never throws", () => {
  const clientWith = (over: Partial<TillClientOptions>) => createTillClient({ baseUrl: BASE, key: FAKE_KEY, fetch: reply(200, {}).fetch, sleep: async () => undefined, now: () => new Date("2026-11-27T15:00:00Z"), ...over });

  it.each([
    ["a fetch that throws at once", (() => { throw new Error("boom"); }) as unknown as typeof fetch],
    ["a fetch that throws a string", (async () => { throw "boom"; }) as unknown as typeof fetch],
    ["a fetch that throws null", (async () => { throw null; }) as unknown as typeof fetch],
    ["a fetch that answers nothing", (async () => undefined) as unknown as typeof fetch],
    ["a fetch that answers a number", (async () => 5) as unknown as typeof fetch],
    ["an answer whose body cannot be read", (async () => ({ status: 200, headers: new Headers(), text: async () => { throw new Error("boom"); } })) as unknown as typeof fetch],
    ["an answer with no headers", (async () => ({ status: 429, text: async () => "{}" })) as unknown as typeof fetch],
  ])("%s", async (_why, f) => {
    const client = clientWith({ fetch: f });
    for (const [name, call] of everyCall(client)) {
      const r = await call();
      expect([name, r.ok]).toEqual([name, false]);
      expect(ALL_KINDS).toContain(errorOf(r).kind);
    }
  });

  it("a sleep or a clock that throws", async () => {
    for (const over of [{ sleep: (() => { throw new Error("boom"); }) as TillClientOptions["sleep"] }, { sleep: (async () => { throw new Error("boom"); }) as TillClientOptions["sleep"] }, { now: () => { throw new Error("boom"); } }]) {
      const client = clientWith(over);
      for (const [name, call] of everyCall(client)) expect([name, (await call()).ok]).toEqual([name, false]);
    }
  });

  it("a network error is kind network, with the cause's code when it has one, and nothing else of it", async () => {
    const { till, client } = setup();
    till.down();
    expect(errorOf(await client.listStores())).toEqual({ kind: "network", message: "the till could not be reached (ECONNREFUSED)" });
    const plain = clientWith({ fetch: (async () => { throw new TypeError(`fetch failed ${FAKE_KEY} Bearer ${FAKE_KEY}`); }) as typeof fetch });
    expect(errorOf(await plain.listStores())).toEqual({ kind: "network", message: "the till could not be reached" });
  });
});

// ── The key ────────────────────────────────────────────────

describe("the key", () => {
  it("goes in the Authorization header, as a Bearer, and nowhere else: not the address, not another header", async () => {
    const KEY = "test-key-not-real+/=0000";
    const r = reply(200, { stores: [] });
    const client = createTillClient({ baseUrl: BASE, key: KEY, fetch: r.fetch, sleep: async () => undefined, now: () => new Date("2026-11-27T15:00:00Z") });
    for (const [, call] of everyCall(client)) await call();
    expect(r.seen).toHaveLength(7);
    for (const { url, init } of r.seen) {
      expect(url).not.toContain("test-key");
      expect(decodeURIComponent(url)).not.toContain("test-key");
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("manual");
      expect(init.body).toBeUndefined();
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(Object.entries(headers).filter(([k, v]) => k !== "Authorization" && v.includes("test-key"))).toEqual([]);
    }
  });

  it("is in no result, in the record of requests, or in a log line, in any state of the fake", async () => {
    const spies = (["log", "info", "warn", "error", "debug", "trace"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      const everything: string[] = [];
      const states: Array<[string, (t: FakeTill) => void]> = [
        ["normal", () => undefined],
        ["down", (t) => t.down()],
        ["slow", (t) => t.slow(60_000)],
        ["rate limited", (t) => t.rateLimit(99, 1)],
        ["server error", (t) => t.serverError()],
        ["garbage", (t) => t.garbage()],
        ["redirect", (t) => t.redirect(`https://evil.test/steal?k=${FAKE_KEY}`)],
        ["echo", (t) => t.echoKey()],
      ];
      for (const [, on] of states) {
        const { till, client } = setup();
        on(till);
        for (const [, call] of everyCall(client)) everything.push(JSON.stringify(await call()));
        everything.push(JSON.stringify(till.requests));
        expect(JSON.stringify(till.requests)).not.toContain("Bearer");
      }
      // A wrong key too: the till's refusal says nothing of either key.
      const wrong = setup({ key: "test-key-not-real-9999" });
      everything.push(JSON.stringify(await wrong.client.listStores()), JSON.stringify(wrong.till.requests));
      for (const text of everything) {
        expect(text).not.toContain(FAKE_KEY);
        expect(text).not.toContain("not-real-9999");
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it("is scrubbed from what the till echoes back: the header, the key, and its URL-encoded, JSON-escaped and base64 forms", async () => {
    const KEY = 'tk-"q"-\\b/+=-0000';
    const forms = [KEY, encodeURIComponent(KEY), JSON.stringify(KEY).slice(1, -1), btoa(KEY)];
    const message = `bad header Authorization: Bearer ${KEY}; raw ${KEY}; encoded ${forms[1]}; escaped ${forms[2]}; b64 ${forms[3]}`;
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 502, 503]) {
      const r = reply(status, { error: { code: "server_error", message } });
      const client = createTillClient({ baseUrl: BASE, key: KEY, fetch: r.fetch, sleep: async () => undefined, now: () => new Date("2026-11-27T15:00:00Z"), maxWaitMs: 0 });
      for (const [name, call] of everyCall(client)) {
        const result = await call();
        const text = JSON.stringify(result);
        for (const f of forms) expect([status, name, f, text.includes(f)]).toEqual([status, name, f, false]);
        if (status !== 429) expect(errorOf(result).message).toContain("[key]");
      }
    }
  });

  it("is scrubbed even when the fake till echoes the header in a 500", async () => {
    const { till, client } = setup();
    till.echoKey();
    const e = errorOf(await client.listStores());
    expect(e.kind).toBe("server");
    expect(e.message).toContain("[key]");
    expect(e.message).not.toContain(FAKE_KEY);
    expect(JSON.stringify(e)).not.toContain("test-key-not-real");
  });

  it("is scrubbed from a code the till made up out of it, and from a bad answer's message", async () => {
    const r = reply(500, { error: { code: FAKE_KEY, message: `Bearer ${FAKE_KEY}` } });
    const client = createTillClient({ baseUrl: BASE, key: FAKE_KEY, fetch: r.fetch, sleep: async () => undefined, now: () => new Date("2026-11-27T15:00:00Z") });
    const e = errorOf(await client.listStores());
    expect(JSON.stringify(e)).not.toContain(FAKE_KEY);
    expect(e.code).toBeUndefined();
    const odd = reply(200, { [FAKE_KEY]: 1 });
    const c2 = createTillClient({ baseUrl: BASE, key: FAKE_KEY, fetch: odd.fetch, sleep: async () => undefined, now: () => new Date("2026-11-27T15:00:00Z") });
    expect(JSON.stringify(await c2.listStores())).not.toContain(FAKE_KEY);
  });

  it("is not in the message of a long till message cut short", async () => {
    const message = "x".repeat(290) + FAKE_KEY + "y".repeat(50);
    const r = reply(500, { error: { code: "server_error", message } });
    const client = createTillClient({ baseUrl: BASE, key: FAKE_KEY, fetch: r.fetch, sleep: async () => undefined, now: () => new Date("2026-11-27T15:00:00Z") });
    const e = errorOf(await client.listStores());
    expect(e.message).not.toContain("test-key");
    expect(e.message.length).toBeLessThanOrEqual(300);
  });

  it("is not in the record of a request the fake refused for lack of one", async () => {
    const { till, client } = setup({ key: "test-key-not-real-9999" });
    await client.listStores();
    expect(JSON.stringify(till.requests)).not.toContain("9999");
  });
});

describe("a redirect is never followed", () => {
  it("answers bad_answer after ONE request, which asked not to follow, and the key goes nowhere else", async () => {
    for (const target of ["https://evil.test/steal", `${BASE}/stores`, `https://evil.test/?k=${FAKE_KEY}`]) {
      const { till, client } = setup();
      till.redirect(target);
      for (const [name, call] of everyCall(client)) {
        const e = errorOf(await call());
        expect([name, e.kind, e.status]).toEqual([name, "bad_answer", 302]);
        expect(e.message).not.toContain("evil.test");
        expect(JSON.stringify(e)).not.toContain(FAKE_KEY);
      }
      expect(till.requests).toHaveLength(7);
      expect(new Set(till.requests.map((r) => r.redirect))).toEqual(new Set(["manual"]));
      expect(till.requests.every((r) => r.url.startsWith(BASE))).toBe(true);
      expect(till.requests.some((r) => r.url.includes("evil.test"))).toBe(false);
    }
  });
});

// ── Slowing down ───────────────────────────────────────────

describe("429: waits for Retry-After with the injected sleep, at most twice, at most maxWaitMs in all", () => {
  it("whole seconds", async () => {
    const { till, client } = setup();
    till.rateLimit(1, 3);
    const t0 = performance.now();
    expect(dataOf(await client.listStores()).stores).toHaveLength(1);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(till.clock.waits).toEqual([3000]);
    expect(till.requests).toHaveLength(2);
  });

  it("an HTTP date, read against the injected clock", async () => {
    const { till, client } = setup();
    till.rateLimit(1, new Date(till.clock.now().getTime() + 5000).toUTCString());
    expect(kindOf(await client.listStores())).toBe("ok");
    expect(till.clock.waits).toEqual([5000]);

    // A clock half a second into a second: a date 4.5 s ahead is 4.5 s away, which is waited for as 5.
    const late = setup({}, createFakeTill({ clock: createFakeClock("2026-11-27T15:00:00.500Z") }));
    late.till.rateLimit(1, new Date(late.till.clock.now().getTime() + 4500).toUTCString());
    await late.client.listStores();
    expect(late.till.clock.waits).toEqual([5000]); // rounded up to a whole second

    const past = setup();
    past.till.rateLimit(1, new Date(past.till.clock.now().getTime() - 60_000).toUTCString());
    expect(kindOf(await past.client.listStores())).toBe("ok");
    expect(past.till.clock.waits).toEqual([0]);
  });

  it("a missing or unreadable Retry-After counts as 1 second", async () => {
    for (const header of [undefined, "", "soon", "-5", "1.5", "1e3", "3 seconds", "0x10", "Tomorrow", "not a date 2026", "99999999999999999999"]) {
      const { till, client } = setup();
      till.rateLimit(1, header);
      await client.listStores();
      expect([String(header), till.clock.waits]).toEqual([String(header), [1000]]);
    }
  });

  it("retryAfterSeconds on its own", () => {
    const now = new Date("2026-11-27T15:00:00Z");
    expect(retryAfterSeconds("7", now)).toBe(7);
    expect(retryAfterSeconds(" 7 ", now)).toBe(7);
    expect(retryAfterSeconds("0", now)).toBe(0);
    expect(retryAfterSeconds(null, now)).toBe(1);
    expect(retryAfterSeconds("Fri, 27 Nov 2026 15:00:05 GMT", now)).toBe(5);
    expect(retryAfterSeconds("Fri, 27 Nov 2026 14:00:00 GMT", now)).toBe(0);
    expect(retryAfterSeconds("Friday, 27-Nov-26 15:00:09 GMT", now)).toBe(9);
    expect(retryAfterSeconds("Fri Nov 27 15:00:03 2026", now)).toBe(3);
    expect(retryAfterSeconds("Fri, 27 Nov 2026 15:00:05", now)).toBe(1); // no GMT: not an HTTP date
    expect(retryAfterSeconds("garbage", now)).toBe(1);
    expect(retryAfterSeconds("100000000", now)).toBe(86_400); // never trusted past a day
  });

  it("at most 2 retries: three requests in all, then rate_limited with retryAfterSeconds", async () => {
    expect(MAX_RETRIES).toBe(2);
    const { till, client } = setup();
    till.rateLimit(1000, 1);
    const e = errorOf(await client.listStores());
    expect(e).toMatchObject({ kind: "rate_limited", status: 429, code: "rate_limited", retryAfterSeconds: 1 });
    expect(till.requests).toHaveLength(3);
    expect(till.clock.waits).toEqual([1000, 1000]);
  });

  it("two 429s then an answer is an answer", async () => {
    const { till, client } = setup();
    till.rateLimit(2, 2);
    expect(kindOf(await client.listStores())).toBe("ok");
    expect(till.requests).toHaveLength(3);
    expect(till.clock.waits).toEqual([2000, 2000]);
  });

  it("never more than maxWaitMs of waiting in all (10 seconds by default)", async () => {
    expect(DEFAULT_MAX_WAIT_MS).toBe(10_000);
    // 6 s fits; a second 6 s would make 12 s: stop before sleeping.
    const a = setup();
    a.till.rateLimit(1000, 6);
    expect(errorOf(await a.client.listStores())).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 6 });
    expect(a.till.clock.waits).toEqual([6000]);
    expect(a.till.requests).toHaveLength(2);
    // A single wait over the cap is not waited for at all.
    const b = setup();
    b.till.rateLimit(1000, 11);
    expect(errorOf(await b.client.listStores())).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 11 });
    expect(b.till.clock.waits).toEqual([]);
    expect(b.till.requests).toHaveLength(1);
    // Exactly the cap is allowed.
    const c = setup();
    c.till.rateLimit(1, 10);
    expect(kindOf(await c.client.listStores())).toBe("ok");
    expect(c.till.clock.waits).toEqual([10_000]);
    // 5 + 5 = 10 fits; the third wait would not be needed (two retries at most).
    const d = setup();
    d.till.rateLimit(1000, 5);
    await d.client.listStores();
    expect(d.till.clock.waits).toEqual([5000, 5000]);
  });

  it("the cap is a setting of the client", async () => {
    const { till, client } = setup({ maxWaitMs: 2000 });
    till.rateLimit(1000, 3);
    expect(kindOf(await client.listStores())).toBe("rate_limited");
    expect(till.clock.waits).toEqual([]);
    const lax = setup({ maxWaitMs: 60_000 });
    lax.till.rateLimit(2, 20);
    expect(kindOf(await lax.client.listStores())).toBe("ok");
    expect(lax.till.clock.waits).toEqual([20_000, 20_000]);
  });

  it("a 5xx is not retried, and neither is a timeout", async () => {
    const a = setup();
    a.till.serverError();
    await a.client.listStores();
    expect(a.till.requests).toHaveLength(1);
    const b = setup();
    b.till.slow(60_000);
    await b.client.listStores();
    expect(b.till.requests).toHaveLength(1);
    expect(b.till.clock.waits).toEqual([]);
  });
});

describe("timeout, through the injected clock", () => {
  it("a request slower than timeoutMs (8 s by default) is a timeout; no real time passes", async () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(8000);
    const { till, client } = setup();
    till.slow(20_000);
    const start = till.clock.now().getTime();
    const t0 = performance.now();
    const e = errorOf(await client.listStores());
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(e).toMatchObject({ kind: "timeout" });
    expect(e.status).toBeUndefined();
    expect(till.clock.now().getTime() - start).toBe(8000);
    expect(till.clock.deadlines).toEqual([8000]);
  });

  it("timeoutMs is a setting, and a request faster than it is fine", async () => {
    const a = setup({ timeoutMs: 500 });
    a.till.slow(900);
    expect(kindOf(await a.client.listStores())).toBe("timeout");
    const b = setup({ timeoutMs: 500 });
    b.till.slow(400);
    expect(kindOf(await b.client.listStores())).toBe("ok");
    expect(b.till.clock.deadlines).toEqual([500]);
  });

  it("the request is told to stop (its signal aborts), and the deadline's timer is cancelled when it finishes", async () => {
    let signal: AbortSignal | null | undefined;
    const { till } = setup();
    till.slow(60_000);
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      return till.fetch(input, init);
    }) as typeof fetch;
    const client = createTillClient({ baseUrl: till.baseUrl, key: till.key, fetch: spy, sleep: till.clock.sleep, now: till.clock.now });
    await client.listStores();
    expect(signal?.aborted).toBe(true);

    // Finished in time: the deadline sleep is aborted, so a real timer could be cleared.
    let deadlineSignal: AbortSignal | undefined;
    const fine = createFakeTill();
    const ok = setup(
      {
        sleep: (ms, s) => {
          deadlineSignal = s;
          return fine.clock.sleep(ms, s);
        },
      },
      fine,
    );
    await ok.client.listStores();
    expect(deadlineSignal?.aborted).toBe(true);
  });

  it("reading the body counts too: an answer that never finishes is a timeout", async () => {
    const till = createFakeTill();
    const hanging = (async () => ({ status: 200, headers: new Headers(), text: () => new Promise<string>(() => undefined) })) as unknown as typeof fetch;
    const client = createTillClient({ baseUrl: till.baseUrl, key: till.key, fetch: hanging, sleep: till.clock.sleep, now: till.clock.now });
    expect(kindOf(await client.listStores())).toBe("timeout");
  });

  it("a sleep that returns at once (a stub that does not wait) is not mistaken for a timeout", async () => {
    const { client } = setup({ sleep: async () => undefined });
    expect(kindOf(await client.listStores())).toBe("ok");
  });
});

// ── Inputs ─────────────────────────────────────────────────

describe("inputs are checked before any request", () => {
  const S = FAKE_STORE_ID;
  const calls: Array<[string, (c: TillClient) => Promise<TillResult<unknown>>]> = [
    ["listStaff: no store", (c) => c.listStaff(undefined as unknown as string)],
    ["listStaff: not a uuid", (c) => c.listStaff("abc")],
    ["listStaff: a uuid and more", (c) => c.listStaff(`${S}x`)],
    ["listStaff: a number", (c) => c.listStaff(5 as unknown as string)],
    ["listStaff: injection", (c) => c.listStaff(`${S}&day=2026-11-25`)],
    ["listProducts: not a uuid", (c) => c.listProducts("")],
    ["listSuppliers: not a uuid", (c) => c.listSuppliers("../x")],
    ["listOrders: not a uuid", (c) => c.listOrders("nope")],
    ["listOrders: another status", (c) => c.listOrders(S, "closed" as "open")],
    ["listShifts: no input", (c) => c.listShifts(undefined as never)],
    ["listShifts: not a uuid", (c) => c.listShifts({ storeId: "x", day: "2026-11-25" })],
    ["listShifts: no day", (c) => c.listShifts({ storeId: S } as never)],
    ["listShifts: month 13", (c) => c.listShifts({ storeId: S, day: "2026-13-01" })],
    ["listShifts: 30 Feb", (c) => c.listShifts({ storeId: S, day: "2026-02-30" })],
    ["listShifts: a day that is not a leap day", (c) => c.listShifts({ storeId: S, day: "2027-02-29" })],
    ["listShifts: slashes", (c) => c.listShifts({ storeId: S, day: "2026/11/25" })],
    ["listShifts: two-digit year", (c) => c.listShifts({ storeId: S, day: "26-11-25" })],
    ["listShifts: a moment", (c) => c.listShifts({ storeId: S, day: "2026-11-25T14:00:00Z" })],
    ["listShifts: after today", (c) => c.listShifts({ storeId: S, day: "2026-11-28" })],
    ["dailySales: no input", (c) => c.dailySales(undefined as never)],
    ["dailySales: not a uuid", (c) => c.dailySales({ storeId: "x", from: "2026-11-01", to: "2026-11-02" })],
    ["dailySales: from missing", (c) => c.dailySales({ storeId: S, to: "2026-11-02" } as never)],
    ["dailySales: to missing", (c) => c.dailySales({ storeId: S, from: "2026-11-02" } as never)],
    ["dailySales: not real", (c) => c.dailySales({ storeId: S, from: "2026-11-31", to: "2026-12-01" })],
    ["dailySales: from after to", (c) => c.dailySales({ storeId: S, from: "2026-11-05", to: "2026-11-04" })],
    ["dailySales: to after today", (c) => c.dailySales({ storeId: S, from: "2026-11-20", to: "2026-11-28" })],
    ["dailySales: 93 days", (c) => c.dailySales({ storeId: S, from: "2026-08-25", to: "2026-11-26" })],
    ["dailySales: a year", (c) => c.dailySales({ storeId: S, from: "2025-11-01", to: "2026-11-01" })],
  ];
  it.each(calls)("%s", async (_why, call) => {
    const { till, client } = setup();
    expect(kindOf(await call(client))).toBe("bad_input");
    expect(till.requests).toEqual([]);
  });

  it("the messages name the problem, never the value", async () => {
    const { client } = setup();
    const e = errorOf(await client.listShifts({ storeId: S, day: "SENTINEL-NOT-A-DAY" }));
    expect(e.message).toBe("day must be a real date written YYYY-MM-DD");
    expect(JSON.stringify(errorOf(await client.listStaff("SENTINEL-NOT-AN-ID")))).not.toContain("SENTINEL");
  });

  it("the edges are allowed: today, and exactly 92 days", async () => {
    expect(MAX_SPAN_DAYS + 1).toBe(92);
    const { till, client } = setup();
    expect(kindOf(await client.listShifts({ storeId: S, day: "2026-11-27" }))).toBe("ok");
    expect(kindOf(await client.dailySales({ storeId: S, from: "2026-11-27", to: "2026-11-27" }))).toBe("ok");
    expect(kindOf(await client.dailySales({ storeId: S, from: "2026-08-27", to: "2026-11-26" }))).toBe("ok");
    expect(kindOf(await client.dailySales({ storeId: S, from: "2026-08-28", to: "2026-11-27" }))).toBe("ok");
    expect(till.requests).toHaveLength(4);
    expect(kindOf(await client.dailySales({ storeId: S, from: "2026-08-26", to: "2026-11-26" }))).toBe("bad_input");
    expect(till.requests).toHaveLength(4);
  });

  it("'today' is the Toronto day of the injected clock", async () => {
    // 03:00 UTC on the 28th is 22:00 on the 27th in Toronto: the 28th is still tomorrow.
    const early = setup({ now: () => new Date("2026-11-28T03:00:00Z") });
    expect(kindOf(await early.client.listShifts({ storeId: S, day: "2026-11-28" }))).toBe("bad_input");
    expect(early.till.requests).toEqual([]);
    // 06:00 UTC on the 28th is 01:00 on the 28th in Toronto: the request goes out (the fake's own clock is a day behind and says no).
    const late = setup({ now: () => new Date("2026-11-28T06:00:00Z") });
    expect(kindOf(await late.client.listShifts({ storeId: S, day: "2026-11-28" }))).toBe("rejected");
    expect(late.till.requests).toHaveLength(1);
  });

  it("only the contract's parameters are sent: unknown ones are dropped", async () => {
    const { till, client } = setup();
    await client.listShifts({ storeId: S, day: "2026-11-25", from: "2026-11-01", limit: 5, status: "open", key: "x" } as never);
    await client.dailySales({ storeId: S, from: "2026-11-20", to: "2026-11-25", day: "2026-11-25", page: 2 } as never);
    await client.listStaff(S);
    await client.listOrders(S);
    await client.listOrders(S, "open");
    const queries = till.requests.map((r) => [...new URL(r.url).searchParams.keys()]);
    expect(queries).toEqual([["store_id", "day"], ["store_id", "from", "to"], ["store_id"], ["store_id"], ["store_id", "status"]]);
  });

  it("a store id in capitals is accepted, and the answer for it is accepted too", async () => {
    const { client } = setup();
    expect(kindOf(await client.listStaff(FAKE_STORE_ID.toUpperCase()))).toBe("ok");
  });
});

// ── Answers ────────────────────────────────────────────────

describe("the typed results equal what the fake holds", () => {
  it("every call", async () => {
    const { till, client } = setup();
    const d = till.state.data;
    expect(dataOf(await client.listStores())).toEqual({ stores: d.stores });
    expect(dataOf(await client.listStaff(FAKE_STORE_ID))).toEqual({ store_id: FAKE_STORE_ID, staff: d.staff });
    for (const [day, shifts] of Object.entries(d.shifts)) expect(dataOf(await client.listShifts({ storeId: FAKE_STORE_ID, day }))).toEqual({ store_id: FAKE_STORE_ID, business_day: day, shifts });
    expect(dataOf(await client.listShifts({ storeId: FAKE_STORE_ID, day: FAKE_DAYS.empty }))).toEqual({ store_id: FAKE_STORE_ID, business_day: FAKE_DAYS.empty, shifts: [] });
    expect(dataOf(await client.dailySales({ storeId: FAKE_STORE_ID, from: "2026-11-01", to: "2026-11-27" }))).toEqual({ store_id: FAKE_STORE_ID, from: "2026-11-01", to: "2026-11-27", days: d.sales });
    expect(dataOf(await client.dailySales({ storeId: FAKE_STORE_ID, from: FAKE_DAYS.empty, to: FAKE_DAYS.empty })).days).toEqual([]);
    expect(dataOf(await client.listProducts(FAKE_STORE_ID))).toEqual({ store_id: FAKE_STORE_ID, products: d.products });
    expect(dataOf(await client.listSuppliers(FAKE_STORE_ID))).toEqual({ store_id: FAKE_STORE_ID, suppliers: d.suppliers });
    expect(dataOf(await client.listOrders(FAKE_STORE_ID))).toEqual({ store_id: FAKE_STORE_ID, orders: d.orders });
  });

  it("money stays as the till sent it: JSON numbers to the cent, refunds negative, null kept as null", async () => {
    const { client } = setup();
    const [shift] = dataOf(await client.listShifts({ storeId: FAKE_STORE_ID, day: FAKE_DAYS.closedWithNotKnown })).shifts;
    expect(typeof shift!.takings.cash.sales_total).toBe("number");
    expect(shift!.takings.cash).toEqual({ sales_total: 63.35, refunds_total: -5, net_total: 58.35 });
    expect(shift!.variance).toBe(-0.35);
    const auto = dataOf(await client.listShifts({ storeId: FAKE_STORE_ID, day: FAKE_DAYS.allChannels })).shifts.find((s) => s.status === "auto_closed")!;
    expect(auto.counted).toBeNull();
    expect(auto.expected).toBeNull();
  });

  it("a field the till adds later is handed on, not stripped", async () => {
    const { till, client } = setup();
    (till.state.data.stores[0] as unknown as Record<string, unknown>).added_later = "kept";
    expect((dataOf(await client.listStores()).stores[0] as unknown as Record<string, unknown>).added_later).toBe("kept");
  });

  it("no answer is paged in contract 1.1.0: a list is the whole list, and nothing says `truncated`", async () => {
    const { till, client } = setup();
    till.state.data.products = Array.from({ length: 1200 }, (_, i) => ({ ...till.state.data.products[0]!, sku: `YV-${20000 + i}` }));
    const r = dataOf(await client.listProducts(FAKE_STORE_ID));
    expect(r.products).toHaveLength(1200);
    expect(Object.keys(r).sort()).toEqual(["products", "store_id"]);
    const doc = parse(readFileSync(new URL("../contracts/till-api.v1.yaml", import.meta.url), "utf8")) as { paths: Record<string, { get?: { parameters?: Array<Record<string, string>> } }> };
    const names = Object.values(doc.paths).flatMap((p) => (p.get?.parameters ?? []).map((q) => q.name ?? q.$ref ?? ""));
    expect(names.filter((n) => /page|cursor|offset|limit|next/i.test(n))).toEqual([]);
  });
});

describe("the answer is checked lightly: what is needed to hand on typed data", () => {
  const withBody = (body: unknown, status = 200) => {
    const r = reply(status, body);
    return createTillClient({ baseUrl: BASE, key: FAKE_KEY, fetch: r.fetch, sleep: async () => undefined, now: () => new Date("2026-11-27T15:00:00Z") });
  };

  it("not JSON, not an object", async () => {
    for (const body of ["<html>no</html>", "", "null", "[]", "5", '"x"', "true"]) {
      const e = errorOf(await withBody(body).listStores());
      expect([body, e.kind, e.status]).toEqual([body, "bad_answer", 200]);
    }
    expect(errorOf(await withBody("<html>SENTINEL-BODY</html>").listStores()).message).toBe("GET /stores: the answer is not JSON");
  });

  it("a missing top-level key is named, with its endpoint", async () => {
    expect(errorOf(await withBody({}).listStores()).message).toBe("GET /stores: the answer has no `stores`");
    expect(errorOf(await withBody({ store_id: FAKE_STORE_ID }).listStaff(FAKE_STORE_ID)).message).toBe("GET /staff: the answer has no `staff`");
    expect(errorOf(await withBody({ store_id: FAKE_STORE_ID, shifts: [] }).listShifts({ storeId: FAKE_STORE_ID, day: "2026-11-25" })).message).toBe("GET /shifts: the answer has no `business_day`");
    expect(errorOf(await withBody({ store_id: FAKE_STORE_ID, from: "a", to: "b" }).dailySales({ storeId: FAKE_STORE_ID, from: "2026-11-01", to: "2026-11-02" })).message).toBe("GET /sales/daily: the answer has no `days`");
    expect(errorOf(await withBody({ stores: [] }).listProducts(FAKE_STORE_ID)).message).toBe("GET /products: the answer has no `store_id`");
    expect(errorOf(await withBody({ store_id: FAKE_STORE_ID }).listSuppliers(FAKE_STORE_ID)).message).toBe("GET /suppliers: the answer has no `suppliers`");
    expect(errorOf(await withBody({ store_id: FAKE_STORE_ID }).listOrders(FAKE_STORE_ID)).message).toBe("GET /orders: the answer has no `orders`");
  });

  it("an array that is not one, and never a value in the message", async () => {
    for (const bad of ["SENTINEL-VALUE", { SENTINEL: 1 }, 5, null]) {
      const e = errorOf(await withBody({ stores: bad }).listStores());
      expect(e).toEqual({ kind: "bad_answer", status: 200, message: "GET /stores: `stores` is not a list" });
      expect(JSON.stringify(e)).not.toContain("SENTINEL");
    }
  });

  it("an answer about another store is refused", async () => {
    const e = errorOf(await withBody({ store_id: FAKE_HIDDEN_STORE_ID, staff: [] }).listStaff(FAKE_STORE_ID));
    expect(e).toEqual({ kind: "bad_answer", status: 200, message: "GET /staff: the answer is not for the store asked about" });
    expect(kindOf(await withBody({ store_id: 5, staff: [] }).listStaff(FAKE_STORE_ID))).toBe("bad_answer");
  });
});

// ── GET only, and no ambient time, waiting or randomness ───

const TILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src/till");
const OPS = resolve(TILL_DIR, "../..");
const text = (file: string): string => readFileSync(join(TILL_DIR, file), "utf8");
/** Source without its comments, so a comment may talk about what the code must not do. */
const code = (file: string): string => text(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the client has no way to send anything but a GET, and takes time, waiting and the network from outside", () => {
  it("every request in the client is a GET, and no other method is named", () => {
    const src = code("client.ts");
    expect([...src.matchAll(/method:\s*([^,}]+)/g)].map((m) => m[1])).toEqual(['"GET"']);
    expect(src).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    const init = src.slice(src.indexOf("options.fetch(url, {"), src.indexOf("signal: abortRequest.signal })"));
    expect(init.length).toBeGreaterThan(20);
    expect(init).not.toMatch(/\bbody\b/);
    expect(src).toMatch(/redirect:\s*"manual"/);
    expect(src).not.toMatch(/redirect:\s*"follow"/);
  });

  it("no clock, environment, randomness or timer of its own", () => {
    const src = code("client.ts");
    for (const forbidden of [/new Date\(\)/, /Date\.now/, /process\.env/, /\bprocess\b/, /Math\.random/, /setTimeout/, /setInterval/, /performance\.now/, /\bcrypto\b/, /console\./, /globalThis\.fetch/, /(?<![.\w])fetch\(/]) {
      expect(src, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("every request goes through the injected fetch, after an isTillUrl check", () => {
    const src = code("client.ts");
    expect([...src.matchAll(/options\.fetch\(/g)]).toHaveLength(1);
    expect(src).toMatch(/isTillUrl\(url\)/);
  });

  it("the Worker's files import nothing from node:, no ajv, no yaml, no fs", () => {
    for (const file of ["address.ts", "client.ts", "days.ts", "fake.ts", "index.ts", "types.ts"]) {
      const imports = [...text(file).matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/^node:|^(ajv|ajv-formats|ajv\/.*|yaml|fs|path|url|crypto|pg)$/);
        if (spec.startsWith(".")) expect(spec, `${file} imports ${spec}`).not.toMatch(/contract$|rules$/);
      }
      expect(code(file), file).not.toMatch(/\b(require|Buffer|__dirname|process\.)\b/);
    }
  });
});

describe("the client has exactly four callers (the till link's and the sales-by-channel module and handler); the fake is for tests", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "public" || name === ".wrangler") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|mts|mjs|js)$/.test(name)) out.push(p);
    }
    return out;
  }
  // The checking tool and the Settings screen use these, and only these, from the till folder.
  const ALLOWED = new Set(["contract", "rules", "address"]);

  // The callers of the client, by name (card P5-02b changed this from "nobody"; card P5-03b added the last
  // two). The till link's own: the module that makes the reads and the handler that gives it a timer and a
  // clock; and sales by channel's: its module (one dailySales read) and its handler (the input's days).
  // Adding a caller is a decision to be made on purpose: it is a change to this list, and to ADR-0024.
  const CALLERS = ["src/modules/sales-channels.ts", "src/modules/till-link.ts", "src/rpc/handlers/sales-channels.ts", "src/rpc/handlers/till-link.ts"];

  /** Every file outside till/ that imports the client, its index, the fake, the types or the days, or names a thing only a caller uses. */
  function callersOf(files: string[]): string[] {
    const found = new Set<string>();
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(?:from|import\(|require\()\s*["']([^"']+)["']/g)) {
        const spec = m[1]!;
        if (!spec.startsWith(".")) continue;
        const target = resolve(dirname(file), spec).replace(/\.(ts|js|mjs)$/, "");
        if (target === TILL_DIR || target.startsWith(TILL_DIR + "/")) {
          if (!ALLOWED.has(relative(TILL_DIR, target))) found.add(relative(OPS, file));
        }
      }
      for (const word of ["tillClientFor", "createFakeTill", "createFakeClock"]) if (src.includes(word)) found.add(relative(OPS, file));
    }
    return [...found].sort();
  }

  it("exactly the four callers named above import the client, its index, the fake, the types or the days: no other file of ops/src (outside till/), ops/tools or ops/parity", () => {
    const files = [...walk(join(OPS, "src")), ...walk(join(OPS, "tools")), ...walk(join(OPS, "parity"))].filter((f) => !f.startsWith(TILL_DIR + "/"));
    expect(files.length).toBeGreaterThan(50);
    expect(callersOf(files)).toEqual(CALLERS);
  });

  it("the fake is never used outside the tests: neither caller names it", () => {
    for (const rel of CALLERS) {
      const src = readFileSync(join(OPS, rel), "utf8");
      expect(src, rel).not.toMatch(/createFakeTill|createFakeClock|till\/fake/);
    }
  });

  it("the search itself finds a caller when there is one (it has teeth)", () => {
    // Pretend a file imports the client: the same matcher must catch it.
    const sample = `import { tillClientFor } from "../till/index";`;
    const m = [...sample.matchAll(/(?:from|import\(|require\()\s*["']([^"']+)["']/g)].map((x) => x[1]);
    expect(m).toEqual(["../till/index"]);
    const target = resolve(join(OPS, "src/modules"), m[0]!);
    expect(relative(TILL_DIR, target)).toBe("index");
    expect(ALLOWED.has("index")).toBe(false);
    expect(sample.includes("tillClientFor")).toBe(true);
  });
});

// ── The hand-written types match the contract ──────────────

describe("what the client checks and sends matches the contract", () => {
  const doc = parse(readFileSync(new URL("../contracts/till-api.v1.yaml", import.meta.url), "utf8")) as {
    paths: Record<string, { get?: { parameters?: Array<{ $ref?: string; name?: string; required?: boolean }>; responses: Record<string, any> } }>;
    components: { parameters: Record<string, { name: string; required?: boolean }> };
  };
  const answerSchema = (path: string) => doc.paths[path]!.get!.responses["200"].content["application/json"].schema as { required: string[]; properties: Record<string, { type?: string }> };

  it("the top-level keys each endpoint must have, and which are lists", () => {
    const byPath: Record<string, keyof typeof SHAPES> = { "/stores": "stores", "/staff": "staff", "/shifts": "shifts", "/sales/daily": "daily", "/products": "products", "/suppliers": "suppliers", "/orders": "orders" };
    for (const [path, name] of Object.entries(byPath)) {
      const schema = answerSchema(path);
      expect([...SHAPES[name].required].sort(), path).toEqual([...schema.required].sort());
      const arrays = Object.entries(schema.properties).filter(([, p]) => p.type === "array").map(([k]) => k);
      expect([...SHAPES[name].arrays].sort(), path).toEqual(arrays.sort());
      expect(SHAPES[name].endpoint).toBe(`GET ${path}`);
    }
  });

  it("the parameters each call sends are the contract's: the required ones always, the others only when given", async () => {
    const paramsOf = (path: string): { required: string[]; optional: string[] } => {
      const ps = (doc.paths[path]!.get!.parameters ?? []).map((p) => (p.$ref ? { ...doc.components.parameters[p.$ref.split("/").pop()!]! } : { name: p.name!, required: p.required }));
      return { required: ps.filter((p) => p.required).map((p) => p.name).sort(), optional: ps.filter((p) => !p.required).map((p) => p.name).sort() };
    };
    const { till, client } = setup();
    await client.listStores();
    await client.listStaff(FAKE_STORE_ID);
    await client.listShifts({ storeId: FAKE_STORE_ID, day: "2026-11-25" });
    await client.dailySales({ storeId: FAKE_STORE_ID, from: "2026-11-24", to: "2026-11-25" });
    await client.listProducts(FAKE_STORE_ID);
    await client.listSuppliers(FAKE_STORE_ID);
    await client.listOrders(FAKE_STORE_ID);
    await client.listOrders(FAKE_STORE_ID, "open");
    const sent = till.requests.map((r) => ({ path: new URL(r.url).pathname.replace("/ops/v1", ""), keys: [...new URL(r.url).searchParams.keys()].sort() }));
    expect(sent.map((s) => s.path)).toEqual(["/stores", "/staff", "/shifts", "/sales/daily", "/products", "/suppliers", "/orders", "/orders"]);
    for (const s of sent.slice(0, 7)) expect(s.keys, s.path).toEqual(paramsOf(s.path).required);
    expect(sent[7]!.keys).toEqual([...paramsOf("/orders").required, ...paramsOf("/orders").optional].sort());
  });

  it("the 92-day limit and the key's header are the contract's words", () => {
    const text = readFileSync(new URL("../contracts/till-api.v1.yaml", import.meta.url), "utf8");
    expect(text).toContain("At most 92 days per request");
    expect(text).toContain("at most 91 days after `from`");
    expect(text).toContain("`Authorization: Bearer <key>`");
    expect(text).toContain("60 requests a minute per key");
    expect(text).toContain("`429` with `Retry-After`");
  });
});

describe("nothing here reached the network", () => {
  it("the global fetch was not called (and the file fails if it was)", () => {
    expect(reached).not.toHaveBeenCalled();
  });
});
