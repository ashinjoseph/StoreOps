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
 * One-shot boot payload: validates the token and returns the user profile
 * plus the landing (My Shift) state in a SINGLE round-trip. Used on page
 * load / session restore so the app needs one RPC instead of two
 * (rpcGetMe + rpcGetMyShiftState). If the shift state fails to build, we
 * still return `me` so the app can render; the shift tab will retry.
 */
function rpcGetBootstrap(token) {
  const session = _session(token);
  let shift = null;
  try { shift = _rpcGetMyShiftState(token); } catch (e) {
    console.error('rpcGetBootstrap shift failed: ' + e.message);
  }
  return {
    me: {
      staffId: session.staffId,
      name: session.name,
      role: session.role,
      companiesAuthorized: session.companiesAuthorized,
    },
    shift: shift,
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

/**
 * Send a WhatsApp "shift opened" notice (name + till). Called fire-and-forget
 * by the client right after a successful open so it never slows the open.
 * Best-effort; respects notifier_enabled + whatsapp_target_number (which may
 * list several recipients).
 */
function rpcNotifyShiftOpen(token, company) {
  const session = _session(token);
  const label = company === 'vape' ? 'Vape' : (company === 'cstore' ? 'Cstore' : String(company || ''));
  const when = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'EEE d MMM, HH:mm');
  const params = [session.name, label, when];
  const plain = '🟢 ' + session.name + ' opened the ' + label + ' till\n🕐 ' + when;
  try { return Notifier.sendOp('shift_open', params, plain); } catch (e) { return { sent: false, reason: 'exception' }; }
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

// ── Clover reconciliation ─────────────────────────────────

/**
 * Reconcile today's cashier-entered card totals against Clover.
 * Any authenticated user (auto path fires after any cashier's close).
 * force=true (manual button) runs even if tills are still open.
 */
function rpcReconcileDay(token, force) {
  const session = _session(token);
  const r = Reconcile.reconcileDay(session.staffId, force === true ? 'manual' : 'auto');
  // JSON round-trip: the raw result carries Date objects (merchants[].window
  // start/end) that google.script.run can't serialize — the client would
  // otherwise receive null and throw. Stringify converts Dates → ISO strings.
  return JSON.parse(JSON.stringify(r || {}));
}

/**
 * Recent reconciliations (latest run per date+merchant, newest first) for
 * the dashboard's history table. admin / manager / payroll_admin.
 */
function rpcGetReconciliation(token, limit) {
  const session = _session(token);
  Auth.require(session, ['admin', 'manager', 'payroll_admin']);
  return Reconcile.getRecent(Number(limit) || 60);
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
    const names = _staffNameMap();
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
        computedByName: names[r.computedBy] || r.computedBy || '',
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
  const r = Commissions.runForWeek({
    weekStart: range.start,
    weekEnd: range.end,
    actorId: session.staffId,
    force: force === true,
  });
  // JSON round-trip — raw result carries Date objects (weekStart/weekEnd)
  // that google.script.run can't serialize (client would receive null).
  return JSON.parse(JSON.stringify(r || {}));
}

// ── Commission rules CRUD ─────────────────────────────────

function rpcGetCommissionRules(token) {
  const session = _session(token);
  Auth.require(session, ['admin', 'manager', 'payroll_admin']);
  // Return a clean, JSON-serializable shape — raw records carry Date
  // objects + _rowIndex which google.script.run can fail to serialize
  // (the client then receives "[Ljava.lang.Object;@…" instead of an array).
  return CommissionRules.getAll().map(r => ({
    ruleId:        r.ruleId,
    name:          r.name,
    appliesTo:     r.appliesTo,
    staffId:       r.staffId,
    company:       r.company,
    threshold:     r.threshold,
    percentage:    r.percentage,
    active:        r.active,
    effectiveFrom: r.effectiveFrom ? r.effectiveFrom.toISOString() : null,
    effectiveTo:   r.effectiveTo ? r.effectiveTo.toISOString() : null,
    notes:         r.notes,
  }));
}

/**
 * Diagnostic — run from the Apps Script editor to see what
 * CommissionRules.getAll() actually reads from the sheet. No auth, no
 * deployment required: just open the editor, pick this function from
 * the dropdown, click Run, then View → Logs (or Executions).
 */
function debugCommissionRules() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.COMMISSION_RULES);
  if (!sh) {
    console.log('DIAG: sheet not found. Expected name: "' + SHEETS.COMMISSION_RULES + '"');
    const all = SpreadsheetApp.getActiveSpreadsheet().getSheets().map(s => s.getName());
    console.log('DIAG: sheets in this workbook: ' + JSON.stringify(all));
    return;
  }
  console.log('DIAG: sheet "' + sh.getName() + '" lastRow=' + sh.getLastRow() + ' lastCol=' + sh.getLastColumn());
  const allValues = sh.getDataRange().getValues();
  console.log('DIAG: total raw rows = ' + allValues.length);
  allValues.forEach((row, i) => {
    console.log('DIAG: row ' + (i + 1) + ' = ' + JSON.stringify(row));
  });
  const result = CommissionRules.getAll();
  console.log('DIAG: CommissionRules.getAll() returned ' + result.length + ' record(s)');
  result.forEach((r, i) => {
    console.log('DIAG: record ' + i + ' = ' + JSON.stringify(r));
  });
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

// ── Suppliers reference + Shopping list ───────────────────

/**
 * Supplier reference (where to buy what). Any authenticated user.
 */
function rpcGetSuppliers(token) {
  _session(token);
  return Suppliers.getAll();
}

/**
 * Order catalog — known items for the picker. Any authenticated user.
 */
function rpcGetOrderCatalog(token) {
  _session(token);
  return OrderCatalog.getAll().map(i => ({
    itemId: i.itemId,
    name: i.name,
    category: i.category,
    unit: i.unit,
    unitPrice: i.unitPrice,
    parLevel: i.parLevel,
    suggestedSupplier: i.suggestedSupplier,
  }));
}

/**
 * Add a new catalog item. Any authenticated user (employees curate the
 * catalog as they discover items to order).
 */
function rpcAddCatalogItem(token, input) {
  const session = _session(token);
  const item = OrderCatalog.create({
    name: input.name,
    category: input.category,
    unit: input.unit || '',
    unitPrice: Number(input.unitPrice) || 0,
    parLevel: Number(input.parLevel) || 0,
    suggestedSupplier: input.suggestedSupplier || '',
    notes: input.notes || '',
    actorId: session.staffId,
  });
  return {
    itemId: item.itemId, name: item.name, category: item.category,
    unit: item.unit, unitPrice: item.unitPrice, parLevel: item.parLevel,
  };
}

/**
 * The active shopping checklist (still-to-buy + already-checked) — visible
 * to everyone. `bought` flags checked-off items.
 */
function rpcGetShoppingList(token) {
  _session(token);
  const names = _staffNameMap();
  return ShoppingList.getActive().map(e => ({
    entryId: e.entryId,
    itemId: e.itemId,
    itemName: e.itemName,
    category: e.category,
    quantity: e.quantity,
    unit: e.unit,
    unitPrice: e.unitPrice,
    note: e.note,
    bought: e.status === 'bought',
    addedBy: e.addedBy,
    addedByName: names[e.addedBy] || e.addedBy,
    addedAt: e.addedAt ? e.addedAt.toISOString() : null,
  }));
}

/**
 * Check / uncheck an item (mark bought or back to to-buy). Any user.
 */
function rpcSetShoppingItemBought(token, entryId, bought) {
  const session = _session(token);
  const entry = ShoppingList.setBought(entryId, bought === true, session.staffId);
  return { entryId: entry.entryId, bought: entry.status === 'bought' };
}

/**
 * Clear the whole list (start fresh). Manager / payroll_admin / admin.
 */
function rpcClearShoppingList(token) {
  const session = _session(token);
  Auth.require(session, ['manager', 'admin', 'payroll_admin']);
  return ShoppingList.clearAll(session.staffId);
}

/**
 * Add an item to the pending list. Any authenticated user.
 */
function rpcAddToShoppingList(token, input) {
  const session = _session(token);
  const entry = ShoppingList.add({
    itemId: input.itemId || '',
    itemName: input.itemName,
    category: input.category,
    quantity: Number(input.quantity),
    unit: input.unit || '',
    unitPrice: input.unitPrice !== undefined ? Number(input.unitPrice) : undefined,
    note: input.note || '',
    newItem: input.newItem === true,
    parLevel: Number(input.parLevel) || 0,
    suggestedSupplier: input.suggestedSupplier || '',
    addedBy: session.staffId,
  });
  return {
    entryId: entry.entryId, itemName: entry.itemName,
    category: entry.category, quantity: entry.quantity, unit: entry.unit,
  };
}

/**
 * Remove a pending entry. The person who added it, or a manager/
 * payroll_admin/admin.
 */
function rpcRemoveShoppingListEntry(token, entryId) {
  const session = _session(token);
  const entry = ShoppingList.getById(entryId);
  if (!entry) throw new Error('Entry not found: ' + entryId);
  const privileged = ['manager', 'admin', 'payroll_admin'].indexOf(session.role) !== -1;
  if (entry.addedBy !== session.staffId && !privileged) {
    throw new Error('FORBIDDEN: only the person who added this, or a manager/admin, can remove it');
  }
  return ShoppingList.removeEntry(entryId, session.staffId);
}

/**
 * Edit an active entry's name / quantity / note. The person who added it, or
 * a manager/payroll_admin/admin (mirrors remove).
 */
function rpcEditShoppingListEntry(token, entryId, patch) {
  const session = _session(token);
  const entry = ShoppingList.getById(entryId);
  if (!entry) throw new Error('Entry not found: ' + entryId);
  const privileged = ['manager', 'admin', 'payroll_admin'].indexOf(session.role) !== -1;
  if (entry.addedBy !== session.staffId && !privileged) {
    throw new Error('FORBIDDEN: only the person who added this, or a manager/admin, can edit it');
  }
  patch = patch || {};
  return ShoppingList.edit({
    entryId: entryId,
    itemName: patch.itemName,
    quantity: patch.quantity !== undefined ? Number(patch.quantity) : undefined,
    note: patch.note,
    actorId: session.staffId,
  });
}

/**
 * Generate the shopping list: format + clear pending + WhatsApp.
 * Manager / payroll_admin / admin only.
 */
function rpcGenerateShoppingList(token) {
  const session = _session(token);
  Auth.require(session, ['manager', 'admin', 'payroll_admin']);
  return ShoppingList.generate(session.staffId);
}
