# Test Cases — StoreOps Batches 1 + 2

This document walks through the scenarios needed to validate the schema
(batch 1) and the shift lifecycle (batch 2). Each test has a setup, an
action, and what to verify. If anything fails, note which test and the
specific assertion — that's enough to debug quickly.

**Important**: batches 1 + 2 deliver the *data layer* only. There's no
web UI yet (batch 4). All testing happens by either:

- **Running functions from the Apps Script editor** (Run → choose function)
- **Looking at sheet data directly** to verify rows were created/updated
- **Inspecting the `audit_log` sheet** for evidence of operations

Tests are listed in dependency order. Don't skip ahead.

---

## Prerequisites

Before any test runs:

- [ ] Followed `docs/quickstart.md` through step 8 (clasp push complete)
- [ ] `🏪 StoreOps → ⚙️ First-time Setup` ran without error
- [ ] All 14 sheets exist with proper headers
- [ ] Yellow placeholder row visible in each operational tab

If setup didn't complete, **stop here** and fix that first.

---

## Section A — Schema verification (batch 1)

### A1. All 14 tabs exist

**Action**: open the spreadsheet, count tabs at the bottom.

**Pass**: 14 tabs, named exactly: `staff`, `attendance`, `till_sessions`,
`sales`, `payments`, `payment_items`, `bonuses`, `commission_rules`,
`commission_runs`, `audit_log`, `config`, `pos_extracted`,
`clover_batches`, `validation_results`.

**Fail**: missing tabs → re-run First-time Setup. Old `Sheet1` still
present → safe to delete.

### A2. Column headers match the spec

**Action**: scan column headers of each tab vs `docs/data-model.md`.

**Pass**: headers match exactly (snake_case, in the documented order).
Special check: `staff` has `companies_authorized` column (not just
`companies`).

**Fail**: missing or renamed columns → likely a code/doc drift.
Stop and report — every later test depends on these.

### A3. Validation rules work

**Action**: in the `staff` sheet, try to set the `role` column of a
new row to `superuser` (invalid).

**Pass**: cell shows a red corner / warning when blurred (data
validation enabled but `allowInvalid: true` means it accepts the
value with a warning rather than blocking it).

### A4. Config defaults are populated

**Action**: open the `config` tab.

**Pass**: 16 rows of key/value/description, all required keys present
(`cstore_default_opening_float = 250`, `vape_default_opening_float = 100`,
`variance_ok_threshold = 1`, etc.).

### A5. Placeholder rows are visible

**Action**: visit each operational tab.

**Pass**: each has exactly one yellow-highlighted placeholder row
with realistic-looking data. The `staff` tab has the admin
placeholder; others use `S_001` as the staff_id.

---

## Section B — Replace placeholders with real data

These aren't tests of code; they're setup so the rest of testing has
realistic data.

### B1. Set yourself up as admin

**Action**: edit row 3 of the `staff` sheet (the placeholder):

