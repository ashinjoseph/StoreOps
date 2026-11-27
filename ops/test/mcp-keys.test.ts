// Making and withdrawing assistant keys (card P5-11): the three own RPCs through the REAL router with
// the merged contract, their field rules, their audit rows, and what the list never holds. Also the
// structure of src/mcp/ (no way from there into the RPC registry or router) and the settings.
import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/sessions";
import { connect } from "../src/db/client";
import { Config } from "../src/lib/config";
import { CONFIG_KEYS } from "../src/lib/config-keys";
import * as settings from "../src/modules/settings";
import { mergeOpsContract, parseRpcContract } from "../src/rpc/contract";
import { ERROR_PREFIXED, handlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import { withTransaction } from "../src/db/tx";
import { makeWorld, sdkClient, setDoor, STAFF, type McpWorld } from "./helpers/mcp";

const NOW = new Date("2026-11-27T15:00:00Z");
const NAMES = ["rpcGetAssistantKeys", "rpcCreateAssistantKey", "rpcRevokeAssistantKey"];

const contract = parseRpcContract(
  mergeOpsContract(
    JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")),
    JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")),
  ),
);

let w: McpWorld;
const tokens: Record<string, string> = {};
const errors: object[] = [];
let router: (r: Request) => Promise<Response>;

beforeAll(async () => {
  w = await makeWorld(NOW);
  for (const [id] of STAFF.filter(([, , , active]) => active)) {
    tokens[id] = (await withTransaction(w.db, (tx) => createSession(tx, id, Config.fromRows([{ key: "session_hours", value: "720" }]), NOW))).token;
  }
  router = createRpcRouter({ contract, handlers, openDb: () => connect(w.testDb.appUrl), resolveSession, errorPrefixed: ERROR_PREFIXED, env: {}, now: () => w.clock.now, log: (e) => errors.push(e) });
});
afterAll(async () => {
  await w?.close();
});
beforeEach(async () => {
  w.clock.now = NOW;
  await w.owner.query("update ops.staff set active = (staff_id <> 'S_005')");
});

async function call(name: string, args: unknown[]): Promise<{ ok: boolean; result?: any; error?: { message: string } }> {
  const res = await router(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }));
  return (await res.json()) as { ok: boolean; result?: any; error?: { message: string } };
}
const admin = () => tokens["S_001"] as string;
const create = (input: Record<string, unknown>) => call("rpcCreateAssistantKey", [admin(), input]);
const audits = (action: string) => w.owner.query<{ actor_id: string; target_id: string; before: string | null; after: string | null; details: string | null }>("select * from ops.audit_log where action = $1 order by seq", [action]);

describe("the contract", () => {
  it("lists the three, admin only, with a session, with the params the page sends", () => {
    for (const name of NAMES) expect(contract.get(name), name).toMatchObject({ roles: ["admin"], needs_session: true, migrate: true });
    expect(contract.get("rpcGetAssistantKeys")?.params).toEqual(["token"]);
    expect(contract.get("rpcCreateAssistantKey")?.params).toEqual(["token", "input"]);
    expect(contract.get("rpcRevokeAssistantKey")?.params).toEqual(["token", "input"]);
    for (const name of NAMES) expect(typeof handlers[name], name).toBe("function");
  });
});

