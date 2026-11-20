# Operations app migration — task cards

> **Status: draft for owner review.** Read
> [the plan](2026-11-operations-app-migration.md) first: section 5 explains
> the roles, the tiers, the worker rules and the parity oracle these cards
> rely on.

**For the orchestrator:** hand a worker one card plus the worker rules from
the plan, nothing else. A card may start when every card under **Needs** is
`done`. Cards flagged *money* or *security* get a T3 review of the diff.

**For a worker:** you were given one card. Do that card only.

## Ledger

| ID | Card | Tier | Needs | Flags | Status |
|---|---|:-:|---|---|---|
| P0-01 | Owner answers decisions D1–D12 | owner | | | todo |
| P0-02 | Till API contract v1 | T3 | P0-01 | security | todo |
| P0-03 | Database schema contract | T3 | P0-01 | money | todo |
| P0-04 | RPC contract file | T1 | | | todo |
| P1-01 | Archive old audit-log rows (current app) | T2 | | | todo |
| P1-02 | Till API built (till repository) | external | P0-02 | security | todo |
| P1-03 | Vape close prefilled from the till (current app) | T2 | P1-02 | money | todo |
| P2-01 | Scaffold `ops/` and its CI | T1 | P0-01 | | todo |
| P2-02 | Migrations runner and first migration | T1 | P2-01, P0-03 | | todo |
| P2-03 | Database, money, date and ID helpers | T2 | P2-02 | money | todo |
| P2-04 | Audit log writer | T1 | P2-03 | | todo |
| P2-05 | Config and secrets access | T1 | P2-03 | security | todo |
| P2-06 | Login, sessions, lockout, roles | T2 | P2-04, P2-05 | security | todo |
| P2-07 | RPC router | T2 | P2-06, P0-04 | security | todo |
| P2-08 | UI served with the new transport | T2 | P2-07 | | todo |
| P2-09 | Parity harness | T3 | P2-07 | | todo |
| P2-10 | Staging deploy | T2 | P2-08 | security | todo |
| P3-01 | Port Staff, Suppliers, OrderCatalog | T1 | P2-09 | | todo |
| P3-02 | Port ProductTypes and ProductMaster | T2 | P2-09 | | todo |
| P3-03 | Product import by CSV upload | T2 | P3-02 | | todo |
| P3-04 | Port ShoppingList | T2 | P3-02, P3-08 | | todo |
| P3-05 | Port the shift core: Attendance, TillSessions, Sales | T2 | P3-01 | money | todo |
| P3-06 | Port CashHandling | T2 | P3-05 | money | todo |
| P3-07 | Port Clover and Reconcile | T2 | P3-06, P3-08 | money | todo |
| P3-08 | Port Notifier (WhatsApp) | T2 | P2-09 | security | todo |
| P3-09 | Port Payments and Bonuses | T2 | P3-05 | money | todo |
| P3-10 | Port CommissionRules, Commissions, weekly cron | T2 | P3-09 | money | todo |
| P3-11 | Port the sales dashboard and insights | T2 | P3-05 | | todo |
| P3-12 | Port PublicReport and the public pages | T2 | P3-07, P3-11 | security | todo |
| P4-01 | Sheet export tool | T2 | P0-03 | | todo |
| P4-02 | Import tool with a rejects file | T2 | P4-01, P2-02 | money | todo |
| P4-03 | Reconcile report: Sheet against database | T2 | P4-02 | money | todo |
| P4-04 | Dry run on a copy of production | T3 + owner | P3-12, P4-03 | money | todo |
| P4-05 | Cutover runbook, then the switch | T3 + owner | P4-04 | money | todo |
| P4-06 | Nightly export to a Google Sheet | T2 | P4-05 | | todo |
| P4-07 | Retire the Apps Script deploy | T1 | P4-05 + 30 days | | todo |
| P5-01 | Stores and staff assignments | T2 | P4-05 | security | todo |
| P5-02 | Till link: staff sync and PIN check | T2 | P5-01, P1-02 | security | todo |
| P5-03 | Vape close from the till snapshot | T2 | P5-02 | money | todo |
| P5-04 | LLM gateway: free model first, Claude behind a flag | T2 | P4-05 | security | todo |
| P5-05 | Purchase receipts | T2 | P5-04 | money | todo |
| P5-06 | Receipt test set through both models | T2 + owner | P5-04 | | todo |
| P5-07 | Delivery runs: spec first, then build | T3 | P5-04 | | todo |
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

