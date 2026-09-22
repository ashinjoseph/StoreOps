// ============================================================
//  import-perf — a bulk paste must not re-read the sheet per row
// ============================================================
//  Apps Script charges per sheet read and caps an execution at six minutes.
//  A SKU-less row — every row of a barcode-only inventory — used to fall
//  through to a duplicate check that re-read the entire product master, so a
//  200-row paste read the master 200 times and timed out somewhere in the
//  middle, leaving a half-imported sheet.
//
//  The fix was to build both dedup indexes once and keep them current as rows
//  are created. Nothing on screen looks different when that regresses; it
//  just gets slower until it stops finishing. Hence counting the reads.
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('bulk import cost');

const PM_COLS = ['product_id','sku','barcode','product_name','brand','category',
  'subcategory','pack_size','unit','supplier','cost_price','sell_price',
  'sell_price_credit','min_sell_price','margin_amount','margin_pct','active',
  'notes','source_file','created_by','created_at','updated_by','updated_at'];
// Must match ProductMaster.stagingLayout('other') exactly — the importer now
// refuses a header that is missing any of it, which is the whole point.
const ST_COLS = ['sku','barcode','product_name','brand','category','subcategory',
  'pack_size','unit','supplier','min_sell_price','notes','source_file','needs_detail',
  'cost_price','sell_price','sell_price_credit'];
const SX = {}; ST_COLS.forEach((c, i) => { SX[c] = i; });

function stagingRow(o) {
  const r = new Array(ST_COLS.length).fill('');
  Object.keys(o).forEach(k => { r[SX[k]] = o[k]; });
  return r;
}

let masterReads = 0, masterWrites = 0;
/** Wrap the master sheet's ranges so every bulk read and write is counted. */
function instrument() {
  const ss = global.SpreadsheetApp.getActiveSpreadsheet();
  const orig = ss.getSheetByName;
  global.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: name => {
        const sh = orig(name);
        if (!sh || name !== 'product_master') return sh;
        const g = sh.getRange;
        sh.getRange = function (r, c, nr, nc) {
          const range = g.call(sh, r, c, nr, nc);
          const gv = range.getValues, sv = range.setValues;
          range.getValues = function () {
            // The header probe is not the cost; a multi-row data read is.
            if (r >= 3 && (nr || 1) > 1) masterReads++;
            return gv.call(range);
          };
          range.setValues = function (v) { masterWrites++; return sv.call(range, v); };
          return range;
        };
        return sh;
      },
      insertSheet: () => null,
    }),
    getUi: () => ({ alert: () => {} }),
  };
}

function run(stagingRows, existing) {
  masterReads = 0; masterWrites = 0;
  H.sheets({
    product_master: { headers: PM_COLS, rows: existing || [] },
    _pm_other_staging: { headers: ST_COLS, rows: stagingRows },
    config: {},
  });
  const M = H.load(['Util.gs', 'ProductTypes.gs', 'ProductMaster.gs'], {
    SHEETS: { PRODUCT_MASTER: 'product_master', PM_OTHER_STAGING: '_pm_other_staging' },
    AuditLog: { write: () => {}, writeMany: () => {} },
  });
  instrument();
  const res = M.ProductMaster.importFromStaging({ type: 'other', actorId: 'S_1' });
  return { res: res, module: M, reads: masterReads, writes: masterWrites };
}

// Barcode-only rows: no SKU at all, which is the case that used to be linear.
function barcodeOnly(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(stagingRow({ barcode: '0620675' + (10000 + i), product_name: 'Item ' + i,
                          brand: 'Brand', cost_price: 1, sell_price: 2 }));
  }
  return out;
}

t.section('The master is read a fixed number of times, whatever the paste size');
const small = run(barcodeOnly(5));
const large = run(barcodeOnly(200));
t.eq('five rows import', small.res.imported, 5);
t.eq('two hundred rows import', large.res.imported, 200);
t.eq('and cost the same number of master reads', large.reads, small.reads);
t.ok('which is a small constant, not per-row', small.reads <= 3);
t.ok('the same small constant on the big paste', large.reads <= 3);

t.section('Forty times the rows is not forty times the reads');
// The regression this guards is exactly proportional, so state it that way.
t.ok('reads did not scale with the paste', large.reads < 200);

