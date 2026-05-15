// ============================================================
//  Sales.gs — sales rows (one per till_session)
// ============================================================
//  Written by TillSessions.close. Read by the sales dashboard and
//  by the commission engine (batch 3).
//
//  Sales row is 1:1 with till_session (same id used for both).
//  Denormalized: staff_id, company, date kept on the row so dashboard
//  queries don't have to join.
// ============================================================

const Sales = (() => {

  const COL = {
    sales_id: 1, session_id: 2, staff_id: 3, company: 4, date: 5,
    cash_sales: 6, credit_card_sales: 7, debit_card_sales: 8, cashback_paid: 9,
    hst_collected: 10, bottle_deposit: 11, round_off: 12,
    misc_cash_sales: 13, misc_credit_sales: 14, misc_debit_sales: 15, misc_notes: 16
  };
  const NUM_COLS = 16;
  const DATA_START_ROW = 3;

  function sheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.SALES);
    if (!sh) throw new Error('sales sheet not found — run First-time Setup');
    return sh;
  }

  function rowToRecord_(row, rowIndex) {
    return {
      salesId:          (row[COL.sales_id - 1] || '').toString().trim(),
      sessionId:        (row[COL.session_id - 1] || '').toString().trim(),
      staffId:          (row[COL.staff_id - 1] || '').toString().trim(),
      company:          (row[COL.company - 1] || '').toString().trim(),
      date:             row[COL.date - 1] instanceof Date ? row[COL.date - 1] : null,
      cashSales:        Number(row[COL.cash_sales - 1]) || 0,
      creditCardSales:  Number(row[COL.credit_card_sales - 1]) || 0,
      debitCardSales:   Number(row[COL.debit_card_sales - 1]) || 0,
      cashbackPaid:     Number(row[COL.cashback_paid - 1]) || 0,
      hstCollected:     Number(row[COL.hst_collected - 1]) || 0,
      bottleDeposit:    Number(row[COL.bottle_deposit - 1]) || 0,
      roundOff:         Number(row[COL.round_off - 1]) || 0,
      miscCashSales:    Number(row[COL.misc_cash_sales - 1]) || 0,
      miscCreditSales:  Number(row[COL.misc_credit_sales - 1]) || 0,
      miscDebitSales:   Number(row[COL.misc_debit_sales - 1]) || 0,
      miscNotes:        (row[COL.misc_notes - 1] || '').toString(),
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
      .filter(r => r.salesId);
  }

  function getForSession_(sessionId) {
    return getAll_().find(s => s.sessionId === sessionId) || null;
  }

  function getForDateRange_(startDate, endDate, filters) {
    const start = startDate instanceof Date ? startDate : Util.parseDate(startDate);
    const end = endDate instanceof Date ? endDate : Util.parseDate(endDate);
    if (!start || !end) return [];
    const all = getAll_();
    return all.filter(s => {
      if (!s.date || s.date < start || s.date > end) return false;
      if (filters) {
        if (filters.staffId && s.staffId !== filters.staffId) return false;
        if (filters.company && s.company !== filters.company) return false;
      }
      return true;
    });
  }

  /**
   * Write a sales row. Called by TillSessions.close_().
   * Sales id matches session id (1:1).
   *
   * Idempotency: if a row for this session already exists, update it
   * in place rather than appending a duplicate.
   */
  function write_(input, actorId) {
    if (!input.sessionId) throw new Error('sessionId required');
    if (!input.staffId) throw new Error('staffId required');
    if (!input.company) throw new Error('company required');
    if (!input.date) throw new Error('date required');

    const sh = sheet_();
    const dateMidnight = input.date instanceof Date
      ? Util.parseDate(Util.formatDate(input.date))
      : Util.parseDate(input.date);

    const values = [
      input.sessionId,            // sales_id = session_id
      input.sessionId,
      input.staffId,
      input.company,
      dateMidnight,
      Util.roundMoney(input.cashSales || 0),
      Util.roundMoney(input.creditCardSales || 0),
      Util.roundMoney(input.debitCardSales || 0),
      Util.roundMoney(input.cashbackPaid || 0),
      Util.roundMoney(input.hstCollected || 0),
      Util.roundMoney(input.bottleDeposit || 0),
      Util.roundMoney(input.roundOff || 0),
      Util.roundMoney(input.miscCashSales || 0),
      Util.roundMoney(input.miscCreditSales || 0),
      Util.roundMoney(input.miscDebitSales || 0),
      input.miscNotes || ''
    ];

    const existing = getForSession_(input.sessionId);
    let action, before;
    if (existing) {
      // Update in place
      action = 'sales.update';
      before = {
        cashSales: existing.cashSales,
        creditCardSales: existing.creditCardSales,
        debitCardSales: existing.debitCardSales,
      };
      sh.getRange(existing._rowIndex, 1, 1, NUM_COLS).setValues([values]);
    } else {
      action = 'sales.create';
      before = null;
      const row = sh.getLastRow() + 1;
      sh.getRange(row, 1, 1, NUM_COLS).setValues([values]);
    }

    AuditLog.write({
      actorId: actorId || 'SYSTEM',
      action,
      targetType: 'sales',
      targetId: input.sessionId,
      before,
      after: {
        cashSales: values[5],
        creditCardSales: values[6],
        debitCardSales: values[7],
        cashbackPaid: values[8],
      },
    });

    return getForSession_(input.sessionId);
  }

  /**
   * Total revenue across cash + credit + debit (excluding cashback).
   * Used by commission engine.
   */
  function totalForRow_(row) {
    if (!row) return 0;
    return Util.roundMoney(
      (row.cashSales || 0) + (row.creditCardSales || 0) + (row.debitCardSales || 0) +
      (row.miscCashSales || 0) + (row.miscCreditSales || 0) + (row.miscDebitSales || 0)
    );
  }

  /**
   * Sum sales by (staff_id, company) for a date range.
   * Used by commission engine and the dashboard.
   *
   * Returns array of { staffId, company, total, cashTotal, cardTotal,
   *                    cashbackTotal, sessionCount }
   */
  function aggregateByStaffCompany_(startDate, endDate) {
    const rows = getForDateRange_(startDate, endDate, null);
    const map = {};
    rows.forEach(r => {
      const key = r.staffId + '|' + r.company;
      if (!map[key]) {
        map[key] = {
          staffId: r.staffId,
          company: r.company,
          total: 0,
          cashTotal: 0,
          cardTotal: 0,
          cashbackTotal: 0,
          sessionCount: 0,
        };
      }
      map[key].total += totalForRow_(r);
      map[key].cashTotal += (r.cashSales || 0) + (r.miscCashSales || 0);
      map[key].cardTotal += (r.creditCardSales || 0) + (r.debitCardSales || 0)
                         + (r.miscCreditSales || 0) + (r.miscDebitSales || 0);
      map[key].cashbackTotal += r.cashbackPaid || 0;
      map[key].sessionCount += 1;
    });
    return Object.values(map).map(v => ({
      ...v,
      total: Util.roundMoney(v.total),
      cashTotal: Util.roundMoney(v.cashTotal),
      cardTotal: Util.roundMoney(v.cardTotal),
      cashbackTotal: Util.roundMoney(v.cashbackTotal),
    }));
  }

  /**
   * Dashboard query — list rows with optional filters, paginated.
   *
   * @param input { startDate, endDate, staffId?, company?, page?, pageSize? }
   * @returns { rows, totalCount, page, pageSize, totals: { cash, credit, debit } }
   */
  function getDashboard_(input) {
    const startDate = input.startDate
      ? (input.startDate instanceof Date ? input.startDate : Util.parseDate(input.startDate))
      : null;
    const endDate = input.endDate
      ? (input.endDate instanceof Date ? input.endDate : Util.parseDate(input.endDate))
      : null;
    if (!startDate || !endDate) throw new Error('startDate and endDate required');

    let rows = getForDateRange_(startDate, endDate, {
      staffId: input.staffId,
      company: input.company,
    });
    // Sort newest first
    rows.sort((a, b) => b.date - a.date);

    const totals = {
      cash: 0, credit: 0, debit: 0, total: 0,
      cashback: 0, sessionCount: rows.length,
    };
    rows.forEach(r => {
      totals.cash   += (r.cashSales || 0) + (r.miscCashSales || 0);
      totals.credit += (r.creditCardSales || 0) + (r.miscCreditSales || 0);
      totals.debit  += (r.debitCardSales || 0) + (r.miscDebitSales || 0);
      totals.cashback += r.cashbackPaid || 0;
    });
    totals.total = totals.cash + totals.credit + totals.debit;
    ['cash','credit','debit','total','cashback'].forEach(k => {
      totals[k] = Util.roundMoney(totals[k]);
    });

    const pageSize = input.pageSize || 50;
    const page = input.page || 1;
    const start = (page - 1) * pageSize;
    const pageRows = rows.slice(start, start + pageSize);

    // Lookup names once
    const staffMap = {};
    Staff.getAll().forEach(s => { staffMap[s.staffId] = s.name; });

    return {
      rows: pageRows.map(r => ({
        salesId: r.salesId,
        sessionId: r.sessionId,
        staffId: r.staffId,
        staffName: staffMap[r.staffId] || r.staffId,
        company: r.company,
        date: r.date ? Util.formatDate(r.date) : null,
        cash: Util.roundMoney((r.cashSales || 0) + (r.miscCashSales || 0)),
        credit: Util.roundMoney((r.creditCardSales || 0) + (r.miscCreditSales || 0)),
        debit: Util.roundMoney((r.debitCardSales || 0) + (r.miscDebitSales || 0)),
        cashback: r.cashbackPaid || 0,
        total: totalForRow_(r),
        miscNotes: r.miscNotes,
      })),
      totalCount: rows.length,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(rows.length / pageSize)),
      totals,
    };
  }

  return {
    getAll:                  getAll_,
    getForSession:           getForSession_,
    getForDateRange:         getForDateRange_,
    write:                   write_,
    totalForRow:             totalForRow_,
    aggregateByStaffCompany: aggregateByStaffCompany_,
    getDashboard:            getDashboard_,
  };
})();
