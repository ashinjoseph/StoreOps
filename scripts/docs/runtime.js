// ============================================================
//  runtime.js — the real StoreOps server, running in Node
// ============================================================
//  Loads every src/*.gs file as-is over an in-memory spreadsheet and
//  stand-ins for the Apps Script services it touches. Nothing in src/ is
//  copied or re-implemented: firstTimeSetup builds the schema, the real
//  migrations bring it up to date, and the real RPCs answer the UI.
//
//  Used by screenshots.js so the docs show the app as it actually renders,
//  over data that is fictional but internally consistent — totals add up
//  because the server computed them.
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..', '..', 'src');

// ── An in-memory spreadsheet ─────────────────────────────────
// Rows and columns are 1-based like Sheets. A cell that was never written
// reads back as '' — exactly what getValues gives for an empty cell.
function makeSheet(name) {
  const grid = [];               // grid[row][col], 1-based, sparse
  let maxCols = 26, maxRows = 1000;
  const cell = (r, c) => (grid[r] && grid[r][c] !== undefined ? grid[r][c] : '');
  const lastRow = () => {
    for (let r = grid.length - 1; r >= 1; r--) {
      if (grid[r] && grid[r].some(v => v !== '' && v !== undefined && v !== null)) return r;
    }
    return 0;
  };
  const lastCol = () => {
    let m = 0;
    grid.forEach(row => { if (row) row.forEach((v, c) => { if (v !== '' && v != null && c > m) m = c; }); });
    return m;
  };
  const chain = target => new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      return () => chain(t);           // any formatting call is a no-op
    },
  });
  const range = (r, c, nr, nc) => {
    nr = nr || 1; nc = nc || 1;
    const self = {
      getRow: () => r, getColumn: () => c, getNumRows: () => nr, getNumColumns: () => nc,
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const line = [];
          for (let j = 0; j < nc; j++) line.push(cell(r + i, c + j));
          out.push(line);
        }
        return out;
      },
      getDisplayValues() { return self.getValues().map(l => l.map(v => v == null ? '' : String(v))); },
      getValue() { return cell(r, c); },
      setValues(v) {
        v.forEach((line, i) => line.forEach((val, j) => {
          const rr = r + i, cc = c + j;
          (grid[rr] = grid[rr] || [])[cc] = val;
          if (cc > maxCols) maxCols = cc;
          if (rr > maxRows) maxRows = rr;
        }));
        return chain(self);
      },
      setValue(v) { return self.setValues([[v]]); },
      clearContent() {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) {
          if (grid[r + i]) grid[r + i][c + j] = '';
        }
        return chain(self);
      },
    };
    return chain(self);
  };
  const sheet = {
    getName: () => name,
    getRange: (r, c, nr, nc) => range(r, c, nr, nc),
    getLastRow: lastRow,
    getLastColumn: lastCol,
    getMaxColumns: () => maxCols,
    getMaxRows: () => maxRows,
    insertColumnsAfter: (after, n) => { maxCols = Math.max(maxCols, after + n); return sheet; },
    insertRowsAfter: (after, n) => { maxRows = Math.max(maxRows, after + n); return sheet; },
    deleteRow: r => { grid.splice(r, 1); return sheet; },
    getDataRange: () => range(1, 1, Math.max(lastRow(), 1), Math.max(lastCol(), 1)),
    _grid: grid,
  };
  return chain(sheet);
}

function makeSpreadsheet() {
  const sheets = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n)),
    getSheets: () => Object.values(sheets),
    getId: () => 'docs-fixture',
    getName: () => 'StoreOps (docs fixture)',
    getSpreadsheetTimeZone: () => 'America/Toronto',
    _sheets: sheets,
  };
  return new Proxy(ss, { get: (t, p) => (p in t ? t[p] : () => t) });
}

// Any builder chain — data validation, triggers, menus — that the docs don't
// care about: every property is a function returning the same chain.
function chainable() {
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, { get: (t, p) => (p === 'then' ? undefined : () => proxy) });
  return proxy;
}

// ── Utilities.formatDate, for the patterns the code uses ─────
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function formatDate(d, tz, fmt) {
  const p = n => String(n).padStart(2, '0');
  return fmt.replace(/yyyy|MMM|MM|dd|d|EEE|HH|mm|ss/g, tok => ({
    yyyy: d.getFullYear(), MMM: MON[d.getMonth()], MM: p(d.getMonth() + 1),
    dd: p(d.getDate()), d: d.getDate(), EEE: DOW[d.getDay()],
    HH: p(d.getHours()), mm: p(d.getMinutes()), ss: p(d.getSeconds()),
  })[tok]);
}

