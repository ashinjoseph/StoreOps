// rpcLogin and rpcLogout: the two calls that run without a session.
import { login, logout } from "../../auth/login";
import { MissingSecretError } from "../../lib/config";
import type { RpcHandler } from "../types";

/**
 * The Worker secret PINs are hashed with. A missing one is a deployment fault,
 * not something to tell the person signing in: MissingSecretError is not a
 * plain Error, so the router answers SERVER_ERROR and logs the binding's name.
 */
export function pinPepper(env: Readonly<Record<string, unknown>>): string {
  const v = env["PIN_PEPPER"];
  if (typeof v !== "string" || v === "") throw new MissingSecretError("PIN_PEPPER");
  return v;
}

export const rpcLogin: RpcHandler = async (ctx, name, code) =>
  login({ db: ctx.db, config: await ctx.config(), pepper: pinPepper(ctx.env), now: ctx.now }, name as string, code as string);

export const rpcLogout: RpcHandler = (ctx, token) => logout({ db: ctx.db, now: ctx.now }, token as string);
