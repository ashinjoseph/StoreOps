// ============================================================
//  reconcile — the daily close message, and what it claims
// ============================================================
//  Three production incidents live here:
//
//  1. "Clover not configured" reported as "Clover unavailable", which would
//     fire every day for a till that was never meant to have it
//  2. the total-sales line measured cash-above-float PLUS the Clover card
//     total; remove Clover and only the reported side keeps its card term, so
//     a clean day reports a variance the size of the whole card take
//  3. the parameter SHAPE followed the till rather than the template, so the
//     wrong count went to an approved template — Meta answers http_400,
//     dispatch_ swallows it, and no message ever arrives
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('reconcile and the close message');

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

function sess(o) {
  const r = new Array(21).fill('');
  r[0] = o.id; r[1] = 'A_1'; r[2] = o.staff || 'S_004'; r[3] = o.company;
  r[4] = TODAY; r[5] = 'closed'; r[6] = at(9, 0); r[7] = at(21, 20);
  r[8] = o.float; r[9] = o.float; r[11] = o.counted; r[12] = o.float;
  r[13] = o.counted - o.float; r[14] = o.expected;
  r[15] = o.counted - o.expected; r[16] = 'OK';
  if (o.company === 'cstore') { r[18] = o.lotto == null ? 500 : o.lotto; r[19] = 0; r[20] = ''; }
  return r;
}
// Split shape (vape): credit + debit, no single total.
const saleSplit = (id, c, cash, cr, db) => ({
  sessionId: id, company: c, cashSales: cash, creditCardSales: cr, debitCardSales: db,
  cardTotalSales: null, miscCashSales: 0, miscCreditSales: 0, miscDebitSales: 0,
  miscCardSales: null, cardSplit: true,
});
// Single-total shape (cstore on ePOS): blank credit/debit.
const saleTotal = (id, c, cash, card) => ({
  sessionId: id, company: c, cashSales: cash, creditCardSales: null, debitCardSales: null,
  cardTotalSales: card, miscCashSales: 0, miscCreditSales: null, miscDebitSales: null,
  miscCardSales: null, cardSplit: false,
});

let SENT, M;
// cstore has no Clover merchant (ePOS); vape does.
function clover(vapeOk) {
  return {
    isEnabled: () => true,
    merchantFor: c => c === 'vape' ? { merchantId: 'VAPE1', token: 'x' } : { merchantId: '', token: '' },
    getCardTotals: m => !m.merchantId
      ? { ok: false, error: 'not_configured' }
      : (vapeOk ? { ok: true, credit: 1, debit: 50, total: 51 }
                : { ok: false, error: 'http_500' }),
  };
}
function scenario(sessions, sales, cfg, vapeOk) {
  SENT = [];
  H.sheets({
    till_sessions: { headers: TS_HEADERS, rows: sessions },
    validation_results: { headers: VR_HEADERS, rows: [] },
    config: Object.assign({
      cstore_default_opening_float: 250, vape_default_opening_float: 60,
      lotto_reserve_default: 500, variance_ok_threshold: 1,
      variance_minor_threshold: 30, card_variance_threshold: 1,
      whatsapp_template_shift_close: 'shift_close_v2',
    }, cfg || {}),
  });
  M = H.load(['Util.gs', 'TillSessions.gs', 'Reconcile.gs'], {
    Clover: clover(vapeOk !== false),
    Sales: { getForDateRange: () => sales, write: () => ({}), getForSession: () => null },
    Staff: { getAll: () => ([{ staffId: 'S_004', name: 'Ashin' }, { staffId: 'S_005', name: 'Meera' }]),
             getById: id => ({ staffId: id, name: id, companiesAuthorized: ['cstore','vape'] }) },
    Attendance: { openOrPromote: () => ({}), complete: () => {} },
    CashHandling: { sheetsExist: () => true,
                    getAllOutstanding: () => ({ grandTotal: 1240, holders: [], stale: [] }) },
    Notifier: { notify: () => {},
                sendOp: (op, params, plain) => { SENT.push({ op, params, plain });
                  return { sent: false, reason: 'harness' }; } },
  });
  return M.Reconcile.reconcileDay('S_004', 'manual');
}

