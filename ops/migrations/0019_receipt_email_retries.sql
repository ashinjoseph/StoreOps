-- P5-19 and part of P5-18: what happens next to an email an assistant has dealt with
-- (docs/components/receipts.md, "Emails checked"; docs/guides/email-invoice-scan.md).
--
-- The owner, Nov 28:
--   - an email that could not be read is "retried once and then waits for the user": `tries` counts the
--     times it was recorded as could_not_read. After one, the next scan looks at it again; after two, the
--     app tells every assistant to skip it and refuses to record it again, until a person settles it:
--     either "dealt with" (person_done_by, person_done_at, person_note: the email is finished) or "let the
--     assistant try once more" (tries goes back to 1, audited);
--   - the same file sent again by another email "changes nothing": a new outcome, already_on_file, for an
--     email whose file came back as already on file. `same_as` names that original. No original is filed
--     from such an email, so its count is 0.
-- What happens next is worked out from these columns by one pure function (receipts/emails.ts nextStep);
-- nothing here stores it.

alter table ops.receipt_emails
  drop constraint receipt_emails_outcome_check,
  add constraint receipt_emails_outcome_check check (outcome in ('filed', 'nothing_to_file', 'could_not_read', 'already_on_file')),
  drop constraint receipt_emails_count,
  add constraint receipt_emails_count check (
    (outcome = 'filed' and originals >= 1) or (outcome in ('nothing_to_file', 'already_on_file') and originals = 0) or outcome = 'could_not_read'
  ),
  add column tries          integer not null default 0 check (tries >= 0 and tries <= 1000),   -- times recorded as could_not_read
  add column person_done_by text references ops.staff (staff_id),
  add column person_done_at timestamptz,
  add column person_note    text check (person_note is null or (person_note <> '' and char_length(person_note) <= 300)),
  add column same_as        text references ops.receipt_originals (receipt_id),
  add constraint receipt_emails_person_done check (
    (person_done_by is null) = (person_done_at is null) and (person_done_at is null) = (person_note is null)
    and (person_done_at is null or outcome = 'could_not_read')
  ),
  add constraint receipt_emails_same_as check ((same_as is not null) = (outcome = 'already_on_file'));

-- Emails recorded before this migration: each could_not_read one counts as tried once.
update ops.receipt_emails set tries = 1 where outcome = 'could_not_read';

comment on column ops.receipt_emails.tries is 'How many times an assistant recorded this email as could_not_read. At 2 it waits for a person (P5-19)';
comment on column ops.receipt_emails.person_note is 'What a person did about an email that could not be read; with person_done_by and person_done_at it finishes the email';
comment on column ops.receipt_emails.same_as is 'For already_on_file: the receipt original this email''s file is the same as';

-- The page: the ones a person may have to look at (could not be read, not yet settled by a person) on top.
drop index ops.receipt_emails_list_idx;
create index receipt_emails_list_idx on ops.receipt_emails ((outcome = 'could_not_read' and person_done_at is null) desc, email_date desc, email_id desc);

-- ── Grants: the exceptions to roles.sql's defaults (select, insert, update; never delete) ──
-- 0017 limited updates to named columns; these are added to them. message_id, email_id and first_seen_at
-- still never change.
grant update (tries, person_done_by, person_done_at, person_note, same_as) on ops.receipt_emails to ops_app;
