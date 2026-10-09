// ============================================================
//  docs-guard — the docs stay in step with the code
// ============================================================
//  The docs are part of every change (docs/guides/docs-process.md). This
//  checks what a machine can: the generated schema matches what Setup.gs
//  builds, every ADR and component page is indexed, component pages have
//  their sections, relative links resolve, every image shown exists and is
//  produced by scripts/docs/screens.js, every suite is listed in the suites
//  README, and the agent-facing files (AGENTS.md, llms.txt, the generated
//  code map) are current and complete. Whether the prose is still TRUE is the reviewer's job.
// ============================================================
const fs = require('fs');
const path = require('path');
const H = require('./_lib/harness');
const t = H.suite('Docs guard — docs in step with the code');

const ROOT = path.resolve(__dirname, '..', '..');
const DOCS = path.join(ROOT, 'docs');
const read = p => fs.readFileSync(p, 'utf8');
const rel = p => path.relative(ROOT, p);

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.md')) out.push(p);
  });
  return out;
}
const pages = walk(DOCS, ['README.md', 'AGENTS.md', 'CLAUDE.md'].map(f => path.join(ROOT, f)));
const isTemplate = p => path.basename(p) === '_template.md';
// Markdown with fenced code removed, so examples in code blocks aren't links.
const prose = p => read(p).replace(/```[\s\S]*?```/g, '');
const links = p => {
  const out = [];
  const re = /!?\[[^\]]*\]\(([^)\s]+)\)/g;
  let m;
  const s = prose(p);
  while ((m = re.exec(s))) out.push({ target: m[1], image: m[0][0] === '!' });
  return out;
};

// ── 1. The schema reference is generated, and current ───────
t.section('The schema reference matches what Setup.gs builds');
{
  const S = require(path.join(ROOT, 'scripts', 'docs', 'schema.js'));
  const want = S.build();
  const have = fs.existsSync(S.OUT) ? read(S.OUT) : '';
  t.ok('docs/reference/schema.md is current (npm run docs:schema)', have === want);
}

t.section('The code map and llms.txt are generated, and current');
{
  const C = require(path.join(ROOT, 'scripts', 'docs', 'codemap.js'));
  t.ok('docs/reference/code-map.md is current (npm run docs:codemap)',
       fs.existsSync(C.OUT) && read(C.OUT) === C.build());
  const Ll = require(path.join(ROOT, 'scripts', 'docs', 'llms.js'));
  t.ok('llms.txt is current (npm run docs:llms)',
       fs.existsSync(Ll.OUT) && read(Ll.OUT) === Ll.build());
}

t.section('Every doc an agent might need is reachable from llms.txt');
{
  const idx = read(path.join(ROOT, 'llms.txt'));
  pages.filter(p => !isTemplate(p) && p !== path.join(ROOT, 'README.md') &&
                    p !== path.join(ROOT, 'CLAUDE.md') && p !== path.join(DOCS, 'components', 'README.md'))
    .forEach(p => t.ok('listed: ' + rel(p), idx.indexOf('(' + rel(p).split(path.sep).join('/') + ')') !== -1));
  const dead = [];
  const re = /\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(idx))) if (!/^https?:/.test(m[1]) && !fs.existsSync(path.join(ROOT, m[1]))) dead.push(m[1]);
  t.eq('no dead links in llms.txt', dead.join(', '), '');
  t.ok('CLAUDE.md imports AGENTS.md, so the two cannot diverge',
       /^@AGENTS\.md$/m.test(read(path.join(ROOT, 'CLAUDE.md'))));
}

// ── 2. ADRs are all indexed ─────────────────────────────────
t.section('Every ADR is in the index, and the index has no dead rows');
{
  const dir = path.join(DOCS, 'adr');
  const index = read(path.join(dir, 'README.md'));
  const files = fs.readdirSync(dir).filter(f => /^\d{4}-.*\.md$/.test(f));
  t.ok('there are ADRs', files.length > 0);
  files.forEach(f => t.ok('indexed: ' + f, index.indexOf('(' + f + ')') !== -1));
  const listed = (index.match(/\((\d{4}-[^)]+\.md)\)/g) || []).map(s => s.slice(1, -1));
  listed.forEach(f => t.ok('exists: ' + f, files.indexOf(f) !== -1));
  const nums = files.map(f => f.slice(0, 4));
  t.eq('numbers are unique', nums.length, new Set(nums).size);
  files.forEach(f => t.ok('has a status: ' + f, /\*\*Status:\*\*/.test(read(path.join(dir, f)))));
}

// ── 3. Component pages are indexed and complete ─────────────
t.section('Every component page is indexed and has its sections');
{
  const dir = path.join(DOCS, 'components');
  const index = read(path.join(dir, 'README.md'));
  const SECTIONS = ['## What it does', '## How it works', '## Rules it must not break',
                    '## Code map', '## Tests'];
  fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md' && f !== '_template.md')
    .forEach(f => {
      t.ok('indexed: ' + f, index.indexOf('(' + f + ')') !== -1);
      const s = read(path.join(dir, f));
      const missing = SECTIONS.filter(h => s.indexOf(h) === -1);
      t.eq('sections: ' + f, missing.join(', '), '');
      t.ok('has a diagram or picture: ' + f, /```mermaid|!\[/.test(s));
    });
}

// ── 4. Relative links resolve ───────────────────────────────
t.section('Every relative link in the docs resolves');
{
  const dead = [];
  pages.filter(p => !isTemplate(p)).forEach(p => {
    links(p).forEach(l => {
      if (/^(https?:|mailto:|#)/.test(l.target)) return;
      const file = l.target.split('#')[0];
      if (!file) return;
      if (!fs.existsSync(path.resolve(path.dirname(p), file))) dead.push(rel(p) + ' → ' + l.target);
    });
  });
  t.eq('dead links', dead.join('\n'), '');
}

// ── 5. Images are real screenshots of the real app ──────────
t.section('Images exist, and come from scripts/docs/screens.js');
{
  const screens = require(path.join(ROOT, 'scripts', 'docs', 'screens.js'));
  const produced = new Set();
  screens.forEach(s => { produced.add(s.name + '.png'); (s.also || []).forEach(a => produced.add(a + '.png')); });
  const imgDir = path.join(DOCS, 'images');
  const onDisk = fs.readdirSync(imgDir).filter(f => /\.(png|jpe?g|gif|svg)$/.test(f));
  onDisk.forEach(f => t.ok('produced by screens.js: ' + f, produced.has(f)));
  produced.forEach(f => t.ok('captured: ' + f, onDisk.indexOf(f) !== -1));

  const shown = new Set();
  pages.filter(p => !isTemplate(p)).forEach(p => links(p).forEach(l => {
    if (/\.(png|jpe?g|gif|svg)$/.test(l.target) && !/^https?:/.test(l.target)) {
      shown.add(path.basename(l.target));
      if (l.image) t.ok('has alt text: ' + rel(p) + ' ' + path.basename(l.target),
        !new RegExp('!\\[\\]\\(' + l.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)').test(prose(p)));
    }
  }));
  onDisk.forEach(f => t.ok('used by a doc: ' + f, shown.has(f)));
}

// ── 6. Every suite is described ─────────────────────────────
t.section('Every suite is listed in tests/suites/README.md');
{
  const dir = path.join(ROOT, 'tests', 'suites');
  const readme = read(path.join(dir, 'README.md'));
  fs.readdirSync(dir).filter(f => f.endsWith('.js') && f !== 'run.js')
    .forEach(f => t.ok(f, readme.indexOf('`' + f.replace(/\.js$/, '') + '`') !== -1));
}

t.done();
