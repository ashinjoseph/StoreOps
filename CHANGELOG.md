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
- **The close sheet says where the counted cash goes.** The drawer is counted
  once and then splits three ways, but the summary stopped at the count — so on
  a refill day the banked figure quietly dropped by the transfer with nothing on
  screen to account for it. A new line reads *"$250.00 float · $300.00 reserve ·
  $100.00 banked"*, and flags itself if a hand-typed transfer would bank a
  negative. **The variance math is unchanged**: the drawer is counted before the
  cash moves, so `expected = opening + sales` measured against that count stays
  the honest reconciliation, and `cash_removed_at_close` already nets the
  transfer out.
- **The reconcile WhatsApp carries the reserve every day**, not only when
  something moved — a balance nobody can see is a balance nobody checks. The
  cash block gains the same destination line, and the pot gets its own:

  ```
  💵 *Cash - recorded / counted*
  $650.00 / $650.00   var +$0.00
  ↳ float $250.00 back · reserve $300.00 · banked $100.00

  🎟 *Lotto reserve*   $200.00   ⚠️ short $300.00
  ↳ 400 paid
  ```

  A short pot carries the cashier's own reason, which is the only thing that
  explains it to whoever reads the message. `whatsapp_template_shift_close` is
  approved at Meta with exactly nine parameters, so the reserve rides inside the
  existing cash parameter rather than taking a tenth — nothing needs
  re-approving, and it works the moment it deploys.
- The reserve balance is read once per reconcile from `getLottoLog`, not summed
  across the day's sessions: the top-up is a flow and adds up, but the pot is a
  balance and doesn't. It attaches only to the merchant group that holds cstore.
- `shift.closed` audit lines name the reserve and any transfer, so the log reads
  without opening the sheet.
- `Setup.gs` — new `lotto_reserve_default` config key and a one-shot
  **Add lotto reserve to till_sessions** migration for existing sheets.
  Until it runs, `getAll_` reads only as wide as the sheet actually is and the
  lotto UI stays hidden, so the code is safe to deploy before the migration.
- Vape close is unchanged, and lotto never reaches the `sales` sheet — a
  payout is not a sale, and mixing it in would corrupt commissions and the
  Clover reconciliation.

### Cash handling — the other half of the drawer (Batch 8)
- **Cash that leaves the drawer is now tracked to the person carrying it.**
  Every close already computed `cash_removed_at_close` — the count, less the
  float that stays for tomorrow, less anything moved into the lotto reserve —
  and then forgot about it. That is real money in someone's pocket, and the
  business had no answer to *how much of our cash is out with staff right now,
  and with whom*. It accumulates against the cashier, shift by shift, until a
  handover discharges it.
- **A handover names who recorded it, and that line is never hidden.** There is
  deliberately no confirm step: either the cashier or the cash manager records
  the movement and it takes effect immediately. What makes it trustworthy is
  attribution — *"recorded by Jaigy · 8:02 PM"* sits on every row in both views,
  uncollapsed, because with no handshake that line **is** the acknowledgment.
  When one person says they handed cash over and the other says they didn't, the
  tab is the record.
- **Handovers settle specific shifts, oldest first.** A partial handover fills
  each session before moving to the next, so "which shift's cash is still out"
  has an answer rather than just a total. The split is previewed live in the
  sheet as the amount is typed — visible *before* submitting, not discovered
  afterwards. Same walk `payShifts` uses against unpaid attendance.
- **Handing over less than the full balance requires a reason**, and the reason
  field only appears once the amount is short — the show-on-need rule the lotto
  reserve reason already follows. Handing over *more* than the balance is
  refused with the real figure named, which is what keeps a balance from going
  negative.
- **A void keeps the row.** `Payments.undo` deletes; this doesn't. The status
  flips to `voided`, the allocation reverses because voided rows stop counting,
  and the mistake stays legible with who made it. A ledger that exists for
  conflict review can't quietly delete its own evidence.
