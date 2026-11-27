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
import { type ContentType } from "./sniff";
import type { ReceiptStorage } from "./storage";

export const STATUSES = ["waiting", "set_aside"] as const;
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

/** The uploader's note: one line, no control or direction characters, capped at 300. Blank is null. */
export function cleanNote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(UNSAFE, "").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  const chars = [...text];
  return chars.length <= NOTE_MAX ? text : chars.slice(0, NOTE_MAX).join("");
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
}

const SELECT = `select o.receipt_id, o.sha256, o.size_bytes, o.content_type, o.storage_key, o.business, o.status,
                       o.set_aside_reason, o.set_aside_by, sa.name as set_aside_by_name, o.set_aside_at,
                       o.source, o.added_by, ad.name as added_by_name, o.added_at, o.file_name, o.note
                  from ops.receipt_originals o
                  left join ops.staff ad on ad.staff_id = o.added_by
                  left join ops.staff sa on sa.staff_id = o.set_aside_by`;

const nameOr = (name: string | null, id: string): string => (name ?? id).trim();

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
  const source: Source = input.source === "photo" ? "photo" : "upload";
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
    `insert into ops.receipt_originals (receipt_id, sha256, size_bytes, content_type, storage_key, business, status, source, added_by, added_at, file_name, note)
     values ($1, $2, $3, $4, $5, $6, 'waiting', $7, $8, $9, $10, $11)`,
    [id, input.sha256, input.bytes.byteLength, input.contentType, key, business, source, viewer.staffId, now, fileName, note],
  );
  await audit.write(
    tx,
    { actorId: viewer.staffId, action: "receipt_original.add", targetType: "receipt_originals", targetId: id, after: { id, sha256: hash, size: input.bytes.byteLength, type: input.contentType, business, source } },
    { now },
  );
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
  const status: Status = input.status === "set_aside" ? "set_aside" : "waiting";
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
  const counts: Record<Status, number> = { waiting: 0, set_aside: 0 };
  for (const c of await db.query<{ status: Status; n: number }>("select status, count(*)::int as n from ops.receipt_originals group by status")) {
    if (c.status in counts) counts[c.status] = c.n;
  }
  const page = rows.slice(0, limit);
  return {
    scope: "all",
    status,
    items: page.map((r) => view(r, viewer)),
    counts,
    next: rows.length > limit ? (page[page.length - 1]?.receipt_id ?? null) : null,
    canSetAside: SET_ASIDE_ROLES.includes(viewer.role),
  };
}

/** What the view route needs to serve an original, or null: no such id, or one `viewer` may not see (the same answer). */
export async function forView(db: Db, viewer: Viewer, id: unknown, now: Date): Promise<{ id: string; storageKey: string; contentType: ContentType; size: number } | null> {
  if (typeof id !== "string" || !ID.test(id)) return null;
  const row = await db.maybeOne<Row>(`${SELECT} where o.receipt_id = $1`, [id]);
  if (row === null || !maySee(viewer, row, now)) return null;
  return { id: row.receipt_id, storageKey: row.storage_key, contentType: row.content_type, size: row.size_bytes };
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
    if (row.status !== "waiting") throw new Error("Only an original that is waiting can be set aside.");
    const raw = typeof input.reason === "string" ? input.reason : "";
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(raw)) throw new Error("The reason cannot contain a line break or other control character.");
    const reason = raw.trim().replace(/\s+/g, " ");
    const n = [...reason].length;
    if (n < REASON_MIN || n > REASON_MAX) throw new Error(`Say why it is set aside, in ${REASON_MIN} to ${REASON_MAX} characters.`);
    await tx.query("update ops.receipt_originals set status = 'set_aside', set_aside_reason = $2, set_aside_by = $3, set_aside_at = $4 where receipt_id = $1", [row.receipt_id, reason, viewer.staffId, now]);
    await audit.write(tx, { actorId: viewer.staffId, action: "receipt_original.set_aside", targetType: "receipt_originals", targetId: row.receipt_id, before: { status: row.status }, after: { status: "set_aside", reason } }, { now });
  } else {
    if (row.status !== "set_aside") return { record: view(row, viewer), changed: false };
    await tx.query("update ops.receipt_originals set status = 'waiting', set_aside_reason = null, set_aside_by = null, set_aside_at = null where receipt_id = $1", [row.receipt_id]);
    await audit.write(
      tx,
      { actorId: viewer.staffId, action: "receipt_original.put_back", targetType: "receipt_originals", targetId: row.receipt_id, before: { status: "set_aside", reason: row.set_aside_reason, by: row.set_aside_by, at: row.set_aside_at?.toISOString() }, after: { status: "waiting" } },
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
