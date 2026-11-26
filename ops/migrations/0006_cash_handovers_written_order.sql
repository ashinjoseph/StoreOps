-- P3-06: cash handovers keep the order they were written in (see 0004).
-- The history lists handovers newest first by the moment they were recorded and, for handovers
-- recorded in the same instant, in the Sheet's row order.
alter table ops.cash_handovers add column seq bigint generated always as identity;
create unique index cash_handovers_seq_idx on ops.cash_handovers (seq);
comment on column ops.cash_handovers.seq is 'The order handovers were written in (the Sheet''s row order). Generated; never set by the app.';
