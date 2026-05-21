// ============================================================
//  Clover.gs — Clover REST API client (card totals for a day)
// ============================================================
//  Pulls the day's CARD payments from Clover and sums them by
//  credit / debit / total so we can reconcile against what cashiers
//  entered at close. Isolated + defensive: never throws — returns
//  { ok:false, error } on any failure so reconciliation degrades
//  gracefully and closing is never affected.
//
//  Config (config sheet):
//    clover_enabled, clover_base_url,
//    clover_<company>_merchant_id, clover_<company>_token
// ============================================================

const Clover = (() => {

  function configValue_(key, defaultValue) {
    try {
      const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.CONFIG);
      if (!sh) return defaultValue;
      const data = sh.getRange(3, 1, sh.getLastRow() - 2, 2).getValues();
      const row = data.find(r => r[0] === key);
      return row && row[1] !== '' ? row[1] : defaultValue;
    } catch (e) { return defaultValue; }
  }

  function isEnabled_() {
    const raw = configValue_('clover_enabled', 'false');
    return raw === true || String(raw).toLowerCase() === 'true';
  }

  /**
   * Clover connection for a company. Companies that share a merchant_id
   * are reconciled together (group-by-merchant). To split cstore/vape
   * into two Clover merchants later, just give them different ids/tokens.
   */
  function merchantFor_(company) {
    const baseUrl = configValue_('clover_base_url', 'https://api.clover.com');
    const c = (company === 'vape') ? 'vape' : 'cstore';
    return {
      merchantId: configValue_('clover_' + c + '_merchant_id', ''),
      token:      configValue_('clover_' + c + '_token', ''),
      baseUrl:    baseUrl,
    };
  }

  /**
   * Classify a Clover card payment as credit vs debit.
   * ⚠️ Clover's debit/credit separation depends on the merchant's tender
   * setup and is NOT always reliable. Total-card is the dependable check;
   * credit/debit are best-effort. Tune this one function against a real
   * payments response if the split looks wrong. Unknown card → 'credit'
   * (so credit + debit still equals total).
   */
  function classifyPayment_(p) {
    const tender = (p.tender && (p.tender.labelKey || p.tender.label)) || '';
    const cardTx = (p.cardTransaction && (p.cardTransaction.type || p.cardTransaction.entryType)) || '';
    const blob = (tender + ' ' + cardTx).toString().toLowerCase();
    if (blob.indexOf('debit') !== -1) return 'debit';
    if (blob.indexOf('credit') !== -1) return 'credit';
    return 'credit';
  }

  /**
   * Sum a merchant's CARD payments for one business day.
   * @param merchant { merchantId, token, baseUrl }
   * @param dateMidnight Date (local midnight of the business day)
   * @returns { ok:true, credit, debit, total, count } | { ok:false, error, detail? }
   */
  function getCardTotalsForDay_(merchant, dateMidnight) {
    if (!merchant || !merchant.merchantId || !merchant.token) {
      return { ok: false, error: 'not_configured' };
    }
    const start = dateMidnight.getTime();
    const end = Util.endOfDay(dateMidnight).getTime();
    const base = (merchant.baseUrl || 'https://api.clover.com').replace(/\/+$/, '');
    const limit = 1000;
    let offset = 0, credit = 0, debit = 0, total = 0, count = 0;

    try {
      for (let page = 0; page < 50; page++) {  // hard cap 50k payments/day
        const url = base + '/v3/merchants/' + encodeURIComponent(merchant.merchantId) + '/payments'
          + '?filter=' + encodeURIComponent('createdTime>=' + start)
          + '&filter=' + encodeURIComponent('createdTime<=' + end)
          + '&expand=' + encodeURIComponent('cardTransaction,tender')
          + '&limit=' + limit + '&offset=' + offset;
        const resp = UrlFetchApp.fetch(url, {
          method: 'get',
          headers: { Authorization: 'Bearer ' + merchant.token },
          muteHttpExceptions: true,
        });
        const code = resp.getResponseCode();
        if (code < 200 || code >= 300) {
          return { ok: false, error: 'http_' + code, detail: resp.getContentText().slice(0, 300) };
        }
        const body = JSON.parse(resp.getContentText());
        const els = (body && body.elements) || [];
        els.forEach(p => {
          if (p.result && p.result !== 'SUCCESS') return;  // skip voided/failed
          if (!p.cardTransaction) return;                  // card payments only
          const amt = (Number(p.amount) || 0) / 100;       // cents → dollars
          total += amt;
          if (classifyPayment_(p) === 'debit') debit += amt; else credit += amt;
          count++;
        });
        if (els.length < limit) break;
        offset += limit;
      }
      return {
        ok: true,
        credit: Util.roundMoney(credit),
        debit:  Util.roundMoney(debit),
        total:  Util.roundMoney(total),
        count:  count,
      };
    } catch (e) {
      return { ok: false, error: 'exception', detail: e.message };
    }
  }

  return {
    isEnabled:           isEnabled_,
    merchantFor:         merchantFor_,
    getCardTotalsForDay: getCardTotalsForDay_,
  };
})();
