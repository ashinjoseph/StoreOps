// The till link, switched off until it is configured.
//
// `tillClientFor` is how a later card will get a client. It answers `not_configured` to every call, and
// makes no request, unless ALL of these hold:
//   till_enabled is true           (a setting; default false)
//   till_api_url is set and is one of the till's own addresses (address.ts)
//   TILL_API_KEY is bound          (a Worker secret: never in the table)
// Nothing in the app calls it yet (card P5-02a): test/till-client.test.ts searches the code for a caller.
import { maybeSecret, type Config } from "../lib/config";
import { createTillClient, type Sleep, type TillClient } from "./client";
import { tillBaseUrl } from "./address";

export interface TillDeps {
  /** Outbound HTTP (ctx.fetch). Never the global `fetch`. */
  fetch: typeof fetch;
  sleep: Sleep;
  now: () => Date;
  timeoutMs?: number;
  maxWaitMs?: number;
}

export function tillClientFor(env: Readonly<Record<string, unknown>>, config: Config, deps: TillDeps): TillClient {
  const url = config.value("till_api_url");
  const key = maybeSecret(env, "till_api_key");
  const on = config.boolean("till_enabled") && tillBaseUrl(url) !== null && key !== null;
  return createTillClient({ ...deps, baseUrl: on ? url : null, key: on ? key : null });
}

export type { TillClient } from "./client";
