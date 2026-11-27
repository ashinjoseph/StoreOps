# Operations app migration — task cards

> **Status: draft for owner review.** Read
> [the plan](2026-11-operations-app-migration.md) first: section 5 explains
> the roles, the tiers, the worker rules and the parity oracle these cards
> rely on.

**For the orchestrator:** hand a worker one card plus the worker rules from
the plan, nothing else. A card may start when every card under **Needs** is
`done`. Cards flagged *money* or *security* get a T3 review of the diff.

**For a worker:** you were given one card. Do that card only.

Cards marked `dropped` cover areas the owner deprecated (plan section 2,
"Not migrated"). Their IDs stay so other cards' references don't move; never
hand one out.

## Ledger

| ID | Card | Tier | Needs | Flags | Status |
|---|---|:-:|---|---|---|
| P0-01 | Owner answers decisions D1–D12 | owner | | | done (go-ahead Nov 26; unanswered rows use their defaults) |
| P0-02 | Till API contract v1, from the owner | owner + T3 review | | security | done (1.1.0) |
| P0-03 | Database schema contract | T3 | P0-01 | money | done |
| P0-04 | RPC contract file | T1 | | | done |
| P1-01 | Archive old audit-log rows (current app) | T2 | | | todo |
| P1-02 | Till API built (till repository) | owner | P0-02 | security | staging done and checked (Nov 23); production key to come |
| P1-03 | Vape close prefilled from the till (current app) | T2 | P1-02 | money | todo |
| P1-04 | Till API retrieval check against staging | T1 | P0-02, P2-01 | security | built and tested on fixtures; a run against staging is still to do |
| P2-01 | Scaffold `ops/` and its CI | T1 | P0-01 | | done |
| P2-02 | Migrations runner and first migration | T1 | P2-01, P0-03 | | done |
| P2-03a | Money, date and ID helpers | T2 | P2-01 | money | done |
| P2-03b | Database client and transactions | T2 | P2-02 | money | done |
| P2-04 | Audit log writer | T1 | P2-03b | | done |
| P2-04b | Audit log and payments keep the order rows were written in | T1 | P3-09b (migration number) | | done |
| P2-05 | Config and secrets access | T1 | P2-03b | security | done |
| P2-06 | Login, sessions, lockout, roles | T2 | P2-04, P2-05 | security | done |
| P2-07 | RPC router | T2 | P2-05, P0-04 | security | done |
| P2-08a | UI copy and the new transport | T2 | P2-01 | | done |
| P2-08b | UI served by the Worker; login round-trips | T2 | P2-08a, P2-07 | | done (the login screen's name list comes with P3-01) |
| P2-09a | Sheet rows into the new database (fixture loader) | T2 | P2-02 | money | done |
| P2-09 | Parity harness | T3 | P2-07, P2-09a | | done |
| P2-09b | Parity fixture: a payroll admin and an inactive person | T2 | P2-09 | | done |
| P2-10 | Staging deploy | T2 | P2-08b | security | todo (staging runs locally for now; the hosted rehearsal is still needed before production) |
| P3-01 | Port Staff | T1 | P2-09 | | done |
| P3-02 | ~~Port ProductTypes and ProductMaster~~ | | | | dropped |
| P3-03 | ~~Product import by CSV upload~~ | | | | dropped |
| P3-04 | ~~Port ShoppingList~~ | | | | dropped |
| P3-05a | Port Attendance: schedule, hours, who am I | T2 | P3-01 | money | done |
| P3-05b | Port the open and the close: TillSessions, Sales | T3 | P3-05a, P3-08 | money | done |
| P3-05c | Port the shift state and bootstrap reads | T2 | P3-05b, P3-06 | money | done |
| P3-06 | Port CashHandling | T2 | P3-05b | money | done |
| P3-07 | Port Clover and Reconcile | T2 | P3-06, P3-08 | money | done |
| P3-07b | Give a reconcile a time budget | T1 | P3-07 | money | done |
| P3-08 | Port Notifier (WhatsApp) | T2 | P2-09 | security | done |
| P3-09a | Port Bonuses | T2 | P3-05a | money | done |
| P3-09b | Port Payments (pay, undo, owed, history) | T3 | P3-09a, P3-08 | money | done (undo is a void; the owner has still to confirm that) |
| P3-10a | Port CommissionRules | T2 | P3-09a | money | done |
| P3-10b | Port the commission engine and the weekly cron | T2 | P3-10a, P3-05b | money | done |
| P3-11 | Port the sales dashboard and insights | T2 | P3-05b | | done |
| P3-12 | Port PublicReport and the public pages | T2 | P3-07, P3-11 | security | done |
| P4-01 | Sheet export tool | T2 | P0-03 | | done (not yet run on a real download) |
| P4-02 | Import tool with a rejects file | T2 | P4-01, P2-02 | money | done (not yet run on real data) |
| P4-03 | Reconcile report: Sheet against database | T2 | P4-02 | money | done (not yet run on real data) |
| P4-04 | Dry run on a copy of production | T3 + owner | P3-12, P4-03 | money | todo |
| P4-05 | Cutover runbook, then the switch | T3 + owner | P4-04, P4-09, P4-10 | money | todo |
| P4-06 | Nightly export to a Google Sheet | T2 | P4-05 | | todo |
| P4-07 | Retire the Apps Script deploy | T1 | P4-05 + 30 days | | todo |
| P4-08 | The new app's own RPCs and screens: where they are listed, how they are hidden in Apps Script | T1 | P3-12 | security | done |
| P4-09 | Settings screen: an admin edits the settings | T2 | P4-08 | security | done (four things for the owner, in the card) |
| P4-10 | Schedule corrections after the fact | T3 | P4-08 | money | done (the owner confirmed its three rules, Nov 27) |
| P4-11 | Staff screen: add, change, deactivate, PINs, raises | T3 | P4-08 | security, money | done (one thing for the owner, in the card) |
| P4-11b | A day worked with no rate shows as "no rate set", not $0 | T2 | P4-11 | money | todo (changes what a ported call answers: the owner to agree) |
| P4-12a | Correct a closed till | T3 | P4-08 | money | done (three things for the owner, in the card) |
| P4-12b | Enter a shift that was never put in the app | T3 | P4-12a | money | todo |
| P4-12c | Reconcile a past day again | T2 | P4-08 | money | todo |
| P4-13 | Audit log on a screen; a setting to pause the Monday run | T1 | P4-09 | security | todo (planned) |
| P4-14 | Backups, and a restore that has been tried | T2 + owner | P2-10 | money | todo (planned) |
| P5-01 | Stores and staff assignments | T2 | P4-05 | security | todo |
| P5-02a | Till link: the client and a fake till (switched off) | T2 | | security | done (nine questions for the till side, in the card) |
| P5-02b | Till link: people and stores matched, key expiry | T2 | P5-02a, P4-11 | security | todo |
| P5-03 | Vape close from the till snapshot | T2 | P5-02b, P4-05 | money | todo (goes live only after the switch has settled) |
| P5-03b | Sales by channel: in store, online, delivery | T2 | P5-02a | | todo |
| P5-04 | LLM gateway: free model first, Claude behind a flag | T2 | P4-05 | security | postponed (the owner, Nov 27: assistants through MCP first) |
| P5-05 | Purchase receipts, supplier records and product costs | T2 | P5-12 | money | todo (the draft now comes through MCP) |
| P5-06 | Receipt test set through each assistant | T2 + owner | P5-05 | | todo |
| P5-07 | Delivery runs: spec first, then build | T3 | P5-02a | | spec drafted, with the owner (eight questions; needs new calls from the till side) |
| P5-08 | Send a vape delivery to the till, on a button | T2 | P5-05, P1-02 | money | todo |
| P5-09 | Bookkeeping export of receipts, per business, in QuickBooks's layout | T2 | P5-05 | money | todo |
| P5-10 | Trial with Muse: can it hand over an original, and how does it connect | T2 + owner | P2-10 | security | todo (needs a public address: the hosted setup) |
| P5-11 | The MCP door: keys, read and propose rights, limits, audit | T3 | | security | todo |
| P5-12 | The two businesses and the receipt inbox (originals kept) | T2 | P5-11 | money | todo |
| P5-13 | Emailed invoices through the assistant | T2 | P5-05 | security | todo |
| P5-14 | Delivery planning tools for an assistant | T2 | P5-07, P5-11 | | todo |
| P5-15 | Cost history from receipt lines, and price-rise flags for a manager | T2 | P5-05 | money | todo |
| P5-16 | The old purchase list brought in as history | T1 | P5-12 | money | todo |
| P6-01 | Installable web app | T2 | P4-05 | | todo |
| P6-02 | Store listings: decide | owner | P6-01 | | todo |

## Layout the cards assume

```
ops/
  package.json  tsconfig.json  wrangler.toml  vitest.config.ts
  contracts/    rpc.json  schema.sql  till-api.v1.yaml      (frozen: workers never edit)
  migrations/   0001_init.sql, 0002_…sql                    (append only)
  src/
    index.ts    Worker entry: router, static files, cron
    lib/        money.ts  dates.ts  ids.ts  audit.ts  config.ts
    db/         client.ts  tx.ts
    auth/       login.ts  sessions.ts  roles.ts
    modules/    one file per ported module
    rpc/        one file per area; registers its rpc handlers
    till/       client for the till API
    llm/        gateway, providers, validators
  public/       Index.html  transport.js  public page templates
  test/         unit tests
  parity/       harness and the list of RPCs covered
  tools/        export, import, reconcile
```

Commands the cards use:

| Command | Checks |
|---|---|
| `npm --prefix ops run typecheck` | TypeScript compiles |
| `npm --prefix ops test` | Unit tests of the new app |
| `npm --prefix ops run parity -- <rpc names>` | Old and new return the same for those RPCs |
| `npm test` | The current app's suites and the docs guard still pass |

---

## Phase 0 — Contracts

### P0-01 · Owner answers decisions D1–D12 · owner
**Make:** the table in section 3 of the plan, edited to show each answer.
**Done when:** every row has an answer, and the three questions under it too.

### P0-02 · Till API contract v1, from the owner · owner + T3 review · security
The owner builds the till side from
[the till API request](2026-11-till-api-for-operations.md) and shares the
till's OpenAPI file.
**Make:** that file, copied to `ops/contracts/till-api.v1.yaml` unchanged.
**Done when:** a T3 review confirms every field in the request is present
with the stated meaning (or lists the differences for the owner), and the
file passes an OpenAPI linter.

### P0-03 · Database schema contract · T3 · money
**Read:** `docs/reference/schema.md`; `docs/architecture/data-model.md`;
ADRs 0004, 0005, 0013, 0014; decisions D2 and D4.
**Make:** `ops/contracts/schema.sql`: one table per data tab, same column
names, all in schema `ops`, plus the `ops_app` role with rights on `ops`
only. Rules:
- money `numeric(12,2)`; dates `date`; moments `timestamptz`;
- a column that can be "not measured" is nullable and has no default;
- existing text IDs stay as primary keys, so the import is lossless;
- foreign keys for every relation in the data model;
- new tables: `stores`, `staff_stores`, `sessions`, `login_failures`;
- every operational table gets `store_id`, defaulting to the one store;
- `audit_log` can be inserted into, never updated or deleted;
- the deprecated tabs are left out: `product_master`, the three
  `product_*_detail` tabs, the `_pm_*_staging` tabs, `suppliers`,
  `order_catalog`, `shopping_list`, `pos_extracted`, `clover_batches`
  (plan section 2, "Not migrated").
**Done when:** the file loads into an empty Postgres with no errors, and
every column in `schema.md` is either present or listed in a "left out, and
why" comment at the top.

### P0-04 · RPC contract file · T1
**Read:** `scripts/docs/codemap.js` (it already parses every RPC).
**Make:** `scripts/docs/rpc-contract.js`, `ops/contracts/rpc.json`: for each
RPC its name, parameter names, allowed roles, whether it needs a session, and
`"migrate": false` for the 21 whose module is deprecated (`ProductMaster`,
`ProductTypes`, `ShoppingList`, `Suppliers`, `OrderCatalog` in the code map's
module column).
**Done when:** the file lists all 62 RPCs, 41 to migrate and 21 not, and
matches the RPC table in `docs/reference/code-map.md`; `npm test` passes.

## Phase 1 — Quick wins on the current app

### P1-01 · Archive old audit-log rows · T2
**Read:** `src/AuditLog.gs`; `src/Setup.gs` (`onOpen` only); ADR-0014.
**Make:** a menu item that moves `audit_log` rows older than a configurable
number of months to an `audit_log_archive` tab, in one read and one write.
Rows are moved, never deleted. Tests in `tests/suites/`.
**Done when:** `npm test` passes; the new assertions were seen failing first;
the docs steps in `AGENTS.md` are done.
**Don't:** change how audit rows are written.

### P1-02 · Till API built · owner · security
Lives in the till platform's repository; built by the owner. Implements
`ops/contracts/till-api.v1.yaml`. A staging key, on invented data, comes
first; then a production key.
**Done when:** the check at the end of the till API request passes for one
real closed day.

### P1-03 · Vape close prefilled from the till · T2 · money
Only if D9 says yes. On the current Apps Script app.
**Read:** `src/Clover.gs` (the pattern to copy: never throws, returns
`{ok:false,error}`); `src/TillSessions.gs` (`close_`); `src/Index.html`
function `openShiftForm`; `docs/components/shifts-and-close.md`.
**Make:** `src/TillApi.gs`; a config flag `till_api_enabled`, default off;
the vape close sheet shows the till's figures prefilled and editable, with a
note of where they came from. Takings are the `*_total` fields of
`takings`. The till's `expected` includes `door_cash`; show door cash as its
own line so the cashier sees why expected is higher.
**Done when:** with the flag off nothing changes (existing suites pass
untouched); with it on and the API failing, the close still works by hand;
`npm test` passes with new assertions seen failing first.

### P1-04 · Till API retrieval check against staging · T1 · security
**Read:** `ops/contracts/till-api.v1.yaml`; `docs/plans/2026-11-ops-local-database.md`
("The till, while building").
**Make:** `ops/tools/till-check.ts`: with `TILL_API_BASE_URL` and
`TILL_API_KEY` from the environment, call every `GET` in the contract
(stores; then for each store: staff, shifts for yesterday, sales for the
last 7 days, products, suppliers and open orders); validate each answer against the contract's schemas; print counts
and any schema differences. Never print the key. Never call `POST`.
**Done when:** against the till's staging it reports every endpoint
answering and matching the contract, or lists each difference for the owner;
pointing it at another staging is a change of `TILL_API_BASE_URL` only; a
test with a faked `fetch` shows a missing required field is reported.

## Phase 2 — Foundation

### P2-01 · Scaffold `ops/` and its CI · T1
**Read:** `.github/workflows/ci.yml`, `deploy.yml`, `test-deploy.yml`.
**Make:** the `ops/` layout above with an empty Worker that answers
`GET /health`; a typecheck, a test runner with one passing test; a CI job
that runs both, with a Postgres service container as in
`docs/plans/2026-11-ops-local-database.md`. Add `paths: ['src/**']` to the
two deploy workflows so changes under `ops/` or `docs/` no longer push the
current app.
**Done when:** `npm --prefix ops run typecheck` and `npm --prefix ops test`
pass; `npm test` passes; CI is green.
**Don't:** add a framework beyond a small router; add any paid service.

### P2-02 · Migrations runner and first migration · T1
**Read:** `ops/contracts/schema.sql`; `docs/plans/2026-11-ops-local-database.md`.
**Make:** `ops/db/compose.yml`, `ops/db/init/01-roles.sh`, `ops/.env.example`
and the `db:*` commands, as in the spec; `ops/migrations/0001_init.sql` (the
contract, verbatim); `ops/src/db/migrate.ts` that applies numbered files once
each, in order, as `ops_owner`, and records them; a test helper that gives
each test file its own database copied from a migrated `ops_template`.
**Done when:** the checks at the end of the spec pass locally and in CI;
`db:reset` twice in a row gives no error and every table from the contract.

### P2-03a · Money, date and ID helpers · T2 · money
Split from P2-03 (Nov 26) so it can run before the database exists.
**Read:** `src/Util.gs`; ADR-0004.
**Make:** `ops/src/lib/money.ts`, `dates.ts`, `ids.ts`: the same functions
as `Util.gs`, same names where sensible.
**Done when:** unit tests cover every exported function of `Util.gs` with the
same inputs and outputs, checked against the real `Util.gs` loaded in the
test, including rounding at half cents, the Toronto business day across
midnight and across a clock change, and both ID styles.

### P2-03b · Database client and transactions · T2 · money
**Read:** `docs/plans/2026-11-ops-local-database.md`.
**Make:** `ops/src/db/client.ts`, `ops/src/db/tx.ts` (run a function in one
transaction; lock a row for update). `numeric` comes back as a string from
the driver: convert at this boundary, `NULL` stays `null`.
**Done when:** tests show a rolled-back transaction leaves no row; two
connections locking the same row, the second waits; a `NULL` money column
reads as `null`, never 0.

### P2-04 · Audit log writer · T1
**Read:** `src/AuditLog.gs`; ADR-0014.
**Make:** `ops/src/lib/audit.ts` with `write({actorId, action, targetType,
targetId, before, after, details})`, usable inside a transaction.
**Done when:** tests show a row is written; an update or delete on
`audit_log` is refused by the database.

### P2-04b · Audit log and payments keep the order rows were written in · T1
Found Nov 26: the Sheet kept audit rows in the order they were appended. The
new table has no such order: rows written in the same second sort by a random
id suffix, so "what happened first" within one change can't be told (a test
that assumed otherwise failed one run in three).
**Make:** a migration adding `seq bigint generated always as identity` to
`ops.audit_log`; `audit.recent` and anything else that lists audit rows
orders by it; the parity harness lists `audit_log.seq` as a new-only column;
tests that read audit rows order by it.
**Done when:** a test writes 1,000 rows in one statement and in ten
transactions and reads them back in exactly the order written; parity and
the suites pass.
**Done (Nov 26):** migration `0004_written_order.sql` adds `seq` to
`audit_log` and to `payments` (the Payments port had ordered same-second
payments by Postgres's internal row position, which a dump and restore, such
as the move to Supabase, would not keep). The log reader returns the newest
rows by `seq`, as the Sheet's last rows read upwards.

