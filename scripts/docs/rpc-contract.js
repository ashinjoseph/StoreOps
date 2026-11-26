#!/usr/bin/env node
// ============================================================
//  rpc-contract.js — write ops/contracts/rpc.json from the source
// ============================================================
//  Usage:   node scripts/docs/rpc-contract.js           (write the file)
//           node scripts/docs/rpc-contract.js --check   (exit 1 if it is stale)
//
//  A machine-readable list of every rpc* endpoint in src/WebApp.gs, for the
//  new server under ops/: name, parameters, roles, whether it needs a session,
//  the modules it calls, and whether it is migrated. The parsing is the code
//  map's (codemap.js parseRpcs), so the two cannot disagree.
//
//  `migrate` is false when any of the module areas listed in DEPRECATED is
//  touched: those areas are not being moved off Sheets.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { parseRpcs } = require('./codemap');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'ops', 'contracts', 'rpc.json');
const DEPRECATED = ['ProductMaster', 'ProductTypes', 'ShoppingList', 'Suppliers', 'OrderCatalog'];

function build() {
  const rpcs = parseRpcs().map(r => ({
    name: r.name,
    params: r.params ? r.params.split(',').map(p => p.trim()) : [],
    roles: r.roles,
    needs_session: r.needsSession,
    modules: r.calls,
    migrate: !r.calls.some(m => DEPRECATED.indexOf(m) !== -1),
  }));
  const out = {
    generated_from: 'src/WebApp.gs',
    count: rpcs.length,
    migrate_count: rpcs.filter(r => r.migrate).length,
    rpcs,
  };
  return JSON.stringify(out, null, 2) + '\n';
}

if (require.main === module) {
  const json = build();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (cur !== json) {
      console.error('ops/contracts/rpc.json is stale — run npm run docs:rpc');
      process.exit(1);
    }
    console.log('rpc.json is up to date');
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, json);
    console.log('wrote ' + path.relative(ROOT, OUT));
  }
}
module.exports = { build, OUT };
