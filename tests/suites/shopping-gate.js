// ============================================================
//  shopping-gate — an incomplete product cannot be ordered
// ============================================================
//  Several vape variants arrive from the POS sharing one name, because the
//  flavour never made it across. They have to stay in the picker — a product
//  you cannot see is a product someone adds a second time — but ordering one
//  is guesswork: nobody can tell which flavour the line means.
//
//  The picker sends you to the edit form instead of adding. This is the gate
//  underneath that, because the client is a suggestion and the RPC is the
//  actual door.
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('Ordering gate on incomplete products');

const PM_COLS = ['product_id','sku','barcode','product_name','brand','category','subcategory',
  'pack_size','unit','supplier','cost_price','sell_price','sell_price_credit','min_sell_price',
  'margin_amount','margin_pct','active','notes','source_file','created_by','created_at',
  'updated_by','updated_at','needs_detail'];
const SL_COLS = ['entry_id','item_id','item_name','category','quantity','unit','unit_price',
  'note','status','added_by','added_at','batch_id','generated_by','generated_at','product_id'];
const VD_COLS = ['product_id','sku','product_line','form_factor','puffs','eliquid_ml',
  'nicotine','flavor','purchase_price','sale_price','sale_price_credit','last_invoice_no',
  'created_at','updated_at'];

function pmRow(o) {
  const r = new Array(PM_COLS.length).fill('');
  r[0] = o.id; r[1] = o.sku || ''; r[2] = o.barcode || '';
  r[3] = o.name; r[4] = o.brand || 'STLTH'; r[5] = 'vape';
  r[10] = o.cost || 0; r[11] = o.sell || 0;
  r[16] = o.active === undefined ? true : o.active;
  r[23] = o.needsDetail === true;
  return r;
}

let M;
function load(rows) {
  H.sheets({
    product_master:      { headers: PM_COLS, rows: rows },
    product_vape_detail: { headers: VD_COLS, rows: [] },
    shopping_list:       { headers: SL_COLS, rows: [] },
    _pm_vape_staging:    { headers: [], rows: [] },
    config: {},
  });
  M = H.load(['Util.gs', 'ProductTypes.gs', 'ProductMaster.gs', 'ShoppingList.gs'], {
    SHEETS: { PRODUCT_MASTER: 'product_master', SHOPPING_LIST: 'shopping_list',
              PM_VAPE_STAGING: '_pm_vape_staging' },
    AuditLog: { write: () => {} },
    Staff: { getAll: () => [{ staffId: 'S_1', name: 'Ashin' }] },
  });
  return M;
}

const OK   = { id: 'PM_1', sku: 'YV-23619', name: 'STLTH Loop Max 70K Pod Blue Razz', cost: 23.52, sell: 32.5 };
const TBC  = { id: 'PM_2', sku: 'YV-23621', name: 'STLTH Loop Max 70K Pod — flavour TBC · 691584101735',
               needsDetail: true, sell: 32.5 };
const GONE = { id: 'PM_3', sku: 'YV-00000', name: 'Discontinued thing', active: false };

t.section('A complete product goes on the list');
load([pmRow(OK), pmRow(TBC), pmRow(GONE)]);
const entry = M.ShoppingList.add({ productId: 'PM_1', quantity: 3, addedBy: 'S_1' });
t.eq('it is recorded', entry.quantity, 3);
t.eq('under its own name', entry.itemName, OK.name);
t.eq('and its category', entry.category, 'vape');

t.section('An incomplete one is refused');
t.throws('adding it throws', () =>
  M.ShoppingList.add({ productId: 'PM_2', quantity: 1, addedBy: 'S_1' }), 'NEEDS_DETAIL');
t.throws('and says what is missing', () =>
  M.ShoppingList.add({ productId: 'PM_2', quantity: 1, addedBy: 'S_1' }), 'flavour or variant');
t.throws('naming the product, not just an id', () =>
  M.ShoppingList.add({ productId: 'PM_2', quantity: 1, addedBy: 'S_1' }), 'STLTH Loop Max 70K Pod');
t.eq('nothing was written', M.ShoppingList.getPending().length, 1);