let uuidSeq = 0;
function installServices(ss) {
  const props = {};
  const cache = {};
  global.SpreadsheetApp = {
    getActiveSpreadsheet: () => ss,
    getUi: () => ({
      alert: () => 'YES', prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => '' }),
      Button: { YES: 'YES', NO: 'NO', OK: 'OK', CANCEL: 'CANCEL' },
      ButtonSet: { YES_NO: 'YES_NO', OK: 'OK', OK_CANCEL: 'OK_CANCEL' },
      createMenu: () => chainable(),
    }),
    newDataValidation: () => chainable(),
    DataValidationCriteria: {},
  };
  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; },
      getProperties: () => Object.assign({}, props),
      getKeys: () => Object.keys(props),
    }),
  };
  global.CacheService = {
    getScriptCache: () => ({
      get: k => (k in cache ? cache[k] : null),
      getAll: ks => { const o = {}; ks.forEach(k => { if (k in cache) o[k] = cache[k]; }); return o; },
      put: (k, v) => { cache[k] = v; },
      putAll: o => Object.assign(cache, o),
      remove: k => { delete cache[k]; },
      removeAll: ks => ks.forEach(k => delete cache[k]),
    }),
  };
  global.LockService = { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) };
  global.ScriptApp = {
    getProjectTriggers: () => [], deleteTrigger() {}, WeekDay: { MONDAY: 'MONDAY' },
    newTrigger: () => chainable(),
  };
  // The docs never talk to Meta or Clover.
  global.UrlFetchApp = {
    fetch: () => ({ getResponseCode: () => 200, getContentText: () => '{}' }),
  };
  global.HtmlService = {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
    createHtmlOutputFromFile: () => chainable(),
    createTemplateFromFile: () => ({ evaluate: () => chainable() }),
  };
  global.Session = { getScriptTimeZone: () => 'America/Toronto', getActiveUser: () => ({ getEmail: () => '' }) };
  global.Utilities = {
    formatDate,
    getUuid: () => '00000000-0000-4000-8000-' + String(++uuidSeq).padStart(12, '0'),
    sleep() {},
    computeDigest: () => [],
    DigestAlgorithm: {}, Charset: {},
    base64Encode: s => Buffer.from(String(s)).toString('base64'),
  };
  global.Logger = { log() {} };
}

// ── Load the real source ─────────────────────────────────────
// Util and Setup first (helpers, SHEETS, enums), WebApp last (it uses every
// module). Modules are returned by name; WebApp's rpc* functions too.
function loadSource() {
  const files = fs.readdirSync(SRC).filter(f => f.endsWith('.gs'));
  const first = ['Util.gs', 'Setup.gs'];
  const order = first.concat(files.filter(f => first.indexOf(f) === -1 && f !== 'WebApp.gs'), ['WebApp.gs']);
  const src = order.map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n;\n');
  const names = [];
  const re = /^(?:const|function) ([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src))) if (names.indexOf(m[1]) === -1) names.push(m[1]);
  const ret = '\n;return {' + names.map(n => n + ': typeof ' + n + " !== 'undefined' ? " + n + ' : undefined').join(',') + '};';
  return new Function(src + ret)();
}

/**
 * A fresh StoreOps backend: schema built by the real firstTimeSetup, brought
 * current by the real migrations, placeholder rows cleared.
 */
function boot() {
  const ss = makeSpreadsheet();
  installServices(ss);
  const api = loadSource();
  Object.keys(api).forEach(k => { if (api[k] !== undefined) global[k] = api[k]; });

  const quiet = fn => { try { fn(); } catch (e) { /* reported below */ throw e; } };
  quiet(() => api.firstTimeSetup());
  Object.keys(api).filter(k => /^menu_migrate/.test(k) && k !== 'menu_migrateProductMasterV2')
    .forEach(k => { try { api[k](); } catch (e) { console.warn('migration ' + k + ': ' + e.message); } });

  // Setup seeds one placeholder row per table so a human can eyeball the
  // shape. The modules ignore them, but the fixture starts clean.
  Object.values(ss._sheets).forEach(sh => {
    const g = sh._grid;
    for (let r = g.length - 1; r >= 3; r--) {
      const first = g[r] && g[r][1];
      if (typeof first === 'string' && /PLACEHOLDER/i.test(first)) g.splice(r, 1);
    }
  });
  return { api, ss };
}

module.exports = { boot, formatDate };
