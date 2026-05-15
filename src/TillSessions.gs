// ============================================================
//  TillSessions.gs — per-company cash reconciliation
// ============================================================
//  One row per (date, staff, company). Lifecycle:
//    open  →  closed  →  (Phase 2: validated)
//
//  Opening a session creates or promotes today's attendance.
//  Closing the LAST open session for an attendance auto-completes
//  that attendance.
//
//  This module also writes the corresponding sales row at close.
// ============================================================

const TillSessions = (() => {

  const COL = {
    session_id: 1, attendance_id: 2, staff_id: 3, company: 4, date: 5,
    status: 6, start_time: 7, end_time: 8,
    expected_opening: 9, opening_float: 10, opening_note: 11,
    closing_cash_counted: 12, cash_left_in_till: 13, cash_removed_at_close: 14,
    expected_cash: 15, closing_variance: 16, variance_status: 17, notes: 18
  };
  const NUM_COLS = 18;
  const DATA_START_ROW = 3;

  function sheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.TILL_SESSIONS);
    if (!sh) throw new Error('till_sessions sheet not found — run First-time Setup');
    return sh;
  }

  function configValue_(key, defaultValue) {
    try {
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      const sh = ss.getSheetByName(SHEETS.CONFIG);
      if (!sh) return defaultValue;
      const data = sh.getRange(3, 1, sh.getLastRow() - 2, 2).getValues();
      const row = data.find(r => r[0] === key);
      return row && row[1] !== '' ? row[1] : defaultValue;
    } catch (e) { return defaultValue; }
  }

  function getExpectedFloat_(company) {
    return Number(configValue_(
      company === 'cstore' ? 'cstore_default_opening_float' : 'vape_default_opening_float',
      company === 'cstore' ? 250 : 100
    )) || 0;
  }

  function getVarianceStatus_(variance) {
    const ok = Number(configValue_('variance_ok_threshold', 1)) || 1;
    const minor = Number(configValue_('variance_minor_threshold', 30)) || 30;
    const abs = Math.abs(variance);
    if (abs <= ok) return 'OK';
    if (abs <= minor) return 'minor';
    return 'investigate';
  }

  function rowToRecord_(row, rowIndex) {
    return {
      sessionId:        (row[COL.session_id - 1] || '').toString().trim(),
      attendanceId:     (row[COL.attendance_id - 1] || '').toString().trim(),
      staffId:          (row[COL.staff_id - 1] || '').toString().trim(),
      company:          (row[COL.company - 1] || '').toString().trim(),
      date:             row[COL.date - 1] instanceof Date ? row[COL.date - 1] : null,
      status:           (row[COL.status - 1] || 'open').toString().trim(),
      startTime:        row[COL.start_time - 1] instanceof Date ? row[COL.start_time - 1] : null,
      endTime:          row[COL.end_time - 1] instanceof Date ? row[COL.end_time - 1] : null,
      expectedOpening:  Number(row[COL.expected_opening - 1]) || 0,
      openingFloat:     Number(row[COL.opening_float - 1]) || 0,
      openingNote:      (row[COL.opening_note - 1] || '').toString(),
      closingCashCounted:  Number(row[COL.closing_cash_counted - 1]) || 0,
      cashLeftInTill:      Number(row[COL.cash_left_in_till - 1]) || 0,
      cashRemovedAtClose:  Number(row[COL.cash_removed_at_close - 1]) || 0,
      expectedCash:        Number(row[COL.expected_cash - 1]) || 0,
      closingVariance:     Number(row[COL.closing_variance - 1]) || 0,
      varianceStatus:      (row[COL.variance_status - 1] || '').toString(),
      notes:               (row[COL.notes - 1] || '').toString(),
      _rowIndex:           rowIndex,
    };
  }

  function getAll_() {
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last < DATA_START_ROW) return [];
    const data = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS).getValues();
    return data
      .map((row, i) => rowToRecord_(row, i + DATA_START_ROW))
      .filter(r => r.sessionId);
  }

  function getById_(sessionId) {
    return getAll_().find(s => s.sessionId === sessionId) || null;
  }

  function getForAttendance_(attendanceId) {
    return getAll_().filter(s => s.attendanceId === attendanceId);
  }

  function getOpenForCompany_(company) {
    return getAll_().find(s => s.company === company && s.status === 'open') || null;
  }

  function getOpenForStaff_(staffId) {
    return getAll_().filter(s => s.staffId === staffId && s.status === 'open');
  }

  function getForDateRange_(startDate, endDate, filterCompany) {
    const start = startDate instanceof Date ? startDate : Util.parseDate(startDate);
    const end = endDate instanceof Date ? endDate : Util.parseDate(endDate);
    if (!start || !end) return [];
    return getAll_().filter(s => {
      if (!s.date || s.date < start || s.date > end) return false;
      if (filterCompany && s.company !== filterCompany) return false;
      return true;
    });
  }

  /**
   * Open a till session.
   *
   * @param input { staffId, company, openingCount, openingNote?, actorId }
   *
   * Workflow:
   *   1. Reject if a session for this company is already open
   *   2. Get or create today's attendance for this staff (status: in_progress)
   *   3. Create new till_session linked to that attendance
   *   4. Audit + notify
   */
  function open_(input) {
    if (!input.staffId) throw new Error('staffId required');
    if (!input.actorId) throw new Error('actorId required');
    if (!input.company || COMPANIES.indexOf(input.company) === -1) {
      throw new Error('Invalid company: ' + input.company);
    }
    if (typeof input.openingCount !== 'number' || input.openingCount < 0) {
      throw new Error('openingCount must be a non-negative number');
    }

    const staff = Staff.getById(input.staffId);
    if (!staff) throw new Error('Staff not found: ' + input.staffId);
    if (staff.companiesAuthorized.indexOf(input.company) === -1) {
      throw new Error(staff.name + ' is not authorized for ' + input.company);
    }

    // Reject duplicate open
    const existingOpen = getOpenForCompany_(input.company);
    if (existingOpen) {
      throw new Error(
        input.company + ' already has an open shift (' +
        existingOpen.sessionId + ' by ' + existingOpen.staffId + ')'
      );
    }

    const now = new Date();
    const today = Util.todayMidnight();

    // Verify opening float — if mismatch and no note, refuse
    const expectedFloat = getExpectedFloat_(input.company);
    if (Math.abs(input.openingCount - expectedFloat) > 0.01 && !input.openingNote) {
      throw new Error(
        'Float mismatch (counted ' + input.openingCount + ', expected ' + expectedFloat +
        '). Please provide an opening note.'
      );
    }

    // Step 1: get or create attendance for today
    const attendance = Attendance.openOrPromote(input.staffId, today, input.actorId, now);

    // Step 2: create till_session
    const sessionId = Util.tillSessionId(today, input.staffId, input.company);
    const sh = sheet_();
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, NUM_COLS).setValues([[
      sessionId,
      attendance.attendanceId,
      input.staffId,
      input.company,
      today,
      'open',
      now, '',
      expectedFloat, input.openingCount, input.openingNote || '',
      0, 0, 0, 0, 0,
      '', input.notes || ''
    ]]);

    AuditLog.write({
      actorId: input.actorId,
      action: 'till.open',
      targetType: 'till_sessions',
      targetId: sessionId,
      after: {
        staffId: input.staffId,
        company: input.company,
        openingFloat: input.openingCount,
        attendanceId: attendance.attendanceId,
      },
    });

    Notifier.notify('shift.opened', {
      staffId: input.staffId,
      staffName: staff.name,
      company: input.company,
      sessionId,
      openingFloat: input.openingCount,
    });

    return getById_(sessionId);
  }

  /**
   * Close a till session.
   *
   * @param input { sessionId, actorId,
   *                cashSales, creditCard, debitCard, cashback,
   *                miscCash, miscCredit, miscDebit, miscNotes,
   *                physicalCount, hstCollected?, bottleDeposit?, roundOff?,
   *                notes? }
   *
   * Workflow:
   *   1. Validate session is open and actor is allowed
   *   2. Write sales row (calls Sales.write_)
   *   3. Compute expected/variance, update till_session
   *   4. If this was the LAST open session for the attendance,
   *      auto-complete the attendance
   */
  function close_(input) {
    if (!input.sessionId) throw new Error('sessionId required');
    if (!input.actorId) throw new Error('actorId required');
    if (typeof input.physicalCount !== 'number' || input.physicalCount < 0) {
      throw new Error('physicalCount required (non-negative number)');
    }

    const session = getById_(input.sessionId);
    if (!session) throw new Error('Session not found: ' + input.sessionId);
    if (session.status !== 'open') {
      throw new Error('Session is not open (status: ' + session.status + ')');
    }

    // Only the cashier who opened, OR an admin/manager, can close
    if (session.staffId !== input.actorId) {
      const actor = Staff.getById(input.actorId);
      if (!actor || (actor.role !== 'admin' && actor.role !== 'manager')) {
        throw new Error(
          'Only ' + session.staffId + ' or an admin/manager can close this session'
        );
      }
    }

    const now = new Date();
    const floatAmount = getExpectedFloat_(session.company);

    // Build sales payload
    const salesInput = {
      sessionId: session.sessionId,
      staffId: session.staffId,
      company: session.company,
      date: session.date,
      cashSales:        Number(input.cashSales) || 0,
      creditCardSales:  Number(input.creditCard) || 0,
      debitCardSales:   Number(input.debitCard) || 0,
      cashbackPaid:     Number(input.cashback) || 0,
      hstCollected:     Number(input.hstCollected) || 0,
      bottleDeposit:    Number(input.bottleDeposit) || 0,
      roundOff:         Number(input.roundOff) || 0,
      miscCashSales:    Number(input.miscCash) || 0,
      miscCreditSales:  Number(input.miscCredit) || 0,
      miscDebitSales:   Number(input.miscDebit) || 0,
      miscNotes:        input.miscNotes || '',
    };

    Sales.write(salesInput, input.actorId);

    // Compute expected cash and variance
    const expectedCash = session.openingFloat
                       + salesInput.cashSales
                       + salesInput.miscCashSales
                       - salesInput.cashbackPaid;
    const variance = Util.roundMoney(input.physicalCount - expectedCash);
    const cashRemoved = Util.roundMoney(input.physicalCount - floatAmount);
    const varianceStatus = getVarianceStatus_(variance);

    // Update till_session
    const sh = sheet_();
    const row = session._rowIndex;
    sh.getRange(row, COL.status).setValue('closed');
    sh.getRange(row, COL.end_time).setValue(now);
    sh.getRange(row, COL.closing_cash_counted).setValue(input.physicalCount);
    sh.getRange(row, COL.cash_left_in_till).setValue(floatAmount);
    sh.getRange(row, COL.cash_removed_at_close).setValue(cashRemoved);
    sh.getRange(row, COL.expected_cash).setValue(Util.roundMoney(expectedCash));
    sh.getRange(row, COL.closing_variance).setValue(variance);
    sh.getRange(row, COL.variance_status).setValue(varianceStatus);
    if (input.notes) sh.getRange(row, COL.notes).setValue(input.notes);

    AuditLog.write({
      actorId: input.actorId,
      action: 'till.close',
      targetType: 'till_sessions',
      targetId: session.sessionId,
      after: {
        physicalCount: input.physicalCount,
        expectedCash: Util.roundMoney(expectedCash),
        variance,
        varianceStatus,
      },
    });

    Notifier.notify('shift.closed', {
      staffId: session.staffId,
      staffName: (Staff.getById(session.staffId) || {}).name,
      company: session.company,
      sessionId: session.sessionId,
      variance,
    });

    // If this was the LAST open session for the attendance, complete it
    const siblings = getForAttendance_(session.attendanceId);
    const stillOpen = siblings.filter(s =>
      s.status === 'open' && s.sessionId !== session.sessionId
    );
    if (stillOpen.length === 0) {
      try {
        Attendance.complete(session.attendanceId, now, input.actorId);
      } catch (e) {
        // Log but don't fail the close
        console.log('Attendance.complete failed: ' + e.message);
      }
    }

    return {
      session: getById_(session.sessionId),
      expectedCash: Util.roundMoney(expectedCash),
      counted: input.physicalCount,
      variance,
      cashRemoved,
      floatLeft: floatAmount,
      varianceStatus,
    };
  }

  /**
   * Admin override: edit fields on a closed session. Triggers a recompute
   * of variance. Useful for correcting data-entry errors.
   *
   * Cannot reopen a session — that needs cancellation flow.
   */
  function edit_(input) {
    if (!input.sessionId) throw new Error('sessionId required');
    if (!input.actorId) throw new Error('actorId required');
    const actor = Staff.getById(input.actorId);
    if (!actor || (actor.role !== 'admin' && actor.role !== 'manager')) {
      throw new Error('Only admin/manager can edit closed sessions');
    }
    const session = getById_(input.sessionId);
    if (!session) throw new Error('Session not found: ' + input.sessionId);

    const sh = sheet_();
    const row = session._rowIndex;
    const before = {
      openingFloat: session.openingFloat,
      closingCashCounted: session.closingCashCounted,
      notes: session.notes,
    };

    if (input.openingFloat != null) {
      sh.getRange(row, COL.opening_float).setValue(Number(input.openingFloat));
    }
    if (input.closingCashCounted != null) {
      sh.getRange(row, COL.closing_cash_counted).setValue(Number(input.closingCashCounted));
    }
    if (input.notes != null) sh.getRange(row, COL.notes).setValue(input.notes);

    // Recompute variance if needed
    const updated = getById_(session.sessionId);
    const salesRow = Sales.getForSession(updated.sessionId);
    if (salesRow) {
      const expected = updated.openingFloat + salesRow.cashSales + salesRow.miscCashSales - salesRow.cashbackPaid;
      const variance = Util.roundMoney(updated.closingCashCounted - expected);
      sh.getRange(row, COL.expected_cash).setValue(Util.roundMoney(expected));
      sh.getRange(row, COL.closing_variance).setValue(variance);
      sh.getRange(row, COL.variance_status).setValue(getVarianceStatus_(variance));
    }

    AuditLog.write({
      actorId: input.actorId,
      action: 'till.edit',
      targetType: 'till_sessions',
      targetId: session.sessionId,
      before,
      after: {
        openingFloat: input.openingFloat,
        closingCashCounted: input.closingCashCounted,
        notes: input.notes,
      },
    });

    return getById_(session.sessionId);
  }

  return {
    getAll:              getAll_,
    getById:             getById_,
    getForAttendance:    getForAttendance_,
    getOpenForCompany:   getOpenForCompany_,
    getOpenForStaff:     getOpenForStaff_,
    getForDateRange:     getForDateRange_,
    open:                open_,
    close:               close_,
    edit:                edit_,
    getExpectedFloat:    getExpectedFloat_,
    getVarianceStatus:   getVarianceStatus_,
  };
})();
