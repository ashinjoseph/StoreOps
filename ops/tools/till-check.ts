/// <reference types="node" />
/**
 * Till API retrieval check (card P1-04).
 *
 * Calls every GET endpoint of the till API once per store and reports whether
 * each answer matches the contract (ops/contracts/till-api.v1.yaml) and its
 * arithmetic rules. GET only. Never prints the key, an Authorization header, or
 * any person's name or id: output is counts, statuses, field paths and money.
 *
 *   TILL_API_BASE_URL=https://.../ops/v1 TILL_API_KEY=... npm run till:check
 *
 * Exit code: 0 no errors (warnings allowed), 1 errors, 2 usage.
 */
import { pathToFileURL } from "node:url";
// Node's type stripping needs the explicit ".ts"; tsconfig does not allow that extension.
// @ts-ignore TS5097
import { loadContract } from "../src/till/contract.ts";
// @ts-ignore TS5097
import { checkDailyRow, checkDailyRows, checkProducts, checkShift, type Difference } from "../src/till/rules.ts";

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; redirect: "error" },
) => Promise<FetchResponse>;

export interface TillResponse {
  status: number;
  /** Parsed JSON, or undefined when the body was not JSON. */
  body: unknown;
  notJson: boolean;
}

/** The till could not be reached at all (DNS, refused, timeout, redirect). */
export class TillUnreachable extends Error {
  readonly code: string;
  constructor(code: string) {
    super("till unreachable");
    this.code = code;
  }
}

/** Waited between requests so the till's 60 a minute limit is never near. */
export const MIN_GAP_MS = 1100;
const MAX_RETRY_AFTER_MS = 120_000;

interface ClientOptions {
  baseUrl: string;
  key: string | undefined;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
}

/**
 * The only place a request is made, and the only place the key is used.
 * Refuses every method but GET. Paces requests, and retries a 429 once.
 */
export function createTillClient(opts: ClientOptions) {
  const base = opts.baseUrl.trim().replace(/\/+$/, "");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.key) headers["Authorization"] = `Bearer ${opts.key}`;
  let sent = 0;

  async function once(url: string): Promise<{ res: FetchResponse; text: string }> {
    try {
      const res = await opts.fetch(url, { method: "GET", headers, redirect: "error" });
      return { res, text: await res.text() };
    } catch (e) {
      const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
      const raw = cause?.code ?? (e as { code?: unknown } | null)?.code;
      throw new TillUnreachable(typeof raw === "string" && /^[A-Z0-9_]{3,40}$/.test(raw) ? raw : "network error");
    }
  }

  async function request(method: string, path: string, query: Record<string, string>): Promise<TillResponse> {
    if (method !== "GET") throw new Error(`only GET is allowed, refused ${method}`);
    const qs = new URLSearchParams(query).toString();
    const url = `${base}${path}${qs ? `?${qs}` : ""}`;
    if (sent++ > 0) await opts.sleep(MIN_GAP_MS);
    let r = await once(url);
    if (r.res.status === 429) {
      const secs = Number(r.res.headers.get("Retry-After"));
      const wait = Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : MIN_GAP_MS;
      await opts.sleep(Math.max(wait, MIN_GAP_MS));
      r = await once(url);
    }
    try {
      return { status: r.res.status, body: JSON.parse(r.text), notJson: false };
    } catch {
      return { status: r.res.status, body: undefined, notJson: true };
    }
  }

  return { request };
}

