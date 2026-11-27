// The till client: the ONE place the Operations app calls the till (ADR-0024).
//
// What the till is and what it gives: ops/contracts/till-api.v1.yaml (1.1.0). This file is GET only: it
// has no code path that can send anything to the till (a proposal is a later card). It runs in the
// Worker, so it imports nothing from `node:` and does not load the contract; the full schema check is the
// Node tool's job (ops/tools/till-check.ts), and this client checks only what it needs to hand typed data on.
//
// What every function promises:
//   - It never throws. It answers { ok: true, data } or { ok: false, error: { kind, ... } }.
//   - The key goes only into the Authorization header of a request to one of the till's own addresses
//     (address.ts). A request to any other address is `bad_address` and is not made. A redirect is never
//     followed (`redirect: "manual"`), so the key cannot follow one.
//   - The key is in no answer, message, thrown value or log line: every text that leaves is scrubbed of it,
//     including text the till echoed back.
//   - Time, waiting and the network come from outside (`now`, `sleep`, `fetch`), so a test sees all of them.
//
// Slowing down: on 429 it waits for Retry-After with `sleep` and tries again, at most twice and never more
// than `maxWaitMs` of waiting in all; then it answers `rate_limited`. A request that takes longer than
// `timeoutMs` is a `timeout` (not retried). A 5xx is not retried either: the caller decides.
//
// Nothing is paged in contract 1.1.0, so nothing here follows pages and no answer says `truncated`.
//
// `sleep(ms, signal?)` resolves after `ms` milliseconds, or at once when `signal` aborts (it never
// rejects). The client uses it twice: to wait out a 429 (no signal), and as each request's deadline (with
// a signal it aborts when the request finishes, so a real timer can be cleared).
import { isTillUrl, tillBaseUrl } from "./address";
import { daysBetween, isRealDay, torontoDay } from "./days";
import {
  TILL_ERROR_CODES,
  type DailySalesAnswer,
  type OrdersAnswer,
  type ProductsAnswer,
  type ShiftsAnswer,
  type StaffAnswer,
  type StoresAnswer,
  type SuppliersAnswer,
  type TillError,
  type TillErrorCode,
  type TillErrorKind,
  type TillResult,
} from "./types";

export { isTillUrl, tillBaseUrl, TILL_SERVERS } from "./address";

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_WAIT_MS = 10_000;
/** A 429 is retried at most this many times. */
export const MAX_RETRIES = 2;
/** What a missing or unreadable Retry-After counts as. */
export const DEFAULT_RETRY_AFTER_SECONDS = 1;
/** The contract: `to` is at most 91 days after `from` (92 days in all). */
export const MAX_SPAN_DAYS = 91;
/** A request's deadline counts only if the clock really moved this far (a sleep that returns at once is not a timeout). */
const DEADLINE_SLACK_MS = 20;
const MAX_MESSAGE_CHARS = 300;
const MAX_RETRY_AFTER_SECONDS = 86_400;

export interface TillClientOptions {
  /** One of the till's addresses (address.ts). Blank or missing: every call answers `not_configured`. */
  baseUrl: string | null | undefined;
  /** The Operations key. Blank or missing: every call answers `not_configured`. */
  key: string | null | undefined;
  /** Outbound HTTP. Never the global `fetch`. */
  fetch: typeof fetch;
  sleep: Sleep;
  /** The clock: an HTTP-date Retry-After is read against it, a request's deadline is measured with it, and "today" comes from it. */
  now: () => Date;
  timeoutMs?: number;
  maxWaitMs?: number;
}

export interface TillClient {
  /** The stores this key may see. */
  listStores(): Promise<TillResult<StoresAnswer>>;
  /** Everyone who can work a till at the store (people with an Office login). */
  listStaff(storeId: string): Promise<TillResult<StaffAnswer>>;
  /** Every shift OPENED on the business day, open ones included. `day` is `YYYY-MM-DD` (Toronto), not after today. */
  listShifts(input: { storeId: string; day: string }): Promise<TillResult<ShiftsAnswer>>;
  /** One row per business day and channel, `from` to `to` inclusive: at most 92 days, `to` not after today. */
  dailySales(input: { storeId: string; from: string; to: string }): Promise<TillResult<DailySalesAnswer>>;
  /** The till's product codes (no prices or costs). */
  listProducts(storeId: string): Promise<TillResult<ProductsAnswer>>;
  /** The till's supplier codes. */
  listSuppliers(storeId: string): Promise<TillResult<SuppliersAnswer>>;
  /** Purchase orders sent or arrived and not yet received. `open` is the only status in v1. */
  listOrders(storeId: string, status?: "open"): Promise<TillResult<OrdersAnswer>>;
}