### P2-05 · Config and secrets access · T1 · security
**Read:** `docs/reference/schema.md` (the config section).
**Make:** `ops/src/lib/config.ts`: non-secret settings from the `config`
table with the same keys and defaults as today; secrets (anything ending
`_token` or `_key`) from Worker secrets only, never from the table.
**Done when:** tests show a blank value falls back to its default, and asking
the table for a secret key throws.

### P2-06 · Login, sessions, lockout, roles · T2 · security
**Read:** `src/Auth.gs`; `src/Staff.gs` (`verifyLoginCode_`);
`docs/architecture/security.md`; ADR-0002; `tests/suites/rpc-guards.js`.
**Make:** `ops/src/auth/login.ts`, `sessions.ts`, `roles.ts`: same rules as
today. Store a hash of the token, not the token. PINs are stored hashed:
the contract has no PIN column, so this card adds one by migration
(`staff.pin_hash`, a slow salted hash; never the PIN).
**RPCs:** `rpcLogin`, `rpcLogout` (parity is added for these in P3-01, once
the harness exists).
**Done when:** tests cover: right PIN, wrong PIN and unknown name give the
same message; lockout after the configured failures and release after the
window; rolling renewal past half-life; logout; `requireRole` refusing a
wrong role; a role sent by the client being ignored.

