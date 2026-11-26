// The Worker as one thing: every request goes through worker.fetch(request, env)
// with a real database behind OPS_DB_APP_URL and a fake ASSETS that serves from
// memory. The sign-in is driven twice: with plain requests, and with the real
// client script (public/transport.js) whose fetch is worker.fetch.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setPin } from "../src/auth/pin";
import { connect, type Db } from "../src/db/client";
import worker, { buildCounts } from "../src/index";
import { main as setPinMain } from "../tools/set-pin";
import { createTestDb, type TestDb } from "./helpers/db";

const PEPPER = "test-pepper-not-a-secret";
const TRANSPORT = readFileSync(new URL("../public/transport.js", import.meta.url), "utf8");
const PAGE = "<!doctype html><title>StoreOps</title><p>hello</p>";

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
};

let testDb: TestDb;
let db: Db & { close(): Promise<void> };

/** Serves "/" and "/transport.js" from memory; anything else is the platform's own 404. */
const assets = {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/") return new Response(request.method === "HEAD" ? null : PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (pathname === "/transport.js") return new Response(TRANSPORT, { headers: { "content-type": "text/javascript; charset=utf-8" } });
    return new Response("Not found", { status: 404 });
  },
};

const envFor = (): Record<string, unknown> => ({ ASSETS: assets, OPS_DB_APP_URL: testDb.appUrl, PIN_PEPPER: PEPPER });
const get = (path: string, env: Record<string, unknown> = envFor(), method = "GET") => worker.fetch(new Request(`https://ops.test${path}`, { method }), env);
const rpc = (name: string, args: unknown[], env: Record<string, unknown> = envFor()) =>
  worker.fetch(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }), env);

const sessionCount = async (): Promise<number> => (await db.one<{ n: number }>("select count(*)::int as n from ops.sessions where staff_id = 'S1'")).n;

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  await db.query("insert into ops.staff (staff_id, name, active, role, companies_authorized) values ('S1', 'Asha Example', true, 'manager', 'cstore,vape')");
  await setPin(db, "S1", "4821", PEPPER);
});
afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

describe("/health", () => {
  it("database up: 200, ok, db ok", async () => {
    const res = await get("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true, service: "storeops-ops", db: "ok" });
  });

  it("database down (closed port): 503, db down, nothing about the failure or the connection string", async () => {
    const url = new URL(testDb.appUrl);
    url.port = "1"; // nothing listens here
    const res = await get("/health", { ASSETS: assets, OPS_DB_APP_URL: url.toString() });
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: false, service: "storeops-ops", db: "down" });
    for (const secret of [url.toString(), "local-only-app", "ops_app", "127.0.0.1", "ECONNREFUSED", "at "]) expect(text).not.toContain(secret);
  });

  it("neither HYPERDRIVE nor OPS_DB_APP_URL: 503 db down", async () => {
    const res = await get("/health", { ASSETS: assets });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, service: "storeops-ops", db: "down" });
  });

  it("HEAD /health works", async () => {
    expect((await get("/health", envFor(), "HEAD")).status).toBe(200);
  });
});

describe("sign-in over HTTP", () => {
  it("rpcLogin gives a token; rpcLogout ends it; the session row is gone; both audit rows exist", async () => {
    const start = await sessionCount();
    const login = await rpc("rpcLogin", ["Asha Example", "4821"]);
    expect(login.status).toBe(200);
    const body = (await login.json()) as { ok: boolean; result: { success: boolean; token: string; staffId: string } };
    expect(body.ok).toBe(true);
    expect(body.result).toMatchObject({ success: true, staffId: "S1" });
    const token = body.result.token;
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(await sessionCount()).toBe(start + 1);

    const out = await rpc("rpcLogout", [token]);
    expect(await out.json()).toEqual({ ok: true, result: { success: true } });
    expect(await sessionCount()).toBe(start);

    const names = (await db.query<{ action: string }>("select action from ops.audit_log where actor_id = 'S1'")).map((a) => a.action);
    expect(names).toContain("login.success");
    expect(names).toContain("login.logout");
  });

  it("the real client script signs in and out through the Worker", async () => {
    const win: { google?: { script: { run: any } } } = {};
    const clientFetch = (url: string, init: RequestInit) => worker.fetch(new Request(`https://ops.test${url}`, init), envFor());
    new Function("window", "fetch", "console", TRANSPORT)(win, clientFetch, console);
    const run = win.google!.script.run;
    const once = (method: string, ...args: unknown[]) =>
      new Promise<{ kind: "ok" | "fail"; value: any }>((resolve) => {
        run.withSuccessHandler((value: any) => resolve({ kind: "ok", value })).withFailureHandler((value: any) => resolve({ kind: "fail", value }))[method](...args);
      });

    const good = await once("rpcLogin", "Asha Example", "4821");
    expect(good.kind).toBe("ok");
    expect(good.value).toMatchObject({ success: true, staffId: "S1", name: "Asha Example", role: "manager" });

    const bad = await once("rpcLogin", "Asha Example", "0000");
    expect(bad).toEqual({ kind: "ok", value: { success: false, error: "Invalid name or code" } });

    expect(await once("rpcLogout", good.value.token)).toEqual({ kind: "ok", value: { success: true } });
  });
});