t.section('Writes do not scale with the paste either');
// This is what put a 186-row vape import over the six-minute execution limit:
// a row at a time meant eight API calls each — core row, detail row, audit
// row, and a getLastRow before each — so the cost grew with the file until it
// stopped finishing. A bulk run now collects and appends once per sheet.
t.ok('five rows cost a handful of writes', small.writes <= 3);
t.eq('and two hundred rows cost the same', large.writes, small.writes);
t.ok('not one per row', large.writes < 200);

/** A product already sitting in the master, as a sheet row. */
function masterRow(o) {
  const row = new Array(PM_COLS.length).fill('');
  row[0] = o.productId; row[1] = o.sku || ''; row[2] = o.barcode || '';
  row[3] = o.productName; row[4] = o.brand || ''; row[5] = o.category || 'other';
  row[8] = o.unit || ''; row[10] = o.costPrice || 0; row[11] = o.sellPrice || 0;
  row[16] = true;
  return row;
}

t.section('A SKU dedups against what is already there');
let r = run(
  [stagingRow({ sku: 'ABC', product_name: 'Cola', brand: 'Coke', cost_price: 1, sell_price: 3 })],
  [masterRow({ productId: 'P1', sku: 'ABC', productName: 'Cola', brand: 'Coke' })]
);
t.eq('the second pass updates rather than duplicates', r.res.updated, 1);
t.eq('and imports nothing new', r.res.imported, 0);
t.eq('the master still holds one product',
     r.module.ProductMaster.getAll().length, 1);
t.eq('a different SKU is a different product',
     run([stagingRow({ sku: 'XYZ', product_name: 'Cola Zero', brand: 'Coke',
                       cost_price: 1, sell_price: 3 })],
         [masterRow({ productId: 'P1', sku: 'ABC', productName: 'Cola', brand: 'Coke' })])
       .res.imported, 1);

t.section('A row with no SKU dedups on brand and name');
r = run([stagingRow({ barcode: '111', product_name: 'Cola', brand: 'Coke',
                      cost_price: 1, sell_price: 2 })],
        [masterRow({ productId: 'P1', sku: '', barcode: '111', productName: 'Cola',
                     brand: 'Coke' })]);
t.eq('nothing is imported twice', r.res.imported, 0);
t.eq('it is skipped, not updated — there is no key to update on', r.res.skipped, 1);

t.section('Two rows sharing a name inside one paste collapse');
// Otherwise the same paste behaves differently from two consecutive pastes.
r = run([
  stagingRow({ barcode: '111', product_name: 'Cola', brand: 'Coke', cost_price: 1, sell_price: 2 }),
  stagingRow({ barcode: '222', product_name: 'Cola', brand: 'Coke', cost_price: 1, sell_price: 2 }),
]);
t.eq('the first is created', r.res.imported, 1);
t.eq('the second is skipped', r.res.skipped, 1);
t.eq('and the master ends with one row, not two',
     r.module.ProductMaster.getAll().length, 1);

t.section('Names are matched case- and space-insensitively');
r = run([
  stagingRow({ product_name: 'Cola', brand: 'Coke', cost_price: 1, sell_price: 2 }),
  stagingRow({ product_name: '  COLA ', brand: ' coke', cost_price: 1, sell_price: 2 }),
]);
t.eq('only one survives', r.res.imported, 1);
t.eq('the other is a duplicate', r.res.skipped, 1);

t.section('Junk rows are skipped silently, not reported as errors');
r = run([
  stagingRow({ product_name: '', brand: '' }),                      // blank
  stagingRow({ product_name: 'product_name', brand: 'brand' }),     // pasted header echo
  stagingRow({ product_name: 'Cola', brand: 'Coke', cost_price: 1, sell_price: 2 }),
]);
t.eq('only the real row imports', r.res.imported, 1);
t.eq('nothing is counted as an error', r.res.errorCount, 0);
t.eq('and nothing is reported as skipped either', r.res.skipped, 0);

t.section('A failing row is named, not just counted');
// The staging tab is hidden, so "row 47" means counting rows to find out what
// broke. The error has to carry the SKU and the name.
// A bad category is rejected in create_, so this really does throw — a row
// that merely lacks a price would sail through for the 'other' type, which
// has no validate rule, and the assertions below would pass on an empty list.
r = run([
  stagingRow({ sku: 'YV-1', product_name: 'Good one', cost_price: 1, sell_price: 2 }),
  stagingRow({ sku: 'YV-2', product_name: 'Bad one', category: 'nonsense',
               cost_price: 1, sell_price: 2 }),
]);
t.eq('the good row landed', r.res.imported, 1);
t.eq('the bad one is counted as an error', r.res.errorCount, 1);
const failed = r.res.errors[0];
t.eq('it carries the SKU', failed.sku, 'YV-2');
t.eq('and the product name', failed.productName, 'Bad one');
t.eq('and still the row number', failed.rowIndex, 4);
t.ok('and says what went wrong', /invalid category/.test(failed.message));

