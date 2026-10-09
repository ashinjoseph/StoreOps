// ============================================================
//  fixtures.js — two months of a fictional store, seeded for the docs
// ============================================================
//  Everyone and everything here is invented. No real staff, wages, sales or
//  phone numbers ever reach a screenshot.
//
//  History that only the passage of time can create — shifts, sales, the
//  daily reconciliation — is written as rows. Everything derived from it is
//  produced by the REAL modules: the commission engine proposes the bonuses,
//  Payments allocates pay oldest-first, CashHandling settles handovers, the
//  product master validates and prices. So the numbers on screen agree with
//  each other for the same reason they do in production.
//
//  Seeded RNG, so a re-run produces the same story (dates move with today).
// ============================================================
'use strict';

// mulberry32 — tiny, deterministic, good enough for fixtures.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAFF = [
  { id: 'S_001', name: 'Priya Nair',    role: 'admin',         rate: 0,     code: '1111', notes: 'Owner' },
  { id: 'S_002', name: 'Daniel Okafor', role: 'manager',       rate: 19.5,  code: '2222', notes: 'Store manager' },
  { id: 'S_003', name: 'Maya Chen',     role: 'employee',      rate: 17.6,  code: '3333', notes: '' },
  { id: 'S_004', name: 'Jordan Reyes',  role: 'employee',      rate: 17.6,  code: '4444', notes: '' },
  { id: 'S_005', name: 'Sam Patel',     role: 'employee',      rate: 17.2,  code: '5555', notes: '' },
];

