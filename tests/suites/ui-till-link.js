// ============================================================
//  ui-till-link — "Till logins" on the Staff screen, and the key warning
//  on Settings (Operations app only; admin only)
// ============================================================
//  Card P5-02b; ADR-0023, ADR-0024. These assertions run the page's own
//  functions, lifted from both copies of the page (src/Index.html and the
//  Worker's built ops/public/index.html):
//   - the section is loaded for an admin in the Operations app ONLY: a
//     manager's Staff screen makes no till call and has no section, and
//     inside Apps Script nothing changes;
//   - each state of the link renders its own message and, when the till
//     cannot be read, no matching control at all, with the stored matches
//     shown read-only;
//   - a suggestion ("Match to X?") sends nothing: it opens a confirm, and
//     only the Match button in it calls the server;
//   - the key's expiry warning sits at the top of the section and above
//     the Till group on Settings, and only when the server says warn;
//   - everything the server sent is escaped; no var, no storage;
//   - the built Operations page carries the section.
// ============================================================
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const H = require('./_lib/harness');
const DOM = require('./_lib/dom');
const t = H.suite('Till logins — Staff screen and Settings, Operations app');

const OWN = ['tillWarnHTML_', 'tillRoleText_', 'tillDay_', 'tillStoreLineHTML_', 'tillPersonHTML_', 'tillSectionHTML_', 'loadTillSection_', 'renderTillSection_',
  'tillSheetFail_', 'openTillMatchSheet_', 'openTillUnlinkSheet_', 'openTillStoreSheet_'];
const ASYNC = { loadTillSection_: true, loadStaffAdminTab: true };
const consts = js => /  const STAFF_ROLES = [^\n]*\n  const STAFF_TILLS = [^\n]*\n/.exec(js)[0] + /  const TILL_ERR_ = [^\n]*\n/.exec(js)[0];
const MAYA = '11111111-aaaa-4aaa-8aaa-000000000003';
const DANIEL = '11111111-aaaa-4aaa-8aaa-000000000002';
const CASEY = '11111111-aaaa-4aaa-8aaa-000000000004';
const TILL_STORE = '5b0a1c52-7d3e-4c1f-9a10-0a1b2c3d4e01';

const KEY_OK = { day: '2027-03-01', daysLeft: 94, warn: false, recorded: true, message: null };
const KEY_WARN = { day: '2026-12-05', daysLeft: 8, warn: true, recorded: true, message: 'The till\'s key expires on 2026-12-05 (in 8 days). Make a new key in the till\'s Office and install it, then change the date in Settings.' };
const person = (staffId, name, over) => Object.assign({ staffId, name, active: true, link: null, suggestion: null }, over || {});
const link = (id, name, over) => Object.assign({ tillStaffId: id, tillName: name, tillRole: 'store_manager', matchedAt: '2026-11-20T15:00:00.000Z', lastSeenAt: '2026-11-26T15:00:00.000Z', inTillList: true }, over || {});
const okData = (over) => Object.assign({
  state: 'ok', message: 'The till answered.', keyExpiry: KEY_OK,
  stores: [{ storeId: 'store_main', name: 'Main store', tillStore: { id: TILL_STORE, name: 'Fictional Corner Store' } }],
  tillStores: [{ id: TILL_STORE, name: 'Fictional Corner Store', code: 'FIC1', active: true }],
  people: [
    person('S_003', 'Maya Chen', { link: link(MAYA, 'Maya Chen', { tillRole: 'cashier' }) }),
    person('S_002', 'Daniel Okafor', { suggestion: { tillStaffId: DANIEL, tillName: 'Daniel Okafor' } }),
    person('S_004', 'Eli Stone'),
  ],
  unmatchedTillPeople: [
    { tillStaffId: DANIEL, name: 'Daniel Okafor', role: 'store_manager', active: true },
    { tillStaffId: CASEY, name: 'Casey Lindqvist', role: 'cashier', active: false },
  ],
}, over || {});
const STATES = [
  ['off', 'The link to the till is switched off (Settings, Till). Sign-in and everything else work as usual.'],
  ['not_configured', 'The link to the till is switched on but not set up: it needs the till\'s address in Settings and the key installed.'],
  ['unreachable', 'The till could not be reached just now (it may be down). What is saved is shown; try again later.'],
  ['refused', 'The till did not accept the key. It may have expired or been withdrawn: install a new one.'],
  ['bad_answer', 'The till answered with something this app does not understand. Nothing was changed; tell whoever looks after the till link.'],
];
const notOk = (state, message) => Object.assign(okData(), { state, message, tillStores: [], unmatchedTillPeople: [], people: [
  person('S_003', 'Maya Chen', { link: link(MAYA, 'Maya Chen', { tillRole: 'cashier', inTillList: null }) }),
  person('S_002', 'Daniel Okafor'),
] });

