-- P5-05b: a person reviews a receipt draft beside its original, corrects it, confirms it onto the books
-- of one business, and voids a confirmed receipt that proves wrong
-- (docs/components/receipts.md; docs/adr/0029-a-confirmed-receipt-is-final-and-a-mistake-is-voided.md).
-- No new table: columns on the tables of 0010 and 0013, the status confirmed for originals, and a trigger
-- that keeps a confirmed receipt final. The cutover tools neither load nor compare any of them.
--
-- A CORRECTION is a new reading (read_by_kind person) that supersedes the live draft, as 0013 already
-- allows: no figure of a row ever changes. CONFIRMING marks the live draft confirmed (status, confirmed_*)
-- and records, on the same row, the checks re-run at that moment, the reason given when any failed, and
-- what differs from the FIRST reading of the original. VOIDING marks a confirmed receipt voided (voided_*,
-- 0013) and makes a new draft copied from it (redo_of names the voided one), so it can be confirmed again.

-- ── receipt_originals: a confirmed receipt's original is confirmed ──
-- waiting → drafted → confirmed; a void takes it back to drafted (with the copied draft).
alter table ops.receipt_originals drop constraint receipt_originals_status;
alter table ops.receipt_originals add constraint receipt_originals_status check (status in ('waiting', 'drafted', 'confirmed', 'set_aside'));

-- ── purchase_receipts: what the review adds ──
alter table ops.purchase_receipts
  -- When a person chose the business (business_decided_by = {person}): what the signs said, kept beside, so
  -- a later report can say which kinds of sign were right. NULL when the signs decided it.
  add column signs_business    text references ops.businesses (business),
  add column signs_decided_by  text[],
  -- A draft made by a void: the voided receipt it was copied from (it supersedes nothing).
  add column redo_of           text references ops.purchase_receipts (purchase_id),
  -- Confirming: the checks re-run on the figures confirmed, the ids of those that failed, and the reason
  -- the person gave (required when any failed).
  add column confirm_checks    jsonb,
  add column confirm_failed    text[],
  add column confirm_reason    text check (confirm_reason is null or char_length(confirm_reason) between 3 and 300),
  -- What was changed at review: the comparison of this receipt with the first reading of its original
  -- ({ comparedWith, fields: [{ field, before, after }], lines: { added, removed, changed }, count }).
  add column review_changes    jsonb,
  add column compared_with     text references ops.purchase_receipts (purchase_id);

alter table ops.purchase_receipts add constraint purchase_receipts_person_chose check (
  ((business_decided_by = array['person']::text[]) = (signs_decided_by is not null))
  and (signs_decided_by is null or (signs_decided_by <> '{}' and signs_decided_by <@ array['name', 'hst_number', 'supplier_account', 'card_last4', 'conflict', 'not_known']::text[]))
  and (signs_business is null or signs_decided_by is not null)
);
alter table ops.purchase_receipts add constraint purchase_receipts_confirm_record check (
  (confirmed_at is null) = (confirm_checks is null)
  and (confirmed_at is null) = (confirm_failed is null)
  and (confirmed_at is null) = (review_changes is null)
  and (confirmed_at is null) = (compared_with is null)
  and (confirmed_at is null or (business is not null and supplier_id is not null and receipt_date is not null and kind is not null))
  and (confirm_reason is null or cardinality(confirm_failed) > 0)
  and (confirm_failed is null or cardinality(confirm_failed) = 0 or confirm_reason is not null)
  and (review_changes is null or jsonb_typeof(review_changes) = 'object')
  and (confirm_checks is null or jsonb_typeof(confirm_checks) = 'array')
);
alter table ops.purchase_receipts add constraint purchase_receipts_redo_not_self check (redo_of is distinct from purchase_id);
-- One redo per voided receipt.
create unique index purchase_receipts_redo_of on ops.purchase_receipts (redo_of) where redo_of is not null;
-- The books: one business, newest on the books first.
create index purchase_receipts_books_idx on ops.purchase_receipts (business, confirmed_at desc, purchase_id desc) where status in ('confirmed', 'voided');
comment on column ops.purchase_receipts.signs_decided_by is 'When a person chose the business ({person}): what the signs said (the kinds, or {conflict} / {not_known}); NULL when the signs decided it';
comment on column ops.purchase_receipts.review_changes is 'At confirm: what differs from the first reading of the original (compared_with), field by field, and the lines added, removed and changed';

-- A confirmed receipt is final: once confirmed, the only change any role can make is to void it (once).
-- The column grants below already keep the figures, the business and the supplier out of reach; this keeps
-- the confirm record and the status too, whoever runs the update.
create function ops.purchase_receipts_final() returns trigger language plpgsql as $$
begin
  if old.status in ('confirmed', 'voided') then
    if old.status = 'confirmed' and new.status = 'voided'
       and new.voided_at is not null and old.voided_at is null
       and (to_jsonb(new) - array['status', 'voided_by', 'voided_at', 'void_reason']) = (to_jsonb(old) - array['status', 'voided_by', 'voided_at', 'void_reason']) then
      return new;
    end if;
    raise exception 'a % receipt is final: it cannot be changed', old.status using errcode = 'check_violation', constraint = 'purchase_receipts_final';
  end if;
  return new;
end;
$$;
create trigger purchase_receipts_final before update on ops.purchase_receipts for each row execute function ops.purchase_receipts_final();

-- ── business_signs and supplier_names: learnt from which confirmed receipt ──
-- A sign or a spelling a person ticked when confirming names the receipt, so voiding it can list them.
alter table ops.business_signs add column learnt_from_receipt text references ops.purchase_receipts (purchase_id);
alter table ops.business_signs add constraint business_signs_learnt_receipt check ((learnt_from = 'confirmed_receipt') = (learnt_from_receipt is not null));
alter table ops.supplier_names add column learnt_from_receipt text references ops.purchase_receipts (purchase_id);
alter table ops.supplier_names add constraint supplier_names_learnt_receipt check ((learnt_from = 'confirmed_receipt') = (learnt_from_receipt is not null));

-- ── suppliers: the display name in the normal form, unique among active suppliers ──
-- (receipts/businesses.ts normalise: NFKC, lower case, no white space, no dashes.) NULL only on a row made
-- before this migration.
alter table ops.suppliers add column display_key text check (display_key is null or (display_key <> '' and char_length(display_key) <= 250));
create unique index suppliers_active_display_key on ops.suppliers (display_key) where active and display_key is not null;

-- ── Grants: the exceptions to roles.sql's defaults (select, insert, update; never delete) ──
-- purchase_receipts: 0013 granted status, the superseded link and the confirm and void columns; confirming
-- also writes its record. The figures, the business, what the signs said, the supplier and redo_of are
-- written once, at insert.
grant update (confirm_checks, confirm_failed, confirm_reason, review_changes, compared_with) on ops.purchase_receipts to ops_app;
-- suppliers: renaming changes the display name and its key.
grant update (display_key) on ops.suppliers to ops_app;