// ── Checking inputs ────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Errors and scrubbing ───────────────────────────────────

const fail = (kind: TillErrorKind, message: string, extra: Partial<TillError> = {}): { ok: false; error: TillError } => ({ ok: false, error: { kind, message, ...extra } });

/** Every spelling of the key a till might echo back: as is, URL-encoded, JSON-escaped, base64. */
function keyForms(key: string): string[] {
  const forms = new Set<string>([key, encodeURIComponent(key), JSON.stringify(key).slice(1, -1)]);
  try {
    forms.add(btoa(key));
  } catch {
    // not encodable: the other forms stand
  }
  return [...forms].filter((f) => f !== "").sort((a, b) => b.length - a.length);
}

function makeScrub(key: string | null): (text: string) => string {
  const forms = key === null || key === "" ? [] : keyForms(key);
  return (text: string): string => {
    let out = text;
    for (const f of forms) if (out.includes(f)) out = out.split(f).join("[key]");
    return out.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
  };
}

/** The key as a header value, or null when it cannot be one (blank, a space, a line break, non-ASCII). */
function usableKey(key: string | null | undefined): string | null {
  return typeof key === "string" && /^[\x21-\x7e]+$/.test(key) ? key : null;
}

// ── Reading an answer ──────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isCode = (v: unknown): v is TillErrorCode => typeof v === "string" && (TILL_ERROR_CODES as readonly string[]).includes(v);

const DAY3 = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
const MON = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
/** The three HTTP-date forms (RFC 9110): `Sun, 06 Nov 1994 08:49:37 GMT`, the old `Sunday, 06-Nov-94 08:49:37 GMT`, and `Sun Nov  6 08:49:37 1994`. */
const HTTP_DATES: ReadonlyArray<readonly [RegExp, (t: string) => string]> = [
  [new RegExp(`^${DAY3}, \\d{2} ${MON} \\d{4} \\d{2}:\\d{2}:\\d{2} GMT$`), (t) => t],
  [new RegExp(`^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${MON}-\\d{2} \\d{2}:\\d{2}:\\d{2} GMT$`), (t) => t],
  [new RegExp(`^${DAY3} ${MON} [ \\d]\\d \\d{2}:\\d{2}:\\d{2} \\d{4}$`), (t) => `${t} GMT`],
];

/** Seconds from a Retry-After header: whole seconds, or an HTTP date read against `now`. Missing or unreadable: 1. */
export function retryAfterSeconds(header: string | null, now: Date): number {
  if (header === null) return DEFAULT_RETRY_AFTER_SECONDS;
  const text = header.trim();
  let secs: number;
  if (/^\d{1,9}$/.test(text)) secs = Number(text);
  else {
    const form = HTTP_DATES.find(([re]) => re.test(text));
    const at = form === undefined ? Number.NaN : Date.parse(form[1](text));
    if (Number.isNaN(at)) return DEFAULT_RETRY_AFTER_SECONDS;
    secs = Math.max(0, Math.ceil((at - now.getTime()) / 1000));
  }
  return Math.min(secs, MAX_RETRY_AFTER_SECONDS);
}

interface Shape {
  /** For messages: `GET /shifts`. */
  endpoint: string;
  /** Top-level keys the contract marks required. */
  required: readonly string[];
  /** Of those, the ones that are arrays. */
  arrays: readonly string[];
}

/** What each answer needs to be handed on typed. Kept equal to the contract by test/till-client.test.ts. */
export const SHAPES = {
  stores: { endpoint: "GET /stores", required: ["stores"], arrays: ["stores"] },
  staff: { endpoint: "GET /staff", required: ["store_id", "staff"], arrays: ["staff"] },
  shifts: { endpoint: "GET /shifts", required: ["store_id", "business_day", "shifts"], arrays: ["shifts"] },
  daily: { endpoint: "GET /sales/daily", required: ["store_id", "from", "to", "days"], arrays: ["days"] },
  products: { endpoint: "GET /products", required: ["store_id", "products"], arrays: ["products"] },
  suppliers: { endpoint: "GET /suppliers", required: ["store_id", "suppliers"], arrays: ["suppliers"] },
  orders: { endpoint: "GET /orders", required: ["store_id", "orders"], arrays: ["orders"] },
} as const satisfies Record<string, Shape>;

type Settled = { ok: true; res: Response; text: string } | { ok: false; error: unknown };

