// The RPC router: the contract, not the handler, decides who may call what.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connect, DbError, ValueError, type Db } from "../src/db/client";
import { ROLES, type Role, type Session } from "../src/auth/types";
import { parseRpcContract, type RpcContract } from "../src/rpc/contract";
import { createRpcRouter } from "../src/rpc/router";
import type { RpcContext, RpcHandler } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

const realJson = JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8"));
const contract: RpcContract = parseRpcContract(realJson);

type Conn = Db & { close(): Promise<void> };
let testDb: TestDb;
let shared: Conn;
let other: Conn;
beforeAll(async () => {
  testDb = await createTestDb();
  shared = await connect(testDb.appUrl);
  other = await connect(testDb.appUrl);
});
afterAll(async () => {
  await shared?.close();
  await other?.close();
  await testDb?.drop();
});

// ---- fakes -------------------------------------------------------------------

const sessionFor = (role: Role): Session => ({
  staffId: `staff-${role}`,
  name: `Fictional ${role}`,
  role,
  companiesAuthorized: ["cstore"],
  expiresAt: 4_000_000_000_000,
});
const SESSIONS = new Map<string, Session>(ROLES.map((r) => [`tok-${r}`, sessionFor(r)]));
const NOT_LOGGED_IN = "NOT_LOGGED_IN";
const fakeResolve = vi.fn(async (_db: unknown, token: unknown, _now: Date): Promise<Session> => {
  const s = typeof token === "string" ? SESSIONS.get(token) : undefined;
  if (!s) throw new Error(NOT_LOGGED_IN);
  return s;
});

const FIXED = new Date("2026-11-26T15:30:00.000Z");

interface Rig {
  router: (r: Request) => Promise<Response>;
  opened: () => number;
  closed: () => number;
  logs: object[];
  queries: string[];
}
/** Handlers by name. Every call gets the shared real connection, wrapped to count opens, closes and queries. */
function rig(handlers: Record<string, RpcHandler>, over: { openDb?: () => Promise<Conn>; now?: () => Date } = {}): Rig {
  let opened = 0;
  let closed = 0;
  const logs: object[] = [];
  const queries: string[] = [];
  const openDb = over.openDb
    ? async () => {
        opened++;
        return over.openDb!();
      }
    : async () => {
        opened++;
        const wrapped: Conn = {
          query: (t, p) => (queries.push(t), shared.query(t, p)),
          one: (t, p) => (queries.push(t), shared.one(t, p)),
          maybeOne: (t, p) => (queries.push(t), shared.maybeOne(t, p)),
          close: async () => {
            closed++;
          },
        };
        return wrapped;
      };
  const router = createRpcRouter({
    contract,
    handlers,
    openDb,
    resolveSession: fakeResolve,
    env: { SOME_BINDING: "x" },
    now: over.now ?? (() => FIXED),
    log: (e) => logs.push(e),
  });
  return { router, opened: () => opened, closed: () => closed, logs, queries };
}

