// ============================================================
//  ui-close-sheet — the form the cashier actually fills in
// ============================================================
//  Everything the server rejects, the sheet has to get right first: which
//  card fields exist for this till, whether a lotto pot is in play, and which
//  single field is allowed to go negative. None of that is reachable from a
//  server test — it is decided in the browser, built as a string, and wired
//  up by id. So run the real function against a stub document and inspect
//  what it produced.
// ============================================================
const vm = require('vm');
const H = require('./_lib/harness');
const DOM = require('./_lib/dom');
const t = H.suite('Close sheet — shape, sign and sums');

// The sum assertions run after the sheet's own async float fetch settles, so a
// throw in there would otherwise end the process quietly with a green count.
process.on('unhandledRejection', err => {
  console.log('  ✗ the async half of the suite threw: ' + (err && err.stack || err));
  process.exit(1);
});

// ── Lift the client code ────────────────────────────────────
const js = H.clientScript('Index.html');
const NEEDED = ['esc', 'money', 'fmtDate', 'moneyInput', 'wireMoneyInputs', 'closeShiftForm'];
const lifted = NEEDED.map(n => H.fnSource(js, n)).join('\n\n');

/**
 * Open the close sheet for one till and return everything the test needs to
 * poke at it: the rendered fields, the sheet's own metadata, and the wiring
 * the function attached after rendering.
 */
function openClose(opts) {
  opts = opts || {};
  let sheet = null;
  let dom = { $: () => null, has: () => false };
  const ctx = {
    console: { log() {}, error() {}, warn() {} },
    navigator: {},
    state: {
      token: 'tok',
      cardSplit: opts.cardSplit === undefined ? undefined : opts.cardSplit,
      lotto: opts.lotto === undefined
        ? { enabled: true, expected: 500, lastCounted: opts.lastCounted === undefined ? 500 : opts.lastCounted }
        : opts.lotto,
    },
    TTL_LIVE: 60000,
    $: id => dom.$(id),
    openSheet: spec => {
      sheet = spec;
      dom = DOM.fromHTML(String(spec.bodyHTML) + String(spec.actionsHTML || ''));
    },
    closeSheet: () => {},
    haptic: () => {},
    toast: () => {},
    // The sheet refines the float asynchronously; resolve it inline so the
    // numbers under test are the ones a loaded sheet really holds.
    cachedCall: () => Promise.resolve({
      cards: [{ company: opts.company || 'cstore',
                state: 'open_by_me',
                expectedFloat: opts.floatValue === undefined ? 250 : opts.floatValue,
                detail: { openingFloat: opts.openingFloat === undefined ? 250 : opts.openingFloat } }],
    }),
    call: () => Promise.resolve({}),
    setTimeout: fn => fn(),
  };
  vm.createContext(ctx);
  vm.runInContext(lifted + '\ncloseShiftForm(' + JSON.stringify(opts.sessionId || 'SES1') +
    ', ' + JSON.stringify(opts.company || 'cstore') + ', ' +
    JSON.stringify(opts.cardFloat === undefined ? 250 : opts.cardFloat) + ');', ctx);
  return { sheet: sheet, dom: dom, ctx: ctx };
}

/** Let the queued float fetch settle, then recompute as the sheet would. */
function settled(s) {
  return new Promise(res => setImmediate(() => { s.dom.fire(s.dom.get('closeCount'), 'input'); res(s); }));
}

// ── Card shape ──────────────────────────────────────────────
t.section('A split till asks for credit and debit, and nothing else');
const split = openClose({ company: 'vape', cardSplit: { vape: true } });
t.ok('credit field rendered', split.dom.has('closeCredit'));
t.ok('debit field rendered', split.dom.has('closeDebit'));
t.ok('no single card field', !split.dom.has('closeCard'));
t.ok('misc credit rendered', split.dom.has('closeMiscCredit'));
t.ok('misc debit rendered', split.dom.has('closeMiscDebit'));
t.ok('no misc card field', !split.dom.has('closeMiscCard'));

t.section('An ePOS till asks for one card figure, and nothing else');
const epos = openClose({ company: 'cstore', cardSplit: { cstore: false } });
t.ok('single card field rendered', epos.dom.has('closeCard'));
t.ok('no credit field', !epos.dom.has('closeCredit'));
t.ok('no debit field', !epos.dom.has('closeDebit'));
t.ok('misc card rendered', epos.dom.has('closeMiscCard'));
t.ok('no misc credit field', !epos.dom.has('closeMiscCredit'));
t.ok('no misc debit field', !epos.dom.has('closeMiscDebit'));