const CST = () => sess({ id: 'CST-1', company: 'cstore', float: 250, counted: 850, expected: 850 });
const VAP = () => sess({ id: 'VAP-1', company: 'vape', float: 60, counted: 111, expected: 111 });

// ── 1. Not configured is not unavailable ────────────────────
t.section('A till with no Clover is out of scope, not broken');
let res = scenario([CST()], [saleTotal('CST-1', 'cstore', 600, 1240)],
                   { cstore_card_split: 'false' });
let rec = res.merchants[0];
t.eq('flagged not-applicable', rec.cloverNA, true);
t.eq('cards were not verified', rec.cardsVerified, false);
t.eq('status is not clover_unavailable', rec.status, 'OK');
t.eq('no card diff computed', rec.cardDiff, null);
t.eq('no clover figure invented', rec.cloverCard, null);
t.eq('cashier credit is blank, not zero', rec.cashierCredit, null);
t.eq('but the card figure itself is kept', rec.cashierCard, 1240);

t.section('A genuine Clover outage still warns');
res = scenario([VAP()], [saleSplit('VAP-1', 'vape', 51, 1, 50)], {}, false);
rec = res.merchants[0];
t.eq('status says unavailable', rec.status, 'clover_unavailable');
t.eq('and is NOT confused with not-configured', rec.cloverNA, false);

// ── 2. No fictional variance ────────────────────────────────
t.section('A clean unverified day reports no variance');
res = scenario([CST()], [saleTotal('CST-1', 'cstore', 600, 1240)],
               { cstore_card_split: 'false',
                 whatsapp_template_shift_close_cstore: 'shift_close_cstore' });
let p = SENT[0].params;
t.ok('the total-sales line carries no variance mark', p[4].indexOf('var') === -1);
t.ok('it names both tenders', /cash \$600\.00/.test(p[4]) && /card \$1240\.00/.test(p[4]));
t.ok('and shows full revenue', p[4].indexOf('$1840.00') === 0);
t.ok('the cash line carries the verdict', /var \+\$0\.00/.test(p[5]));
t.ok('nothing claims a $1240 discrepancy', p[4].indexOf('-$1240') === -1);

t.section('Card checks cannot fire without a measurement');
res = scenario([CST()], [saleTotal('CST-1', 'cstore', 600, 1240)],
               { cstore_card_split: 'false', card_variance_threshold: 0,
                 whatsapp_template_shift_close_cstore: 'shift_close_cstore' });
t.eq('still OK at a zero threshold', res.merchants[0].status, 'OK');
t.ok('status text says cash, not "All matched"', SENT[0].params[10] === '✅ Cash matched');

t.section('A real cash shortfall still surfaces — the only check left');
res = scenario([sess({ id: 'CST-1', company: 'cstore', float: 250, counted: 810, expected: 850 })],
               [saleTotal('CST-1', 'cstore', 600, 1240)],
               { cstore_card_split: 'false',
                 whatsapp_template_shift_close_cstore: 'shift_close_cstore' });
t.eq('flagged for investigation', res.merchants[0].status, 'investigate');
t.ok('and names the shortfall', /cash short \$40\.00/.test(SENT[0].params[10]));

// ── 3. Shape follows the template ───────────────────────────
t.section('Each template gets the count it expects');
scenario([CST()], [saleTotal('CST-1', 'cstore', 600, 1240)],
         { cstore_card_split: 'false',
           whatsapp_template_shift_close_cstore: 'shift_close_cstore' });
t.eq('cstore op key', SENT[0].op, 'shift_close_cstore');
t.eq('cstore sends 11', SENT[0].params.length, 11);

scenario([VAP()], [saleSplit('VAP-1', 'vape', 51, 1, 50)],
         { whatsapp_template_shift_close_vape: 'shift_close_vape' });
t.eq('vape op key', SENT[0].op, 'shift_close_vape');
t.eq('vape sends 12', SENT[0].params.length, 12);
t.ok('and carries no lotto line', !SENT[0].params.some(x => /not tracked on this till/.test(String(x))));

