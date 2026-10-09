#!/usr/bin/env node
// ============================================================
//  mermaid.js — render every mermaid block in the docs, fail on any error
// ============================================================
//  Usage:   node scripts/docs/mermaid.js
//           MERMAID_JS=/path/to/mermaid.min.js node scripts/docs/mermaid.js
//
//  GitHub renders mermaid fences itself and shows a parse error in place of
//  a diagram that does not parse — so a broken diagram is only noticed by
//  whoever opens the page. This renders each block in Chromium with the real
//  mermaid library and reports file:line for every one that fails.
//
//  Needs Playwright (as screenshots.js) and mermaid:
//    npm i --no-save mermaid@11      or set MERMAID_JS
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* fall through */ }
  return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
}
function mermaidPath() {
  if (process.env.MERMAID_JS) return process.env.MERMAID_JS;
  try { return require.resolve('mermaid/dist/mermaid.min.js', { paths: [ROOT] }); }
  catch (e) {
    console.error('mermaid not found — npm i --no-save mermaid@11, or set MERMAID_JS');
    process.exit(2);
  }
}

function markdownFiles() {
  const out = [path.join(ROOT, 'README.md')];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    });
  })(path.join(ROOT, 'docs'));
  return out;
}

function blocks(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '```mermaid') continue;
    const start = i + 1;
    let j = start;
    while (j < lines.length && lines[j].trim() !== '```') j++;
    found.push({ file: path.relative(ROOT, file), line: start, code: lines.slice(start, j).join('\n') });
    i = j;
  }
  return found;
}

(async () => {
  const all = markdownFiles().flatMap(blocks);
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><body></body>');
  await page.addScriptTag({ path: mermaidPath() });
  await page.evaluate(() => mermaid.initialize({ startOnLoad: false }));
  let bad = 0;
  for (let i = 0; i < all.length; i++) {
    const b = all[i];
    const err = await page.evaluate(async ({ code, id }) => {
      try { await mermaid.render(id, code); return null; }
      catch (e) { return String(e && e.message || e).split('\n').slice(0, 4).join(' '); }
    }, { code: b.code, id: 'd' + i });
    if (err) { bad++; console.log('✗ ' + b.file + ':' + b.line + '  ' + err); }
  }
  await browser.close();
  console.log((bad ? '❌ ' : '✅ ') + (all.length - bad) + ' of ' + all.length + ' diagrams render');
  process.exit(bad ? 1 : 0);
})();
