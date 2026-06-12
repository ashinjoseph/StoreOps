// ============================================================
//  Util.gs — date/ID/money/parsing helpers (no sheet access)
// ============================================================

const Util = (() => {

  function tz_() {
    return Session.getScriptTimeZone();
  }

  // ── Date helpers ────────────────────────────────────────
  function todayMidnight_() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function endOfDay_(d) {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  }

  function formatDate_(d) {
    return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd');
  }

  function formatDateTime_(d) {
    return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd HH:mm:ss');
  }

  function parseDate_(yyyyMmDd) {
    if (!yyyyMmDd) return null;
    if (yyyyMmDd instanceof Date) return yyyyMmDd;
    return new Date(yyyyMmDd + 'T00:00:00');
  }

  function addDays_(d, days) {
    const x = new Date(d);
    x.setDate(x.getDate() + days);
    return x;
  }

  function getMondayOf_(d) {
    const x = new Date(d);
    const dow = x.getDay();
    const diff = dow === 0 ? -6 : 1 - dow;
    x.setDate(x.getDate() + diff);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  /**
   * Get the Monday→Sunday window for "last week" relative to `now`.
   * Used by the commission engine.
   */
  function getPreviousWeekRange_(now) {
    const ref = now || new Date();
    const thisMonday = getMondayOf_(ref);
    const lastMonday = addDays_(thisMonday, -7);
    const lastSunday = endOfDay_(addDays_(lastMonday, 6));
    return { start: lastMonday, end: lastSunday };
  }

  /**
   * Compute hours between two Date objects.
   */
  function diffHours_(start, end) {
    if (!start || !end) return 0;
    const ms = end.getTime() - start.getTime();
    return Math.max(0, ms / (1000 * 60 * 60));
  }

  // ── ID generation ───────────────────────────────────────
  function newId_(prefix) {
    const stamp = Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd_HHmmss');
    const rand = Math.random().toString(36).substring(2, 5);
    return prefix + '_' + stamp + '_' + rand;
  }

  /**
   * Deterministic attendance ID: same date+staff always produces the same ID.
   * Lets re-imports and idempotent creates work safely.
   */
  function attendanceId_(dateObj, staffId) {
    const stamp = Utilities.formatDate(dateObj, tz_(), 'yyyyMMdd');
    return 'A_' + stamp + '_' + staffId;
  }

  function tillSessionId_(dateObj, staffId, company) {
    const prefix = company === 'cstore' ? 'CST' : 'VAP';
    const stamp = Utilities.formatDate(dateObj, tz_(), 'yyyyMMdd');
    return prefix + '-' + stamp + '-' + staffId;
  }

  function newToken_() {
    return Utilities.getUuid().replace(/-/g, '');
  }

  function newLoginCode_(digits) {
    digits = digits || 4;
    let code = '';
    for (let i = 0; i < digits; i++) {
      code += Math.floor(Math.random() * 10);
    }
    return code;
  }

  // ── Money ───────────────────────────────────────────────
  function roundMoney_(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function moneyEquals_(a, b, tolerance) {
    return Math.abs((Number(a) || 0) - (Number(b) || 0)) < (tolerance || 0.005);
  }

  function formatMoney_(n) {
    return '$' + (Number(n) || 0).toFixed(2);
  }

  // ── Time-of-day parsing (for custom shift entry) ────────
  /**
   * Parse a time-range string like "9am-5pm", "5:30pm-11pm", "5.30pm-11pm".
   * Returns { startHour, startMin, endHour, endMin, hours } or null.
   */
  function parseTimeRange_(value) {
    const v = (value || '').toString().toLowerCase().trim();
    if (!v) return null;

    const rx = /^(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|a|p)?\s*(?:[-–—]+|to|until|till)\s*(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm|a|p)?$/i;
    const m = v.match(rx);
    if (!m) return null;

    let sh = +m[1], sm = m[2] ? +m[2] : 0;
    let eh = +m[4], em = m[5] ? +m[5] : 0;
    let sp = (m[3] || '').toLowerCase().replace(/^a$/, 'am').replace(/^p$/, 'pm');
    let ep = (m[6] || '').toLowerCase().replace(/^a$/, 'am').replace(/^p$/, 'pm');

    if (sm > 59 || em > 59) return null;
    if (sh > 23 || eh > 23) return null;
    if (!sp && !ep) return null;

    if (!sp && ep) sp = (ep === 'pm' && sh < eh) ? 'am' : ep;

    if (sp === 'pm' && sh !== 12) sh += 12;
    if (sp === 'am' && sh === 12) sh = 0;
    if (ep === 'pm' && eh !== 12) eh += 12;
    if (ep === 'am' && eh === 12) eh = 0;

    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (endMin <= startMin) return null;

    return {
      startHour: sh, startMin: sm,
      endHour: eh, endMin: em,
      hours: (endMin - startMin) / 60,
    };
  }

  function formatTimeHHMM_(hour, min) {
    const h = String(hour).padStart(2, '0');
    const m = String(min || 0).padStart(2, '0');
    return h + ':' + m;
  }

  return {
    todayMidnight: todayMidnight_,
    endOfDay: endOfDay_,
    formatDate: formatDate_,
    formatDateTime: formatDateTime_,
    parseDate: parseDate_,
    addDays: addDays_,
    getMondayOf: getMondayOf_,
    getPreviousWeekRange: getPreviousWeekRange_,
    diffHours: diffHours_,
    newId: newId_,
    attendanceId: attendanceId_,
    tillSessionId: tillSessionId_,
    newToken: newToken_,
    newLoginCode: newLoginCode_,
    roundMoney: roundMoney_,
    moneyEquals: moneyEquals_,
    formatMoney: formatMoney_,
    parseTimeRange: parseTimeRange_,
    formatTimeHHMM: formatTimeHHMM_,
  };
})();
