// ============================================================
//  ops-schema-contract — the Postgres contract covers the Sheet
// ============================================================
//  ops/contracts/schema.sql is the frozen schema the Operations app builds
//  on, and the import from the Sheet must be lossless. This suite needs no
//  Postgres: it boots the real server (scripts/docs/runtime.js), which runs
//  firstTimeSetup and every migration, takes each tab and header row from
//  that, and holds the SQL to it:
//    - every tab is a table or is named in the "Left out, and why" list;
//    - every column of a migrated tab is a column of its table, or is named
//      in that list; a migrated table invents no column but store_id;
//    - no deprecated tab has a table;
//    - no numeric column (money, hours, rates) carries a default (ADR-0004);
//    - audit_log has its update/delete revoked from ops_app (ADR-0014);
//    - delete is granted to ops_app on sessions and login_failures only;
//    - no float, real or double precision anywhere.
// ============================================================
const fs = require('fs');
const path = require('path');
const H = require('./_lib/harness');
const R = require('../../scripts/docs/runtime');
const t = H.suite('Operations schema contract (ops/contracts/schema.sql)');

const SQL_PATH = path.join(H.REPO, 'ops', 'contracts', 'schema.sql');
const ROLES_PATH = path.join(H.REPO, 'ops', 'contracts', 'roles.sql');

// Deprecated by the owner (migration plan, "Not migrated: deprecated areas").
const DEPRECATED = ['product_master', 'product_beer_detail', 'product_cigarettes_detail',
  'product_vape_detail', 'suppliers', 'order_catalog', 'shopping_list',
  'pos_extracted', 'clover_batches'];
const isDeprecated = tab => DEPRECATED.includes(tab) || /^_pm_.*_staging$/.test(tab);
// Tables that exist only in Operations (no Sheet tab behind them).
const NEW_TABLES = ['stores', 'staff_stores', 'sessions', 'login_failures'];

// ── What the Sheet actually has ──────────────────────────────
const { ss } = R.boot();
const TABS = {};
ss.getSheets().forEach(s => {
  TABS[s.getName()] = s.getRange(2, 1, 1, s.getLastColumn()).getValues()[0]
    .map(h => String(h).trim()).filter(Boolean);
});

// ── Parse the SQL ────────────────────────────────────────────
t.section('The contract files exist');
const haveSql = fs.existsSync(SQL_PATH);
t.ok('ops/contracts/schema.sql exists', haveSql);
t.ok('ops/contracts/roles.sql exists', fs.existsSync(ROLES_PATH));
const raw = haveSql ? fs.readFileSync(SQL_PATH, 'utf8') : '';
const rolesRaw = fs.existsSync(ROLES_PATH) ? fs.readFileSync(ROLES_PATH, 'utf8') : '';
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
const code = stripComments(raw);

// "Left out, and why": lines of the form
//   --   tab    <name>          <reason>
//   --   column <tab>.<column>  <reason>
const leftTabs = new Set();
const leftCols = new Set();
{
  const start = raw.indexOf('Left out, and why');
  const block = start === -1 ? '' : raw.slice(start).split(/\n(?!--)/)[0];
  block.split('\n').forEach(line => {
    let m = /^--\s+tab\s+([a-z_]+)\s/.exec(line + ' ');
    if (m) leftTabs.add(m[1]);
    m = /^--\s+column\s+([a-z_]+)\.([a-z_]+)\s/.exec(line + ' ');
    if (m) leftCols.add(m[1] + '.' + m[2]);
  });
}

// Tables: create table ops.<name> ( ... ); one column per line, a column
// being a name followed by a type (any type, so a float would be seen).
const TYPE = '(?:text|varchar(?:\\s*\\(\\s*\\d+\\s*\\))?|character\\s+varying|boolean|bool|date|' +
  'timestamptz|timestamp(?:\\s+with(?:out)?\\s+time\\s+zone)?|time|interval|jsonb|json|bytea|uuid|' +
  'numeric(?:\\s*\\(\\s*\\d+\\s*(?:,\\s*\\d+\\s*)?\\))?|decimal(?:\\s*\\([^)]*\\))?|' +
  'smallint|integer|int|bigint|real|float[48]?|double\\s+precision|money)(?=[\\s,]|$)';
const TABLES = {};
{
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:ops\.)?([a-z_]+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
  let m;
  while ((m = re.exec(code))) {
    const cols = {};
    m[2].split('\n').forEach(line => {
      const c = new RegExp('^\\s*"?([a-z_]+)"?\\s+(' + TYPE + ')(.*)$', 'i').exec(line);
      if (!c) return;
      if (/^(constraint|primary|unique|check|foreign|exclude)$/i.test(c[1])) return;
      cols[c[1]] = { type: c[2].trim().toLowerCase(), rest: c[3].toLowerCase() };
    });
    TABLES[m[1]] = cols;
  }
}

t.section('Every Sheet tab is a table or is left out by name');
Object.keys(TABS).forEach(tab => {
  const has = !!TABLES[tab], left = leftTabs.has(tab);
  t.ok(tab + (has ? ' → table' : left ? ' → left out' : ' → MISSING'), has !== left);
});

t.section('No deprecated tab has a table, and each is in the left-out list');
Object.keys(TABS).filter(isDeprecated).forEach(tab => {
  t.ok(tab + ' has no table', !TABLES[tab]);
  t.ok(tab + ' is listed as left out', leftTabs.has(tab));
});
DEPRECATED.forEach(tab => t.ok('no table ' + tab, !TABLES[tab]));