const pending = [];
const tick = () => new Promise(r => setImmediate(r)).then(() => new Promise(r => setImmediate(r)));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

H.uiScripts().forEach(([label, js]) => {
  t.section('Against ' + label);

  const own = OWN.map(n => H.fnSource(js, n)).join('\n');
  const count = (s, n) => s.split(n).length - 1;
  t.eq('the four calls are named only inside the section\'s own functions',
    ['rpcGetTillLink', 'rpcSetTillStore', 'rpcLinkTillStaff', 'rpcUnlinkTillStaff'].map(n => count(js, n) > 0 && count(js, n) === count(own, n)), [true, true, true, true]);
  t.ok('no var in the section (it would hoist over a module helper)', !/\bvar\b/.test(own));
  t.ok('no localStorage or sessionStorage in the section', !/localStorage|sessionStorage/.test(own));
  t.ok('no template tag in the section', own.indexOf('<?') === -1);
  t.ok('the Staff loader asks for the section only for an admin in the Operations app', /data\.viewerRole === 'admin' && isOpsApp_\(\)/.test(H.fnSource(js, 'loadStaffAdminTab')));

  // A world with the page's real call/cachedCall over a google.script.run stub, and stubs for the rest.
  const lifted = [consts(js), 'const rpcCache = new Map(); const rpcInflight = new Map(); const TTL_SEMI = 300000;',
    ...['_ckey', 'isReadMethod_', 'call', 'cachedCall', 'cacheFresh', 'esc', 'money', 'isOpsApp_', 'staffBadge_', 'staffRoleLabel_', 'staffTillsText_', 'staffRateText_', 'staffRowHTML_', 'renderStaffAdminTab', 'loadStaffAdminTab']
      .map(n => (ASYNC[n] ? 'async ' : '') + (n === 'cachedCall' ? 'async ' : '') + H.fnSource(js, n)),
    ...OWN.map(n => (ASYNC[n] ? 'async ' : '') + H.fnSource(js, n))].join('\n\n');

  function world(opts) {
    let dom = DOM.fromHTML('');
    let viewHTML = '';
    let boxMade = false;
    const w = { sheets: [], sent: [], toasts: [], stored: [], inserted: [], boxes: [] };
    // The till section's box: rendering into it makes the stubs for its controls.
    const makeBox = () => {
      let html = '';
      const box = {
        get innerHTML() { return html; },
        set innerHTML(h) { html = h; box.dom = DOM.fromHTML(h); box.stubs = null; w.boxes.push(h); },
        dom: DOM.fromHTML(''),
        stubs: null,
        querySelectorAll(sel) {
          if (sel !== '[data-till-act]') return [];
          const out = [];
          const re = /<[a-z]+ [^>]*data-till-act="([a-z]+)"[^>]*>/g;
          let m;
          while ((m = re.exec(html))) {
            const staff = /data-staff-id="([^"]*)"/.exec(m[0]);
            const store = /data-store-id="([^"]*)"/.exec(m[0]);
            out.push({ dataset: { tillAct: m[1], staffId: staff && staff[1], storeId: store && store[1] }, onclick: null });
          }
          box.stubs = out;
          return out;
        },
        click(act, staffId) {
          const s = (box.stubs || []).find(x => x.dataset.tillAct === act && (staffId === undefined || x.dataset.staffId === staffId || x.dataset.storeId === staffId));
          if (!s) throw new Error('no control ' + act + ' ' + staffId);
          return s.onclick({ stopPropagation() { w.stopped = true; } });
        },
      };
      return box;
    };
    const box = makeBox();
    const view = {
      get innerHTML() { return viewHTML; },
      set innerHTML(h) { viewHTML = h; dom = DOM.fromHTML(h); boxMade = false; },
      querySelectorAll: () => [],
      insertAdjacentHTML(pos, h) { w.inserted.push([pos, h]); if (h.indexOf('id="staffTillSection"') !== -1) boxMade = true; },
    };
    Object.assign(w, {
      console: { log() {}, error() {}, warn() {} },
      Intl, Date, Math, Number, String, JSON, isNaN, Promise, Map, Error, setTimeout,
      window: opts.apps ? {} : { STOREOPS_APP: 'ops' },
      navigator: {},
      localStorage: { setItem: (k, v) => w.stored.push([k, v]), getItem: () => null, removeItem() {} },
      document: { querySelectorAll: () => [] },
      state: { token: 'tok', me: { role: opts.role } },
      $: id => (id === 'view-staff' ? view : id === 'staffTillSection' ? (boxMade ? box : null) : dom.$(id)),
      view, box,
      dom: () => dom,
      openSheet: spec => { w.sheets.push(spec); dom = DOM.fromHTML(String(spec.bodyHTML) + String(spec.actionsHTML || '')); },
      closeSheet: () => { w.closed = (w.closed || 0) + 1; },
      haptic: () => {},
      moreBack: () => '',
      toast: (m, k) => w.toasts.push([m, k]),
      handleRpcError: e => w.toasts.push([e.message, 'error']),
      google: { script: { run: null } },
    });
    const runner = () => {
      let ok = null;
      let bad = null;
      let proxy = null;
      const r = { withSuccessHandler(f) { ok = f; return proxy; }, withFailureHandler(f) { bad = f; return proxy; } };
      proxy = new Proxy(r, {
        get: (o, k) => (k in o ? o[k] : (...args) => {
          w.sent.push([k].concat(args));
          setImmediate(() => {
            const a = opts.answer ? opts.answer(k, args) : {};
            if (a instanceof Error) bad(a); else ok(a);
          });
        }),
      });
      return proxy;
    };
    Object.defineProperty(w.google.script, 'run', { get: runner });
    vm.createContext(w);
    vm.runInContext(lifted, w);
    return w;
  }
  const fn = (w, name) => vm.runInContext(name, w);
  const sentNames = w => w.sent.map(c => c[0]);

  const adminList = { viewerRole: 'admin', cashManagerStaffId: null, staff: [{ staffId: 'S_001', name: 'Priya Nair', role: 'admin', companies: ['cstore'], active: true, hourlyRate: 25, hasPin: true, lockedOut: false, openTills: [], cashHeld: 0, email: '', notes: '', startDate: null }] };
  const managerList = { viewerRole: 'manager', staff: [{ staffId: 'S_001', name: 'Priya Nair', role: 'admin', companies: ['cstore'], active: true, hasPin: true }] };

  // ── Who gets the section ──────────────────────────────────
  pending.push((async () => {
    const asAdmin = world({ role: 'admin', answer: m => (m === 'rpcGetStaffAdmin' ? adminList : m === 'rpcGetTillLink' ? okData() : {}) });
    await fn(asAdmin, 'loadStaffAdminTab')(true);
    await settle();
    t.eq(label + ': an admin in the Operations app: the list, then the till section, one call each', sentNames(asAdmin), ['rpcGetStaffAdmin', 'rpcGetTillLink']);
    t.ok(label + ': the section is added after the list, so the list is not rebuilt', asAdmin.inserted.length === 1 && asAdmin.inserted[0][0] === 'beforeend' && /id="staffTillSection"/.test(asAdmin.inserted[0][1]));
    t.ok(label + ': and it holds the Till logins heading and the store line', /Till logins/.test(asAdmin.box.innerHTML) && /Main store ↔ Fictional Corner Store/.test(asAdmin.box.innerHTML));
    t.eq(label + ': the call is made with the session token only', asAdmin.sent[1], ['rpcGetTillLink', 'tok']);

    const asManager = world({ role: 'manager', answer: m => (m === 'rpcGetStaffAdmin' ? managerList : okData()) });
    await fn(asManager, 'loadStaffAdminTab')(true);
    await settle();
    t.eq(label + ': a manager\'s Staff screen makes no till call', sentNames(asManager), ['rpcGetStaffAdmin']);
    t.ok(label + ': and has no till section', asManager.inserted.length === 0 && asManager.view.innerHTML.indexOf('Till logins') === -1 && asManager.view.innerHTML.indexOf('staffTillSection') === -1);

    const inAppsScript = world({ role: 'admin', apps: true, answer: m => (m === 'rpcGetStaffAdmin' ? adminList : okData()) });
    await fn(inAppsScript, 'loadStaffAdminTab')(true);
    await settle();
    t.eq(label + ': inside Apps Script, even for an admin, nothing changes', [sentNames(inAppsScript), inAppsScript.inserted.length], [['rpcGetStaffAdmin'], 0]);
  })());

  // ── A till call that fails is shown in the section only ───
  pending.push((async () => {
    const w = world({ role: 'admin', answer: m => (m === 'rpcGetStaffAdmin' ? adminList : new Error('SERVER_ERROR')) });
    await fn(w, 'loadStaffAdminTab')(true);
    await settle();
    t.ok(label + ': the Staff list is there, and the section says it could not be loaded', /Priya Nair/.test(w.view.innerHTML) && /could not be loaded: SERVER_ERROR/.test(w.box.innerHTML));
    const gone = world({ role: 'admin', answer: m => (m === 'rpcGetStaffAdmin' ? adminList : new Error('NOT_LOGGED_IN')) });
    await fn(gone, 'loadStaffAdminTab')(true);
    await settle();
    t.ok(label + ': a lost sign-in goes to the app\'s own handler', gone.toasts.some(x => /NOT_LOGGED_IN/.test(x[0])));
  })());

  // ── Each state ────────────────────────────────────────────
  {
    const w = world({ role: 'admin' });
    const html = fn(w, 'tillSectionHTML_');
    STATES.forEach(([state, message]) => {
      const h = html(notOk(state, message));
      t.ok(label + ': ' + state + ': its message is shown, as the server wrote it', h.indexOf(message.replace(/'/g, '&#39;')) !== -1 && h.indexOf('data-till-state="' + state + '"') !== -1);
      t.ok(label + ': ' + state + ': no matching control of any kind, not even for the store', h.indexOf('data-till-act') === -1 && h.indexOf('<button') === -1 && h.indexOf('<select') === -1);
      t.ok(label + ': ' + state + ': the stored match is shown, read-only', /Matched to Maya Chen \(till\)/.test(h) && /Main store ↔ Fictional Corner Store/.test(h));
      t.ok(label + ': ' + state + ': people with no match are not listed, and nothing from the till is', h.indexOf('Daniel Okafor') === -1 && h.indexOf('In the till, not matched here') === -1);
    });
    const ok = html(okData());
    t.ok(label + ': ok: no state line', ok.indexOf('data-till-state') === -1);
    t.ok(label + ': ok: the store line has a Change button', /data-till-act="store"[^>]*>Change</.test(ok));
    t.ok(label + ': ok: a matched person says who, role and last seen, and can be tapped to end it',
      /data-till-person="S_003" data-till-act="unlink"/.test(ok) && /Matched to Maya Chen \(till\) · cashier · last seen 2026-11-26/.test(ok));
    t.ok(label + ': ok: a suggestion is a button, and the person can be tapped to choose someone else',
      /data-till-act="suggest" data-staff-id="S_002"[^>]*>Match to Daniel Okafor\?</.test(ok) && /data-till-person="S_002" data-till-act="choose"/.test(ok));
    t.ok(label + ': ok: a person with no suggestion says "not matched" and can be tapped', /data-till-person="S_004" data-till-act="choose"[\s\S]*?not matched/.test(ok));
    t.ok(label + ': ok: the till\'s unmatched people are listed with the note that they are not created here',
      /In the till, not matched here/.test(ok) && /Casey Lindqvist/.test(ok) && /not active in the till/.test(ok) && /not created here/.test(ok));
    t.ok(label + ': ok: the unmatched list has no control: it creates nothing', !/data-till-unmatched="[^"]*"[^>]*data-till-act/.test(ok));
    t.eq(label + ': the till section never says "$" (no money here)', ok.indexOf('$'), -1);

    const gone = html(okData({ people: [person('S_003', 'Maya Chen', { link: link(MAYA, 'Maya Chen', { inTillList: false }) })], unmatchedTillPeople: [] }));
    t.ok(label + ': a match the till no longer lists is flagged, and can still be ended', /no longer in the till&#39;s list/.test(gone) && /data-till-act="unlink"/.test(gone));
    const noStore = html(okData({ stores: [{ storeId: 'store_main', name: 'Main store', tillStore: null }], people: [person('S_003', 'Maya Chen')], unmatchedTillPeople: [] }));
    t.ok(label + ': ok but no store matched: Choose, a hint, and no people to match', /not matched to a till store/.test(noStore) && />Choose</.test(noStore) && /Match the store first/.test(noStore) && noStore.indexOf('data-till-person') === -1);
    const inactive = html(okData({ people: [person('S_006', 'Gus Lowe', { active: false })], unmatchedTillPeople: [] }));
    t.ok(label + ': an inactive person is listed, marked inactive, and can be matched', /inactive/.test(inactive) && /data-till-person="S_006" data-till-act="choose"/.test(inactive));
    t.eq(label + ': no warning when the server says none', [html(okData()).indexOf('data-till-warning'), html(notOk('off', 'x')).indexOf('data-till-warning')], [-1, -1]);
    const warned = html(okData({ keyExpiry: KEY_WARN }));
    t.ok(label + ': the warning is the first thing under the heading, as the server wrote it', warned.indexOf('Till logins') < warned.indexOf('data-till-warning') && warned.indexOf('data-till-warning') < warned.indexOf('Main store') && warned.indexOf('expires on 2026-12-05 (in 8 days)') !== -1);
    const blank = html(okData({ keyExpiry: { day: null, daysLeft: null, warn: true, recorded: false, message: 'The key\'s expiry date is not recorded: type it into Settings (Till) when a key is installed.' } }));
    t.ok(label + ': a date not recorded is a warning too', /expiry date is not recorded/.test(blank));
    const offWarn = html(Object.assign(notOk('off', STATES[0][1]), { keyExpiry: KEY_WARN }));
    t.ok(label + ': the warning shows whatever the state is', offWarn.indexOf('data-till-warning') !== -1);
  }

  // ── Everything from the server is escaped ─────────────────
  {
    const w = world({ role: 'admin' });
    const evil = '"><img src=x onerror=alert(1)>';
    const h = fn(w, 'tillSectionHTML_')(okData({
      message: evil, keyExpiry: Object.assign({}, KEY_WARN, { message: evil }),
      stores: [{ storeId: evil, name: evil, tillStore: { id: evil, name: evil } }],
      people: [person(evil, evil, { link: link(evil, evil, { tillRole: evil, lastSeenAt: evil }) }), person('S_9', evil, { suggestion: { tillStaffId: evil, tillName: evil } })],
      unmatchedTillPeople: [{ tillStaffId: evil, name: evil, role: evil, active: true }],
    }));
    t.ok(label + ': a hostile name, role, id, store and message are all escaped', h.indexOf('<img') === -1 && h.indexOf('&lt;img') !== -1 && h.indexOf('onerror=alert(1)>') === -1);
    const bad = fn(w, 'tillSectionHTML_')(notOk('refused', evil));
    t.ok(label + ': and so is a state\'s message', bad.indexOf('<img') === -1);
  }

  // ── A suggestion needs a confirm ──────────────────────────
  pending.push((async () => {
    const w = world({ role: 'admin', answer: (m) => (m === 'rpcLinkTillStaff' ? { staffId: 'S_002', name: 'Daniel Okafor', link: link(DANIEL, 'Daniel Okafor') } : m === 'rpcGetTillLink' ? okData() : {}) });
    w.view.innerHTML = '<div></div>';
    w.view.insertAdjacentHTML('beforeend', '<div id="staffTillSection"></div>');
    const data = okData();
    fn(w, 'renderTillSection_')(data);
    w.box.click('suggest', 'S_002');
    t.eq(label + ': tapping "Match to Daniel Okafor?" sends nothing and opens a confirm', [w.sent.length, w.sheets.length], [0, 1]);
    t.ok(label + ': the confirm names both people and says they are the same', /Match <b>Daniel Okafor<\/b> here to <b>Daniel Okafor<\/b> in the till \(store manager\)\? You are saying they are the same person/.test(w.sheets[0].bodyHTML));
    t.ok(label + ': the tap did not also open the row\'s own chooser', w.stopped === true && w.sheets.length === 1);
    w.dom().fire(w.dom().get('tillMatchBtn'), 'click');
    await settle();
    t.eq(label + ': only the Match button calls the server, with the two ids and nothing else', w.sent.filter(c => c[0] === 'rpcLinkTillStaff'), [['rpcLinkTillStaff', 'tok', { staffId: 'S_002', tillStaffId: DANIEL }]]);
    t.ok(label + ': then it closes, says so, and loads the section again', w.closed === 1 && w.toasts.some(x => /Daniel Okafor matched to Daniel Okafor \(till\)/.test(x[0])) && sentNames(w).indexOf('rpcGetTillLink') !== -1);
  })());

  pending.push((async () => {
    const w = world({ role: 'admin', answer: () => new Error('Maya Chen is already matched to Maya Chen.') });
    w.view.insertAdjacentHTML('beforeend', '<div id="staffTillSection"></div>');
    const data = okData();
    fn(w, 'renderTillSection_')(data);
    w.box.click('suggest', 'S_002');
    w.dom().fire(w.dom().get('tillMatchBtn'), 'click');
    await settle();
    t.ok(label + ': a refusal is shown in the sheet as written, the sheet stays open and the button comes back', w.dom().get('tillErr').textContent === 'Maya Chen is already matched to Maya Chen.' && !w.closed && w.dom().get('tillMatchBtn').disabled === false);
  })());

  // ── Choosing someone else ─────────────────────────────────
  pending.push((async () => {
    const w = world({ role: 'admin', answer: (m) => (m === 'rpcLinkTillStaff' ? { staffId: 'S_004', name: 'Eli Stone', link: link(CASEY, 'Casey Lindqvist', { tillRole: 'cashier' }) } : okData()) });
    w.view.insertAdjacentHTML('beforeend', '<div id="staffTillSection"></div>');
    fn(w, 'renderTillSection_')(okData());
    w.box.click('choose', 'S_004');
    const d = w.dom();
    t.ok(label + ': tapping "not matched" offers the till\'s unmatched people, none chosen, and says nobody is created',
      /<option value="">Choose…/.test(w.sheets[0].bodyHTML) && w.sheets[0].bodyHTML.indexOf('value="' + CASEY + '"') !== -1 && /nobody is created from the till/.test(w.sheets[0].bodyHTML) && w.sheets[0].bodyHTML.indexOf('selected') === -1);
    d.fire(d.get('tillMatchBtn'), 'click');
    await settle();
    t.eq(label + ': pressing Match with nobody chosen sends nothing and says so', [w.sent.length, d.get('tillErr').textContent], [0, 'Choose the person in the till.']);
    d.get('tillChoice').value = CASEY;
    d.fire(d.get('tillMatchBtn'), 'click');
    await settle();
    t.eq(label + ': the chosen till person goes with the person tapped', w.sent.find(c => c[0] === 'rpcLinkTillStaff'), ['rpcLinkTillStaff', 'tok', { staffId: 'S_004', tillStaffId: CASEY }]);
    // a person with a suggestion has it preselected
    const w2 = world({ role: 'admin' });
    fn(w2, 'openTillMatchSheet_')(okData(), okData().people[1], false);
    t.ok(label + ': the suggestion is preselected in the chooser', new RegExp('value="' + DANIEL + '" selected').test(w2.sheets[0].bodyHTML));
    const w3 = world({ role: 'admin' });
    fn(w3, 'openTillMatchSheet_')(okData({ unmatchedTillPeople: [] }), okData().people[2], false);
    t.ok(label + ': with nobody left in the till there is nothing to choose and no Match button', /Everyone in the till is already matched/.test(w3.sheets[0].bodyHTML) && w3.sheets[0].actionsHTML.indexOf('tillMatchBtn') === -1);
  })());

  // ── Ending a match ────────────────────────────────────────
  pending.push((async () => {
    const w = world({ role: 'admin', answer: (m) => (m === 'rpcUnlinkTillStaff' ? { staffId: 'S_003', name: 'Maya Chen', ended: true, tillStaffId: MAYA, tillName: 'Maya Chen' } : okData()) });
    w.view.insertAdjacentHTML('beforeend', '<div id="staffTillSection"></div>');
    fn(w, 'renderTillSection_')(okData());
    w.box.click('unlink', 'S_003');
    const d = w.dom();
    t.ok(label + ': tapping a matched person offers to end the match, and says it changes nothing in the till', /End this match/.test(w.sheets[0].actionsHTML) && /does not change anything in the till/.test(w.sheets[0].bodyHTML) && /Matched to Maya Chen \(till\)/.test(w.sheets[0].subtitle));
    d.get('tillReason').value = 'Left the till company';
    d.fire(d.get('tillUnlinkBtn'), 'click');
    await settle();
    t.eq(label + ': the reason goes with the person', w.sent.find(c => c[0] === 'rpcUnlinkTillStaff'), ['rpcUnlinkTillStaff', 'tok', { staffId: 'S_003', reason: 'Left the till company' }]);
    t.ok(label + ': and the section is loaded again', sentNames(w).indexOf('rpcGetTillLink') !== -1 && w.toasts.some(x => /no longer matched/.test(x[0])));
    const w2 = world({ role: 'admin', answer: () => new Error('A reason is needed: 3 to 300 characters, on one line.') });
    fn(w2, 'openTillUnlinkSheet_')(okData().people[0]);
    w2.dom().get('tillReason').value = 'x';
    w2.dom().fire(w2.dom().get('tillUnlinkBtn'), 'click');
    await settle();
    t.ok(label + ': a refused reason is shown as written', w2.dom().get('tillErr').textContent === 'A reason is needed: 3 to 300 characters, on one line.');
  })());

  // ── The store match ───────────────────────────────────────
  pending.push((async () => {
    const w = world({ role: 'admin', answer: (m, args) => (m === 'rpcSetTillStore' ? { storeId: 'store_main', tillStore: args[1].tillStoreId ? { id: TILL_STORE, name: 'Fictional Corner Store' } : null, changed: true } : okData()) });
    w.view.insertAdjacentHTML('beforeend', '<div id="staffTillSection"></div>');
    const unmatched = okData({ stores: [{ storeId: 'store_main', name: 'Main store', tillStore: null }] });
    fn(w, 'renderTillSection_')(unmatched);
    w.box.click('store', 'store_main');
    let d = w.dom();
    t.ok(label + ': the store sheet lists the till\'s stores', /<option value="">Choose…/.test(w.sheets[0].bodyHTML) && w.sheets[0].bodyHTML.indexOf('value="' + TILL_STORE + '"') !== -1);
    d.fire(d.get('tillStoreSave'), 'click');
    await settle();
    t.eq(label + ': Match with nothing chosen sends nothing', [w.sent.length, d.get('tillErr').textContent], [0, 'Choose the till\'s store.']);
    d.get('tillStoreChoice').value = TILL_STORE;
    d.fire(d.get('tillStoreSave'), 'click');
    await settle();
    t.eq(label + ': the match is sent with the store and the till store', w.sent.find(c => c[0] === 'rpcSetTillStore'), ['rpcSetTillStore', 'tok', { storeId: 'store_main', tillStoreId: TILL_STORE }]);

    const w2 = world({ role: 'admin', answer: (m) => (m === 'rpcSetTillStore' ? { storeId: 'store_main', tillStore: null, changed: true } : okData()) });
    w2.view.insertAdjacentHTML('beforeend', '<div id="staffTillSection"></div>');
    fn(w2, 'renderTillSection_')(okData());
    w2.box.click('store', 'store_main');
    t.ok(label + ': a matched store offers to end the match (and says to end it before choosing another)', /Fictional Corner Store/.test(w2.sheets[0].bodyHTML) && /end this match first/.test(w2.sheets[0].bodyHTML) && w2.sheets[0].actionsHTML.indexOf('tillStoreEnd') !== -1);
    w2.dom().fire(w2.dom().get('tillStoreEnd'), 'click');
    await settle();
    t.eq(label + ': ending sends a null till store', w2.sent.find(c => c[0] === 'rpcSetTillStore'), ['rpcSetTillStore', 'tok', { storeId: 'store_main', tillStoreId: null }]);

    const w3 = world({ role: 'admin', answer: () => new Error('1 person is matched through it: end their match first.') });
    w3.view.insertAdjacentHTML('beforeend', '<div id="staffTillSection"></div>');
    fn(w3, 'renderTillSection_')(okData());
    w3.box.click('store', 'store_main');
    w3.dom().fire(w3.dom().get('tillStoreEnd'), 'click');
    await settle();
    t.ok(label + ': the server\'s refusal is shown as written', w3.dom().get('tillErr').textContent === '1 person is matched through it: end their match first.');
  })());

  // ── Settings: the same warning, above the Till group ──────
  {
    const lifted2 = 'let backupNote_ = null;\n' + ['esc', 'settingShown_', 'tillWarnHTML_', 'backupLineHTML_', 'renderSettingsTab'].map(n => H.fnSource(js, n)).join('\n');
    const w = { document: {}, Date, Math, Number, String, JSON, console, moreBack: () => '', haptic() {}, $: null, state: { me: { role: 'admin' } } };
    let html = '';
    w.$ = () => ({ get innerHTML() { return html; }, set innerHTML(h) { html = h; }, querySelectorAll: () => [] });
    vm.createContext(w);
    vm.runInContext(lifted2, w);
    const settings = [
      { key: 'cash_manager_staff_id', value: null, default: '', blankReads: '', read: 'text', description: 'Cash manager', isDefault: true, group: 'Tills and cash' },
      { key: 'till_enabled', value: 'true', default: 'false', blankReads: 'false', read: 'boolean', description: 'Switch for the link to the till', isDefault: false, group: 'Till' },
      { key: 'till_api_url', value: null, default: '', blankReads: '', read: 'text', description: 'The till\'s address', isDefault: true, group: 'Till' },
      { key: 'commission_run_day', value: null, default: '0', blankReads: '0', read: 'number', description: 'Day', isDefault: true, group: 'Commissions' },
    ];
    const render = k => { vm.runInContext('renderSettingsTab', w)({ settings, other: [], secrets: [], tillKeyExpiry: k }); return html; };
    const warned = render(KEY_WARN);
    const till = warned.indexOf('>Till</div>');
    t.ok(label + ': Settings: the warning is under the Till heading and above its first setting', till !== -1 && warned.indexOf('data-till-warning') > till && warned.indexOf('data-till-warning') < warned.indexOf('data-setting-key="till_enabled"'));
    t.eq(label + ': Settings: once only, and not above the other groups', [warned.split('data-till-warning').length - 1, warned.indexOf('data-till-warning') > warned.indexOf('data-setting-key="cash_manager_staff_id"')], [1, true]);
    t.eq(label + ': Settings: no warning when the server says none, or says nothing', [render(KEY_OK).indexOf('data-till-warning'), render(undefined).indexOf('data-till-warning'), render(null).indexOf('data-till-warning')], [-1, -1, -1]);
    t.ok(label + ': Settings: the warning is the server\'s sentence', render(KEY_WARN).indexOf('expires on 2026-12-05 (in 8 days)') !== -1);
  }
});

// ── The built Operations page carries the section ─────────
{
  t.section('The two apps');
  const built = require('child_process').execFileSync(process.execPath, [path.join(H.REPO, 'ops', 'tools', 'build-ui.mjs'), '--stdout'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  t.ok('the built page has the till section\'s loader, renderer and sheets', ['async function loadTillSection_(', 'function renderTillSection_(', 'function tillSectionHTML_(', 'function openTillMatchSheet_(', 'function openTillUnlinkSheet_(', 'function openTillStoreSheet_(', 'function tillWarnHTML_('].every(s => built.indexOf(s) !== -1));
  t.ok('the built page asks for the section only for an admin in the Operations app', /data\.viewerRole === 'admin' && isOpsApp_\(\)/.test(built));
  t.ok('the built page puts the warning above the Till group on Settings', /if \(g\.name === 'Till'\) html \+= tillWarnHTML_\(data && data\.tillKeyExpiry\)/.test(built));
  const src = fs.readFileSync(path.join(H.SRC, 'Index.html'), 'utf8');
  t.ok('Apps Script never loads the transport, so the section is never asked for there', src.indexOf('/transport.js') === -1);
  t.ok('no template tag in the page', src.indexOf('<?') === -1 && built.indexOf('<?') === -1);
}

Promise.all(pending).then(() => t.done()).catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
