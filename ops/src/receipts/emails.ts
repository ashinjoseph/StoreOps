// The emails an assistant has dealt with (card P5-13; docs/components/receipts.md, "Emails checked").
// NEW in the Operations app (ADR-0023); ops/test/receipt-emails.test.ts is the specification.
//
// The app has NO access to email, and none is added here. An assistant reads a mailbox by its own means and
// tells the app, one tool call per email (receipt_email_done), what it did. Each email is one row of
// ops.receipt_emails, whatever came of it, so the next scan skips it:
//   filed            one or more originals were handed over from it
//   nothing_to_file  it was looked at: not an invoice or a receipt
//   could_not_read   an attachment could not be fetched or opened: a person should look
//
// ONE SPELLING OF A MESSAGE ID. The id is the email's Message-ID header value. `messageKey` is its normal
// form, the one place it is defined: direction marks and surrounding white space removed, one pair of
// surrounding angle brackets removed, nothing else changed (the part before @ is case-sensitive in
// principle, so case is kept). `<abc@x>` and `abc@x` are the same email. Originals and tickets keep the id as
// it was given and are matched on `ops.message_key(email_message_id)` (migration 0017: an index, no rewrite
// of any old row's text); this table stores the normal form itself.
//
// Rules: identity (the key and its person) comes from the caller; time is the caller's `now`; SQL takes values
// as parameters only; nothing is erased. Recording an email again updates its outcome, count and note and
// keeps `first_seen_at`; an audit row is written for every recording, without the sender, subject or note
// (text an email's author wrote: cleaned, capped, stored, shown as text, never obeyed).
import type { Db } from "../db/client";
import type { Tx } from "../db/tx";
import * as audit from "../lib/audit";
import { cleanLine } from "./originals";
import * as tickets from "./tickets";

export const OUTCOMES = ["filed", "nothing_to_file", "could_not_read"] as const;
export type EmailOutcome = (typeof OUTCOMES)[number];
export const PAGE_MAX = 50;
export const PAGE_DEFAULT = 20;
const ID = /^re[0-9a-f]{24}$/;

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const newEmailId = (): string => "re" + hex(crypto.getRandomValues(new Uint8Array(12)));

/**
 * The normal form of a message id, or null when it cannot be one: not text, a control character in it, more
 * than MESSAGE_ID_MAX characters, or nothing left once cleaned (`<>`). Pure.
 *   direction marks and surrounding white space removed; then ONE pair of surrounding angle brackets removed;
 *   nothing else (case, inner spaces, any other `<` or `>` are kept).
 */
export function messageKey(raw: unknown): string | null {
  const cleaned = tickets.cleanEmailText(raw, tickets.MESSAGE_ID_MAX);
  if (cleaned === null) return null;
  const chars = [...cleaned];
  const key = chars.length >= 2 && chars[0] === "<" && chars[chars.length - 1] === ">" ? chars.slice(1, -1).join("") : cleaned;
  return key === "" ? null : key;
}

// ── Recording an email ─────────────────────────────────────

export interface RecordInput {
  /** Normal form (messageKey). */
  messageId: string;
  sender: string;
  date: Date;
  subject: string | null;
  outcome: EmailOutcome;
  note: string | null;
}

export interface Recorder {
  keyId: string;
  staffId: string;
}

export interface EmailView {
  id: string;
  messageId: string;
  from: string;
  date: string;
  subject: string | null;
  outcome: EmailOutcome;
  originals: number;
  note: string | null;
  firstSeenAt: string;
  recordedAt: string;
  /** Who recorded it last: the person whose key it was, and the key's label. */
  recordedBy: { name: string; keyLabel: string };
}

interface Row {
  email_id: string;
  message_id: string;
  sender: string;
  email_date: Date;
  subject: string | null;
  outcome: EmailOutcome;
  originals: number;
  note: string | null;
  first_seen_at: Date;
  recorded_at: Date;
  key_id: string;
  key_label: string | null;
  staff_name: string | null;
}

