// ============================================================
//  ui-audit-log — the Audit log screen (Operations app only)
// ============================================================
//  Card P4-13; ADR-0023. These assertions run the page's own functions,
//  lifted from both copies of the page (src/Index.html and the Worker's
//  built ops/public/index.html):
//   - the drawer entry is opsOnly and offered to an admin only, never
//     inside Apps Script;
//   - a row whose values hold <script> and quotes is rendered escaped, in
//     the list, in the sheet and in the filters (every value goes through
//     esc());
//   - the before/after sheet marks the keys that changed, shows a missing
//     key as a dash and a blank as the word "blank" (never a zero);
//   - "Older" asks for the page after `nextBefore` and adds to what is
//     shown; a filter change asks again from the top;
//   - the screen reads through cachedCall (a read: it never clears the
//     read cache) and names its one call only inside its own functions;
//   - the Commissions screen shows "The Monday run is paused (Settings)."
//     only in the Operations app, only for an admin, and only when paused;
//   - the built Operations page carries the screen; Apps Script hides it.
// ============================================================
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const H = require('./_lib/harness');
const DOM = require('./_lib/dom');
const t = H.suite('Audit log screen — Operations app, admin only');

const OWN = ['auditWords_', 'auditWhen_', 'auditWho_', 'auditTarget_', 'auditInput_', 'auditFlat_', 'auditDiff_', 'auditValueHTML_', 'auditKeyLabel_',
  'auditRowHTML_', 'auditSheetHTML_', 'openAuditSheet_', 'auditFiltersHTML_', 'renderAuditTab', 'loadAuditLogTab', 'loadOlderAudit_'];
const ASYNC = { loadAuditLogTab: true, loadOlderAudit_: true };
const consts = js => /  const AUDIT_PAGE = [^\n]*\n  const AUDIT_WORDS = \{[\s\S]*?\n  \};\n  const auditState = [^\n]*\n/.exec(js)[0];

const HOSTILE = '<script>alert(1)</script> "quoted" \'single\' <img src=x onerror=1> &amp;';
const pending = [];

