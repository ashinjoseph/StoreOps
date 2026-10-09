# 0011. Commissions are proposed, then approved by a person

- **Status:** Accepted
- **Date:** 2026-05 (Batch 3)
- **Components:** [commissions](../components/commissions.md), [payroll](../components/payroll.md)

## Context

Commission rules are written by people and can be wrong: a misplaced decimal,
a rule left active after someone leaves, a threshold for the wrong till. Money
paid out is hard to get back from staff.

## Decision

The weekly engine only ever **proposes** (`status = proposed`). A payroll admin
or admin **approves** (→ `pending`, payable) or **cancels** each one.
`Payments.payBonus` refuses anything not `pending` with "Approve it first".
Runs are **idempotent per week**: a second run for the same week is skipped
unless forced, and per-rule guards still prevent duplicate bonuses.

## Consequences

- ✅ A wrong rule costs one cancelled proposal, not a clawback.
- ✅ The Monday trigger is safe to leave installed.
- ⚠️ Someone has to approve weekly; an unapproved commission isn't owed yet,
  and My Pay shows it as pending.

## Alternatives considered

- **Auto-pay with a reversal flow:** the reversal is the hard part, and it
  involves a person anyway.