### P2-07 · RPC router · T2 · security
**Read:** `ops/contracts/rpc.json`; `src/WebApp.gs` lines for `_session` and
three sample RPCs.
**Wire format (fixed; P2-08a's transport speaks it):** `POST /rpc/<name>`,
JSON body `{"args": [...]}` with the arguments exactly as the page passed
them (the session token first, where the RPC takes one). Answer:
`{"ok": true, "result": …}` (an undefined result is `null`), or
`{"ok": false, "error": {"message": "…"}}` where the message is the thrown
error's message, as `google.script.run`'s failure handler gets it today. A
thrown RPC error is HTTP 200; a bad body is 400; an unknown name is 404; an
RPC marked `migrate: false` in the contract is 404 with message
`NOT_MIGRATED`.
**Make:** `ops/src/rpc/router.ts`: that endpoint; looks the name up in the contract; applies the session and role
rule from the contract before calling the handler; maps `NOT_LOGGED_IN` and
`FORBIDDEN` to the same error text the UI checks for today. An RPC with no
handler yet answers "not ported".
**Done when:** tests show a role-restricted RPC refuses the wrong role from
the contract alone, with no handler code involved; an unknown name is a 404;
dates in results arrive as ISO strings.

### P2-08a · UI copy and the new transport · T2
Split from P2-08 (Nov 26) so it can run before the router exists.
**Read:** `scripts/docs/screenshots.js` (its `google.script.run` shim);
in `src/Index.html` only the functions `call`, `cachedCall`, `handleRpcError`;
`doGet` in `src/WebApp.gs` (what the template is given).
**Make:** `ops/public/transport.js` giving the page a `google.script.run`
that speaks P2-07's wire format; a build step, runnable with Node built-ins
only, that writes the page for the Worker from `src/Index.html`, unchanged
apart from loading the transport, resolving the template tags, and removing
the `shopping`, `suppliers` and `products` entries from `MORE_ITEMS`; the UI
suites (`tests/suites/ui-*.js`, except `ui-picker` and `ui-products`) run
against the built copy as well. The built page is generated, not committed.
**Done when:** the UI suites pass against both copies; the built page's
drawer has no Shopping List, Suppliers or Product Master entry; tests with a
faked `fetch` show success, a thrown RPC error, a 404 and a network failure
each reach the right handler.

### P2-08b · UI served by the Worker; login round-trips · T2
**Make:** the Worker serves the built page at `/` and its static files.
**Done when:** the login screen loads from the Worker locally and a login
round-trips through `/rpc/rpcLogin`.

### P2-09a · Sheet rows into the new database · T2 · money
Added Nov 26: the part of the parity harness that doesn't need the router,
and the same translation the production import (P4-02) will use.
**Make:** `ops/src/import/sheet-to-db.ts` (Sheet cells to contract rows, by
header name; blank stays `NULL`; a row that doesn't fit is a reject with its
tab, row and column but never its value); `ops/src/import/load.ts`;
`ops/test/helpers/fixture.ts` (`loadFixture(db)`: the old runtime's fictional
data, loaded into a test database).
**Done when:** the whole fixture loads with zero rejects; per table, row
counts match the Sheet; per money column, sums match to the cent and blank
counts equal `NULL` counts; a tampered fixture gives exactly the planted
rejects.

### P2-09 · Parity harness · T3
**Read:** `scripts/docs/runtime.js`, `scripts/docs/fixtures.js`; plan
section 5, "The oracle".
**Make:** `ops/parity/`: freeze the clock for both sides; seed the old
runtime; copy its sheets into the new database through the same column
names; call one RPC on both; compare, ignoring generated IDs and timestamps;
for write RPCs also compare the rows each side wrote. A list file names the
RPCs covered so far.
**Done when:** `npm --prefix ops run parity -- rpcGetStaffDirectory` passes
against a trivial ported handler, and deliberately breaking that handler
makes it fail with a readable diff.

### P2-10 · Staging deploy · T2 · security
**Owner's decision (Nov 26): staging runs locally for now.** The app and the
database both run on the owner's computer, reached over the Wi-Fi; the steps
are in [docs/guides/cutover-dry-run.md](../guides/cutover-dry-run.md),
section 7. That covers the dry run on real data and the day of use beside
the live app (P4-04). This card is not dropped: the hosted pieces it sets up
(the deployed Worker, the secrets, the Monday schedule, the hosted database's
connection limits and speed) are not exercised locally, so one hosted
rehearsal on the same kind of database as production is still needed before
the switch (P4-05).
**Read:** `docs/plans/2026-11-ops-local-database.md` ("Flip to Supabase").
**Needs from the owner:** a Cloudflare account; a fresh Supabase project in
the slot freed from the till's staging, with the role script run and `ops`
kept out of the exposed schemas; secrets.
**Make:** a workflow that deploys `ops/` to a staging URL on push to the
working branch, runs migrations first as `ops_owner`, and never touches
production; a weekly cron request so the free project isn't paused while
idle; `TILL_API_BASE_URL` and `TILL_API_KEY` set for the till's staging.
**Done when:** the staging URL serves the login page and `/health`; the
spec's checks pass against Supabase as `ops_app`; the report names every
paid service this turned on and its expected cost.

## Phase 3 — Port, module by module

Every card in this phase has the same shape. **Make:** `ops/src/modules/<name>.ts`
(functions that take a `Db`), `ops/src/rpc/handlers/<area>.ts` (one
`RpcHandler` per RPC, registered in `ops/src/rpc/registry.ts`), tests in
`ops/test/`, and parity cases in `ops/parity/cases/<area>.ts` (added to
`cases/index.ts`). **Done when:** typecheck and tests pass;
`npm --prefix ops run parity -- <the RPCs named>` passes with no exemption
the orchestrator hasn't agreed; the matching suite in `tests/suites/` has
been ported assertion for assertion (list any you could not port, and why).

A parity case is a few lines:
```ts
parityCase("rpcGetCashPosition", { as: "manager" }),
paritySequence("a handover shows in the history", { as: "S_003", writes: ["cash_handovers", "cash_handover_items", "audit_log"] }, [
  step("rpcRecordCashHandover", { args: [{ /* input */ }] }),
  step("rpcGetCashHandoverHistory", { args: [20, "S_003"] }),
]),
```
A write case declares every table it changes; a table changed and not
declared fails the case. A handler with no parity case fails the run.

A sign-in lasts 24 hours and the harness signs each caller in when the case
starts. A case that moves the clock further than that must keep its callers
signed in (call `rpcGetMe` as them along the way, or `rpcLogin` at the new
time and use that token). A step called as a fixture person and answered
`NOT_LOGGED_IN` on both sides fails the case unless it says
`expect: "signed_out"`: two equal refusals compare nothing (found Nov 26:
nine dashboard cases had passed that way).

Rows that the Sheet listed in the order they were appended are read
`order by seq` (`audit_log`, `payments`, `sales`,
`cash_handovers`, `commission_runs`, `validation_results`: 0004 to 0008).
A table that needs the same gets a `seq` column the same way; never order
by Postgres's own row position (`ctid`, `xmin`).

Where the schema stores a day and the Sheet held a date-time, the old RPC
answers with a time of day the new one cannot have. Such a field is named
in `ops/parity/day-only.ts` with its reason and is compared as its Toronto
day on both sides (so far: `handedOn`, `weekEnd`, `periodEnd`). The orchestrator adds to that list,
not a card.

Five old RPCs return a `Date` (`rpcGetAllStaff` `startDate`; `rpcCreateBonus`,
`rpcApproveBonus`, `rpcCancelBonus` and `rpcScheduleShift` date fields).
`google.script.run` can't carry one, so the page gets `null` there today, and
the harness compares against that. Return `null` in those fields and list
them in the report; whether to send the real date is the owner's call later.

### P3-01 · Staff · T1
**Read:** `src/Staff.gs`.
**RPCs:** `rpcGetActiveStaffForLogin`, `rpcGetStaffDirectory`,
`rpcGetAllStaff`.
Also add `rpcLogin` and `rpcLogout` from P2-06 to the parity list.

### P3-02, P3-03, P3-04 · dropped
Product master, product import and shopping list are deprecated (plan
section 2, "Not migrated"). Not ported.

### P3-05 · Shift core, in three cards (split Nov 26: about 2,000 lines of old code)
- **P3-05a · Attendance:** `rpcGetMe`, `rpcGetWeekSchedule`, `rpcScheduleShift`,
  `rpcCancelScheduledShift`, `rpcAdjustAttendanceHours`, `rpcEditAttendanceTimes`.
- **P3-05b · The open and the close:** `rpcOpenShift`, `rpcCloseShift`, and
  `rpcNotifyShiftOpen` (it reads the open session, so it lives here, on top of
  P3-08's sender). The close is one transaction: session, sales row, attendance.
- **P3-05c · Shift state:** `rpcGetMyShiftState`, `rpcGetBootstrap` (they also
  read cash handling, so they follow P3-06). Done Nov 26. Each makes 13 or 14
  database statements per page load, whatever the amount of data; if the
  first screen feels slow on staging (P2-10), this is the place to look.

The notes below apply to whichever of the three touches that code.

### P3-05 (original card) · Attendance, TillSessions, Sales · T2 · money
**Read:** `src/Attendance.gs`, `src/TillSessions.gs`, `src/Sales.gs`
(skip `getDashboard_` and `buildInsights_`); ADRs 0005, 0006, 0008;
`tests/suites/lotto-payout.js`, `sales-cards.js`, `wiring.js`.
**RPCs:** `rpcGetMyShiftState`, `rpcGetBootstrap`, `rpcGetMe`, `rpcOpenShift`,
`rpcCloseShift`, `rpcGetWeekSchedule`, `rpcScheduleShift`,
`rpcCancelScheduledShift`, `rpcAdjustAttendanceHours`, `rpcEditAttendanceTimes`.
**Note:** the three modules call each other; port them together. The close
is one transaction: session, sales row, attendance.
Settings read oddly here (found by P2-05; keep the behaviour): the opening
floats and `lotto_reserve_default` use `Number(x) || 0`, so read them with
`config.value` and that expression, not `config.number`; `<company>_card_split`
is true unless the trimmed, lower-cased value is `false`, and `Sales.gs`
defaults it to true for both companies while `Setup.gs` says false for cstore.

### P3-06 · CashHandling · T2 · money
**Read:** `src/CashHandling.gs`; `tests/suites/cash-handling.js`,
`rpc-guards.js` (cash sections).
**RPCs:** `rpcGetCashPosition`, `rpcRecordCashHandover`,
`rpcVoidCashHandover`, `rpcGetCashOutstandingFor`, `rpcGetCashHandoverHistory`.
**Note:** `record` runs in one transaction and locks the cashier's row first.
`cash_handover_stale_days` treats a negative or zero as 7 (its own rule,
not `config.number`).
Item ids written in a loop must not collide (the old `newId` can repeat
within a second, and the new table has a primary key): give each item a
suffix that includes its position in the batch.
Add a test where two handovers for the same person run at once and the
second sees the first.

### P3-07 · Clover and Reconcile · T2 · money
**Read:** `src/Clover.gs`, `src/Reconcile.gs`; ADRs 0004, 0007;
`tests/suites/reconcile.js`, `link.js`.
**RPCs:** `rpcReconcileDay`, `rpcGetReconciliation`.

### P3-07b · Give a reconcile a time budget · T1 · money
Found Nov 26: a reconcile asks Clover for up to 50 pages per merchant and
sends one WhatsApp message per recipient, each with a 10-second limit, all
inside one database transaction that also holds the day's lock. If Clover is
slow, a reconcile could hold both for many minutes (worst case about 17).
The current app has the same shape but no transaction to hold.
**Make:** one deadline for the whole reconcile (proposed: 25 seconds for
Clover in total; past it the day is recorded as `clover_unavailable`, as a
failed request is today), checked before each request; the WhatsApp sends
keep their own limit.
**Done when:** a test with a Clover stub that answers slowly ends within the
budget, records `clover_unavailable`, and still sends the report.
**Done (Nov 26):** all of one reconcile's Clover requests share 25 seconds.
With nothing left no request starts, and a request gets no longer than what
is left. Out of time is a failed request: the till is recorded
`clover_unavailable` with its Clover figures blank (never partial totals),
and the WhatsApp report still goes. Worst case for the transaction is now
about 25 seconds for Clover plus 10 seconds per WhatsApp recipient.

### P3-08 · Notifier (WhatsApp) · T2 · security
**Read:** `src/Notifier.gs`; `tests/suites/notifier.js`;
`docs/guides/whatsapp-templates.md`.
**RPCs:** `rpcCheckWhatsApp` (`rpcNotifyShiftOpen` moved to P3-05b: it reads the open session). The module also ports `sendOp` and `notify`, which the close, payments and commissions call.
**Note:** the token comes from a Worker secret. No test may call Meta. Leave
out the `shopping_list` message and its template key; the shopping list is
deprecated (also drop it from the list `diagnose` checks).

### P3-09 · Payments and Bonuses, in two cards (split Nov 26: about 1,000 lines of old code)
- **P3-09a · Bonuses:** `rpcGetProposedBonuses`, `rpcApproveBonus`, `rpcCancelBonus`, `rpcCreateBonus`.
- **P3-09b · Payments:** `rpcGetPayrollOverview`, `rpcGetOwedSummary`, `rpcGetMyOwedSummary`,
  `rpcPayShifts`, `rpcPayBonus`, `rpcUndoPayment`, `rpcGetPaymentHistory`. It calls Bonuses and
  the Notifier, so it follows both.

### P3-09 (original card) · Payments and Bonuses · T2 · money
**Read:** `src/Payments.gs`, `src/Bonuses.gs`; ADR-0011;
`docs/components/payroll.md`.
**RPCs:** `rpcGetPayrollOverview`, `rpcGetOwedSummary`, `rpcGetMyOwedSummary`,
`rpcPayShifts`, `rpcPayBonus`, `rpcUndoPayment`, `rpcGetPaymentHistory`,
`rpcGetProposedBonuses`, `rpcApproveBonus`, `rpcCancelBonus`, `rpcCreateBonus`.
**Note:** the current app has no payroll suite. Write one first, against the
old runtime, covering oldest-first, overpayment, the mismatch guard and undo;
then port. Each payment is one transaction with a lock on the staff row.
**Undo (found in the schema review):** today `Payments.undo` deletes the
payment and its item rows and audits it. The new database refuses the app
any delete on money tables. Proposed, pending the owner: a migration adds
`voided_at`, `voided_by` and `void_reason` to `payments`; undo sets them,
and every read leaves voided payments out, so each RPC answers as today and
the record stays. Item ids written in a loop must not collide (see P3-06).

### P3-10 · CommissionRules, Commissions, weekly cron · T2 · money
**Read:** `src/CommissionRules.gs`, `src/Commissions.gs`; ADRs 0011, 0013;
`tests/suites/commission-fixed.js`.
**RPCs:** `rpcGetCommissionRuns`, `rpcRunCommissionEngine`,
`rpcGetCommissionRules`, `rpcCreateCommissionRule`, `rpcUpdateCommissionRule`.
**Make also:** a cron handler that runs the previous week on Mondays.

### P3-11 · Sales dashboard and insights · T2
**Read:** `src/Sales.gs` (`getDashboard_`, `buildInsights_`);
`tests/suites/sales-insights.js`, `perf.js`, `wiring.js`.
**RPCs:** `rpcGetSalesDashboard`.
**Note:** aggregate in SQL where it is simple; keep the insight rules as
ported functions so the same tests apply.

### P3-12 · PublicReport and the public pages · T2 · security
**Read:** `src/PublicReport.gs`; `src/WebApp.gs` (`doGet`, the two page
functions, `inlineJson_`); ADR-0003; `tests/suites/public-*.js`,
`routing.js`, `template-guard.js`, `parity.js`.
**Make:** `GET /?v=sales` and `GET /?v=recon` served with the payload
inlined and `<` escaped. No RPC is reachable without a session.
**Done when (extra):** the hostile-note test from `public-inline.js` passes.
**Done (Nov 26).** `/?v=recon` and `/?v=sales` are served by the Worker: no
session, one read-only transaction, the payload inlined with `<` escaped,
no caching, not indexable, not frameable, and a content policy that lets the
page load nothing and call nothing. The payload is the current one, field
for field. After changing `src/Public*.html`, run
`npm --prefix ops run build:ui` (typecheck, test and parity do it too).
**What these pages show to anyone with the link, today and in the new app**
(for the owner to confirm; nothing was added or removed):
- the 7-day report names each person holding cash, with the amount and how
  long; names the cash manager; lists each handover with who gave, who
  received, who recorded it, the amount and the typed note; and shows the
  note a cashier typed with a lotto count;
- the sales page shows totals only: no names, ids or notes.
**Kept as it is, and wrong:** each lotto count is shown under the day before
its close (the old code reads the day as UTC). Fix after cutover, in both
the page's eyes at once.
**Not built:** a limit on how often the pages can be requested. Each 7-day
report costs about 11 database queries with nobody signed in; a Cloudflare
rate rule on `/` with `v` set belongs in P2-10 (staging).

## Phase 4 — Data and cutover

### P4-01 · Sheet export tool · T2
**Make:** `ops/tools/export-sheet.ts`: one file per tab from a downloaded
workbook, values exactly as stored (blank stays blank, dates as dates).
Export every tab, deprecated ones included: the export is also the archive.
**Done when:** run on the fixture workbook, row counts match the workbook.
**Done (Nov 26):** `npm --prefix ops run export:sheet -- <workbook.xlsx> <out-dir>`
writes one JSON file per tab and a `manifest.json` with checksums. It reads
the .xlsx with Node's built-ins only (no new dependency), prints counts and
never a cell value, and refuses anything it cannot read in full. A date
cell is a wall-clock time in Toronto and becomes that instant; a blank
stays blank. The fixture workbook reads back cell for cell and loads into
the database exactly as the fixture itself does.
**Not yet verified: a real Google download** (only workbooks written by
the tests). On the owner's first real export, check:
1. it completes, and the tab count and each tab's row count match the Sheet
   (hidden tabs included);
2. date columns arrive as dates, not plain numbers (the tool's table shows
   a `dates` count per tab);
3. no tab shows `errors` or unexpected `formulas`;
4. a few known cells by eye: a date, a time, a blank, a figure with cents,
   an id with leading zeros.
One limit, by nature: a time inside the repeated hour of the November clock
change is read as the first of the two.

### P4-02 · Import tool with a rejects file · T2 · money
**Read:** `ops/contracts/schema.sql`; ADR-0004.
**Make:** `ops/tools/import.ts`: loads the export in foreign-key order inside
one transaction, skipping the deprecated tabs listed in P0-03; blank becomes `NULL`; any row that fails goes to
`rejects.csv` with its tab, row number and reason.
From the schema review, the import must also: reject a figure that doesn't
survive the round trip to 2 decimals (Postgres rounds silently); lower-case
enum values such as `Closed` before insert, rejecting anything still
outside the set; leave out secret config keys, `staff.login_code` and the
seeded placeholder rule `CR_001` when it is inactive and unused; turn each
`staff.login_code` into `staff.pin_hash` with P2-06's hashing (the plaintext
never reaches the database); map
`commission_runs.week_end` (stored as Sunday 23:59:59) to its Toronto date.
Duplicate item ids (found by P2-09a): `payment_items` and
`cash_handover_items` can hold two rows with the same `item_id`, because the
old id is a one-second stamp plus three random characters and a payment
writes many items at once. A duplicate there is never rejected (it is
money): the later row is re-keyed (`<id>-d2`, `-d3`…), loaded, and listed
in the report. Build on `ops/src/import/sheet-to-db.ts` and `load.ts`.
Open, for the owner: an open till session holds 0, not blank, in its closing
columns; the proposal is to import those as `NULL` for rows still open.
**Done when:** the fixture imports with zero rejects; a workbook with a
broken row produces exactly one reject and loads the rest; each rule above
has a test.
**Done (Nov 26):**
`npm --prefix ops run import:sheet -- <export-dir> [--dry-run] [--report <dir>] [--accept-rejects <n>] [--open-sessions-blank]`,
with `OPS_DB_APP_URL` and `PIN_PEPPER` in the environment (never printed; it
reads no `.dev.vars`, so a stray local file cannot supply a fake pepper at
cutover). It runs as `ops_app`, which cannot delete. How it behaves:
- It checks every tab file against the manifest's checksum, that every
  migration is applied, and that every table it loads is empty; otherwise it
  refuses. It never deletes or truncates.
- One transaction, each tab top to bottom (so `seq` is the Sheet's order).
- **It commits only when the number of rejects equals `--accept-rejects`
  (default 0).** Otherwise it rolls back, writes `rejects.csv` and
  `import-report.json`, and exits 1: the database stays empty and the run
  can be repeated. `--dry-run` always rolls back.
- The reports hold tab, Sheet row, column and reason; never a cell value.
- A row with no id but other cells is a reject (it used to be skipped).
- Duplicate ids are re-keyed (`-d2`, `-d3`…) in `payment_items`,
  `cash_handover_items` and, by a ruling on landing, `audit_log` (same kind
  of id, four rows per close, nothing refers to them). A duplicate id in any
  other table rejects the later row: those rows have children.
- `PIN_PEPPER` must be the Worker's real secret, or nobody can sign in.
**For the dry run on real data (P4-04), expect rejects from:** figures with
more decimals than cents; text in a number or date column; a time typed
into `scheduled_start`/`scheduled_end` (they are text `HH:MM`); a status or
method outside the allowed words; rows pointing at a deleted person or
shift (each takes its children with it); duplicate ids in `bonuses`,
`payments`, `cash_handovers`, `validation_results`; a sales row with both
card shapes filled; a row with no id. An error cell (`#REF!`) in a loaded
tab, or an unknown tab, stops the import. A login code stored as a number
loses its leading zeros (`0123` reads as `123`) and is counted in the report.

### P4-03 · Reconcile report · T2 · money
**Make:** `ops/tools/reconcile.ts`: per table and per month, row count and
the sum of every money column, Sheet beside database, with differences.
**Done when:** it reports zero differences on the fixture, and a planted
one-cent change is reported. Optional: if the owner provides a one-off cstore
ePOS export, a second report compares its card totals with the Sheet's
cstore `card_total_sales` per day.
**Done (Nov 26):**
`npm --prefix ops run reconcile:import -- <export-dir> --import-report <import-report.json> [--out <dir>]`,
with `OPS_DB_READ_URL` in the environment (the read-only role; never
printed). It reads the export, the import's report and `rejects.csv`, and
the database in one read-only snapshot, and exits 0 only when there is no
unexplained difference. What it checks:
- every row and every column the Sheet has, matched by id: money to the
  cent, dates by their Toronto day, times to the instant, blank against
  blank (a blank that became 0 is a difference even though no sum changes);
- per table and per month: row counts, the sum of every money column
  (added in whole cents, never as fractions), and the count of blanks;
- the order of rows, for the tables that keep it;
- nothing extra in the database; no secret setting loaded; a PIN hash set
  for exactly the people who had a login code, and never the code itself;
- the import's own report: every rejected or left-out row it lists must be
  a real row of the export, and the totals must add up.
It computes the Sheet's side with its own arithmetic, not the importer's
code (a test forbids the import), so a mistake in the importer cannot
cancel out. Rows the import rejected or left out on purpose are listed
separately with the money they carry. The report shows sums per month and
the size of a difference in cents; it never shows a name, a note, a pay
rate or a row's figures.
**Limits:** it compares the export with the database, not the live Sheet
with the export (the export tool's first-run checks cover that); it cannot
verify a PIN without the secret; and a row the import rejected is listed,
not judged: the owner reads that list. The optional ePOS comparison is not
built.

### P4-04 · Dry run on a copy of production · T3 + owner · money
Export production, import to staging, run P4-03, explain every difference in
writing. Two people then use staging for a normal day beside the real app.
**First, a local rehearsal that needs no hosting:**
[docs/guides/cutover-dry-run.md](../guides/cutover-dry-run.md) takes the real
Sheet through export, import and the check on the owner's own computer.
Run end to end on the fictional data on Nov 26: clean result, a second
import refused, and a planted one-cent change reported.
**First real run (owner, Windows, Nov 27):** the export worked on the real
download. The import then refused all 13 deprecated tabs as unknown. Cause:
Git on Windows checks files out with CRLF line ends, and the reader of the
schema file's deprecated-tab list understood only LF. Fixed the same day:
the schema reader, migration checksums and the page build now read a CRLF
checkout as the same text, and `.gitattributes` keeps LF in every checkout.
Checked by taking a full CRLF copy of the code through migrate, dry run,
import, the check and the page build.
**First dry run on real data (Nov 27): 10,271 rows, 314 rejected.** No
reject was a money figure, a date or a status in the wrong form: every tab
that holds money loaded whole except the rows below.
- 303 in `audit_log`: the app writes each reconcile entry's target as the
  day in text, and Google Sheets had turned it into a date cell. Fixed the
  same day: in `audit_log.target_id` only, a date cell at midnight in
  Toronto is read back as the day in text, counted in the report; the
  Sheet-against-database check states the same rule on its own.
- 11 that need the owner to look at the Sheet (nothing is guessed):
  two early till sessions (rows 3 and 4) whose attendance row does not
  exist, which take their two sales rows and two handover lines with them;
  two till sessions (rows 525 and 526) repeating the ids of rows 521 and
  522, and two sales rows (523 and 524) pointing at sessions that are not
  in the tab; one bonus (row 3) pointing at a commission run that is not in
  the tab.
  **Owner's answer (Nov 27): all 11 are test data and are left out.** The
  import is run with `--accept-rejects 11`; the Sheet-against-database
  check then lists them under "not loaded" with the money they carry.
  For the real cutover (P4-05): the same rows will reject again unless they
  are removed from the Sheet first. Accepting by count alone would also
  accept a different 11, so the runbook compares that day's `rejects.csv`
  with this list (tab and row) before the count is given.
  **Result (Nov 27): the import committed and the check found no
  unexplained difference.** All but 15 rows loaded (the 11 test rows left
  out, and 4 settings rows left out on purpose). Every month's sums match
  to the cent in every table; the whole audit log loaded; every person's
  PIN was hashed. The local rehearsal part of this card is done. Still to
  do: the day of use beside the live app, and the hosted rehearsal.
  The monthly sums also showed two oddities in the Sheet's own data (the
  same on both sides, so not import differences). They were passed to the
  owner in conversation; no figures are recorded here.
- Also seen: 5 formula cells in `till_sessions` (someone typed formulas
  there; the export keeps their shown values); 2 tills open at download
  time, holding 0 in their closing figures; 1 audit id re-keyed.
**Done when:** the owner signs off the reconcile report.

### P4-05 · Cutover runbook, then the switch · T3 + owner · money
**Make:** `docs/guides/cutover.md`: the steps of plan section 6 with the
exact commands, who does each, how long each takes, and the way back. The
Supabase project has been staging until now: the runbook empties schema
`ops` before the real import, and moves staging to a new `ops_staging`
schema with its own role and fictional data only.
**Done when:** staff are on the new URL and the first close reconciles.

### P4-06 · Nightly export to a Google Sheet · T2
**Make:** a cron job that writes each table to a tab of a read-only Sheet,
and the same tables as dated files in R2, kept 90 days. The free Supabase
plan has no automatic backups, so the R2 copy is the backup.
**Done when:** the Sheet's totals match P4-03's database side, and a restore
from last night's R2 files into an empty local Postgres gives the same
totals.

### P4-07 · Retire the Apps Script deploy · T1
Thirty days after the switch. Remove the two deploy workflows; mark `src/`
as archived in `AGENTS.md`; set ADR-0001 to superseded.

### P4-08, P4-09, P4-10 · What the Sheet used to do (owner, Nov 27)
Once the Sheet is gone an admin cannot fix things by editing a cell. Two
needs come first, both for the admin role only, both before the switch
(P4-05 now waits for them):

- **P4-08 · Groundwork (done).** [ADR-0023](../adr/0023-the-operations-app-has-rpcs-and-screens-of-its-own.md):
  the new app's own RPCs are listed by hand in `ops/contracts/rpc-ops.json`
  and merged into the contract the Worker enforces; a screen only the new
  app has is marked `opsOnly` in the page's drawer list and is hidden inside
  Apps Script. Own RPCs have no comparison case (nothing to compare with):
  unit tests are their specification.
- **P4-09 · Settings.** An admin sees every setting with its meaning and
  default, and changes any of them: checked by the setting's kind, audited
  with before and after, blank meaning "use the default". The three keys
  (WhatsApp, the two Clover tokens) are not settings any more: they are held
  by Cloudflare and are shown only as set or not set.
  **Done.** `rpcGetSettings` and `rpcUpdateSetting`, admin only; a value is
  refused where the code that reads it would misread it (a zero that reads
  as the default, an address a key would not be sent to, a cash manager who
  is not active). Checked in a browser as an admin and as an employee.
  Four things it showed, for the owner:
  1. `cstore_card_split` is listed with the default "false", but the code
     that reads it (in the current app too) treats a blank as "true". So
     "Use the default" on the cstore till means "splits credit and debit".
     The screen shows what a blank really reads as. Leave the saved "false"
     alone; decide later whether the reader or the list should change.
  2. `commission_run_day` and `commission_run_hour` are read by nothing in
     the new app: the weekly run's time is part of the app (P3-10b). The
     screen says so.
  3. Nothing stops the "minor" variance limit being set below the "OK"
     limit.
  4. A cash manager chosen here can later be deactivated; cash handling then
     reads as "nobody". The staff screen (P4-11) is to refuse that.
- **P4-10 · Schedule corrections.** An admin corrects a day for one person,
  today or in the past, with a reason: scheduled times, actual start and
  end, and whether the day was worked or cancelled; or adds a day worked by
  someone who was not scheduled. Hours follow the actual times. Refused
  while money has been paid against the day (undo the payment first) or
  while that person's till is open. Till sessions and sales are not moved.
  The owner's two cases: someone left early and another stayed (two
  corrections, one per person); someone did not show and a stand-in worked
  (cancel one day, add the other).
  **Done.** `rpcGetAttendanceDay` and `rpcCorrectAttendance`, admin only,
  from the Schedule screen: tap a day, then "Correct this day" or "Add a
  day worked". The sheet shows what is recorded, the tills opened that day
  and what the change does to the pay owed, before saving. A correction
  and a payment for the same person wait for each other, so a day cannot
  be paid at its old hours while it is being corrected. Both of the owner's
  cases were replayed in a browser on the merged build. What it does not
  do: move a till session filed under the wrong person (P4-12), or record a
  scheduled shift that runs past midnight (leave the schedule blank; the
  actual times do cross midnight). Three questions for the owner:
  1. A day whose stored rate is 0 (the app writes 0 for "no rate yet" when
     a shift is scheduled) takes the person's current rate when corrected
     to worked. A stored rate above 0 is kept. Right?
  2. A day corrected to "did not work" keeps the rate it had. Right?
  3. Notes on a day are capped at 2,000 characters, newest kept. Enough?

### P4-11 to P4-14 · the rest of what the Sheet used to do
Planned Nov 27 in [After the Sheet](2026-11-after-the-sheet.md), part 1: the
review of the Sheet's menu, every table and every unused write function, the
gaps found, and what each card builds. Not started: they wait for the
owner's answers to the questions on that page. P4-06 (the nightly Google
Sheet copy) is proposed to move before the switch, since the Sheet was also
where people looked things up.

