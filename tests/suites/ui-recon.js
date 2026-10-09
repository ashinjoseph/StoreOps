// ============================================================
//  ui-recon — the reconcile panel on the dashboard
// ============================================================
//  A till with no Clover has nothing measuring its cards. The server stores
//  that as a blank and reads it back as null; the panel must then show the
//  claimed figure on its own. Rendering null as $0.00 paints the whole card
//  take as a red shortfall on every past day of history.
// ============================================================
const vm = require('vm');
const H = require('./_lib/harness');
const t = H.suite('Reconcile panel — history and today');

const js = H.clientScript('Index.html');
const NEEDED = ['esc', 'money', 'todayMidnight', 'isoDate', 'fmtWin_',
                'pairVar_', 'signedMoney_', 'reconGroupDetail_', 'reconRow_',
                'renderReconPanel'];
const lifted = NEEDED.map(n => H.fnSource(js, n)).join('\n\n');

function render(rows) {
  const out = { innerHTML: '', onclick: null, disabled: false, textContent: '' };
  const ctx = {
    console: { log() {}, error() {}, warn() {} },
    state: { reconHistOpen: true },
    $: () => out,
    haptic: () => {}, toast: () => {}, call: async () => ({}), loadReconPanel: () => {},
    Date, Math, Number, String,
  };
  vm.createContext(ctx);
  ctx.ROWS = rows;
  vm.runInContext(lifted + '\nrenderReconPanel(ROWS);', ctx);
  return out.innerHTML;
}

const PAST = '2026-09-14';
function row(o) {
  return Object.assign({
    businessDate: PAST, windowStart: null, windowEnd: null,
    companies: 'cstore', status: 'OK', cashSales: 600,
    cashCounted: 850, cashVariance: 0, cashierCard: 1240,
    cashierCredit: null, cashierDebit: null,
    cloverCredit: null, cloverDebit: null, cloverCard: null, cardVariance: null,
  }, o || {});
}
const cardsCell = html => {
  const m = /data-label="Cards">([\s\S]*?)<\/div>/.exec(html);
  return m ? m[1] : '';
};

t.section('A past day with no Clover shows the claim, not a loss');
let html = render([row()]);
let cell = cardsCell(html);
t.ok('the claimed card figure is shown', cell.indexOf('$1240.00') !== -1);
t.ok('it says the cards were not verified', /not verified/.test(cell));
t.ok('no measured $0.00 is invented', cell.indexOf('$0.00') === -1);
t.ok('and no red shortfall', cell.indexOf('-$1240.00') === -1 && cell.indexOf('bad') === -1);

t.section('A past day with Clover still shows the comparison');
html = render([row({ companies: 'vape', cloverCard: 1200, cardVariance: 40 })]);
cell = cardsCell(html);
t.ok('both figures are shown', cell.indexOf('$1240.00 / $1200.00') !== -1);
t.ok('a real difference is still red', /pv-var bad/.test(cell));
t.ok('and is not called unverified', !/not verified/.test(cell));

t.section('A measured zero is a measurement');
html = render([row({ companies: 'vape', cashierCard: 0, cloverCard: 0, cardVariance: 0 })]);
cell = cardsCell(html);
t.ok('zero against zero is a clean match', /pv-var ok/.test(cell));
t.ok('not "not verified"', !/not verified/.test(cell));

t.done();
