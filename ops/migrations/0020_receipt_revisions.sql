-- P5-18: an updated invoice replaces the one it updates (docs/components/receipts.md, "An updated invoice").
--
-- The owner, Nov 28: a wholesaler sometimes accepts an order, then finds items out of stock and sends an
-- updated invoice under the same number; "if no changes then nothing to change, but if there is a delta,
-- modify". A confirmed receipt is final (0014), so nothing is modified in place: confirming the update with
-- `replaces` takes the old one off the books in the same step (voided, with the reason "Replaced by an
-- updated invoice (receipt <id>)", its original set aside; an old one still a draft has its original set
-- aside) and records here which receipt the new one replaces. No new table.
--
-- One receipt is replaced at most once. `replaces` is written once, when the update is confirmed; the
-- final-receipt trigger of 0014/0018 compares the whole row, so it never changes after that.

alter table ops.purchase_receipts
  add column replaces text references ops.purchase_receipts (purchase_id);
create unique index purchase_receipts_replaces on ops.purchase_receipts (replaces) where replaces is not null;
comment on column ops.purchase_receipts.replaces is 'The receipt this one replaces: an updated invoice from the same supplier, same invoice number and business (P5-18). Set at confirm';

-- ── Grants: the exceptions to roles.sql's defaults (select, insert, update; never delete) ──
grant update (replaces) on ops.purchase_receipts to ops_app;
