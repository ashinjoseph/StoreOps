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
const ST_COLS = ['sku','barcode','product_name','brand','category','subcategory',
  'pack_size','unit','supplier','min_sell_price','notes','source_file',
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
    AuditLog: { write: () => {} },
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

t.section('Each product is written once, not by rewriting the sheet');
t.eq('one write per imported row', large.writes, 200);

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

t.section('An empty staging tab costs nothing');
r = run([]);
t.eq('nothing imported', r.res.imported, 0);
t.eq('and the master was never read', r.reads, 0);

t.done();
