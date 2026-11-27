// ============================================================
//  ui-reconcile-past — "Run again for a past day" on the Reconcile screen
// ============================================================
//  In the Operations app a manager or admin can reconcile a past day again
//  (card P4-12c; ADR-0023). These assertions run the page's own functions,
//  lifted from both copies of the page:
//   - the control is offered in the Operations app, to the roles that can
//     open the Reconcile screen, and to nobody else;
//   - inside Apps Script the screen renders EXACTLY what it did before this
//     card (compared with a frozen copy of the old renderer in
//     _lib/recon-panel-before-p412c.txt), for every role, with one set of
//     results or several;
//   - in the Operations app a day with several sets of results shows the
//     newest and says how many it replaced; automatic runs of different
//     tills are not "earlier results"; "not verified" stays words;
//   - the form says that no message is sent and earlier results are kept,
//     asks for the day and a reason, sends exactly those two, and shows the
//     answer the way a manual run is shown;
//   - the built Operations page carries the control.
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./_lib/harness');
const DOM = require('./_lib/dom');
const t = H.suite('Reconcile a past day again — Operations app, the roles that can reconcile');

// renderReconPanel exactly as it was before this card (commit 196f6f4), frozen: inside Apps Script
// the screen must still produce what this produced.
const ORIGINAL_RENDER = fs.readFileSync(path.join(__dirname, '_lib', 'recon-panel-before-p412c.txt'), 'utf8');
// reconGroupDetail_ exactly as it was before card P4-12d (commit ac249bb), frozen the same way.
const ORIGINAL_DETAIL = fs.readFileSync(path.join(__dirname, '_lib', 'recon-group-detail-before-p412d.txt'), 'utf8');

const NEEDED = ['esc', 'money', 'signedMoney_', 'todayMidnight', 'isoDate', 'fmtWin_', 'pairVar_', 'reconGroupDetail_', 'reconRow_',
  'renderReconPanel', 'renderWhatsAppCheck_', 'isOpsApp_', 'reconPastOffered_', 'reconDays_', 'reconDayNote_', 'torontoWall_', 'torontoToday_',
  'reconYesterday_', 'reconPastFormHTML_', 'reconRecordRow_', 'reconPastGroup_', 'reconPastResultHTML_', 'openReconPast_'];

