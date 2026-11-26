-- P3-11: sales rows keep the order they were written in (see 0004 for audit_log and payments).
-- The dashboard lists a day's rows in the order the Sheet appended them, which is the order of
-- the closes: cstore morning, vape, cstore evening. No other column says that.
alter table ops.sales add column seq bigint generated always as identity;
create unique index sales_seq_idx on ops.sales (seq);
comment on column ops.sales.seq is 'The order sales rows were written in (the Sheet''s row order). Generated; never set by the app.';
