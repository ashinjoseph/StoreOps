// The three routes for receipt originals (cards P5-12a and P5-12b; ADR-0026), beside /rpc/* and /mcp in index.ts:
//
//   PUT /files/receipt-original                     add an original: the raw file is the body
//   GET /files/receipt-original/<id>                send one back, to a session allowed to see it
//   PUT /files/receipt-original/by-ticket/<ticket>  an assistant's original, by a one-time ticket (at the end)
//
// The first two:
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
import { callerHash, floodAllows, recordCall } from "../mcp/limits";
import * as originals from "./originals";
import { NOT_ACCEPTED, sniff, type ContentType } from "./sniff";
import type { ReceiptStorage } from "./storage";
import * as tickets from "./tickets";

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

function fault(deps: { log: (entry: object) => void }, where: string, err: unknown): Response {
  const id = crypto.randomUUID();
  try {
    deps.log({ route: UPLOAD_PATH, where, id, errorClass: err instanceof Error ? err.name : typeof err, message: err instanceof Error ? err.message : "" });
  } catch {
    // A failing logger must not turn a fault into a crash.
  }
  return answer(500, { ok: false, error: { message: "SERVER_ERROR", id } });
}

// ── The one path every file goes through (the page's upload and the ticket route) ──

/** Content-Length present and within `limit`, checked before a byte of the body is read. */
export async function checkLength(request: Request, limit: number): Promise<{ ok: true; claimed: number } | { ok: false; response: Response }> {
  const lengthText = request.headers.get("content-length");
  if (lengthText === null || !/^[0-9]{1,12}$/.test(lengthText)) return { ok: false, response: refuse(411, "The size of the file was not sent (Content-Length is required).") };
  const claimed = Number(lengthText);
  if (claimed > limit) {
    await request.body?.cancel().catch(() => undefined);
    return { ok: false, response: refuse(413, tooLarge(limit)) };
  }
  return { ok: true, claimed };
}

export type Received =
  | { ok: true; bytes: Uint8Array; type: ContentType; sha256: Uint8Array }
  | { ok: false; response: Response; reason: "empty" | "too_long" | "incomplete" | "not_accepted" };

