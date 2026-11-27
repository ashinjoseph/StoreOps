-- P5-05a: receipt drafts, what was read off one receipt original and checked by the app
-- (docs/components/receipts.md; docs/adr/0027-the-app-decides-the-business-and-checks-the-arithmetic.md).
-- Four Operations-only tables; no Sheet tab feeds them and the cutover tools neither load nor compare them.
--
-- A DRAFT is a reading of one stored original: the figures an assistant (through the tool
-- receipt_propose) or a person (by hand, rpcEnterReceiptDraft) read off it, the business the APP
-- decided from the buyer's signs printed on it, and the result of the app's arithmetic checks. It
-- counts for nothing until a person confirms it (the next card). A draft's figures never change once
-- written: a new reading of the same original is a new row that supersedes the old one, which is kept.
--
-- status (named CHECK, so a later card can grow it by drop and re-add, as 0012 did for originals):
--   draft       the live reading of its original (at most one per original, with confirmed)
--   superseded  replaced by a newer reading (superseded_by, superseded_at); kept, never deleted
--   confirmed   a person confirmed it (next card: confirmed_by, confirmed_at)
--   voided      a confirmed receipt taken back (a later card: voided_by, voided_at, void_reason)
-- Only draft and superseded are reached by card P5-05a.

-- ── Suppliers: one name per supplier, with the spellings seen so far ──
create table ops.suppliers (
  supplier_id   text primary key check (supplier_id ~ '^sp[0-9a-f]{20}$'),
  display_name  text not null check (display_name <> '' and char_length(display_name) <= 120),
  -- The supplier's own HST number (nine digits, RT, four digits), when known.
  hst_number    text check (hst_number is null or hst_number ~ '^[0-9]{9}RT[0-9]{4}$'),
  notes         text check (notes is null or (notes <> '' and char_length(notes) <= 500)),
  active        boolean not null default true,
  created_by    text not null,                                            -- staff id; no FK, like the other actor columns
  created_at    timestamptz not null
);
comment on table ops.suppliers is 'One row per supplier. Never deleted: a supplier no longer used is marked inactive.';

-- supplier_names: each spelling a supplier is printed under. name_key is the form two spellings are
-- compared in (receipts/businesses.ts normalise: NFKC, lower case, no white space, no dashes). One live
-- spelling belongs to one supplier. A spelling is removed (removed_*), never deleted.
create table ops.supplier_names (
  name_id      text primary key check (name_id ~ '^sn[0-9a-f]{20}$'),
  supplier_id  text not null references ops.suppliers (supplier_id),
  name         text not null check (name <> '' and char_length(name) <= 120),
  name_key     text not null check (name_key <> '' and char_length(name_key) <= 250),
  learnt_from  text not null default 'typed' check (learnt_from in ('typed', 'confirmed_receipt')),
  added_by     text not null,
  added_at     timestamptz not null,
  removed_by   text,
  removed_at   timestamptz,
  constraint supplier_names_removed check ((removed_by is null) = (removed_at is null))
);
create unique index supplier_names_live_key on ops.supplier_names (name_key) where removed_at is null;
create index supplier_names_supplier_idx on ops.supplier_names (supplier_id);
comment on table ops.supplier_names is 'Each spelling a supplier is printed under, compared by name_key. Removed, never deleted.';

