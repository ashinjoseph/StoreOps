// ============================================================
//  ui-no-rate — a day worked with no pay rate reads "no rate set", not $0 (card P4-11b)
// ============================================================
//  In the Operations app a blank hourly rate reaches the page as null, and the
//  pay answers ADD `noRateDays` / `noRateDayCount` for days worked with no rate
//  (ADR-0031). My Pay and Payroll say "no rate set" for them, list them, and
//  say what the totals leave out. Apps Script never sends either (a blank rate
//  is 0 there), so inside Apps Script every pay screen and the Schedule cell
//  sheet must render byte-identically to a frozen copy of the functions as
//  they were before this card (commit 91f8df5), for every role and every
//  answer the old app can send, and even for an answer it cannot send.
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./_lib/harness');
const t = H.suite('A day with no pay rate reads "no rate set", not $0; Apps Script renders as before');

const FROZEN = fs.readFileSync(path.join(__dirname, '_lib', 'pay-screens-before-p411b.txt'), 'utf8');
const FROZEN_NAMES = ['renderMyPayTab', 'renderPayrollTab', 'renderPayShiftsForm', 'editScheduleCell'];

const NEEDED = ['esc', 'money', 'fmtDate', 'isOpsApp_', 'moreBack', 'torontoWall_', 'torontoToday_', 'scheduleCellOffers_',
  'noRateSet_', 'payRateText_', 'noRateDaysOf_', 'dayCount_', 'noRateHours_', 'payrollNoRateHTML_',
  'renderMyPayTab', 'renderPayrollTab', 'renderPayShiftsForm', 'editScheduleCell'];

const ROLES = ['admin', 'manager', 'payroll_admin', 'employee'];
const HOSTILE = '<img src=x onerror="alert(1)">';

// ── Answers the old app can send (a blank rate arrives as 0) ──
const shift = o => Object.assign({ attendanceId: 'A_20260915_S_003', date: '2026-09-15T04:00:00.000Z', dateStr: '2026-09-15', hoursWorked: 6.5, rate: 17.6, value: 114.4, paid: 0, remaining: 114.4, scheduledHours: 0, actualHours: 0, hoursBasis: '', mismatch: false }, o || {});
const bonus = o => Object.assign({ bonusId: 'B_1', type: 'commission', amount: 52.32, paid: 0, remaining: 52.32, date: '2026-09-14T04:00:00.000Z', dateStr: '2026-09-14', reason: 'Weekly commission', company: 'vape' }, o || {});
const MYPAY = {
  'a rate, two shifts (one part paid), a bonus': { staffId: 'S_003', staffName: 'Maya Chen', hourlyRate: 17.6, shiftsOwed: 214.4, bonusesOwed: 52.32, totalOwed: 266.72, unpaidShifts: [shift(), shift({ attendanceId: 'A_20260916_S_003', dateStr: '2026-09-16', hoursWorked: 8.25, value: 145.2, paid: 45.2, remaining: 100 })], pendingBonuses: [bonus()] },
  'the admin at a real 0': { staffId: 'S_001', staffName: 'Priya Nair', hourlyRate: 0, shiftsOwed: 0, bonusesOwed: 0, totalOwed: 0, unpaidShifts: [], pendingBonuses: [] },
  'a blank rate, as the old app sends it (0), with days at 0 that are owed nothing': { staffId: 'S_009', staffName: 'Ravi Shore', hourlyRate: 0, shiftsOwed: 0, bonusesOwed: 0, totalOwed: 0, unpaidShifts: [], pendingBonuses: [] },
  'hostile text': { staffId: 'S_003', staffName: HOSTILE, hourlyRate: 18, shiftsOwed: 10, bonusesOwed: 1, totalOwed: 11, unpaidShifts: [shift({ dateStr: HOSTILE, value: 10, remaining: 10 })], pendingBonuses: [bonus({ reason: HOSTILE, company: HOSTILE, type: HOSTILE })] },
};
const person = o => Object.assign({ staffId: 'S_003', staffName: 'Maya Chen', hourlyRate: 17.6, shiftsOwed: 214.4, bonusesOwed: 52.32, totalOwed: 266.72, unpaidShiftCount: 2, pendingBonusCount: 1, hasMismatch: false, mismatchCount: 0 }, o || {});
const OVERVIEW = {
  'everyone, with a 0 rate, a mismatch and nothing owed': [
    person({ staffId: 'S_001', staffName: 'Priya Nair', hourlyRate: 0, shiftsOwed: 0, bonusesOwed: 0, totalOwed: 0, unpaidShiftCount: 0, pendingBonusCount: 0 }),
    person({ staffId: 'S_002', staffName: 'Daniel Okafor', hourlyRate: 19.5, shiftsOwed: 0, bonusesOwed: 120, totalOwed: 120, unpaidShiftCount: 0 }),
    person(),
    person({ staffId: 'S_005', staffName: 'Sam Patel', hourlyRate: 17.2, hasMismatch: true, mismatchCount: 1, bonusesOwed: 0, totalOwed: 214.4, pendingBonusCount: 0 }),
    person({ staffId: 'S_009', staffName: 'Ravi Shore', hourlyRate: 0, shiftsOwed: 0, bonusesOwed: 0, totalOwed: 0, unpaidShiftCount: 0, pendingBonusCount: 0 }),
  ],
  'nobody': [],
  'hostile text': [person({ staffId: HOSTILE, staffName: HOSTILE })],
};
const OWED = { staffId: 'S_003', shiftsOwed: 214.4, bonusesOwed: 52.32, totalOwed: 266.72, unpaidShifts: MYPAY['a rate, two shifts (one part paid), a bonus'].unpaidShifts, pendingBonuses: [bonus()], hasMismatch: false, mismatchCount: 0 };
const WEEK = {
  weekStart: '2026-09-14', weekEnd: '2026-09-20', days: [],
  staff: [{ staffId: 'S_003', name: 'Maya Chen' }, { staffId: 'S_009', name: HOSTILE }],
  cells: [
    { staffId: 'S_003', staffName: 'Maya Chen', date: '2026-09-15', attendanceId: 'A_20260915_S_003', status: 'worked', scheduledStart: '09:00', scheduledEnd: '17:00', hoursWorked: 6.5, scheduledHours: 8, actualHours: 6.5, hoursBasis: '' },
    { staffId: 'S_009', staffName: HOSTILE, date: '2026-09-15', attendanceId: 'A_20260915_S_009', status: 'worked', scheduledStart: '', scheduledEnd: '', hoursWorked: 6.5, scheduledHours: 0, actualHours: 6.5, hoursBasis: '' },
    { staffId: 'S_003', staffName: 'Maya Chen', date: '2026-09-21', attendanceId: 'A_20260921_S_003', status: 'scheduled', scheduledStart: '10:00', scheduledEnd: '18:00', hoursWorked: 0, scheduledHours: 8, actualHours: 0, hoursBasis: '' },
  ],
};
const CELLS = [['S_003', '2026-09-15'], ['S_009', '2026-09-15'], ['S_003', '2026-09-21'], ['S_003', '2026-09-22']];

