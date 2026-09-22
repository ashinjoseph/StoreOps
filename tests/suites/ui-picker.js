// ============================================================
//  ui-picker — the list you order from
// ============================================================
//  The picker is the only way a product reaches the shopping list, so a
//  product it will not show may as well not be in the master. It used to cap
//  at 40 rows with nothing on screen to say so: the vape shelf alone runs to
//  ~190 products, so tapping the Vape chip showed a fifth of it and hid the
//  rest silently. "Not in the picker" then looks exactly like "past the cut",
//  which is how something nobody could find gets added to the master twice.
// ============================================================
const vm = require('vm');
const H = require('./_lib/harness');
const t = H.suite('Shopping-list product picker');

const js = H.clientScript('Index.html');
const lifted = ['esc', 'money', 'catLabel', 'renderResults']
  .map(n => H.fnSource(js, n)).join('\n\n');

// Read the cap out of the source rather than restating it, so the assertions
// below follow the real value if it is ever retuned.
const capMatch = /const MAX_PICKER_ROWS = (\d+);/.exec(js);
const CAP = capMatch ? Number(capMatch[1]) : null;

function product(i, over) {
  return Object.assign({
    productId: 'P' + i, sku: 'YV-' + (23500 + i),
    productName: 'Vape product ' + i, brand: 'Brand' + (i % 7),
    category: 'vape', subcategory: '', unit: '', costPrice: 0,
  }, over || {});
}
function catalogue(n, over) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(product(i, typeof over === 'function' ? over(i) : over));
  return out;
}

