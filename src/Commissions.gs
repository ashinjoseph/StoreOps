// ============================================================
//  Commissions.gs — weekly commission engine + Monday trigger
// ============================================================
//  The engine:
//    1. Determines the target week (default = previous Monday → Sunday)
//    2. For each active commission_rule:
//        - Resolve which staff it covers (one or all)
//        - For each (staff, company) pair: sum sales for the window
//        - If sales > threshold: propose a bonus
//    3. Write a commission_runs row summarizing
//
//  Idempotency: refuses to run for the same week_start unless force=true.
//  This prevents accidental duplicate runs from creating duplicate bonuses.
//
//  Trigger lifecycle:
//    installWeeklyTrigger() — creates a Monday-morning trigger
//    removeWeeklyTrigger()  — removes it
//    triggerHandler_()      — fires; calls runForPreviousWeek()
//
//  The trigger is NOT auto-installed during setup. Admin installs it
//  via menu when ready to go live.
// ============================================================

const Commissions = (() => {

  const RUN_COL = {
    run_id: 1, week_start: 2, week_end: 3, staff_count: 4,
    bonuses_created: 5, total_commission_amount: 6,
    computed_at: 7, computed_by: 8, notes: 9
  };
  const RUN_NUM_COLS = 9;
  const RUN_DATA_START = 3;

  function runsSheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.COMMISSION_RUNS);
    if (!sh) throw new Error('commission_runs sheet not found — run First-time Setup');
    return sh;
  }

  function runRowToRecord_(row, rowIndex) {
    return {
      runId:                 (row[RUN_COL.run_id - 1] || '').toString().trim(),
      weekStart:             row[RUN_COL.week_start - 1] instanceof Date ? row[RUN_COL.week_start - 1] : null,
      weekEnd:               row[RUN_COL.week_end - 1] instanceof Date ? row[RUN_COL.week_end - 1] : null,
      staffCount:            Number(row[RUN_COL.staff_count - 1]) || 0,
      bonusesCreated:        Number(row[RUN_COL.bonuses_created - 1]) || 0,
      totalCommissionAmount: Number(row[RUN_COL.total_commission_amount - 1]) || 0,
      computedAt:            row[RUN_COL.computed_at - 1] instanceof Date ? row[RUN_COL.computed_at - 1] : null,
      computedBy:            (row[RUN_COL.computed_by - 1] || '').toString(),
      notes:                 (row[RUN_COL.notes - 1] || '').toString(),
      _rowIndex:             rowIndex,
    };
  }

  function getAllRuns_() {
    const sh = runsSheet_();
    const last = sh.getLastRow();
    if (last < RUN_DATA_START) return [];
    const data = sh.getRange(RUN_DATA_START, 1, last - RUN_DATA_START + 1, RUN_NUM_COLS).getValues();
    return data
      .map((row, i) => runRowToRecord_(row, i + RUN_DATA_START))
      .filter(r => r.runId && !r.runId.startsWith('CRN_PLACEHOLDER'));
  }

  function findRunForWeek_(weekStart) {
    const ws = Util.formatDate(weekStart);
    return getAllRuns_().find(r =>
      r.weekStart && Util.formatDate(r.weekStart) === ws
    ) || null;
  }

  // ── Core engine ────────────────────────────────────────

  /**
   * Run the commission engine for one week window.
   *
   * @param input {
   *   weekStart:  Date — Monday 00:00 of the target week (required)
   *   weekEnd:    Date — Sunday 23:59 of the target week (required)
   *   force:      boolean — if true, runs even if a run already exists
   *                          for this week (and creates duplicate bonuses!)
   *   actorId:    string — who triggered (SYSTEM_TRIGGER if from cron)
   * }
   *
   * @returns {
   *   runId, weekStart, weekEnd,
   *   bonusesProposed: [{ bonusId, staffId, company, ruleId, sales,
   *                       threshold, percentage, amount }],
   *   totalAmount, staffCount,
   *   skipped: boolean — true if duplicate run was skipped
   * }
   */
  function runForWeek_(input) {
    if (!input || !input.weekStart || !input.weekEnd) {
      throw new Error('weekStart and weekEnd required');
    }
    const weekStart = input.weekStart instanceof Date ? input.weekStart : Util.parseDate(input.weekStart);
    const weekEnd = input.weekEnd instanceof Date ? input.weekEnd : Util.parseDate(input.weekEnd);
    const actorId = input.actorId || 'SYSTEM_TRIGGER';
    const force = input.force === true;

    // Idempotency check
    const existingRun = findRunForWeek_(weekStart);
    if (existingRun && !force) {
      return {
        skipped: true,
        existingRunId: existingRun.runId,
        weekStart,
        weekEnd,
        reason: 'Run already exists for this week (' + existingRun.runId + '). Pass force=true to re-run.',
      };
    }

    // Get sales aggregated by (staffId, company) for the window
    const salesAgg = Sales.aggregateByStaffCompany(weekStart, weekEnd);
    // Index for fast lookup: 'staffId|company' → totals
    const salesMap = {};
    salesAgg.forEach(s => {
      salesMap[s.staffId + '|' + s.company] = s;
    });

    // Get applicable rules (active during this week)
    const rules = CommissionRules.getActiveOn(weekStart);
    if (rules.length === 0) {
      // No rules: still write a run row so we have history
      const runId = Util.newId('CRN');
      writeRunWithId_(runId, {
        weekStart, weekEnd, staffCount: 0, bonusesCreated: 0,
        totalAmount: 0, computedBy: actorId,
        notes: 'No active rules for this week',
      });
      return {
        runId, weekStart, weekEnd,
        bonusesProposed: [],
        totalAmount: 0, staffCount: 0,
        skipped: false,
      };
    }

    // Pre-allocate the run ID so we can attach it to proposed bonuses
    const runId = Util.newId('CRN');

    const allStaff = Staff.getActive();
    const bonusesProposed = [];
    const staffWithCommission = new Set();
    let totalAmount = 0;

    rules.forEach(rule => {
      // Determine which staff this rule covers
      const targetStaff = rule.appliesTo === 'all_staff'
        ? allStaff
        : allStaff.filter(s => s.staffId === rule.staffId);

      targetStaff.forEach(staff => {
        const key = staff.staffId + '|' + rule.company;
        const sales = salesMap[key];
        if (!sales || sales.total <= rule.threshold + 0.005) {
          return;  // no sales, or below threshold
        }

        // Skip if a commission already exists for this (staff, company, week)
        // — prevents two rules from creating duplicates if admin layered them
        if (Bonuses.existsCommissionFor(staff.staffId, rule.company, weekStart, weekEnd)) {
          return;
        }

        const excess = Util.roundMoney(sales.total - rule.threshold);
        const commission = Util.roundMoney(excess * rule.percentage / 100);
        if (commission <= 0.005) return;

        const reason = 'Weekly commission: ' + rule.company + ' sales of ' +
                       Util.formatMoney(sales.total) + ' over ' +
                       Util.formatMoney(rule.threshold) + ' threshold @ ' +
                       rule.percentage + '%';

        const bonusRec = Bonuses.propose({
          staffId: staff.staffId,
          amount: commission,
          reason,
          company: rule.company,
          periodStart: weekStart,
          periodEnd: weekEnd,
          sourceRunId: runId,
          actorId,
        });

        bonusesProposed.push({
          bonusId: bonusRec.bonusId,
          staffId: staff.staffId,
          staffName: staff.name,
          company: rule.company,
          ruleId: rule.ruleId,
          sales: sales.total,
          threshold: rule.threshold,
          percentage: rule.percentage,
          amount: commission,
        });
        staffWithCommission.add(staff.staffId);
        totalAmount = Util.roundMoney(totalAmount + commission);
      });
    });

    // Now write the commission_runs row with computed totals
    writeRunWithId_(runId, {
      weekStart, weekEnd,
      staffCount: staffWithCommission.size,
      bonusesCreated: bonusesProposed.length,
      totalAmount,
      computedBy: actorId,
      notes: force && existingRun
        ? 'Forced re-run (previous: ' + existingRun.runId + ')'
        : '',
    });

    AuditLog.write({
      actorId,
      action: 'commission.run',
      targetType: 'commission_runs',
      targetId: runId,
      after: {
        weekStart: Util.formatDate(weekStart),
        weekEnd: Util.formatDate(weekEnd),
        bonusesCreated: bonusesProposed.length,
        totalAmount,
        staffCount: staffWithCommission.size,
      },
    });

    Notifier.notify('commission.computed', {
      bonusesCreated: bonusesProposed.length,
      totalAmount,
      weekStart: Util.formatDate(weekStart),
      weekEnd: Util.formatDate(weekEnd),
    });

    return {
      runId, weekStart, weekEnd,
      bonusesProposed,
      totalAmount,
      staffCount: staffWithCommission.size,
      skipped: false,
    };
  }

  function writeRunWithId_(runId, input) {
    const sh = runsSheet_();
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, RUN_NUM_COLS).setValues([[
      runId,
      input.weekStart,
      input.weekEnd,
      input.staffCount || 0,
      input.bonusesCreated || 0,
      Util.roundMoney(input.totalAmount || 0),
      new Date(),
      input.computedBy || 'SYSTEM_TRIGGER',
      input.notes || '',
    ]]);
    return runId;
  }

  /**
   * Convenience: run for the previous calendar week.
   */
  function runForPreviousWeek_(actorId, force) {
    const range = Util.getPreviousWeekRange(new Date());
    return runForWeek_({
      weekStart: range.start,
      weekEnd: range.end,
      actorId: actorId || 'SYSTEM_TRIGGER',
      force: force === true,
    });
  }

  // ── Time-driven trigger management ──────────────────────

  const TRIGGER_HANDLER = 'commissionsTriggerHandler';

  /**
   * Install a weekly time-driven trigger that fires every Monday at
   * the hour specified in config.commission_run_hour (default 9).
   *
   * Idempotent: removes existing trigger first.
   */
  function installWeeklyTrigger_() {
    removeWeeklyTrigger_();

    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CONFIG);
    let runHour = 9;
    if (sh) {
      const data = sh.getRange(3, 1, sh.getLastRow() - 2, 2).getValues();
      const row = data.find(r => r[0] === 'commission_run_hour');
      if (row && row[1] !== '') runHour = Number(row[1]) || 9;
    }

    ScriptApp.newTrigger(TRIGGER_HANDLER)
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay.MONDAY)
      .atHour(runHour)
      .create();

    AuditLog.write({
      actorId: 'SYSTEM',
      action: 'commission.trigger_installed',
      targetType: 'trigger',
      targetId: TRIGGER_HANDLER,
      details: 'Monday at ' + runHour + ':00',
    });

    return { installed: true, dayOfWeek: 'MONDAY', hour: runHour };
  }

  function removeWeeklyTrigger_() {
    const triggers = ScriptApp.getProjectTriggers()
      .filter(t => t.getHandlerFunction() === TRIGGER_HANDLER);
    triggers.forEach(t => ScriptApp.deleteTrigger(t));
    if (triggers.length > 0) {
      AuditLog.write({
        actorId: 'SYSTEM',
        action: 'commission.trigger_removed',
        targetType: 'trigger',
        targetId: TRIGGER_HANDLER,
        details: 'Removed ' + triggers.length + ' trigger(s)',
      });
    }
    return { removed: triggers.length };
  }

  function isTriggerInstalled_() {
    return ScriptApp.getProjectTriggers()
      .some(t => t.getHandlerFunction() === TRIGGER_HANDLER);
  }

  return {
    runForWeek:           runForWeek_,
    runForPreviousWeek:   runForPreviousWeek_,
    getAllRuns:           getAllRuns_,
    findRunForWeek:       findRunForWeek_,
    installWeeklyTrigger: installWeeklyTrigger_,
    removeWeeklyTrigger:  removeWeeklyTrigger_,
    isTriggerInstalled:   isTriggerInstalled_,
  };
})();

// ============================================================
//  Top-level trigger handler — must be a top-level function
//  (Apps Script can't trigger module IIFE methods directly)
// ============================================================
function commissionsTriggerHandler() {
  try {
    Commissions.runForPreviousWeek('SYSTEM_TRIGGER', false);
  } catch (e) {
    console.error('commissionsTriggerHandler failed: ' + e.message);
    AuditLog.write({
      actorId: 'SYSTEM',
      action: 'commission.trigger_error',
      targetType: 'trigger',
      targetId: 'commissionsTriggerHandler',
      details: e.message,
    });
  }
}
