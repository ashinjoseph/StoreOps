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
    session_ids: 18, validated_at: 19, validated_by: 20, cash_sales: 21
  };
  const NUM_COLS = 21;
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
        cashierCredit: 0, cashierDebit: 0, cashSales: 0,
        cashCounted: 0, cashVariance: 0, openingFloat: 0,
        cashBanked: 0, floatLeft: 0, lottoTopup: 0,
        tookCash: {}, staff: {},
        startMs: Infinity, endMs: 0,
      };
      const g = groups[key];
      g.companies[s.company] = true;
      g.sessionIds.push(s.sessionId);
      g.staff[s.staffId] = true;
      // Who walked out with what, today. The standing balance is a separate
      // question (CashHandling answers it); this is just this day's movement.
      if ((s.cashRemovedAtClose || 0) > 0.005) {
        g.tookCash[s.staffId] = Util.roundMoney((g.tookCash[s.staffId] || 0) + s.cashRemovedAtClose);
      }
      const sale = salesById[s.sessionId];
      if (sale) {
        g.cashierCredit += (sale.creditCardSales || 0) + (sale.miscCreditSales || 0);
        g.cashierDebit  += (sale.debitCardSales || 0) + (sale.miscDebitSales || 0);
        g.cashSales     += (sale.cashSales || 0) + (sale.miscCashSales || 0);
      }
      g.cashCounted  += s.closingCashCounted || 0;
      g.cashVariance += s.closingVariance || 0;
      g.openingFloat += s.openingFloat || 0;
      // Where the counted cash went. These are flows, so they add up across
      // sessions — unlike the reserve BALANCE below, which does not.
      g.cashBanked   += s.cashRemovedAtClose || 0;
      g.floatLeft    += s.cashLeftInTill || 0;
      g.lottoTopup   += s.lottoTopupFromTill || 0;
      if (s.startTime instanceof Date) g.startMs = Math.min(g.startMs, s.startTime.getTime());
      if (s.endTime instanceof Date)   g.endMs   = Math.max(g.endMs, s.endTime.getTime());
    });

    const threshold = Number(configValue_('card_variance_threshold', 1)) || 1;
    const now = new Date();
    const dateStr = Util.formatDate(today);
    const merchants = [];

    // The lotto pot is a single balance held by the store, not a per-session
    // flow — summing it across the day's sessions would be meaningless. Read
    // the standing balance once and hang it off whichever merchant group holds
    // cstore. Best-effort: a sheet that hasn't run the lotto migration returns
    // enabled:false and the message drops the section entirely.
    let lotto = null;
    try {
      const log = TillSessions.getLottoLog(14);
      if (log && log.enabled) lotto = log;
    } catch (e) {
      console.error('reconcile: lotto log failed: ' + e.message);
    }

    // Standing cash-in-hand across the whole business, read once. Today's
    // takings say what moved; this says how much is still out, which is the
    // number that should worry someone if it keeps climbing.
    let cashOut = null;
    try {
      if (CashHandling.sheetsExist()) cashOut = CashHandling.getAllOutstanding();
    } catch (e) {
      console.error('reconcile: cash outstanding failed: ' + e.message);
    }

    // staff_id → display name, for the "who worked" line.
    const staffNames = {};
    try {
      Staff.getAll().forEach(st => { staffNames[st.staffId] = st.name; });
    } catch (e) {
      console.error('reconcile: staff names failed: ' + e.message);
    }

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
        cashSales: Util.roundMoney(g.cashSales),
        cashCounted: Util.roundMoney(g.cashCounted),
        cashVariance: Util.roundMoney(g.cashVariance),
        openingFloat: Util.roundMoney(g.openingFloat),
        cashBanked: Util.roundMoney(g.cashBanked),
        floatLeft: Util.roundMoney(g.floatLeft),
        lottoTopup: Util.roundMoney(g.lottoTopup),
        staffNames: Object.keys(g.staff).map(id => staffNames[id] || id).sort(),
        // [{ name, amount }] — who took today's cash out of this till.
        tookCash: Object.keys(g.tookCash)
          .map(id => ({ name: staffNames[id] || id, amount: g.tookCash[id] }))
          .sort((a, b) => b.amount - a.amount),
        // Business-wide, not per-merchant — but it belongs on the message that
        // reports the day's cash, and only needs saying once.
        cashOutTotal: cashOut ? cashOut.grandTotal : null,
        cashOutHolders: cashOut ? cashOut.holders.length : 0,
        cashOutStale: cashOut ? cashOut.stale.length : 0,
        // Only the group that actually holds cstore carries the pot.
        lotto: (lotto && g.companies[TillSessions.lottoCompany]) ? {
          balance:  lotto.lastCounted,
          expected: lotto.expected,
          shortfall: Util.roundMoney(lotto.expected - (lotto.lastCounted || 0)),
          note: (lotto.entries[0] && lotto.entries[0].note) || '',
        } : null,
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
      rec.sessionIds.join(','), now, actorId || 'SYSTEM', rec.cashSales,
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

  // The 9 ordered params for the shift_close template. All single-line
  // scalars - the template owns the layout. Convention: source / local.
  /** Who worked this till today. */
  function staffParam_(m) {
    const names = m.staffNames || [];
    return names.length ? names.join(', ') : 'no staff recorded';
  }

  /**
   * Who is carrying today's takings, and how much is still out overall.
   * Today's movement and the standing balance answer different questions —
   * "did the cash leave" versus "has it ever come back" — so both are here.
   */
  function inHandParam_(m) {
    const took = m.tookCash || [];
    const parts = took.length
      ? took.map(t => t.name + ' ' + Util.formatMoney(t.amount))
      : ['nothing taken out today'];
    if (m.cashOutTotal != null) {
      parts.push(Util.formatMoney(m.cashOutTotal) + ' still out' +
        (m.cashOutHolders ? ' with ' + m.cashOutHolders +
          (m.cashOutHolders === 1 ? ' person' : ' people') : ''));
      if (m.cashOutStale) parts.push('⚠️ ' + m.cashOutStale + ' held over the limit');
    }
    return parts.join(' · ');
  }

  /** The pot, as one line. Fixed templates can't drop a section, so a till
   *  without a reserve says so rather than sending an empty dash. */
  function lottoParam_(m) {
    if (!m.lotto) return 'not tracked on this till';
    const short = Number(m.lotto.shortfall) || 0;
    let s = (m.lotto.balance == null ? 'not counted yet' : Util.formatMoney(m.lotto.balance));
    if ((m.lottoTopup || 0) > 0.01) s += ' (+' + Util.formatMoney(m.lottoTopup) + ' moved in)';
    if (short > 0.01) {
      s += ' - short ' + Util.formatMoney(short);
      if (m.lotto.note) s += ' - ' + m.lotto.note;
    }
    return s;
  }

  /**
   * Body parameters for `whatsapp_template_shift_close`, in template order.
   *
   * THIRTEEN parameters, one idea each. The previous nine crammed the
   * destination, the reserve and the variance into a single cash parameter
   * because the approved template had no room — which made the one line
   * nobody could parse. The static template now owns the layout; every value
   * here is a single fact on a single line.
   *
   * Rules these must satisfy or Meta rejects the send: no newlines, no tabs,
   * no run of 4+ spaces inside a value. flattenForTemplate_ enforces it, but
   * building them clean means it never has to.
   */
  function reconParams_(dateObj, m) {
    const friendly = Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'EEE d MMM yyyy');
    const windowStr = hhmm_(m.windowStart) + '–' + hhmm_(m.windowEnd);
    const companies = m.companies.join(' + ');
    const recorded = Util.roundMoney(m.cashCounted - m.cashVariance);
    const reported = Util.roundMoney(m.cashSales + m.cashierCard);

    const cashLine = Util.formatMoney(recorded) + ' / ' + Util.formatMoney(m.cashCounted) +
      ' (var ' + signed_(m.cashVariance) + ') ' + mark_(m.cashVariance);

    let totalLine, credit, debit, total, status;
    if (m.cloverOk) {
      const expected = Util.roundMoney((m.cashCounted - m.openingFloat) + m.cloverCard);
      const totalDiff = Util.roundMoney(reported - expected);
      totalLine = 'reported ' + Util.formatMoney(reported) + ' / expected ' + Util.formatMoney(expected) + ' (' + signed_(totalDiff) + ') ' + mark_(totalDiff);
      credit = Util.formatMoney(m.cloverCredit) + ' / ' + Util.formatMoney(m.cashierCredit) + ' (' + signed_(m.creditDiff) + ') ' + mark_(m.creditDiff);
      debit  = Util.formatMoney(m.cloverDebit) + ' / ' + Util.formatMoney(m.cashierDebit) + ' (' + signed_(m.debitDiff) + ') ' + mark_(m.debitDiff);
      total  = Util.formatMoney(m.cloverCard) + ' / ' + Util.formatMoney(m.cashierCard) + ' (' + signed_(m.cardDiff) + ') ' + mark_(m.cardDiff);
      status = m.status === 'OK' ? '✅ All matched' : '⚠️ Review needed';
    } else {
      totalLine = 'reported ' + Util.formatMoney(reported) + ' (no Clover)';
      credit = Util.formatMoney(m.cashierCredit) + ' (cashier, no Clover)';
      debit  = Util.formatMoney(m.cashierDebit) + ' (cashier, no Clover)';
      total  = Util.formatMoney(m.cashierCard) + ' (cashier, no Clover)';
      status = '⚠️ Clover unavailable - cards not verified';
    }

    return [
      friendly,            // {{1}}  Sat 15 Aug 2026
      companies,           // {{2}}  cstore + vape
      windowStr,           // {{3}}  09:00–17:20
      staffParam_(m),      // {{4}}  Ashin, Meera
      totalLine,           // {{5}}  reported / expected
      cashLine,            // {{6}}  recorded / counted (var)
      destination_(m),     // {{7}}  float back · reserve · in hand
      inHandParam_(m),     // {{8}}  who carries it, what's still out
      lottoParam_(m),      // {{9}}  pot balance, movement, reason
      credit,              // {{10}}
      debit,               // {{11}}
      total,               // {{12}}
      status,              // {{13}}
    ];
  }

  /**
   * Where the counted cash went, on one line: the float stays in the drawer,
   * any reserve top-up leaves for the pot, and the rest leaves with the
   * cashier. Without this the last figure just drops by the transfer with
   * nothing to explain it.
   *
   * Called "in hand", not "banked" — it isn't banked, it's being carried
   * until it's handed to the cash manager, and CashHandling tracks it from
   * there. Same word on the close sheet and the close notice.
   */
  function destination_(m) {
    const parts = ['float ' + Util.formatMoney(m.floatLeft || 0) + ' back'];
    if ((m.lottoTopup || 0) > 0.01) parts.push('reserve ' + Util.formatMoney(m.lottoTopup));
    parts.push(Util.formatMoney(m.cashBanked || 0) + ' in hand');
    return parts.join(' · ');
  }

  /**
   * The lotto pot, reported every day the store closes — not only on days
   * something moved — so the balance is always on the record. A pot that ends
   * short carries the cashier's reason, which is the only thing that explains
   * a shortfall to someone who wasn't there.
   */
  function reserveLines_(m) {
    if (!m.lotto) return [];
    const l = m.lotto;
    if (l.balance == null) {
      return ['\u{1F39F} *Lotto reserve*   no count on record yet'];
    }
    const short = Number(l.shortfall) || 0;
    const out = ['\u{1F39F} *Lotto reserve*   ' + Util.formatMoney(l.balance) +
      (short > 0.01 ? '   ⚠️ short ' + Util.formatMoney(short) : '')];
    if ((m.lottoTopup || 0) > 0.01) {
      out.push('\u{21B3} ' + Util.formatMoney(m.lottoTopup) + ' moved in from till today');
    }
    if (short > 0.01 && l.note) out.push('\u{21B3} ' + l.note);
    return out;
  }

  function formatMessage_(dateObj, merchants) {
    const friendly = Utilities.formatDate(dateObj, Session.getScriptTimeZone(), 'EEE d MMM yyyy');

    const lines = ['\u{1F9FE} *Shift Reconciliation*', '\u{1F4C5} ' + friendly, ''];
    merchants.forEach(m => {
      lines.push('\u{1F3EA} *' + m.companies.join(' + ') + '*   \u{23F0} ' + hhmm_(m.windowStart) + '–' + hhmm_(m.windowEnd));
      lines.push('\u{1F464} ' + staffParam_(m));
      lines.push('');
      const reported = Util.roundMoney(m.cashSales + m.cashierCard);
      if (m.cloverOk) {
        const expected = Util.roundMoney((m.cashCounted - m.openingFloat) + m.cloverCard);
        const totalDiff = Util.roundMoney(reported - expected);
        lines.push('Σ *Total sales*  reported ' + Util.formatMoney(reported) + ' / expected ' + Util.formatMoney(expected) + '   ' + signed_(totalDiff) + ' ' + mark_(totalDiff));
      } else {
        lines.push('Σ *Total sales*  reported ' + Util.formatMoney(reported) + '   (no Clover)');
      }
      lines.push('');
      lines.push('\u{1F4B5} *Cash - recorded / counted*');
      const recorded = Util.roundMoney(m.cashCounted - m.cashVariance);
      lines.push(Util.formatMoney(recorded) + ' / ' + Util.formatMoney(m.cashCounted) + '   var ' + signed_(m.cashVariance));
      lines.push('\u{21B3} ' + destination_(m));
      lines.push('');
      lines.push('\u{1F91D} *Cash in hand*');
      lines.push('\u{21B3} ' + inHandParam_(m));
      lines.push('');
      const reserve = reserveLines_(m);
      if (reserve.length) { reserve.forEach(l => lines.push(l)); lines.push(''); }
      if (m.cloverOk) {
        lines.push('\u{1F4B3} *Cards - Clover / cashier*');
        lines.push('Credit  ' + Util.formatMoney(m.cloverCredit) + ' / ' + Util.formatMoney(m.cashierCredit) + '   ' + signed_(m.creditDiff) + ' ' + mark_(m.creditDiff));
        lines.push('Debit   ' + Util.formatMoney(m.cloverDebit) + ' / ' + Util.formatMoney(m.cashierDebit) + '   ' + signed_(m.debitDiff) + ' ' + mark_(m.debitDiff));
        lines.push('Total   ' + Util.formatMoney(m.cloverCard) + ' / ' + Util.formatMoney(m.cashierCard) + '   ' + signed_(m.cardDiff) + ' ' + mark_(m.cardDiff));
        lines.push('');
        lines.push(m.status === 'OK' ? '✅ *All matched*' : '⚠️ *Review needed*');
      } else {
        lines.push('\u{1F4B3} *Cards*  cashier ' + Util.formatMoney(m.cashierCard) + '   ⚠️ Clover unavailable');
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
        cashSales:     Number(r[COL.cash_sales - 1]) || 0,
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
