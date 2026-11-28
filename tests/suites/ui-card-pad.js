// ============================================================
//  ui-card-pad — a card filled directly keeps its inner margin (card P5-17)
// ============================================================
//  The class .payroll-card (white, rounded, overflow: hidden) was made for the
//  Payroll screen, whose children .payroll-card-head and .payroll-card-body
//  carry the padding. The Operations-only screens put their text straight
//  inside it, and on a phone the first letter was cut by the rounded corner.
//  The fix is one new class, card-pad, on every card whose content is placed
//  directly inside it. Held down here:
//   - the Payroll rules are byte-identical to before (pinned);
//   - every card in the page is either wrapped in head/body or carries
//     card-pad: the next screen that forgets fails this suite;
//   - the only direct cards without it are the two Apps Script screens that
//     were never changed (Suppliers, Product Master);
//   - hostile text is still escaped in the cards that were touched.
// ============================================================
const H = require('./_lib/harness');
const fs = require('fs');
const path = require('path');
const t = H.suite('Card padding — directly filled cards');

// The Payroll rules, as they were before this card (pinned character for character).
const PAYROLL_RULES = [
  '  .payroll-card {\n    background: white;\n    border-radius: 14px;\n    margin-bottom: 10px;\n    overflow: hidden;\n    box-shadow: 0 1px 3px rgba(0,0,0,0.06);\n  }\n',
  '  .payroll-card-head {\n    padding: 13px 16px;\n    display: flex; align-items: center; justify-content: space-between;\n    border-bottom: 1px solid #f0f1f5;\n  }\n',
  '  .payroll-body { padding: 10px 16px; }\n',
];
// Every directly filled card now carries the class, the live app's Suppliers screen included (the owner, Nov 28).
// Product Master's card wraps its content in rows that carry their own padding, so it counts as wrapped.
const UNCHANGED_SCREENS = [];

const src = fs.readFileSync(path.join(H.SRC, 'Index.html'), 'utf8');

t.section('The Payroll rules');
PAYROLL_RULES.forEach((r, i) => t.ok('rule ' + (i + 1) + ' of ' + PAYROLL_RULES.length + ' is byte-identical to before', src.indexOf(r) !== -1));
t.ok('the new class is its own rule, with the same horizontal padding as the card head', /\n  \.card-pad \{ padding: \d+px 16px; \}\n/.test(src));

// Every use of the class: whether the next element is the head or body, and the function it sits in.
function uses(js) {
  const out = [];
  const re = /class="payroll-card((?: [^"]*)?)"/g;
  let m;
  while ((m = re.exec(js))) {
    const after = js.slice(m.index + m[0].length);
    const tagEnd = after.indexOf('>');
    const next = after.slice(tagEnd + 1, tagEnd + 120);
    const wrapped = /^[^<]*<div class="(payroll-card-(head|body)|product-row-head)/.test(next);
    const before = js.slice(0, m.index);
    const at = Math.max(before.lastIndexOf('\n  function '), before.lastIndexOf('\n  async function '));
    const fn = (/function ([A-Za-z0-9_]+)\(/.exec(before.slice(at)) || [])[1];
    out.push({ extra: m[1], wrapped, fn });
  }
  return out;
}

H.uiScripts().forEach(([label, js]) => {
  t.section('Against ' + label);
  const all = uses(js);
  t.ok(label + ': the page has its cards', all.length === 26);
  const direct = all.filter(u => !u.wrapped);
  const bare = direct.filter(u => !/\bcard-pad\b/.test(u.extra));
  t.eq(label + ': every directly filled card carries card-pad', bare.map(u => u.fn).sort(), UNCHANGED_SCREENS);
  t.eq(label + ': a card wrapped in head/body never has card-pad (no doubled margin)', all.filter(u => u.wrapped && /card-pad/.test(u.extra)).length, 0);
  t.eq(label + ': fourteen cards carry the class', direct.length - bare.length, 14);
  t.ok(label + ': the Suppliers card carries it', all.some(u => u.fn === 'renderSuppliersTab' && /\bcard-pad\b/.test(u.extra)));
  t.ok(label + ': the Product Master card is wrapped (its rows are padded) and has no card-pad', all.filter(u => u.fn === 'renderProductsTab').every(u => u.wrapped && !/card-pad/.test(u.extra)));
  t.ok(label + ': no "<?" anywhere in the page script', js.indexOf('<?') === -1);

  // Hostile text is still escaped in the touched cards that can be drawn on their own.
  const HOST = '<img src=x onerror=alert(1)>';
  const names = ['esc', 'money', 'receiptWhen_', 'receiptEmailRowHTML_', 'businessSignText_', 'businessCardHTML_', 'legacyCents_', 'legacySupplierHTML_', 'legacySortedWords_', 'legacySpellingHTML_', 'legacyRowHTML_'];
  const consts = ['RECEIPT_EMAIL_WORDS', 'BUSINESS_SIGN_KINDS', 'LEGACY_VIEWS'].map(n => new RegExp('  const ' + n + ' [^\\n]*').exec(js)[0]).join('\n');
  const fns = new Function(consts + '\n' + names.map(n => H.fnSource(js, n)).join('\n') + '; return { receiptEmailRowHTML_, businessCardHTML_, legacySpellingHTML_, legacyRowHTML_ };')();
  const outs = [
    fns.receiptEmailRowHTML_({ id: HOST, subject: HOST, from: HOST, date: '2026-11-26T14:14:00.000Z', outcome: 'could_not_read', originals: 1, note: HOST, recordedBy: { name: HOST, keyLabel: HOST }, recordedAt: '2026-11-26T14:20:00.000Z' }),
    fns.businessCardHTML_({ key: 'cstore', displayName: HOST, legalName: HOST, hstNumber: HOST, notes: HOST, signs: [] }, true),
    fns.legacyRowHTML_({ supplier: HOST, date: '2026-01-02', amountCents: 1250, note: HOST, linked: { name: HOST }, sheetRow: 7, business: '' }, true),
    fns.legacySpellingHTML_({ text: HOST, variants: 2, totalCents: 1250, rows: 2, supplier: { name: HOST }, partlyLinked: false, business: '' }, 0, true),
  ];
  outs.forEach((o, i) => {
    t.ok(label + ': card ' + (i + 1) + ': hostile text escaped, nothing live', o.indexOf('<img') === -1 && o.indexOf('&lt;img src=x onerror=alert(1)&gt;') !== -1);
    t.ok(label + ': card ' + (i + 1) + ': carries card-pad', /^<div class="payroll-card card-pad"/.test(o));
  });
});

t.done();