const SELECT = `select e.email_id, e.message_id, e.sender, e.email_date, e.subject, e.outcome, e.originals, e.note, e.first_seen_at, e.recorded_at,
                       e.key_id, k.label as key_label, s.name as staff_name
                  from ops.receipt_emails e
                  left join ops.assistant_keys k on k.key_id = e.key_id
                  left join ops.staff s on s.staff_id = e.staff_id`;

const view = (r: Row): EmailView => ({
  id: r.email_id,
  messageId: r.message_id,
  from: r.sender,
  date: r.email_date.toISOString(),
  subject: r.subject,
  outcome: r.outcome,
  originals: r.originals,
  note: r.note,
  firstSeenAt: r.first_seen_at.toISOString(),
  recordedAt: r.recorded_at.toISOString(),
  recordedBy: { name: (r.staff_name ?? "").trim(), keyLabel: r.key_label ?? r.key_id },
});

export type RecordResult = { ok: true; created: boolean; email: EmailView } | { ok: false; error: string };

/** The note and the subject as stored: one line each, capped (200 for the subject, 300 for the note), blank is null. */
export const cleanSubject = (raw: unknown): string | null => cleanLine(raw, tickets.SUBJECT_MAX);

/**
 * Record that an email was dealt with (inside the call's transaction). Refused, with words an assistant can
 * act on, when it says `filed` and no original from that email is on file, or `nothing_to_file` while one is.
 * The count is what is on file, counted here, never taken from the caller. Recording again updates the
 * outcome, the count, the sender, date, note and who recorded it, keeps the first-seen time, and keeps a
 * subject already stored when the new record gives none.
 */