### The owner's answers (Nov 27)
1. **Go ahead** with the staff screen and with corrections to a closed till.
2. **A manager may add people.** Built as: a manager adds an employee (name,
   tills, start date, a first PIN) and nothing else; the pay rate, roles
   above employee, changes, deactivating and PIN resets stay with an admin.
   A manager does not see pay rates anywhere today, and this keeps it so.
3. **A raise may also apply to unpaid days.** When an admin changes a rate
   they may say "also from this date": worked days from that date with
   nothing paid against them take the new rate; days with any payment are
   left and listed.
4. **People do not change their own PIN.** An admin sets it.
5. **"Delivery" means delivery runs:** see the deliveries, mark them
   delivered, see the delivery plan. The till's API has no call for either
   yet, so P5-07 starts with a spec and a request to the till side.
6. **Build the read-only till link now,** switched off (P5-02a, P5-02b,
   P5-03b).
7. **Schedule corrections (P4-10) are right as built:** a day with no rate
   yet takes the person's current rate; a day set to "did not work" keeps its
   rate, is not in payroll and is owed nothing; notes capped at 2,000
   characters.

**P4-11 is done:** More → Staff. An admin adds, changes, deactivates and
reactivates people, sets PINs, and gives a raise that may also cover unpaid
days from a date (shown before saving; days with a payment are left and
listed). A manager adds an employee with a name, tills, a start date and a
first PIN, and sees no pay rate anywhere, on the screen or in what the
server sends. The guards: the only active admin, yourself, an open till,
the cash manager. Setting a PIN signs the person out everywhere and clears
a lockout. Checked in a browser as admin, manager and employee.
One thing it showed, for the owner (P4-11b): a person with **no rate yet**
who works a day gets a rate of 0 stored on that day, as the current app
does. The day is then worth $0, is in no "owed" list, and My Pay shows
"$0.00/hr", until an admin sets the rate with "also from this date", which
does cover those days. So after a manager adds someone, an admin must set
their rate that way. Showing such days as "no rate set" changes what two
ported calls answer, so it is a card of its own.

