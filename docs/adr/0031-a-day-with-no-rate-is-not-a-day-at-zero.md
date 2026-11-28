# 0031. A day worked with no pay rate is "no rate set", not a day at $0

- **Status:** Accepted
- **Date:** 2026-11
- **Components:** [payroll](../components/payroll.md), [schedule and attendance](../components/schedule-and-attendance.md), [staff](../components/staff-admin.md)

## Context

A person is paid hours × rate for each day worked. The rate is copied onto the
day (`rate_at_attendance`) when their last till of the day closes. In the Apps
Script app a person whose hourly rate is blank gets **0** copied onto the day
(`Number(x) || 0` in `Staff.gs`), and the port kept that for parity. Such a
day is worth $0.00: it appears in no "owed" list, the totals look complete, My
Pay shows *$0.00/hr*, and nobody is told.

That was rare while rates were typed into the Sheet. Since the Staff screen
([card P4-11](../components/staff-admin.md)), a manager can add an employee and
only an admin sets pay, so **every new hire** works their first days with no
rate. Those days would silently be worth nothing. It is the case
[ADR-0004](0004-blank-is-not-zero.md) warns about: a zero is a claim
("worth nothing"), a blank is the absence of one.

The owner agreed on 28 November 2026 that the new app shows these days as
**no rate set**.

## Decision

A **deliberate difference from the Apps Script app**, in the Operations app
only. The live app is not changed.

- **Stored blank.** When a day is completed for a person whose hourly rate is
  blank, `rate_at_attendance` is stored `NULL`, not 0
  (`ops/src/modules/attendance.ts` `complete`, through the new reader
  `staff.hourlyRatesOf`). A real rate of 0 (the owner, who is not paid by the
  hour) is still 0. Nothing else about the close changes: hours, times, status,
  who and when are written exactly as before, and the audit row says
  `rate: null`.
- **Read as null.** An attendance record's `rateAtAttendance` is `null` for a
  blank (it was 0). The pay screens read the person's rate through
  `staff.hourlyRatesOf`, which answers `null` for a blank; `staff.getById` and
  the Staff readers' other callers keep the old `Number(x) || 0`.
- **Visible, and never summed as 0.** A worked day with a blank rate is still
  left out of `unpaidShifts` and every total (a sum may leave it out; ADR-0004),
  but the answers now carry it, in fields that are **added** and present
  **only when there is such a day**:
  - `rpcGetPayrollOverview` (each person), `rpcGetOwedSummary` and
    `rpcGetMyOwedSummary`: `noRateDayCount` and `noRateDays`
    (`[{ attendanceId, dateStr, hoursWorked, paid }]`, oldest first;
    `hoursWorked` is null when the hours are blank too);
  - `rpcPayShifts`: `skippedNoRate` (the same shape), and `skippedNoRate`
    (the ids) in the `payment.shifts` audit row.
- **Two existing fields become null for a blank rate.** `hourlyRate` on
  `rpcGetPayrollOverview` and `rpcGetMyOwedSummary` (0 before), and
  `rateAtAttendance` on the record the Schedule calls answer
  (`rpcScheduleShift`, `rpcCancelScheduledShift`, `rpcAdjustAttendanceHours`,
  `rpcEditAttendanceTimes`) for a day whose rate is blank. For everyone with a
  rate, or a real 0, both are exactly what they were.
- **Never paid, never $0.** `payShifts` walks only days with a rate. A day with
  no rate is skipped and named. When such days are all that is left, the
  payment is refused with words: *"<name> has no pay rate set: set it on the
  Staff screen first."* (or, when the person has a rate now and only old days
  lack one, the days and the date to apply the rate from). An overpayment
  refusal that states a total adds *"Not counted: N days worked with no rate
  set."*
- **Rows already at 0 are left alone.** A 0 written by the Apps Script app, or
  by the new app before this decision, cannot be told from a real 0, so nothing
  is rewritten and those days still read as $0.00. An admin re-rates them with
  the Staff screen's *also apply to unpaid days from*, which re-rates unpaid
  worked days whose rate is blank or 0.
- **The page.** `src/Index.html` is shared. Inside Apps Script (`isOpsApp_()`
  false) the pay screens render exactly as before, whatever they are sent (the
  old app sends 0 and never the added fields). In the Operations app a `null`
  rate reads *no rate set* (a 0 still reads $0.00); My Pay lists the days with
  *no rate set* where the rate and value would be; the Payroll card says
  *"N days worked with no rate set"* with the dates and hours, that nothing can
  be paid for them, and how to fix it; the totals say *not counted: N days with
  no rate*; a person with only such days has no *Pay Shifts* button and reads
  *Rate needed*, not *All settled*.

## Consequences

- ✅ A new hire's first days are visible to them and to payroll from the first
  close, and cannot be paid at $0 by accident.
- ✅ For every person with a rate, every answer and every written row is what
  it was: the comparison harness's 1,020 cases pass unchanged (its fixture has
  no one with a blank rate; `ops/test/no-rate.test.ts` checks that, so a case
  that adds one is noticed), and the answers are pinned against the pre-change
  code.
- ⚠️ The Operations app and the Apps Script app now answer differently for a
  person with a blank rate: `null` where the old app says 0, and fields the old
  app never sends. This is the point of the decision, and it is why the page
  branches on `isOpsApp_()`.
- ⚠️ Old days at 0 keep reading $0.00 until an admin re-rates them; the app
  cannot know which of them were blanks.
- ⚠️ `rpcGetAllStaff` (admin, no screen calls it) still answers 0 for a blank
  rate, as the port did; the Staff screen reads its own `null`.

## Alternatives considered

- **Keep 0, for parity:** the day stays invisible and worth nothing; every new
  hire added from the Staff screen would be underpaid without anyone being
  told. Parity is a tool for the port, not a reason to keep a known fault.
- **Rewrite old 0s to NULL at the switch:** a 0 written for a blank and a real
  0 (the owner) look the same; rewriting would turn true zeros into "no rate"
  and change money history that has been reconciled. The Staff screen's
  re-rate already fixes the ones that matter, one person at a time, audited.
- **Refuse to close a till for a person with no rate:** the till close is the
  cash count and the sales record; blocking it would lose the store's figures
  to fix a payroll field, and the person did work the day.
- **Guess a default rate** (minimum wage, the last rate used): a guess becomes
  a claim that gets paid. Pay is set by an admin, or it is not set.
