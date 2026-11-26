// transport.js gives the page a google.script.run that speaks HTTP. These
// tests evaluate the real file against a fake window and a fake fetch.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const SRC = readFileSync(new URL("../public/transport.js", import.meta.url), "utf8");

type Call = { url: string; init: any };
type Reply = { status: number; body: string } | "reject";

function boot(reply: Reply | ((url: string) => Reply), existing?: unknown) {
  const calls: Call[] = [];
  const errors: unknown[][] = [];
  const win: any = {};
  if (existing) win.google = existing;
  const fakeFetch = (url: string, init: any) => {
    calls.push({ url, init });
    const r = typeof reply === "function" ? reply(url) : reply;
    if (r === "reject") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: () => Promise.resolve(r.body),
    });
  };
  const con = { error: (...a: unknown[]) => errors.push(a), log() {}, warn() {} };
  new Function("window", "fetch", "console", SRC)(win, fakeFetch, con);
  return { win, run: win.google.script.run, calls, errors };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const json = (o: unknown, status = 200): Reply => ({ status, body: JSON.stringify(o) });

// Run one call and resolve with whichever handler fired.
function once(run: any, method: string, ...args: unknown[]) {
  return new Promise<{ kind: "ok" | "fail"; value: any; user?: unknown }>((resolve) => {
    run
      .withSuccessHandler((value: any, user: unknown) => resolve({ kind: "ok", value, user }))
      .withFailureHandler((value: any, user: unknown) => resolve({ kind: "fail", value, user }))[method](...args);
  });
}

describe("request", () => {
  it("posts JSON to /rpc/<name> with exactly the arguments, in order", async () => {
    const t = boot(json({ ok: true, result: 1 }));
    const args = ["tok", null, { a: { b: [1, 2, { c: null }] } }, [], "x"];
    await once(t.run, "rpcDoThing", ...args);
    expect(t.calls).toHaveLength(1);
    const c = t.calls[0]!;
    expect(c.url).toBe("/rpc/rpcDoThing");
    expect(c.init.method).toBe("POST");
    expect(c.init.headers["content-type"]).toBe("application/json");
    expect(c.init.body).toBe(JSON.stringify({ args }));
    expect(JSON.parse(c.init.body).args).toEqual(args);
  });

  it("sends an empty args list for a call with no arguments", async () => {
    const t = boot(json({ ok: true, result: null }));
    await once(t.run, "rpcGetActiveStaffForLogin");
    expect(t.calls[0]!.init.body).toBe('{"args":[]}');
  });
});

describe("answers", () => {
  it("success gives the handler the result", async () => {
    const t = boot(json({ ok: true, result: { rows: [1, 2] } }));
    const r = await once(t.run, "rpcX");
    expect(r).toMatchObject({ kind: "ok", value: { rows: [1, 2] } });
  });

  it("a null result reaches the handler as null", async () => {
    const t = boot(json({ ok: true, result: null }));
    const r = await once(t.run, "rpcX");
    expect(r.kind).toBe("ok");
    expect(r.value).toBeNull();
  });

  for (const msg of ["NOT_LOGGED_IN", "FORBIDDEN"]) {
    it(`{"ok":false} ${msg} becomes an Error with exactly that message`, async () => {
      const t = boot(json({ ok: false, error: { message: msg } }));
      const r = await once(t.run, "rpcX", "tok");
      expect(r.kind).toBe("fail");
      expect(r.value).toBeInstanceOf(Error);
      expect(r.value.message).toBe(msg);
    });
  }

  it("HTTP 404 with a JSON error body uses that message", async () => {
    const t = boot(json({ ok: false, error: { message: "NOT_MIGRATED" } }, 404));
    const r = await once(t.run, "rpcShopping");
    expect(r.kind).toBe("fail");
    expect(r.value.message).toBe("NOT_MIGRATED");
  });

  it("HTTP 500 with a non-JSON body gives the fixed message", async () => {
    const t = boot({ status: 500, body: "<html>oops</html>" });
    const r = await once(t.run, "rpcX");
    expect(r.kind).toBe("fail");
    expect(r.value).toBeInstanceOf(Error);
    expect(r.value.message).toBe("NETWORK_ERROR");
  });

  it("HTTP 200 with an unreadable body gives the fixed message", async () => {
    const t = boot({ status: 200, body: "not json" });
    const r = await once(t.run, "rpcX");
    expect(r.value.message).toBe("NETWORK_ERROR");
  });

  it("a rejected fetch gives the fixed message", async () => {
    const t = boot("reject");
    const r = await once(t.run, "rpcX");
    expect(r.kind).toBe("fail");
    expect(r.value.message).toBe("NETWORK_ERROR");
  });
});

