// ============================================================
//  sales-cards — two card shapes, one continuous total
// ============================================================
//  cstore moved to an ePOS and reports ONE card figure; vape still splits
//  credit from debit. The design rests on one property: the two shapes are
//  mutually exclusive per row, so every total sums all of them and stays
//  correct on both sides of the migration with no date logic anywhere.
//
//  Blank is not zero. A blank credit cell means "this till reported one
//  figure"; a zero means "it split and took nothing on credit". Erase that
//  distinction and history stops being readable.
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('sales card shapes');

const COLS = ['sales_id','session_id','staff_id','company','date',
  'cash_sales','credit_card_sales','debit_card_sales','cashback_paid',
  'hst_collected','bottle_deposit','round_off',
  'misc_cash_sales','misc_credit_sales','misc_debit_sales','misc_notes',
  'card_total_sales','misc_card_sales'];
const IX = {}; COLS.forEach((c, i) => { IX[c] = i; });

let ROWS = [], M;
function reset(cfg) {
  ROWS = [];
  H.sheets({ sales: { headers: COLS, rows: ROWS }, config: cfg || {} });
  M = H.load(['Util.gs', 'Sales.gs'], { Staff: { getAll: () => ([{ staffId: 'S_1', name: 'Ashin' }]) } });
}
// A split row: credit/debit populated, card_total blank.
function split(dateStr, company, cash, credit, debit) {
  const r = new Array(COLS.length).fill('');
  r[IX.sales_id] = 'SL' + ROWS.length; r[IX.session_id] = 'T' + ROWS.length;
  r[IX.staff_id] = 'S_1'; r[IX.company] = company;
  r[IX.date] = new Date(dateStr + 'T00:00:00');
  r[IX.cash_sales] = cash; r[IX.credit_card_sales] = credit; r[IX.debit_card_sales] = debit;
  ROWS.push(r);
}
// A single-total row: card_total populated, credit/debit BLANK.
function total(dateStr, company, cash, card) {
  const r = new Array(COLS.length).fill('');
  r[IX.sales_id] = 'SL' + ROWS.length; r[IX.session_id] = 'T' + ROWS.length;
  r[IX.staff_id] = 'S_1'; r[IX.company] = company;
  r[IX.date] = new Date(dateStr + 'T00:00:00');
  r[IX.cash_sales] = cash; r[IX.card_total_sales] = card;
  ROWS.push(r);
}
const dash = (a, b, company) => M.Sales.getDashboard({
  startDate: new Date(a + 'T00:00:00'), endDate: new Date(b + 'T23:59:59'),
  company: company || null, pageSize: 500,
});

t.section('A single-total row keeps credit and debit blank');
reset(); total('2026-09-01', 'cstore', 600, 1240);
let d = dash('2026-09-01', '2026-09-01');
t.eq('total is cash + card', d.totals.total, 1840);
t.eq('card bucket carries the figure', d.totals.card, 1240);
t.eq('credit stays empty', d.totals.credit, 0);
t.eq('cardAll is the tender figure', d.totals.cardAll, 1240);
t.eq('the row reports no split', d.rows[0].credit, null);
t.eq('nor a debit', d.rows[0].debit, null);
t.eq('but carries the card figure', d.rows[0].card, 1240);

t.section('A split row is untouched — history keeps its shape');
reset(); split('2026-09-01', 'cstore', 600, 1240, 0);
d = dash('2026-09-01', '2026-09-01');
t.eq('same total', d.totals.total, 1840);
t.eq('credit populated', d.totals.credit, 1240);
t.eq('card bucket empty', d.totals.card, 0);
t.eq('cardAll still the tender figure', d.totals.cardAll, 1240);
t.eq('debit is 0, not null — it split and took nothing', d.rows[0].debit, 0);
t.eq('and has no single-total figure', d.rows[0].card, null);

t.section('A range spanning the migration sums once, not twice');
reset();
split('2026-09-01', 'cstore', 600, 1000, 0);
total('2026-09-02', 'cstore', 700, 1100);
d = dash('2026-09-01', '2026-09-02');
t.eq('every tender counted once', d.totals.total, 3400);
t.eq('cash across the boundary', d.totals.cash, 1300);
t.eq('credit covers only the pre rows', d.totals.credit, 1000);
t.eq('card covers only the post rows', d.totals.card, 1100);
t.eq('cardAll is continuous', d.totals.cardAll, 2100);
t.eq('split coverage reported', d.totals.splitRows, 1);
t.eq('unsplit coverage reported', d.totals.totalRows, 1);

t.section('The daily chart cannot dip at the boundary');
t.eq('two trading days', d.daily.length, 2);
t.eq('pre day', d.daily[0].total, 1600);
t.eq('post day', d.daily[1].total, 1800);
t.ok('no day collapses to zero', d.daily.every(x => x.total > 0));

t.section('The same money totals the same whichever shape recorded it');
reset(); split('2026-09-01', 'cstore', 600, 1240, 0);
const asSplit = dash('2026-09-01', '2026-09-01').totals.total;
reset(); total('2026-09-01', 'cstore', 600, 1240);
const asTotal = dash('2026-09-01', '2026-09-01').totals.total;
t.eq('shape does not change the total', asSplit, asTotal);
t.eq('and it is the right number', asTotal, 1840);

t.section('The commission feed sees card revenue either way');
reset(); total('2026-09-01', 'cstore', 600, 1240);
let agg = M.Sales.aggregateByStaffCompany(new Date('2026-09-01T00:00:00'),
                                          new Date('2026-09-01T23:59:59'));
t.eq('one staff/company pair', agg.length, 1);
t.eq('cardTotal includes the single figure', agg[0].cardTotal, 1240);
t.eq('total feeds the threshold', agg[0].total, 1840);

t.section('cardSplitFor is config-driven and defaults to splitting');
reset();
t.eq('unknown till defaults true', M.Sales.cardSplitFor('newtill'), true);
reset({ cstore_card_split: 'false', vape_card_split: 'true' });
t.eq('cstore reads false', M.Sales.cardSplitFor('cstore'), false);
t.eq('vape unaffected', M.Sales.cardSplitFor('vape'), true);
reset({ vape_card_split: ' False ' });
t.eq('whitespace and case tolerated', M.Sales.cardSplitFor('vape'), false);

t.section('Mixed shapes still add up per company');
reset();
split('2026-09-01', 'vape', 100, 150, 50);
total('2026-09-01', 'cstore', 600, 1240);
d = dash('2026-09-01', '2026-09-01');
t.eq('day total covers both tills', d.daily[0].total, 2140);
const bc = d.daily[0].byCompany;
t.eq('cstore slice', bc.cstore, 1840);
t.eq('vape slice', bc.vape, 300);
t.near('slices sum to the bar', bc.cstore + bc.vape, d.daily[0].total, 0.005);

t.section('Filtering to one company keeps the arithmetic');
d = dash('2026-09-01', '2026-09-01', 'cstore');
t.eq('cstore only', d.totals.total, 1840);
t.eq('and no vape credit leaks in', d.totals.credit, 0);

t.done();
