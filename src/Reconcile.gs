// ============================================================
//  Reconcile.gs — end-of-day cashier vs Clover reconciliation
// ============================================================
//  Runs when no till sessions remain open for the day (auto, after a
//  close) or on demand (manual button). Sums the day's cashier-entered
//  card totals (cstore+vape), groups companies by Clover merchant,
//  pulls Clover's card totals, computes variances, writes a
//  validation_results row per merchant, and sends a WhatsApp summary.
//
//  Group-by-merchant: companies sharing a merchant_id reconcile
//  together. Splitting into two merchants later is config-only.
// ============================================================

const Reconcile = (() => {

  const COL = {
    validation_id: 1, business_date: 2, merchant: 3, companies: 4,
    cashier_credit: 5, clover_credit: 6, cashier_debit: 7, clover_debit: 8,
    cashier_card: 9, clover_card: 10, card_variance: 11,
    cash_counted: 12, cash_variance: 13, status: 14, mode: 15,
    validated_at: 16, validated_by: 17
  };
  const NUM_COLS = 17;
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

  function hasOpenSessionsToday_() {
    const today = Util.todayMidnight();
    const sessions = TillSessions.getForDateRange(today, Util.endOfDay(today)) || [];
    return sessions.some(s => s.status === 'open');
  }

  /**
   * Reconcile the current business day.
   * @param actorId staffId triggering it
   * @param mode 'auto' (post-close) | 'manual' (button)
   * @returns { ready:false, openCount } | { ready:true, empty:true }
   *        | { ready:true, mode, date, merchants:[...], whatsapp:{sent} }
   */
  function reconcileDay_(actorId, mode) {
    // Auto path stays dormant until Clover is enabled (no noise for stores
    // that haven't adopted it). Manual runs regardless (lets you test).
    if (mode !== 'manual' && !Clover.isEnabled()) {
      return { ready: false, disabled: true };
    }

    const today = Util.todayMidnight();
    const todayEnd = Util.endOfDay(today);
    const sessions = TillSessions.getForDateRange(today, todayEnd) || [];

    // Auto path: do nothing while any till is still open.
    const openCount = sessions.filter(s => s.status === 'open').length;
    if (mode !== 'manual' && openCount > 0) {
      return { ready: false, openCount: openCount };
    }

    const closed = sessions.filter(s => s.status === 'closed' || s.status === 'validated');

    // Card per company (from sales rows); cash per company (from sessions).
    const sales = Sales.getForDateRange(today, todayEnd, null) || [];
    const cardByCompany = {};
    sales.forEach(r => {
      const c = r.company || 'cstore';
      if (!cardByCompany[c]) cardByCompany[c] = { credit: 0, debit: 0 };
      cardByCompany[c].credit += (r.creditCardSales || 0) + (r.miscCreditSales || 0);
      cardByCompany[c].debit  += (r.debitCardSales || 0) + (r.miscDebitSales || 0);
    });
    const cashByCompany = {};
    closed.forEach(s => {
      const c = s.company || 'cstore';
      if (!cashByCompany[c]) cashByCompany[c] = { counted: 0, variance: 0 };
      cashByCompany[c].counted  += s.closingCashCounted || 0;
      cashByCompany[c].variance += s.closingVariance || 0;
    });

    // Group companies by Clover merchant.
    const groups = {};
    COMPANIES.forEach(company => {
      const card = cardByCompany[company];
      const cash = cashByCompany[company];
      if (!card && !cash) return;  // no activity today
      const m = Clover.merchantFor(company);
      const key = m.merchantId || ('NOCONFIG:' + company);
      if (!groups[key]) groups[key] = {
        merchant: m, companies: [],
        cashierCredit: 0, cashierDebit: 0, cashCounted: 0, cashVariance: 0,
      };
      groups[key].companies.push(company);
      if (card) { groups[key].cashierCredit += card.credit; groups[key].cashierDebit += card.debit; }
      if (cash) { groups[key].cashCounted += cash.counted; groups[key].cashVariance += cash.variance; }
    });

    if (Object.keys(groups).length === 0) return { ready: true, empty: true };

    const threshold = Number(configValue_('card_variance_threshold', 1)) || 1;
    const now = new Date();
    const dateStr = Util.formatDate(today);
    const merchants = [];

    Object.keys(groups).forEach(key => {
      const g = groups[key];
      const cashierCredit = Util.roundMoney(g.cashierCredit);
      const cashierDebit  = Util.roundMoney(g.cashierDebit);
      const cashierCard   = Util.roundMoney(cashierCredit + cashierDebit);

      const clover = Clover.isEnabled()
        ? Clover.getCardTotalsForDay(g.merchant, today)
        : { ok: false, error: 'disabled' };
      const cloverCredit = clover.ok ? clover.credit : 0;
      const cloverDebit  = clover.ok ? clover.debit  : 0;
      const cloverCard   = clover.ok ? clover.total  : 0;
      const cardDiff = Util.roundMoney(cashierCard - cloverCard);

      let status;
      if (!clover.ok) status = 'clover_unavailable';
      else status = Math.abs(cardDiff) <= threshold ? 'OK' : 'investigate';

      const rec = {
        merchant: g.merchant.merchantId || '(not configured)',
        companies: g.companies.slice(),
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

    const message = formatMessage_(dateStr, merchants);
    let whatsapp = { sent: false, reason: 'not_attempted' };
    try { whatsapp = Notifier.sendWhatsApp(message); } catch (e) { whatsapp = { sent: false, reason: 'exception', detail: e.message }; }

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
      dateObj,
      rec.merchant,
      rec.companies.join('+'),
      rec.cashierCredit, rec.cloverCredit, rec.cashierDebit, rec.cloverDebit,
      rec.cashierCard, rec.cloverCard, rec.cardDiff,
      rec.cashCounted, rec.cashVariance, rec.status, mode, now, actorId || 'SYSTEM',
    ]]);
  }

  function formatMessage_(dateStr, merchants) {
    const lines = ['🧾 Daily Close — ' + dateStr, ''];
    merchants.forEach(m => {
      const who = m.companies.join('+');
      const mtag = (m.merchant && m.merchant !== '(not configured)') ? ' (merchant ' + m.merchant + ')' : '';
      lines.push('— ' + who + mtag + ' —');
      lines.push('Cash counted ' + Util.formatMoney(m.cashCounted) + ', variance ' + signed_(m.cashVariance));
      if (m.cloverOk) {
        lines.push('Credit: cashier ' + Util.formatMoney(m.cashierCredit) + ' vs Clover ' + Util.formatMoney(m.cloverCredit) + ' (' + signed_(m.creditDiff) + ')');
        lines.push('Debit:  cashier ' + Util.formatMoney(m.cashierDebit) + ' vs Clover ' + Util.formatMoney(m.cloverDebit) + ' (' + signed_(m.debitDiff) + ')');
        lines.push('Total:  cashier ' + Util.formatMoney(m.cashierCard) + ' vs Clover ' + Util.formatMoney(m.cloverCard) + ' (' + signed_(m.cardDiff) + ')' + (m.status === 'OK' ? ' ✓' : ' ⚠️'));
      } else {
        lines.push('Card (cashier) ' + Util.formatMoney(m.cashierCard) + ' — Clover unavailable (' + (m.cloverError || '') + ')');
      }
      lines.push('');
    });
    return lines.join('\n').trim();
  }

  /**
   * Recent reconciliations for the dashboard history table — the latest run
   * per (business_date, merchant), newest date first, capped at `limit` rows.
   */
  function getRecent_(limit) {
    limit = limit || 60;
    const sh = sheet_();
    const last = sh.getLastRow();
    if (last < DATA_START_ROW) return [];
    const data = sh.getRange(DATA_START_ROW, 1, last - DATA_START_ROW + 1, NUM_COLS).getValues();

    const latest = {};  // 'date|merchant' -> { ts, rec }
    data.forEach(r => {
      if (!(r[COL.validation_id - 1] || '').toString()) return;
      const bd = r[COL.business_date - 1] instanceof Date
        ? Util.formatDate(r[COL.business_date - 1])
        : (r[COL.business_date - 1] || '').toString();
      const merchant = (r[COL.merchant - 1] || '').toString();
      const ts = r[COL.validated_at - 1] instanceof Date ? r[COL.validated_at - 1].getTime() : 0;
      const key = bd + '|' + merchant;
      if (latest[key] && ts <= latest[key].ts) return;
      latest[key] = { ts: ts, rec: {
        businessDate: bd,
        merchant: merchant,
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
        validatedAt:   ts ? new Date(ts).toISOString() : null,
        validatedBy:  (r[COL.validated_by - 1] || '').toString(),
      }};
    });

    return Object.keys(latest)
      .map(k => latest[k].rec)
      .sort((a, b) => (a.businessDate < b.businessDate ? 1 : (a.businessDate > b.businessDate ? -1 : 0)))
      .slice(0, limit);
  }

  return {
    reconcileDay: reconcileDay_,
    getRecent: getRecent_,
    hasOpenSessionsToday: hasOpenSessionsToday_,
  };
})();