t.section('The error COUNT is not the length of the error list');
// errors is capped; reporting its length as the count said "Errors: 50" on a
// run that actually lost 161 rows, and the numbers stopped adding up to the
// rows that went in.
// More failures than the list can hold, so the cap actually bites.
const many = [];
for (let i = 0; i < 60; i++) {
  many.push(stagingRow({ sku: 'OK-' + i, product_name: 'Fine ' + i,
                         cost_price: 1, sell_price: 2 }));
}
for (let i = 0; i < 70; i++) {
  many.push(stagingRow({ sku: 'BAD-' + i, product_name: 'Broken ' + i,
                         category: 'nonsense', cost_price: 1, sell_price: 2 }));
}
r = run(many);
t.eq('the good rows landed', r.res.imported, 60);
t.eq('every failure is counted', r.res.errorCount, 70);
t.eq('but the list is capped at 50', r.res.errors.length, 50);
t.ok('so the count is larger than the list', r.res.errorCount > r.res.errors.length);
t.eq('read = imported + updated + skipped + errorCount',
     r.res.imported + r.res.updated + r.res.skipped + r.res.errorCount, 130);

t.section('A stale header row is refused, not silently mis-mapped');
// The real incident: the staging tab was built before needs_detail existed, so
// row 2 still described 22 columns while the pasted data had 23. Mapping is by
// NAME, so every lookup still succeeded — each one pointing a column to the
// left of its data. 161 of 186 rows failed as "sale_price > 0", blaming the
// data for a header problem.
const CURRENT = ST_COLS.slice();
const STALE = CURRENT.filter(c => c !== 'needs_detail');

function runWithHeader(header, dataRows) {
  masterReads = 0; masterWrites = 0;
  H.sheets({
    product_master: { headers: PM_COLS, rows: [] },
    _pm_other_staging: { headers: header, rows: dataRows },
    config: {},
  });
  const M = H.load(['Util.gs', 'ProductTypes.gs', 'ProductMaster.gs'], {
    SHEETS: { PRODUCT_MASTER: 'product_master', PM_OTHER_STAGING: '_pm_other_staging' },
    AuditLog: { write: () => {}, writeMany: () => {} },
  });
  try { return { res: M.ProductMaster.importFromStaging({ type: 'other', actorId: 'S_1' }) }; }
  catch (e) { return { error: e.message }; }
}
// Data carries the CURRENT shape; the header on row 2 is the stale one.
const wide = [['SKU-1','111','Cola','Coke','other','','','','','','','','', 1, 2, '']];
let out = runWithHeader(STALE, wide);
t.ok('the import refuses outright', !!out.error);
t.ok('and names the column that is missing', /needs_detail/.test(out.error || ''));
t.ok('and says the header is the problem, not the data',
     /header row[\s\S]*out of date/i.test(out.error || ''));
t.ok('and says how to fix it', /Refresh staging headers/.test(out.error || ''));

t.section('A current header imports normally');
out = runWithHeader(CURRENT, wide);
t.ok('no refusal', !out.error);
t.eq('the row lands', out.res.imported, 1);

t.section('A repeated header row is counted, not swallowed');
// Pasting one row too low leaves the header sitting in the data. It used to be
// dropped in silence, which hid exactly the misalignment that caused it.
out = runWithHeader(CURRENT, [
  CURRENT.map(c => c),                                            // the echo
  ['SKU-2','222','Fanta','Coke','other','','','','','','','','', 1, 2, ''],
]);
t.eq('the real row still imports', out.res.imported, 1);
t.eq('the echo is reported', out.res.headerEchoes, 1);
t.eq('and is not counted as an error', out.res.errorCount, 0);
t.eq('nor as a skip', out.res.skipped, 0);

// ── The registry path, which is where the real cost lives ──────────────────
// Everything above imports 'other', which writes no detail row and no audit
// row. That is why a 186-row vape import could take six minutes while this
// suite stayed green: the type that actually times out was never exercised.
const VS_COLS = ['sku','barcode','product_name','brand','category','subcategory',
  'pack_size','unit','supplier','min_sell_price','notes','source_file','needs_detail',
  'product_line','form_factor','puffs','eliquid_ml','nicotine','flavor',
  'purchase_price','sale_price','sale_price_credit','last_invoice_no'];
