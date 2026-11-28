-- P5-05c: receipts of every kind in one form (docs/components/receipts.md;
-- docs/adr/0032-one-receipt-form-for-every-kind.md).
-- No new table: four optional facts about the document on ops.purchase_receipts, who added the Canadian
-- amount paid to a confirmed receipt and when, the final-receipt trigger of 0014 allowing exactly that one
-- addition, and its grant. The cutover tools neither load nor compare any of them.
--
-- The facts, each blank when the document does not say (ADR-0004: blank is not "no"):
--   document_kind  what the document is: receipt, invoice, credit_note (a refund, return or credit from a
--                  supplier), statement (a summary of several invoices or of an account), other;
--   currency       the three-letter code as printed (CAD, USD, ...); blank: none printed, taken as CAD;
--   tax_included   true when the document says prices include HST and prints no HST amount; false; blank;
--   total_cad      for a document in another currency: what left the account in Canadian dollars (from
--                  the card or bank statement). Blank until known; a reader or reviewer may give it on a
--                  draft, and it may be ADDED, ONCE, to a confirmed receipt (total_cad_by, total_cad_at).
-- Extra charges keep their JSON column (other_charges, 0013): each part may now also hold a kind
-- (deposit, eco_fee, tobacco_tax, duty, delivery, tip, discount, other) and a taxed mark; a part without
-- them is read as "kind not said, tax not marked". No table: they are written once with the reading.
-- Amounts are stored as printed, with their own signs: nothing here changes a sign or converts a currency.

alter table ops.purchase_receipts
  add column document_kind  text check (document_kind is null or document_kind in ('receipt', 'invoice', 'credit_note', 'statement', 'other')),
  add column currency       text check (currency is null or currency ~ '^[A-Z]{3}$'),
  add column tax_included   boolean,
  add column total_cad      numeric(12, 2),
  add column total_cad_by   text,
  add column total_cad_at   timestamptz;

alter table ops.purchase_receipts add constraint purchase_receipts_total_cad check (
  (total_cad is null or (currency is not null and currency <> 'CAD'))
  and ((total_cad_by is null) = (total_cad_at is null))
  and (total_cad_at is null or total_cad is not null)
);
comment on column ops.purchase_receipts.document_kind is 'What the document is, as a reader or reviewer said: receipt, invoice, credit_note, statement, other; NULL: not said';
comment on column ops.purchase_receipts.currency is 'The currency code printed on the document; NULL: none printed, taken as Canadian dollars';
comment on column ops.purchase_receipts.total_cad is 'For a document in another currency: the Canadian amount actually paid. May be added once to a confirmed receipt (total_cad_by, total_cad_at)';

-- A confirmed receipt is final (0014), with ONE more exception: the Canadian amount paid may be added to a
-- confirmed receipt in another currency, once, blank to a value, with who and when; nothing else on the row
-- changes with it. The same function replaces 0014's: the void exception is unchanged. On a reading that is
-- not on the books (a draft, a superseded one), the three columns never change either: a draft's figures
-- are written once, and a correction is a new reading.
create or replace function ops.purchase_receipts_final() returns trigger language plpgsql as $$
begin
  if old.status in ('confirmed', 'voided') then
    if old.status = 'confirmed' and new.status = 'voided'
       and new.voided_at is not null and old.voided_at is null
       and (to_jsonb(new) - array['status', 'voided_by', 'voided_at', 'void_reason']) = (to_jsonb(old) - array['status', 'voided_by', 'voided_at', 'void_reason']) then
      return new;
    end if;
    if old.status = 'confirmed' and new.status = 'confirmed'
       and old.currency is not null and old.currency <> 'CAD'
       and old.total_cad is null and old.total_cad_by is null and old.total_cad_at is null
       and new.total_cad is not null and new.total_cad_by is not null and new.total_cad_at is not null
       and (to_jsonb(new) - array['total_cad', 'total_cad_by', 'total_cad_at']) = (to_jsonb(old) - array['total_cad', 'total_cad_by', 'total_cad_at']) then
      return new;
    end if;
    raise exception 'a % receipt is final: it cannot be changed', old.status using errcode = 'check_violation', constraint = 'purchase_receipts_final';
  end if;
  if new.total_cad is distinct from old.total_cad or new.total_cad_by is distinct from old.total_cad_by or new.total_cad_at is distinct from old.total_cad_at then
    raise exception 'the Canadian amount paid can be added only to a receipt on the books' using errcode = 'check_violation', constraint = 'purchase_receipts_final';
  end if;
  return new;
end;
$$;

-- ── Grants: the exceptions to roles.sql's defaults (select, insert, update; never delete) ──
-- purchase_receipts: the four facts are written once, at insert, like the figures. Adding the Canadian
-- amount paid to a confirmed receipt writes it and its two companions (the trigger above decides when).
grant update (total_cad, total_cad_by, total_cad_at) on ops.purchase_receipts to ops_app;
