-- P3-09b: undoing a payment voids it; it is never deleted (AGENTS.md hard rule 9, ADR-0014).
-- The old app deleted the payment row and its item rows. Here the row and its items stay, the
-- three columns below say who voided it, when and why, and every read of the Payments module
-- leaves a voided payment and its items out, so each RPC answers as the old one did after its
-- delete. A NULL voided_at: the payment stands.
alter table ops.payments
  add column voided_at timestamptz,
  add column voided_by text,
  add column void_reason text,
  add constraint payments_voided_together check ((voided_at is null) = (voided_by is null));

comment on column ops.payments.voided_at is 'When the payment was undone; NULL = it stands. A voided payment and its items count for nothing.';
comment on column ops.payments.voided_by is 'Who undid it (a staff id, no foreign key, like every actor column); set exactly when voided_at is.';
comment on column ops.payments.void_reason is 'Why, as given to the undo; NULL when none was given.';
