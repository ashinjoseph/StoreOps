// ============================================================
//  commission-fixed — a rule that is not tied to sales
// ============================================================
//  Every rule used to be "a percentage of sales over a threshold", which
//  cannot express a management fee: the fee is owed whether or not the till
//  took anything that week. A flat amount is a second shape, and the two have
//  to coexist — the person on a management fee usually earns sales commission
//  as well, and neither may suppress the other.
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('Fixed-amount commission rules');

const CR_COLS = ['rule_id','name','applies_to','staff_id','company','threshold',
  'percentage','active','effective_from','effective_to','created_by','created_at',
  'notes','rule_type','fixed_amount'];
const BN_COLS = ['bonus_id','staff_id','date','type','amount','reason','status',
  'period_start','period_end','company','source_run_id','created_by','created_at',
  'notes','source_rule_id'];
const RUN_COLS = ['run_id','week_start','week_end','staff_count','bonuses_created',
  'total_amount','computed_by','computed_at','notes'];

const WEEK_START = new Date(2026, 8, 21);           // Mon 21 Sep 2026
const WEEK_END = new Date(2026, 8, 27, 23, 59, 59); // Sun 27 Sep

function rule(o) {
  const r = new Array(CR_COLS.length).fill('');
  r[0] = o.id; r[1] = o.name || o.id;
  r[2] = o.staffId ? 'specific_staff' : 'all_staff';
  r[3] = o.staffId || ''; r[4] = o.company || 'cstore';
  r[5] = o.threshold || 0; r[6] = o.percentage || 0;
  r[7] = o.active === undefined ? true : o.active;
  r[8] = o.from || new Date(2026, 0, 1); r[9] = o.to || '';
  r[10] = 'S_ADM'; r[11] = new Date(2026, 0, 1); r[12] = '';
  r[13] = o.type || '';                 // blank must read as 'percentage'
  r[14] = o.fixedAmount || 0;
  return r;
}

let M, SALES;
function engine(rules, sales, bonusRows) {
  SALES = sales || [];
  // Deep-copy: the sheet stub appends written rows into the array it is
  // handed, so a fixture shared between runs quietly accumulates the bonuses
  // an earlier run wrote — and then blocks the next one.
  H.sheets({
    commission_rules: { headers: CR_COLS, rows: rules.map(r => r.slice()) },
    bonuses:          { headers: BN_COLS, rows: (bonusRows || []).map(r => r.slice()) },
    commission_runs:  { headers: RUN_COLS, rows: [] },
    config: {},
  });
  M = H.load(['Util.gs', 'CommissionRules.gs', 'Bonuses.gs', 'Commissions.gs'], {
    SHEETS: { COMMISSION_RULES: 'commission_rules', BONUSES: 'bonuses',
              COMMISSION_RUNS: 'commission_runs' },
    COMPANIES: ['cstore', 'vape'],
    RULE_APPLIES: ['all_staff', 'specific_staff'],
    AuditLog: { write: () => {}, writeMany: () => {} },
    Notifier: { notify: () => {}, sendOp: () => ({ sent: false }) },
    Staff: {
      getActive: () => ([{ staffId: 'S_ASH', name: 'Ashin' }, { staffId: 'S_MEE', name: 'Meera' }]),
      getById: id => ({ staffId: id, name: id }),
    },
    Sales: { aggregateByStaffCompany: () => SALES },
  });
  return M.Commissions.runForWeek({
    weekStart: WEEK_START, weekEnd: WEEK_END, actorId: 'S_ADM',
  });
}
const sale = (staffId, company, total) => ({ staffId, company, total });
const forStaff = (res, id) => res.bonusesProposed.filter(b => b.staffId === id);
// A regression here should report every assertion it breaks, not die on the
// first empty array and hide the rest of the picture.
const one = list => (list && list[0]) || {};
const byRule = (res, id) => one(res.bonusesProposed.filter(b => b.ruleId === id));

