// ============================================================
//  ui-assistants — the Assistants screen (card P5-11)
// ============================================================
//  The Operations app's screen where an admin makes and withdraws the keys
//  AI assistants use at /mcp. It is opsOnly and admin only, and a new key
//  is shown ONCE: in the sheet and nowhere else. These assertions lift the
//  screen's real functions, with the page's real `call`/`cachedCall` and
//  read cache over a stubbed google.script.run, drive "make a key" end to
//  end, and look at everything the code wrote: the cache, toasts, storage,
//  the address bar, and the sheet after it closes.
// ============================================================
const fs = require('fs');
const path = require('path');
const H = require('./_lib/harness');
const t = H.suite('Assistants screen — keys shown once, opsOnly, admin only');

const SRC_HTML = fs.readFileSync(path.join(H.SRC, 'Index.html'), 'utf8');
const js = H.clientScript('Index.html');
const KEY = 'ops_ak0123456789abcdef_SECRETsecretSECRETsecretSECRETsecret0123';

(async () => {
  t.section('The drawer entry');
  const lifted = /const ALL_ROLES = [^\n]*\n  const MORE_ITEMS = \[[\s\S]*?\n  \];/.exec(js)[0];
  const items = new Function(lifted + '; return MORE_ITEMS;')();
  const entry = items.filter(i => i.tab === 'assistants');
  t.eq('one entry in the real MORE_ITEMS', entry.length, 1);
  t.ok('it is opsOnly', entry[0] && entry[0].opsOnly === true);
  t.eq('and admin only', entry[0] && entry[0].roles, ['admin']);
  t.ok('written on one line, as the build reads the list', /^\s*\{ tab: 'assistants'.*\},\s*$/m.test(js));
  const pick = new Function(H.fnSource(js, 'moreItemsFor_') + '; return moreItemsFor_;')();
  const has = (role, ops) => pick(items, role, ops).some(i => i.tab === 'assistants');
  t.eq('absent for an admin inside Apps Script', has('admin', false), false);
  t.eq('present for an admin in the Operations app', has('admin', true), true);
  t.eq('absent for the other three roles even there', ['manager', 'payroll_admin', 'employee'].map(r => has(r, true)), [false, false, false]);
  t.ok('a drawer tab with a loader, a title and a view',
    /const DRAWER_TABS = \[[^\]]*'assistants'/.test(js) &&
    /assistants:\s*loadAssistantsTab\b/.test(H.fnSource(js, 'tabLoaders_')) &&
    /assistants: 'Assistants'/.test(H.fnSource(js, 'switchTab')) &&
    SRC_HTML.indexOf('<div class="view" id="view-assistants"></div>') !== -1);

  const SCREEN = ['loadAssistantsTab', 'assistantWhen_', 'assistantStatus_', 'renderAssistantsTab', 'openMakeKeySheet', 'showNewKeySheet_', 'openWithdrawKeySheet'];
  // fnSource starts at "function name(": put back an "async" the page wrote in front of it.
  const lift = n => { const src = H.fnSource(js, n); return js.indexOf('async function ' + n + '(') !== -1 ? 'async ' + src : src; };
  const own = SCREEN.map(lift).join('\n');
  t.ok('no var in the screen (it would hoist over a module helper)', !/\bvar\b/.test(own));
  t.ok('no "<?" in the screen', own.indexOf('<?') === -1);
  const count = (s, n) => s.split(n).length - 1;
  t.eq('its three calls are named only inside its own functions',
    ['rpcGetAssistantKeys', 'rpcCreateAssistantKey', 'rpcRevokeAssistantKey'].map(n => count(js, n) === count(own, n) && count(js, n) > 0), [true, true, true]);
  t.ok('the page never stores, routes or logs a key: no localStorage, history, location.hash or console in the screen',
    !/localStorage|sessionStorage|history\.|location\.hash|location\.href|console\./.test(own));

  // ── A world for the lifted code ──────────────────────────
  function world() {
    // Every element exists the moment anyone (the page or the test) asks for it.
    const made = {};
    const mk = id => ({ id, innerHTML: '', textContent: '', value: '', disabled: false, onclick: null, focus() {}, select() {}, querySelectorAll: () => [] });
    const els = new Proxy(made, { get: (o, id) => (o[id] = o[id] || mk(id)) });
    const el = id => els[id];
    const w = { els, toasts: [], sheets: [], stored: [], clipboard: [], calls: [], closed: 0, answers: {} };
    const storage = { setItem: (k, v) => w.stored.push([k, v]), getItem: () => null, removeItem: () => {} };
    const run = {
      withSuccessHandler(ok) {
        return {
          withFailureHandler(fail) {
            return new Proxy({}, {
              get: (_o, method) => (...args) => {
                w.calls.push([method, args]);
                const a = w.answers[method];
                Promise.resolve().then(() => (a instanceof Error ? fail(a) : ok(typeof a === 'function' ? a(...args) : a)));
              },
            });
          },
        };
      },
    };
    const deps = {
      $: el,
      haptic: () => {},
      toast: (msg, kind) => w.toasts.push(String(msg) + '|' + String(kind)),
      openSheet: opts => { w.sheets.push(opts); el('sheetBody').innerHTML = opts.bodyHTML || ''; el('sheetActions').innerHTML = opts.actionsHTML || ''; },
      closeSheet: () => { w.closed++; },
      handleRpcError: e => { throw e; },
      moreBack: () => '<button>← More</button>',
      state: { token: 'TOKEN-1' },
      location: { origin: 'https://ops.example', href: 'https://ops.example/' },
      navigator: { clipboard: { writeText: async s => { w.clipboard.push(s); } } },
      localStorage: storage,
      sessionStorage: storage,
      google: { script: { run } },
    };
    const names = Object.keys(deps);
    const cacheCode = ['TTL_REF', 'TTL_SEMI', 'TTL_LIVE', 'rpcCache', 'rpcInflight'].map(n => new RegExp('  const ' + n + ' [^\\n]*').exec(js)[0]).join('\n');
    const code = [cacheCode, H.fnSource(js, '_ckey'), H.fnSource(js, 'isReadMethod_'), H.fnSource(js, 'call'), lift('cachedCall'), H.fnSource(js, 'cacheFresh'), H.fnSource(js, 'esc'), own].join('\n') +
      '; return { rpcCache, ' + SCREEN.join(', ') + ' };';
    w.fns = new Function(...names, code)(...names.map(n => deps[n]));
    w.deps = deps;
    return w;
  }
  const tick = () => new Promise(r => setTimeout(r, 0));

  t.section('Making a key: shown once, in the sheet only');
  {
    const w = world();
    const list = { enabled: true, address: '/mcp', keys: [], people: [{ staffId: 'S_003', name: 'Cleo <b>Marsh</b>' }] };
    w.answers.rpcGetAssistantKeys = list;
    await w.fns.loadAssistantsTab();
    await tick();
    t.ok('the list was read through the cache', w.fns.rpcCache.size === 1);
    t.ok('the door is said to be open, and switched in Settings', /door is open/.test(w.els['view-assistants'].innerHTML) && /Settings/.test(w.els['view-assistants'].innerHTML));
    w.els.assistantMakeBtn.onclick();
    t.ok('the make sheet lists the people, escaped', /Cleo &lt;b&gt;Marsh&lt;\/b&gt;/.test(w.sheets[0].bodyHTML) && w.sheets[0].bodyHTML.indexOf('<b>Marsh') === -1);
    w.els.akStaff.value = 'S_003';
    w.els.akLabel.value = 'Cleo\'s Muse';
    w.els.akRight.value = 'propose';
    w.els.akPersonal.value = 'no';
    w.els.akDays.value = '30';
    w.answers.rpcCreateAssistantKey = { record: { keyId: 'ak0123456789abcdef', label: 'Cleo\'s Muse', staffName: 'Cleo Marsh', right: 'propose' }, key: KEY };
    await w.els.akMakeBtn.onclick();
    await tick();
    const create = w.calls.find(c => c[0] === 'rpcCreateAssistantKey');
    t.eq('the create call sends the form, with the token from the session', create && create[1], ['TOKEN-1', { staffId: 'S_003', label: 'Cleo\'s Muse', right: 'propose', personalDetails: false, days: 30 }]);
    const shown = w.sheets[w.sheets.length - 1];
    t.eq('the key is in the new sheet exactly once', count(shown.bodyHTML, KEY), 1);
    t.ok('with the address to give the assistant', shown.bodyHTML.indexOf('https://ops.example/mcp') !== -1);
    t.ok('and the plain warning', /will not be shown again/.test(shown.bodyHTML) && /never into a chat/.test(shown.bodyHTML));
    t.ok('in a box that can be selected (a read-only textarea)', /<textarea id="akKey" readonly/.test(shown.bodyHTML));
    t.ok('the subtitle and title do not hold it', (shown.title + shown.subtitle).indexOf(KEY) === -1);
    t.ok('the read cache does not hold it (and was cleared by the write)', JSON.stringify([...w.fns.rpcCache.entries()]).indexOf('SECRET') === -1 && w.fns.rpcCache.size === 0);

    w.els.akKey.value = KEY; // what the textarea holds in a browser
    await w.els.akCopyBtn.onclick();
    t.eq('Copy puts it on the clipboard', w.clipboard, [KEY]);
    t.ok('no toast holds it', w.toasts.length > 0 && w.toasts.every(s => s.indexOf('SECRET') === -1));
    t.eq('nothing was written to storage', w.stored, []);
    t.eq('the address bar was not touched', w.deps.location.href, 'https://ops.example/');

    w.answers.rpcGetAssistantKeys = list;
    w.els.akDoneBtn.onclick();
    await tick();
    t.ok('closing wipes the sheet', w.els.sheetBody.innerHTML === '' && w.els.sheetActions.innerHTML === '' && w.closed === 1);
    t.ok('and the close controls are given back', w.els.sheetClose.onclick === w.deps.closeSheet && w.els.backdrop.onclick === w.deps.closeSheet);
    t.ok('nowhere the code wrote holds the key now',
      [JSON.stringify([...w.fns.rpcCache.entries()]), w.toasts.join(), JSON.stringify(w.stored), w.els['view-assistants'].innerHTML, w.els.sheetBody.innerHTML].join('\n').indexOf('SECRET') === -1);
  }

  t.section('The ✕ and the backdrop wipe it too');
  {
    const w = world();
    w.answers.rpcGetAssistantKeys = { enabled: false, keys: [], people: [] };
    w.fns.showNewKeySheet_({ record: { label: 'x', staffName: 'y', right: 'read' }, key: KEY });
    t.ok('shown', w.els.sheetBody.innerHTML.indexOf(KEY) !== -1);
    w.els.sheetClose.onclick();
    t.ok('the ✕ wipes it', w.els.sheetBody.innerHTML === '');
    w.fns.showNewKeySheet_({ record: { label: 'x', staffName: 'y', right: 'read' }, key: KEY });
    w.els.backdrop.onclick();
    t.ok('the backdrop wipes it', w.els.sheetBody.innerHTML === '');
  }

  t.section('The list');
  {
    const w = world();
    w.fns.renderAssistantsTab({
      enabled: false,
      people: [],
      keys: [
        { keyId: 'ak1', label: '<img src=x onerror=1>', staffName: 'Ada', right: 'read', personalDetails: false, status: 'live', daysLeft: 12, lastUsedAt: null, callsToday: 3 },
        { keyId: 'ak2', label: 'Old', staffName: 'Bram', right: 'propose', personalDetails: true, status: 'withdrawn', withdrawnAt: '2026-11-20T15:00:00Z', withdrawnBy: 'Ada', daysLeft: 0, lastUsedAt: '2026-11-19T15:00:00Z', callsToday: 0 },
        { keyId: 'ak3', label: 'Gone', staffName: 'Cleo', right: 'read', personalDetails: false, status: 'expired', daysLeft: 0, lastUsedAt: null, callsToday: 0 },
      ],
    });
    const h = w.els['view-assistants'].innerHTML;
    t.ok('hostile text is escaped', h.indexOf('<img') === -1 && h.indexOf('&lt;img') !== -1);
    t.ok('the door is said to be closed', /door is closed/.test(h));
    t.ok('a live key: expires in N days, last used never, calls today', /Expires in 12 days/.test(h) && /last used never/.test(h) && /3 calls today/.test(h));
    t.ok('withdrawn and expired keys are greyed and cannot be withdrawn again',
      count(h, 'opacity:.5') === 2 && count(h, 'data-assistant-withdraw=') === 1 && /Withdrawn/.test(h) && /Expired/.test(h));
    t.ok('the right and personal details are said in words', /read only/.test(h) && /read and propose/.test(h) && /customers' details/.test(h));
  }

  t.section('Withdrawing');
  {
    const w = world();
    w.answers.rpcRevokeAssistantKey = { keyId: 'ak1', status: 'withdrawn' };
    w.answers.rpcGetAssistantKeys = { enabled: true, keys: [], people: [] };
    w.fns.openWithdrawKeySheet({ keyId: 'ak1', label: 'L', staffName: 'Ada' });
    w.els.akReason.value = 'phone lost';
    await w.els.akWithdrawBtn.onclick();
    await tick();
    t.eq('sends the key id and the reason', w.calls.find(c => c[0] === 'rpcRevokeAssistantKey')[1], ['TOKEN-1', { keyId: 'ak1', reason: 'phone lost' }]);
    t.ok('and says so', w.toasts.some(s => /withdrawn/.test(s)));
  }

  t.section('The built Operations page carries the screen; Apps Script hides it');
  {
    const { buildUi } = await import(path.join(H.REPO, 'ops', 'tools', 'build-ui.mjs'));
    const out = buildUi({ write: false });
    t.ok('the built page has the view, the loader and the opsOnly entry',
      out.indexOf('id="view-assistants"') !== -1 && out.indexOf('async function loadAssistantsTab(') !== -1 && /\{ tab: 'assistants'[^\n]*opsOnly: true/.test(out));
    t.ok('the Apps Script page never marks itself as the Operations app', SRC_HTML.indexOf("STOREOPS_APP = 'ops'") === -1);
  }

  t.done();
})().catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
