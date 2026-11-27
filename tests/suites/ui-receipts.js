// ============================================================
//  ui-receipts — the Receipts and Businesses screens (card P5-12a)
// ============================================================
//  The Operations app's receipt inbox and its two businesses. These
//  assertions lift the screens' real functions from both copies of the page
//  (src/Index.html and the Worker's built ops/public/index.html) and call
//  them per role:
//   - both drawer entries are opsOnly: Receipts for every role, Businesses
//     for admin, manager and payroll admin; neither inside Apps Script;
//   - what an employee is shown has no list of other people's originals and
//     no set-aside or change-business control; a payroll admin sees the list
//     without them; admin and manager have them;
//   - a photo over the limit is refused on the device before any request;
//   - the token goes in an Authorization header only: never in a URL the
//     code builds (every fetch is inspected), a toast or storage;
//   - every blob URL is revoked when its view closes;
//   - the Businesses screen is read only unless the server says canEdit.
// ============================================================
const fs = require('fs');
const path = require('path');
const H = require('./_lib/harness');
const t = H.suite('Receipts and Businesses screens — Operations app');

const TOKEN = 'tok3n5ecretabcdef0123456789abcdef';
const SCREEN = ['receiptSizeText_', 'receiptBusinessLabel_', 'receiptWhen_', 'receiptTooLarge_', 'receiptUploadHeaders_', 'sendReceiptOriginal_', 'fetchReceiptOriginal_',
  'revokeReceiptUrl_', 'revokeReceiptBlobs_', 'loadReceiptsTab', 'receiptAddHTML_', 'receiptThumbHTML_', 'receiptRowHTML_', 'renderReceiptsTab', 'loadReceiptThumbs_',
  'receiptPickHTML_', 'wireReceiptAdd_', 'submitReceipt_', 'openReceiptSheet_', 'openReceiptAsideSheet_', 'openReceiptBusinessSheet_',
  'loadBusinessesTab', 'businessSignText_', 'businessCardHTML_', 'renderBusinessesTab', 'openBusinessEditSheet_', 'openBusinessSignSheet_'];
const CALLS = ['rpcGetReceiptInbox', 'rpcSetReceiptAside', 'rpcSetReceiptBusiness', 'rpcGetBusinesses', 'rpcUpdateBusiness', 'rpcAddBusinessSign', 'rpcRemoveBusinessSign'];

const item = (o) => Object.assign({ id: 'ro' + 'a'.repeat(24), addedAt: '2026-11-27T15:00:00.000Z', addedBy: 'Cleo Marsh', mine: false, business: null, source: 'photo', contentType: 'image/jpeg', size: 2516582, fileName: 'IMG_0042.JPG', note: 'Fictional Grocer', status: 'waiting', setAside: null }, o);
const ALL = { scope: 'all', status: 'waiting', items: [item({}), item({ id: 'ro' + 'b'.repeat(24), contentType: 'application/pdf', fileName: 'invoice.pdf', addedBy: 'Eli <b>Stone</b>', business: 'vape' })], counts: { waiting: 2, set_aside: 1 }, next: null, canSetAside: true, maxMb: 10 };
const ASIDE = { scope: 'all', status: 'set_aside', items: [item({ id: 'ro' + 'c'.repeat(24), status: 'set_aside', setAside: { reason: 'A fictional flyer', by: 'Bram Hale', at: '2026-11-27T16:00:00.000Z' } })], counts: { waiting: 2, set_aside: 1 }, next: null, canSetAside: true, maxMb: 10 };
const OWN = { scope: 'own', days: 7, items: [item({ mine: true, addedBy: 'Jordan Reyes' })], maxMb: 10 };

