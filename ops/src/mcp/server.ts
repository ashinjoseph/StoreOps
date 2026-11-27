// The MCP door: POST /mcp (card P5-11; ADR-0025). One function, handleMcp(request, deps).
//
// What it does, in order, for every request:
//   1. one database connection; read the settings. The door is off (assistants_enabled is not true), or
//      the database cannot be reached: 404 with an empty body, whatever the request, and no write.
//   2. not POST: 405 (Allow: POST). The server keeps no session and no stream open, so GET and DELETE
//      have nothing to serve.
//   3. an Origin header: 403. An assistant's servers send none; a web page always does. No CORS header
//      is ever sent, so no page can read an answer either.
//   4. the body: over 64 KB (by Content-Length, or while reading) is 413, before anything is parsed.
//   5. the key (Authorization: Bearer ops_<id>_<secret>): any refusal is the same 401, same body, same
//      headers, the same work done. The reason goes into ops.assistant_calls, up to the flood limits.
//   6. one JSON-RPC message (a batch is refused) handed to the official SDK's web-standard Streamable
//      HTTP transport, stateless (no session id) and answering with JSON (no event stream), and a new
//      low-level SDK Server for this request whose two handlers are below: tools/list (the tools the
//      key's right allows) and tools/call (everything a call must pass, recorded).
//
// A tool call, inside one transaction that holds the key's row lock: the key is still usable; the
// per-minute limit; the tool is on the allowlist; the key's right covers it; the arguments fit its
// schema; a proposal's daily cap; then the tool runs, the call is recorded and the key marked used, all
// committed together. The answer is one text block, and for the one tool that shows a receipt original
// (FILE_TOOLS in tools.ts) one file block after it; a tool's own error ("no such original") is a tool
// error, recorded as allowed. A handler is given the request's origin (to build an upload address) and
// the receipt storage, never the request itself. A refusal is recorded and answered as a tool error with a readable message (an
// unknown tool as the protocol's "invalid params" error). A tool that throws is rolled back, answered
// with a fixed message, and recorded as failed in a transaction of its own.
//
// Nothing here imports the RPC registry or router: the allowlist (tools.ts) is the only way in.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/types.js";
import { z } from "zod";
import type { Db } from "../db/client";
import { withTransaction } from "../db/tx";
import { loadConfig, type Config } from "../lib/config";
import { asData, toolText } from "./data";
import * as keys from "./keys";
import { callerHash, callsPerMinute, checkCallLimit, checkProposalLimit, floodAllows, proposalsPerDay, recordCall, type Refusal } from "./limits";
import { DATA_SENTENCE, FILE_TOOLS, TOOLS, rightAllows, type ToolDef, type ToolFile } from "./tools";
import type { ReceiptStorage } from "../receipts/storage";

export interface McpDeps {
  /** One connection per request; the door closes it. */
  openDb: () => Promise<Db & { close(): Promise<void> }>;
  /** The clock. Read at the start of a request and when a call's time is measured. */
  now: () => Date;
  /** Tests only: tools added after the allowlist. The Worker never passes this. */
  tools?: readonly ToolDef[];
  /** Where receipt originals are kept (the RECEIPTS binding); null or absent when it is not bound. */
  storage?: ReceiptStorage | null;
  /** One entry per fault: the tool's name and the error's class, never a message, argument or key. */
  log?: (entry: object) => void;
}

export const MAX_BODY_BYTES = 64 * 1024;
export const SERVER_NAME = "storeops-operations";

const NO_STORE = { "cache-control": "no-store" } as const;
const UNAUTHORIZED_BODY = JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });

const empty = (status: number, extra: Record<string, string> = {}): Response => new Response(null, { status, headers: { ...NO_STORE, ...extra } });
const jsonError = (status: number, code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), { status, headers: { ...NO_STORE, "content-type": "application/json" } });
const unauthorized = (): Response =>
  new Response(UNAUTHORIZED_BODY, { status: 401, headers: { ...NO_STORE, "content-type": "application/json", "www-authenticate": 'Bearer realm="storeops"' } });

/** The body's bytes, or null once it passes the cap (reading stops there, whatever Content-Length claimed). */
async function readBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const NOT_JSON = Symbol("not json");
function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return NOT_JSON;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What the record calls this request: the tool's name for tools/call, else the method; "-" when there is neither. */
function toolNameOf(message: unknown): string {
  if (!isObject(message)) return "-";
  const method = typeof message["method"] === "string" ? message["method"] : "";
  const params = message["params"];
  if (method === "tools/call" && isObject(params) && typeof params["name"] === "string") return asData(params["name"], 100) || "-";
  return asData(method, 100) || "-";
}

