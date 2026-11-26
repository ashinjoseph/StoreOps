// The two public pages: `GET /?v=recon` (the 7-day report) and `GET /?v=sales` (the sales page).
// The port of src/WebApp.gs doGet's two public views, publicReconPage_ and publicSalesPage_.
//
// These are the only pages of the app anyone on the internet can open with no sign-in, so:
//   - No session, no RPC (ADR-0003). The payload is built here and inlined into the template; the
//     page's script makes no call (and its content security policy allows none).
//   - Nothing is read from the request but its method and its URL's `v` and `days`: no cookie, no
//     token, no header, no body, no other query parameter.
//   - Read only: one connection, one READ ONLY transaction around the whole build, the connection
//     always closed. A write attempted inside the build is refused by the database.
//   - `days` is coerced, then clamped, exactly as before: recon 1-31 (default 7), sales 1-365
//     (default 60). The old code already had both upper bounds.
//   - If anything fails (no database, the build throws), the old fallback payload ("Report
//     temporarily unavailable.") is served, with status 503 (the page is temporarily unavailable;
//     the old Apps Script page could only answer 200), and one log line { event, view, errorClass,
//     message }. No message, stack, table name or value reaches the response.
//
// The title is the old setTitle's ('StoreOps · <days>-day report' / 'StoreOps · sales'), written into
// the template's <title>. The old addMetaTag('viewport', ...) is the template's own meta tag already.
// The old ALLOWALL frame option (Apps Script serves inside an iframe) is not kept: these pages are
// never framed (frame-ancestors 'none', X-Frame-Options DENY from secure()).
import type { Db } from "../db/client";
import { loadConfig } from "../lib/config";
import { build, buildSales, type PublicDeps as ReportDeps } from "../modules/public-report";
import { inlineJson } from "./inline";
import { PUBLIC_TEMPLATES, type PublicTemplate } from "./templates.generated";

export type PublicView = "recon" | "sales";

/** A public page's builder: the module's build or buildSales (replaceable in tests). */
export type Builder = (db: Db, days: number, deps: ReportDeps) => Promise<unknown>;

export interface PublicDeps {
  /** One connection for this request; the handler closes it. */
  openDb: () => Promise<Db & { close(): Promise<void> }>;
  now: () => Date;
  log: (entry: Record<string, unknown>) => void;
  /** Tests only: replace a builder. */
  build?: Partial<Record<PublicView, Builder>>;
}

const BUILDERS: Record<PublicView, Builder> = { recon: build, sales: buildSales };
const UNAVAILABLE = "Report temporarily unavailable.";

/**
 * The public view this request is for, or null for anything else (which then goes where it went
 * before: the app page, or a 405). GET or HEAD, the path exactly "/", and `v` exactly "recon" or
 * "sales" (case-sensitive; the first `v` when there are several, as Apps Script's e.parameter).
 */
export function publicView(request: Request): PublicView | null {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (url.pathname !== "/") return null;
  const v = url.searchParams.get("v") || "";
  return v === "recon" || v === "sales" ? v : null;
}

/**
 * `?days=`, as publicReconPage_ / publicSalesPage_ read it: `Number(raw || default)`; NaN is the
 * default; then rounded and clamped to 1-31 (recon) or 1-365 (sales).
 */
export function parseDays(view: PublicView, raw: string | null): number {
  const [def, max] = view === "recon" ? [7, 31] : [60, 365];
  const n = Number(raw || def);
  return Number.isNaN(n) ? def : Math.min(max, Math.max(1, Math.round(n)));
}

/** What the old page served when the build threw. */
export function fallbackPayload(view: PublicView, days: number): Record<string, unknown> {
  if (view === "sales") return { days, unavailable: UNAVAILABLE };
  return {
    days,
    fromStr: "",
    toStr: "",
    generatedAt: "",
    reserve: { unavailable: UNAVAILABLE },
    cash: { unavailable: UNAVAILABLE },
    reconcile: { unavailable: UNAVAILABLE },
  };
}

/** The old setTitle. */
export function pageTitle(view: PublicView, days: unknown): string {
  return view === "recon" ? `StoreOps · ${String(days)}-day report` : "StoreOps · sales";
}

const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The page: the template with the inlined payload at its one tag, and the old title in its <title>. */
export function renderPublicPage(view: PublicView, template: PublicTemplate, payload: unknown): string {
  const days = payload !== null && typeof payload === "object" ? (payload as { days?: unknown }).days : undefined;
  const before = template.before.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(pageTitle(view, days))}</title>`);
  return before + inlineJson(payload) + template.after;
}

/**
 * The CSP source for the page's one inline script: sha256 of its text exactly as the HTML parser
 * hands it to the script engine (from the end of <script ...> to the first </script; newlines as
 * the parser normalises them).
 */
export async function scriptHash(html: string): Promise<string> {
  const open = /<script\b[^>]*>/i.exec(html);
  if (!open) throw new Error("public page: no inline script");
  const start = open.index + open[0].length;
  const end = html.slice(start).search(/<\/script/i);
  if (end === -1) throw new Error("public page: the script is not closed");
  const text = html.slice(start, start + end).replace(/\r\n?/g, "\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return `'sha256-${btoa(bin)}'`;
}

/**
 * The policy for a public page: nothing but this response's one inline script, inline styles (the
 * template's <style> and the style attributes its script writes), no requests of any kind (no RPC,
 * no image, no font), no <base> URL, no form, never framed.
 */
export function publicCsp(hash: string): string {
  return `default-src 'none'; script-src ${hash}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

/**
 * Run `fn` inside one READ ONLY transaction on `db` (begin transaction read only … commit; rollback
 * when anything fails). Any insert, update or delete inside it is refused by the database (SQLSTATE
 * 25006). Next to the handler because withTransaction (db/tx.ts) has no read-only form.
 */
export async function withReadOnlyTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  await db.query("begin transaction read only");
  let result: T;
  try {
    result = await fn(db);
  } catch (err) {
    await db.query("rollback").catch(() => undefined);
    throw err;
  }
  try {
    await db.query("commit");
  } catch (err) {
    await db.query("rollback").catch(() => undefined);
    throw err;
  }
  return result;
}

/**
 * Serve a public page. Reads only `request.method` and `request.url`. Answers the page (200) or the
 * old fallback (503), with the headers below; the caller passes `csp` to secure() for this response.
 */
export async function handlePublic(request: Request, _env: unknown, deps: PublicDeps): Promise<{ response: Response; csp: string }> {
  const method = request.method;
  const url = new URL(request.url);
  const view = publicView(request);
  if (view === null) throw new Error("handlePublic: not a public page request");
  const days = parseDays(view, url.searchParams.get("days"));
  const builder = deps.build?.[view] ?? BUILDERS[view];

  let payload: unknown;
  let status = 200;
  try {
    const conn = await deps.openDb();
    try {
      payload = await withReadOnlyTransaction(conn, async (tx) => builder(tx, days, { config: await loadConfig(tx), now: deps.now() }));
    } finally {
      await conn.close().catch(() => undefined);
    }
  } catch (err) {
    deps.log({ event: "public_page.failed", view, errorClass: err instanceof Error ? err.name : typeof err, message: err instanceof Error ? err.message : String(err) });
    payload = fallbackPayload(view, days);
    status = 503;
  }

  const html = renderPublicPage(view, PUBLIC_TEMPLATES[view], payload);
  const csp = publicCsp(await scriptHash(html));
  const response = new Response(method === "HEAD" ? null : html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
    },
  });
  return { response, csp };
}
