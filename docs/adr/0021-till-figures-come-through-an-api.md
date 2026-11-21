# 0021. Till figures come through an API, and Operations keeps its own snapshot

- **Status:** Proposed (pending owner review of the migration plan)
- **Date:** 2026-11
- **Components:** [shifts and the close](../components/shifts-and-close.md), [reconcile](../components/reconcile.md), [app shell and auth](../components/app-shell-and-auth.md)

## Context

The till platform already records, per shift, the float, cash sales, counted
cash, variance and takings by payment method. Operations needs those figures
for the vape close, reconciliation and commissions, and could share the
till's staff list. There are two ways to get them: read the till's
database directly, or call an API the till exposes.

The till has audit and tax responsibilities and its schema changes often.

## Decision

- Operations reads the till **only through a versioned, read-only API** with
  a scoped key: stores, staff directory, shifts with cash-up, daily sales.
  The agreed contract is `ops/contracts/till-api.v1.yaml`.
  It never holds credentials for the till's database.
- **Operations stores what it fetched as a snapshot**, with the time fetched.
  Pay and commissions are computed from the snapshot.
- **A later difference between the till and a snapshot is flagged, never
  applied automatically.** A person decides.
- **Operations signs everyone in with its own PINs.** Till PINs are never
  copied or checked from outside: the till checks them on the till PC so it
  works offline, and an internet-facing check of a short PIN could be
  guessed through.
- **Anything Operations sends to the till is a proposal** for someone to
  approve in the Office, sent only when a person presses a button: a
  supplier delivery, with stock and cost together, for example.
- **Manual entry remains** for when the API is unreachable, and for the
  cstore ePOS, which has no integration.

## Consequences

- ✅ What "net sales" or "expected cash" means is defined once, by the till.
- ✅ The till can change its tables without breaking Operations.
- ✅ Pay doesn't move when the till is corrected after the fact; the
  difference is visible instead.
- ✅ Operations can't write to tax records, by construction.
- ⚠️ Six endpoints must be built and kept on the till side.
- ⚠️ A person may have two PINs, one for the till and one for Operations.
- ⚠️ Operations depends on the till being reachable at close; hence the
  manual path.
- ⚠️ Two staff lists must be linked: an Operations person optionally points
  at a till staff id.

## Alternatives considered

- **Read the till's database directly:** no endpoints to build, and every
  till migration can break Operations, definitions drift, and Operations
  holds credentials inside the tax system.
- **Read-only database views as the contract:** less work than an API and
  still database credentials in the wrong place.
- **Copy PIN hashes into Operations:** two places to leak from and two
  lockout counters to keep in step.
- **A PIN check endpoint on the till:** proposed in the request; declined by
  the till side, because a 4–6 digit PIN behind an internet-facing endpoint
  can be guessed, and the till's lockout lives on the till PC.
