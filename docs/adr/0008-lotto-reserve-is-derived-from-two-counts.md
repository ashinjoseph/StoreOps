# 0008. What the lotto pot fed the drawer is derived from two counts

- **Status:** Accepted
- **Date:** 2026-08 (#10, #13)
- **Components:** [shifts and the close](../components/shifts-and-close.md)

## Context

cstore keeps a cash **reserve pot** that pays lottery winners and is topped up
from the drawer. When the pot pays a winner, the drawer's expected cash changes.
Asking the cashier "how much did the pot feed the drawer?" is one more number
typed under pressure.

## Decision

The pot is **counted** at every close, and its contribution is derived:

```
reserve_at_start = previous.lotto_reserve_counted + previous.lotto_topup_from_till
reserve_fed      = reserve_at_start − this.lotto_reserve_counted
expected_cash    = float + cash_sales + misc_cash − cashback + reserve_fed
```

A count that differs from the last one needs a reason, which is shown on the
7-day report.

## Consequences

- ✅ No new input, and the figure is measured rather than declared, so it
  cross-checks itself against a physical count.
- ✅ Source-agnostic: whether the pot or the drawer paid the customer, the
  drawer reconciles.
- ⚠️ The `+ topup` term carries weight. The pot is counted *before* a top-up, so
  reading the last count alone understated the start by exactly the top-up.
  That was a real defect (#13), now covered by `lotto-payout`.

## Alternatives considered

- **Type "paid from reserve":** a number nobody can check, and wrong
  whenever the cashier misremembers.
- **Keep the pot outside the close entirely:** then a payout shows up as a
  drawer shortage with no explanation.