t.section('A fixed rule pays with no sales at all');
// This is the whole point. A management fee is owed for the week regardless of
// what the till did, so the engine must not require a sales row to exist.
let res = engine([rule({ id: 'CR_001', staffId: 'S_ASH', type: 'fixed', fixedAmount: 120 })], []);
t.eq('one bonus proposed', res.bonusesProposed.length, 1);
t.eq('for the named staff', one(res.bonusesProposed).staffId, 'S_ASH');
t.eq('at the flat amount', one(res.bonusesProposed).amount, 120);
t.eq('and the run total matches', res.totalAmount, 120);
t.ok('the reason says it is not tied to sales',
     /not tied to sales/.test(one(M.Bonuses.getAll()).reason || ''));

t.section('…and pays the same when there are sales');
res = engine([rule({ id: 'CR_001', staffId: 'S_ASH', type: 'fixed', fixedAmount: 120 })],
             [sale('S_ASH', 'cstore', 9000)]);
t.eq('still the flat amount, not a share of it', one(res.bonusesProposed).amount, 120);

t.section('A fee and a sales commission both pay');
// The person on a management fee normally earns commission too. Before, the
// engine allowed one commission per staff/company/week, so whichever rule it
// reached second was dropped without a word.
res = engine([
  rule({ id: 'CR_001', staffId: 'S_ASH', type: 'fixed', fixedAmount: 120 }),
  rule({ id: 'CR_002', percentage: 5, threshold: 5000 }),
], [sale('S_ASH', 'cstore', 9000), sale('S_MEE', 'cstore', 6000)]);
const ash = forStaff(res, 'S_ASH');
t.eq('Ashin gets two lines', ash.length, 2);
t.eq('the fee', byRule(res, 'CR_001').amount, 120);
t.eq('and the commission on 4000 over threshold', byRule(res, 'CR_002').amount, 200);
t.eq('Meera gets only the commission', forStaff(res, 'S_MEE').length, 1);
t.eq('at 5% of her 1000 excess', one(forStaff(res, 'S_MEE')).amount, 50);
t.eq('three bonuses in total', res.bonusesProposed.length, 3);
t.eq('and the run total is their sum', res.totalAmount, 370);

t.section('Order does not decide who gets paid');
// Same two rules, listed the other way round.
res = engine([
  rule({ id: 'CR_002', percentage: 5, threshold: 5000 }),
  rule({ id: 'CR_001', staffId: 'S_ASH', type: 'fixed', fixedAmount: 120 }),
], [sale('S_ASH', 'cstore', 9000)]);
t.eq('still both lines for Ashin', forStaff(res, 'S_ASH').length, 2);
t.eq('still the same total', res.totalAmount, 320);

t.section('A fee does not pay twice for the same week');
// A forced re-run must not hand out the fee again.
const already = {
  headers: BN_COLS,
  rows: [(() => {
    const b = new Array(BN_COLS.length).fill('');
    b[0] = 'B_1'; b[1] = 'S_ASH'; b[2] = WEEK_START; b[3] = 'commission';
    b[4] = 120; b[5] = 'Weekly fixed amount: fee'; b[6] = 'proposed';
    b[7] = WEEK_START; b[8] = WEEK_END; b[9] = 'cstore'; b[10] = 'CRN_OLD';
    b[11] = 'S_ADM'; b[12] = WEEK_START; b[13] = ''; b[14] = 'CR_001';
    return b;
  })()],
};
res = engine([rule({ id: 'CR_001', staffId: 'S_ASH', type: 'fixed', fixedAmount: 120 })],
             [], already.rows);
t.eq('nothing is proposed a second time', res.bonusesProposed.length, 0);
t.eq('and the run total is zero', res.totalAmount, 0);

t.section('…but an existing fee does not block the sales commission');
// The old guard was per staff+company+week, so a fee already on the books
// would have swallowed the commission that was also owed.
res = engine([rule({ id: 'CR_002', percentage: 5, threshold: 5000 })],
             [sale('S_ASH', 'cstore', 9000)], already.rows);