const pending = [];
H.uiScripts().forEach(([label, js]) => {
  t.section('Against ' + label);
  const lifted = NEEDED.map(n => (n === 'openReconPast_' ? 'async ' : '') + H.fnSource(js, n)).join('\n\n');

  function world(opts) {
    const panel = {
      innerHTML: '', wired: [],
      querySelectorAll(sel) {
        const out = [];
        if (sel !== '[data-rerun]') return out;
        const re = /data-rerun="([^"]*)"/g;
        let m;
        while ((m = re.exec(panel.innerHTML))) { const node = { dataset: { rerun: m[1] } }; panel.wired.push(node); out.push(node); }
        return out;
      },
    };
    let panelDom = { html: null, dom: null };
    let sheetDom = null;
    const w = {
      sheets: [], calls: [], toasts: [], reloads: 0, errors: [], panel,
      console: { log() {}, error() {}, warn() {} },
      Intl, Date, Math, Number, String, JSON, isNaN, Promise, parseFloat, Object,
      window: opts.ops ? { STOREOPS_APP: 'ops' } : {},
      state: { token: 'tok', me: opts.role ? { role: opts.role } : undefined, reconHistOpen: true },
      $: id => {
        if (id === 'reconPanel') return panel;
        if (sheetDom && sheetDom.$(id)) return sheetDom.$(id);
        if (panelDom.html !== panel.innerHTML) panelDom = { html: panel.innerHTML, dom: DOM.fromHTML(panel.innerHTML) };
        return panelDom.dom.$(id);
      },
      openSheet: spec => { w.sheets.push(spec); sheetDom = DOM.fromHTML(String(spec.bodyHTML) + String(spec.actionsHTML || '')); },
      closeSheet: () => {},
      haptic: () => {},
      toast: (m, k) => w.toasts.push([m, k]),
      handleRpcError: e => w.errors.push(e.message),
      loadReconPanel: force => { if (force) w.reloads++; },
      call: (method, ...args) => {
        w.calls.push([method].concat(args));
        const a = opts.answer ? opts.answer(method, args) : {};
        return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
      },
    };
    vm.createContext(w);
    vm.runInContext(lifted, w);
    w.render = rows => { vm.runInContext('renderReconPanel', w)(rows); return panel.innerHTML; };
    w.sheetDom = () => sheetDom;
    return w;
  }

  // The frozen renderer, in the same kind of world (not the Operations app).
  function originalRender(rows, role) {
    const w = world({ ops: false, role });
    vm.runInContext(ORIGINAL_RENDER.replace('function renderReconPanel(', 'function originalRenderReconPanel('), w);
    vm.runInContext('originalRenderReconPanel', w)(rows);
    return w.panel.innerHTML;
  }

  // The frozen panel with the frozen detail function too (the panel calls it by name).
  function originalRenderWithOldDetail(rows, role) {
    const w = world({ ops: false, role });
    vm.runInContext(ORIGINAL_DETAIL, w);
    vm.runInContext(ORIGINAL_RENDER.replace('function renderReconPanel(', 'function originalRenderReconPanel('), w);
    vm.runInContext('originalRenderReconPanel', w)(rows);
    return w.panel.innerHTML;
  }

  const TODAY = vm.runInContext('isoDate(todayMidnight())', world({}));
  const PAST = '2026-11-20';
  const RERUN_AT = '2026-11-27T20:00:00.000Z';   // 15:00 Toronto on the 27th
  const FIRST_AT = '2026-11-21T03:05:00.000Z';   // 22:05 Toronto on the 20th
  const row = o => Object.assign({
    businessDate: PAST, windowStart: '2026-11-20T14:00:00.000Z', windowEnd: '2026-11-21T02:20:00.000Z', companies: 'vape', status: 'OK',
    cashSales: 51, cashCounted: 111, cashVariance: 0, cashierCard: 51, cashierCredit: 1, cashierDebit: 50,
    cloverCredit: 1, cloverDebit: 50, cloverCard: 51, cardVariance: 0, mode: 'manual', validatedAt: FIRST_AT, validatedBy: 'S_004',
  }, o || {});
  const html = (w, rows) => w.render(rows);
  const trows = h => (h.match(/class="recon-trow"/g) || []).length;   // the header row is class="recon-trow head"

  // ── Who is offered the control ─────────────────────────────
  {
    const offered = vm.runInContext('reconPastOffered_', world({}));
    const got = [];
    ['admin', 'manager', 'payroll_admin', 'employee', undefined, 'ghost'].forEach(role => [true, false].forEach(ops => { if (offered(role, ops)) got.push([role, ops]); }));
    t.eq('only the roles that can open the Reconcile screen, only in the Operations app', got, [['admin', true], ['manager', true], ['payroll_admin', true]]);
    const items = /\{ tab: 'recon',[^}]*roles: (\[[^\]]*\])/.exec(js);
    t.eq('and those are the screen\'s own roles', JSON.parse(items[1].replace(/'/g, '"')).sort(), ['admin', 'manager', 'payroll_admin']);
  }

  // ── Inside Apps Script: exactly what it was ─────────────────
  {
    const SETS = {
      'one set of past results': [row(), row({ companies: 'cstore', cloverCard: null, cardVariance: null, cashierCredit: null, cashierDebit: null, cashierCard: 1240 })],
      'a past day with two sets of results (a re-run)': [row({ validatedAt: RERUN_AT, cashVariance: 0 }), row({ validatedAt: FIRST_AT, cashVariance: 270, status: 'investigate' })],
      'today with two sets (a forced re-run) and a past day': [row({ businessDate: TODAY, validatedAt: RERUN_AT }), row({ businessDate: TODAY, validatedAt: FIRST_AT, cashVariance: -3 }), row()],
      'nothing': [],
    };
    ['admin', 'manager', 'payroll_admin', 'employee', undefined].forEach(role => Object.keys(SETS).forEach(name => {
      const before = originalRender(SETS[name], role);
      const now = html(world({ ops: false, role }), SETS[name]);
      t.ok('Apps Script, ' + (role || 'no role') + ', ' + name + ': the same HTML as before this card', before === now && before.length > 100);
    }));
    // The data sets above hold no unmeasured till on today's panel, so for them the comparison is unchanged and
    // still byte-identical (nothing was weakened). P4-12d changed ONE thing on purpose: today's "Total sales" line of a till whose cards were not measured
    // (it used to set the cashier's card total against "cash sales + nothing" and print it as a red difference).
    // Those data sets are kept apart from SETS above; here the frozen renderer AND frozen detail function's output, with
    // exactly that line rewritten, must equal what the page now renders, so nothing else on the screen moved.
    const TODAY_UNMEASURED = {
      'today, one card total (cstore)': [row({ businessDate: TODAY, companies: 'cstore', cloverCard: null, cardVariance: null, cashierCredit: null, cashierDebit: null, cashierCard: 1240, cashSales: 600 })],
      'today, split cards, Clover unreachable, with a measured till': [row({ businessDate: TODAY, status: 'clover_unavailable', cloverCard: null, cloverCredit: null, cloverDebit: null }), row({ businessDate: TODAY, companies: 'cstore' }), row()],
    };
    const TOTAL_LINE = /<div class="recon-line"><span>Total sales<\/span><span>(\$[\d.]+) \/ \$[\d.]+ <small class="recon-diff">\([+-]\$[\d.]+\)<\/small><\/span><\/div>/g;
    Object.keys(TODAY_UNMEASURED).forEach(name => {
      const rows = TODAY_UNMEASURED[name];
      const before = originalRenderWithOldDetail(rows, 'admin');
      const now = html(world({ ops: false, role: 'admin' }), rows);
      const unmeasuredBefore = rows.filter(r => r.cloverCard == null && r.businessDate === TODAY).length;
      const rewritten = before.replace(TOTAL_LINE, (m, reported) => '<div class="recon-line"><span>Total sales</span><span>' + reported + ' <small>reported, not verified</small></span></div>');
      t.ok('Apps Script, ' + name + ': differs from the frozen screen (the fault is gone)', before !== now);
      // The clover_unavailable till already read "reported"; only the words after it change.
      const expected = rewritten.split('<small>reported</small>').join('<small>reported, not verified</small>');
      t.ok('Apps Script, ' + name + ': the ONLY differences are the Total sales lines of the unmeasured tills (' + unmeasuredBefore + ')', expected === now);
      const gone = (before.match(/class="recon-diff">\([+-]\$/g) || []).length - (now.match(/class="recon-diff">\([+-]\$/g) || []).length;
      t.ok('Apps Script, ' + name + ': exactly one red difference per unmeasured till is gone', gone === rows.filter(r => r.cloverCard == null && r.businessDate === TODAY && r.status !== 'clover_unavailable').length);
    });
    const apps = html(world({ ops: false, role: 'admin' }), SETS['a past day with two sets of results (a re-run)']);
    t.ok('both sets are still listed, with no control and no note', trows(apps) === 2 && !/reconPastBtn|data-rerun|earlier result|Run again/.test(apps));
    const w = world({ ops: false, role: 'admin' });
    html(w, SETS['one set of past results']);
    t.eq('and nothing is wired to open the form', [w.panel.wired.length, w.sheets.length], [0, 0]);
  }

  // ── The Operations app ─────────────────────────────────────
  {
    const ops = role => world({ ops: true, role });
    ['admin', 'manager', 'payroll_admin'].forEach(role => {
      const h = html(ops(role), [row()]);
      t.ok(role + ': "Run again for a past day" is on the screen, beside Reconcile today', /id="reconPastBtn"[^>]*>Run again for a past day</.test(h) && /id="reconRunBtn"/.test(h));
    });
    t.ok('an employee (who cannot open the screen) is offered nothing', !/reconPastBtn|data-rerun/.test(html(ops('employee'), [row()])));
    t.ok('with no role known, nothing is offered', !/reconPastBtn|data-rerun/.test(html(ops(undefined), [row()])));

    // A day with two sets shows the newest and says so.
    let w = ops('admin');
    let h = html(w, [row({ validatedAt: RERUN_AT, cashCounted: 111 }), row({ validatedAt: FIRST_AT, cashVariance: 270, status: 'investigate', cashCounted: 381 })]);
    t.eq('a past day with two sets of results lists ONE set: the newest', [trows(h), /\$111\.00/.test(h), /\$381\.00/.test(h)], [1, true, false]);
    t.ok('and says it was run again, on which day, and how many results it replaced', h.indexOf('re-run on 2026-11-27 · 1 earlier result') !== -1);
    t.ok('the History count is the days\' current rows', h.indexOf('History (1 shifts)') !== -1);
    t.ok('the day offers "Run again" with its date', /<button class="recon-btn recon-btn-quiet" data-rerun="2026-11-20">Run again<\/button>/.test(h));
    t.eq('one button per day, however many rows', (html(ops('admin'), [row(), row({ companies: 'cstore' })]).match(/data-rerun=/g) || []).length, 1);

    h = html(ops('admin'), [row({ validatedAt: '2026-11-29T20:00:00.000Z' }), row({ validatedAt: RERUN_AT }), row({ validatedAt: FIRST_AT })]);
    t.ok('three sets: "2 earlier results"', h.indexOf('2 earlier results') !== -1);

    // Automatic runs of different tills are each current; a later manual run replaces them.
    const auto1 = row({ mode: 'auto', companies: 'cstore', validatedAt: '2026-11-20T21:00:00.000Z', cashierCard: 1240, cloverCard: null, cardVariance: null, cashierCredit: null, cashierDebit: null });
    const auto2 = row({ mode: 'auto', companies: 'vape', validatedAt: '2026-11-21T02:30:00.000Z' });
    h = html(ops('admin'), [auto2, auto1]);
    t.ok('two automatic runs (two tills) are both shown and are not "earlier results"', trows(h) === 2 && h.indexOf('earlier result') === -1);
    h = html(ops('admin'), [row({ validatedAt: RERUN_AT }), auto2, auto1]);
    t.ok('a manual run replaces the automatic runs before it', trows(h) === 1 && h.indexOf('2 earlier results') !== -1);
    h = html(ops('admin'), [auto2, row({ validatedAt: '2026-11-20T23:00:00.000Z' }), auto1]);
    t.ok('an automatic run after the newest manual one (a till that closed later) is part of the day', trows(h) === 2 && h.indexOf('1 earlier result') !== -1);

    // A day first reconciled by a past-day run.
    h = html(ops('admin'), [row({ validatedAt: RERUN_AT })]);
    t.ok('a day whose only results were made later says "run on" that day, not "re-run"', h.indexOf('run on 2026-11-27') !== -1 && h.indexOf('re-run') === -1);
    h = html(ops('admin'), [row()]);
    t.ok('an ordinary day says nothing', h.indexOf('earlier result') === -1 && h.indexOf('run on') === -1 && h.indexOf('re-run') === -1);

    // Today's forced re-run reads the same way.
    h = html(ops('admin'), [row({ businessDate: TODAY, validatedAt: RERUN_AT, cashCounted: 222 }), row({ businessDate: TODAY, validatedAt: FIRST_AT, cashCounted: 333 })]);
    t.ok('today with a forced re-run shows the newest result and says "re-run · 1 earlier result"', /\$222\.00/.test(h) && !/\$333\.00/.test(h) && h.indexOf('re-run · 1 earlier result') !== -1);

    // Not verified stays in words, never a measured $0.00; text is escaped.
    const unmeasured = o => row(Object.assign({ companies: '<b>cstore</b>', cloverCard: null, cardVariance: null, cashierCredit: null, cashierDebit: null, cashierCard: 1240 }, o));
    h = html(ops('admin'), [unmeasured({ validatedAt: RERUN_AT }), unmeasured()]);
    const cardCell = (/data-label="Cards">([\s\S]*?)<\/div>/.exec(h) || [])[1] || '';
    t.ok('cards with no measurement read "not verified", with no measured $0.00 and no loss', /not verified/.test(cardCell) && cardCell.indexOf('$1240.00') !== -1 && cardCell.indexOf('$0.00') === -1 && h.indexOf('-$1240.00') === -1);
    t.ok('a company name is escaped', h.indexOf('<b>cstore') === -1 && h.indexOf('&lt;b&gt;cstore') !== -1);

    // ── The form ──
    w = ops('admin');
    html(w, [row()]);
    t.ok('the toolbar button is wired', typeof w.$('reconPastBtn').onclick === 'function' && w.panel.wired.length === 1 && typeof w.panel.wired[0].onclick === 'function');
    w.$('reconPastBtn').onclick();
    const sheet = w.sheets[w.sheets.length - 1];
    const yesterday = (() => { const d = new Date(vm.runInContext('torontoToday_()', w) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
    t.eq('the form opens with the day set to yesterday and an empty reason', [w.sheetDom().get('rpDate').value, w.sheetDom().get('rpReason').value, w.sheetDom().get('rpDate').value < TODAY], [yesterday, '', true]);
    t.ok('it says plainly that no message is sent and earlier results are kept',
      sheet.bodyHTML.indexOf('No WhatsApp message is sent') !== -1 && sheet.bodyHTML.indexOf('earlier results are kept') !== -1);
    w.panel.wired[0].onclick();
    t.eq('"Run again" on a listed day opens the form with that day', w.sheetDom().get('rpDate').value, PAST);

    // Validation before any call.
    w.sheetDom().get('rpReason').value = ' ab ';
    pending.push(w.sheetDom().get('rpGo').onclick().then(() => {
      t.ok('a reason under 3 characters is refused on the page, with no call', w.calls.length === 0 && w.toasts.some(x => /reason/i.test(x[0])));
      w.sheetDom().get('rpDate').value = '';
      w.sheetDom().get('rpReason').value = 'Till 2 count was fixed';
      return w.sheetDom().get('rpGo').onclick();
    }).then(() => { t.ok('no day picked is refused on the page, with no call', w.calls.length === 0); }));

    // A run.
    const answer = {
      ready: true, mode: 'manual', date: PAST, rerun: true, sent: false, previous: 2, whatsappSummary: 'not sent: a re-run of a past day sends no message',
      merchants: [
        { companies: ['vape'], status: 'investigate', windowStart: '2026-11-20T14:00:00.000Z', windowEnd: '2026-11-21T02:20:00.000Z', cashierCard: 51, cloverCard: null, cashierCredit: 1, cashierDebit: 50, cloverCredit: null, cloverDebit: null, cashSales: 51, cashCounted: 105, cashVariance: -6 },
        { companies: ['cstore'], status: 'OK', windowStart: null, windowEnd: null, cashierCard: 1240, cloverCard: null, cashierCredit: null, cashierDebit: null, cloverCredit: null, cloverDebit: null, cashSales: 600, cashCounted: 850, cashVariance: 0 },
      ],
    };
    const ran = world({ ops: true, role: 'manager', answer: () => answer });
    html(ran, [row()]);
    ran.panel.wired[0].onclick();
    ran.sheetDom().get('rpDate').value = PAST;
    ran.sheetDom().get('rpReason').value = '  Till 2 count was fixed on Monday  ';
    pending.push(ran.sheetDom().get('rpGo').onclick().then(() => {
      t.eq('exactly the day and the trimmed reason are sent, with the session token', ran.calls, [['rpcReconcilePastDay', 'tok', { date: PAST, reason: 'Till 2 count was fixed on Monday' }]]);
      const shown = ran.sheets[ran.sheets.length - 1];
      t.ok('the answer is shown as a manual run is: each till\'s figures', /Cash \(recorded \/ counted\)/.test(shown.bodyHTML) && shown.bodyHTML.indexOf('$105.00') !== -1 && shown.bodyHTML.indexOf('vape') !== -1 && shown.bodyHTML.indexOf('cstore') !== -1);
      t.ok('cards without a measurement are "not verified" there too, never a measured $0.00',
        /Cards<\/span><span>\$1240\.00 <small>single total, not verified/.test(shown.bodyHTML) && !/Credit<\/span><span>\$0\.00/.test(shown.bodyHTML) && shown.bodyHTML.indexOf('Total</span>') === -1);
      t.ok('and no "Total sales" line compares the day\'s cash sales with a Clover figure that was never measured', shown.bodyHTML.indexOf('Total sales') === -1);
      t.ok('it says no message was sent and that earlier rows are kept', shown.bodyHTML.indexOf('No WhatsApp message was sent') !== -1 && shown.bodyHTML.indexOf('2 earlier result rows are kept') !== -1);
      t.ok('a toast says the same', ran.toasts.some(x => x[1] === 'success' && /no WhatsApp message sent/.test(x[0])));
      t.eq('and the list reloads with the history open', [ran.reloads, ran.state.reconHistOpen], [1, true]);
    }));

    // Where Clover measured the cards, the list's own detail is used: credit, debit and total, claimed against measured.
    const measured = world({ ops: true, role: 'admin', answer: () => ({ ready: true, date: PAST, previous: 0, merchants: [{ companies: ['vape'], status: 'OK', windowStart: null, windowEnd: null, cashierCard: 51, cloverCard: 51, cashierCredit: 1, cashierDebit: 50, cloverCredit: 1, cloverDebit: 50, cashSales: 51, cashCounted: 111, cashVariance: 0 }] }) });
    html(measured, [row()]);
    measured.panel.wired[0].onclick();
    measured.sheetDom().get('rpReason').value = 'Matched check';
    pending.push(measured.sheetDom().get('rpGo').onclick().then(() => {
      const b = measured.sheets[measured.sheets.length - 1].bodyHTML;
      t.ok('a till whose cards were measured shows credit, debit and total against Clover, and says there were no earlier results', /Credit/.test(b) && /Debit/.test(b) && /Total sales/.test(b) && !/not verified/.test(b) && b.indexOf('There were no earlier results.') !== -1);
    }));

    // A refusal.
    const refused = world({ ops: true, role: 'admin', answer: () => new Error('Use Reconcile today for today.') });
    html(refused, [row()]);
    refused.panel.wired[0].onclick();
    refused.sheetDom().get('rpReason').value = 'A good reason';
    pending.push(refused.sheetDom().get('rpGo').onclick().then(() => {
      t.ok('a refusal is shown, the button comes back, and nothing reloads',
        refused.errors[0] === 'Use Reconcile today for today.' && refused.reloads === 0 && refused.sheetDom().get('rpGo').disabled === false && refused.sheetDom().get('rpGo').textContent === 'Run again');
    }));
  }

  // ── The page wires it ──
  t.section('The page wires it');
  t.ok('renderReconPanel asks isOpsApp_() and reconPastOffered_ with the session role', /isOpsApp_\(\)/.test(H.fnSource(js, 'renderReconPanel')) && /reconPastOffered_\(state\.me && state\.me\.role, ops\)/.test(H.fnSource(js, 'renderReconPanel')));
  t.ok('the call is named only by the form that sends it', js.split('rpcReconcilePastDay').length - 1 === H.fnSource(js, 'openReconPast_').split('rpcReconcilePastDay').length - 1);
  t.ok('this copy of the page has the control', js.indexOf('Run again for a past day') !== -1 && js.indexOf('id="reconPastBtn"') !== -1);
  t.ok('no var and no template tag in the new functions', ['reconPastOffered_', 'reconDays_', 'reconDayNote_', 'reconYesterday_', 'reconPastFormHTML_', 'reconRecordRow_', 'reconPastGroup_', 'reconPastResultHTML_', 'openReconPast_']
    .every(n => !/\bvar\s+[A-Za-z_$]/.test(H.fnSource(js, n)) && H.fnSource(js, n).indexOf('<?') === -1));
});

// ── The built Operations page ──
pending.push(import(path.join(H.REPO, 'ops', 'tools', 'build-ui.mjs')).then(({ buildUi }) => {
  const built = buildUi({ write: false });
  t.section('The built Operations page');
  t.ok('carries the control, its call and its note', built.indexOf('Run again for a past day') !== -1 && built.indexOf("'rpcReconcilePastDay'") !== -1 && built.indexOf('No WhatsApp message is sent') !== -1);
  t.ok('and no template tag', built.indexOf('<?') === -1);
}));

Promise.all(pending).then(() => t.done()).catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
