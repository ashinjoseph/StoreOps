// ============================================================
//  parity — the two pages read the same ledger, so they must agree
// ============================================================
//  The same Sales.getDashboard payload is drawn twice: once in the app, for
//  whoever is logged in, and once on a no-login page owners open from a
//  WhatsApp link. They are different code in different files and nothing
//  makes them stay in step.
//
//  Drift here is worse than a bug on either page alone — two figures for the
//  same day, both presented as the truth, with no way for a reader to tell
//  which one is wrong. So this suite builds one real payload from a sheet
//  fixture and holds the two renderings against each other.
// ============================================================
const vm = require('vm');
const H = require('./_lib/harness');
const t = H.suite('App and public page agree');

const COLS = ['sales_id','session_id','staff_id','company','date',
  'cash_sales','credit_card_sales','debit_card_sales','cashback_paid',
  'hst_collected','bottle_deposit','round_off',
  'misc_cash_sales','misc_credit_sales','misc_debit_sales','misc_notes',
  'card_total_sales','misc_card_sales'];
const IX = {}; COLS.forEach((c, i) => { IX[c] = i; });

let ROWS = [];
function row(dateStr, company, fields) {
  const r = new Array(COLS.length).fill('');
  r[IX.sales_id] = 'SL' + ROWS.length; r[IX.session_id] = 'T' + ROWS.length;
  r[IX.staff_id] = 'S_1'; r[IX.company] = company;
  r[IX.date] = new Date(dateStr + 'T00:00:00');
  Object.keys(fields).forEach(k => { r[IX[k]] = fields[k]; });
  ROWS.push(r);
}

/** One real payload, straight out of Sales.gs. */
function payload(build) {
  ROWS = [];
  build();
  H.sheets({ sales: { headers: COLS, rows: ROWS }, config: {} });
  const M = H.load(['Util.gs', 'Sales.gs'],
    { Staff: { getAll: () => ([{ staffId: 'S_1', name: 'Ashin' }]) } });
  return M.Sales.getDashboard({
    startDate: new Date('2026-09-01T00:00:00'),
    endDate: new Date('2026-09-05T23:59:59'),
    pageSize: 500,
  });
}

// ── The app's rendering ─────────────────────────────────────
const appJs = H.clientScript('Index.html');
const appLifted = ['esc', 'money', 'compactMoney', 'dayParts', 'renderSalesBody']
  .map(n => H.fnSource(appJs, n)).join('\n\n');

function renderApp(d) {
  const out = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const ctx = vm.createContext({
    console: { log() {}, error() {} },
    state: { salesData: d, salesExpandedDays: {} },
    $: () => out, haptic: () => {}, focusSalesChart_: () => {},
  });
  vm.runInContext(appLifted + '\nrenderSalesBody();', ctx);
  return out.innerHTML;
}

// ── The public page's rendering ─────────────────────────────
// The whole page, exactly as served: the payload is substituted for the
// templating scriptlet and render() runs on a stub document.
const pubHtml = H.read('PublicSales.html');
const pubJs = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/.exec(pubHtml)[1]
  .replace(/<\?[\s\S]*?\?>/, 'PAYLOAD');

function renderPublic(d) {
  const app = { innerHTML: '' };
  const ctx = vm.createContext({
    PAYLOAD: {
      days: 5, fromStr: '2026-09-01', toStr: '2026-09-05',
      totals: d.totals, companies: d.companies, sessionCount: d.totalCount,
      daily: (d.daily || []).map(x => ({ dateStr: x.dateStr, total: x.total,
        sessionCount: x.sessionCount, byCompany: x.byCompany || {} })),
      insights: d.insights || null,
    },
    document: { getElementById: () => app,
                querySelector: () => ({ scrollLeft: 0, scrollWidth: 900, clientWidth: 360 }) },
    console: { log() {}, error() {} },
  });
  vm.runInContext(pubJs, ctx);
  return app.innerHTML;
}