**P4-12a is done:** on the Sales screen, under each closed till of the day,
an admin has "Correct this till". The sheet shows what is recorded, what has
been handed over, whether the day was reconciled, and takes the same figures
a close takes; a reason is required. The arithmetic is the close's own: it
was moved into one function (`closeFigures`) that both use, and every
existing test and comparison case still passes. Refused when it would leave
less cash than was already handed over from that till (void the handover
first). After saving it says what moved, and what is now out of date: the
day's reconcile (P4-12c), a commission run that used the old sales, and for
a changed lotto count the next cstore close. Checked in a browser as admin,
manager and employee. Three things for the owner:
1. The control is on **Sales**, not History: History lists payments, and
   Sales is the only screen that lists every closed till.
2. A figure the admin clears is stored as blank ("not entered"), where a
   close stores 0 for a figure left empty. Sums treat both as 0.
3. A correction keeps the float that was left in the drawer that day and
   the lotto count of the close before it, even if the settings have
   changed since. The variance limits are today's, because nothing records
   the ones in force that day.

P4-12 is split in three so each can be reviewed on its own: correcting a
closed till (a), entering a shift that was never put in the app (b), and
running the reconcile again for a past day (c).

### The till link, in build order
[After the Sheet](2026-11-after-the-sheet.md), part 2, puts P5-02, P5-03,
P5-07 and P5-08 in order, splits P5-02 in two (the client and a fake till;
then people and stores matched), adds sales by channel as its own step, and
says what each waits for.

