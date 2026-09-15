// ============================================================
//  lotto-payout — a payout can exceed the day's cash takings
// ============================================================
//  Three production defects live under these assertions:
//
//  1. cash_sales could not go below zero, so a big win had no way to reconcile
//  2. the reserve's top-up was added to a count that already included it, which
//     opened the next shift high AND made the drawer read short by the top-up
//  3. expected cash had to absorb whatever the pot fed the till, derived from
//     two physical counts rather than a typed field
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('lotto payout and reserve');

const TS_HEADERS = ['session_id','attendance_id','staff_id','company','date','status',
  'start_time','end_time','expected_opening','opening_float','opening_note',
  'closing_cash_counted','cash_left_in_till','cash_removed_at_close','expected_cash',
  'closing_variance','variance_status','notes',
  'lotto_reserve_counted','lotto_topup_from_till','lotto_reserve_note'];

const FLOAT = 250, RESERVE = 500;
const DAY = '2026-08-12';

// A closed cstore session carrying a reserve count, so lastReserveCount_ has
// something to read. Written straight to the sheet — this is history, not a
// close we are exercising.
function seedReserve(counted, topup) {
  const r = new Array(21).fill('');
  r[0] = 'T_SEED'; r[2] = 'S_ASH'; r[3] = 'cstore';
  r[4] = new Date('2026-08-10T00:00:00'); r[5] = 'closed';
  r[7] = new Date('2026-08-10T20:00:00');
  r[18] = counted; r[19] = topup || 0; r[20] = 'seed';
  return r;
}

let M, salesWritten;
function scenario(seedRows, cfg) {
  salesWritten = [];
  H.sheets({
    till_sessions: { headers: TS_HEADERS, rows: (seedRows || []).slice() },
    config: Object.assign({
      cstore_default_opening_float: FLOAT,
      vape_default_opening_float: 60,
      lotto_reserve_default: RESERVE,
      variance_ok_threshold: 1,
      variance_minor_threshold: 30,
    }, cfg || {}),
  });
  M = H.load(['Util.gs', 'TillSessions.gs'], {
    Staff: { getById: id => ({ staffId: id, name: id, role: 'employee',
                               companiesAuthorized: ['cstore', 'vape'] }) },
    Attendance: { openOrPromote: () => ({ attendanceId: 'A_1' }), complete: () => {} },
    Sales: {
      write: (input) => { salesWritten.push(input); return input; },
      getForSession: () => null,
    },
    Notifier: { notify: () => {} },
  });
  return M.TillSessions;
}

// Open then close one cstore shift with the given figures.
function runShift(o) {
  const TS = M.TillSessions;
  const s = TS.open({
    staffId: o.staff || 'S_MEE', company: o.company || 'cstore',
    openingCount: o.float == null ? FLOAT : o.float, actorId: o.staff || 'S_MEE',
  });
  return TS.close(Object.assign({
    sessionId: s.sessionId, actorId: o.staff || 'S_MEE',
    creditCard: 0, debitCard: 0, miscCash: 0, miscCredit: 0, miscDebit: 0,
    lottoNote: o.note === undefined ? 'payout' : o.note,
  }, {
    cashSales: o.cashSales,
    physicalCount: o.count,
    lottoCounted: o.lottoCounted,
    lottoTopupFromTill: o.topup || 0,
  }));
}

// ── 1. The scenario this was built for ──────────────────────
t.section('A payout larger than the drawer, funded by the reserve');
scenario([seedReserve(RESERVE, 0)]);
// float 250 + sales 200 − payout 500 = −50, so $50 came from the pot and the
// drawer closes empty. Netted cash sales: 200 − 500 = −300.
let r = runShift({ cashSales: -300, count: 0, lottoCounted: RESERVE - 50 });
t.eq('expected cash absorbs the $50 fed in', r.expectedCash, 0);
t.eq('variance is zero — it reconciles', r.variance, 0);
t.eq('the fed amount is derived, not typed', r.reserveFedToTill, 50);

t.section('Same shift, float restored instead — both conventions reconcile');
scenario([seedReserve(RESERVE, 0)]);
r = runShift({ cashSales: -300, count: FLOAT, lottoCounted: RESERVE - 300 });
t.eq('fed reads $300 from the two counts', r.reserveFedToTill, 300);
t.eq('expected cash matches the drawer', r.expectedCash, FLOAT);
t.eq('variance zero', r.variance, 0);

