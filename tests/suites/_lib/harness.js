// ============================================================
//  harness.js — run real StoreOps modules over stubbed Sheets
// ============================================================
//  No production test hooks and no copied logic. A suite loads the actual
//  src/*.gs text, evaluates it against stubbed Apps Script globals, and
//  asserts on what the real functions return. For src/*.html it lifts the
//  inline <script> and runs that.
//
//  Usage:
//    const H = require('./_lib/harness');
//    const t = H.suite('lotto payout');
//    H.sheets({ till_sessions: { headers: [...], rows: [...] } });
//    const M = H.load(['Util.gs', 'TillSessions.gs']);
//    t.eq('label', actual, expected);
//    t.done();
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SRC = path.join(REPO, 'src');

// ── Sheet stub ──────────────────────────────────────────────
// Every sheet is { headers: [...], rows: [[...]] }. getRange honours the
// requested width even past the headers, because that is what a real Sheet
// does — a grid is wider than its populated columns, and code that reads
// NUM_COLS must not blow up on a narrower header row.
let SHEET_DATA = {};
let WRITES = [];

function sheetStub(name) {
  const def = SHEET_DATA[name];
  if (!def) return null;
  const headers = def.headers || [];
  const rows = def.rows;
  const width = Math.max(headers.length, 1,
    ...rows.map(r => r.length));
  const DATA_START = 3;                       // row 1 title, row 2 headers
  return {
    getName: () => name,
    getLastRow: () => (DATA_START - 1) + rows.length,
    getLastColumn: () => width,
    getRange: (r, c, nr, nc) => {
      const rowCount = nr == null ? 1 : nr;
      const colCount = nc == null ? 1 : nc;
      const slice = () => {
        const out = [];
        for (let i = 0; i < rowCount; i++) {
          const abs = r + i;
          const src = abs === 2 ? headers : (rows[abs - DATA_START] || []);
          const line = [];
          for (let j = 0; j < colCount; j++) {
            const v = src[c - 1 + j];
            line.push(v === undefined ? '' : v);
          }
          out.push(line);
        }
        return out;
      };
      return {
        getValues: slice,
        getValue: () => slice()[0][0],
        setValues: v => {
          WRITES.push({ sheet: name, row: r, col: c, values: v });
          v.forEach((line, i) => {
            const abs = r + i - DATA_START;
            if (abs < 0) return;
            if (!rows[abs]) rows[abs] = [];
            line.forEach((cell, j) => { rows[abs][c - 1 + j] = cell; });
          });
          return this;
        },
        setValue: val => {
          WRITES.push({ sheet: name, row: r, col: c, values: [[val]] });
          const abs = r - DATA_START;
          if (abs >= 0) { if (!rows[abs]) rows[abs] = []; rows[abs][c - 1] = val; }
          return this;
        },
        setNumberFormat: function () { return this; },
        setFontWeight: function () { return this; },
        setFontColor: function () { return this; },
        setBackground: function () { return this; },
        setHorizontalAlignment: function () { return this; },
        merge: function () { return this; },
        setFontSize: function () { return this; },
      };
    },
    setColumnWidth: function () { return this; },
    insertRowAfter: function () { return this; },
    getDataRange: function () { return this.getRange(1, 1, this.getLastRow(), width); },
  };
}

/**
 * Define the sheets for this scenario.
 * `config` may be given as a plain {key: value} object for convenience.
 */
function sheets(spec) {
  SHEET_DATA = {};
  WRITES = [];
  Object.keys(spec || {}).forEach(name => {
    const def = spec[name];
    if (name === 'config' && !Array.isArray(def) && !def.rows) {
      SHEET_DATA.config = {
        headers: ['key', 'value', 'description'],
        rows: Object.keys(def).map(k => [k, def[k], '']),
      };
      return;
    }
    SHEET_DATA[name] = Array.isArray(def)
      ? { headers: [], rows: def }
      : { headers: def.headers || [], rows: def.rows || [] };
  });
}

function setConfig(key, value) {
  if (!SHEET_DATA.config) {
    SHEET_DATA.config = { headers: ['key', 'value', 'description'], rows: [] };
  }
  const row = SHEET_DATA.config.rows.find(r => r[0] === key);
  if (row) row[1] = value; else SHEET_DATA.config.rows.push([key, value, '']);
}

const rowsOf = name => (SHEET_DATA[name] || { rows: [] }).rows;
const writes = () => WRITES.slice();