export async function record(tx: Tx, input: RecordInput, who: Recorder, now: Date): Promise<RecordResult> {
  // One at a time per message id: two records of one email at once make one row.
  await tx.query("select pg_advisory_xact_lock(hashtextextended('ops.receipt_emails:' || $1, 0))", [input.messageId]);
  const onFile = (await tx.one<{ n: number }>("select count(*)::int as n from ops.receipt_originals where email_message_id is not null and ops.message_key(email_message_id) = $1", [input.messageId])).n;
  if (input.outcome === "filed" && onFile === 0) {
    return {
      ok: false,
      error:
        "No receipt original from that message id is on file, so it cannot be recorded as filed. Hand each attachment over with receipt_upload_start and a PUT first. " +
        "If every file was refused or was already on file from another email (receipts_from_email and my_proposals say which), record nothing_to_file with a note, or could_not_read when a file could not be fetched.",
    };
  }
  if (input.outcome === "nothing_to_file" && onFile > 0) {
    return { ok: false, error: `${onFile} receipt original${onFile === 1 ? " is" : "s are"} already on file from that message id, so it cannot be recorded as nothing to file. Record filed (or could_not_read when another attachment could not be read).` };
  }
  const subject = input.subject ?? (await tx.maybeOne<{ s: string }>("select email_subject as s from ops.receipt_originals where email_message_id is not null and ops.message_key(email_message_id) = $1 and email_subject is not null order by added_at, receipt_id limit 1", [input.messageId]))?.s ?? null;
  const before = await tx.maybeOne<Row>(`${SELECT} where e.message_id = $1 for update of e`, [input.messageId]);
  let id: string;
  if (before === null) {
    id = newEmailId();
    await tx.query(
      `insert into ops.receipt_emails (email_id, message_id, sender, email_date, subject, outcome, originals, note, key_id, staff_id, first_seen_at, recorded_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [id, input.messageId, input.sender, input.date, subject, input.outcome, onFile, input.note, who.keyId, who.staffId, now],
    );
    await audit.write(tx, { actorId: who.staffId, action: "receipt_email.record", targetType: "receipt_emails", targetId: id, after: { id, assistantKeyId: who.keyId, outcome: input.outcome, originals: onFile } }, { now });
  } else {
    id = before.email_id;
    await tx.query(
      "update ops.receipt_emails set sender = $2, email_date = $3, subject = coalesce($4, subject), outcome = $5, originals = $6, note = $7, key_id = $8, staff_id = $9, recorded_at = $10 where email_id = $1",
      [id, input.sender, input.date, subject, input.outcome, onFile, input.note, who.keyId, who.staffId, now],
    );
    await audit.write(
      tx,
      {
        actorId: who.staffId,
        action: "receipt_email.update",
        targetType: "receipt_emails",
        targetId: id,
        before: { outcome: before.outcome, originals: before.originals, assistantKeyId: before.key_id },
        after: { outcome: input.outcome, originals: onFile, assistantKeyId: who.keyId },
      },
      { now },
    );
  }
  return { ok: true, created: before === null, email: view(await tx.one<Row>(`${SELECT} where e.email_id = $1`, [id])) };
}

// ── What the tool reads ────────────────────────────────────

export interface FromEmail {
  recorded: EmailView | null;
  originals: tickets.OriginalFromEmail[];
  open_tickets: tickets.OpenTicketForEmail[];
}

/** For each message id in normal form: whether it is recorded, the originals filed from it and the tickets still open. */
export async function forMessageIds(db: Db, keys: readonly string[], now: Date): Promise<Map<string, FromEmail>> {
  const filed = await tickets.byMessageIds(db, keys, now);
  const rows = await db.query<Row>(`${SELECT} where e.message_id = any($1::text[])`, [[...keys]]);
  const recorded = new Map(rows.map((r) => [r.message_id, view(r)] as const));
  const out = new Map<string, FromEmail>();
  for (const [k, f] of filed) out.set(k, { recorded: recorded.get(k) ?? null, originals: f.originals, open_tickets: f.open_tickets });
  return out;
}

// ── What the page reads ────────────────────────────────────

export interface ListInput {
  before?: unknown;
  limit?: unknown;
}

export interface EmailList {
  items: EmailView[];
  counts: Record<EmailOutcome, number>;
  next: string | null;
}

/**
 * The emails checked, for admin, manager and payroll admin (the RPC checks the role): the ones a person
 * should look at (could_not_read) first, then the email's date, newest first; a page at a time after the id
 * `before` (the previous page's `next`), at most PAGE_MAX. Counts are of every email, per outcome.
 */
export async function list(db: Db, input: ListInput): Promise<EmailList> {
  const limitIn = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : PAGE_DEFAULT;
  const limit = Math.min(Math.max(limitIn, 1), PAGE_MAX);
  const before = typeof input.before === "string" && ID.test(input.before) ? input.before : null;
  const rows = await db.query<Row>(
    `with cur as (select (outcome = 'could_not_read') as top, email_date, email_id from ops.receipt_emails where email_id = $1)
     ${SELECT}
      where $1::text is null
         or exists (select 1 from cur c
                     where (c.top and e.outcome <> 'could_not_read')
                        or ((e.outcome = 'could_not_read') = c.top and (e.email_date, e.email_id) < (c.email_date, c.email_id)))
      order by (e.outcome = 'could_not_read') desc, e.email_date desc, e.email_id desc
      limit $2`,
    [before, limit + 1],
  );
  const counts: Record<EmailOutcome, number> = { filed: 0, nothing_to_file: 0, could_not_read: 0 };
  for (const c of await db.query<{ outcome: EmailOutcome; n: number }>("select outcome, count(*)::int as n from ops.receipt_emails group by outcome")) {
    if (c.outcome in counts) counts[c.outcome] = c.n;
  }
  const page = rows.slice(0, limit);
  return { items: page.map(view), counts, next: rows.length > limit ? (page[page.length - 1]?.email_id ?? null) : null };
}
