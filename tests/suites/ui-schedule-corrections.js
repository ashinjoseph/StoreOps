// ============================================================
//  ui-schedule-corrections — "Correct this day" on the Schedule screen
// ============================================================
//  An admin in the Operations app can correct a past day (or add a day
//  worked) after the fact (card P4-10; ADR-0023). These assertions run the
//  page's own functions, lifted from both copies of the page:
//   - torontoInstant_ builds the instant from the date, the time and
//     TORONTO's offset for that date, whatever zone the browser is in (this
//     process is put in Auckland on purpose), across both clock changes;
//   - the correction controls are offered to an admin in the Operations app
//     only, for today or a past day only;
//   - inside Apps Script (and for a manager) the cell sheet is exactly what
//     it was, and its old buttons still make the same calls;
//   - the correction sheet sends Toronto instants and shows the server's
//     "owed for the day: before → after".
// ============================================================
process.env.TZ = 'Pacific/Auckland';
const vm = require('vm');
const H = require('./_lib/harness');
const DOM = require('./_lib/dom');
const t = H.suite('Schedule corrections — Operations app, admin only, Toronto time');

t.ok('this process is not in Toronto (so a browser-zone instant would be caught)', new Date(2026, 0, 15).getTimezoneOffset() !== 300 && new Date(2026, 6, 15).getTimezoneOffset() !== 240);

const NEEDED = ['esc', 'money', 'isOpsApp_', 'scheduleCellOffers_', 'torontoWall_', 'torontoToday_', 'torontoInstant_',
  'torontoLocalValue_', 'instantFromLocal_', 'correctionPrefill_', 'owedText_', 'dayCorrectionHTML_', 'correctionHoursText_',
  'openDayCorrection_', 'editScheduleCell'];