### P0-02 · Till API contract v1 · T3 · security
**Read:** `docs/adr/0021-till-figures-come-through-an-api.md`; the till
platform's daily report shape (ask the owner for one sample).
**Make:** `ops/contracts/till-api.v1.yaml` (OpenAPI) with five endpoints:

| Endpoint | Returns |
|---|---|
| `GET /ops/v1/staff` | till staff id, name, active, stores |
| `POST /ops/v1/pin/verify` | whether a PIN is right for one person; the till applies its own lockout |
| `GET /ops/v1/shifts?store&day` | each shift: register, opened and closed (time, by whom), float, cash sales, cash refunds, paid in, paid out, expected, counted, variance, **and takings split by cash, credit, debit for that shift** |
| `GET /ops/v1/sales/daily?store&from&to` | per day: net, HST, total, by payment method |
| `POST /ops/v1/proposals` | accepts a proposal for Office approval; returns its id and status |

State in the file: bearer key, read-only apart from proposals, every call
logged by the till, rate limited, money before HST unless a field says total,
times in UTC with the Toronto business day given separately.
**Done when:** the file passes an OpenAPI linter, and the owner has agreed it
with whoever builds P1-02.

### P0-03 · Database schema contract · T3 · money
**Read:** `docs/reference/schema.md`; `docs/architecture/data-model.md`;
ADRs 0004, 0005, 0013, 0014; decision D4.
**Make:** `ops/contracts/schema.sql`: one table per data tab, same column
names. Rules:
- money `numeric(12,2)`; dates `date`; moments `timestamptz`;
- a column that can be "not measured" is nullable and has no default;
- existing text IDs stay as primary keys, so the import is lossless;
- foreign keys for every relation in the data model;
- new tables: `stores`, `staff_stores`, `sessions`, `login_failures`;
- every operational table gets `store_id`, defaulting to the one store;
- `audit_log` can be inserted into, never updated or deleted;
- staging tabs, `pos_extracted` and `clover_batches` are left out.
**Done when:** the file loads into an empty Postgres with no errors, and
every column in `schema.md` is either present or listed in a "left out, and
why" comment at the top.

### P0-04 · RPC contract file · T1
**Read:** `scripts/docs/codemap.js` (it already parses every RPC).
**Make:** `scripts/docs/rpc-contract.js`, `ops/contracts/rpc.json`: for each
RPC its name, parameter names, allowed roles, and whether it needs a session.
**Done when:** the file lists 62 RPCs and matches the RPC table in
`docs/reference/code-map.md`; `npm test` passes.

## Phase 1 — Quick wins on the current app

### P1-01 · Archive old audit-log rows · T2
**Read:** `src/AuditLog.gs`; `src/Setup.gs` (`onOpen` only); ADR-0014.
**Make:** a menu item that moves `audit_log` rows older than a configurable
number of months to an `audit_log_archive` tab, in one read and one write.
Rows are moved, never deleted. Tests in `tests/suites/`.
**Done when:** `npm test` passes; the new assertions were seen failing first;
the docs steps in `AGENTS.md` are done.
**Don't:** change how audit rows are written.

### P1-02 · Till API built · external · security
Lives in the till platform's repository. Implements `ops/contracts/till-api.v1.yaml`.
**Done when:** the shifts endpoint returns one real closed shift whose figures
match the till's own daily report.

### P1-03 · Vape close prefilled from the till · T2 · money
Only if D9 says yes. On the current Apps Script app.
**Read:** `src/Clover.gs` (the pattern to copy: never throws, returns
`{ok:false,error}`); `src/TillSessions.gs` (`close_`); `src/Index.html`
function `openShiftForm`; `docs/components/shifts-and-close.md`.
**Make:** `src/TillApi.gs`; a config flag `till_api_enabled`, default off;
the vape close sheet shows the till's figures prefilled and editable, with a
note of where they came from.
**Done when:** with the flag off nothing changes (existing suites pass
untouched); with it on and the API failing, the close still works by hand;
`npm test` passes with new assertions seen failing first.

## Phase 2 — Foundation