## Phase 5 — New abilities

### P5-01 · Stores and staff assignments · T2 · security
**Make:** screens and RPCs to assign a person to stores with a role and
dates; every list and every write filtered by the caller's stores.
**Done when:** tests show a person assigned to store A can neither read nor
write store B through any RPC in the contract.

### P5-02a · the client and a fake till · done
[ADR-0024](../adr/0024-the-till-is-read-through-one-client.md) and the
[till link](../components/till-link.md) page. One client
(`ops/src/till/`): it never throws, sends the key only to the till's two
addresses and only in a header, never follows a redirect, scrubs the key
from every message, waits when told to slow down (twice at most), and can
only read. A fake till built from the contract serves every case the later
cards need. Nothing calls the client: the setting `till_enabled` is off and
a test fails if any other part of the app imports it. The key is a Worker
secret (`TILL_API_KEY`); the Settings screen has a "Till" group. One of the
seven deliberate breakages (retrying for ever) hangs the suite instead of
failing a named test; it is caught, but slowly.
Questions for the till side that it raised:
1. A shift list takes one `day`, not a range: is a range planned?
2. Which time zone is "not after today"? (Toronto is assumed.)
3. What exactly does an `auto_closed` shift return? (Empty `z_number`,
   `expected`, `counted` are assumed.)
