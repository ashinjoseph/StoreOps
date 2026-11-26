// The Notifier's one RPC. Thin: who may call is the contract's `roles` (admin, manager, payroll_admin),
// applied by the router before this runs. Everything else is in modules/notifier.ts.
import * as notifier from "../../modules/notifier";
import type { RpcHandler } from "../types";

/**
 * What would stop WhatsApp messages arriving, checked without sending one: the switch, the URL, the
 * token, recipients, templates, and Meta's own view of the token and phone number. Never returns the
 * token. A failed check is an answer ({ ok: false, checks }), not an error.
 */
export const rpcCheckWhatsApp: RpcHandler = async (ctx) =>
  notifier.diagnose({ config: await ctx.config(), env: ctx.env, fetch: ctx.fetch, db: ctx.db, now: ctx.now });
