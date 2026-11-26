-- P3-10b: commission runs keep the order they were written in (see 0004).
-- "The first run of a week" and the run history's order among runs of the same instant are the
-- Sheet's row order.
alter table ops.commission_runs add column seq bigint generated always as identity;
create unique index commission_runs_seq_idx on ops.commission_runs (seq);
comment on column ops.commission_runs.seq is 'The order runs were written in (the Sheet''s row order). Generated; never set by the app.';