/** The body: read with a hard cap of the size claimed, its type from the bytes, its SHA-256. */
export async function receiveFile(request: Request, claimed: number, limit: number): Promise<Received> {
  if (claimed === 0) return { ok: false, reason: "empty", response: refuse(400, `The file is empty. ${NOT_ACCEPTED}`) };
  // Read no more than was claimed: a body longer than its Content-Length is refused.
  const bytes = await readCapped(request.body, claimed);
  if (bytes === null) return { ok: false, reason: "too_long", response: refuse(413, `The file is larger than its stated size. ${tooLarge(limit)}`) };
  if (bytes.byteLength !== claimed) return { ok: false, reason: "incomplete", response: refuse(400, "The file arrived incomplete. Send it again.") };
  const type: ContentType | null = sniff(bytes);
  if (type === null) return { ok: false, reason: "not_accepted", response: refuse(415, NOT_ACCEPTED) };
  const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return { ok: true, bytes, type, sha256 };
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
    const length = await checkLength(request, limit);
    if (!length.ok) return length.response;
    const file = await receiveFile(request, length.claimed, limit);
    if (!file.ok) return file.response;
    const { bytes, type, sha256 } = file;
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

// ── The ticket route (card P5-12b) ─────────────────────────
//
//   PUT /files/receipt-original/by-ticket/<ticket>   an assistant's file: the raw file is the body
//
// The ticket (tickets.ts) is the only credential: a session token or an assistant key on this route is
// never read. In this order: PUT only (405); no Origin header at all (403: no browser has business here);
// the door is on (assistants_enabled; off: the fixed 404, nothing written); storage bound (503);
// Content-Length required (411) and within receipt_max_mb (413): these two refusals neither read the
// body nor spend the ticket; then, in one transaction, the ticket found under its row lock. Unknown,
// malformed, used, expired, or its key expired or withdrawn or its person inactive: the SAME 404 with
// the same body, the reason only in ops.assistant_calls (flood-limited as refused sign-ins are). A usable
// ticket is spent and the PUT recorded, committed before the body is read; then the file goes through
// exactly the page's path (receiveFile, originals.add) and the ticket is marked with what became of it.

export interface TicketRouteDeps {
  openDb: () => Promise<Db & { close(): Promise<void> }>;
  /** Null when the RECEIPTS binding is missing. */
  storage: ReceiptStorage | null;
  now: () => Date;
  log: (entry: object) => void;
}

/** The one answer to every refused ticket, byte for byte. */
export const NO_TICKET_BODY = JSON.stringify({ ok: false, error: { message: "No such upload address. Ask for a new one with receipt_upload_start." } });
const noTicket = (): Response => new Response(NO_TICKET_BODY, { status: 404, headers: HEADERS });

/** PUT /files/receipt-original/by-ticket/<ticket>. */
export async function handleTicketUpload(request: Request, deps: TicketRouteDeps): Promise<Response> {
  if (request.method !== "PUT") return new Response(JSON.stringify({ ok: false, error: { message: "METHOD_NOT_ALLOWED" } }), { status: 405, headers: { ...HEADERS, allow: "PUT" } });
  if (request.headers.has("origin")) return refuse(403, "FORBIDDEN: this address takes a file from an assistant's own computer, never from a web page.");
  let conn: Db & { close(): Promise<void> };
  try {
    conn = await deps.openDb();
  } catch (err) {
    return fault(deps, "open", err);
  }
  try {
    const now = deps.now();
    const config = await withTransaction(conn, (tx) => loadConfig(tx));
    if (!config.boolean("assistants_enabled")) {
      await request.body?.cancel().catch(() => undefined);
      return noTicket();
    }
    if (deps.storage === null) return refuse(503, "Receipt storage is not set up on this server.");
    const storage = deps.storage;
    const limit = originals.maxBytes(config);
    const length = await checkLength(request, limit);
    if (!length.ok) return length.response;
    const presented = tickets.ticketFromPath(new URL(request.url).pathname);
    const caller = await callerHash(request.headers.get("cf-connecting-ip"));
    const tookMs = (): number => deps.now().getTime() - now.getTime();
    const found = await withTransaction(conn, async (tx) => {
      const r = await tickets.lockForPut(tx, presented, now);
      if (!r.ok) {
        if (await floodAllows(tx, caller, now)) {
          await recordCall(tx, { keyId: r.keyId, tool: tickets.PUT_RECORD_NAME, at: now, allowed: false, refusal: r.reason, tookMs: tookMs(), proposal: false, callerHash: caller });
        }
        return r;
      }
      await tickets.spend(tx, r.ticket.ticketId, now);
      await recordCall(tx, { keyId: r.ticket.keyId, tool: tickets.PUT_RECORD_NAME, at: now, allowed: true, refusal: null, tookMs: tookMs(), proposal: false, callerHash: caller });
      return r;
    });
    if (!found.ok) {
      await request.body?.cancel().catch(() => undefined);
      return noTicket();
    }
    const t = found.ticket;
    const file = await receiveFile(request, length.claimed, limit);
    if (!file.ok) {
      await withTransaction(conn, (tx) => tickets.markOutcome(tx, t.ticketId, { kind: "refused", refusal: file.reason }, deps.now()));
      return file.response;
    }
    const added = await withTransaction(conn, async (tx) => {
      const a = await originals.add(
        tx,
        storage,
        { bytes: file.bytes, sha256: file.sha256, contentType: file.type, business: t.business, source: t.source, fileName: t.fileName, note: t.note, from: { keyId: t.keyId, source: t.source, email: t.email } },
        { staffId: t.staffId, role: "assistant" },
        now,
      );
      await tickets.markOutcome(tx, t.ticketId, { kind: a.duplicate ? "duplicate" : "kept", receiptId: a.record.id }, now);
      return a;
    });
    const result = added.duplicate
      ? { duplicate: true, message: added.message, id: added.record.id, addedAt: added.record.addedAt }
      : { duplicate: false, message: added.message, id: added.record.id, addedAt: added.record.addedAt, size: file.bytes.byteLength, type: file.type };
    return answer(added.duplicate ? 200 : 201, { ok: true, result });
  } catch (err) {
    return fault(deps, "ticket", err);
  } finally {
    await conn.close().catch(() => undefined);
  }
}