export function createTillClient(options: TillClientOptions): TillClient {
  const key = usableKey(options.key);
  const scrub = makeScrub(typeof options.key === "string" ? options.key : null);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const configured = typeof options.baseUrl === "string" && options.baseUrl.trim() !== "" && typeof options.key === "string" && options.key !== "";

  /** One request: the answer, or a timeout, or a failure to reach the till. */
  async function attempt(url: string, key: string): Promise<{ kind: "answer"; res: Response; text: string } | { kind: "timeout" } | { kind: "network"; code?: string }> {
    const startedAt = options.now().getTime();
    const stopDeadline = new AbortController();
    const abortRequest = new AbortController();
    try {
      const work: Promise<Settled> = (async () => {
        const res = await options.fetch(url, { method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${key}` }, redirect: "manual", signal: abortRequest.signal });
        return { ok: true as const, res, text: await res.text() };
      })().catch((error: unknown): Settled => ({ ok: false, error }));
      const deadline = options.sleep(timeoutMs, stopDeadline.signal).then(
        () => "deadline" as const,
        () => "deadline" as const,
      );
      let first: Settled | "deadline" = await Promise.race([work, deadline]);
      // A sleep that returns before the time is up (a stub that does not wait) is not a timeout.
      while (first === "deadline") {
        if (options.now().getTime() - startedAt >= timeoutMs - DEADLINE_SLACK_MS) {
          abortRequest.abort();
          return { kind: "timeout" };
        }
        first = await work;
      }
      if (!first.ok) {
        const e = first.error as { cause?: { code?: unknown }; code?: unknown } | null;
        const raw = e?.cause?.code ?? e?.code;
        return typeof raw === "string" && /^[A-Z0-9_]{3,40}$/.test(raw) ? { kind: "network", code: raw } : { kind: "network" };
      }
      return { kind: "answer", res: first.res, text: first.text };
    } finally {
      stopDeadline.abort();
    }
  }

  /** The till's own error code and (scrubbed) message out of an error body, when it sent them. */
  function errorBody(text: string): { code?: TillErrorCode; said?: string } {
    try {
      const body: unknown = JSON.parse(text);
      if (isObj(body) && isObj(body.error)) {
        const out: { code?: TillErrorCode; said?: string } = {};
        if (isCode(body.error.code)) out.code = body.error.code;
        if (typeof body.error.message === "string") out.said = scrub(body.error.message).trim().slice(0, MAX_MESSAGE_CHARS);
        return out;
      }
    } catch {
      // not JSON: the status alone speaks
    }
    return {};
  }

  /** The error of an answer that was not a 200 (a 429 has its own path). */
  function refusal(status: number, text: string): { ok: false; error: TillError } {
    const { code, said } = errorBody(text);
    const extra: Partial<TillError> = { status, ...(code !== undefined ? { code } : {}) };
    const say = (fallback: string): string => (said !== undefined && said !== "" ? said : fallback);
    if (status === 401) return fail("unauthorized", say("the till did not accept the key"), extra);
    if (status === 403) return fail("forbidden", say("the key may not see that store"), extra);
    if (status === 404) return fail("not_found", say("the till has no such thing"), extra);
    if (status >= 500) return fail("server", say(`the till failed (${status})`), extra);
    if (status >= 400) return fail("rejected", say(`the till refused the request (${status})`), extra);
    return fail("bad_answer", `the till answered with an unexpected status (${status})`, { status });
  }

  /** The 200 answer, if it has what the endpoint needs. Names an endpoint and a key, never a value. */
  function checked<T>(shape: Shape, text: string, storeId: string | undefined): TillResult<T> {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail("bad_answer", `${shape.endpoint}: the answer is not JSON`, { status: 200 });
    }
    if (!isObj(body)) return fail("bad_answer", `${shape.endpoint}: the answer is not an object`, { status: 200 });
    for (const k of shape.required) {
      if (!(k in body)) return fail("bad_answer", `${shape.endpoint}: the answer has no \`${k}\``, { status: 200 });
    }
    for (const k of shape.arrays) {
      if (!Array.isArray(body[k])) return fail("bad_answer", `${shape.endpoint}: \`${k}\` is not a list`, { status: 200 });
    }
    if (storeId !== undefined && (typeof body.store_id !== "string" || body.store_id.toLowerCase() !== storeId.toLowerCase())) {
      return fail("bad_answer", `${shape.endpoint}: the answer is not for the store asked about`, { status: 200 });
    }
    return { ok: true, data: body as T };
  }

  async function get<T>(shape: Shape, path: string, params: Array<[string, string]>, storeId: string | undefined, validate: () => string | null): Promise<TillResult<T>> {
    try {
      if (!configured || key === null) return fail("not_configured", "the till link is not set up (no address or no key)");
      const base = tillBaseUrl(options.baseUrl);
      if (base === null) return fail("bad_address", "the till address is not one of the till's own addresses");
      const problem = validate();
      if (problem !== null) return fail("bad_input", problem);
      const qs = params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      const url = `${base}${path}${qs === "" ? "" : `?${qs}`}`;
      // Belt and braces: whatever was built, the key goes only to an address the till owns.
      if (!isTillUrl(url)) return fail("bad_address", "the request address is not one of the till's own addresses");

      let waitedMs = 0;
      for (let retries = 0; ; retries++) {
        const out = await attempt(url, key);
        if (out.kind === "timeout") return fail("timeout", `${shape.endpoint}: the till did not answer in ${Math.round(timeoutMs / 1000)} seconds`);
        if (out.kind === "network") return fail("network", out.code === undefined ? "the till could not be reached" : `the till could not be reached (${out.code})`);
        const { res, text } = out;
        const status = res.status;
        if (status === 200) return checked<T>(shape, text, storeId);
        if (status === 429) {
          const secs = retryAfterSeconds(res.headers.get("retry-after"), options.now());
          if (retries >= MAX_RETRIES || waitedMs + secs * 1000 > maxWaitMs) {
            return fail("rate_limited", `the till asked us to slow down (try again in ${secs} seconds)`, { status, retryAfterSeconds: secs, ...(errorBody(text).code === "rate_limited" ? { code: "rate_limited" as const } : {}) });
          }
          await options.sleep(secs * 1000);
          waitedMs += secs * 1000;
          continue;
        }
        if (status >= 300 && status < 400) return fail("bad_answer", `${shape.endpoint}: the till answered with a redirect, which is never followed`, { status });
        if (status === 0 || (status >= 200 && status < 300) || status < 200) return fail("bad_answer", `${shape.endpoint}: the till answered with an unexpected status (${status})`, { status });
        return refusal(status, text);
      }
    } catch {
      // Nothing above should throw; if something does, the answer is still an answer, and says nothing about why.
      return fail("bad_answer", `${shape.endpoint}: the answer could not be handled`);
    }
  }

  // The last line of defence for the key: whatever an answer carries, its text is scrubbed.
  const clean = <T>(r: TillResult<T>): TillResult<T> => (r.ok ? r : { ok: false, error: { ...r.error, message: scrub(r.error.message) } });

  const needStore = (storeId: unknown): string | null => (typeof storeId === "string" && UUID.test(storeId) ? null : "storeId must be a uuid");

  return {
    listStores: async () => clean(await get<StoresAnswer>(SHAPES.stores, "/stores", [], undefined, () => null)),
    listStaff: async (storeId) => clean(await get<StaffAnswer>(SHAPES.staff, "/staff", [["store_id", String(storeId)]], String(storeId), () => needStore(storeId))),
    listShifts: async (input) => {
      const storeId = isObj(input) ? input.storeId : undefined;
      const day = isObj(input) ? input.day : undefined;
      return clean(
        await get<ShiftsAnswer>(SHAPES.shifts, "/shifts", [["store_id", String(storeId)], ["day", String(day)]], String(storeId), () => {
          const s = needStore(storeId);
          if (s !== null) return s;
          if (!isRealDay(day)) return "day must be a real date written YYYY-MM-DD";
          if (day > torontoDay(options.now())) return "day cannot be after today";
          return null;
        }),
      );
    },
    dailySales: async (input) => {
      const storeId = isObj(input) ? input.storeId : undefined;
      const from = isObj(input) ? input.from : undefined;
      const to = isObj(input) ? input.to : undefined;
      return clean(
        await get<DailySalesAnswer>(SHAPES.daily, "/sales/daily", [["store_id", String(storeId)], ["from", String(from)], ["to", String(to)]], String(storeId), () => {
          const s = needStore(storeId);
          if (s !== null) return s;
          if (!isRealDay(from) || !isRealDay(to)) return "from and to must be real dates written YYYY-MM-DD";
          if (from > to) return "from cannot be after to";
          if (to > torontoDay(options.now())) return "to cannot be after today";
          if (daysBetween(from, to) > MAX_SPAN_DAYS) return `from and to can be at most ${MAX_SPAN_DAYS + 1} days apart`;
          return null;
        }),
      );
    },
    listProducts: async (storeId) => clean(await get<ProductsAnswer>(SHAPES.products, "/products", [["store_id", String(storeId)]], String(storeId), () => needStore(storeId))),
    listSuppliers: async (storeId) => clean(await get<SuppliersAnswer>(SHAPES.suppliers, "/suppliers", [["store_id", String(storeId)]], String(storeId), () => needStore(storeId))),
    listOrders: async (storeId, status) =>
      clean(
        await get<OrdersAnswer>(SHAPES.orders, "/orders", status === undefined ? [["store_id", String(storeId)]] : [["store_id", String(storeId)], ["status", String(status)]], String(storeId), () => {
          const s = needStore(storeId);
          if (s !== null) return s;
          if (status !== undefined && status !== "open") return "status can only be open";
          return null;
        }),
      ),
  };
}
