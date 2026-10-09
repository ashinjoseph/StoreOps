# 0014. An append-only audit log; void, never delete

- **Status:** Accepted
- **Date:** 2026-05 (Batch 1); handovers 2026-08
- **Components:** all writes

## Context

The Sheet is editable by its owners, so the app can't stop a number being
changed. It can make every change made **through the app** attributable, and
make money records reviewable after the fact.

## Decision

- Every login attempt, payment, undo, handover, void, rule change, product
  change, hours adjustment and notification writes a row to `audit_log`:
  actor, action, target, before, after, details. Nothing in the app updates or
  deletes those rows.
- Money ledgers **void instead of deleting**: a handover is flipped to
  `voided` with who and when, and its allocations are released. The shopping
  list marks `ordered` or `removed`.
- `recorded_by` on a handover is permanent and shown on screen. That replaces
  a two-party confirmation flow.

## Consequences

- ✅ "Who changed this, and from what?" has an answer.
- ✅ A deleted row can't be reviewed; a voided one can.
- ⚠️ The log grows without bound. At this store's volume that's years before
  it matters; archiving would be a later ADR.
- ⚠️ Direct edits in the Sheet bypass it. That's a stated non-goal in the
  [threat model](../architecture/security.md#threat-model).

## Alternatives considered

- **Two-party confirmation for handovers:** doubles the taps for every
  handover to prevent a dispute the permanent `recorded_by` already settles.