// ── Reading a figure back out of each page ──────────────────
const appTile = (html, label) => {
  const m = new RegExp('sales-total-label">' + label +
    '</div><div class="sales-total-amount">([^<]+)<').exec(html);
  return m ? m[1] : null;
};
const pubTile = (html, label) => {
  const m = new RegExp('class="k">' + label + '</div><div class="v">([^<]+)<').exec(html);
  return m ? m[1] : null;
};
const appBars = html => (html.match(/class="sc-amt">([^<]*)</g) || [])
  .map(m => m.replace(/.*">/, '').replace('<', ''));
// Scoped to the chart: the insight cards use `amt` for their hero figures too,
// and picking those up would compare the chart against the wrong numbers.
const pubBars = html => (html.match(/class="col"[^>]*><div class="amt">([^<]*)</g) || [])
  .map(m => m.replace(/.*">/, '').replace('<', ''));

function both(build) {
  const d = payload(build);
  return { data: d, app: renderApp(d), pub: renderPublic(d) };
}

// ── The ranges that matter ──────────────────────────────────
const RANGES = {
  'an ePOS-only range': () => {
    row('2026-09-01', 'cstore', { cash_sales: 600, card_total_sales: 1240 });
    row('2026-09-02', 'cstore', { cash_sales: 550, card_total_sales: 1100 });
    row('2026-09-03', 'cstore', { cash_sales: 700, card_total_sales: 900 });
  },
  'a split-card range': () => {
    row('2026-09-01', 'vape', { cash_sales: 100, credit_card_sales: 200, debit_card_sales: 50 });
    row('2026-09-02', 'vape', { cash_sales: 120, credit_card_sales: 180, debit_card_sales: 60 });
  },
  'a range spanning the migration': () => {
    row('2026-09-01', 'cstore', { cash_sales: 600, credit_card_sales: 800, debit_card_sales: 440 });
    row('2026-09-02', 'cstore', { cash_sales: 550, card_total_sales: 1100 });
    row('2026-09-02', 'vape', { cash_sales: 120, credit_card_sales: 180, debit_card_sales: 60 });
    row('2026-09-03', 'cstore', { cash_sales: 700, card_total_sales: 900 });
  },
  'a day the lotto payouts outran the takings': () => {
    row('2026-09-01', 'cstore', { cash_sales: -300, card_total_sales: 100 });
    row('2026-09-02', 'cstore', { cash_sales: 600, card_total_sales: 1240 });
  },
  'a range with misc sales on it': () => {
    row('2026-09-01', 'cstore', { cash_sales: 600, card_total_sales: 1240,
                                  misc_cash_sales: 20, misc_card_sales: 15 });
    row('2026-09-02', 'cstore', { cash_sales: 550, card_total_sales: 1100 });
  },
};

Object.keys(RANGES).forEach(name => {
  const r = both(RANGES[name]);
  t.section('Both pages agree on ' + name);
  t.ok('the app rendered something', r.app.length > 0);
  t.ok('the public page rendered something', r.pub.length > 0);
  ['Cash', 'Card'].forEach(tender => {
    const a = appTile(r.app, tender), p = pubTile(r.pub, tender);
    t.ok(tender + ' is shown on both', a !== null && p !== null);
    t.eq(tender + ' is the same figure', p, a);
  });
  t.eq('the same number of days is charted', pubBars(r.pub).length, appBars(r.app).length);
  t.eq('and every day is the same figure', pubBars(r.pub), appBars(r.app));
});

t.section('The split note says the same thing on both, or neither says it');
let r = both(RANGES['a range spanning the migration']);
const appNote = /Of the card total, ([^<]*)</.exec(r.app);
const pubNote = /Of the card total, ([^<]*)</.exec(r.pub);
t.ok('both pages carry the note', !!appNote && !!pubNote);
t.ok('both name the same split total',
     appNote && pubNote && appNote[1].split(' is')[0] === pubNote[1].split(' is')[0]);
t.ok('both say the rest is a single figure',
     /single card figure|one card figure/.test(r.app) &&
     /single card figure|one card figure/.test(r.pub));

r = both(RANGES['an ePOS-only range']);
t.ok('neither explains a breakdown that does not exist',
     r.app.indexOf('Of the card total') === -1 && r.pub.indexOf('Of the card total') === -1);

t.section('Neither page loses the Card tender when nothing is split');
r = both(RANGES['an ePOS-only range']);
t.eq('the app still shows Card', appTile(r.app, 'Card'), '$3240.00');
t.eq('so does the public page', pubTile(r.pub, 'Card'), '$3240.00');

t.section('The totals the pages show are the ones the ledger holds');
// Not just equal to each other — equal to the sum of the rows.
r = both(RANGES['a range spanning the migration']);
t.eq('cash is the sum of the cash column', r.data.totals.cash, 1970);
t.eq('card is the sum of both card shapes', r.data.totals.cardAll, 3480);
t.eq('the app prints that cash figure', appTile(r.app, 'Cash'), '$1970.00');
t.eq('the app prints that card figure', appTile(r.app, 'Card'), '$3480.00');
t.eq('the public page prints the same cash', pubTile(r.pub, 'Cash'), '$1970.00');
t.eq('the public page prints the same card', pubTile(r.pub, 'Card'), '$3480.00');

t.done();
