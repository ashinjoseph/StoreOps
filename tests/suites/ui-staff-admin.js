// ============================================================
//  ui-staff-admin — the Staff screen (Operations app only)
// ============================================================
//  Card P4-11; ADR-0023. These assertions run the page's own functions,
//  lifted from both copies of the page (src/Index.html and the Worker's
//  built ops/public/index.html):
//   - the drawer entry is opsOnly and offered to an admin and a manager
//     only, never inside Apps Script;
//   - the sheet built for a manager has no rate field, no role choice, no
//     email or notes; an admin's has them; PIN boxes are password boxes;
//   - a blank rate is "no rate set", never $0.00; a real 0 stays $0.00;
//   - the PIN goes to the server through `call` only: never into the read
//     cache, a toast or localStorage; two different PINs send nothing;
//   - the preview and the after-save words say what the server answered.
// ============================================================
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const H = require('./_lib/harness');
const DOM = require('./_lib/dom');
const t = H.suite('Staff screen — Operations app, admin and manager');

const PIN = '73918264';
const OWN = ['loadStaffAdminTab', 'staffRateText_', 'staffRoleLabel_', 'staffTillsText_', 'staffBadge_', 'staffRowHTML_', 'renderStaffAdminTab',
  'staffSheetHTML_', 'staffPinFieldsHTML_', 'staffPinPair_', 'staffFormValues_', 'staffRateChanged_', 'ratePreviewText_', 'staffSkippedText_',
  'staffSavedText_', 'openStaffSheet_', 'openStaffPinSheet_'];
const ASYNC = { loadStaffAdminTab: true };
const consts = js => /  const STAFF_ROLES = [^\n]*\n  const STAFF_TILLS = [^\n]*\n/.exec(js)[0];

