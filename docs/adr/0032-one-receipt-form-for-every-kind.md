# 0032. One receipt form for every kind of document: optional facts and checks that adapt

- **Status:** Accepted
- **Date:** 2026-11
- **Components:** [receipts](../components/receipts.md), [costs](../components/costs.md), [assistants](../components/assistants.md)

## Context

The receipt chain (cards P5-05a and P5-05b; [ADR-0027](0027-the-app-decides-the-business-and-checks-the-arithmetic.md),
[ADR-0029](0029-a-confirmed-receipt-is-final-and-a-mistake-is-voided.md)) was
built around a plain receipt: a subtotal, an HST, a few other charges, a total in
Canadian dollars. The card that built drafts listed what that model did not hold
well: a credit note (a negative total, or a positive one, with nothing to say it
was a credit), tax included in the price with no HST line, a deposit or fee that
is itself taxed, tobacco tax, an invoice in another currency (read as dollars), a
statement covering several invoices, a tip on a meal.

The owner was asked which of these the business gets. The answer (Nov 28): **"a
mix of everything"**, and not to choose a fixed path per kind. The two
businesses' books go to a bookkeeper; what a document adds to them must be
right whatever it is, and what the app does not know must be said, not guessed
([ADR-0004](0004-blank-is-not-zero.md)).

## Decision

1. **One form, one tool, one set of checks.** Four optional facts about the
   document, each blank when the document does not say, each set by a reader
   and correctable by a reviewer, none of which changes which fields the form
   shows: what it is (`receipt`, `invoice`, `credit_note`, `statement`,
   `other`); the currency code printed; whether prices include HST; and, for a
   document in another currency, the Canadian amount actually paid. Each extra
   charge gains a kind (`deposit`, `eco_fee`, `tobacco_tax`, `duty`,
   `delivery`, `tip`, `discount`, `other`) and a taxed mark. The only control
   that appears on a choice is the Canadian amount paid, offered when a
   currency other than CAD is given.
2. **The checks adapt and still only flag.** The HST check puts the charges
   marked taxed in its base; with tax inside the price it says what the HST
   would be at most (total × rate ÷ (100 + rate)) and passes, and flags an HST
   amount given as well; in another currency it is not checked, and says why.
   A sign that does not fit the kind (a credit note printed positive, a
   negative total on anything else) is flagged in words and never changed. A
   statement is always flagged. Another currency is flagged until the Canadian
   amount paid is known.
3. **One rule of what counts on the books**, a pure function
   (`countsOnBooks`) with a SQL twin the totals use, proven equal over a
   generated set: a receipt, invoice, other or unsaid kind in Canadian dollars
   counts as its total; **a credit note counts as minus its size, whatever
   sign is printed**; **a statement is kept on file and counts as nothing**;
   **a document in another currency counts as its Canadian amount paid**, and
   until that is known it waits, counted apart and named; a voided one counts
   as nothing. The totals line names everything left out, with its count.
4. **The Canadian amount paid may be added to a confirmed receipt, once.** It
   is the only thing that can ever be added to a confirmed receipt: blank to a
   value, by an admin or a manager, with who and when, audited. The database's
   final-receipt trigger allows exactly that change and refuses a second one,
   clearing it, and every other change. A wrong amount is fixed as any other
   mistake on the books: void and redo.
5. **What gives no cost is not observed.** The cost history is in Canadian
   dollars: a foreign document's lines, a statement's and a credit note's are
   not observed, and the confirm's cost summary says so and why.

## Consequences

- A plain receipt is stored, checked and counted exactly as before: the new
  columns are blank, a charge with no kind is stored as before, and the new
  checks are present only when they have something to say.
- The books' totals are no longer the sum of the printed totals: a reader of the
  totals must read the line of what was left out. The export card will follow the
  same function.
- A credit note printed positive is counted negative. If a supplier ever prints
  a positive credit note that is really a charge, the person must call it
  something else; the flag asks them.
- The four facts are four more controls on an already full review. On a phone
  they wrap into two rows near the totals.
- A foreign document's subtotal and HST are not in the Canadian sums: no HST is
  claimed from it (a foreign supplier rarely charges HST; one that does is a case
  the app does not yet hold, listed in the component page).

## Alternatives considered

- **A document-type switch that changes the form** (a wizard: "is this a credit
  note?", then a different set of fields). Rejected: the owner gets a mix and
  asked for no fixed path; a switch hides fields a document of that kind may
  still print, and makes a misclassified document lose its figures. One form
  with optional facts keeps every figure as printed.
- **Converting currency in the app** (a rate table, or a rate fetched on the
  day). Rejected: the books need what actually left the account, which a rate
  does not give (card fees, the bank's own rate, the day it settled). The person
  types it from the statement, once.
- **Refusing documents that do not fit** (a statement, a negative total, a
  foreign invoice). Rejected: a refusal loses the original's reading and sends
  the person around the app; a flag that asks, with a reason at confirm, keeps
  the record and the person's judgement.
- **Splitting tax out of a tax-included price automatically** (HST = total × 13
  ÷ 113). Rejected: it is right only when every line is taxed, which the app
  cannot know from a total; an HST claimed that was not paid is a tax error. The
  check says the most it could be, and nothing is stored.
- **Storing a credit note's amounts with the sign flipped.** Rejected: the
  original prints what it prints, and the stored row is checked against it;
  the sign is decided where it counts, in one function.
