// ============================================================
//  ui-dashboard — tender tiles and the day chart
// ============================================================
//  The sales tab reads a range that now spans a till migration: some days
//  carry a credit/debit breakdown and some carry one card figure. What the
//  tiles must never do is let a tender disappear halfway through a range — a
//  Card tile that vanishes reads as a business that stopped taking cards.
//
//  The chart is the only per-day totals view, so every bar carries its own
//  amount, and it has to open on the newest day without yanking itself
//  sideways when a reader taps a bar.
// ============================================================
const vm = require('vm');
const H = require('./_lib/harness');
const t = H.suite('Sales tab — tiles and chart');

const js = H.clientScript('Index.html');
const NEEDED = ['esc', 'money', 'compactMoney', 'dayParts',
                'chartScrollTarget_', 'renderSalesBody'];
const lifted = NEEDED.map(n => H.fnSource(js, n)).join('\n\n');

function render(data) {
  const out = {
    innerHTML: '',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const ctx = {
    console: { log() {}, error() {}, warn() {} },
    state: { salesData: data, salesExpandedDays: {} },
    $: () => out,
    haptic: () => {},
    focusSalesChart_: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(lifted + '\nrenderSalesBody();', ctx);
  return out.innerHTML;
}

function daily(n, total) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({ dateStr: '2026-09-' + String(i).padStart(2, '0'),
                total: total === undefined ? 1000 + i : total,
                byCompany: { cstore: 800, vape: 200 } });
  }
  return rows;
}

