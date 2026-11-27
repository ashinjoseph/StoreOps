// ============================================================
//  ui-till-corrections — "Correct this till" on the Sales screen
// ============================================================
//  An admin in the Operations app can correct a closed till's figures after
//  the close (card P4-12a; ADR-0023). These assertions run the page's own
//  functions, lifted from both copies of the page:
//   - the control is offered to an admin in the Operations app only, on a
//     closed (or validated) till only;
//   - inside Apps Script, and for every other role, the Sales screen renders
//     exactly what it did and its bars still open their day;
//   - the correction sheet asks for the close's figures, in the close's
//     words and order, in the row's card shape only;
//   - a blank figure is shown in words, never as $0.00, and sent as null;
//   - after saving it shows the server's before → after and what went stale.
// ============================================================
const vm = require('vm');
const H = require('./_lib/harness');
const DOM = require('./_lib/dom');
const t = H.suite('Till corrections — Operations app, admin only, the close\'s figures');

const NEEDED = ['esc', 'money', 'signedMoney_', 'moneyInput', 'compactMoney', 'dayParts', 'isOpsApp_', 'tillRowOffers_', 'tillRowControl_',
  'tillFigure_', 'tillCorrectionPreview_', 'tillCorrectionHTML_', 'tillCorrectionValues_', 'tillCorrectionInput_', 'tillCorrectionResultHTML_',
  'openTillCorrection_', 'renderSalesBody', 'missedShiftOffers_', 'missedShiftControl_', 'torontoWall_', 'torontoToday_',
  'salesTillWanted_', 'salesTillHostHTML_', 'salesTillDayHostHTML_', 'loadSalesTill_'];

