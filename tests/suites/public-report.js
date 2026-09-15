// ============================================================
//  public-report — what a link with no login is allowed to say
// ============================================================
//  Both public pages are served to whoever holds the URL. The reconcile
//  report goes out on the shift-close WhatsApp; the sales page goes to
//  owners. Neither has a session behind it, so what the builder puts in the
//  payload IS the access control — there is no second gate downstream.
//
//  The other half is honesty: a section that cannot load must say so rather
//  than take the page down, and a figure nothing measured must be absent
//  rather than zero. Publishing "measured $0.00 · -$1,240.00" in red every
//  day, for a till that simply is not on Clover any more, is a total loss
//  reported to owners on a schedule.
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('Public report payloads');

const TODAY = new Date(2026, 8, 15);          // 15 Sep 2026, local midnight

let dash;
function build(overrides) {
  const o = overrides || {};
  dash = null;
  H.sheets({ config: {} });
  return H.load(['Util.gs', 'PublicReport.gs'], {
    Sales: {
      getDashboard: q => {
        dash = q;
        return o.dashboard || {
          totals: { total: 9000, cash: 3000, cardAll: 6000, credit: 0, debit: 0, misc: 0 },
          companies: ['cstore', 'vape'],
          totalCount: 120,
          daily: [
            { dateStr: '2026-09-14', total: 1800, sessionCount: 2,
              byCompany: { cstore: 1600, vape: 200 },
              // Everything below is present in the dashboard's own rows and
              // must not survive the hop to a no-login page.
              staffName: 'Ash', staffId: 'S1', sessionId: 'SES1' },
          ],
          rows: [{ salesId: 'SL1', staffName: 'Ash', staffId: 'S1',
                   sessionId: 'SES1', miscNotes: 'two bags', date: '2026-09-14' }],
          insights: { cashShare: { pct: 33.3 } },
        };
      },
    },
    Reconcile: { getRecent: () => o.recent || [] },
    TillSessions: { getLottoLog: () => o.lottoLog || { enabled: false } },
    CashHandling: { sheetsExist: () => false, getOutstanding: () => [] },
    Staff: { getAll: () => [] },
  });
}

// Util.todayMidnight is the window's anchor; pin it so the assertions below
// are about the window's shape, not about the day the suite happens to run.
function withToday(fn) {
  const real = Util.todayMidnight;
  Util.todayMidnight = () => new Date(TODAY.getTime());
  try { return fn(); } finally { Util.todayMidnight = real; }
}

// ── The sales page ──────────────────────────────────────────
t.section('The sales payload publishes aggregates and nothing else');
build();
let p = withToday(() => PublicReport.buildSales(60));
const blob = JSON.stringify(p);
t.ok('no session rows at all', p.rows === undefined);
t.ok('no staff name anywhere in the payload', blob.indexOf('staffName') === -1);
t.ok('no staff id', blob.indexOf('staffId') === -1);
t.ok('no session id', blob.indexOf('sessionId') === -1);
t.ok('no sales id', blob.indexOf('salesId') === -1);
t.ok('no cashier-typed notes', blob.indexOf('miscNotes') === -1);
t.eq('a day carries only its shape of trade',
     Object.keys(p.daily[0]).sort(), ['byCompany', 'dateStr', 'sessionCount', 'total']);

t.section('…and enough to draw the page');
t.eq('the totals are there', p.totals.total, 9000);
t.eq('the companies are there', p.companies, ['cstore', 'vape']);
t.eq('the session count is a count, not a list', p.sessionCount, 120);
t.ok('the insights come across', !!p.insights);
t.ok('the window is named', !!p.fromStr && !!p.toStr);
t.ok('and when it was built', !!p.generatedAt);

t.section('The window is the last N days ending today');
build();
p = withToday(() => PublicReport.buildSales(60));
t.eq('sixty days ends today', p.toStr, '2026-09-15');
t.eq('and starts fifty-nine days back', p.fromStr, '2026-07-18');
t.eq('the days are echoed', p.days, 60);
build();
p = withToday(() => PublicReport.buildSales(7));
t.eq('a shorter window starts later', p.fromStr, '2026-09-09');

t.section('A junk window falls back rather than building nothing');
build();
t.eq('junk means the default', withToday(() => PublicReport.buildSales('abc')).days, 60);
t.eq('zero means the default too', withToday(() => PublicReport.buildSales(0)).days, 60);

t.section('The rows are never fetched, only the aggregates');
// Session rows are dropped on the way out, so paying to read them would be
// spending a quota on data the page is forbidden to publish.
build();
withToday(() => PublicReport.buildSales(60));
t.eq('the dashboard is asked for one row', dash.pageSize, 1);
t.eq('from the first page', dash.page, 1);
t.ok('over the right window', Util.formatDate(dash.startDate) === '2026-07-18');

