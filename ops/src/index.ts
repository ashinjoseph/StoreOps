// The Worker's entry. One fetch handler, three destinations:
//
//   /health          the service and one trivial database query
//   /rpc/*           the RPC router (contract, handlers, a real database connection)
//   everything else  the static assets: the built page and its script
//
// Every answer leaves with the same security headers, whoever produced it.
// The page is never framed (the old app had to allow framing because Apps
// Script wraps it in an iframe; this one does not). There is deliberately no
// script-src policy yet: the page is one large inline script.
import rpcContractJson from "../contracts/rpc.json";
import { runWeeklyCommissions } from "./cron";
import { connect } from "./db/client";
import { notFound } from "./router";
import { parseRpcContract, type RpcContract } from "./rpc/contract";
import { ERROR_PREFIXED, handlers, resolveSession } from "./rpc/registry";
import { createRpcRouter } from "./rpc/router";

export interface Env {
  /** Static assets (wrangler [assets]). Absent in unit tests or when misconfigured. */
  ASSETS?: { fetch(request: Request): Promise<Response> };
  /** Cloudflare Hyperdrive: the database connection in a deployed Worker. */
  HYPERDRIVE?: { connectionString: string };
  /** A direct connection string (local development, tests). */
  OPS_DB_APP_URL?: string;
  PIN_PEPPER?: string;
  [binding: string]: unknown;
}

/** No database is configured for this Worker. Never carries a connection string. */
export class DbNotConfiguredError extends Error {
  constructor() {
    super("no database configured: bind HYPERDRIVE or set OPS_DB_APP_URL");
    this.name = "DbNotConfiguredError";
  }
}

export function connectionString(env: Env): string {
  const hyperdrive = env.HYPERDRIVE;
  if (hyperdrive !== undefined && typeof hyperdrive.connectionString === "string" && hyperdrive.connectionString !== "") return hyperdrive.connectionString;
  const direct = env.OPS_DB_APP_URL;
  if (typeof direct === "string" && direct !== "") return direct;
  throw new DbNotConfiguredError();
}

/** How many times the contract was parsed and a router built (for tests: both stay put after the first call). */
export const buildCounts = { contract: 0, router: 0 };

type RpcHandle = (request: Request) => Promise<Response>;

let contract: RpcContract | undefined;
const routers = new WeakMap<object, RpcHandle>();

/** Built once per isolate: a Worker's env object is the same for every request it serves. */
function rpcRouter(env: Env): RpcHandle {
  let router = routers.get(env);
  if (router === undefined) {
    if (contract === undefined) {
      contract = parseRpcContract(rpcContractJson);
      buildCounts.contract++;
    }
    router = createRpcRouter({
      contract,
      handlers,
      resolveSession,
      errorPrefixed: ERROR_PREFIXED,
      env,
      openDb: async () => connect(connectionString(env)),
    });
    routers.set(env, router);
    buildCounts.router++;
  }
  return router;
}

const HEALTH_TIMEOUT_MS = 2000;

/** True when `select 1` answers within the timeout. Never throws; says nothing about why it failed. */
async function databaseUp(env: Env): Promise<boolean> {
  let conn: Awaited<ReturnType<typeof connect>> | undefined;
  const attempt = (async () => {
    conn = await connect(connectionString(env));
    await conn.query("select 1");
  })();
  // A connection that finishes opening after the timeout must still be closed.
  const settled = attempt.finally(() => conn?.close().catch(() => undefined));
  settled.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), HEALTH_TIMEOUT_MS);
  });
  try {
    await Promise.race([settled, timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function health(env: Env): Promise<Response> {
  return (await databaseUp(env))
    ? json({ ok: true, service: "storeops-ops", db: "ok" }, 200)
    : json({ ok: false, service: "storeops-ops", db: "down" }, 503);
}

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "no-referrer"],
  ["x-frame-options", "DENY"],
  ["content-security-policy", "frame-ancestors 'none'"],
];

/** A copy of `res` with the security headers set (a response from another handler may have immutable headers). */
function secure(res: Response, path: string): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);
  const isPage = path === "/" || path.endsWith(".html") || (headers.get("content-type") ?? "").toLowerCase().includes("text/html");
  if (isPage) headers.set("cache-control", "no-store");
  else if (path === "/transport.js" && !headers.has("cache-control")) headers.set("cache-control", "public, max-age=300");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/rpc/")) return rpcRouter(env)(request);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: { code: "method_not_allowed", message: "Only GET and HEAD." } }, 405);
  }
  if (pathname === "/health") return health(env);
  if (env.ASSETS === undefined) return notFound();
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, _ctx?: unknown): Promise<Response> {
    return secure(await route(request, env), new URL(request.url).pathname);
  },
  /**
   * The Monday commission cron (wrangler.toml [triggers]). It is scheduled for both UTC hours that can be
   * 09:00 in Toronto; runWeeklyCommissions does nothing unless this one is. It throws when the run fails,
   * so Cloudflare records the failure.
   */
  async scheduled(controller: { scheduledTime: number; cron?: string }, env: Env, _ctx?: unknown): Promise<void> {
    await runWeeklyCommissions({
      openDb: async () => connect(connectionString(env)),
      now: () => new Date(controller.scheduledTime),
      env,
      fetch: (input, init) => fetch(input, init),
      log: (entry) => console.error(entry),
    });
  },
};
