// Receipt originals: the record of every photo or file received for the books (card P5-12a; ADR-0026).
// NEW in the Operations app (ADR-0023); ops/test/receipt-inbox.test.ts is the specification.
//
// The original itself is in object storage (storage.ts) under a key made from a random id, kept byte for
// byte; this file keeps its record in ops.receipt_originals: the SHA-256, the size, the type decided by
// the bytes (sniff.ts), who added it and when, the business when somebody said so (NULL: not known,
// never guessed), and its status. Nothing is extracted here (later cards).
//
// Rules:
//   - The same bytes twice are one original. `add` takes an advisory lock on the hash, then looks for it,
//     so two uploads of the same bytes at the same moment store one object and one row; the second is
//     answered with the first ("already on file").
//   - Nothing is erased, overwritten or moved. Set aside (with a reason) and put back change the row's
//     status only; the object and the hash are not touched.
//   - Who may see what is decided here from the viewer (rule 5 of the card): admin, manager and payroll
//     admin see every original; an employee sees only the originals they added in the last 7 days. An
//     original an employee may not see answers exactly as one that does not exist.
//   - The file name and the note are shown to people only: cleaned, capped, never used in a key or a path.
// Time is the caller's `now`; ids from crypto; SQL takes values as parameters only.
import type { Db } from "../db/client";
import type { Tx } from "../db/tx";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import { formatDate, formatDateTime } from "../lib/dates";
import { type Business, isBusiness } from "./businesses";
import * as drafts from "./drafts";
import { type ContentType } from "./sniff";
import type { ReceiptStorage } from "./storage";

/** drafted (card P5-05a): read, its draft waiting for review (ops/src/receipts/drafts.ts). confirmed (card P5-05b): its receipt is on the books (review.ts). */
export const STATUSES = ["waiting", "drafted", "confirmed", "set_aside"] as const;
export type Status = (typeof STATUSES)[number];
export const SOURCES = ["photo", "upload"] as const;
export type Source = (typeof SOURCES)[number];
export const SEE_ALL: readonly string[] = ["admin", "manager", "payroll_admin"];
export const SET_ASIDE_ROLES: readonly string[] = ["admin", "manager"];
export const EMPLOYEE_DAYS = 7;
export const FILE_NAME_MAX = 120;
export const NOTE_MAX = 300;
export const REASON_MIN = 3;
export const REASON_MAX = 300;
export const PAGE_MAX = 50;
export const PAGE_DEFAULT = 20;
export const MB = 1024 * 1024;
export const MAX_MB_LIMIT = 25;

