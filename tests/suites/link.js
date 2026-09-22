// ============================================================
//  link — the dashboard link on the close message
// ============================================================
//  The config holds the plain /exec deployment URL, because that is what the
//  Apps Script console gives you; the query string is this code's job. Two
//  things can go wrong quietly: sending a link that goes nowhere because
//  nothing is configured, and sending one that lands on the app's login
//  screen because the view parameter never got appended.
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('The public dashboard link');

const TS_HEADERS = ['session_id','attendance_id','staff_id','company','date','status',
  'start_time','end_time','expected_opening','opening_float','opening_note',
  'closing_cash_counted','cash_left_in_till','cash_removed_at_close','expected_cash',
  'closing_variance','variance_status','notes',
  'lotto_reserve_counted','lotto_topup_from_till','lotto_reserve_note'];
const VR_HEADERS = ['validation_id','business_date','window_start','window_end','merchant',
  'companies','cashier_credit','clover_credit','cashier_debit','clover_debit',
  'cashier_card','clover_card','card_variance','cash_counted','cash_variance',
  'status','mode','session_ids','computed_at','computed_by','cash_sales'];

const TODAY = new Date(); TODAY.setHours(0, 0, 0, 0);
const at = (h, m) => { const d = new Date(TODAY); d.setHours(h, m, 0, 0); return d; };

function cstoreSession() {
  const r = new Array(21).fill('');
  r[0] = 'CST-1'; r[1] = 'A_1'; r[2] = 'S_004'; r[3] = 'cstore';
  r[4] = TODAY; r[5] = 'closed'; r[6] = at(9, 0); r[7] = at(21, 20);
  r[8] = 250; r[9] = 250; r[11] = 850; r[12] = 250; r[13] = 600; r[14] = 850;
  r[15] = 0; r[16] = 'OK'; r[18] = 500; r[19] = 0;
  return r;
}
const sale = {
  sessionId: 'CST-1', company: 'cstore', cashSales: 600,
  creditCardSales: null, debitCardSales: null, cardTotalSales: 1240,
  miscCashSales: 0, miscCreditSales: null, miscDebitSales: null,
  miscCardSales: null, cardSplit: false,
};

let SENT;
/** Run one close and return the plain-text body the notifier was handed. */
function bodyWith(url) {
  SENT = [];
  const cfg = {
    cstore_default_opening_float: 250, vape_default_opening_float: 60,
    lotto_reserve_default: 500, variance_ok_threshold: 1,
    variance_minor_threshold: 30, card_variance_threshold: 1,
    cstore_card_split: 'false',
    whatsapp_template_shift_close_cstore: 'shift_close_cstore',
  };
  if (url !== undefined) cfg.public_report_url = url;
  H.sheets({
    till_sessions: { headers: TS_HEADERS, rows: [cstoreSession()] },
    validation_results: { headers: VR_HEADERS, rows: [] },
    config: cfg,
  });
  const M = H.load(['Util.gs', 'TillSessions.gs', 'Reconcile.gs'], {
    Clover: { isEnabled: () => true,
              merchantFor: () => ({ merchantId: '', token: '' }),
              getCardTotals: () => ({ ok: false, error: 'not_configured' }) },
    Sales: { getForDateRange: () => [sale], write: () => ({}), getForSession: () => null },
    Staff: { getAll: () => ([{ staffId: 'S_004', name: 'Ashin' }]),
             getById: id => ({ staffId: id, name: id, companiesAuthorized: ['cstore'] }) },
    Attendance: { openOrPromote: () => ({}), complete: () => {} },
    CashHandling: { sheetsExist: () => true,
                    getAllOutstanding: () => ({ grandTotal: 1240, holders: [], stale: [] }) },
    Notifier: { notify: () => {},
                sendOp: (op, params, plain) => { SENT.push({ op, params, plain });
                  return { sent: false, reason: 'harness' }; } },
  });
  M.Reconcile.reconcileDay('S_004', 'manual');
  return (SENT[0] || {}).plain || '';
}
const linkIn = body => (/Sales dashboard: (\S+)/.exec(body) || [])[1] || null;

t.section('Nothing configured means no link, not a dead one');
let body = bodyWith('');
t.eq('no link', linkIn(body), null);
t.ok('and no orphan label left behind', body.indexOf('Sales dashboard') === -1);
t.ok('the message is still sent', body.length > 0);
t.ok('and still signs off', /StoreOps · automated/.test(body));
t.eq('an absent key is the same as a blank one', linkIn(bodyWith(undefined)), null);

t.section('A plain deployment URL gets the view appended');
// The console hands you the /exec URL; nobody should have to remember the
// query string, and a link without it lands on the app's login screen.
body = bodyWith('https://script.google.com/macros/s/AKfy123/exec');
t.eq('the view is appended',
     linkIn(body), 'https://script.google.com/macros/s/AKfy123/exec?v=sales');

t.section('A URL that already carries a query keeps it');
body = bodyWith('https://script.google.com/macros/s/AKfy123/exec?foo=1');
t.eq('joined with an ampersand, not a second question mark',
     linkIn(body), 'https://script.google.com/macros/s/AKfy123/exec?foo=1&v=sales');
t.ok('exactly one question mark', (linkIn(body).match(/\?/g) || []).length === 1);

t.section('The link points at sales, not at the reconcile report');
// The people on this thread are owners and managers, and the message already
// carries the reconciliation. What they want from the link is how trade is
// going.
t.ok('v=sales', /v=sales/.test(linkIn(bodyWith('https://x.test/exec'))));
t.ok('not v=recon', !/v=recon/.test(linkIn(bodyWith('https://x.test/exec'))));

t.section('A config value with stray whitespace still works');
t.eq('trimmed before the query is appended',
     linkIn(bodyWith('  https://x.test/exec  ')), 'https://x.test/exec?v=sales');

t.section('The link sits at the end, after the figures');
body = bodyWith('https://x.test/exec');
t.ok('after the cash lines', body.indexOf('Sales dashboard') > body.indexOf('Cash'));
t.ok('before the sign-off',
     body.indexOf('Sales dashboard') < body.indexOf('StoreOps · automated'));

t.done();
