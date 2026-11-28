-- P5-13: emailed invoices through the assistant (docs/components/receipts.md, docs/components/assistants.md,
-- docs/guides/email-invoice-scan.md). One Operations-only table; no Sheet tab feeds it and the cutover
-- tools neither load nor compare it. The app has no access to email: an assistant reads the mailbox by its
-- own means and tells the app, one tool call per email, what it did.
--
-- 1. receipt_emails: one row per email an assistant has dealt with, whatever came of it, so the next scan
--    skips it. message_id is the email's Message-ID header in its NORMAL FORM (receipts/emails.ts
--    messageKey: direction marks and surrounding white space removed, one pair of surrounding angle
--    brackets removed, nothing else changed; case is kept). One row per message_id. Nothing is deleted:
--    recording an email again updates its outcome and count and keeps first_seen_at (the audit log holds
--    each change). The sender, subject and note are text an email's author wrote: cleaned, capped, stored,
--    shown to people as text, never obeyed.
-- 2. The attachment a file was (its name as the email gives it and its position among the attachments), or
--    the mark that it is a PDF print of the email's own text, on the upload ticket and on the original.
--    Only for an emailed file; a print has no attachment name or position.
-- 3. ops.message_key(text): the normal form of a message id AS STORED on originals and tickets (which keep
--    the id as it was given, already trimmed and free of direction marks), so a lookup compares normal
--    forms without rewriting any old row's text. Indexed on both tables.
--
-- outcome:
--   filed            one or more originals came from it (originals >= 1)
--   nothing_to_file  looked at: not an invoice or a receipt (originals = 0)
--   could_not_read   an attachment could not be fetched or opened: a person should look
create table ops.receipt_emails (
  email_id       text primary key check (email_id ~ '^re[0-9a-f]{24}$'),
  message_id     text not null unique check (message_id <> '' and char_length(message_id) <= 300),   -- normal form
  sender         text not null check (sender <> '' and char_length(sender) <= 200),
  email_date     timestamptz not null,
  subject        text check (subject is null or (subject <> '' and char_length(subject) <= 200)),
  outcome        text not null check (outcome in ('filed', 'nothing_to_file', 'could_not_read')),
  originals      integer not null check (originals >= 0 and originals <= 1000),                   -- on file from this email when it was recorded
  note           text check (note is null or (note <> '' and char_length(note) <= 300)),
  key_id         text not null references ops.assistant_keys (key_id),                           -- the key that last recorded it
  staff_id       text not null references ops.staff (staff_id),                                   -- ... and its person
  first_seen_at  timestamptz not null,
  recorded_at    timestamptz not null,                                                           -- when it was last recorded
  constraint receipt_emails_count check (
    (outcome = 'filed' and originals >= 1) or (outcome = 'nothing_to_file' and originals = 0) or outcome = 'could_not_read'
  ),
  constraint receipt_emails_times check (recorded_at >= first_seen_at)
);
-- The page: could_not_read on top, then the email's date, newest first.
create index receipt_emails_list_idx on ops.receipt_emails ((outcome = 'could_not_read') desc, email_date desc, email_id desc);
comment on table ops.receipt_emails is 'Every email an assistant has dealt with (filed, nothing to file, could not read), one row per Message-ID in normal form. Updated when recorded again, never deleted.';
comment on column ops.receipt_emails.message_id is 'The Message-ID header in normal form: direction marks and surrounding white space removed, one pair of angle brackets removed, case kept';

-- ── ops.message_key: the normal form of an id as stored on originals and tickets ──
-- Those columns were written through cleanEmailText (trimmed, direction marks removed), so what is left to
-- do is the one pair of angle brackets. Mirrors messageKey in ops/src/receipts/emails.ts; a test compares them.
create function ops.message_key(t text) returns text language sql immutable strict as $$
  select case when char_length(t) >= 3 and left(t, 1) = '<' and right(t, 1) = '>' then substr(t, 2, char_length(t) - 2) else t end
$$;

-- ── The attachment, or the print, on the ticket and on the original ──
alter table ops.receipt_upload_tickets
  add column email_subject             text check (email_subject is null or (email_subject <> '' and char_length(email_subject) <= 200)),
  add column email_attachment_name     text check (email_attachment_name is null or (email_attachment_name <> '' and char_length(email_attachment_name) <= 120)),
  add column email_attachment_position integer check (email_attachment_position is null or email_attachment_position between 1 and 999),
  add column email_print               boolean check (email_print is null or email_print),               -- null: not a print
  add constraint receipt_upload_tickets_attachment check (
    (email_attachment_name is null) = (email_attachment_position is null)
    and (email_print is null or email_attachment_name is null)
    and (source = 'email' or (email_subject is null and email_attachment_name is null and email_print is null))
  );
alter table ops.receipt_originals
  add column email_subject             text check (email_subject is null or (email_subject <> '' and char_length(email_subject) <= 200)),
  add column email_attachment_name     text check (email_attachment_name is null or (email_attachment_name <> '' and char_length(email_attachment_name) <= 120)),
  add column email_attachment_position integer check (email_attachment_position is null or email_attachment_position between 1 and 999),
  add column email_print               boolean check (email_print is null or email_print),
  add constraint receipt_originals_attachment check (
    (email_attachment_name is null) = (email_attachment_position is null)
    and (email_print is null or email_attachment_name is null)
    and (source = 'email' or (email_subject is null and email_attachment_name is null and email_print is null))
  );
-- receipts_from_email: originals and open tickets by the normal form of the message id.
create index receipt_originals_message_key_idx on ops.receipt_originals (ops.message_key(email_message_id)) where email_message_id is not null;
create index receipt_upload_tickets_message_key_idx on ops.receipt_upload_tickets (ops.message_key(email_message_id)) where email_message_id is not null;

-- ── Grants: the exceptions to roles.sql's defaults (select, insert, update; never delete) ──
-- receipt_emails: the row's id, its message id and the time it was first seen never change; recording an
-- email again may change what the assistant said about it and who said it, nothing else.
revoke update on ops.receipt_emails from ops_app;
grant update (sender, email_date, subject, outcome, originals, note, key_id, staff_id, recorded_at) on ops.receipt_emails to ops_app;
-- The new columns on tickets and originals are written once, with the row: no update is granted on them
-- (the existing column grants of 0010 and 0012 are unchanged).
