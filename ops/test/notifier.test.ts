// The Notifier module (WhatsApp sends, the setup check, and the internal event log),
// against a fake `fetch`. Nothing here reaches Meta or any real host.
//
// Part 1 is tests/suites/notifier.js ported assertion for assertion (the old suite's
// section titles are kept so the two can be read side by side). Part 2 is what the
// move adds: the timeout, the token and phone numbers never leaving the module, the
// request itself, the shopping-list message being left out, and notify.
//
// Not ported from the old suite: nothing. Two assertions are STRICTER than the old
// ones, on purpose, and say so where they are: "an unset key falls back to plain text"
// (the old one also passed when nothing was posted at all) and "the sentence is
// whole" (checked against the whole sentence, not one cut point).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, type Db } from "../src/db/client";
import { Config } from "../src/lib/config";
import { diagnose, notify, sendOp, sendTemplate, sendWhatsApp, summarize, type NotifierDeps, type SendResult } from "../src/modules/notifier";
import { createTestDb, type TestDb } from "./helpers/db";

const CFG: Record<string, string> = {
  notifier_enabled: "true",
  whatsapp_api_url: "https://graph.facebook.com/v25.0/1/messages",
  whatsapp_target_number: "14165550100, 19055550101",
  whatsapp_template_lang: "en",
  whatsapp_template_shift_close_cstore: "shift_close_cstore",
};
const TOKEN = "TOKEN-for-tests-only";

interface Posted {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  signal: AbortSignal | null | undefined;
}

const noDb: Db = {
  query: () => Promise.reject(new Error("this test must not touch the database")),
  one: () => Promise.reject(new Error("this test must not touch the database")),
  maybeOne: () => Promise.reject(new Error("this test must not touch the database")),
};

interface Rig {
  deps: NotifierDeps;
  posted: Posted[];
  /** What Meta answers next (every request, until changed). */
  respond: { code: number; body: string };
  /** When set, fetch rejects with this instead of answering. */
  fail: { error: unknown } | null;
}

function rig(cfg: Record<string, string> = {}, env: Record<string, unknown> = { WHATSAPP_API_TOKEN: TOKEN }, db: Db = noDb): Rig {
  const r: Rig = { posted: [], respond: { code: 200, body: "{}" }, fail: null, deps: undefined as never };
  const rows = Object.entries({ ...CFG, ...cfg }).map(([key, value]) => ({ key, value }));
  const fakeFetch: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    r.posted.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase(), headers, body: typeof init?.body === "string" ? init.body : null, signal: init?.signal });
    if (r.fail) throw r.fail.error;
    return new Response(r.respond.body, { status: r.respond.code });
  };
  r.deps = { config: Config.fromRows(rows), env, fetch: fakeFetch, db, now: new Date("2026-11-26T15:00:00Z") };
  return r;
}
const json = (p: Posted): { to: string; type: string; text?: { body: string }; template: { name: string; language: { code: string }; components: { type: string; parameters: { type: string; text: string }[] }[] } } =>
  JSON.parse(p.body ?? "null");

const reasonOf = (r: SendResult): string | undefined => ("reason" in r ? r.reason : undefined);
const ELEVEN = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"];

// ═══ Part 1: tests/suites/notifier.js, assertion for assertion ═══

describe("The wire payload is what the template expects", () => {
  it("matches the approved template", async () => {
    const r = rig();
    await sendTemplate(r.deps, "shift_close_cstore", ELEVEN);
    const body = json(r.posted[0]!);
    expect(body.template.name).toBe("shift_close_cstore"); // template name
    expect(body.template.language.code).toBe("en"); // language from config
    expect(body.template.components.length).toBe(1); // one component
    expect(body.template.components[0]!.type).toBe("body"); // of type body
    expect(body.template.components[0]!.parameters.length).toBe(11); // carrying all eleven
    expect(body.template.components[0]!.parameters[0]!.type).toBe("text"); // each a text param
    expect(body.template.components.some((c) => c.type === "button")).toBe(false); // no button component is invented
    expect(r.posted.length).toBe(2); // one POST per recipient
  });
});