/** The SDK's server would otherwise build an Ajv validator, which compiles code at run time (refused in a Worker). The door never asks a client for input, so nothing is ever validated by it. */
const NO_VALIDATOR: jsonSchemaValidator = {
  getValidator() {
    throw new Error("the MCP door validates no client-supplied schema");
  },
};

const INSTRUCTIONS =
  "Tools over the store's Operations app. An assistant may read a few things and propose a few things; a proposal changes nothing until a person confirms it on a screen. " +
  "Dates are Toronto days (YYYY-MM-DD). Each answer is one line of summary, then JSON. " +
  DATA_SENTENCE;

const toolError = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });
const FAILED = "The tool failed; nothing was changed. Try again later.";

function badInputMessage(name: string, error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((i) => `${i.path.length > 0 ? i.path.join(".") : "arguments"}: ${i.message}`);
  return asData(`Bad input for ${name}: ${parts.join("; ")}`, 400);
}

interface CallScope {
  conn: Db;
  key: keys.KeyInfo;
  config: Config;
  caller: Uint8Array;
  deps: McpDeps;
  tools: ReadonlyMap<string, ToolDef>;
  /** The request's own origin (scheme, host, port): the one thing of the request a tool is given. */
  origin: string;
}

/** Base64 of `bytes`, built a slice at a time (a spread of millions of arguments would overflow the stack). */
function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let at = 0; at < bytes.length; at += 0x8000) bin += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(bin);
}

/**
 * The one file block a tool may add after its text (only the tools in FILE_TOOLS): an image block for
 * a photo, an embedded resource with a blob for a PDF.
 */
function fileBlock(file: ToolFile): CallToolResult["content"][number] {
  const data = base64(file.bytes);
  if (file.contentType === "application/pdf") return { type: "resource", resource: { uri: file.uri, mimeType: file.contentType, blob: data } };
  return { type: "image", data, mimeType: file.contentType };
}

type Outcome = { kind: "result"; result: CallToolResult } | { kind: "unknown"; name: string } | { kind: "failed"; tool: ToolDef; err: unknown };