-- ── Purchase receipts: drafts now; confirmed and voided receipts later ──
create table ops.purchase_receipts (
  purchase_id           text primary key check (purchase_id ~ '^pr[0-9a-f]{24}$'),
  -- The original it was read from. NULL only for a later import of the old purchase list (P5-16).
  original_id           text references ops.receipt_originals (receipt_id),
  status                text not null default 'draft',
  -- Who read it: an assistant's key and its person, or a person by hand.
  read_by_kind          text not null check (read_by_kind in ('assistant', 'person')),
  read_by_key           text references ops.assistant_keys (key_id),
  read_by               text not null,                                    -- staff id: the key's person, or the person
  read_at               timestamptz not null,
  -- The business, as the APP decided it from the signs (never the reader's choice).
  business              text references ops.businesses (business),
  business_decided_by   text[] not null,                                  -- the kinds of sign that decided it, or {conflict} / {not_known}; {person} later
  business_signs        jsonb not null default '[]'::jsonb,               -- the live signs that matched: [{ sign_id, business, kind, value, supplier }]
  business_person_said  text references ops.businesses (business),        -- what a person said at upload (receipt_originals.business), kept beside
  -- What the document prints about the BUYER (as printed, cleaned). Evidence, not a decision.
  buyer_name            text check (buyer_name is null or (buyer_name <> '' and char_length(buyer_name) <= 120)),
  buyer_hst_number      text check (buyer_hst_number is null or (buyer_hst_number <> '' and char_length(buyer_hst_number) <= 40)),
  buyer_account_number  text check (buyer_account_number is null or (buyer_account_number <> '' and char_length(buyer_account_number) <= 60)),
  buyer_card_last4      text check (buyer_card_last4 is null or buyer_card_last4 ~ '^[0-9]{4}$'),
  suggested_business    text references ops.businesses (business),        -- the reader's own guess: stored, decides nothing
  -- The supplier as printed, and the supplier it matched (NULL: not on the list; a person picks later).
  supplier_id           text references ops.suppliers (supplier_id),
  supplier_name         text check (supplier_name is null or (supplier_name <> '' and char_length(supplier_name) <= 120)),
  supplier_name_key     text check (supplier_name_key is null or (supplier_name_key <> '' and char_length(supplier_name_key) <= 250)),
  supplier_hst_number   text check (supplier_hst_number is null or (supplier_hst_number <> '' and char_length(supplier_hst_number) <= 40)),
  invoice_number        text check (invoice_number is null or (invoice_number <> '' and char_length(invoice_number) <= 60)),
  invoice_key           text check (invoice_key is null or (invoice_key <> '' and char_length(invoice_key) <= 120)),
  -- The date as given (text) and, when it is a real day, as a date. Blank: not on the receipt.
  receipt_date          date,
  receipt_date_text     text check (receipt_date_text is null or (receipt_date_text <> '' and char_length(receipt_date_text) <= 40)),
  paid_how              text check (paid_how is null or paid_how in ('cash', 'card', 'account', 'other')),
  paid_card_last4       text check (paid_card_last4 is null or paid_card_last4 ~ '^[0-9]{4}$'),
  -- Money: exact, two decimals. Only the total is required; NULL is "not on the receipt", never 0.
  subtotal              numeric(12, 2),
  hst                   numeric(12, 2),
  total                 numeric(12, 2) not null,
  other_total           numeric(12, 2),                                   -- the sum of other_charges, when there are any
  other_charges         jsonb,                                            -- [{ label, amount: "1.20" }]: bottle deposits, fees, duty
  hst_rate_percent      numeric(6, 3) not null,                           -- the setting hst_rate_percent the checks used
  kind                  text check (kind is null or kind in ('stock', 'supplies', 'equipment', 'licences_fees', 'other')),
  -- The checks: every one with passed true, false or null (not checked), and its words.
  needs_attention       boolean not null,
  checks                jsonb not null,
  where_read            jsonb,                                            -- { field: "bottom right, under TOTAL" }, text for the reviewer
  reader_note           text check (reader_note is null or (reader_note <> '' and char_length(reader_note) <= 500)),
  -- Replacing: the newer row names the one it replaced; the older is marked superseded.
  supersedes            text references ops.purchase_receipts (purchase_id),
  -- Checked at commit: the older row is marked before the newer is inserted (the one-live-reading index).
  superseded_by         text references ops.purchase_receipts (purchase_id) deferrable initially deferred,
  superseded_at         timestamptz,
  -- For the next cards; present and unused here.
  confirmed_by          text,
  confirmed_at          timestamptz,
  voided_by             text,
  voided_at             timestamptz,
  void_reason           text check (void_reason is null or char_length(void_reason) between 3 and 300),
  constraint purchase_receipts_status check (status in ('draft', 'confirmed', 'voided', 'superseded')),
  constraint purchase_receipts_reader check (
    (read_by_kind = 'assistant') = (read_by_key is not null)
  ),
  constraint purchase_receipts_business check (
    business_decided_by <> '{}'
    and business_decided_by <@ array['name', 'hst_number', 'supplier_account', 'card_last4', 'person', 'conflict', 'not_known']::text[]
    and (business is null) = (business_decided_by && array['conflict', 'not_known']::text[])
    and (cardinality(business_decided_by) = 1 or not (business_decided_by && array['conflict', 'not_known', 'person']::text[]))
  ),
  constraint purchase_receipts_other check ((other_total is null) = (other_charges is null) and (other_charges is null or jsonb_typeof(other_charges) = 'array')),
  constraint purchase_receipts_checks check (jsonb_typeof(checks) = 'array' and jsonb_typeof(business_signs) = 'array'),
  constraint purchase_receipts_where_read check (where_read is null or jsonb_typeof(where_read) = 'object'),
  constraint purchase_receipts_date check (receipt_date is null or receipt_date_text is not null),
  constraint purchase_receipts_card check (paid_card_last4 is null or paid_how = 'card'),
  constraint purchase_receipts_superseded check (
    (status = 'superseded') = (superseded_at is not null)
    and (superseded_at is null) = (superseded_by is null)
  ),
  constraint purchase_receipts_confirmed check ((confirmed_by is null) = (confirmed_at is null) and (status not in ('confirmed', 'voided') or confirmed_at is not null)),
  constraint purchase_receipts_voided check (
    (status = 'voided') = (voided_at is not null)
    and (voided_at is null) = (voided_by is null)
    and (voided_at is null) = (void_reason is null)
  ),
  constraint purchase_receipts_not_self check (supersedes is distinct from purchase_id and superseded_by is distinct from purchase_id)
);
-- One live reading per original: a draft or a confirmed receipt (superseded and voided rows do not count).
create unique index purchase_receipts_live_original on ops.purchase_receipts (original_id) where status in ('draft', 'confirmed') and original_id is not null;
-- The duplicate checks: the same supplier and invoice number; the same supplier, date and total.
create index purchase_receipts_invoice_idx on ops.purchase_receipts (invoice_key) where status in ('draft', 'confirmed');
create index purchase_receipts_supplier_date_idx on ops.purchase_receipts (supplier_name_key, receipt_date) where status in ('draft', 'confirmed');
-- my_proposals: a key's drafts, newest first.
create index purchase_receipts_key_idx on ops.purchase_receipts (read_by_key, read_at desc, purchase_id desc) where read_by_key is not null;
comment on table ops.purchase_receipts is 'Readings of receipt originals (drafts), and later the confirmed receipts. Figures never change after insert; a newer reading supersedes. Never deleted.';
comment on column ops.purchase_receipts.business_decided_by is 'The kinds of sign that decided the business (name, hst_number, supplier_account, card_last4), or {conflict} / {not_known}; {person} when a person chose it (next card)';

-- purchase_receipt_lines: the lines as printed, for the cost history (a later card). Optional.
create table ops.purchase_receipt_lines (
  purchase_id   text not null references ops.purchase_receipts (purchase_id),
  line_no       integer not null check (line_no between 1 and 300),
  description   text not null check (description <> '' and char_length(description) <= 300),
  item_code     text check (item_code is null or (item_code <> '' and char_length(item_code) <= 60)),
  quantity      numeric(12, 3),
  unit_price    numeric(14, 4),                                           -- up to four decimals: fuel at 1.459 a litre, 0.3333 each
  line_total    numeric(12, 2),
  taxed         boolean,                                                  -- NULL: not marked on the receipt
  primary key (purchase_id, line_no)
);
comment on table ops.purchase_receipt_lines is 'The lines of a purchase receipt as printed. Never changed or deleted.';

-- ── receipt_originals: a read original is drafted ──
-- An original with a live draft leaves "waiting to be read". Set aside from drafted is allowed; putting
-- it back makes it drafted again (its draft is kept). The set-aside columns stay tied to set_aside.
alter table ops.receipt_originals drop constraint receipt_originals_status;
alter table ops.receipt_originals add constraint receipt_originals_status check (status in ('waiting', 'drafted', 'set_aside'));

-- ── Grants: the exceptions to roles.sql's defaults (select, insert, update; never delete) ──
-- suppliers: a later card renames, records the HST number, marks inactive.
revoke update on ops.suppliers from ops_app;
grant update (display_name, hst_number, notes, active) on ops.suppliers to ops_app;
-- supplier_names: a spelling never changes; the app may only mark it removed.
revoke update on ops.supplier_names from ops_app;
grant update (removed_by, removed_at) on ops.supplier_names to ops_app;
-- purchase_receipts: the figures, the reader, the business decision and the checks never change after
-- insert (a new reading supersedes). The app may change the status and the superseded link, and the
-- confirm and void columns the next cards fill.
revoke update on ops.purchase_receipts from ops_app;
grant update (status, superseded_by, superseded_at, confirmed_by, confirmed_at, voided_by, voided_at, void_reason) on ops.purchase_receipts to ops_app;
-- purchase_receipt_lines: written with their receipt, never changed.
revoke update on ops.purchase_receipt_lines from ops_app;