4. Can `closed_by` be empty on a closed shift?
5. There is still no field for the "To check" case (asked Nov 23).
6. Is `Retry-After` sent as seconds or as a date? (Both are handled.)
7. Does a store that does not exist also answer `forbidden_store`?
8. Is the daily-sales limit 92 days inclusive?
9. The four driver-handover fields (asked Nov 23) are not in the contract.
It also confirmed that the contract has no call about customer deliveries.

### P5-02 · Till link: staff sync and key expiry · T2 · security
**Read:** `ops/contracts/till-api.v1.yaml`; `docs/plans/2026-11-till-api-agreed.md`.
**Make:** `ops/src/till/client.ts` (never throws; returns `{ok:false,error}`;
waits for `Retry-After` on `429`); a link from an Operations person to a
till `staff_id`, offered from `GET /staff`; a map from the till's stores to
Operations' stores. Sign-in stays Operations' own (D6): the till has no PIN
check. The nil uuid (`00000000-0000-0000-0000-000000000000`,
"Not known") is the till's "no one recorded" and is never linked. The key's expiry date is recorded when it is installed, and admins
are warned 14 days before it.
Tests and local runs use a fake till built from the contract.
**Done when:** tests cover: linking a person; a till person who isn't in
Operations is listed, not created; till down, the link screen says so and
sign-in is unaffected; the expiry warning shows at 14 days and not at 15.