/** Run the real renderResults over a catalogue and return what it painted. */
function render(products, cat, search) {
  const store = { value: search || '', innerHTML: '' };
  const ctx = vm.createContext({
    products: products, activeCat: cat || 'all', privileged: false,
    MAX_PICKER_ROWS: CAP,
    console: { log() {}, error() {} },
    $: () => store,
    ctrlHTML: pid => '<button data-add="' + pid + '">+</button>',
  });
  vm.runInContext(lifted + '\nrenderResults();', ctx);
  const html = store.innerHTML;
  return {
    html: html,
    // Not `si-row"` — a flagged row carries a second class, and matching the
    // closing quote would quietly count it as absent.
    rows: (html.match(/class="si-row[ "]/g) || []).length,
    names: (html.match(/class="si-name">([^<]*)</g) || [])
      .map(m => m.replace(/.*">/, '').replace('<', '')),
    note: (/class="si-empty">([^<]*)</.exec(html) || [])[1] || '',
  };
}

t.section('The cap is declared, and clears a whole shelf');
t.ok('MAX_PICKER_ROWS is declared in the source', CAP !== null);
// The vape catalogue is ~190 today and grows with every new flavour. A cap
// that does not clear it turns browsing into guess-the-search-term.
t.ok('it clears the current vape shelf with room to spare', CAP >= 200);

t.section('Tapping a category shows the whole category');
let r = render(catalogue(186), 'vape');
t.eq('all 186 vape products are painted', r.rows, 186);
t.eq('and nothing is described as cut off', r.note, '');
t.ok('the first product is there', r.names.indexOf('Vape product 0') !== -1);
t.ok('and so is the last — the one the old cap hid',
     r.names.indexOf('Vape product 185') !== -1);

t.section('A shelf twice this size still browses');
r = render(catalogue(400), 'vape');
t.eq('capped at the declared maximum', r.rows, CAP);
t.ok('and the cut is stated out loud', /Showing 250 of 400/.test(r.note));
t.ok('with a way forward', /type to narrow/i.test(r.note));

t.section('A category chip filters to that category');
const mixed = catalogue(60, i => ({
  category: ['vape', 'beer', 'cigarettes'][i % 3],
  productName: ['vape', 'beer', 'cigarettes'][i % 3] + ' item ' + i,
}));
t.eq('vape only', render(mixed, 'vape').rows, 20);
t.eq('beer only', render(mixed, 'beer').rows, 20);
t.eq('all shows everything', render(mixed, 'all').rows, 60);

t.section('Search narrows within the chip');
const named = [
  product(1, { productName: 'STLTH Loop 25K Pod — flavour TBC · 691584095058', subcategory: 'Loop 25K Pod' }),
  product(2, { productName: 'STLTH Loop 25K Pod — flavour TBC · 691584094853', subcategory: 'Loop 25K Pod' }),
  // Name deliberately does NOT spell out the line, so the assertion below
  // really exercises subcategory and not a second hit on the name.
  product(3, { productName: 'Elf Bar Mango Ice', subcategory: 'FS70K' }),
  product(4, { productName: 'ALLO Ultra 2500 Grape Ice', subcategory: 'Ultra 2500' }),
];
t.eq('by product line', render(named, 'vape', 'loop 25k').rows, 2);
t.eq('by flavour', render(named, 'vape', 'mango').rows, 1);
// The line lives in subcategory too, which is searched but never displayed —
// so a family is reachable even when the name does not spell it out.
t.eq('by a subcategory the row never shows', render(named, 'vape', 'fs70k').rows, 1);
t.ok('and that row really does not print the term',
     render(named, 'vape', 'fs70k').names.join(' ').toLowerCase().indexOf('fs70k') === -1);
t.eq('every term must match, not any', render(named, 'vape', 'elf grape').rows, 0);
t.eq('a barcode in the name finds one variant',
     render(named, 'vape', '691584095058').rows, 1);
t.eq('nothing matching says so', render(named, 'vape', 'zzzz').rows, 0);
t.ok('and offers a next step', /No matching products/.test(render(named, 'vape', 'zzzz').note));

t.section('A cost nobody has recorded is not reported as free');
// Cost is filled in over time; most rows sit at zero. "cost $0.00" reads as
// free rather than as not-yet-recorded.
r = render([product(1, { costPrice: 0 })], 'vape');
t.ok('no cost shown when there is none', r.html.indexOf('cost $') === -1);
t.ok('the row still renders', r.rows === 1);
r = render([product(1, { costPrice: 22.93 })], 'vape');
t.ok('a real cost is shown', /cost \$22\.93/.test(r.html));

t.section('An incomplete row is listed, not hidden');
// Hiding it is how a second copy of the same product gets created: it is not
// in the picker, so someone adds it again.
const flagged = [
  product(1, { productName: 'STLTH Loop 25K Pod — flavour TBC · 691584095058', needsDetail: true }),
  product(2, { productName: 'Elf Bar FS70K Mango Ice' }),
];
r = render(flagged, 'vape');
t.eq('both rows are painted', r.rows, 2);
t.ok('the incomplete one is marked', /class="si-flag">needs details</.test(r.html));
t.ok('and its row is styled apart', /class="si-row si-row-fix"/.test(r.html));
t.ok('the complete one is not marked',
     (r.html.match(/si-flag/g) || []).length === 1);

t.section('…but it cannot be added from the picker');
t.ok('the incomplete row offers a way to fix it', /data-fix="P1"/.test(r.html));
t.ok('and no way to add it', !/data-add="P1"/.test(r.html));
t.ok('the complete row still adds normally', /data-add="P2"/.test(r.html));
t.ok('and offers no fix button', !/data-fix="P2"/.test(r.html));

t.section('It is still findable while it waits to be fixed');
t.eq('by the barcode in its name',
     render(flagged, 'vape', '691584095058').rows, 1);
t.eq('and by its line', render(flagged, 'vape', 'loop 25k').rows, 1);

t.section('Every painted row can actually be tapped');
r = render(catalogue(186), 'vape');
t.eq('one add control per row', (r.html.match(/data-add=/g) || []).length, 186);
t.eq('one control slot per row', (r.html.match(/data-ctrl=/g) || []).length, 186);
// A flagged row still gets a control slot — it just holds Fix instead of +.
r = render(catalogue(10, i => ({ needsDetail: i % 2 === 0 })), 'vape');
t.eq('every row keeps its slot', (r.html.match(/data-ctrl=/g) || []).length, 10);
t.eq('half of them add', (r.html.match(/data-add=/g) || []).length, 5);
t.eq('half of them fix', (r.html.match(/data-fix=/g) || []).length, 5);

t.done();