const pending = [];
H.uiScripts().forEach(([label, js]) => {
  t.section('Against ' + label);

  // ── The drawer entry ──────────────────────────────────────
  {
    const lifted = /const ALL_ROLES = [^\n]*\n  const MORE_ITEMS = \[[\s\S]*?\n  \];/.exec(js)[0];
    const items = new Function(lifted + '; return MORE_ITEMS;')();
    const entry = items.filter(i => i.tab === 'staff');
    t.eq('one Staff entry in the real MORE_ITEMS', entry.length, 1);
    t.ok('it is opsOnly', entry[0].opsOnly === true);
    t.eq('for admin and manager', entry[0].roles, ['admin', 'manager']);
    t.ok('written on one line, as the build reads the list', /^\s*\{ tab: 'staff'.*opsOnly: true \},\s*$/m.test(js));
    const pick = new Function(H.fnSource(js, 'moreItemsFor_') + '; return moreItemsFor_;')();
    const has = (role, ops) => pick(items, role, ops).some(i => i.tab === 'staff');
    t.eq('offered in the Operations app to admin and manager only',
      ['admin', 'manager', 'payroll_admin', 'employee'].map(r => has(r, true)), [true, true, false, false]);
    t.eq('hidden inside Apps Script from everyone', ['admin', 'manager', 'payroll_admin', 'employee'].map(r => has(r, false)), [false, false, false, false]);
    t.ok('a drawer tab with a title, a loader and a view',
      /const DRAWER_TABS = \[[^\]]*'staff'/.test(js) && /staff: 'Staff'/.test(H.fnSource(js, 'switchTab')) && /staff:\s*loadStaffAdminTab\b/.test(H.fnSource(js, 'tabLoaders_')));
    const own = OWN.map(n => H.fnSource(js, n)).join('\n');
    const count = (s, n) => s.split(n).length - 1;
    t.eq('the five calls are named only inside the screen\'s own functions',
      ['rpcGetStaffAdmin', 'rpcCreateStaff', 'rpcUpdateStaff', 'rpcPreviewRateChange', 'rpcSetStaffPin'].map(n => count(js, n) > 0 && count(js, n) === count(own, n)), [true, true, true, true, true]);
    t.ok('no var in the screen (it would hoist over a module helper)', !/\bvar\b/.test(own));
    t.ok('no localStorage or sessionStorage in the screen', !/localStorage|sessionStorage/.test(own));
  }

  // A world with the page's real call/cachedCall over a google.script.run stub, and stubs for the rest.
  const lifted = [consts(js), 'const rpcCache = new Map(); const rpcInflight = new Map(); const TTL_SEMI = 300000;',
    ...['_ckey', 'isReadMethod_', 'call', 'cachedCall', 'cacheFresh', 'esc', 'money'].map(n => (n === 'cachedCall' ? 'async ' : '') + H.fnSource(js, n)),
    ...OWN.map(n => (ASYNC[n] ? 'async ' : '') + H.fnSource(js, n))].join('\n\n');
  function world(opts) {
    let dom = DOM.fromHTML('');
    const checks = [];
    // The list view: what is rendered into it becomes the elements $ finds (the Add button).
    let viewHTML = '';
    const view = { get innerHTML() { return viewHTML; }, set innerHTML(h) { viewHTML = h; dom = DOM.fromHTML(h); }, querySelectorAll: () => [] };
    const w = {
      sheets: [], sent: [], toasts: [], stored: [],
      console: { log() {}, error() {}, warn() {} },
      Intl, Date, Math, Number, String, JSON, isNaN, Promise, Map, Error, setTimeout,
      window: { STOREOPS_APP: 'ops' },
      navigator: {},
      localStorage: { setItem: (k, v) => w.stored.push([k, v]), getItem: () => null, removeItem() {} },
      document: { querySelectorAll: sel => (sel === '[data-staff-till]' ? checks : []) },
      state: { token: 'tok', me: { role: opts.role } },
      $: id => (id === 'view-staff' ? view : dom.$(id)),
      view,
      dom: () => dom,
      checks,
      openSheet: spec => {
        w.sheets.push(spec);
        dom = DOM.fromHTML(String(spec.bodyHTML) + String(spec.actionsHTML || ''));
        checks.length = 0;
        (String(spec.bodyHTML).match(/data-staff-till="[a-z]+"[^>]*/g) || []).forEach(m => checks.push({ dataset: { staffTill: /"([a-z]+)"/.exec(m)[1] }, checked: / checked/.test(m) }));
      },
      closeSheet: () => {},
      haptic: () => {},
      moreBack: () => '',
      toast: (m, k) => w.toasts.push([m, k]),
      handleRpcError: e => w.toasts.push([e.message, 'error']),
      google: { script: { run: null } },
    };
    // google.script.run: records what was sent and answers from opts.answer.
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

  // ── What the sheet holds, by role ─────────────────────────
  {
    const w = world({ role: 'manager' });
    const build = fn(w, 'staffSheetHTML_');
    const mgr = build('manager', null);
    const adminAdd = build('admin', null);
    const adminEdit = build('admin', { staffId: 'S_003', name: 'Cleo Marsh', role: 'employee', companies: ['cstore'], hourlyRate: null, startDate: '', email: '', notes: '', active: true });
    const ids = html => (html.match(/\bid="([^"]+)"/g) || []).map(s => /"([^"]+)"/.exec(s)[1]);
    t.eq('a manager\'s add: name, tills, start date and the PIN twice, nothing else', ids(mgr), ['staffName', 'staffStart', 'staffPin', 'staffPin2', 'staffErr']);
    t.ok('a manager\'s add has no rate field and no role choice (not even hidden)', !/staffRate|staffRole|<select|rate|Role/i.test(mgr.replace(/data-staff-till/g, '')));
    t.ok('a manager\'s add offers both tills', /data-staff-till="cstore"/.test(mgr) && /data-staff-till="vape"/.test(mgr));
    t.eq('an admin\'s add has every field', ids(adminAdd), ['staffName', 'staffRole', 'staffRate', 'staffStart', 'staffEmail', 'staffNotes', 'staffPin', 'staffPin2', 'staffErr']);
    t.ok('an admin\'s change has the apply-from date (hidden until the rate changes) and a reason, and no PIN box',
      /id="staffApplyWrap" style="display:none"/.test(adminEdit) && ids(adminEdit).indexOf('staffApplyFrom') !== -1 && ids(adminEdit).indexOf('staffReason') !== -1 && ids(adminEdit).indexOf('staffPin') === -1);
    t.ok('a blank rate is an empty box with "no rate set" as its hint, never 0', /id="staffRate" value="" placeholder="no rate set"/.test(adminEdit));
    const pinBoxes = mgr.match(/<input[^>]*id="staffPin2?"[^>]*>/g) || [];
    t.ok('both PIN boxes are password boxes, numeric, new-password', pinBoxes.length === 2 && pinBoxes.every(b => /type="password"/.test(b) && /inputmode="numeric"/.test(b) && /autocomplete="new-password"/.test(b)));
    t.ok('the PIN boxes start empty', pinBoxes.every(b => /value=""/.test(b)));
    t.ok('a hostile name is escaped', build('admin', { staffId: 'S_9', name: '"><img src=x onerror=1>', role: 'employee', companies: [], hourlyRate: 1, active: true }).indexOf('<img') === -1);
  }

  // ── The list ──────────────────────────────────────────────
  {
    const w = world({ role: 'admin' });
    t.eq('staffRateText_: blank is words, a real zero is $0.00', [null, undefined, '', 0, 18.5].map(fn(w, 'staffRateText_')), ['no rate set', 'no rate set', 'no rate set', '$0.00/h', '$18.50/h']);
    fn(w, 'renderStaffAdminTab')({
      viewerRole: 'admin', cashManagerStaffId: 'S_002',
      staff: [
        { staffId: 'S_004', name: 'Dara Vance', role: 'employee', companies: ['vape'], active: true, hourlyRate: null, hasPin: false, lockedOut: false, openTills: [], cashHeld: 0, email: '', notes: '', startDate: null },
        { staffId: 'S_005', name: 'Eli <b>Stone</b>', role: 'employee', companies: ['vape'], active: true, hourlyRate: 18, hasPin: true, lockedOut: true, openTills: ['vape'], cashHeld: 212.5, email: '', notes: '', startDate: null },
        { staffId: 'S_007', name: 'Gus Lowe', role: 'employee', companies: [], active: false, hourlyRate: 19, hasPin: true, lockedOut: false, openTills: [], cashHeld: 0, email: '', notes: '', startDate: null },
      ],
    });
    const h = w.view.innerHTML;
    t.ok('an admin\'s list: a blank rate reads "no rate set", not $0.00', h.indexOf('no rate set') !== -1 && h.indexOf('$0.00') === -1);
    t.ok('badges: no PIN, locked out, till open, holds cash, inactive', ['no PIN', 'locked out', 'vape till open', 'holds $212.50', 'inactive'].every(b => h.indexOf(b) !== -1));
    t.ok('an inactive person is greyed', /data-staff-id="S_007"[^>]*opacity:\.55/.test(h));
    t.ok('names are escaped', h.indexOf('<b>') === -1 && h.indexOf('&lt;b&gt;') !== -1);
    t.ok('an Add a person button', h.indexOf('id="staffAddBtn"') !== -1 && h.indexOf('Add a person') !== -1);

    const m = world({ role: 'manager' });
    fn(m, 'renderStaffAdminTab')({ viewerRole: 'manager', staff: [{ staffId: 'S_003', name: 'Cleo Marsh', role: 'employee', companies: ['cstore'], active: true, hasPin: true }] });
    const mh = m.view.innerHTML;
    t.ok('a manager\'s list: name, role and till, no rate in any form', mh.indexOf('Cleo Marsh') !== -1 && mh.indexOf('Employee · cstore') !== -1 && !/\$|no rate set|\/h|hourly/i.test(mh));
    t.ok('a manager\'s rows open nothing (no data-staff-id to tap)', mh.indexOf('data-staff-id') === -1);
  }

  // ── The words ─────────────────────────────────────────────
  {
    const w = world({ role: 'admin' });
    const pv = fn(w, 'ratePreviewText_');
    t.eq('the preview sentence', pv({ days: 4, owedBefore: 160, owedAfter: 418, skippedPaid: [{ date: '2026-05-18', paid: 160 }, { date: '2026-05-19', paid: 50 }] }),
      '4 days: owed for them goes from $160.00 to $418.00. 2 paid days are left as they are (2026-05-18 $160.00, 2026-05-19 $50.00).');
    t.eq('no days', pv({ days: 0, owedBefore: null, owedAfter: null, skippedPaid: [] }), 'No unpaid days from then: nothing is re-rated.');
    const saved = fn(w, 'staffSavedText_');
    t.eq('after a raise', saved({ record: { name: 'Cleo Marsh', active: true }, changed: true, daysChanged: 4, owedBefore: 160, owedAfter: 418, skippedPaid: [{}, {}], cashHeld: 0 }),
      'Cleo Marsh saved. 4 unpaid days re-rated: owed for them went from $160.00 to $418.00. 2 paid days were left as they were.');
    t.eq('after a deactivation of someone holding cash', saved({ record: { name: 'Eli Stone', active: false }, changed: true, daysChanged: 0, owedBefore: null, owedAfter: null, skippedPaid: [], cashHeld: 212.5 }),
      'Eli Stone saved. Eli Stone still holds $212.50 of shop cash: it stays on the Cash screen under their name.');
    t.ok('rate changed: blank to a number, a number to blank, 18 vs 18.00 is no change',
      [fn(w, 'staffRateChanged_')({ hourlyRate: null }, '18'), fn(w, 'staffRateChanged_')({ hourlyRate: 18 }, ''), fn(w, 'staffRateChanged_')({ hourlyRate: 18 }, '18.00')].join() === 'true,true,false');
  }

  // ── The PIN goes to the server and nowhere else ───────────
  pending.push((async () => {
    const w = world({ role: 'admin', answer: (m, args) => (m === 'rpcCreateStaff' ? { staffId: 'S_008', name: args[1].name, role: 'employee', active: true } : m === 'rpcSetStaffPin' ? { staffId: 'S_005', sessionsEnded: 2, lockoutCleared: true } : { viewerRole: 'admin', staff: [], cashManagerStaffId: null }) });
    fn(w, 'openStaffSheet_')('admin', null);
    const d = w.dom();
    d.get('staffName').value = 'Hana Park';
    d.get('staffRole').value = 'employee';
    d.get('staffRate').value = '';
    d.get('staffStart').value = '';
    d.get('staffEmail').value = '';
    d.get('staffNotes').value = '';
    d.get('staffPin').value = PIN;
    d.get('staffPin2').value = PIN + '0';
    d.fire(d.get('staffSaveBtn'), 'click');
    await tick();
    t.eq(label + ': two different PINs send nothing and say so', [w.sent.length, d.get('staffErr').textContent], [0, 'The two PINs are not the same.']);
    d.get('staffPin2').value = PIN;
    w.checks[0].checked = true; // cstore
    d.fire(d.get('staffSaveBtn'), 'click');
    await tick();
    await tick();
    const create = w.sent.find(c => c[0] === 'rpcCreateStaff');
    t.eq(label + ': the add sends every field with the PIN', create && create[2], { name: 'Hana Park', companies: ['cstore'], startDate: '', role: 'employee', hourlyRate: '', email: '', notes: '', pin: PIN });

    fn(w, 'openStaffPinSheet_')({ staffId: 'S_005', name: 'Eli Stone' });
    const d2 = w.dom();
    d2.get('staffPin').value = PIN;
    d2.get('staffPin2').value = PIN;
    d2.fire(d2.get('staffPinSave'), 'click');
    await tick();
    await tick();
    t.eq(label + ': set PIN sends staffId and pin', (w.sent.find(c => c[0] === 'rpcSetStaffPin') || [])[2], { staffId: 'S_005', pin: PIN });
    const cache = JSON.stringify([...vm.runInContext('rpcCache', w).entries()]);
    t.ok(label + ': the read cache was used (the list reloaded) and holds no PIN', cache.indexOf('rpcGetStaffAdmin') !== -1 && cache.indexOf(PIN) === -1);
    t.ok(label + ': no toast holds the PIN', w.toasts.length >= 2 && JSON.stringify(w.toasts).indexOf(PIN) === -1);
    t.ok(label + ': nothing is written to localStorage', w.stored.length === 0);
    t.ok(label + ': no sheet\'s markup holds the PIN', JSON.stringify(w.sheets).indexOf(PIN) === -1);
  })());

  // ── A manager's add sends no role, rate, email or notes ───
  pending.push((async () => {
    const w = world({ role: 'manager', answer: () => ({ staffId: 'S_008', name: 'Hana Park', role: 'employee', active: true }) });
    fn(w, 'openStaffSheet_')('manager', null);
    const d = w.dom();
    d.get('staffName').value = 'Hana Park';
    d.get('staffStart').value = '2026-06-15';
    d.get('staffPin').value = '4826';
    d.get('staffPin2').value = '4826';
    d.fire(d.get('staffSaveBtn'), 'click');
    await tick();
    const create = w.sent.find(c => c[0] === 'rpcCreateStaff');
    t.eq(label + ': a manager\'s add sends name, tills, start date and PIN only', create && Object.keys(create[2]).sort(), ['companies', 'name', 'pin', 'startDate']);
  })());

  // ── A raise: the preview is asked for, then the save carries the date ──
  pending.push((async () => {
    const person = { staffId: 'S_003', name: 'Cleo Marsh', role: 'employee', companies: ['cstore'], hourlyRate: 20, startDate: '', email: '', notes: '', active: true };
    const w = world({ role: 'admin', answer: m => (m === 'rpcPreviewRateChange' ? { days: 4, owedBefore: 160, owedAfter: 418, skippedPaid: [] } : m === 'rpcUpdateStaff' ? { record: { name: 'Cleo Marsh', staffId: 'S_003', active: true }, changed: true, daysChanged: 4, owedBefore: 160, owedAfter: 418, skippedPaid: [], cashHeld: 0 } : { viewerRole: 'admin', staff: [] }) });
    fn(w, 'openStaffSheet_')('admin', person);
    const d = w.dom();
    t.eq(label + ': the apply-from date is hidden while the rate is unchanged', d.get('staffApplyWrap').style.display, 'none');
    d.get('staffRate').value = '22';
    d.fire(d.get('staffRate'), 'input');
    t.eq(label + ': and shown once it changes', d.get('staffApplyWrap').style.display, '');
    d.get('staffApplyFrom').value = '2026-05-15';
    d.fire(d.get('staffApplyFrom'), 'change');
    await tick();
    t.eq(label + ': the preview is asked for and shown', [(w.sent.find(c => c[0] === 'rpcPreviewRateChange') || [])[2], d.get('staffPreview').textContent],
      [{ staffId: 'S_003', hourlyRate: '22', applyRateFrom: '2026-05-15' }, '4 days: owed for them goes from $160.00 to $418.00.']);
    d.get('staffRole').value = 'employee'; // the stub has no <option selected>: set what the browser would read
    d.get('staffReason').value = 'Raise from mid-May';
    d.fire(d.get('staffSaveBtn'), 'click');
    await tick();
    const up = (w.sent.find(c => c[0] === 'rpcUpdateStaff') || [])[2];
    t.eq(label + ': the save sends every field, the date and the reason', up, { name: 'Cleo Marsh', companies: ['cstore'], startDate: '', role: 'employee', hourlyRate: '22', email: '', notes: '', staffId: 'S_003', active: true, applyRateFrom: '2026-05-15', reason: 'Raise from mid-May' });
    t.ok(label + ': and says what changed in words', /4 unpaid days re-rated: owed for them went from \$160\.00 to \$418\.00/.test(w.sheets[w.sheets.length - 1].bodyHTML));
  })());
});

// ── The built Operations page carries the screen; Apps Script hides it ──
{
  t.section('The two apps');
  const built = require('child_process').execFileSync(process.execPath, [path.join(H.REPO, 'ops', 'tools', 'build-ui.mjs'), '--stdout'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  t.ok('the built page has the view, the loader and the opsOnly entry', built.indexOf('<div class="view" id="view-staff"></div>') !== -1 && built.indexOf('async function loadStaffAdminTab(') !== -1 && /\{ tab: 'staff'[^\n]*opsOnly: true/.test(built));
  t.ok('the built page sets the Operations marker (transport loaded)', built.indexOf('<script src="/transport.js"></script>') !== -1);
  const src = fs.readFileSync(path.join(H.SRC, 'Index.html'), 'utf8');
  t.ok('the Apps Script page never loads the transport, so isOpsApp_ is false there and the entry is hidden', src.indexOf('/transport.js') === -1);
  t.ok('no template tag in the page', src.indexOf('<?') === -1);
}

Promise.all(pending).then(() => t.done()).catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
