# 0001. Apps Script and a Google Sheet as the platform

- **Status:** Accepted
- **Date:** 2026-05
- **Components:** all; see [architecture overview](../architecture/overview.md)

## Context

One store with two tills and a small team. There's no hosting budget and no
one to run servers or patch a database. The owner already works in Google
Sheets and wants to be able to open the data, sort it, and hand it to an
accountant without asking anyone. Staff use their own phones.

## Decision

The whole system is one **Google Apps Script** project (V8) bound to one
**Google Sheet**. Each tab is a table, the web app is served by `doGet`, the
UI calls the server through `google.script.run`, and the code is deployed
from GitHub with `clasp`.

## Consequences

- ✅ Costs nothing to run, with nothing to patch and nothing to back up beyond
  Google's own version history.
- ✅ The data stays readable: the owner can inspect, filter and export any
  table.
- ✅ Auth for the deploying account, HTTPS, hosting and the trigger scheduler
  come with the platform.
- ⚠️ No transactions and no foreign keys. Consistency is the code's job, which
  is why IDs are deterministic where retries are likely and why allocation
  walks are tested.
- ⚠️ 6-minute execution limit and slow sheet calls. Bulk paths must batch
  ([0010](0010-bulk-import-reads-once-writes-once.md)), and read paths cache
  ([0016](0016-per-execution-caches-for-read-paths.md)).
- ⚠️ Anyone with edit access to the Sheet can change any number. The audit log
  ([0014](0014-append-only-audit-log.md)) is the mitigation.
- ⚠️ One global scope for all files. Every module is an IIFE that returns a
  small public object, and private helpers end in `_`.

## Alternatives considered

- **A hosted web app with Postgres** (Supabase, Firebase, etc.): better
  integrity and speed, but a monthly bill, credentials to manage, and data the
  owner can't open in a familiar tool.
- **Off-the-shelf POS add-ons:** none covered tills, lotto, payroll,
  commissions and cash handovers together, and each costs per seat.