### P2-01 · Scaffold `ops/` and its CI · T1
**Read:** `.github/workflows/ci.yml`, `deploy.yml`, `test-deploy.yml`.
**Make:** the `ops/` layout above with an empty Worker that answers
`GET /health`; a typecheck, a test runner with one passing test; a CI job
that runs both. Add `paths: ['src/**']` to the two deploy workflows so
changes under `ops/` or `docs/` no longer push the current app.
**Done when:** `npm --prefix ops run typecheck` and `npm --prefix ops test`
pass; `npm test` passes; CI is green.
**Don't:** add a framework beyond a small router; add any paid service.

### P2-02 · Migrations runner and first migration · T1
**Read:** `ops/contracts/schema.sql`.
**Make:** `ops/migrations/0001_init.sql` (the contract, verbatim);
`ops/src/db/migrate.ts` that applies numbered files once each, in order, and
records them; a test helper that gives each test file a fresh in-process
Postgres with all migrations applied.
**Done when:** a test creates the database twice in a row with no error and
finds every table from the contract. If the in-process Postgres can't run a
statement in the contract, report BLOCKED with the statement.

### P2-03 · Database, money, date and ID helpers · T2 · money
**Read:** `src/Util.gs`; ADR-0004.
**Make:** `ops/src/db/client.ts`, `ops/src/db/tx.ts` (run a function in one
transaction; lock a row for update); `ops/src/lib/money.ts`, `dates.ts`,
`ids.ts`: the same functions as `Util.gs`, same names where sensible.
**Done when:** unit tests cover every exported function of `Util.gs` with the
same inputs and outputs, including rounding at half cents, the Toronto
business day across midnight and across a clock change, and both ID styles.

### P2-04 · Audit log writer · T1
**Read:** `src/AuditLog.gs`; ADR-0014.
**Make:** `ops/src/lib/audit.ts` with `write({actorId, action, targetType,
targetId, before, after, details})`, usable inside a transaction.
**Done when:** tests show a row is written; an update or delete on
`audit_log` is refused by the database.

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
today. Store a hash of the token, not the token. PINs are stored hashed.
**RPCs:** `rpcLogin`, `rpcLogout` (parity is added for these in P3-01, once
the harness exists).
**Done when:** tests cover: right PIN, wrong PIN and unknown name give the
same message; lockout after the configured failures and release after the
window; rolling renewal past half-life; logout; `requireRole` refusing a
wrong role; a role sent by the client being ignored.

### P2-07 · RPC router · T2 · security
**Read:** `ops/contracts/rpc.json`; `src/WebApp.gs` lines for `_session` and
three sample RPCs.
**Make:** `ops/src/rpc/router.ts`: `POST /rpc/<name>` with a JSON array of
arguments; looks the name up in the contract; applies the session and role
rule from the contract before calling the handler; maps `NOT_LOGGED_IN` and
`FORBIDDEN` to the same error text the UI checks for today. An RPC with no
handler yet answers "not ported".
**Done when:** tests show a role-restricted RPC refuses the wrong role from
the contract alone, with no handler code involved; an unknown name is a 404;
dates in results arrive as ISO strings.

### P2-08 · UI served with the new transport · T2
**Read:** `scripts/docs/screenshots.js` (its `google.script.run` shim);
in `src/Index.html` only the functions `call`, `cachedCall`, `handleRpcError`.
**Make:** `ops/public/transport.js` giving the page a `google.script.run`
that posts to `/rpc/<name>`; a build step that copies `src/Index.html` to
`ops/public/` unchanged apart from loading the transport; the UI suites
(`tests/suites/ui-*.js`) pointed at the copy as well.
**Done when:** the login screen loads from the Worker locally and a login
round-trips; the UI suites pass against both copies.
**Don't:** edit `src/Index.html` by hand in `ops/public/`; it is generated.

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
**Needs from the owner:** a Cloudflare account, an empty database, secrets.
**Make:** a workflow that deploys `ops/` to a staging URL on push to the
working branch, runs migrations first, and never touches production.
**Done when:** the staging URL serves the login page and `/health`; the
report names every paid service this turned on and its expected cost.

## Phase 3 — Port, module by module

Every card in this phase has the same shape. **Make:** `ops/src/modules/<name>.ts`,
`ops/src/rpc/<area>.ts`, tests in `ops/test/`, and the RPC names added to the
parity list. **Done when:** typecheck and tests pass; parity passes for the
RPCs named; the matching suite in `tests/suites/` has been ported assertion
for assertion (list any you could not port, and why).