t.section('An older payload with no card_split keeps the form it always had');
// Nothing here hardcodes a till name; a payload that predates the field must
// not silently switch a till to the other shape.
const legacy = openClose({ company: 'cstore', cardSplit: undefined });
t.ok('defaults to the split form', legacy.dom.has('closeCredit') && legacy.dom.has('closeDebit'));
t.ok('and not the single figure', !legacy.dom.has('closeCard'));

// ── Lotto belongs to one till ───────────────────────────────
t.section('The lotto pot is a cstore thing only');
const vape = openClose({ company: 'vape', cardSplit: { vape: true } });
t.ok('no reserve count on a vape close', !vape.dom.has('closeLotto'));
t.ok('no top-up row', !vape.dom.has('closeLottoTopup'));
t.ok('no reserve line in the summary', !vape.dom.has('sumLotto'));
t.ok('and no sign button — a vape till has no payout to make',
     !vape.dom.has('closeCashSign'));

const noPot = openClose({ company: 'cstore', lotto: { enabled: false } });
t.ok('nor when the sheet has no columns for it yet', !noPot.dom.has('closeLotto'));
t.ok('no sign button either', !noPot.dom.has('closeCashSign'));

const cstore = openClose({ company: 'cstore' });
t.ok('cstore gets the reserve count', cstore.dom.has('closeLotto'));
t.ok('cstore gets the reserve summary line', cstore.dom.has('sumLotto'));
t.ok('cstore gets the sign button', cstore.dom.has('closeCashSign'));

// ── The sign button ─────────────────────────────────────────
t.section('The sign button is the only way to type a minus on a phone');
// iOS shows a decimal keypad with no minus key, so the field cannot be typed
// negative there at all — the button is the entire mechanism.
let s = openClose({ company: 'cstore' });
const cashEl = s.dom.get('closeCash');
const signEl = s.dom.get('closeCashSign');
t.eq('the button ships showing a plus', signEl.textContent, '+');
s.dom.fire(signEl, 'click');
t.eq('a tap on an empty field arms the minus', cashEl.value, '-');
t.eq('and the button says so', signEl.textContent, '−');
t.ok('and is marked negative', signEl.classList.contains('neg'));
s.dom.fire(signEl, 'click');
t.eq('tapping back disarms it without leaving a -0', cashEl.value, '');
t.eq('button back to plus', signEl.textContent, '+');
t.ok('and no longer marked negative', !signEl.classList.contains('neg'));

s.dom.type('closeCash', '300');
t.eq('typing leaves the sign alone', signEl.textContent, '+');
s.dom.fire(signEl, 'click');
t.eq('a tap flips a typed amount', cashEl.value, '-300');
t.eq('button follows', signEl.textContent, '−');
s.dom.fire(signEl, 'click');
t.eq('and flips it back', cashEl.value, '300');

t.section('The button mirrors the field rather than holding its own state');
s = openClose({ company: 'cstore' });
// A desktop keyboard can type the minus directly; the button must agree.
s.dom.type('closeCash', '-120');
t.eq('typing a minus lights the button', s.dom.get('closeCashSign').textContent, '−');
s.dom.type('closeCash', '120');
t.eq('clearing it puts the button back', s.dom.get('closeCashSign').textContent, '+');

// ── Which field may go negative ─────────────────────────────
t.section('Exactly one field accepts a minus');
s = openClose({ company: 'cstore' });
t.eq('cash sales keeps it', s.dom.type('closeCash', '-300').value, '-300');
t.eq('misc cash strips it', s.dom.type('closeMiscCash', '-50').value, '50');
t.eq('the drawer count strips it', s.dom.type('closeCount', '-10').value, '10');
t.eq('the reserve count strips it', s.dom.type('closeLotto', '-500').value, '500');
// The top-up is also rewritten by the recalc that follows, so assert the
// invariant that matters rather than a resting value: no minus survives.
t.ok('the top-up strips it', !/-/.test(s.dom.type('closeLottoTopup', '-25').value));
const e2 = openClose({ company: 'cstore', cardSplit: { cstore: false } });
t.eq('the card total strips it', e2.dom.type('closeCard', '-100').value, '100');

t.section('Even on the field that allows it, only one and only in front');
s = openClose({ company: 'cstore' });
t.eq('a trailing minus is a typo', s.dom.type('closeCash', '1-2').value, '12');
t.eq('two minuses are a typo', s.dom.type('closeCash', '--5').value, '-5');
t.eq('letters never survive', s.dom.type('closeCash', '-3a0').value, '-30');
t.eq('one decimal point only', s.dom.type('closeCash', '-3.0.5').value, '-3.05');

t.section('A vape till may not go negative at all — there is no pot to fund it');
const v2 = openClose({ company: 'vape', cardSplit: { vape: true } });
t.eq('cash sales strips the minus there', v2.dom.type('closeCash', '-300').value, '300');