// ── Apps Script globals ─────────────────────────────────────
let idSeq = 0;
function installGlobals(extra) {
  global.SHEETS = {
    STAFF: 'staff', ATTENDANCE: 'attendance', TILL_SESSIONS: 'till_sessions',
    SALES: 'sales', PAYMENTS: 'payments', PAYMENT_ITEMS: 'payment_items',
    BONUSES: 'bonuses', COMMISSION_RULES: 'commission_rules',
    COMMISSION_RUNS: 'commission_runs', AUDIT_LOG: 'audit_log', CONFIG: 'config',
    POS_EXTRACTED: 'pos_extracted', CLOVER_BATCHES: 'clover_batches',
    VALIDATION_RESULTS: 'validation_results', SUPPLIERS: 'suppliers',
    ORDER_CATALOG: 'order_catalog', SHOPPING_LIST: 'shopping_list',
    PRODUCT_MASTER: 'product_master',
    CASH_HANDOVERS: 'cash_handovers', CASH_HANDOVER_ITEMS: 'cash_handover_items',
  };
  global.COMPANIES = ['cstore', 'vape'];
  global.SpreadsheetApp = {
    getActiveSpreadsheet: () => ({
      getSheetByName: sheetStub,
      insertSheet: name => { SHEET_DATA[name] = { headers: [], rows: [] }; return sheetStub(name); },
    }),
    getUi: () => ({ alert: () => {} }),
  };
  global.Session = { getScriptTimeZone: () => 'America/Toronto' };
  global.Utilities = {
    formatDate: (d, tz, fmt) => {
      const p = n => String(n).padStart(2, '0');
      const iso = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
      if (fmt === 'yyyyMMdd') return iso.replace(/-/g, '');
      if (fmt === 'yyyyMMdd_HHmmss') return iso.replace(/-/g, '') + '_' + p(++idSeq);
      if (fmt === 'EEE d MMM yyyy') {
        const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return DOW[d.getDay()] + ' ' + d.getDate() + ' ' + MON[d.getMonth()] + ' ' + d.getFullYear();
      }
      if (fmt === 'HH:mm') return p(d.getHours()) + ':' + p(d.getMinutes());
      return iso;
    },
    getUuid: () => 'uuid-' + (++idSeq),
  };
  global.AuditLog = { write() {} };
  global.console = console;
  Object.assign(global, extra || {});
}

/**
 * Evaluate real module source and hand back the modules it defines.
 * Files are concatenated in order, so dependencies come first.
 */
function load(files, extraGlobals) {
  installGlobals(extraGlobals);
  const src = files.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
  // Module objects are named after their file (Sales.gs -> Sales). WebApp.gs
  // has no module object at all — it declares top-level rpc* functions — so
  // collect those by name too, or a suite cannot call the endpoint it is
  // testing.
  const names = files
    .map(f => path.basename(f, path.extname(f)))
    .filter(n => /^[A-Z]/.test(n));
  const topLevel = [];
  const re = /^function ([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(src))) if (topLevel.indexOf(m[1]) === -1) topLevel.push(m[1]);
  const all = names.concat(topLevel.filter(n => names.indexOf(n) === -1));
  const ret = '\n; return { ' +
    all.map(n => n + ': typeof ' + n + " !== 'undefined' ? " + n + ' : undefined').join(', ') +
    ' };';
  const mods = new Function(src + ret)();
  Object.keys(mods).forEach(k => { if (mods[k] !== undefined) global[k] = mods[k]; });
  return mods;
}

/** Lift the inline <script> out of an HTML file — the client code, as shipped. */
function clientScript(file) {
  const html = fs.readFileSync(path.join(SRC, file), 'utf8');
  const m = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('no inline script in ' + file);
  return m[1];
}

const read = file => fs.readFileSync(path.join(SRC, file), 'utf8');

/** Pull one named function's source out of a file, braces balanced. */
function fnSource(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i === -1) throw new Error('no function ' + name);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unbalanced ' + name);
}

/** Run a snippet of lifted client code in its own context. */
function sandbox(code, ctx) {
  const c = vm.createContext(Object.assign({ console: console }, ctx || {}));
  vm.runInContext(code, c);
  return c;
}

// ── Assertions ──────────────────────────────────────────────
function suite(title) {
  let pass = 0, fail = 0;
  const log = s => console.log(s);
  log('\n━━ ' + title + ' ━━');
  const api = {
    section(t) { log('\n' + t); return api; },
    ok(label, cond) {
      if (cond) { pass++; log('  ✓ ' + label); }
      else { fail++; log('  ✗ ' + label); }
      return api;
    },
    eq(label, actual, expected) {
      const a = JSON.stringify(actual), e = JSON.stringify(expected);
      if (a === e) { pass++; log('  ✓ ' + label); }
      else { fail++; log('  ✗ ' + label + '\n      expected ' + e + '\n      got      ' + a); }
      return api;
    },
    near(label, actual, expected, tol) {
      if (actual != null && Math.abs(actual - expected) <= (tol == null ? 0.011 : tol)) {
        pass++; log('  ✓ ' + label);
      } else { fail++; log('  ✗ ' + label + ' — expected ~' + expected + ', got ' + actual); }
      return api;
    },
    throws(label, fn, needle) {
      try {
        fn();
        fail++; log('  ✗ ' + label + ' — expected a throw, got none');
      } catch (e) {
        if (!needle || String(e.message).indexOf(needle) !== -1) { pass++; log('  ✓ ' + label); }
        else { fail++; log('  ✗ ' + label + '\n      message lacked "' + needle + '": ' + e.message); }
      }
      return api;
    },
    done() {
      log('\n' + (fail === 0 ? '✅ ' : '❌ ') + pass + ' passed, ' + fail + ' failed');
      process.exitCode = fail === 0 ? (process.exitCode || 0) : 1;
      return { pass, fail };
    },
  };
  return api;
}

module.exports = {
  suite, sheets, setConfig, rowsOf, writes,
  load, clientScript, read, fnSource, sandbox,
  REPO, SRC,
};
