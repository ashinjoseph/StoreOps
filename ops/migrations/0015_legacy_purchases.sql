-- P5-16: the old purchase list, brought in as history
-- (docs/components/receipts.md, "The old purchase list").
-- The owner kept purchases as a list in a workbook: a date, a supplier typed by hand, an amount and a note.
-- Decision (Nov 27): the list comes into the app as HISTORY, with the little it has, marked "no original on
-- file". It is NOT turned into receipts (no document, no tax figure, no invoice number, and for most rows
-- nothing that says which business bought it), so it has tables of its own and never mixes with the books.
-- Two Operations-only tables; no Sheet tab feeds them and the cutover tools neither load nor compare them.
--
-- A FILE is one workbook the list was read from (its SHA-256, its name as given, the tab). A ROW is one line
-- of that tab, kept exactly as it was: the row number as a person sees it in the spreadsheet, the date, the
-- supplier as typed, the amount to the cent, the note as typed. Nothing is corrected, merged or dropped.
-- A person may afterwards say which business a row belongs to (never set by the app on its own) and which
-- supplier on the app's list a spelling stands for; the text as typed stays. A changed file replaces an old
-- one by marking the old file and its rows SUPERSEDED: nothing is deleted.

-- ── supplier_names: a spelling may be learnt from the old list ──
-- (0013 made the CHECK inline, so Postgres named it supplier_names_learnt_from_check.)
alter table ops.supplier_names drop constraint supplier_names_learnt_from_check;
alter table ops.supplier_names add constraint supplier_names_learnt_from_check check (learnt_from in ('typed', 'confirmed_receipt', 'old_list'));

-- ── legacy_purchase_files: one workbook the list came from ──
create table ops.legacy_purchase_files (
  file_id        text primary key check (file_id ~ '^lf[0-9a-f]{20}$'),
  -- The workbook's SHA-256: the same file twice is one file.
  file_sha256    bytea not null unique check (octet_length(file_sha256) = 32),
  file_name      text not null check (file_name <> '' and char_length(file_name) <= 200),   -- as given, cleaned
  tab            text not null check (tab <> '' and char_length(tab) <= 100),
  rows_read      integer not null check (rows_read >= 0),
  rows_kept      integer not null check (rows_kept >= 0),
  rows_rejected  integer not null check (rows_rejected >= 0),
  imported_by    text not null,                                          -- staff id; no FK, like the other actor columns
  imported_at    timestamptz not null,
  superseded_by  text references ops.legacy_purchase_files (file_id),
  superseded_at  timestamptz,
  constraint legacy_purchase_files_counts check (rows_kept + rows_rejected = rows_read),
  constraint legacy_purchase_files_superseded check ((superseded_by is null) = (superseded_at is null) and superseded_by is distinct from file_id)
);
comment on table ops.legacy_purchase_files is 'One workbook the old purchase list was read from. Never deleted: a changed file supersedes it.';

-- ── legacy_purchases: one line of the old list ──
create table ops.legacy_purchases (
  row_id          text primary key check (row_id ~ '^lp[0-9a-f]{24}$'),
  file_id         text not null references ops.legacy_purchase_files (file_id),
  -- The row number as a person sees it in the spreadsheet (the header is row 1, so the first is row 2).
  sheet_row       integer not null check (sheet_row >= 2),
  purchase_date   date not null check (purchase_date >= date '2000-01-01'),
  -- The supplier as typed ('' when the cell was blank: "supplier not written") and its normal form
  -- (receipts/businesses.ts normalise), which groups the spellings.
  supplier_text   text not null,
  spelling_key    text not null,
  amount          numeric(12, 2) not null,                                -- exact; a zero or negative amount (a refund) is kept as it is
  note            text not null,                                          -- as typed; '' when the cell was blank
  -- Which business bought it: NULL until a person says so. Nothing sets it automatically.
  business        text references ops.businesses (business),
  business_set_by text,
  business_set_at timestamptz,
  -- The supplier on the app's list this spelling stands for: NULL until a person links it.
  supplier_id     text references ops.suppliers (supplier_id),
  linked_by       text,
  linked_at       timestamptz,
  superseded_at   timestamptz,
  constraint legacy_purchases_file_row unique (file_id, sheet_row),
  constraint legacy_purchases_business_set check ((business_set_by is null) = (business_set_at is null) and (business is null or business_set_by is not null)),
  constraint legacy_purchases_link_set check ((linked_by is null) = (linked_at is null) and (supplier_id is null or linked_by is not null))
);
comment on table ops.legacy_purchases is 'The old purchase list, as history: no original on file. Never deleted, never among the receipts.';
-- "One business (or not sorted), newest first": the list and its totals.
create index legacy_purchases_business_idx on ops.legacy_purchases (business, purchase_date desc, row_id desc) where superseded_at is null;
-- "By spelling": the spellings table and what one spelling covers.
create index legacy_purchases_spelling_idx on ops.legacy_purchases (spelling_key) where superseded_at is null;
create index legacy_purchases_file_idx on ops.legacy_purchases (file_id);

-- ── Grants: the exceptions to roles.sql's defaults (select, insert, update; never delete) ──
-- A file is written once; the app may only mark it superseded.
revoke update on ops.legacy_purchase_files from ops_app;
grant update (superseded_by, superseded_at) on ops.legacy_purchase_files to ops_app;
-- A row is written once; the app may only change its business, its supplier link and its superseded mark.
revoke update on ops.legacy_purchases from ops_app;
grant update (business, business_set_by, business_set_at, supplier_id, linked_by, linked_at, superseded_at) on ops.legacy_purchases to ops_app;
