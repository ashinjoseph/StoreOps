# 0005. Card shapes are mutually exclusive columns; schema changes append

- **Status:** Accepted
- **Date:** 2026-09 (#12)
- **Components:** [shifts and the close](../components/shifts-and-close.md), [sales dashboard](../components/sales-dashboard.md), [data model](../architecture/data-model.md)

## Context

cstore moved to an ePOS that reports **one card total** with no credit/debit
split. 262 rows of history had the split. Writing the single total into
`credit_card_sales` was the one-line change, and would have made every report
say "Credit $1,240 · Debit $0", a false statement that makes old and new
rows indistinguishable.

## Decision

- **Add columns:** `card_total_sales` and `misc_card_sales`. Never repurpose or
  reorder existing ones; a migration appends, and is safe to run twice.
- **One shape per row.** A row fills either credit + debit **or** card total,
  never both, so
  `total = cash + credit + debit + card_total + misc` is right on both sides of
  the change **with no date logic**.
- Which shape a till uses is config (`<company>_card_split`, default `true`);
  each row's own shape is derived from the row, never from today's config.

## Consequences

- ✅ Totals are continuous across the change, and a third till needs no code.
- ✅ Old rows keep their meaning.
- ⚠️ Any analysis must sum all three card columns. Reading only credit + debit
  undercounts every ePOS day and looks like a decline, not a bug.
- ⚠️ The credit/debit **mix** for a single-total till doesn't exist in the
  data after the change date.

## Alternatives considered

- **Reuse `credit_card_sales` for the total:** false reports, ambiguous
  history.
- **Date-based logic** ("after `cstore_epos_from`, read column X"): every
  reader carries a date check forever, and the next change adds another.