async function callTool(scope: CallScope, name: string, rawArgs: unknown): Promise<CallToolResult> {
  const { conn, deps, caller } = scope;
  const started = deps.now();
  const keyId = scope.key.keyId;
  const tool = scope.tools.get(name);
  const proposal = tool?.right === "propose";
  const recordName = asData(name, 100) || "-";
  const elapsed = () => deps.now().getTime() - started.getTime();

  let outcome: Outcome;
  try {
    outcome = await withTransaction(conn, async (tx): Promise<Outcome> => {
      const refuse = async (refusal: Refusal, message: string, asProposal = proposal): Promise<Outcome> => {
        await recordCall(tx, { keyId, tool: recordName, at: started, allowed: false, refusal, tookMs: elapsed(), proposal: asProposal, callerHash: caller });
        return { kind: "result", result: toolError(message) };
      };
      const locked = await keys.lockKey(tx, keyId, started);
      if (!locked.ok) return refuse(locked.reason, "This key no longer works.");
      const perMinute = await checkCallLimit(tx, keyId, started, callsPerMinute(scope.config));
      if (!perMinute.ok) return refuse("rate_limited", perMinute.message);
      if (tool === undefined) {
        await recordCall(tx, { keyId, tool: recordName, at: started, allowed: false, refusal: "unknown_tool", tookMs: elapsed(), proposal: false, callerHash: caller });
        return { kind: "unknown", name: recordName };
      }
      if (!rightAllows(locked.key.right, tool.right)) {
        return refuse("no_right", `This key may only read; ${tool.name} makes a proposal. Ask an admin for a key that may propose.`);
      }
      const parsed = tool.input.safeParse(rawArgs ?? {});
      if (!parsed.success) return refuse("bad_input", badInputMessage(tool.name, parsed.error));
      if (proposal) {
        const perDay = await checkProposalLimit(tx, keyId, started, proposalsPerDay(scope.config));
        if (!perDay.ok) return refuse("rate_limited", perDay.message);
      }
      let answer;
      try {
        answer = await tool.run(
          { db: tx, key: locked.key, now: started, config: scope.config, origin: scope.origin, storage: scope.deps.storage ?? null },
          parsed.data as Record<string, unknown>,
        );
        // One text block; and for the tools in FILE_TOOLS only, one file block after it. Any other tool
        // that answers a file has failed (rolled back, answered with the fixed message).
        if ("file" in answer && answer.file !== undefined && !FILE_TOOLS.includes(tool.name)) throw new TypeError(`${tool.name} may not answer a file`);
      } catch (err) {
        // Leave the transaction by throwing, so everything the tool wrote is rolled back.
        throw new ToolFailed(tool, err);
      }
      await recordCall(tx, { keyId, tool: tool.name, at: started, allowed: true, refusal: null, tookMs: elapsed(), proposal, callerHash: caller });
      await keys.markUsed(tx, keyId, started);
      if ("error" in answer) return { kind: "result", result: toolError(asData(answer.error, 400)) };
      const content: CallToolResult["content"] = [{ type: "text", text: toolText(answer.summary, answer.data) }];
      if (answer.file !== undefined) content.push(fileBlock(answer.file));
      return { kind: "result", result: { content } };
    });
  } catch (err) {
    const failedTool = err instanceof ToolFailed ? err.tool : tool;
    outcome = { kind: "failed", tool: failedTool as ToolDef, err: err instanceof ToolFailed ? err.cause : err };
  }

  if (outcome.kind === "unknown") throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${outcome.name}`);
  if (outcome.kind === "result") return outcome.result;

  // A fault: log its class only, record it in a transaction of its own, answer a fixed message.
  try {
    (deps.log ?? (() => undefined))({ mcp: recordName, errorClass: outcome.err instanceof Error ? outcome.err.constructor.name : typeof outcome.err });
  } catch {
    // a failing logger must not hide the answer
  }
  await withTransaction(conn, (tx) =>
    recordCall(tx, { keyId, tool: recordName, at: started, allowed: false, refusal: "failed", tookMs: elapsed(), proposal, callerHash: caller }),
  ).catch(() => undefined);
  return toolError(FAILED);
}

class ToolFailed extends Error {
  readonly tool: ToolDef;
  constructor(tool: ToolDef, cause: unknown) {
    super("tool failed", { cause });
    this.tool = tool;
  }
}

function buildServer(scope: CallScope): Server {
  const server = new Server({ name: SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS, jsonSchemaValidator: NO_VALIDATOR });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...scope.tools.values()]
      .filter((t) => rightAllows(scope.key.right, t.right))
      .map((t) => {
        const { $schema: _drop, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
        return { name: t.name, title: t.title, description: t.description, inputSchema: { ...schema, type: "object" as const } };
      }),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => callTool(scope, req.params.name, req.params.arguments));
  return server;
}

/** The door. See the header for what it does. */
export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  const now = deps.now();
  let conn: Db & { close(): Promise<void> };
  try {
    conn = await deps.openDb();
  } catch {
    return empty(404); // cannot tell whether the door is on: it is shut
  }
  try {
    let config: Config;
    try {
      config = await withTransaction(conn, (tx) => loadConfig(tx));
    } catch {
      return empty(404);
    }
    if (!config.boolean("assistants_enabled")) return empty(404);
    if (request.method !== "POST") return empty(405, { allow: "POST" });
    if (request.headers.has("origin")) return empty(403);

    const bytes = await readBody(request);
    if (bytes === null) return empty(413);
    const message = parseJson(bytes);
    const caller = await callerHash(request.headers.get("cf-connecting-ip"));

    const auth = await withTransaction(conn, async (tx) => {
      const r = await keys.authenticate(tx, request.headers.get("authorization"), now);
      if (!r.ok && (await floodAllows(tx, caller, now))) {
        await recordCall(tx, { keyId: r.keyId, tool: toolNameOf(message), at: now, allowed: false, refusal: r.reason, tookMs: deps.now().getTime() - now.getTime(), proposal: false, callerHash: caller });
      }
      return r;
    });
    if (!auth.ok) return unauthorized();

    if (message === NOT_JSON) return jsonError(400, -32700, "Parse error: the body is not JSON");
    if (Array.isArray(message)) return jsonError(400, -32600, "Batches are not accepted: send one message per request");

    const all = [...TOOLS, ...(deps.tools ?? [])];
    const tools = new Map<string, ToolDef>();
    for (const t of all) if (!tools.has(t.name)) tools.set(t.name, t);
    const server = buildServer({ conn, key: auth.key, config, caller, deps, tools, origin: new URL(request.url).origin });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY_BYTES });
    await server.connect(transport);
    try {
      const res = await transport.handleRequest(request, { parsedBody: message });
      const headers = new Headers(res.headers);
      headers.set("cache-control", "no-store");
      return new Response(await res.text(), { status: res.status, headers });
    } finally {
      await server.close().catch(() => undefined);
    }
  } finally {
    await conn.close().catch(() => undefined);
  }
}
