# 0029. A confirmed receipt is final; a mistake is voided and done again

- **Status:** Accepted
- **Date:** 2026-11
- **Components:** [receipts](../components/receipts.md), [assistants](../components/assistants.md)

## Context

Card P5-05a keeps what was read off a receipt original as a draft that counts
for nothing ([ADR-0027](0027-the-app-decides-the-business-and-checks-the-arithmetic.md)).
Card P5-05b is the step where a person makes it count: they look at the
original beside the figures, correct what is wrong, settle the business and
the supplier, and confirm. A confirmed receipt is a line in one of two
companies' books (cstore and vape: separate HST numbers, separate QuickBooks
files). Three things follow from that:

- What is on the books must not move under the bookkeeper. A figure changed
  after it was exported, or a receipt that quietly changes business, is a tax
  claim nobody can trace.
- People make mistakes after confirming too: a total misread, the wrong
  business. They must be able to put it right without erasing what was there
  ([AGENTS.md](../../AGENTS.md) hard rule 9: never delete money records).
- The owner asked the app to **learn** which printed signs tell the businesses
  apart (the owner's answer 5 in
  [the design](../plans/2026-11-assistants-through-mcp.md#the-owners-answers-nov-27)),
  and later cards will measure the assistants by how much a reviewer changed.

## Decision

1. **A correction is a new reading.** A person's correction is written as a new
   draft (read by that person) that supersedes the live one, exactly as a new
   proposal does; the old row is never changed. The checks and the business
   decision are run again by the same pure functions. The database role has no
   right to update a draft's figures.
2. **Confirm settles five things and is final.** A total, a receipt date that
   is a real day, a kind, a business (the signs' decision, or a person's choice,
   recorded as `person` with what the signs said kept beside) and an active
   supplier. The checks are re-run on the figures confirmed; any that fail need
   a typed reason, stored with the failing checks; a duplicate of a receipt
   already confirmed needs an admin. Once confirmed nothing about the receipt
   can change: column grants keep the figures, the business and the supplier
   out of the app's reach, and a trigger refuses any other change but a single
   void. Its original becomes `confirmed`; one original has at most one
   confirmed receipt.
3. **A mistake is voided, then done again.** An admin or a manager voids a
   confirmed receipt with a reason. It stays in every list, marked voided, out
   of the totals, with its original and figures. The original goes back to
   review with a new draft copied from the voided one (`redo_of`), to correct and
   confirm again.
4. **The app learns only when a person confirms, and only by a tick.** At
   confirm, each piece of buyer evidence printed and not yet a sign is offered,
   unticked, and is added only when an admin ticks it, through the Businesses
   card's own operation (`learnt_from = 'confirmed_receipt'`, the receipt named).
   The printed supplier name is offered (ticked) as a spelling of the chosen
   supplier. A void does not remove what was learnt; it lists it.
5. **What was changed is recorded** on the receipt, field by field, against the
   first reading of the original, for the later measure of the assistants.

## Consequences

- ✅ The books are append-only in practice: what was confirmed, by whom and why
  can always be shown, including what was voided and why.
- ✅ A mistake costs one void and one re-confirm, and leaves both on file.
- ✅ The record of which signs decided each receipt, or that a person chose,
  builds up without anyone curating it; adding a sign stays a deliberate act.
- ⚠️ One original can carry several receipts over time (one confirmed, the
  others voided). Every list that counts money filters on `confirmed`.
- ⚠️ A sign or spelling learnt from a receipt later voided stays until an admin
  removes it on the Businesses screen. The void sheet says so, but nothing
  forces it.
- ⚠️ A person overruling the signs is a failed check (a reason is required), so
  a business that is often bought for with the other's card will ask for a
  reason each time until the card's sign is moved.

## Alternatives considered

- **Edit a confirmed receipt in place** (with an audit row). Simplest for the
  person, but the figures on the books would then differ from what was
  exported, and the audit log would be the only memory of what the receipt
  once said. A void keeps both versions as rows anyone can list.
- **Learn every printed card, name and account automatically** on confirm. It
  would learn fast, and learn wrong: a borrowed card, a supplier printing its
  own name as the buyer, a typo in a reading would each become a sign that then
  decides other receipts silently. A tick by an admin costs a second.
- **Confirm automatically a draft whose checks all pass.** The checks are
  arithmetic; they cannot see a wrong business, a wrong supplier or a figure
  invented so that it adds up ([ADR-0027](0027-the-app-decides-the-business-and-checks-the-arithmetic.md)).
  A person looking at the original is the control.
- **One list of the books for both businesses**, filtered by a column. Easy to
  build and easy to misuse: an export or a total made from the wrong filter
  would mix two companies' tax. The books view cannot be asked for without one
  business.