- **The reserve was already accounted for, and still is.** The lotto top-up
  comes off `cash_removed_at_close` and nothing else, so a refill day leaves the
  cashier carrying $100 instead of $400 while `closing_variance` stays $0.00. A
  payout made during the shift never enters the arithmetic at all — it came out
  of the pot, and the POS cash figure is already net of it. **No close maths
  changed in this batch.**
- **A short drawer is not a credit.** If a count comes in under its own float,
  `cash_removed_at_close` is negative; those sessions are skipped rather than
  summed. Adding them would let a till shortfall quietly *reduce* what a cashier
  owes, turning a loss into a discount — and `variance_status` already handles
  shortfalls. Unlikely in practice, since the reserve exists for exactly that
  case, but cheap to guard.
- **"Banked" is now "in hand"**, on the close summary, in the reconcile message
  and on the close notice. It was never banked — it is being carried until
  someone hands it over. One word for one thing, in all three places it is read.
- `shift.closed` notices name it too: *"closed cstore shift, $0.00 variance,
  lotto reserve $500.00 (+$300.00 from till), $100.00 in hand"* — guarded like
  the reserve clause, so a close that took nothing out stays silent about it.
- **My Shift shows what you're carrying** with a tap through to the tab, so the
  balance is discovered rather than hunted for in the More drawer.
- The cash manager is **one named person in config** (`cash_manager_staff_id`),
  not a role and not hardcoded. When he works a shift himself he holds that
  shift's cash like anyone else and records a handover to himself — `from == to`
  is an ordinary row, and his own balance sits above the roster so he can't scan
  past it.
- Cash still out after `cash_handover_stale_days` (default 7) is flagged in its
  own block on the manager's view — a thing to act on, not a badge to scan for.
- `Setup.gs` — new `cash_handovers` + `cash_handover_items` tables and a
  **Add cash handling tables** migration. Until it runs, `sheetsExist_()` is
  false, every RPC returns `{enabled:false}` instead of throwing, and the tab
  hides itself — so this deploys safely ahead of the click.
- Privilege is resolved server-side from the session, never from the client: an
  employee gets their own balance and nothing else, and asking
  `rpcGetCashHandoverHistory` for someone else's rows quietly returns their own.

### Reconcile message rebuilt on 13 parameters (Batch 8)
- **The nine-parameter template is replaced by `shift_close_v2`.** Parameter 5
  had become a dumping ground — cash recorded/counted, the variance, the
  destination split and the whole lotto reserve were crammed into one value,
  because the approved template had no room for a tenth. That produced exactly
  the line nobody could read. Thirteen parameters now carry one fact each and
  the template owns the layout.
- **Two facts the message never carried:** who worked the till (`{{4}}`), and
  who is carrying the day's cash (`{{8}}`) — the latter naming both today's
  takings per person and how much is still out across the business, with a
  flag when anything has been held past `cash_handover_stale_days`. Today's
  movement and the standing balance answer different questions, so both appear.
- The cash variance now carries its own ✅/⚠️ mark rather than sitting bare, and
  the Clover-unavailable status says what it cost you — *"cards not verified"* —
  instead of just naming the outage.
- Parameter 9 reads `not tracked on this till` for a vape-only day or a
  pre-migration sheet. A fixed template can't drop a section the way the plain
  text does, so it says so rather than sending a bare dash.
- `docs/whatsapp-template-shift-close.md` — the body to paste into Meta, sample
  values taken from real harness output, the good-day/bad-day shape of every
  parameter, and the structural rules the layout satisfies (no leading or
  trailing variable, no two variables adjacent — which is why `Result:` sits in
  front of `{{13}}`).
- Deploying before the new template is approved costs the message, not the
  data: Meta rejects the send on a parameter-count mismatch, `dispatch_` mutes
  it, and the reconciliation still runs and still writes its row.
