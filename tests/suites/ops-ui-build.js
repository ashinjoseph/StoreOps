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
  t.eq('three lines are gone', a.length - b.length, 3);
  const removed = [];
  let j = 0;
  a.forEach(line => { if (b[j] === line) j++; else removed.push(line); });
  t.eq('the scripts match once those lines are removed', j, b.length);
  t.eq('the removed lines are the three entries', removed.map(tabOfLine), GONE);

  t.section('The build fails loudly');
  for (const tab of GONE) {
    const mutated = SRC_HTML.split('\n').filter(l => tabOfLine(l) !== tab).join('\n');
    t.throws('without the ' + tab + ' entry', () => buildUi({ write: false, source: mutated }), tab);
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
