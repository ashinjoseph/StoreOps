-- P5-12a: the two businesses and the receipt inbox (docs/adr/0026-receipt-originals-are-kept-as-received.md).
-- Three Operations-only tables; no Sheet tab feeds them and the cutover tools neither load nor compare them.
--
-- businesses: exactly the two (cstore and vape), seeded here. They are separate companies with separate
-- HST numbers and separate books. The legal name and HST number start blank (NULL): the display names
-- in the settings cstore_business_name / vape_business_name are trading names, not legal names, and a
-- migration runs before the cutover import has loaded the settings, so reading them here would seed
-- nothing on a new database and a guess on an old one. The screen shows the setting's name until an
-- admin types the legal name. A business is never added or removed by the app.
create table ops.businesses (
  business     text primary key check (business in ('cstore', 'vape')),
  legal_name   text check (legal_name is null or (legal_name <> '' and char_length(legal_name) <= 120)),
  -- Canadian business number + program: nine digits, RT, four digits, stored without spaces.
  hst_number   text check (hst_number is null or hst_number ~ '^[0-9]{9}RT[0-9]{4}$'),
  notes        text check (notes is null or (notes <> '' and char_length(notes) <= 500)),
  modified_by  text,                                                  -- staff id; no FK, like the other actor columns
  modified_at  timestamptz,
  constraint businesses_modified check ((modified_by is null) = (modified_at is null))
);
insert into ops.businesses (business) values ('cstore'), ('vape');

comment on table ops.businesses is 'The two businesses (separate companies, separate HST numbers). Seeded; never added or removed.';

-- business_signs: what on a document says which business it belongs to. A sign is removed (removed_*),
-- never deleted. value is what was typed (cleaned); value_key is the form two spellings are compared in
-- (see receipts/businesses.ts normalise: NFKC, lower case, no white space, no dashes; for an account
-- number, the supplier's key, a bar, then the number's key). One live sign can belong to one business
-- only: the partial unique index below holds that, whichever business the second spelling is typed for.
create table ops.business_signs (
  sign_id      text primary key check (sign_id ~ '^bs[0-9a-f]{20}$'),
  business     text not null references ops.businesses (business),
  kind         text not null check (kind in ('name', 'hst_number', 'supplier_account', 'card_last4')),
  value        text not null check (value <> '' and char_length(value) <= 120),
  value_key    text not null check (value_key <> '' and char_length(value_key) <= 250),
  supplier     text check (supplier is null or (supplier <> '' and char_length(supplier) <= 80)),
  learnt_from  text not null default 'typed' check (learnt_from in ('typed', 'confirmed_receipt')),
  added_by     text not null,
  added_at     timestamptz not null,
  removed_by   text,
  removed_at   timestamptz,
  constraint business_signs_supplier check ((kind = 'supplier_account') = (supplier is not null)),
  constraint business_signs_card check (kind <> 'card_last4' or value ~ '^[0-9]{4}$'),
  constraint business_signs_hst check (kind <> 'hst_number' or value ~ '^[0-9]{9}RT[0-9]{4}$'),
  constraint business_signs_removed check ((removed_by is null) = (removed_at is null))
);
create unique index business_signs_live_key on ops.business_signs (kind, value_key) where removed_at is null;
create index business_signs_business_idx on ops.business_signs (business);

comment on table ops.business_signs is 'Signs that identify a business on a receipt (a name, an HST number, a supplier account, a card). Removed, never deleted.';

-- receipt_originals: one row per original received (a photo or a file), kept byte for byte in object
-- storage (R2) under storage_key. The SHA-256 is unique: the same bytes twice are one original.
-- Nothing is extracted yet. status grows by later cards: the CHECK is named, so a later migration
-- replaces it (drop constraint, add constraint: a check, no table rewrite) with more states; the
-- set-aside columns are tied to 'set_aside' only, so new states need no change there.
-- source: photo and upload now; assistant and email are reserved, with their own columns, so the cards
-- that add them need no migration.
create table ops.receipt_originals (
  receipt_id        text primary key check (receipt_id ~ '^ro[0-9a-f]{24}$'),
  sha256            bytea not null unique check (octet_length(sha256) = 32),
  size_bytes        integer not null check (size_bytes > 0 and size_bytes <= 26214400),
  content_type      text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf')),
  storage_key       text not null unique check (storage_key ~ '^originals/[0-9]{4}-[0-9]{2}/ro[0-9a-f]{24}$'),
  business          text references ops.businesses (business),             -- NULL: not known yet, never guessed
  status            text not null default 'waiting',
  set_aside_reason  text check (set_aside_reason is null or char_length(set_aside_reason) between 3 and 300),
  set_aside_by      text,
  set_aside_at      timestamptz,
  source            text not null check (source in ('photo', 'upload', 'assistant', 'email')),
  assistant_key_id  text references ops.assistant_keys (key_id),
  email_message_id  text check (email_message_id is null or char_length(email_message_id) <= 500),
  email_sender      text check (email_sender is null or char_length(email_sender) <= 320),
  email_date        timestamptz,
  added_by          text not null,                                         -- staff id; no FK, like the other actor columns
  added_at          timestamptz not null,
  file_name         text check (file_name is null or (file_name <> '' and char_length(file_name) <= 120)),
  note              text check (note is null or (note <> '' and char_length(note) <= 300)),
  constraint receipt_originals_status check (status in ('waiting', 'set_aside')),
  constraint receipt_originals_set_aside check (
    (status = 'set_aside') = (set_aside_at is not null)
    and (set_aside_at is null) = (set_aside_by is null)
    and (set_aside_at is null) = (set_aside_reason is null)
  ),
  constraint receipt_originals_assistant check ((source = 'assistant') = (assistant_key_id is not null)),
  constraint receipt_originals_email check ((source = 'email') = (email_message_id is not null))
);
create index receipt_originals_list_idx on ops.receipt_originals (status, added_at desc, receipt_id desc);
create index receipt_originals_added_by_idx on ops.receipt_originals (added_by, added_at desc);

comment on table ops.receipt_originals is 'Every receipt original received, kept byte for byte in R2 (storage_key) with its SHA-256. Never deleted.';
comment on column ops.receipt_originals.file_name is 'The name the file was sent with, cleaned and capped: shown to a person, never used as a path or a key';

-- ── Grants: the exceptions to roles.sql's defaults (select, insert, update; never delete) ──
-- businesses: the two rows are seeded here; the app may change what an admin types, nothing else.
revoke insert, update on ops.businesses from ops_app;
grant update (legal_name, hst_number, notes, modified_by, modified_at) on ops.businesses to ops_app;
-- business_signs: a sign never changes after it is added; the app may only mark it removed.
revoke update on ops.business_signs from ops_app;
grant update (removed_by, removed_at) on ops.business_signs to ops_app;
-- receipt_originals: the hash, size, type, storage key, source and who added it never change.
revoke update on ops.receipt_originals from ops_app;
grant update (business, status, set_aside_reason, set_aside_by, set_aside_at) on ops.receipt_originals to ops_app;
