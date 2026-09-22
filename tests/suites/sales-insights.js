// ============================================================
//  sales-insights — shaped data, so a wrong answer is visible
// ============================================================
//  The fixture is built so a sign flip or an off-by-one bucket boundary
//  changes the answer. June + July 2026, 61 days: base weekday $400, weekend
//  $800, and days 1–10 lifted 40% — the whole `early` bucket and nothing else,
//  so a day-10/day-11 slip moves the winner.
//
//  Averaging is PER TRADING DAY, not per session. That distinction once
//  flipped a published weekday conclusion, so it is asserted directly.
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('sales insights');

const COLS = ['sales_id','session_id','staff_id','company','date',
  'cash_sales','credit_card_sales','debit_card_sales','cashback_paid',
  'hst_collected','bottle_deposit','round_off',
  'misc_cash_sales','misc_credit_sales','misc_debit_sales','misc_notes',
  'card_total_sales','misc_card_sales'];
const IX = {}; COLS.forEach((c, i) => { IX[c] = i; });

let ROWS = [], M;
function reset() {
  ROWS = [];
  H.sheets({ sales: { headers: COLS, rows: ROWS }, config: {} });
  M = H.load(['Util.gs', 'Sales.gs'], { Staff: { getAll: () => ([{ staffId: 'S_1', name: 'Ashin' }]) } });
}
function row(dateStr, company, cash, card) {
  const r = new Array(COLS.length).fill('');
  r[IX.sales_id] = 'SL' + ROWS.length; r[IX.session_id] = 'T' + ROWS.length;
  r[IX.staff_id] = 'S_1'; r[IX.company] = company;
  r[IX.date] = new Date(dateStr + 'T00:00:00');
  r[IX.cash_sales] = cash; r[IX.credit_card_sales] = card; r[IX.debit_card_sales] = 0;
  ROWS.push(r);
}
const dash = (a, b, company) => M.Sales.getDashboard({
  startDate: new Date(a + 'T00:00:00'), endDate: new Date(b + 'T23:59:59'),
  company: company || null, pageSize: 500,
});
const iso = d => d.toISOString().slice(0, 10);

// Build the shaped range.
function seed(company) {
  for (let m = 5; m <= 6; m++) {                     // June (5) and July (6)
    const last = new Date(2026, m + 1, 0).getDate();
    for (let day = 1; day <= last; day++) {
      const d = new Date(2026, m, day);
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      let amount = weekend ? 800 : 400;
      if (day <= 10) amount = Math.round(amount * 1.4);
      row(iso(d), company || 'cstore', amount * 0.6, amount * 0.4);
    }
  }
}

t.section('Shape is recovered from the data');
reset(); seed();
let d = dash('2026-06-01', '2026-07-31');
t.eq('61 trading days', d.daily.length, 61);
t.eq('one session per day', d.totals.sessionCount, 61);
t.near('per trading day equals total / days', d.insights.trend.perTradingDay,
       d.totals.total / 61, 0.02);

t.section('Weekday averages are per trading day');
const dw = d.insights.dayOfWeek;
t.ok('not suppressed over 61 days', !dw.insufficient);
t.ok('weekend wins', ['Saturday', 'Sunday'].indexOf(dw.best.name) !== -1);
t.ok('weekday loses', ['Saturday', 'Sunday'].indexOf(dw.worst.name) === -1);
const sat = dw.buckets.find(b => b.name === 'Saturday');
t.near('Saturday average is the per-day figure, not a per-session one',
       sat.average, sat.total / sat.days, 0.011);
t.ok('every bucket averages over its own day count',
     dw.buckets.every(b => !b.days || Math.abs(b.average - b.total / b.days) < 0.011));

t.section('The part-of-month boundary is exactly day 10');
const tm = d.insights.timeOfMonth;
t.ok('not suppressed over two months', !tm.insufficient);
// `strongest` publishes the label, not the key.
t.eq('the lifted bucket wins', tm.strongest.label, 'Days 1-10');
t.ok('and by a visible margin', tm.strongest.average > tm.weakest.average * 1.2);
const early = tm.buckets.find(b => b.key === 'early');
const mid = tm.buckets.find(b => b.key === 'mid');
t.eq('early covers 20 days', early.days, 20);
t.eq('mid covers 20 days', mid.days, 20);
t.ok('and early really is higher', early.average > mid.average);

t.section('Short ranges are suppressed, not guessed');
reset();
row('2026-06-01', 'cstore', 100, 100);
row('2026-06-02', 'cstore', 100, 100);
d = dash('2026-06-01', '2026-06-02');
t.ok('time-of-month suppressed under a month', !!d.insights.timeOfMonth.insufficient);
t.ok('and says why', /month/i.test(d.insights.timeOfMonth.insufficient));

reset(); row('2026-06-01', 'cstore', 100, 100);
d = dash('2026-06-01', '2026-06-01');
t.ok('one weekday is not a weekday comparison', !!d.insights.dayOfWeek.insufficient);

t.section('Trend compares against the preceding window');
reset(); seed();
d = dash('2026-07-01', '2026-07-31');
const tr = d.insights.trend;
t.eq('31 trading days', tr.tradingDays, 31);
t.ok('a previous window was found', tr.previousTotal > 0);
t.near('change amount is the difference', tr.changeAmount,
       tr.total - tr.previousTotal, 0.011);
t.ok('best and worst days are named', !!tr.best && !!tr.worst);
t.ok('best is at least worst', tr.best.total >= tr.worst.total);

t.section('Per-company split appears only when unfiltered');
reset();
seed('cstore');
row('2026-06-15', 'vape', 60, 40);
d = dash('2026-06-01', '2026-07-31');
t.ok('byCompany present with two tills', !!d.insights.byCompany);
t.ok('and names both', !!d.insights.byCompany.cstore && !!d.insights.byCompany.vape);
t.near('company totals sum to the headline',
       d.insights.byCompany.cstore.total + d.insights.byCompany.vape.total,
       d.totals.total, 0.02);
d = dash('2026-06-01', '2026-07-31', 'cstore');
t.ok('absent when filtered to one company', !d.insights.byCompany);

t.section('A blank company still counts toward the day');
reset();
row('2026-06-01', 'cstore', 100, 100);
row('2026-06-01', '', 50, 50);
d = dash('2026-06-01', '2026-06-01');
t.eq('the day total includes it', d.daily[0].total, 300);
const parts = Object.keys(d.daily[0].byCompany)
  .reduce((s, k) => s + d.daily[0].byCompany[k], 0);
t.near('and the segments still sum to the bar', parts, d.daily[0].total, 0.011);

t.done();