const pending = [];
H.uiScripts().forEach(([label, js]) => {
  t.section('Against ' + label);
  const lifted = NEEDED.map(n => (n === 'openTillCorrection_' || n === 'loadSalesTill_' ? 'async ' : '') + H.fnSource(js, n)).join('\n\n');

  function world(opts) {
    let dom = DOM.fromHTML('');
    // The Sales screen's container: the html it was given, and stub buttons for what the page wires.
    const results = {
      innerHTML: '', wired: [],
      querySelector: () => null,
      querySelectorAll(sel) {
        const out = [];
        const re = sel === '.sc-col' ? /<button class="sc-col[^"]*" data-day="([^"]*)"/g
          : sel === '[data-correct-till]' ? /data-correct-till="([^"]*)"/g : null;
        if (!re) return out;
        let m;
        while ((m = re.exec(results.innerHTML))) {
          const node = sel === '.sc-col' ? { dataset: { day: m[1] } } : { dataset: { correctTill: m[1] } };
          results.wired.push([sel, m[1], node]);
          out.push(node);
        }
        return out;
      },
    };
    const w = {
      sheets: [], calls: [], opened: [], toasts: [], reloads: 0, results,
      console: { log() {}, error() {}, warn() {} },
      Intl, Date, Math, Number, String, JSON, isNaN, Promise, parseFloat,
      window: opts.ops ? { STOREOPS_APP: 'ops' } : {},
      state: { token: 'tok', me: { role: opts.role }, salesData: opts.sales || null, salesExpandedDays: {} },
      $: id => (id === 'salesResults' ? results : dom.$(id)),
      dom: () => dom,
      openSheet: spec => { w.sheets.push(spec); dom = DOM.fromHTML(String(spec.bodyHTML) + String(spec.actionsHTML || '')); },
      closeSheet: () => {},
      haptic: () => {},
      focusSalesChart_: () => {},
      toast: (m, k) => w.toasts.push([m, k]),
      handleRpcError: e => w.toasts.push([e.message, 'error']),
      loadSalesTab: () => { w.reloads++; },
      call: (method, ...args) => { w.calls.push([method].concat(args)); return Promise.resolve(opts.answer ? opts.answer(method, args) : {}); },
    };
    vm.createContext(w);
    vm.runInContext(lifted, w);
    if (opts.stubSheet) vm.runInContext('openTillCorrection_ = function (id) { opened.push(id); };', w);
    return w;
  }
  const fn = (w, name) => vm.runInContext(name, w);

  // ── Who is offered what ──────────────────────────────────
  {
    const offers = fn(world({ role: 'admin', ops: true }), 'tillRowOffers_');
    const got = [];
    ['admin', 'manager', 'payroll_admin', 'employee'].forEach(role => [true, false].forEach(ops =>
      ['open', 'closed', 'validated'].forEach(st => { if (offers(role, ops, st).correct) got.push([role, ops, st]); })));
    t.eq('only an admin in the Operations app, only on a closed or validated till', got, [['admin', true, 'closed'], ['admin', true, 'validated']]);
  }

  // ── The Sales screen: unchanged outside the Operations app ──
  {
    const sales = {
      totals: { total: 4123.5, cash: 1750, credit: 300, debit: 200, cardAll: 2373.5, misc: 0 },
      companies: ['cstore', 'vape'],
      daily: [{ dateStr: '2026-09-12', total: 4123.5, sessionCount: 2, byCompany: { cstore: 2473.5, vape: 1650 } }],
      rows: [
        { sessionId: 'CST-20260912-S_003', staffName: 'Cleo Marsh', company: 'cstore', date: '2026-09-12', cash: 600, credit: null, debit: null, card: 1873.5, misc: 0, total: 2473.5, miscNotes: '' },
        { sessionId: 'VAP-20260912-S_004', staffName: 'Dara <Vance>', company: 'vape', date: '2026-09-12', cash: 1150, credit: 300, debit: 200, card: null, misc: 0, total: 1650, miscNotes: '' },
      ],
      rowCount: 2,
    };
    const render = (role, ops) => {
      const w = world({ role, ops, sales, stubSheet: true });
      fn(w, 'renderSalesBody')();
      return w;
    };
    const BTN = /<button type="button" class="history-toggle" data-correct-till="[^"]*">Correct this till<\/button>/g;
    const script = render('admin', false).results.innerHTML;
    let same = true;
    ['admin', 'manager', 'payroll_admin', 'employee'].forEach(role => {
      if (render(role, false).results.innerHTML !== script) same = false;
      if (role !== 'admin' && render(role, true).results.innerHTML !== script) same = false;
    });
    t.ok('inside Apps Script, and for every role but admin, the Sales day renders exactly the same, with no correction control', same && script.indexOf('Correct this till') === -1);
    const admin = render('admin', true);
    // P4-12b adds one more control to an admin's Sales day (ui-missed-shifts holds it down).
    const MISSED = /<button type="button" class="history-toggle" data-enter-shift="[^"]*">Enter a shift that was not put in<\/button>/g;
    t.eq('in the Operations app an admin\'s Sales day is that same screen plus one button per till (and the missed-shift control), nothing else',
      [admin.results.innerHTML.replace(BTN, '').replace(MISSED, '') === script, (admin.results.innerHTML.match(BTN) || []).length, (admin.results.innerHTML.match(MISSED) || []).length], [true, 2, 1]);
    t.ok('the till id in the control is escaped', admin.results.innerHTML.indexOf('data-correct-till="VAP-20260912-S_004"') !== -1 && admin.results.innerHTML.indexOf('Dara <Vance>') === -1);

    // The click paths: a bar still opens its day; the new button opens the sheet for that till.
    const w = render('manager', false);
    const bars = w.results.wired.filter(x => x[0] === '.sc-col');
    t.eq('Apps Script: the bars are wired as before and no correction button is', [bars.length, w.results.wired.filter(x => x[0] === '[data-correct-till]').length], [1, 0]);
    bars[0][2].onclick();
    t.eq('a bar still selects its day and re-renders', Object.keys(w.state.salesExpandedDays), ['2026-09-12']);
    const a = render('admin', true);
    const btns = a.results.wired.filter(x => x[0] === '[data-correct-till]');
    btns[1][2].onclick();
    t.eq('the new button opens the correction sheet for that till', a.opened, ['VAP-20260912-S_004']);
  }

  // ── The sheet, per card shape ────────────────────────────
  const session = (o) => Object.assign({
    sessionId: 'VAP-20260912-S_004', company: 'vape', staffId: 'S_004', staffName: 'Dara Vance', date: '2026-09-12',
    startTime: '2026-09-12T13:00:00.000Z', endTime: '2026-09-12T21:00:00.000Z', status: 'closed',
    openingFloat: 100, closingCashCounted: 1520, expectedCash: 1250, closingVariance: 270, varianceStatus: 'investigate',
    cashRemovedAtClose: 1420, cashLeftInTill: 100, notes: null,
  }, o || {});
  const salesRow = (o) => Object.assign({
    salesId: 'VAP-20260912-S_004', cashSales: 1150, creditCardSales: 300, debitCardSales: 200, cardTotalSales: null, cashbackPaid: 0,
    hstCollected: 0, bottleDeposit: 0, roundOff: 0, miscCashSales: 0, miscCreditSales: 0, miscDebitSales: 0, miscCardSales: null, miscNotes: null, total: 1650,
  }, o || {});
  const view = (o) => Object.assign({
    session: session(), sales: salesRow(), cardShape: 'split', dateShape: 'split', handedOver: 0, reconciled: false,
    commissionRunsTouched: [], lotto: null, canCorrect: true, blockedBy: null,
  }, o || {});
  const cstoreView = view({
    session: session({ sessionId: 'CST-20260912-S_003', company: 'cstore', staffName: 'Cleo Marsh', openingFloat: 250, closingCashCounted: 850, expectedCash: 850, closingVariance: 0, varianceStatus: 'OK', cashRemovedAtClose: 550, cashLeftInTill: 250, lottoReserveCounted: 500, lottoTopupFromTill: 50, lottoReserveNote: null }),
    sales: salesRow({ salesId: 'CST-20260912-S_003', cashSales: 600, creditCardSales: null, debitCardSales: null, cardTotalSales: 1873.5, miscCreditSales: null, miscDebitSales: null, miscCardSales: 0, total: 2473.5 }),
    cardShape: 'single', dateShape: 'single', lotto: { expected: 500, previousCount: 450 },
  });
  {
    const w = world({ role: 'admin', ops: true });
    const html = fn(w, 'tillCorrectionHTML_');
    const ids = h => DOM.fromHTML(h).ids();
    const split = ids(html(view()));
    const single = ids(html(cstoreView));
    const has = (list, xs) => xs.every(x => list.indexOf(x) !== -1);
    const none = (list, xs) => xs.every(x => list.indexOf(x) === -1);
    t.ok('a credit/debit row: credit, debit, misc credit, misc debit; no card total, no misc card, no lotto',
      has(split, ['tcCash', 'tcCredit', 'tcDebit', 'tcMiscCash', 'tcMiscCredit', 'tcMiscDebit', 'tcMiscNotes', 'tcCount', 'tcReason']) && none(split, ['tcCard', 'tcMiscCard', 'tcLotto', 'tcLottoTopup']));
    t.ok('a one-total row: card and misc card; no credit or debit; the cstore till asks about the lotto reserve',
      has(single, ['tcCash', 'tcCard', 'tcMiscCard', 'tcLotto', 'tcLottoTopup', 'tcLottoNote', 'tcCount']) && none(single, ['tcCredit', 'tcDebit', 'tcMiscCredit', 'tcMiscDebit']));
    // The close sheet's words, in the close sheet's order.
    const order = (h, labels) => { let at = -1; return labels.every(l => { const i = h.indexOf('<label>' + l); const ok = i > at; at = i; return ok; }); };
    t.ok('the inputs are the close sheet\'s, in its words and order (credit/debit)', order(html(view()),
      ['Cash sales ($)', 'Credit card sales ($)', 'Debit card sales ($)', 'Misc cash ($)', 'Misc credit ($)', 'Misc debit ($)', 'Misc notes', 'Cash counted in till ($)', 'Reason (required)']));
    t.ok('the inputs are the close sheet\'s, in its words and order (one total, lotto)', order(html(cstoreView),
      ['Cash sales ($)', 'Card sales ($)', 'Reserve counted ($)', 'Moving from till into reserve ($)', 'Reason reserve isn\'t $500.00', 'Misc cash ($)', 'Misc card ($)', 'Misc notes', 'Cash counted in till ($)']));
    const close = H.fnSource(js, 'closeShiftForm');
    t.ok('those words are the close sheet\'s own', ['Cash sales ($)', 'Credit card sales ($)', 'Debit card sales ($)', 'Card sales ($)', 'Reserve counted ($)', 'Moving from till into reserve ($)', 'Misc cash ($)', 'Misc credit ($)', 'Misc debit ($)', 'Misc card ($)', 'Misc notes', 'Cash counted in till ($)']
      .every(l => close.indexOf('<label>' + l) !== -1));
    const d0 = DOM.fromHTML(html(cstoreView));
    t.eq('prefilled from the record; the reserve is the pot before the top-up, as on the close sheet', [d0.get('tcCash').value, d0.get('tcCard').value, d0.get('tcCount').value, d0.get('tcLotto').value, d0.get('tcLottoTopup').value], ['600', '1873.5', '850', '450', '50']);

    // Blank is not zero.
    const blank = html(view({ session: session({ closingCashCounted: null, expectedCash: null, closingVariance: null, varianceStatus: null, cashRemovedAtClose: null }), sales: salesRow({ cashSales: null, creditCardSales: null, total: 200 }) }));
    t.ok('a blank figure is said in words', ['Cash counted not counted', 'Cash sales not entered', 'Credit not entered', 'Expected cash not worked out', 'Variance not worked out', 'Cash removed not worked out'].every(x => blank.indexOf(x) !== -1));
    const allBlank = html(view({ session: session({ openingFloat: null, closingCashCounted: null, expectedCash: null, closingVariance: null, varianceStatus: null, cashRemovedAtClose: null }),
      sales: salesRow({ cashSales: null, creditCardSales: null, debitCardSales: null, miscCashSales: null, miscCreditSales: null, miscDebitSales: null, total: 0 }) }));
    const recorded = allBlank.slice(allBlank.indexOf('Recorded now'), allBlank.indexOf('Total '));
    t.ok('and never as $0.00', recorded.length > 100 && recorded.indexOf('$0.00') === -1 && recorded.indexOf('Opening float not counted') !== -1);
    const d1 = DOM.fromHTML(blank);
    t.eq('a blank input stays blank (not 0)', [d1.get('tcCount').value, d1.get('tcCash').value, d1.get('tcCredit').value], ['', '', '']);
    const noSales = html(view({ sales: null }));
    t.ok('a till with no sales recorded says so', noSales.indexOf('No sales were recorded for this till: saving writes them.') !== -1);
    const fig = fn(w, 'tillFigure_');
    t.eq('tillFigure_: a recorded 0 is $0.00, a blank is the word', [fig(0, 'x'), fig(null, 'not counted'), fig(undefined, 'not entered'), fig(-270, 'x')], ['$0.00', 'not counted', 'not entered', '-$270.00']);
  }

  // ── Loading, blocked, preview, saving ────────────────────
  {
    const blocked = world({ role: 'admin', ops: true, answer: () => view({ canCorrect: false, blockedBy: 'This till is still open: close it instead.', session: session({ status: 'open' }) }) });
    pending.push(fn(blocked, 'openTillCorrection_')('VAP-20260912-S_004').then(() => {
      const s = blocked.sheets[blocked.sheets.length - 1];
      t.ok('a blocked till says why', s.bodyHTML.indexOf('This till is still open: close it instead.') !== -1);
      t.ok('and offers no Save and no inputs', s.actionsHTML.indexOf('tcSave') === -1 && s.bodyHTML.indexOf('tcReason') === -1);
    }));

    const result = {
      session: session({ closingCashCounted: 1250 }), sales: salesRow(),
      changed: [{ field: 'closingCashCounted', before: 1520, after: 1250 }],
      varianceBefore: 270, varianceAfter: 0, cashRemovedBefore: 1420, cashRemovedAfter: 1150, totalBefore: 1650, totalAfter: 1650,
      staleReconcile: true, commissionRunsTouched: [{ runId: 'CR_1', weekEnd: '2026-09-13', status: 'proposed' }], nextLottoSession: null,
    };
    const w = world({ role: 'admin', ops: true, sales: {}, answer: (m) => (m === 'rpcGetTillCorrection'
      ? view({ handedOver: 300, reconciled: true, commissionRunsTouched: [{ runId: 'CR_1', weekEnd: '2026-09-13', status: 'proposed' }] }) : result) });
    pending.push(fn(w, 'openTillCorrection_')('VAP-20260912-S_004').then(() => {
      t.eq('it loads the till first', w.calls[0], ['rpcGetTillCorrection', 'tok', 'VAP-20260912-S_004']);
      const s = w.sheets[w.sheets.length - 1];
      t.ok('it says who, which till and the day', s.title === 'Correct VAPE till: Dara Vance' && s.subtitle === '2026-09-12');
      t.ok('it shows what is recorded now', ['Cash counted $1520.00', 'Expected cash $1250.00', 'Variance +$270.00 (investigate)', 'Cash removed $1420.00', 'Total $1650.00'].every(x => s.bodyHTML.indexOf(x) !== -1));
      t.ok('the cash handed over, the reconcile and the commission runs', s.bodyHTML.indexOf('already handed over: <strong>$300.00</strong>') !== -1 &&
        s.bodyHTML.indexOf('This day has been reconciled.') !== -1 && s.bodyHTML.indexOf('week ending 2026-09-13 (proposed)') !== -1);
      const d = w.dom();
      t.ok('the preview starts from the record', /\+\$270\.00 \(investigate\)/.test(d.get('tcSummary').innerHTML));
      d.type('tcCount', '1250');
      t.ok('and follows the count as it is typed', /\+\$0\.00 \(OK\)/.test(d.get('tcSummary').innerHTML) && /Cash removed:<\/span> <strong>\$1150\.00/.test(d.get('tcSummary').innerHTML));
      d.type('tcCredit', '310');
      t.ok('and the total as a card figure is typed', /id="tcTotal">\$1660\.00/.test(d.get('tcSummary').innerHTML));
      d.type('tcCredit', '300');
      d.type('tcMiscDebit', '');
      d.get('tcReason').value = 'x';
      d.fire(d.get('tcSave'), 'click');
      t.eq('a reason is required', [w.calls.length, w.toasts[w.toasts.length - 1][1]], [1, 'error']);
      d.get('tcReason').value = '  Count typed as 1,520.00; it was 1,250.00 ';
      d.fire(d.get('tcSave'), 'click');
      return new Promise(r => setImmediate(r));
    }).then(() => {
      t.eq('Save sends every figure of the row\'s shape, a blank as null', w.calls[1], ['rpcCorrectTillSession', 'tok', {
        sessionId: 'VAP-20260912-S_004', openingFloat: 100, closingCashCounted: 1250, cashSales: 1150, miscCashSales: 0,
        miscNotes: '', notes: '', reason: 'Count typed as 1,520.00; it was 1,250.00',
        creditCardSales: 300, debitCardSales: 200, miscCreditSales: 0, miscDebitSales: null }]);
      const done = w.sheets[w.sheets.length - 1].bodyHTML;
      t.ok('then shows the server\'s figures, before and after', done.indexOf('Variance $270.00 → $0.00. Cash removed $1420.00 → $1150.00. Day\'s total $1650.00 → $1650.00.') !== -1);
      t.ok('says the day must be reconciled again', done.indexOf('This day was reconciled on the old figures: run the reconcile for it again.') !== -1);
      t.ok('and that the commission run was not recalculated', done.indexOf('Commission run for the week ending 2026-09-13 used the old sales figures and has not been recalculated.') !== -1);
      t.eq('and reloads the Sales screen', w.reloads, 1);
    }));

    // cstore: the reserve is sent as the close sends it (count + moved in).
    const c = world({ role: 'admin', ops: true, answer: (m) => (m === 'rpcGetTillCorrection' ? cstoreView : Object.assign({}, result, { changed: [] })) });
    pending.push(fn(c, 'openTillCorrection_')('CST-20260912-S_003').then(() => {
      const d = c.dom();
      d.type('tcCard', '1837.5');
      d.get('tcReason').value = 'Slipped digit';
      d.fire(d.get('tcSave'), 'click');
      return new Promise(r => setImmediate(r));
    }).then(() => {
      const sent = c.calls[1][2];
      t.eq('a one-total row sends the card total and misc card, no credit or debit, and the reserve as count + moved in',
        [sent.cardTotalSales, sent.miscCardSales, 'creditCardSales' in sent, 'debitCardSales' in sent, sent.lottoReserveCounted, sent.lottoTopupFromTill, sent.lottoReserveNote],
        [1837.5, 0, false, false, 500, 50, '']);
      t.ok('a correction that changes nothing says so', c.sheets[c.sheets.length - 1].bodyHTML.indexOf('Nothing changed') !== -1);
    }));
  }

  t.section('The page wires it');
  t.ok('the Sales row asks tillRowControl_, which asks tillRowOffers_ with the session role and isOpsApp_()',
    /tillRowControl_\(r\)/.test(H.fnSource(js, 'renderSalesBody')) && /tillRowOffers_\(state\.me && state\.me\.role, isOpsApp_\(\), 'closed'\)/.test(H.fnSource(js, 'tillRowControl_')));
  t.ok('only its own functions name the two calls', ['rpcGetTillCorrection', 'rpcCorrectTillSession'].every(m => js.split(m).length - 1 === H.fnSource(js, 'openTillCorrection_').split(m).length - 1));
  t.ok('the screen is in this copy of the page', js.indexOf('function openTillCorrection_(') !== -1 && js.indexOf('function tillCorrectionHTML_(') !== -1);
});

Promise.all(pending).then(() => t.done()).catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
