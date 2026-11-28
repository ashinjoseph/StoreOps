# 0033. An updated invoice replaces the one it updates, in one step

- **Status:** Accepted
- **Date:** 2026-11
- **Components:** [receipts](../components/receipts.md), [costs](../components/costs.md)

## Context

A wholesaler sometimes accepts an order, then finds items out of stock and
sends an **updated invoice** under the same invoice number, with fewer lines
and a lower total. The owner (Nov 28): "if no changes then nothing to change,
but if there is a delta, modify."

A receipt on the books is final ([ADR-0029](0029-a-confirmed-receipt-is-final-and-a-mistake-is-voided.md)):
a mistake is voided, kept on file, and done again. The duplicate check already
flags the update (same supplier, same invoice number), and only an admin may
confirm a duplicate of a receipt on the books, with a reason, so that nothing is
counted twice. Without a rule, a manager confirming the update would be refused,
and an admin confirming it would put both invoices on the books.

## Decision

- A reading of the **same business**, with the same supplier and invoice number
  as a receipt on the books (or a draft of another original), is **offered as
  its update** in the review (`confirm.revision`). A match on the books is
  preferred to a draft.
- Confirming with **`replaces`** set to the offered receipt does, in one
  transaction: the old receipt is **voided** with the reason *Replaced by an
  updated invoice (receipt &lt;new id&gt;)* and its original is **set aside**
  (*Replaced by an updated invoice*); no redo draft is made. An old one that
  was still a draft has its original set aside. Then the update is confirmed,
  recording `replaces`. Nothing is modified in place and nothing is deleted.
- The duplicate check the update resolves (every match is the one replaced)
  no longer needs an admin or a reason; it is kept in `confirm_checks` with
  its words and left out of `confirm_failed`. **Any other failed check still
  needs a reason.** Admin and manager may confirm an update, as they may
  confirm and void.
- **The same figures** (subtotal, HST and total all equal) are a copy, not an
  update: replacing is refused, and the review says to set it aside.
- The cost history drops the old receipt's lines before it takes the
  update's, so a price is compared with what was there before.
- One receipt is replaced at most once (a unique index); an update of an
  update replaces the update.

## Consequences

- ✅ The books always hold the invoice as it stands, with the earlier one
  on file, voided, saying what replaced it, and the audit log saying who did it.
- ✅ A manager can do the everyday case without an admin, and without typing
  a reason for a duplicate that is not one.
- ⚠️ The update is recognised only by the same supplier and the same
  invoice number. An update under a new number is two receipts, and the old
  one must be voided by hand.
- ⚠️ "The same figures" compares the totals, not the lines: a reworded copy
  with the same totals is treated as a copy.

## Alternatives considered

- **Change the confirmed receipt in place:** breaks ADR-0029; the books would
  no longer show what was confirmed and when.
- **Void the old one by hand, then confirm the new one:** possible before this
  record, but two steps a person can forget halfway, and the void put the old
  original back in review as if it needed redoing.
- **Let an assistant decide it is an update:** an assistant only proposes; a
  person confirms, and this is a money decision.
