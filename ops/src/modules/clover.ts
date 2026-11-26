// Clover: the port of src/Clover.gs. The day's CARD payments from the Clover REST API, summed by
// credit / debit / total, so the reconcile can compare them with what the cashiers entered.
//
// As before, `getCardTotals` never throws: every failure is an answer, { ok:false, error, detail? },
// so a reconcile degrades and a close is never affected:
//   not_configured   no merchant id or no token (and, new, a base URL that is not Clover's: below)
//   http_<code>      Clover answered outside 200-299 (detail: the first 300 characters of its body)
//   exception        anything else: the request failed or timed out, the body is not JSON, ...
// The reconcile keeps only `error` (Reconcile.gs line 284); `detail` is never stored or answered.
//
// Paging (Clover.gs lines 78-109): 1,000 payments a page, at most 50 pages; a page shorter than
// 1,000 is the last. A payment counts when its `result` is missing or SUCCESS and it has a
// cardTransaction; its `amount` is in cents, and a missing or unreadable amount counts as 0 (kept).
// credit, debit and total are each rounded once, at the end (roundMoney).
//
// Settings: clover_enabled, clover_base_url (default https://api.clover.com) and
// clover_<cstore|vape>_merchant_id from the config table. The tokens are SECRETS: clover_cstore_token
// and clover_vape_token come only from the Worker bindings CLOVER_CSTORE_TOKEN / CLOVER_VAPE_TOKEN
// (`maybeSecret`), never from the table; a missing binding is a blank token (not configured).
//
// Deliberate differences from the old code (card P3-07, security):
//   - The token goes only to Clover. Before any request, the URL must be https:, carry no user name
//     or password, use the default port and have one of Clover's own API hosts (CLOVER_HOSTS). Any
//     other clover_base_url counts as not configured (the old outcome for a till with no Clover) and
//     NO request is made. The old code sent the token to whatever the setting held.
//   - Each request has a 10-second limit (AbortSignal.timeout; UrlFetchApp had its own). A request
//     that does not finish is a failed fetch: { ok:false, error:'exception' }, as before.
//   - The token never appears in an answer: it is not an enumerable property of a Merchant (so it is
//     not in a JSON or a log of one), and any text that might carry it is scrubbed.
// The merchant id is URL-encoded (as before); the time window is numbers only.
import { maybeSecret, type Config } from "../lib/config";
import { roundMoney } from "../lib/money";

export const DEFAULT_BASE_URL = "https://api.clover.com";
/** Clover's own REST API hosts: the only places a Clover token may be sent. */
export const CLOVER_HOSTS: readonly string[] = ["api.clover.com", "api.eu.clover.com", "api.la.clover.com", "apisandbox.dev.clover.com", "sandbox.dev.clover.com"];
/** Each request's limit. (Added in the move: see the header.) */
export const REQUEST_TIMEOUT_MS = 10_000;
/** Payments a page, and the most pages one call reads (Clover.gs: "hard cap 50k payments/day"). */
export const PAGE_SIZE = 1000;
export const MAX_PAGES = 50;

export interface Merchant {
  merchantId: string;
  baseUrl: string;
  /** Not enumerable: never in a JSON, a log line or an answer. */
  readonly token: string;
}

export type CardTotals = { ok: true; credit: number; debit: number; total: number; count: number } | { ok: false; error: string; detail?: string };

export interface CloverDeps {
  /** Outbound HTTP. Never the global `fetch`. */
  fetch: typeof fetch;
  /** Tests only: a shorter limit than REQUEST_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Time left for Clover in the piece of work this request belongs to (card P3-07b). When given:
   * no request is started with nothing left, and a request gets no longer than what is left.
   * A reconcile asks Clover inside a transaction that holds the day's lock; this bounds it.
   */
  budget?: { remainingMs(): number };
}

/** What a request refused for lack of time answers with: a failure, like any failed request. */
export const OUT_OF_TIME = "Clover took too long: this reconcile's time for Clover is used up";

/** `raw === true || String(raw).toLowerCase() === 'true'` (Clover.gs isEnabled_). */
export function isEnabled(config: Config): boolean {
  return config.boolean("clover_enabled", "false");
}

/**
 * The Clover connection for a company: 'vape' is vape, anything else is cstore (Clover.gs
 * merchantFor_). Companies that share a merchant id are reconciled together.
 */
export function merchantFor(deps: { config: Config; env: Readonly<Record<string, unknown>> }, company: unknown): Merchant {
  const vape = company === "vape";
  const merchant = {
    merchantId: deps.config.value(vape ? "clover_vape_merchant_id" : "clover_cstore_merchant_id", ""),
    baseUrl: deps.config.value("clover_base_url", DEFAULT_BASE_URL),
  } as Merchant;
  Object.defineProperty(merchant, "token", { value: maybeSecret(deps.env, vape ? "clover_vape_token" : "clover_cstore_token") ?? "", enumerable: false });
  return merchant;
}

