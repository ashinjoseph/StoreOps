-- P2-04b: keep the order rows were written in, for the two tables that are read in that order.
-- The Sheet kept every tab in the order rows were appended. A table has no order of its own, and
-- rows written in the same second cannot be told apart by their time or their id (the id ends in
-- random characters). `seq` is that order: the database gives each new row the next number.
--   audit_log: "what happened first" within one change, and the newest rows for the log reader.
--   payments:  the history lists payments of the same instant in the order they were recorded.
-- The import loads each tab top to bottom, so imported rows get the Sheet's own order.
-- GENERATED ALWAYS: the app cannot choose or change a row's place.
alter table ops.audit_log add column seq bigint generated always as identity;
alter table ops.payments add column seq bigint generated always as identity;

create unique index audit_log_seq_idx on ops.audit_log (seq);
create unique index payments_seq_idx on ops.payments (seq);

comment on column ops.audit_log.seq is 'The order rows were written in (the Sheet''s row order). Generated; never set by the app.';
comment on column ops.payments.seq is 'The order payments were recorded in (the Sheet''s row order). Generated; never set by the app.';
