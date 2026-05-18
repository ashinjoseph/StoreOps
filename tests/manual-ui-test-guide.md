# StoreOps — Manual UI Test Guide

Real-world testing of the full StoreOps app. No scripts to paste, no Apps
Script editor — just open the web app URL on your phone (or browser) and
go through each scenario.

This guide assumes you've deployed batch 4 (the web app) and have at least
two staff in your `staff` sheet: yourself as `admin` and someone else as
`employee`. Add a third with role `manager` if you want to fully test
manager-only paths.

> If anything doesn't match what's described, **stop on that test, note
> what differed, and tell me**. Don't keep going on a broken assumption.

---

## Before you start

In your `staff` sheet, make sure you have at least:

| staff_id | name | hourly_rate | active | role | login_code | companies_authorized |
|----------|------|-------------|--------|------|------------|----------------------|
| S_001 | (your name) | 0 | TRUE | admin | (your PIN) | cstore,vape |
| S_002 | Blesson | 12.00 | TRUE | employee | 1003 | cstore,vape |
| S_003 | (someone) | 14.00 | TRUE | manager | 5678 | cstore,vape |

Open the web app URL. You should see a deep-navy sign-in screen with a
dropdown of names and a 4-digit PIN field.

---

## §1 — Login + role visibility

### T1.1 Sign in as admin
- Open the URL
- Pick your name from the dropdown
- Type your PIN, tap **Sign in**
- **Pass**: header shows your name + "admin" pill; bottom nav shows
  **all 5 tabs**: My Shift, Schedule, Payroll, Sales, History

### T1.2 Sign in as employee
- Sign out (top right ⏻)
- Pick Blesson, type `1003`
- **Pass**: bottom nav shows **3 tabs only**: My Shift, Schedule, History.
  No Payroll, no Sales.

### T1.3 Sign in as manager
- Sign out, pick the manager, type `5678`
- **Pass**: bottom nav shows **4 tabs**: My Shift, Schedule, Sales, History.
  No Payroll.

### T1.4 Failed sign-in
- Sign out, pick any name, type a wrong PIN
- **Pass**: red error banner "Invalid name or code"; PIN field clears

### T1.5 Lockout
- Type wrong PIN 5 times in a row for the same name
- **Pass**: 6th attempt shows "Too many failed attempts. Try again in X minutes."
- **To recover** (without waiting): in Apps Script editor, run any function
  manually — or wait 60 minutes — or open the script properties UI and
  delete the `loginFails:<name>` entry.

### T1.6 Remembered name
- Sign out
- **Pass**: the dropdown remembers the last name you signed in as

### T1.7 Session persistence
- Sign in as admin
- Close the browser tab completely
- Reopen the URL
- **Pass**: you land directly on My Shift, no re-login required
- **Why**: the token is in `sessionStorage` (24-hour rolling expiry)

### T1.8 Session timeout
- Sign in, then in Apps Script editor run:
  `PropertiesService.getScriptProperties().deleteAllProperties();`
- Now interact with any tab (e.g. switch tabs)
- **Pass**: yellow toast "Session expired — please sign in again"; returned
  to login screen

---

## §2 — My Shift (the cashier flow)

Sign in as Blesson for these tests.

### T2.1 Initial state — nothing open
- **Pass**: Two cards visible — CSTORE and VAPE — both with grey "Closed"
  pill, "Expected float: $250" or $100, and a navy "Open" button each.
- "Today" summary card is **not** visible (nothing happened yet today)
- Recent shifts section is hidden if no closed shifts in last 7 days

### T2.2 Open cstore shift (matching float)
- Tap "Open CSTORE"
- Sheet slides up: "Open CSTORE shift / Count the cash in the till"
- Fields: Counted float, Note (required if count ≠ expected)
- Type `250` in Counted float
- Tap "Open shift"
- **Pass**: sheet closes, green toast "✓ CSTORE shift opened", page refreshes,
  CSTORE card now shows green border with status "Open", "Started: HH:MM",
  "Running: 0h 00m" (will tick up), "Float: $250.00", and a red "Close CSTORE" button.