describe("who may call", () => {
  it("an admin is answered", async () => {
    const list = await call("rpcGetAssistantKeys", [admin()]);
    expect(list.ok).toBe(true);
    expect(list.result).toMatchObject({ enabled: false, address: "/mcp" });
  });

  it.each([
    ["a manager", "S_002", "manager"],
    ["an employee", "S_003", "employee"],
    ["a payroll admin", "S_004", "payroll_admin"],
  ])("%s is refused all three, and nothing is written", async (_who, id, role) => {
    const before = (await w.owner.one<{ n: number }>("select count(*)::int as n from ops.assistant_keys")).n;
    const t = tokens[id] as string;
    for (const [name, args] of [
      ["rpcGetAssistantKeys", [t]],
      ["rpcCreateAssistantKey", [t, { staffId: id, label: "Mine", right: "propose" }]],
      ["rpcRevokeAssistantKey", [t, { keyId: "ak0000000000000000", reason: "because" }]],
    ] as const) {
      expect(await call(name, [...args]), name).toEqual({ ok: false, error: { message: `FORBIDDEN: requires admin, got ${role}` } });
    }
    expect((await w.owner.one<{ n: number }>("select count(*)::int as n from ops.assistant_keys")).n).toBe(before);
  });

  it("no token, or a made-up one, is NOT_LOGGED_IN", async () => {
    for (const name of NAMES) {
      expect((await call(name, [])).error?.message, name).toBe("NOT_LOGGED_IN");
      expect((await call(name, ["made-up", {}])).error?.message, name).toBe("NOT_LOGGED_IN");
    }
  });
});

describe("making a key", () => {
  it("answers the record and, this once, the key; stores its hash; audits it without the key", async () => {
    const r = await create({ staffId: "S_003", label: "Cleo's Muse", right: "read", personalDetails: false, days: 30, actorId: "S_999" });
    expect(r.ok).toBe(true);
    const { record, key } = r.result as { record: Record<string, unknown>; key: string };
    expect(key).toMatch(/^ops_ak[0-9a-f]{16}_[A-Za-z0-9_-]{43}$/);
    expect(record).toMatchObject({ staffId: "S_003", staffName: "Cleo Marsh", label: "Cleo's Muse", right: "read", personalDetails: false, status: "live", daysLeft: 30, callsToday: 0, lastUsedAt: null, withdrawnAt: null });
    expect(record["keyId"]).toBe(key.split("_")[1]);
    expect(Object.keys(record)).not.toContain("keyHash");
    const [row] = await audits("assistant_key.create");
    expect(row).toMatchObject({ actor_id: "S_001", target_id: record["keyId"] });
    expect(JSON.parse(row!.after as string)).toEqual({ staffId: "S_003", label: "Cleo's Muse", right: "read", personalDetails: false, expiresAt: "2026-12-27T15:00:00.000Z" });
    // The key works, and the list never shows it again, or its hash.
    await setDoor(w, true);
    const client = await sdkClient(w, key);
    expect((await client.callTool({ name: "whoami", arguments: {} })).isError).toBeFalsy();
    await setDoor(w, false);
    const list = await call("rpcGetAssistantKeys", [admin()]);
    const text = JSON.stringify(list);
    expect(text).not.toContain(key);
    expect(text).not.toContain(key.slice(key.indexOf("_", 4) + 1));
    expect(text).not.toMatch(/hash/i);
    const listed = (list.result.keys as Array<Record<string, unknown>>).find((k) => k["keyId"] === record["keyId"]);
    expect(listed).toMatchObject({ callsToday: 1, status: "live" });
    expect(listed?.["lastUsedAt"]).toBe(NOW.toISOString());
  });

  it("defaults: read, no personal details, 90 days", async () => {
    const r = await create({ staffId: "S_004", label: "Dara's default" });
    expect(r.result.record).toMatchObject({ right: "read", personalDetails: false, daysLeft: 90, expiresAt: "2027-02-25T15:00:00.000Z" });
  });

  it.each([
    [{ label: "" }, /label must be 1 to 60 characters/],
    [{ label: "   " }, /label must be 1 to 60 characters/],
    [{ label: "x".repeat(61) }, /label must be 1 to 60 characters/],
    [{ label: "two\nlines" }, /control character/],
    [{ label: 42 }, /label must be text/],
    [{ right: "admin" }, /right must be read or propose/],
    [{ days: 0 }, /days must be a whole number from 1 to 365/],
    [{ days: 366 }, /days must be a whole number from 1 to 365/],
    [{ days: 1.5 }, /days must be a whole number from 1 to 365/],
    [{ days: "30" }, /days must be a whole number from 1 to 365/],
    [{ personalDetails: "yes" }, /personalDetails must be true or false/],
    [{ staffId: "S_404" }, /not an active person/],
    [{ staffId: "S_005" }, /not an active person/],
    [{ staffId: null }, /not an active person/],
  ])("refuses %j", async (change, message) => {
    const before = (await w.owner.one<{ n: number }>("select count(*)::int as n from ops.assistant_keys")).n;
    const r = await create({ staffId: "S_002", label: "Bram's Muse", right: "read", ...change });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(message);
    expect((await w.owner.one<{ n: number }>("select count(*)::int as n from ops.assistant_keys")).n).toBe(before);
  });

  it("a label is unique among that person's live keys only", async () => {
    expect((await create({ staffId: "S_002", label: "Shared label" })).ok).toBe(true);
    const dup = await create({ staffId: "S_002", label: " Shared label " });
    expect(dup.error?.message).toMatch(/already has a working key called Shared label/);
    expect((await create({ staffId: "S_004", label: "Shared label" })).ok).toBe(true); // another person
    const short = await create({ staffId: "S_002", label: "Short one", days: 1 });
    w.clock.now = new Date(NOW.getTime() + 2 * 86_400_000);
    expect((await create({ staffId: "S_002", label: "Short one" })).ok).toBe(true); // the old one expired
    const first = (await w.owner.one<{ key_id: string }>("select key_id from ops.assistant_keys where staff_id = 'S_002' and label = 'Shared label'")).key_id;
    expect((await call("rpcRevokeAssistantKey", [admin(), { keyId: first, reason: "replaced" }])).ok).toBe(true);
    expect((await create({ staffId: "S_002", label: "Shared label" })).ok).toBe(true); // the old one is withdrawn
    expect(short.ok).toBe(true);
  });
});

