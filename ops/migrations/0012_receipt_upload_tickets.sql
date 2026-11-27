-- P5-12b: one-time upload addresses for an assistant's receipt originals (docs/components/receipts.md,
-- docs/components/assistants.md; ADR-0025 and ADR-0026, amended Nov 2026).
-- One Operations-only table; no Sheet tab feeds it and the cutover tools neither load nor compare it.
--
-- A file never travels inside a tool call. An assistant with a `propose` key asks the tool
-- receipt_upload_start for an address; the app makes a ticket (32 random bytes, base64url), answers it
-- once, inside the address PUT /files/receipt-original/by-ticket/<ticket>, and keeps only its SHA-256
-- here, as ops.assistant_keys keeps a key. A ticket is for one file, for 10 minutes, for the key that
-- asked. Nothing is deleted: a used, refused or expired ticket stays, marked.
--
-- outcome:
--   waiting    not used yet (and, once expires_at has passed, as good as expired: nothing can use it)
--   kept       a PUT sent a file and it became the original receipt_id
--   duplicate  a PUT sent the same bytes as the original receipt_id, already on file; nothing stored
--   refused    a PUT spent it and the file was refused (refusal says why: not_accepted, empty,
--              too_long, incomplete), or the upload was cut off before the end (interrupted)
--   expired    seen unused after expires_at (marked when a PUT or the same key's next ask sees it)
create table ops.receipt_upload_tickets (
  ticket_id         text primary key check (ticket_id ~ '^rt[0-9a-f]{24}$'),
  ticket_hash       bytea not null unique check (octet_length(ticket_hash) = 32),
  key_id            text not null references ops.assistant_keys (key_id),
  staff_id          text not null references ops.staff (staff_id),       -- the key's person: the original's added_by
  -- What the assistant declared when it asked (cleaned as the page's are; shown to people, never obeyed).
  business          text references ops.businesses (business),           -- NULL: not known, never guessed
  source            text not null check (source in ('assistant', 'email')),
  email_message_id  text check (email_message_id is null or (email_message_id <> '' and char_length(email_message_id) <= 300)),
  email_sender      text check (email_sender is null or (email_sender <> '' and char_length(email_sender) <= 200)),
  email_date        timestamptz,
  file_name         text check (file_name is null or (file_name <> '' and char_length(file_name) <= 120)),
  note              text check (note is null or (note <> '' and char_length(note) <= 300)),
  asked_at          timestamptz not null,
  expires_at        timestamptz not null,
  spent_at          timestamptz,                                          -- when a PUT got as far as reading the body
  outcome           text not null default 'waiting',
  receipt_id        text references ops.receipt_originals (receipt_id),
  refusal           text check (refusal is null or refusal ~ '^[a-z_]{1,40}$'),
  decided_at        timestamptz,
  constraint receipt_upload_tickets_expiry check (expires_at > asked_at),
  constraint receipt_upload_tickets_email check (
    (source = 'email') = (email_message_id is not null)
    and (email_message_id is null) = (email_sender is null)
    and (email_message_id is null) = (email_date is null)
  ),
  constraint receipt_upload_tickets_outcome check (
    (outcome = 'waiting' and spent_at is null and receipt_id is null and refusal is null and decided_at is null)
    or (outcome in ('kept', 'duplicate') and spent_at is not null and receipt_id is not null and refusal is null and decided_at is not null)
    or (outcome = 'refused' and spent_at is not null and receipt_id is null and refusal is not null and decided_at is not null)
    or (outcome = 'expired' and spent_at is null and receipt_id is null and refusal is null and decided_at is not null)
  )
);
-- my_proposals: this key's tickets, newest first.
create index receipt_upload_tickets_key_idx on ops.receipt_upload_tickets (key_id, asked_at desc, ticket_id desc);
-- receipts_from_email: an open ticket for a message id.
create index receipt_upload_tickets_message_idx on ops.receipt_upload_tickets (email_message_id) where email_message_id is not null;
-- receipts_from_email: an original for a message id (the column 0010 reserved).
create index receipt_originals_message_idx on ops.receipt_originals (email_message_id) where email_message_id is not null;

comment on table ops.receipt_upload_tickets is 'One-time upload addresses an assistant asked for. Only a SHA-256 of each ticket is kept. Marked, never deleted.';
comment on column ops.receipt_upload_tickets.ticket_hash is 'sha256 of the ticket text; the ticket is answered once, inside the upload address, and never stored';

-- ── receipt_originals: an emailed original keeps the key that handed it over ──
-- 0010 tied assistant_key_id to source 'assistant' only. An original an assistant hands over from an
-- email is source 'email' AND has the key (card P5-12b, decision 4); a later forwarding address could
-- add an emailed original with no key. So: 'assistant' needs a key; a key means 'assistant' or 'email'.
alter table ops.receipt_originals drop constraint receipt_originals_assistant;
alter table ops.receipt_originals add constraint receipt_originals_assistant check (
  (source <> 'assistant' or assistant_key_id is not null)
  and (assistant_key_id is null or source in ('assistant', 'email'))
);

-- ── assistant_calls: the ticket route's refusals are recorded too ──
-- A PUT to the ticket route is a row (tool 'upload_by_ticket'): never the ticket, the file or its name.
-- Its refusals add three reasons; they count against the same flood limit as refused sign-ins.
alter table ops.assistant_calls drop constraint assistant_calls_refusal_check;
alter table ops.assistant_calls add constraint assistant_calls_refusal_check check (
  refusal in ('bad_key', 'expired', 'withdrawn', 'person_inactive', 'no_right', 'rate_limited', 'unknown_tool', 'bad_input', 'failed',
              'bad_ticket', 'ticket_used', 'ticket_expired')
);
create index assistant_calls_flood_any_idx on ops.assistant_calls (caller_hash, at)
  where refusal in ('bad_key', 'expired', 'withdrawn', 'person_inactive', 'bad_ticket', 'ticket_used', 'ticket_expired');
create index assistant_calls_flood_any_total_idx on ops.assistant_calls (at)
  where refusal in ('bad_key', 'expired', 'withdrawn', 'person_inactive', 'bad_ticket', 'ticket_used', 'ticket_expired');

-- ── Grants: the exceptions to roles.sql's defaults (select, insert, update; never delete) ──
-- receipt_upload_tickets: who asked, the hash and what was declared never change; the app may only
-- spend a ticket and mark what became of it.
revoke update on ops.receipt_upload_tickets from ops_app;
grant update (spent_at, outcome, receipt_id, refusal, decided_at) on ops.receipt_upload_tickets to ops_app;
