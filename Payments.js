// ============================================================
//  Payments.gs — payment recording, two distinct flows
// ============================================================
//  Two separate operations admins can perform:
//
//  1) payShifts — record a payment toward unpaid attendance.
//     Walks attendance OLDEST FIRST, fills each fully before moving on.
//     Partial allocation supported on the last shift. Overpayment
//     rejected with a clear error stating the actual amount owed.
//     Bonuses are NOT included — they have their own flow.
//
//  2) payBonus — pay one specific bonus. Can be partial. If amount
//     equals the bonus remaining, status flips proposed/pending → paid.
//     Overpayment rejected.
//
//  Both produce one payments row + one or more payment_items rows.
//
//  Undo:
//     undo(paymentId)        — removes a specific payment + its items
//     undoLastForStaff(...)  — convenience: undo most recent for staff
// ============================================================

const Payments = (() => {

  // payments sheet schema
  const P_COL = {
    payment_id: 1, staff_id: 2, paid_on: 3, total_amount: 4,
    method: 5, recorded_by: 6, notes: 7
  };
  const P_NUM_COLS = 7;
  const P_DATA_START = 3;

  // payment_items sheet schema
  const I_COL = {
    item_id: 1, payment_id: 2, item_type: 3, ref_id: 4, amount: 5, notes: 6
  };
  const I_NUM_COLS = 6;
  const I_DATA_START = 3;

  let _paymentsCache = null;
  let _itemsCache = null;

  function bustCaches_() {
    _paymentsCache = null;
    _itemsCache = null;
  }

  function paymentsSheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PAYMENTS);
    if (!sh) throw new Error('payments sheet not found — run First-time Setup');
    return sh;
  }
  function itemsSheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.PAYMENT_ITEMS);
    if (!sh) throw new Error('payment_items sheet not found — run First-time Setup');
    return sh;
  }

  // ── Row decoders ────────────────────────────────────────
  function pRowToRecord_(row, rowIndex) {
    return {
      paymentId:   (row[P_COL.payment_id - 1] || '').toString().trim(),
      staffId:     (row[P_COL.staff_id - 1] || '').toString().trim(),
      paidOn:      row[P_COL.paid_on - 1] instanceof Date ? row[P_COL.paid_on - 1] : null,
      totalAmount: Number(row[P_COL.total_amount - 1]) || 0,
      method:      (row[P_COL.method - 1] || '').toString(),
      recordedBy:  (row[P_COL.recorded_by - 1] || '').toString(),
      notes:       (row[P_COL.notes - 1] || '').toString(),
      _rowIndex:   rowIndex,
    };
  }

  function iRowToRecord_(row, rowIndex) {
    return {
      itemId:    (row[I_COL.item_id - 1] || '').toString().trim(),
      paymentId: (row[I_COL.payment_id - 1] || '').toString().trim(),
      itemType:  (row[I_COL.item_type - 1] || '').toString().trim(),
      refId:     (row[I_COL.ref_id - 1] || '').toString().trim(),
      amount:    Number(row[I_COL.amount - 1]) || 0,
      notes:     (row[I_COL.notes - 1] || '').toString(),
      _rowIndex: rowIndex,
    };
  }

  function getAllPayments_() {
    if (_paymentsCache) return _paymentsCache;
    const sh = paymentsSheet_();
    const last = sh.getLastRow();
    _paymentsCache = last < P_DATA_START ? [] :
      sh.getRange(P_DATA_START, 1, last - P_DATA_START + 1, P_NUM_COLS)
        .getValues()
        .map((row, i) => pRowToRecord_(row, i + P_DATA_START))
        .filter(r => r.paymentId && !r.paymentId.startsWith('P_PLACEHOLDER'));
    return _paymentsCache;
  }

  function getAllItems_() {
    if (_itemsCache) return _itemsCache;
    const sh = itemsSheet_();
    const last = sh.getLastRow();
    _itemsCache = last < I_DATA_START ? [] :
      sh.getRange(I_DATA_START, 1, last - I_DATA_START + 1, I_NUM_COLS)
        .getValues()
        .map((row, i) => iRowToRecord_(row, i + I_DATA_START))
        .filter(r => r.itemId && !r.itemId.startsWith('IT_PLACEHOLDER'));
    return _itemsCache;
  }

  function getPaymentById_(paymentId) {
    return getAllPayments_().find(p => p.paymentId === paymentId) || null;
  }

  function getItemsForPayment_(paymentId) {
    return getAllItems_().filter(i => i.paymentId === paymentId);
  }

  function getPaymentsForStaff_(staffId) {
    return getAllPayments_()
      .filter(p => p.staffId === staffId)
      .sort((a, b) => (b.paidOn || 0) - (a.paidOn || 0));
  }

  /**
   * Recent payments across all staff, newest first. For history UI.
   */
  function getRecent_(limit) {
    limit = limit || 50;
    return getAllPayments_()
      .sort((a, b) => (b.paidOn || 0) - (a.paidOn || 0))
      .slice(0, limit);
  }

  /**
   * For the given attendance IDs, return { attendanceId → totalPaid }.
   * Called by Attendance.getUnpaidForStaff and getOwedSummary.
   */
  function getAttendancePaidAmounts_(attendanceIds) {
    if (!attendanceIds || attendanceIds.length === 0) return {};
    const wanted = new Set(attendanceIds);
    const items = getAllItems_().filter(i =>
      i.itemType === 'shift' && wanted.has(i.refId)
    );
    const map = {};
    items.forEach(i => {
      map[i.refId] = Util.roundMoney((map[i.refId] || 0) + i.amount);
    });
    return map;
  }

  /**
   * For the given bonus IDs, return { bonusId → totalPaid }.
   */
  function getBonusPaidAmounts_(bonusIds) {
    if (!bonusIds || bonusIds.length === 0) return {};
    const wanted = new Set(bonusIds);
    const items = getAllItems_().filter(i =>
      i.itemType === 'bonus' && wanted.has(i.refId)
    );
    const map = {};
    items.forEach(i => {
      map[i.refId] = Util.roundMoney((map[i.refId] || 0) + i.amount);
    });
    return map;
  }

  // ── Owed summary ────────────────────────────────────────

  /**
   * Compute what's owed to a staff member:
   *   - Unpaid attendance (shifts) with chronological breakdown
   *   - Pending bonuses (each tracked separately)
   *
   * @returns {
   *   staffId,
   *   shiftsOwed,         // sum of remaining for unpaid attendance
   *   bonusesOwed,        // sum of remaining for pending bonuses
   *   totalOwed,          // shifts + bonuses
   *   unpaidShifts: [     // oldest first
   *     { attendanceId, date, dateStr, hoursWorked, rate, value, paid, remaining }
   *   ],
   *   pendingBonuses: [
   *     { bonusId, type, date, dateStr, amount, paid, remaining, reason, company }
   *   ]
   * }
   */
  function getOwedSummary_(staffId) {
    if (!staffId) throw new Error('staffId required');

    const allAttendance = Attendance.getUnpaidForStaff(staffId);
    const paidMap = getAttendancePaidAmounts_(allAttendance.map(a => a.attendanceId));

    const unpaidShifts = [];
    let shiftsOwed = 0;
    allAttendance.forEach(a => {
      const value = Util.roundMoney(a.hoursWorked * a.rateAtAttendance);
      const paid = paidMap[a.attendanceId] || 0;
      const remaining = Util.roundMoney(value - paid);
      if (remaining > 0.005) {
        unpaidShifts.push({
          attendanceId: a.attendanceId,
          date: a.date ? a.date.toISOString() : null,
          dateStr: a.date ? Util.formatDate(a.date) : '',
          hoursWorked: a.hoursWorked,
          rate: a.rateAtAttendance,
          value: value,
          paid: paid,
          remaining: remaining,
        });
        shiftsOwed = Util.roundMoney(shiftsOwed + remaining);
      }
    });

    const allBonuses = Bonuses.getForStaff(staffId);
    const bonusPaidMap = getBonusPaidAmounts_(allBonuses.map(b => b.bonusId));
    const pendingBonuses = allBonuses
      .filter(b => b.status === 'pending')
      .map(b => {
        const paid = bonusPaidMap[b.bonusId] || 0;
        const remaining = Util.roundMoney(b.amount - paid);
        return {
          bonusId: b.bonusId,
          type: b.type,
          amount: b.amount,
          paid: paid,
          remaining: remaining,
          date: b.date ? b.date.toISOString() : null,
          dateStr: b.date ? Util.formatDate(b.date) : '',
          reason: b.reason,
          company: b.company,
        };
      })
      .filter(b => b.remaining > 0.005);

    const bonusesOwed = Util.roundMoney(
      pendingBonuses.reduce((s, b) => s + b.remaining, 0)
    );

    return {
      staffId,
      shiftsOwed,
      bonusesOwed,
      totalOwed: Util.roundMoney(shiftsOwed + bonusesOwed),
      unpaidShifts,
      pendingBonuses,
    };
  }

  // ── payShifts ──────────────────────────────────────────

  /**
   * Pay `amount` against unpaid attendance, oldest first.
   * Bonuses are NOT touched by this flow.
   *
   * @param input {
   *   staffId, amount, paidOn?, method?, notes?, actorId
   * }
   *
   * Returns: {
   *   paymentId, totalAmount, kind: 'shifts',
   *   itemsCreated: [{ itemId, attendanceId, dateStr, amount, isPartial }],
   *   summary: { shiftsOwedBefore, shiftsOwedAfter, fullyPaidCount, partialCount }
   * }
   *
   * Throws on overpayment (amount > shiftsOwed) with a message that
   * states how much is actually owed.
   */
  function payShifts_(input) {
    if (!input.staffId) throw new Error('staffId required');
    if (typeof input.amount !== 'number' || input.amount <= 0) {
      throw new Error('amount must be a positive number');
    }
    if (!input.actorId) throw new Error('actorId required');

    const staff = Staff.getById(input.staffId);
    if (!staff) throw new Error('Staff not found: ' + input.staffId);

    const amount = Util.roundMoney(input.amount);
    const owed = getOwedSummary_(input.staffId);

    if (owed.shiftsOwed <= 0.005) {
      throw new Error(
        'No unpaid shifts for ' + staff.name + '. Nothing to pay.'
      );
    }
    if (amount > owed.shiftsOwed + 0.005) {
      throw new Error(
        'Overpayment rejected: trying to pay ' + Util.formatMoney(amount) +
        ' but only ' + Util.formatMoney(owed.shiftsOwed) +
        ' owed in unpaid shifts for ' + staff.name + '. ' +
        (owed.bonusesOwed > 0
          ? 'To pay a bonus (' + Util.formatMoney(owed.bonusesOwed) + ' pending), use the bonus flow.'
          : '')
      );
    }

    const paidOn = input.paidOn instanceof Date ? input.paidOn : new Date();
    const method = input.method || 'cash';
    if (PAYMENT_METHODS.indexOf(method) === -1) {
      throw new Error('Invalid payment method: ' + method);
    }

    // Create payment header
    const paymentId = Util.newId('P');
    const pSh = paymentsSheet_();
    const pRow = pSh.getLastRow() + 1;
    pSh.getRange(pRow, 1, 1, P_NUM_COLS).setValues([[
      paymentId, input.staffId, paidOn, amount, method, input.actorId, input.notes || ''
    ]]);

    // Walk unpaid shifts and create payment_items
    const iSh = itemsSheet_();
    const itemsCreated = [];
    let remaining = amount;

    for (const s of owed.unpaidShifts) {
      if (remaining <= 0.005) break;
      const toApply = Util.roundMoney(Math.min(s.remaining, remaining));
      const isPartial = toApply < s.remaining - 0.005;
      const itemId = Util.newId('IT');
      const itemNote = isPartial
        ? 'Partial — ' + Util.formatMoney(toApply) + ' of ' + Util.formatMoney(s.remaining)
        : '';
      iSh.getRange(iSh.getLastRow() + 1, 1, 1, I_NUM_COLS).setValues([[
        itemId, paymentId, 'shift', s.attendanceId, toApply, itemNote
      ]]);
      itemsCreated.push({
        itemId,
        attendanceId: s.attendanceId,
        dateStr: s.dateStr,
        amount: toApply,
        isPartial,
      });
      remaining = Util.roundMoney(remaining - toApply);
    }

    if (remaining > 0.005) {
      // Should be impossible given the overpayment guard, but make noise if so.
      AuditLog.write({
        actorId: input.actorId,
        action: 'payment.allocation_error',
        targetType: 'payments',
        targetId: paymentId,
        details: 'Unallocated ' + Util.formatMoney(remaining) + ' after walking shifts — INVESTIGATE'
      });
    }

    AuditLog.write({
      actorId: input.actorId,
      action: 'payment.shifts',
      targetType: 'payments',
      targetId: paymentId,
      after: {
        staffId: input.staffId,
        amount: amount,
        itemCount: itemsCreated.length,
        attendanceIds: itemsCreated.map(i => i.attendanceId),
      },
    });

    Notifier.notify('payment.recorded', {
      staffId: input.staffId,
      staffName: staff.name,
      amount: amount,
      kind: 'shifts',
      itemCount: itemsCreated.length,
    });

    bustCaches_();
    return {
      paymentId,
      totalAmount: amount,
      kind: 'shifts',
      itemsCreated,
      summary: {
        shiftsOwedBefore: owed.shiftsOwed,
        shiftsOwedAfter: Util.roundMoney(owed.shiftsOwed - amount),
        fullyPaidCount: itemsCreated.filter(i => !i.isPartial).length,
        partialCount: itemsCreated.filter(i => i.isPartial).length,
      },
    };
  }

  // ── payBonus ────────────────────────────────────────────

  /**
   * Pay a specific bonus. Can be partial. If amount equals remaining,
   * bonus.status flips to 'paid'. Otherwise stays 'pending'.
   *
   * @param input { bonusId, amount, paidOn?, method?, notes?, actorId }
   */
  function payBonus_(input) {
    if (!input.bonusId) throw new Error('bonusId required');
    if (typeof input.amount !== 'number' || input.amount <= 0) {
      throw new Error('amount must be a positive number');
    }
    if (!input.actorId) throw new Error('actorId required');

    const bonus = Bonuses.getById(input.bonusId);
    if (!bonus) throw new Error('Bonus not found: ' + input.bonusId);
    if (bonus.status !== 'pending') {
      throw new Error(
        'Bonus is not pending (status=' + bonus.status + '). ' +
        (bonus.status === 'proposed' ? 'Approve it first.' :
         bonus.status === 'paid' ? 'Already paid.' :
         'Cannot pay a ' + bonus.status + ' bonus.')
      );
    }

    const staff = Staff.getById(bonus.staffId);
    if (!staff) throw new Error('Staff not found: ' + bonus.staffId);

    const amount = Util.roundMoney(input.amount);
    const paidMap = getBonusPaidAmounts_([bonus.bonusId]);
    const alreadyPaid = paidMap[bonus.bonusId] || 0;
    const remaining = Util.roundMoney(bonus.amount - alreadyPaid);

    if (remaining <= 0.005) {
      throw new Error('Bonus already fully paid');
    }
    if (amount > remaining + 0.005) {
      throw new Error(
        'Overpayment rejected: trying to pay ' + Util.formatMoney(amount) +
        ' but only ' + Util.formatMoney(remaining) + ' remaining on this bonus.'
      );
    }

    const paidOn = input.paidOn instanceof Date ? input.paidOn : new Date();
    const method = input.method || 'cash';
    if (PAYMENT_METHODS.indexOf(method) === -1) {
      throw new Error('Invalid payment method: ' + method);
    }

    // Payment header
    const paymentId = Util.newId('P');
    const pSh = paymentsSheet_();
    const pRow = pSh.getLastRow() + 1;
    pSh.getRange(pRow, 1, 1, P_NUM_COLS).setValues([[
      paymentId, bonus.staffId, paidOn, amount, method, input.actorId,
      input.notes || ('Bonus: ' + (bonus.reason || bonus.type))
    ]]);

    // Single payment_item
    const iSh = itemsSheet_();
    const itemId = Util.newId('IT');
    const isPartial = amount < remaining - 0.005;
    const itemNote = isPartial
      ? 'Partial — ' + Util.formatMoney(amount) + ' of ' + Util.formatMoney(remaining)
      : '';
    iSh.getRange(iSh.getLastRow() + 1, 1, 1, I_NUM_COLS).setValues([[
      itemId, paymentId, 'bonus', bonus.bonusId, amount, itemNote
    ]]);

    // Flip status only if fully paid
    if (!isPartial) {
      Bonuses.markPaid(bonus.bonusId, input.actorId);
    }

    AuditLog.write({
      actorId: input.actorId,
      action: 'payment.bonus',
      targetType: 'payments',
      targetId: paymentId,
      after: {
        staffId: bonus.staffId,
        bonusId: bonus.bonusId,
        amount: amount,
        bonusType: bonus.type,
        fullyPaid: !isPartial,
      },
    });

    Notifier.notify('payment.recorded', {
      staffId: bonus.staffId,
      staffName: staff.name,
      amount: amount,
      kind: 'bonus',
      bonusType: bonus.type,
    });

    bustCaches_();
    return {
      paymentId,
      bonusId: bonus.bonusId,
      amount,
      isPartial,
      newBonusStatus: isPartial ? 'pending' : 'paid',
      kind: 'bonus',
    };
  }

  // ── Undo ────────────────────────────────────────────────

  /**
   * Undo a specific payment. Removes the payments row + all its items.
   * If a fully-paid bonus reverts to having unpaid remainder, flips its
   * status back to 'pending'.
   */
  function undo_(paymentId, actorId) {
    if (!paymentId) throw new Error('paymentId required');
    if (!actorId) throw new Error('actorId required');

    bustCaches_(); // ensure live row indices before row deletions
    const payment = getPaymentById_(paymentId);
    if (!payment) throw new Error('Payment not found: ' + paymentId);
    const items = getItemsForPayment_(paymentId);

    // For each bonus item, check whether removing this amount means the
    // bonus is no longer fully paid → flip back to 'pending'.
    items.forEach(item => {
      if (item.itemType !== 'bonus') return;
      const b = Bonuses.getById(item.refId);
      if (!b || b.status !== 'paid') return;
      const totalPaid = getBonusPaidAmounts_([b.bonusId])[b.bonusId] || 0;
      const willRemain = Util.roundMoney(totalPaid - item.amount);
      if (willRemain < b.amount - 0.005) {
        Bonuses.revertToPending(b.bonusId, actorId);
      }
    });

    // Delete items first (in descending row order so indices stay valid)
    const iSh = itemsSheet_();
    const itemRows = items.map(i => i._rowIndex).sort((a, b) => b - a);
    itemRows.forEach(rowIdx => iSh.deleteRow(rowIdx));

    // Delete payment header
    const pSh = paymentsSheet_();
    pSh.deleteRow(payment._rowIndex);

    AuditLog.write({
      actorId,
      action: 'payment.undo',
      targetType: 'payments',
      targetId: paymentId,
      before: {
        staffId: payment.staffId,
        amount: payment.totalAmount,
        itemCount: items.length,
      },
    });

    bustCaches_(); // row indices shifted after deletions — invalidate
    return {
      success: true,
      removedPaymentId: paymentId,
      removedItemCount: items.length,
    };
  }

  /**
   * Convenience: undo the most recent payment for a staff member.
   */
  function undoLastForStaff_(staffId, actorId) {
    const payments = getPaymentsForStaff_(staffId);
    if (payments.length === 0) {
      throw new Error('No payments to undo for ' + staffId);
    }
    return undo_(payments[0].paymentId, actorId);
  }

  return {
    // Write operations
    payShifts:                payShifts_,
    payBonus:                 payBonus_,
    undo:                     undo_,
    undoLastForStaff:         undoLastForStaff_,
    // Read operations
    getOwedSummary:           getOwedSummary_,
    getPaymentById:           getPaymentById_,
    getPaymentsForStaff:      getPaymentsForStaff_,
    getItemsForPayment:       getItemsForPayment_,
    getRecent:                getRecent_,
    getAllPayments:           getAllPayments_,
    getAllItems:              getAllItems_,
    // Helpers (used by Attendance + Bonuses)
    getAttendancePaidAmounts: getAttendancePaidAmounts_,
    getBonusPaidAmounts:      getBonusPaidAmounts_,
  };
})();
