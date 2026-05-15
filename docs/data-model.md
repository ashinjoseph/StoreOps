# Data Model — StoreOps v1

14 tabs, all in one Google Sheet. Relationships are by ID columns.

## Conventions

- **IDs** are short opaque strings with semantic prefixes
- **All money** stored as numbers in dollars (e.g. `12.50`)
- **All dates** stored as real Date values, never strings
- **Booleans** stored as `TRUE`/`FALSE` checkboxes
- **Status fields** use a small fixed vocabulary per table

## ID conventions

| Entity | Prefix | Example | Notes |
|--------|--------|---------|-------|
| Staff | `S_` | `S_001` | Sequential, padded to 3 digits |
| Attendance | `A_` | `A_20260514_S_001` | Deterministic: date+staff → no dupes |
| Till session | `CST-` / `VAP-` | `CST-20260514-S_001` | Per company, per staff, per date |
| Payment | `P_` | `P_20260514_142301_a7b` | Timestamp + random suffix |
| Payment item | `IT_` | `IT_20260514_142301_x9k` | One per allocation |
| Bonus | `B_` | `B_20260514_142301_f2e` | Includes commissions |
| Commission rule | `CR_` | `CR_001` | Sequential |
| Commission run | `CRN_` | `CRN_20260518_093001` | One per Monday run |
| Audit log | `LOG_` | `LOG_20260514_142301_q1z` | One per event |

## Sheets

### 1. `staff`

| Col | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| A | staff_id | string | yes | `S_001`. Auto-generated; immutable. |
| B | name | string | yes | Display name (renames cascade to audit log). |
| C | hourly_rate | number | yes | Current rate; past attendance keeps its own rate. |
| D | active | bool | yes | Inactive = hidden from dropdowns; history kept. |
| E | role | enum | yes | `admin` / `manager` / `employee` |
| F | login_code | string | yes | 4-digit PIN; treat sheet as sensitive. |
| G | companies_authorized | string | yes | `cstore`, `vape`, or `cstore,vape` |
| H | email | string | no | Optional; reserved for future Gmail auth. |
| I | start_date | date | no | First day of employment. |
| J | created_at | date | yes | When the row was added. |
| K | notes | string | no | Free text. |

### 2. `attendance` — the payroll source of truth

One row per person per workday. Rate is snapshotted at close time so
later rate changes don't retroactively re-price.

| Col | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| A | attendance_id | string | yes | `A_20260514_S_001`. Deterministic. |
| B | staff_id | string | yes | FK → staff |
| C | date | date | yes | Workday date |
| D | scheduled_start | string | no | `HH:MM` (admin-set in advance) |
| E | scheduled_end | string | no | `HH:MM` |
| F | actual_start | datetime | no | Cashier-recorded on first till open |
| G | actual_end | datetime | no | Set when last till_session closes |
| H | hours_worked | number | no | Computed: actual_end − actual_start, in hours |
| I | rate_at_attendance | number | no | Snapshotted at attendance close |
| J | status | enum | yes | `scheduled` / `in_progress` / `worked` / `cancelled` |
| K | notes | string | no | |
| L | created_by | string | yes | staff_id of whoever triggered creation |
| M | created_at | datetime | yes | |
| N | modified_by | string | no | |
| O | modified_at | datetime | no | |

**Status semantics:**
- `scheduled` — admin set this up in advance; no actual_start yet
- `in_progress` — cashier opened a till session, attendance auto-created
- `worked` — last till session closed; actual_end set; payable
- `cancelled` — never happened; ignored in payroll

A shift is "paid" iff its `attendance_id` appears in `payment_items` with
`item_type = 'shift'` summing to ≥ `hours_worked × rate_at_attendance`.

### 3. `till_sessions` — per-company cash reconciliation

One row per (date, staff, company). Lifecycle: open → closed → validated.

| Col | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| A | session_id | string | yes | `CST-20260514-S_001` or `VAP-...` |
| B | attendance_id | string | yes | FK → attendance (parent workday) |
| C | staff_id | string | yes | Denormalized for fast queries |
| D | company | enum | yes | `cstore` / `vape` |
| E | date | date | yes | Same as parent attendance |
| F | status | enum | yes | `open` / `closed` / `validated` |
| G | start_time | datetime | yes | When cashier opened |
| H | end_time | datetime | no | When cashier closed |
| I | expected_opening | number | yes | Float from config |
| J | opening_float | number | yes | What cashier counted at open |
| K | opening_note | string | no | Required if mismatch |
| L | closing_cash_counted | number | no | Full till count at close |
| M | cash_left_in_till | number | no | Standard float (e.g. $250) |
| N | cash_removed_at_close | number | no | counted − float = takings |
| O | expected_cash | number | no | opening + cash_sales + misc_cash − cashback |
| P | closing_variance | number | no | counted − expected |
| Q | variance_status | enum | no | `OK` / `minor` / `investigate` / `pending_validation` |
| R | notes | string | no | |

