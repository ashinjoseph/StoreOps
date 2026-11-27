# 0027. A reader reports what is printed; the app decides the business and checks the arithmetic

- **Status:** Accepted
- **Date:** 2026-11
- **Components:** [receipts](../components/receipts.md), [assistants](../components/assistants.md)

## Context

Card P5-05a turns a receipt original into figures: supplier, invoice number,
date, subtotal, HST, total, lines. The figures are read by an AI assistant
through the MCP door ([ADR-0025](0025-assistants-come-in-through-mcp-and-only-propose.md))
or typed by a person. They will become the books of two separate companies
(cstore and vape, separate HST numbers, separate QuickBooks files), so two
things must never go wrong silently:

- **A receipt filed under the wrong business.** Its tax would be claimed by
  the wrong company, and nothing downstream could tell.
- **Figures that do not add up, or a tax figure that was invented.** A model
  that cannot read a smudged line tends to produce a plausible number rather
  than nothing. An HST of `0` and an HST that is not printed are different
  facts ([ADR-0004](0004-blank-is-not-zero.md)).

The assistant reads well but is not accountable, and a document can carry text
written to steer it. The app has no model of its own (P5-04 postponed; ADR-0022
stays an option).

## Decision

1. **The reader reports what is printed; it decides nothing.** The input is
   what the document says, including what it says about the BUYER: the name
   printed as sold to or billed to, the buyer's HST number, an account or
   membership number, the last four digits of the card paid with. A field the
   document does not print is left out and stored as NULL. A reader may add a
   guess at the business; it is stored as a suggestion and decides nothing.
2. **The app decides the business from the live signs** of the Businesses
   card, compared in its normal form: one business matched by one or more
   signs is that business, and the draft records which kinds of sign decided
   it and the signs themselves; signs pointing at both businesses are a
   `conflict`; nothing matched is `not_known`. A business a person set at
   upload is kept beside as "a person said", never as the decision, and a
   disagreement is flagged. The supplier is never used to guess.
3. **The app checks the arithmetic, exactly, and flags; it does not refuse.**
   Money is integer cents parsed from the reader's own spelling (two decimals
   at most; a line's unit price alone may have four, as fuel and wholesale
   prices are printed, and nothing is computed from it); the checks are lines to subtotal, parts to total (to the cent),
   HST against the rate setting (within 2 cents), the date (a real day, not in
   the future, not more than 7 years old), duplicates across both businesses,
   the supplier's HST number's shape, and the business. A draft that fails any
   is kept and marked *needs attention*, each failure a sentence with the
   numbers. Only what is no draft at all is refused (no such original, one set
   aside, one a person is working on, no total, an amount that is not money,
   more than 300 lines, text over its limit), and a refusal writes nothing.
4. **A draft counts for nothing until a person confirms it** (the next card).
   Its figures never change once written: a new reading supersedes it (kept,
   linked both ways); a reading by a person is never replaced by a proposal.

## Consequences

- ✅ The business of every receipt can be traced to the printed evidence and
  the signs it matched, or it says plainly that it is not known.
- ✅ A misreading shows up as a sentence a reader can act on: the assistant is
  answered each check, can look again once and propose a correction.
- ✅ The checks are pure functions over integers: the next card reruns them
  when a person edits, and a test can pin every tolerance.
- ⚠️ A receipt from a new card, a new trading name or a new account is "not
  known" until an admin adds the sign. That is deliberate: a month of drafts
  shows which signs are worth adding.
- ⚠️ The checks are Ontario-shaped: one HST rate, tax on top of the price.
  Receipts that are not (tax included in the price, a credit note) need a
  person, and are questions for the owner and the bookkeeper
  ([receipts](../components/receipts.md#what-the-model-cannot-hold-yet)).
- ⚠️ A draft with every check failing is still kept: the review screen must
  make *needs attention* impossible to miss.

## Alternatives considered

- **Let the reader choose the business.** Simplest, and usually right. But
  the reader is the part that can be misled by the document, and a wrong
  business is the one mistake the books cannot detect later. The reader's
  guess is kept as a suggestion so the two can be compared.
- **Refuse a draft that fails a check.** It would push an assistant to adjust
  figures until they add up, which is exactly the invented number to avoid; a
  real receipt that does not add up (a printing error, a rounding rule) could
  then never be filed. Flagging keeps what was read and says what is wrong.
- **A model run by the app to check the model.** Two readings that agree are
  not evidence of a third fact; arithmetic is. It also costs money per receipt
  and brings back the gateway that P5-04 postponed.
- **Guess the business from the supplier** ("this wholesaler only sells to
  vape"). Often true, sometimes not, and silent when wrong. If it proves
  reliable, it can become a sign a person adds, recorded and visible.