| Column | Value |
|--------|-------|
| staff_id | `S_001` |
| name | Your name (e.g. `Ashin`) |
| hourly_rate | `0` (admin doesn't get paid through this) |
| active | `TRUE` |
| role | `admin` |
| login_code | `1234` (or your real PIN) |
| companies_authorized | `cstore,vape` |
| created_at | `=NOW()` |
| notes | (clear "placeholder" text) |

Remove the yellow background (Format → Fill color → No fill).

### B2. Add 2 more staff for testing

Add rows 4 and 5 manually:

| staff_id | name | hourly_rate | active | role | login_code | companies_authorized | created_at |
|----------|------|-------------|--------|------|------------|---------------------|------------|
| S_002 | Blesson | 12.00 | TRUE | employee | 1003 | cstore,vape | `=NOW()` |
| S_003 | Manager Sample | 14.00 | TRUE | manager | 5678 | cstore,vape | `=NOW()` |

(Names are placeholders — substitute your actual roster.)

### B3. Delete other placeholder rows

In each of these tabs, **delete the yellow placeholder row**:
`attendance`, `till_sessions`, `sales`, `payments`, `payment_items`,
`bonuses`, `commission_rules`, `commission_runs`, `audit_log`.

Why: those placeholders pollute test results. After this step, all
test data will be created by code paths we're testing.

---

## Section C — Util.gs smoke tests

These are tiny scripts to run from the Apps Script editor that exercise
the foundation code.

### C1. ID generation works

**Action**: in Apps Script editor, paste into a new function and run:

```javascript
function test_C1() {
  const today = new Date();
  Logger.log(Util.attendanceId(today, 'S_001'));
  Logger.log(Util.tillSessionId(today, 'S_001', 'cstore'));
  Logger.log(Util.tillSessionId(today, 'S_001', 'vape'));
  Logger.log(Util.newId('P'));
  Logger.log(Util.newToken());
  Logger.log(Util.newLoginCode(4));
}
```

**Pass**: log output shows:
- `A_20YYMMDD_S_001` (today's date as YYYYMMDD prefix)
- `CST-20YYMMDD-S_001`
- `VAP-20YYMMDD-S_001`
- `P_20YYMMDD_HHMMSS_xxx` (timestamp + random suffix)
- A 32-char hex string with no hyphens
- A 4-digit numeric string

### C2. Week math

```javascript
function test_C2() {
  const now = new Date();
  Logger.log('Today Monday: ' + Util.getMondayOf(now));
  const range = Util.getPreviousWeekRange(now);
  Logger.log('Last week: ' + range.start + ' → ' + range.end);
}
```

**Pass**: `Today Monday` is the most recent Monday at midnight; last
week range is the 7 days before it (Monday 00:00 to Sunday 23:59).

### C3. Time parsing

```javascript
function test_C3() {
  ['9am-5pm', '5:30pm-11pm', '5.30pm-11pm', '9-5pm', '10am-2:30pm']
    .forEach(s => Logger.log(s + ' → ' + JSON.stringify(Util.parseTimeRange(s))));
}
```

**Pass**: all five parse into structured `{startHour, startMin, endHour, endMin, hours}`.
`5.30pm-11pm` (with dot, not colon) parses correctly — this was the v2 bug fix.

---

## Section D — Auth flow (batch 1)

### D1. Login as admin

```javascript
function test_D1() {
  const res = Auth.login('Ashin', '1234');  // your name + code from B1
  Logger.log(JSON.stringify(res, null, 2));
}
```

**Pass**: returns `{success: true, token: <32 hex chars>, staffId: 'S_001', name: 'Ashin', role: 'admin', companiesAuthorized: ['cstore','vape']}`.

Also check `audit_log` sheet — a new row with action `login.success`.

### D2. Login with wrong code

```javascript
function test_D2() {
  const res = Auth.login('Ashin', '9999');
  Logger.log(JSON.stringify(res));
}
```

**Pass**: `{success: false, error: 'Invalid name or code'}`. New
audit row with action `login.fail`, details `wrong_code`.

### D3. Lockout after 5 failures

**Action**: run `test_D2` six times in a row.

**Pass**: 6th call returns `{success: false, error: 'Too many failed attempts. Try again in N minutes.'}`. Audit log has 5 `login.fail` rows with `wrong_code` + 1 with `rate_limited`.

**Cleanup**: in Apps Script editor, run:
```javascript
PropertiesService.getScriptProperties().deleteAllProperties();
```
This clears all sessions + rate limit state.

### D4. Validate a real token

After running test_D1 and noting the token:

```javascript
function test_D4() {
  // Paste the token from test_D1 output
  const TOKEN = '<paste-token-here>';
  try {
    const session = Auth.validate(TOKEN);
    Logger.log('Valid: ' + JSON.stringify(session));
  } catch (e) {
    Logger.log('Failed: ' + e.message);
  }
}
```

**Pass**: prints "Valid: {staffId, name, role, companiesAuthorized, expiresAt}".

### D5. Role guard

```javascript
function test_D5() {
  const TOKEN = '<token-from-test_D1>';
  const session = Auth.validate(TOKEN);
  try {
    Auth.require(session, ['admin']);
    Logger.log('PASS: admin role allowed');
  } catch (e) {
    Logger.log('FAIL: ' + e.message);
  }
  try {
    Auth.require(session, ['manager']);
    Logger.log('UNEXPECTED PASS');
  } catch (e) {
    Logger.log('PASS: admin rejected from manager-only check: ' + e.message);
  }
}
```

**Pass**: first check passes ('admin in [admin]'), second throws
"FORBIDDEN: requires manager, got admin".

---

## Section E — Attendance + TillSessions integration (batch 2)

These tests exercise the full open/close lifecycle. Each test
**builds on the previous** — don't reset between them.

### E1. Open a cstore till session

```javascript
function test_E1() {
  const result = TillSessions.open({
    staffId: 'S_002',     // Blesson
    company: 'cstore',
    openingCount: 250,    // matches expected float exactly
    actorId: 'S_002',
  });
  Logger.log(JSON.stringify(result, null, 2));
}
```

**Pass**:
- Returns an object with `sessionId` starting with `CST-`, `attendanceId` starting with `A_`, status=open.
- In the `attendance` sheet, new row with status=`in_progress`, `actual_start` ~ now, hours_worked=0.
- In the `till_sessions` sheet, new row with status=`open`, opening_float=250, expected_opening=250.
- In `audit_log`, two rows: `attendance.open` then `till.open`.

### E2. Open a vape till session for the SAME person SAME day

Important: this must reuse the same attendance row.

```javascript
function test_E2() {
  const result = TillSessions.open({
    staffId: 'S_002',
    company: 'vape',
    openingCount: 100,
    actorId: 'S_002',
  });
  Logger.log(JSON.stringify(result, null, 2));
}
```

**Pass**:
- `attendanceId` returned is **the same** as test_E1's attendanceId.
- `attendance` sheet still has just ONE row for Blesson today (not 2).
- `till_sessions` has 2 rows now (CST-... and VAP-...).
- `audit_log` has a `till.open` row but NOT a new `attendance.open` row.

### E3. Cannot open cstore twice

```javascript
function test_E3() {
  try {
    TillSessions.open({
      staffId: 'S_001',     // different person trying to open the already-open company
      company: 'cstore',
      openingCount: 250,
      actorId: 'S_001',
    });
    Logger.log('UNEXPECTED PASS');
  } catch (e) {
    Logger.log('PASS: ' + e.message);
  }
}
```

**Pass**: throws "cstore already has an open shift...".

### E4. Float mismatch needs a note

```javascript
function test_E4() {
  // First close the existing cstore session so we can try opening fresh
  // (skip this if you want to test on a different day's data)
  try {
    TillSessions.open({
      staffId: 'S_002',
      company: 'cstore',  // will fail anyway because still open from E1
      openingCount: 240,  // off by $10
      actorId: 'S_002',
    });
    Logger.log('UNEXPECTED PASS');
  } catch (e) {
    Logger.log('PASS: ' + e.message);
  }
}
```

**Pass**: throws either "cstore already has an open shift" OR "Float mismatch (counted 240, expected 250). Please provide an opening note." — both are correct behavior. The mismatch-without-note rejection is what we want to confirm; if your existing E1 session is closed, you'll see that message.

### E5. Close the cstore session

```javascript
function test_E5() {
  // Find the cstore session_id from the till_sessions sheet
  const today = Util.todayMidnight();
  const sessionId = Util.tillSessionId(today, 'S_002', 'cstore');
  const result = TillSessions.close({
    sessionId: sessionId,
    cashSales: 500,
    creditCard: 100,
    debitCard: 300,
    cashback: 50,
    miscCash: 0,
    miscCredit: 0,
    miscDebit: 0,
    miscNotes: '',
    physicalCount: 700,  // expected = 250 + 500 + 0 - 50 = 700 → variance 0
    actorId: 'S_002',
  });
  Logger.log(JSON.stringify(result, null, 2));
}
```

**Pass**:
- Returns `{session, expectedCash: 700, counted: 700, variance: 0, cashRemoved: 450, floatLeft: 250, varianceStatus: 'OK'}`.
- `till_sessions` row updated: status=closed, end_time set, all closing fields populated, variance_status=`OK`.
- `sales` sheet: NEW row with the tender breakdown.
- `attendance` row STILL `in_progress` (vape session still open).
- `audit_log`: rows for `till.close` and `sales.create`.

### E6. Close the vape session — auto-completes attendance

```javascript
function test_E6() {
  const today = Util.todayMidnight();
  const sessionId = Util.tillSessionId(today, 'S_002', 'vape');
  const result = TillSessions.close({
    sessionId: sessionId,
    cashSales: 50,
    creditCard: 20,
    debitCard: 30,
    cashback: 0,
    miscCash: 0, miscCredit: 0, miscDebit: 0,
    miscNotes: '',
    physicalCount: 150,  // expected = 100 + 50 - 0 = 150 → variance 0
    actorId: 'S_002',
  });
  Logger.log(JSON.stringify(result, null, 2));
}
```

**Pass**:
- Returns `{..., variance: 0, varianceStatus: 'OK'}`.
- `till_sessions`: vape row is closed.
- **`attendance` row promoted to `worked`**, hours_worked computed
  (start = whichever was earliest, end = vape close time). Check
  `hours_worked` is a sensible number (probably small for a test —
  even a few seconds shows as e.g. `0.00`).
- `rate_at_attendance` = 12.00 (Blesson's rate snapshot).
- `audit_log`: `till.close`, `sales.create`, AND `attendance.complete`.

### E7. Verify hours_worked formula

Open the `attendance` sheet, find Blesson's row from today. Verify
`hours_worked × rate_at_attendance = the value` he'll be paid.

E.g. if test_E5 and E6 ran 5 minutes apart, `hours_worked` should be
~0.08 (5 min/60); rate=$12; value=$1.00. Not realistic dollar amount
because of test timing, but the *math* should be consistent.

### E8. Read sales dashboard

```javascript
function test_E8() {
  const today = Util.todayMidnight();
  const result = Sales.getDashboard({
    startDate: today,
    endDate: today,
  });
  Logger.log(JSON.stringify(result, null, 2));
}
```

**Pass**:
- `rows`: 2 rows (cstore and vape for Blesson today).
- `totals.cash`: 550 (500 cstore + 50 vape), `credit`: 120, `debit`: 330,
  `total`: 1000, `cashback`: 50.
- `pageCount`: 1, `page`: 1, `pageSize`: 50.
- Each row has `staffName: 'Blesson'`, computed `total`, etc.

### E9. Aggregate by staff × company

```javascript
function test_E9() {
  const today = Util.todayMidnight();
  const result = Sales.aggregateByStaffCompany(today, today);
  Logger.log(JSON.stringify(result, null, 2));
}
```

**Pass**: 2 entries — `{staffId: 'S_002', company: 'cstore', total: 900, sessionCount: 1}` and similar for vape (`total: 100`).

(Cstore total = 500 cash + 100 credit + 300 debit = 900, not the $1000 dashboard total which includes vape.)

---

## Section F — Edge cases

### F1. Closing a non-open session

```javascript
function test_F1() {
  const today = Util.todayMidnight();
  const sessionId = Util.tillSessionId(today, 'S_002', 'cstore');
  try {
    TillSessions.close({
      sessionId,
      physicalCount: 1000,
      actorId: 'S_002',
    });
    Logger.log('UNEXPECTED PASS');
  } catch (e) {
    Logger.log('PASS: ' + e.message);
  }
}
```

**Pass**: throws "Session is not open (status: closed)".

### F2. Manager closing someone else's session

Assuming today's sessions are closed, advance the date (or use a
different test scenario — open a new session as `S_002` first, then
try to close it as the manager).

```javascript
function test_F2_setup() {
  // Open a fresh session as Blesson
  TillSessions.open({
    staffId: 'S_002', company: 'cstore', openingCount: 250, actorId: 'S_002',
  });
}

function test_F2_close_as_manager() {
  const today = Util.todayMidnight();
  const sessionId = Util.tillSessionId(today, 'S_002', 'cstore');
  const result = TillSessions.close({
    sessionId,
    cashSales: 100, creditCard: 0, debitCard: 0, cashback: 0,
    miscCash: 0, miscCredit: 0, miscDebit: 0,
    physicalCount: 350,
    actorId: 'S_003',  // manager
  });
  Logger.log('PASS: manager closed session ' + result.session.sessionId);
}
```

(This test only runs if you don't have a closed cstore session for today
yet — depends on state.)

**Pass**: manager succeeds. Audit log records `actorId: S_003` while the session's `staff_id` is `S_002`.

### F3. Employee closing someone else's session

```javascript
function test_F3() {
  // Need to first set up a different staff in attendance + an open session...
  // SIMPLIFIED: use the rejection path
  try {
    TillSessions.close({
      sessionId: 'CST-99999999-S_002',
      physicalCount: 100,
      actorId: 'S_999',  // a non-admin/non-manager
    });
    Logger.log('UNEXPECTED PASS');
  } catch (e) {
    Logger.log('PASS: ' + e.message);
  }
}
```

**Pass**: throws either "Session not found" OR (if you set up a real
scenario) "Only S_002 or an admin/manager can close this session".

### F4. Unauthorized company

If Blesson's `companies_authorized` was `cstore` only, opening vape
should fail.

Modify the `staff` sheet: change Blesson's `companies_authorized` to
just `cstore`. Then:

```javascript
function test_F4() {
  try {
    TillSessions.open({
      staffId: 'S_002', company: 'vape', openingCount: 100, actorId: 'S_002',
    });
    Logger.log('UNEXPECTED PASS');
  } catch (e) {
    Logger.log('PASS: ' + e.message);
  }
}
```

**Pass**: throws "Blesson is not authorized for vape".

**Cleanup**: restore `companies_authorized` to `cstore,vape`.

---

## Section G — Notifier scaffold

### G1. Notifier writes to audit log

Any test in section E should have produced `notify.shift.opened` and
`notify.shift.closed` rows in `audit_log`. Verify by filtering.

**Pass**: audit_log has rows where `action` starts with `notify.`. Their
`details` column has human-readable text like "🟢 Blesson opened cstore shift (float $250)".

### G2. Notifier doesn't send externally yet

Open the `config` tab. `notifier_enabled` should be `false`. No external
sends are attempted.

**Pass**: no errors from any test about external HTTP failures. The
events are logged but not transmitted.

---

## Section H — Idempotency

### H1. Re-opening a worked attendance

```javascript
function test_H1() {
  // After section E ran for today, Blesson's attendance is 'worked'
  try {
    TillSessions.open({
      staffId: 'S_002', company: 'cstore', openingCount: 250, actorId: 'S_002',
    });
    Logger.log('UNEXPECTED PASS');
  } catch (e) {
    Logger.log('PASS: ' + e.message);
  }
}
```

**Pass**: throws "Attendance for S_002 on YYYY-MM-DD is already completed (status=worked). Cannot reopen."

### H2. Scheduling for a future date

```javascript
function test_H2() {
  const tomorrow = Util.addDays(Util.todayMidnight(), 1);
  const result = Attendance.schedule({
    staffId: 'S_002',
    date: tomorrow,
    scheduledStart: '09:00',
    scheduledEnd: '17:00',
    actorId: 'S_001',
  });
  Logger.log(JSON.stringify(result));
}
```

**Pass**: new row in `attendance` for tomorrow, status=`scheduled`,
scheduled_start='09:00', actual times empty.

### H3. Opening promotes scheduled → in_progress

(Skip if you can't time-travel; doable mentally by editing the test_H2
row's date to today after creating it.)

After running test_H2 and changing the row's date to TODAY:

```javascript
function test_H3() {
  // Now open a cstore session for S_002 today
  const result = TillSessions.open({
    staffId: 'S_002', company: 'cstore', openingCount: 250, actorId: 'S_002',
  });
  Logger.log(JSON.stringify(result));
}
```

**Pass**: attendance row stays the same ID, status flips from
`scheduled` to `in_progress`, scheduled_start/end fields preserved.
Audit log shows `attendance.promote` action.

---

## Section I — Audit log review

Open the `audit_log` sheet. After running all tests in sections D-H,
you should see:

**Pass**: an audit row for **every** state-changing operation:
- All login attempts (success + fail)
- Every attendance create, promote, complete, schedule
- Every till session open + close
- Every sales row write
- Every notifier event (`notify.shift.opened`, etc.)

**Fail**: missing entries → something is bypassing audit. Note which
operation didn't produce a row.

---

## What to do after testing

If everything in sections A through I passes:
- Foundation + shift lifecycle is solid
- Ready for batch 3 (payments, bonuses, commissions)
- Ready for batch 4 (web UI on top)

If anything fails:
- Note the test number and specific assertion that failed
- Check the `audit_log` sheet — sometimes the audit row reveals where the operation actually wrote (or didn't write)
- Check the Apps Script execution log (View → Logs) — `console.log` output goes there
- Stop and report; don't keep building on a broken foundation

---

## Reset between test runs

If you want to start over (e.g. after a bunch of tests created test
data you don't want to keep):

1. Run **🏪 StoreOps → ⚠️ Reset Data** — wipes attendance, till_sessions, sales, payments, payment_items, bonuses, commission_runs, audit_log. Preserves staff, config, commission_rules.
2. Re-run section B if you also wiped staff (the reset doesn't wipe staff, but if you accidentally deleted real rows).

For session/lockout reset:
```javascript
PropertiesService.getScriptProperties().deleteAllProperties();
```
