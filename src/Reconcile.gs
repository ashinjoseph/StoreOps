// ============================================================
//  Reconcile.gs — per-shift cashier vs Clover reconciliation
// ============================================================
//  Runs when no till sessions remain open for the day (auto, after a
//  close) or on demand (manual button). Reconciles ONLY the shift that
//  just closed — the closed sessions not yet reconciled — and pulls
//  Clover for that shift's exact open→close window, so morning and
//  evening match independently and never double-count.
//
//  Each run records the session_ids it covered so the next run skips
//  them. Manual mode re-checks the whole day (all closed sessions).
//
//  Group-by-merchant: companies sharing a merchant_id reconcile together
//  (config-only to split into two merchants later).
// ============================================================

const Reconcile = (() => {

  const COL = {
    validation_id: 1, business_date: 2, window_start: 3, window_end: 4,
    merchant: 5, companies: 6,
    cashier_credit: 7, clover_credit: 8, cashier_debit: 9, clover_debit: 10,
    cashier_card: 11, clover_card: 12, card_variance: 13,
    cash_counted: 14, cash_variance: 15, status: 16, mode: 17,
    session_ids: 18, validated_at: 19, validated_by: 20
  };
  const NUM_COLS = 20;
  const DATA_START_ROW = 3;

  function sheet_() {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.VALIDATION_RESULTS);
    if (!sh) throw new Error('validation_results sheet not found — run First-time Setup');
    return sh;
  }

  function configValue_(key, defaultValue) {
    try {
      const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CONFIG);
      if (!sh) return defaultValue;
      const data = sh.getRange(3, 1, sh.getLastRow() - 2, 2).getValues();
      const row = data.find(r => r[0] === key);
      return row && row[1] !== '' ? row[1] : defaultValue;
    } catch (e) { return defaultValue; }
  }

  function signed_(n) {
    n = Util.roundMoney(n);
    return (n < 0 ? '-' : '+') + '$' + Math.abs(n).toFixed(2);
  }
  function hhmm_(d) {
    return d instanceof Date ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'HH:mm') : '—';
  }
  function mark_(d) {
    const threshold = Number(configValue_('card_variance_threshold', 1)) || 1;
    return Math.abs(Util.roundMoney(d)) <= threshold ? '✅' : '⚠️';
  }

  function hasOpenSessionsToday_() {
    const today = Util.todayMidnight();
    const sessions = TillSessions.getForDateRange(today, Util.endOfDay(today)) || [];
    return sessions.some(s => s.status === 'open');
  }

  // Session IDs already covered by a reconciliation today (to skip on the
  // next auto run so shifts don't double-count).
  function reconciledSessionIdsToday_(dateObj) {
    const sh = sheet_();
    const last = sh.getLastRow();
    const set = {};
    if (last < DATA_START_ROW) return set;
    const data = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS).getValues();
    const want = Util.formatDate(dateObj);
    data.forEach(r => {
      const bd = r[COL.business_date - 1] instanceof Date
        ? Util.formatDate(r[COL.business_date - 1]) : (r[COL.business_date - 1] || '').toString();
      if (bd !== want) return;
      (r[COL.session_ids - 1] || '').toString().split(',').forEach(id => {
        const t = id.trim();
        if (t) set[t] = true;
      });
    });
    return set;
  }

  /**
   * Reconcile the shift that just closed (auto) or the whole day (manual).
   * @returns { ready:false, ... } | { ready:true, empty:true }
   *        | { ready:true, mode, date, merchants:[...], whatsapp:{sent} }
   */
  function reconcileDay_(actorId, mode) {
    if (mode !== 'manual' && !Clover.isEnabled()) return { ready: false, disabled: true };

    const today = Util.todayMidnight();
    const todayEnd = Util.endOfDay(today);
    const sessions = TillSessions.getForDateRange(today, todayEnd) || [];

    const openCount = sessions.filter(s => s.status === 'open').length;
    if (mode !== 'manual' && openCount > 0) return { ready: false, openCount: openCount };

    let closed = sessions.filter(s => s.status === 'closed' || s.status === 'validated');

    // Auto: only the sessions not yet reconciled (this shift). Manual: all.
    if (mode !== 'manual') {
      const done = reconciledSessionIdsToday_(today);
      closed = closed.filter(s => !done[s.sessionId]);
    }
    if (closed.length === 0) return { ready: true, empty: true };

    // Card per session from the sales rows (1:1 with sessions).
    const salesById = {};
    (Sales.getForDateRange(today, todayEnd, null) || []).forEach(r => { salesById[r.sessionId] = r; });

    // Group the in-scope sessions by Clover merchant.
    const groups = {};
    closed.forEach(s => {
      const m = Clover.merchantFor(s.company);
      const key = m.merchantId || ('NOCONFIG:' + s.company);
      if (!groups[key]) groups[key] = {
        merchant: m, companies: {}, sessionIds: [],
        cashierCredit: 0, cashierDebit: 0, cashCounted: 0, cashVariance: 0,
        startMs: Infinity, endMs: 0,
      };
      const g = groups[key];
      g.companies[s.company] = true;
      g.sessionIds.push(s.sessionId);
      const sale = salesById[s.sessionId];
      if (sale) {
        g.cashierCredit += (sale.creditCardSales || 0) + (sale.miscCreditSales || 0);
        g.cashierDebit  += (sale.debitCardSales || 0) + (sale.miscDebitSales || 0);
      }
      g.cashCounted  += s.closingCashCounted || 0;
      g.cashVariance += s.closingVariance || 0;
      if (s.startTime instanceof Date) g.startMs = Math.min(g.startMs, s.startTime.getTime());
      if (s.endTime instanceof Date)   g.endMs   = Math.max(g.endMs, s.endTime.getTime());
    });

    const threshold = Number(configValue_('card_variance_threshold', 1)) || 1;
    const now = new Date();
    const dateStr = Util.formatDate(today);
    const merchants = [];

    Object.keys(groups).forEach(key => {
      const g = groups[key];
      // Fall back to the day if a session is missing a timestamp.
      const startMs = isFinite(g.startMs) ? g.startMs : today.getTime();
      const endMs = g.endMs > 0 ? g.endMs : now.getTime();

      const cashierCredit = Util.roundMoney(g.cashierCredit);
      const cashierDebit  = Util.roundMoney(g.cashierDebit);
      const cashierCard   = Util.roundMoney(cashierCredit + cashierDebit);

      const clover = Clover.isEnabled()
        ? Clover.getCardTotals(g.merchant, startMs, endMs)
        : { ok: false, error: 'disabled' };
      const cloverCredit = clover.ok ? clover.credit : 0;
      const cloverDebit  = clover.ok ? clover.debit  : 0;
      const cloverCard   = clover.ok ? clover.total  : 0;
      const cardDiff = Util.roundMoney(cashierCard - cloverCard);

      const status = !clover.ok ? 'clover_unavailable'
        : (Math.abs(cardDiff) <= threshold ? 'OK' : 'investigate');

      const rec = {
        merchant: g.merchant.merchantId || '(not configured)',
        companies: Object.keys(g.companies),
        windowStart: new Date(startMs),
        windowEnd: new Date(endMs),
        sessionIds: g.sessionIds.slice(),
        cashierCredit: cashierCredit, cloverCredit: cloverCredit, creditDiff: Util.roundMoney(cashierCredit - cloverCredit),
        cashierDebit: cashierDebit, cloverDebit: cloverDebit, debitDiff: Util.roundMoney(cashierDebit - cloverDebit),
        cashierCard: cashierCard, cloverCard: cloverCard, cardDiff: cardDiff,
        cashCounted: Util.roundMoney(g.cashCounted),
        cashVariance: Util.roundMoney(g.cashVariance),
        cloverOk: !!clover.ok,
        cloverError: clover.ok ? '' : (clover.error || ''),
        status: status,
      };
      merchants.push(rec);
      writeRow_(today, rec, mode, actorId, now);
    });

    const message = formatMessage_(today, merchants);
    let whatsapp = { sent: false, reason: 'not_attempted' };
    try { whatsapp = sendNotifications_(today, merchants); } catch (e) { whatsapp = { sent: false, reason: 'exception', detail: e.message }; }

    AuditLog.write({
      actorId: actorId || 'SYSTEM',
      action: 'reconcile.day',
      targetType: 'validation_results',
      targetId: dateStr,
      details: 'mode=' + mode + '; ' + message.replace(/\n/g, ' | '),
    });

    return { ready: true, mode: mode, date: dateStr, merchants: merchants, whatsapp: whatsapp };
  }

  function writeRow_(dateObj, rec, mode, actorId, now) {
    const sh = sheet_();
    const row = sh.getLastRow() + 1;
    sh.getRange(row, 1, 1, NUM_COLS).setValues([[
      Util.newId('VR'),
      dateObj, rec.windowStart, rec.windowEnd,
      rec.merchant, rec.companies.join('+'),
      rec.cashierCredit, rec.cloverCredit, rec.cashierDebit, rec.cloverDebit,
      rec.cashierCard, rec.cloverCard, rec.cardDiff,
      rec.cashCounted, rec.cashVariance, rec.status, mode,
      rec.sessionIds.join(','), now, actorId || 'SYSTEM',
    ]]);
  }

  // One templated message per merchant group (usually just one: cstore+vape
  // combined). Falls back to per-group plain text when no shift_close
  // template is configured. Aggregates the per-group send results.
  function sendNotifications_(dateObj, merchants) {
    let anySent = false;
    const perGroup = [];
    merchants.forEach(m => {
      const params = reconParams_(dateObj, m);
      const plain = formatMessage_(dateObj, [m]);
      let r;
      try { r = Notifier.sendOp('shift_close', params, plain); }
      catch (e) { r = { sent: false, reason: 'exception', detail: e.message }; }
      if (r && r.sent) anySent = true;
      perGroup.push(r);
    });
    return { sent: anySent, perGroup: perGroup };
  }

  // The 9 ordered params for the shift_close template (matches the Setup
  // config note). All single-line scalars — the template owns the layout.
  function reconParams_(dateObj, m) {
    const friendly = Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'EEE d MMM yyyy');
    const windowStr = hhmm_(m.windowStart) + '–' + hhmm_(m.windowEnd);
    const companies = m.companies.join(' + ');
    let credit, debit, total, status;
    if (m.cloverOk) {
      credit = Util.formatMoney(m.cashierCredit) + ' / ' + Util.formatMoney(m.cloverCredit) + ' (' + signed_(m.creditDiff) + ') ' + mark_(m.creditDiff);
      debit  = Util.formatMoney(m.cashierDebit) + ' / ' + Util.formatMoney(m.cloverDebit) + ' (' + signed_(m.debitDiff) + ') ' + mark_(m.debitDiff);
      total  = Util.formatMoney(m.cashierCard) + ' / ' + Util.formatMoney(m.cloverCard) + ' (' + signed_(m.cardDiff) + ') ' + mark_(m.cardDiff);
      status = m.status === 'OK' ? '✅ All matched' : '⚠️ Review needed';
    } else {
      credit = Util.formatMoney(m.cashierCredit) + ' (no Clover)';
      debit  = Util.formatMoney(m.cashierDebit) + ' (no Clover)';
      total  = Util.formatMoney(m.cashierCard) + ' (no Clover)';
      status = '⚠️ Clover unavailable';
    }
    return [
      friendly, companies, windowStr,
      Util.formatMoney(m.cashCounted), signed_(m.cashVariance),
      credit, debit, total, status,
    ];
  }

  function formatMessage_(dateObj, merchants) {
    const friendly = Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'EEE d MMM yyyy');

    const lines = ['🧾 *Shift Reconciliation*', '📅 ' + friendly, ''];
    merchants.forEach(m => {
      lines.push('🏪 *' + m.companies.join(' + ') + '*   ⏰ ' + hhmm_(m.windowStart) + '–' + hhmm_(m.windowEnd));
      lines.push('');
      lines.push('💵 *Cash*');
      lines.push('Counted   ' + Util.formatMoney(m.cashCounted));
      lines.push('Variance  ' + signed_(m.cashVariance));
      lines.push('');
      if (m.cloverOk) {
        lines.push('💳 *Cards — cashier vs Clover*');
        lines.push('Credit  ' + Util.formatMoney(m.cashierCredit) + ' / ' + Util.formatMoney(m.cloverCredit) + '   ' + signed_(m.creditDiff) + ' ' + mark_(m.creditDiff));
        lines.push('Debit   ' + Util.formatMoney(m.cashierDebit) + ' / ' + Util.formatMoney(m.cloverDebit) + '   ' + signed_(m.debitDiff) + ' ' + mark_(m.debitDiff));
        lines.push('Total   ' + Util.formatMoney(m.cashierCard) + ' / ' + Util.formatMoney(m.cloverCard) + '   ' + signed_(m.cardDiff) + ' ' + mark_(m.cardDiff));
        lines.push('');
        lines.push(m.status === 'OK' ? '✅ *All matched*' : '⚠️ *Review needed*');
      } else {
        lines.push('💳 *Cards*');
        lines.push('Cashier total  ' + Util.formatMoney(m.cashierCard));
        lines.push('⚠️ Clover unavailable');
      }
      lines.push('');
    });
    lines.push('_StoreOps · automated_');
    return lines.join('\n').trim();
  }

  /**
   * Recent reconciliations for the dashboard — newest first, capped at
   * `limit` rows. One row per shift (auto) or whole-day check (manual).
   */
  function getRecent_(limit) {
    limit = limit || 60;
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last < DATA_START_ROW) return [];
    const data = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS).getValues();
    const toIso = d => d instanceof Date ? d.toISOString() : null;
    return data
      .filter(r => (r[COL.validation_id - 1] || '').toString())
      .map(r => ({
        businessDate: r[COL.business_date - 1] instanceof Date ? Util.formatDate(r[COL.business_date - 1]) : (r[COL.business_date - 1] || '').toString(),
        windowStart:  toIso(r[COL.window_start - 1]),
        windowEnd:    toIso(r[COL.window_end - 1]),
        merchant:     (r[COL.merchant - 1] || '').toString(),
        companies:    (r[COL.companies - 1] || '').toString(),
        cashierCredit: Number(r[COL.cashier_credit - 1]) || 0,
        cloverCredit:  Number(r[COL.clover_credit - 1]) || 0,
        cashierDebit:  Number(r[COL.cashier_debit - 1]) || 0,
        cloverDebit:   Number(r[COL.clover_debit - 1]) || 0,
        cashierCard:   Number(r[COL.cashier_card - 1]) || 0,
        cloverCard:    Number(r[COL.clover_card - 1]) || 0,
        cardVariance:  Number(r[COL.card_variance - 1]) || 0,
        cashCounted:   Number(r[COL.cash_counted - 1]) || 0,
        cashVariance:  Number(r[COL.cash_variance - 1]) || 0,
        status:       (r[COL.status - 1] || '').toString(),
        mode:         (r[COL.mode - 1] || '').toString(),
        validatedAt:   toIso(r[COL.validated_at - 1]),
        validatedBy:  (r[COL.validated_by - 1] || '').toString(),
        _ts:           r[COL.validated_at - 1] instanceof Date ? r[COL.validated_at - 1].getTime() : 0,
      }))
      .sort((a, b) => b._ts - a._ts)
      .slice(0, limit)
      .map(r => { delete r._ts; return r; });
  }

  return {
    reconcileDay: reconcileDay_,
    getRecent: getRecent_,
    hasOpenSessionsToday: hasOpenSessionsToday_,
  };
})();
