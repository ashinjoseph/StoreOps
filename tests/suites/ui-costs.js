// ============================================================
//  ui-costs — the Costs screen (card P5-15)
// ============================================================
//  What each item costs from each supplier, and the price-rise flags. The
//  screen only exists in the Operations app (ADR-0023). These assertions lift
//  its real functions from both copies of the page (src/Index.html and the
//  Worker's built ops/public/index.html) and call them per role:
//   - the drawer entry is opsOnly, for admin, manager and payroll admin only,
//     and hidden inside Apps Script;
//   - a flag reads as one sentence a manager can act on; a worked-out cost
//     says so; a cost that is not there is never "$0.00"; a unit cost keeps
//     its decimals (never money());
//   - the screen cannot be asked for without a business: no call is made;
//   - admin and manager act (Seen, Price raised, join); payroll admin only
//     reads; only an admin sees "Work out costs for earlier receipts";
//   - hostile text in an item or supplier name is escaped everywhere;
//   - the confirm and void sheets on the Receipts screen say what the
//     server's summary says;
//   - the built Operations page contains the screen.
// ============================================================
const fs = require('fs');
const path = require('path');
const H = require('./_lib/harness');
const t = H.suite('Costs screen — Operations app');

const TOKEN = 'tok3n5ecretabcdef0123456789abcdef';
const SCREEN = ['costDate_', 'costEach_', 'costFlagSentence_', 'costFlagNotes_', 'costFlagHTML_', 'costBusinessName_', 'loadCostsTab', 'loadCostFlags_', 'drawCostFlags_', 'setCostFlag_',
  'openCostRaisedSheet_', 'costSupplierOptions_', 'drawCostFind_', 'costItemRowHTML_', 'loadCostItems_', 'costHistoryRowHTML_', 'costItemHTML_', 'openCostItem_', 'drawCostItem_', 'drawCostJoinPicker_', 'askCostReason_'];
const CONSTS = ['costsState_', 'COST_MONTHS_', 'COST_STATES_', 'COST_WORKED_', 'COST_WITHDRAWN_', 'COST_BECAUSE_', 'COST_NOT_COUNTED_'];
const CALLS = ['rpcGetPriceFlags', 'rpcSetPriceFlag', 'rpcGetItemCosts', 'rpcFindItems', 'rpcJoinItems', 'rpcObserveEarlierReceipts'];

const thisYear = new Date().getFullYear();
const flag = (o) => Object.assign({
  id: 'pf' + 'a'.repeat(20), business: 'cstore', state: 'new',
  item: { id: 'it' + '1'.repeat(20), code: 'CK12', name: 'Cola 12-pack', printedAs: 'Cola 12-pack', joined: false },
  supplier: { id: 'sp' + '9'.repeat(20), name: 'Fictional Wholesale Ltd' },
  from: { costId: 'ic1', cost: '1.20', date: thisYear + '-10-20', receiptId: 'pr' + '1'.repeat(24), how: 'printed' },
  to: { costId: 'ic2', cost: '1.35', date: thisYear + '-11-20', receiptId: 'pr' + '2'.repeat(24), how: 'printed' },
  risePercent: '12.5', thresholdPercent: '5', raisedBecause: 'confirm', raisedAt: thisYear + '-11-20T15:00:00.000Z', mark: null, withdrawn: null,
}, o);
const FLAGS = (list, counts) => ({ business: 'cstore', flags: list, counts: Object.assign({ new: list.length, seen: 0, price_raised: 0, withdrawn: 0 }, counts || {}), next: null });
const item = (o) => Object.assign({ id: 'it' + '1'.repeat(20), business: 'cstore', supplier: { id: 'sp' + '9'.repeat(20), name: 'Fictional Wholesale Ltd' }, code: 'CK12', name: 'Cola 12-pack', joinedCount: 0, observations: 3, latest: { cost: '1.35', date: thisYear + '-11-20', how: 'printed', receiptId: 'pr' + '2'.repeat(24) } }, o);
const cost = (o) => Object.assign({ costId: 'ic1', itemId: 'it' + '1'.repeat(20), printedAs: { code: 'CK12', description: 'Cola 12-pack' }, receiptId: 'pr' + '1'.repeat(24), invoiceNumber: 'INV-77', line: 1, date: thisYear + '-10-20', cost: '1.20', how: 'printed', quantity: '2', lineTotal: null, taxed: null, flag: null, notCounted: null }, o);
const HISTORY = (o) => Object.assign({
  business: 'cstore', item: { id: 'it' + '1'.repeat(20), code: 'CK12', name: 'Cola 12-pack', supplier: { id: 'sp' + '9'.repeat(20), name: 'Fictional Wholesale Ltd' } },
  askedFor: { id: 'it' + '1'.repeat(20), joinedInto: null },
  members: [{ id: 'it' + '1'.repeat(20), code: 'CK12', name: 'Cola 12-pack', root: true, join: null }],
  history: [cost({}), cost({ costId: 'ic2', date: thisYear + '-11-20', cost: '1.35', flag: { id: 'pf' + 'a'.repeat(20), state: 'new', risePercent: '12.5' } })], earlierNotShown: 0, notCounted: [],
}, o);