describe("handlers", () => {
  it("no failure handler: nothing throws, and it is logged to console.error", async () => {
    const t = boot(json({ ok: false, error: { message: "FORBIDDEN" } }));
    const done = vi.fn();
    t.run.withSuccessHandler(done).rpcX();
    await tick();
    await tick();
    expect(done).not.toHaveBeenCalled();
    expect(t.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(t.errors)).toContain("FORBIDDEN");
  });

  it("no handlers at all: a successful call is fine", async () => {
    const t = boot(json({ ok: true, result: 1 }));
    t.run.rpcX();
    await tick();
    expect(t.calls).toHaveLength(1);
    expect(t.errors).toHaveLength(0);
  });

  it("chains started from run do not share handlers", async () => {
    const t = boot(json({ ok: true, result: 7 }));
    const a = vi.fn();
    const b = vi.fn();
    t.run.withSuccessHandler(a).rpcA();
    t.run.withSuccessHandler(b).rpcB();
    t.run.rpcC(); // no handlers: must not call a or b
    await tick();
    await tick();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(t.calls.map((c) => c.url)).toEqual(["/rpc/rpcA", "/rpc/rpcB", "/rpc/rpcC"]);
  });

  it("a half-built chain does not leak into the next one", async () => {
    const t = boot(json({ ok: true, result: 7 }));
    const leaked = vi.fn();
    t.run.withSuccessHandler(leaked); // never called
    const fresh = vi.fn();
    t.run.withSuccessHandler(fresh).rpcX();
    await tick();
    await tick();
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(leaked).not.toHaveBeenCalled();
  });

  it("handlers can be set in either order", async () => {
    const t = boot(json({ ok: false, error: { message: "FORBIDDEN" } }));
    const ok = vi.fn();
    const fail = vi.fn();
    t.run.withFailureHandler(fail).withSuccessHandler(ok).rpcX();
    await tick();
    await tick();
    expect(fail).toHaveBeenCalledTimes(1);
    expect(ok).not.toHaveBeenCalled();
  });

  it("withUserObject passes the object as the second handler argument", async () => {
    const t = boot(json({ ok: true, result: 3 }));
    const user = { id: 9 };
    const r = await new Promise<any>((resolve) => {
      t.run.withUserObject(user).withSuccessHandler((v: any, u: any) => resolve({ v, u })).rpcX();
    });
    expect(r.v).toBe(3);
    expect(r.u).toBe(user);
    const t2 = boot(json({ ok: false, error: { message: "FORBIDDEN" } }));
    const f = await new Promise<any>((resolve) => {
      t2.run.withFailureHandler((e: any, u: any) => resolve({ e, u })).withUserObject(user).rpcX();
    });
    expect(f.u).toBe(user);
  });

  it("a success handler that throws does not call the failure handler", async () => {
    const t = boot(json({ ok: true, result: 1 }));
    const fail = vi.fn();
    t.run
      .withSuccessHandler(() => {
        throw new Error("boom");
      })
      .withFailureHandler(fail)
      .rpcX();
    await tick();
    await tick();
    expect(fail).not.toHaveBeenCalled();
  });
});

describe("install", () => {
  it("leaves an existing google.script.run alone", () => {
    const existing = { script: { run: { marker: true } } };
    const t = boot(json({ ok: true, result: 1 }), existing);
    expect(t.win.google).toBe(existing);
    expect(t.win.google.script.run.marker).toBe(true);
  });

  it("defines google.script.run when absent", () => {
    const t = boot(json({ ok: true, result: 1 }));
    expect(typeof t.win.google.script.run.withSuccessHandler).toBe("function");
  });

  it("uses no var", () => {
    expect(/\bvar\s/.test(SRC)).toBe(false);
  });
});
