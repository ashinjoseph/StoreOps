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

### Sales split by company, without losing the consolidated view (Batch 11)

85 days of production data (262 sessions, 84 trading days, $182,383) showed the
two tills barely move together — **daily correlation 0.36**, and only **0.26**
once the shared Mon–Sun rhythm is removed from both series, so a quarter of even
that was the weekly cycle rather than the two tills responding to the same
customers. Vape's share of the day swings between 2.7% and 26.7% around a 12.0%
median, so at 12.7% of revenue a 25% move in vape shifts the combined line about
3%: invisible on the only chart that existed.

They differ structurally too, not just in size — cstore takes **50.4% of its
revenue in cash against vape's 30.7%**. That is a real difference in cash
exposure, though it is not what makes cstore 92% of the cash removed at close:
cstore is 87.3% of revenue, and the mix difference accounts for only about
4.6 points of the gap.

- **A segmented All / Cstore / Vape control** on the Sales tab, defaulting to
  All so the consolidated view stays the landing page. It replaces the company
  dropdown rather than joining it: two controls driving one filter disagree the
  first time only one is set, and the toggle applies immediately while the
  filter card waits for *Apply*.
- **Insight cards carry a cstore/vape strip**, so the comparison is visible
  without switching views. Suppressed when filtered to a single company — a
  side-by-side of one is a fact with extra furniture.
- **Per-day totals are rendered once.** The tab drew a bar chart of daily totals
  and then an accordion repeating the same dates and totals underneath. The bars
  are now the only place those numbers appear, and remain the day selector; the
  session drill-down opens beneath the chart for the selected day.
- **Bars are stacked by company**, cstore base and vape on top, so the
  consolidated chart answers "how did we do" and "which side of the business did
  it" at once. Each day's segments are asserted to sum to its bar.
- **The same toggle on Cash Handling**, splitting what each person holds. It is
  a *view* filter and never a settlement one: recording a handover still walks
  that person's shifts oldest-first across both tills, and a test asserts the
  allocation crosses companies (`cstore → vape → cstore`) rather than draining
  one. Filtering the view while settling only that company would age cash
  silently in the till nobody was looking at.
- All of it is computed from rows already loaded, so `getDashboard` still costs
  the single sheet read the previous batch got it down to.

#### Corrected while building this

An earlier pass reported Saturday as the best weekday with a 77% spread. That
was averaged **per session** — "which shift is busiest" — not per trading day,
which is what the dashboard computes and what the business question actually
is. Per trading day, **cstore peaks Friday ($2,191) and vape peaks Tuesday
($333)**, both troughing Sunday. Peak against trough that is a **42% spread for
cstore and 92% for vape** — the earlier text attached the 42% to a clause about
both companies, which badly undersold vape. Saturday has the largest individual
sessions but runs only 1.17 of them a day against Friday's 1.69.

The `realdata` suite caught it: it runs the dashboard over the real production
rows and pins figures computed independently from the workbook, so a plausible
answer is not enough — it has to be the same answer. The corrected reading is
the more useful one anyway: Saturday carries the most money per shift on the
fewest shifts, which is a staffing observation the per-session average hid.

#### Corrected again, after an independent audit

A second pass recomputed every published figure from the workbook. The code was
right; some of the prose was not.

- **The time-of-month comparison mixed two formulas.** "9% versus 42%" put
  `(max−min)/max` against `peak/trough−1`. Like for like it is **10.0% vs 41.8%**
  (peak/trough) or **9.1% vs 29.5%** ((max−min)/max). The contrast is real; the
  published pairing was the most flattering non-comparable one.
- **Vape's per-day share maximum was an artefact.** The 28.9% peak came from a
  day where a cstore session was recorded with all six tender fields at zero, so
  vape's share was high because cstore's sales were missing. The honest range is
  2.7%–26.7%.
- Sales per labour hour: median $155.72 and 1,162.2 hours hold; the p10/p90
  quoted ($110.17 / $203.49) are nearest-rank — linear interpolation gives
  $110.55 / $202.95.

**Three data-quality problems the audit surfaced, which are the sheet's rather
than the code's:** three sessions closed with every tender field at zero while
their tills removed $435 and $215 in cash — **$650 that provably crossed the
counter is missing from recorded revenue**, so every figure here is low by about
0.36%. And 2026-08-02 carries 14 paid labour hours with no till session at all.

### The public link becomes the sales dashboard (Batch 12)

`?v=recon` answered "does the money add up" — an operational question, for
people who chase variances and already have logins. The public link is better
spent on "how is trade going", which is what owners and stakeholders want and
the one thing they cannot see anywhere else.

- **New `?v=sales`, alongside `?v=recon` rather than replacing it.** `doGet`
  already branched on `?v=`, so both views exist under one URL scheme and the
  operational report stays reachable for anyone who wants it.
- **The WhatsApp link now points at sales.** The shift-close message already
  carries the reconciliation itself, so a second copy behind a tap added
  nothing. `shift_close_v2` has not gone to Meta yet, so relabelling the button
  from "View 7-day report" to "View sales dashboard" costs nothing.
- **60-day window**, because the insights have floors — the time-of-month split
  needs 28 trading days — and a shorter default would greet every reader with
  cards explaining why they are empty. `?days=` clamps 1–365.
- Same no-login contract as the reconcile report: **the payload is inlined at
  render time**, so serving the page opens no RPC and the only thing reachable
  is the one document.

**Aggregates only, and that is the point.** The page carries totals, the daily
chart stacked by till, and all four insight cards with their per-company splits.
It does **not** carry session rows, cashier names, staff or session IDs, or the
free-text notes a cashier typed. The reconcile report names staff against cash
amounts — reasonable to send to five known numbers, unreasonable to leave on a
URL that can be forwarded onward and cannot be rotated without redeploying. Nine
assertions in the `public-sales` suite check the absence of each of those fields
against the real production payload, because on a public page the things that
are *not* published matter more than the things that are.

One consequence worth stating plainly: the page shows revenue and cash share,
which together indicate roughly how much cash a corner store handles and when.
That was already true of the report it replaces — which additionally said who
was carrying it, by name — so this is a net reduction in exposure, but it is a
deliberate choice rather than an accident.

#### Fixed: a comment about the scriptlet broke the scriptlet

Both public pages died with `SyntaxError: Unexpected token ')'` blamed on
`WebApp.gs` at the line calling `.evaluate()` — a file that is entirely valid,
and which `node --check` passes.

Apps Script templating is a **text preprocessor**. It scans the whole file for
scriptlet delimiters before any of it is HTML or JavaScript, so it cannot see
JS comments. The comment written to explain the force-print scriptlet contained
the delimiter itself, which opened a scriptlet that swallowed everything up to
the real closing tag — taking the actual payload expression with it. Three
openers in a file that must contain exactly one.

The error is attributed to `WebApp.gs` because that is where `.evaluate()`
compiles the template, which is what makes it hard to find: the reported file
and line are both innocent.

`Public.html` carried the same defect from the moment the comment was written,
so **the reconcile report has been broken since PR #4 reached production**. It
went unnoticed only because the WhatsApp button that links to it has not been
submitted to Meta yet, so nothing has actually opened the URL.

A `template-guard` suite now asserts that each templated page contains exactly
one scriptlet opener and one closer, that it is the force-print payload form,
and that nothing appears before it. It builds the delimiters at runtime so the
test cannot trip its own rule, and it fails 4 assertions against the broken
commit.

#### The day chart opens on the newest days

The track is built oldest-first and scrolls, so over a 60-day window it opened
hard left on the oldest day — while the day selected by default, and rendered
in detail underneath, was the newest. The selected bar was simply off-screen.

- **Nothing selected → the far right.** The newest days are what a reader wants
  first; older ones are a scroll back.
- **A selection off-screen → centred**, so tapping a bar always brings it into
  view.
- **A selection already fully visible → left exactly where the reader put it.**
  Re-rendering replaces the chart's markup and wipes its scroll position, so the
  position is captured before the swap and restored after; without that, every
  tap would yank the chart sideways even when nothing needed to move.

The arithmetic lives in `chartScrollTarget_`, which takes plain numbers and
touches no DOM, so the behaviour is asserted rather than eyeballed — including
that a bar ending one pixel inside the viewport is left alone while the next one
along is re-centred.

The public sales page gets the same treatment, minus the selection logic: it
opens on the newest days and lets the reader scroll back.

#### The public chart shows its amounts

The in-app chart prints each day's total above its bar; the public one didn't.
Not by design — `compact()` was written into `PublicSales.html` and then never
called, so the page shipped with a formatter it had no use for. Without a label
the bars are shape only, and the page has no accordion underneath to read the
figures off: the tooltip was the only way to get a number out of it, which on a
phone means no way at all.

Each column now carries `$2.0k` / `$960` above the bar, the same abbreviation
`compactMoney` uses in the app, so the two charts read identically. The column
widens 30px → 34px to fit four characters, and gets `justify-content: flex-end`
so the label sits on top of its own bar rather than floating at chart height —
without it a short day's label hangs in space well above the bar it belongs to.

