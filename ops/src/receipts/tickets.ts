// One-time upload addresses for an assistant's receipt originals (card P5-12b; ADR-0026 amended).
// NEW in the Operations app (ADR-0023); ops/test/mcp-receipts.test.ts is the specification.
//
// A file never travels inside a tool call. An assistant whose key may propose calls the tool
// receipt_upload_start; `ask` makes a ticket here: 32 random bytes from crypto, as base64url (43
// characters), answered once inside the address PUT /files/receipt-original/by-ticket/<ticket>. The
// table keeps the ticket's SHA-256, never the ticket. A ticket is:
//   - for one file: the first PUT that gets as far as reading the body spends it, whether or not the
//     file is then accepted;
//   - for 10 minutes: valid while now < expires_at;
//   - tied to the key that asked: dead at once if, at the time of the PUT, that key has expired or been
//     withdrawn, or its person is no longer active (the route also refuses while the door is off).
// `lockForPut` finds a presented ticket under a row lock (select ... for update), so two PUTs with one
// ticket on two connections are taken one after the other: the second sees it spent. Every refusal
// does the same work: one hash (of a dummy for a malformed ticket), one locked lookup, one update that
// marks an expired ticket (and touches nothing otherwise).
//
// What the assistant declared when it asked (the business, the source, an email's message id, sender
// and date, a file name, a note) is data: cleaned and capped as the page's are, stored, shown to a
// person later, never obeyed. Time is the caller's `now`; SQL takes values as parameters only; nothing
// is removed: a used, refused or expired ticket stays, marked.
import type { Db } from "../db/client";
import type { Tx } from "../db/tx";
import * as audit from "../lib/audit";
import { formatDateTime } from "../lib/dates";
import { type Business, isBusiness } from "./businesses";
import { cleanFileName, cleanLine, cleanNote } from "./originals";

export const TICKET_PREFIX = "/files/receipt-original/by-ticket/";
export const TICKET_MINUTES = 10;
export const TICKET_MS = TICKET_MINUTES * 60_000;
export const MESSAGE_ID_MAX = 300;
export const SENDER_MAX = 200;
export const SUBJECT_MAX = 200;
export const POSITION_MAX = 999;
/** Tool name in ops.assistant_calls for a PUT to the ticket route (never the ticket or the file). */
export const PUT_RECORD_NAME = "upload_by_ticket";

const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
/** Hashed when the presented ticket is malformed, so that path does the same work. */
const DUMMY_TICKET = "A".repeat(43);
const DUMMY_ID = "rt000000000000000000000000";
/** C0 and C1 controls, line and paragraph separators: refused in a message id or a sender. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** Direction embeddings, overrides and isolates: removed from a message id or a sender. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export type TicketSource = "assistant" | "email";
export type Outcome = "waiting" | "kept" | "duplicate" | "refused" | "expired";
/** Why a spent ticket's file was refused. `interrupted`: set when the ticket is spent, replaced once the PUT finishes. */
export type FileRefusal = "not_accepted" | "not_a_pdf" | "empty" | "too_long" | "incomplete" | "interrupted";

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 of the ticket text: the 32 bytes the table keeps. */
export async function hashTicket(ticket: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket)));
}

/** A new ticket and its id, from crypto. */
export function newTicket(): { ticketId: string; ticket: string } {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return { ticketId: "rt" + hex(crypto.getRandomValues(new Uint8Array(12))), ticket: base64url(secret) };
}

// ── What an assistant may declare ──────────────────────────

/**
 * An email's message id or sender as stored and compared: surrounding white space trimmed, direction
 * marks removed. null when it holds a control character, is blank, or is longer than `max` afterwards.
 * Case and inner spaces are kept: two ids match only when they are exactly the same after this.
 */
