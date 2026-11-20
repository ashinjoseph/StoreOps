# 0020. Operations moves to its own app and database

- **Status:** Proposed (pending owner review of the migration plan)
- **Date:** 2026-11
- **Components:** all; see the [migration plan](../plans/2026-11-operations-app-migration.md)

## Context

[ADR-0001](0001-apps-script-and-sheets-as-the-platform.md) chose Apps Script
and a Google Sheet because they were free and the owner could open the data.
Six months of trading changed the picture:

- every request re-reads whole tabs, so the app slows as rows accumulate;
- nothing locks a payment or a handover, so two people acting at once could
  both allocate the same shift;
- secrets sit in a `config` tab that anyone with Sheet access can read;
- the app can't be installed on a phone, take a photo upload, or run a
  capped LLM call well;
- the shop now has a till platform on Postgres, moving to Cloudflare, that
  already records what staff re-type into the vape close.

The till carries audit and tax duties. Payroll, attendance and cash handovers
are internal. The two must not share a database.

## Decision

- StoreOps becomes the **Operations app**: a Cloudflare Worker serving the
  existing UI, over **its own Postgres database**, separate from the till's.
- **The `rpc*` contract is kept as it is.** The UI is moved unchanged; only
  the transport and the storage change. Old and new are compared RPC by RPC
  over the same data before the switch.
- **One table per tab, same column names**, with `NULL` for "not measured",
  foreign keys, and numbered SQL migrations in place of `Setup.gs`.
- **Money writes that allocate run in one transaction with a row lock.**
- **Secrets move to Worker secrets.** The `config` table keeps settings only.
- **The owner keeps a readable copy:** a nightly read-only export to a Sheet.
- The Sheet app stays read-only for 30 days after the switch as the way back.

## Consequences

- ✅ Read cost stops growing with history, and the double-allocation gap closes.
- ✅ Installable app, uploads, cron and capped LLM calls become possible.
- ✅ Every existing rule and ADR carries over; the tests carry over with them.
- ⚠️ No longer free: a database and a Worker plan have a monthly cost.
- ⚠️ The owner can no longer fix a number by editing a cell. Corrections go
  through the app, which is also what keeps the audit log complete.
- ⚠️ A migration of all history, with a dry run and a reconcile, before the
  switch.
- ⚠️ Supersedes ADR-0001 once the switch has happened, not before.

## Alternatives considered

- **Stay on Sheets and archive old rows:** buys months, fixes none of the
  other limits. Kept as a quick win, not as the answer.
- **Put Operations' tables in the till's database:** least work, and it puts
  payroll inside the system with tax duties and ties Operations to the till's
  schema.
- **A native app over Sheets:** rewrites the UI and keeps the slow part.
- **Rewrite from scratch:** discards the rules and tests that six months of
  incidents paid for.