A `public-chart` suite now runs the page's real `chart()` in a sandbox, lifted
out of the HTML rather than copied, and asserts the label on every column, in
the single-company view, and on a zero day. It also re-checks that the stacked
segments still sum to the bar height, since the label changed the column's
layout. It fails 6 assertions against the commit before this one — including
"chart body calls compact", which is the assertion that would have caught the
dead formatter in the first place.

386 assertions across 20 suites.

### Lotto payouts bigger than the day's takings (Batch 13)

A large win paid at the counter is cash leaving the drawer, and the close sheet
had nowhere to put it. `cash_sales` refused a negative, so a shift that sold
$200 and paid out $500 could not be recorded at all — and the reserve, counted
separately, reported a shortfall for the same money. One movement, wrong in two
places, with no way to reconcile either.

#### Payouts are netted into cash sales

The decision — taken deliberately, with the cost understood — is to net the
payout: that shift enters **−$300**. Sales figures take the hit on payout days.
Heavy payouts are occasional, and the alternative was a reconciliation that
never closes.

`cash_sales` may now go negative, but **only on cstore**, and only in that one
field. The close sheet's money inputs strip a minus from everything else, which
is the guard that caught a real bug once; it stays on the other six. A vape
till has no payout mechanism and no pot to fund one, so the server rejects a
negative there rather than accepting a typo.

#### The reserve reconciles it, and it is derived rather than typed

```
reserve_at_start = previous.lotto_reserve_counted + previous.lotto_topup_from_till
reserve_fed      = reserve_at_start − this.lotto_reserve_counted

expected_cash    = float + cash_sales + misc_cash + reserve_fed
```

No new column and no new input. The cashier already counts the pot, so what it
fed the drawer is **measured**, not declared — one less number to get wrong, and
it cross-checks itself against a physical count.

The `+ topup` term is load-bearing: the pot is counted *before* any till-to-
reserve move, so a topped-up pot holds counted + topup. Reading `lastCounted`
alone understated it by exactly the top-up — a pre-existing defect that also
made the close sheet pre-fill the wrong starting balance. `getLottoLog` now
publishes `lastOpening` and both sides use it.

#### Which pot paid the customer does not matter

The first design required that the reserve never pay a customer directly. That
restriction turned out to be unnecessary — the arithmetic is source-agnostic:

```
drawer  = float + gross_sales + transfer − paid_from_drawer
fed     = transfer + paid_from_reserve
entered = gross_sales − paid_from_reserve − paid_from_drawer

float + entered + fed  ==  drawer         (paid_from_reserve cancels)
```

Verified over 200,000 randomised shifts: zero mismatches. So the rule at the
counter is one line with no exceptions — **net every payout into cash sales,
whichever pot it came out of** — and it is printed next to the field that needs
it. A cashier holding a $500 winner does not have to reason about which pot
they are allowed to open.

Both conventions reconcile from the same code path: draw $50 and close the
drawer at zero, or draw $300 and restore the float. The code derives the
transfer from the counts and does not need to know which you use.

#### Two guards, both before the write

- **Negative `cash_sales` off the lotto till** is rejected outright.
- **A negative `expected_cash`** is rejected: no drawer holds less than nothing,
  so with `reserve_fed` in the formula it can only mean a movement went
  unrecorded — almost always a pot count not updated after cash was drawn from
  it. The message says so.

Both run *before* `Sales.write`, which previously sat ahead of the variance
maths. A throw after it would have left a sales row against a session still
open.

#### What a person reads

- `compactMoney` and its public twin took `Math.abs` and would have printed a
  −$300 day as **$300** — the day rendered as its own opposite. Both keep the
  sign now. The bar geometry was already safe: heights are floored by
  `Math.max(3, …)` and stacks are guarded on `total > 0`.
- Insight bar widths clamp at 0 rather than emitting `width:-12%`, which is not
  a valid length.
- The close summary shows *"$50 drawn from reserve"* when the term is non-zero,
  so the expected figure doesn't look like it disagrees with float + sales.
- **The cash-destination line no longer claims a float went back when it
  didn't.** A drawer closing below its float now reads *"$250 below the $250
  float · nothing in hand"* on both the close sheet and WhatsApp `{{7}}` —
  previously it said "$250.00 float · -$250.00 in hand". `CashHandling` already
  skipped negative `cash_removed_at_close`, so the handover ledger was never
  affected; only the sentence was wrong.

#### Verification

Two new suites. `lotto-payout` drives real opens and closes through the module:
the scenario both ways, the payout made entirely from the pot, a 400/100 split,
two untouched-day regressions, a genuine $50 loss that must still surface as
variance rather than be absorbed, the top-up term, an empty reserve history, and
both guards including that no sales row is written when one fires. `lotto-ui`
covers the label sign, the per-field minus rule, the counter text, and the
destination line. They fail 24 and 22 assertions respectively against the
commit before this one.

455 assertions across 22 suites.

#### Still open, and only the sheet can close it

A payout **nobody records** is undetectable — `expected_cash` exceeds the drawer
by exactly the unrecorded amount and looks like a plain shortfall. No formula
finds an event that was never written down.

Worth noting against the standing cash-variance question: cstore, which sells
lotto, runs a median variance of **−$4.65** across 131 sessions with 73 negative;
vape, which does not, sits at **$0.00** with 48 sessions exactly zero. The till
that pays out is the one that drifts. Not proof, but the first hypothesis to
test now that payouts have somewhere to go.

#### A sign button, because no phone keypad has a minus

Negative cash sales worked on a desktop and were unreachable on a phone. The
close-sheet money fields are `inputmode="decimal"`, and neither that nor
`type="number"` puts a minus key on the iOS keypad — so the one figure allowed
to go below zero could not be entered on the device every cashier actually uses.

Cash sales now sits beside a **sign toggle**, rendered only on the lotto till.
The field keeps its numeric keypad; the sign becomes a control rather than a
keystroke. The button mirrors the field instead of holding state of its own, so
typing a `-` on a desktop keyboard lights it up exactly the same way, and it
turns solid when negative — a minus one character wide is easy to miss on the
figure that decides the whole reconciliation.

Tapping it on an empty or zero field arms the sign rather than leaving `-0`
behind, so the next keystrokes land negative. Every other money field keeps the
minus guard it has always had.

The instruction about entering payouts in Cash sales is gone from the close
sheet. It explained a rule the arithmetic already enforces, on a screen where
the reserve section is long enough already.

A `sign-toggle` suite pins the control to the lotto till, asserts the keypad was
not swapped for a text keyboard to get the minus, and runs the flip arithmetic
over the cases that bite — `-0`, a bare armed `-`, and flip-twice being the
identity. It fails 12 assertions against the previous commit.

459 assertions across 22 suites.

### cstore moves to ePOS: one card figure, no Clover (Batch 13)

cstore's till is now an ePOS. It reports **one card total** instead of a
credit/debit split, and it takes **no Clover payments at all** — so there is
nothing left to reconcile the cards against. vape is unchanged: Clover connected,
split reported, checked as before. Every change below is per company.

#### The schema adds columns rather than repurposing them

`sales` gains `card_total_sales` (17) and `misc_card_sales` (18). The
credit/debit columns keep every historical value.

Writing the single total into `credit_card_sales` would have been simpler and
would have made every report say *"Credit $1,240 · Debit $0"* for cstore — a
statement about the world that is false, and one that makes 262 rows of real
history indistinguishable from the new shape. The columns are **mutually
exclusive per row** instead, so

```
total = cash + credit + debit + card_total + misc
```

is correct on both sides of the migration **with no date logic anywhere**.

**Blank is not zero.** A blank `credit_card_sales` means *"this till reported one
figure"*; a zero means *"it split its cards and took nothing on credit"*.
`numOrNull_` preserves the distinction and `cardSplit` exposes it per row —
derived from the row itself, never from today's config, because the same till
reports both shapes across the boundary.

Which shape a till uses is `<company>_card_split` in config, defaulting to
`true`, so an untouched install keeps the behaviour it has always had and a third
till needs no code change.

#### "Not configured" is not "unavailable"

`statusParam_` returned `⚠️ Clover unavailable - cards not verified` whenever
Clover was absent. After the migration that would have fired **every single day**
for cstore, training everyone to ignore the one line that flags real problems.

A group is now `cloverNA` when the only reason is `not_configured`: cards are out
of scope, no warning, no `cardsOff`, and `card_variance_threshold` is never read.
A genuine outage — network, auth, 5xx — still warns exactly as before, and both
cases are asserted, because either alone passes a broken implementation.

#### The expensive one: the total-sales line