t.eq('the commission still lands', res.bonusesProposed.length, 1);
t.eq('at the right amount', (res.bonusesProposed[0] || {}).amount, 200);

t.section('A deleted fee rule stops blocking anything');
// The fee's rule row is gone entirely; its bonus is still on the books. That
// row must not suppress the commission that is owed this week.
res = engine([rule({ id: 'CR_002', percentage: 5, threshold: 5000 })],
             [sale('S_ASH', 'cstore', 9000)], already.rows);
t.eq('the commission is unaffected', res.bonusesProposed.length, 1);

t.section('A legacy bonus with no rule id still blocks, as it always did');
// Rows written before source_rule_id existed cannot be attributed, so they
// keep their old behaviour rather than being silently ignored.
const legacy = already.rows.map(r => { const c = r.slice(); c[14] = ''; return c; });
res = engine([rule({ id: 'CR_002', percentage: 5, threshold: 5000 })],
             [sale('S_ASH', 'cstore', 9000)], legacy);
t.eq('no second commission for that week', res.bonusesProposed.length, 0);

t.section('A threshold turns a fee into a conditional one');
const conditional = [rule({ id: 'CR_003', staffId: 'S_ASH', type: 'fixed',
                            fixedAmount: 120, threshold: 5000 })];
t.eq('below the threshold it does not pay',
     engine(conditional, [sale('S_ASH', 'cstore', 4000)]).bonusesProposed.length, 0);
t.eq('with no sales at all it does not pay',
     engine(conditional, []).bonusesProposed.length, 0);
res = engine(conditional, [sale('S_ASH', 'cstore', 6000)]);
t.eq('above it, the full flat amount', one(res.bonusesProposed).amount, 120);
t.ok('and the reason names the threshold',
     /over \$5,?000\.00 threshold/.test(one(M.Bonuses.getAll()).reason || ''));

t.section('Percentage rules are untouched by any of this');
res = engine([rule({ id: 'CR_002', percentage: 5, threshold: 5000 })],
             [sale('S_ASH', 'cstore', 9000)]);
t.eq('still 5% of the excess', one(res.bonusesProposed).amount, 200);
t.eq('recorded as a percentage rule', one(res.bonusesProposed).ruleType, 'percentage');
t.eq('below threshold still earns nothing',
     engine([rule({ id: 'CR_002', percentage: 5, threshold: 5000 })],
            [sale('S_ASH', 'cstore', 4000)]).bonusesProposed.length, 0);
t.eq('no sales still earns nothing',
     engine([rule({ id: 'CR_002', percentage: 5, threshold: 5000 })], []).bonusesProposed.length, 0);

t.section('A blank rule_type is a percentage rule');
// Every row written before this column existed has one, and the migration
// backfills it — but a hand-added row may not.
const blank = M.CommissionRules.getAll();
t.eq('read back as percentage', one(blank).ruleType, 'percentage');

t.section('The bonus records which rule produced it');
res = engine([
  rule({ id: 'CR_001', staffId: 'S_ASH', type: 'fixed', fixedAmount: 120 }),
  rule({ id: 'CR_002', percentage: 5, threshold: 5000 }),
], [sale('S_ASH', 'cstore', 9000)]);
const written = M.Bonuses.getAll();
t.eq('two bonus rows', written.length, 2);
t.ok('each names its rule', written.every(b => b.sourceRuleId));
t.eq('the fee is attributed to the fixed rule',
     one(written.filter(b => b.amount === 120)).sourceRuleId, 'CR_001');
t.eq('and the commission to the percentage rule',
     one(written.filter(b => b.amount === 200)).sourceRuleId, 'CR_002');

