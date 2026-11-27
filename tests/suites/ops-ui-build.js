// ============================================================
//  ops-ui-build — the Worker's copy of the page
// ============================================================
//  ops/tools/build-ui.mjs makes ops/public/index.html from src/Index.html:
//  the transport script goes in, the three screens that are not moving leave
//  the More drawer, and nothing else changes. It also makes
//  ops/src/public/templates.generated.ts from src/Public.html and
//  src/PublicSales.html: each split at its one payload tag, nothing else
//  changed. These assertions build in memory and compare the result with the
//  source.
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

  // Found on the owner's first dry run (Nov 27): Git on Windows checks files out with CRLF line ends.
  t.section('A checkout with Windows line endings builds the same pages');
  const crlf = s => s.replace(/\r?\n/g, '\r\n');
  t.ok('the source here has LF only', SRC_HTML.indexOf('\r') === -1);
  t.ok('the app page is the same bytes', buildUi({ write: false, source: crlf(SRC_HTML) }) === out);
  {
    const { buildPublicTemplates } = await import(BUILD);
    const pub = name => fs.readFileSync(path.join(H.SRC, name), 'utf8');
    const fromLf = buildPublicTemplates({ write: false });
    const fromCrlf = buildPublicTemplates({ write: false, sources: { recon: crlf(pub('Public.html')), sales: crlf(pub('PublicSales.html')) } });
    t.eq('the two public templates are the same', JSON.stringify(fromCrlf), JSON.stringify(fromLf));
  }

  t.section('Deterministic');
  t.ok('building twice gives the same bytes', buildUi({ write: false }) === buildUi({ write: false }));

  // ── The two public templates (?v=recon, ?v=sales) ──────────
  // Built into ops/src/public/templates.generated.ts, a module the Worker imports (never a static
  // asset: that would be served raw, with the tag in it and no payload), each split at its one
  // payload tag. The Apps Script rule holds for the build too: one force-print tag, no other "<?".
  const { buildPublicTemplates, splitPublicTemplate, PAYLOAD_TAG } = await import(BUILD);
  const SOURCES = {
    recon: fs.readFileSync(path.join(H.SRC, 'Public.html'), 'utf8'),
    sales: fs.readFileSync(path.join(H.SRC, 'PublicSales.html'), 'utf8'),
  };
  const built = buildPublicTemplates({ write: false });
  ['recon', 'sales'].forEach(view => {
    const src = SOURCES[view];
    const tpl = built[view];
    t.section('Public template: ' + view);
    t.eq('the tag is the force-print form', PAYLOAD_TAG, '<?!= payload ?>');
    t.ok('the source has it exactly once', src.split(PAYLOAD_TAG).length === 2);
    t.ok('before + tag + after is the source, byte for byte', tpl.before + PAYLOAD_TAG + tpl.after === src);
    t.ok('no "<?" or "?>" is left in either half', [tpl.before, tpl.after].every(s => s.indexOf('<?') === -1 && s.indexOf('?>') === -1));
    t.ok('the payload is the value of var DATA', /var DATA = $/.test(tpl.before) && tpl.after.charAt(0) === ';');
    t.ok('inside the one inline script', /<script>[^<]*$/.test(tpl.before.slice(tpl.before.lastIndexOf('<script>'))) && /^[\s\S]*?<\/script>/.test(tpl.after));
    t.eq('one <script> in the page', (src.match(/<script\b/gi) || []).length, 1);
    t.ok('the module carries both halves as they are',
      built.module.indexOf(JSON.stringify(tpl.before).slice(1, -1)) !== -1 && built.module.indexOf(JSON.stringify(tpl.after).slice(1, -1)) !== -1);
    t.eq('and names its source', tpl.source, view === 'recon' ? 'src/Public.html' : 'src/PublicSales.html');

    t.section('Public template ' + view + ': the build fails loudly');
    const withSrc = s => () => buildPublicTemplates({ write: false, sources: { [view]: s } });
    t.throws('with another "<?" in a comment', withSrc(src.replace('<script>', '<script>\n// a scriptlet opens on <? even here')), '<?');
    t.throws('with the escaping form instead', withSrc(src.replace(PAYLOAD_TAG, '<?= payload ?>')), 'payload');
    t.throws('with the tag twice', withSrc(src.replace(PAYLOAD_TAG, PAYLOAD_TAG + '; var B = ' + PAYLOAD_TAG)), 'exactly one');
    t.throws('with no tag at all', withSrc(src.replace(PAYLOAD_TAG, '{}')), 'exactly one');
    t.throws('with a stray "?>"', withSrc(src.replace('</body>', '?></body>')), '?>');
    t.throws('with a script from elsewhere', withSrc(src.replace('</head>', '<script src="https://cdn.example.test/x.js"></script></head>')), 'script');
    t.throws('with a second inline script', withSrc(src.replace('</body>', '<script>var x = 1;</script></body>')), 'script');
    t.throws('with the tag outside the script', withSrc(src.replace('var DATA = ' + PAYLOAD_TAG + ';', 'var DATA = null;').replace('</body>', PAYLOAD_TAG + '</body>')), 'script');
    t.throws('with the tag not as the value of var DATA', withSrc(src.replace('var DATA = ' + PAYLOAD_TAG + ';', 'var DATA = (' + PAYLOAD_TAG + ');')), 'var DATA');
    t.throws('splitting directly works the same way', () => splitPublicTemplate('x.html', '<p><?= x ?></p>'), 'exactly one');
  });
  t.section('Public templates: deterministic');
  t.ok('building twice gives the same module', buildPublicTemplates({ write: false }).module === buildPublicTemplates({ write: false }).module);

  t.done();
})().catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
