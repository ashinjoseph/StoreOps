// ============================================================
//  ui-sales-channels — "From the till" on the Sales screen
//  (Operations app only; the vape and All views)
// ============================================================
//  Card P5-03b; ADR-0023, ADR-0024. These assertions run the page's own
//  functions, lifted from both copies of the page (src/Index.html and the
//  Worker's built ops/public/index.html):
//   - the section exists only in the Operations app and only when the
//     vape or the All view is selected; the cstore view, and Apps Script
//     in every role, make no call and write no element;
//   - it is loaded AFTER the screen has drawn (the screen never waits
//     for the till), with a quiet placeholder meanwhile; an old answer
//     never paints over a newer one;
//   - each state of the link shows its message and no figures at all; a
//     switched-off link is said only to the role that can open Settings;
//   - "no figures" and $0.00 are different things on screen; a refund
//     and a negative day show as negative;
//   - "N days to check" and "did not all add up" appear only when the
//     server says so; the side-by-side of what was entered at close and
//     what the till rang has no verdict (no colour, no "error");
//   - everything the server sent is escaped; no var, no storage;
//   - inside Apps Script the Sales screen is byte-identical to what it
//     was (a frozen copy of renderSalesBody), for every role;
//   - the built Operations page carries the section.
// ============================================================
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const H = require('./_lib/harness');
const t = H.suite('Sales by channel — "From the till" on the Sales screen, Operations app');

// renderSalesBody exactly as it was before this card (commit ac249bb), frozen: inside Apps Script the
// screen must still produce what this produced.
const ORIGINAL_BODY = fs.readFileSync(path.join(__dirname, '_lib', 'sales-body-before-p503b.txt'), 'utf8');

const OWN = ['salesTillWanted_', 'salesTillHostHTML_', 'salesTillDayHostHTML_', 'salesSelectedDay_', 'tillDayLabel_', 'tillChannelHTML_', 'tillChannelsHTML_',
  'salesTillHTML_', 'salesTillDayHTML_', 'paintSalesTill_', 'loadSalesTill_'];
const NEEDED = ['esc', 'money', 'signedMoney_', 'compactMoney', 'dayParts', 'isOpsApp_', 'isReadMethod_', 'chartScrollTarget_', 'missedShiftOffers_', 'missedShiftControl_',
  'tillRowOffers_', 'tillRowControl_', 'torontoWall_', 'torontoToday_', 'renderSalesBody'].concat(OWN);

const STATES = [
  ['off', 'The link to the till is switched off (Settings, Till). Sign-in and everything else work as usual.'],
  ['not_configured', 'The link to the till is switched on but not set up: it needs the till\'s address in Settings and the key installed.'],
  ['no_store', 'The till\'s store is not matched to this store yet (Staff, Till logins).'],
  ['unreachable', 'The till could not be reached just now (it may be down). What is saved is shown; try again later.'],
  ['refused', 'The till did not accept the key. It may have expired or been withdrawn: install a new one.'],
  ['bad_answer', 'The till answered with something this app does not understand. Nothing was changed; tell whoever looks after the till link.'],
];

const ch = o => Object.assign({ total: 0, net: 0, hst: 0, refunds: 0, count: 0, refundCount: 0, days: 1 }, o || {});
const NONE = { till: null, online: null, delivery: null, all: null };
const ok = over => Object.assign({
  state: 'ok', message: 'The till answered.',
  range: { from: '2026-11-20', to: '2026-11-27', clamped: false },
  channels: {
    till: ch({ total: 266.55, net: 235, hst: 30.55, refunds: -5, count: 7, refundCount: 1, days: 3 }),
    online: ch({ total: 22.6, net: 20, hst: 2.6, count: 1 }),
    delivery: Object.assign(ch({ total: 28.25, net: 25, hst: 3.25, count: 1 }), { orders: 1, fees: 5 }),
    all: ch({ total: 317.4, net: 280, hst: 36.4, refunds: -5, count: 9, refundCount: 1, days: 3 }),
  },
  day: {
    till: ch({ total: 67.8, net: 60, hst: 7.8, count: 2 }),
    online: ch({ total: 22.6, net: 20, hst: 2.6, count: 1 }),
    delivery: Object.assign(ch({ total: 28.25, net: 25, hst: 3.25, count: 1 }), { orders: 1, fees: 5 }),
    all: ch({ total: 118.65, net: 105, hst: 13.65, count: 4 }),
  },
  enteredAtClose: { total: 192.35, days: 3 }, toCheck: [], brokenRows: false,
}, over || {});
const notOk = (state, message) => ({ state, message, range: { from: '2026-11-20', to: '2026-11-27', clamped: false }, channels: null, day: null, enteredAtClose: { total: 150.3, days: 1 }, toCheck: [], brokenRows: false });

