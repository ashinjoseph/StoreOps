#!/usr/bin/env node
// ============================================================
//  codemap.js — regenerate docs/reference/code-map.md from the source
// ============================================================
//  Usage:   node scripts/docs/codemap.js           (write the file)
//           node scripts/docs/codemap.js --check   (exit 1 if it is stale)
//
//  The map an agent (or a new developer) needs before touching anything:
//  every module's purpose, public API, the tabs it touches, what it calls and
//  which suites load it; every rpc* endpoint with its parameters and the roles
//  its Auth.require admits; and the shared vocabulary (status enums, roles).
//
//  Purpose lines come from each file's header comment, the API from the
//  module object the real code builds (booted by runtime.js), roles from the
//  Auth.require call in each RPC body. Nothing is typed by hand, so it can't
//  drift; the docs-guard suite runs the --check form.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('./runtime');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const SUITES = path.join(ROOT, 'tests', 'suites');
const OUT = path.join(ROOT, 'docs', 'reference', 'code-map.md');

const read = f => fs.readFileSync(f, 'utf8');
const gsFiles = fs.readdirSync(SRC).filter(f => f.endsWith('.gs')).sort();
const htmlFiles = fs.readdirSync(SRC).filter(f => f.endsWith('.html')).sort();
const modNames = gsFiles.map(f => f.replace(/\.gs$/, ''));

// The body of `function name(...) {...}`, by brace matching.
function body(src, start) {
  let depth = 0, seen = false;
  for (let j = start; j < src.length; j++) {
    if (src[j] === '{') { depth++; seen = true; }
    else if (src[j] === '}') { depth--; if (seen && depth === 0) return src.slice(start, j + 1); }
  }
  return src.slice(start);
}

// "//  Sales.gs — sales rows (one per till_session)" → "sales rows (one per till_session)"
function purpose(src, file) {
  const m = new RegExp('^//\\s+' + file.replace('.', '\\.') + '\\s+[—-]+\\s+(.+)$', 'm').exec(src);
  return m ? m[1].trim() : '';
}

function suitesLoading(file) {
  return fs.readdirSync(SUITES).filter(f => f.endsWith('.js') && f !== 'run.js')
    .filter(f => read(path.join(SUITES, f)).indexOf("'" + file + "'") !== -1)
    .map(f => f.replace(/\.js$/, '')).sort();
}

const esc = s => String(s).replace(/\|/g, '\\|');

