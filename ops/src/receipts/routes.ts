// The two routes for receipt originals (card P5-12a; ADR-0026), beside /rpc/* and /mcp in index.ts:
//
//   PUT /files/receipt-original        add an original: the raw file is the body
//   GET /files/receipt-original/<id>   send one back, to a session allowed to see it
//
// Both take the page's own session token as `Authorization: Bearer <token>` and resolve it exactly as
// the RPC router does (resolveSession, in a transaction of its own, committed before anything else), so
// identity and role come from the session only. Neither ever takes a token from the URL, and neither
// sends a cookie or a CORS header. A request with an Origin header other than the app's own is refused
// (the page and the API share one origin; this closes cross-site uploads with a stolen token).
//
// The upload, in this order: session, size (Content-Length required and within receipt_max_mb before a
// byte is read), the body read with a hard cap (never more than the limit is buffered, whatever
// Content-Length claimed), the type from the bytes, the SHA-256, then originals.add (duplicate check,
// store, row, audit) in one transaction.
//
// The view: an original is a file somebody uploaded, sent to a signed-in person's browser. It goes out
// with the type decided at upload, nosniff, inline under a generated name, never cached, and a
// sandboxing policy, so that a hostile PDF or image cannot run script on the app's origin. An id the
// session may not see answers exactly as an id that does not exist.
import { NOT_LOGGED_IN, type Session } from "../auth/types";
import type { Db } from "../db/client";
import { withTransaction } from "../db/tx";
import { loadConfig } from "../lib/config";
import * as originals from "./originals";
import { NOT_ACCEPTED, sniff, type ContentType } from "./sniff";
import type { ReceiptStorage } from "./storage";

export const UPLOAD_PATH = "/files/receipt-original";
export const VIEW_PREFIX = "/files/receipt-original/";
/** The policy every original is served with. */
export const VIEW_CSP = "sandbox; default-src 'none'";

export interface ReceiptRouteDeps {
  openDb: () => Promise<Db & { close(): Promise<void> }>;
  /** The router's own: throws Error(NOT_LOGGED_IN). */
  resolveSession: (db: import("../db/tx").Tx, token: unknown, now: Date) => Promise<Session>;
  /** Null when the RECEIPTS binding is missing. */
  storage: ReceiptStorage | null;
  now: () => Date;
  log: (entry: object) => void;
}

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } as const;

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}
const refuse = (status: number, message: string): Response => answer(status, { ok: false, error: { message } });

/** The bearer token, or null. Only the Authorization header is read. */
function bearer(request: Request): string | null {
  const h = request.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(h.trim());
  return m ? (m[1] as string) : null;
}

/** False when the request names an origin other than its own (a request with no Origin passes). */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  return origin === new URL(request.url).origin;
}

/** A percent-encoded UTF-8 header value, decoded; null when absent or not decodable. */
function decodedHeader(request: Request, name: string): string | null {
  const raw = request.headers.get(name);
  if (raw === null || raw === "") return null;
  if (raw.length > 6000) return raw.slice(0, 6000);
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * The body, read until `cap` bytes; null as soon as more than `cap` arrive (reading stops there and
 * the stream is cancelled). Never buffers more than `cap` plus one chunk.
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number): Promise<Uint8Array | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const tooLarge = (limit: number): string =>
  `This file is larger than ${Math.round(limit / originals.MB)} MB, the most the app keeps. For a photo, choose a smaller picture size on the phone and take it again; for a PDF, ask for a smaller copy.`;

async function withSession<T>(deps: ReceiptRouteDeps, request: Request, fn: (db: Db & { close(): Promise<void> }, session: Session, now: Date) => Promise<T>): Promise<T | Response> {
  const token = bearer(request);
  if (token === null) return refuse(401, NOT_LOGGED_IN);
  let conn: Db & { close(): Promise<void> };
  try {
    conn = await deps.openDb();
  } catch (err) {
    return fault(deps, "open", err);
  }
  try {
    const now = deps.now();
    let session: Session;
    try {
      session = await withTransaction(conn, (tx) => deps.resolveSession(tx, token, now));
    } catch (err) {
      if (err instanceof Error && err.message === NOT_LOGGED_IN) return refuse(401, NOT_LOGGED_IN);
      throw err;
    }
    return await fn(conn, session, now);
  } catch (err) {
    return fault(deps, "receipt", err);
  } finally {
    await conn.close().catch(() => undefined);
  }
}