### P3-01 · Staff, Suppliers, OrderCatalog · T1
**Read:** `src/Staff.gs`, `src/Suppliers.gs`, `src/OrderCatalog.gs`.
**RPCs:** `rpcGetActiveStaffForLogin`, `rpcGetStaffDirectory`,
`rpcGetAllStaff`, `rpcGetSuppliers`, `rpcGetOrderCatalog`, `rpcAddCatalogItem`.
Also add `rpcLogin` and `rpcLogout` from P2-06 to the parity list.

### P3-02 · ProductTypes and ProductMaster · T2
**Read:** `src/ProductTypes.gs`, `src/ProductMaster.gs` (skip
`importFromStaging_`); ADRs 0012, 0015; `tests/suites/shopping-gate.js`.
**RPCs:** `rpcGetProductMaster`, `rpcSearchProducts`, `rpcGetProduct`,
`rpcGetProductCategories`, `rpcGetProductTypeSchema`, `rpcCreateProduct`,
`rpcUpdateProduct`, `rpcDeactivateProduct`, `rpcReactivateProduct`.
**Note:** lists read the core table only; detail loads for one product.

### P3-03 · Product import by CSV upload · T2
**Read:** `src/ProductMaster.gs` (`importFromStaging_` and its helpers);
ADRs 0009, 0010; `tests/suites/import-perf.js`.
**Make:** an upload that takes the same CSV columns as the staging tabs,
validates the header by name, and writes in one transaction.
**RPCs:** `rpcImportProductMasterFromStaging` (same name, takes the file).

### P3-04 · ShoppingList · T2
**Read:** `src/ShoppingList.gs`; `tests/suites/shopping-gate.js`.
**RPCs:** `rpcGetShoppingList`, `rpcAddToShoppingList`,
`rpcEditShoppingListEntry`, `rpcRemoveShoppingListEntry`,
`rpcSetShoppingItemBought`, `rpcClearShoppingList`,
`rpcGenerateShoppingList`, `rpcGetProductsForPicker`.

### P3-05 · Shift core: Attendance, TillSessions, Sales · T2 · money
**Read:** `src/Attendance.gs`, `src/TillSessions.gs`, `src/Sales.gs`
(skip `getDashboard_` and `buildInsights_`); ADRs 0005, 0006, 0008;
`tests/suites/lotto-payout.js`, `sales-cards.js`, `wiring.js`.
**RPCs:** `rpcGetMyShiftState`, `rpcGetBootstrap`, `rpcGetMe`, `rpcOpenShift`,
`rpcCloseShift`, `rpcGetWeekSchedule`, `rpcScheduleShift`,
`rpcCancelScheduledShift`, `rpcAdjustAttendanceHours`, `rpcEditAttendanceTimes`.
**Note:** the three modules call each other; port them together. The close
is one transaction: session, sales row, attendance.

### P3-06 · CashHandling · T2 · money
**Read:** `src/CashHandling.gs`; `tests/suites/cash-handling.js`,
`rpc-guards.js` (cash sections).
**RPCs:** `rpcGetCashPosition`, `rpcRecordCashHandover`,
`rpcVoidCashHandover`, `rpcGetCashOutstandingFor`, `rpcGetCashHandoverHistory`.
**Note:** `record` runs in one transaction and locks the cashier's row first.
Add a test where two handovers for the same person run at once and the
second sees the first.

### P3-07 · Clover and Reconcile · T2 · money
**Read:** `src/Clover.gs`, `src/Reconcile.gs`; ADRs 0004, 0007;
`tests/suites/reconcile.js`, `link.js`.
**RPCs:** `rpcReconcileDay`, `rpcGetReconciliation`.

### P3-08 · Notifier (WhatsApp) · T2 · security
**Read:** `src/Notifier.gs`; `tests/suites/notifier.js`;
`docs/guides/whatsapp-templates.md`.
**RPCs:** `rpcNotifyShiftOpen`, `rpcCheckWhatsApp`.
**Note:** the token comes from a Worker secret. No test may call Meta.