describe("static assets", () => {
  it("/ is the page: no-store, security headers", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PAGE);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("text/html");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), name).toBe(value);
  });

  it("/transport.js is the script, not no-store", async () => {
    const res = await get("/transport.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(TRANSPORT);
    expect(res.headers.get("cache-control")).not.toBe("no-store");
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), name).toBe(value);
  });

  it("HEAD / works; POST / is 405", async () => {
    const head = await get("/", envFor(), "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect((await get("/", envFor(), "POST")).status).toBe(405);
  });

  it("an unknown path is whatever ASSETS says", async () => {
    const res = await get("/nope.txt");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("no ASSETS binding: a plain 404, no crash", async () => {
    const res = await get("/", { OPS_DB_APP_URL: testDb.appUrl });
    expect(res.status).toBe(404);
  });

  it("an asset request opens no database connection", async () => {
    let touched = 0;
    const env = {
      ASSETS: assets,
      PIN_PEPPER: PEPPER,
      get HYPERDRIVE() {
        touched++;
        return undefined;
      },
      get OPS_DB_APP_URL() {
        touched++;
        return testDb.appUrl;
      },
    };
    await get("/", env);
    await get("/transport.js", env);
    await get("/nope", env);
    expect(touched).toBe(0);
    // the same probe sees a database request, so the probe works
    await rpc("rpcLogin", ["Asha Example", "0000"], env);
    expect(touched).toBeGreaterThan(0);
  });
});

describe("headers on every answer", () => {
  it("health, rpc success, rpc errors, 404, 405 and assets all carry the four security headers", async () => {
    const login = await rpc("rpcLogin", ["Asha Example", "4821"]);
    const token = ((await login.clone().json()) as { result: { token: string } }).result.token;
    const answers: [string, Response][] = [
      ["health", await get("/health")],
      ["health down", await get("/health", { ASSETS: assets })],
      ["rpc success", login],
      ["rpc ordinary error", await rpc("rpcGetMe", ["not-a-token"])],
      ["rpc 404", await rpc("rpcNoSuchThing", [])],
      ["rpc 405", await get("/rpc/rpcLogin")],
      ["rpc 400", await worker.fetch(new Request("https://ops.test/rpc/rpcLogin", { method: "POST", body: "{" }), envFor())],
      ["rpc 500", await rpc("rpcLogin", ["a", "b"], { ASSETS: assets })],
      ["asset page", await get("/")],
      ["asset script", await get("/transport.js")],
      ["asset 404", await get("/nope")],
      ["405", await get("/", envFor(), "DELETE")],
      ["no assets", await get("/x", {})],
    ];
    for (const [label, res] of answers) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(res.headers.get(name), `${label}: ${name}`).toBe(value);
    }
    await rpc("rpcLogout", [token]);
  });
});

describe("one router per isolate", () => {
  it("further /rpc calls do not parse the contract or build a router again", async () => {
    const env = envFor();
    await rpc("rpcLogin", ["Asha Example", "0000"], env);
    const built = { ...buildCounts };
    await rpc("rpcLogin", ["Asha Example", "0000"], env);
    await rpc("rpcLogin", ["Asha Example", "0000"], env);
    expect(buildCounts).toEqual(built);
    expect(buildCounts.contract).toBe(1);
  });
});

describe("no database configured", () => {
  it("/rpc/rpcLogin answers 500 SERVER_ERROR and /health 503", async () => {
    const env = { ASSETS: assets, PIN_PEPPER: PEPPER };
    const res = await rpc("rpcLogin", ["Asha Example", "4821"], env);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: { message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.message).toBe("SERVER_ERROR");
    expect((await get("/health", env)).status).toBe(503);
  });
});

describe("set-pin tool", () => {
  const run = async (args: string[], env: Record<string, string | undefined>) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await setPinMain(args, env, { out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  it("refuses a database that is not on this machine, and never prints the PIN", async () => {
    const r = await run(["S1", "9876"], { OPS_DB_APP_URL: "postgres://ops_app:x@db.example.com:5432/ops", PIN_PEPPER: PEPPER });
    expect(r.code).not.toBe(0);
    expect(r.out + r.err).not.toContain("9876");
    expect(r.err).toContain("db.example.com");
  });

  it("sets a PIN that then signs in, printing only the confirmation", async () => {
    await db.query("insert into ops.staff (staff_id, name, active, role, companies_authorized) values ('S9', 'Cy Tester', true, 'employee', 'vape')");
    const r = await run(["S9", "2468"], { OPS_DB_APP_URL: testDb.appUrl, PIN_PEPPER: PEPPER });
    expect(r).toEqual({ code: 0, out: "PIN set for S9", err: "" });
    const login = await rpc("rpcLogin", ["Cy Tester", "2468"]);
    expect(((await login.json()) as { result: { success: boolean } }).result.success).toBe(true);
  });

  it("needs a staff id, a pin, and the two environment values", async () => {
    expect((await run(["S1"], { OPS_DB_APP_URL: testDb.appUrl, PIN_PEPPER: PEPPER })).code).not.toBe(0);
    const noPepper = await run(["S1", "1234"], { OPS_DB_APP_URL: testDb.appUrl });
    expect(noPepper.code).not.toBe(0);
    expect(noPepper.out + noPepper.err).not.toContain("1234");
  });
});
