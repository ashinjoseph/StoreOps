#!/usr/bin/env node
// ============================================================
//  schema.js — regenerate docs/reference/schema.md from the code
// ============================================================
//  Usage:   node scripts/docs/schema.js           (write the file)
//           node scripts/docs/schema.js --check   (exit 1 if it is stale)
//
//  Boots the real server (runtime.js), which runs firstTimeSetup and every
//  migration, then lists each sheet's header row and every config key with
//  its description. Nothing here is typed by hand, so the reference cannot
//  drift from what Setup.gs actually builds. The docs-guard suite runs the
//  --check form.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('./runtime');

const OUT = path.resolve(__dirname, '..', '..', 'docs', 'reference', 'schema.md');

function build() {
  const { ss } = R.boot();
  const sheets = ss.getSheets();
  const lines = [
    '# Schema reference',
    '',
    '> **Generated** by `npm run docs:schema` from what `firstTimeSetup` and the',
    '> migrations in `src/Setup.gs` actually build. Do not edit by hand — change',
    '> the code and regenerate. The docs-guard suite fails when this file is stale.',
    '',
    'Row 1 of every tab is a title banner, row 2 is the header, data starts at row 3.',
    'Tabs starting with `_` are import staging areas, not data.',
    'For what the tables mean and how they relate, see',
    '[architecture/data-model.md](../architecture/data-model.md).',
    '',
    '| Tab | Columns | Purpose |',
    '|---|---:|---|',
  ];
  const title = s => String(s.getRange(1, 1, 1, 1).getValues()[0][0] || '')
    .replace(/^[^\w]+/u, '').trim();
  sheets.forEach(s => {
    lines.push('| [`' + s.getName() + '`](#' + s.getName() + ') | ' +
      s.getLastColumn() + ' | ' + title(s).replace(/\|/g, '\\|') + ' |');
  });
  sheets.filter(s => s.getName() !== 'config').forEach(s => {
    const headers = s.getRange(2, 1, 1, s.getLastColumn()).getValues()[0];
    lines.push('', '## ' + s.getName(), '', '_' + title(s) + '_', '',
      '| # | Column |', '|---:|---|');
    headers.forEach((h, i) => lines.push('| ' + (i + 1) + ' | `' + h + '` |'));
  });

  const cfg = ss.getSheetByName('config');
  const rows = cfg.getRange(3, 1, cfg.getLastRow() - 2, 3).getValues()
    .filter(r => r[0]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  lines.push('', '## config', '',
    'Key/value tab read by every module (cached for 5 minutes). Values are',
    'deliberately not listed — they are per-install and some are secrets.', '',
    '| Key | What it controls |', '|---|---|');
  rows.forEach(r => lines.push('| `' + r[0] + '` | ' +
    String(r[2] || '').replace(/\|/g, '\\|').replace(/\n/g, ' ') + ' |'));
  return lines.join('\n') + '\n';
}

if (require.main === module) {
  const md = build();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== md) { console.error('docs/reference/schema.md is stale — run npm run docs:schema'); process.exit(1); }
    console.log('schema.md is up to date');
  } else {
    fs.writeFileSync(OUT, md);
    console.log('wrote ' + path.relative(process.cwd(), OUT));
  }
}
module.exports = { build, OUT };