function seed(api, ss) {
  const R = rng(20260901);
  const between = (a, b) => Math.round((a + R() * (b - a)) * 100) / 100;
  const money = n => Math.round(n * 100) / 100;

  // Append a row by column NAME, read from the sheet's own header row — the
  // fixture cannot drift out of step with the schema the setup just built.
  const put = (sheetName, obj) => {
    const sh = ss.getSheetByName(sheetName);
    const hdr = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0];
    const row = hdr.map(h => (h in obj ? obj[h] : ''));
    sh.getRange(Math.max(sh.getLastRow(), 2) + 1, 1, 1, row.length).setValues([row]);
  };
  const setConfig = (key, value) => {
    const sh = ss.getSheetByName('config');
    const vals = sh.getRange(3, 1, Math.max(sh.getLastRow() - 2, 1), 2).getValues();
    const i = vals.findIndex(r => r[0] === key);
    if (i >= 0) sh.getRange(3 + i, 2).setValue(value);
    else put('config', { key, value, description: 'docs fixture' });
  };

  // Setup seeds a placeholder admin, a placeholder rule and the store's own
  // supplier list. None of that is fictional, so none of it may reach a
  // screenshot: clear the data rows and start from nothing.
  const clear = sheetName => {
    const sh = ss.getSheetByName(sheetName);
    const last = sh.getLastRow();
    if (last >= 3) sh.getRange(3, 1, last - 2, sh.getLastColumn()).clearContent();
    sh._grid.length = 3;
  };
  // Not every placeholder says so — some carry real-looking ids such as
  // CST-<date>-S_001 — so clear every table but config rather than guess.
  Object.keys(ss._sheets).filter(n => n !== 'config').forEach(clear);

  // ── Config ────────────────────────────────────────────────
  setConfig('cash_manager_staff_id', 'S_002');
  setConfig('public_report_url', 'https://script.google.com/macros/s/EXAMPLE/exec');
  setConfig('cstore_card_split', 'false');      // cstore is on ePOS: one card figure
  setConfig('vape_card_split', 'true');
  setConfig('notifier_enabled', 'false');

  // ── Staff ────────────────────────────────────────────────
  const created = new Date(); created.setDate(created.getDate() - 120);
  STAFF.forEach(s => put('staff', {
    staff_id: s.id, name: s.name, hourly_rate: s.rate, active: true, role: s.role,
    login_code: s.code, companies_authorized: 'cstore,vape', email: '',
    start_date: created, created_at: created, notes: s.notes,
  }));

  // ── Two months of shifts ─────────────────────────────────
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // Twice the sales tab's 60-day window, so its "vs the previous window"
  // trend compares two full periods instead of one against nothing.
  const DAYS = 120;
  const EPOS_CUTOVER = 21;                       // cstore moved to ePOS 21 days ago
  const rota = [['S_003', 'S_004', 'S_005'], ['S_004', 'S_005', 'S_003'], ['S_005', 'S_003', 'S_004']];
  let reserve = 500;

  for (let back = DAYS; back >= 1; back--) {
    const day = new Date(today); day.setDate(day.getDate() - back);
    const dow = day.getDay();
    const mult = (dow === 5 || dow === 6 ? 1.28 : dow === 0 ? 0.82 : 1) *
                 (day.getDate() <= 10 ? 1.12 : day.getDate() >= 25 ? 1.04 : 1);
    const [am, pm, vape] = rota[back % 3];
    const ymd = api.Util.formatDate(day).replace(/-/g, '');
    const at = (h, m) => { const d = new Date(day); d.setHours(h, m || 0, 0, 0); return d; };
    const onEpos = back <= EPOS_CUTOVER;

    const shifts = [
      { staff: am, company: 'cstore', start: at(8), end: at(15),
        cash: between(430, 680) * mult, card: between(720, 1080) * mult },
      { staff: pm, company: 'cstore', start: at(15), end: at(22, 15),
        cash: between(520, 860) * mult, card: between(830, 1290) * mult },
      { staff: vape, company: 'vape', start: at(10), end: at(20),
        cash: between(70, 210) * mult, card: between(220, 470) * mult },
    ];

    // One night a big lotto win is paid out of the reserve — the case the
    // till-close sheet was rebuilt for.
    const payoutNight = back === 9;

    shifts.forEach((s, i) => {
      const id = (s.company === 'cstore' ? 'CST' : 'VAP') + '-' + ymd + '-' + s.staff;
      const float = s.company === 'cstore' ? 250 : 100;
      let cash = money(s.cash);
      let fed = 0, topup = 0, counted = null, note = '';
      if (s.company === 'cstore' && i === 1) {
        if (payoutNight) { cash = money(cash - 900); fed = 300; reserve = 200; note = 'Paid $900 winning ticket'; }
        else if (reserve < 500) { topup = 500 - reserve; reserve = 500; }
        counted = reserve;
      } else if (s.company === 'cstore') {
        counted = reserve;
      }
      const drift = R();
      const variance = drift > 0.94 ? -money(between(31, 48)) : drift > 0.82 ? money(between(-6, 4)) : 0;
      const expected = money(float + cash + fed);
      const countedCash = money(expected + variance);
      const status = Math.abs(variance) > 30 ? 'investigate' : Math.abs(variance) > 1 ? 'minor' : 'OK';
      const removed = money(countedCash - float - topup);
      const attId = 'A_' + ymd + '_' + s.staff;

      put('till_sessions', {
        session_id: id, attendance_id: attId, staff_id: s.staff, company: s.company,
        date: day, status: 'closed', start_time: s.start, end_time: s.end,
        expected_opening: float, opening_float: float, opening_note: '',
        closing_cash_counted: countedCash, cash_left_in_till: float,
        cash_removed_at_close: removed, expected_cash: expected,
        closing_variance: variance, variance_status: status, notes: '',
        lotto_reserve_counted: counted == null ? '' : counted,
        lotto_topup_from_till: topup, lotto_reserve_note: note,
      });

      const card = money(s.card);
      const split = s.company === 'vape' || !onEpos;
      const credit = split ? money(card * 0.62) : '';
      const debit = split ? money(card - credit) : '';
      put('sales', {
        sales_id: id, session_id: id, staff_id: s.staff, company: s.company, date: day,
        cash_sales: cash, credit_card_sales: credit, debit_card_sales: debit,
        cashback_paid: 0, misc_cash_sales: 0, misc_credit_sales: split ? 0 : '',
        misc_debit_sales: split ? 0 : '', misc_notes: '',
        card_total_sales: split ? '' : card, misc_card_sales: split ? '' : 0,
      });

      const hours = money((s.end - s.start) / 36e5);
      const rate = STAFF.find(x => x.id === s.staff).rate;
      put('attendance', {
        attendance_id: attId, staff_id: s.staff, date: day,
        actual_start: s.start, actual_end: s.end, hours_worked: hours,
        rate_at_attendance: rate, status: 'worked', created_by: 'S_001',
        created_at: s.start, hours_basis: 'actual',
      });
    });

    // The day's reconciliation: cstore has no Clover (ePOS), vape does.
    const cst = shifts.filter(s => s.company === 'cstore');
    const vp = shifts.find(s => s.company === 'vape');
    const vCard = money(vp.card);
    const cloverVar = R() > 0.9 ? money(between(-14, -3)) : 0;
    put('validation_results', {
      validation_id: 'VR_' + ymd + '_V', business_date: day, window_start: vp.start, window_end: vp.end,
      merchant: 'vape', companies: 'vape',
      cashier_credit: money(vCard * 0.62), clover_credit: money(vCard * 0.62 + cloverVar),
      cashier_debit: money(vCard - vCard * 0.62), clover_debit: money(vCard - vCard * 0.62),
      cashier_card: vCard, clover_card: money(vCard + cloverVar), card_variance: cloverVar,
      cash_counted: money(100 + vp.cash), cash_variance: 0,
      status: Math.abs(cloverVar) > 1 ? 'INVESTIGATE' : 'OK', mode: 'auto',
      session_ids: 'VAP-' + ymd + '-' + vp.staff, validated_at: vp.end, validated_by: 'SYSTEM',
      cash_sales: money(vp.cash),
    });
    const cCard = money(cst.reduce((a, s) => a + s.card, 0));
    const cCash = money(cst.reduce((a, s) => a + s.cash, 0));
    put('validation_results', {
      validation_id: 'VR_' + ymd + '_C', business_date: day, window_start: cst[0].start, window_end: cst[1].end,
      merchant: 'cstore', companies: 'cstore',
      cashier_credit: '', clover_credit: '', cashier_debit: '', clover_debit: '',
      cashier_card: cCard, clover_card: '', card_variance: '',
      cash_counted: money(500 + cCash), cash_variance: 0,
      status: 'OK', mode: 'auto',
      session_ids: cst.map(s => 'CST-' + ymd + '-' + s.staff).join(','),
      validated_at: cst[1].end, validated_by: 'SYSTEM', cash_sales: cCash,
    });
  }

  // ── Today: cstore open, vape not yet ─────────────────────
  {
    const ymd = api.Util.formatDate(today).replace(/-/g, '');
    const start = new Date(today); start.setHours(8, 2, 0, 0);
    put('till_sessions', {
      session_id: 'CST-' + ymd + '-S_003', attendance_id: 'A_' + ymd + '_S_003',
      staff_id: 'S_003', company: 'cstore', date: today, status: 'open',
      start_time: start, expected_opening: 250, opening_float: 250,
      lotto_reserve_counted: '', lotto_topup_from_till: '',
    });
    put('attendance', {
      attendance_id: 'A_' + ymd + '_S_003', staff_id: 'S_003', date: today,
      actual_start: start, rate_at_attendance: 17.6, status: 'in_progress',
      created_by: 'S_003', created_at: start, hours_basis: 'actual',
    });
  }

  // ── Commission rules, through the real API ───────────────
  const ruleStart = new Date(today); ruleStart.setDate(ruleStart.getDate() - 70);
  api.CommissionRules.create({ name: 'Cstore weekly — 3% over $6,000', appliesTo: 'all_staff',
    company: 'cstore', threshold: 6000, percentage: 3, effectiveFrom: ruleStart, actorId: 'S_001' });
  api.CommissionRules.create({ name: 'Vape weekly — 5% over $1,200', appliesTo: 'all_staff',
    company: 'vape', threshold: 1200, percentage: 5, effectiveFrom: ruleStart, actorId: 'S_001' });
  api.CommissionRules.create({ name: 'Management fee', appliesTo: 'specific_staff', staffId: 'S_002',
    company: 'cstore', threshold: 0, ruleType: 'fixed', fixedAmount: 120,
    effectiveFrom: ruleStart, actorId: 'S_001', notes: 'Weekly, not tied to sales' });

  // ── The real engine, for the last four weeks ─────────────
  const monday = new Date(today); monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  for (let w = 4; w >= 1; w--) {
    const ws = new Date(monday); ws.setDate(ws.getDate() - 7 * w);
    const we = new Date(ws); we.setDate(we.getDate() + 6); we.setHours(23, 59, 59);
    api.Commissions.runForWeek({ weekStart: ws, weekEnd: we, actorId: 'SYSTEM_TRIGGER' });
  }
  // Approve all but the latest week's proposals, so Payroll shows both states.
  const latest = new Date(monday); latest.setDate(latest.getDate() - 7);
  api.Bonuses.getAll().filter(b => b.status === 'proposed' &&
      b.periodStart && b.periodStart < latest)
    .forEach(b => api.Bonuses.approve(b.bonusId, 'S_001'));

  // ── Pay everyone up to about two weeks ago, oldest first ─
  const payThrough = new Date(today); payThrough.setDate(payThrough.getDate() - 10);
  ['S_003', 'S_004', 'S_005'].forEach(id => {
    const owed = api.Payments.getOwedSummary(id);
    const amount = money(owed.unpaidShifts
      .filter(u => new Date(u.date) < payThrough)
      .reduce((a, u) => a + u.remaining, 0));
    if (amount > 0) {
      try { api.Payments.payShifts({ staffId: id, amount, method: 'etransfer',
                                     actorId: 'S_001', overrideMismatch: true }); }
      catch (e) { console.warn('pay ' + id + ': ' + e.message); }
    }
  });
  // Daniel's management fees for the older weeks have been paid too.
  api.Bonuses.getAll().filter(b => b.staffId === 'S_002' && b.status === 'pending')
    .slice(0, 2).forEach(b => {
      try { api.Payments.payBonus({ bonusId: b.bonusId, amount: b.amount, method: 'etransfer', actorId: 'S_001' }); }
      catch (e) { console.warn('pay bonus: ' + e.message); }
    });

  // ── Cash handovers: weekly drops, the last few shifts still out ──
  // One handover per cashier per week, dated the Monday after, so the cash
  // page reads like a real ledger rather than one enormous transfer. The
  // shifts since the last drop stay out — the normal state of a till.
  // Allocation is oldest-first in the real module, so each week's drop
  // settles exactly that week's shifts.
  const mondayAfter = dateStr => {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
    d.setHours(10, 0, 0, 0);
    return d;
  };
  ['S_003', 'S_004', 'S_005'].forEach(id => {
    try {
      const weeks = {};
      api.CashHandling.getOutstandingForStaff(id).unsettledSessions.forEach(s => {
        const due = mondayAfter(s.dateStr);
        if (due > new Date()) return;            // this week's shifts: still out
        const k = due.getTime();
        weeks[k] = money((weeks[k] || 0) + s.remaining);
      });
      Object.keys(weeks).map(Number).sort((a, b) => a - b).forEach(k => {
        if (weeks[k] <= 0) return;
        // Every drop but the newest leaves later weeks outstanding at the
        // moment it is recorded, and the real guard wants a reason for that.
        api.CashHandling.record({ fromStaffId: id, amount: weeks[k], actorId: 'S_002',
          handedOn: new Date(k), notes: 'Weekly drop' });
      });
    } catch (e) { console.warn('handover ' + id + ': ' + e.message); }
  });

  // ── Product master, through the real API ─────────────────
  const P = (o) => {
    try { return api.ProductMaster.create(Object.assign({ actorId: 'S_001', sourceFile: 'docs-fixture' }, o)); }
    catch (e) { console.warn('product ' + o.productName + ': ' + e.message); return null; }
  };
  const vape = (sku, name, brand, line, flavor, sale, cost, extra) => P(Object.assign({
    sku, productName: name, brand, category: 'vape', subcategory: line,
    detail: { product_line: line, form_factor: 'Disposable', flavor, nicotine: '20 mg/mL',
              eliquid_ml: 20, sale_price: sale, purchase_price: cost || 0 },
  }, extra || {}));
  vape('VP-1001', 'Nimbus 40K Blue Razz Ice', 'Nimbus', '40K', 'Blue Razz Ice', 34.99, 21.4);
  vape('VP-1002', 'Nimbus 40K Watermelon Mint', 'Nimbus', '40K', 'Watermelon Mint', 34.99, 21.4);
  vape('VP-1003', 'Nimbus 40K Mango Peach', 'Nimbus', '40K', 'Mango Peach', 34.99, 21.4);
  vape('VP-1004', 'Corvo Pod 25K Grape Ice', 'Corvo', 'Pod 25K', 'Grape Ice', 27.5, 0);
  vape('VP-1005', 'Corvo Pod 25K Strawberry Kiwi', 'Corvo', 'Pod 25K', 'Strawberry Kiwi', 27.5, 0);
  vape('VP-1006', 'Corvo Pod 25K — flavour TBC · 690000000123', 'Corvo', 'Pod 25K', '', 27.5, 0,
       { needsDetail: true, notes: 'flavour unknown — complete before ordering' });
  vape('VP-1007', 'Corvo Pod 25K — flavour TBC · 690000000130', 'Corvo', 'Pod 25K', '', 27.5, 0,
       { needsDetail: true, notes: 'flavour unknown — complete before ordering' });
  vape('VP-1008', 'Halo Mini 3K Cool Mint', 'Halo', 'Mini 3K', 'Cool Mint', 19.99, 11.6);
  const other = (sku, name, brand, cost, sell, sub) => P({ sku, productName: name, brand,
    category: 'grocery', subcategory: sub || '', costPrice: cost, sellPrice: sell });
  other('GR-2001', 'Sparkling Water 500ml', 'Clearbrook', 0.62, 1.99, 'Drinks');
  other('GR-2002', 'Cola 355ml Can', 'Fizzco', 0.48, 1.79, 'Drinks');
  other('GR-2003', 'Sea Salt Chips 200g', 'Crunchworks', 1.85, 4.49, 'Snacks');
  other('GR-2004', 'Milk 2% 1L', 'Meadowfield', 1.6, 3.29, 'Dairy');
  other('GR-2005', 'Instant Noodles Chicken', 'Ramenya', 0.41, 1.49, 'Pantry');
  other('GR-2006', 'Paper Towels 2-pack', 'Softleaf', 2.9, 5.99, 'Household');

  // ── Shopping list, through the real API ──────────────────
  const byName = n => api.ProductMaster.getAll().find(p => p.productName === n);
  [['Nimbus 40K Blue Razz Ice', 10, 'S_003'], ['Nimbus 40K Mango Peach', 6, 'S_004'],
   ['Halo Mini 3K Cool Mint', 12, 'S_003'], ['Sparkling Water 500ml', 24, 'S_005'],
   ['Milk 2% 1L', 8, 'S_004'], ['Sea Salt Chips 200g', 12, 'S_005']]
    .forEach(([n, q, by]) => {
      const p = byName(n);
      if (p) api.ShoppingList.add({ productId: p.productId, quantity: q, addedBy: by });
    });

  // ── Suppliers ────────────────────────────────────────────
  [['SUP_01', 'Northline Distribution', 'Vapes', 'Disposables, pods', 'orders@northline.example'],
   ['SUP_02', 'Metro Wholesale Club', 'Grocery', 'Drinks, snacks, household', 'Walk-in, Mon–Sat'],
   ['SUP_03', 'Lakeside Dairy', 'Grocery', 'Milk, eggs', 'Delivers Tue & Fri']]
    .forEach(([id, name, cat, products, contact]) =>
      put('suppliers', { supplier_id: id, name, category: cat, products, contact, notes: '', active: true }));

  api.ProductMaster._bust && api.ProductMaster._bust();
  return { staff: STAFF, today };
}

module.exports = { seed, STAFF };