### T2.3 Try to open cstore again
- Sign out, sign back in (or just refresh)
- The CSTORE card should still show "Open" with red Close button
- Tap "Open VAPE" (it's still closed)
- **Pass**: vape modal opens normally (different company)

### T2.4 Open vape shift with float mismatch (no note)
- In the open vape sheet, type `90` (expected is 100)
- Leave the note blank
- Tap "Open shift"
- **Pass**: red toast like "Float mismatch: expected $100.00, counted $90.00. An opening note is required." Sheet stays open.

### T2.5 Open vape with mismatch + note
- Same modal, type "Drawer was short overnight" in the note
- Tap "Open shift"
- **Pass**: sheet closes, green toast, both cards now show "Open"

### T2.6 Switch users mid-shift
- Sign out
- Sign in as your admin self
- Go to My Shift
- **Pass**: both cards show **orange border**, status pill "In use", text
  "Open by: Blesson · Started: HH:MM". Buttons show "In use by another"
  and are disabled.

### T2.7 Close cstore with sales
- Sign in as Blesson
- Tap "Close CSTORE"
- Sheet opens with sales-by-tender fields
- Fill in:
  - Cash sales: `500`
  - Credit card sales: `100`
  - Debit card sales: `300`
  - Cashback paid out: `50`
- Skip the "Misc sales" expandable section
- Cash counted in till: `700`
- **Live computation** at the bottom should show:
  - Expected cash: $700.00 (250 + 500 + 0 − 50 = 700)
  - Counted: $700.00
  - Variance: $0.00 (green)
- Tap "Close shift"
- **Pass**: green toast "✓ CSTORE closed · variance $0.00", page refreshes,
  CSTORE card shows "Closed" status, "Today" card still hidden (vape still open)

### T2.8 Close vape — attendance auto-completes
- Tap "Close VAPE"
- Cash sales: `50`, Credit: `0`, Debit: `0`, Cashback: `0`
- Cash counted: `150` (100 float + 50 cash sales)
- Variance should show $0.00 green
- Tap "Close shift"
- **Pass**: both cards now show "Closed". The **TODAY card now appears**
  with "TODAY · COMPLETED", showing total hours and 2 sessions.
- **Pass**: recent shifts section now lists both shifts you just closed
  with green "✓ OK" pills.

### T2.9 Variance — minor
- Open cstore again (count `250`)
- Close it: cash sales `500`, others `0`, cashback `0`, counted `745`
- Expected = 750, variance = -$5
- **Pass**: variance shows yellow "compute-variance-minor" color in live view
- After submit: green success toast (minor variance still OK)
- recent shifts pill: yellow "± -$5.00"

### T2.10 Variance — investigate
- Open cstore again
- Close it: cash sales `500`, counted `300`
- Expected = $750, variance = -$450 (way over $30 threshold)
- **Pass**: variance shows red in live preview; toast on submit shows
  warning yellow; recent shifts pill is red "⚠ -$450.00"

### T2.11 Misc sales section
- Open cstore, then in the close sheet, click the "Misc sales ▾"
  expandable
- **Pass**: three input fields appear (misc cash, misc credit, misc debit)
  plus a notes field
- Fill in misc cash `20`, complete normally
- Expected cash math should include the misc: opening + cash + miscCash − cashback

---

## §3 — Schedule (read-only as employee, edit as manager/admin)

Sign in as admin.

### T3.1 Week navigation
- Tap Schedule tab
- **Pass**: Header shows current week range "May 12 – May 18" with
  "This week" label. Grid below with one row per active staff member,
  columns for Mon-Sun.
- Tap `‹` button
- **Pass**: shows previous week, "Jump to this week" link appears

### T3.2 Today highlighted
- **Pass**: today's column header is highlighted with a soft yellow tint;
  cells in today's column also have the tint

### T3.3 Tap an empty cell to schedule
- Tap a future day's cell for any staff member
- **Pass**: sheet slides up with "Staff name / Day label" and two time
  fields (Scheduled start, Scheduled end)
- Type `09:00` and `17:00`
- Tap "Schedule"
- **Pass**: green toast "✓ Saved", page refreshes, that cell now shows
  blue "SCHEDULED" pill with "09:00–17:00"

### T3.4 Edit existing scheduled cell
- Tap the cell you just scheduled
- **Pass**: sheet opens with the times pre-filled; two buttons:
  "Cancel shift" (left) and "Save" (right)
- Change times to `10:00` / `18:00`, tap "Save"
- **Pass**: cell now shows the new times

### T3.5 Cancel a scheduled shift
- Tap the same cell, tap "Cancel shift"
- Confirm in the native dialog
- **Pass**: green toast "✓ Shift cancelled", cell goes back to "—"

### T3.6 Try to edit a worked shift
- Find a cell with green "WORKED" pill (your test work from §2)
- Tap it
- **Pass**: sheet opens but is **read-only** — shows status & hours but
  no editable fields, with a note "Cannot edit a shift that's in progress
  or worked". Single "Close" button.

### T3.7 Employee can view schedule but not edit
- Sign out, sign in as Blesson
- Tap Schedule
- **Pass**: same grid, but tapping a cell does **nothing** (cells aren't
  clickable). Note: there should be no "Tap any cell to schedule" hint
  text at the bottom.

---

## §4 — Payroll (admin only)

Sign in as admin. This requires that some attendance is in "worked" state
(do §2 first if you haven't, or manually edit a row in the `attendance`
sheet to status=`worked` with hours_worked > 0).

### T4.1 Payroll overview
- Tap Payroll tab
- **Pass**: top card shows "TOTAL OWED" with the sum across all staff,
  count of unpaid shifts, count of staff with owed amount
- Below: one card per active staff, each showing:
  - Name, hourly rate
  - Big "owed amount" on the right (grey if $0)
  - Unpaid shifts count + $ amount
  - Pending bonuses count + $ amount
  - "Pay Shifts" button (green) and/or "Pay Bonus" button (grey), or "All settled"

### T4.2 Pay full shifts amount
- For Blesson (assuming he has unpaid shifts), tap "Pay Shifts"
- Sheet opens listing each unpaid shift with date + hours × rate + remaining
- Amount field defaults to the full owed amount
- Progress bar shows 100% (green)
- Tap **"Pay Full"** button (rightmost green button)
- Native confirm: "Pay $X to Blesson?"
- Confirm
- **Pass**: toast "✓ Paid $X · N shifts settled", payroll page refreshes,
  Blesson's owed drops accordingly

### T4.3 Pay partial amount
- Re-open the close-shift modal somehow (or sign Blesson in and have him
  work another shift). Or you can edit `attendance` sheet manually:
  add a row with status=`worked`, hours_worked=5, rate_at_attendance=12,
  date in the past.
- Back in Payroll → tap "Pay Shifts"
- Edit the Amount field down to e.g. half the owed amount
- **Pass**: progress bar shrinks to ~50%; label shows "$X / $Y"
- Tap "Pay" (not Pay Full)
- Confirm
- **Pass**: toast like "✓ Paid $X · N shifts settled (1 partial)";
  Blesson's card still shows some unpaid (the partial shift)

### T4.4 Reject overpayment
- Try to pay more than owed (type a huge number in Amount, tap Pay)
- **Pass**: red toast like "Overpayment rejected: trying to pay $X but
  only $Y owed in unpaid shifts for Blesson."

### T4.5 No unpaid shifts
- Pay everything off (multiple Pay calls until owed is $0)
- **Pass**: card shows "$0.00" in grey, "All settled" disabled button
- Try to tap Pay Shifts (if button visible) — wait, button shouldn't be visible

### T4.6 Proposed commissions panel
- Run the commission engine: go to the sheet menu → 🏪 StoreOps →
  🔄 Run Commission Engine. (Assuming you have commission rules + sales
  data — see prerequisites for batch 3.)
- Go back to web app → Payroll
- **Pass**: amber "PROPOSED COMMISSIONS — needs approval" section at top
  showing each proposed bonus with staff name, amount, reason, Cancel/Approve buttons.
- Tap "Approve"
- **Pass**: toast "✓ Bonus approved", row disappears from proposed section,
  staff's "pending bonuses" count goes up by 1

### T4.7 Pay an approved bonus
- For a staff with pending bonuses (count > 0), tap "Pay Bonus"
- **Pass**: sheet lists each pending bonus with its remaining amount,
  type, company, reason
- Tap "Pay this bonus" on one
- **Pass**: a new sheet (replaces content) shows amount field pre-filled
  with full remaining, progress bar, method, notes
- Tap "Pay Full"
- **Pass**: confirm dialog, then toast "✓ Paid $X", bonus is now `paid`

### T4.8 Cancel a proposed commission
- Run engine again or have another proposed
- Tap "Cancel" on a proposed row
- Confirm in native dialog
- **Pass**: toast "Cancelled" (yellow), bonus disappears from proposed list

### T4.9 Manager cannot see Payroll
- Sign out, sign in as manager
- **Pass**: Payroll tab not visible in bottom nav

### T4.10 Manually call payroll RPCs as manager (security test)
- Sign in as manager
- Open browser devtools → Console
- Type: `google.script.run.withSuccessHandler(console.log).withFailureHandler(e => console.error(e.message)).rpcGetPayrollOverview(sessionStorage.getItem('storeops_token'))`
- **Pass**: console error like "FORBIDDEN: requires admin, got manager"

---

## §5 — Sales dashboard (admin + manager)

Sign in as admin (or manager).

### T5.1 Initial load
- Tap Sales tab
- **Pass**: filter card at top with Start date, End date (defaults to
  today and 6 days ago), Staff "All", Company "Both", Group by "Day & Company"
- Below: 4 total cards (Total / Cash / Credit / Debit), then a table

### T5.2 Apply filters
- Change date range to a wider window
- Tap "Apply"
- **Pass**: spinner, then results refresh

### T5.3 Filter by company
- Set Company to "Vape", tap Apply
- **Pass**: table now shows only vape rows; totals reflect that

### T5.4 Pagination
- If you have > 50 rows in the date range, the pagination at bottom
  shows "Page 1 of N", "‹ Prev" disabled, "Next ›" enabled
- Tap "Next ›"
- **Pass**: page 2 loads, "‹ Prev" now enabled, "Next ›" disabled on last page

### T5.5 Empty state
- Set date range to a window with no sales (e.g. far past)
- **Pass**: total cards show $0.00, table is empty or shows only the header

---

## §6 — History

### T6.1 Admin sees all payments
- Sign in as admin
- Tap History
- **Pass**: list of payments, newest first, max 25
- Each item shows: staff name, date, method, item count, total amount

### T6.2 Show items
- Tap "Show items" on a row
- **Pass**: expands inline showing each payment_item (shift/bonus type, ref_id, amount)
- Tap "Hide items"
- **Pass**: collapses

### T6.3 Undo a payment
- For any non-trivial test payment, tap "Undo this payment" (red text)
- Confirm in native dialog
- **Pass**: toast "Payment undone" (yellow), list refreshes, payment removed
- **Pass**: go back to Payroll — the relevant staff's owed amount has gone back up

### T6.4 Employee sees only own
- Sign in as Blesson
- Tap History
- **Pass**: only Blesson's payments shown (or empty if none)
- **Pass**: no "Undo this payment" button visible

### T6.5 Manager sees all but cannot undo
- Sign in as manager
- Tap History
- **Pass**: all payments visible (same view as admin)
- **Pass**: no undo button visible (manager isn't admin)

---

## §7 — Things to verify across the whole app

### T7.1 Refresh recovers state
- On any tab, hit browser refresh (or pull down to refresh on mobile)
- **Pass**: app reloads, you're still signed in, same tab is active

### T7.2 Open shift survives refresh
- Open a cstore shift as Blesson
- Refresh the page
- **Pass**: My Shift still shows the open shift with the correct running time

### T7.3 Tab switch is instant
- Tap between My Shift, Schedule, Payroll, etc.
- **Pass**: tab content changes within ~200ms (spinner briefly visible while loading)
- **Pass**: tabs animate in with a small fade

### T7.4 Sign out clears state
- Sign out
- Open browser devtools → Application tab → Session storage
- **Pass**: no `storeops_token` or `storeops_me` entries
- **Pass**: localStorage still has `storeops_last_name` (intentional —
  remembers the last name across logins)

### T7.5 Two browsers / two devices
- Sign in as Blesson on phone, open cstore shift
- Sign in as admin on laptop
- Go to My Shift on laptop
- **Pass**: admin sees cstore card with "In use by Blesson" status (orange)

### T7.6 Network error handling
- Turn off WiFi briefly
- Try to do any action (tap a tab, submit a form)
- **Pass**: error toast appears with whatever Apps Script returns; nothing crashes
- Turn WiFi back on and retry — should work

### T7.7 The audit log captures everything
- Do a sequence: login → open shift → close shift → pay → undo → logout
- Open the `audit_log` sheet in your StoreOps spreadsheet
- **Pass**: each operation has at least one row, with actor_id, timestamp, action, details

---

## §8 — Edge cases I want you to verify (real-world stuff)

### T8.1 What if both companies have unmatched float?
- Sign in as Blesson
- Tap Open CSTORE, type `260` with note "extra 10"
- Tap Open VAPE, type `95` with note "missing 5"
- Both should succeed
- **Pass**: both cards show "Open" status with the actual counted floats

### T8.2 Sign in as Blesson but try to close someone else's shift
- Sign in as admin, open a cstore shift as **admin** (not Blesson)
- Sign out, sign in as Blesson
- Tap My Shift
- **Pass**: cstore card shows "In use by [admin]" (orange), close button disabled

### T8.3 Schedule something for the past
- Admin → Schedule → navigate to last week
- Tap a cell from yesterday for Blesson
- Type `09:00` / `17:00`, tap "Schedule"
- **Pass**: scheduled row appears (legitimate — admin might back-fill records)
- **Note**: this is intentional behavior; backdating is allowed

### T8.4 Schedule then have employee work it
- Admin schedules Blesson tomorrow `09:00` / `17:00`
- Tomorrow comes (or change the row's date to today in the sheet for testing)
- Blesson signs in, opens cstore
- **Pass**: in the `attendance` sheet, his existing scheduled row is
  **promoted** (status changes from `scheduled` → `in_progress`, actual_start filled).
  No duplicate row created.

### T8.5 Try to cancel a paid attendance
- Pay Blesson for some shifts first
- Go to `attendance` sheet, find his paid attendance row
- The cancel action isn't exposed in UI (intentionally), but the underlying
  `Attendance.cancel` function would refuse if you tried to use it. **No UI test needed**.

---

## §9 — Commission engine integration

### T9.1 Set up a rule
- Open `commission_rules` sheet directly
- Add a row: rule_id `CR_001`, name "Cstore weekly", applies_to `all_staff`,
  staff_id (blank), company `cstore`, threshold `500`, percentage `5`,
  active TRUE, effective_from yesterday's date
- Save

### T9.2 Ensure there are sales
- You should have at least one closed cstore shift with $500+ in sales
  from §2's testing

### T9.3 Run engine manually from menu
- In the spreadsheet → 🏪 StoreOps → 🔄 Run Commission Engine (last week)
- **Pass**: dialog reports "Commission run complete · X staff · Y bonuses
  · $Z total"

### T9.4 See proposed commission in app
- Open web app, sign in as admin, tap Payroll
- **Pass**: amber proposed section at top with the new commission

### T9.5 Approve + pay
- Tap Approve → toast → moves out of proposed
- Bonus is now `pending` in `bonuses` sheet
- Tap "Pay Bonus" on that staff's card → pay full
- **Pass**: bonus status flips to `paid` in sheet; payment in History

### T9.6 Re-run protection
- Run the engine again from menu
- **Pass**: dialog asks "A commission run for this week already exists.
  Run again? This will create DUPLICATE bonus rows for the same week."
- Tap No
- **Pass**: nothing happens (skipped)
- Run again, tap Yes
- **Pass**: it does re-run; you can clean up duplicates manually

### T9.7 Auto-trigger install
- Menu → 🗓️ Install Weekly Auto-Trigger
- **Pass**: dialog confirms "Trigger installed · MONDAY at 9:00"
- Verify in Apps Script editor → Triggers (left sidebar)
- **Pass**: a `commissionsTriggerHandler` time-driven trigger exists
- Menu → 🛑 Remove Weekly Auto-Trigger
- **Pass**: dialog confirms "Removed 1 trigger(s)"

---

## When everything passes

- Foundation, shift lifecycle, payments, commissions, UI — all integrated
- Audit log shows every operation
- Multi-role access works as designed
- Edge cases handled (mismatch, overpayment, busy company, scheduled→worked promotion)
- Auto-trigger ready for production

Tag the version (`v1.0.0`), create a new deployment in Apps Script,
update your "production" deployment to point at it, and you're live.

---

## If anything fails

Note:
1. Which test number
2. What you did
3. What you expected
4. What actually happened (screenshot if possible)
5. Any error message from the toast or browser console

That's enough for me to debug quickly.
