// The Worker's entry. One fetch handler, four destinations:
//
//   GET|HEAD /?v=recon, /?v=sales   the two public pages (public/pages.ts): no session, the payload
//                                   built in one read-only transaction and inlined (ADR-0003)
//   /health                         the service and one trivial database query
//   /rpc/*                          the RPC router (contract, handlers, a real database connection)
//   /mcp                            the door for AI assistants (mcp/server.ts; ADR-0025): off unless the
//                                   setting assistants_enabled is true; a key, not a session
//   /files/receipt-original[/<id>]  receipt originals (receipts/routes.ts; ADR-0026): PUT adds one, GET
//                                   sends one back; the page's session as a bearer header, never a URL
//   /files/receipt-original/by-ticket/<ticket>
//                                   an assistant's original (receipts/routes.ts; card P5-12b): PUT only,
//                                   the one-time ticket is the only credential
//   everything else                 the static assets: the built page and its script (so / with any
//                                   other v, or none, is the app page, as before)
//
// Every answer leaves with the same security headers, whoever produced it.
// The page is never framed (the old app had to allow framing because Apps
// Script wraps it in an iframe; this one does not). There is deliberately no
// script-src policy for the app page yet: it is one large inline script. The
// public pages carry their own policy (one script, by hash; see secure()).
import rpcContractJson from "../contracts/rpc.json";
import rpcOpsJson from "../contracts/rpc-ops.json";
import { runWeeklyCommissions } from "./cron";
import { isBackupCron, runScheduledBackup } from "./backup/nightly";
import { backupStorage, isBackupBucket } from "./backup/storage";
import { connect } from "./db/client";
import { connectionString, DbNotConfiguredError } from "./db/connection";
import { handleMcp } from "./mcp/server";
import { handlePublic, publicView } from "./public/pages";
import { handleTicketUpload, handleUpload, handleView, UPLOAD_PATH, VIEW_CSP, VIEW_PREFIX, type ReceiptRouteDeps } from "./receipts/routes";
import { bucketStorage, isBucket } from "./receipts/storage";
import { TICKET_PREFIX } from "./receipts/tickets";
import { notFound } from "./router";
import { mergeOpsContract, parseRpcContract, type RpcContract } from "./rpc/contract";
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
  /** Cloudflare R2: the bucket receipt originals are kept in (wrangler.toml [[r2_buckets]]). */
  RECEIPTS?: unknown;
  /** Cloudflare R2: the bucket the nightly copy is written to (wrangler.toml [[r2_buckets]]; card P4-06a). */
  BACKUPS?: unknown;
  [binding: string]: unknown;
}

export { connectionString, DbNotConfiguredError };

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
      contract = parseRpcContract(mergeOpsContract(rpcContractJson, rpcOpsJson));
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

/**
 * A copy of `res` with the security headers set (a response from another handler may have immutable headers).
 * `policy.csp` replaces the default content-security-policy for this one response (the public pages:
 * their one inline script, by hash); it is never taken from the response itself.
 */
function secure(res: Response, path: string, policy: { csp?: string } = {}): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of SECURITY_HEADERS) headers.set(name, value);
  if (policy.csp !== undefined) headers.set("content-security-policy", policy.csp);
  const isPage = path === "/" || path.endsWith(".html") || (headers.get("content-type") ?? "").toLowerCase().includes("text/html");
  if (isPage) headers.set("cache-control", "no-store");
  else if (path === "/transport.js" && !headers.has("cache-control")) headers.set("cache-control", "public, max-age=300");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function receiptDeps(env: Env): ReceiptRouteDeps {
  return {
    openDb: async () => connect(connectionString(env)),
    resolveSession,
    storage: isBucket(env.RECEIPTS) ? bucketStorage(env.RECEIPTS) : null,
    now: () => new Date(),
    log: (entry) => console.error(entry),
  };
}

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/rpc/")) return rpcRouter(env)(request);
  if (pathname === UPLOAD_PATH) return handleUpload(request, receiptDeps(env));
  if (pathname.startsWith(TICKET_PREFIX)) return handleTicketUpload(request, receiptDeps(env));
  if (pathname.startsWith(VIEW_PREFIX)) return handleView(request, receiptDeps(env));
  if (pathname === "/mcp") {
    return handleMcp(request, {
      openDb: async () => connect(connectionString(env)),
      now: () => new Date(),
      log: (entry) => console.error(entry),
      storage: isBucket(env.RECEIPTS) ? bucketStorage(env.RECEIPTS) : null,
    });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: { code: "method_not_allowed", message: "Only GET and HEAD." } }, 405);
  }
  if (pathname === "/health") return health(env);
  if (env.ASSETS === undefined) return notFound();
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, _ctx?: unknown): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (publicView(request) !== null) {
      const { response, csp } = await handlePublic(request, env, {
        openDb: async () => connect(connectionString(env)),
        now: () => new Date(),
        log: (entry) => console.error(entry),
      });
      return secure(response, path, { csp });
    }
    // An original is served with its own sandboxing policy (receipts/routes.ts), never the page's.
    return secure(await route(request, env), path, path.startsWith(VIEW_PREFIX) ? { csp: VIEW_CSP } : {});
  },
  /**
   * The scheduled jobs (wrangler.toml [triggers]). Each is independent of the other.
   *   The nightly copy's two crons (src/backup/nightly.ts): scheduled for both UTC hours that can be 03:00 in
   *     Toronto; the job does nothing unless it is 03:00 there. A failed copy is audited and logged and is
   *     never thrown, so it cannot touch the Monday run.
   *   Every other firing is the Monday commission cron (src/cron.ts), exactly as before: both UTC hours that
   *     can be 09:00 in Toronto; runWeeklyCommissions does nothing unless this one is. It throws when the run
   *     fails, so Cloudflare records the failure.
   */
  async scheduled(controller: { scheduledTime: number; cron?: string }, env: Env, _ctx?: unknown): Promise<void> {
    if (isBackupCron(controller.cron)) {
      // The scheduled time plus the time that has passed since (performance.now only moves forward), so the audit row can say how long the copy took.
      const t0 = performance.now();
      await runScheduledBackup({
        openDb: async () => connect(connectionString(env)),
        storage: isBackupBucket(env.BACKUPS) ? backupStorage(env.BACKUPS) : null,
        now: () => new Date(controller.scheduledTime + (performance.now() - t0)),
        log: (entry) => console.error(entry),
        actorId: "SYSTEM",
      }).catch((err: unknown) => console.error({ event: "backup.cron.error", errorClass: err instanceof Error ? err.name : typeof err }));
      return;
    }
    await runWeeklyCommissions({
      openDb: async () => connect(connectionString(env)),
      now: () => new Date(controller.scheduledTime),
      env,
      fetch: (input, init) => fetch(input, init),
      log: (entry) => console.error(entry),
    });
  },
};
