-- P3-07: reconcile rows keep the order they were written in (see 0004).
-- One run writes a row per merchant with the same validated_at; the history lists them newest
-- first and, within one run, in the order the Sheet appended them.
alter table ops.validation_results add column seq bigint generated always as identity;
create unique index validation_results_seq_idx on ops.validation_results (seq);
comment on column ops.validation_results.seq is 'The order reconcile rows were written in (the Sheet''s row order). Generated; never set by the app.';
