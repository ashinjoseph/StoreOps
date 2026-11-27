// ============================================================
//  ui-recon-unverified — today's Reconcile panel and cards nobody measured
// ============================================================
//  A till whose cards were not measured against the card processor has no
//  measured figure: the server sends `cloverCard: null` (hard rule 1, ADR-0004).
//  That happens for the cstore till (one card total, no processor), the
//  processor switched off or not configured (status OK or investigate, by
//  cash), and the processor unreachable (status clover_unavailable).
//  Today's panel used to set the day's cash sales plus the cashier's card total
//  against "cash sales + null" and print the whole card take as a red difference
//  ("Total sales $3743.68 / $1397.84 (+$2345.84)"). Here the real page
//  functions render hand-built results and the assertions read what a person
//  reads: words, the cashier's own figure, no difference, no red.
// ============================================================
const vm = require('vm');
const H = require('./_lib/harness');
const t = H.suite('Reconcile panel — unmeasured cards read as words, not as a difference');

const NEEDED = ['esc', 'money', 'todayMidnight', 'isoDate', 'fmtWin_', 'pairVar_', 'signedMoney_', 'reconGroupDetail_', 'reconRow_',
                'renderReconPanel', 'isOpsApp_', 'reconPastOffered_', 'reconRecordRow_', 'reconPastGroup_'];

