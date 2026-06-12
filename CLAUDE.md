# StoreOps — Claude project context

Auto-loaded by Claude Code on every conversation opened against this repo. Keep this file lean; deep walkthroughs live in linked docs.

## Project overview

- **Stack**: Google Apps Script (GAS, V8 runtime) backend + Google Sheets as the database + a single vanilla-JS SPA frontend in `Index.html`.
- **Domain**: retail store operations for two companies (`cstore` = convenience store, `vape` = vape shop). Modules cover staff roster, attendance, till sessions, sales aggregation, payments, bonuses/commissions, reconciliation, inventory and supplier directory.
- **Timezone**: `America/Toronto` for every date format/parse — never assume UTC.
- **Money**: stored as plain `number` (dollars). Always pass through `Util.roundMoney_` on write and `Util.moneyEquals_` on compare.
- **Deployment**: CLASP — config in `.clasp.json`, manifest in `appsscript.json`. `clasp push` uploads, the webapp deployment serves `doGet` from `WebApp.js`.

## Repository layout

All source files sit flat at the project root (GAS does not support folders).

| Role | Files |
|---|---|
| **HTTP/RPC entry** | `WebApp.js` (doGet + every `rpc*` function) |
| **Infra** | `Auth.js` (sessions, tokens, role guards), `Util.js` (dates/IDs/money — no sheet access), `AuditLog.js` (append-only event log), `Setup.js` (schema, menus, first-time setup) |
| **Frontend** | `Index.html` (single-page app, ~3,300 lines, no framework) |
| **Domain — payroll/sales** | `Staff.js`, `Attendance.js`, `TillSessions.js`, `Sales.js`, `Payments.js`, `Bonuses.js`, `CommissionRules.js`, `Commissions.js`, `Reconcile.js` |
| **Integrations** | `Notifier.js` (WhatsApp push), `Clover.js` (POS stub) |
| **Catalog/orders** | `OrderCatalog.js`, `ShoppingList.js`, `Suppliers.js` |

Setup.js owns the canonical list of sheet tabs in the `SHEETS` constant (17 tabs total).

## Architecture invariants — read before editing

1. **Modular monolith, IIFE per file**: `const ModuleName = (() => { ...; return { publicApi }; })();`. Private helpers end with `_`. Never expose `_`-suffixed functions in the return object.
2. **Sheets are the database** — there is no external DB. Each domain module owns exactly one sheet tab.
3. **Column mapping is fragile**: every module declares
   ```js
   const COL = { field_name: 1, /* 1-indexed */ };
   const NUM_COLS = N;
   const DATA_START_ROW = 3;   // row 1 = title, row 2 = headers, row 3+ = data
   ```
   Adding a column means: update `Setup.js` headers, update `COL`, update `NUM_COLS`, update `rowToRecord_`, update every writer.
4. **`rowToRecord_(row, rowIndex)`** converts a sheet row array into a camelCase object and attaches `_rowIndex` for in-place updates. Coerce types explicitly (Dates stay Date, numbers via `Number(...)`, booleans via strict comparison).
5. **Caching is explicit**: writers must call the module's own `bustCache_()`. There is no auto-invalidation. Reads that bypass cache must be deliberate.
6. **Audit logging is mandatory**: every write path calls
   ```js
   AuditLog.write({ actorId, action: 'domain.verb', targetType, targetId, before, after });
   ```
   The audit_log sheet is the compliance trail.
7. **Auth is server-side, every time**: every RPC starts with
   ```js
   const session = _session(token);
   Auth.require(session, ['admin', 'manager']);
   ```
   Roles: `admin`, `manager`, `employee`, `payroll_admin`. Companies: `cstore`, `vape`. Never trust a client-claimed role.
8. **IDs**: `Util.newId_(prefix)` for random sortable IDs. For records that must be safely re-importable (attendance, till sessions), use the deterministic helpers `attendanceId_(date, staffId)` / `tillSessionId_(date, staffId, company)`.
9. **Dates/money**: always `Util.formatDate_`, `Util.formatDateTime_`, `Util.roundMoney_`, `Util.moneyEquals_`. Never `===` on money floats.

## RPC convention

```js
function rpcActionName(token, input) {
  const session = _session(token);
  Auth.require(session, ['admin', 'manager']);
  return Module.action(input, session.staffId);   // plain JSON-serializable object
}
```

Throwing **is** the error channel — the frontend treats `withFailureHandler` as the failure path. Don't swallow exceptions in the RPC.

## Frontend contract

- `Index.html` is one large vanilla-JS SPA — no framework, no build step.
- Backend calls go through `google.script.run.withSuccessHandler(...).withFailureHandler(...).rpcXxx(token, payload)`.
- Session token is cached in `localStorage`. Pre-auth RPCs (`rpcLogin`, `rpcGetActiveStaffForLogin`, `rpcLogout`) accept a missing/invalid token.
- Money is rendered with tabular-nums CSS and the `formatMoney` helper already in `Index.html` — reuse it, don't reformat by hand.

## Configuration & sessions

- The `config` sheet is a key/value store (row 3+). Examples: `cstore_default_opening_float`, `variance_ok_threshold`, `commission_run_hour`, `notifier_enabled`. `Auth.js` caches it for 5 minutes.
- Sessions live in `PropertiesService` under key `session:<token>`. Login failure rate-limiting uses `loginFails:<staffName>`.

## Workflow tips

- **No automated tests**. Validate by pushing with CLASP, exercising the deployed web app, and reading the Apps Script execution log. `console.error` is your debugger.
- **Schema changes**: edit the relevant `createXxxTab_()` in `Setup.js`, then re-run "⚙️ First-time Setup" from the spreadsheet menu (or `resetDataTables()` for a clean wipe).
- **Weekly automation**: `Commissions.js` installs a Monday trigger; admins manage it via the spreadsheet menu (🗓️ Install / 🛑 Remove).

## Adding a new feature

See [`ADDING_FEATURES.md`](./ADDING_FEATURES.md) in this directory for the step-by-step playbook (schema → module → RPC → audit → frontend → checklist).
