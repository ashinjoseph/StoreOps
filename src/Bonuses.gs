// ============================================================
//  Bonuses.gs — bonuses, commissions, adjustments
// ============================================================
//  Lifecycle:
//    proposed   — created by commission engine; awaiting admin approval
//    pending    — approved or admin-added; payable via Payments.payBonus
//    paid       — fully paid via payment_items
//    cancelled  — never to be paid
//
//  A bonus is "fully paid" when sum of payment_items.amount where
//  item_type='bonus' AND ref_id=bonusId equals bonus.amount.
//  Partial bonus payments are supported — status stays 'pending' until
//  fully paid, at which point it flips to 'paid' via Payments.payBonus.
// ============================================================

const Bonuses = (() => {

  const COL = {
    bonus_id: 1, staff_id: 2, date: 3, type: 4, amount: 5, reason: 6,
    status: 7, period_start: 8, period_end: 9, company: 10, source_run_id: 11,
    created_by: 12, created_at: 13, notes: 14
  };
  const NUM_COLS = 14;
  const DATA_START_ROW = 3;

  function sheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.BONUSES);
    if (!sh) throw new Error('bonuses sheet not found — run First-time Setup');
    return sh;
  }

  function rowToRecord_(row, rowIndex) {
    return {
      bonusId:      (row[COL.bonus_id - 1] || '').toString().trim(),
      staffId:      (row[COL.staff_id - 1] || '').toString().trim(),
      date:         row[COL.date - 1] instanceof Date ? row[COL.date - 1] : null,
      type:         (row[COL.type - 1] || '').toString().trim(),
      amount:       Number(row[COL.amount - 1]) || 0,
      reason:       (row[COL.reason - 1] || '').toString(),
      status:       (row[COL.status - 1] || '').toString().trim(),
      periodStart:  row[COL.period_start - 1] instanceof Date ? row[COL.period_start - 1] : null,
      periodEnd:    row[COL.period_end - 1] instanceof Date ? row[COL.period_end - 1] : null,
      company:      (row[COL.company - 1] || '').toString().trim(),
      sourceRunId:  (row[COL.source_run_id - 1] || '').toString().trim(),
      createdBy:    (row[COL.created_by - 1] || '').toString().trim(),
      createdAt:    row[COL.created_at - 1] instanceof Date ? row[COL.created_at - 1] : null,
      notes:        (row[COL.notes - 1] || '').toString(),
      _rowIndex:    rowIndex,
    };
  }

  function getAll_() {
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last < DATA_START_ROW) return [];
    const data = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS).getValues();
    return data
      .map((row, i) => rowToRecord_(row, i + DATA_START_ROW))
      .filter(b => b.bonusId);
  }

  function getById_(bonusId) {
    return getAll_().find(b => b.bonusId === bonusId) || null;
  }

  function getForStaff_(staffId, statusFilter) {
    return getAll_()
      .filter(b => b.staffId === staffId &&
                   (!statusFilter || b.status === statusFilter))
      .sort((a, b) => (b.date || 0) - (a.date || 0));
  }

  function getProposed_() {
    return getAll_()
      .filter(b => b.status === 'proposed')
      .sort((a, b) => (a.date || 0) - (b.date || 0));
  }

  /**
   * Idempotency for commission runs: has a commission bonus already been
   * created for (staffId, company, periodStart, periodEnd)?
   */
  function existsCommissionFor_(staffId, company, periodStart, periodEnd) {
    if (!(periodStart instanceof Date) || !(periodEnd instanceof Date)) return false;
    const ps = Util.formatDate(periodStart);
    const pe = Util.formatDate(periodEnd);
    return getAll_().some(b =>
      b.type === 'commission' &&
      b.staffId === staffId &&
      b.company === company &&
      b.status !== 'cancelled' &&
      b.periodStart && b.periodEnd &&
      Util.formatDate(b.periodStart) === ps &&
      Util.formatDate(b.periodEnd) === pe
    );
  }

  // ── Create ──────────────────────────────────────────────
  /**
   * Admin manually adds a bonus (or deduction/tip/adjustment).
   * Starts as 'pending' — payable through Payments.payBonus.
   *
   * @param input { staffId, type, amount, reason, date?, notes?, actorId }
   */
  function create_(input) {
    if (!input.staffId) throw new Error('staffId required');
    if (!input.type) throw new Error('type required');
    if (BONUS_TYPES.indexOf(input.type) === -1) {
      throw new Error('Invalid type: ' + input.type + '. Must be one of: ' + BONUS_TYPES.join(', '));
    }
    if (typeof input.amount !== 'number') throw new Error('amount must be a number');
    if (input.amount === 0) throw new Error('amount cannot be zero');
    if (!input.reason) throw new Error('reason required');
    if (!input.actorId) throw new Error('actorId required');

    const staff = Staff.getById(input.staffId);
    if (!staff) throw new Error('Staff not found: ' + input.staffId);

    return writeRow_({
      staffId: input.staffId,
      type: input.type,
      amount: Util.roundMoney(input.amount),
      reason: input.reason,
      date: input.date instanceof Date ? input.date : new Date(),
      status: 'pending',
      periodStart: null,
      periodEnd: null,
      company: input.company || '',
      sourceRunId: '',
      notes: input.notes || '',
      actorId: input.actorId,
      auditAction: 'bonus.created',
    });
  }

  /**
   * Commission engine creates this. Starts as 'proposed' — admin must
   * approve before it's payable.
   *
   * @param input {
   *     staffId, amount, reason, periodStart, periodEnd, company,
   *     sourceRunId, actorId
   *   }
   */
  function propose_(input) {
    if (!input.staffId) throw new Error('staffId required');
    if (typeof input.amount !== 'number' || input.amount <= 0) {
      throw new Error('amount must be a positive number');
    }
    if (!input.reason) throw new Error('reason required');
    if (!(input.periodStart instanceof Date)) throw new Error('periodStart Date required');
    if (!(input.periodEnd instanceof Date)) throw new Error('periodEnd Date required');
    if (!input.company || COMPANIES.indexOf(input.company) === -1) {
      throw new Error('Invalid company: ' + input.company);
    }
    if (!input.actorId) throw new Error('actorId required');

    return writeRow_({
      staffId: input.staffId,
      type: 'commission',
      amount: Util.roundMoney(input.amount),
      reason: input.reason,
      date: new Date(),
      status: 'proposed',
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      company: input.company,
      sourceRunId: input.sourceRunId || '',
      notes: '',
      actorId: input.actorId,
      auditAction: 'bonus.proposed',
    });
  }

  function writeRow_(rec) {
    const bonusId = Util.newId('B');
    const sh = sheet_();
    const row = sh.getLastRow() + 1;
    const now = new Date();
    sh.getRange(row, 1, 1, NUM_COLS).setValues([[
      bonusId,
      rec.staffId,
      rec.date,
      rec.type,
      rec.amount,
      rec.reason,
      rec.status,
      rec.periodStart || '',
      rec.periodEnd || '',
      rec.company,
      rec.sourceRunId,
      rec.actorId,
      now,
      rec.notes,
    ]]);

    AuditLog.write({
      actorId: rec.actorId,
      action: rec.auditAction,
      targetType: 'bonuses',
      targetId: bonusId,
      after: {
        staffId: rec.staffId,
        type: rec.type,
        amount: rec.amount,
        status: rec.status,
        reason: rec.reason.substring(0, 100),
      },
    });

    return getById_(bonusId);
  }

  // ── Status transitions ──────────────────────────────────
  /**
   * Admin approves a proposed bonus → flips to pending.
   * Returns the updated record.
   */
  function approve_(bonusId, actorId) {
    if (!bonusId) throw new Error('bonusId required');
    if (!actorId) throw new Error('actorId required');

    const bonus = getById_(bonusId);
    if (!bonus) throw new Error('Bonus not found: ' + bonusId);
    if (bonus.status !== 'proposed') {
      throw new Error('Can only approve proposed bonuses (current: ' + bonus.status + ')');
    }

    const sh = sheet_();
    sh.getRange(bonus._rowIndex, COL.status).setValue('pending');

    AuditLog.write({
      actorId,
      action: 'bonus.approved',
      targetType: 'bonuses',
      targetId: bonusId,
      before: { status: 'proposed' },
      after: { status: 'pending' },
    });

    return getById_(bonusId);
  }

  /**
   * Cancel a bonus. Works from any status except 'paid'.
   */
  function cancel_(bonusId, actorId, reason) {
    if (!bonusId) throw new Error('bonusId required');
    if (!actorId) throw new Error('actorId required');

    const bonus = getById_(bonusId);
    if (!bonus) throw new Error('Bonus not found: ' + bonusId);
    if (bonus.status === 'paid') {
      throw new Error('Cannot cancel a paid bonus — undo the payment first');
    }
    if (bonus.status === 'cancelled') return bonus;

    const sh = sheet_();
    sh.getRange(bonus._rowIndex, COL.status).setValue('cancelled');
    if (reason) {
      const newNotes = bonus.notes + (bonus.notes ? ' | ' : '') + 'Cancelled: ' + reason;
      sh.getRange(bonus._rowIndex, COL.notes).setValue(newNotes);
    }

    AuditLog.write({
      actorId,
      action: 'bonus.cancelled',
      targetType: 'bonuses',
      targetId: bonusId,
      before: { status: bonus.status },
      after: { status: 'cancelled', reason: reason || '' },
    });

    return getById_(bonusId);
  }

  /**
   * Called by Payments.payBonus when this bonus is fully paid.
   * Flips status from 'pending' → 'paid'.
   */
  function markPaid_(bonusId, actorId) {
    const bonus = getById_(bonusId);
    if (!bonus) throw new Error('Bonus not found: ' + bonusId);
    if (bonus.status !== 'pending') {
      throw new Error('Can only pay pending bonuses (current: ' + bonus.status + ')');
    }
    const sh = sheet_();
    sh.getRange(bonus._rowIndex, COL.status).setValue('paid');

    AuditLog.write({
      actorId: actorId || 'SYSTEM',
      action: 'bonus.paid',
      targetType: 'bonuses',
      targetId: bonusId,
      before: { status: 'pending' },
      after: { status: 'paid' },
    });

    return getById_(bonusId);
  }

  /**
   * Called by Payments.undo when a payment that included this bonus is
   * reversed. Flips 'paid' → 'pending'.
   */
  function revertToPending_(bonusId, actorId) {
    const bonus = getById_(bonusId);
    if (!bonus) return null;  // bonus deleted, that's OK
    if (bonus.status !== 'paid') return bonus;  // not paid, nothing to revert

    const sh = sheet_();
    sh.getRange(bonus._rowIndex, COL.status).setValue('pending');

    AuditLog.write({
      actorId: actorId || 'SYSTEM',
      action: 'bonus.reverted',
      targetType: 'bonuses',
      targetId: bonusId,
      before: { status: 'paid' },
      after: { status: 'pending' },
      details: 'Reverted due to payment undo',
    });

    return getById_(bonusId);
  }

  return {
    create:                 create_,
    propose:                propose_,
    approve:                approve_,
    cancel:                 cancel_,
    markPaid:               markPaid_,
    revertToPending:        revertToPending_,
    getById:                getById_,
    getForStaff:            getForStaff_,
    getProposed:            getProposed_,
    getAll:                 getAll_,
    existsCommissionFor:    existsCommissionFor_,
  };
})();
