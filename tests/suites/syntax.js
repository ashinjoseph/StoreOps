// ============================================================
//  syntax — every file Apps Script will parse, parsed here first
// ============================================================
//  Apps Script reports a parse error in a .gs file, or in a page's inline
//  script, as a runtime failure blamed on whatever line happened to call into
//  it. This compiles each .gs file and each inline <script> (scriptlets
//  replaced by a literal, as the template engine would leave a value) so the
//  failure is named by file before anything is pushed.
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./_lib/harness');
const t = H.suite('Syntax gate — what Apps Script will parse');

const SRC = path.resolve(__dirname, '..', '..', 'src');
const files = fs.readdirSync(SRC).filter(f => /\.(gs|html)$/.test(f)).sort();

t.section('Server files compile');
files.filter(f => f.endsWith('.gs')).forEach(f => {
  let err = null;
  try { new vm.Script(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f }); }
  catch (e) { err = e.message; }
  t.eq(f, err, null);
});

t.section('Inline page scripts compile');
files.filter(f => f.endsWith('.html')).forEach(f => {
  const html = fs.readFileSync(path.join(SRC, f), 'utf8');
  const re = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, n = 0, err = null;
  while ((m = re.exec(html))) {
    n++;
    try { new vm.Script(m[1].replace(/<\?[\s\S]*?\?>/g, 'null'), { filename: f + '#' + n }); }
    catch (e) { err = (err ? err + '; ' : '') + '#' + n + ' ' + e.message; }
  }
  t.eq(f + ' (' + n + ' script' + (n === 1 ? '' : 's') + ')', err, null);
});

t.done();
