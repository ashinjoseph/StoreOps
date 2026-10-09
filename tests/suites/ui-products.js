// ============================================================
//  ui-products — the Product Master list
// ============================================================
//  Cost is filled in over time, so most new products sit at cost 0. The
//  list printed that as "cost $0.00 · margin 100.0%" — free stock with a
//  perfect margin — and the margin sort put every one of them at the top.
//  The picker already says nothing rather than $0.00 (ui-picker); this is
//  the same rule on the screen people price from.
// ============================================================
const vm = require('vm');
const H = require('./_lib/harness');
const t = H.suite('Product Master — the list');

const js = H.clientScript('Index.html');
const sortsSrc = /const PM_SORTS = \{[\s\S]*?\n  \};/.exec(js)[0];
const lifted = ['esc', 'money', 'moreBack', 'pmDistinct', 'pmMarginKey_',
                'pmDefaultFilter', 'renderProductsTab']
  .map(n => H.fnSource(js, n)).join('\n\n') + '\n' + sortsSrc;

function render(products, sort) {
  const el = () => ({ innerHTML: '', querySelectorAll: () => [], focus() {} });
  const view = el();
  const ctx = {
    console: { log() {}, error() {}, warn() {} },
    state: { products, me: { role: 'admin' },
             productsFilter: { query: '', category: '', brand: '', supplier: '', sort: sort || 'name_asc' } },
    document: { activeElement: null },
    $: id => id === 'view-products' ? view : null,
    openProductForm() {}, deactivateProduct() {}, switchTab() {},
    PRODUCT_CATEGORIES_UI: ['vape', 'cigarettes', 'beer', 'grocery', 'other'],
  };
  vm.createContext(ctx);
  vm.runInContext(lifted + '\nrenderProductsTab();', ctx);
  return view.innerHTML;
}
const P = (id, name, cost, sell) => ({
  productId: id, productName: name, category: 'vape', brand: 'Nimbus', sku: id,
  costPrice: cost, sellPrice: sell, active: true,
  marginPct: sell > 0 ? (sell - cost) / sell : 0,
});
const order = html => (html.match(/payroll-name"[^>]*>([^<]+)/g) || [])
  .map(s => s.replace(/.*>/, ''));

t.section('A product with no cost is not shown as free');
let html = render([P('A', 'Uncosted', 0, 27.5)]);
t.ok('it says the cost is missing', /no cost recorded/.test(html));
t.ok('no "cost $0.00"', html.indexOf('cost $0.00') === -1);
t.ok('no 100% margin', html.indexOf('100.0%') === -1);

t.section('A costed product still shows both');
html = render([P('B', 'Costed', 21.4, 34.99)]);
t.ok('its cost', /cost \$21\.40/.test(html));
t.ok('and its margin', /margin 38\.8%/.test(html));

t.section('Sorting by margin ranks what can be ranked');
html = render([P('A', 'Uncosted', 0, 27.5), P('B', 'Thin', 30, 34.99), P('C', 'Fat', 10, 34.99)],
              'margin_desc');
t.eq('highest real margin first, uncosted last', order(html).join(','), 'Fat,Thin,Uncosted');

t.done();