export function cleanEmailText(raw: unknown, max: number): string | null {
  if (typeof raw !== "string" || CONTROL.test(raw)) return null;
  const text = raw.replace(BIDI, "").trim();
  if (text === "" || [...text].length > max) return null;
  return text;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * An email's date as a real instant, or null. Two forms: ISO 8601 with a time and a zone
 * (2026-11-26T09:14:00-05:00, ...Z) and the email header's own (Thu, 26 Nov 2026 09:14:00 -0500).
 * The day must exist (no 30 February), the year be 1990 to 2100.
 */
export function parseEmailDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.length > 100) return null;
  const s = raw.trim();
  let y: number, mo: number, d: number, h: number, mi: number, se: number, offMin: number;
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i.exec(s);
  const mail = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s+([+-]\d{4}|GMT|UT|UTC|Z)(?:\s+\([^()]{0,40}\))?$/.exec(s);
  let zone: string;
  if (iso) {
    [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(iso[i])) as [number, number, number, number, number];
    se = iso[6] === undefined ? 0 : Number(iso[6]);
    zone = iso[7] as string;
  } else if (mail) {
    const m = MONTHS.indexOf((mail[2] as string).toLowerCase());
    if (m < 0) return null;
    [d, y, h, mi] = [Number(mail[1]), Number(mail[3]), Number(mail[4]), Number(mail[5])];
    mo = m + 1;
    se = mail[6] === undefined ? 0 : Number(mail[6]);
    zone = mail[7] as string;
  } else return null;
  if (/^(z|gmt|ut|utc)$/i.test(zone)) offMin = 0;
  else {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (!z || Number(z[2]) > 14 || Number(z[3]) > 59) return null;
    offMin = (z[1] === "-" ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3]));
  }
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || se > 59) return null;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, se) - offMin * 60_000);
}

export interface AskInput {
  business?: Business | null | undefined;
  source: TicketSource;
  email?: EmailInput | undefined;
  file_name?: string | undefined;
  note?: string | undefined;
}

/** What an assistant declares about an emailed file: exactly one of `attachment` and `print` (card P5-13). */
export interface EmailInput {
  message_id: string;
  from: string;
  date: string;
  subject?: string | undefined;
  attachment?: { name: string; position: number } | undefined;
  print?: true | undefined;
}

/** The attachment an emailed file was, or that it is a PDF print of the email's own text. */
export interface EmailPart {
  subject: string | null;
  attachment: { name: string; position: number } | null;
  print: boolean;
}

export interface Asker {
  keyId: string;
  staffId: string;
}

export interface Asked {
  ticketId: string;
  /** The ticket itself: in this answer only, never stored. */
  ticket: string;
  askedAt: Date;
  expiresAt: Date;
  declared: {
    business: Business | null;
    source: TicketSource;
    email: { message_id: string; from: string; date: string; subject: string | null; attachment: { name: string; position: number } | null; print: boolean } | null;
    file_name: string | null;
    note: string | null;
  };
}

/**
 * The subject, and which part of the email the file is: exactly one of an attachment (its name as the email
 * gives it, cleaned, and its position, 1 to 999) and the mark that it is a print of the email itself. null
 * when neither or both are given, the position is not a whole number in range, or the name is empty once
 * cleaned. The subject is text an email's author wrote: one line, capped, never obeyed.
 */
export function emailPart(email: { subject?: unknown; attachment?: unknown; print?: unknown } | undefined): EmailPart | null {
  if (email === undefined) return null;
  const print = email.print === true;
  const given = email.attachment !== undefined && email.attachment !== null;
  if (email.print !== undefined && email.print !== true) return null;
  if (print === given) return null;
  const subject = cleanLine(email.subject, SUBJECT_MAX);
  if (print) return { subject, attachment: null, print: true };
  const a = email.attachment as { name?: unknown; position?: unknown };
  const name = cleanFileName(a.name);
  if (name === null || typeof a.position !== "number" || !Number.isInteger(a.position) || a.position < 1 || a.position > POSITION_MAX) return null;
  return { subject, attachment: { name, position: a.position }, print: false };
}

/**
 * Make a ticket for the key `asker` (inside the call's transaction). The input has passed the tool's
 * schema; the email's three fields are checked again here. The same key's tickets that expired unused
 * are marked expired first. One audit row, without the ticket, its hash, the file name or the note.
 */