function build() {
  const { api } = R.boot();
  const L = [
    '# Code map',
    '',
    '> **Generated** by `npm run docs:codemap` from `src/`. Do not edit by hand.',
    '> The docs-guard suite fails when this file is stale.',
    '',
    'Where everything is, for people and for coding agents. Purpose lines come from',
    'each file\'s header comment, the API from the module object the code actually',
    'builds, and RPC roles from the `Auth.require` call in each endpoint. For *why*',
    'things are the way they are, see the [ADRs](../adr/README.md); for what each',
    'feature does, the [component pages](../components/README.md).',
    '',
    '## Contents',
    '',
    '- [Server modules](#server-modules)',
    '- [RPC endpoints](#rpc-endpoints)',
    '- [Pages](#pages)',
    '- [Vocabulary](#vocabulary)',
    '',
    '## Server modules',
    '',
    'Each `.gs` file defines one module object (an IIFE) with the same name as the',
    'file, except `WebApp.gs` and `Setup.gs`, which define top-level functions.',
    'Apps Script loads every file into one global scope.',
    '',
    '| Module | Lines | Purpose | Tabs (`SHEETS.*`) | Calls | Loaded by suites |',
    '|---|---:|---|---|---|---|',
  ];

  const details = [];
  gsFiles.forEach(f => {
    const name = f.replace(/\.gs$/, '');
    const src = read(path.join(SRC, f));
    const lines = src.split('\n').length;
    const tabs = Array.from(new Set((src.match(/SHEETS\.([A-Z_]+)/g) || [])
      .map(s => api.SHEETS[s.slice(7)] || s.slice(7).toLowerCase()))).sort();
    const calls = modNames.filter(o => o !== name && o !== 'Util' && o !== 'AuditLog' &&
      new RegExp('\\b' + o + '\\.[a-zA-Z]').test(src));
    const suites = suitesLoading(f);
    L.push('| [`' + name + '`](#' + name.toLowerCase() + ') | ' + lines + ' | ' +
      esc(purpose(src, f)) + ' | ' + (tabs.map(t => '`' + t + '`').join(', ') || '—') +
      ' | ' + (calls.join(', ') || '—') + ' | ' + (suites.join(', ') || '**none**') + ' |');

    const mod = api[name];
    let exported;
    if (mod && typeof mod === 'object') {
      exported = Object.keys(mod).map(k => {
        const v = mod[k];
        if (typeof v === 'function') {
          const sig = /\(([^)]*)\)/.exec(v.toString());
          return '`' + k + '(' + (sig ? sig[1].replace(/\s+/g, ' ').trim() : '') + ')`';
        }
        return '`' + k + '`';
      });
    } else {
      const re = /^function ([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm;
      exported = [];
      let m;
      while ((m = re.exec(src))) {
        if (name === 'WebApp' && /^rpc/.test(m[1])) continue;   // listed under RPCs
        exported.push('`' + m[1] + '(' + m[2].replace(/\s+/g, ' ').trim() + ')`');
      }
    }
    details.push('### ' + name, '', '`src/' + f + '` · ' + esc(purpose(src, f)), '',
      exported.length ? exported.join(' · ') : '_no public API_', '');
  });

  // ── RPCs ──────────────────────────────────────────────────
  const web = read(path.join(SRC, 'WebApp.gs'));
  const re = /^function (rpc[A-Za-z0-9_]*)\s*\(([^)]*)\)/gm;
  const rpcs = [];
  let m;
  // An RPC that hands off to a private helper (`return _rpcX(token)`) is
  // guarded inside the helper, so read one level of helpers too.
  const helper = name => {
    const i = web.search(new RegExp('^function ' + name.replace('$', '\\$') + '\\s*\\(', 'm'));
    return i === -1 ? '' : body(web, i);
  };
  while ((m = re.exec(web))) {
    let b = body(web, m.index);
    (b.match(/\b_[A-Za-z]\w*(?=\()/g) || []).forEach(h => { if (h !== '_session') b += helper(h); });
    const req = /Auth\.require\(session,\s*\[([^\]]*)\]/.exec(b);
    let who;
    if (req) who = req[1].replace(/['"\s]/g, '').split(',').join(', ');
    else if (/_session\(|Auth\.validate\(/.test(b)) who = 'any signed-in';
    else who = '**no session check**';
    const calls = modNames.filter(o => o !== 'Util' && o !== 'WebApp' &&
      new RegExp('\\b' + o + '\\.[a-zA-Z]').test(b) && o !== 'Auth');
    rpcs.push({ name: m[1], params: m[2].replace(/\s+/g, ' ').trim(), who, calls });
  }
  L.push('', '## RPC endpoints', '',
    'Called from the browser as `google.script.run.<name>(...)` (wrapped by `call` /',
    '`cachedCall` in `Index.html`). Every endpoint takes the session token first and',
    'reads identity and role from the server session, never from its arguments.',
    'Roles: `admin`, `manager`, `payroll_admin`, `employee`.', '',
    '| RPC | Parameters | Allowed | Calls |', '|---|---|---|---|');
  rpcs.forEach(r => L.push('| `' + r.name + '` | `' + esc(r.params) + '` | ' + r.who + ' | ' +
    (r.calls.join(', ') || '—') + ' |'));
  L.push('', rpcs.length + ' endpoints.', '');

  // ── Pages ─────────────────────────────────────────────────
  L.push('## Pages', '', '| File | Lines | Served by | Client functions |', '|---|---:|---|---:|');
  const served = { 'Index.html': '`doGet` (no `?v`)', 'Public.html': '`doGet` `?v=recon`',
                   'PublicSales.html': '`doGet` `?v=sales`' };
  htmlFiles.forEach(f => {
    const src = read(path.join(SRC, f));
    const fns = (src.match(/^\s*(?:async\s+)?function [A-Za-z_$][\w$]*\s*\(/gm) || []).length;
    L.push('| `src/' + f + '` | ' + src.split('\n').length + ' | ' + (served[f] || '—') + ' | ' + fns + ' |');
  });
  L.push('');

  // ── Vocabulary ────────────────────────────────────────────
  L.push('## Vocabulary', '',
    'Constants defined in `Setup.gs` and used across modules. A status written to a',
    'sheet must be one of these.', '', '| Constant | Values |', '|---|---|');
  Object.keys(api).filter(k => /^[A-Z][A-Z_]+$/.test(k) && k !== 'SHEETS' && k !== 'COLORS')
    .sort().forEach(k => {
      const v = api[k];
      const vals = Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : [v]);
      L.push('| `' + k + '` | ' + vals.map(x => '`' + x + '`').join(', ') + ' |');
    });
  L.push('', 'Tab names are `SHEETS.*`; their columns are in the [schema reference](schema.md).', '');

  L.push('## Module APIs', '', ...details);
  return L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
}

if (require.main === module) {
  const md = build();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? read(OUT) : '';
    if (cur !== md) { console.error('docs/reference/code-map.md is stale — run npm run docs:codemap'); process.exit(1); }
    console.log('code-map.md is up to date');
  } else {
    fs.writeFileSync(OUT, md);
    console.log('wrote ' + path.relative(process.cwd(), OUT));
  }
}
module.exports = { build, OUT };
