# 0013. Every bonus records the rule that produced it

- **Status:** Accepted
- **Date:** 2026-09 (#23)
- **Components:** [commissions](../components/commissions.md)

## Context

A weekly **$120 management fee** had to be paid to one person every week,
whatever the sales. The engine only knew percentage rules, and its duplicate
guard asked "does this person already have a commission for this till this
week?" With a fee added, either the fee would block the sales commission or
the commission would block the fee.

## Decision

- Rules have a `rule_type`: `percentage` (the default when blank) or `fixed`,
  with `fixed_amount`. A fixed rule with a threshold above zero pays only when
  sales clear it.
- Every bonus records **`source_rule_id`** as well as `source_run_id`.
- **Guards by kind:** a fee asks only whether *this rule* has paid this week; a
  percentage rule is blocked only by rows from *other percentage rules*. A
  legacy row with no rule ID still blocks, as before. A deleted fee rule stops
  blocking anything.
- A rule that would pay nothing (fixed with no amount, percentage with no
  percentage) is refused at creation.

## Consequences

- ✅ A fee and a commission land side by side in the same week.
- ✅ "Which rule paid this?" has an answer for every new bonus.
- ⚠️ Two new columns on two tables, added by a migration.

## Alternatives considered

- **Add the fee by hand each week as an ad-hoc bonus:** forgettable, and
  "this should repeat weekly" was the requirement.
- **Mark fee bonuses with a different `type`:** would have blocked correctly
  but still couldn't say which of two fee rules paid.