t.section('Shape follows the TEMPLATE even when Clover state disagrees');
// cstore's Clover config has NOT been blanked, so cloverNA is false — the
// template still expects 11 and must get 11.
SENT = [];
H.sheets({
  till_sessions: { headers: TS_HEADERS, rows: [CST()] },
  validation_results: { headers: VR_HEADERS, rows: [] },
  config: { cstore_default_opening_float: 250, vape_default_opening_float: 60,
            lotto_reserve_default: 500, variance_ok_threshold: 1,
            variance_minor_threshold: 30, card_variance_threshold: 1,
            cstore_card_split: 'false',
            whatsapp_template_shift_close: 'shift_close_v2',
            whatsapp_template_shift_close_cstore: 'shift_close_cstore' },
});
M = H.load(['Util.gs', 'TillSessions.gs', 'Reconcile.gs'], {
  Clover: { isEnabled: () => true,
            merchantFor: () => ({ merchantId: 'STILL_SET', token: 'x' }),
            getCardTotals: () => ({ ok: true, credit: 600, debit: 640, total: 1240 }) },
  Sales: { getForDateRange: () => [saleTotal('CST-1', 'cstore', 600, 1240)],
           write: () => ({}), getForSession: () => null },
  Staff: { getAll: () => ([{ staffId: 'S_004', name: 'Ashin' }]),
           getById: id => ({ staffId: id, name: id, companiesAuthorized: ['cstore'] }) },
  Attendance: { openOrPromote: () => ({}), complete: () => {} },
  CashHandling: { sheetsExist: () => true,
                  getAllOutstanding: () => ({ grandTotal: 0, holders: [], stale: [] }) },
  Notifier: { notify: () => {},
              sendOp: (op, params, plain) => { SENT.push({ op, params, plain });
                return { sent: false, reason: 'harness' }; } },
});
M.Reconcile.reconcileDay('S_004', 'manual');
t.eq('still the cstore template', SENT[0].op, 'shift_close_cstore');
t.eq('still 11 params, not 13', SENT[0].params.length, 11);

t.section('Unset keys fall back to the shared template AND its shape');
scenario([VAP()], [saleSplit('VAP-1', 'vape', 51, 1, 50)], {});
t.eq('vape falls back', SENT[0].op, 'shift_close');
t.eq('and sends 13, not 12', SENT[0].params.length, 13);
t.ok('with the lotto slot filled', /not tracked on this till/.test(SENT[0].params[8]));

scenario([CST()], [saleTotal('CST-1', 'cstore', 600, 1240)], { cstore_card_split: 'false' });
t.eq('cstore falls back', SENT[0].op, 'shift_close');
t.eq('and sends 13, not 11', SENT[0].params.length, 13);

t.section('A failed send says why, instead of looking like success');
res = scenario([CST()], [saleTotal('CST-1', 'cstore', 600, 1240)],
               { cstore_card_split: 'false',
                 whatsapp_template_shift_close_cstore: 'shift_close_cstore' });
t.ok('a summary is returned', typeof res.whatsappSummary === 'string' && res.whatsappSummary.length > 0);
t.ok('naming the till', /cstore/.test(res.whatsappSummary));
t.ok('naming the template', /shift_close_cstore/.test(res.whatsappSummary));
t.ok('naming the parameter count', /\(11\)/.test(res.whatsappSummary));
t.ok('and saying it failed', /FAILED/.test(res.whatsappSummary));

t.section('The plain-text fallback matches the shape it describes');
scenario([CST()], [saleTotal('CST-1', 'cstore', 600, 1240)], { cstore_card_split: 'false' });
const plain = SENT[0].plain;
t.ok('no Credit line for a till with no split', plain.indexOf('Credit  ') === -1);
t.ok('no Debit line either', plain.indexOf('Debit   ') === -1);
t.ok('says the total is unverified', /not verified/.test(plain));
t.ok('carries the cash verdict', /Cash - recorded \/ counted/.test(plain));
t.ok('and no "Clover unavailable" noise', plain.indexOf('Clover unavailable') === -1);

t.done();