const post = (name: string, body: string | Uint8Array, path = `/rpc/${name}`) =>
  new Request(`http://worker.test${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
async function call(r: Rig, name: string, args: unknown[], path?: string) {
  const res = await r.router(post(name, JSON.stringify({ args }), path));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text), headers: res.headers };
}
const exists = async (id: string) => (await other.maybeOne("select 1 as x from ops.staff where staff_id = $1", [id])) !== null;
const insertStaff = (db: Db, id: string, name = "Fictional Person") =>
  db.query("insert into ops.staff (staff_id, name, active, role) values ($1, $2, true, 'employee')", [id, name]);
let seq = 0;
const nextId = () => `rpc-${++seq}-${Math.floor(performance.now())}`;

const migrated = contract.entries.filter((e) => e.migrate);
const restricted = migrated.filter((e) => e.roles !== null);
const sessioned = migrated.filter((e) => e.needs_session);

// ---- the contract is the enforcement -----------------------------------------

describe("roles come from the contract, before any handler runs", () => {
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const e of contract.entries) spies[e.name] = vi.fn(async () => "handled");
  const r = rig(spies as unknown as Record<string, RpcHandler>);

  it("every role-restricted RPC: refused for each role not listed, handler untouched; called for each role listed", async () => {
    expect(restricted.length).toBeGreaterThan(10);
    let pairs = 0;
    for (const e of restricted) {
      for (const role of ROLES) {
        const spy = spies[e.name]!;
        spy.mockClear();
        const rest = e.params.slice(1).map((_, i) => `arg${i}`);
        const out = await call(r, e.name, [`tok-${role}`, ...rest]);
        pairs++;
        expect(out.status, `${e.name} as ${role}`).toBe(200);
        if (e.roles!.includes(role)) {
          expect(out.body, `${e.name} as ${role}`).toEqual({ ok: true, result: "handled" });
          expect(spy, `${e.name} as ${role}`).toHaveBeenCalledTimes(1);
        } else {
          expect(out.body, `${e.name} as ${role}`).toEqual({
            ok: false,
            error: { message: `FORBIDDEN: requires ${e.roles!.join(" or ")}, got ${role}` },
          });
          expect(spy, `${e.name} as ${role}`).not.toHaveBeenCalled();
        }
      }
    }
    expect(pairs).toBe(restricted.length * ROLES.length);
    console.log(`contract-driven (RPC, role) pairs exercised: ${pairs} across ${restricted.length} restricted RPCs`);
  });

  it("every needs_session RPC: a missing, empty, unknown or non-string token is NOT_LOGGED_IN, handler untouched", async () => {
    const tokens: Array<[string, unknown[]]> = [
      ["missing", []],
      ["empty", [""]],
      ["unknown", ["tok-nobody"]],
      ["number", [42]],
      ["null", [null]],
      ["object", [{ role: "admin" }]],
      ["array", [["tok-admin"]]],
      ["prototype key", ["__proto__"]],
    ];
    let cases = 0;
    for (const e of sessioned) {
      for (const [label, args] of tokens) {
        const spy = spies[e.name]!;
        spy.mockClear();
        const out = await call(r, e.name, args);
        cases++;
        expect(out.status, `${e.name} ${label}`).toBe(200);
        expect(out.body, `${e.name} ${label}`).toEqual({ ok: false, error: { message: NOT_LOGGED_IN } });
        expect(spy, `${e.name} ${label}`).not.toHaveBeenCalled();
      }
    }
    expect(cases).toBe(sessioned.length * tokens.length);
    console.log(`contract-driven (RPC, bad token) cases exercised: ${cases} across ${sessioned.length} session RPCs`);
  });

  it("every unrestricted session RPC works for every role", async () => {
    for (const e of sessioned.filter((x) => x.roles === null)) {
      for (const role of ROLES) {
        const out = await call(r, e.name, [`tok-${role}`]);
        expect(out.body, `${e.name} as ${role}`).toEqual({ ok: true, result: "handled" });
      }
    }
  });
});

// ---- what the handler receives -----------------------------------------------

describe("handler arguments and context", () => {
  it("never receives the token: (ctx, a, b) for a session RPC, ctx.session is the resolved one", async () => {
    const seen: unknown[][] = [];
    const h: RpcHandler = (ctx, ...args) => (seen.push([ctx, ...args]), "ok");
    const r = rig({ rpcGetStaffDirectory: h });
    const out = await call(r, "rpcGetStaffDirectory", ["tok-admin", "a", { b: 2 }]);
    expect(out.body).toEqual({ ok: true, result: "ok" });
    expect(seen).toHaveLength(1);
    const [ctx, ...args] = seen[0] as [RpcContext, ...unknown[]];
    expect(args).toEqual(["a", { b: 2 }]);
    expect(ctx.session).toEqual(sessionFor("admin"));
    expect(JSON.stringify(args)).not.toContain("tok-admin");
  });

  it("passes every argument when the RPC takes no session, and ctx.session is null (rpcLogin)", async () => {
    const seen: unknown[][] = [];
    const r = rig({ rpcLogin: (ctx, ...a) => (seen.push([ctx, ...a]), "in") });
    fakeResolve.mockClear();
    const out = await call(r, "rpcLogin", ["Fictional Person", "1234"]);
    expect(out.body).toEqual({ ok: true, result: "in" });
    const [ctx, ...args] = seen[0] as [RpcContext, ...unknown[]];
    expect(args).toEqual(["Fictional Person", "1234"]);
    expect(ctx.session).toBeNull();
    expect(fakeResolve).not.toHaveBeenCalled();
  });

  it("rpcLogout (a token param, but needs_session false) gets the token as an ordinary argument", async () => {
    const seen: unknown[][] = [];
    const r = rig({ rpcLogout: (_ctx, ...a) => (seen.push(a), null) });
    await call(r, "rpcLogout", ["tok-admin"]);
    expect(seen).toEqual([["tok-admin"]]);
  });

  it("a role or staff id inside the arguments changes nothing", async () => {
    let got: Session | null = null;
    const r = rig({ rpcGetStaffDirectory: (ctx) => ((got = ctx.session), "ok") });
    await call(r, "rpcGetStaffDirectory", ["tok-employee", { role: "admin", staffId: "staff-admin", session: sessionFor("admin") }, "admin"]);
    expect(got).toEqual(sessionFor("employee"));

    const e = restricted[0]!;
    const spy = vi.fn(() => "no");
    const r2 = rig({ [e.name]: spy });
    const outsider = ROLES.find((x) => !e.roles!.includes(x))!;
    const out = await call(r2, e.name, [`tok-${outsider}`, { role: e.roles![0], staffId: "staff-admin" }]);
    expect(out.body.error.message).toMatch(/^FORBIDDEN: requires /);
    expect(spy).not.toHaveBeenCalled();
  });

  it("gives env through, and one clock reading for the whole call (resolveSession sees the same instant)", async () => {
    let ctxSeen: RpcContext | undefined;
    let ticks = 1_700_000_000_000;
    const clock = vi.fn(() => new Date(ticks++));
    const r = rig(
      {
        rpcGetMe: async (ctx) => {
          ctxSeen = ctx;
          await new Promise((res) => setTimeout(res, 5));
          return ctx.now.toISOString();
        },
      },
      { now: clock },
    );
    fakeResolve.mockClear();
    const out = await call(r, "rpcGetMe", ["tok-admin"]);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(out.body.result).toBe(new Date(1_700_000_000_000).toISOString());
    expect(ctxSeen!.now).toBe(fakeResolve.mock.calls[0]![2]);
    expect(ctxSeen!.env).toEqual({ SOME_BINDING: "x" });
  });

  it("ctx.config() runs one query however often it is called, and none when never called", async () => {
    const r = rig({
      rpcGetMe: async (ctx) => {
        const [a, b, c] = await Promise.all([ctx.config(), ctx.config(), ctx.config()]);
        await ctx.config();
        return a === b && b === c;
      },
      rpcGetStaffDirectory: () => "x",
    });
    const out = await call(r, "rpcGetMe", ["tok-admin"]);
    expect(out.body.result).toBe(true);
    expect(r.queries.filter((q) => /ops\.config/.test(q))).toHaveLength(1);
    const r2 = rig({ rpcGetStaffDirectory: () => "x" });
    await call(r2, "rpcGetStaffDirectory", ["tok-admin"]);
    expect(r2.queries.filter((q) => /ops\.config/.test(q))).toHaveLength(0);
  });
});

// ---- the wire format ---------------------------------------------------------

describe("status codes, and no database before the call is understood", () => {
  const notMigrated = contract.entries.find((e) => !e.migrate)!.name;
  const r = rig({});
  const errBody = (m: string) => ({ ok: false, error: { message: m } });

  const cases: Array<[string, () => Request, number, string | null]> = [
    ["GET", () => new Request("http://worker.test/rpc/rpcLogin"), 405, null],
    ["PUT", () => new Request("http://worker.test/rpc/rpcLogin", { method: "PUT", body: "{}" }), 405, null],
    ["DELETE", () => new Request("http://worker.test/rpc/rpcLogin", { method: "DELETE" }), 405, null],
    ["bad JSON", () => post("rpcLogin", "{nope"), 400, null],
    ["empty body", () => post("rpcLogin", ""), 400, null],
    ["array body", () => post("rpcLogin", "[]"), 400, null],
    ["null body", () => post("rpcLogin", "null"), 400, null],
    ["string body", () => post("rpcLogin", '"x"'), 400, null],
    ["missing args", () => post("rpcLogin", "{}"), 400, null],
    ["args not an array", () => post("rpcLogin", '{"args":{"0":"a"}}'), 400, null],
    ["args a string", () => post("rpcLogin", '{"args":"a"}'), 400, null],
    ["invalid UTF-8", () => post("rpcLogin", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])), 400, null],
    ["unknown name", () => post("rpcNoSuchThing", '{"args":[]}'), 404, null],
    ["not migrated", () => post(notMigrated, '{"args":["tok-admin"]}'), 404, "NOT_MIGRATED"],
    ["not ported", () => post("rpcGetBootstrap", '{"args":["tok-admin"]}'), 501, "NOT_PORTED"],
  ];
  for (const [label, make, status, message] of cases) {
    it(`${label} -> ${status}, no connection opened, JSON answer with the standard headers`, async () => {
      const before = r.opened();
      const res = await r.router(make());
      expect(res.status).toBe(status);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as any;
      expect(body.ok).toBe(false);
      expect(typeof body.error.message).toBe("string");
      if (message) expect(body).toEqual(errBody(message));
      expect(r.opened()).toBe(before);
    });
  }

  it("every migrate:false RPC in the real contract is 404 NOT_MIGRATED, even with a registered handler and a good session", async () => {
    const spy = vi.fn(() => "x");
    const handlers: Record<string, RpcHandler> = {};
    for (const e of contract.entries) handlers[e.name] = spy;
    const rr = rig(handlers);
    const names = contract.entries.filter((e) => !e.migrate).map((e) => e.name);
    expect(names.length).toBe(62 - realJson.migrate_count);
    for (const n of names) {
      const out = await call(rr, n, ["tok-admin"]);
      expect(out.status, n).toBe(404);
      expect(out.body, n).toEqual(errBody("NOT_MIGRATED"));
    }
    expect(spy).not.toHaveBeenCalled();
    expect(rr.opened()).toBe(0);
  });

  it("a body over 1 MB is 400, by actual byte length; exactly 1 MB is accepted", async () => {
    const LIMIT = 1024 * 1024;
    const frame = (fill: number) => `{"args":["${"x".repeat(fill)}"]}`;
    const overhead = frame(0).length;
    const handler = vi.fn(() => "in");
    const rr = rig({ rpcLogin: handler });
    const exact = frame(LIMIT - overhead);
    expect(new TextEncoder().encode(exact).length).toBe(LIMIT);
    expect((await rr.router(post("rpcLogin", exact))).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);

    const over = frame(LIMIT - overhead + 1);
    expect(new TextEncoder().encode(over).length).toBe(LIMIT + 1);
    const before = rr.opened();
    const res = await rr.router(post("rpcLogin", over));
    expect(res.status).toBe(400);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(rr.opened()).toBe(before);

    // 600k two-byte characters: fewer than 1M characters, more than 1 MB of bytes.
    const wide = `{"args":["${"é".repeat(600_000)}"]}`;
    expect(wide.length).toBeLessThan(LIMIT);
    expect((await rr.router(post("rpcLogin", wide))).status).toBe(400);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a streamed body that lies about its size is cut off at the limit too", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(chunk);
        sent += chunk.length;
        if (sent > 50 * 1024 * 1024) c.close();
      },
    });
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      body: stream,
      headers: { "content-length": "10" },
      duplex: "half",
    };
    const handler = vi.fn(() => "in");
    const rr = rig({ rpcLogin: handler });
    const res = await rr.router(new Request("http://worker.test/rpc/rpcLogin", init));
    expect(res.status).toBe(400);
    expect(sent).toBeLessThan(5 * 1024 * 1024); // stopped reading soon after 1 MB
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("a name is only ever looked up, never executed", () => {
  const handler = vi.fn(() => "x");
  const r = rig({ rpcLogin: handler });
  const paths = [
    "/rpc/__proto__",
    "/rpc/constructor",
    "/rpc/toString",
    "/rpc/hasOwnProperty",
    "/rpc/valueOf",
    "/rpc/rpcLogin/extra",
    "/rpc/rpcLogin/",
    "/rpc/",
    "/rpc",
    "/rpc//rpcLogin",
    "/rpc/rpc%4Cogin",
    "/rpc/rpcLogin%2Fextra",
    "/rpc/%72pcLogin",
    "/rpc/rpc.Login",
    "/rpc/rpcLogin.",
    "/rpc/..%2Frpc%2FrpcLogin",
    "/rpc/rpclogin",
    "/rpc/%20rpcLogin",
    "/other/rpcLogin",
    "/",
  ];
  for (const p of paths) {
    it(`POST ${p} is 404 and runs nothing`, async () => {
      const before = r.opened();
      const res = await r.router(post("x", '{"args":[]}', p));
      expect(res.status).toBe(404);
      expect(((await res.json()) as any).ok).toBe(false);
      expect(r.opened()).toBe(before);
    });
  }
  it("none of them reached the registered handler", () => expect(handler).not.toHaveBeenCalled());

  it("a prototype-named handler (toString) on a handlers map is never used", async () => {
    const rr = rig({});
    const out = await call(rr, "toString", [], "/rpc/toString");
    expect(out.status).toBe(404);
  });
});

// ---- transactions ------------------------------------------------------------

describe("one transaction per call", () => {
  it("a handler that inserts and returns: the row is committed and visible on another connection", async () => {
    const id = nextId();
    const r = rig({ rpcGetMe: async (ctx) => (await insertStaff(ctx.db, id), { saved: id }) });
    const out = await call(r, "rpcGetMe", ["tok-admin"]);
    expect(out).toMatchObject({ status: 200, body: { ok: true, result: { saved: id } } });
    expect(await exists(id)).toBe(true);
  });

  it("a handler that inserts and then throws a plain Error: 200 with its message, no row", async () => {
    const id = nextId();
    const r = rig({
      rpcGetMe: async (ctx) => {
        await insertStaff(ctx.db, id);
        throw new Error("Till is already open");
      },
    });
    const out = await call(r, "rpcGetMe", ["tok-admin"]);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: false, error: { message: "Till is already open" } });
    expect(await exists(id)).toBe(false);
    expect(r.logs).toEqual([]);
  });

  it("a database error is a fault: 500 SERVER_ERROR with a request id, no row, and nothing from the arguments in the log or the answer", async () => {
    const id = nextId();
    const secretValue = "Distinctive-Argument-Value-9137";
    const r = rig({
      rpcGetMe: async (ctx, ...args) => {
        await insertStaff(ctx.db, id, String(args[0]));
        await insertStaff(ctx.db, id, String(args[0])); // duplicate key: DbError
        return "unreachable";
      },
    });
    const out = await call(r, "rpcGetMe", ["tok-admin", secretValue]);
    expect(out.status).toBe(500);
    expect(out.body.ok).toBe(false);
    expect(out.body.error.message).toBe("SERVER_ERROR");
    expect(typeof out.body.error.id).toBe("string");
    expect(Object.keys(out.body.error).sort()).toEqual(["id", "message"]);
    expect(await exists(id)).toBe(false);
    expect(r.logs).toHaveLength(1);
    const entry = r.logs[0] as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(["errorClass", "id", "message", "rpc"]);
    expect(entry["rpc"]).toBe("rpcGetMe");
    expect(entry["errorClass"]).toBe("DbError");
    expect(entry["id"]).toBe(out.body.error.id);
    for (const leaked of [secretValue, "tok-admin", "staff-admin", "Fictional admin"]) {
      expect(JSON.stringify(r.logs)).not.toContain(leaked);
      expect(out.text).not.toContain(leaked);
    }
  });

  it("request ids differ between faults", async () => {
    const r = rig({
      rpcGetMe: () => {
        throw new TypeError("x");
      },
    });
    const a = await call(r, "rpcGetMe", ["tok-admin"]);
    const b = await call(r, "rpcGetMe", ["tok-admin"]);
    expect(a.body.error.id).not.toBe(b.body.error.id);
  });

  it("a handler that swallows a failed statement still rolls back and is a fault, not a commit", async () => {
    const id = nextId();
    const r = rig({
      rpcGetMe: async (ctx) => {
        await insertStaff(ctx.db, id);
        await insertStaff(ctx.db, id).catch(() => undefined);
        return "looks fine";
      },
    });
    const out = await call(r, "rpcGetMe", ["tok-admin"]);
    expect(out.status).toBe(500);
    expect(out.body.error.message).toBe("SERVER_ERROR");
    expect(await exists(id)).toBe(false);
  });

  it("resolveSession runs inside the same transaction (a rolled-back call leaves nothing, even from it)", async () => {
    const id = nextId();
    const router = createRpcRouter({
      contract,
      handlers: {
        rpcGetMe: () => {
          throw new Error("nope");
        },
      },
      openDb: async () => ({ ...shared, close: async () => undefined }),
      resolveSession: async (db, token) => {
        await insertStaff(db, id);
        return SESSIONS.get(String(token))!;
      },
      env: {},
      log: () => undefined,
    });
    const res = await router(post("rpcGetMe", '{"args":["tok-admin"]}'));
    expect(((await res.json()) as any).error.message).toBe("nope");
    expect(await exists(id)).toBe(false);
  });
});

describe("which messages reach the page", () => {
  class Weird extends Error {}
  const faults: Array<[string, () => unknown, string]> = [
    ["DbError", () => { throw new DbError("unique", { code: "23505", table: "staff" }); }, "DbError"],
    ["ValueError", () => { throw new ValueError("numeric value is not a finite number"); }, "ValueError"],
    ["TypeError", () => { throw new TypeError("Cannot read properties of undefined (reading 'x')"); }, "TypeError"],
    ["RangeError", () => { throw new RangeError("Invalid array length"); }, "RangeError"],
    ["ReferenceError", () => { throw new ReferenceError("zzz is not defined"); }, "ReferenceError"],
    ["SyntaxError", () => { throw new SyntaxError("Unexpected token"); }, "SyntaxError"],
    ["custom Error subclass", () => { throw new Weird("secret detail"); }, "Weird"],
    ["thrown string", () => { throw "just a string with secret detail"; }, "string"],
    ["thrown object", () => { throw { message: "secret detail" }; }, "object"],
    ["thrown null", () => { throw null; }, "null"],
    ["rejected promise", () => Promise.reject(new TypeError("secret detail")), "TypeError"],
  ];
  for (const [label, thrower, cls] of faults) {
    it(`${label} -> 500 SERVER_ERROR, logged once with its class`, async () => {
      const r = rig({ rpcGetMe: thrower as RpcHandler });
      const out = await call(r, "rpcGetMe", ["tok-admin", "arg-value-5521"]);
      expect(out.status).toBe(500);
      expect(out.body).toEqual({ ok: false, error: { message: "SERVER_ERROR", id: expect.any(String) } });
      expect(out.text).not.toContain("secret detail");
      expect(r.logs).toHaveLength(1);
      expect((r.logs[0] as Record<string, unknown>)["errorClass"]).toBe(cls);
      expect(JSON.stringify(r.logs)).not.toContain("arg-value-5521");
      expect(JSON.stringify(r.logs)).not.toContain("tok-admin");
    });
  }

  it("the 'transaction rolled back' error is a fault with that class in the log", async () => {
    const id = nextId();
    const r = rig({
      rpcGetMe: async (ctx) => {
        await insertStaff(ctx.db, id);
        await insertStaff(ctx.db, id).catch(() => undefined);
        return "x";
      },
    });
    const out = await call(r, "rpcGetMe", ["tok-admin"]);
    expect(out.body.error.message).toBe("SERVER_ERROR");
    expect((r.logs[0] as Record<string, unknown>)["errorClass"]).toBe("Error");
    expect(String((r.logs[0] as Record<string, unknown>)["message"])).toMatch(/rolled back/);
  });

  it("a plain Error from the handler, from resolveSession or from the role check reaches the page unchanged (200)", async () => {
    const r = rig({
      rpcGetMe: () => {
        throw new Error("Cash count is required");
      },
    });
    expect((await call(r, "rpcGetMe", ["tok-admin"])).body).toEqual({ ok: false, error: { message: "Cash count is required" } });
    expect((await call(r, "rpcGetMe", ["bad"])).body).toEqual({ ok: false, error: { message: NOT_LOGGED_IN } });
    const e = restricted[0]!;
    const rr = rig({ [e.name]: () => "x" });
    const outsider = ROLES.find((x) => !e.roles!.includes(x))!;
    const out = await call(rr, e.name, [`tok-${outsider}`]);
    expect(out.status).toBe(200);
    expect(out.body.error.message).toBe(`FORBIDDEN: requires ${e.roles!.join(" or ")}, got ${outsider}`);
    expect(r.logs).toEqual([]);
    expect(rr.logs).toEqual([]);
  });

  it("a resolveSession that fails with a non-plain error is a fault", async () => {
    const router = createRpcRouter({
      contract,
      handlers: { rpcGetMe: () => "x" },
      openDb: async () => ({ ...shared, close: async () => undefined }),
      resolveSession: async () => {
        throw new DbError("other", {});
      },
      env: {},
      log: () => undefined,
    });
    const res = await router(post("rpcGetMe", '{"args":["t"]}'));
    expect(res.status).toBe(500);
  });

  it("a resolveSession that returns nothing usable is a fault, not a pass", async () => {
    const spy = vi.fn(() => "x");
    const router = createRpcRouter({
      contract,
      handlers: { rpcGetMe: spy },
      openDb: async () => ({ ...shared, close: async () => undefined }),
      resolveSession: (async () => null) as never,
      env: {},
      log: () => undefined,
    });
    const res = await router(post("rpcGetMe", '{"args":["t"]}'));
    expect(res.status).toBe(500);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("the connection is always closed", () => {
  it("after success, a thrown error, a role refusal, a bad token and a fault", async () => {
    const e = restricted[0]!;
    const outsider = ROLES.find((x) => !e.roles!.includes(x))!;
    const insider = e.roles![0]!;
    const r = rig({
      [e.name]: () => "x",
      rpcGetMe: (_c, ...a) => {
        if (a[0] === "plain") throw new Error("plain");
        if (a[0] === "fault") throw new TypeError("boom");
        return "ok";
      },
    });
    await call(r, e.name, [`tok-${insider}`]);
    expect([r.opened(), r.closed()]).toEqual([1, 1]);
    await call(r, "rpcGetMe", ["tok-admin", "plain"]);
    expect([r.opened(), r.closed()]).toEqual([2, 2]);
    await call(r, e.name, [`tok-${outsider}`]);
    expect([r.opened(), r.closed()]).toEqual([3, 3]);
    await call(r, "rpcGetMe", ["nobody"]);
    expect([r.opened(), r.closed()]).toEqual([4, 4]);
    await call(r, "rpcGetMe", ["tok-admin", "fault"]);
    expect([r.opened(), r.closed()]).toEqual([5, 5]);
  });

  it("a close that fails does not turn a success into a failure", async () => {
    const r = rig(
      { rpcGetMe: () => "ok" },
      {
        openDb: async () => ({
          ...shared,
          close: async () => {
            throw new Error("socket gone");
          },
        }),
      },
    );
    const out = await call(r, "rpcGetMe", ["tok-admin"]);
    expect(out.body).toEqual({ ok: true, result: "ok" });
  });

  it("a failing openDb is a 500 SERVER_ERROR, logged, with nothing leaked", async () => {
    const r = rig(
      { rpcGetMe: vi.fn(() => "x") },
      {
        openDb: async () => {
          throw new DbError("other", { code: "ECONNREFUSED" });
        },
      },
    );
    const out = await call(r, "rpcGetMe", ["tok-admin", "arg-value-77"]);
    expect(out.status).toBe(500);
    expect(out.body.error.message).toBe("SERVER_ERROR");
    expect(typeof out.body.error.id).toBe("string");
    expect(r.logs).toHaveLength(1);
    expect((r.logs[0] as Record<string, unknown>)["errorClass"]).toBe("DbError");
    expect(JSON.stringify(r.logs)).not.toContain("arg-value-77");
  });
});

// ---- results -----------------------------------------------------------------

describe("results", () => {
  const run = async (value: unknown) => {
    const r = rig({ rpcGetMe: () => value });
    return call(r, "rpcGetMe", ["tok-admin"]);
  };

  it("undefined becomes null", async () => {
    expect((await run(undefined)).body).toEqual({ ok: true, result: null });
  });
  it("a Date, anywhere, becomes its ISO string", async () => {
    const d = new Date("2026-03-04T05:06:07.000Z");
    expect((await run(d)).body.result).toBe("2026-03-04T05:06:07.000Z");
    expect((await run({ a: [{ when: d }], b: d })).body.result).toEqual({
      a: [{ when: "2026-03-04T05:06:07.000Z" }],
      b: "2026-03-04T05:06:07.000Z",
    });
  });
  it("nested objects and arrays, nulls, zero and empty strings arrive intact", async () => {
    const v = { a: [1, { b: [null, "", 0, false] }], c: {}, d: [] };
    expect((await run(v)).body).toEqual({ ok: true, result: v });
  });
  it("answers carry the standard headers on success and on a handler error", async () => {
    const out = await run(1);
    expect(out.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(out.headers.get("cache-control")).toBe("no-store");
    const r = rig({
      rpcGetMe: () => {
        throw new Error("x");
      },
    });
    const bad = await call(r, "rpcGetMe", ["tok-admin"]);
    expect(bad.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(bad.headers.get("cache-control")).toBe("no-store");
  });

  it("a result that cannot be serialised (a cycle) is a fault, and the handler's insert is rolled back", async () => {
    const id = nextId();
    const r = rig({
      rpcGetMe: async (ctx) => {
        await insertStaff(ctx.db, id);
        const cyc: Record<string, unknown> = {};
        cyc["self"] = cyc;
        return cyc;
      },
    });
    const out = await call(r, "rpcGetMe", ["tok-admin"]);
    expect(out.status).toBe(500);
    expect(out.body.error.message).toBe("SERVER_ERROR");
    expect(await exists(id)).toBe(false);
    expect((r.logs[0] as Record<string, unknown>)["errorClass"]).toBe("TypeError");
  });

  it("a BigInt result and a function result are faults too", async () => {
    expect((await run(10n)).status).toBe(500);
    expect((await run(() => 1)).status).toBe(500);
  });
});

// ---- the real client ---------------------------------------------------------

describe("round trip with the real transport.js", () => {
  const SRC = readFileSync(new URL("../public/transport.js", import.meta.url), "utf8");
  function bootClient(r: Rig) {
    const win: Record<string, any> = {};
    const fakeFetch = async (url: string, init: RequestInit) => {
      const res = await r.router(new Request(`http://worker.test${url}`, init));
      return { ok: res.ok, status: res.status, text: () => res.text() };
    };
    new Function("window", "fetch", "console", SRC)(win, fakeFetch, { error() {}, log() {}, warn() {} });
    return win["google"].script.run as any;
  }
  const once = (run: any, method: string, ...args: unknown[]) =>
    new Promise<{ kind: "ok" | "fail"; value: any }>((resolve) => {
      run
        .withSuccessHandler((value: any) => resolve({ kind: "ok", value }))
        .withFailureHandler((value: any) => resolve({ kind: "fail", value }))[method](...args);
    });
  const e = restricted[0]!;
  const outsider = ROLES.find((x) => !e.roles!.includes(x))!;
  const r = rig({
    rpcGetMe: (ctx, ...a) => ({ me: ctx.session!.staffId, a, at: ctx.now }),
    [e.name]: () => "x",
    rpcGetStaffDirectory: () => {
      throw new TypeError("secret detail");
    },
  });
  const run = bootClient(r);

  it("success reaches the success handler with the result", async () => {
    const out = await once(run, "rpcGetMe", "tok-manager", 1, "two");
    expect(out.kind).toBe("ok");
    expect(out.value).toEqual({ me: "staff-manager", a: [1, "two"], at: FIXED.toISOString() });
  });
  it("NOT_LOGGED_IN reaches the failure handler as an Error with that exact message", async () => {
    const out = await once(run, "rpcGetMe", "no-such-token");
    expect(out.kind).toBe("fail");
    expect(out.value).toBeInstanceOf(Error);
    expect(out.value.message).toBe("NOT_LOGGED_IN");
  });
  it("a FORBIDDEN refusal reaches the failure handler as an Error with the exact message", async () => {
    const out = await once(run, e.name, `tok-${outsider}`);
    expect(out.kind).toBe("fail");
    expect(out.value).toBeInstanceOf(Error);
    expect(out.value.message).toBe(`FORBIDDEN: requires ${e.roles!.join(" or ")}, got ${outsider}`);
  });
  it("a fault reaches the failure handler as SERVER_ERROR, nothing more", async () => {
    const out = await once(run, "rpcGetStaffDirectory", "tok-admin");
    expect(out.kind).toBe("fail");
    expect(out.value.message).toBe("SERVER_ERROR");
  });
  it("NOT_PORTED and NOT_MIGRATED surface by message", async () => {
    expect((await once(run, "rpcGetBootstrap", "tok-admin")).value.message).toBe("NOT_PORTED");
    const nm = contract.entries.find((x) => !x.migrate)!.name;
    expect((await once(run, nm, "tok-admin")).value.message).toBe("NOT_MIGRATED");
  });
});
