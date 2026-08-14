# Changelog

All notable changes to StoreOps are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/), versions `vX.Y.Z`.

## [Unreleased] — v1.0.0

### Foundation (Batch 1)
- Project scaffolding (clasp + git ready)
- `Util.gs` — date, ID, money, shift-time parsing helpers
- `Setup.gs` — 14-tab schema + placeholder rows + menu
- `Staff.gs` — roster CRUD, constant-time login code verification
- `Auth.gs` — token-based sessions, rate-limited login
- `AuditLog.gs` — append-only event log
- `Notifier.gs` — WhatsApp hook scaffold (logs only, ready for future)
- Documentation: README, quickstart, data-model, auth-design

### Shift lifecycle (Batch 2)
- `Attendance.gs` — per-day workday records; openOrPromote, schedule,
  complete (auto from TillSessions), cancel, editActualTimes
- `TillSessions.gs` — per-company reconciliation; open (rejects duplicate
  per company, validates float, auto-creates/promotes attendance), close
  (writes sales, computes variance, auto-completes attendance when last
  session for the day closes), edit (admin override)
- `Sales.gs` — 1:1 with till_sessions; write (idempotent), getDashboard
  (filters + pagination + totals), aggregateByStaffCompany (commission feed)
- `tests/test-cases-batch-1-2.md` — 9-section walkthrough for testing
  setup, auth, full shift lifecycle, edge cases, idempotency, audit log

### Payments + Commissions (Batch 3)
- `Payments.gs` — split into two flows: `payShifts` (chronological
  allocation against unpaid attendance, oldest first, partial supported,
  overpayment rejected) and `payBonus` (settle one bonus, partial
  supported, overpayment rejected). Also `undo`, `undoLastForStaff`,
  `getOwedSummary` (computes shifts owed + pending bonuses).
- `Bonuses.gs` — already in place from earlier work; doc comments
  updated to reference new payment API.
- `CommissionRules.gs` — CRUD for commission rules (create, update,
  deactivate, getRulesFor staff+company+date).
- `Commissions.gs` — weekly commission engine: walks rules, aggregates
  sales by (staff, company), proposes bonuses for sales above threshold,
  writes commission_runs row with totals. Idempotency check prevents
  duplicate runs. Includes time-driven trigger management:
  `installWeeklyTrigger` (Monday at configured hour), `removeWeeklyTrigger`,
  `isTriggerInstalled`. Top-level `commissionsTriggerHandler` is the
  function the trigger fires.
- `Setup.gs` — menu updated with three new items:
  - Run Commission Engine (last week) — manual trigger
  - Install Weekly Auto-Trigger
  - Remove Weekly Auto-Trigger

### Web UI (Batch 4)
- `WebApp.gs` — RPC layer (29 endpoints) with role guards on every
  write. `doGet` entry point serves `Index.html`. Pre-auth RPCs
  (`rpcGetActiveStaffForLogin`, `rpcLogin`, `rpcLogout`) accept no
  token; everything else validates the session and enforces roles.
- `Index.html` — single-page app with bottom tab navigation:
  - **My Shift** — card-based (cstore + vape) dashboard, status pills,
    open/close modals with live variance preview, recent shifts list
  - **Schedule** — weekly grid, swipeable nav, click-to-edit cells
    (admin/manager only), today highlighted
  - **Payroll** — total owed dashboard, per-staff cards, "Pay Full"
    one-tap + custom-amount partial with progress bar, proposed
    commissions panel for admin approval, pay individual bonuses
  - **Sales** — filterable + paginated dashboard with totals strip
  - **History** — payment list with item drill-down, admin can undo
- Role-based tab visibility:
  - Employee: My Shift + Schedule (read-only) + History (own only)
  - Manager: + Schedule (edit) + Sales
  - Admin: + Payroll + History (all + undo)
- Session: `localStorage` remembers last name, `sessionStorage` holds
  token (24h rolling). Refresh recovers state.
- `tests/manual-ui-test-guide.md` — 9-section walkthrough of the real
  UI like a real user (no Apps Script editor needed)

This completes v1.0.0.

### Product Master + reconciliation upgrades (Batch 5)
- `ProductMaster.gs` — thin core product catalog (identity + resolved
  cost/sell/margin) with chunked `CacheService` reads, dedup on
  sku(+unit), and an import pipeline from per-type staging sheets.
- `ProductTypes.gs` — per-type (beer / cigarettes / vape) registry:
  detail sheet + columns, `derivePricing`, `validate`, UI field schema.
  Grocery/other are core-only.
- `Setup.gs` — adds `product_master` + per-type detail sheets, 4
  per-type import staging tabs, and menu items to import each type and
  to migrate an existing flat `product_master` to the per-type layout.
- `ShoppingList.gs` — adding an entry now resolves the product from
  Product Master (single source of truth for name/category/unit/cost)
  instead of free-text entry; `shopping_list` gains a `product_id`
  column.