/**
 * Credit or debit, from the tender's labelKey (else label) and the card transaction's type (else
 * entryType): "debit" anywhere is debit, else credit. Unknown is credit, so credit + debit = total.
 * Best-effort, as the old comment says; the total is the dependable check. (Clover.gs classifyPayment_)
 */
// The old code is untyped JavaScript over Clover's JSON; `any` keeps its exact reads (a null tender, a number label...).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifyPayment(p: any): "credit" | "debit" {
  const tender = (p.tender && (p.tender.labelKey || p.tender.label)) || "";
  const cardTx = (p.cardTransaction && (p.cardTransaction.type || p.cardTransaction.entryType)) || "";
  const blob = (tender + " " + cardTx).toString().toLowerCase();
  if (blob.indexOf("debit") !== -1) return "debit";
  if (blob.indexOf("credit") !== -1) return "credit";
  return "credit";
}

/** https://<one of CLOVER_HOSTS>/… with no user name, no password and the default port: the only places a Clover token may go. */
export function isCloverUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && CLOVER_HOSTS.includes(u.hostname) && u.username === "" && u.password === "" && (u.port === "" || u.port === "443");
  } catch {
    return false;
  }
}

/** `text` with the token, if it is in there, replaced. */
function scrub(text: string, secret: string): string {
  return secret !== "" && text.includes(secret) ? text.split(secret).join("<secret>") : text;
}

/**
 * One GET with the limit. The limit covers reading the body. Whatever the fetch does after the
 * limit is ignored, so a fetch that never looks at its signal still cannot hang the reconcile.
 */
async function get(deps: CloverDeps, url: string, token: string): Promise<{ code: number; text: string }> {
  const most = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const ms = deps.budget ? Math.max(1, Math.min(most, Math.floor(deps.budget.remainingMs()))) : most;
  const signal = AbortSignal.timeout(ms);
  const limit = new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new Error(`timed out after ${ms / 1000} seconds`));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
  const work = (async () => {
    const resp = await deps.fetch(url, { method: "GET", headers: { Authorization: "Bearer " + token }, signal });
    return { code: resp.status, text: await resp.text() };
  })();
  work.catch(() => undefined); // if the limit wins, a later failure of the request is not news
  limit.catch(() => undefined);
  return Promise.race([work, limit]);
}

/**
 * Sum a merchant's CARD payments from `startMs` to `endMs` (epoch ms, both inclusive).
 * (Clover.gs getCardTotals_.) Never throws.
 */
export async function getCardTotals(deps: CloverDeps, merchant: Merchant | null | undefined, startMs: number, endMs: number): Promise<CardTotals> {
  if (!merchant || !merchant.merchantId || !merchant.token) {
    return { ok: false, error: "not_configured" };
  }
  const token = merchant.token;
  const start = startMs;
  const end = endMs;
  const base = (merchant.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const limit = PAGE_SIZE;
  let offset = 0;
  let credit = 0;
  let debit = 0;
  let total = 0;
  let count = 0;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url =
        base +
        "/v3/merchants/" +
        encodeURIComponent(merchant.merchantId) +
        "/payments" +
        "?filter=" +
        encodeURIComponent("createdTime>=" + start) +
        "&filter=" +
        encodeURIComponent("createdTime<=" + end) +
        "&expand=" +
        encodeURIComponent("cardTransaction,tender") +
        "&limit=" +
        limit +
        "&offset=" +
        offset;
      // DELIBERATE ADDITION (see the header): the token is only ever sent to Clover.
      if (!isCloverUrl(url)) return { ok: false, error: "not_configured" };
      // Never partial totals: out of time is a failed request, and the day is "not verified".
      if (deps.budget && deps.budget.remainingMs() <= 0) return { ok: false, error: "exception", detail: OUT_OF_TIME };
      const resp = await get(deps, url, token);
      const code = resp.code;
      if (code < 200 || code >= 300) {
        return { ok: false, error: "http_" + code, detail: scrub(resp.text.slice(0, 300), token) };
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const body: any = JSON.parse(resp.text);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const els: any = (body && body.elements) || [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      els.forEach((p: any) => {
        if (p.result && p.result !== "SUCCESS") return; // skip voided/failed
        if (!p.cardTransaction) return; // card payments only
        const amt = (Number(p.amount) || 0) / 100; // cents → dollars
        total += amt;
        if (classifyPayment(p) === "debit") debit += amt;
        else credit += amt;
        count++;
      });
      if (els.length < limit) break;
      offset += limit;
    }
    return { ok: true, credit: roundMoney(credit), debit: roundMoney(debit), total: roundMoney(total), count };
  } catch (e) {
    return { ok: false, error: "exception", detail: scrub(e instanceof Error ? e.message : String(e), token) };
  }
}