(ATM tracking removed per design — handled separately if ever needed.)

### 4. `sales` — sales by tender, per till_session

| Col | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| A | sales_id | string | yes | Same as session_id (1:1) |
| B | session_id | string | yes | FK → till_sessions |
| C | staff_id | string | yes | Denormalized |
| D | company | enum | yes | Denormalized |
| E | date | date | yes | Denormalized |
| F | cash_sales | number | no | From POS by tender |
| G | credit_card_sales | number | no | |
| H | debit_card_sales | number | no | |
| I | cashback_paid | number | no | Cash given out via debit |
| J | hst_collected | number | no | Tax field |
| K | bottle_deposit | number | no | Regulatory field |
| L | round_off | number | no | Round-off field |
| M | misc_cash_sales | number | no | Service fees not in POS |
| N | misc_credit_sales | number | no | |
| O | misc_debit_sales | number | no | |
| P | misc_notes | string | no | |

Denormalized columns (staff_id, company, date) make the sales dashboard
queryable without joining 3 tables. Trade-off: edits to till_session
metadata must propagate here. Cashier flow always writes both together,
so this stays consistent.

### 5. `payments`

| Col | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| A | payment_id | string | yes | `P_...` |
| B | staff_id | string | yes | FK → staff |
| C | paid_on | date | yes | When the payment happened |
| D | total_amount | number | yes | Sum of payment_items.amount for this payment_id |
| E | method | enum | no | `cash` / `bank` / `etransfer` / `other` |
| F | recorded_by | string | yes | staff_id of admin who recorded |
| G | notes | string | no | |

### 6. `payment_items` — allocation links

| Col | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| A | item_id | string | yes | `IT_...` |
| B | payment_id | string | yes | FK → payments |
| C | item_type | enum | yes | `shift` / `bonus` |
| D | ref_id | string | yes | attendance_id or bonus_id |
| E | amount | number | yes | Dollars from this payment to this item |
| F | notes | string | no | E.g. "Partial — $50 of $174" |

**A shift is fully paid** when:
```
sum(payment_items.amount where item_type='shift' and ref_id=attendance_id)
  >= attendance.hours_worked × attendance.rate_at_attendance
```

### 7. `bonuses`

Bonuses, commissions, deductions, adjustments — all here.

| Col | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| A | bonus_id | string | yes | `B_...` |
| B | staff_id | string | yes | FK → staff |
| C | date | date | yes | When earned/applied |
| D | type | enum | yes | `bonus` / `commission` / `incentive` / `deduction` / `tip` / `adjustment` |
| E | amount | number | yes | Positive for bonuses; negative for deductions |
| F | reason | string | yes | "Vape sales of $700 over $500" |
| G | status | enum | yes | `proposed` / `pending` / `paid` / `cancelled` |
| H | period_start | date | no | For commissions: week_start |
| I | period_end | date | no | For commissions: week_end |
| J | company | enum | no | For commission: `cstore` / `vape` / blank |
| K | source_run_id | string | no | For commission: links to commission_runs |
| L | created_by | string | yes | |
| M | created_at | datetime | yes | |
| N | notes | string | no | |

**Status semantics:**
- `proposed` — auto-generated by commission engine; awaiting admin approval
- `pending` — approved (or manually added by admin); payable
- `paid` — fully settled
- `cancelled` — never to be paid

### 8. `commission_rules`

| Col | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| A | rule_id | string | yes | `CR_001` |
| B | name | string | yes | "Cstore weekly base" |
| C | applies_to | enum | yes | `all_staff` / `specific_staff` |
| D | staff_id | string | no | Only used if applies_to=specific_staff |
| E | company | enum | yes | `cstore` / `vape` |
| F | threshold | number | yes | E.g. 1500 |
| G | percentage | number | yes | E.g. 5 (means 5%, not 0.05) |
| H | active | bool | yes | |
| I | effective_from | date | yes | Rule applies to periods starting on/after this |
| J | effective_to | date | no | Nullable; rule retires after this |
| K | created_by | string | yes | |
| L | created_at | datetime | yes | |
| M | notes | string | no | |

