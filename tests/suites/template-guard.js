// ============================================================
//  template-guard — the Apps Script templating contract
// ============================================================
//  Apps Script's HTML templating is a TEXT preprocessor. It scans the file
//  for <? … ?> before any JavaScript parser sees it, so it cannot tell a
//  scriptlet from the same characters inside a string, a regex or a comment,
//  and it cannot tell a bound variable from a misspelled one — an unbound
//  name prints as nothing and leaves `var DATA = ;`, which is a syntax error
//  that blanks the whole page with no server-side trace.
//
//  None of that is reachable from a unit test: it happens inside Google's
//  renderer, in production, on a page nobody is logged in to. So this suite
//  reads the files as the preprocessor does — as text — and pins the
//  invariants that keep a template renderable.
// ============================================================
const fs = require('fs');
const path = require('path');
const H = require('./_lib/harness');
const t = H.suite('HTML template preprocessing');

const webapp = H.read('WebApp.gs');

// ── What the server serves, and how ─────────────────────────
function servedAs(re) {
  const out = [];
  let m;
  const rx = new RegExp(re.source, 'g');
  while ((m = rx.exec(webapp))) if (out.indexOf(m[1]) === -1) out.push(m[1]);
  return out;
}
const templates = servedAs(/createTemplateFromFile\('([^']+)'\)/);
const plainFiles = servedAs(/createHtmlOutputFromFile\('([^']+)'\)/);

t.section('Every file the server names is actually there');
t.ok('at least one template is served', templates.length > 0);
templates.concat(plainFiles).forEach(name => {
  t.ok(name + '.html exists', fs.existsSync(path.join(H.SRC, name + '.html')));
});

t.section('A file is served one way or the other, never both');
// Preprocessing is decided by the call, not the file. The same file served
// both ways would have its scriptlets evaluated down one route and shipped
// to the browser verbatim down the other.
plainFiles.forEach(name => {
  t.ok(name + ' is not also a template', templates.indexOf(name) === -1);
});

// ── Scriptlet syntax, read as text ──────────────────────────
// Returns every <? … ?> in the file plus anything that looks like a broken
// one. The preprocessor is not forgiving: an unclosed <? swallows the rest
// of the file.
function scriptlets(src) {
  const found = [];
  const problems = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('<?', i);
    if (open === -1) break;
    const close = src.indexOf('?>', open);
    if (close === -1) { problems.push('unclosed <? at offset ' + open); break; }
    const body = src.slice(open + 2, close);
    if (body.indexOf('<?') !== -1) problems.push('nested <? at offset ' + open);
    found.push({ open: open, close: close, body: body, raw: src.slice(open, close + 2) });
    i = close + 2;
  }
  // Any ?> the walk above did not consume is a closer with no opener — in a
  // template that is a literal ?> shipped into the page.
  let j = 0, stray = 0;
  while ((j = src.indexOf('?>', j)) !== -1) {
    if (!found.some(s => s.close === j)) stray++;
    j += 2;
  }
  if (stray) problems.push(stray + ' stray ?>');
  return { found: found, problems: problems };
}

templates.forEach(name => {
  const src = H.read(name + '.html');
  const s = scriptlets(src);
  t.section(name + '.html — scriptlets');
  t.eq('no malformed scriptlets', s.problems, []);
  t.ok('has at least one scriptlet', s.found.length > 0);

  s.found.forEach(sc => {
    const printed = /^!?=/.test(sc.body);
    const label = sc.raw.length > 40 ? sc.raw.slice(0, 37) + '…' : sc.raw;
    // A printing scriptlet in these pages carries JSON into a <script> block.
    // <?= escapes for HTML, which turns every quote into &quot; and makes the
    // assignment unparseable; only <?!= ships the JSON intact.
    if (printed) {
      t.ok(label + ' force-prints, not HTML-escapes', sc.body.indexOf('!=') === 0);
    }
    t.ok(label + ' is not wrapped in quotes',
         !(src[sc.open - 1] === '"' || src[sc.open - 1] === "'"));
  });
});

// ── Bindings: what the template prints, the server must set ─
// Every template is evaluated right after its fields are assigned, so both
// halves live in one function. Lift that window and compare the two lists.
function bindingsFor(name) {
  const at = webapp.indexOf("createTemplateFromFile('" + name + "')");
  if (at === -1) return null;
  // The call is usually reached through a namespace (`HtmlService.`), so allow
  // anything dotted between the `=` and the call itself.
  const varName = (/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[\w$.]*$/
    .exec(webapp.slice(0, at).split('\n').pop()) || [])[1];
  if (!varName) return null;
  const after = webapp.slice(at);
  const end = after.indexOf(varName + '.evaluate()');
  const window = end === -1 ? after : after.slice(0, end);
  const set = [];
  const rx = new RegExp('\\b' + varName + '\\.([A-Za-z_$][\\w$]*)\\s*=', 'g');
  let m;
  while ((m = rx.exec(window))) if (set.indexOf(m[1]) === -1) set.push(m[1]);
  return { varName: varName, assigned: set };
}

templates.forEach(name => {
  const src = H.read(name + '.html');
  const b = bindingsFor(name);
  t.section(name + '.html — bindings');
  t.ok('the server binds fields before evaluate()', !!b && b.assigned.length > 0);
  if (!b) return;

  // Names the template reads out of the template scope. Anything else in a
  // scriptlet is a global or a literal, not a binding.
  const printedNames = [];
  scriptlets(src).found.forEach(sc => {
    const expr = sc.body.replace(/^!?=/, '').trim();
    const id = /^([A-Za-z_$][\w$]*)\b/.exec(expr);
    if (id && printedNames.indexOf(id[1]) === -1) printedNames.push(id[1]);
  });

  printedNames.forEach(n => {
    // An unbound name is not an error at render time — it prints as nothing.
    // That is exactly why it has to be caught here.
    t.ok('<?!= ' + n + ' ?> is bound by the server', b.assigned.indexOf(n) !== -1);
  });
  b.assigned.forEach(n => {
    // The other direction: a binding nothing reads means the placeholder was
    // renamed and the page is now rendering a hole.
    t.ok(b.varName + '.' + n + ' is read by the template', printedNames.indexOf(n) !== -1);
  });
});

// ── Files served without preprocessing ──────────────────────
t.section('Plain-served files carry no scriptlet delimiters');
// createHtmlOutputFromFile does no preprocessing, so a <? here is not a
// scriptlet — it ships to the browser as text. And if the file is ever
// promoted to a template, every one of them starts being evaluated.
plainFiles.forEach(name => {
  const src = H.read(name + '.html');
  t.eq(name + '.html has no <?', (src.match(/<\?/g) || []).length, 0);
  t.eq(name + '.html has no ?>', (src.match(/\?>/g) || []).length, 0);
});

t.section('The printed payload lands in parseable JavaScript');
templates.forEach(name => {
  const src = H.read(name + '.html');
  scriptlets(src).found.filter(sc => /^!?=/.test(sc.body)).forEach(sc => {
    const line = src.slice(0, sc.open).split('\n').pop() +
                 src.slice(sc.close + 2).split('\n')[0];
    // `var DATA = <?!= payload ?>` with no terminator is the failure mode an
    // unbound name turns into — keep the statement closed either way.
    t.ok(name + ': ' + sc.raw.slice(0, 20) + '… sits in a terminated statement',
         /;\s*$/.test(line.trim()) || /^\s*[<]/.test(line));
  });
});

t.done();