### P3-09 · Payments and Bonuses · T2 · money
**Read:** `src/Payments.gs`, `src/Bonuses.gs`; ADR-0011;
`docs/components/payroll.md`.
**RPCs:** `rpcGetPayrollOverview`, `rpcGetOwedSummary`, `rpcGetMyOwedSummary`,
`rpcPayShifts`, `rpcPayBonus`, `rpcUndoPayment`, `rpcGetPaymentHistory`,
`rpcGetProposedBonuses`, `rpcApproveBonus`, `rpcCancelBonus`, `rpcCreateBonus`.
**Note:** the current app has no payroll suite. Write one first, against the
old runtime, covering oldest-first, overpayment, the mismatch guard and undo;
then port. Each payment is one transaction with a lock on the staff row.

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
**Done when:** run on the fixture workbook, row counts match the workbook.

### P4-02 · Import tool with a rejects file · T2 · money
**Read:** `ops/contracts/schema.sql`; ADR-0004.
**Make:** `ops/tools/import.ts`: loads the export in foreign-key order inside
one transaction; blank becomes `NULL`; any row that fails goes to
`rejects.csv` with its tab, row number and reason.
**Done when:** the fixture imports with zero rejects; a workbook with a
broken row produces exactly one reject and loads the rest.

### P4-03 · Reconcile report · T2 · money
**Make:** `ops/tools/reconcile.ts`: per table and per month, row count and
the sum of every money column, Sheet beside database, with differences.
**Done when:** it reports zero differences on the fixture, and a planted
one-cent change is reported.

### P4-04 · Dry run on a copy of production · T3 + owner · money
Export production, import to staging, run P4-03, explain every difference in
writing. Two people then use staging for a normal day beside the real app.
**Done when:** the owner signs off the reconcile report.

### P4-05 · Cutover runbook, then the switch · T3 + owner · money
**Make:** `docs/guides/cutover.md`: the steps of plan section 6 with the
exact commands, who does each, how long each takes, and the way back.
**Done when:** staff are on the new URL and the first close reconciles.

### P4-06 · Nightly export to a Google Sheet · T2
**Make:** a cron job that writes each table to a tab of a read-only Sheet.
**Done when:** the Sheet's totals match P4-03's database side.

### P4-07 · Retire the Apps Script deploy · T1
Thirty days after the switch. Remove the two deploy workflows; mark `src/`
as archived in `AGENTS.md`; set ADR-0001 to superseded.

## Phase 5 — New abilities

### P5-01 · Stores and staff assignments · T2 · security
**Make:** screens and RPCs to assign a person to stores with a role and
dates; every list and every write filtered by the caller's stores.
**Done when:** tests show a person assigned to store A can neither read nor
write store B through any RPC in the contract.

### P5-02 · Till link: staff sync and PIN check · T2 · security
**Read:** `ops/contracts/till-api.v1.yaml`.
**Make:** `ops/src/till/client.ts` (never throws; returns `{ok:false,error}`);
a link from an Operations person to a till staff id; PIN check delegated to
the till for linked people, with Operations' own PIN for the rest.
**Done when:** tests cover: linked person, unlinked person, till down (the
person can still log in with their Operations PIN if they have one).

### P5-03 · Vape close from the till snapshot · T2 · money
**Make:** at close, fetch the shift from the till, store it as a snapshot
with the time fetched, and prefill the close for the cashier to confirm. A
later difference between the till and the snapshot is flagged, never applied.
**Done when:** tests cover: till figures used; till down, manual entry; till
corrected afterwards, flag raised and pay unchanged.

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

### P5-05 · Purchase receipts · T2 · money
**Make:** photo upload to R2; a draft from the gateway; a review screen where
a person corrects and confirms; posting the purchase in Operations; a
proposal to the till for cost and stock. Record every field the reviewer
changed.
**Done when:** tests show nothing is posted without a person's confirmation,
and a draft whose lines don't add up is marked for attention.

### P5-06 · Receipt test set · T2 + owner
The owner supplies 20–30 real receipts. Run each through both models; report
per model: passed validators, fields a person had to correct, cost.
**Done when:** the owner picks the starting mode from the report.

### P5-07 · Delivery runs · T3
Write the spec with the owner first (who drives, what an order needs at the
door, what counts as delivered). Then split the build into cards.

## Phase 6 — App

### P6-01 · Installable web app · T2
**Make:** a web app manifest, icons, and a service worker that caches only
the app's own files, never RPC answers.
**Done when:** the app installs to a home screen on Android and iPhone, and
a signed-out phone with no network shows the login page, not stale data.

### P6-02 · Store listings: decide · owner
Whether to wrap the app for the app stores (Apple about US$99 a year, Google
about US$25 once; check current terms). If yes, the orchestrator writes the cards.