### 9. `commission_runs`

One row per Monday-trigger execution. Idempotency check.

| Col | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| A | run_id | string | yes | `CRN_20260518_093001` |
| B | week_start | date | yes | Previous Monday 00:00 |
| C | week_end | date | yes | Previous Sunday 23:59 |
| D | staff_count | number | yes | How many staff had commissions |
| E | bonuses_created | number | yes | Total new bonus rows |
| F | total_commission_amount | number | yes | Sum of created amounts |
| G | computed_at | datetime | yes | |
| H | computed_by | string | yes | `SYSTEM_TRIGGER` or staff_id |
| I | notes | string | no | E.g. "manual re-run" |

### 10. `audit_log`

| Col | Name | Type | Required | Notes |
|-----|------|------|----------|-------|
| A | log_id | string | yes | `LOG_...` |
| B | timestamp | datetime | yes | |
| C | actor_id | string | yes | staff_id or `SYSTEM` |
| D | action | string | yes | Dot-namespaced verb: `attendance.open`, `payment.record`, etc. |
| E | target_type | string | yes | `attendance`, `payments`, etc. |
| F | target_id | string | yes | The PK of the affected row |
| G | before | string | no | JSON snapshot |
| H | after | string | no | JSON snapshot |
| I | details | string | no | Free text |

### 11. `config`

Key/value settings.

| Col | Name | Type | Notes |
|-----|------|------|-------|
| A | key | string | E.g. `cstore_default_opening_float` |
| B | value | string | Stored as string; parsed by code as needed |
| C | description | string | Human-readable hint |

**Required keys** (created with defaults at setup):
- `cstore_default_opening_float` = `250`
- `vape_default_opening_float` = `100`
- `variance_ok_threshold` = `1`
- `variance_minor_threshold` = `30`
- `cstore_business_name` = `Convenience Store`
- `vape_business_name` = `Vape Shop`
- `session_hours` = `24`
- `login_max_fails` = `5`
- `login_lockout_mins` = `60`
- `commission_run_day` = `1` (Monday — 0=Sunday, 1=Monday, …)
- `commission_run_hour` = `9` (9 AM trigger)
- `notifier_enabled` = `false`
- `whatsapp_target_number` = empty
- `whatsapp_api_url` = empty

### 12–14. Phase 2 placeholder tabs

`pos_extracted`, `clover_batches`, `validation_results` — created with
correct columns but no code reads/writes them yet. Schema is documented
inside the sheet (column headers + sample row) so when Phase 2 builds
on top, the shape is already there.

## Worked example — Blesson's typical day

**Morning open:**
1. Blesson taps "Open Cstore" → counts $250 → confirms
   - System creates `attendance` row `A_20260514_S_003` (status=in_progress, actual_start=08:55)
   - System creates `till_session` row `CST-20260514-S_003` (status=open)
2. Blesson taps "Open Vape" → counts $100 → confirms
   - Attendance is reused (still in_progress)
   - System creates `till_session` row `VAP-20260514-S_003` (status=open)

**Evening close:**
3. Blesson taps "Close Cstore" → enters sales by tender → counts $1,030
   - `till_session` row updated (status=closed, end_time=17:05, variance computed)
   - `sales` row created
4. Blesson taps "Close Vape" → enters sales → counts $175
   - `till_session` updated
   - `sales` row created
   - **All till sessions for today are closed** → attendance auto-completes:
     - actual_end = 17:10 (max of all closing end_times)
     - hours_worked = 8.25 (17:10 − 08:55)
     - rate_at_attendance = 12 (snapshotted from staff row)
     - status = worked

**Result:**
- 1 attendance row (= 1 payroll record)
- 2 till_session rows (one per company)
- 2 sales rows (one per company)
- Hours come from the human's wall-clock day, not the sum of till_session durations.

Payroll value for Blesson today: 8.25 × $12 = $99.

## Implications

- **One attendance = one payable unit.** Payments allocate against
  attendance, not till_sessions.
- **Edits to attendance times after close** are possible but write to
  audit log. Used to fix data entry errors.
- **Future scheduling** writes an attendance row in advance with
  status=scheduled. When the cashier opens their first till session,
  the scheduled attendance is matched (same staff_id, date) and updated
  to in_progress instead of creating a duplicate.