// ── The running sums ────────────────────────────────────────
t.section('Expected cash is float + sales, and says when the reserve fed it');
(async () => {
  s = await settled(openClose({ company: 'cstore', openingFloat: 250, floatValue: 250 }));
  s.dom.type('closeCash', '450');
  s.dom.type('closeMiscCash', '0');
  s.dom.type('closeCount', '700');
  t.eq('expected is float plus takings', s.dom.get('sumExpected').textContent, '$700.00');
  t.eq('counted is echoed', s.dom.get('sumCounted').textContent, '$700.00');
  t.eq('a clean count shows no variance', s.dom.get('sumVariance').textContent, '+$0.00');
  t.eq('and is marked OK', s.dom.get('sumVariance').className, 'compute-variance-OK');
  t.eq('no reserve movement, no reserve row', s.dom.get('sumFedRow').style.display, 'none');

  t.section('Variance thresholds match the bands the server grades on');
  s.dom.type('closeCount', '699.50');
  t.eq('under a dollar is still OK', s.dom.get('sumVariance').className, 'compute-variance-OK');
  s.dom.type('closeCount', '690');
  t.eq('a tenner short is minor', s.dom.get('sumVariance').className, 'compute-variance-minor');
  s.dom.type('closeCount', '650');
  t.eq('over thirty is an investigation', s.dom.get('sumVariance').className,
       'compute-variance-investigate');
  s.dom.type('closeCount', '');
  t.eq('no count yet, no variance claimed', s.dom.get('sumVariance').textContent, '—');
  t.eq('and nothing said about where it goes', s.dom.get('sumDestRow').style.display, 'none');

  t.section('Cash drawn from the reserve is named, not folded in silently');
  // The pot started at $500 and counts $200: $300 of it is in the drawer, so
  // expected cash has to include it or the close reads as a $300 surplus.
  s = await settled(openClose({ company: 'cstore', lastCounted: 500, openingFloat: 250, floatValue: 250 }));
  s.dom.type('closeCash', '-300');
  s.dom.type('closeLotto', '200');
  s.dom.type('closeCount', '250');
  t.eq('expected accounts for the cash the pot fed in',
       s.dom.get('sumExpected').textContent, '$250.00');
  t.eq('the reserve row is shown', s.dom.get('sumFedRow').style.display, '');
  t.eq('and says which way the money went',
       s.dom.get('sumFed').textContent, '$300.00 drawn from reserve');
  t.eq('the close reconciles', s.dom.get('sumVariance').textContent, '+$0.00');

  t.section('Money moved the other way is named the other way');
  s = await settled(openClose({ company: 'cstore', lastCounted: 500, openingFloat: 250, floatValue: 250 }));
  s.dom.type('closeCash', '450');
  s.dom.type('closeLotto', '600');       // someone put cash in mid-shift
  s.dom.type('closeCount', '600');
  t.eq('the row reads as an addition',
       s.dom.get('sumFed').textContent, '$100.00 added to reserve');

  t.section('The counted cash is accounted for all the way out of the drawer');
  s = await settled(openClose({ company: 'cstore', lastCounted: 500, openingFloat: 250, floatValue: 250 }));
  s.dom.type('closeCash', '450');
  s.dom.type('closeCount', '700');
  t.eq('float stays, the rest is in hand',
       s.dom.get('sumDest').textContent, '$250.00 float · $450.00 in hand');

  t.section('A drawer below its float reports the shortfall, not a negative hand');
  // Saying "$250 float · -$250 in hand" states the opposite of what happened.
  s = await settled(openClose({ company: 'cstore', lastCounted: 500, openingFloat: 250, floatValue: 250 }));
  s.dom.type('closeCash', '-300');
  s.dom.type('closeLotto', '500');
  s.dom.type('closeCount', '0');
  t.ok('the shortfall is named', /below the \$250\.00 float/.test(s.dom.get('sumDest').textContent));
  t.ok('and nothing is claimed to be in hand',
       /nothing in hand/.test(s.dom.get('sumDest').textContent));
  t.ok('flagged rather than reported flat',
       s.dom.get('sumDest').className === 'compute-variance-minor');

  t.section('A reason is asked for only once the pot is known to be short');
  s = await settled(openClose({ company: 'cstore', lastCounted: 500, openingFloat: 250, floatValue: 250 }));
  t.eq('nothing asked before a count exists',
       s.dom.get('closeLottoNoteWrap').style.display, 'none');
  s.dom.type('closeLotto', '200');
  s.dom.type('closeCount', '250');
  t.eq('a short pot with a count asks why',
       s.dom.get('closeLottoNoteWrap').style.display, '');
  s.dom.type('closeLotto', '500');
  s.dom.type('closeCount', '700');
  t.eq('a full pot does not', s.dom.get('closeLottoNoteWrap').style.display, 'none');

  t.done();
})();
