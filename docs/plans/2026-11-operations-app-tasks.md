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
| P2-10 | Staging deploy | T2 | P2-08b | security | todo |
| P3-01 | Port Staff | T1 | P2-09 | | done |
| P3-02 | ~~Port ProductTypes and ProductMaster~~ | | | | dropped |
| P3-03 | ~~Product import by CSV upload~~ | | | | dropped |
| P3-04 | ~~Port ShoppingList~~ | | | | dropped |
| P3-05a | Port Attendance: schedule, hours, who am I | T2 | P3-01 | money | done |
| P3-05b | Port the open and the close: TillSessions, Sales | T3 | P3-05a, P3-08 | money | done |
| P3-05c | Port the shift state and bootstrap reads | T2 | P3-05b, P3-06 | money | todo |
| P3-06 | Port CashHandling | T2 | P3-05b | money | done |
| P3-07 | Port Clover and Reconcile | T2 | P3-06, P3-08 | money | todo |
| P3-08 | Port Notifier (WhatsApp) | T2 | P2-09 | security | done |
| P3-09a | Port Bonuses | T2 | P3-05a | money | done |
| P3-09b | Port Payments (pay, undo, owed, history) | T3 | P3-09a, P3-08 | money | done (undo is a void; the owner has still to confirm that) |
| P3-10a | Port CommissionRules | T2 | P3-09a | money | done |
| P3-10b | Port the commission engine and the weekly cron | T2 | P3-10a, P3-05b | money | in progress |
| P3-11 | Port the sales dashboard and insights | T2 | P3-05b | | done |
| P3-12 | Port PublicReport and the public pages | T2 | P3-07, P3-11 | security | todo |
| P4-01 | Sheet export tool | T2 | P0-03 | | in progress |
| P4-02 | Import tool with a rejects file | T2 | P4-01, P2-02 | money | todo |
| P4-03 | Reconcile report: Sheet against database | T2 | P4-02 | money | todo |
| P4-04 | Dry run on a copy of production | T3 + owner | P3-12, P4-03 | money | todo |
| P4-05 | Cutover runbook, then the switch | T3 + owner | P4-04 | money | todo |
| P4-06 | Nightly export to a Google Sheet | T2 | P4-05 | | todo |
| P4-07 | Retire the Apps Script deploy | T1 | P4-05 + 30 days | | todo |
| P5-01 | Stores and staff assignments | T2 | P4-05 | security | todo |
| P5-02 | Till link: staff sync and key expiry | T2 | P5-01, P1-02 | security | todo |
| P5-03 | Vape close from the till snapshot | T2 | P5-02 | money | todo |
| P5-04 | LLM gateway: free model first, Claude behind a flag | T2 | P4-05 | security | todo |
| P5-05 | Purchase receipts, supplier records and product costs | T2 | P5-04 | money | todo |
| P5-06 | Receipt test set through both models | T2 + owner | P5-04 | | todo |
| P5-07 | Delivery runs: spec first, then build | T3 | P5-04 | | todo |
| P5-08 | Send a vape delivery to the till, on a button | T2 | P5-05, P1-02 | money | todo |
| P5-09 | Bookkeeping export of receipts | T2 | P5-05 | money | todo |
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
`order by seq` (migrations 0004 to 0006: `audit_log`, `payments`, `sales`,
`cash_handovers`).
A table that needs the same gets a `seq` column the same way; never order
by Postgres's own row position (`ctid`, `xmin`).

Where the schema stores a day and the Sheet held a date-time, the old RPC
answers with a time of day the new one cannot have. Such a field is named
in `ops/parity/day-only.ts` with its reason and is compared as its Toronto
day on both sides (so far: `handedOn`). The orchestrator adds to that list,
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
  read cash handling, so they follow P3-06).

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

## Phase 4 — Data and cutover

### P4-01 · Sheet export tool · T2
**Make:** `ops/tools/export-sheet.ts`: one file per tab from a downloaded
workbook, values exactly as stored (blank stays blank, dates as dates).
Export every tab, deprecated ones included: the export is also the archive.
**Done when:** run on the fixture workbook, row counts match the workbook.

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

### P4-03 · Reconcile report · T2 · money
**Make:** `ops/tools/reconcile.ts`: per table and per month, row count and
the sum of every money column, Sheet beside database, with differences.
**Done when:** it reports zero differences on the fixture, and a planted
one-cent change is reported. Optional: if the owner provides a one-off cstore
ePOS export, a second report compares its card totals with the Sheet's
cstore `card_total_sales` per day.

### P4-04 · Dry run on a copy of production · T3 + owner · money
Export production, import to staging, run P4-03, explain every difference in
writing. Two people then use staging for a normal day beside the real app.
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

## Phase 5 — New abilities

### P5-01 · Stores and staff assignments · T2 · security
**Make:** screens and RPCs to assign a person to stores with a role and
dates; every list and every write filtered by the caller's stores.
**Done when:** tests show a person assigned to store A can neither read nor
write store B through any RPC in the contract.

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

## Phase 6 — App

### P6-01 · Installable web app · T2
**Make:** a web app manifest, icons, and a service worker that caches only
the app's own files, never RPC answers.
**Done when:** the app installs to a home screen on Android and iPhone, and
a signed-out phone with no network shows the login page, not stale data.

### P6-02 · Store listings: decide · owner
Whether to wrap the app for the app stores (Apple about US$99 a year, Google
about US$25 once; check current terms). If yes, the orchestrator writes the cards.