t.section('Which pot paid the customer cancels out');
scenario([seedReserve(RESERVE, 0)]);
// Reserve pays the whole $500 直接; drawer untouched at 250 + 200 = 450.
r = runShift({ cashSales: -300, count: 450, lottoCounted: 0 });
t.eq('fed reads the full $500', r.reserveFedToTill, 500);
t.eq('expected cash still equals the drawer', r.expectedCash, 450);
t.eq('variance zero', r.variance, 0);

t.section('A real shortfall on top of a payout still surfaces');
scenario([seedReserve(RESERVE, 0)]);
// Pot fell 300 but only 250 reached the drawer.
r = runShift({ cashSales: -300, count: 200, lottoCounted: RESERVE - 300 });
t.eq('fed still reads 300 from the counts', r.reserveFedToTill, 300);
t.eq('expected cash unchanged', r.expectedCash, 250);
t.eq('the missing $50 shows as variance, not absorbed', r.variance, -50);
t.ok('and is flagged', r.varianceStatus !== 'OK');

// ── 2. The top-up must not be counted twice ─────────────────
t.section('A previous top-up is already inside the stored count');
scenario([seedReserve(425, 160)]);      // pot ended at 425, having taken 160 in
// Reported case: $160 moved onto a $265 pot. The next shift must open at 425,
// not 585 — and expected cash must not inherit the phantom $160.
// 425 is below the $500 default, so the reason rule applies — that guard is
// correct and stays; supply the reason a cashier would.
r = runShift({ cashSales: 200, count: 450, lottoCounted: 425, note: 'topped up last shift' });
t.eq('opens at 425, not 585', r.reserveFedToTill, 0);
t.eq('no phantom cash shortfall', r.expectedCash, 450);
t.eq('drawer reconciles', r.variance, 0);
t.eq('and is not flagged', r.varianceStatus, 'OK');

t.section('A genuine draw from a topped-up pot still reads correctly');
scenario([seedReserve(425, 160)]);
r = runShift({ cashSales: -100, count: 250, lottoCounted: 325 });
t.eq('fed reads the real movement', r.reserveFedToTill, 100);
t.eq('expected absorbs exactly that', r.expectedCash, 250);
t.eq('variance zero', r.variance, 0);

t.section('The close sheet pre-fills from the closing balance');
scenario([seedReserve(425, 160)]);
const log = M.TillSessions.getLottoLog(30);
t.eq('lastCounted is the closing balance', log.lastCounted, 425);
t.eq('nothing is added on top of it', log.lastOpening, undefined);

// ── 3. Guards ───────────────────────────────────────────────
t.section('Negative cash sales only where a pot can fund it');
scenario([seedReserve(RESERVE, 0)]);
t.throws('vape refuses a negative', () => runShift({
  company: 'vape', staff: 'S_ASH', float: 60, cashSales: -50, count: 10,
}), 'cannot be negative');
t.eq('and no sales row was written', salesWritten.length, 0);

t.section('An impossible expected cash is rejected');
scenario([seedReserve(RESERVE, 0)]);
t.throws('negative expected cash blocked',
  () => runShift({ cashSales: -900, count: 0, lottoCounted: RESERVE }),
  'exceed');
t.eq('no sales row written', salesWritten.length, 0);

t.section('No previous reserve count — no crash, nothing fed');
scenario([]);
r = runShift({ cashSales: 200, count: 450, lottoCounted: RESERVE, note: '' });
t.eq('fed defaults to zero', r.reserveFedToTill, 0);
t.eq('expected cash is float + sales', r.expectedCash, 450);

t.section('A drawer below float owes nobody anything');
scenario([seedReserve(RESERVE, 0)]);
r = runShift({ cashSales: -300, count: 0, lottoCounted: RESERVE - 50 });
// counted 0 − float 250 = −250. CashHandling skips anything <= 0, so this is
// never carried as cash in hand — that guard is asserted in the cash suite.
t.eq('cash removed is exactly counted minus float', r.session.cashRemovedAtClose, -250);
t.ok('and is negative, so nothing is owed', r.session.cashRemovedAtClose < 0);

t.done();