const VD_COLS = ['product_id','sku','product_line','form_factor','puffs','eliquid_ml',
  'nicotine','flavor','purchase_price','sale_price','sale_price_credit','last_invoice_no',
  'created_at','updated_at'];
const AL_COLS = ['log_id','ts','actor_id','action','target_type','target_id',
  'before','after','details'];
const VX = {}; VS_COLS.forEach((c, i) => { VX[c] = i; });

function vapeRow(i) {
  const r = new Array(VS_COLS.length).fill('');
  r[VX.sku] = 'YV-' + (20000 + i);
  r[VX.barcode] = '69375' + (100000 + i);
  r[VX.product_name] = 'Vape thing ' + i;
  r[VX.brand] = 'Brand';
  r[VX.category] = 'vape';
  r[VX.product_line] = 'Line';
  r[VX.form_factor] = 'Disposable';
  r[VX.flavor] = 'Flavour ' + i;
  r[VX.sale_price] = 24.99;
  return r;
}

let apiCalls = 0;
function runVape(rows, master, detail) {
  apiCalls = 0;
  H.sheets({
    product_master:      { headers: PM_COLS, rows: master || [] },
    product_vape_detail: { headers: VD_COLS, rows: detail || [] },
    audit_log:           { headers: AL_COLS, rows: [] },
    _pm_vape_staging:    { headers: VS_COLS, rows: rows },
    config: {},
  });
  const M = H.load(['Util.gs', 'ProductTypes.gs', 'ProductMaster.gs', 'AuditLog.gs'], {
    SHEETS: { PRODUCT_MASTER: 'product_master', PM_VAPE_STAGING: '_pm_vape_staging',
              AUDIT_LOG: 'audit_log' },
  });
  const ss = global.SpreadsheetApp.getActiveSpreadsheet();
  const orig = ss.getSheetByName;
  global.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: name => {
        const sh = orig(name);
        if (!sh) return sh;
        const glr = sh.getLastRow, g = sh.getRange;
        sh.getLastRow = function () { apiCalls++; return glr.call(sh); };
        sh.getRange = function (r, c, nr, nc) {
          const range = g.call(sh, r, c, nr, nc);
          const gv = range.getValues, sv = range.setValues, s1 = range.setValue;
          range.getValues = function () { apiCalls++; return gv.call(range); };
          range.setValues = function (v) { apiCalls++; return sv.call(range, v); };
          range.setValue = function (v) { apiCalls++; return s1.call(range, v); };
          return range;
        };
        return sh;
      },
      insertSheet: () => null,
    }),
    getUi: () => ({ alert: () => {} }),
  };
  const res = M.ProductMaster.importFromStaging({ type: 'vape', actorId: 'IMPORT' });
  return { res: res, calls: apiCalls, M: M };
}

t.section('A vape import does not cost more the bigger it gets');
// Apps Script kills an execution at six minutes. At a few hundred milliseconds
// per API call that is roughly 1400 calls — which a row-at-a-time import of
// 186 products reached exactly, and did in production.
const tiny = runVape([vapeRow(1), vapeRow(2), vapeRow(3)]);
t.eq('three rows import', tiny.res.imported, 3);
const big = runVape(Array.from({ length: 200 }, (_, i) => vapeRow(i)));
t.eq('two hundred rows import', big.res.imported, 200);
t.ok('and cost about the same as three', big.calls <= tiny.calls + 2);
t.ok('nowhere near the execution limit', big.calls < 60);

t.section('Re-importing the same file is just as cheap');
// The second run is all updates. It used to cost MORE than the first — a full
// master read and a full detail read per row — so a correction pass timed out
// even when the first import had not.
const rows200 = Array.from({ length: 200 }, (_, i) => vapeRow(i));
const first = runVape(rows200);
const master = H.rowsOf('product_master').map(r => r.slice());
const detail = H.rowsOf('product_vape_detail').map(r => r.slice());
const second = runVape(rows200, master, detail);
t.eq('nothing is inserted twice', second.res.imported, 0);
t.eq('every row is updated', second.res.updated, 200);
t.ok('and it costs no more than the insert did', second.calls <= first.calls + 5);
t.ok('still nowhere near the limit', second.calls < 60);
t.eq('the master did not grow', second.M.ProductMaster.getAll().length, 200);

t.section('An empty staging tab costs nothing');
r = run([]);
t.eq('nothing imported', r.res.imported, 0);
t.eq('and the master was never read', r.reads, 0);

t.done();