// ── Tender tiles ────────────────────────────────────────────
const tiles = html => (html.match(/sales-total-label">([^<]+)</g) || [])
  .map(s => s.replace(/.*">/, '').replace('<', ''));
const tileValue = (html, label) => {
  const re = new RegExp('sales-total-label">' + label +
                        '</div><div class="sales-total-amount">([^<]+)<');
  const m = re.exec(html);
  return m ? m[1] : null;
};

t.section('An ePOS-only range — one card figure, no breakdown anywhere');
let html = render({
  totals: { total: 9000, cash: 3000, credit: 0, debit: 0, cardAll: 6000, misc: 0 },
  daily: daily(3), companies: ['cstore'], rows: [],
});
t.eq('four tiles, always the same four', tiles(html), ['Total', 'Cash', 'Card', 'Misc']);
t.eq('Card carries the whole card total', tileValue(html, 'Card'), '$6000.00');
t.ok('no Credit tile', tiles(html).indexOf('Credit') === -1);
t.ok('no Debit tile', tiles(html).indexOf('Debit') === -1);
t.ok('nothing to explain, so nothing is said', html.indexOf('ds-note') === -1);

t.section('A fully split range — same tiles, plus the breakdown as a note');
html = render({
  totals: { total: 9000, cash: 3000, credit: 4000, debit: 2000, cardAll: 6000, misc: 0 },
  daily: daily(3), companies: ['cstore', 'vape'], rows: [],
});
t.eq('still four tiles', tiles(html), ['Total', 'Cash', 'Card', 'Misc']);
t.eq('Card is still the sum', tileValue(html, 'Card'), '$6000.00');
t.ok('the breakdown is a note, not a tile', /is split by type/.test(html));
t.ok('credit named in the note', /credit \$4000\.00/.test(html));
t.ok('debit named in the note', /debit \$2000\.00/.test(html));
t.ok('nothing is described as partial', !/reported as one card figure/.test(html));

t.section('A range that spans the migration says how much is broken down');
html = render({
  totals: { total: 9000, cash: 3000, credit: 2000, debit: 1000, cardAll: 6000, misc: 0 },
  daily: daily(3), companies: ['cstore', 'vape'], rows: [],
});
t.eq('the Card tile does not shrink to the split part',
     tileValue(html, 'Card'), '$6000.00');
t.ok('the note states the split portion', /Of the card total, \$3000\.00 is split by type/.test(html));
t.ok('and that the rest is one figure', /reported as one card figure/.test(html));

t.section('An older payload with no cardAll still shows a Card tile');
// The field arrived with the ePOS work; a cached response from before it must
// not blank the tile out.
html = render({
  totals: { total: 9000, cash: 3000, credit: 4000, debit: 2000, misc: 0 },
  daily: daily(3), companies: ['cstore'], rows: [],
});
t.eq('falls back to credit + debit', tileValue(html, 'Card'), '$6000.00');

// ── Chart labels ────────────────────────────────────────────
t.section('Every bar carries its own amount');
html = render({
  totals: { total: 9000, cash: 3000, cardAll: 6000, credit: 0, debit: 0, misc: 0 },
  daily: daily(7), companies: ['cstore', 'vape'], rows: [],
});
t.eq('one amount label per bar',
     (html.match(/class="sc-amt"/g) || []).length,
     (html.match(/class="sc-col/g) || []).length);
t.eq('seven bars for seven days', (html.match(/class="sc-col/g) || []).length, 7);
t.ok('labels are compact, not full money', /\$1\.0k|\$1,0/.test(html));

t.section('A day the payouts outran shows as a loss, not as its own opposite');
html = render({
  totals: { total: 500, cash: -300, cardAll: 800, credit: 0, debit: 0, misc: 0 },
  daily: [{ dateStr: '2026-09-01', total: -300, byCompany: { cstore: -300 } }],
  companies: ['cstore'], rows: [],
});
// Read the bar's own label, not the page: the Cash tile also prints -$300.00
// and would mask a chart that had dropped the sign.
const barLabels = (html.match(/class="sc-amt">([^<]*)</g) || [])
  .map(m => m.replace(/.*">/, '').replace('<', ''));
t.eq('the bar is labelled as a loss', barLabels, ['-$300']);

t.section('compactMoney itself');
const ctx = vm.createContext({});
vm.runInContext(lifted, ctx);
const compact = ctx.compactMoney;
t.eq('under a thousand is rounded whole', compact(950), '$950');
t.eq('thousands get one decimal', compact(1361), '$1.4k');
t.eq('five figures drop the decimal', compact(13610), '$14k');
t.eq('a negative keeps its sign', compact(-1361), '-$1.4k');
t.eq('so does a small negative', compact(-300), '-$300');
t.eq('but a rounding-error zero does not get a minus', compact(-0.001), '$0');
t.eq('junk is zero, not NaN', compact('nonsense'), '$0');

// ── Where the chart sits ────────────────────────────────────
t.section('The chart opens on the newest day');
// The track is built oldest-first, so left is the past. Nothing selected means
// a reader who just opened the tab, and they want the newest day.
const target = ctx.chartScrollTarget_;
t.eq('nothing selected scrolls to the far right', target(null, 0, 360, 2000, null), 1640);
t.eq('a track that fits does not scroll', target(null, 0, 2000, 360, null), 0);

t.section('Tapping a visible bar does not yank the chart sideways');
// selLeft 400, width 40, viewport 360 starting at 380 — fully on screen.
t.eq('the reader keeps their position', target(400, 40, 360, 2000, 380), 380);
t.eq('a bar flush with the left edge counts as visible', target(380, 40, 360, 2000, 380), 380);
t.eq('a bar flush with the right edge counts as visible', target(700, 40, 360, 2000, 380), 380);

t.section('A selection off-screen is centred');
t.eq('one to the right', target(1000, 40, 360, 2000, 380), 1000 - 160);
t.eq('one to the left', target(100, 40, 360, 2000, 800), 100 - 160 < 0 ? 0 : 100 - 160);
t.eq('never past the end', target(1980, 40, 360, 2000, 0), 1640);
t.eq('never before the start', target(0, 40, 360, 2000, 900), 0);

t.section('No previous position is not the same as a visible selection');
// First paint has nothing to preserve, so a selection must still be centred
// rather than left wherever the track happens to open.
t.eq('centred on first paint', target(1000, 40, 360, 2000, null), 840);

t.done();