### P5-03 · Vape close from the till snapshot · T2 · money
**Make:** at close, fetch the shift from the till, store it as a snapshot
with the time fetched, and prefill the close for the cashier to confirm. A
later difference between the till and the snapshot is flagged, never applied.
Use the till's `expected`, which includes `door_cash`; store door cash as
its own column. A shift belongs to the business day it opened.
An empty `counted` (including on an `auto_closed` shift) is *not counted*:
shown as such, `variance` left empty, never 0. Door cash belongs to the
shift open when the delivery was recorded, and the driver answers for it,
not the cashier (owner, Nov 23). Once the till sends the driver handover
(`door_cash.collected_total`, `handed_over_total`, `driver`,
`handed_over_at`; asked Nov 23), store it as its own snapshot row and show
two figures: the driver's gap (`handed_over_total − collected_total`) and
the cashier's variance. A handover not yet made shows as *with the driver*.
Neither gap is ever taken from pay; both go to a manager.
`staff_takings` rows with the nil uuid count toward no one's commission and
are shown to the manager. Takings that don't add up to the sales total (the
till's "To check" case) are stored and flagged, never rejected.
The till reports `etransfer` as its own method; add a matching column to the
Operations sales row (a schema change with its own migration) instead of
folding it into cash or card.
**Done when:** tests cover: till figures used; till down, manual entry; till
corrected afterwards, flag raised and pay unchanged; an e-Transfer sale kept
separate and counted in the day's total.

### P5-04 · LLM gateway · T2 · security
**Read:** `docs/adr/0022-llm-calls-go-to-the-free-model-first.md`.
**Make:** `ops/src/llm/`: one entry point per task; two providers; a mode
setting per task (`cf_only`, `cf_then_claude`, `claude_only`); validators in
code; a daily cap on Claude calls; a log row per call. Use the provider's
official SDK and its structured-output feature; do not hand-build HTTP calls.
**Done when:** tests with both providers faked cover: `cf_only` never calls
Claude even on failure; `cf_then_claude` calls Claude only when a validator
fails; the cap stops further calls; with no Claude key installed the app
starts and `cf_only` works.

### P5-05 · Purchase receipts, supplier records and product costs · T2 · money
A receipt is first a **bookkeeping record**: the photo and the figures on it,
kept together for tax filing. Product costs come out of it.
**Make:**
- tables in `ops`: `suppliers`, `purchase_receipts` (store, supplier, receipt
  date, invoice number, subtotal, HST, total, how it was paid, photo key,
  status), `purchase_receipt_lines`, and `product_costs` (store, item or SKU,
  supplier, unit cost, effective day, the receipt it came from);
- vape lines keep the invoice's shape, as the till does: pieces per carton,
  carton price and duty per carton, with unit cost = (carton price + duty) /
  pieces; plus the till's product code and supplier code, picked from
  `GET /products` and `GET /suppliers` (the till gives no costs, so this
  table is the cost history for both stores);
- photo upload to R2, the photo linked to its receipt;
- a draft from the LLM gateway, and a review screen where a person corrects
  and confirms; record every field the reviewer changed;
- confirming a receipt writes its lines to `product_costs` for that store.
**Rules:** a confirmed receipt and its photo are never deleted, only voided
with a reason and audited; the R2 bucket gives the Worker no delete right.
Tax records generally have to be kept for six years; confirm the period with
the bookkeeper.
**Done when:** tests show nothing is recorded without a person's
confirmation; a draft whose lines don't add up to the total is marked for
attention; a voided receipt stays listed with its photo; the old Sheet's
`product_master` and `suppliers` tabs are not read.

### P5-06 · Receipt test set · T2 + owner
The owner supplies 20–30 real receipts. Run each through both models; report
per model: passed validators, fields a person had to correct, cost.
**Done when:** the owner picks the starting mode from the report.

### P5-07 · Delivery runs · T3
First draft of the spec: [Delivery runs](2026-11-delivery-runs-spec.md)
(Nov 27), from the owner's request to see the deliveries, mark them
delivered and see the plan. It holds the request to the till side (a list of
deliveries, the customer's details on a call of their own, and recording
the outcome) and eight questions for the owner.
Write the spec with the owner first (who drives, what an order needs at the
door, what counts as delivered). Then split the build into cards.
The spec must cover the driver's door cash: per run, cash the deliveries
collected, the handover at the till (from the till's `door_cash` handover
fields), the driver's gap, and cash still *with the driver* at the end of a
run. A driver's gap is shown to a manager and never taken from pay (Ontario
limits deductions for cash shortages; check with the bookkeeper before any
policy).

### P5-08 · Send a vape delivery to the till, on a button · T2 · money
**Read:** `ops/contracts/till-api.v1.yaml` (`POST /proposals`, kind
`receipt`); `docs/plans/2026-11-till-api-agreed.md`.
**Make:** on a confirmed vape receipt, a "Send to the till" action that sends
it as one `receipt` proposal: stock received and cost together, with the
till's purchase order or supplier code, the invoice number and date, and
each line's till code. Lines with no till code go in `not_matched`, as
written. Show the proposal's status, including `expired`. The idempotency
key is `<receipt id>-<attempt>`, so a resend after expiry is a new proposal
and a double press is not. No cron, no automatic send. The action doesn't
exist for cstore receipts.
Match each invoice line to a till code from `GET /products`: by barcode,
then the supplier's own code, then name, and let the person confirm or
change each match. Offer the open orders from `GET /orders` for the
supplier; with none, send `vendor`. A placeholder code (`sku_pending`) may
be sent and is shown as such. After a `422` for a waiting proposal, show
that one; after an expired or rejected one, resend under a new key.
**Done when:** tests cover: nothing is sent until a person presses the
button; pressing it twice makes one proposal; an expired proposal can be
sent again; `422` shows the till's reason and leaves the receipt unsent;
a cstore receipt can't be sent; till down, the receipt stays unsent with the
error shown; a line is matched by barcode, and failing that by the
supplier's own code; a line with no match goes in `not_matched`.
A resend reads `GET /proposals/{id}` for the status: a repeated request
always answers `pending`.

### P5-09 · Bookkeeping export of receipts · T2 · money
**Make:** an export of receipts for a date range and store: one CSV of
receipts, one of lines, and a zip of the photos named by receipt id. Voided
receipts are included and marked.
**Done when:** the CSV totals match the receipts screen for the same range.
An integration with QuickBooks or similar is a later decision; this export
is what it will start from.

### P5-10 to P5-14 · Assistants through MCP (owner, Nov 27)
Proposed in [Assistants through MCP](2026-11-assistants-through-mcp.md): for
the first iteration the app runs no model of its own (P5-04 is postponed).
An AI assistant reaches the app through an MCP server and may read a short
list of things and propose a short list of things; a person confirms every
proposal beside the original document. It covers purchase receipts (the
original kept for audit, the figures taken from it, one business per
receipt, an export per business for QuickBooks), invoices that arrive by
email (found by the assistant through its own mailbox connection; the app is
given no access to email), and delivery planning. The owner answered its
eight questions on Nov 27 (recorded on that page): Muse first, connecting
with a key; QuickBooks Online with a company per business; a receipt never
holds both businesses; lines are read where they can be, to keep a cost
history and flag price rises (P5-15); the old purchase list comes in as
history (P5-16); an assistant may see customers' details for delivery
planning. The trial (P5-10) needs a public address, so it waits for the
hosted setup; the door itself (P5-11) can be built and tested without it. P5-05 keeps its
tables, its checks and its review screen; only where the draft comes from
changes. P5-06 becomes a test of the assistants on real receipts.

## Phase 6 — App

### P6-01 · Installable web app · T2
**Make:** a web app manifest, icons, and a service worker that caches only
the app's own files, never RPC answers.
**Done when:** the app installs to a home screen on Android and iPhone, and
a signed-out phone with no network shows the login page, not stale data.

### P6-02 · Store listings: decide · owner
Whether to wrap the app for the app stores (Apple about US$99 a year, Google
about US$25 once; check current terms). If yes, the orchestrator writes the cards.