const pending = [];
H.uiScripts().forEach(([label, js]) => {
  t.section('Against ' + label);
  const lifted = NEEDED.map(n => (n === 'openDayCorrection_' ? 'async ' : '') + H.fnSource(js, n)).join('\n\n');

  function world(opts) {
    let dom = DOM.fromHTML('');
    const w = {
      sheets: [], calls: [], opened: [], toasts: [], reloads: 0,
      console: { log() {}, error() {}, warn() {} },
      Intl, Date, Math, Number, String, JSON, isNaN, Promise,
      window: opts.ops ? { STOREOPS_APP: 'ops' } : {},
      navigator: {},
      state: { token: 'tok', me: { role: opts.role } },
      $: id => dom.$(id),
      dom: () => dom,
      openSheet: spec => { w.sheets.push(spec); dom = DOM.fromHTML(String(spec.bodyHTML) + String(spec.actionsHTML || '')); },
      closeSheet: () => {},
      haptic: () => {},
      toast: (m, k) => w.toasts.push([m, k]),
      confirm: () => true,
      handleRpcError: e => w.toasts.push([e.message, 'error']),
      loadScheduleTab: () => { w.reloads++; },
      call: (method, ...args) => { w.calls.push([method].concat(args)); return Promise.resolve(opts.answer ? opts.answer(method, args) : {}); },
    };
    vm.createContext(w);
    vm.runInContext(lifted, w);
    if (opts.stubCorrection) vm.runInContext('openDayCorrection_ = function (s, d) { opened.push([s, d]); };', w);
    return w;
  }
  const fn = (w, name) => vm.runInContext(name, w);

  // ── torontoInstant_ ──────────────────────────────────────
  {
    const w = world({ role: 'admin', ops: true });
    const ti = fn(w, 'torontoInstant_');
    const cases = [
      ['summer', '2026-07-01', '09:00', '2026-07-01T09:00:00-04:00', '2026-07-01T13:00:00.000Z'],
      ['winter', '2026-01-15', '09:00', '2026-01-15T09:00:00-05:00', '2026-01-15T14:00:00.000Z'],
      ['the evening before spring forward', '2026-03-07', '23:00', '2026-03-07T23:00:00-05:00', '2026-03-08T04:00:00.000Z'],
      ['spring forward, just before', '2026-03-08', '01:59', '2026-03-08T01:59:00-05:00', '2026-03-08T06:59:00.000Z'],
      ['spring forward, the skipped hour (read with the offset from before)', '2026-03-08', '02:30', '2026-03-08T02:30:00-05:00', '2026-03-08T07:30:00.000Z'],
      ['spring forward, just after', '2026-03-08', '03:00', '2026-03-08T03:00:00-04:00', '2026-03-08T07:00:00.000Z'],
      ['spring forward, the evening', '2026-03-08', '21:00', '2026-03-08T21:00:00-04:00', '2026-03-09T01:00:00.000Z'],
      ['fall back, just before', '2026-11-01', '00:59', '2026-11-01T00:59:00-04:00', '2026-11-01T04:59:00.000Z'],
      ['fall back, the repeated hour (the first one)', '2026-11-01', '01:30', '2026-11-01T01:30:00-04:00', '2026-11-01T05:30:00.000Z'],
      ['fall back, just after', '2026-11-01', '02:00', '2026-11-01T02:00:00-05:00', '2026-11-01T07:00:00.000Z'],
      ['fall back, the evening', '2026-11-01', '21:00', '2026-11-01T21:00:00-05:00', '2026-11-02T02:00:00.000Z'],
    ];
    cases.forEach(([name, d, hm, want, utc]) => {
      const got = ti(d, hm);
      t.eq('torontoInstant_ ' + name, [got, got && new Date(got).toISOString()], [want, utc]);
    });
    t.eq('torontoInstant_ refuses what is not a date and a time', [ti('2026-7-1', '09:00'), ti('2026-07-01', '9:00'), ti('', ''), ti('2026-07-01', '24:00')], [null, null, null, null]);
    const tw = fn(w, 'torontoWall_');
    t.eq('torontoWall_ reads an instant on Toronto\'s clock', [tw('2026-11-01T05:30:00Z'), tw('2026-11-01T06:30:00Z')].map(x => [x.date, x.time, x.offsetMin]),
      [['2026-11-01', '01:30', -240], ['2026-11-01', '01:30', -300]]);
    t.eq('a datetime-local value round-trips through Toronto time', fn(w, 'instantFromLocal_')(fn(w, 'torontoLocalValue_')('2026-06-08T21:00:00.000Z')), '2026-06-08T17:00:00-04:00');
  }

  // ── Who is offered what ──────────────────────────────────
  {
    const w = world({ role: 'admin', ops: true });
    const offers = fn(w, 'scheduleCellOffers_');
    const today = '2026-06-10';
    const got = [];
    ['admin', 'manager', 'employee', 'payroll_admin'].forEach(role => [true, false].forEach(ops =>
      [['2026-06-08', 'worked'], ['2026-06-08', null], [today, 'scheduled'], [today, null], ['2026-06-11', 'scheduled'], ['2026-06-11', null]].forEach(([d, st]) => {
        const o = offers(role, ops, st, d, today);
        if (o.correct || o.addWorked) got.push([role, ops, d, st, o.correct ? 'correct' : 'add']);
      })));
    t.eq('only an admin in the Operations app, only today or before: correct a day with a row, add one without',
      got, [['admin', true, '2026-06-08', 'worked', 'correct'], ['admin', true, '2026-06-08', null, 'add'], ['admin', true, today, 'scheduled', 'correct'], ['admin', true, today, null, 'add']]);
  }

  // ── The cell sheet: unchanged outside the Operations app ──
  {
    const today = fn(world({ role: 'admin', ops: true }), 'torontoToday_')();
    t.ok('torontoToday_ is a YYYY-MM-DD day', /^\d{4}-\d{2}-\d{2}$/.test(today));
    const PAST = '2020-01-06';
    const FUTURE = '2999-01-07';
    const cellsFor = date => [
      { staffId: 'S1', date, attendanceId: 'A1', status: 'worked', scheduledStart: '09:00', scheduledEnd: '17:00', hoursWorked: 8.5, scheduledHours: 8, actualHours: 8.5, hoursBasis: '' },
      { staffId: 'S2', date, attendanceId: 'A2', status: 'scheduled', scheduledStart: '10:00', scheduledEnd: '14:00', hoursWorked: 0, scheduledHours: 4, actualHours: 0, hoursBasis: '' },
      { staffId: 'S3', date, attendanceId: null, status: null, scheduledStart: '', scheduledEnd: '', hoursWorked: 0, scheduledHours: 0, actualHours: 0, hoursBasis: '' },
    ];
    const week = { staff: [{ staffId: 'S1', name: 'Cleo Marsh' }, { staffId: 'S2', name: 'Eli Stone' }, { staffId: 'S3', name: 'Dara Vance' }],
      cells: [PAST, today, FUTURE].reduce((a, d) => a.concat(cellsFor(d)), []) };
    const sheetOf = (role, ops, staffId, date) => {
      const w = world({ role, ops, stubCorrection: true });
      fn(w, 'editScheduleCell')(staffId, date, week);
      return { w, html: w.sheets[0].bodyHTML + '|' + w.sheets[0].actionsHTML };
    };
    const BTN = /<button type="button" class="btn-primary" id="correctDayBtn"[^>]*>(Correct this day|Add a day worked)<\/button>/;
    let same = true, onlyButton = true, labels = [];
    ['S1', 'S2', 'S3'].forEach(s => [PAST, today, FUTURE].forEach(d => {
      const scriptAdmin = sheetOf('admin', false, s, d).html;
      const scriptManager = sheetOf('manager', false, s, d).html;
      const opsManager = sheetOf('manager', true, s, d).html;
      const opsAdmin = sheetOf('admin', true, s, d).html;
      if (!(scriptAdmin === scriptManager && scriptManager === opsManager && scriptAdmin.indexOf('correctDayBtn') === -1)) same = false;
      if (opsAdmin.replace(BTN, '') !== scriptAdmin) onlyButton = false;
      const m = BTN.exec(opsAdmin);
      labels.push([s, d === PAST ? 'past' : d === today ? 'today' : 'future', m ? m[1] : null]);
    }));
    t.ok('inside Apps Script the sheet is the same for an admin and a manager, with no correction control', same);
    t.ok('in the Operations app an admin\'s sheet is the Apps Script sheet plus one button, nothing else', onlyButton);
    t.eq('the button: correct a day with a row, add a day worked on an empty cell, never on a future day', labels, [
      ['S1', 'past', 'Correct this day'], ['S1', 'today', 'Correct this day'], ['S1', 'future', null],
      ['S2', 'past', 'Correct this day'], ['S2', 'today', 'Correct this day'], ['S2', 'future', null],
      ['S3', 'past', 'Add a day worked'], ['S3', 'today', 'Add a day worked'], ['S3', 'future', null],
    ]);

    // The old controls still make the same calls (Apps Script, admin).
    const pend = [];
    {
      const { w } = sheetOf('admin', false, 'S2', PAST);
      w.dom().get('schedStart').value = '11:00';
      w.dom().get('schedEnd').value = '15:00';
      pend.push(Promise.resolve(w.dom().fire(w.dom().get('saveSchedBtn'), 'click')).then(() => new Promise(r => setImmediate(r))).then(() =>
        t.eq('Save on a scheduled cell: cancel and schedule again, as before', w.calls,
          [['rpcCancelScheduledShift', 'tok', 'A2', 'Replaced'], ['rpcScheduleShift', 'tok', { staffId: 'S2', date: PAST, scheduledStart: '11:00', scheduledEnd: '15:00' }]])));
    }
    {
      const { w } = sheetOf('manager', false, 'S2', FUTURE);
      w.dom().fire(w.dom().get('cancelSchedBtn'), 'click');
      pend.push(new Promise(r => setImmediate(r)).then(() => t.eq('Cancel shift, as before', w.calls, [['rpcCancelScheduledShift', 'tok', 'A2', 'Cancelled via UI']])));
    }
    {
      const { w } = sheetOf('admin', false, 'S1', PAST);
      w.dom().fire(w.dom().get('useActualBtn'), 'click');
      pend.push(new Promise(r => setImmediate(r)).then(() => t.eq('Use actual hours, as before', w.calls, [['rpcAdjustAttendanceHours', 'tok', 'A1', 'actual']])));
    }
    {
      const { w } = sheetOf('admin', true, 'S3', PAST);
      w.dom().fire(w.dom().get('correctDayBtn'), 'click');
      t.eq('the new button opens the correction sheet for that person and day', w.opened, [['S3', PAST]]);
    }
    pending.push(...pend);
  }

  // ── The correction sheet ─────────────────────────────────
  {
    const DAY = '2026-06-08';
    const base = {
      staffId: 'S_003', name: 'Cleo Marsh', active: true, date: DAY,
      record: { attendanceId: 'A_20260608_S_003', status: 'worked', scheduledStart: '09:00', scheduledEnd: '17:00', actualStart: '2026-06-08T13:00:00.000Z', actualEnd: '2026-06-08T21:00:00.000Z', hoursWorked: 8, rateAtAttendance: 20, hoursBasis: null, notes: null },
      currentRate: 20, paid: 0,
      tillSessions: [{ sessionId: 'CST-20260608-S_003', company: 'cstore', status: 'closed', startTime: '2026-06-08T13:00:00.000Z', endTime: '2026-06-08T21:00:00.000Z' }],
      canCorrect: true, blockedBy: null,
    };
    const answer = day => (method) => method === 'rpcGetAttendanceDay' ? day
      : { record: Object.assign({}, day.record, { hoursWorked: 5 }), created: false, owedBefore: 160, owedAfter: 100 };

    const blocked = world({ role: 'admin', ops: true, answer: answer(Object.assign({}, base, { paid: 50, canCorrect: false, blockedBy: 'Cannot correct: $50.00 has been paid against this day. Undo the payment first.' })) });
    pending.push(fn(blocked, 'openDayCorrection_')('S_003', DAY).then(() => {
      const s = blocked.sheets[blocked.sheets.length - 1];
      t.ok('a blocked day says why', s.bodyHTML.indexOf('Cannot correct: $50.00 has been paid against this day.') !== -1);
      t.ok('a blocked day offers no Save', s.actionsHTML.indexOf('corrSave') === -1 && s.bodyHTML.indexOf('corrReason') === -1);
      t.ok('it shows what was paid', s.bodyHTML.indexOf('Paid against this day: <strong>$50.00</strong>') !== -1);
    }));

    const w = world({ role: 'admin', ops: true, answer: answer(base) });
    pending.push(fn(w, 'openDayCorrection_')('S_003', DAY).then(() => {
      t.eq('it loads the day first', w.calls[0], ['rpcGetAttendanceDay', 'tok', 'S_003', DAY]);
      const s = w.sheets[w.sheets.length - 1];
      t.ok('it shows the till that day, in Toronto time', s.bodyHTML.indexOf('cstore: 09:00 → 17:00') !== -1);
      const d = w.dom();
      t.eq('the actual times are prefilled from the record, in Toronto time', [d.get('corrStart').value, d.get('corrEnd').value], ['2026-06-08T09:00', '2026-06-08T17:00']);
      // The stub document has no <select> semantics: set the choice a browser shows first.
      d.get('corrStatus').value = 'worked';
      d.fire(d.get('corrStatus'), 'change');
      t.ok('it shows the hours the times make', /8\.00h<\/strong> × \$20\.00\/h = \$160\.00/.test(d.get('corrHours').innerHTML));
      d.type('corrEnd', '2026-06-08T14:00');
      t.ok('and updates them as the times change', /5\.00h<\/strong> × \$20\.00\/h = \$100\.00/.test(d.get('corrHours').innerHTML));
      d.get('corrSchedStart').value = '09:00';
      d.get('corrSchedEnd').value = '17:00';
      d.get('corrReason').value = '  Left at 14:00, Eli covered ';
      d.fire(d.get('corrSave'), 'click');
      return new Promise(r => setImmediate(r));
    }).then(() => {
      t.eq('Save sends every field, the times as Toronto instants', w.calls[1], ['rpcCorrectAttendance', 'tok', {
        staffId: 'S_003', date: DAY, status: 'worked', scheduledStart: '09:00', scheduledEnd: '17:00',
        actualStart: '2026-06-08T09:00:00-04:00', actualEnd: '2026-06-08T14:00:00-04:00', reason: 'Left at 14:00, Eli covered' }]);
      const done = w.sheets[w.sheets.length - 1];
      t.ok('then shows the server\'s owed for the day, before and after',
        done.bodyHTML.indexOf('This changes what Cleo Marsh is owed for the day from <strong>$160.00</strong> to <strong>$100.00</strong>.') !== -1);
      t.eq('and reloads the week', w.reloads, 1);
    }));

    // A stand-in with no row: prefilled from nothing; "did not work" sends no times.
    const empty = Object.assign({}, base, { staffId: 'S_005', name: 'Eli <Stone>', record: null, tillSessions: [], currentRate: null });
    const w2 = world({ role: 'admin', ops: true, answer: answer(empty) });
    pending.push(fn(w2, 'openDayCorrection_')('S_005', DAY).then(() => {
      const s = w2.sheets[w2.sheets.length - 1];
      t.ok('a name is escaped', s.title === 'Add a day worked: Eli <Stone>' && s.bodyHTML.indexOf('<Stone>') === -1);
      t.ok('no rate set is said, not $0.00', s.bodyHTML.indexOf('Current rate: no rate set') !== -1);
      const d = w2.dom();
      t.eq('nothing to prefill from', [d.get('corrStart').value, d.get('corrEnd').value], ['', '']);
      d.get('corrStatus').value = 'cancelled';
      d.get('corrReason').value = 'Did not come';
      d.fire(d.get('corrSave'), 'click');
      return new Promise(r => setImmediate(r));
    }).then(() => {
      t.eq('"Did not work" sends no actual times', [w2.calls[1][2].status, w2.calls[1][2].actualStart, w2.calls[1][2].actualEnd], ['cancelled', null, null]);
    }));
    const owed = fn(world({ role: 'admin', ops: true }), 'owedText_');
    pending.push(Promise.resolve().then(() => {
      t.eq('a blank owed figure is said in words, never $0.00',
        [owed(0, { status: 'scheduled' }), owed(null, null), owed(null, { status: 'cancelled' }), owed(null, { status: 'worked' }), owed(140.8, { status: 'worked' })],
        ['$0.00', 'nothing (no day recorded)', 'nothing (did not work)', 'nothing (no hours recorded, or no rate set)', '$140.80']);
    }));
    // The day's own rate: blank reads "no rate set" (the same words as Payroll and My Pay); a real 0 is $0.00/h.
    const dayHTML = fn(world({ role: 'admin', ops: true }), 'dayCorrectionHTML_');
    pending.push(Promise.resolve().then(() => {
      const withRate = v => dayHTML(Object.assign({}, base, { record: Object.assign({}, base.record, { rateAtAttendance: v }), canCorrect: false, blockedBy: 'x' }));
      t.ok('a blank day rate reads "Rate: no rate set"', withRate(null).indexOf('Rate: no rate set') !== -1);
      t.ok('a real 0 day rate reads $0.00/h, never "no rate set"', withRate(0).indexOf('Rate: $0.00/h') !== -1 && withRate(0).indexOf('Rate: no rate set') === -1);
      t.ok('no screen of this sheet says "recorded" about a rate', ['none recorded', 'no rate recorded'].every(x => withRate(null).indexOf('Rate: ' + x) === -1));
    }));
  }

  t.section('The page wires it');
  t.ok('editScheduleCell asks scheduleCellOffers_ with the session role and isOpsApp_()',
    /scheduleCellOffers_\(state\.me\.role, isOpsApp_\(\), cell \? cell\.status : null, date, torontoToday_\(\)\)/.test(H.fnSource(js, 'editScheduleCell')));
  t.ok('the Schedule screen still lets only admins and managers tap a cell', /const canEdit = role === 'admin' \|\| role === 'manager';/.test(H.fnSource(js, 'renderScheduleTab')));
  t.ok('the screen is in this copy of the page', js.indexOf('function loadScheduleTab(') !== -1 && js.indexOf('function openDayCorrection_(') !== -1);
});

Promise.all(pending).then(() => t.done()).catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