function fault(deps: ReceiptRouteDeps, where: string, err: unknown): Response {
  const id = crypto.randomUUID();
  try {
    deps.log({ route: UPLOAD_PATH, where, id, errorClass: err instanceof Error ? err.name : typeof err, message: err instanceof Error ? err.message : "" });
  } catch {
    // A failing logger must not turn a fault into a crash.
  }
  return answer(500, { ok: false, error: { message: "SERVER_ERROR", id } });
}

/** PUT /files/receipt-original. */
export async function handleUpload(request: Request, deps: ReceiptRouteDeps): Promise<Response> {
  if (request.method !== "PUT") return new Response(JSON.stringify({ ok: false, error: { message: "METHOD_NOT_ALLOWED" } }), { status: 405, headers: { ...HEADERS, allow: "PUT" } });
  if (!sameOrigin(request)) return refuse(403, "FORBIDDEN: this address takes uploads from the app's own page only.");
  const result = await withSession(deps, request, async (conn, session, now) => {
    if (deps.storage === null) return refuse(503, "Receipt storage is not set up on this server.");
    const storage = deps.storage;
    const config = await withTransaction(conn, (tx) => loadConfig(tx));
    const limit = originals.maxBytes(config);
    const lengthText = request.headers.get("content-length");
    if (lengthText === null || !/^[0-9]{1,12}$/.test(lengthText)) return refuse(411, "The size of the file was not sent (Content-Length is required).");
    const claimed = Number(lengthText);
    if (claimed === 0) return refuse(400, `The file is empty. ${NOT_ACCEPTED}`);
    if (claimed > limit) {
      await request.body?.cancel().catch(() => undefined);
      return refuse(413, tooLarge(limit));
    }
    // Read no more than was claimed: a body longer than its Content-Length is refused.
    const bytes = await readCapped(request.body, claimed);
    if (bytes === null) return refuse(413, `The file is larger than its stated size. ${tooLarge(limit)}`);
    if (bytes.byteLength !== claimed) return refuse(400, "The file arrived incomplete. Send it again.");
    const type: ContentType | null = sniff(bytes);
    if (type === null) return refuse(415, NOT_ACCEPTED);
    const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const added = await withTransaction(conn, (tx) =>
      originals.add(
        tx,
        storage,
        {
          bytes,
          sha256,
          contentType: type,
          business: request.headers.get("x-receipt-business"),
          source: request.headers.get("x-receipt-source"),
          fileName: decodedHeader(request, "x-receipt-filename"),
          note: decodedHeader(request, "x-receipt-note"),
        },
        { staffId: session.staffId, role: session.role },
        now,
      ),
    );
    return answer(added.duplicate ? 200 : 201, { ok: true, result: added });
  });
  return result;
}

/** A file name for the browser, made here: the date and the id, and the type's extension. */
const EXT: Readonly<Record<ContentType, string>> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" };

/** GET /files/receipt-original/<id>. */
export async function handleView(request: Request, deps: ReceiptRouteDeps): Promise<Response> {
  if (request.method !== "GET") return new Response(JSON.stringify({ ok: false, error: { message: "METHOD_NOT_ALLOWED" } }), { status: 405, headers: { ...HEADERS, allow: "GET" } });
  if (!sameOrigin(request)) return refuse(403, "FORBIDDEN: originals are shown in the app's own page only.");
  const id = new URL(request.url).pathname.slice(VIEW_PREFIX.length);
  const result = await withSession(deps, request, async (conn, session, now) => {
    if (deps.storage === null) return refuse(503, "Receipt storage is not set up on this server.");
    const found = await withTransaction(conn, (tx) => originals.forView(tx, { staffId: session.staffId, role: session.role }, id, now));
    if (found === null) return refuse(404, "No such receipt original.");
    const object = await deps.storage.get(found.storageKey);
    if (object === null) {
      deps.log({ route: VIEW_PREFIX, where: "missing object", id: found.id });
      return refuse(404, "No such receipt original.");
    }
    return new Response(object.bytes, {
      status: 200,
      headers: {
        "content-type": found.contentType,
        "content-length": String(object.bytes.byteLength),
        "x-content-type-options": "nosniff",
        "content-disposition": `inline; filename="receipt-${found.id}.${EXT[found.contentType]}"`,
        "cache-control": "private, no-store",
        "content-security-policy": VIEW_CSP,
      },
    });
  });
  return result;
}
