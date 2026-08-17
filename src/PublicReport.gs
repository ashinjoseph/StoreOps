// ============================================================
//  PublicReport.gs — the 7-day report served outside the app
// ============================================================
//  Reachable from the link on the reconcile WhatsApp, with no login. It
//  answers the three questions people currently open the app to check:
//  who is carrying the shop's cash, how the lotto pot has moved, and
//  whether the days added up.
//
//  READ ONLY, and deliberately so. Nothing here writes, and the page is
//  rendered with its data inlined at request time — so no RPC endpoint
//  becomes reachable without a session. The only thing exposed is one
//  URL returning one HTML document.
//
//  Every section is wrapped: a spreadsheet that hasn't run a migration
//  reports that section as unavailable instead of failing the page. A
//  report that half-loads is worth more than one that 500s.
// ============================================================

const PublicReport = (() => {

  const DEFAULT_DAYS = 7;

  function dayKey_(d) {
    return d instanceof Date ? Util.formatDate(d) : (d || '').toString();
  }

  // The last `days` calendar days, oldest first, as yyyy-MM-dd. Built from
  // local midnights rather than by subtracting 86400000ms, so a DST change
  // doesn't duplicate or skip a day.
  function dayWindow_(days) {
    const out = [];
    const today = Util.todayMidnight();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      out.push({ key: Util.formatDate(d), date: d });
    }
    return out;
  }

  function section_(fn) {
    try {
      return fn();
    } catch (e) {
      return { unavailable: e.message || 'not available' };
    }
  }

  // ── Reserve ─────────────────────────────────────────────
  /**
   * The lotto pot over the window: what it was counted at each day, what
   * moved in, and the cashier's reason on any day it came up short.
   */
  function reserveSection_(days, window) {
    const log = TillSessions.getLottoLog(Math.max(days, 14));
    if (!log || !log.enabled) return { unavailable: 'Lotto reserve is not set up on this sheet.' };

    const byDay = {};
    (log.entries || []).forEach(e => {
      const k = dayKey_(e.date ? new Date(e.date) : null);
      if (!k) return;
      // Several shifts can touch the pot in a day; the balance is the last
      // count, but the money moved in is a flow and adds up.
      const prev = byDay[k];
      byDay[k] = {
        counted: e.counted,
        topup: Util.roundMoney((prev ? prev.topup : 0) + (e.topup || 0)),
        note: e.note || (prev ? prev.note : ''),
        shortfall: e.shortfall || 0,
      };
    });

    const rows = window.map(w => {
      const d = byDay[w.key];
      return {
        dateStr: w.key,
        counted: d ? d.counted : null,
        topup: d ? d.topup : 0,
        shortfall: d ? d.shortfall : 0,
        note: d ? d.note : '',
        traded: !!d,
      };
    });

    return {
      expected: log.expected,
      current: log.lastCounted,
      currentDate: log.lastCountedDate ? dayKey_(new Date(log.lastCountedDate)) : '',
      shortfall: log.lastCounted == null ? null : Util.roundMoney(log.expected - log.lastCounted),
      movedIn: Util.roundMoney(rows.reduce((s, r) => s + (r.topup || 0), 0)),
      rows: rows,
    };
  }

  // ── Cash held ───────────────────────────────────────────
  /**
   * Who is carrying shop cash right now, and the handovers that moved it
   * during the window. Names are shown — that is the point of the page.
   */
  function cashSection_(days, window) {
    if (!CashHandling.sheetsExist()) {
      return { unavailable: 'Cash handling is not set up on this sheet.' };
    }
    const out = CashHandling.getAllOutstanding();
    const mgr = CashHandling.cashManager();

    // Handovers inside the window, oldest first, so the page reads as a
    // story of the week rather than a snapshot.
    const first = window[0].key;
    const moves = CashHandling.getHistory(200, null)
      .filter(h => h.status !== 'voided' && h.handedOnStr && h.handedOnStr >= first)
      .sort((a, b) => (a.handedOnStr < b.handedOnStr ? -1 : 1))
      .map(h => ({
        dateStr: h.handedOnStr,
        from: h.fromName,
        to: h.toName,
        amount: h.amount,
        recordedBy: h.recordedByName,
        notes: h.notes || '',
      }));

    const movedByDay = {};
    moves.forEach(m => {
      movedByDay[m.dateStr] = Util.roundMoney((movedByDay[m.dateStr] || 0) + m.amount);
    });

    return {
      total: out.grandTotal,
      holders: out.holders.map(h => ({
        name: h.name, total: h.total, shifts: h.shifts,
        oldest: h.oldest, oldestAge: h.oldestAge,
      })),
      stale: out.stale.map(s => ({
        name: s.name, dateStr: s.dateStr, remaining: s.remaining, ageDays: s.ageDays,
      })),
      staleDays: out.staleDays,
      cashManager: mgr ? mgr.name : null,
      moves: moves,
      movedTotal: Util.roundMoney(moves.reduce((s, m) => s + m.amount, 0)),
      byDay: window.map(w => ({ dateStr: w.key, movedIn: movedByDay[w.key] || 0 })),
    };
  }

  // ── Daily reconcile ─────────────────────────────────────
  /**
   * One row per reconciled shift in the window, presented the same way the
   * dashboard and the WhatsApp message present it: claimed, measured, and
   * measured minus claimed. Three surfaces, one convention.
   */
  function reconcileSection_(days, window) {
    const first = window[0].key;
    const rows = (Reconcile.getRecent(200) || [])
      .filter(r => r.businessDate && r.businessDate >= first)
      .map(r => ({
        dateStr: r.businessDate,
        companies: r.companies,
        cashClaimed: Util.roundMoney(r.cashCounted - r.cashVariance),
        cashMeasured: Util.roundMoney(r.cashCounted),
        cashVar: Util.roundMoney(r.cashVariance),
        cardClaimed: Util.roundMoney(r.cashierCard),
        cardMeasured: Util.roundMoney(r.cloverCard),
        cardVar: Util.roundMoney(r.cloverCard - r.cashierCard),
        status: r.status,
      }))
      .sort((a, b) => (a.dateStr < b.dateStr ? 1 : -1));

    if (!rows.length) return { rows: [], note: 'Nothing reconciled in this window yet.' };
    return {
      rows: rows,
      // Counted once so the header can say whether the week is clean without
      // the reader scanning every row.
      okCount: rows.filter(r => r.status === 'OK').length,
      flagged: rows.filter(r => r.status !== 'OK').length,
    };
  }

  /**
   * The whole payload. Never throws — a failed section reports itself.
   */
  function build_(days) {
    days = Number(days) || DEFAULT_DAYS;
    const window = dayWindow_(days);
    return {
      days: days,
      fromStr: window[0].key,
      toStr: window[window.length - 1].key,
      generatedAt: Util.formatDateTime(new Date()),
      reserve:   section_(() => reserveSection_(days, window)),
      cash:      section_(() => cashSection_(days, window)),
      reconcile: section_(() => reconcileSection_(days, window)),
    };
  }

  // ── Sales ───────────────────────────────────────────────
  /**
   * The sales dashboard, for people who do not have a login: owners and
   * whoever else needs to know how trade is going. Aggregates only.
   *
   * Session rows are deliberately NOT carried across. In the app the day
   * detail names the cashier who worked it, and putting names against takings
   * on a no-login URL is the exact exposure switching away from the reconcile
   * report was meant to remove. A stakeholder needs the shape of trade, not
   * who was on the till.
   */
  function salesSection_(days) {
    const end = Util.todayMidnight();
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1));
    const endOfDay = new Date(end.getFullYear(), end.getMonth(), end.getDate(), 23, 59, 59);

    const d = Sales.getDashboard({
      startDate: start, endDate: endOfDay,
      page: 1, pageSize: 1,          // rows are dropped; ask for as few as possible
    });

    return {
      fromStr: Util.formatDate(start),
      toStr:   Util.formatDate(end),
      totals:  d.totals,
      companies: d.companies || [],
      sessionCount: d.totalCount || 0,
      // Day totals and their company split — enough for the stacked chart,
      // with no per-session detail behind it.
      daily: (d.daily || []).map(x => ({
        dateStr: x.dateStr, total: x.total, sessionCount: x.sessionCount,
        byCompany: x.byCompany || {},
      })),
      insights: d.insights || null,
    };
  }

  function buildSales_(days) {
    days = Number(days) || 60;
    return Object.assign(
      { days: days, generatedAt: Util.formatDateTime(new Date()) },
      section_(() => salesSection_(days))
    );
  }

  return { build: build_, buildSales: buildSales_ };
})();
