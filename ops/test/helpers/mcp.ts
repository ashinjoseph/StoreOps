// Shared set-up for the MCP door's tests (card P5-11): a real database with invented people, a
// clock the test moves, and the SDK's OWN client talking to handleMcp over an in-memory fetch, so
// protocol compatibility is checked by the official client and not by hand-built JSON.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { setPin } from "../../src/auth/pin";
import { connect, type Db } from "../../src/db/client";
import { withTransaction } from "../../src/db/tx";
import * as keys from "../../src/mcp/keys";
import { handleMcp, type McpDeps } from "../../src/mcp/server";
import type { ToolDef } from "../../src/mcp/tools";
import { createTestDb, type TestDb } from "./db";

export const PEPPER = "test-pepper-not-a-secret";
export const MCP_URL = "https://ops.test/mcp";

/** Invented people only. [id, name, role, active, pin] */
export const STAFF: Array<[string, string, string, boolean, string]> = [
  ["S_001", "Ada Quill", "admin", true, "1111"],
  ["S_002", "Bram Hale", "manager", true, "2222"],
  ["S_003", "Cleo Marsh", "employee", true, "3333"],
  ["S_004", "Dara Vance", "payroll_admin", true, "4444"],
  ["S_005", "Eli Stone", "employee", false, "5555"],
];

export interface McpWorld {
  testDb: TestDb;
  /** As the app (ops_app). */
  db: Db & { close(): Promise<void> };
  /** As the owner: for planting and for reading everything. */
  owner: Db & { close(): Promise<void> };
  clock: { now: Date };
  /** Every response handleMcp gave, for header checks. */
  responses: Response[];
  /** Extra tools (test-only) the next requests see beside the real ones. */
  extraTools: ToolDef[];
  deps(): McpDeps;
  /** handleMcp over an in-memory fetch. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  close(): Promise<void>;
}

export async function makeWorld(start: Date): Promise<McpWorld> {
  const testDb = await createTestDb();
  const db = await connect(testDb.appUrl);
  const owner = await connect(testDb.ownerUrl);
  for (const [id, name, role, active, pin] of STAFF) {
    await owner.query("insert into ops.staff (staff_id, name, active, role, companies_authorized) values ($1, $2, $3, $4, 'cstore,vape')", [id, name, active, role]);
    await setPin(db, id, pin, PEPPER);
  }
  const world: McpWorld = {
    testDb,
    db,
    owner,
    clock: { now: start },
    responses: [],
    extraTools: [],
    deps() {
      return {
        openDb: () => connect(testDb.appUrl),
        now: () => world.clock.now,
        ...(world.extraTools.length > 0 ? { tools: world.extraTools } : {}),
      };
    },
    async fetch(input, init) {
      const req = input instanceof Request ? input : new Request(input, init);
      const res = await handleMcp(req, world.deps());
      // Status and headers only: a clone would tee the body, and cancelling one branch of a tee
      // waits for the other (the SDK client cancels the body of a 202).
      world.responses.push(new Response(null, { status: res.status, headers: res.headers }));
      return res;
    },
    async close() {
      await db.close();
      await owner.close();
      await testDb.drop();
    },
  };
  return world;
}

export async function setDoor(w: McpWorld, on: boolean): Promise<void> {
  await w.owner.query("insert into ops.config (key, value) values ('assistants_enabled', $1) on conflict (key) do update set value = excluded.value", [on ? "true" : "false"]);
}

export async function setConfig(w: McpWorld, key: string, value: string | null): Promise<void> {
  await w.owner.query("insert into ops.config (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value", [key, value]);
}

/** Make a key through the module, as an admin would, at the world's time. */
export async function makeKey(
  w: McpWorld,
  input: Partial<{ staffId: string; label: string; right: string; personalDetails: boolean; days: number }> = {},
): Promise<{ key: string; keyId: string }> {
  const made = await withTransaction(w.db, (tx) =>
    keys.createKey(
      tx,
      { staffId: input.staffId ?? "S_003", label: input.label ?? `Key ${Math.random().toString(36).slice(2, 8)}`, right: input.right ?? "read", personalDetails: input.personalDetails ?? false, days: input.days ?? 90, actorId: "S_001" },
      { now: w.clock.now },
    ),
  );
  return { key: made.key, keyId: made.record.keyId };
}

/** The SDK's own client, connected through handleMcp. `headers` go on every request it sends. */
export async function sdkClient(w: McpWorld, key: string | null, headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: "storeops-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (input, init) => w.fetch(input as string | URL, init),
    requestInit: { headers: { ...(key === null ? {} : { authorization: `Bearer ${key}` }), ...headers } },
  });
  await client.connect(transport);
  return client;
}

/** The one text block of a tool result. */
export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  if (content.length !== 1 || content[0]?.type !== "text") throw new Error(`expected one text block, got ${JSON.stringify(content)}`);
  return content[0].text ?? "";
}

/** The JSON after the summary line. */
export function jsonOf(result: unknown): Record<string, unknown> {
  const text = textOf(result);
  const nl = text.indexOf("\n");
  return JSON.parse(text.slice(nl + 1)) as Record<string, unknown>;
}

export interface CallRow {
  seq: number;
  key_id: string | null;
  tool: string;
  at: Date;
  allowed: boolean;
  refusal: string | null;
  took_ms: number | null;
  proposal: boolean;
}
export const calls = (w: McpWorld): Promise<CallRow[]> =>
  w.owner.query<CallRow>("select seq, key_id, tool, at, allowed, refusal, took_ms, proposal from ops.assistant_calls order by seq");
export const callCount = async (w: McpWorld): Promise<number> => (await w.owner.one<{ n: number }>("select count(*)::int as n from ops.assistant_calls")).n;

/** A raw POST to the door with a JSON-RPC body, as an assistant would send it. */
export function rawPost(w: McpWorld, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return w.fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export const TOOLS_CALL = (name: string, args: Record<string, unknown> = {}, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