// ── Recurrence ────────────────────────────────────────────────────────────
// The engine is driven by a weekly trigger, one run per week. A management fee
// is only useful if it comes round again every week on its own, so run several
// consecutive weeks against ONE set of sheets and watch what accumulates.
function weekOf(mondayDay) {
  return {
    start: new Date(2026, 8, mondayDay),
    end: new Date(2026, 8, mondayDay + 6, 23, 59, 59),
  };
}
function session(rules, sales) {
  SALES = sales || [];
  H.sheets({
    commission_rules: { headers: CR_COLS, rows: rules.map(r => r.slice()) },
    bonuses:          { headers: BN_COLS, rows: [] },
    commission_runs:  { headers: RUN_COLS, rows: [] },
    config: {},
  });
  const mod = H.load(['Util.gs', 'CommissionRules.gs', 'Bonuses.gs', 'Commissions.gs'], {
    SHEETS: { COMMISSION_RULES: 'commission_rules', BONUSES: 'bonuses',
              COMMISSION_RUNS: 'commission_runs' },
    COMPANIES: ['cstore', 'vape'],
    RULE_APPLIES: ['all_staff', 'specific_staff'],
    AuditLog: { write: () => {}, writeMany: () => {} },
    Notifier: { notify: () => {}, sendOp: () => ({ sent: false }) },
    Staff: {
      getActive: () => ([{ staffId: 'S_ASH', name: 'Ashin' }]),
      getById: id => ({ staffId: id, name: id }),
    },
    Sales: { aggregateByStaffCompany: () => SALES },
  });
  return {
    M: mod,
    run: w => mod.Commissions.runForWeek({
      weekStart: w.start, weekEnd: w.end, actorId: 'SYSTEM_TRIGGER',
    }),
  };
}

t.section('The fee comes round again every week');
let sess = session([rule({ id: 'CR_001', staffId: 'S_ASH', type: 'fixed',
                           fixedAmount: 120, from: new Date(2026, 8, 1) })], []);
const wk1 = sess.run(weekOf(7));
const wk2 = sess.run(weekOf(14));
const wk3 = sess.run(weekOf(21));
t.eq('week 1 pays it', wk1.bonusesProposed.length, 1);
t.eq('week 2 pays it again', wk2.bonusesProposed.length, 1);
t.eq('week 3 too', wk3.bonusesProposed.length, 1);
t.eq('the same amount each time',
     [wk1, wk2, wk3].map(r => one(r.bonusesProposed).amount), [120, 120, 120]);
t.eq('three separate bonuses on the books', sess.M.Bonuses.getAll().length, 3);
t.eq('each against its own week',
     sess.M.Bonuses.getAll().map(b => b.periodStart.getDate()), [7, 14, 21]);
t.eq('and still with no sales anywhere', SALES.length, 0);

t.section('…but only once per week');
// The trigger can fire twice, or someone can run it by hand after it already
// ran. Neither may pay the fee a second time for a week it already covered.
const again = sess.run(weekOf(21));
t.ok('a second run of the same week is skipped', again.skipped === true);
t.eq('nothing extra was written', sess.M.Bonuses.getAll().length, 3);
const forced = sess.M.Commissions.runForWeek({
  weekStart: weekOf(21).start, weekEnd: weekOf(21).end, actorId: 'S_ADM', force: true,
});
t.eq('even a forced re-run proposes nothing', forced.bonusesProposed.length, 0);
t.eq('still three bonuses', sess.M.Bonuses.getAll().length, 3);

t.section('It stops when the rule does');
sess = session([rule({ id: 'CR_001', staffId: 'S_ASH', type: 'fixed', fixedAmount: 120,
                       from: new Date(2026, 8, 14), to: new Date(2026, 8, 20) })], []);
t.eq('nothing before it starts', sess.run(weekOf(7)).bonusesProposed.length, 0);
t.eq('paid inside its window', sess.run(weekOf(14)).bonusesProposed.length, 1);
t.eq('nothing after it ends', sess.run(weekOf(21)).bonusesProposed.length, 0);
t.eq('one bonus in total', sess.M.Bonuses.getAll().length, 1);