const pending = [];
H.uiScripts().forEach(([label, js]) => {
  t.section('Against ' + label);

  // ── The drawer entry ──────────────────────────────────────
  {
    const lifted = /const ALL_ROLES = [^\n]*\n  const MORE_ITEMS = \[[\s\S]*?\n  \];/.exec(js)[0];
    const items = new Function(lifted + '; return MORE_ITEMS;')();
    const pick = new Function(H.fnSource(js, 'moreItemsFor_') + '; return moreItemsFor_;')();
    const has = (tab, role, ops) => pick(items, role, ops).some(i => i.tab === tab);
    const roles = ['admin', 'manager', 'payroll_admin', 'employee'];
    const entry = items.filter(i => i.tab === 'costs');
    t.eq('costs: one entry in the real MORE_ITEMS', entry.length, 1);
    t.ok('costs: it is opsOnly', entry[0] && entry[0].opsOnly === true);
    t.eq('costs: its roles are admin, manager and payroll admin', entry[0] && entry[0].roles, ['admin', 'manager', 'payroll_admin']);
    t.ok('costs: written on one line, as the build reads the list', /^\s*\{ tab: 'costs'.*opsOnly: true \},\s*$/m.test(js));
    t.eq('costs: hidden inside Apps Script from everyone', roles.map(r => has('costs', r, false)), [false, false, false, false]);
    t.eq('costs: in the Operations app, admin, manager and payroll admin only', roles.map(r => has('costs', r, true)), [true, true, true, false]);
    t.ok('costs: a drawer tab with a loader and a title',
      /const DRAWER_TABS = \[[^\]]*'costs'/.test(js) && /costs:\s*loadCostsTab\b/.test(H.fnSource(js, 'tabLoaders_')) && /costs: 'Costs'/.test(H.fnSource(js, 'switchTab')));
    t.ok('costs: the page has its view', /<div class="view" id="view-costs"><\/div>/.test(fs.readFileSync(path.join(H.SRC, 'Index.html'), 'utf8')));
  }

  const lift = n => { const src = H.fnSource(js, n); return js.indexOf('async function ' + n + '(') !== -1 ? 'async ' + src : src; };
  const own = SCREEN.map(lift).join('\n');
  const constSrc = n => {
    const one = new RegExp('  const ' + n + ' = [^\\n]*;\\n').exec(js);
    if (one) return one[0];
    return new RegExp('  const ' + n + ' = \\{[\\s\\S]*?\\n  \\};\\n').exec(js)[0];
  };
  const count = (s, n) => s.split(n).length - 1;
  t.eq('the six calls are named only inside the screen\'s own functions', CALLS.map(n => count(js, n) > 0 && count(js, n) === count(own, n)), CALLS.map(() => true));
  t.ok('no var in the screen', !/\bvar\b/.test(own));
  t.ok('no "<?" in the screen', own.indexOf('<?') === -1);
  t.ok('no storage, history or address bar in the screen', !/localStorage|sessionStorage|window\.history|(^|[^.\w])history\.(back|go|forward|push|replace|length|state)|location\.(hash|href|search)|document\.cookie/.test(own));
  t.ok('a unit cost is never put through money() (it would round to cents)', !/money\((c\.cost|f\.(from|to)\.cost|latest\.cost|it\.latest\.cost)/.test(own));

  // ── A world for the lifted code ───────────────────────────
  function world(opts) {
    const made = {};
    const found = new Map();
    const mk = id => ({
      id, innerHTML: '', textContent: '', value: '', disabled: false, onclick: null, oninput: null, style: {}, dataset: {}, remove() { this.removed = true; },
      insertAdjacentHTML(_pos, html) { this.innerHTML += html; },
      querySelectorAll(sel) {
        const attr = /^\[data-([a-z-]+)\]$/.exec(sel);
        if (!attr) return [];
        const key = attr[1].replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
        return (String(this.innerHTML).match(new RegExp('data-' + attr[1] + '="([^"]*)"', 'g')) || []).map(m => {
          const v = /"([^"]*)"/.exec(m)[1];
          const k = sel + v;
          if (!found.has(k)) found.set(k, { innerHTML: '', textContent: '', disabled: false, dataset: { [key]: v }, onclick: null });
          return found.get(k);
        });
      },
    });
    const els = new Proxy(made, { get: (o, id) => (o[id] = o[id] || mk(id)) });
    const w = { els, toasts: [], sheets: [], calls: [], closed: 0, found };
    const answers = opts.answers || {};
    const deps = {
      $: id => els[id],
      haptic: () => {},
      toast: (msg, kind) => w.toasts.push(String(msg) + '|' + String(kind)),
      openSheet: o => { w.sheets.push(o); els.sheetBody.innerHTML = o.bodyHTML || ''; els.sheetActions.innerHTML = o.actionsHTML || ''; els.sheetTitle.textContent = o.title || ''; },
      closeSheet: () => { w.closed++; },
      handleRpcError: (e, v) => { w.toasts.push('error:' + e.message); if (v) v.innerHTML = 'ERR ' + e.message; },
      moreBack: () => '<button>← More</button>',
      state: { token: TOKEN, me: { role: opts.role } },
      call: async (m, ...a) => { w.calls.push([m, a]); const x = answers[m]; if (x instanceof Error) throw x; return typeof x === 'function' ? x(...a) : x; },
      receiptWhen_: iso => 'WHEN(' + iso + ')',
      receiptUnitPrice_: text => { const s = String(text); return s.charAt(0) === '-' ? '-$' + s.slice(1) : '$' + s; },
    };
    const names = Object.keys(deps);
    w.fns = new Function(...names, CONSTS.map(constSrc).join('\n') + '\n' + H.fnSource(js, 'esc') + '\n' + H.fnSource(js, 'money') + '\n' + own + '; return { costsState_, ' + SCREEN.join(', ') + ' };')(...names.map(n => deps[n]));
    return w;
  }
  const strip = html => String(html).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  // ── Pure helpers ──────────────────────────────────────────
  {
    const w = world({ role: 'manager' });
    t.eq(label + ': a date as "Nov 20"', w.fns.costDate_(thisYear + '-11-20'), 'Nov 20');
    t.eq(label + ': another year keeps its year', w.fns.costDate_('2019-01-05'), 'Jan 5, 2019');
    t.eq(label + ': a unit cost keeps every decimal', [w.fns.costEach_('1.459'), w.fns.costEach_('0.3333'), w.fns.costEach_('6.00')], ['$1.459 each', '$0.3333 each', '$6.00 each']);
    t.eq(label + ': a cost that is not there is never $0.00', [w.fns.costEach_(null), w.fns.costEach_(undefined), w.fns.costEach_('')], ['no cost recorded', 'no cost recorded', 'no cost recorded']);
    t.eq(label + ': the flag reads as a sentence a manager can act on', strip(w.fns.costFlagSentence_(flag({}))), 'Cola 12-pack (CK12) from Fictional Wholesale Ltd: $1.20 → $1.35 each, up 12.5%, on the receipt of Nov 20');
    const worked = strip(w.fns.costFlagSentence_(flag({ to: Object.assign({}, flag({}).to, { how: 'worked_out' }) })));
    t.ok(label + ': a worked-out cost in a flag says so', /the new cost was worked out from the line total/.test(worked) && !/earlier cost was/.test(worked));
    const oneNoCode = strip(w.fns.costFlagSentence_(flag({ item: { id: 'it1', code: null, name: 'Gum', printedAs: 'Gum', joined: false } })));
    t.ok(label + ': an item with no code has none shown', /^Gum from Fictional Wholesale Ltd:/.test(oneNoCode));
    const hostile = w.fns.costFlagSentence_(flag({ item: { id: 'it1', code: '<img src=x onerror=alert(1)>', name: '<script>alert(1)</script>', printedAs: 'x', joined: false }, supplier: { id: 'sp1', name: 'A & "B" <i>Ltd</i>' } }));
    t.ok(label + ': hostile text in an item or supplier name is escaped', hostile.indexOf('<script>') === -1 && hostile.indexOf('<img') === -1 && hostile.indexOf('<i>') === -1 && /&lt;script&gt;/.test(hostile) && /A &amp; &quot;B&quot; &lt;i&gt;Ltd&lt;\/i&gt;/.test(hostile));
    const notes = w.fns.costFlagNotes_(flag({ raisedBecause: 'join', item: { id: 'it1', code: null, name: 'Gum', printedAs: 'GUM <b>2</b>', joined: true }, state: 'seen', mark: { by: 'Bram Hale', at: 'T', note: 'looked <b>at</b>' } }));
    t.ok(label + ': the notes say it was found by joining, who marked it, and the percentage; escaped', /found when two items were joined as one/.test(notes) && /last marked by Bram Hale/.test(notes) && /more than 5%/.test(notes) && notes.indexOf('<b>') === -1 && /across items joined as one/.test(notes));
    const gone = w.fns.costFlagNotes_(flag({ state: 'withdrawn', withdrawn: { reason: 'receipt_voided', at: 'T' } }));
    t.ok(label + ': a withdrawn flag says why', /withdrawn: a receipt it rested on was voided/.test(gone));
    const row = w.fns.costItemRowHTML_(item({ name: 'Cola <b>x</b>', supplier: { id: 's', name: '<u>S</u>' }, latest: { cost: '3.3333', date: thisYear + '-11-20', how: 'worked_out', receiptId: 'pr' } }));
    t.ok(label + ': an item row shows its latest cost undistorted, marked worked out, escaped', /latest \$3\.3333 each, Nov 20 \(worked out from the line total\)/.test(row) && row.indexOf('<b>x') === -1 && row.indexOf('<u>') === -1);
    const none = w.fns.costItemRowHTML_(item({ latest: null, observations: 0 }));
    t.ok(label + ': an item with no counted cost says so, never $0.00', /no cost recorded/.test(none) && !/\$0\.00/.test(none));
    const hh = w.fns.costItemHTML_(HISTORY({ history: [cost({ cost: '3.3333', how: 'worked_out', quantity: '3', lineTotal: '10.00' }), cost({ costId: 'ic3', cost: '1.459', date: thisYear + '-11-21' })], notCounted: [cost({ costId: 'ic4', cost: '9.99', notCounted: { reason: 'receipt_voided', at: 'T' } })] }), true);
    t.ok(label + ': the history marks a worked-out cost with how it was worked out', /worked out from the line total \(\$10\.00 ÷ 3\)/.test(hh) && /\$3\.3333 each/.test(hh) && /\$1\.459 each/.test(hh));
    t.ok(label + ': a cost that is not counted is listed apart, with why', /Not counted<\/div>[\s\S]*\$9\.99 each[\s\S]*Not counted: its receipt was voided/.test(hh));
    t.ok(label + ': the history shows no $0.00', !/\$0\.00/.test(hh));
    const hostileHistory = w.fns.costItemHTML_(HISTORY({ item: { id: 'it1', code: null, name: 'n', supplier: { id: 's', name: '<b>S</b>' } }, history: [cost({ printedAs: { code: '<i>c</i>', description: '<script>x</script>' }, invoiceNumber: '<b>1</b>' })] }), true);
    t.ok(label + ': hostile text in a history is escaped', hostileHistory.indexOf('<script>') === -1 && hostileHistory.indexOf('<i>c') === -1 && hostileHistory.indexOf('<b>1') === -1 && hostileHistory.indexOf('<b>S') === -1);
  }

  // ── The screen cannot be asked for without a business ─────
  pending.push((async () => {
    for (const role of ['admin', 'manager', 'payroll_admin']) {
      const w = world({ role, answers: {} });
      await w.fns.loadCostsTab();
      const h = w.els['view-costs'].innerHTML;
      t.ok(label + ': ' + role + ': no business chosen: it asks for one and makes no call', /Choose a business/.test(w.els.costsBody.innerHTML) && /data-costs-business="cstore"/.test(h) && /data-costs-business="vape"/.test(h) && w.calls.length === 0);
      t.ok(label + ': ' + role + ': there is no "both" choice', !/data-costs-business="both"|>both</.test(h));
    }
    const w = world({ role: 'manager', answers: {} });
    await w.fns.loadCostFlags_(true);
    await w.fns.loadCostItems_(null);
    t.ok(label + ': the loaders themselves refuse to ask with no business', w.calls.length === 0);
    w.fns.costsState_.business = 'both';
    await w.fns.loadCostFlags_(true);
    t.ok(label + ': nor with a business that is not one of the two', w.calls.length === 0);
  })());

  // ── Per role: what is rendered and what can be done ───────
  pending.push((async () => {
    const answers = () => ({
      rpcGetPriceFlags: FLAGS([flag({}), flag({ id: 'pf' + 'b'.repeat(20), item: { id: 'it' + '2'.repeat(20), code: null, name: 'Gum <b>x</b>', printedAs: 'Gum', joined: false } })], { seen: 1 }),
      rpcFindItems: { business: 'cstore', suppliers: [{ id: 'sp' + '9'.repeat(20), name: 'Fictional <i>Wholesale</i> Ltd' }], items: [item({}), item({ id: 'it' + '2'.repeat(20), name: 'Gum', code: null, latest: null, observations: 0 })], next: null },
      rpcGetItemCosts: HISTORY({}),
      rpcSetPriceFlag: { message: 'Marked: seen.', flag: {} },
      rpcJoinItems: { message: 'Joined.' },
      rpcObserveEarlierReceipts: { message: 'Worked out 3 earlier receipts: 4 lines added to the cost history, 1 line with no cost (not guessed), 1 price rise flagged.' },
    });
    for (const role of ['admin', 'manager']) {
      const w = world({ role, answers: answers() });
      await w.fns.loadCostsTab();
      w.fns.costsState_.business = 'cstore';
      await w.fns.loadCostsTab();
      const call0 = w.calls.find(c => c[0] === 'rpcGetPriceFlags');
      t.eq(label + ': ' + role + ': the flags are asked for one business and the New state, with no business ever left out', call0 && call0[1], [TOKEN, { business: 'cstore', state: 'new', limit: 20 }]);
      const h = w.els.costFlags.innerHTML;
      t.ok(label + ': ' + role + ': the flags as sentences, the counts per state, New first', strip(h).indexOf('Cola 12-pack (CK12) from Fictional Wholesale Ltd: $1.20 → $1.35 each, up 12.5%, on the receipt of Nov 20') !== -1 && /New \(2\)/.test(h) && /Seen \(1\)/.test(h) && /Price raised \(0\)/.test(h) && /Withdrawn \(0\)/.test(h));
      t.ok(label + ': ' + role + ': each flag has Seen, Price raised and History', count(h, 'data-flag-seen=') === 2 && count(h, 'data-flag-raised=') === 2 && count(h, 'data-flag-history=') === 2 && count(h, 'data-flag-new=') === 0);
      t.ok(label + ': ' + role + ': an item name with HTML is escaped', h.indexOf('<b>x') === -1 && /Gum &lt;b&gt;x&lt;\/b&gt;/.test(h));
      t.ok(label + ': ' + role + ': the supplier choice escapes names', w.els.costFindSupplier.innerHTML.indexOf('<i>Wholesale') === -1 && /Fictional &lt;i&gt;Wholesale&lt;\/i&gt; Ltd/.test(w.els.costFindSupplier.innerHTML) && w.calls.some(c => c[0] === 'rpcFindItems'));
      t.eq(label + ': ' + role + ': "Work out costs for earlier receipts" is for an admin only', /costsCatchUp/.test(w.els['view-costs'].innerHTML), role === 'admin');
      // Seen: one call with the flag id and the state, nothing else.
      w.fns.drawCostFlags_();
      const seen = w.els.costFlags.querySelectorAll('[data-flag-seen]')[0];
      await seen.onclick();
      t.eq(label + ': ' + role + ': Seen sends the flag and the state only', (w.calls.find(c => c[0] === 'rpcSetPriceFlag') || [])[1], [TOKEN, { flagId: 'pf' + 'a'.repeat(20), state: 'seen' }]);
      // Price raised: a sheet with an optional note.
      w.fns.openCostRaisedSheet_('pf' + 'a'.repeat(20));
      w.els.costRaisedNote.value = 'Cola now $8.49 on both tills';
      await w.els.costRaisedGo.onclick();
      const raised = w.calls.filter(c => c[0] === 'rpcSetPriceFlag')[1];
      t.eq(label + ': ' + role + ': Price raised sends the note typed', raised && raised[1], [TOKEN, { flagId: 'pf' + 'a'.repeat(20), state: 'price_raised', note: 'Cola now $8.49 on both tills' }]);
      // Find an item, then its history, with the join control.
      await w.fns.drawCostFind_();
      w.els.costFindSupplier.value = 'sp' + '9'.repeat(20);
      w.els.costFindText.value = 'cola';
      await w.els.costFindGo.onclick();
      const find = w.calls.filter(c => c[0] === 'rpcFindItems').pop();
      t.eq(label + ': ' + role + ': Find sends the business, the supplier and the text', find && find[1], [TOKEN, { business: 'cstore', limit: 20, supplierId: 'sp' + '9'.repeat(20), text: 'cola' }]);
      t.ok(label + ': ' + role + ': the items: a cost shown whole, an item with none says so', /latest \$1\.35 each, Nov 20/.test(w.els.costItems.innerHTML) && /no cost recorded/.test(w.els.costItems.innerHTML));
      await w.fns.openCostItem_('it' + '1'.repeat(20));
      const body = w.els.sheetBody.innerHTML;
      t.ok(label + ': ' + role + ': the history lists the costs in order, the flag on the one that rose, and the join control', /\$1\.20 each[\s\S]*\$1\.35 each[\s\S]*Up 12\.5% on the cost before it \(new\)/.test(body) && /costJoinOpen/.test(body));
    }
    // A payroll admin reads: no mark, no join, no catch-up.
    const p = world({ role: 'payroll_admin', answers: answers() });
    p.fns.costsState_.business = 'cstore';
    await p.fns.loadCostsTab();
    const ph = p.els.costFlags.innerHTML;
    t.ok(label + ': payroll admin: the flags are read only (no Seen, Price raised or New control)', /Cola 12-pack/.test(strip(ph)) && !/data-flag-seen|data-flag-raised|data-flag-new/.test(ph) && /data-flag-history=/.test(ph));
    t.ok(label + ': payroll admin: no catch-up button', !/costsCatchUp/.test(p.els['view-costs'].innerHTML));
    await p.fns.openCostItem_('it' + '1'.repeat(20));
    t.ok(label + ': payroll admin: the history has no join control', !/costJoinOpen|data-cost-unjoin/.test(p.els.sheetBody.innerHTML) && /\$1\.35 each/.test(p.els.sheetBody.innerHTML));
    // Marked flags offer the other states; a withdrawn flag offers nothing but its history.
    const m = world({ role: 'manager', answers: { rpcGetPriceFlags: FLAGS([flag({ state: 'price_raised', mark: { by: 'Bram Hale', at: 'T', note: null } }), flag({ id: 'pf' + 'c'.repeat(20), state: 'withdrawn', withdrawn: { reason: 'history_changed', at: 'T' } })]) } });
    m.fns.costsState_.business = 'cstore';
    m.fns.costsState_.flagState = 'price_raised';
    await m.fns.loadCostsTab();
    const mh = m.els.costFlags.innerHTML;
    t.ok(label + ': a flag already marked offers Seen and Mark new again, not Price raised again; a withdrawn flag only its history', count(mh, 'data-flag-seen=') === 1 && count(mh, 'data-flag-new=') === 1 && count(mh, 'data-flag-raised=') === 0 && count(mh, 'data-flag-history=') === 2);
    // The catch-up: an admin only; says how many receipts and lines.
    const a = world({ role: 'admin', answers: answers() });
    await a.fns.loadCostsTab();
    await a.els.costsCatchUp.onclick();
    t.ok(label + ': the catch-up calls the RPC with the token only, and shows what it did', (a.calls.find(c => c[0] === 'rpcObserveEarlierReceipts') || [])[1].length === 1 && /Worked out 3 earlier receipts: 4 lines/.test(a.els.costsCatchUpMsg.textContent));
    // A refusal from the server is shown, not swallowed.
    const bad = world({ role: 'manager', answers: Object.assign(answers(), { rpcJoinItems: new Error('Those items come from different suppliers. Nothing was joined.') }) });
    bad.fns.costsState_.business = 'cstore';
    bad.fns.drawCostJoinPicker_(HISTORY({}));
    await new Promise(r => setTimeout(r, 0));
    bad.els.costJoinList.querySelectorAll('[data-join-into]')[0].onclick();
    bad.els.costReason.value = 'the supplier renamed it';
    await bad.els.costReasonGo.onclick();
    t.ok(label + ': a refused join shows the server\'s words and can be tried again', /different suppliers\. Nothing was joined/.test(bad.els.costReasonErr.textContent) && bad.els.costReasonGo.disabled === false);
    // A join: the reason, the item and the one it is joined into, from the picker.
    const j = world({ role: 'manager', answers: answers() });
    j.fns.costsState_.business = 'cstore';
    const h = HISTORY({});
    j.fns.drawCostJoinPicker_(h);
    await new Promise(r => setTimeout(r, 0));
    t.ok(label + ': the join picker lists the supplier\'s other items (not the item itself)', j.els.costJoinList.innerHTML.indexOf('data-join-into="it' + '2'.repeat(20) + '"') !== -1 && j.els.costJoinList.innerHTML.indexOf('data-join-into="' + h.item.id + '"') === -1);
    const picked = j.els.costJoinList.querySelectorAll('[data-join-into]')[0];
    picked.onclick();
    j.els.costReason.value = 'same line, renamed';
    await j.els.costReasonGo.onclick();
    t.eq(label + ': joining sends the item, the one it is joined into and the reason; the person comes from the session', (j.calls.find(c => c[0] === 'rpcJoinItems') || [])[1], [TOKEN, { itemId: h.item.id, intoItemId: 'it' + '2'.repeat(20), reason: 'same line, renamed' }]);
  })());
});