- **"All matched" now checks the cash too.** The status tested the card
  difference *only*, so a drawer $40 short still reported ✅ All matched as long
  as Clover and the cashier agreed on cards — the one line most people read,
  saying the one thing it hadn't checked. It now fails on either and names
  which: *"⚠️ cash short $40.00 · cards off $12.00"*. The `{{5}}` total-sales
  difference is deliberately left out of the roll-up: it is a derived
  cross-check that already contains the cash variance, and folding it in would
  flag the same shortfall twice.
- **Cash in hand names people.** *"$1240.00 still out with 2 people"* said there
  was something to chase without saying who to chase. It lists holders by name
  with their balances, and falls back to today's takings marked `(today)` where
  the cash handling tables aren't set up yet.
- The cards block is labelled `Clover / cashier` so the two figures in each row
  are identified rather than inferred.
- **One sign convention across the whole message.** Every line now reads
  *claimed / measured (var = measured − claimed)*, so negative always means
  less is there than was claimed. Total sales was subtracting the other way, so
  a $40 short drawer read `+$40.00` on one line and `cash short $40.00` two
  lines below — the same event with opposite signs, which reads as a
  contradiction rather than a reconciliation. Cards had the same inversion
  hidden differently: displayed `Clover / cashier` but differenced
  `cashier − Clover`. Both are realigned; the stored `card_variance` column
  keeps its original direction so the sheet doesn't change meaning halfway
  through its history.

### Sales and Reconcile split, plus a report anyone can open (Batch 9)
- **Sales and Reconcile are two tabs now.** A reconciliation panel was pinned to
  the top of the sales dashboard, so neither could grow: Sales couldn't gain the
  trend work below, and Reconcile couldn't become the daily-control view it
  wanted to be. They answer different questions on different cadences.
- **The reconcile table stops mixing units.** It read `Cash Δ` beside absolute
  `Card` and `Clover` — a delta and two levels in one row, with nothing to
  compare across. Cash and cards now both read *claimed / measured (var ±$X)*,
  the same convention the WhatsApp message uses, and a harness asserts the two
  produce identical figures **including sign** so they can't drift apart again.
- **Four insights on the Sales tab**, each answering something a corner store
  actually acts on:
  - **Trend** against the previous equal-length window, with a 7-day rolling
    average so a noisy Tuesday doesn't read as a decline.
  - **Part of month** — days 1-10 / 11-20 / 21-end, which is where the payday
    and cheque cycles show up.
  - **Day of week**, naming the busiest and quietest, so staffing can follow the
    real week.
  - **Cash share of takings**, and whether it's drifting — the number that
    decides how much float is needed and how much ends up in someone's hands.
- **Averages divide by days that traded, not calendar days.** A week the shop
  was shut would otherwise read as a collapse in trade rather than an absence of
  it, which is the same arithmetic mistake that makes seasonal businesses look
  like failing ones.
- **Short ranges say so instead of drawing a line.** The rolling average needs 7
  days and the month split needs a full month; below that the block explains why
  it's empty. A trend line through three points looks exactly as authoritative
  as one through ninety.
- **Percentage-point changes are labelled as points.** Cash share moving 50%→60%
  reports `+10 pts`, not `+20%` — the classic way this number gets published at
  twice its real size.
- **A 7-day report anyone can open, no login.** `?v=recon` on the deployment URL
  serves a read-only page: who is carrying cash and how much, how the lotto pot
  moved day by day with the cashier's reasons, and whether each day reconciled.
  The reconcile WhatsApp links to it, so checking a figure no longer means
  finding a PIN.
- The report's data is **inlined into the page at render time**, so serving it
  creates no RPC reachable without a session — the only thing exposed is one URL
  returning one document. Each section is wrapped: a sheet that hasn't run a
  migration reports that section unavailable rather than failing the page, and a
  failed build never puts a stack trace in front of an anonymous visitor.
- The link is a **static URL button** on the template, not a 14th body
  parameter — so it rides the same Meta submission instead of costing a second
  approval, and `Notifier` needs no change to send it. Blank
  `public_report_url` sends no link rather than a dead one.