t.section('A section that cannot load says so instead of taking the page down');
H.sheets({ config: {} });
H.load(['Util.gs', 'PublicReport.gs'], {
  Sales: { getDashboard: () => { throw new Error('Sales sheet is missing'); } },
  Reconcile: { getRecent: () => [] },
  TillSessions: { getLottoLog: () => ({ enabled: false }) },
  CashHandling: { sheetsExist: () => false },
  Staff: { getAll: () => [] },
});
// The whole contract is that this does not throw, so catching here turns a
// regression into a failed assertion instead of a dead suite.
let broken = null;
try { broken = withToday(() => PublicReport.buildSales(60)); } catch (err) { broken = null; }
t.ok('the payload still comes back', !!broken);
broken = broken || {};
t.eq('the window survives', broken.days, 60);
t.ok('and the failure is named', !!broken.unavailable);
t.ok('no totals are invented', broken.totals === undefined);

// ── The reconcile report ────────────────────────────────────
function reconRows() {
  return [
    // A cstore day after the migration: nothing measured the cards.
    { businessDate: '2026-09-14', companies: ['cstore'], cashCounted: 700,
      cashVariance: -10, cashierCard: 1240, cloverCard: null, status: 'OK' },
    // A vape day still on Clover.
    { businessDate: '2026-09-13', companies: ['vape'], cashCounted: 300,
      cashVariance: 0, cashierCard: 400, cloverCard: 395, status: 'INVESTIGATE' },
    { businessDate: '2026-09-12', companies: ['vape'], cashCounted: 250,
      cashVariance: 0, cashierCard: 100, cloverCard: 100, status: 'OK' },
  ];
}

t.section('A card figure nothing measured is omitted, not zeroed');
build({ recent: reconRows() });
let r = withToday(() => PublicReport.build(7));
const unmeasured = r.reconcile.rows.filter(x => x.dateStr === '2026-09-14')[0];
t.eq('cardMeasured is absent', unmeasured.cardMeasured, null);
t.eq('and so is the variance', unmeasured.cardVar, null);
t.eq('what the cashier claimed is still published', unmeasured.cardClaimed, 1240);
t.ok('a zero would have published a total loss',
     unmeasured.cardMeasured !== 0 && unmeasured.cardVar !== -1240);

t.section('A day that was measured reports the difference');
const measured = r.reconcile.rows.filter(x => x.dateStr === '2026-09-13')[0];
t.eq('measured comes through', measured.cardMeasured, 395);
t.eq('and the variance is measured minus claimed', measured.cardVar, -5);

t.section('The report says whether the window was clean');
t.eq('newest day first', r.reconcile.rows.map(x => x.dateStr),
     ['2026-09-14', '2026-09-13', '2026-09-12']);
t.eq('clean days counted', r.reconcile.okCount, 2);
t.eq('flagged days counted', r.reconcile.flagged, 1);

t.section('Days outside the window are not published');
build({ recent: reconRows().concat([
  { businessDate: '2026-08-01', companies: ['cstore'], cashCounted: 1, cashVariance: 0,
    cashierCard: 1, cloverCard: 1, status: 'OK' }]) });
r = withToday(() => PublicReport.build(7));
t.ok('an older day is dropped',
     r.reconcile.rows.every(x => x.dateStr >= '2026-09-09'));

t.section('An empty window explains itself');
build({ recent: [] });
r = withToday(() => PublicReport.build(7));
t.eq('no rows', r.reconcile.rows, []);
t.ok('and a note rather than a blank card', !!r.reconcile.note);

t.section('Every section is wrapped, so one failure cannot take the page');
H.sheets({ config: {} });
H.load(['Util.gs', 'PublicReport.gs'], {
  Sales: { getDashboard: () => ({ totals: {}, daily: [], companies: [] }) },
  Reconcile: { getRecent: () => { throw new Error('Reconcile sheet is missing'); } },
  TillSessions: { getLottoLog: () => { throw new Error('no lotto columns'); } },
  CashHandling: { sheetsExist: () => { throw new Error('no cash sheets'); } },
  Staff: { getAll: () => [] },
});
let half = null;
try { half = withToday(() => PublicReport.build(7)); } catch (err) { half = null; }
t.ok('the page is still built', !!half);
half = half || { reserve: {}, cash: {}, reconcile: {} };
t.ok('the reserve section names its problem', !!half.reserve.unavailable);
t.ok('the cash section names its problem', !!half.cash.unavailable);
t.ok('the reconcile section names its problem', !!half.reconcile.unavailable);
t.ok('the header still says when', !!half.generatedAt);
t.eq('and over what window', half.days, 7);

t.done();