describe("Parameters are flattened so Meta accepts them", () => {
  it("collapses, strips and fills", async () => {
    const r = rig();
    await sendTemplate(r.deps, "x", ["line one\nline two", "  wide   gaps  ", "*bold*", ""]);
    const ps = json(r.posted[0]!).template.components[0]!.parameters.map((p) => p.text);
    expect(ps[0]).not.toContain("\n"); // newlines collapsed
    expect(/ {4}/.test(ps[1]!)).toBe(false); // no run of four spaces
    expect(ps[2]).not.toContain("*"); // markdown stripped
    expect(ps[3]).toBe("—"); // an empty param becomes a dash, never empty
  });
});

describe("A rejected send never throws, and reports the reason", () => {
  const META_400 = JSON.stringify({
    error: {
      message: "(#132000) Number of parameters does not match the expected number of params",
      code: 132000,
      type: "OAuthException",
      error_data: { messaging_product: "whatsapp", details: "body: number of localizable_params (11) does not match the expected number of params (13)" },
    },
  });
  it("reports not sent, with Meta's whole sentence", async () => {
    const r = rig();
    r.respond = { code: 400, body: META_400 };
    const out = await sendTemplate(r.deps, "shift_close_cstore", ELEVEN); // does not throw
    expect(out.sent).toBe(false); // and reports not sent
    const row = "results" in out ? out.results[0]! : undefined;
    expect(row?.reason).toBe("http_400"); // with the http code
    expect(row?.detail).toMatch(/#132000/); // the error code survives
    expect(row?.detail).toMatch(/\(11\)/); // the count we SENT survives
    expect(row?.detail).toMatch(/\(13\)/); // the count the template EXPECTS survives
    // The sentence is whole, not cut mid-word (stricter than the old "!/\bnu$/": the whole text is checked).
    expect(row?.detail).toBe(
      "(#132000) Number of parameters does not match the expected number of params — body: number of localizable_params (11) does not match the expected number of params (13)",
    );
  });
});

describe("Other Meta shapes degrade sensibly", () => {
  it("message-only, template-not-found, non-JSON and empty bodies", async () => {
    const r = rig();
    const first = async (): Promise<{ sent: boolean; detail: string | undefined }> => {
      const out = await sendTemplate(r.deps, "x", ["a"]);
      return { sent: out.sent, detail: "results" in out ? out.results[0]?.detail : undefined };
    };
    r.respond = { code: 401, body: JSON.stringify({ error: { message: "Invalid OAuth access token", code: 190 } }) };
    expect((await first()).detail).toMatch(/Invalid OAuth/);
    r.respond = {
      code: 404,
      body: JSON.stringify({ error: { message: "(#132001) Template name does not exist", error_data: { details: "template name (shift_close_cstore) does not exist in en" } } }),
    };
    expect((await first()).detail).toMatch(/does not exist in en/);
    r.respond = { code: 502, body: "<html>502 Bad Gateway</html>" };
    expect((await first()).detail).toMatch(/502 Bad Gateway/);
    r.respond = { code: 500, body: "" };
    expect((await first()).sent).toBe(false); // an empty body does not throw
  });
});

describe("The detail is bounded, so a toast stays usable", () => {
  it("caps a long message and a long raw body", async () => {
    const r = rig();
    r.respond = { code: 400, body: JSON.stringify({ error: { message: "x".repeat(900) } }) };
    const a = await sendTemplate(r.deps, "x", ["a"]);
    expect(("results" in a ? a.results[0]!.detail : "")!.length).toBeLessThanOrEqual(400);
    r.respond = { code: 400, body: "y".repeat(900) };
    const b = await sendTemplate(r.deps, "x", ["a"]);
    expect(("results" in b ? b.results[0]!.detail : "")!.length).toBeLessThanOrEqual(400);
  });
});

describe("Guards before any request is made", () => {
  it("disabled, no token, no recipients, no template name", async () => {
    let r = rig({ notifier_enabled: "false" });
    expect(reasonOf(await sendTemplate(r.deps, "x", ["a"]))).toBe("disabled"); // disabled sends nothing
    expect(r.posted.length).toBe(0); // and posts nothing
    r = rig({}, {});
    expect(reasonOf(await sendTemplate(r.deps, "x", ["a"]))).toBe("not_configured"); // no token is not_configured
    r = rig({ whatsapp_target_number: "" });
    expect(reasonOf(await sendTemplate(r.deps, "x", ["a"]))).toBe("not_configured"); // no recipients is not_configured
    r = rig();
    expect(reasonOf(await sendTemplate(r.deps, "", ["a"]))).toBe("no_template"); // no template name is refused
  });
});

describe("sendOp picks the template named in config", () => {
  it("resolves whatsapp_template_<opKey>", async () => {
    const r = rig();
    await sendOp(r.deps, "shift_close_cstore", ELEVEN, "plain text");
    expect(json(r.posted[0]!).template.name).toBe("shift_close_cstore"); // resolved from whatsapp_template_<opKey>
  });
  it("an unset key falls back to plain text, not a template", async () => {
    const r = rig();
    await sendOp(r.deps, "shift_close", ELEVEN, "plain text");
    // Stricter than the old "posted nothing OR not a template": it must post, and post text.
    expect(r.posted.length).toBe(2);
    expect(json(r.posted[0]!).type).toBe("text");
    expect(json(r.posted[0]!).text?.body).toBe("plain text");
  });
});

// ── Diagnose ──
const check = (d: { checks: { name: string; ok: boolean; detail: string; fix: string }[] }, name: string) => d.checks.find((c) => c.name === name) ?? { name, ok: false, detail: "", fix: "" };

describe("Diagnose: a healthy setup asks Meta, sends nothing", () => {
  it("one GET to the phone number with the bearer token", async () => {
    const r = rig({ whatsapp_template_shift_open: "shift_open" });
    r.respond = { code: 200, body: JSON.stringify({ verified_name: "Fictional Mart", display_phone_number: "+1 416-555-0199", quality_rating: "GREEN" }) };
    const d = await diagnose(r.deps);
    expect(r.posted.length).toBe(1); // one request
    expect(r.posted[0]!.method).toBe("GET"); // a GET, not a send
    expect(r.posted[0]!.url).toMatch(/\/1\?fields=/); // to the phone number, not /messages
    expect(r.posted[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`); // with the token as a bearer header
    expect(d.ok).toBe(true); // all good
    expect(check(d, "meta").detail).toMatch(/Fictional Mart/); // names the WhatsApp number it would send from
    expect(check(d, "recipients").detail).toMatch(/2/); // counts the recipients
    expect(JSON.stringify(d)).not.toContain(TOKEN); // the token never appears in the report
  });
});

describe("Diagnose: an expired token is named, in Meta's words", () => {
  it("fails the Meta check with Meta's sentence and a fix", async () => {
    const r = rig();
    r.respond = { code: 401, body: JSON.stringify({ error: { message: "Error validating access token: Session has expired on Sunday, 19-Oct-26.", code: 190 } }) };
    const d = await diagnose(r.deps);
    expect(d.ok).toBe(false);
    expect(check(d, "meta").ok).toBe(false); // the Meta check fails
    expect(check(d, "meta").detail).toMatch(/Session has expired/); // with Meta's own sentence
    expect(check(d, "meta").fix).toMatch(/token/i); // and what to do about it
  });
});

describe("Diagnose: a switched-off notifier is the first thing reported", () => {
  it("flags the switch and names the key", async () => {
    const d = await diagnose(rig({ notifier_enabled: "false" }).deps);
    expect(d.ok).toBe(false);
    expect(check(d, "enabled").ok).toBe(false); // the switch is flagged
    expect(check(d, "enabled").fix).toMatch(/notifier_enabled/); // naming the config key to change
  });
});

describe("Diagnose: missing settings are named, and Meta is not asked", () => {
  it("no token and no recipients", async () => {
    const r = rig({ whatsapp_target_number: "" }, {});
    const d = await diagnose(r.deps);
    expect(r.posted.length).toBe(0); // no request made without a token
    expect(check(d, "token").ok).toBe(false); // token flagged
    expect(check(d, "recipients").ok).toBe(false); // recipients flagged
    expect(check(d, "url").ok).toBe(true); // the URL itself is fine
  });
});

describe("Diagnose: a URL that isn't a /messages endpoint is caught", () => {
  it("flags the URL", async () => {
    const d = await diagnose(rig({ whatsapp_api_url: "https://graph.facebook.com/v21.0/" }).deps);
    expect(check(d, "url").ok).toBe(false);
  });
});

describe("Diagnose: lists which templates are set", () => {
  it("names the set and the unset", async () => {
    const d = await diagnose(rig({ whatsapp_template_shift_open: "" }).deps);
    expect(check(d, "templates").detail).toMatch(/shift_close_cstore/); // a configured close template is listed
    expect(check(d, "templates").detail).toMatch(/shift_open/); // an unset one is called out
  });
});

// ═══ Part 2: what the move adds ═══

describe("the request to Meta is the old request", () => {
  it("a template send: POST, the configured URL, bearer token, JSON content type, the same JSON body", async () => {
    const r = rig({ whatsapp_template_shift_open: "shift_open" });
    await sendOp(r.deps, "shift_open", ["Maya", "Cstore", "Thu 26 Nov, 10:00"], "plain");
    expect(r.posted.length).toBe(2);
    const p = r.posted[0]!;
    expect(p.method).toBe("POST");
    expect(p.url).toBe("https://graph.facebook.com/v25.0/1/messages");
    expect(p.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(p.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(p.body as string)).toEqual({
      messaging_product: "whatsapp",
      to: "14165550100",
      type: "template",
      template: { name: "shift_open", language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: "Maya" }, { type: "text", text: "Cstore" }, { type: "text", text: "Thu 26 Nov, 10:00" }] }] },
    });
    expect(JSON.parse(r.posted[1]!.body as string).to).toBe("19055550101");
  });

  it("a plain-text send keeps newlines; a generic template flattens the same text into {{1}}", async () => {
    const plain = rig();
    await sendWhatsApp(plain.deps, "line one\nline two");
    expect(JSON.parse(plain.posted[0]!.body as string)).toMatchObject({ type: "text", text: { body: "line one\nline two" } });
    const generic = rig({ whatsapp_template_name: "generic", whatsapp_template_lang: "fr" });
    await sendWhatsApp(generic.deps, "line one\nline *two*");
    expect(JSON.parse(generic.posted[0]!.body as string).template).toEqual({
      name: "generic",
      language: { code: "fr" },
      components: [{ type: "body", parameters: [{ type: "text", text: "line one line two" }] }],
    });
  });

  it("the parameter count is whatever the caller built: no count is added, dropped or padded", async () => {
    for (const n of [0, 3, 10, 11, 12, 13, 14]) {
      const r = rig({ whatsapp_template_shift_close: "shift_close_v2" });
      await sendOp(r.deps, "shift_close", Array.from({ length: n }, (_, i) => `p${i}`), "plain");
      expect(json(r.posted[0]!).template.components.flatMap((c) => c.parameters).length).toBe(n);
    }
  });

  it("the diagnose check is a GET with only the bearer header and no body", async () => {
    const r = rig();
    await diagnose(r.deps);
    const p = r.posted[0]!;
    expect(p.url).toBe("https://graph.facebook.com/v25.0/1?fields=verified_name,display_phone_number,quality_rating");
    expect(p.method).toBe("GET");
    expect(p.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(p.headers["content-type"]).toBeUndefined();
    expect(p.body).toBeNull();
  });

  it("every outbound call carries an abort signal", async () => {
    const r = rig();
    await sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain");
    await diagnose(r.deps);
    expect(r.posted.length).toBe(3);
    for (const p of r.posted) expect(p.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("a failure is reported, never swallowed (hard rule 7)", () => {
  it("one recipient failing does not hide the other: sent is true, the failure is in results", async () => {
    const r = rig();
    let n = 0;
    const base = r.deps.fetch;
    r.deps = { ...r.deps, fetch: async (i, o) => (++n === 1 ? new Response(JSON.stringify({ error: { message: "(#133010) Account not registered" } }), { status: 400 }) : base(i, o)) };
    const out = await sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain");
    expect(out).toEqual({
      sent: true,
      sentCount: 1,
      total: 2,
      results: [
        { to: "14165550100", sent: false, reason: "http_400", detail: "(#133010) Account not registered" },
        { to: "19055550101", sent: true },
      ],
    });
  });

  it("every recipient failing is sent:false with each reason", async () => {
    const r = rig();
    r.respond = { code: 400, body: JSON.stringify({ error: { message: "(#133010) Account not registered", code: 133010 } }) };
    const out = await sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain");
    expect(out).toMatchObject({ sent: false, sentCount: 0, total: 2 });
    expect("results" in out && out.results.map((x) => x.reason)).toEqual(["http_400", "http_400"]);
  });

  it("a network error is an 'exception' result carrying its message, not a throw", async () => {
    const r = rig();
    r.fail = { error: new Error("Address unavailable") };
    const out = await sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain");
    expect(out).toEqual({
      sent: false,
      sentCount: 0,
      total: 2,
      results: [
        { to: "14165550100", sent: false, reason: "exception", detail: "Address unavailable" },
        { to: "19055550101", sent: false, reason: "exception", detail: "Address unavailable" },
      ],
    });
  });

  it("the setup check says so when Meta cannot be reached", async () => {
    const r = rig();
    r.fail = { error: new Error("Address unavailable") };
    const d = await diagnose(r.deps);
    expect(d.ok).toBe(false);
    expect(check(d, "meta")).toMatchObject({ ok: false, detail: "request failed: Address unavailable" });
  });

  it("a 2xx is sent even when Meta's body is unreadable (nothing reads it)", async () => {
    const r = rig();
    r.respond = { code: 200, body: "not json at all" };
    expect(await sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain")).toMatchObject({ sent: true, sentCount: 2 });
  });
});

describe("a timeout is a failed send, reported like any other", () => {
  afterEach(() => vi.useRealTimers());

  /** A fetch that never answers; it rejects only if its signal is aborted (as the real one does). */
  const hanging = (r: Rig, seen: { signals: AbortSignal[] }): void => {
    r.deps = {
      ...r.deps,
      fetch: (_input, init) =>
        new Promise<Response>((_res, rej) => {
          const s = init?.signal;
          if (s) {
            seen.signals.push(s);
            s.addEventListener("abort", () => rej(new DOMException("The operation was aborted", "AbortError")));
          }
        }),
    };
  };

  it("sendOp gives up on each recipient after 10 seconds", async () => {
    vi.useFakeTimers();
    const r = rig();
    const seen = { signals: [] as AbortSignal[] };
    hanging(r, seen);
    const pending = sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(seen.signals.length).toBe(1);
    expect(seen.signals[0]!.aborted).toBe(false); // not before 10 s
    await vi.advanceTimersByTimeAsync(1);
    expect(seen.signals[0]!.aborted).toBe(true); // at 10 s
    await vi.advanceTimersByTimeAsync(10_000); // the second recipient has its own 10 s
    const out = await pending;
    expect(out).toEqual({
      sent: false,
      sentCount: 0,
      total: 2,
      results: [
        { to: "14165550100", sent: false, reason: "exception", detail: "timed out after 10 seconds" },
        { to: "19055550101", sent: false, reason: "exception", detail: "timed out after 10 seconds" },
      ],
    });
  });

  it("the setup check reports it as a failed Meta check", async () => {
    vi.useFakeTimers();
    const r = rig();
    hanging(r, { signals: [] });
    const pending = diagnose(r.deps);
    await vi.advanceTimersByTimeAsync(10_000);
    const d = await pending;
    expect(d.ok).toBe(false);
    expect(check(d, "meta")).toMatchObject({ ok: false, detail: "request failed: timed out after 10 seconds" });
  });

  it("a fetch that ignores its signal still cannot hang the send", async () => {
    vi.useFakeTimers();
    const r = rig();
    r.deps = { ...r.deps, fetch: () => new Promise<Response>(() => undefined) };
    const pending = sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toMatchObject({ sent: false, total: 2 });
  });

  it("the timer is cleared after a normal answer (nothing left running)", async () => {
    vi.useFakeTimers();
    const r = rig();
    await sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the token never leaves the module", () => {
  const all = (...xs: unknown[]): string => JSON.stringify(xs);

  it("is not in a send result, a diagnose report, or any detail, even when Meta or the network echoes it", async () => {
    const echoes = [
      { code: 400, body: JSON.stringify({ error: { message: `Invalid token ${TOKEN}`, error_data: { details: `Bearer ${TOKEN}` } } }) },
      { code: 502, body: `gateway said: ${TOKEN}` },
    ];
    for (const e of echoes) {
      const r = rig();
      r.respond = e;
      const out = await sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain");
      const d = await diagnose(r.deps);
      expect(all(out, d)).not.toContain(TOKEN);
    }
    const r = rig();
    r.fail = { error: new Error(`fetch failed for Bearer ${TOKEN}`) };
    expect(all(await sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain"), await diagnose(r.deps))).not.toContain(TOKEN);
  });

  it("is not in anything thrown or logged", async () => {
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.join(" "))));
    try {
      const r = rig();
      r.fail = { error: new Error(`boom ${TOKEN}`) };
      await sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain");
      await diagnose(r.deps);
      const refused = await sendOp(r.deps, "shopping_list" as never, [], "x").catch((e: unknown) => String(e));
      expect(String(refused)).not.toContain(TOKEN);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    expect(logged.join("\n")).not.toContain(TOKEN);
  });

  it("is read only from the Worker binding: a token in the settings table is ignored", async () => {
    const r = rig({ whatsapp_api_token: "table-token-must-be-ignored" }, {});
    expect(await sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain")).toEqual({ sent: false, reason: "not_configured" });
    expect(r.posted.length).toBe(0);
  });
});

describe("a missing token gives the outcome a blank one gave", () => {
  it.each([
    ["no binding", {}],
    ["an empty binding", { WHATSAPP_API_TOKEN: "" }],
    ["a binding that is not text", { WHATSAPP_API_TOKEN: 42 }],
  ])("%s: sendOp is not_configured, nothing is sent; diagnose flags the token and does not ask Meta", async (_name, env) => {
    const r = rig({}, env);
    expect(await sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain")).toEqual({ sent: false, reason: "not_configured" });
    const d = await diagnose(r.deps);
    expect(check(d, "token")).toMatchObject({ ok: false, detail: "whatsapp_api_token is blank" });
    expect(r.posted.length).toBe(0);
    expect(d.checks.map((c) => c.name)).toEqual(["enabled", "url", "token", "recipients", "templates"]);
  });
});

describe("phone numbers", () => {
  it("the setup report counts recipients and never prints a number (the old report did not either)", async () => {
    const r = rig();
    r.respond = { code: 200, body: JSON.stringify({ verified_name: "Fictional Mart", display_phone_number: "+1 416-555-0199" }) };
    const text = JSON.stringify(await diagnose(r.deps));
    for (const n of ["14165550100", "19055550101"]) expect(text).not.toContain(n);
  });

  it("send results name the recipient in full, exactly as the old results did (the old code masks nothing)", async () => {
    const r = rig();
    const out = await sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain");
    expect("results" in out && out.results.map((x) => x.to)).toEqual(["14165550100", "19055550101"]);
  });

  it("recipients split on commas, semicolons and spaces, and blanks are dropped", async () => {
    const r = rig({ whatsapp_target_number: " 14165550100;19055550101 , ,14165550102 " });
    const out = await sendOp(r.deps, "shift_open", ["a", "b", "c"], "plain");
    expect("results" in out && out.results.map((x) => x.to)).toEqual(["14165550100", "19055550101", "14165550102"]);
  });
});

describe("the shopping-list message was left out", () => {
  it("sendOp refuses the shopping_list key, before any request", async () => {
    const r = rig();
    await expect(sendOp(r.deps, "shopping_list" as never, ["a", "b", "c"], "plain")).rejects.toThrow(/shopping_list/);
    expect(r.posted.length).toBe(0);
  });
  it("the setup check does not list it", async () => {
    const t = check(await diagnose(rig().deps), "templates").detail;
    expect(t).not.toMatch(/shopping/);
    expect(t).toBe(
      "set: shift_close_cstore=shift_close_cstore · not set: shift_open, shift_close, shift_close_vape (those send plain text, which Meta only delivers inside a 24h chat window)",
    );
  });
});

describe("hostile text in a parameter arrives as data", () => {
  const HOSTILE = `He said "hi" <script>alert(1)</script> \\ \n\ttab 😀 *bold* _it_ {{1}} ' &amp;`;
  it("is JSON-escaped in the body and flattened as the old code flattened it", async () => {
    const r = rig({ whatsapp_template_shift_open: "shift_open" });
    await sendOp(r.deps, "shift_open", [HOSTILE, "b", "c"], "plain");
    const text = json(r.posted[0]!).template.components[0]!.parameters[0]!.text;
    expect(text).toBe(`He said "hi" <script>alert(1)</script> \\ tab 😀 bold it {{1}} ' &amp;`);
    expect(JSON.parse(r.posted[0]!.body as string)).toBeTruthy(); // still valid JSON
  });
  it("plain text is sent unflattened", async () => {
    const r = rig();
    await sendOp(r.deps, "shift_close", [], HOSTILE);
    expect(json(r.posted[0]!).text?.body).toBe(HOSTILE);
  });
});

// ── notify: the internal event log ──
describe("notify", () => {
  let testDb: TestDb;
  let db: Db & { close(): Promise<void> };
  beforeAll(async () => {
    testDb = await createTestDb();
    db = await connect(testDb.appUrl);
  });
  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });
  const rows = (): Promise<{ actor_id: string | null; action: string; target_type: string | null; target_id: string | null; details: string | null }[]> =>
    db.query("select actor_id, action, target_type, target_id, details from ops.audit_log order by \"timestamp\", log_id");

  it("always logs, sends nothing, and says why it dispatched nothing", async () => {
    const off = rig({ notifier_enabled: "false" }, undefined, db);
    expect(await notify(off.deps, "shift.opened", { staffName: "Maya", company: "cstore", openingFloat: 250, actorId: "S_001", targetType: "session", targetId: "TS_1" })).toEqual({ dispatched: false, reason: "disabled" });
    const on = rig({ notifier_enabled: "TRUE" }, undefined, db);
    on.deps = { ...on.deps, now: new Date("2026-11-26T15:00:01Z") }; // a later instant, so the rows sort the same way every time
    expect(await notify(on.deps, "payment.recorded", { staffId: "S_003", amount: 12.5 })).toEqual({ dispatched: false, reason: "no_channel_configured" });
    expect(off.posted.length + on.posted.length).toBe(0); // notify sends nothing, even with the notifier on
    expect(await rows()).toEqual([
      { actor_id: "S_001", action: "notify.shift.opened", target_type: "session", target_id: "TS_1", details: "🟢 Maya opened cstore shift (float $250)" },
      { actor_id: "SYSTEM", action: "notify.payment.recorded", target_type: "notification", target_id: null, details: "💰 Paid $12.50 to S_003" },
    ]);
  });

  it("summarises each event the old callers use, word for word", () => {
    expect(summarize("shift.opened", { staffId: "S_001", company: "vape" })).toBe("🟢 S_001 opened vape shift");
    expect(summarize("shift.closed", { staffName: "Maya", company: "cstore", variance: 0 })).toBe("🔴 Maya closed cstore shift, $0 variance");
    expect(summarize("shift.closed", { staffName: "Maya", company: "cstore", variance: 2.5 })).toBe("🔴 Maya closed cstore shift, +$2.50 over");
    expect(summarize("shift.closed", { staffName: "Maya", company: "cstore", variance: -3 })).toBe("🔴 Maya closed cstore shift, -$3.00 short");
    expect(summarize("shift.closed", { staffName: "Maya", company: "cstore", variance: 0, lottoReserveCounted: 500, lottoTopupFromTill: 300, cashInHand: 302 })).toBe(
      "🔴 Maya closed cstore shift, $0 variance, lotto reserve $500.00 (+$300.00 from till), $302.00 in hand",
    );
    expect(summarize("shift.closed", { staffName: "Sam", company: "vape", variance: 0, lottoReserveCounted: null, cashInHand: 0 })).toBe("🔴 Sam closed vape shift, $0 variance");
    expect(summarize("commission.computed", { bonusesCreated: 2, totalAmount: 40 })).toBe("🎯 Commission run: 2 bonus(es), $40.00 total");
    expect(summarize("commission.computed", {})).toBe("🎯 Commission run: 0 bonus(es), $0.00 total");
    expect(summarize("something.else", {})).toBe("Event: something.else");
  });
});