for (const [label, js] of H.uiScripts()) {
t.section('Against ' + label);
const lifted = NEEDED.map(n => H.fnSource(js, n)).join('\n\n');

function world() {
  const out = { innerHTML: '', onclick: null, disabled: false, textContent: '' };
  const ctx = {
    console: { log() {}, error() {}, warn() {} },
    state: { reconHistOpen: true },
    window: {}, $: () => out,
    haptic: () => {}, toast: () => {}, call: async () => ({}), loadReconPanel: () => {},
    Date, Math, Number, String,
  };
  vm.createContext(ctx);
  vm.runInContext(lifted, ctx);
  return { ctx, out };
}
const w = world();
const TODAY = vm.runInContext('isoDate(todayMidnight())', w.ctx);
const row = o => Object.assign({
  businessDate: TODAY, windowStart: null, windowEnd: null, companies: 'cstore', status: 'OK',
  cashSales: 600, cashCounted: 850, cashVariance: 0, cashierCard: 1240,
  cashierCredit: null, cashierDebit: null, cloverCredit: null, cloverDebit: null, cloverCard: null, cardVariance: null,
}, o || {});
const detail = r => vm.runInContext('reconGroupDetail_', w.ctx)(r);
const lines = h => (h.match(/<div class="recon-line">[\s\S]*?<\/div>/g) || []).map(l => l.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
const line = (h, label) => lines(h).filter(l => l.indexOf(label) === 0)[0] || '';

// Nothing on an unmeasured till may read as a card comparison.
function unmeasured(name, r, cardsWords) {
  const h = detail(r);
  const total = line(h, 'Total sales');
  const cards = lines(h).filter(l => /^Cards/.test(l))[0] || '';
  t.ok(name + ': total sales shows the day\'s figure ' + (r.cashSales + r.cashierCard).toFixed(2), total.indexOf('$' + (r.cashSales + r.cashierCard).toFixed(2)) !== -1);
  t.ok(name + ': the total says it is not verified', /not verified/.test(total));
  t.ok(name + ': no difference is computed against the absent side', !/[+\-]\$\d/.test(total) && !/\(/.test(total) && !/ \/ /.test(total));
  t.ok(name + ': the cards line keeps the cashier\'s own figure', cards.indexOf('$' + r.cashierCard.toFixed(2)) !== -1);
  t.ok(name + ': and says in words why there is no comparison', cardsWords.test(cards));
  t.ok(name + ': no red and no over/short from the card comparison', h.indexOf('recon-diff') === -1 && h.indexOf('recon-ok') === -1);
  t.ok(name + ': no measured $0.00 is invented on a card line', lines(h).filter(l => /^(Total sales|Cards|Credit|Debit|Total)/.test(l)).every(l => l.indexOf('$0.00') === -1));
  t.ok(name + ': no Credit/Debit/Total comparison lines', lines(h).every(l => !/^(Credit|Debit|Total)( \$|$)/.test(l)));
  return h;
}

t.section('Measured: unchanged');
{
  const ok = detail(row({ companies: 'vape', cashierCard: 1240, cloverCard: 1240, cardVariance: 0, cashierCredit: 800, cashierDebit: 440, cloverCredit: 800, cloverDebit: 440 }));
  t.eq('matching: total sales set against the measured total, in green', line(ok, 'Total sales'), 'Total sales $1840.00 / $1840.00 (+$0.00)');
  t.ok('matching: credit, debit and total are compared, in green', /Credit \$800\.00 \/ \$800\.00 \(\+\$0\.00\)|Credit \$800.00 \/ \$800.00/.test(line(ok, 'Credit')) && ok.indexOf('recon-diff') === -1);
  const bad = detail(row({ companies: 'vape', status: 'investigate', cashierCard: 1240, cloverCard: 1200, cardVariance: 40 }));
  t.eq('not matching: the difference is shown', line(bad, 'Total sales'), 'Total sales $1840.00 / $1800.00 (+$40.00)');
  t.ok('not matching: and is red', /class="recon-diff">\(\+\$40\.00\)/.test(bad));
  const zero = detail(row({ companies: 'vape', cashSales: 100, cashierCard: 0, cloverCard: 0, cardVariance: 0 }));
  t.ok('a measured zero is a number: compared, green, not "not verified"', line(zero, 'Total sales') === 'Total sales $100.00 / $100.00 (+$0.00)' && !/not verified/.test(zero) && zero.indexOf('recon-ok') !== -1);
  const zeroOff = detail(row({ companies: 'vape', cashSales: 100, cashierCard: 30, cloverCard: 0, cardVariance: 30 }));
  t.ok('a measured zero against a claim is a real, red difference', /\(\+\$30\.00\)/.test(zeroOff) && zeroOff.indexOf('recon-diff') !== -1);
}

t.section('Not measured: the cstore till (one card total, no processor)');
unmeasured('one total, status OK', row({ cashierCard: 2345.84, cashSales: 1397.84 }), /single total, not verified/);
const one = detail(row({ cashierCard: 2345.84, cashSales: 1397.84 }));
t.eq('the line from the live report: no "(+$2345.84)"', line(one, 'Total sales'), 'Total sales $3743.68 reported, not verified');
unmeasured('one total, cash short (investigate)', row({ status: 'investigate', cashVariance: -8, cashierCard: 2345.84, cashSales: 1397.84 }), /single total, not verified/);

t.section('Not measured: a split-card till with the processor off or not configured');
unmeasured('split, processor off / not configured', row({ companies: 'vape', cashierCard: 1240, cashierCredit: 800, cashierDebit: 440 }), /single total, not verified/);

t.section('Not measured: the processor unreachable');
unmeasured('split, unreachable', row({ companies: 'vape', status: 'clover_unavailable', cashierCard: 1240, cashierCredit: 800, cashierDebit: 440 }), /Clover unavailable/);
const gone = detail(row({ companies: 'vape', status: 'clover_unavailable', cashierCard: 1240, cashierCredit: 800, cashierDebit: 440 }));
t.ok('unreachable: the badge still says the status', /recon-badge warn">clover_unavailable/.test(gone));

t.section('Absent is null, undefined or blank; only a number is a measurement');
['undefined', "''"].forEach(v => {
  const r = row({ cashierCard: 500 });
  r.cloverCard = v === 'undefined' ? undefined : '';
  unmeasured('cloverCard ' + v, r, /not verified/);
});

t.section('Today\'s panel and the history table say it the same way');
{
  const out = w.out;
  vm.runInContext('renderReconPanel', w.ctx)([row({ cashierCard: 2345.84, cashSales: 1397.84 }), row({ businessDate: '2026-09-14', cashierCard: 1240 })]);
  const h = out.innerHTML;
  t.ok('today: no red difference anywhere on the panel', h.indexOf('recon-diff') === -1 && !/\(\+\$2345\.84\)/.test(h));
  t.ok('today: the panel says "not verified"', /Total sales[\s\S]*?not verified/.test(h));
  const cell = (/data-label="Cards">([\s\S]*?)<\/div>/.exec(h) || [])[1] || '';
  t.ok('history: the same words, the claim alone, no red', /not verified/.test(cell) && cell.indexOf('$1240.00') !== -1 && cell.indexOf('bad') === -1);
}

t.section('The answer sheet (reconPastGroup_) still agrees');
{
  const g = vm.runInContext('reconPastGroup_', w.ctx);
  t.ok('an unmeasured till is in words there too', /single total, not verified/.test(g(row())));
}

t.section('Code hygiene of the changed function');
t.ok('no var and no template tag', !/\bvar\s+[A-Za-z_$]/.test(H.fnSource(js, 'reconGroupDetail_')) && H.fnSource(js, 'reconGroupDetail_').indexOf('<?') === -1);
}

t.done();
