// Sign-in through the real router with the real handlers, against a real
// database: the first slice of the new app that works end to end.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setPin } from "../src/auth/pin";
import { connect, type Db } from "../src/db/client";
import { parseRpcContract } from "../src/rpc/contract";
import { handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import type { RpcHandlers } from "../src/rpc/types";
import { createTestDb, type TestDb } from "./helpers/db";

const PEPPER = "test-pepper-not-a-secret";
const contract = parseRpcContract(JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")));

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
const logged: object[] = [];

function router(env: Record<string, unknown>, extra: RpcHandlers = {}, at = new Date(Date.UTC(2026, 5, 15, 16, 0, 0))) {
  return createRpcRouter({
    contract,
    handlers: { ...handlers, ...extra },
    openDb: () => connect(testDb.appUrl),
    resolveSession,
    env,
    now: () => at,
    log: (e) => logged.push(e),
  });
}
async function call(r: ReturnType<typeof router>, name: string, args: unknown[]) {
  const res = await r(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
  return { status: res.status, body: (await res.json()) as { ok: boolean; result?: Record<string, unknown>; error?: { message: string; id?: string } } };
}

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  await db.query("insert into ops.staff (staff_id, name, active, role, companies_authorized) values ('S1', 'Asha Example', true, 'manager', 'cstore,vape'), ('S2', 'Ben Sample', true, 'employee', 'vape')");
  await setPin(db, "S1", "4821", PEPPER);
  await setPin(db, "S2", "1357", PEPPER);
});
afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

describe("sign-in through the router", () => {
  const whoAmI: RpcHandlers = { rpcGetMe: (ctx) => ({ staffId: ctx.session?.staffId, role: ctx.session?.role }) };

  it("the right PIN gives a token; the token opens a session call; logout ends it", async () => {
    const r = router({ PIN_PEPPER: PEPPER }, whoAmI);
    const login = await call(r, "rpcLogin", ["Asha Example", "4821"]);
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);
    expect(login.body.result).toMatchObject({ success: true, staffId: "S1", name: "Asha Example", role: "manager", companiesAuthorized: ["cstore", "vape"] });
    const token = login.body.result?.["token"] as string;
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    const me = await call(r, "rpcGetMe", [token]);
    expect(me.body).toEqual({ ok: true, result: { staffId: "S1", role: "manager" } });

    expect((await call(r, "rpcLogout", [token])).body).toEqual({ ok: true, result: { success: true } });
    expect((await call(r, "rpcGetMe", [token])).body).toEqual({ ok: false, error: { message: "NOT_LOGGED_IN" } });
  });

  it("a wrong PIN is an ordinary answer, and its failure row is kept (the call commits)", async () => {
    const r = router({ PIN_PEPPER: PEPPER });
    const res = await call(r, "rpcLogin", ["Ben Sample", "0000"]);
    expect(res.body).toEqual({ ok: true, result: { success: false, error: "Invalid name or code" } });
    const n = await db.one<{ n: number }>("select count(*)::int as n from ops.login_failures where name_key = 'ben sample'");
    expect(n.n).toBe(1);
  });

  it("a deactivated person's token stops working at once", async () => {
    const r = router({ PIN_PEPPER: PEPPER }, whoAmI);
    const token = (await call(r, "rpcLogin", ["Ben Sample", "1357"])).body.result?.["token"] as string;
    expect((await call(r, "rpcGetMe", [token])).body.ok).toBe(true);
    await db.query("update ops.staff set active = false where staff_id = 'S2'");
    expect((await call(r, "rpcGetMe", [token])).body).toEqual({ ok: false, error: { message: "NOT_LOGGED_IN" } });
    await db.query("update ops.staff set active = true where staff_id = 'S2'");
  });

  it("a missing PIN_PEPPER is a server fault: nobody signs in, and the page learns nothing", async () => {
    logged.length = 0;
    const res = await call(router({}), "rpcLogin", ["Asha Example", "4821"]);
    expect(res.status).toBe(500);
    expect(res.body.error?.message).toBe("SERVER_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("PEPPER");
    expect(JSON.stringify(logged)).toContain("PIN_PEPPER"); // the operator is told which binding
    expect(JSON.stringify(logged)).not.toContain("4821");
  });

  it("an RPC with no handler yet answers NOT_PORTED", async () => {
    const res = await call(router({ PIN_PEPPER: PEPPER }), "rpcGetAllStaff", ["x"]);
    expect(res.status).toBe(501);
    expect(res.body.error?.message).toBe("NOT_PORTED");
  });
});