const pending = [];
H.uiScripts().forEach(([label, js]) => {
  t.section('Against ' + label);

  // ── The drawer entries ────────────────────────────────────
  {
    const lifted = /const ALL_ROLES = [^\n]*\n  const MORE_ITEMS = \[[\s\S]*?\n  \];/.exec(js)[0];
    const items = new Function(lifted + '; return MORE_ITEMS;')();
    const pick = new Function(H.fnSource(js, 'moreItemsFor_') + '; return moreItemsFor_;')();
    const has = (tab, role, ops) => pick(items, role, ops).some(i => i.tab === tab);
    const roles = ['admin', 'manager', 'payroll_admin', 'employee'];
    for (const tab of ['receipts', 'businesses']) {
      const entry = items.filter(i => i.tab === tab);
      t.eq(tab + ': one entry in the real MORE_ITEMS', entry.length, 1);
      t.ok(tab + ': it is opsOnly', entry[0] && entry[0].opsOnly === true);
      t.ok(tab + ': written on one line, as the build reads the list', new RegExp("^\\s*\\{ tab: '" + tab + "'.*opsOnly: true \\},\\s*$", 'm').test(js));
      t.eq(tab + ': hidden inside Apps Script from everyone', roles.map(r => has(tab, r, false)), [false, false, false, false]);
      t.ok(tab + ': a drawer tab with a loader, a title and a view',
        new RegExp("const DRAWER_TABS = \\[[^\\]]*'" + tab + "'").test(js) && new RegExp(tab + ':\\s*load' + tab[0].toUpperCase() + tab.slice(1) + 'Tab\\b').test(H.fnSource(js, 'tabLoaders_')) &&
        new RegExp(tab + ": '" + tab[0].toUpperCase() + tab.slice(1) + "'").test(H.fnSource(js, 'switchTab')));
    }
    t.eq('Receipts is offered to every role in the Operations app', roles.map(r => has('receipts', r, true)), [true, true, true, true]);
    t.eq('Businesses to admin, manager and payroll admin only', roles.map(r => has('businesses', r, true)), [true, true, true, false]);
    t.ok('leaving any screen revokes the Receipts screen\'s blob URLs', /revokeReceiptBlobs_\(\)/.test(H.fnSource(js, 'switchTab')));
  }

  const lift = n => { const src = H.fnSource(js, n); return js.indexOf('async function ' + n + '(') !== -1 ? 'async ' + src : src; };
  const own = SCREEN.map(lift).join('\n');
  const count = (s, n) => s.split(n).length - 1;
  t.eq('the seven calls are named only inside the screens\' own functions', CALLS.map(n => count(js, n) > 0 && count(js, n) === count(own, n)), CALLS.map(() => true));
  t.ok('no var in the screens', !/\bvar\b/.test(own));
  t.ok('no "<?" in the screens', own.indexOf('<?') === -1);
  t.ok('no storage, history or address bar in the screens', !/localStorage|sessionStorage|history\.|location\.(hash|href|search)|document\.cookie/.test(own));
  t.ok('no URL with a query string is built: fetch addresses are fixed paths', !/\?token|[?&]t=|'\?'/.test(own));

  // ── A world for the lifted code ───────────────────────────
  function world(opts) {
    const made = {};
    // querySelectorAll finds [data-x="v"] in what was rendered: the rows and thumbnails the code wires.
    const found = new Map();
    const mk = id => ({
      id, innerHTML: '', textContent: '', value: '', disabled: false, onclick: null, onchange: null, style: {}, files: null, dataset: {}, setAttribute() {}, querySelector: () => null,
      querySelectorAll(sel) {
        const attr = /^\[data-([a-z-]+)\]$/.exec(sel);
        if (!attr) return [];
        const key = attr[1].replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
        return (String(this.innerHTML).match(new RegExp('data-' + attr[1] + '="([^"]*)"', 'g')) || []).map(m => {
          const v = /"([^"]*)"/.exec(m)[1];
          const k = sel + v;
          if (!found.has(k)) found.set(k, { innerHTML: '', textContent: '', dataset: { [key]: v }, querySelector: () => null });
          return found.get(k);
        });
      },
    });
    const els = new Proxy(made, { get: (o, id) => (o[id] = o[id] || mk(id)) });
    const w = { els, toasts: [], sheets: [], stored: [], fetches: [], calls: [], created: [], revoked: [], closed: 0, opened: [], answers: opts.answers || {} };
    const storage = { setItem: (k, v) => w.stored.push([k, v]), getItem: () => null, removeItem: () => {} };
    let blobs = 0;
    const deps = {
      $: id => els[id],
      haptic: () => {},
      toast: (msg, kind) => w.toasts.push(String(msg) + '|' + String(kind)),
      openSheet: o => { w.sheets.push(o); els.sheetBody.innerHTML = o.bodyHTML || ''; els.sheetActions.innerHTML = o.actionsHTML || ''; },
      closeSheet: () => { w.closed++; },
      handleRpcError: e => w.toasts.push('error:' + e.message),
      moreBack: () => '<button>← More</button>',
      state: { token: TOKEN, me: { role: opts.role } },
      call: async (m, ...a) => { w.calls.push([m, a]); return w.answers[m]; },
      cachedCall: async (m, a) => { w.calls.push([m, a]); const x = w.answers[m]; return typeof x === 'function' ? x(...a) : x; },
      cacheFresh: () => false,
      rpcCache: { clear: () => { w.cacheCleared = (w.cacheCleared || 0) + 1; } },
      TTL_LIVE: 60000,
      TTL_SEMI: 300000,
      localStorage: storage,
      sessionStorage: storage,
      fetch: async (url, init) => {
        w.fetches.push({ url: String(url), init: init || {} });
        const f = opts.fetch || (() => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }), blob: async () => ({ type: 'image/jpeg' }) }));
        return f(String(url), init || {});
      },
      URL: { createObjectURL: () => { const u = 'blob:https://ops.test/' + (++blobs); w.created.push(u); return u; }, revokeObjectURL: u => w.revoked.push(u) },
      IntersectionObserver: undefined,
      window: { open: (u, n, f) => { w.opened.push([u, n, f]); return null; } },
    };
    const names = Object.keys(deps);
    const consts = ['RECEIPT_ACCEPT', 'RECEIPT_MB', 'receiptState_', 'BUSINESS_SIGN_KINDS'].map(n => new RegExp('  const ' + n + ' [^\\n]*').exec(js)[0]).join('\n');
    w.fns = new Function(...names, consts + '\n' + H.fnSource(js, 'esc') + '\n' + own + '; return { receiptState_, ' + SCREEN.join(', ') + ' };')(...names.map(n => deps[n]));
    return w;
  }
  const tick = () => new Promise(r => setTimeout(r, 0));
  const ids = html => (String(html).match(/\bid="([^"]+)"/g) || []).map(s => /"([^"]+)"/.exec(s)[1]);

  // ── Per role: what is rendered ────────────────────────────
  pending.push((async () => {
    // An employee: the server answers their own; the page shows add + their own, nothing else.
    const e = world({ role: 'employee', answers: { rpcGetReceiptInbox: OWN } });
    await e.fns.loadReceiptsTab();
    const eh = e.els['view-receipts'].innerHTML;
    t.ok(label + ': employee: Add a receipt, both ways in, the business choice, the note, Send', ['rcptCamera', 'rcptFile', 'rcptBusiness', 'rcptNote', 'rcptSend'].every(id => ids(eh).indexOf(id) !== -1) && /Add a receipt/.test(eh));
    t.ok(label + ': employee: the camera input asks for the back camera, the file input for the five kinds',
      /<input type="file" id="rcptCamera" accept="image\/\*" capture="environment"/.test(eh) && /id="rcptFile" accept="image\/jpeg,image\/png,image\/webp,image\/heic,image\/heif,\.heic,\.heif,application\/pdf"/.test(eh));
    t.ok(label + ': employee: "What you added in the last 7 days", with their own', /What you added in the last 7 days/.test(eh) && /Jordan Reyes/.test(eh));
    t.ok(label + ': employee: no Waiting or Set aside list, no other person', !/Waiting \(|Set aside \(/.test(eh) && !/Cleo Marsh|Eli/.test(eh));
    t.eq(label + ': employee: only one read, the own list (no set-aside page asked for)', e.calls.map(c => [c[0], c[1][1]]), [['rpcGetReceiptInbox', { status: 'waiting' }]]);
    e.fns.openReceiptSheet_(OWN.items[0], false);
    const es = e.sheets[e.sheets.length - 1];
    t.ok(label + ': employee: the large view has Close only, no Set aside, Put back or Change business', /rcptCloseBtn/.test(es.actionsHTML) && !/rcptAsideBtn|rcptBackBtn|rcptBizBtn|Set aside|Change business/.test(es.actionsHTML));

    // A payroll admin: the list, without the controls.
    const p = world({ role: 'payroll_admin', answers: { rpcGetReceiptInbox: (tok, input) => (input.status === 'set_aside' ? ASIDE : Object.assign({}, ALL, { canSetAside: false })) } });
    await p.fns.loadReceiptsTab();
    const ph = p.els['view-receipts'].innerHTML;
    t.ok(label + ': payroll admin: Waiting (2) then Set aside (1)', ph.indexOf('Waiting (2)') !== -1 && ph.indexOf('Set aside (1)') > ph.indexOf('Waiting (2)'));
    t.ok(label + ': rows escaped; a PDF mark; "business not known"; the note; set-aside details', ph.indexOf('Eli &lt;b&gt;Stone&lt;/b&gt;') !== -1 && ph.indexOf('<b>Stone') === -1 && />PDF</.test(ph) && /business not known/.test(ph) && /Fictional Grocer/.test(ph) && /Set aside by Bram Hale: A fictional flyer/.test(ph));
    t.ok(label + ': thumbnails only for images, fetched (a few at a time) with the header', p.fetches.length === 2 && p.fetches.every(f => /^\/files\/receipt-original\/ro[a-c]{24}$/.test(f.url)));
    p.fns.openReceiptSheet_(ALL.items[0], false);
    t.ok(label + ': payroll admin: no set-aside or business control', !/rcptAsideBtn|rcptBizBtn/.test(p.sheets[p.sheets.length - 1].actionsHTML));

    // A manager: the controls.
    const m = world({ role: 'manager', answers: { rpcGetReceiptInbox: (tok, input) => (input.status === 'set_aside' ? ASIDE : ALL), rpcSetReceiptAside: { changed: true } } });
    await m.fns.loadReceiptsTab();
    await m.fns.openReceiptSheet_(ALL.items[0], true);
    const ms = m.sheets[m.sheets.length - 1];
    t.ok(label + ': manager: Set aside and Change business on a waiting original', /rcptAsideBtn/.test(ms.actionsHTML) && /rcptBizBtn/.test(ms.actionsHTML));
    t.ok(label + ': the image is shown from a blob URL', /<img alt="Receipt original" src="blob:https:\/\/ops\.test\/\d+"/.test(m.els.rcptBig.innerHTML));
    const shownUrl = m.created[m.created.length - 1];
    m.els.sheetClose.onclick();
    t.ok(label + ': closing the large view revokes its blob URL', m.revoked.indexOf(shownUrl) !== -1);
    await m.fns.openReceiptSheet_(ASIDE.items[0], true);
    t.ok(label + ': manager: Put back on a set-aside original', /rcptBackBtn/.test(m.sheets[m.sheets.length - 1].actionsHTML));
    await m.els.rcptBackBtn.onclick();
    t.eq(label + ': Put back sends the id and aside false, with the token as the first argument', m.calls.filter(c => c[0] === 'rpcSetReceiptAside').map(c => c[1]), [[TOKEN, { id: ASIDE.items[0].id, aside: false }]]);
    m.fns.openReceiptAsideSheet_(ALL.items[0]);
    m.els.rcptReason.value = 'A fictional flyer';
    await m.els.rcptAsideSave.onclick();
    t.eq(label + ': Set aside sends the reason', m.calls.filter(c => c[0] === 'rpcSetReceiptAside').map(c => c[1][1])[1], { id: ALL.items[0].id, aside: true, reason: 'A fictional flyer' });
    m.fns.openReceiptBusinessSheet_(ALL.items[0]);
    m.els.rcptBizPick.value = '';
    m.answers.rpcSetReceiptBusiness = { changed: true };
    await m.els.rcptBizSave.onclick();
    t.eq(label + ': "Not known" is sent as null', (m.calls.find(c => c[0] === 'rpcSetReceiptBusiness') || [])[1], [TOKEN, { id: ALL.items[0].id, business: null }]);

    // A PDF opens in a new tab from a blob URL.
    const d = world({ role: 'admin', fetch: () => ({ ok: true, status: 200, blob: async () => ({ type: 'application/pdf' }) }) });
    await d.fns.openReceiptSheet_(ALL.items[1], true);
    d.els.rcptOpenPdf.onclick();
    t.ok(label + ': a PDF opens from a blob URL in a new tab, no opener', d.opened.length === 1 && /^blob:/.test(d.opened[0][0]) && d.opened[0][2] === 'noopener');
  })());

  // ── The limit is checked before any request ───────────────
  pending.push((async () => {
    const w = world({ role: 'employee', answers: { rpcGetReceiptInbox: OWN } });
    await w.fns.loadReceiptsTab();
    const fetchesBefore = w.fetches.length;
    const photo = { name: 'IMG_0099.HEIC', type: 'image/heic', size: 12 * 1024 * 1024 };
    w.els.rcptCamera.files = [photo];
    w.els.rcptCamera.onchange();
    t.eq(label + ': a 12 MB photo is refused on the device, in words', w.els.rcptMsg.textContent,
      'This photo is 12.0 MB, more than the 10 MB the app keeps. Choose a smaller picture size in the phone\'s camera settings and take it again.');
    t.ok(label + ': Send stays off', w.els.rcptSend.disabled === true);
    w.fns.receiptState_.file = photo; // even if the state were set, submit checks again
    await w.fns.submitReceipt_();
    t.eq(label + ': and nothing is sent', w.fetches.length, fetchesBefore);
    t.eq(label + ': the limit follows the server (maxMb)', w.fns.receiptTooLarge_({ size: 3 * 1024 * 1024, type: 'application/pdf', name: 'a.pdf' }, 2), 'This file is 3.0 MB, more than the 2 MB the app keeps. Ask for a smaller copy of the file.');
    t.eq(label + ': at the limit is fine', w.fns.receiptTooLarge_({ size: 10 * 1024 * 1024, type: 'image/jpeg' }, 10), '');
  })());

  // ── Sending: the token in a header, never in a URL ────────
  pending.push((async () => {
    const answers = { rpcGetReceiptInbox: OWN };
    const w = world({
      role: 'employee', answers,
      fetch: (url, init) => (init.method === 'PUT'
        ? { ok: true, status: 201, json: async () => ({ ok: true, result: { duplicate: false, message: 'Kept. 2.4 MB, added 2026-11-27 10:05.', record: {} } }) }
        : { ok: true, status: 200, blob: async () => ({ type: 'image/jpeg' }) }),
    });
    await w.fns.loadReceiptsTab();
    const file = { name: 'IMG 0042 ü.JPG', type: 'image/jpeg', size: 2516582 };
    w.els.rcptFile.files = [file];
    w.els.rcptFile.onchange();
    t.ok(label + ': the preview says the size and that it is sent as it is', /2\.4 MB will be sent, as it is/.test(w.els.rcptPreview.innerHTML));
    w.els.rcptBusiness.value = 'cstore';
    w.els.rcptNote.value = ' Fictional Grocer, milk ';
    await w.fns.submitReceipt_();
    const put = w.fetches.find(f => f.init.method === 'PUT');
    t.eq(label + ': PUT /files/receipt-original with the file itself as the body', put && [put.url, put.init.body === file], ['/files/receipt-original', true]);
    t.eq(label + ': the headers', put && put.init.headers, { authorization: 'Bearer ' + TOKEN, 'x-receipt-source': 'upload', 'x-receipt-business': 'cstore', 'x-receipt-filename': encodeURIComponent('IMG 0042 ü.JPG'), 'x-receipt-note': encodeURIComponent('Fictional Grocer, milk') });
    t.ok(label + ': afterwards the server\'s words, as they are', w.els.rcptMsg.textContent === 'Kept. 2.4 MB, added 2026-11-27 10:05.');
    t.ok(label + ': the read cache is cleared after a kept original', w.cacheCleared >= 1);

    // The view fetch, and a "not sure" business sends no header.
    const h = w.fns.receiptUploadHeaders_(TOKEN, { name: 'a.pdf' }, { source: 'photo', business: '', note: '' });
    t.eq(label + ': "Not sure" sends no business header; a photo says so', h, { authorization: 'Bearer ' + TOKEN, 'x-receipt-source': 'photo', 'x-receipt-filename': 'a.pdf' });
    await w.fns.fetchReceiptOriginal_('ro' + 'd'.repeat(24));
    const all = w.fetches.map(f => f.url + ' ' + JSON.stringify(f.init.body === file ? null : f.init.body || null));
    t.ok(label + ': no fetch address holds the token, and every fetch carries it as a Bearer header', w.fetches.length >= 2 && all.every(u => u.indexOf(TOKEN) === -1) && w.fetches.every(f => f.init.headers && f.init.headers.authorization === 'Bearer ' + TOKEN));
    t.ok(label + ': no fetch sends cookies elsewhere (same-origin only)', w.fetches.every(f => f.init.credentials === 'same-origin'));
    t.ok(label + ': no image or link the page drew holds the token', [w.els['view-receipts'].innerHTML, w.els.rcptPreview.innerHTML, JSON.stringify(w.sheets)].every(s => s.indexOf(TOKEN) === -1));
    t.ok(label + ': no toast holds the token; nothing in storage', w.toasts.length > 0 && w.toasts.every(s => s.indexOf(TOKEN) === -1) && w.stored.length === 0);

    // A refusal is shown as the server wrote it; NOT_LOGGED_IN goes to the sign-in path.
    const r = world({ role: 'employee', answers, fetch: () => ({ ok: false, status: 415, json: async () => ({ ok: false, error: { message: 'This file is not a photo or a PDF the app can keep. Send a JPEG, PNG, WebP or HEIC photo, or a PDF.' } }) }) });
    await r.fns.loadReceiptsTab();
    r.fns.receiptState_.file = { name: 'x.png', type: 'image/png', size: 10 };
    await r.fns.submitReceipt_();
    t.eq(label + ': a refusal, word for word', r.els.rcptMsg.textContent, 'This file is not a photo or a PDF the app can keep. Send a JPEG, PNG, WebP or HEIC photo, or a PDF.');
    const x = world({ role: 'employee', answers, fetch: () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: { message: 'NOT_LOGGED_IN' } }) }) });
    await x.fns.loadReceiptsTab();
    x.fns.receiptState_.file = { name: 'x.png', type: 'image/png', size: 10 };
    await x.fns.submitReceipt_();
    t.ok(label + ': a lapsed session goes to the sign-in path', x.toasts.indexOf('error:NOT_LOGGED_IN') !== -1);

    // Redrawing the screen revokes the thumbnails it made.
    const p = world({ role: 'admin', answers: { rpcGetReceiptInbox: (tok, input) => (input.status === 'set_aside' ? ASIDE : ALL) } });
    await p.fns.loadReceiptsTab();
    await tick();
    const made = p.created.slice();
    p.fns.revokeReceiptBlobs_();
    t.ok(label + ': leaving the screen revokes every thumbnail\'s blob URL', made.length === 2 && made.every(u => p.revoked.indexOf(u) !== -1));
  })());

  // ── Businesses ────────────────────────────────────────────
  pending.push((async () => {
    const data = (canEdit) => ({ canEdit, businesses: [
      { key: 'cstore', displayName: 'Fictional Corner', legalName: null, hstNumber: null, notes: null, signs: [] },
      { key: 'vape', displayName: 'Fictional <i>Vapes</i>', legalName: 'Fictional Vapour Ltd.', hstNumber: '123456789RT0001', notes: null, signs: [{ id: 'bs' + '1'.repeat(20), kind: 'card_last4', value: '4821', supplier: null }, { id: 'bs' + '2'.repeat(20), kind: 'supplier_account', value: 'AC-1029', supplier: 'Fictional Wholesale' }] },
    ] });
    const m = world({ role: 'manager', answers: { rpcGetBusinesses: data(false) } });
    await m.fns.loadBusinessesTab();
    const mh = m.els['view-businesses'].innerHTML;
    t.ok(label + ': businesses: a blank legal name and HST number say "not recorded"', /Legal name: <i>not recorded<\/i>/.test(mh) && /HST number: <i>not recorded<\/i>/.test(mh));
    t.ok(label + ': businesses: the signs, escaped', /Card ending<\/b> 4821/.test(mh) && /AC-1029 at Fictional Wholesale/.test(mh) && mh.indexOf('<i>Vapes') === -1);
    t.ok(label + ': businesses: read only for a manager (no change, add or remove control)', !/data-business-edit|data-sign-add|data-sign-remove/.test(mh) && /read only/.test(mh));
    const a = world({ role: 'admin', answers: { rpcGetBusinesses: data(true), rpcAddBusinessSign: { sign: {} } } });
    await a.fns.loadBusinessesTab();
    const ah = a.els['view-businesses'].innerHTML;
    t.ok(label + ': businesses: an admin may change each business, add and remove signs', count(ah, 'data-business-edit=') === 2 && count(ah, 'data-sign-add=') === 2 && count(ah, 'data-sign-remove=') === 2);
    a.fns.openBusinessSignSheet_(data(true).businesses[0]);
    a.els.signKind.value = 'card_last4';
    a.els.signValue.value = '4821';
    await a.els.signSave.onclick();
    t.eq(label + ': adding a card sign sends the business, the kind and the four digits; no supplier', (a.calls.find(c => c[0] === 'rpcAddBusinessSign') || [])[1], [TOKEN, { business: 'cstore', kind: 'card_last4', value: '4821', supplier: null }]);
  })());
});

// ── The built Operations page carries both screens; Apps Script hides them ──
{
  t.section('The two apps');
  const built = require('child_process').execFileSync(process.execPath, [path.join(H.REPO, 'ops', 'tools', 'build-ui.mjs'), '--stdout'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  t.ok('the built page has both views, both loaders and both opsOnly entries',
    built.indexOf('<div class="view" id="view-receipts"></div>') !== -1 && built.indexOf('<div class="view" id="view-businesses"></div>') !== -1 &&
    built.indexOf('async function loadReceiptsTab(') !== -1 && built.indexOf('async function loadBusinessesTab(') !== -1 &&
    /\{ tab: 'receipts'[^\n]*opsOnly: true/.test(built) && /\{ tab: 'businesses'[^\n]*opsOnly: true/.test(built));
  const src = fs.readFileSync(path.join(H.SRC, 'Index.html'), 'utf8');
  t.ok('the Apps Script page never loads the transport, so the entries are hidden there', src.indexOf('/transport.js') === -1);
  t.ok('no template tag in the page', src.indexOf('<?') === -1);
}

Promise.all(pending).then(() => t.done()).catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
