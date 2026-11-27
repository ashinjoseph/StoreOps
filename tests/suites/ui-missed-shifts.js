// ============================================================
//  ui-missed-shifts — "Enter a shift that was not put in" on the Sales screen
// ============================================================
//  An admin in the Operations app can enter a shift that was worked but never
//  opened or closed in the app (card P4-12b; ADR-0023). These assertions run
//  the page's own functions, lifted from both copies of the page:
//   - the control is offered to an admin in the Operations app only, for a
//     day before today (or for a range with no sales, with no day chosen);
//   - inside Apps Script, and for every other role, the Sales day renders
//     exactly what it did;
//   - the sheet asks for that till's close figures, in the close's words and
//     order, in that day's card shape (redrawn when the server names the
//     other shape);
//   - it previews through the server (debounced), shows the server's answer
//     and its refusals as they are, and a blank is words, never $0.00;
//   - after saving it says what was created and what went stale.
// ============================================================
const vm = require('vm');
const H = require('./_lib/harness');
const DOM = require('./_lib/dom');
const t = H.suite('Missed shifts — Operations app, admin only, a past day');

const NEEDED = ['esc', 'money', 'signedMoney_', 'moneyInput', 'compactMoney', 'dayParts', 'isOpsApp_', 'tillRowOffers_', 'tillRowControl_', 'tillFigure_',
  'torontoWall_', 'torontoToday_', 'torontoInstant_', 'instantFromLocal_',
  'missedShiftOffers_', 'missedShiftControl_', 'missedShiftShape_', 'missedShiftShapeFrom_', 'missedShiftFiguresHTML_', 'missedShiftHTML_',
  'missedShiftValues_', 'missedShiftInput_', 'missedClock_', 'missedShiftHoursText_', 'missedShiftSummaryHTML_', 'missedShiftResultHTML_',
  'missedShiftDayBefore_', 'openMissedShift_', 'renderSalesBody'];
const MINE = NEEDED.filter(n => /^missed|^openMissedShift_$/.test(n));