t.section('Every column of a migrated tab is in its table, or left out by name');
Object.keys(TABS).filter(tab => TABLES[tab]).forEach(tab => {
  TABS[tab].forEach(col => {
    const has = !!TABLES[tab][col], left = leftCols.has(tab + '.' + col);
    t.ok(tab + '.' + col + (has ? '' : left ? ' (left out)' : ' MISSING'), has !== left);
  });
});

t.section('A migrated table invents no column but store_id');
Object.keys(TABLES).filter(tab => TABS[tab]).forEach(tab => {
  const extra = Object.keys(TABLES[tab]).filter(c => c !== 'store_id' && !TABS[tab].includes(c));
  t.eq(tab + ': no invented columns', extra, []);
});

t.section('The left-out list names only things that exist');
leftTabs.forEach(tab => t.ok('tab ' + tab + ' exists in the Sheet', !!TABS[tab]));
leftCols.forEach(tc => {
  const [tab, col] = tc.split('.');
  t.ok('column ' + tc + ' exists in the Sheet', !!TABS[tab] && TABS[tab].includes(col));
});

t.section('Only the expected tables exist');
const expected = Object.keys(TABS).filter(tab => !leftTabs.has(tab)).concat(NEW_TABLES).sort();
t.eq('tables = migrated tabs + ' + NEW_TABLES.join(', '), Object.keys(TABLES).sort(), expected);

t.section('Blank is not zero: no numeric column has a default (ADR-0004)');
{
  let numeric = 0;
  Object.keys(TABLES).forEach(tab => Object.keys(TABLES[tab]).forEach(col => {
    const c = TABLES[tab][col];
    if (!/^(numeric|decimal|integer|int|smallint|bigint)/.test(c.type)) return;
    numeric++;
    if (/\bdefault\b/.test(c.rest)) t.ok(tab + '.' + col + ' has no default', false);
  }));
  t.ok('found numeric columns to check (' + numeric + ')', numeric > 20);
  t.ok('no "default 0" anywhere', !/default\s+0(\.0+)?\b/i.test(code));
}

t.section('Money is numeric(12,2)');
['till_sessions.expected_cash', 'till_sessions.closing_variance', 'sales.cash_sales',
  'sales.card_total_sales', 'payments.total_amount', 'payment_items.amount',
  'bonuses.amount', 'cash_handovers.amount', 'cash_handover_items.amount',
  'validation_results.clover_card'].forEach(tc => {
  const [tab, col] = tc.split('.');
  const c = TABLES[tab] && TABLES[tab][col];
  t.eq(tc, c && c.type.replace(/\s+/g, ''), 'numeric(12,2)');
});

t.section('No floating-point types');
t.ok('no float / real / double precision in schema.sql',
  !/\b(float[48]?|real|double\s+precision)\b/i.test(code));

t.section('Grants: audit_log append-only; delete only where a row is disposable');
t.ok('revoke update, delete on audit_log from ops_app',
  /revoke\s+update\s*,\s*delete\s+on\s+(?:table\s+)?ops\.audit_log\s+from\s+ops_app\s*;/i.test(code));
{
  const deletes = [];
  const re = /grant\s+([a-z, ]+?)\s+on\s+(?:table\s+)?ops\.([a-z_]+)\s+to\s+ops_app/gi;
  let m;
  while ((m = re.exec(code))) if (/\bdelete\b|\ball\b/i.test(m[1])) deletes.push(m[2]);
  t.eq('delete granted to ops_app on exactly sessions and login_failures',
    deletes.sort(), ['login_failures', 'sessions']);
  t.ok('no blanket grant on all tables', !/grant[^;]*on\s+all\s+tables/i.test(code));
}

t.section('roles.sql: passwords come from session settings, delete is not a default');
const rolesCode = stripComments(rolesRaw);
t.ok('no password literal', !/password\s+'[^']*'/i.test(rolesCode));
['owner', 'app', 'read'].forEach(v =>
  t.ok('reads the ops.' + v + '_password setting', /current_setting\(\s*'ops\.'/.test(rolesCode) && rolesRaw.indexOf('ops.' + v + '_password') !== -1));
t.ok('default privileges grant select, insert, update to ops_app',
  /alter\s+default\s+privileges[\s\S]*?grant\s+select\s*,\s*insert\s*,\s*update\s+on\s+tables\s+to\s+ops_app/i.test(rolesCode));
t.ok('no default delete for anyone',
  !/alter\s+default\s+privileges[^;]*grant[^;]*\bdelete\b/i.test(rolesCode));

t.section('Both contract files are plain SQL: any driver or SQL editor can run them');
[['roles.sql', rolesRaw], ['schema.sql', raw]].forEach(([name, text]) => {
  const code = stripComments(text);
  t.ok(name + ' has no psql meta-command (a line starting with a backslash)', !/^\s*\\/m.test(code));
  t.ok(name + ' has no psql variable (:\'name\')', !/:'[a-z_]+'/.test(code));
  t.ok(name + ' leaves the transaction to its caller (no begin/commit)', !/^\s*(begin|commit)\s*;/im.test(code));
});

t.section('Every operational table carries store_id');
['attendance', 'till_sessions', 'sales', 'validation_results', 'payments', 'bonuses',
  'commission_rules', 'commission_runs', 'cash_handovers'].forEach(tab => {
  const c = TABLES[tab] && TABLES[tab].store_id;
  t.ok(tab + '.store_id references stores with a default',
    !!c && /references\s+ops\.stores/.test(c.rest) && /\bdefault\b/.test(c.rest));
});

t.done();