// ── What only the Operations app sends ──
const DAYS = [
  { attendanceId: 'A_20260915_S_007', dateStr: '2026-09-15', hoursWorked: 6.5, paid: 0 },
  { attendanceId: 'A_20260916_S_007', dateStr: '2026-09-16', hoursWorked: 8.25, paid: 0 },
];
const HANA_MY = { staffId: 'S_007', staffName: 'Hana Park', hourlyRate: null, shiftsOwed: 0, bonusesOwed: 0, totalOwed: 0, unpaidShifts: [], pendingBonuses: [], noRateDayCount: 2, noRateDays: DAYS };
const HANA_ROW = person({ staffId: 'S_007', staffName: 'Hana Park', hourlyRate: null, shiftsOwed: 0, bonusesOwed: 0, totalOwed: 0, unpaidShiftCount: 0, pendingBonusCount: 0, noRateDayCount: 2, noRateDays: DAYS });

const pending = [];
H.uiScripts().forEach(([label, js]) => {
  t.section('Against ' + label);
  const lifted = NEEDED.map(n => H.fnSource(js, n)).join('\n\n');

  function world(opts) {
    const els = {};
    const el = id => els[id] || (els[id] = { id, innerHTML: '', textContent: '', value: '', style: {}, disabled: false, onclick: null, dataset: {}, addEventListener() {}, querySelectorAll() { return []; } });
    const w = {
      sheets: [], toasts: [],
      console: { log() {}, error() {}, warn() {} },
      Intl, Date, Math, Number, String, JSON, isNaN, Promise, parseFloat, Object, Array,
      window: opts.ops ? { STOREOPS_APP: 'ops' } : {},
      state: { token: 'tok', me: { role: opts.role || 'admin' } },
      $: el,
      openSheet: spec => { w.sheets.push(spec); el('sheetBody').innerHTML = spec.bodyHTML; el('sheetActions').innerHTML = spec.actionsHTML || ''; },
      closeSheet: () => {}, haptic: () => {}, toast: (m, k) => w.toasts.push([m, k]), confirm: () => true,
      call: async () => ({}), cachedCall: async () => ({}), loadPayrollTab: () => {}, loadScheduleTab: () => {},
      openDayCorrection_: () => {}, openPayShiftsForm: () => {}, openPayBonusList: () => {}, renderPayMismatch_: () => {},
    };
    vm.createContext(w);
    vm.runInContext(lifted, w);
    if (opts.frozen) vm.runInContext(FROZEN, w); // the frozen functions replace the current ones, by name
    w.el = el;
    return w;
  }
  const myPay = (o, data) => { const w = world(o); vm.runInContext('renderMyPayTab', w)(data); return w.el('view-mypay').innerHTML; };
  const payroll = (o, data) => { const w = world(o); vm.runInContext('renderPayrollTab', w)(data); return w.el('view-payroll').innerHTML; };
  const payForm = (o, owed, staff) => { const w = world(o); vm.runInContext('renderPayShiftsForm', w)(owed, staff); const s = w.sheets[0] || {}; return JSON.stringify([s.title, s.subtitle, s.bodyHTML, s.actionsHTML]); };
  const cell = (o, staffId, date) => { const w = world(o); vm.runInContext('editScheduleCell', w)(staffId, date, WEEK); const s = w.sheets[0] || {}; return JSON.stringify([s.title, s.subtitle, s.bodyHTML, s.actionsHTML]); };

  t.ok('the frozen copy names the four functions it replaces', FROZEN_NAMES.every(n => FROZEN.indexOf('function ' + n + '(') !== -1));

  // ── Inside Apps Script: byte-identical to the frozen copy ──
  {
    let n = 0, same = 0;
    const check = (name, a, b) => { n++; if (a === b && a.length > 40) same++; else t.ok('Apps Script: ' + name + ' renders as before', false); };
    ROLES.forEach(role => {
      const A = { ops: false, role }, F = { ops: false, role, frozen: true };
      Object.keys(MYPAY).forEach(k => check(role + ' My Pay, ' + k, myPay(A, MYPAY[k]), myPay(F, MYPAY[k])));
      Object.keys(OVERVIEW).forEach(k => check(role + ' Payroll, ' + k, payroll(A, OVERVIEW[k]), payroll(F, OVERVIEW[k])));
      check(role + ' Pay shifts form', payForm(A, OWED, OVERVIEW['everyone, with a 0 rate, a mismatch and nothing owed'][2]), payForm(F, OWED, OVERVIEW['everyone, with a 0 rate, a mismatch and nothing owed'][2]));
      CELLS.forEach(([s, d]) => check(role + ' Schedule cell ' + s + ' ' + d, cell(A, s, d), cell(F, s, d)));
    });
    t.ok('Apps Script: My Pay, Payroll, Pay shifts and the Schedule cell sheet render byte-identically for every role and answer (' + same + ' of ' + n + ')', n === 48 && same === n);

    // An answer the old app never sends (null, the added fields) still renders as it always did there.
    ROLES.forEach(role => {
      const A = { ops: false, role }, F = { ops: false, role, frozen: true };
      check(role + ' My Pay with null and noRateDays', myPay(A, HANA_MY), myPay(F, HANA_MY));
      check(role + ' Payroll with null and noRateDays', payroll(A, [HANA_ROW]), payroll(F, [HANA_ROW]));
      check(role + ' Pay shifts with noRateDays', payForm(A, Object.assign({}, OWED, { noRateDays: DAYS, noRateDayCount: 2 }), HANA_ROW), payForm(F, Object.assign({}, OWED, { noRateDays: DAYS, noRateDayCount: 2 }), HANA_ROW));
    });
    t.ok('Apps Script: even for null and the added fields, nothing new is shown (' + same + ' of ' + n + ')', same === n);
    const html = myPay({ ops: false }, HANA_MY) + payroll({ ops: false }, [HANA_ROW]);
    t.ok('Apps Script: never "no rate set"', html.indexOf('no rate set') === -1 && html.indexOf('not counted') === -1);
  }

  // ── In the Operations app ──
  {
    const O = { ops: true, role: 'admin' }, F = { ops: true, role: 'admin', frozen: true };
    // For people with a rate (or a real 0) the answers are unchanged, and so is the screen.
    t.ok('Operations app: for answers with no blank rate, My Pay and Payroll are as before', Object.keys(MYPAY).every(k => myPay(O, MYPAY[k]) === myPay(F, MYPAY[k])) && Object.keys(OVERVIEW).every(k => payroll(O, OVERVIEW[k]) === payroll(F, OVERVIEW[k])));
    t.ok('Operations app: the Schedule cell sheet is as before', ROLES.every(role => CELLS.every(([s, d]) => cell({ ops: true, role }, s, d) === cell({ ops: true, role, frozen: true }, s, d))));

    const zero = myPay(O, MYPAY['the admin at a real 0']);
    t.ok('Operations app, My Pay: a real 0 reads $0.00/hr', zero.indexOf('$0.00/hr') !== -1 && zero.indexOf('no rate set') === -1);
    const mine = myPay(O, HANA_MY);
    t.ok('Operations app, My Pay: a blank rate reads "no rate set", never $0.00/hr', /Hourly Rate<\/div><div class="sales-total-amount">no rate set</.test(mine) && mine.indexOf('/hr') === -1);
    t.ok('Operations app, My Pay: the no-rate days are listed with their dates and hours', mine.indexOf('Days worked with no rate set (2)') !== -1 && mine.indexOf('2026-09-15') !== -1 && mine.indexOf('6.50h') !== -1 && mine.indexOf('2026-09-16') !== -1 && mine.indexOf('8.25h') !== -1);
    const rows = (mine.match(/<div class="mypay-row">[\s\S]*?<\/div><\/div>/g) || []);
    t.ok('Operations app, My Pay: "no rate set" where the rate and the value would be, never $0.00', rows.length === 2 && rows.every(r => (r.match(/no rate set/g) || []).length === 3 && r.indexOf('$0.00') === r.lastIndexOf('$0.00')));
    t.ok('Operations app, My Pay: the total says what it leaves out', mine.indexOf('not counted: 2 days with no rate') !== -1 && mine.indexOf('Every shift with a rate set has been paid in full.') !== -1);

    const over = payroll(O, [person(), HANA_ROW]);
    t.ok('Operations app, Payroll: a blank rate reads "no rate set"; a rate reads as before', over.indexOf('<div class="payroll-rate">no rate set</div>') !== -1 && over.indexOf('<div class="payroll-rate">$17.60/hr</div>') !== -1);
    t.ok('Operations app, Payroll: the card says "2 days worked with no rate set" with the dates and hours', over.indexOf('2 days worked with no rate set') !== -1 && over.indexOf('6.50h · no rate set') !== -1 && over.indexOf('8.25h · no rate set') !== -1);
    t.ok('Operations app, Payroll: and how to fix it', over.indexOf('Nothing can be paid for them until a rate is set. Set Hana Park\'s rate on the Staff screen, with \'also apply to unpaid days from\' 2026-09-15.') !== -1);
    t.ok('Operations app, Payroll: the total owed leaves them out and says so', over.indexOf('$266.72') !== -1 && over.indexOf('not counted: 2 days with no rate') !== -1);
    t.ok('Operations app, Payroll: no Pay Shifts for a no-rate-only person, and not "All settled"', over.indexOf('data-pay-shifts="S_007"') === -1 && over.indexOf('Rate needed') !== -1 && over.indexOf('All settled') === -1);
    const zeroRow = payroll(O, [OVERVIEW['everyone, with a 0 rate, a mismatch and nothing owed'][0]]);
    t.ok('Operations app, Payroll: a real 0 reads $0.00/hr', zeroRow.indexOf('<div class="payroll-rate">$0.00/hr</div>') !== -1 && zeroRow.indexOf('no rate set') === -1);

    const form = payForm(O, Object.assign({}, OWED, { noRateDayCount: 1, noRateDays: [DAYS[0]] }), person());
    t.ok('Operations app, Pay shifts: the days not counted are named', form.indexOf('Not counted: 1 day worked with no rate set (2026-09-15). They are not paid until a rate is set.') !== -1);

    // Hostile text from the server is escaped.
    const evil = [{ attendanceId: 'A_x', dateStr: HOSTILE, hoursWorked: null, paid: 0 }];
    const h = myPay(O, Object.assign({}, HANA_MY, { noRateDays: evil, noRateDayCount: 1 })) + payroll(O, [person({ staffId: HOSTILE, staffName: HOSTILE, hourlyRate: null, noRateDays: evil, noRateDayCount: 1, totalOwed: 0, shiftsOwed: 0, bonusesOwed: 0 })]) +
      payForm(O, Object.assign({}, OWED, { noRateDays: evil, noRateDayCount: 1 }), person());
    t.ok('Operations app: hostile text is escaped in the lists, the fix sentence and the form', h.indexOf('<img') === -1 && h.indexOf('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;') !== -1);
    t.ok('Operations app: blank hours read "hours not recorded"', h.indexOf('hours not recorded') !== -1);

    // The pay toast names the days skipped.
    const w = world(O);
    w.call = async () => ({ summary: { fullyPaidCount: 2, partialCount: 0 }, skippedNoRate: [DAYS[0]] });
    vm.runInContext('renderPayShiftsForm', w)(Object.assign({}, OWED, { noRateDays: [DAYS[0]], noRateDayCount: 1 }), person());
    w.el('payAmount').value = '214.40';
    pending.push(w.el('paySubmitBtn').onclick().then(() => {
      t.ok('Operations app (' + label + '), Pay shifts: the toast says the no-rate day was not paid', w.toasts.length === 1 && w.toasts[0][0].indexOf('1 day with no rate not paid') !== -1);
    }));
  }
});

Promise.all(pending).then(() => t.done()).catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