const DAY_MS = 86_400_000;
const ID = /^ro[0-9a-f]{24}$/;
/** Controls, U+2028/2029 and the bidirectional overrides and isolates: removed from a name or a note. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

export interface Viewer {
  staffId: string;
  role: string;
}

/** The largest original accepted, in bytes: the setting receipt_max_mb, whole MB from 1 to 25 (default 10). */
export function maxBytes(config: Config): number {
  const n = Math.floor(config.number("receipt_max_mb", 10));
  return Math.min(Math.max(Number.isFinite(n) ? n : 10, 1), MAX_MB_LIMIT) * MB;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const newReceiptId = (): string => "ro" + hex(crypto.getRandomValues(new Uint8Array(12)));
/** The storage key: the Toronto month and the random id. Nothing a person typed is ever in it. */
export const storageKeyFor = (id: string, now: Date): string => `originals/${formatDate(now).slice(0, 7)}/${id}`;

/** One line, shown to a person: no control or direction characters, no path (the last part after / or \), capped. Blank is null. */
export function cleanFileName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const lastPart = raw.split(/[/\\]/).pop() ?? "";
  const text = lastPart.replace(UNSAFE, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  if (text === "") return null;
  const chars = [...text];
  return chars.length <= FILE_NAME_MAX ? text : chars.slice(0, FILE_NAME_MAX).join("");
}

/** Free text an outsider wrote (a note, an email's subject): one line, no control or direction characters, capped at `max`. Blank is null. */
export function cleanLine(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(UNSAFE, "").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** The uploader's note: one line, no control or direction characters, capped at 300. Blank is null. */
export function cleanNote(raw: unknown): string | null {
  return cleanLine(raw, NOTE_MAX);
}

// ── The record as people see it ───────────────────────────

export interface OriginalView {
  id: string;
  addedAt: string;
  /** The name of who added it. */
  addedBy: string;
  /** True when the viewer added it. */
  mine: boolean;
  business: Business | null;
  source: string;
  contentType: ContentType;
  size: number;
  fileName: string | null;
  note: string | null;
  status: Status;
  setAside: { reason: string; by: string; at: string } | null;
  /** Only on an original an assistant handed over (card P5-12b): the label of the key it used. */
  assistant?: { label: string };
  /**
   * Only on an original from an email: the sender and date as the assistant gave them (text, shown as text),
   * the subject when it said, and (card P5-13) which attachment it was (its name as the email gives it and its
   * position) or `print: true` when it is a PDF print of the email's own text, made by the assistant.
   */
  email?: { from: string; date: string; subject?: string; attachment?: { name: string; position: number }; print?: true };
  /** Only on a drafted original in the list of admin, manager and payroll admin (card P5-05a): its live draft's headline. */
  draft?: DraftHeadline;
}

/** What the "Read, waiting for review" list shows of a draft. Money as exact text ("56.60"). */
export interface DraftHeadline {
  id: string;
  supplier: string | null;
  date: string | null;
  total: string;
  business: Business | null;
  needsAttention: boolean;
  failed: number;
  /** Card P5-05c: the currency printed, when it is not Canadian dollars (the total is then in it, and shown with its code). */
  currency?: string;
}

interface Row {
  receipt_id: string;
  sha256: Buffer;
  size_bytes: number;
  content_type: ContentType;
  storage_key: string;
  business: Business | null;
  status: Status;
  set_aside_reason: string | null;
  set_aside_by: string | null;
  set_aside_by_name: string | null;
  set_aside_at: Date | null;
  source: string;
  added_by: string;
  added_by_name: string | null;
  added_at: Date;
  file_name: string | null;
  note: string | null;
  assistant_key_id: string | null;
  key_label: string | null;
  email_message_id: string | null;
  email_sender: string | null;
  email_date: Date | null;
  email_subject: string | null;
  email_attachment_name: string | null;
  email_attachment_position: number | null;
  email_print: boolean | null;
}

const SELECT = `select o.receipt_id, o.sha256, o.size_bytes, o.content_type, o.storage_key, o.business, o.status,
                       o.set_aside_reason, o.set_aside_by, sa.name as set_aside_by_name, o.set_aside_at,
                       o.source, o.added_by, ad.name as added_by_name, o.added_at, o.file_name, o.note,
                       o.assistant_key_id, ak.label as key_label, o.email_message_id, o.email_sender, o.email_date,
                       o.email_subject, o.email_attachment_name, o.email_attachment_position, o.email_print
                  from ops.receipt_originals o
                  left join ops.staff ad on ad.staff_id = o.added_by
                  left join ops.staff sa on sa.staff_id = o.set_aside_by
                  left join ops.assistant_keys ak on ak.key_id = o.assistant_key_id`;

const nameOr = (name: string | null, id: string): string => (name ?? id).trim();

/** The email part of a row: sender and date, and only what is set of the subject, the attachment and the print mark. */
function emailOf(r: Row): { from: string; date: string; subject?: string; attachment?: { name: string; position: number }; print?: true } {
  return {
    from: r.email_sender as string,
    date: (r.email_date as Date).toISOString(),
    ...(r.email_subject !== null ? { subject: r.email_subject } : {}),
    ...(r.email_attachment_name !== null && r.email_attachment_position !== null ? { attachment: { name: r.email_attachment_name, position: r.email_attachment_position } } : {}),
    ...(r.email_print === true ? { print: true as const } : {}),
  };
}

function view(r: Row, viewer: Viewer): OriginalView {
  return {
    id: r.receipt_id,
    addedAt: r.added_at.toISOString(),
    addedBy: nameOr(r.added_by_name, r.added_by),
    mine: r.added_by === viewer.staffId,
    business: r.business,
    source: r.source,
    contentType: r.content_type,
    size: r.size_bytes,
    fileName: r.file_name,
    note: r.note,
    status: r.status,
    setAside: r.status === "set_aside" && r.set_aside_at !== null ? { reason: r.set_aside_reason ?? "", by: nameOr(r.set_aside_by_name, r.set_aside_by ?? ""), at: r.set_aside_at.toISOString() } : null,
    ...(r.assistant_key_id !== null ? { assistant: { label: r.key_label ?? r.assistant_key_id } } : {}),
    ...(r.email_sender !== null && r.email_date !== null ? { email: emailOf(r) } : {}),
  };
}

/** Whether `viewer` may see this original (list it, view it). */
export function maySee(viewer: Viewer, row: { added_by: string; added_at: Date }, now: Date): boolean {
  if (SEE_ALL.includes(viewer.role)) return true;
  return row.added_by === viewer.staffId && now.getTime() - row.added_at.getTime() < EMPLOYEE_DAYS * DAY_MS;
}

// ── Adding ─────────────────────────────────────────────────

export interface AddInput {
  bytes: Uint8Array;
  sha256: Uint8Array;
  contentType: ContentType;
  business: unknown;
  source: unknown;
  fileName: unknown;
  note: unknown;
  /**
   * Only for an original an assistant handed over through an upload ticket (card P5-12b): the key it
   * used, and the source it declared (an email's message id, sender and date, already checked).
   * Nothing a person sends can set this: the page's route never passes it.
   */
  from?: { keyId: string; source: "assistant" | "email"; email: ({ messageId: string; sender: string; date: Date } & import("./tickets").EmailPart) | null };
}

export interface AddResult {
  duplicate: boolean;
  message: string;
  /** The full record, or (a duplicate the viewer may not see) only who added it and when. */
  record: OriginalView | { id: string; addedAt: string; addedBy: string };
}

const when = (d: Date): string => formatDateTime(d).slice(0, 16);

/**
 * Keep a new original: store the bytes, then write the row and one audit row, in `tx`. The same bytes
 * already on file: nothing is stored or written, and the answer names the first. `business` is cstore,
 * vape, or anything else for "not sure" (stored as NULL). `source` is photo or upload (default upload).
 */
export async function add(tx: Tx, storage: ReceiptStorage, input: AddInput, viewer: Viewer, now: Date): Promise<AddResult> {
  if (input.sha256.byteLength !== 32) throw new TypeError("sha256 must be 32 bytes");
  const business: Business | null = isBusiness(input.business) ? input.business : null;
  const from = input.from;
  const source: Source | "assistant" | "email" = from !== undefined ? from.source : input.source === "photo" ? "photo" : "upload";
  const email = from?.source === "email" ? from.email : null;
  if (from?.source === "email" && email === null) throw new TypeError("an emailed original needs the email's message id, sender and date");
  const fileName = cleanFileName(input.fileName);
  const note = cleanNote(input.note);
  const hash = hex(input.sha256);

  // One at a time per fingerprint: the second of two identical uploads waits here, then finds the first.
  await tx.query("select pg_advisory_xact_lock(hashtextextended('ops.receipt_originals:' || $1, 0))", [hash]);
  const existing = await tx.maybeOne<Row>(`${SELECT} where o.sha256 = $1`, [input.sha256]);
  if (existing !== null) {
    const message = `Already on file, added ${when(existing.added_at)} by ${nameOr(existing.added_by_name, existing.added_by)}.`;
    const record = maySee(viewer, existing, now) ? view(existing, viewer) : { id: existing.receipt_id, addedAt: existing.added_at.toISOString(), addedBy: nameOr(existing.added_by_name, existing.added_by) };
    return { duplicate: true, message, record };
  }

  const id = newReceiptId();
  const key = storageKeyFor(id, now);
  // The object first. If the row then cannot be written, the object stays: unreferenced and harmless,
  // and never removed by the app (docs/components/receipts.md).
  await storage.put(key, input.bytes, { contentType: input.contentType, sha256: hash, receiptId: id });
  await tx.query(
    `insert into ops.receipt_originals (receipt_id, sha256, size_bytes, content_type, storage_key, business, status, source, added_by, added_at, file_name, note,
                                        assistant_key_id, email_message_id, email_sender, email_date, email_subject, email_attachment_name, email_attachment_position, email_print)
     values ($1, $2, $3, $4, $5, $6, 'waiting', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
    [id, input.sha256, input.bytes.byteLength, input.contentType, key, business, source, viewer.staffId, now, fileName, note, from?.keyId ?? null, email?.messageId ?? null, email?.sender ?? null, email?.date ?? null,
      email?.subject ?? null, email?.attachment?.name ?? null, email?.attachment?.position ?? null, email?.print ? true : null],
  );
  const after: Record<string, unknown> = { id, sha256: hash, size: input.bytes.byteLength, type: input.contentType, business, source };
  if (from !== undefined) after["assistantKeyId"] = from.keyId;
  await audit.write(tx, { actorId: viewer.staffId, action: "receipt_original.add", targetType: "receipt_originals", targetId: id, after }, { now });
  const row = await tx.one<Row>(`${SELECT} where o.receipt_id = $1`, [id]);
  return { duplicate: false, message: `Kept. ${sizeText(row.size_bytes)}, added ${when(now)}.`, record: view(row, viewer) };
}

/** "2.4 MB", "830 KB", "512 bytes". */
export function sizeText(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

// ── Reading ────────────────────────────────────────────────

export interface InboxInput {
  status?: unknown;
  before?: unknown;
  limit?: unknown;
}

export type Inbox =
  | { scope: "all"; status: Status; items: OriginalView[]; counts: Record<Status, number>; next: string | null; canSetAside: boolean }
  | { scope: "own"; days: number; items: OriginalView[] };

/** The inbox as `viewer` may see it. Never a storage key, never a URL. */
export async function inbox(db: Db, viewer: Viewer, input: InboxInput, now: Date): Promise<Inbox> {
  if (!SEE_ALL.includes(viewer.role)) {
    const since = new Date(now.getTime() - EMPLOYEE_DAYS * DAY_MS);
    const rows = await db.query<Row>(`${SELECT} where o.added_by = $1 and o.added_at > $2 order by o.added_at desc, o.receipt_id desc limit $3`, [viewer.staffId, since, PAGE_MAX]);
    return { scope: "own", days: EMPLOYEE_DAYS, items: rows.map((r) => view(r, viewer)) };
  }
  const status: Status = input.status === "set_aside" ? "set_aside" : input.status === "drafted" ? "drafted" : input.status === "confirmed" ? "confirmed" : "waiting";
  const limitIn = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : PAGE_DEFAULT;
  const limit = Math.min(Math.max(limitIn, 1), PAGE_MAX);
  const before = typeof input.before === "string" && ID.test(input.before) ? input.before : null;
  const rows = await db.query<Row>(
    `${SELECT}
      where o.status = $1
        and ($2::text is null or (o.added_at, o.receipt_id) < (select added_at, receipt_id from ops.receipt_originals where receipt_id = $2))
      order by o.added_at desc, o.receipt_id desc
      limit $3`,
    [status, before, limit + 1],
  );
  const counts: Record<Status, number> = { waiting: 0, drafted: 0, confirmed: 0, set_aside: 0 };
  for (const c of await db.query<{ status: Status; n: number }>("select status, count(*)::int as n from ops.receipt_originals group by status")) {
    if (c.status in counts) counts[c.status] = c.n;
  }
  const page = rows.slice(0, limit);
  const heads = status === "drafted" ? await headlines(db, page.map((r) => r.receipt_id)) : new Map<string, DraftHeadline>();
  return {
    scope: "all",
    status,
    items: page.map((r) => {
      const v = view(r, viewer);
      const h = heads.get(r.receipt_id);
      return h === undefined ? v : { ...v, draft: h };
    }),
    counts,
    next: rows.length > limit ? (page[page.length - 1]?.receipt_id ?? null) : null,
    canSetAside: SET_ASIDE_ROLES.includes(viewer.role),
  };
}

/** The live drafts' headlines of these originals, by original id. One query. */
async function headlines(db: Db, ids: readonly string[]): Promise<Map<string, DraftHeadline>> {
  const out = new Map<string, DraftHeadline>();
  if (ids.length === 0) return out;
  const rows = await db.query<{ original_id: string; purchase_id: string; supplier_name: string | null; receipt_date: string | null; total: string; business: Business | null; needs_attention: boolean; failed: number; currency: string | null }>(
    `select original_id, purchase_id, supplier_name, receipt_date, total::text as total, business, needs_attention, currency,
            (select count(*)::int from jsonb_array_elements(checks) c where c->>'passed' = 'false') as failed
       from ops.purchase_receipts where original_id = any($1::text[]) and status = 'draft'`,
    [ids],
  );
  for (const r of rows) {
    out.set(r.original_id, { id: r.purchase_id, supplier: r.supplier_name, date: r.receipt_date, total: r.total, business: r.business, needsAttention: r.needs_attention, failed: r.failed, ...(r.currency !== null && r.currency !== "CAD" ? { currency: r.currency } : {}) });
  }
  return out;
}

/** What the view route needs to serve an original, or null: no such id, or one `viewer` may not see (the same answer). */
export async function forView(db: Db, viewer: Viewer, id: unknown, now: Date): Promise<{ id: string; storageKey: string; contentType: ContentType; size: number } | null> {
  if (typeof id !== "string" || !ID.test(id)) return null;
  const row = await db.maybeOne<Row>(`${SELECT} where o.receipt_id = $1`, [id]);
  if (row === null || !maySee(viewer, row, now)) return null;
  return { id: row.receipt_id, storageKey: row.storage_key, contentType: row.content_type, size: row.size_bytes };
}

// ── What an assistant reads (card P5-12b) ─────────────────
// An assistant reads for the business, not for one person: a key may list and be shown any original
// that is waiting (not set aside). Never a storage key, a URL or who set something aside.

export interface ToReadItem {
  id: string;
  addedAt: Date;
  source: string;
  contentType: ContentType;
  size: number;
  business: Business | null;
  fileName: string | null;
  note: string | null;
  email: { sender: string; date: Date; subject: string | null; attachment: { name: string; position: number } | null; print: boolean } | null;
}

const toReadItem = (r: Row): ToReadItem => ({
  id: r.receipt_id,
  addedAt: r.added_at,
  source: r.source,
  contentType: r.content_type,
  size: r.size_bytes,
  business: r.business,
  fileName: r.file_name,
  note: r.note,
  email:
    r.email_sender !== null && r.email_date !== null
      ? {
          sender: r.email_sender,
          date: r.email_date,
          subject: r.email_subject,
          attachment: r.email_attachment_name !== null && r.email_attachment_position !== null ? { name: r.email_attachment_name, position: r.email_attachment_position } : null,
          print: r.email_print === true,
        }
      : null,
});

/** The waiting originals, oldest first, a page at a time after the id `after`; and how many are waiting. */
export async function toRead(db: Db, input: { after?: string | undefined; limit: number }): Promise<{ waiting: number; items: ToReadItem[]; next: string | null }> {
  const limit = Math.min(Math.max(Math.floor(input.limit), 1), PAGE_MAX);
  const after = typeof input.after === "string" && ID.test(input.after) ? input.after : null;
  const rows = await db.query<Row>(
    `${SELECT}
      where o.status = 'waiting'
        and ($1::text is null or (o.added_at, o.receipt_id) > (select added_at, receipt_id from ops.receipt_originals where receipt_id = $1))
      order by o.added_at, o.receipt_id
      limit $2`,
    [after, limit + 1],
  );
  const waiting = (await db.one<{ n: number }>("select count(*)::int as n from ops.receipt_originals where status = 'waiting'")).n;
  const page = rows.slice(0, limit);
  return { waiting, items: page.map(toReadItem), next: rows.length > limit ? (page[page.length - 1]?.receipt_id ?? null) : null };
}

/**
 * One original for an assistant, with its storage key: waiting, or drafted (card P5-05a: so a reader can
 * look again and propose a correction); null for a malformed id, an unknown one or one set aside (the
 * same answer).
 */
export async function forAssistant(db: Db, id: unknown): Promise<(ToReadItem & { storageKey: string }) | null> {
  if (typeof id !== "string" || !ID.test(id)) return null;
  const row = await db.maybeOne<Row>(`${SELECT} where o.receipt_id = $1 and o.status in ('waiting', 'drafted')`, [id]);
  return row === null ? null : { ...toReadItem(row), storageKey: row.storage_key };
}

// ── Changing ───────────────────────────────────────────────

async function lockOne(tx: Tx, id: unknown): Promise<Row> {
  const row = typeof id === "string" && ID.test(id) ? await tx.maybeOne<Row>(`${SELECT} where o.receipt_id = $1 for update of o`, [id]) : null;
  if (row === null) throw new Error("No such receipt original.");
  return row;
}

/** Set an original aside (it is not a receipt: a reason of 3 to 300 characters) or put it back. Doing it twice changes nothing. */
export async function setAside(tx: Tx, input: { id?: unknown; aside?: unknown; reason?: unknown }, viewer: Viewer, now: Date): Promise<{ record: OriginalView; changed: boolean }> {
  if (typeof input.aside !== "boolean") throw new Error("aside must be true (set aside) or false (put back).");
  const row = await lockOne(tx, input.id);
  if (input.aside) {
    if (row.status === "set_aside") return { record: view(row, viewer), changed: false };
    // A confirmed original's receipt is on the books (card P5-05b): it is voided first, then set aside if need be.
    if (row.status === "confirmed") throw new Error("This receipt is on the books: it cannot be set aside. Void it first (it goes back to Read, waiting for review); then it can be set aside if it is not a receipt.");
    if (row.status !== "waiting" && row.status !== "drafted") throw new Error("Only an original that is waiting or read can be set aside.");
    const raw = typeof input.reason === "string" ? input.reason : "";
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(raw)) throw new Error("The reason cannot contain a line break or other control character.");
    const reason = raw.trim().replace(/\s+/g, " ");
    const n = [...reason].length;
    if (n < REASON_MIN || n > REASON_MAX) throw new Error(`Say why it is set aside, in ${REASON_MIN} to ${REASON_MAX} characters.`);
    await tx.query("update ops.receipt_originals set status = 'set_aside', set_aside_reason = $2, set_aside_by = $3, set_aside_at = $4 where receipt_id = $1", [row.receipt_id, reason, viewer.staffId, now]);
    await audit.write(tx, { actorId: viewer.staffId, action: "receipt_original.set_aside", targetType: "receipt_originals", targetId: row.receipt_id, before: { status: row.status }, after: { status: "set_aside", reason } }, { now });
    // A drafted original's draft leaves the live list with it (kept, unchanged; card P5-05a).
    if (row.status === "drafted") await drafts.takenOut(tx, row.receipt_id, viewer.staffId, now);
  } else {
    if (row.status !== "set_aside") return { record: view(row, viewer), changed: false };
    // Back to drafted when it has a draft (restored to the live list), else to waiting.
    const back: Status = (await drafts.restore(tx, row.receipt_id, viewer.staffId, now)) ? "drafted" : "waiting";
    await tx.query("update ops.receipt_originals set status = $2, set_aside_reason = null, set_aside_by = null, set_aside_at = null where receipt_id = $1", [row.receipt_id, back]);
    await audit.write(
      tx,
      { actorId: viewer.staffId, action: "receipt_original.put_back", targetType: "receipt_originals", targetId: row.receipt_id, before: { status: "set_aside", reason: row.set_aside_reason, by: row.set_aside_by, at: row.set_aside_at?.toISOString() }, after: { status: back } },
      { now },
    );
  }
  return { record: view(await tx.one<Row>(`${SELECT} where o.receipt_id = $1`, [row.receipt_id]), viewer), changed: true };
}

/** Say which business a waiting original belongs to (cstore, vape, or null for "not known"). */
export async function setBusiness(tx: Tx, input: { id?: unknown; business?: unknown }, viewer: Viewer, now: Date): Promise<{ record: OriginalView; changed: boolean }> {
  const b = input.business;
  if (!(b === null || isBusiness(b))) throw new Error("Business must be cstore, vape, or null for not known.");
  const row = await lockOne(tx, input.id);
  if (row.status !== "waiting") throw new Error("Only an original that is waiting can have its business changed. Put it back first.");
  if (row.business === b) return { record: view(row, viewer), changed: false };
  await tx.query("update ops.receipt_originals set business = $2 where receipt_id = $1", [row.receipt_id, b]);
  await audit.write(tx, { actorId: viewer.staffId, action: "receipt_original.set_business", targetType: "receipt_originals", targetId: row.receipt_id, before: { business: row.business }, after: { business: b } }, { now });
  return { record: view(await tx.one<Row>(`${SELECT} where o.receipt_id = $1`, [row.receipt_id]), viewer), changed: true };
}
