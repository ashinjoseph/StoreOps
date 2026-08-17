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

  // Per-execution row cache, same shape as TillSessions._tillCache. The
  // dashboard reads this sheet at least twice per request — once for the
  // visible range and again for the insight baseline — and every read was
  // pulling the whole sheet. Scope is one execution, so a write in another
  // request can never be served a stale list.
  let _salesCache = null;
  function bustCache_() { _salesCache = null; }

  function getAll_() {
    if (_salesCache) return _salesCache;
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last < DATA_START_ROW) return [];
    const data = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS).getValues();
    _salesCache = data
      .map((row, i) => rowToRecord_(row, i + DATA_START_ROW))
      .filter(r => r.salesId);
    return _salesCache;
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
    // The row list is now stale. This matters immediately: the return below
    // re-reads through getForSession_, which would otherwise hand back the
    // pre-write record — or nothing at all for a freshly created row.
    bustCache_();

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
  // ============================================================
  //  Insights
  // ============================================================
  //  Everything here answers a question a corner store actually asks:
  //  is trade up or down, which days carry the week, which part of the
  //  month pays, and how much of it still arrives as cash.
  //
  //  Two rules run through all of it.
  //
  //  Averages divide by DAYS THAT TRADED, never by calendar days in the
  //  range. A week the shop was shut would otherwise read as a collapse
  //  in trade rather than an absence of it.
  //
  //  Where the range is too short to support a claim, the block comes
  //  back with `insufficient` and a reason, and the UI prints the reason.
  //  A rolling average drawn through three points looks exactly as
  //  confident as one drawn through ninety, which is how a dashboard
  //  starts lying.
  // ============================================================

  const DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Days 1-10 / 11-20 / 21-end. Buckets hold different numbers of days —
  // and a partial range truncates one — so they are only ever compared as
  // per-day averages, never as sums.
  const MONTH_BUCKETS = [
    { key: 'early', label: 'Days 1-10',  from: 1,  to: 10 },
    { key: 'mid',   label: 'Days 11-20', from: 11, to: 20 },
    { key: 'late',  label: 'Days 21-end', from: 21, to: 31 },
  ];

  function pctChange_(now, before) {
    if (!before) return null;          // no baseline — "+∞%" says nothing
    return Math.round(((now - before) / Math.abs(before)) * 1000) / 10;
  }

  function sumTotals_(rows) {
    let cash = 0, total = 0;
    rows.forEach(r => {
      const c = (r.cashSales || 0) + (r.miscCashSales || 0);
      cash += c;
      total += totalForRow_(r);
    });
    return { cash: Util.roundMoney(cash), total: Util.roundMoney(total) };
  }

  // Trailing mean over `window` days of the daily series. Emitted only from
  // the point a full window exists, so the line never starts on a partial
  // average that looks like a dip.
  function rollingAverage_(daily, window) {
    const out = [];
    for (let i = 0; i < daily.length; i++) {
      if (i + 1 < window) { out.push(null); continue; }
      let sum = 0;
      for (let j = i - window + 1; j <= i; j++) sum += daily[j].total;
      out.push(Util.roundMoney(sum / window));
    }
    return out;
  }

  function trendInsight_(daily, totals, prevRows, dayCount) {
    const prev = sumTotals_(prevRows);
    const perDay = dayCount ? Util.roundMoney(totals.total / dayCount) : 0;
    const block = {
      total: totals.total,
      previousTotal: prev.total,
      changePct: pctChange_(totals.total, prev.total),
      changeAmount: Util.roundMoney(totals.total - prev.total),
      perTradingDay: perDay,
      tradingDays: dayCount,
      best: null, worst: null,
      rolling7: null,
    };
    if (daily.length) {
      const sorted = daily.slice().sort((a, b) => b.total - a.total);
      block.best  = { dateStr: sorted[0].dateStr, total: sorted[0].total };
      block.worst = { dateStr: sorted[sorted.length - 1].dateStr, total: sorted[sorted.length - 1].total };
    }
    if (daily.length >= 7) {
      block.rolling7 = rollingAverage_(daily, 7);
    } else {
      block.rollingInsufficient = 'Needs 7 days of sales for a rolling average — this range has ' + daily.length + '.';
    }
    return block;
  }

  function dayOfWeekInsight_(daily) {
    const buckets = DOW_NAMES.map((n, i) => ({ dow: i, name: n, short: DOW_SHORT[i], total: 0, days: 0, average: 0 }));
    daily.forEach(d => {
      if (!d.dateMs) return;
      const b = buckets[new Date(d.dateMs).getDay()];
      b.total = Util.roundMoney(b.total + d.total);
      b.days++;
    });
    buckets.forEach(b => { b.average = b.days ? Util.roundMoney(b.total / b.days) : 0; });

    const traded = buckets.filter(b => b.days > 0);
    if (traded.length < 2) {
      return { insufficient: 'Needs at least two different weekdays of sales.', buckets: buckets };
    }
    const ranked = traded.slice().sort((a, b) => b.average - a.average);
    return {
      buckets: buckets,
      best:  { name: ranked[0].name, average: ranked[0].average },
      worst: { name: ranked[ranked.length - 1].name, average: ranked[ranked.length - 1].average },
      // How much better the best day is than the worst — the number that
      // decides whether staffing the week evenly is a mistake.
      spreadPct: pctChange_(ranked[0].average, ranked[ranked.length - 1].average),
    };
  }

  function timeOfMonthInsight_(daily) {
    const buckets = MONTH_BUCKETS.map(b => ({
      key: b.key, label: b.label, total: 0, days: 0, average: 0,
    }));
    daily.forEach(d => {
      if (!d.dateMs) return;
      const dom = new Date(d.dateMs).getDate();
      const idx = dom <= 10 ? 0 : (dom <= 20 ? 1 : 2);
      buckets[idx].total = Util.roundMoney(buckets[idx].total + d.total);
      buckets[idx].days++;
    });
    buckets.forEach(b => { b.average = b.days ? Util.roundMoney(b.total / b.days) : 0; });

    // Under a month, at least one bucket is missing or barely sampled, and
    // "days 1-10 are your best" off four days is a coin toss with a chart.
    const covered = buckets.filter(b => b.days > 0).length;
    if (daily.length < 28 || covered < 3) {
      return {
        insufficient: 'Needs a full month of sales to compare parts of the month — this range covers ' +
                      daily.length + ' trading day' + (daily.length === 1 ? '' : 's') +
                      ' across ' + covered + ' of 3 parts.',
        buckets: buckets,
      };
    }
    const ranked = buckets.slice().sort((a, b) => b.average - a.average);
    const overall = Util.roundMoney(
      buckets.reduce((s, b) => s + b.total, 0) / buckets.reduce((s, b) => s + b.days, 0)
    );
    buckets.forEach(b => { b.vsOverallPct = pctChange_(b.average, overall); });
    return {
      buckets: buckets,
      overallAverage: overall,
      strongest: { label: ranked[0].label, average: ranked[0].average },
      weakest:   { label: ranked[2].label, average: ranked[2].average },
    };
  }

  function tenderMixInsight_(daily, totals, prevRows) {
    const share = (cash, total) => total ? Math.round((cash / total) * 1000) / 10 : null;
    const prev = sumTotals_(prevRows);
    const nowShare  = share(totals.cash, totals.total);
    const prevShare = share(prev.cash, prev.total);
    return {
      cash: totals.cash,
      total: totals.total,
      cashSharePct: nowShare,
      previousCashSharePct: prevShare,
      // Percentage POINTS, not a percent change of a percent — the latter is
      // the classic way this number gets reported as five times its size.
      changePoints: (nowShare != null && prevShare != null)
        ? Math.round((nowShare - prevShare) * 10) / 10 : null,
      series: daily.map(d => ({
        dateStr: d.dateStr,
        sharePct: share(d.cash, d.total),
      })),
    };
  }

  /**
   * Everything the sales dashboard shows above the raw rows. Built from the
   * `daily` series the dashboard already computes, plus ONE extra read for
   * the preceding equal-length window.
   */
  /**
   * Rows → one entry per calendar day, oldest first. Extracted so the
   * consolidated view and each per-company view are built by the SAME reducer:
   * the moment they diverge, a split can disagree with the whole it came from.
   *
   * `byCompany` on each day is what lets the chart stack cstore under vape
   * without a second pass over the sheet.
   */
  function buildDaily_(rows) {
    const map = {};
    rows.forEach(r => {
      const key = r.date ? Util.formatDate(r.date) : '—';
      let d = map[key];
      if (!d) {
        d = map[key] = {
          dateStr: key, dateMs: r.date ? r.date.getTime() : 0,
          cash: 0, credit: 0, debit: 0, misc: 0, total: 0, sessionCount: 0,
          byCompany: {},
        };
      }
      const rowTotal = totalForRow_(r);
      d.cash   += r.cashSales || 0;
      d.credit += r.creditCardSales || 0;
      d.debit  += r.debitCardSales || 0;
      d.misc   += (r.miscCashSales || 0) + (r.miscCreditSales || 0) + (r.miscDebitSales || 0);
      d.sessionCount++;
      if (r.company) d.byCompany[r.company] = (d.byCompany[r.company] || 0) + rowTotal;
    });
    return Object.keys(map).map(k => {
      const d = map[k];
      d.total = Util.roundMoney(d.cash + d.credit + d.debit + d.misc);
      ['cash', 'credit', 'debit', 'misc'].forEach(x => { d[x] = Util.roundMoney(d[x]); });
      Object.keys(d.byCompany).forEach(c => { d.byCompany[c] = Util.roundMoney(d.byCompany[c]); });
      return d;
    }).sort((a, b) => a.dateMs - b.dateMs);
  }

  /**
   * One company's slice of the same range: its own daily series, its own
   * weekday profile, and its share of the whole. Built from rows already in
   * memory, so the split costs no extra sheet read.
   */
  function companySlice_(companyRows, grandTotal) {
    const cDaily = buildDaily_(companyRows);
    const total = Util.roundMoney(cDaily.reduce((s, d) => s + d.total, 0));
    const tradingDays = cDaily.length;
    return {
      total: total,
      tradingDays: tradingDays,
      perTradingDay: tradingDays ? Util.roundMoney(total / tradingDays) : 0,
      sharePct: grandTotal ? Math.round((total / grandTotal) * 1000) / 10 : 0,
      sessionCount: companyRows.length,
      dayOfWeek: dayOfWeekInsight_(cDaily),
      daily: cDaily,
    };
  }

  function buildInsights_(daily, totals, startDate, endDate, filters) {
    // Step the baseline window in whole DAYS, not raw milliseconds. Callers
    // pass an end of 23:59:59, so a millisecond span is a second short of the
    // full range — enough to land `prevStart` just after midnight and drop a
    // row stamped at exactly midnight, which is how every date in this sheet
    // is stored. Constructing the dates by component also keeps it correct
    // across a DST boundary, where 86400000ms is not a day.
    const startDay = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const endDay   = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    const spanDays = Math.max(1, Math.round((endDay - startDay) / 86400000) + 1);
    const prevStart = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() - spanDays);
    const prevEnd   = new Date(startDay.getTime() - 1);   // 23:59:59.999 the day before
    let prevRows = [];
    try {
      prevRows = getForDateRange_(prevStart, prevEnd, filters) || [];
    } catch (e) {
      // A failed baseline should cost the comparison, not the dashboard.
      prevRows = [];
    }

    return {
      trend:       trendInsight_(daily, totals, prevRows, daily.length),
      dayOfWeek:   dayOfWeekInsight_(daily),
      timeOfMonth: timeOfMonthInsight_(daily),
      tenderMix:   tenderMixInsight_(daily, totals, prevRows),
      previousPeriod: {
        startStr: Util.formatDate(prevStart),
        endStr:   Util.formatDate(prevEnd),
        sessionCount: prevRows.length,
      },
    };
  }

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
      cash: 0, credit: 0, debit: 0, misc: 0, total: 0,
      cashback: 0, sessionCount: rows.length,
    };
    rows.forEach(r => {
      totals.cash   += r.cashSales || 0;
      totals.credit += r.creditCardSales || 0;
      totals.debit  += r.debitCardSales || 0;
      totals.misc   += (r.miscCashSales || 0) + (r.miscCreditSales || 0) + (r.miscDebitSales || 0);
      totals.cashback += r.cashbackPaid || 0;
    });
    totals.total = totals.cash + totals.credit + totals.debit + totals.misc;
    ['cash','credit','debit','misc','total','cashback'].forEach(k => {
      totals[k] = Util.roundMoney(totals[k]);
    });

    // Per-day aggregation over the FULL filtered set (independent of paging).
    // Powers the dashboard's daily bar chart. Sorted oldest→newest, and each
    // day carries its per-company split so the chart can stack cstore and vape
    // without a second query.
    const daily = buildDaily_(rows);

    // Company list comes from the data, not from Setup.gs's COMPANIES — this
    // module has no load-order dependency on Setup and a third till would flow
    // through without a code change.
    const companies = [];
    rows.forEach(r => {
      if (r.company && companies.indexOf(r.company) === -1) companies.push(r.company);
    });
    companies.sort();

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
        cash: Util.roundMoney(r.cashSales || 0),
        credit: Util.roundMoney(r.creditCardSales || 0),
        debit: Util.roundMoney(r.debitCardSales || 0),
        misc: Util.roundMoney((r.miscCashSales || 0) + (r.miscCreditSales || 0) + (r.miscDebitSales || 0)),
        cashback: r.cashbackPaid || 0,
        total: totalForRow_(r),
        miscNotes: r.miscNotes,
      })),
      totalCount: rows.length,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(rows.length / pageSize)),
      totals,
      daily,
      companies: companies,
      insights: Object.assign(
        buildInsights_(daily, totals, startDate, endDate, {
          staffId: input.staffId, company: input.company,
        }),
        // Only when nothing is filtered out. Narrowed to one company there is
        // no comparison to draw, and a single-key object invites the UI to
        // render a side-by-side of one.
        (!input.company && companies.length > 1)
          ? { byCompany: companies.reduce((acc, c) => {
                acc[c] = companySlice_(rows.filter(r => r.company === c), totals.total);
                return acc;
              }, {}) }
          : {}
      ),
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
