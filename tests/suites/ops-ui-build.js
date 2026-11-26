// ============================================================
//  ops-ui-build — the Worker's copy of the page
// ============================================================
//  ops/tools/build-ui.mjs makes ops/public/index.html from src/Index.html:
//  the transport script goes in, the three screens that are not moving leave
//  the More drawer, and nothing else changes. These assertions build in
//  memory and compare the result with the source.
// ============================================================
const fs = require('fs');
const path = require('path');
const H = require('./_lib/harness');
const t = H.suite('Operations UI build — same page, new transport');

const BUILD = path.join(H.REPO, 'ops', 'tools', 'build-ui.mjs');
const SRC_HTML = fs.readFileSync(path.join(H.SRC, 'Index.html'), 'utf8');
const GONE = ['shopping', 'suppliers', 'products'];

const scriptOf = html => /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/.exec(html)[1];
const tabsOf = js => {
  const m = /const MORE_ITEMS = \[([\s\S]*?)\n  \];/.exec(js);
  return (m[1].match(/\{ tab: '([a-z]+)'/g) || []).map(s => /'([a-z]+)'/.exec(s)[1]);
};
const tabOfLine = l => { const m = /\{ tab: '([a-z]+)'/.exec(l); return m && m[1]; };
// A line of the warm-up list after sign-in: ['rpcName', [state.token, ...], TTL_X],  or jobs.push([...]).
const warmOfLine = l => { const m = /^\s*(?:jobs\.push\()?\['(rpc[A-Za-z]+)',\s*\[state\.token/.exec(l); return m && m[1]; };
const warmOf = js => js.split('\n').map(warmOfLine).filter(Boolean);

(async () => {
  const { buildUi } = await import(BUILD);
  const out = buildUi({ write: false });

  t.section('Output');
  t.ok('no template tag remains', out.indexOf('<?') === -1);
  const tAt = out.indexOf('<script src="/transport.js"></script>');
  const pageAt = out.search(/<script(?![^>]*src=)[^>]*>/);
  t.ok('loads /transport.js', tAt !== -1);
  t.ok('transport loads before the page script', tAt !== -1 && tAt < pageAt);

  t.section('The More drawer');
  const before = tabsOf(scriptOf(SRC_HTML));
  const after = tabsOf(scriptOf(out));
  t.ok('source has the three entries', GONE.every(g => before.indexOf(g) !== -1));
  t.ok('built page has none of them', GONE.every(g => after.indexOf(g) === -1));
  t.eq('every other entry survives, in order', after, before.filter(x => GONE.indexOf(x) === -1));

  t.section('Nothing else in the script changes');
  const a = scriptOf(SRC_HTML).split('\n');
  const b = scriptOf(out).split('\n');
  t.eq('five lines are gone', a.length - b.length, 5);
  const removed = [];
  let j = 0;
  a.forEach(line => { if (b[j] === line) j++; else removed.push(line); });
  t.eq('the scripts match once those lines are removed', j, b.length);
  t.eq('the removed lines are the two warm-up calls and the three entries',
    removed.map(l => tabOfLine(l) || warmOfLine(l)), ['rpcGetShoppingList', 'rpcGetSuppliers'].concat(GONE));

  // Found by loading the built page in a browser (Nov 26): after sign-in the page warms its cache
  // with a list of reads, and two of them belong to screens that are not moving. Each answered
  // 404 NOT_MIGRATED on every load.
  t.section('The warm-up after sign-in asks only for what the new app has');
  const contract = JSON.parse(fs.readFileSync(path.join(H.REPO, 'ops', 'contracts', 'rpc.json'), 'utf8'));
  const migrated = {};
  contract.rpcs.forEach(r => { migrated[r.name] = r.migrate === true; });
  const warmBefore = warmOf(scriptOf(SRC_HTML));
  const warmAfter = warmOf(scriptOf(out));
  t.ok('the source warms the two deprecated reads', ['rpcGetShoppingList', 'rpcGetSuppliers'].every(n => warmBefore.indexOf(n) !== -1));
  t.ok('the warm-up list was found (at least ten reads)', warmAfter.length >= 10);
  t.eq('every read the built page warms is one the new app migrates', warmAfter.filter(n => migrated[n] !== true), []);
  t.eq('every other warm-up read survives, in order', warmAfter, warmBefore.filter(n => migrated[n] === true));

  t.section('The build fails loudly');
  for (const tab of GONE) {
    const mutated = SRC_HTML.split('\n').filter(l => tabOfLine(l) !== tab).join('\n');
    t.throws('without the ' + tab + ' entry', () => buildUi({ write: false, source: mutated }), tab);
  }
  for (const name of ['rpcGetShoppingList', 'rpcGetSuppliers']) {
    const mutated = SRC_HTML.split('\n').filter(l => warmOfLine(l) !== name).join('\n');
    t.throws('without the ' + name + ' warm-up line', () => buildUi({ write: false, source: mutated }), name);
  }
  t.throws('with a duplicated entry',
    () => buildUi({ write: false, source: SRC_HTML.replace(/(\n    \{ tab: 'products'[^\n]*)/, '$1$1') }), 'products');
  t.throws('when a template tag would remain (in a comment)',
    () => buildUi({ write: false, source: SRC_HTML.replace('<script>', '<script>\n// <?= x ?>') }), '<?');
  t.throws('when a template tag would remain (in markup)',
    () => buildUi({ write: false, source: SRC_HTML.replace('</body>', '<?!= x ?></body>') }), '<?');

  t.section('Deterministic');
  t.ok('building twice gives the same bytes', buildUi({ write: false }) === buildUi({ write: false }));

  t.done();
})().catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