export async function ask(tx: Tx, input: AskInput, asker: Asker, now: Date): Promise<Asked> {
  const business: Business | null = isBusiness(input.business) ? input.business : null;
  let email: ({ messageId: string; sender: string; date: Date } & EmailPart) | null = null;
  if (input.source === "email") {
    const messageId = cleanEmailText(input.email?.message_id, MESSAGE_ID_MAX);
    const sender = cleanEmailText(input.email?.from, SENDER_MAX);
    const date = parseEmailDate(input.email?.date);
    if (messageId === null || sender === null || date === null) throw new TypeError("the email's message id, sender and date did not pass the tool's schema");
    const part = emailPart(input.email);
    if (part === null) throw new TypeError("an emailed file is exactly one of an attachment and a print of the email");
    email = { messageId, sender, date, ...part };
  }
  const fileName = cleanFileName(input.file_name);
  const note = cleanNote(input.note);
  await markExpired(tx, asker.keyId, now);
  const { ticketId, ticket } = newTicket();
  const expiresAt = new Date(now.getTime() + TICKET_MS);
  await tx.query(
    `insert into ops.receipt_upload_tickets (ticket_id, ticket_hash, key_id, staff_id, business, source, email_message_id, email_sender, email_date, file_name, note, asked_at, expires_at,
                                             email_subject, email_attachment_name, email_attachment_position, email_print)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [ticketId, await hashTicket(ticket), asker.keyId, asker.staffId, business, input.source, email?.messageId ?? null, email?.sender ?? null, email?.date ?? null, fileName, note, now, expiresAt,
      email?.subject ?? null, email?.attachment?.name ?? null, email?.attachment?.position ?? null, email?.print ? true : null],
  );
  await audit.write(
    tx,
    {
      actorId: asker.staffId,
      action: "receipt_upload_ticket.create",
      targetType: "receipt_upload_tickets",
      targetId: ticketId,
      after: { ticketId, assistantKeyId: asker.keyId, source: input.source, business, expiresAt: expiresAt.toISOString() },
    },
    { now },
  );
  return {
    ticketId,
    ticket,
    askedAt: now,
    expiresAt,
    declared: {
      business,
      source: input.source,
      email: email === null ? null : { message_id: email.messageId, from: email.sender, date: email.date.toISOString(), subject: email.subject, attachment: email.attachment, print: email.print },
      file_name: fileName,
      note,
    },
  };
}

/** This key's tickets that expired unused: marked expired (decided at their expiry). */
export async function markExpired(tx: Tx, keyId: string, now: Date): Promise<void> {
  await tx.query("update ops.receipt_upload_tickets set outcome = 'expired', decided_at = expires_at where key_id = $1 and outcome = 'waiting' and expires_at <= $2", [keyId, now]);
}

// ── The PUT ────────────────────────────────────────────────

export interface LiveTicket {
  ticketId: string;
  keyId: string;
  staffId: string;
  business: Business | null;
  source: TicketSource;
  email: ({ messageId: string; sender: string; date: Date } & EmailPart) | null;
  fileName: string | null;
  note: string | null;
}

/** Why a presented ticket is refused (recorded in ops.assistant_calls, never answered). */
export type TicketRefusal = "bad_ticket" | "ticket_used" | "ticket_expired" | "withdrawn" | "expired" | "person_inactive";

interface TicketRow {
  ticket_id: string;
  key_id: string;
  staff_id: string;
  business: Business | null;
  source: TicketSource;
  email_message_id: string | null;
  email_sender: string | null;
  email_date: Date | null;
  email_subject: string | null;
  email_attachment_name: string | null;
  email_attachment_position: number | null;
  email_print: boolean | null;
  file_name: string | null;
  note: string | null;
  expires_at: Date;
  outcome: Outcome;
  key_withdrawn_at: Date | null;
  key_expires_at: Date;
  active: boolean;
}

/** The ticket in the address's last part, or null when it is not one's shape. */
export function ticketFromPath(pathname: string): string | null {
  if (!pathname.startsWith(TICKET_PREFIX)) return null;
  const t = pathname.slice(TICKET_PREFIX.length);
  return TICKET_RE.test(t) ? t : null;
}

/**
 * Find the presented ticket and lock its row for the rest of `tx`. Usable: answers it. Otherwise the
 * reason, after the same work. An expired ticket that was still waiting is marked expired here.
 */
export async function lockForPut(tx: Tx, presented: string | null, now: Date): Promise<{ ok: true; ticket: LiveTicket } | { ok: false; reason: TicketRefusal; keyId: string | null }> {
  const hash = await hashTicket(presented ?? DUMMY_TICKET);
  const row = await tx.maybeOne<TicketRow>(
    `select t.ticket_id, t.key_id, t.staff_id, t.business, t.source, t.email_message_id, t.email_sender, t.email_date, t.email_subject, t.email_attachment_name, t.email_attachment_position, t.email_print, t.file_name, t.note,
            t.expires_at, t.outcome, k.withdrawn_at as key_withdrawn_at, k.expires_at as key_expires_at, s.active
       from ops.receipt_upload_tickets t
       join ops.assistant_keys k on k.key_id = t.key_id
       join ops.staff s on s.staff_id = t.staff_id
      where t.ticket_hash = $1
        for update of t`,
    [hash],
  );
  const found = presented !== null && row !== null ? row : null;
  // One update on every path: it marks this ticket expired when it is waiting past its time, else changes nothing.
  await tx.query("update ops.receipt_upload_tickets set outcome = 'expired', decided_at = expires_at where ticket_id = $1 and outcome = 'waiting' and expires_at <= $2", [found?.ticket_id ?? DUMMY_ID, now]);
  if (found === null) return { ok: false, reason: "bad_ticket", keyId: null };
  const keyId = found.key_id;
  if (found.outcome !== "waiting") return { ok: false, reason: "ticket_used", keyId };
  if (now.getTime() >= found.expires_at.getTime()) return { ok: false, reason: "ticket_expired", keyId };
  if (found.key_withdrawn_at !== null) return { ok: false, reason: "withdrawn", keyId };
  if (now.getTime() >= found.key_expires_at.getTime()) return { ok: false, reason: "expired", keyId };
  if (found.active !== true) return { ok: false, reason: "person_inactive", keyId };
  return {
    ok: true,
    ticket: {
      ticketId: found.ticket_id,
      keyId,
      staffId: found.staff_id.trim(),
      business: found.business,
      source: found.source,
      email:
        found.email_message_id === null || found.email_sender === null || found.email_date === null
          ? null
          : {
              messageId: found.email_message_id,
              sender: found.email_sender,
              date: found.email_date,
              subject: found.email_subject,
              attachment: found.email_attachment_name === null || found.email_attachment_position === null ? null : { name: found.email_attachment_name, position: found.email_attachment_position },
              print: found.email_print === true,
            },
      fileName: found.file_name,
      note: found.note,
    },
  };
}

/** Spend a locked, usable ticket: from here on it can never be used again. Marked `interrupted` until the PUT finishes. */
export async function spend(tx: Tx, ticketId: string, now: Date): Promise<void> {
  await tx.query("update ops.receipt_upload_tickets set spent_at = $2, outcome = 'refused', refusal = 'interrupted', decided_at = $2 where ticket_id = $1 and outcome = 'waiting'", [ticketId, now]);
}

/** What became of a spent ticket's file. */
export async function markOutcome(db: Db, ticketId: string, outcome: { kind: "kept" | "duplicate"; receiptId: string } | { kind: "refused"; refusal: FileRefusal }, now: Date): Promise<void> {
  if (outcome.kind === "refused") {
    await db.query("update ops.receipt_upload_tickets set outcome = 'refused', refusal = $2, receipt_id = null, decided_at = $3 where ticket_id = $1 and spent_at is not null", [ticketId, outcome.refusal, now]);
  } else {
    await db.query("update ops.receipt_upload_tickets set outcome = $2, receipt_id = $3, refusal = null, decided_at = $4 where ticket_id = $1 and spent_at is not null", [ticketId, outcome.kind, outcome.receiptId, now]);
  }
}

// ── What the tools read ────────────────────────────────────

export type ProposalStatus = "waiting" | "confirmed" | "refused";

export interface ProposalView {
  id: string;
  kind: "receipt_upload";
  status: ProposalStatus;
  made_at: string;
  decided_at: string | null;
  note: string;
}

const REFUSAL_WORDS: Readonly<Record<string, string>> = {
  not_accepted: "The file was refused: it is not a photo or a PDF the app can keep (JPEG, PNG, WebP, HEIC or PDF). Nothing was stored.",
  not_a_pdf: "The file was refused: this address was for a print of the email, which must be a PDF, and the file is not one. Nothing was stored.",
  empty: "The file was refused: it was empty. Nothing was stored.",
  too_long: "The file was refused: more bytes arrived than its stated size (Content-Length). Nothing was stored.",
  incomplete: "The file was refused: it arrived incomplete. Nothing was stored.",
  interrupted: "The upload stopped before the file was kept. Nothing was stored.",
};

interface ProposalRow {
  ticket_id: string;
  outcome: Outcome;
  refusal: string | null;
  receipt_id: string | null;
  asked_at: Date;
  expires_at: Date;
  decided_at: Date | null;
}

const when = (d: Date): string => formatDateTime(d).slice(0, 16);

function proposalOf(r: ProposalRow, now: Date): ProposalView {
  const lapsed = r.outcome === "expired" || (r.outcome === "waiting" && now.getTime() >= r.expires_at.getTime());
  const base = { id: r.ticket_id, kind: "receipt_upload" as const, made_at: r.asked_at.toISOString() };
  if (lapsed) return { ...base, status: "refused", decided_at: (r.decided_at ?? r.expires_at).toISOString(), note: "The upload address expired unused. Nothing was received." };
  if (r.outcome === "waiting") return { ...base, status: "waiting", decided_at: null, note: `The upload address is open until ${when(r.expires_at)} (Toronto). Nothing received yet.` };
  if (r.outcome === "kept") return { ...base, status: "confirmed", decided_at: r.decided_at?.toISOString() ?? null, note: `Kept as receipt original ${r.receipt_id}.` };
  if (r.outcome === "duplicate") return { ...base, status: "confirmed", decided_at: r.decided_at?.toISOString() ?? null, note: `Already on file as receipt original ${r.receipt_id}: the same bytes were sent before, so nothing new was stored.` };
  return { ...base, status: "refused", decided_at: r.decided_at?.toISOString() ?? null, note: REFUSAL_WORDS[r.refusal ?? ""] ?? "The file was refused. Nothing was stored." };
}

/** This key's tickets as proposals, newest first; `status` filters after the mapping. */
export async function proposals(db: Db, keyId: string, now: Date, opts: { status?: ProposalStatus | undefined; limit: number }): Promise<ProposalView[]> {
  const where =
    opts.status === undefined
      ? ""
      : opts.status === "waiting"
        ? "and outcome = 'waiting' and expires_at > $2"
        : opts.status === "confirmed"
          ? "and outcome in ('kept', 'duplicate')"
          : "and (outcome in ('refused', 'expired') or (outcome = 'waiting' and expires_at <= $2))";
  const rows = await db.query<ProposalRow>(
    `select ticket_id, outcome, refusal, receipt_id, asked_at, expires_at, decided_at
       from ops.receipt_upload_tickets
      where key_id = $1 ${where} and $2::timestamptz is not null
      order by asked_at desc, ticket_id desc
      limit $3`,
    [keyId, now, opts.limit],
  );
  return rows.map((r) => proposalOf(r, now));
}

export interface OriginalFromEmail {
  id: string;
  added_at: string;
  status: string;
  attachment: { name: string; position: number } | null;
  print: boolean;
}
export interface OpenTicketForEmail {
  id: string;
  expires_at: string;
  attachment: { name: string; position: number } | null;
  print: boolean;
}

/**
 * For each message id in NORMAL FORM (emails.messageKey): the originals filed from it and the tickets for it
 * still open (any key), each with the attachment it is or the mark that it is a print. Rows are matched on
 * ops.message_key(email_message_id), so an id stored with its angle brackets, or without, is the same email;
 * no stored text is rewritten.
 */
export async function byMessageIds(db: Db, keys: readonly string[], now: Date): Promise<Map<string, { originals: OriginalFromEmail[]; open_tickets: OpenTicketForEmail[] }>> {
  const out = new Map<string, { originals: OriginalFromEmail[]; open_tickets: OpenTicketForEmail[] }>();
  for (const m of keys) out.set(m, { originals: [], open_tickets: [] });
  const ids = [...out.keys()];
  const part = (name: string | null, position: number | null) => (name === null || position === null ? null : { name, position });
  const found = await db.query<{ k: string; receipt_id: string; added_at: Date; status: string; email_attachment_name: string | null; email_attachment_position: number | null; email_print: boolean | null }>(
    `select ops.message_key(email_message_id) as k, receipt_id, added_at, status, email_attachment_name, email_attachment_position, email_print
       from ops.receipt_originals
      where email_message_id is not null and ops.message_key(email_message_id) = any($1::text[])
      order by added_at, receipt_id`,
    [ids],
  );
  for (const r of found) out.get(r.k)?.originals.push({ id: r.receipt_id, added_at: r.added_at.toISOString(), status: r.status, attachment: part(r.email_attachment_name, r.email_attachment_position), print: r.email_print === true });
  const open = await db.query<{ k: string; ticket_id: string; expires_at: Date; email_attachment_name: string | null; email_attachment_position: number | null; email_print: boolean | null }>(
    `select ops.message_key(email_message_id) as k, ticket_id, expires_at, email_attachment_name, email_attachment_position, email_print
       from ops.receipt_upload_tickets
      where email_message_id is not null and ops.message_key(email_message_id) = any($1::text[]) and outcome = 'waiting' and expires_at > $2
      order by asked_at, ticket_id`,
    [ids, now],
  );
  for (const r of open) out.get(r.k)?.open_tickets.push({ id: r.ticket_id, expires_at: r.expires_at.toISOString(), attachment: part(r.email_attachment_name, r.email_attachment_position), print: r.email_print === true });
  return out;
}