`{{5}}` compared the cashier's figure against `(cash counted − float) + Clover
card total`. Both sides carried a card term and they cancelled when the cards
agreed. **Remove Clover and only the reported side keeps its term**, so a
perfectly clean day would have reported a variance equal to the whole card take —
roughly half of cstore revenue, on the line management reads first.

Rebuilding it as a cash-only cross-check was rejected too: that restates the cash
line, which is now this till's only verdict, and two lines reporting one variance
is what made the old nine-parameter message unreadable. So for a Clover-less till
`{{5}}` is **descriptive** — `$1,842.00 — cash $602.00 · card $1,240.00` — with
no mark, and the status says `✅ Cash matched` rather than `All matched`, which
would claim a check that no longer runs.

#### Two templates, one per till

`shift_close_v2` served both and no longer fits either. cstore gets
**`shift_close_cstore`** (11 parameters, cards as information). vape gets
**`shift_close_vape`** (12) — v2 minus the lotto line, which printed *"not
tracked on this till"* on every vape message since the parameter existed. The
reserve parameter is now appended only where a pot exists, so a till that does
sell lotto would get it back automatically.

Routing was small: `sendNotifications_` already loops per merchant group and each
group knows its companies, so it picks an op key per group and falls back to the
shared template when a key is unset. Until both are approved, both tills keep
using v2 — the rollout is safe half-done.

A wrong parameter count is an `http_400` that `dispatch_` swallows: the day
reconciles, the row is written, and the message silently never arrives. The suite
asserts the count per shape, because nothing at runtime will.

#### What the sweep found that the plan had missed

**The public reconcile page had no unavailable branch at all** — unlike the
in-app tab, which has one. With Clover gone it would have published

> **Cards** $1,240.00 / $0.00 · **−$1,240.00**

in red, every day, on the no-login link that goes to owners and managers. It also
hardcoded a $1 tolerance and ignored the configured threshold. `PublicReport` now
omits the measured figure rather than sending zero, and the cell renders the
claim alone with a *"not verified"* note.

**The in-app tab keyed off the stored status string**, so a cards-not-applicable
day reporting `OK` would have fallen through and rendered *"Credit $0.00 /
$1,240.00"* in red — the same wrong number, relocated. All three renderers now
branch on whether a measured figure exists, which is the blank-is-not-zero rule
applied to the read side.

#### Tender tiles stay continuous

Card is the tender; credit and debit are a breakdown of it that only some rows
carry. So the **Card tile is always present and always the sum** — a tile that
vanished partway through a range would read as a business that stopped taking
cards — and the split renders beneath it with a coverage note when the range
straddles the migration. A test asserts the Card tile is never absent.

Nothing plots the split over time, so no line collapses at the boundary; per
session it is one shape or the other, and no coverage note is needed at row
level.

#### Also

- `close_` rejects a close carrying both shapes, naming the company and the
  config key that disagreed — that means client and config are out of step, and
  trusting either half would write a row that cannot be reconciled afterwards.
- `rpcCloseShift` forwards the new fields and passes absent ones through as null
  rather than 0; coercing here would make every close look like a split.
- `aggregateByStaffCompany` includes the single total, so commissions on cstore
  card sales do not silently under-pay. It is a feed, not a screen, so nothing
  would have looked wrong.
- `menu_migrateSalesCardTotal` appends the columns to an existing sheet, guarded
  on the header so a second run is harmless.
- `docs/data-model.md` documents both shapes and the rule that any query must sum
  all three card columns — reading only credit and debit undercounts every
  post-migration row, and looks like a decline rather than a bug.

583 assertions across 25 suites. The three new suites fail 29, 33 and outright
against the previous commit.

#### Fix: a lotto top-up was counted twice

`lotto_reserve_counted` stores the pot's **closing** balance — the close sheet
submits `counted + topup` as a single figure. The lotto-payout batch read it as
the count *before* the top-up and added the top-up on top of it again.

So a $160 move onto a $265 pot stored $425 correctly, and then opened the next
shift at **$585**. Two consequences, and the second is the worse one:

- the pot looked $160 short against an opening it never had, and demanded a
  reason for a discrepancy that did not exist
- `expectedCash` inherited the same $160, so the **drawer read $160 short** on
  the shift after any top-up — a phantom cash shortfall, on the figure that is
  now cstore's only remaining control

The stored semantic was right all along; the reader was wrong. `reserveFed` now
takes the previous closing balance as-is, and `lastOpening` — a field that only
existed to carry the phantom addition — is gone from `getLottoLog_`, the RPC
payload and the close sheet.

The `lotto-payout` suite carried an assertion pinning the wrong premise
("opening balance is counted + topup"). It is replaced by the reported case
itself — $160 onto a $265 pot, asserting the next shift opens at $425 and the
drawer reconciles — plus a genuine draw from a topped-up pot, so both directions
stay covered. Eleven assertions fail against the previous commit.

590 assertions across 25 suites.

#### Fix: the close message stopped sending

The ePOS batch changed the reconcile message's parameter **shape** with the
till's nature — cstore to 11, vape to 12 — while template **routing** still fell
back to the shared `shift_close_v2` whenever the per-till keys were unset.

So both tills sent the wrong parameter count to a 13-parameter template. Meta
answers `http_400`, `Notifier.dispatch_` uses `muteHttpExceptions`, and the day
reconciles and writes its row regardless: **no message, no error, nothing
anywhere saying the send failed.** This is the exact failure the batch documented
as a trap and then shipped.

vape broke **regardless of configuration** — dropping its lotto parameter was
unconditional — so it had been silent since that deploy, not just since the
cstore config was switched on.

The shape now belongs to the **template being sent to**, not to the till.
Falling back to the shared template builds the legacy 13 — lotto slot filled with
"not tracked on this till" as it always was, cards in the "no Clover" wording —
and the 11/12 shapes apply only once `whatsapp_template_shift_close_<company>`
names a template that expects them.

The batch's own plan called for asserting the parameter count on the fallback
path. The test that shipped asserted only the op key, which is why routing was
covered and the count was not. Both are pinned now, in both directions: unset
keys give 13, configured keys give 11 and 12.

597 assertions across 25 suites. Four fail against the previous commit.

#### The parameter shape now follows the template, all the way

The previous fix bound the shape to the template only on the **fallback** path.
With the per-till templates configured it still branched on runtime Clover state:
`cstore_card_split` was set and the templates were live, but `clover_cstore_*`
was still populated, so `cloverNA` was false and cstore built the 13-parameter
comparative shape — and sent it to an 11-parameter template. Silent `http_400`
again, on the one till whose config was half-migrated.

An approved template has a fixed number of placeholders. The shape is therefore a
property of **which template was resolved**, never of whether Clover happened to
answer. `shapeFor_(opKey)` now decides it outright, and the 11/12/13 shapes are
pinned in both directions — including the case where Clover is still configured
on a till whose template says it is not verified.

#### A failed send says so

`dispatch_` captured Meta's response text and `sendNotifications_` threw it away,
so a message that never arrived was indistinguishable from one that did: the
toast read `✓ Reconciled` either way, nothing was written down, and both silent
failures in this area ran for days before anyone noticed.

The per-group result now carries what was **attempted** — till, template name,
parameter count — alongside the outcome, and `describeSend_` renders one line
like:

```
cstore → shift_close_cstore(11) FAILED http_400 — (#132000) Number of parameters does not match
```

That line goes into the `reconcile.day` audit row and into the toast, which now
reads `✓ Reconciled · WhatsApp NOT sent — …` rather than claiming success. A
parameter count that disagrees with its template is the failure that looks like
nothing at all; it now names itself.

608 assertions across 25 suites. Eight fail against the previous commit.

#### Keep the sentence that identifies the fault

The diagnostic release surfaced the failure but sliced Meta's response at 200
characters, cutting `"details":"body: nu` mid-word. `error_data.details` is the
only field naming **both** the count sent and the count the template expects, so
the failure became visible and stayed unidentifiable.

`apiError_` now pulls `error.message` and `error.error_data.details` out of the
body, so the line reads:

```
(#132000) Number of parameters does not match the expected number of params —
body: number of localizable_params (11) does not match the expected number of params (13)
```

Bounded at 400 characters, and any non-JSON body — an HTML gateway error, an
empty response — falls back to a raw slice rather than throwing inside the send
loop.

621 assertions across 26 suites.

#### Fix: the public sales page was blank

`?v=sales` rendered nothing at all since the ePOS batch. The tender-tile change
added, inside `render()`:

```js
var split = t.credit + t.debit;
```

`split` is also a module-level helper — the per-company insight strip — called
twice inside that same function. The `var` hoists to the top of `render()` and
shadows it for the whole body, so the **first** call, several sections earlier,
got `undefined` and threw. Nothing had been written to `#app` by then, so the
page came out white with no error.

Renamed to `splitTotal`. The comment on it names the trap, because the next
person reaching for `split` as a local will be reaching for the obvious word.

**Two blank-page incidents is enough**, so `render()` is now wrapped: a throw
writes "This report failed to render" plus the message into `#app` instead of
leaving it empty. On a no-login URL sent to owners, failing legibly is the
minimum.

A `public-render` suite runs the **whole** page — payload through to `#app` —
over five payload shapes. The existing `public-sales` suite tested the server
payload and `public-chart` tested `chart()` in isolation; neither ever called
`render()`, which is exactly how a fatal error in it shipped twice. It throws on
5 of 5 real payloads against the previous commit.

#### The suites now live in the repo

They were in a session scratchpad, and the container was recycled mid-diagnosis:
roughly 620 assertions across 26 suites, gone in one step. `tests/suites/` is
their home from now on, with the house rule written down — every assertion
confirmed failing against the commit it fixes. `clasp push` uploads `rootDir:
src` only, so nothing there reaches Apps Script.

Only `public-render` survived, as it was written after the loss. The rest need
rebuilding.

### Product import, the vape shelf, and fixed commission rules (PRs #18–#23)

- **#18 — the lost suites rebuilt.** 22 suites, 800 assertions, each confirmed
  failing against the code it guards.
- **#19 — the whole vape shelf is orderable.** Category chips show every
  product in the category. A product flagged `needs_detail` stays in the picker
  with a **Fix** button instead of **+**, and the server refuses to order it
  until the flavour or variant is filled in. Creating and editing products is
  open to every role; cashiers add most new stock.
- **#20 — a failed import says which rows failed, and why**, instead of a bare
  error count.
- **#21 — a stale staging header is refused** instead of being mapped by
  position into the wrong columns. **Refresh staging headers** rewrites it.
- **#22 — imports stop timing out.** The vape import reads each sheet once and
  writes each sheet once, whatever the size of the paste.
- **#23 — fixed-amount commission rules**, for a weekly management fee that
  isn't tied to sales. Every bonus now records the rule that produced it
  (`source_rule_id`), so a fee and a sales commission no longer block each
  other.

### Documentation, and what writing it found (Batch 14)

The repo now explains itself, with pictures, to a new developer, a manager or an
interviewer. Start at `docs/README.md`.

- **Architecture:** system context, layers, module map, the daily flow, data
  model with an ER diagram, security (threat model, sessions, the role table
  read from the code), deployment and CI. Mermaid throughout, every diagram
  checked to render (`npm run docs:mermaid`).
- **Twelve component pages**, each with screenshots, a diagram, the rules it
  must not break, a code map, the tests that hold it down, and its history.
- **Eighteen ADRs** for decisions already made, from the platform choice to
  blank-is-not-zero, written from this changelog and the pull requests.
- **A ten-minute showcase** for interviews and management reviews.
- **Screenshots are generated, not taken.** `scripts/docs` runs every `src/*.gs`
  file in Node over an in-memory spreadsheet, seeds 120 days of a fictional store
  through the real module APIs, and renders the real pages in Chromium with
  `google.script.run` answered by the real RPCs. No real names, pay or takings.
- **The schema reference is generated** from what `Setup.gs` and the migrations
  build (`npm run docs:schema`).
- **Docs are enforced.** A `docs-guard` suite fails when the schema doc is stale,
  an ADR or component page isn't indexed, a link is dead, or an image isn't
  produced by the screenshot list. `ci.yml` runs every suite on every push and
  pull request, the first time CI has run the tests at all. A PR template and
  `CLAUDE.md` carry the checklist.
- A `syntax` suite compiles every `.gs` file and inline page script, so CI runs
  the old copy-paste syntax gate.

#### Found while generating the screenshots

Running the whole app end to end over consistent data surfaced four real bugs.
Each fix is its own commit, with assertions confirmed failing without it.

- **Reconcile history and the public report showed cstore's whole card take as
  a loss, every day.** `Reconcile.getRecent_` read blank Clover columns with
  `Number(x) || 0`, so "not measured" came back as "measured $0.00". The public
  report's null guard could never fire. The suite that should have caught it
  stubbed `getRecent` with `null`, so it passed without running the real read.
  Blank now reads back as `null`; the history cell says *not verified*.
- **Script injection through the public 7-day report.** The inlined payload
  wasn't escaped for the HTML parser, and it carries cashier-typed notes. A
  note containing `</script>` would have run in every owner's browser. `<` is
  now written as `<`.
- **My Pay overflowed a phone.** Four tiles at ~83px each, and a six-column
  table that ran PAID and REMAINING together. Two-by-two tiles under 560px.
- **Product Master showed uncosted products as "cost $0.00 · margin 100%"**
  and sorted them first by margin. Now *no cost recorded*, and sorted last.

Also: an empty toast pill that sat permanently over the tab bar is now hidden,
and a stale "no-op" header comment in `Notifier.gs` describes what it actually
does.

#### Readable by AI agents, too

- **`AGENTS.md`** is the entry point for coding agents (and a fast start for
  people): layout, commands, the shape of the code, ten hard rules each linked to
  its ADR, recipes for common changes, and gotchas that have bitten before.
  `CLAUDE.md` imports it, so the two can't diverge.
- **`docs/reference/code-map.md`** is generated from the source: every module's
  purpose, public API, tabs, callers and the suites that load it; every `rpc*`
  with its parameters and the roles its `Auth.require` admits (following one
  level of helper calls); the status vocabularies.
- **`llms.txt`** indexes every doc with a one-line description, generated from
  the pages themselves.
- The docs guard now fails when the code map or `llms.txt` is stale, when a doc
  is missing from `llms.txt`, or when `CLAUDE.md` stops importing `AGENTS.md`.
  `npm run docs:generate` rebuilds all three generated files.
- [ADR-0019](docs/adr/0019-agent-facing-docs.md) records the decision.

### WhatsApp notifications stopped: what can cause it, and a check that says which (Batch 15)

Investigating "WhatsApp notifications aren't working" turned up two ways a
message could fail with no sign anywhere, plus no quick way to tell an expired
token from a switched-off setting.

- **The close message depended on Clover.** The automatic reconcile after each
  close returned before building the message whenever `clover_enabled` was off,
  with no toast and no audit row. Since cstore left Clover, switching it off is
  the natural move, and it switched off every close message with it. Reconcile
  now always runs; Clover switched off counts as *not configured*, so cards read
  "not verified" with no daily outage warning. `notifier_enabled` is the switch
  for messages.
- **A failed shift-open notice was invisible.** The app discarded the result,
  and failed sends wrote nothing. Now the cashier sees *Shift opened · WhatsApp
  NOT sent — <reason>*, and `audit_log` gets a `notify.shift_open_failed` row
  with Meta's reason per number.
- **💬 Check WhatsApp setup**, a button on the Reconcile tab for managers and
  admins and a Sheet menu item, checks the switch, URL, token, recipients and
  templates, then asks Meta (a GET, never a send) whether the token and phone
  number are valid. An expired token comes back in Meta's own words with the fix.
  It never shows the token.
- Two real-looking phone numbers in the notifier suite were replaced with 555
  numbers.

New assertions in `reconcile`, `notifier`, `rpc-guards` and `ui-recon`. All
were confirmed failing against the previous code or a deliberate mutation of
the fix.

### Settings screen in the Operations app (card P4-09)

After the move off Sheets there is no `config` tab to edit. An admin now has
**More → Settings** (Operations app only, hidden in Apps Script): every setting
under a heading, its default, a sheet to change it, and "Use the default".
`rpcGetSettings` and `rpcUpdateSetting` are the first calls only the Operations
app has (listed in `ops/contracts/rpc-ops.json`, admin only). A value is refused
where its reader would misread it (a zero read as the default, an address the
Clover or WhatsApp token would not be sent to, a number that is not a number); a
blank stores NULL; the three credentials are listed as set or not set and never
shown or stored here. Every change is audited, with phone numbers masked to their
last four digits. See [settings](docs/components/settings.md).

New assertions in `ops/test/settings.test.ts` and `ops-ui-build`; each was seen
failing first, and against a deliberate mutation of the fix.

### Correct a day after the fact, in the Operations app (P4-10)

Without the Sheet an admin can no longer fix the `attendance` tab by hand when
the schedule did not match what happened. In the Operations app (never inside
Apps Script) an admin who taps a Schedule cell for today or a past day now sees
**Correct this day**, or **Add a day worked** on an empty cell.

- The sheet shows what is recorded, the till sessions that day, what has been
  paid, and refuses (with the reason, and no Save) a day with money paid
  against it or a till still open.
- The admin says what happened (worked, or did not work), the scheduled and
  actual times in Toronto time whatever the device's zone, and a reason; after
  saving it shows what the person is owed for that day, before and after.
- Two new admin-only calls, `rpcGetAttendanceDay` and `rpcCorrectAttendance`
  (ADR-0023), each correction one `attendance.correct` audit row with the whole
  record before and after. Till sessions, sales, payments and bonuses are never
  touched; a blank rate is stored as blank, never 0.

New: `ops/test/attendance-corrections.test.ts` and the `ui-schedule-corrections`
suite, both confirmed failing before the code existed and against deliberate
mutations (paid-day guard, blank rate, the staff-row lock, the role gate, the
Toronto offset).

### Add, change and deactivate people, set PINs and give raises, in the Operations app (P4-11)

Without the Sheet nobody could add a person or change their pay. In the
Operations app (never inside Apps Script) **More → Staff** now lists everyone.

- An admin adds a person (name, role, tills, rate, start date, email, notes,
  a first PIN typed twice), changes them, deactivates or reactivates them and
  sets a new PIN. A blank rate is "no rate set", stored blank, never $0.
- A manager may add an employee (name, tills, start date, PIN) and sees no
  pay rate, email, notes or cash.
- A raise may reach back: with a date, every worked day from it with nothing
  paid takes the new rate (paid and partly paid days are left alone and
  listed). The sheet previews it ("4 days: owed goes from $160.00 to
  $418.00") before Save.
- Guards: the last active admin, yourself, an open till and the cash manager
  cannot be deactivated (or the admin demoted); a reason is needed for a
  rate, role or active change. Deactivating signs the person out everywhere;
  a role change applies at their next call. Setting a PIN ends their other
  sessions and lifts a lockout. The PIN is never stored, logged, audited or
  answered, only its hash is kept.
- Five new calls (ADR-0023), each audited (`staff.create`, `staff.update`,
  `staff.rate_applied`, `staff.pin_set`). See [staff](docs/components/staff-admin.md).

New: `ops/test/staff-admin.test.ts` and the `ui-staff-admin` suite, both seen
failing before the code existed, and against seven deliberate mutations (a
manager adding a manager, the rate in the manager's list, re-rating a paid
day, a blank rate stored as 0, the id lock dropped, the PIN in the audit row,
the last admin deactivated).

### The till client and a fake till, switched off (P5-02a)

The vape till has agreed a read API with Operations (contract 1.1.0). This is
the one place the Operations app will call it, built and tested but **called
by nothing**: no RPC, no screen, no cron. Until an admin turns it on and
installs a key, every call answers `not_configured` and makes no request.

- `ops/src/till/client.ts`: `listStores`, `listStaff`, `listShifts`,
  `dailySales`, `listProducts`, `listSuppliers`, `listOrders`, all GET. It never
  throws (an answer is `{ ok, data }` or `{ ok: false, error: { kind, ... } }`);
  sends the key only to the till's own addresses (`isTillUrl`), only in the
  `Authorization` header, and scrubs it from every message even when the till
  echoes it back; never follows a redirect; waits out a 429 (twice, 10 seconds
  at most) with an injected `sleep`; times out after 8 seconds; checks its
  inputs before any request and the answer's required keys and lists after.
  Hand-written types in `till/types.ts`.
- `ops/src/till/fake.ts`: a fake till built from the contract, with fictional
  data (an `auto_closed` shift with nothing counted, the nil uuid, takings short
  of the total, door cash, all three channels) and switches for every failure,
  and a fake clock that never really waits. Its answers are validated against
  the contract by the tests.
- Settings `till_enabled` (off), `till_api_url` (refused unless it is the
  till's own address) and `till_key_expires_on`, and the Worker secret
  `TILL_API_KEY`, listed under *Kept by Cloudflare*.
- [ADR-0024](docs/adr/0024-the-till-is-read-through-one-client.md) and the
  [till link](docs/components/till-link.md) page.

New: `ops/test/till-client.test.ts`, `ops/test/till-fake.test.ts` and new
assertions in `ops/test/settings.test.ts` and `ops/test/config.test.ts`. The
settings assertions were seen failing before the code; the client's were seen
failing against deliberate mutations (any https host accepted, redirects
followed, the key not scrubbed, 429 retried forever, a throw on a network error,
a caller outside `ops/src/till`, a field the contract does not have).

### Correct a closed till, in the Operations app (P4-12a)

Without the Sheet an admin can no longer fix the `till_sessions` and `sales`
tabs by hand when a cashier mistyped a figure at close. In the Operations app
(never inside Apps Script) an admin sees **Correct this till** under each till
of the selected day on the Sales screen.

- The sheet shows what is recorded (blank figures in words, never $0.00), the
  cash from that till already handed over, whether the day was reconciled and
  which commission runs cover it; it asks for the close sheet's figures in the
  row's card shape, previews the variance and total, and needs a reason.
- The server works every derived figure out again with the close's own
  arithmetic (`closeFigures`, now shared by `close` and the correction, with no
  change to what a close stores): expected cash, variance and its status, cash
  removed, the lotto figures, the total. A blank stays blank; the row keeps its
  card shape or takes its till's shape for that day; cash already handed over
  must stay covered (void the handover first).
- Two new admin-only calls, `rpcGetTillCorrection` and `rpcCorrectTillSession`
  (ADR-0023); one `till.correct` audit row with the whole session and sales row
  before and after. Nothing else is written and no message is sent: the answer
  says when the day's reconcile, a commission run or the next cstore close used
  the old figures.

New: `ops/test/till-corrections.test.ts` and the `ui-till-corrections` suite,
seen failing before the code existed and against seven deliberate mutations
(handed-over guard, blank as 0, both card shapes, variance status, the role
gate, the session lock, a one-cent drift from the close).

### A door for AI assistants, with keys an admin makes and withdraws (P5-11)

The Operations app gets a second way in, beside the screens, for AI assistants
(Muse first, Claude after): `/mcp`, an MCP server on the official SDK
(`@modelcontextprotocol/sdk` 1.32.2, with its required `zod`), stateless,
answering with JSON. It ships **off**: until an admin sets
`assistants_enabled` to Yes in Settings it answers nothing to anyone.

- **More → Assistants** (admins, Operations app only): make a key for one
  person and one assistant (label, read only or read and propose, personal
  details yes/no, 1 to 365 days), shown **once** and never stored (only its
  SHA-256); withdraw it with a reason. Three admin-only calls,
  `rpcGetAssistantKeys`, `rpcCreateAssistantKey`, `rpcRevokeAssistantKey`,
  each key made or withdrawn audited.
- Three read tools: `whoami`, `businesses`, `my_proposals` (empty until a
  propose tool exists). Every answer is a summary line and JSON; outside text
  goes through `asData`.
- Every wrong key gets the same 401; a request from a browser (`Origin`) is
  refused; calls per minute and proposals per Toronto day are limited per key,
  counted under the key's row lock; every call is recorded in
  `ops.assistant_calls` without its arguments or answer.
- Two new tables (migration 0009), not loaded or compared by the cutover tools.

Why, and what was rejected: [ADR-0025](docs/adr/0025-assistants-come-in-through-mcp-and-only-propose.md).
How the owner connects an assistant: [Connect an assistant](docs/guides/connect-an-assistant.md).
See [assistants](docs/components/assistants.md).

New: `ops/test/mcp-door.test.ts` and `ops/test/mcp-keys.test.ts` (driving the
door with the SDK's own client against a real database) and the
`ui-assistants` suite; each failed before the code existed, and against nine
deliberate mutations of the door (open while off, a stored key, a telling
401, a read key proposing, no rate limit, a browser let in, an unpinned tool,
a role in `whoami`, a withdrawn key working).

### Reconcile a past day again, in the Operations app (P4-12c)

After an admin corrects a closed till, the day's reconcile was made on the old
figures and "Reconcile today" could only reconcile today. In the Operations app
(never inside Apps Script) the Reconcile screen now has **Run again for a past
day**, and **Run again** beside each listed day.

- It reconciles every till of that day again from the figures as they stand now,
  with the reconcile's own arithmetic: `reconcileDay` was split so that
  `buildRecords` (closed sessions to result rows, with Clover asked for each
  group's window) and `writeRows` are shared, and today's run passes today. What
  a run of today stores, audits and sends is unchanged (a golden recorded before
  the split holds it).
- Earlier results are kept: new rows are added, nothing is updated or deleted.
  The new rows are `manual` and are marked by being validated on a later day than
  their business day; the reason is in the audit row (`reconcile.past_day`, with
  each till's cash and card verdict). **No WhatsApp message is sent.** Where Clover
  cannot answer for that day the cards are recorded as not verified.
- A day with several sets of results now shows the newest as the day's result and
  says how many it replaced ("re-run on 2026-11-27 · 1 earlier result").
- New call `rpcReconcilePastDay` (ADR-0023), for admin, manager and payroll admin. One
  run of a day at a time (the per-day lock `reconcileDay` takes), and a till
  correction in flight is waited for.

New: `ops/test/reconcile-past.test.ts` and the `ui-reconcile-past` suite, seen
failing before the code existed and against eight deliberate mutations (a
message sent on a past day, unverified cards recorded as matching, earlier rows
updated, today allowed, today's window asked of Clover, an open till allowed, the
control shown inside Apps Script, one figure a cent off the real run).

### Enter a shift that was never put in, in the Operations app (P4-12b)

- An admin can enter, from the Sales screen, a shift someone worked on a past
  day without opening or closing the till in the app: **Enter a shift that was
  not put in** asks who, which till, when (Toronto time) and the till's close
  figures in that day's card shape, previews the variance, cash removed, the
  total and what happens to the day's hours, and writes the till session, its
  sales row and the day's attendance as an open and a close would have.
- Two new admin-only calls, `rpcPreviewMissedShift` (writes nothing) and
  `rpcEnterMissedShift` (ADR-0023); one `till.enter_missed` audit row. No
  overlap with another shift on that till; the same person on the other till is
  allowed and reported; a day already worked keeps its hours; today is opened
  and closed the normal way. Nothing is sent anywhere: the answer says when the
  day's reconcile, a commission run or the next cstore close is out of date.

New: `ops/test/missed-shifts.test.ts` and the `ui-missed-shifts` suite, seen
failing before the code existed and against eight deliberate mutations.

### The audit log on a screen, and a setting to pause the Monday run, in the Operations app (P4-13)

- An admin can read the audit log: **More → Audit log** lists who did what,
  newest first, with filters for a person, a kind of action and a day, **Older**
  for the next page, and a sheet per entry showing before and after side by
  side with what changed marked. Phone numbers show their last four digits only
  and any secret-looking key is hidden; the stored rows are never changed.
  Reading the log is not itself logged.
- New admin-only call `rpcGetAuditLog` (ADR-0023). Newest first by the order the
  rows were written in, 50 a page (100 at most), no page numbers and no count.
- A new setting, `commission_run_paused` (Settings, Commissions group, off by
  default): when on, the Monday morning run does nothing but write one audit row,
  `commissions.run_skipped`. **Run engine** on the Commissions screen still works.
  The Commissions screen says "The Monday run is paused (Settings)." when it is on,
  through a new small read, `rpcGetCommissionRunPaused`.

New: `ops/test/audit-view.test.ts`, the pause tests in `ops/test/cron.test.ts` and
the `ui-audit-log` suite, seen failing against nine deliberate mutations (a manager
reading the log, ordering by time, phone numbers unmasked, a `pinHash` shown, the
action put into the SQL, a value rendered without `esc()`, the pause also stopping
Run engine, the weekly job running while paused, a session id or an amount masked as
a phone number).

### The two businesses and a receipt inbox, in the Operations app (P5-12a)

- **More → Receipts**, for everyone signed in: take a photo of a purchase
  receipt or choose its PDF, say which business (cstore, vape or not sure),
  add a note, and send. The original is kept exactly as received (never
  shrunk or converted), with its SHA-256, size and type, in an R2 bucket
  (`RECEIPTS`, `storeops-receipts`) and a row in `ops.receipt_originals`. The
  same file twice is one original ("Already on file, added … by …"). Nothing
  is read from it yet.
- Admin, manager and payroll admin see the list (Waiting, then Set aside) with
  previews, and open an original large; admin and manager set one aside with a
  reason, put it back, or say which business it belongs to. An employee sees
  their own additions of the last 7 days.
- **More → Businesses**: each business's legal name, HST number (nine digits,
  RT, four digits) and the signs that say a receipt is its own (a name as
  printed, an HST number, a supplier account, a card's last four digits).
  Changed by an admin; read by manager and payroll admin. One sign belongs to
  one business only, however it is spaced, dashed or cased.
- Two routes beside `/rpc/*` and `/mcp`: `PUT /files/receipt-original` (the
  session as a bearer header, the type decided by the file's bytes: JPEG, PNG,
  WebP, HEIC/HEIF or PDF; at most `receipt_max_mb`, default 10) and
  `GET /files/receipt-original/<id>` (only to a session allowed to see it,
  sandboxed, never cached, never by a URL alone). Seven new calls in
  `rpc-ops.json`; every change audited.
- The assistant's `businesses` tool now also answers each business's legal
  name, HST number and live signs.
- Three new tables (migration 0010), not loaded or compared by the cutover
  tools. The hosted setup must create the bucket and put a retention lock on it.

Why, and what was rejected: [ADR-0026](docs/adr/0026-receipt-originals-are-kept-as-received.md).
See [receipts](docs/components/receipts.md).

New: `ops/test/receipt-inbox.test.ts`, `ops/test/businesses.test.ts` and the
`ui-receipts` suite, against a real database and the in-memory bucket; each
failed before the code existed, and against ten deliberate mutations (the sent
type trusted, SVG accepted, no size cap, an employee viewing another's
original, no sandbox or `nosniff`, a second object for the same hash, a
`delete` in the storage interface, the file name in the storage key, one sign
for both businesses, an original served without a session).

### Till logins: people and stores matched, and a warning before the key expires (P5-02b)

- An admin can now match each person on the Staff list to their login in the
  vape till, and the till's store to this store, from **More → Staff → Till
  logins** (Operations app only; a manager's Staff screen is unchanged). Nothing
  is matched by the app: it suggests where the names are equal (ignoring case and
  repeated spaces) and an admin confirms. A till person with no match is listed,
  never created here, and nothing about them is kept. A match the till no longer
  lists is flagged and kept; ending one needs a reason and works with the till
  down. Sign-in is unchanged: name and PIN, no till.
- When the till cannot be read (switched off, not set up, down, slow, refusing the
  key, answering nonsense) the section says which in plain words and shows what
  is saved, with no matching; nothing else in the app is affected. The whole call
  stays inside 8 seconds. Nothing is sent to the till.
- From 14 days before the day typed into `till_key_expires_on` (and after it) a
  warning shows on the Staff section and above the Till group on Settings; at 15
  days there is none; a blank date with the link on says it is not recorded. No
  message is sent.
- Four new admin-only calls (`rpcGetTillLink`, `rpcSetTillStore`, `rpcLinkTillStaff`,
  `rpcUnlinkTillStaff`; ADR-0023), two new tables (migration 0011), and
  `rpcGetSettings` also answers `tillKeyExpiry`. The client now has exactly two
  named callers (the till link's module and handler).

New: `ops/test/till-link.test.ts` and the `ui-till-link` suite, run against the
fake till and a real database, and seen failing against nine deliberate
mutations (matching on an equal name by itself, accepting the nil uuid, throwing
when the till is down, one till login for two people, warning at 15 days, creating
a person from a till person, a third caller of the client, a pay rate in the
answer, a manager allowed to match).

### Reconcile: unmeasured cards read as "not verified", not as a difference (P4-12d)

- On the Reconcile screen's panel for today, a till whose card takings were not
  measured against the card processor (the cstore till's single card total, the
  processor off or not configured, or unreachable) showed *Total sales* as a red
  difference against zero, for example "$3743.68 / $1397.84 (+$2345.84)". It now
  reads "$3743.68 reported, not verified", with no difference. Measured tills,
  including a measured zero, are unchanged, and so is the history table (it
  already said "not verified"). The page is shared, so the live app and the
  Operations app are both fixed; the server sent the right figures all along.

New: `ui-recon-unverified`, seen failing against the old page (46 assertions);
`ui-reconcile-past` now also freezes the old detail function and shows the
Apps Script screen differs from it only in those lines.

### The vape till's sales by channel on the Sales screen (P5-03b)

- In the Operations app, the **Sales** screen has a new section, **From the till**,
  under the totals when the **All** or **Vape** view is selected. It shows the vape
  till's own sales for the same dates in its three channels (in store, online,
  delivery) and all together: the total, before tax, tax, refunds, the number of
  sales and refunds, and for delivery the orders and the delivery fees (which are
  already inside its figures), and the same lines for the day you have open. It sits
  beside what the cashiers entered and is never added into the totals, the trend
  or the bars, and nothing from the till is saved. A range longer than 92 days is
  cut to the newest 92 and says so; a day the till reported nothing for says
  "no figures", not $0.00; a day whose takings do not add up is counted as the
  till reports it and marked "to check in the till". Beside it, "Entered at close"
  and "Rung at the till" are shown with their difference and no verdict.
- When the till cannot be read (switched off, not set up, its store not matched,
  down, slow, refusing the key, answering nonsense) the section says which in one
  line, and the rest of the Sales screen is unchanged and does not wait for it.
  Switched off is only said to an admin. Inside Apps Script the Sales screen is
  exactly as it was.
- One new call, `rpcGetSalesByChannel` (the Sales screen's own roles, read only,
  8 seconds at most). The till's client now has four named callers.

### The assistant's tools for the receipt inbox (P5-12b)

- An AI assistant connected with a key (Operations app only) can now see which
  receipt originals are waiting to be read (`receipts_to_read`, oldest first)
  and be shown one exactly as it was kept (`receipt_original`: a photo as an
  image, a PDF as an embedded file; one larger than the new setting
  `assistant_show_max_mb`, default 8 MB, is not shown and never shrunk). Any
  key may list and be shown every waiting original, none set aside.
- With a key that may propose, it can hand an original over: the tool
  `receipt_upload_start` answers a one-time upload address and the assistant
  sends the raw file there with a plain `PUT`
  (`/files/receipt-original/by-ticket/<ticket>`). A file never travels inside a
  tool call. The address is for one file, for 10 minutes, for that key; it is
  used up by the first PUT that sends a body, and every refused address gets the
  same 404. The file goes through exactly the checks and storage of the
  Receipts screen (size, type from the bytes, fingerprint, the same bytes kept
  once). Each address counts as one proposal against the key's daily cap.
- An emailed invoice keeps the message's id, sender and date, and
  `receipts_from_email` says whether an email has already been handed over (or
  has an address open), so a daily mailbox scan does not file it twice.
  `my_proposals` lists the key's upload addresses: waiting, confirmed (kept or
  already on file, naming the original) or refused (saying why).
- On the Receipts screen an original an assistant handed over says *added by
  <person>'s assistant (<key label>)*, and an emailed one shows its sender and
  date. Nothing is read from an original yet and nothing is confirmed.
- One new table (`ops.receipt_upload_tickets`, migration 0012, which also lets
  an emailed original keep its key and records refused PUTs with the door's
  calls); ADR-0025 and ADR-0026 amended.

New: `ops/test/mcp-receipts.test.ts` (the tools through the SDK's own client,
the upload route through the Worker) and assertions in the `ui-receipts` suite,
seen failing against eleven deliberate mutations (a ticket used twice, the
ticket stored instead of its hash, a ticket alive after its key is withdrawn, an
expired ticket answered differently, a read key starting an upload, the
declared type trusted over the bytes, a set-aside original shown, another tool
answering a file, a file name in the call record, tickets outside the daily
cap, an `Origin` accepted on the upload route).

### A nightly copy of every table, and a restore that has been tried (P4-06a)

The Operations app's hosted database has no automatic backups, so the app now
makes its own, and a tool proves one can be restored. The Sheet copy that the
plan also wants (P4-06) is a later card; this one needs no Google credentials.

- Every night at 03:00 Toronto time (the Worker is scheduled at 07:00 and
  08:00 UTC and the job runs only the one that is 03:00 there, on the clock
  change days too) the app writes every table to dated files in a new R2
  bucket, `BACKUPS` (`storeops-backups`): newline-delimited JSON, money as
  strings, instants in UTC, NULL as `null`, in parts of at most 5,000 rows or
  about 2 MB, then `manifest.json` last (every file's table, part, rows, length
  and SHA-256, the newest migration, per-table totals). A folder without a
  manifest is an incomplete copy.
- The whole copy is read in one read-only, repeatable-read transaction, so every
  table is as of one instant, and it blocks nothing and writes one audit row.
- Every table of the database is copied, found from the catalogue at run time,
  except a short written list with a reason each: live sign-ins, failed sign-in
  counts, one-time upload tickets, the record of assistant calls, the
  migration tool's own bookkeeping. Hashes of PINs and of assistants' keys are
  copied. Receipt originals are not (their own bucket); their records are.
- The app can only add: no delete, no overwrite; a second copy the same day goes
  to a new folder. Keeping 90 days is a lifecycle rule on the bucket, not code.
- Settings (More, Settings) shows an admin one line: "Last copy: …, n tables,
  rows" or a warning (never run, the last run failed, or the newest good copy is
  more than 36 hours old), and "Make a copy now" (`rpcRunBackupNow`, admin only,
  one at a time). One audit row per run: `backup.nightly` or `backup.failed`
  (never a row's content). A failed copy never throws out of the scheduled
  handler, so the Monday run is untouched.
- `npm --prefix ops run restore:nightly -- <folder> [--dry-run]` loads a
  downloaded copy into an empty, freshly migrated local database in one
  transaction: it checks the manifest and every file's length and SHA-256 first,
  refuses a database with rows or an older migration, sets the identity counters
  to continue after the restored rows, reads every table back out and compares
  row counts, money sums per month and a SHA-256 of each part, and ends with one
  line. Nothing is kept unless every table matches.
- `docs/components/backups.md`, `docs/guides/restore-a-nightly-copy.md` (for the
  owner, with the Windows differences), ADR-0028, the overview's second bucket
  and the nightly job.

New: `ops/test/backup-*.test.ts` (the format as a table both ways; the round
trip of the fictional fixture into a second database: every table equal value
for value, the cutover reading equal, identity counters continuing, a PIN
signing in; one consistent picture with a till close committed mid-copy; the
table list; parts; the manifest; failures; the scheduled handler for every day
of two years; who may press the button; the restore's refusals), and
`tests/suites/ui-backups.js`. The code was written before the tests; each test
was then proved by a deliberate mutation (the manifest first, a table per
transaction, money as a float, a table left out silently, a restore into a
database with rows, a file with a wrong SHA-256, identity counters not reset, a
manager allowed to copy, a failed copy stopping the Monday job, a folder
overwritten), every one seen failing.

### Receipt drafts: what was read off a receipt, checked by the app (P5-05a)

- An AI assistant with a key that may propose can now send the figures it read
  off one stored receipt (`receipt_propose`): supplier, invoice number, date,
  how it was paid, subtotal, HST, other charges, total, kind of purchase, what
  the receipt prints about the buyer, the lines, and where each figure was
  read. An admin or a manager can type the same figures by hand on a waiting
  receipt (**Enter the figures by hand**). Either way it is kept as a **draft
  that counts for nothing** until a person confirms it (the next card).
- **The app decides the business**, from what the receipt prints about the
  buyer and the signs on the Businesses screen: one business matched says
  which signs decided it; signs of both businesses, or none, leave it not
  known. The reader's guess, the supplier and the business chosen at upload
  never decide it (the last is shown beside, and a disagreement is flagged).
- **The app checks the arithmetic, exactly, in cents**: the lines add up to the
  subtotal, the parts to the total, the HST is plausible for the rate (new
  setting `hst_rate_percent`, default 13), the date is a real day and not in
  the future or over 7 years old, the same invoice is not already on file in
  either business, the supplier's HST number has the right shape. A draft that
  fails a check is kept and marked *needs attention*, with each failure in a
  sentence with its numbers; it is refused only when it is no draft at all. A
  figure not on the receipt stays blank and reads *not on the receipt*. Money
  has two decimals; a line's unit price may have four (fuel at 1.459 a litre),
  and nothing is computed from quantity × unit price.
- On the Receipts screen a read receipt moves to **Read, waiting for review**
  (admin, manager, payroll admin), and opens with what was read beside the
  original, read only. An employee sees that their receipt *has been read*.
- A new reading of the same receipt replaces the old one (which is kept) until
  a person has typed it; nothing is deleted, and every draft is in the audit
  log. Four new tables (migration 0013) and ADR-0027.

New: `ops/test/receipt-drafts.test.ts` and assertions in the `ui-receipts`
suite, seen failing first and against thirteen deliberate mutations (float sums,
the reader's suggestion deciding the business, a business picked when the signs
conflict, a left-out HST stored as 0, a total that does not add up refused, a
read key proposing, an assistant replacing a hand-typed draft, a removed sign
counted, a duplicate missed in the other business, a supplier created from an
assistant's draft, two live drafts for one original, a third decimal accepted on
money, a fifth decimal accepted on a unit price).

### Receipts: review beside the original, confirm onto one business's books, void a mistake (P5-05b)

In the Operations app only. A person now makes a receipt count.

- **Review.** An admin or a manager taps a receipt in *Read, waiting for
  review* and sees the original (on a phone above the fields, kept in sight and
  made large on request; on a wide screen beside them) with every field
  editable: the supplier as printed and the supplier on the list (find by any
  spelling, or add a new one), invoice number, date, how paid, subtotal, HST,
  other charges, total, kind, what is printed about the buyer, the business
  (as the signs say, or chosen) and the lines. **Save corrections** keeps a new
  reading (the old one is kept unchanged) and the app re-runs every check and
  the business decision; each failed check reads as a sentence. Typing the
  figures by hand now goes straight into the review.
- **Confirm.** Needs a date, a kind, a business and a supplier besides the
  total. The last sheet says in large words *This goes on the books of
  <business>*, lists any failed check (a reason is then required) and offers,
  unticked, each card, name, HST number or account printed on the receipt that
  is not yet a sign of that business (an admin may tick them; a manager sees
  them greyed), and *remember this spelling* of the supplier. A duplicate of a
  receipt already on the books needs an admin. A confirmed receipt cannot be
  changed by anyone, and records what the reviewer changed compared with the
  first reading.
- **On the books.** A new group for admin, manager and payroll admin, one
  business at a time (never both together): newest first, filtered by date
  and kind, with the count, subtotal, HST and total of the filter. A receipt
  opens read only beside its original, with what was changed and who read it.
- **Void.** An admin or a manager voids a confirmed receipt with a reason: it
  stays on the list, marked voided and out of the totals, and the original goes
  back to review with a copy of its figures to correct and confirm again. Signs
  and spellings learnt from it are listed and not removed.
- An employee sees that their receipt *is on the books*. An assistant's
  `my_proposals` shows a draft confirmed (with how many fields were changed) or
  refused; no assistant tool can confirm, correct or void.
- Migration 0014 (columns on the receipt tables, the status *confirmed*, and a
  trigger that keeps a confirmed receipt final), eight new RPCs and ADR-0029.

New: `ops/test/receipt-review.test.ts` (48 tests) and the review, confirm,
books and void assertions in the `ui-receipts` suite, seen failing first (no
module, no functions) and against fourteen deliberate mutations, each restored
byte for byte.

### The old purchase list brought in as history (P5-16)

- The owner's old purchase list (one tab of a workbook: date, supplier typed by hand, amount, note) comes into the app as history, marked *from the old list: no original on file*. It is not turned into receipts, never appears in *On the books* or its totals, and is never offered to an assistant. Every row is kept exactly as it was (the row number as seen in the spreadsheet, the supplier text with its odd spacing, the amount to the cent); a row with no date, no amount, an amount that is not a number or a date before 2000 or after the day of the import is rejected and listed, never guessed. Exact repeats are all kept.
- A tool the owner runs on their own computer, `npm --prefix ops run import:purchases`, finds the four columns by their headings (never by position), has `--dry-run`, never prints or writes a cell value (counts, row numbers and reasons only), refuses a database that is not on this computer, and records itself under an active admin (`--as`). The same file again adds nothing; a changed file needs `--replace-file <old sha256>`, which marks the old rows replaced (never deleted) and carries their business and supplier over to the matching new rows. The workbook reader gains one option, the header in row 1; its default is unchanged.
- On the Receipts screen, the group *Old purchase list* (admin, manager and payroll admin): the supplier spellings, most rows first, and the rows by cstore, vape or not sorted. Admin and manager set the business for one row or for every row written one way, and link a spelling to a supplier (the supplier then also learns that spelling, `old_list`, so a future receipt printed that way is matched). Nothing sets the business automatically.
- Migration 0015 (two tables, and `old_list` as a way a spelling is learnt), four RPCs, [the guide](docs/guides/import-the-old-purchase-list.md).

New: `ops/test/legacy-purchases.test.ts` and the old-purchase-list assertions in the `ui-receipts` suite, seen failing against twelve deliberate mutations, each restored byte for byte.

### Costs from receipt lines, and price-rise flags for a manager (P5-15)

For the Operations app. What each item costs from each supplier is now kept
from the receipts on the books, and a rise is flagged for a manager to decide
on. The app changes no selling price: those live in the tills.

- **An item is a supplier's own line**: the business, the supplier and the
  supplier's printed code for the line, else its description. There is no
  product list here, so the same goods from two suppliers are two items. An admin
  or a manager can say two items are the same (**This is the same item as…**,
  with a reason); nothing moves or is erased, the histories read as one, and it
  can be undone.
- **A cost is kept when a receipt is confirmed**, for each line that gives one
  exactly: a printed unit price (up to four decimals), or the line total divided
  by the quantity, worked out exactly and rounded half up to four decimals and
  marked *worked out from the line total*. A line with no price, a quantity or
  total of zero or less, or too little to know is counted as *no cost* and is
  never stored as 0 or guessed. Costs are as printed, before tax.
- **A flag** when a cost is more than a set percentage above the one before it
  from the same supplier (the new setting `price_rise_flag_percent`, default 5),
  compared in the order of the receipts' dates, in whole numbers, never floats.
  *New*, *Seen*, *Price raised* (with an optional note) or *Withdrawn* (by the
  app, when a receipt it rested on was voided or an older receipt changed the
  history). Changing the setting does not rewrite old flags.
- **More → Costs** (admin, manager, payroll admin; one business at a time): the
  flags as sentences (*Cola 12-pack from Fictional Wholesale: $6.00 → $6.72 each,
  up 12.0%, on the receipt of Nov 20*), find an item, its history with the costs
  that are not counted apart, and, for an admin, **Work out costs for earlier
  receipts**. After a confirm or a void the result sheet says what it did to the
  cost history.
- Migration 0016 (four tables: `supplier_items`, `item_costs`, `price_flags` and
  `receipt_observations`; the app role cannot remove or rewrite a row), six new
  RPCs, `rpcConfirmReceipt` and `rpcVoidReceipt` answer a `costs` summary, and
  ADR-0030.

New: `ops/test/costs.test.ts` (134 tests), checked against twelve deliberate
mutations (each restored byte for byte), and `tests/suites/ui-costs.js` (139
assertions).

### A day worked with no pay rate shows as "no rate set", not $0 (P4-11b)

In the Operations app only; the Apps Script app is unchanged
([ADR-0031](docs/adr/0031-a-day-with-no-rate-is-not-a-day-at-zero.md)).

- **A blank rate is stored blank.** When a till closes for someone whose hourly
  rate is blank (every new hire a manager adds, until an admin sets their pay),
  the day is stored with no rate instead of 0. A real rate of 0 is still 0.
  Days already at 0 are not rewritten.
- **Payroll** says *"N days worked with no rate set"* on the person's card, with
  the dates and hours, that nothing can be paid for them, and how to fix it on
  the Staff screen; the totals owed leave them out and say *not counted: N days
  with no rate*.
- **My Pay** says *Hourly Rate: no rate set* (a real 0 still reads $0.00/hr)
  and lists those days with *no rate set* where the value would be.
- **Paying shifts** never pays such a day: it is skipped and named; when only
  such days are left the payment is refused (*"<name> has no pay rate set: set
  it on the Staff screen first."*).
- For everyone with a rate, every answer and every row written is exactly as
  before: the 1,020 comparison cases pass unchanged.

New: `ops/test/no-rate.test.ts` (with the pre-change answers pinned in
`ops/test/fixtures/no-rate/pre-change.json`) and `tests/suites/ui-no-rate.js`,
both seen failing against the code before the change.

### Emailed invoices through the assistant (card P5-13)

- **Every email the assistant has dealt with is remembered**, including the ones
  with nothing to file, so tomorrow's scan skips them: the new tool
  `receipt_email_done` records an email as *filed*, *nothing to file* or *could
  not be read*, with a note. *Filed* is refused when no receipt from that email
  is on file, *nothing to file* when one is. Recording an email again updates it
  and keeps the time it was first seen; each recording is audited.
- **One spelling of a message id.** `<abc@x>` and `abc@x` are the same email:
  surrounding white space, direction marks and one pair of angle brackets are
  ignored when ids are compared; case is kept. Receipts already filed with their
  brackets are still found, and no old row is rewritten. The tool descriptions
  and the instructions say to use the email's Message-ID header, never a mail
  provider's own id.
- **Several attachments of one email** are several originals that can be told
  apart: each keeps the attachment's name as the email gives it and its place
  among the attachments. `receipts_from_email` now answers the whole picture per
  email (recorded or not, its originals with their attachment and status, any
  open upload address).
- **An invoice that is the email's own text** is kept as a **PDF print** of the
  email, marked as one: *A print of the email itself, made by the assistant: not
  the original message.* It must really be a PDF. The review repeats the notice
  above the original: a print can be wrong or incomplete.
- **More → Receipts → Emails checked** (admin, manager, payroll admin): every
  email, newest first, a page at a time, with who sent it, its subject, what came
  of it, how many receipts, and which assistant recorded it. The ones that could
  not be read are on top, in red: *A person should look at this one.* An emailed
  original's row says which attachment it was.
- **Nothing in an email is trusted.** The subject, sender, attachment name and
  note are cleaned, capped, stored as text and shown escaped; no tool takes an
  instruction. **The app still has no access to email**: a test reads every file
  under `ops/src/` for a mail host, library or protocol.
- A new guide, [Scan the mailbox for invoices](docs/guides/email-invoice-scan.md):
  what to connect (the mailbox read only, and the Operations app, nothing else),
  the instructions to paste into the scheduled task, what a day of ten invoices
  costs against the key's limits, and what to check after the first run.
- Migration 0017 (`receipt_emails`; the attachment, subject and print columns on
  originals and upload addresses; `ops.message_key`), one new RPC
  (`rpcGetReceiptEmails`) and one new tool; `receipt_upload_start` now needs
  `attachment` or `print: true` for an emailed file.

New: `ops/test/receipt-emails.test.ts`, checked against ten deliberate mutations
(each restored byte for byte), and new assertions in `tests/suites/ui-receipts.js`.

### Receipts of every kind in one form (P5-05c)

The owner gets "a mix of everything": plain receipts, invoices, credit notes,
tax-included meal receipts, invoices in US dollars, statements. They all go
through the same form, the same assistant tool and the same checks. There is no
switch for the kind of document and no separate path.

- **Four optional facts about the document**, near the totals on the by-hand
  sheet and the review: *What it is* (receipt, invoice, credit note, statement,
  other), *Currency printed*, *Tax inside the price* and, only when another
  currency is typed, *Canadian amount paid*. Each is blank until the document
  says. Each other charge gains *What it is* (deposit, eco fee, tobacco tax,
  duty, delivery, tip, discount, other) and *Taxed itself*. A plain receipt is
  stored and checked exactly as before.
- **The checks adapt, and still only flag**: charges marked taxed are in the HST
  base; with tax inside the price the check says the most the HST could be
  (*at most about $5.20, if every line is taxed*) and flags an HST given as well;
  another currency is not checked for HST, and says why. A credit note printed
  positive, a negative total on anything else, a statement and another currency
  are each flagged in words. No sign is changed.
- **One rule of what counts on the books**: a credit note counts as minus,
  whatever sign is printed; a statement is kept on file and counts as nothing; a
  document in another currency counts as its Canadian amount paid and waits until
  that is known. The confirm sheet says how it will count. *On the books* marks
  each kind, and its totals line names everything left out, with counts. Sums
  are exact, by the database, and a test proves its rule equal to the app's.
- **Add the Canadian amount paid** (admin, manager): once, to a confirmed receipt
  in another currency, with who and when. It is the only thing a confirmed
  receipt can ever be given; the database refuses a second one. A wrong amount
  is voided and redone.
- **The cost history** leaves out a foreign document's, a statement's and a
  credit note's lines, and says why.
- `receipt_propose` takes the same facts; its description tells the assistant
  to report them as printed and work nothing out.
- Migration 0018 (four columns and who added the Canadian amount; the
  final-receipt trigger allows that one addition), `rpcAddReceiptCanadianAmount`,
  and ADR-0032.

New: `ops/test/receipt-kinds.test.ts` (34 tests; 33 of them seen failing against
the code before the change), 58 new assertions in `tests/suites/ui-receipts.js`,
and thirteen deliberate mutations, each restored byte for byte.