H.uiScripts().forEach(([label, js]) => {
  t.section('Against ' + label);

  // ── The drawer entry ──────────────────────────────────────
  {
    const lifted = /const ALL_ROLES = [^\n]*\n  const MORE_ITEMS = \[[\s\S]*?\n  \];/.exec(js)[0];
    const items = new Function(lifted + '; return MORE_ITEMS;')();
    const entry = items.filter(i => i.tab === 'audit');
    t.eq('one Audit log entry in the real MORE_ITEMS', entry.length, 1);
    t.ok('it is opsOnly', entry[0].opsOnly === true);
    t.eq('for an admin only', entry[0].roles, ['admin']);
    t.ok('written on one line, as the build reads the list', /^\s*\{ tab: 'audit'.*opsOnly: true \},\s*$/m.test(js));
    const pick = new Function(H.fnSource(js, 'moreItemsFor_') + '; return moreItemsFor_;')();
    const has = (role, ops) => pick(items, role, ops).some(i => i.tab === 'audit');
    t.eq('offered in the Operations app to an admin only',
      ['admin', 'manager', 'payroll_admin', 'employee'].map(r => has(r, true)), [true, false, false, false]);
    t.eq('hidden inside Apps Script from everyone', ['admin', 'manager', 'payroll_admin', 'employee'].map(r => has(r, false)), [false, false, false, false]);
    t.ok('a drawer tab with a title, a loader and a view',
      /const DRAWER_TABS = \[[^\]]*'audit'/.test(js) && /audit: 'Audit log'/.test(H.fnSource(js, 'switchTab')) && /audit:\s*loadAuditLogTab\b/.test(H.fnSource(js, 'tabLoaders_')) &&
      js.length > 0);
    const own = OWN.map(n => H.fnSource(js, n)).join('\n');
    const count = (s, n) => s.split(n).length - 1;
    t.ok('the one call is named only inside the screen\'s own functions', count(js, 'rpcGetAuditLog') > 0 && count(js, 'rpcGetAuditLog') === count(own, 'rpcGetAuditLog'));
    t.ok('the call is a read (its name starts rpcGet): a read never clears the read cache', new Function(H.fnSource(js, 'isReadMethod_') + '; return isReadMethod_;')()('rpcGetAuditLog') === true);
    t.ok('it is read with cachedCall, never with call', /cachedCall\('rpcGetAuditLog'/.test(own) && !/\bcall\('rpcGetAuditLog'/.test(own));
    t.ok('no var in the screen (it would hoist over a module helper)', !/\bvar\b/.test(own));
    t.ok('no localStorage or sessionStorage in the screen', !/localStorage|sessionStorage/.test(own));
    t.ok('no innerHTML of anything but the screen\'s own markup built with esc (no raw value is interpolated)', !/innerHTML\s*=\s*[^;]*\b(r|l)\.(details|actorName|targetId|before|after)\b/.test(own));
  }

  // A world with the page's real call/cachedCall over a google.script.run stub, and stubs for the rest.
  const lifted = [consts(js), 'const rpcCache = new Map(); const rpcInflight = new Map(); const TTL_LIVE = 60000;',
    ...['_ckey', 'isReadMethod_', 'call', 'cachedCall', 'cacheFresh', 'esc'].map(n => (n === 'cachedCall' ? 'async ' : '') + H.fnSource(js, n)),
    ...OWN.map(n => (ASYNC[n] ? 'async ' : '') + H.fnSource(js, n))].join('\n\n');
  function world(opts) {
    opts = opts || {};
    let dom = DOM.fromHTML('');
    let viewHTML = '';
    const view = { get innerHTML() { return viewHTML; }, set innerHTML(h) { viewHTML = h; dom = DOM.fromHTML(h); }, querySelectorAll: () => [] };
    const w = {
      sheets: [], sent: [], toasts: [],
      console: { log() {}, error() {}, warn() {} },
      Intl, Date, Math, Number, String, JSON, isNaN, Promise, Map, Error, Object, Array, setTimeout,
      state: { token: 'tok', me: { role: 'admin' } },
      $: id => (id === 'view-audit' ? view : dom.$(id)),
      view,
      dom: () => dom,
      openSheet: spec => w.sheets.push(spec),
      closeSheet: () => {},
      haptic: () => {},
      moreBack: () => '',
      toast: (m, k) => w.toasts.push([m, k]),
      handleRpcError: e => w.toasts.push([e.message, 'error']),
      google: { script: { run: null } },
    };
    const runner = () => {
      let ok = null;
      let proxy = null;
      const r = {
        withSuccessHandler(f) { ok = f; return proxy; },
        withFailureHandler() { return proxy; },
      };
      proxy = new Proxy(r, { get: (o, k) => (k in o ? o[k] : (...args) => { w.sent.push([k].concat(args)); setImmediate(() => ok(opts.answer ? opts.answer(k, args) : {})); }) });
      return proxy;
    };
    Object.defineProperty(w.google.script, 'run', { get: runner });
    vm.createContext(w);
    vm.runInContext(lifted, w);
    return w;
  }
  const fn = (w, name) => vm.runInContext(name, w);
  const tick = () => new Promise(r => setImmediate(r)).then(() => new Promise(r => setImmediate(r)));

  const row = (over) => Object.assign({
    seq: 10, at: '2026-11-20T19:05:00.000Z', actorId: 'S_001', actorName: 'Ada Quill', action: 'till.correct',
    targetType: 'till_sessions', targetId: 'TS_1', before: { cashSales: 10 }, after: { cashSales: 12.5 }, details: 'Miscounted the coins',
  }, over || {});

  // ── The words ─────────────────────────────────────────────
  {
    const w = world();
    const words = fn(w, 'auditWords_');
    t.eq('plain words for the common actions', ['till.correct', 'config.update', 'staff.pin_set', 'staff.update', 'login.fail'].map(words),
      ['corrected a till', 'changed a setting', 'set a PIN', 'changed a person', 'failed to sign in']);
    t.eq('an action the map does not know is shown as it is', words('mystery.thing'), 'mystery.thing');
    t.eq('a notice names its event', words('notify.shift_open_failed'), 'a notice (shift_open_failed)');
    t.eq('"toString" and other names of the object itself are not words', [words('toString'), words('constructor')], ['toString', 'constructor']);
    t.eq('a blank action is said so', words(''), '(no action)');
    t.ok('the time is Toronto time', fn(w, 'auditWhen_')('2026-11-20T19:05:00.000Z').indexOf('14:05') !== -1);
  }

  // ── Everything goes through esc() ─────────────────────────
  {
    const w = world();
    const hostile = row({ actorName: HOSTILE, targetType: HOSTILE, targetId: HOSTILE, details: HOSTILE, action: '<b>x</b>', before: { [HOSTILE]: HOSTILE }, after: { [HOSTILE]: HOSTILE + '2', nested: [HOSTILE] } });
    const listHTML = fn(w, 'auditRowHTML_')(hostile, 0);
    const sheetHTML = fn(w, 'auditSheetHTML_')(hostile);
    for (const [name, html] of [['the list row', listHTML], ['the sheet', sheetHTML]]) {
      t.ok(name + ': no raw <script>, <img or <b> tag', !/<script|<img|<b>|<\/b>/i.test(html));
      t.ok(name + ': the text is there, escaped', html.indexOf('&lt;script&gt;alert(1)&lt;/script&gt;') !== -1);
      t.ok(name + ': quotes are escaped (nothing can leave an attribute)', !/onerror=1>/.test(html) && html.indexOf('&quot;quoted&quot;') !== -1 && html.indexOf('&#39;single&#39;') !== -1);
    }
    const sendFilters = () => {
      const f = world();
      const s = fn(f, 'auditState');
      s.actors = [{ id: 'S_1', name: HOSTILE }, { id: HOSTILE, name: 'Bad Id' }];
      s.actions = ['<script>x.y', 'ok.thing'];
      s.filters = { actorId: HOSTILE, action: '<script>x.y', day: HOSTILE };
      return fn(f, 'auditFiltersHTML_')();
    };
    const fh = sendFilters();
    t.ok('the filters: names, ids, actions and the current day are escaped', !/<script|<img/i.test(fh) && fh.indexOf('&lt;script&gt;') !== -1);
    // The whole screen, with a hostile row in it.
    const r = world();
    const s = fn(r, 'auditState');
    s.rows = [hostile];
    fn(r, 'renderAuditTab')();
    t.ok('the whole screen holds no raw tag from the row', !/<script|<img|<b>/i.test(r.view.innerHTML));
    // The sheet the page opens.
    fn(r, 'openAuditSheet_')(hostile);
    const sheet = r.sheets[0];
    t.ok('the opened sheet: the body holds no raw tag', !/<script|<img|<b>/i.test(sheet.bodyHTML));
    t.ok('the title and subtitle are set by openSheet as text (textContent), so a tag in them is never markup',
      /\$\('sheetTitle'\)\.textContent = opts\.title/.test(H.fnSource(js, 'openSheet')) && /\$\('sheetSubtitle'\)\.textContent = opts\.subtitle/.test(H.fnSource(js, 'openSheet')));
  }

  // ── The before and after sheet ────────────────────────────
  {
    const w = world();
    const html = fn(w, 'auditSheetHTML_')(row({
      before: { cashSales: 10, lotto: null, session: { status: 'closed', cashback: 0 }, only: 'before' },
      after: { cashSales: 12.5, lotto: null, session: { status: 'closed', cashback: 5 }, added: true, list: ['a', 'b'] },
    }));
    const marked = key => new RegExp('<tr data-audit-key="' + key.replace(/[.[\]]/g, '\\$&') + '" data-changed="1"').test(html);
    const unmarked = key => new RegExp('<tr data-audit-key="' + key.replace(/[.[\]]/g, '\\$&') + '">').test(html);
    t.ok('a changed value is marked', marked('cashSales') && marked('session.cashback'));
    t.ok('a value that did not change is not marked', unmarked('lotto') && unmarked('session.status'));
    t.ok('a key only after, and a key only before, are marked', marked('added') && marked('only') && marked('list[0]') && marked('list[1]'));
    t.ok('a missing key is a dash, a blank is the word blank (never 0)', /only<\/td><td[^>]*>before<\/td><td[^>]*><span[^>]*>—<\/span>/.test(html) && /<span[^>]*>blank<\/span>/.test(html));
    t.ok('a real zero stays 0', /cashback<\/td><td[^>]*>0<\/td><td[^>]*>5<\/td>/.test(html));
    t.ok('the reader is told what the mark means', html.indexOf('marks what changed') !== -1);
    t.ok('the facts are listed: action, target, reason', html.indexOf('till.correct') !== -1 && html.indexOf('till_sessions TS_1') !== -1 && html.indexOf('Miscounted the coins') !== -1);

    const diff = fn(w, 'auditDiff_');
    t.eq('a blank before and a zero after is a change (blank is not zero)', JSON.parse(JSON.stringify(diff({ a: null }, { a: 0 }))).map(l => [l.key, l.before, l.after, l.changed]), [['a', null, '0', true]]);
    t.eq('no before and no after: no lines, and the sheet says so', [JSON.parse(JSON.stringify(diff(null, null))).length, fn(w, 'auditSheetHTML_')(row({ before: null, after: null })).indexOf('recorded no before and after') !== -1], [0, true]);
    t.eq('a create (no before) marks every key', JSON.parse(JSON.stringify(diff(null, { a: 1, b: 'x' }))).map(l => l.changed), [true, true]);
    t.eq('text from an old row (not an object) is one line', JSON.parse(JSON.stringify(diff('old text', null))).map(l => [l.key, l.before, l.hasAfter]), [['value', 'old text', false]]);
    t.eq('key names are readable', ['cashSales', 'session.cashSales', 'list[0]'].map(fn(w, 'auditKeyLabel_')), ['cash sales', 'session.cash sales', 'list[0]']);
  }

  // ── The screen: filters, rows, Older ──────────────────────
  pending.push((async () => {
    const pages = {
      first: { rows: [row({ seq: 30, details: 'third' }), row({ seq: 29, details: 'second' })], nextBefore: 29, total: null, actions: ['config.update', 'till.correct'], actors: [{ id: 'S_001', name: 'Ada Quill' }] },
      second: { rows: [row({ seq: 28, details: 'first' })], nextBefore: null, total: null, actions: ['config.update', 'till.correct'], actors: [{ id: 'S_001', name: 'Ada Quill' }] },
    };
    const w = world({ answer: (m, args) => (args[1] && args[1].before ? pages.second : pages.first) });
    await fn(w, 'loadAuditLogTab')();
    t.eq('the first load asks for the newest page with no before', w.sent.map(c => [c[0], c[1], c[2]]), [['rpcGetAuditLog', 'tok', { limit: 50 }]]);
    t.ok('it shows the rows and an Older button', w.view.innerHTML.indexOf('third') !== -1 && w.view.innerHTML.indexOf('id="auditOlder"') !== -1);
    t.ok('the filters list the people and the kinds the server named, with a group', w.view.innerHTML.indexOf('Ada Quill') !== -1 && w.view.innerHTML.indexOf('All of till.*') !== -1 && w.view.innerHTML.indexOf('corrected a till (till.correct)') !== -1);
    const older = w.dom().get('auditOlder');
    older.onclick();
    await tick();
    t.eq('Older asks for the page after nextBefore, with the same filters', JSON.parse(JSON.stringify(w.sent[1].slice(2))), [{ limit: 50, before: 29 }]);
    t.ok('the older rows are added below the ones already shown, in order', /third[\s\S]*second[\s\S]*first/.test(w.view.innerHTML));
    t.ok('at the end there is no Older button, and the screen says so', w.view.innerHTML.indexOf('id="auditOlder"') === -1 && w.view.innerHTML.indexOf('That is everything') !== -1);

    // A filter asks again from the top, with the filter.
    w.dom().get('auditActor').value = 'S_001';
    w.dom().get('auditAction').value = 'till.';
    w.dom().get('auditDay').value = '2026-11-20';
    w.dom().get('auditDay').onchange();
    await tick();
    t.eq('changing a filter asks from the top, with every filter given', JSON.parse(JSON.stringify(w.sent[2].slice(2))), [{ limit: 50, actorId: 'S_001', action: 'till.', day: '2026-11-20' }]);

    // Nothing shown: a sentence, not a blank.
    const e = world({ answer: () => ({ rows: [], nextBefore: null, total: null, actions: [], actors: [] }) });
    await fn(e, 'loadAuditLogTab')();
    t.ok('an empty answer says nothing was recorded for these filters', e.view.innerHTML.indexOf('Nothing recorded for these filters') !== -1);

    // The read cache: a read is cached, and a second load inside its life asks nothing.
    const c = world({ answer: () => pages.first });
    await fn(c, 'loadAuditLogTab')();
    await fn(c, 'loadAuditLogTab')();
    t.eq('a second load inside the cache life makes no second call', c.sent.length, 1);
    await fn(c, 'loadAuditLogTab')(true);
    t.eq('the refresh control forces a new call', c.sent.length, 2);
  })());
});

// ── The Commissions screen: the paused line ─────────────────
H.uiScripts().forEach(([label, js]) => {
  t.section('The Commissions screen, ' + label);
  function build(opts) {
    let html = '';
    const sent = [];
    const w = {
      state: { token: 'tok', me: { role: opts.role || 'admin' } },
      isOpsApp_: () => opts.ops !== false,
      $: id => (id === 'view-commissions' ? { set innerHTML(h) { html = h; }, get innerHTML() { return html; }, querySelectorAll: () => [] } : null),
      moreBack: () => '', esc: s => String(s), money: n => '$' + n, fmtDate: d => String(d), call: () => Promise.resolve({}), toast: () => {}, haptic: () => {},
      confirm: () => true, triggerCommissionRun: () => {}, loadCommissionsTab: () => {}, TTL_SEMI: 1,
      cachedCall: async (m, args) => { sent.push([m, args]); if (opts.fail) throw new Error('nope'); return { paused: opts.paused }; },
      Object, String,
    };
    vm.createContext(w);
    vm.runInContext(H.fnSource(js, 'renderCommissionsTab').replace('function renderCommissionsTab', 'globalThis.renderCommissionsTab = function'), w);
    vm.runInContext('globalThis.commissionRunPaused_ = async ' + H.fnSource(js, 'commissionRunPaused_'), w);
    return { w, sent, html: () => html };
  }
  const LINE = 'The Monday run is paused (Settings).';
  const render = (opts, paused) => { const b = build(opts); b.w.renderCommissionsTab([], [], paused); return b.html(); };
  t.ok('Operations app, paused: the line is shown', render({}, true).indexOf(LINE) !== -1);
  t.ok('Operations app, not paused: no line', render({}, false).indexOf('Monday run is paused') === -1 && render({}, undefined).indexOf('Monday run is paused') === -1);
  t.ok('Apps Script, even if somehow told it is paused: no line', render({ ops: false }, true).indexOf('Monday run is paused') === -1);
  t.ok('the screen without the setting is as it was: the same HTML but for the line', render({}, true).replace(/<div id="commissionPausedLine"[\s\S]*?<\/div>/, '') === render({}, false));

  // Where the value comes from: one small read of its own, for the three roles that open the screen.
  const ask = async (opts) => { const b = build(opts); const v = await b.w.commissionRunPaused_(false); return { v, sent: b.sent }; };
  pending.push((async () => {
    const on = await ask({ paused: true });
    t.eq('Operations app, paused: yes, from the one small read', [on.v, on.sent.map(c => c[0])], [true, ['rpcGetCommissionRunPaused']]);
    t.eq('not paused', (await ask({ paused: false })).v, false);
    t.eq('an answer that is not a plain true is not paused', [(await ask({ paused: 'true' })).v, (await ask({ paused: undefined })).v], [false, false]);
    for (const role of ['admin', 'manager', 'payroll_admin']) {
      t.eq(role + ': asks, and is told', (await ask({ role, paused: true })).v, true);
    }
    const aps = await ask({ ops: false, paused: true });
    t.eq('Apps Script: no call is made, no line', [aps.v, aps.sent.length], [false, 0]);
    t.eq('a failed read is no line, not an error', (await ask({ fail: true })).v, false);
    t.ok('the screen does not ask the admin-only settings list (it would fail for a manager)', H.fnSource(js, 'commissionRunPaused_').indexOf('rpcGetSettings') === -1);
  })());
});

// ── The built Operations page carries the screen; Apps Script hides it ──
{
  t.section('The two apps');
  const built = require('child_process').execFileSync(process.execPath, [path.join(H.REPO, 'ops', 'tools', 'build-ui.mjs'), '--stdout'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  t.ok('the built page has the view, the loader and the opsOnly entry', built.indexOf('<div class="view" id="view-audit"></div>') !== -1 && built.indexOf('async function loadAuditLogTab(') !== -1 && /\{ tab: 'audit'[^\n]*opsOnly: true/.test(built));
  t.ok('the built page sets the Operations marker (transport loaded)', built.indexOf('<script src="/transport.js"></script>') !== -1);
  t.ok('the built page shows the paused line only through the same function as the source', built.indexOf('The Monday run is paused (Settings).') !== -1);
  const src = fs.readFileSync(path.join(H.SRC, 'Index.html'), 'utf8');
  t.ok('the Apps Script page never loads the transport, so isOpsApp_ is false there: the entry is hidden and no settings call is made', src.indexOf('/transport.js') === -1 && /if \(!isOpsApp_\(\)[^\n]*return false;/.test(src));
  t.ok('no template tag in the page (a "<?" opens a scriptlet even in a comment)', src.indexOf('<?') === -1 && built.indexOf('<?') === -1);
}

Promise.all(pending).then(() => new Promise(r => setTimeout(r, 50))).then(() => t.done()).catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