const pending = [];
H.uiScripts().forEach(([label, js]) => {
  t.section('Against ' + label);
  const lifted = NEEDED.map(n => (n === 'openMissedShift_' ? 'async ' : '') + H.fnSource(js, n)).join('\n\n');

  function world(opts) {
    let dom = DOM.fromHTML('');
    const results = {
      innerHTML: '', wired: [],
      querySelector: () => null,
      querySelectorAll(sel) {
        const out = [];
        const re = sel === '[data-enter-shift]' ? /data-enter-shift="([^"]*)"/g : null;
        if (!re) return out;
        let m;
        while ((m = re.exec(results.innerHTML))) {
          const node = { dataset: { enterShift: m[1] } };
          results.wired.push([sel, m[1], node]);
          out.push(node);
        }
        return out;
      },
    };
    const timers = [];
    const w = {
      sheets: [], calls: [], opened: [], toasts: [], reloads: 0, results, timers,
      console: { log() {}, error() {}, warn() {} },
      Intl, Date, Math, Number, String, JSON, isNaN, Promise, parseFloat, Object,
      TTL_REF: 1,
      window: opts.ops ? { STOREOPS_APP: 'ops' } : {},
      state: { token: 'tok', me: opts.role ? { role: opts.role } : null, salesData: opts.sales || null, salesExpandedDays: {}, cardSplit: opts.cardSplit || { cstore: false, vape: true }, lotto: { enabled: true, expected: 500 } },
      $: id => (id === 'salesResults' ? results : dom.$(id)),
      dom: () => dom,
      openSheet: spec => {
        w.sheets.push(spec);
        dom = DOM.fromHTML(String(spec.bodyHTML) + String(spec.actionsHTML || ''));
        // A <select> shows its first option, as a browser's does.
        const till = dom.get('msCompany');
        if (till && till.value === '') till.value = /<select id="msCompany"><option value="([^"]*)"/.exec(String(spec.bodyHTML))[1];
        // The sheet draws its figures into #msFigures: those fields join the page.
        const fig = dom.get('msFigures');
        if (fig) {
          let html = '';
          // Redrawn: the old fields leave the page, the new ones join it.
          Object.defineProperty(fig, 'innerHTML', { get: () => html, set: h => { DOM.fromHTML(html).ids().forEach(id => { delete dom.nodes[id]; }); html = h; Object.assign(dom.nodes, DOM.fromHTML(h).nodes); } });
        }
        const sum = dom.get('msSummary');
        if (sum) {
          let html = '';
          Object.defineProperty(sum, 'innerHTML', { get: () => html, set: h => { html = h; } });
        }
      },
      closeSheet: () => {},
      haptic: () => {},
      focusSalesChart_: () => {},
      setTimeout: fn => { timers.push(fn); return timers.length; },
      clearTimeout: id => { if (id) timers[id - 1] = null; },
      toast: (m, k) => w.toasts.push([m, k]),
      handleRpcError: e => w.toasts.push([e.message, 'error']),
      loadSalesTab: () => { w.reloads++; },
      call: (method, ...args) => {
        w.calls.push([method].concat(args));
        try { return Promise.resolve(opts.answer ? opts.answer(method, args) : {}); } catch (e) { return Promise.reject(e); }
      },
      cachedCall: (method, args) => w.call(method, ...args),
    };
    vm.createContext(w);
    vm.runInContext(lifted, w);
    if (opts.stubSheet) vm.runInContext('openMissedShift_ = function (d) { opened.push(d); };', w);
    return w;
  }
  const fn = (w, name) => vm.runInContext(name, w);
  /** Run the debounced preview(s) waiting, then let their answers land. */
  const flush = async w => {
    const due = w.timers.splice(0).filter(Boolean);
    due.forEach(f => f());
    await new Promise(r => setImmediate(r));
  };

  // ── Who is offered what ──────────────────────────────────
  {
    const offers = fn(world({ role: 'admin', ops: true }), 'missedShiftOffers_');
    const got = [];
    ['admin', 'manager', 'payroll_admin', 'employee'].forEach(role => [true, false].forEach(ops =>
      [['2026-09-12', 'past'], ['2026-09-20', 'today'], ['2026-09-21', 'future'], ['', 'none']].forEach(([day, kind]) => {
        if (offers(role, ops, day, '2026-09-20').enter) got.push([role, ops, kind]);
      })));
    t.eq('only an admin in the Operations app, only for a day before today (or no day chosen)', got, [['admin', true, 'past'], ['admin', true, 'none']]);
  }

  // ── The Sales screen: unchanged outside the Operations app ──
  const salesFor = day => ({
    totals: { total: 1650, cash: 1150, credit: 300, debit: 200, cardAll: 500, misc: 0 },
    companies: ['vape'],
    daily: [{ dateStr: day, total: 1650, sessionCount: 1, byCompany: { vape: 1650 } }],
    rows: [{ sessionId: 'VAP-x', staffName: 'Dara Vance', company: 'vape', date: day, cash: 1150, credit: 300, debit: 200, card: null, misc: 0, total: 1650, miscNotes: '' }],
    rowCount: 1,
  });
  const empty = { totals: { total: 0, cash: 0, credit: 0, debit: 0, cardAll: 0, misc: 0 }, companies: [], daily: [], rows: [], rowCount: 0 };
  {
    const BTN = /<button type="button" class="history-toggle" data-correct-till="[^"]*">Correct this till<\/button>/g;
    const MISSED = /<button type="button" class="history-toggle" data-enter-shift="([^"]*)">Enter a shift that was not put in<\/button>/g;
    const render = (role, ops, sales) => {
      const w = world({ role, ops, sales, stubSheet: true });
      fn(w, 'renderSalesBody')();
      return w;
    };
    [['a past day', salesFor('2026-09-12')], ['a range with no sales', empty]].forEach(([what, sales]) => {
      const script = render('admin', false, sales).results.innerHTML;
      let same = true;
      ['admin', 'manager', 'payroll_admin', 'employee'].forEach(role => {
        if (render(role, false, sales).results.innerHTML !== script) same = false;
        if (role !== 'admin' && render(role, true, sales).results.innerHTML !== script) same = false;
      });
      t.ok('inside Apps Script, and for every role but admin, the Sales day renders byte for byte the same (' + what + ')', same && script.indexOf('Enter a shift') === -1);
      const admin = render('admin', true, sales).results.innerHTML;
      t.eq('an admin in the Operations app sees that screen plus one control (' + what + ')',
        [admin.replace(BTN, '').replace(MISSED, '') === script, (admin.match(MISSED) || []).length], [true, 1]);
    });
    const past = render('admin', true, salesFor('2026-09-12'));
    t.ok('on a past day the control carries that day', past.results.innerHTML.indexOf('data-enter-shift="2026-09-12"') !== -1);
    const none = render('admin', true, empty);
    t.ok('with no sales in the range it carries no day (the sheet asks)', none.results.innerHTML.indexOf('No sales in this range.</div><button type="button" class="history-toggle" data-enter-shift="">') !== -1);
    const today = fn(world({}), 'torontoToday_')();
    t.ok('not on today (today is opened and closed on the Shift screen)', render('admin', true, salesFor(today)).results.innerHTML.indexOf('Enter a shift') === -1);
    past.results.wired.filter(x => x[0] === '[data-enter-shift]')[0][2].onclick();
    t.eq('the control opens the sheet for that day', past.opened, ['2026-09-12']);
  }

  // ── The sheet's inputs, per till and card shape ──────────
  {
    const w = world({ role: 'admin', ops: true });
    const html = fn(w, 'missedShiftFiguresHTML_');
    const ids = h => DOM.fromHTML(h).ids();
    const has = (list, xs) => xs.every(x => list.indexOf(x) !== -1);
    const none = (list, xs) => xs.every(x => list.indexOf(x) === -1);
    const vapeSplit = ids(html('vape', 'split', 500));
    const vapeSingle = ids(html('vape', 'single', 500));
    const cstSingle = ids(html('cstore', 'single', 500));
    const cstSplit = ids(html('cstore', 'split', 500));
    t.ok('vape, credit and debit: no card total, no lotto', has(vapeSplit, ['msFloat', 'msCash', 'msCredit', 'msDebit', 'msMiscCash', 'msMiscCredit', 'msMiscDebit', 'msMiscNotes', 'msCount']) && none(vapeSplit, ['msCard', 'msMiscCard', 'msLotto', 'msLottoTopup', 'msLottoNote']));
    t.ok('vape, one total: card and misc card, no credit or debit, no lotto', has(vapeSingle, ['msCard', 'msMiscCard', 'msCount']) && none(vapeSingle, ['msCredit', 'msDebit', 'msMiscCredit', 'msMiscDebit', 'msLotto']));
    t.ok('cstore, one total (after ePOS): card, misc card and the lotto reserve', has(cstSingle, ['msCard', 'msMiscCard', 'msLotto', 'msLottoTopup', 'msLottoNote']) && none(cstSingle, ['msCredit', 'msDebit']));
    t.ok('cstore, credit and debit (before ePOS): credit, debit and the lotto reserve', has(cstSplit, ['msCredit', 'msDebit', 'msMiscCredit', 'msMiscDebit', 'msLotto']) && none(cstSplit, ['msCard', 'msMiscCard']));
    const order = (h, labels) => { let at = -1; return labels.every(l => { const i = h.indexOf('<label>' + l); const ok = i > at; at = i; return ok; }); };
    t.ok('the close sheet\'s words in its order (cstore, one total)', order(html('cstore', 'single', 500),
      ['Opening float ($)', 'Cash sales ($)', 'Card sales ($)', 'Reserve counted ($)', 'Moving from till into reserve ($)', 'Reason reserve isn\'t $500.00', 'Misc cash ($)', 'Misc card ($)', 'Misc notes', 'Cash counted in till ($)']));
    t.ok('the close sheet\'s words in its order (vape, credit and debit)', order(html('vape', 'split', 500),
      ['Opening float ($)', 'Cash sales ($)', 'Credit card sales ($)', 'Debit card sales ($)', 'Misc cash ($)', 'Misc credit ($)', 'Misc debit ($)', 'Misc notes', 'Cash counted in till ($)']));
    const close = H.fnSource(js, 'closeShiftForm');
    t.ok('those words are the close sheet\'s own', ['Cash sales ($)', 'Credit card sales ($)', 'Debit card sales ($)', 'Card sales ($)', 'Reserve counted ($)', 'Moving from till into reserve ($)', 'Misc cash ($)', 'Misc credit ($)', 'Misc debit ($)', 'Misc card ($)', 'Misc notes', 'Cash counted in till ($)']
      .every(l => close.indexOf('<label>' + l) !== -1));
    const blank = DOM.fromHTML(html('vape', 'split', 500));
    t.eq('every figure starts blank (not 0)', ['msFloat', 'msCash', 'msCredit', 'msCount'].map(id => blank.get(id).value), ['', '', '', '']);
    const shapeFrom = fn(w, 'missedShiftShapeFrom_');
    t.eq('the shape the server names in its refusal', [shapeFrom('On 2026-08-20 the cstore till reports credit and debit: send credit and debit.'), shapeFrom('On 2026-09-12 the cstore till reports one card total: send one card total.'), shapeFrom('Send one card shape.')], ['split', 'single', null]);
    const sheet = fn(w, 'missedShiftHTML_')([{ staffId: 'S_004', name: 'Dara <b>Vance</b>', active: true }, { staffId: 'S_9', name: 'Old Hand', active: false }], '2026-09-12');
    t.ok('who, which till, the day, start and end in Toronto time, notes, the reason', ['msStaff', 'msCompany', 'msDate', 'msStart', 'msEnd', 'msNotes', 'msReason', 'msSummary'].every(id => sheet.indexOf('id="' + id + '"') !== -1) &&
      sheet.indexOf('type="datetime-local" id="msStart"') !== -1 && sheet.indexOf('Start (Toronto time)') !== -1);
    t.ok('the staff list is escaped and names an inactive person as such', sheet.indexOf('Dara &lt;b&gt;Vance&lt;/b&gt;') !== -1 && sheet.indexOf('<b>') === -1 && sheet.indexOf('Old Hand (inactive)') !== -1);
  }

  // ── Preview, refusals, saving ────────────────────────────
  const PEOPLE = [{ staffId: 'S_004', name: 'Dara Vance', active: true }, { staffId: 'S_003', name: 'Cleo Marsh', active: true }];
  const answerOf = (p) => ({
    session: { sessionId: 'VAP-20260912-S_004', company: 'vape', staffId: 'S_004', staffName: 'Dara Vance', date: '2026-09-12', startTime: '2026-09-12T13:00:00.000Z', endTime: '2026-09-12T21:00:00.000Z', status: 'closed', openingFloat: 100, closingCashCounted: 1250, expectedCash: 1250, closingVariance: 0, varianceStatus: 'OK', cashRemovedAtClose: 1150, cashLeftInTill: 100, notes: 'Entered after the fact: x' },
    sales: { salesId: 'VAP-20260912-S_004', total: 1650 },
    attendance: { attendanceId: 'A_20260912_S_004', status: 'worked', hoursWorked: 8, rateAtAttendance: 17.5, owed: 140 },
    attendanceChange: 'created', hoursLeft: null, notAuthorised: false, otherTill: [], cardShape: 'split', floatLeft: 100,
    floatNote: 'The float left in the drawer is today\'s setting for the vape till ($100.00): nothing records the one in force that day.',
    lotto: null, variance: 0, varianceStatus: 'OK', cashRemoved: 1150, total: 1650, staleReconcile: false, commissionRunsTouched: [], nextLottoSession: null,
    ...(p || {}),
  });
  {
    let refuse = null;
    const saved = answerOf({ staleReconcile: true, commissionRunsTouched: [{ runId: 'CR_1', weekEnd: '2026-09-13', status: 'proposed' }] });
    const w = world({ role: 'admin', ops: true, sales: {}, answer: (m) => {
      if (m === 'rpcGetStaffDirectory') return PEOPLE;
      if (m === 'rpcPreviewMissedShift') { if (refuse) throw new Error(refuse); return answerOf(); }
      return saved;
    } });
    pending.push(fn(w, 'openMissedShift_')('2026-09-12').then(async () => {
      t.eq('it loads the staff list first, and nothing else', w.calls.map(c => c[0]), ['rpcGetStaffDirectory']);
      const s = w.sheets[w.sheets.length - 1];
      t.ok('the sheet starts on the day it was opened for', s.title === 'Enter a shift that was not put in' && w.dom().get('msDate').value === '2026-09-12');
      const d = w.dom();
      t.ok('cstore (the first till) on this day\'s setting: one card total and the lotto reserve', d.has('msCard') && d.has('msLotto') && !d.has('msCredit'));
      d.get('msStaff').value = 'S_004';
      d.get('msCompany').value = 'vape';
      d.fire(d.get('msCompany'), 'change');
      t.ok('choosing vape redraws vape\'s figures (credit and debit, no lotto)', d.has('msCredit') && d.has('msDebit'));
      d.get('msStart').value = '2026-09-12T09:00';
      d.fire(d.get('msStart'), 'change');
      d.get('msEnd').value = '2026-09-12T17:00';
      d.fire(d.get('msEnd'), 'change');
      ['msFloat', '100', 'msCash', '1150', 'msCredit', '300', 'msDebit', '200', 'msCount', '1250'].reduce((a, v, i, xs) => { if (i % 2 === 0) d.type(v, xs[i + 1]); return a; }, 0);
      await flush(w);
      const previews = w.calls.filter(c => c[0] === 'rpcPreviewMissedShift');
      t.eq('typing is debounced: one preview for everything typed', previews.length, 1);
      t.eq('the preview is sent who, when (Toronto instants) and every figure of the shape, a blank as null', previews[0][2], {
        staffId: 'S_004', company: 'vape', date: '2026-09-12', startTime: '2026-09-12T09:00:00-04:00', endTime: '2026-09-12T17:00:00-04:00',
        openingFloat: 100, closingCashCounted: 1250, cashSales: 1150, miscCashSales: null, miscNotes: '', notes: '', reason: '',
        creditCardSales: 300, debitCardSales: 200, miscCreditSales: null, miscDebitSales: null,
      });
      const sum = d.get('msSummary').innerHTML;
      t.ok('it shows the server\'s variance with its status, cash removed, the total and the day\'s hours',
        /\+\$0\.00 \(OK\)/.test(sum) && sum.indexOf('id="msCashRemoved">$1150.00') !== -1 && sum.indexOf('id="msTotal">$1650.00') !== -1 && sum.indexOf('The day is added as worked: 8 hours ($140.00 owed).') !== -1 && sum.indexOf('nothing records the one in force that day') !== -1);
      refuse = 'The vape till already has a shift from 09:00 to 17:00 that day (Cleo <Marsh>).';
      d.type('msCount', '1260');
      await flush(w);
      t.ok('a refusal is shown as the server words it, escaped', d.get('msSummary').innerHTML.indexOf('The vape till already has a shift from 09:00 to 17:00 that day (Cleo &lt;Marsh&gt;).') !== -1);
      refuse = null;
      d.type('msCount', '1250');
      await flush(w);
      d.get('msReason').value = 'x';
      d.fire(d.get('msSave'), 'click');
      t.eq('a reason is required before anything is saved', [w.calls.filter(c => c[0] === 'rpcEnterMissedShift').length, w.toasts[w.toasts.length - 1][1]], [0, 'error']);
      d.get('msReason').value = '  Worked it; the tablet was down ';
      d.fire(d.get('msSave'), 'click');
      await new Promise(r => setImmediate(r));
      const sent = w.calls.filter(c => c[0] === 'rpcEnterMissedShift');
      t.eq('Save sends the same input with the reason', [sent.length, sent[0][2].reason, sent[0][2].closingCashCounted, sent[0][2].startTime], [1, 'Worked it; the tablet was down', 1250, '2026-09-12T09:00:00-04:00']);
      const done = w.sheets[w.sheets.length - 1];
      t.ok('then says what was created', done.title === '✓ VAPE shift entered' && done.bodyHTML.indexOf('Entered the VAPE till for Dara Vance on 2026-09-12, 09:00 to 17:00. Variance +$0.00 (OK). Cash removed $1150.00. Total $1650.00.') !== -1);
      t.ok('and what is now out of date, in a correction\'s words', done.bodyHTML.indexOf('This day was reconciled on the old figures: run the reconcile for it again.') !== -1 &&
        done.bodyHTML.indexOf('Commission run for the week ending 2026-09-13 used the old sales figures and has not been recalculated.') !== -1);
      t.eq('and reloads the Sales screen', w.reloads, 1);
    }));
  }

  // cstore before ePOS: the server names credit and debit, the sheet redraws in it; the reserve is sent as the close sends it.
  {
    const w = world({ role: 'admin', ops: true, answer: (m, args) => {
      if (m === 'rpcGetStaffDirectory') return PEOPLE;
      if (m === 'rpcPreviewMissedShift') {
        if ('cardTotalSales' in args[1]) throw new Error('On 2026-08-20 the cstore till reports credit and debit: send credit and debit.');
        return answerOf({ lotto: { expected: 500, previousCount: 470 }, nextLottoSession: { sessionId: 'CST-20260821-S_005', date: '2026-08-21' }, attendanceChange: 'left',
          hoursLeft: { recorded: 8, span: 12, message: 'The day\'s hours were left at 8: correct the day on the Schedule screen if they should change (the day\'s shifts would span 12 hours).' },
          attendance: { hoursWorked: 8, rateAtAttendance: null, owed: null }, otherTill: [{ sessionId: 'VAP-20260820-S_003', company: 'vape', status: 'closed', startTime: '2026-08-20T13:00:00.000Z', endTime: '2026-08-20T21:00:00.000Z' }] });
      }
      return answerOf({ session: Object.assign(answerOf().session, { company: 'cstore', date: '2026-08-20' }), nextLottoSession: { sessionId: 'CST-20260821-S_005', date: '2026-08-21' } });
    } });
    pending.push(fn(w, 'openMissedShift_')('2026-08-20').then(async () => {
      const d = w.dom();
      d.get('msStaff').value = 'S_003';
      d.fire(d.get('msStaff'), 'change');
      d.get('msStart').value = '2026-08-20T09:00';
      d.get('msEnd').value = '2026-08-20T17:00';
      d.fire(d.get('msEnd'), 'change');
      d.type('msCash', '-80');
      d.type('msLotto', '400');
      d.type('msLottoTopup', '20');
      await flush(w);
      t.ok('the server named credit and debit: the sheet is redrawn in that shape, keeping what was typed', d.has('msCredit') && !d.has('msCard') && d.get('msCash').value === '-80' && d.get('msLotto').value === '400');
      await flush(w);
      const last = w.calls.filter(c => c[0] === 'rpcPreviewMissedShift').pop()[2];
      t.eq('and asks again in it; the reserve is sent as count + moved in; a minus is kept on cstore cash',
        ['creditCardSales' in last, 'cardTotalSales' in last, last.lottoReserveCounted, last.lottoTopupFromTill, last.cashSales], [true, false, 420, 20, -80]);
      const sum = d.get('msSummary').innerHTML;
      t.ok('the day already worked: the server\'s words for the hours left', sum.indexOf('The day&#39;s hours were left at 8: correct the day on the Schedule screen if they should change') !== -1);
      t.ok('the person on the other till is reported; the previous reserve is named', sum.indexOf('was also on the vape till from 09:00 to 17:00') !== -1 && sum.indexOf('left the reserve at $470.00') !== -1);
      d.get('msReason').value = 'Tablet down';
      d.fire(d.get('msSave'), 'click');
      await new Promise(r => setImmediate(r));
      t.ok('after saving, the next cstore close is named in a correction\'s words', w.sheets[w.sheets.length - 1].bodyHTML.indexOf('The next cstore close (2026-08-21) worked out its expected cash from the old reserve count: check it too.') !== -1);
    }));
  }

  // Blank is words, never $0.00.
  {
    const w = world({ role: 'admin', ops: true });
    const text = fn(w, 'missedShiftHoursText_')(answerOf({ attendance: { hoursWorked: 8, rateAtAttendance: null, owed: null } }));
    t.ok('a day with no pay rate says so in words, not $0.00', text === 'The day is added as worked: 8 hours (no pay rate recorded, so nothing is owed for it yet).');
    const sum = fn(w, 'missedShiftSummaryHTML_')(answerOf({ session: Object.assign(answerOf().session, { expectedCash: null }), notAuthorised: true }));
    t.ok('a blank expected cash is words; a person not authorised for the till is asked about', sum.indexOf('Expected cash:</span> <strong>not worked out') !== -1 && sum.indexOf('Dara Vance is not authorised for the vape till now. Are you sure?') !== -1);
  }

  t.section('The page wires it');
  t.ok('the Sales day asks missedShiftControl_, which checks the session role and isOpsApp_()',
    /missedShiftControl_\(sel\.dateStr\)/.test(H.fnSource(js, 'renderSalesBody')) && /missedShiftControl_\(''\)/.test(H.fnSource(js, 'renderSalesBody')) &&
    /role !== 'admin' \|\| !isOpsApp_\(\)/.test(H.fnSource(js, 'missedShiftControl_')));
  t.ok('only its own function names the two calls', ['rpcPreviewMissedShift', 'rpcEnterMissedShift'].every(m => js.split(m).length - 1 === H.fnSource(js, 'openMissedShift_').split(m).length - 1 && js.indexOf(m) !== -1));
  t.ok('no var in its functions (it would hoist over a module helper)', MINE.every(n => !/\bvar\b/.test(H.fnSource(js, n))));
  t.ok('no scriptlet opener anywhere in its functions', MINE.every(n => H.fnSource(js, n).indexOf('<' + '?') === -1));
  t.ok('the screen is in this copy of the page', js.indexOf('function openMissedShift_(') !== -1 && js.indexOf('function missedShiftFiguresHTML_(') !== -1);
});

Promise.all(pending).then(() => t.done()).catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