t.section('An inactive rule pays nothing at all');
sess = session([rule({ id: 'CR_001', staffId: 'S_ASH', type: 'fixed', fixedAmount: 120,
                       from: new Date(2026, 8, 1), active: false })], []);
t.eq('week 1', sess.run(weekOf(7)).bonusesProposed.length, 0);
t.eq('week 2', sess.run(weekOf(14)).bonusesProposed.length, 0);

t.section('A rule that runs forever keeps paying');
// effective_to blank is the ordinary case for a standing fee.
sess = session([rule({ id: 'CR_001', staffId: 'S_ASH', type: 'fixed', fixedAmount: 120,
                       from: new Date(2026, 8, 1), to: '' })], []);
const many = [7, 14, 21, 28].map(d => sess.run(weekOf(d)));
t.eq('every week pays', many.map(r => r.bonusesProposed.length), [1, 1, 1, 1]);
t.eq('and the totals are all the fee', many.map(r => r.totalAmount), [120, 120, 120, 120]);

t.section('A rule that would pay nothing is refused');
// A fixed rule with no amount looks configured in the list and quietly pays
// zero every week — the kind of thing nobody notices until payroll is short.
engine([]);
const mk = o => Object.assign({
  name: 'r', appliesTo: 'all_staff', company: 'cstore', threshold: 0,
  effectiveFrom: new Date(2026, 0, 1), actorId: 'S_ADM',
}, o);
t.throws('a fixed rule with no amount',
  () => M.CommissionRules.create(mk({ ruleType: 'fixed' })), 'fixedAmount');
t.throws('a fixed rule with a zero amount',
  () => M.CommissionRules.create(mk({ ruleType: 'fixed', fixedAmount: 0 })), 'fixedAmount');
t.throws('a fixed rule with a negative amount',
  () => M.CommissionRules.create(mk({ ruleType: 'fixed', fixedAmount: -120 })), 'fixedAmount');
t.throws('an unknown rule type',
  () => M.CommissionRules.create(mk({ ruleType: 'magic', fixedAmount: 120 })), 'ruleType');
t.throws('a percentage rule with no percentage',
  () => M.CommissionRules.create(mk({})), 'percentage');

t.section('A valid fixed rule is written the way the engine reads it');
const made = M.CommissionRules.create(mk({ ruleType: 'fixed', fixedAmount: 120 }));
t.eq('stored as fixed', made.ruleType, 'fixed');
t.eq('with the amount', made.fixedAmount, 120);
t.eq('and no percentage to confuse the list', made.percentage, 0);
t.eq('a percentage rule is still written as one',
     M.CommissionRules.create(mk({ percentage: 5, threshold: 5000 })).ruleType, 'percentage');

t.section('The two shapes cannot be mixed up after the fact');
const pct = M.CommissionRules.getAll().filter(r => r.ruleType === 'percentage')[0];
t.throws('a flat amount cannot be set on a percentage rule',
  () => M.CommissionRules.update({ ruleId: pct.ruleId, fixedAmount: 50, actorId: 'S_ADM' }),
  'only applies to a fixed rule');
t.throws('and a fixed rule cannot be zeroed out',
  () => M.CommissionRules.update({ ruleId: made.ruleId, fixedAmount: 0, actorId: 'S_ADM' }),
  'positive');
M.CommissionRules.update({ ruleId: made.ruleId, fixedAmount: 150, actorId: 'S_ADM' });
t.eq('but it can be changed to another amount',
     M.CommissionRules.getById(made.ruleId).fixedAmount, 150);
// Switching a live rule between shapes changes what it pays with no trace, so
// the field simply is not patchable — end the rule and write a new one.
M.CommissionRules.update({ ruleId: made.ruleId, ruleType: 'percentage', actorId: 'S_ADM' });
t.eq('and its type never changes under it',
     M.CommissionRules.getById(made.ruleId).ruleType, 'fixed');

t.done();
