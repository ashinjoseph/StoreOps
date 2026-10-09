#!/usr/bin/env node
// ============================================================
//  llms.js — regenerate llms.txt, the docs index for language models
// ============================================================
//  Usage:   node scripts/docs/llms.js           (write the file)
//           node scripts/docs/llms.js --check   (exit 1 if it is stale)
//
//  llms.txt (https://llmstxt.org) is a plain markdown index an agent can read
//  in one request: a title, a summary, then sections of links, each with a
//  one-line description. Built from the docs themselves — the title is each
//  page's H1, the description its lead blockquote or first paragraph — so a
//  new page appears here without anyone remembering to add it. The docs-guard
//  suite runs the --check form.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'llms.txt');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const list = dir => fs.readdirSync(path.join(ROOT, dir))
  .filter(f => f.endsWith('.md') && f !== '_template.md')
  .sort()
  .map(f => path.posix.join(dir, f));

function title(p) {
  const m = /^# (.+)$/m.exec(read(p));
  return m ? m[1].trim() : path.basename(p, '.md');
}

// Lead blockquote, else the first prose paragraph, cut to one sentence.
function desc(p) {
  const blocks = read(p).replace(/```[\s\S]*?```/g, '').split(/\n\s*\n/).slice(1);
  for (const raw of blocks) {
    const b = raw.trim();
    if (!b || /^(\||!|#|<|- \*\*Status|---)/.test(b)) continue;
    let t = b.replace(/^>\s?/gm, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    const cut = t.search(/[.:;](\s|$)/);
    if (cut > 30) t = t.slice(0, cut);
    return t.length > 180 ? t.slice(0, 177).replace(/\s\S*$/, '') + '…' : t;
  }
  return '';
}

// Pages whose lead paragraph doesn't describe them well enough for an index.
const OVERRIDE = {
  'docs/reference/code-map.md': 'every server module (purpose, public API, tabs, callers, tests), every rpc* endpoint with its parameters and allowed roles, and the status vocabularies',
  'docs/reference/schema.md': 'every tab and column the code builds, and every config key with what it controls',
  'docs/guides/whatsapp-templates.md': 'the close-message template bodies, parameters and sample values to submit to Meta, and how each figure is worked out',
};
const link = (p, d) => { if (d === undefined && OVERRIDE[p]) d = OVERRIDE[p]; return link0(p, d); };
const link0 = (p, d) => '- [' + title(p) + '](' + p + ')' + ((d === undefined ? desc(p) : d) ? ': ' + (d === undefined ? desc(p) : d) : '');

function build() {
  const L = [
    '# StoreOps',
    '',
    '> Daily operations for a two-till convenience and vape store, on staff phones: till open/close, cash and card reconciliation, cash handovers, schedule, payroll, commissions, product catalogue and shopping list. Google Apps Script (V8) with a Google Sheet as the database; the browser calls server functions through google.script.run.',
    '',
    'Server code is `src/*.gs` (one module object per file, one global scope); the UI is `src/Index.html`; tests in `tests/suites/` load the real source in Node (`npm test`). Read AGENTS.md before changing code. Generated references (code map, schema) are exact; prose pages explain intent and rules.',
    '',
    '## Start here',
    '',
    link('AGENTS.md', 'how to work in this repo: layout, commands, code shape, hard rules, recipes, gotchas'),
    link('docs/README.md'),
    link('docs/context.md'),
    '',
    '## Reference (generated from the code)',
    '',
    ...list('docs/reference').map(p => link(p)),
    '',
    '## Architecture',
    '',
    ...list('docs/architecture').map(p => link(p)),
    '',
    '## Components',
    '',
    ...list('docs/components').filter(p => !/README\.md$/.test(p)).map(p => link(p)),
    '',
    '## Decisions (ADRs)',
    '',
    link('docs/adr/README.md', 'index, and when and how to write one'),
    ...list('docs/adr').filter(p => /\/\d{4}-/.test(p)).map(p => link(p, '')),
    '',
    '## Guides',
    '',
    ...list('docs/guides').map(p => link(p)),
    link('tests/suites/README.md', 'every suite and what it holds down; how to write one'),
    '',
    '## Optional',
    '',
    link('docs/showcase.md'),
    ...list('docs/plans').map(p => link(p)),
    link('CHANGELOG.md', 'every batch of work since v1, with the reasoning'),
  ];
  return L.join('\n') + '\n';
}

if (require.main === module) {
  const txt = build();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== txt) { console.error('llms.txt is stale — run npm run docs:llms'); process.exit(1); }
    console.log('llms.txt is up to date');
  } else {
    fs.writeFileSync(OUT, txt);
    console.log('wrote llms.txt');
  }
}
module.exports = { build, OUT };