t.section('The refusal is its own reason, not a recycled one');
// "inactive" and "needs detail" call for different fixes — reactivate versus
// fill in the flavour — so they must not report the same thing.
t.throws('an inactive product still says inactive', () =>
  M.ShoppingList.add({ productId: 'PM_3', quantity: 1, addedBy: 'S_1' }), 'inactive');
t.throws('a missing product still says not found', () =>
  M.ShoppingList.add({ productId: 'NOPE', quantity: 1, addedBy: 'S_1' }), 'not found');

t.section('It is still a product in every other respect');
// Visible to the picker is the whole point — the flag blocks ordering, not
// existence.
const all = M.ProductMaster.getAll();
t.eq('it is in the active list', all.filter(p => p.productId === 'PM_2').length, 1);
t.eq('and carries the flag', all.find(p => p.productId === 'PM_2').needsDetail, true);
t.eq('while a normal product does not',
     all.find(p => p.productId === 'PM_1').needsDetail, false);
t.eq('the inactive one is still excluded',
     all.filter(p => p.productId === 'PM_3').length, 0);

t.section('Filling the details in opens the door');
load([pmRow(OK), pmRow(TBC)]);
M.ProductMaster.update('PM_2', {
  productName: 'STLTH Loop Max 70K Pod Watermelon Ice',
  needsDetail: false,
}, 'S_1');
const fixed = M.ProductMaster.getById('PM_2');
t.eq('the flag is cleared', fixed.needsDetail, false);
t.eq('and the name took', fixed.productName, 'STLTH Loop Max 70K Pod Watermelon Ice');
const now = M.ShoppingList.add({ productId: 'PM_2', quantity: 2, addedBy: 'S_1' });
t.eq('it can be ordered', now.quantity, 2);
t.eq('under the corrected name', now.itemName, 'STLTH Loop Max 70K Pod Watermelon Ice');

t.section('A rename alone does not open it');
// The gate is a stored field precisely so that editing the display text
// cannot quietly make a guess orderable.
load([pmRow(TBC)]);
M.ProductMaster.update('PM_2', { productName: 'STLTH Loop Max 70K Pod Something' }, 'S_1');
t.eq('still flagged', M.ProductMaster.getById('PM_2').needsDetail, true);
t.throws('still refused', () =>
  M.ShoppingList.add({ productId: 'PM_2', quantity: 1, addedBy: 'S_1' }), 'NEEDS_DETAIL');

t.section('A manager can flag something they spot as wrong');
load([pmRow(OK)]);
M.ProductMaster.update('PM_1', { needsDetail: true }, 'S_1');
t.eq('the flag goes on', M.ProductMaster.getById('PM_1').needsDetail, true);
t.throws('and it stops being orderable', () =>
  M.ShoppingList.add({ productId: 'PM_1', quantity: 1, addedBy: 'S_1' }), 'NEEDS_DETAIL');

t.section('A product created without the flag is orderable straight away');
load([]);
const made = M.ProductMaster.create({
  productName: 'Bazooka X3 90K Banff Mint', brand: 'Bazooka', category: 'vape',
  sku: 'TMP-00003', actorId: 'S_1',
  detail: { sale_price: 44.99, purchase_price: 0, flavor: 'Banff Mint' },
});
t.eq('not flagged by default', made.needsDetail, false);
t.eq('and it lists', M.ShoppingList.add(
  { productId: made.productId, quantity: 1, addedBy: 'S_1' }).quantity, 1);

t.section('…and one created with it is not');
load([]);
const held = M.ProductMaster.create({
  productName: 'OVNS 50K — flavour TBC · 6937057503113', brand: 'OVNS', category: 'vape',
  sku: 'TMP-00023', actorId: 'S_1', needsDetail: true,
  detail: { sale_price: 36.99, purchase_price: 0, flavor: '' },
});
t.eq('the flag is stored', held.needsDetail, true);
t.throws('and it is held back', () =>
  M.ShoppingList.add({ productId: held.productId, quantity: 1, addedBy: 'S_1' }), 'NEEDS_DETAIL');

t.done();
