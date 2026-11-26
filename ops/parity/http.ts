// Outbound HTTP in the parity run: what each side SENDS, compared like what it answers.
//
// A case scripts the replies (`http: [{ status: 200, body: {...} }, { throws: "timeout" }]`).
// Each step gets one `Outbound` per side, built from the same script:
//   old   UrlFetchApp.fetch(url, options)  -> records, then answers from the script
//   new   ctx.fetch(input, init)           -> records, then answers from the script
// The two sides therefore get the same replies in the same order. Nothing ever
// reaches a real host: outside a case step the old runtime's UrlFetchApp and the
// global `fetch` are guards that throw and count (`takeNetworkLeaks`), and the
// harness's own tests and parity.test.ts assert the count stays zero.
//
// After the call the two lists of requests are compared (`diffOutbound`):
//   count and order, method, URL, body (parsed as JSON when it is JSON, then
//   compared with the rules RPC results use: exact, key order ignored), the
//   content-type header, and the authorization header as "Bearer <the one
//   secret>" (see SECRETS_RULE). A request the case did not script, and a
//   scripted reply the old side never asked for, fail the case.
//
// The secret is never printed: it is replaced by <secret> in every request view,
// and `redact` removes it from anything else a report shows (answers, faults).
import { diffValues } from "./compare";
export { guardedFetch, guardedUrlFetchApp, takeNetworkLeaks } from "./network";

/** What Meta (or any host) answers to the next request, or how the request fails. */
export type HttpReply =
  | { status: number; body?: unknown }
  /** The request throws this message on both sides (UrlFetchApp throws; fetch rejects). */
  | { throws: string };

export interface RecordedRequest {
  method: string;
  url: string;
  /** Lower-case names. */
  headers: Record<string, string>;
  body: string | null;
  /** False when the case had no reply left for it. */
  scripted: boolean;
}

/** What is compared about one request. */
export interface RequestView {
  method: string;
  url: string;
  authorization: string;
  contentType: string;
  body: unknown;
}

export const OUTBOUND_RULE =
  "outbound HTTP: each side's requests are recorded and answered from the case's `http` script (the same replies, in order); compared: count, order, method, URL, body (JSON parsed, then compared exactly), content-type, and authorization as Bearer + the one secret. An unscripted request, or a scripted reply the old side never asked for, fails the case. Nothing reaches a real host.";

export const SECRETS_RULE =
  "secrets are mirrored, not shared through the table: the old app reads whatsapp_api_token, clover_cstore_token and clover_vape_token from its config tab, the new app from the WHATSAPP_API_TOKEN, CLOVER_CSTORE_TOKEN and CLOVER_VAPE_TOKEN bindings; before every call the harness sets each binding from the old tab's value (blank: no binding), so both sides hold the same secrets. The WhatsApp token is shown as <secret>, a Clover token as <secret:its key> (so the wrong till's token is a difference), and none is ever printed.";

/** A secret both sides hold, and how it is shown. */
export interface Secret {
  label: string;
  value: string;
}
/** One secret (shown as <secret>), a list, or none. */
export type Secrets = string | null | readonly Secret[];
const listOf = (s: Secrets): readonly Secret[] => (s === null ? [] : typeof s === "string" ? [{ label: "<secret>", value: s }] : s).filter((x) => x.value !== "");

const UNSCRIPTED = "parity: an outbound request the case did not script";

// ── Recording and answering ────────────────────────────────

const lower = (h: Record<string, unknown> | undefined): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = String(v);
  return out;
};

const textOf = (body: unknown): string => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body));

export class Outbound {
  readonly requests: RecordedRequest[] = [];
  #next = 0;
  readonly #script: readonly HttpReply[];

  constructor(script: readonly HttpReply[] = []) {
    this.#script = script;
  }

  /** Scripted replies nobody asked for. */
  get unused(): number {
    return this.#script.length - this.#next;
  }

  #answer(req: RecordedRequest): { status: number; text: string } {
    this.requests.push(req);
    const reply = this.#script[this.#next];
    if (reply === undefined) {
      req.scripted = false;
      throw new Error(`${UNSCRIPTED}: ${req.method} ${req.url}`);
    }
    this.#next++;
    if ("throws" in reply) throw new Error(reply.throws);
    return { status: reply.status, text: textOf(reply.body) };
  }

  /** The old side's UrlFetchApp.fetch(url, options). */
  readonly oldFetch = (url: string, options: { method?: string; headers?: Record<string, unknown>; payload?: unknown } = {}) => {
    const { status, text } = this.#answer({
      method: (options.method ?? "get").toUpperCase(),
      url: String(url),
      headers: lower(options.headers),
      body: options.payload === undefined ? null : textOf(options.payload),
      scripted: true,
    });
    return { getResponseCode: () => status, getContentText: () => text };
  };

  /** The new side's ctx.fetch. */
  readonly newFetch: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const { status, text } = this.#answer({
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      headers,
      body: init?.body === undefined || init.body === null ? null : typeof init.body === "string" ? init.body : "(a body that is not text)",
      scripted: true,
    });
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };
}

// ── Views and the comparison ───────────────────────────────

/** `value` with every occurrence of the secret replaced, at any depth. */
export function redact<T>(value: T, secret: Secrets): T {
  const secrets = listOf(secret);
  if (secrets.length === 0) return value;
  const text = (s: string): string => secrets.reduce((t, x) => (t.includes(x.value) ? t.split(x.value).join(x.label) : t), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** "Bearer <secret>" when it is the secret; anything else says what it is without printing it. */
function authorizationView(value: string | undefined, secret: Secrets): string {
  if (value === undefined) return "(none)";
  const held = listOf(secret).find((x) => value === `Bearer ${x.value}`);
  if (held) return `Bearer ${held.label}`;
  if (value.startsWith("Bearer ")) return "Bearer <a different value>";
  return "(another scheme)";
}

function bodyView(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function viewOf(r: RecordedRequest, secret: Secrets): RequestView {
  return redact(
    {
      method: r.method,
      url: r.url,
      authorization: authorizationView(r.headers["authorization"], secret),
      contentType: r.headers["content-type"] ?? "(none)",
      body: bodyView(r.body),
    },
    secret,
  );
}

export interface OutboundComparison {
  old: RequestView[];
  new: RequestView[];
  diffs: { path: string; old: string; new: string }[];
}

export function diffOutbound(o: Outbound, n: Outbound, secret: Secrets): OutboundComparison {
  const old = o.requests.map((r) => viewOf(r, secret));
  const now = n.requests.map((r) => viewOf(r, secret));
  const diffs: { path: string; old: string; new: string }[] = [];
  diffValues(old, now, "outbound", diffs);
  for (const [side, out] of [["old", o], ["new", n]] as const) {
    out.requests.forEach((r, i) => {
      if (r.scripted) return;
      const what = `${r.method} ${redact(r.url, secret)}: the case scripted no reply for it`;
      diffs.push({ path: `outbound[${i}] (unscripted)`, old: side === "old" ? what : "", new: side === "new" ? what : "" });
    });
  }
  if (o.unused > 0) diffs.push({ path: "outbound (scripted replies)", old: `${o.unused} scripted repl${o.unused === 1 ? "y" : "ies"} the old side never asked for`, new: "" });
  return { old, new: now, diffs };
}
