// ============================================================
//  perf — the read path, counted
// ============================================================
//  Apps Script charges per sheet read, and the dashboard calls getAll_ at
//  least twice per request: once for the visible range, once for the insight
//  baseline. A per-execution cache made that one read. These assertions exist
//  so a later change cannot quietly put the cost back — nothing on screen
//  looks different when it does.
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('read-path cost');

const COLS = ['sales_id','session_id','staff_id','company','date',
  'cash_sales','credit_card_sales','debit_card_sales','cashback_paid',
  'hst_collected','bottle_deposit','round_off',
  'misc_cash_sales','misc_credit_sales','misc_debit_sales','misc_notes',
  'card_total_sales','misc_card_sales'];
const IX = {}; COLS.forEach((c, i) => { IX[c] = i; });

// Count getValues calls against the sales sheet by wrapping the stub.
let reads = 0;
function countingSheets(rows) {
  H.sheets({ sales: { headers: COLS, rows: rows }, config: {} });
  const real = global.SpreadsheetApp;
  return real;
}
function instrument() {
  const ss = global.SpreadsheetApp.getActiveSpreadsheet();
  const orig = ss.getSheetByName;
  global.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: name => {
        const sh = orig(name);
        if (!sh || name !== 'sales') return sh;
        const g = sh.getRange;
        sh.getRange = function (r, c, nr, nc) {
          const range = g.call(sh, r, c, nr, nc);
          const gv = range.getValues;
          range.getValues = function () {
            // Only bulk data reads count; the header probe is not the cost.
            if (r >= 3 && (nr || 1) > 1) reads++;
            return gv.call(range);
          };
          return range;
        };
        return sh;
      },
      insertSheet: () => null,
    }),
    getUi: () => ({ alert: () => {} }),
  };
}

function build(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = new Array(COLS.length).fill('');
    r[IX.sales_id] = 'SL' + i; r[IX.session_id] = 'T' + i; r[IX.staff_id] = 'S_1';
    r[IX.company] = i % 5 === 0 ? 'vape' : 'cstore';
    const d = new Date(2026, 5, 1 + (i % 60));
    r[IX.date] = d;
    r[IX.cash_sales] = 300; r[IX.credit_card_sales] = 200; r[IX.debit_card_sales] = 100;
    rows.push(r);
  }
  return rows;
}

let M;
function fresh(n) {
  reads = 0;
  countingSheets(build(n));
  // load() installs SpreadsheetApp, so wrap it AFTER. The module resolves the
  // global at call time, so a later swap is still seen.
  M = H.load(['Util.gs', 'Sales.gs'], { Staff: { getAll: () => ([{ staffId: 'S_1', name: 'Ashin' }]) } });
  instrument();
  reads = 0;
}
const dash = (company) => M.Sales.getDashboard({
  startDate: new Date('2026-06-01T00:00:00'), endDate: new Date('2026-07-31T23:59:59'),
  company: company || null, pageSize: 50,
});

t.section('One dashboard load costs exactly one read');
fresh(300);
let d = dash();
t.eq('one bulk read', reads, 1);
t.ok('and it returned data', d.totals.total > 0);
t.ok('including the insight baseline', !!d.insights.trend);

t.section('The per-company split adds no read');
fresh(300);
dash();
const withSplit = reads;
t.eq('still one', withSplit, 1);

t.section('A second call in the same execution is free');
fresh(300);
dash(); dash(); dash();
t.eq('three dashboards, one read', reads, 1);

t.section('A write busts the cache — staleness costs more than a read');
fresh(300);
dash();
t.eq('warm', reads, 1);
M.Sales.write({ sessionId: 'T_NEW', staffId: 'S_1', company: 'cstore',
                date: new Date('2026-06-15T00:00:00'), cashSales: 10,
                creditCardSales: 0, debitCardSales: 0 }, 'S_1');
const after = reads;
t.ok('the write re-read rather than trusting the cache', after > 1);
// The real hazard: write_ ends by re-reading through getForSession_, and a warm
// cache would hand back the pre-write record — or nothing at all for a new row.
const back = M.Sales.getForSession('T_NEW');
t.ok('and the new row is visible immediately', !!back);
t.eq('with the value just written', back.cashSales, 10);

t.section('Cost does not grow with the range');
fresh(1200);
reads = 0;
dash();
t.eq('still one read at 1200 rows', reads, 1);

t.done();
