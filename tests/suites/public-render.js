// Run the WHOLE PublicSales page render, not just chart(). An exception
// anywhere in render() leaves #app untouched — which on a phone is a blank page
// with no error, exactly what was reported.
const fs = require('fs'), vm = require('vm');
const html = fs.readFileSync('/home/user/StoreOps/src/PublicSales.html', 'utf8');

// Lift the inline script, replace the templated payload with a real one.
const m = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/.exec(html);
let js = m[1].replace(/<\?[\s\S]*?\?>/, 'PAYLOAD');

const daily = [];
for (let i = 0; i < 5; i++) {
  daily.push({ dateStr: '2026-09-0' + (i + 1), total: 1800 + i * 10,
               byCompany: { cstore: 1600 + i * 10, vape: 200 } });
}
function payload(totals) {
  return {
    fromStr: '2026-07-15', toStr: '2026-09-12', days: 60,
    totals: totals, daily: daily, companies: ['cstore', 'vape'],
    sessionCount: 120,
    insights: INS,
  };
}

// The shapes Sales.buildInsights_ actually emits — never null, never {}.
const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const INS = {
  trend: { changePoints: 4.2, current: 9000, previous: 8640, basis: 'per trading day' },
  dayOfWeek: {
    buckets: DOW.map((n, i) => ({ dow: i, name: n, short: SHORT[i],
                                  total: 1000 * (i + 1), days: 8, average: 125 * (i + 1) })),
    best:  { dow: 6, name: 'Saturday', short: 'Sat', average: 875, days: 8 },
    worst: { dow: 0, name: 'Sunday',   short: 'Sun', average: 125, days: 8 },
  },
  timeOfMonth: {
    buckets: [{ key: 'early', label: 'Days 1-10', average: 1800, days: 20 },
              { key: 'mid',   label: 'Days 11-20', average: 1700, days: 20 },
              { key: 'late',  label: 'Days 21+',  average: 1900, days: 20 }],
    strongest: { key: 'late', label: 'Days 21+', average: 1900 },
    weakest:   { key: 'mid',  label: 'Days 11-20', average: 1700 },
  },
  cashShare: { pct: 33.3, cash: 3000, total: 9000 },
  // Without byCompany the split() helper returns '' and never runs — which is
  // exactly the call that broke. Two companies so the strips actually render.
  byCompany: {
    cstore: { total: 7800, perTradingDay: 1560, tradingDays: 5, sharePct: 86.7,
              sessionCount: 90, cashSharePct: 50.4,
              dayOfWeek: { best:  { name: 'Friday', average: 2191 },
                           worst: { name: 'Sunday', average: 1100 } },
              timeOfMonth: { strongest: { label: 'Days 21+' } },
              trend: { changePoints: 3.1 } },
    vape:   { total: 1200, perTradingDay: 240, tradingDays: 5, sharePct: 13.3,
              sessionCount: 30, cashSharePct: 30.7,
              dayOfWeek: { best:  { name: 'Tuesday', average: 333 },
                           worst: { name: 'Sunday', average: 120 } },
              timeOfMonth: { strongest: { label: 'Days 1-10' } },
              trend: { changePoints: -1.4 } },
  },
};

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { pass++; console.log('  \u2713 ' + l); }
  else { fail++; console.log('  \u2717 ' + l); } };

const app = { innerHTML: '' };
function run(label, data) {
  app.innerHTML = '';
  const ctx = vm.createContext({
    PAYLOAD: data,
    document: {
      getElementById: () => app,
      // The chart scrolls itself to the newest days after render.
      querySelector: () => ({ scrollLeft: 0, scrollWidth: 2000, clientWidth: 360 }),
    },
    console: console,
  });
  try {
    vm.runInContext(js, ctx);
    const out = app.innerHTML || '';
    console.log((out.trim() ? '  ✓ ' : '  ✗ BLANK ') + label + '  (' + out.length + ' chars)');
    return out;
  } catch (e) {
    console.log('  ✗ THREW  ' + label + '  → ' + e.message);
    return null;
  }
}

console.log('\nPublicSales render');
// What getDashboard returns TODAY, post-ePOS-batch.
run('totals with cardAll present', payload({
  total: 9000, cash: 3000, credit: 0, debit: 0, card: 6000, cardAll: 6000,
  misc: 0, cashback: 0, sessionCount: 120, splitRows: 0, totalRows: 120 }));

// What a payload looks like if cardAll is missing — e.g. an older cached shape.
run('totals WITHOUT cardAll', payload({
  total: 9000, cash: 3000, credit: 4000, debit: 2000, misc: 0,
  cashback: 0, sessionCount: 120 }));

run('historical split range', payload({
  total: 9000, cash: 3000, credit: 4000, debit: 2000, card: 0, cardAll: 6000,
  misc: 0, cashback: 0, sessionCount: 120, splitRows: 120, totalRows: 0 }));

run('unavailable payload', { days: 60, unavailable: 'Report temporarily unavailable.' });

run('empty range', { fromStr: '2026-09-01', toStr: '2026-09-12', days: 12,
  totals: { total: 0, cash: 0, credit: 0, debit: 0, card: 0, cardAll: 0, misc: 0,
            cashback: 0, sessionCount: 0, splitRows: 0, totalRows: 0 },
  daily: [], companies: [], sessionCount: 0,
  insights: INS });

console.log('\nThe tender note reports coverage without shadowing the helper');
let out = run('mixed range shows the split note', payload({
  total: 9000, cash: 3000, credit: 2000, debit: 1000, card: 3000, cardAll: 6000,
  misc: 0, cashback: 0, sessionCount: 120, splitRows: 60, totalRows: 60 }));
ok('Card tile present', /<div class="k">Card<\/div>/.test(out));
ok('no standalone Credit tile', !/<div class="k">Credit<\/div>/.test(out));
ok('note states the split portion', /is recorded split by type/.test(out));
ok('note says the rest is a single figure', /single card figure/.test(out));
ok('insight strips still rendered — the helper was not shadowed',
   (out.match(/class="split"/g) || []).length >= 2);

out = run('card-only range omits the note', payload({
  total: 9000, cash: 3000, credit: 0, debit: 0, card: 6000, cardAll: 6000,
  misc: 0, cashback: 0, sessionCount: 120, splitRows: 0, totalRows: 120 }));
ok('no coverage note when nothing is split', !/is recorded split by type/.test(out));
ok('Card tile still present', /<div class="k">Card<\/div>/.test(out));

console.log('\nA throw fails legibly instead of blank');
const src = fs.readFileSync('/home/user/StoreOps/src/PublicSales.html', 'utf8');
ok('render is wrapped', /\(function main\(\) \{\s*\n\s*try \{\s*\n\s*render\(\);/.test(src));
ok('the catch writes into #app', /catch \(err\)[\s\S]{0,200}getElementById\('app'\)/.test(src));
ok('and names the error', /failed to render/.test(src));
// Prove it: break the payload so render() throws, and confirm the page says so.
app.innerHTML = '';
const ctx = vm.createContext({
  PAYLOAD: { totals: {}, daily: [], companies: [],
             insights: { dayOfWeek: { buckets: [] } } },   // best/worst missing
  document: { getElementById: () => app, querySelector: () => null },
  console: { log(){}, error(){} },
});
try { vm.runInContext(js, ctx); } catch (e) { /* must not escape */ }
ok('a broken payload still writes something', (app.innerHTML || '').trim().length > 0);
ok('and says the report failed', /failed to render/.test(app.innerHTML || ''));

console.log('\n' + (fail === 0 ? '✅ ' : '❌ ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