describe("withdrawing a key", () => {
  it("withdraws, audits once, and is idempotent in effect", async () => {
    const made = (await create({ staffId: "S_003", label: "To withdraw" })).result as { record: { keyId: string } };
    const keyId = made.record.keyId;
    const first = await call("rpcRevokeAssistantKey", [admin(), { keyId, reason: "phone lost" }]);
    expect(first.result).toMatchObject({ keyId, status: "withdrawn", withdrawnReason: "phone lost", withdrawnBy: "Ada Quill" });
    w.clock.now = new Date(NOW.getTime() + 5000);
    const again = await call("rpcRevokeAssistantKey", [admin(), { keyId, reason: "second time" }]);
    expect(again.result).toEqual(first.result);
    const rows = (await audits("assistant_key.revoke")).filter((r) => r.target_id === keyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toBe("phone lost");
  });

  it.each([
    [{ reason: "no" }, /reason must be 3 to 300 characters/],
    [{ reason: "r".repeat(301) }, /reason must be 3 to 300 characters/],
    [{ reason: "bad\u0000reason" }, /control character/],
    [{ keyId: "ak0000000000000000" }, /No such key/],
    [{ keyId: 7 }, /No such key/],
  ])("refuses %j", async (change, message) => {
    const made = (await create({ staffId: "S_003", label: `Refuse ${Math.random()}`.slice(0, 20) })).result as { record: { keyId: string } };
    const r = await call("rpcRevokeAssistantKey", [admin(), { keyId: made.record.keyId, reason: "fine reason", ...change }]);
    expect(r.error?.message).toMatch(message);
    expect((await w.owner.one<{ withdrawn_at: Date | null }>("select withdrawn_at from ops.assistant_keys where key_id = $1", [made.record.keyId])).withdrawn_at).toBeNull();
  });
});

describe("the list", () => {
  it("every key with its person, right, dates, status and calls today; the door's state; the active people", async () => {
    await setDoor(w, true);
    const list = await call("rpcGetAssistantKeys", [admin()]);
    expect(list.result.enabled).toBe(true);
    expect(list.result.people).toEqual([
      { staffId: "S_001", name: "Ada Quill" },
      { staffId: "S_002", name: "Bram Hale" },
      { staffId: "S_003", name: "Cleo Marsh" },
      { staffId: "S_004", name: "Dara Vance" },
    ]);
    for (const k of list.result.keys as Array<Record<string, unknown>>) {
      expect(Object.keys(k).sort()).toEqual(
        ["callsToday", "createdAt", "createdBy", "daysLeft", "expiresAt", "keyId", "label", "lastUsedAt", "personalDetails", "right", "staffId", "staffName", "status", "withdrawnAt", "withdrawnBy", "withdrawnReason"].sort(),
      );
    }
    await setDoor(w, false);
  });

  it("a key whose person is deactivated is listed as such", async () => {
    const made = (await create({ staffId: "S_004", label: "Inactive later" })).result as { record: { keyId: string } };
    await w.owner.query("update ops.staff set active = false where staff_id = 'S_004'");
    const list = await call("rpcGetAssistantKeys", [admin()]);
    expect((list.result.keys as Array<{ keyId: string; status: string }>).find((k) => k.keyId === made.record.keyId)?.status).toBe("person_inactive");
    expect((await create({ staffId: "S_004", label: "Not now" })).error?.message).toMatch(/not an active person/);
  });

  it("no fault was logged by the router in this file", () => {
    expect(errors).toEqual([]);
  });
});

describe("settings", () => {
  it("the three are registered, read the way the door reads them, and listed on the Settings screen", async () => {
    expect(CONFIG_KEYS.assistants_enabled).toEqual({ kind: "setting", read: "boolean", default: "false" });
    expect(CONFIG_KEYS.assistant_calls_per_minute).toEqual({ kind: "setting", read: "number", default: "30" });
    expect(CONFIG_KEYS.assistant_proposals_per_day).toEqual({ kind: "setting", read: "number", default: "200" });
    const listed = await withTransaction(w.db, (tx) => settings.list(tx, {}));
    const mine = listed.settings.filter((s) => s.key.startsWith("assistant"));
    expect(mine.map((s) => [s.key, s.group])).toEqual([
      ["assistants_enabled", "Assistants"],
      ["assistant_calls_per_minute", "Assistants"],
      ["assistant_proposals_per_day", "Assistants"],
      ["assistant_show_max_mb", "Assistants"],
    ]);
  });

  it.each([
    ["assistant_calls_per_minute", "0", /whole number from 1 to 600/],
    ["assistant_calls_per_minute", "601", /whole number from 1 to 600/],
    ["assistant_proposals_per_day", "5001", /whole number from 1 to 5000/],
    ["assistants_enabled", "yes", /true or false/],
  ])("refuses %s = %s", async (key, value, message) => {
    await expect(withTransaction(w.db, (tx) => settings.update(tx, { key, value, actorId: "S_001" }, { now: NOW }))).rejects.toThrow(message);
  });

  it("turning the door on is an ordinary audited setting change", async () => {
    await withTransaction(w.db, (tx) => settings.update(tx, { key: "assistants_enabled", value: "true", actorId: "S_001" }, { now: NOW }));
    expect((await audits("config.update")).at(-1)).toMatchObject({ actor_id: "S_001", target_id: "assistants_enabled" });
    await setDoor(w, false);
  });
});

describe("structure", () => {
  const dir = new URL("../src/mcp/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it("src/mcp has the five files of the card", () => {
    expect(files.sort()).toEqual(["data.ts", "keys.ts", "limits.ts", "server.ts", "tools.ts"]);
  });

  it("nothing under src/mcp imports the RPC registry or router, or any RPC handler", () => {
    for (const f of files) {
      const text = readFileSync(new URL(f, dir), "utf8");
      const imports = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] as string);
      for (const i of imports) expect(/rpc\/(registry|router|handlers)/.test(i), `${f} imports ${i}`).toBe(false);
    }
  });

  it("no handler in tools.ts is given the raw Request", () => {
    const text = readFileSync(new URL("tools.ts", dir), "utf8");
    expect(text).not.toMatch(/\bRequest\b/);
  });
});