- `Index.html` — new **Product Master** tab (search, create, edit,
  deactivate, per-type pricing form with live margin preview).
- `Attendance.gs` — `hours_basis` column + `adjustHours` (pin recorded
  hours to the scheduled window or the actual open→close span).
- `Payments.gs` — `payShifts` now blocks on unreconciled scheduled vs.
  actual hours mismatches, with an explicit override that pins the
  affected shifts to actual hours before paying.
- `Reconcile.gs` — validation_results gains `cash_sales`; adds a
  reported-vs-expected total sales check against Clover when available.
- `Sales.gs` — dashboard results include a per-day aggregation (feeds
  the sales dashboard's daily breakdown).
- `scripts/import_product_master.py` + `references/*.xlsx` — Excel →
  staging-CSV pre-processor and its source pricing sheets (beer,
  cigarettes) for the Product Master import.

### Mobile: stop the constant re-logins, faster Shopping List (Batch 6)
- **Sessions now persist.** The token moved from `sessionStorage` to
  `localStorage`. `sessionStorage` dies with the browser tab — which
  mobile browsers discard aggressively — so staff were re-entering their
  PIN constantly even though the server session is valid for 24h and
  auto-renews. Logging in is now a roughly once-a-day event. Logout
  still clears the device.
- **Product Master no longer loads at login.** `prefetchTabs()` was
  fetching the entire catalog (up to 500 products × 24 fields) for every
  role on every app open, including staff who only use the shopping
  list. It is now warmed when the Shopping List tab is opened instead.
- `WebApp.gs` — new `rpcGetProductsForPicker`: an 8-field projection for
  the add-item picker (drops notes, source file, audit columns and the
  derived sell/margin numbers it never showed). The Products tab still
  uses the full `rpcGetProductMaster`.
- **One-tap adding.** The add-item flow was a search sheet plus a second
  quantity sheet — three taps per item, closing fully after each one.
  It is now a single sheet that stays open: tap `+` to add at qty 1, and
  the row becomes a `[− qty +]` stepper. Writes are optimistic and
  debounced (600ms), so repeated taps collapse into one call, and are
  chained per product so an add resolves before a following edit. Adds
  category quick-filter chips.
- **Removing is instant with Undo** instead of a blocking `confirm()`,
  and `✕` / `✎` are now 44px tap targets. `toast()` gained an optional
  action button to carry the Undo.
- Shopping list and picker get their own `@media (max-width:560px)`
  rules — previously only the sales/reconciliation tables were tuned for
  small screens.

### Close-shift input fixes + daily Lotto Reserve log (Batch 7)
- **Amount fields no longer edit themselves.** Every money input in the open
  and close shift sheets was `<input type="number">`, which renders a spinner
  and — the actual bug — responds to the **scroll wheel** while focused, so
  scrolling a long close sheet silently rewrote amounts (one field was found
  sitting at `-0.02`). They are now plain text with `inputmode="decimal"`, so
  phones still get the numeric keypad. New `moneyInput()` / `wireMoneyInputs()`
  helpers in `Index.html` also **clear a field on focus** instead of making you
  select the pre-filled `0` first, strip anything that isn't a digit or a
  single `.`, and restore the resting value on blur — so a field left untouched
  still reads and submits as `0`, exactly as before.
- **Cashback is retired from the close sheet.** The store no longer pays
  cashback, so the field was one more box to tab past on every close. New rows
  write `0`; the `cashback_paid` column and every calculation that reads it
  stay, so historical sessions still recompute correctly.
- **Lotto reserve is now tracked daily.** On heavy lotto days the payouts
  exceed what the drawer has taken, so cashiers pay winners out of a separate
  pot kept in the store. Nothing recorded that pot. The CSTORE close sheet now
  asks for the reserve counted — pre-filled with the **last known balance**, so
  a blind submit records the truth rather than an optimistic $500.
- **The extra reserve fields only appear when they mean something.** A normal
  close, with the pot untouched at $500, shows neither. The *reason* field
  appears once the closing balance isn't the expected one, and is required from
  then on.
- **Refilling the pot is a button, not a sum to work out.** When a previous
  shift left the pot short, the close sheet offers *"Move $300.00 from till
  into reserve"* — one tap, stating the amount, with an editable field
  appearing only if a different amount actually moved. It shows as soon as
  there's a deficit rather than waiting for the drawer count, and caps itself
  once that count exists, saying so — *"Pot is $300.00 short, but only $150.00
  is spare above the $250.00 float"* — instead of quietly offering less. The
  transfer is opt-in: nothing is recorded as moved until the button is tapped,
  because a pre-filled amount recorded cash leaving a drawer that may never
  have been opened.
- **The offer is capped by what the pot is actually missing.** It was capped
  only by the carried deficit and the spare cash, so hand-correcting the count
  to $500 still moved another $300 in — closing at $800 and then demanding a
  reason for it. Correcting the count now withdraws the offer instead.
- **"Reserve counted" is the pot as you count it**, before moving anything in;
  the closing balance is derived as `counted + moved in` and shown in the
  summary. The form previously wrote a computed value back into that field,
  which fed back into itself and made a wrong figure impossible to spot.
- **A payout made during the current shift is deliberately not offered a
  transfer.** The POS cash figure is already net of it, so the drawer is short
  by that amount already — refilling the pot at close is a wash, and recording
  it would take the same money off the banked cash twice. Only a deficit
  carried in from a previous shift can be moved, and it caps the offer.
- **The close sheet states the balance it is working from** — *"Reserve was
  $200.00 at close on Aug 12"*. The top-up row had been silently suppressed by
  a stale cached balance with nothing on screen to explain it; its visibility
  no longer depends on anything the cashier can't see. The float value is now
  handed over from the card that rendered the Close button, so an in-flight
  fetch can't suppress the row either.
- Closing or opening a shift refreshes shift state with `force`. Without it the
  next close sheet could read a `TTL_LIVE` cache up to 60s old and pre-fill the
  reserve from pre-close state — the cause of the missing row.
- **The last known balance is now looked up directly, not through the log.** It
  came from the newest entry of the 14-day reserve log, so it inherited every
  way that list can come up empty — and the close sheet then announced *"no
  previous count on record"* and assumed a full pot, which silently zeroes the
  carried deficit and makes the top-up row unreachable. `lastReserveCount_`
  scans closed cstore sessions directly, with no date window: the pot's last
  count predates any window after a quiet fortnight, and the balance shouldn't
  depend on how far back a list happens to show.
- **The balance chains shift-to-shift, not day-to-day.** Ordering is by
  `end_time`, so a shift that runs past midnight is placed by when it actually
  closed, and a second cashier the same day inherits what the first one left.
  Equal keys tie-break on sheet row: rows are appended in the order they
  happen, and a stable sort was otherwise handing back the *older* of two
  shifts that closed in the same minute.
- **A blank reserve cell is no longer read as `$0.00`.** Sessions closed before
  the migration have no reserve recorded at all; as the newest row, one would
  have reported the pot as empty. They're skipped — by the balance lookup and
  by the log — so "never counted" stays distinct from "counted zero".
- **Date cells are parsed, not discarded.** `rowToRecord_` kept a date only if
  the cell was already a `Date`, so a column formatted as plain text turned
  every session into one with no date — and every date-range query drops those.
  That empties the reserve log and Recent Shifts together, with nothing to
  explain it. Strings are now parsed (a bare `yyyy-MM-dd` at local midnight, so
  it can't slip to the previous day). Closed-status checks are
  case-insensitive, for sheets edited by hand.
- `getForDateRange` end bounds use `Util.endOfDay`. Passing midnight meant any
  date cell that read back with a time component — which happens whenever the
  spreadsheet's timezone differs from the script's — dropped today's sessions
  from the reserve log and from Recent Shifts.
- **Config keys reach sheets that already exist.** `setupConfigSheet_` returns
  early on an existing config tab, so every key added after a spreadsheet was
  first set up — `lotto_reserve_default` among them — never landed in it, and
  the code ran on its in-code fallback with nothing to edit. New
  **StoreOps → Sync config keys** appends whatever is missing, leaving existing
  values alone; First-time Setup and the lotto migration both call it, so the
  one click that turns lotto on also puts its $500 in the config tab.
- `open_` leaves the lotto columns blank for non-CSTORE rows instead of writing
  `0`, which made vape sessions look like they had a reserve.
- **One shift per person per till per day is now enforced at open.** The
  session id is derived from (date, staff, company), so a second open wrote a
  duplicate id; closing it resolved to the first row, found it already closed,
  and refused — leaving a session stuck `open` for ever, which then blocked
  *everyone* from opening that till. It's rejected up front instead, naming the
  existing session.
- `TillSessions.gs` — `till_sessions` gains `lotto_reserve_counted`,
  `lotto_topup_from_till` and `lotto_reserve_note` (cols 19-21). **The reserve
  never affects the till variance.** Payouts came out of the pot, not the
  drawer, and the POS cash figure is already net of them. A refill happens
  after the drawer has been counted and reconciled, so the top-up comes off
  `cash_removed_at_close` — the takings banked — and leaves `expected_cash`
  alone. `getLottoLog()` returns the last 14 days for the UI.
- **My Shift** shows the current balance on the CSTORE card (with a "short $X"
  marker) plus a collapsible reserve log — visible to every role, since any
  cashier who might pay out of the pot needs to know what's in it.
- `Setup.gs` — new `lotto_reserve_default` config key and a one-shot
  **Add lotto reserve to till_sessions** migration for existing sheets.
  Until it runs, `getAll_` reads only as wide as the sheet actually is and the
  lotto UI stays hidden, so the code is safe to deploy before the migration.
- Vape close is unchanged, and lotto never reaches the `sales` sheet — a
  payout is not a sale, and mixing it in would corrupt commissions and the
  Clover reconciliation.