export interface RunOptions {
  baseUrl: string | undefined;
  key: string | undefined;
  fetch: FetchLike;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

const SHIFT_DAYS_TO_TRY = 7;
const SALES_DAYS = 7;
const ERROR_CODES = new Set([
  "bad_request",
  "unauthorized",
  "forbidden_store",
  "not_found",
  "conflict",
  "rejected",
  "rate_limited",
  "server_error",
  "unavailable",
]);

/** The Toronto calendar day of an instant, YYYY-MM-DD. */
export function torontoDay(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (body: unknown, field: string): unknown[] | undefined =>
  isObj(body) && Array.isArray(body[field]) ? (body[field] as unknown[]) : undefined;

/** Runs the whole check; returns the exit code. */
export async function runTillCheck(opts: RunOptions): Promise<number> {
  const { log } = opts;
  if (!opts.baseUrl || !opts.baseUrl.trim()) {
    log("usage: set TILL_API_BASE_URL (and TILL_API_KEY unless a proxy adds it), then run: npm run till:check");
    return 2;
  }
  const contract = loadContract();
  const client = createTillClient({ baseUrl: opts.baseUrl, key: opts.key, fetch: opts.fetch, sleep: opts.sleep });
  let errors = 0;
  let warnings = 0;
  let calls = 0;

  const report = (diffs: Difference[]) => {
    for (const d of diffs) {
      if (d.severity === "error") errors++;
      else warnings++;
      log(`  ${d.severity === "error" ? "ERROR" : "WARNING"} ${d.path || "(answer)"} expected ${d.expected} actual ${d.actual}`);
    }
  };
  const summarise = (diffs: Difference[]) => `${diffs.length} differences (${diffs.filter((d) => d.severity === "error").length} errors, ${diffs.filter((d) => d.severity === "warning").length} warnings)`;

  /** One call. `stop` means nothing further can be trusted. */
  async function call(
    schema: string,
    path: string,
    query: Record<string, string>,
    extraRules: (body: unknown) => Difference[],
  ): Promise<{ stop: boolean; body?: unknown }> {
    const qs = new URLSearchParams(query).toString();
    const shown = `GET ${path}${qs ? `?${qs}` : ""}`;
    calls++;
    let res: TillResponse;
    try {
      res = await client.request("GET", path, query);
    } catch (e) {
      errors++;
      log(`${shown} unreachable (${e instanceof TillUnreachable ? e.code : "network error"})`);
      log("stopped: the till could not be reached");
      return { stop: true };
    }
    if (res.status !== 200) {
      errors++;
      const code = isObj(res.body) && isObj(res.body.error) ? res.body.error.code : undefined;
      const label = typeof code === "string" && ERROR_CODES.has(code) ? code : "no error code";
      log(`${shown} ${res.status} ${res.status === 401 ? "unauthorized" : label}`);
      if (res.status === 401) {
        log("stopped: unauthorized (the key is missing, wrong, expired or revoked)");
        return { stop: true };
      }
      if (res.status === 429) {
        log("stopped: rate limited again after one retry");
        return { stop: true };
      }
      return { stop: false };
    }
    if (res.notJson) {
      errors++;
      log(`${shown} 200 answer is not JSON`);
      return { stop: false };
    }
    const diffs = [...contract.validate(schema, res.body), ...extraRules(res.body)];
    const field = schema === "/sales/daily" ? "days" : schema.slice(1);
    const n = list(res.body, field)?.length;
    log(`${shown} 200 ${n === undefined ? "? items" : `${n} item(s)`} ${summarise(diffs)}`);
    report(diffs);
    return { stop: false, body: res.body };
  }

  const finish = (): number => {
    log(`${calls} calls, ${errors} errors, ${warnings} warnings`);
    log(errors === 0 ? "RESULT: OK" : "RESULT: FAILED");
    return errors === 0 ? 0 : 1;
  };

  const yesterday = addDays(torontoDay(opts.now()), -1);

  const stores = await call("/stores", "/stores", {}, () => []);
  if (stores.stop) return finish();
  const storeIds = (list(stores.body, "stores") ?? [])
    .map((s) => (isObj(s) ? s.store_id : undefined))
    .filter((s): s is string => typeof s === "string");

  for (const storeId of storeIds) {
    const q = { store_id: storeId };

    if ((await call("/staff", "/staff", q, () => [])).stop) return finish();

    for (let i = 0; i < SHIFT_DAYS_TO_TRY; i++) {
      const day = addDays(yesterday, -i);
      const r = await call("/shifts", "/shifts", { ...q, day }, (body) =>
        (list(body, "shifts") ?? []).flatMap((s, j) => checkShift(s, `shifts[${j}]`)),
      );
      if (r.stop) return finish();
      if ((list(r.body, "shifts")?.length ?? 0) > 0) break;
    }

    const from = addDays(yesterday, -(SALES_DAYS - 1));
    const daily = await call("/sales/daily", "/sales/daily", { ...q, from, to: yesterday }, (body) => {
      const days = list(body, "days") ?? [];
      return [...checkDailyRows(days, from, yesterday, "days"), ...days.flatMap((d, j) => checkDailyRow(d, `days[${j}]`))];
    });
    if (daily.stop) return finish();

    const products = await call("/products", "/products", q, () => []);
    if (products.stop) return finish();
    const suppliers = await call("/suppliers", "/suppliers", q, () => []);
    if (suppliers.stop) return finish();
    if (products.body !== undefined && suppliers.body !== undefined) {
      const diffs = checkProducts(list(products.body, "products"), list(suppliers.body, "suppliers"), "products");
      log(`CHECK products against suppliers ${summarise(diffs)}`);
      report(diffs);
    }
    if ((await call("/orders", "/orders", q, () => [])).stop) return finish();
  }
  return finish();
}

async function main(): Promise<void> {
  const code = await runTillCheck({
    baseUrl: process.env.TILL_API_BASE_URL,
    key: process.env.TILL_API_KEY,
    fetch: fetch as unknown as FetchLike,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(line),
  });
  process.exitCode = code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
