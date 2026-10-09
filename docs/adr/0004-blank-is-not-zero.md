# 0004. Blank is not zero

- **Status:** Accepted
- **Date:** 2026-09 (ePOS change); read side fixed 2026-10
- **Components:** [reconcile](../components/reconcile.md), [shifts and the close](../components/shifts-and-close.md), [public reports](../components/public-reports.md), [product master](../components/product-master.md)

## Context

Several figures can be **absent** rather than zero: a till that reports one
card total has no credit figure; a till with no Clover has no measured card
total; a product nobody has costed has no cost. `Number('') || 0` turns every
one of them into `0`, and a zero is a claim, such as "measured $0.00" or
"took nothing on credit". Comparing a claim against that zero produces a
variance the size of the whole figure.

This went wrong twice. Before the ePOS change was designed, a plan review found
the public report would publish cstore's entire card take as a daily loss. And
in October 2026, `Reconcile.getRecent_` was still reading blanks with `|| 0`,
so both the in-app history and the public report did exactly that.

## Decision

- **Write** absence as an empty cell (`blank_` in Reconcile; `''` for the
  unused card shape in Sales).
- **Read** it back as `null` (`numOrNull_`), never `0`.
- **Sums** may treat `null` as 0. Anything that **displays** a figure or
  **compares** two must branch on `null` and say *not verified* or *no cost
  recorded*.
- **Branch on whether the measurement exists**, not on a status string.

## Consequences

- ✅ "Not checked" and "checked and matched" can never look the same.
- ✅ History stays readable across a hardware change.
- ⚠️ Every new reader of these columns must handle `null`. Tests exercise the
  real read path through the sheet (`reconcile`), not a stub that already
  returns `null`, which is how the October bug passed for a month.

## Alternatives considered

- **Store 0 and a separate "measured?" flag:** two columns that can disagree,
  and every existing reader would still sum the zero.
- **Sentinel values (−1):** a sentinel ends up in a total eventually.
