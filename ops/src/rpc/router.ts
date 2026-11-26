// The RPC router: POST /rpc/<name>, body {"args": [...]}.
//
// The contract (ops/contracts/rpc.json) is the rule book. For every call the
// router resolves the session and applies the contract's role rule BEFORE any
// handler runs; a handler never sees the token and cannot widen its own access
// (AGENTS.md hard rule 5: identity and role come from the session only).
//
// Order of a call:
//   1. method, path, body size and JSON shape      -> 405 / 400 / 404   (no database yet)
//   2. contract lookup                              -> 404 / 404 NOT_MIGRATED / 501 NOT_PORTED
//   3. one connection, one transaction for the rest; the connection is always closed
//   4. session (when the contract says so), then role check
//   5. the handler, with the token taken off the front of the arguments
//   6. returned -> commit -> 200; threw -> roll back -> error answer
//
// What the page may read: a plain `Error` (thrown by a handler, by
// resolveSession or by the role check) is a message for the person and goes
// out unchanged with HTTP 200. Anything else is a fault: it is logged once
// (RPC name, request id, error class, message; never arguments, token or
// session) and the page gets the fixed message SERVER_ERROR and the id.
import type { Db } from "../db/client";
import { withTransaction, type Tx } from "../db/tx";
import { loadConfig, type Config } from "../lib/config";
import type { Session } from "../auth/types";
import type { RpcContract } from "./contract";
import type { RpcContext, RpcHandlers } from "./types";

export interface RpcRouterDeps {
  contract: RpcContract;
  handlers: RpcHandlers;
  /** One connection per call; the router closes it. */
  openDb: () => Promise<Db & { close(): Promise<void> }>;
  /** Throws Error(NOT_LOGGED_IN) for a missing, unknown or expired token. Runs inside the call's transaction. */
  resolveSession: (db: Tx, token: unknown, now: Date) => Promise<Session>;
  /** The Worker's bindings, passed through to handlers. */
  env: Readonly<Record<string, unknown>>;
  /** RPC names whose readable errors go out as "<name>: <message>", as their old functions wrapped them. */
  errorPrefixed?: ReadonlySet<string>;
  /** Outbound HTTP handed to handlers as `ctx.fetch`. Default: the runtime's own `fetch`. */
  fetch?: typeof fetch;
  /** The clock, read once per call. Default: the real time (the only place it is read). */
  now?: () => Date;
  /** Receives one entry per fault. Default: console.error. */
  log?: (entry: object) => void;
  /** A fresh id for each fault. Default: a random UUID. */
  requestId?: () => string;
}

const MAX_BODY_BYTES = 1024 * 1024;
const PREFIX = "/rpc/";

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
} as const;

function reply(status: number, body: string, extra?: Record<string, string>): Response {
  return new Response(body, { status, headers: { ...HEADERS, ...extra } });
}
function failure(status: number, message: string, extra?: { id?: string }, headers?: Record<string, string>): Response {
  return reply(status, JSON.stringify({ ok: false, error: { message, ...(extra?.id !== undefined ? { id: extra.id } : {}) } }), headers);
}

/** The body's bytes, or null once it passes the limit (reading stops there, whatever content-length claimed). */
async function readBody(request: Request): Promise<Uint8Array | null> {
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

/** The arguments array, or null when the body is not `{"args": [...]}`. */
function parseArgs(bytes: Uint8Array): unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const args = (parsed as Record<string, unknown>)["args"];
  return Array.isArray(args) ? (args as unknown[]) : null;
}

// Messages `withTransaction` throws as plain Errors that mean "the code is wrong", not "tell the person".
const INTERNAL_MESSAGES = ["transaction rolled back:", "this transaction has finished", "withTransaction cannot be nested"];

/** A message meant for the person: exactly an `Error` (not a subclass such as DbError, TypeError or ValueError), and not one of the transaction's own. */
function isReadable(err: unknown): err is Error {
  if (!(err instanceof Error) || Object.getPrototypeOf(err) !== Error.prototype) return false;
  return !INTERNAL_MESSAGES.some((m) => err.message.startsWith(m));
}

function describe(err: unknown): { errorClass: string; message: string } {
  if (err instanceof Error) {
    const ctor: unknown = Object.getPrototypeOf(err)?.constructor;
    const name = typeof ctor === "function" && ctor.name ? ctor.name : err.name;
    return { errorClass: name, message: err.message };
  }
  return { errorClass: err === null ? "null" : typeof err, message: "" };
}

class Unserialisable extends Error {}

export function createRpcRouter(deps: RpcRouterDeps): (request: Request) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  const log = deps.log ?? ((entry: object) => console.error(entry));
  const newId = deps.requestId ?? (() => crypto.randomUUID());

  function fault(rpc: string, err: unknown): Response {
    const id = newId();
    try {
      log({ rpc, id, ...describe(err) });
    } catch {
      // A failing logger must not turn a fault into a crash.
    }
    return failure(500, "SERVER_ERROR", { id });
  }

  return async function handle(request: Request): Promise<Response> {
    // 1. Method, path, body.
    if (request.method !== "POST") return failure(405, "METHOD_NOT_ALLOWED", undefined, { allow: "POST" });
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(PREFIX)) return failure(404, "NOT_FOUND");
    const name = pathname.slice(PREFIX.length);
    const bytes = await readBody(request);
    if (bytes === null) return failure(400, "BAD_REQUEST");
    const args = parseArgs(bytes);
    if (args === null) return failure(400, "BAD_REQUEST");

    // 2. The contract decides what exists. The name is only ever a Map key, never a property name.
    const entry = deps.contract.get(name);
    if (entry === undefined) return failure(404, "NOT_FOUND");
    if (!entry.migrate) return failure(404, "NOT_MIGRATED");
    const handler = Object.hasOwn(deps.handlers, name) ? deps.handlers[name] : undefined;
    if (typeof handler !== "function") return failure(501, "NOT_PORTED");

    // 3. One connection, one transaction.
    let conn: Db & { close(): Promise<void> };
    try {
      conn = await deps.openDb();
    } catch (err) {
      return fault(name, err);
    }
    try {
      const now = clock();
      const body = await withTransaction(conn, async (tx) => {
        // 4. Session, then the contract's role rule: no handler code has run yet.
        let session: Session | null = null;
        if (entry.needs_session) {
          session = await deps.resolveSession(tx, args[0], now);
          if (typeof session !== "object" || session === null) throw new TypeError("resolveSession returned no session");
          if (entry.roles !== null && !entry.roles.includes(session.role)) {
            throw new Error(`FORBIDDEN: requires ${entry.roles.join(" or ")}, got ${session.role}`);
          }
        }

        // 5. The handler gets the arguments without the token.
        let config: Promise<Config> | undefined;
        const ctx: RpcContext = {
          db: tx,
          session,
          config: () => (config ??= loadConfig(tx)),
          env: deps.env,
          fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
          now,
        };
        const rest = entry.needs_session ? args.slice(1) : args;
        const result = await handler(ctx, ...rest);

        // Serialise before commit: a result that cannot be sent must not be kept.
        const text = JSON.stringify(result === undefined ? null : result);
        if (typeof text !== "string") throw new Unserialisable("result is not JSON"); // a function or symbol
        return `{"ok":true,"result":${text}}`;
      });
      return reply(200, body);
    } catch (err) {
      if (isReadable(err)) return failure(200, deps.errorPrefixed?.has(name) ? `${name}: ${err.message}` : err.message);
      return fault(name, err);
    } finally {
      await conn.close().catch(() => undefined);
    }
  };
}
