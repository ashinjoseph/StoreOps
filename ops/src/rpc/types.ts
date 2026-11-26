// The shape of an RPC handler in the new app. Decided once, here: the router
// (P2-07) calls it, and every ported module (phase 3) implements it.
//
// The old `function rpcThing(token, input)` becomes a handler that never sees
// the token: the router takes it off the front of the arguments, resolves the
// session, applies the contract's role rule, and passes the rest on. Identity
// and role therefore come only from `ctx.session`.
import type { Tx } from "../db/tx";
import type { Config } from "../lib/config";
import type { Session } from "../auth/types";

export interface RpcContext {
  /** One transaction for the whole call: it commits when the handler returns and rolls back when it throws. */
  db: Tx;
  /** The caller. Null only for the RPCs the contract marks `needs_session: false` (login, logout, the login name list). */
  session: Session | null;
  /** Settings, loaded on first use and kept for this call. */
  config(): Promise<Config>;
  /** The Worker's bindings (secrets live here; see lib/config.ts `secret`). */
  env: Readonly<Record<string, unknown>>;
  /** Outbound HTTP (WhatsApp, Clover, the till). Use this, never the global `fetch`, so tests and the parity harness can see and fake every call. */
  fetch: typeof fetch;
  /** The instant the call started. Use this, never `new Date()`, so tests and the parity harness can pin it. */
  now: Date;
}

/**
 * `args` are the page's arguments without the session token. The result must
 * be JSON-safe (a Date is sent as its ISO string; `undefined` arrives as null).
 * Throw a plain `Error` for anything the person should read; its message is
 * shown as the old app showed it.
 */
export type RpcHandler = (ctx: RpcContext, ...args: unknown[]) => Promise<unknown> | unknown;

export type RpcHandlers = Readonly<Record<string, RpcHandler>>;