- `doGet` routes on `?v=`; an unknown value falls through to the app so a
  mangled link lands somewhere useful. `?days=` is clamped 1-31, and coerced
  before clamping — `Number('abc')` is `NaN`, which survives both `Math.max` and
  `Math.min` and would have rendered an empty report.
- Fixed: the insights baseline window stepped by milliseconds, and callers pass
  an end of `23:59:59`. That put `prevStart` a second after midnight and dropped
  any row stamped at exactly midnight — which is how every date in the sheet is
  stored. It steps whole days by date component now, which is also correct
  across a DST boundary where 86400000ms is not a day.
- `Setup.gs` — new `public_report_url` config key. The report needs the
  deployment set to *Execute as: Me* / *Anyone*; a console setting, not code.

#### Fixed after the first test deployment

Three defects that only a live deployment could surface — all of them in the
wiring between layers, which is exactly where the module-level harnesses do not
look.

- **The public report showed nothing at all.** `Public.html` inlined its payload
  with `<?= ?>`, the *escaping* scriptlet, so the JSON arrived contextually
  escaped and `DATA` parsed as a string. Every property read came back
  `undefined`, and the page rendered as three "unavailable" cards — a failure
  that looks like a built page rather than a broken one. Now `<?!= ?>`, with
  guards on each section so a genuinely missing one costs a card and not the
  document.
- **The sales insights never arrived.** `rpcGetSalesDashboard` re-shapes the
  dashboard result by hand (`totalCount` → `rowCount`), and the hand-written
  projection silently dropped `insights` — computed on every request for the
  whole of the first deployment, then thrown away one line before the client.
- **The default range hid an insight it was meant to show.** Time-of-month
  suppresses below 28 trading days, so a fortnight default guaranteed that card
  read "needs a full month" on every first load. The default is 30 days, chosen
  so all four cards have enough behind them to say something.
- A `wiring` suite now covers both seams: the dashboard RPC must forward every
  field the UI reads — discovered from `Index.html` rather than hardcoded, so a
  new `data.foo` fails until the RPC sends it — and `Public.html` must inline
  its payload unescaped. Both assertions were confirmed to fail against the
  original code before being kept.

#### Read-path performance, once real data was in (Batch 10)

The app felt slow after the catalog went from 152 to 374 products. The rendering
was not the problem — the picker caps at 40 rows and the Products tab at 200.
Every cost was a sheet read.

- **`Sales` had no row cache.** `getAll_` re-read the entire sheet on every call,
  and one dashboard load calls it twice: once for the visible range, once inside
  `buildInsights_` for the baseline window. Every other module already solved
  this — `TillSessions._tillCache`, `CashHandling._handoversCache` — so Sales now
  carries the same per-execution cache. Measured: 2 full reads per dashboard load
  down to 1.
- **Adding that cache created a trap, so it is tested.** `write_` ends by
  re-reading through `getForSession_` to return the saved row; against a warm
  cache that returns the *pre-write* record, or nothing at all for a new row. The
  write busts the cache, and three assertions fail if that bust is ever removed.
- **The import re-read `product_master` twice per created row** — once to dedup,
  once to return the created record — against a catalog growing as it ran.
  Measured on 222 rows: **667 full reads**. It now keeps its own name index,
  updates it as rows are created, and busts the cache once at the end: **1 read**,
  with identical insert/skip results and in-paste duplicate handling unchanged.
- **The sales default window was decided by a race.** `prefetchTabs` and
  `loadSalesTab` both seeded `state.salesFilters` — the same object — with
  different windows, so whichever fired first won, and prefetch (1.2s after
  login) usually did. That quietly capped the range at 7 days and kept the
  time-of-month card permanently below its 28-trading-day floor. One
  `seedSalesFilters_` now serves both, at 60 days, which clears every insight
  threshold with margin.
- `perf` and `import-perf` suites assert the shape of the cost — reads staying
  constant as the batch grows — rather than a wall-clock number, so they stay
  meaningful anywhere. Both were confirmed to fail against the previous code.
