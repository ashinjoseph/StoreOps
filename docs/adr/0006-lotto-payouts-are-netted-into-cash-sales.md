# 0006. Lotto payouts are netted into cash sales

- **Status:** Accepted
- **Date:** 2026-08 (#10, #11)
- **Components:** [shifts and the close](../components/shifts-and-close.md)

## Context

A big lottery win paid at the counter is cash leaving the drawer. The close
sheet had nowhere to put it: `cash_sales` refused a negative, so a shift that
sold $200 and paid out $500 couldn't be recorded at all, and the reserve,
counted separately, reported a shortfall for the same money.

## Decision

Net the payout into **cash sales**: that shift enters −$300. `cash_sales` may
go negative **on cstore only**, in that one field. Every other money input
still strips a minus, and the server rejects a negative on vape. A **−**
button sits beside the field because phone number pads have no minus key.

## Consequences

- ✅ The drawer reconciles on payout days.
- ✅ It doesn't matter which pot paid the customer: the arithmetic cancels
  out (see [0008](0008-lotto-reserve-is-derived-from-two-counts.md)).
- ⚠️ Sales figures take the hit on payout days. A day can show negative cash
  sales. Heavy payouts are occasional, so this was accepted knowingly.

## Alternatives considered

- **A separate "payouts" field:** one more number to type and to get wrong,
  plus a column that every report would have to subtract.
- **Require payouts to come from the reserve only:** unenforceable at the
  counter, and unnecessary once the reserve is derived from counts.