// ── The Receipts screen's confirm and void sheets repeat the server's summary ──
{
  t.section('The Receipts screen');
  const src = fs.readFileSync(path.join(H.SRC, 'Index.html'), 'utf8');
  t.ok('the confirm sheet shows the cost summary the server answers', /r\.costs && r\.costs\.message \? '<div class="payroll-rate">' \+ esc\(r\.costs\.message\)/.test(src.slice(src.indexOf("await call('rpcConfirmReceipt'"), src.indexOf("await call('rpcConfirmReceipt'") + 2500)));
  t.ok('the void sheet shows the cost summary the server answers', /r\.costs && r\.costs\.message \? '<div class="payroll-rate">' \+ esc\(r\.costs\.message\)/.test(src.slice(src.indexOf("await call('rpcVoidReceipt'"), src.indexOf("await call('rpcVoidReceipt'") + 1200)));
}

// ── The built Operations page carries the screen; Apps Script hides it ──
{
  t.section('The two apps');
  const built = require('child_process').execFileSync(process.execPath, [path.join(H.REPO, 'ops', 'tools', 'build-ui.mjs'), '--stdout'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  t.ok('the built page has the view, the loader, the opsOnly entry and every call',
    built.indexOf('<div class="view" id="view-costs"></div>') !== -1 && built.indexOf('async function loadCostsTab(') !== -1 && /\{ tab: 'costs'[^\n]*opsOnly: true/.test(built) &&
    CALLS.every(c => built.indexOf("'" + c + "'") !== -1));
  const src = fs.readFileSync(path.join(H.SRC, 'Index.html'), 'utf8');
  t.ok('the Apps Script page never loads the transport, so the entry is hidden there', src.indexOf('/transport.js') === -1 && /\{ tab: 'costs'[^\n]*opsOnly: true/.test(src));
  t.ok('no template tag in the page', src.indexOf('<?') === -1 && built.indexOf('<?') === -1);
}

Promise.all(pending).then(() => t.done()).catch(e => { console.log('  ✗ suite threw: ' + (e && e.stack || e)); process.exit(1); });