const DATA = {
  totals: { total: 9000, cash: 3000, credit: 0, debit: 0, cardAll: 6000, misc: 0 },
  daily: [
    { dateStr: '2026-11-24', total: 100, sessionCount: 1, byCompany: { vape: 100 } },
    { dateStr: '2026-11-25', total: 200, sessionCount: 2, byCompany: { vape: 200 } },
  ],
  companies: ['vape'], rows: [], rowCount: 0,
};

const pendingSync = [];
const settle = () => new Promise(r => setImmediate(r)).then(() => new Promise(r => setImmediate(r)));

H.uiScripts().forEach(([label, js]) => {
  t.section('Against ' + label);
  const own = OWN.map(n => H.fnSource(js, n)).join('\n');
  const lifted = NEEDED.map(n => (n === 'loadSalesTill_' ? 'async ' : '') + H.fnSource(js, n)).join('\n\n');

  function world(opts) {
    let html = '';
    const w = { sent: [], toasts: [], elems: {}, lost: 0 };
    const results = {
      get innerHTML() { return html; },
      set innerHTML(h) { html = h; w.elems = {}; },
      querySelector: () => null, querySelectorAll: () => [],
    };
    const filters = Object.assign({ company: '', startDate: '2026-11-20', endDate: '2026-11-27', staffId: '' }, opts.filters || {});
    Object.assign(w, {
      console: { log() {}, error() {}, warn() {} },
      Intl, Date, Math, Number, String, JSON, isNaN, Promise, Object, parseFloat,
      window: opts.ops === false ? {} : { STOREOPS_APP: 'ops' },
      state: { token: 'tok', me: { role: opts.role || 'admin' }, salesData: opts.data || DATA, salesExpandedDays: opts.expanded || {}, salesFilters: filters },
      $: id => (id === 'salesResults' ? results : (html.indexOf('id="' + id + '"') !== -1 ? (w.elems[id] = w.elems[id] || { innerHTML: '' }) : null)),
      haptic() {}, focusSalesChart_() {},
      handleRpcError: e => w.lost++ + w.toasts.push(e.message),
      call: (method, ...args) => {
        w.sent.push([method].concat(args));
        const a = opts.answer ? opts.answer(method, args) : ok();
        if (a && typeof a.then === 'function') return a;
        return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
      },
    });
    vm.createContext(w);
    vm.runInContext(lifted, w);
    w.draw = () => { vm.runInContext('renderSalesBody', w)(); return html; };
    w.html = () => html;
    w.fn = n => vm.runInContext(n, w);
    return w;
  }
  const tillBox = w => (w.elems.salesTill ? w.elems.salesTill.innerHTML : null);
  const dayBox = w => (w.elems.salesTillDay ? w.elems.salesTillDay.innerHTML : null);

  t.ok(label + ': no var in the section (it would hoist over a module helper)', !/\bvar\b/.test(own));
  t.ok(label + ': no localStorage or sessionStorage in the section', !/localStorage|sessionStorage/.test(own));
  t.ok(label + ': no template tag in the section', own.indexOf('<?') === -1);
  t.eq(label + ': the call is named only inside the section\'s own functions', (js.split('rpcGetSalesByChannel').length - 1), (own.split('rpcGetSalesByChannel').length - 1));

  // ── Who gets the section ──────────────────────────────────
  pendingSync.push(async () => {
    const run = [];
    for (const company of ['', 'vape', 'cstore', 'unassigned']) {
      for (const ops of [true, false]) {
        const w = world({ ops, filters: { company } });
        w.draw();
        await settle();
        const wanted = ops && (company === '' || company === 'vape');
        run.push([company, ops, w.html().indexOf('id="salesTill"') !== -1, w.html().indexOf('id="salesTillDay"') !== -1, w.sent.length]);
        t.eq(label + ': company "' + company + '" ' + (ops ? 'in the Operations app' : 'inside Apps Script') + (wanted ? ': a host element, a day element and one call' : ': no host element, no day element, no call'),
          run[run.length - 1].slice(2), wanted ? [true, true, 1] : [false, false, 0]);
      }
    }
    // the call is the session token and the screen's own range and day, nothing else
    const w = world({ expanded: { '2026-11-24': true }, filters: { company: 'vape', staffId: 'S_003' } });
    w.draw();
    await settle();
    t.eq(label + ': the call carries the token, the range and the selected day only (no store, no role, no staff)', w.sent, [['rpcGetSalesByChannel', 'tok', { from: '2026-11-20', to: '2026-11-27', day: '2026-11-24' }]]);
    const newest = world({});
    newest.draw();
    await settle();
    t.eq(label + ': with no day chosen it asks for the newest day', newest.sent[0][2].day, '2026-11-25');
    const none = world({ data: Object.assign({}, DATA, { daily: [] }) });
    none.draw();
    await settle();
    t.eq(label + ': with no days on the screen it asks for none (null)', none.sent[0][2].day, null);
    const noRange = world({ filters: { startDate: '', endDate: '' } });
    noRange.draw();
    await settle();
    t.eq(label + ': without a range there is no section and no call', [noRange.html().indexOf('id="salesTill"'), noRange.sent.length], [-1, 0]);
    t.ok(label + ': a read: the page\'s read cache is not cleared by it', w.fn('isReadMethod_')('rpcGetSalesByChannel') === true);

    // ── The screen draws first and never waits for the till ──
    const slow = world({ answer: () => new Promise(() => {}) });
    const drawn = slow.draw();
    t.ok(label + ': the totals, the bars and the day are on screen before the till has answered', /sales-total-label">Total</.test(drawn) && /sc-col/.test(drawn) && /day-item open/.test(drawn));
    t.ok(label + ': and the section holds a quiet placeholder while it waits', /Loading the till&#39;s figures/.test(tillBox(slow)) && drawn.indexOf('From the till') === -1);
    t.ok(label + ': the section sits under the totals and before the bars', drawn.indexOf('sales-totals') < drawn.indexOf('id="salesTill"') && drawn.indexOf('id="salesTill"') < drawn.indexOf('sales-chart'));
    t.ok(label + ': the selected day\'s element is inside its detail', drawn.indexOf('day-body') < drawn.indexOf('id="salesTillDay"'));

    // an older answer never paints over a newer one
    const resolvers = [];
    const racing = world({ answer: () => new Promise(r => resolvers.push(r)) });
    racing.draw();
    racing.state.salesExpandedDays = { '2026-11-24': true };
    racing.draw();
    resolvers[1](ok({ enteredAtClose: { total: 2, days: 2 } }));
    await settle();
    resolvers[0](ok({ enteredAtClose: { total: 1, days: 1 } }));
    await settle();
    t.ok(label + ': a late answer for an earlier draw is dropped', /\$2\.00/.test(tillBox(racing)) && !/Entered at close<strong>\$1\.00/.test(tillBox(racing)));

    // a failed call is shown in the section only
    const fails = world({ answer: () => new Error('SERVER_ERROR') });
    fails.draw();
    await settle();
    t.ok(label + ': a call that fails says so in the section; the totals are untouched', /could not be loaded: SERVER_ERROR/.test(tillBox(fails)) && /sales-total-label">Total</.test(fails.html()) && fails.lost === 0);
    const gone = world({ answer: () => new Error('NOT_LOGGED_IN') });
    gone.draw();
    await settle();
    t.ok(label + ': a lost sign-in goes to the app\'s own handler', gone.toasts.some(x => /NOT_LOGGED_IN/.test(x)));
    const refused = world({ answer: () => new Error('The end date is in the future (today is 2026-11-27); the till has no figures for days to come.') });
    refused.draw();
    await settle();
    t.ok(label + ': a refused request shows its words', /The end date is in the future/.test(tillBox(refused)));
  });

  // ── Each state ────────────────────────────────────────────
  pendingSync.push(async () => {
    for (const [state, message] of STATES) {
      const w = world({ role: 'admin', answer: () => notOk(state, message) });
      w.draw();
      await settle();
      const h = tillBox(w);
      t.ok(label + ': ' + state + ': its message, as the server wrote it, and no figures', h.indexOf(message.replace(/'/g, '&#39;')) !== -1 && h.indexOf('data-till-state="' + state + '"') !== -1 && h.indexOf('$') === -1 && h.indexOf('tl-row') === -1 && h.indexOf('tl-pair') === -1);
      t.eq(label + ': ' + state + ': one muted line, and no day lines', [(h.match(/tl-muted/g) || []).length, dayBox(w)], [1, '']);
      t.ok(label + ': ' + state + ': the rest of the screen is as drawn', /sales-total-label">Total</.test(w.html()) && /sc-col/.test(w.html()));
      if (state === 'off') {
        for (const role of ['manager', 'payroll_admin']) {
          const m = world({ role, answer: () => notOk(state, message) });
          m.draw();
          await settle();
          t.eq(label + ': off: nothing at all for a ' + role + ' (they cannot open Settings)', tillBox(m), '');
        }
      } else {
        const m = world({ role: 'manager', answer: () => notOk(state, message) });
        m.draw();
        await settle();
        t.ok(label + ': ' + state + ': a manager is told too', tillBox(m).indexOf(message.replace(/'/g, '&#39;')) !== -1);
      }
    }
  });

  // ── The figures ───────────────────────────────────────────
  pendingSync.push(async () => {
    const w = world({ answer: () => ok() });
    w.draw();
    await settle();
    const h = tillBox(w);
    t.ok(label + ': ok: In store, Online, Delivery and All channels, each with its total', ['In store', 'Online', 'Delivery', 'All channels'].every(n => h.indexOf('<span>' + n + '</span>') !== -1) && /\$266\.55/.test(h) && /\$22\.60/.test(h) && /\$28\.25/.test(h) && /\$317\.40/.test(h));
    t.ok(label + ': ok: before tax, tax, refunds and the counts are under each total', /before tax \$235\.00 · tax \$30\.55 · refunds -\$5\.00 · 7 sales, 1 refund · 3 days/.test(h));
    t.ok(label + ': ok: Delivery adds its orders and its fees, and says the fees are inside', /1 order · delivery fees \$5\.00 \(already inside these figures\)/.test(h));
    t.ok(label + ': ok: the section says it is the till\'s and not part of the totals', /From the till/.test(h) && /not part of the totals above/.test(h));
    t.ok(label + ': ok: no note when nothing is to check and nothing is broken', h.indexOf('data-till-check') === -1 && h.indexOf('data-till-broken') === -1 && h.indexOf('did not all add up') === -1);
    const d = dayBox(w);
    t.ok(label + ': the selected day has its three lines and the all-channels line', ['In store', 'Online', 'Delivery', 'All channels'].every(n => d.indexOf('<span>' + n + '</span>') !== -1) && /\$67\.80/.test(d) && /\$118\.65/.test(d) && /From the till, Nov 25/.test(d));
    t.ok(label + ': and the day is not flagged when the server does not list it', d.indexOf('To check in the till') === -1);

    // no figures is not $0.00
    const mixed = ok({ channels: { till: ch({ total: 0, days: 2 }), online: null, delivery: null, all: ch({ total: 0, days: 2 }) } });
    const m = world({ answer: () => mixed });
    m.draw();
    await settle();
    const mh = tillBox(m);
    t.ok(label + ': a channel reported as 0 shows $0.00', /<span>In store<\/span><strong>\$0\.00<\/strong>/.test(mh));
    t.ok(label + ': a channel not reported shows "no figures", never $0.00', /<span>Online<\/span><span class="tl-none">no figures<\/span>/.test(mh) && /<span>Delivery<\/span><span class="tl-none">no figures<\/span>/.test(mh));
    const empty = world({ answer: () => ok({ channels: NONE, day: NONE }) });
    empty.draw();
    await settle();
    const eh = tillBox(empty);
    t.ok(label + ': a range with nothing reported: every line says no figures, with a sentence, and not one amount', (eh.match(/no figures/g) || []).length >= 4 && /reported no sales for these days/.test(eh) && !/<strong>\$/.test(eh.replace(/<div class="tl-pair"[\s\S]*$/, '')));
    t.ok(label + ': and the day with nothing says no figures on each of its lines', (dayBox(empty).match(/no figures/g) || []).length === 4);

    // negatives
    const neg = world({ answer: () => ok({ channels: { till: ch({ total: -8.9, net: -7.3, hst: -1.6, refunds: -13.95, refundCount: 2, count: 0 }), online: null, delivery: null, all: ch({ total: -8.9 }) } }) });
    neg.draw();
    await settle();
    t.ok(label + ': a negative total and negative refunds are shown as negative', /<strong>-\$8\.90<\/strong>/.test(tillBox(neg)) && /refunds -\$13\.95/.test(tillBox(neg)) && /before tax -\$7\.30/.test(tillBox(neg)));

    // the range's note and the day's mark
    const chk = world({ answer: () => ok({ toCheck: ['2026-11-22', '2026-11-25'] }) });
    chk.draw();
    await settle();
    t.ok(label + ': two days to check: the range says "2 days to check" and names them, and the selected day is marked', /2 days to check in the till: Nov 22, Nov 25/.test(tillBox(chk)) && /counted as the till reports them/.test(tillBox(chk)) && /To check in the till/.test(dayBox(chk)));
    const one = world({ answer: () => ok({ toCheck: ['2026-11-22'] }) });
    one.draw();
    await settle();
    t.ok(label + ': one day: "1 day to check", and a different selected day is not marked', /1 day to check in the till: Nov 22/.test(tillBox(one)) && dayBox(one).indexOf('To check in the till') === -1);
    const broken = world({ answer: () => ok({ brokenRows: true }) });
    broken.draw();
    await settle();
    t.ok(label + ': broken rows: "did not all add up", shown as sent', /The till&#39;s figures did not all add up\. They are shown as the till sent them\./.test(tillBox(broken)));

    // the longer range
    const clamped = world({ answer: () => ok({ range: { from: '2026-08-28', to: '2026-11-27', clamped: true } }) });
    clamped.draw();
    await settle();
    t.ok(label + ': a range cut by the till\'s limit says so, in words, with the days shown', /longer than the till answers at once: showing the newest 92 days, Aug 28 to Nov 27/.test(tillBox(clamped)));
    t.ok(label + ': an uncut range says nothing of it', tillBox(w).indexOf('newest 92 days') === -1);

    // the side by side
    const pair = (tillBox(w).match(/<div class="tl-pair"[\s\S]*?<\/div><\/div>/) || [''])[0];
    t.ok(label + ': side by side: Entered at close, Rung at the till, and the difference (rung minus entered)', /Entered at close<strong>\$192\.35<\/strong>3 days/.test(pair) && /Rung at the till \(In store\)<strong>\$266\.55<\/strong>3 days/.test(pair) && /Difference<strong>\+\$74\.20<\/strong>rung minus entered/.test(pair));
    const sideNotes = tillBox(w).slice(tillBox(w).indexOf('tl-pair'));
    t.ok(label + ': side by side: no verdict: no colour, no class of any kind but the layout\'s, no "error", "wrong", "mismatch"', !/color|background|class="[^"]*(red|bad|ok|warn|err|down|up)\b/.test(pair) && !/error|wrong|mismatch|discrepan|variance|should/i.test(sideNotes) && /Two different measurements/.test(sideNotes));
    const cents = world({ answer: () => ok({ channels: Object.assign({}, ok().channels, { till: ch({ total: 0.3 }) }), enteredAtClose: { total: 0.1, days: 1 } }) });
    cents.draw();
    await settle();
    t.ok(label + ': the difference is worked in cents (0.30 - 0.10 is +$0.20)', /Difference<strong>\+\$0\.20</.test(tillBox(cents)));
    const less = world({ answer: () => ok({ enteredAtClose: { total: 300, days: 3 } }) });
    less.draw();
    await settle();
    t.ok(label + ': the till rang less than was entered: a minus sign, no other signal', /Difference<strong>-\$33\.45<\/strong>/.test(tillBox(less)));
    const nocloses = world({ answer: () => ok({ enteredAtClose: { total: null, days: 0 } }) });
    nocloses.draw();
    await settle();
    t.ok(label + ': no closes in the range: "no closes", not $0.00, and no difference', /Entered at close<strong>no closes<\/strong>0 days/.test(tillBox(nocloses)) && /Difference<strong>—<\/strong>/.test(tillBox(nocloses)));
    const nostore = world({ answer: () => ok({ channels: NONE }) });
    nostore.draw();
    await settle();
    t.ok(label + ': the till reported nothing: "no figures" for the till side and no difference', /Rung at the till \(In store\)<strong>no figures<\/strong>/.test(tillBox(nostore)) && /Difference<strong>—<\/strong>/.test(tillBox(nostore)));
    const staffed = world({ filters: { staffId: 'S_003' } });
    staffed.draw();
    await settle();
    t.ok(label + ': with a staff filter set, the section says the filter does not apply to it', /staff filter does not apply/.test(tillBox(staffed)) && tillBox(w).indexOf('staff filter') === -1);

    // everything the server sent is escaped
    const evil = '"><img src=x onerror=alert(1)>';
    const hostile = world({ answer: () => ok({ message: evil, range: { from: evil, to: evil, clamped: true }, toCheck: [evil], day: Object.assign(ok().day, {}), }) });
    hostile.draw();
    await settle();
    const hh = tillBox(hostile) + dayBox(hostile);
    t.ok(label + ': a hostile range and day are escaped', hh.indexOf('<img') === -1 && hh.indexOf('onerror=alert(1)>') === -1);
    for (const [state] of STATES) {
      const bad = world({ answer: () => notOk(state, evil) });
      bad.draw();
      await settle();
      t.ok(label + ': ' + state + ': a hostile message is escaped', tillBox(bad).indexOf('<img') === -1 && tillBox(bad).indexOf('&lt;img') !== -1);
    }
    const badState = world({ answer: () => notOk(evil, 'x') });
    badState.draw();
    await settle();
    t.ok(label + ': a hostile state is escaped', tillBox(badState).indexOf('<img') === -1);
  });

  // ── Apps Script: byte for byte what it was ────────────────
  pendingSync.push(async () => {
    const SETS = {
      'a range with days': DATA,
      'two companies': Object.assign({}, DATA, { companies: ['cstore', 'vape'], daily: DATA.daily.map(d => Object.assign({}, d, { byCompany: { cstore: 50, vape: d.total } })),
        rows: [{ salesId: 'a', sessionId: 'S1', staffId: 'S_003', staffName: 'Maya Chen', company: 'vape', date: '2026-11-25', cash: 100, credit: null, debit: null, card: 100, misc: 0, cashback: 0, total: 200, miscNotes: '' }], rowCount: 1 }),
      'no days': Object.assign({}, DATA, { daily: [] }),
      'more rows than shown': Object.assign({}, DATA, { rowCount: 5 }),
    };
    for (const role of ['admin', 'manager', 'payroll_admin', 'employee', undefined]) {
      for (const name of Object.keys(SETS)) {
        for (const company of ['', 'vape', 'cstore']) {
          const now = world({ ops: false, role, data: SETS[name], filters: { company } });
          const nowHtml = now.draw();
          await settle();
          const old = world({ ops: false, role, data: SETS[name], filters: { company } });
          vm.runInContext(ORIGINAL_BODY.replace('function renderSalesBody(', 'function originalRenderSalesBody('), old);
          vm.runInContext('originalRenderSalesBody', old)();
          t.ok(label + ': Apps Script, ' + (role || 'no role') + ', ' + name + ', company "' + company + '": the same HTML as before this card, and no call', nowHtml === old.html() && nowHtml.length > 200 && now.sent.length === 0 && nowHtml.indexOf('salesTill') === -1);
        }
      }
    }
    const inOps = world({ ops: true, data: SETS['a range with days'], filters: { company: 'cstore' } });
    const cstoreHtml = inOps.draw();
    const oldOps = world({ ops: true, data: SETS['a range with days'], filters: { company: 'cstore' } });
    vm.runInContext(ORIGINAL_BODY.replace('function renderSalesBody(', 'function originalRenderSalesBody('), oldOps);
    vm.runInContext('originalRenderSalesBody', oldOps)();
    t.ok(label + ': and the cstore view in the Operations app is that too', cstoreHtml === oldOps.html() && inOps.sent.length === 0);
  });
});

finish();
function finish() {
  pendingSync.reduce((p, f) => p.then(f), Promise.resolve()).then(() => {
    // ── The built Operations page carries the section ─────────
    t.section('The two apps');
    const built = require('child_process').execFileSync(process.execPath, [path.join(H.REPO, 'ops', 'tools', 'build-ui.mjs'), '--stdout'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    t.ok('the built page has the section\'s loader, renderers and hosts', ['async function loadSalesTill_(', 'function salesTillHTML_(', 'function salesTillDayHTML_(', 'function salesTillWanted_(', 'function tillChannelHTML_(', 'function paintSalesTill_(']
      .every(s => built.indexOf(s) !== -1));
    t.ok('the built page draws the section after the screen: the call comes after the screen\'s own innerHTML', /\$\('salesResults'\)\.innerHTML = html;[\s\S]{0,200}loadSalesTill_\(\);/.test(built));
    t.ok('the built page asks for the section only through isOpsApp_()', /function salesTillWanted_\(\) \{\s*if \(!isOpsApp_\(\)\) return false;/.test(built));
    const src = fs.readFileSync(path.join(H.SRC, 'Index.html'), 'utf8');
    t.ok('Apps Script never loads the transport, so the section is never asked for there', src.indexOf('/transport.js') === -1);
    t.ok('no template tag in the page, in either copy', src.indexOf('<?') === -1 && built.indexOf('<?') === -1);
    t.done();
  }).catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
}
