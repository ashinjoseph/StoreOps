// ============================================================
//  Attendance.gs — per-day workday records (payroll source of truth)
// ============================================================
//  One row per person per workday. ID is deterministic from
//  (date, staff_id) so re-opens of the same day reuse the same row.
//
//  Lifecycle:
//    scheduled    — admin pre-scheduled this person; no actual work yet
//    in_progress  — at least one till_session opened today
//    worked       — all till_sessions closed; hours_worked computed
//    cancelled    — admin cancelled; ignored in payroll
//
//  Hours come from the wall-clock span of the workday, NOT the sum
//  of till_session durations. Blesson opens cstore at 09:00 and vape
//  at 09:05, closes both at 17:00 → 8 hours worked, not 16.
// ============================================================

const Attendance = (() => {

  const COL = {
    attendance_id: 1, staff_id: 2, date: 3,
    scheduled_start: 4, scheduled_end: 5,
    actual_start: 6, actual_end: 7,
    hours_worked: 8, rate_at_attendance: 9, status: 10,
    notes: 11, created_by: 12, created_at: 13,
    modified_by: 14, modified_at: 15
  };
  const NUM_COLS = 15;
  const DATA_START_ROW = 3;

  function sheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.ATTENDANCE);
    if (!sh) throw new Error('attendance sheet not found — run First-time Setup');
    return sh;
  }

  function rowToRecord_(row, rowIndex) {
    return {
      attendanceId:     (row[COL.attendance_id - 1] || '').toString().trim(),
      staffId:          (row[COL.staff_id - 1] || '').toString().trim(),
      date:             row[COL.date - 1] instanceof Date ? row[COL.date - 1] : null,
      scheduledStart:   (row[COL.scheduled_start - 1] || '').toString().trim(),
      scheduledEnd:     (row[COL.scheduled_end - 1] || '').toString().trim(),
      actualStart:      row[COL.actual_start - 1] instanceof Date ? row[COL.actual_start - 1] : null,
      actualEnd:        row[COL.actual_end - 1] instanceof Date ? row[COL.actual_end - 1] : null,
      hoursWorked:      Number(row[COL.hours_worked - 1]) || 0,
      rateAtAttendance: Number(row[COL.rate_at_attendance - 1]) || 0,
      status:           (row[COL.status - 1] || 'scheduled').toString().trim(),
      notes:            (row[COL.notes - 1] || '').toString(),
      createdBy:        (row[COL.created_by - 1] || '').toString().trim(),
      createdAt:        row[COL.created_at - 1] instanceof Date ? row[COL.created_at - 1] : null,
      modifiedBy:       (row[COL.modified_by - 1] || '').toString().trim(),
      modifiedAt:       row[COL.modified_at - 1] instanceof Date ? row[COL.modified_at - 1] : null,
      _rowIndex:        rowIndex,
    };
  }

  function getAll_() {
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last < DATA_START_ROW) return [];
    const data = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS).getValues();
    return data
      .map((row, i) => rowToRecord_(row, i + DATA_START_ROW))
      .filter(r => r.attendanceId && r.staffId);
  }

  function getById_(attendanceId) {
    return getAll_().find(a => a.attendanceId === attendanceId) || null;
  }

  function getForStaff_(staffId) {
    return getAll_().filter(a => a.staffId === staffId);
  }

  function getForDateAndStaff_(dateObj, staffId) {
    return getById_(Util.attendanceId(dateObj, staffId));
  }

  function getForDateRange_(startDate, endDate, filterStaffId) {
    const start = startDate instanceof Date ? startDate : Util.parseDate(startDate);
    const end = endDate instanceof Date ? endDate : Util.parseDate(endDate);
    if (!start || !end) return [];
    return getAll_().filter(a => {
      if (!a.date || a.date < start || a.date > end) return false;
      if (filterStaffId && a.staffId !== filterStaffId) return false;
      return true;
    });
  }

  /**
   * Unpaid worked attendance rows for one staff, sorted oldest-first.
   * Used by Payments for the chronological allocation walk.
   * Returns array of { attendanceId, date, value, paid, remaining, ... }
   * with remaining > 0 (fully-paid excluded).
   */
  function getUnpaidForStaff_(staffId) {
    const records = getForStaff_(staffId)
      .filter(a => a.status === 'worked')
      .sort((a, b) => a.date - b.date);
    if (records.length === 0) return [];

    const paidMap = Payments.getAttendancePaidAmounts(records.map(r => r.attendanceId));
    const result = [];
    records.forEach(r => {
      const value = Util.roundMoney(r.hoursWorked * r.rateAtAttendance);
      const paid = Util.roundMoney(paidMap[r.attendanceId] || 0);
      const remaining = Util.roundMoney(value - paid);
      if (remaining > 0.005) {
        result.push({
          attendanceId: r.attendanceId,
          date: r.date,
          dateStr: Util.formatDate(r.date),
          staffId: r.staffId,
          hoursWorked: r.hoursWorked,
          rateAtAttendance: r.rateAtAttendance,
          value: value,
          paid: paid,
          remaining: remaining,
        });
      }
    });
    return result;
  }

  // ── Lifecycle operations ────────────────────────────────

  /**
   * Open-or-promote attendance for (date, staff). Called by TillSessions.open.
   *
   * Behavior:
   *   - If no row exists → create with status='in_progress', actual_start=now
   *   - If row exists with status='scheduled' → promote to 'in_progress',
   *     set actual_start=now
   *   - If row exists with status='in_progress' → return unchanged
   *   - If row exists with status='worked' or 'cancelled' → throw
   *     (can't reopen a completed day)
   */
  function openOrPromote_(staffId, dateObj, actorId, now) {
    if (!staffId) throw new Error('staffId required');
    if (!dateObj) throw new Error('date required');
    if (!actorId) throw new Error('actorId required');
    now = now || new Date();

    const staff = Staff.getById(staffId);
    if (!staff) throw new Error('Staff not found: ' + staffId);

    const attendanceId = Util.attendanceId(dateObj, staffId);
    const existing = getById_(attendanceId);

    if (existing) {
      if (existing.status === 'worked') {
        throw new Error(
          'Attendance for ' + staffId + ' on ' + Util.formatDate(dateObj) +
          ' is already completed (status=worked). Cannot reopen.'
        );
      }
      if (existing.status === 'cancelled') {
        throw new Error(
          'Attendance for ' + staffId + ' on ' + Util.formatDate(dateObj) +
          ' is cancelled. Uncancel before opening.'
        );
      }
      if (existing.status === 'in_progress') {
        return existing;  // already in progress
      }
      // status === 'scheduled' → promote
      const sh = sheet_();
      const row = existing._rowIndex;
      sh.getRange(row, COL.status).setValue('in_progress');
      sh.getRange(row, COL.actual_start).setValue(now);
      sh.getRange(row, COL.modified_by).setValue(actorId);
      sh.getRange(row, COL.modified_at).setValue(now);

      AuditLog.write({
        actorId,
        action: 'attendance.promote',
        targetType: 'attendance',
        targetId: attendanceId,
        before: { status: 'scheduled' },
        after: { status: 'in_progress', actualStart: now },
      });

      return getById_(attendanceId);
    }

    // New row — status=in_progress, actual_start=now
    const sh = sheet_();
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, NUM_COLS).setValues([[
      attendanceId,
      staffId,
      dateObj,
      '', '',                  // scheduled_start, scheduled_end (not scheduled)
      now,                     // actual_start
      '',                      // actual_end
      0, 0,                    // hours_worked, rate_at_attendance (filled on complete)
      'in_progress',
      '',                      // notes
      actorId, now,            // created_by, created_at
      '', '',                  // modified_by, modified_at
    ]]);

    AuditLog.write({
      actorId,
      action: 'attendance.open',
      targetType: 'attendance',
      targetId: attendanceId,
      after: {
        staffId,
        date: Util.formatDate(dateObj),
        status: 'in_progress',
        actualStart: now,
      },
    });

    return getById_(attendanceId);
  }

  /**
   * Schedule attendance in advance. Used by admin schedule UI (batch 4).
   * Idempotent: same date+staff updates existing instead of creating dupe.
   *
   * Cannot schedule over an already in_progress or worked attendance.
   */
  function schedule_(input) {
    if (!input.staffId) throw new Error('staffId required');
    if (!input.date) throw new Error('date required');
    if (!input.actorId) throw new Error('actorId required');

    const staff = Staff.getById(input.staffId);
    if (!staff) throw new Error('Staff not found: ' + input.staffId);

    const date = input.date instanceof Date ? input.date : Util.parseDate(input.date);
    const attendanceId = Util.attendanceId(date, input.staffId);
    const existing = getById_(attendanceId);

    if (existing) {
      if (existing.status === 'in_progress' || existing.status === 'worked') {
        throw new Error(
          'Cannot schedule: attendance ' + attendanceId +
          ' is already ' + existing.status
        );
      }
      // Update scheduled times in place
      const sh = sheet_();
      const row = existing._rowIndex;
      const before = {
        scheduledStart: existing.scheduledStart,
        scheduledEnd: existing.scheduledEnd,
      };
      if (input.scheduledStart != null) {
        sh.getRange(row, COL.scheduled_start).setValue(input.scheduledStart);
      }
      if (input.scheduledEnd != null) {
        sh.getRange(row, COL.scheduled_end).setValue(input.scheduledEnd);
      }
      if (existing.status === 'cancelled') {
        sh.getRange(row, COL.status).setValue('scheduled');
      }
      sh.getRange(row, COL.modified_by).setValue(input.actorId);
      sh.getRange(row, COL.modified_at).setValue(new Date());

      AuditLog.write({
        actorId: input.actorId,
        action: 'attendance.schedule_update',
        targetType: 'attendance',
        targetId: attendanceId,
        before,
        after: {
          scheduledStart: input.scheduledStart,
          scheduledEnd: input.scheduledEnd,
        },
      });
      return getById_(attendanceId);
    }

    // New scheduled row
    const sh = sheet_();
    const row = sh.getLastRow() + 1;
    const now = new Date();
    sh.getRange(row, 1, 1, NUM_COLS).setValues([[
      attendanceId,
      input.staffId,
      date,
      input.scheduledStart || '',
      input.scheduledEnd || '',
      '', '',                   // actual times — not yet
      0, 0,                     // hours, rate
      'scheduled',
      input.notes || '',
      input.actorId, now,
      '', '',
    ]]);

    AuditLog.write({
      actorId: input.actorId,
      action: 'attendance.schedule',
      targetType: 'attendance',
      targetId: attendanceId,
      after: {
        staffId: input.staffId,
        date: Util.formatDate(date),
        scheduledStart: input.scheduledStart,
        scheduledEnd: input.scheduledEnd,
      },
    });

    return getById_(attendanceId);
  }

  /**
   * Complete an attendance when its last till_session closes.
   * Called by TillSessions.close. Computes hours, snapshots rate.
   *
   * @param attendanceId  string
   * @param now           Date — passed in so timestamps are consistent
   *                            with the till_session's end_time
   * @param actorId       string
   */
  function complete_(attendanceId, now, actorId) {
    const existing = getById_(attendanceId);
    if (!existing) throw new Error('attendance not found: ' + attendanceId);
    if (existing.status === 'worked') return existing;     // already done
    if (existing.status === 'cancelled') return existing;  // ignore

    const sessions = TillSessions.getForAttendance(attendanceId)
      .filter(s => s.status === 'closed' || s.status === 'validated');
    if (sessions.length === 0) {
      throw new Error('Cannot complete: no closed till_sessions for ' + attendanceId);
    }

    const allStarts = sessions.map(s => s.startTime).filter(Boolean);
    const allEnds = sessions.map(s => s.endTime).filter(Boolean);
    if (allStarts.length === 0 || allEnds.length === 0) {
      throw new Error('Cannot compute hours: missing till_session start/end times');
    }

    const dayStart = existing.actualStart ||
                     new Date(Math.min.apply(null, allStarts.map(d => d.getTime())));
    const dayEnd = new Date(Math.max.apply(null, allEnds.map(d => d.getTime())));
    const hours = Util.roundMoney(Util.diffHours(dayStart, dayEnd));

    const staff = Staff.getById(existing.staffId);
    const rate = staff ? staff.hourlyRate : 0;

    const sh = sheet_();
    const row = existing._rowIndex;
    sh.getRange(row, COL.actual_end).setValue(dayEnd);
    sh.getRange(row, COL.hours_worked).setValue(hours);
    sh.getRange(row, COL.rate_at_attendance).setValue(rate);
    sh.getRange(row, COL.status).setValue('worked');
    sh.getRange(row, COL.modified_by).setValue(actorId);
    sh.getRange(row, COL.modified_at).setValue(now || new Date());

    AuditLog.write({
      actorId,
      action: 'attendance.complete',
      targetType: 'attendance',
      targetId: attendanceId,
      before: { status: existing.status, hoursWorked: existing.hoursWorked },
      after: { status: 'worked', hoursWorked: hours, rate },
    });

    return getById_(attendanceId);
  }

  /**
   * Cancel attendance (e.g. scheduled day didn't happen). Cannot cancel
   * if there are paid items against it — undo the payment first.
   */
  function cancel_(attendanceId, actorId, reason) {
    const existing = getById_(attendanceId);
    if (!existing) throw new Error('attendance not found: ' + attendanceId);

    const paidAmount = Payments.getAttendancePaidAmounts([attendanceId])[attendanceId] || 0;
    if (paidAmount > 0) {
      throw new Error(
        'Cannot cancel: $' + paidAmount.toFixed(2) +
        ' has been paid against this attendance. Undo the payment first.'
      );
    }

    const sh = sheet_();
    const row = existing._rowIndex;
    sh.getRange(row, COL.status).setValue('cancelled');
    sh.getRange(row, COL.notes).setValue(
      (existing.notes ? existing.notes + ' | ' : '') + 'Cancelled: ' + (reason || '')
    );
    sh.getRange(row, COL.modified_by).setValue(actorId);
    sh.getRange(row, COL.modified_at).setValue(new Date());

    AuditLog.write({
      actorId,
      action: 'attendance.cancel',
      targetType: 'attendance',
      targetId: attendanceId,
      before: { status: existing.status },
      after: { status: 'cancelled', reason: reason || '' },
    });

    return getById_(attendanceId);
  }

  /**
   * Admin-only: edit actual_start / actual_end (fix a data-entry error).
   * Recomputes hours_worked. Blocked if any payment touches this row.
   */
  function editActualTimes_(attendanceId, newStart, newEnd, actorId) {
    const existing = getById_(attendanceId);
    if (!existing) throw new Error('attendance not found: ' + attendanceId);

    const paidAmount = Payments.getAttendancePaidAmounts([attendanceId])[attendanceId] || 0;
    if (paidAmount > 0) {
      throw new Error(
        'Cannot edit: $' + paidAmount.toFixed(2) +
        ' already paid. Undo the payment first.'
      );
    }

    const start = newStart instanceof Date ? newStart : new Date(newStart);
    const end = newEnd instanceof Date ? newEnd : new Date(newEnd);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new Error('Invalid start or end time');
    }
    if (end <= start) throw new Error('End time must be after start time');

    const hours = Util.roundMoney(Util.diffHours(start, end));
    const sh = sheet_();
    const row = existing._rowIndex;
    sh.getRange(row, COL.actual_start).setValue(start);
    sh.getRange(row, COL.actual_end).setValue(end);
    sh.getRange(row, COL.hours_worked).setValue(hours);
    sh.getRange(row, COL.modified_by).setValue(actorId);
    sh.getRange(row, COL.modified_at).setValue(new Date());

    AuditLog.write({
      actorId,
      action: 'attendance.edit_times',
      targetType: 'attendance',
      targetId: attendanceId,
      before: {
        actualStart: existing.actualStart,
        actualEnd: existing.actualEnd,
        hoursWorked: existing.hoursWorked,
      },
      after: { actualStart: start, actualEnd: end, hoursWorked: hours },
    });

    return getById_(attendanceId);
  }

  return {
    getAll:              getAll_,
    getById:             getById_,
    getForStaff:         getForStaff_,
    getForDateAndStaff:  getForDateAndStaff_,
    getForDateRange:     getForDateRange_,
    getUnpaidForStaff:   getUnpaidForStaff_,
    openOrPromote:       openOrPromote_,
    schedule:            schedule_,
    complete:            complete_,
    cancel:              cancel_,
    editActualTimes:     editActualTimes_,
  };
})();
