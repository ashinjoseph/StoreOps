// ============================================================
//  WebApp.gs — HTTP entry point + RPC layer
// ============================================================
//  Every endpoint goes through Auth.validate(token) first. Role
//  guards are enforced server-side; never trust client-claimed role.
//
//  Convention: every RPC takes `token` as its first parameter (except
//  `rpcLogin`/`rpcGetActiveStaffForLogin` which are pre-auth). RPCs
//  return plain objects; throw on auth failures (client treats
//  NOT_LOGGED_IN as "redirect to login").
//
//  All write RPCs go through audit log via their respective modules.
// ============================================================

// ── Web app entry point ────────────────────────────────────
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('StoreOps')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag(
      'viewport',
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover'
    );
}

// ── Pre-auth RPCs ──────────────────────────────────────────

/**
 * Names of staff that should appear in the login dropdown.
 * Pre-auth — anyone can call. Only active staff names returned.
 */
function rpcGetActiveStaffForLogin() {
  try {
    return {
      success: true,
      staff: Staff.getActive().map(s => ({ staffId: s.staffId, name: s.name })),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function rpcLogin(name, code) {
  return Auth.login(name, code);
}

function rpcLogout(token) {
  return Auth.logout(token);
}

// ── Helpers used inside RPCs ──────────────────────────────

function _session(token) {
  return Auth.validate(token);    // throws NOT_LOGGED_IN if invalid
}

function _staffNameMap() {
  const map = {};
  Staff.getAll().forEach(s => { map[s.staffId] = s.name; });
  return map;
}

function _enrichStaffNames(rows) {
  const names = _staffNameMap();
  return rows.map(r => ({ ...r, staffName: names[r.staffId] || r.staffId }));
}

// ── Session info ──────────────────────────────────────────

function rpcGetMe(token) {
  const session = _session(token);
  return {
    staffId: session.staffId,
    name: session.name,
    role: session.role,
    companiesAuthorized: session.companiesAuthorized,
  };
}

/**
 * Minimal staff directory for any authenticated user. Returns only
 * { staffId, name, active } — safe for populating filter dropdowns
 * (no rates, login codes, emails). Includes inactive staff so historical
 * data (e.g. sales) can still be filtered by former employees.
 */
function rpcGetStaffDirectory(token) {
  _session(token);
  return Staff.getAll()
    .map(s => ({ staffId: s.staffId, name: s.name, active: s.active }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Self-service owed summary — what the calling user is owed. Scoped to
 * session.staffId so employees can only see their own pay. Includes
 * hourly rate so the per-shift calculation (hours × rate = value) is
 * verifiable by the employee.
 */
function rpcGetMyOwedSummary(token) {
  const session = _session(token);
  const staff = Staff.getById(session.staffId);
  const summary = Payments.getOwedSummary(session.staffId);
  return {
    staffId:        session.staffId,
    staffName:      session.name,
    hourlyRate:     staff ? staff.hourlyRate : 0,
    shiftsOwed:     summary.shiftsOwed,
    bonusesOwed:    summary.bonusesOwed,
    totalOwed:      summary.totalOwed,
    unpaidShifts:   summary.unpaidShifts,
    pendingBonuses: summary.pendingBonuses,
  };
}

// ── My Shift tab ──────────────────────────────────────────

/**
 * Get the current shift state for this user. Returns enough for the
 * dashboard cards to render: per-company open/closed status, today's
 * attendance summary, recent history.
 */
function rpcGetMyShiftState(token) {
  try {
    return _rpcGetMyShiftState(token);
  } catch (e) {
    // Log to Apps Script execution log AND re-throw with a useful message
    console.error('rpcGetMyShiftState failed: ' + e.message + '\n' + (e.stack || ''));
    throw new Error('rpcGetMyShiftState: ' + e.message);
  }
}

function _rpcGetMyShiftState(token) {
  const session = _session(token);
  const staffId = session.staffId;
  const today = Util.todayMidnight();

  // Per-company open session for me (if any)
  const myOpen = TillSessions.getOpenForStaff(staffId) || [];
  const openByCompany = {};
  myOpen.forEach(s => { if (s && s.company) openByCompany[s.company] = s; });

  // Who's currently holding the company tills (could be someone else).
  // getOpenForCompany returns the single open session or null.
  const cstoreOpen = TillSessions.getOpenForCompany('cstore');
  const vapeOpen = TillSessions.getOpenForCompany('vape');

  // Today's attendance for me
  const attendance = Attendance.getForDateAndStaff(today, staffId);

  // Recent shifts (last 7 days, mine, all closed)
  const sevenDaysAgo = Util.addDays(today, -7);
  const allInRange = TillSessions.getForDateRange(sevenDaysAgo, today) || [];
  const recentTill = allInRange
    .filter(s => s && s.staffId === staffId && (s.status === 'closed' || s.status === 'validated'))
    .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
    .slice(0, 10);

  // Build per-company card states
  const cards = ['cstore', 'vape'].map(company => {
    const mine = openByCompany[company];
    const occupied = company === 'cstore' ? cstoreOpen : vapeOpen;
    const expectedFloat = TillSessions.getExpectedFloat(company);
    const authorized = (session.companiesAuthorized || []).indexOf(company) !== -1;

    let state = 'closed';
    let detail = null;

    if (mine) {
      state = 'open_by_me';
      detail = {
        sessionId: mine.sessionId,
        startTime: mine.startTime ? mine.startTime.toISOString() : null,
        openingFloat: mine.openingFloat || 0,
      };
    } else if (occupied && occupied.staffId !== staffId) {
      state = 'open_by_other';
      const names = _staffNameMap();
      detail = {
        staffName: names[occupied.staffId] || occupied.staffId,
        startTime: occupied.startTime ? occupied.startTime.toISOString() : null,
      };
    }

    return { company, state, authorized, expectedFloat: expectedFloat || 0, detail };
  });

  // Today summary (only meaningful if attendance row exists)
  let todaySummary = null;
  if (attendance) {
    const sessionsToday = TillSessions.getForAttendance(attendance.attendanceId) || [];
    todaySummary = {
      attendanceId: attendance.attendanceId,
      status: attendance.status,
      actualStart: attendance.actualStart ? attendance.actualStart.toISOString() : null,
      actualEnd: attendance.actualEnd ? attendance.actualEnd.toISOString() : null,
      hoursWorked: attendance.hoursWorked || 0,
      sessionsOpen: sessionsToday.filter(s => s.status === 'open').length,
      sessionsClosed: sessionsToday.filter(s => s.status === 'closed' || s.status === 'validated').length,
    };
  }

  return {
    today: Util.formatDate(today),
    cards: cards,
    todaySummary: todaySummary,
    recentTill: recentTill.map(s => ({
      sessionId: s.sessionId,
      company: s.company,
      date: s.date ? Util.formatDate(s.date) : null,
      startTime: s.startTime ? s.startTime.toISOString() : null,
      endTime: s.endTime ? s.endTime.toISOString() : null,
      variance: s.closingVariance || 0,
      varianceStatus: s.varianceStatus || null,
    })),
  };
}

function rpcOpenShift(token, input) {
  try {
    const session = _session(token);
    // Cashier opens their OWN shift. Admin can technically open on
    // behalf of someone (e.g. for testing), but not allowed via this RPC.
    const staffId = input.staffId || session.staffId;
    if (staffId !== session.staffId && session.role !== 'admin') {
      throw new Error('FORBIDDEN: can only open your own shift');
    }
    const result = TillSessions.open({
      staffId,
      company: input.company,
      openingCount: Number(input.openingCount),
      openingNote: input.openingNote || '',
      actorId: session.staffId,
    });
    if (!result) throw new Error('TillSessions.open returned null');
    return {
      sessionId:    result.sessionId,
      company:      result.company,
      staffId:      result.staffId,
      status:       result.status,
      openingFloat: Number(result.openingFloat) || 0,
      startTime:    result.startTime ? result.startTime.toISOString() : null,
    };
  } catch (e) {
    console.error('rpcOpenShift failed: ' + e.message + '\n' + (e.stack || ''));
    throw new Error('rpcOpenShift: ' + e.message);
  }
}

function rpcCloseShift(token, input) {
  try {
    const session = _session(token);
    // Cashier closes own shift; manager/admin can close any
    const target = TillSessions.getById(input.sessionId);
    if (!target) throw new Error('Session not found: ' + input.sessionId);
    if (target.staffId !== session.staffId &&
        session.role !== 'admin' &&
        session.role !== 'manager') {
      throw new Error('FORBIDDEN: only the cashier who opened, or an admin/manager, can close this shift');
    }
    // Translate UI field names to TillSessions.close's expected names
    const result = TillSessions.close({
      sessionId:     input.sessionId,
      cashSales:     Number(input.cashSales) || 0,
      creditCard:    Number(input.creditCardSales) || 0,
      debitCard:     Number(input.debitCardSales) || 0,
      cashback:      Number(input.cashbackPaid) || 0,
      miscCash:      Number(input.miscCashSales) || 0,
      miscCredit:    Number(input.miscCreditSales) || 0,
      miscDebit:     Number(input.miscDebitSales) || 0,
      miscNotes:     input.miscNotes || '',
      physicalCount: Number(input.physicalCount),
      notes:         input.closingNote || '',
      actorId:       session.staffId,
    });
    if (!result) throw new Error('TillSessions.close returned null');
    // Normalize for serialization (strip nested session w/ Date fields)
    return {
      sessionId:      result.session ? result.session.sessionId : input.sessionId,
      expectedCash:   Number(result.expectedCash) || 0,
      counted:        Number(result.counted) || 0,
      variance:       Number(result.variance) || 0,
      cashRemoved:    Number(result.cashRemoved) || 0,
      floatLeft:      Number(result.floatLeft) || 0,
      varianceStatus: result.varianceStatus || 'OK',
    };
  } catch (e) {
    console.error('rpcCloseShift failed: ' + e.message + '\n' + (e.stack || ''));
    throw new Error('rpcCloseShift: ' + e.message);
  }
}

// ── Schedule tab ──────────────────────────────────────────

/**
 * Return a 7-day grid for a Monday-start week. Each cell tells what
 * each staff is doing that day.
 */
function rpcGetWeekSchedule(token, weekStartStr) {
  _session(token);
  const weekStart = Util.parseDate(weekStartStr) || Util.getMondayOf(new Date());
  const weekEnd = Util.endOfDay(Util.addDays(weekStart, 6));

  const activeStaff = Staff.getActive();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = Util.addDays(weekStart, i);
    days.push({
      date: Util.formatDate(date),
      dayName: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][i],
    });
  }

  const cells = [];
  activeStaff.forEach(staff => {
    days.forEach(day => {
      const att = Attendance.getForDateAndStaff(Util.parseDate(day.date), staff.staffId);
      cells.push({
        staffId: staff.staffId,
        staffName: staff.name,
        date: day.date,
        attendanceId: att ? att.attendanceId : null,
        status: att ? att.status : null,
        scheduledStart: att ? att.scheduledStart : '',
        scheduledEnd: att ? att.scheduledEnd : '',
        hoursWorked: att ? att.hoursWorked : 0,
      });
    });
  });

  return {
    weekStart: Util.formatDate(weekStart),
    weekEnd: Util.formatDate(weekEnd),
    days,
    staff: activeStaff.map(s => ({ staffId: s.staffId, name: s.name })),
    cells,
  };
}

function rpcScheduleShift(token, input) {
  const session = _session(token);
  Auth.require(session, ['admin', 'manager']);
  return Attendance.schedule({
    staffId: input.staffId,
    date: Util.parseDate(input.date),
    scheduledStart: input.scheduledStart || '',
    scheduledEnd: input.scheduledEnd || '',
    actorId: session.staffId
  });
}

function rpcCancelScheduledShift(token, attendanceId, reason) {
  const session = _session(token);
  Auth.require(session, ['admin', 'manager']);
  return Attendance.cancel(attendanceId, session.staffId, reason || '');
}

function rpcEditAttendanceTimes(token, input) {
  const session = _session(token);
  Auth.require(session, ['admin']);   // admin only for actual-time edits
  return Attendance.editActualTimes(
    input.attendanceId,
    new Date(input.actualStart),
    new Date(input.actualEnd),
    session.staffId
  );
}

// ── Payroll tab ───────────────────────────────────────────

function rpcGetPayrollOverview(token) {
  try {
    const session = _session(token);
    Auth.require(session, ['admin', 'payroll_admin']);
    const staff = Staff.getActive() || [];
    return staff.map(s => {
      let owed;
      try {
        owed = Payments.getOwedSummary(s.staffId) || {};
      } catch (e) {
        console.error('getOwedSummary failed for ' + s.staffId + ': ' + e.message);
        owed = {};
      }
      return {
        staffId: s.staffId,
        staffName: s.name,
        hourlyRate: s.hourlyRate,
        shiftsOwed: owed.shiftsOwed || 0,
        bonusesOwed: owed.bonusesOwed || 0,
        totalOwed: owed.totalOwed || 0,
        unpaidShiftCount: (owed.unpaidShifts || []).length,
        pendingBonusCount: (owed.pendingBonuses || []).length,
      };
    });
  } catch (e) {
    console.error('rpcGetPayrollOverview failed: ' + e.message + '\n' + (e.stack || ''));
    throw new Error('rpcGetPayrollOverview: ' + e.message);
  }
}

function rpcGetOwedSummary(token, staffId) {
  try {
    const session = _session(token);
    Auth.require(session, ['admin', 'payroll_admin']);
    const result = Payments.getOwedSummary(staffId);
    if (!result) {
      // Should never happen — fail loud
      throw new Error('getOwedSummary returned null for ' + staffId);
    }
    return {
      staffId: result.staffId || staffId,
      shiftsOwed: result.shiftsOwed || 0,
      bonusesOwed: result.bonusesOwed || 0,
      totalOwed: result.totalOwed || 0,
      unpaidShifts: result.unpaidShifts || [],
      pendingBonuses: result.pendingBonuses || [],
    };
  } catch (e) {
    console.error('rpcGetOwedSummary(' + staffId + ') failed: ' + e.message + '\n' + (e.stack || ''));
    throw new Error('rpcGetOwedSummary: ' + e.message);
  }
}

function rpcPayShifts(token, input) {
  try {
    const session = _session(token);
    Auth.require(session, ['admin', 'payroll_admin']);
    const result = Payments.payShifts({
      staffId: input.staffId,
      amount: Number(input.amount),
      method: input.method || 'cash',
      notes: input.notes || '',
      actorId: session.staffId,
    });
    if (!result) throw new Error('payShifts returned null');
    return {
      paymentId:    result.paymentId,
      totalAmount:  Number(result.totalAmount) || 0,
      kind:         result.kind || 'shifts',
      itemsCreated: (result.itemsCreated || []).map(it => ({
        itemId:       it.itemId,
        attendanceId: it.attendanceId,
        dateStr:      it.dateStr || '',
        amount:       Number(it.amount) || 0,
        isPartial:    !!it.isPartial,
      })),
      summary: {
        shiftsOwedBefore: Number((result.summary || {}).shiftsOwedBefore) || 0,
        shiftsOwedAfter:  Number((result.summary || {}).shiftsOwedAfter) || 0,
        fullyPaidCount:   Number((result.summary || {}).fullyPaidCount) || 0,
        partialCount:     Number((result.summary || {}).partialCount) || 0,
      },
    };
  } catch (e) {
    console.error('rpcPayShifts failed: ' + e.message + '\n' + (e.stack || ''));
    throw new Error('rpcPayShifts: ' + e.message);
  }
}

function rpcPayBonus(token, input) {
  try {
    const session = _session(token);
    Auth.require(session, ['admin', 'payroll_admin']);
    const result = Payments.payBonus({
      bonusId: input.bonusId,
      amount: Number(input.amount),
      method: input.method || 'cash',
      notes: input.notes || '',
      actorId: session.staffId,
    });
    if (!result) throw new Error('payBonus returned null');
    return {
      paymentId:       result.paymentId,
      bonusId:         result.bonusId,
      amount:          Number(result.amount) || 0,
      isPartial:       !!result.isPartial,
      newBonusStatus:  result.newBonusStatus || 'pending',
      kind:            'bonus',
    };
  } catch (e) {
    console.error('rpcPayBonus failed: ' + e.message + '\n' + (e.stack || ''));
    throw new Error('rpcPayBonus: ' + e.message);
  }
}

function rpcUndoPayment(token, paymentId) {
  const session = _session(token);
  Auth.require(session, ['admin', 'payroll_admin']);
  return Payments.undo(paymentId, session.staffId);
}

// ── Bonuses (proposed/pending) ────────────────────────────

function rpcGetProposedBonuses(token) {
  try {
    const session = _session(token);
    Auth.require(session, ['admin', 'payroll_admin']);
    const names = _staffNameMap();
    return Bonuses.getProposed().map(b => ({
      bonusId: b.bonusId,
      staffId: b.staffId,
      staffName: names[b.staffId] || b.staffId,
      type: b.type,
      amount: b.amount || 0,
      reason: b.reason || '',
      date: b.date ? b.date.toISOString() : null,
      status: b.status,
      periodStart: b.periodStart ? b.periodStart.toISOString() : null,
      periodEnd: b.periodEnd ? b.periodEnd.toISOString() : null,
      company: b.company || '',
      sourceRunId: b.sourceRunId || '',
      notes: b.notes || '',
    }));
  } catch (e) {
    console.error('rpcGetProposedBonuses failed: ' + e.message + '\n' + (e.stack || ''));
    throw new Error('rpcGetProposedBonuses: ' + e.message);
  }
}

function rpcApproveBonus(token, bonusId) {
  const session = _session(token);
  Auth.require(session, ['admin', 'payroll_admin']);
  return Bonuses.approve(bonusId, session.staffId);
}

function rpcCancelBonus(token, bonusId, reason) {
  const session = _session(token);
  Auth.require(session, ['admin', 'payroll_admin']);
  return Bonuses.cancel(bonusId, session.staffId, reason || '');
}

function rpcCreateBonus(token, input) {
  const session = _session(token);
  Auth.require(session, ['admin']);
  return Bonuses.create({
    staffId: input.staffId,
    type: input.type,
    amount: Number(input.amount),
    reason: input.reason,
    date: input.date ? Util.parseDate(input.date) : new Date(),
    company: input.company || '',
    notes: input.notes || '',
    actorId: session.staffId,
  });
}

// ── Sales dashboard ───────────────────────────────────────

function rpcGetSalesDashboard(token, filters) {
  const session = _session(token);
  Auth.require(session, ['admin', 'manager', 'payroll_admin']);
  filters = filters || {};
  const result = Sales.getDashboard({
    startDate: filters.startDate ? Util.parseDate(filters.startDate) : null,
    endDate: filters.endDate ? Util.parseDate(filters.endDate) : null,
    staffId: filters.staffId || null,
    company: filters.company || null,
    page: Number(filters.page) || 1,
    pageSize: Number(filters.pageSize) || 50,
  });
  // Translate fields for UI compatibility:
  //   Sales.getDashboard returns `totalCount` but UI expects `rowCount`
  return {
    rows: result.rows,
    page: result.page,
    pageSize: result.pageSize,
    pageCount: result.pageCount,
    rowCount: result.totalCount,
    totals: result.totals,
  };
}

// ── History tab ───────────────────────────────────────────

function rpcGetPaymentHistory(token, limit) {
  try {
    const session = _session(token);
    limit = Number(limit) || 25;

    function normalizePayment(p, staffName) {
      return {
        paymentId: p.paymentId,
        staffId: p.staffId,
        staffName: staffName,
        paidOn: p.paidOn ? p.paidOn.toISOString() : null,
        totalAmount: p.totalAmount || 0,
        method: p.method || '',
        recordedBy: p.recordedBy || '',
        notes: p.notes || '',
        items: Payments.getItemsForPayment(p.paymentId).map(it => ({
          itemId: it.itemId,
          paymentId: it.paymentId,
          itemType: it.itemType,
          refId: it.refId,
          amount: it.amount || 0,
          notes: it.notes || '',
        })),
      };
    }

    // Employees see only their own payments
    if (session.role === 'employee') {
      return Payments.getPaymentsForStaff(session.staffId)
        .slice(0, limit)
        .map(p => normalizePayment(p, session.name));
    }

    // Admin + manager see everything
    const payments = Payments.getRecent(limit);
    const names = _staffNameMap();
    return payments.map(p => normalizePayment(p, names[p.staffId] || p.staffId));
  } catch (e) {
    console.error('rpcGetPaymentHistory failed: ' + e.message + '\n' + (e.stack || ''));
    throw new Error('rpcGetPaymentHistory: ' + e.message);
  }
}

// ── Commission engine (admin trigger from web app) ────────

function rpcGetCommissionRuns(token, limit) {
  try {
    const session = _session(token);
    Auth.require(session, ['admin', 'manager', 'payroll_admin']);
    limit = Number(limit) || 12;
    return Commissions.getAllRuns()
      .sort((a, b) => (b.computedAt || 0) - (a.computedAt || 0))
      .slice(0, limit)
      .map(r => ({
        runId: r.runId,
        weekStart: r.weekStart ? r.weekStart.toISOString() : null,
        weekEnd: r.weekEnd ? r.weekEnd.toISOString() : null,
        staffCount: r.staffCount || 0,
        bonusesCreated: r.bonusesCreated || 0,
        totalCommissionAmount: r.totalCommissionAmount || 0,
        computedAt: r.computedAt ? r.computedAt.toISOString() : null,
        computedBy: r.computedBy || '',
        notes: r.notes || '',
      }));
  } catch (e) {
    console.error('rpcGetCommissionRuns failed: ' + e.message + '\n' + (e.stack || ''));
    throw new Error('rpcGetCommissionRuns: ' + e.message);
  }
}

function rpcRunCommissionEngine(token, force) {
  const session = _session(token);
  Auth.require(session, ['admin', 'payroll_admin']);
  const range = Util.getPreviousWeekRange(new Date());
  return Commissions.runForWeek({
    weekStart: range.start,
    weekEnd: range.end,
    actorId: session.staffId,
    force: force === true,
  });
}

// ── Commission rules CRUD ─────────────────────────────────

function rpcGetCommissionRules(token) {
  const session = _session(token);
  Auth.require(session, ['admin', 'manager', 'payroll_admin']);
  return CommissionRules.getAll();
}

function rpcCreateCommissionRule(token, input) {
  const session = _session(token);
  Auth.require(session, ['admin', 'payroll_admin']);
  return CommissionRules.create({
    name: input.name,
    appliesTo: input.appliesTo,
    staffId: input.staffId,
    company: input.company,
    threshold: Number(input.threshold),
    percentage: Number(input.percentage),
    active: input.active !== false,
    effectiveFrom: Util.parseDate(input.effectiveFrom),
    effectiveTo: input.effectiveTo ? Util.parseDate(input.effectiveTo) : null,
    notes: input.notes || '',
    actorId: session.staffId,
  });
}

function rpcUpdateCommissionRule(token, input) {
  const session = _session(token);
  Auth.require(session, ['admin', 'payroll_admin']);
  return CommissionRules.update({
    ruleId: input.ruleId,
    name: input.name,
    threshold: input.threshold !== undefined ? Number(input.threshold) : undefined,
    percentage: input.percentage !== undefined ? Number(input.percentage) : undefined,
    active: input.active,
    effectiveTo: input.effectiveTo !== undefined
      ? (input.effectiveTo ? Util.parseDate(input.effectiveTo) : null)
      : undefined,
    notes: input.notes,
    actorId: session.staffId,
  });
}

// ── Staff management (admin only) ─────────────────────────

function rpcGetAllStaff(token) {
  const session = _session(token);
  Auth.require(session, ['admin']);
  // Strip login_code from response — never send PINs to client
  return Staff.getAll().map(s => ({
    staffId: s.staffId,
    name: s.name,
    hourlyRate: s.hourlyRate,
    active: s.active,
    role: s.role,
    companiesAuthorized: s.companiesAuthorized,
    email: s.email,
    startDate: s.startDate,
  }));
}
