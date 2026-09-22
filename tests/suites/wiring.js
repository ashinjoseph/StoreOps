// ============================================================
//  wiring — the close sheet's fields, end to end
// ============================================================
//  rpcCloseShift is a translation layer: the form's names are not the
//  ledger's names, so every field is renamed on its way through. That makes
//  a dropped field silent — it does not throw, it arrives as 0 or null and
//  the shift closes with a number nobody typed. These assertions walk each
//  field from the payload the browser actually builds to the object
//  TillSessions.close receives.
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('RPC field forwarding');

// ── What the browser sends ──────────────────────────────────
// Read the keys out of the real call site rather than restating them here:
// a field added to the form and forgotten on the server should fail this
// suite without anyone remembering to update it.
const ui = H.read('Index.html');
const at = ui.indexOf("call('rpcCloseShift'");
const payloadSrc = ui.slice(at, ui.indexOf('});', at));
// A key is an identifier whose nearest non-space neighbour to the left is a
// brace, a comma or a line break — which picks up the first key inside each
// `cardSplit ? { … }` branch without also catching the bare identifier in a
// ternary's true arm.
const uiFields = [];
payloadSrc.replace(/(^|[{,])\s*([A-Za-z_$][\w$]*)\s*[:,]/gm, (m, _pre, k) => {
  if (uiFields.indexOf(k) === -1) uiFields.push(k);
  return m;
});

const server = H.read('WebApp.gs');
const closeSrc = H.fnSource(server, 'rpcCloseShift');

t.section('Every field the close sheet sends is read by the server');
t.ok('the call site was found', uiFields.length > 5);
// Pin the shape-bearing fields by name too: if the extractor above ever stops
// matching, the loop below would pass by finding nothing to check.
['cashSales', 'creditCardSales', 'debitCardSales', 'cardTotalSales',
 'miscCardSales', 'miscCreditSales', 'physicalCount', 'lottoCounted']
  .forEach(f => t.ok('the close sheet still sends ' + f, uiFields.indexOf(f) !== -1));
uiFields.forEach(f => {
  t.ok(f + ' is consumed by rpcCloseShift', closeSrc.indexOf('input.' + f) !== -1);
});

// ── What the server forwards ────────────────────────────────
let captured, returned;
function callClose(input, session) {
  captured = null;
  H.sheets({ config: {} });
  H.load(['Util.gs', 'WebApp.gs'], {
    Auth: { validate: () => session || { staffId: 'S1', name: 'Ash', role: 'cashier' } },
    Staff: { getAll: () => [] },
    TillSessions: {
      getById: () => ({ sessionId: 'SES1', staffId: 'S1', company: 'cstore' }),
      close: arg => {
        captured = arg;
        return {
          session: { sessionId: 'SES1', startTime: new Date('2026-09-14T09:00:00Z') },
          expectedCash: 700, counted: 690, variance: -10, cashRemoved: 440,
          floatLeft: 250, varianceStatus: 'OK',
          lottoReserveCounted: 500, lottoReserveShort: 0,
        };
      },
    },
    Sales: {}, CashHandling: {}, Reconcile: {}, Notifier: {},
  });
  returned = rpcCloseShift('tok', input);
  return captured;
}

const full = {
  sessionId: 'SES1', cashSales: 450, creditCardSales: 300, debitCardSales: 120,
  cashbackPaid: 0, miscCashSales: 20, miscCreditSales: 5, miscDebitSales: 7,
  miscNotes: 'two bags', physicalCount: 690,
  lottoCounted: 500, lottoTopupFromTill: 50, lottoNote: 'topped up',
};

t.section('A split-card close forwards every field under its ledger name');
const c = callClose(full);
t.eq('sessionId', c.sessionId, 'SES1');
t.eq('cashSales', c.cashSales, 450);
t.eq('creditCardSales → creditCard', c.creditCard, 300);
t.eq('debitCardSales → debitCard', c.debitCard, 120);
t.eq('miscCashSales → miscCash', c.miscCash, 20);
t.eq('miscCreditSales → miscCredit', c.miscCredit, 5);
t.eq('miscDebitSales → miscDebit', c.miscDebit, 7);
t.eq('miscNotes carried verbatim', c.miscNotes, 'two bags');
t.eq('physicalCount', c.physicalCount, 690);
t.eq('lottoCounted', c.lottoCounted, 500);
t.eq('lottoTopupFromTill', c.lottoTopupFromTill, 50);
t.eq('lottoNote', c.lottoNote, 'topped up');

t.section('Blank is not zero — the card shape survives the hop');
// TillSessions reads the row's card shape from which fields are PRESENT, so
// an absent field coerced to 0 here would make every ePOS close look like a
// credit/debit split and put the reconciler back on a column that is gone.
const epos = callClose({
  sessionId: 'SES1', cashSales: 450, cardTotalSales: 380,
  cashbackPaid: 0, miscCashSales: 0, miscCardSales: 12,
  miscNotes: '', physicalCount: 690, lottoCounted: null, lottoTopupFromTill: 0, lottoNote: '',
});
t.eq('cardTotalSales → cardTotal', epos.cardTotal, 380);
t.eq('miscCardSales → miscCard', epos.miscCard, 12);
t.eq('an absent creditCard stays null', epos.creditCard, null);
t.eq('an absent debitCard stays null', epos.debitCard, null);
t.eq('an absent miscCredit stays null', epos.miscCredit, null);
t.eq('an absent miscDebit stays null', epos.miscDebit, null);
const split = callClose(full);
t.eq('and the other way round — cardTotal is null on a split close', split.cardTotal, null);
t.eq('miscCard is null on a split close', split.miscCard, null);

t.section('A recorded zero is a zero, not a blank');
const zeroed = callClose({
  sessionId: 'SES1', cashSales: 0, cardTotalSales: 0, cashbackPaid: 0,
  miscCashSales: 0, miscCardSales: 0, miscNotes: '', physicalCount: 250,
  lottoCounted: 0, lottoTopupFromTill: 0, lottoNote: 'pot emptied',
});
t.eq('a card total of zero is recorded, not dropped', zeroed.cardTotal, 0);
t.eq('a misc card of zero is recorded', zeroed.miscCard, 0);
t.eq('a lotto count of zero is a count, not "not asked"', zeroed.lottoCounted, 0);
// An empty string is what a cleared input posts; it means "not recorded".
const cleared = callClose({
  sessionId: 'SES1', cashSales: 100, cardTotalSales: '', cashbackPaid: 0,
  miscCashSales: 0, miscNotes: '', physicalCount: 350,
});
t.eq('an emptied card field is blank, not zero', cleared.cardTotal, null);

t.section('Negative cash sales survive — a lotto payout can outrun the takings');
const payout = callClose({
  sessionId: 'SES1', cashSales: -300, cardTotalSales: 100, cashbackPaid: 0,
  miscCashSales: 0, miscNotes: '', physicalCount: 250,
  lottoCounted: 200, lottoTopupFromTill: 0, lottoNote: 'big win paid out',
});
t.eq('the sign is not swallowed by a ||0', payout.cashSales, -300);

t.section('Who acted comes from the session, never from the payload');
const spoofed = callClose(
  Object.assign({}, full, { actorId: 'S99', staffId: 'S99' }),
  { staffId: 'S1', name: 'Ash', role: 'cashier' }
);
t.eq('actorId is the caller', spoofed.actorId, 'S1');
t.ok('the payload cannot name a different actor', closeSrc.indexOf('input.actorId') === -1);

t.section('What comes back is serializable');
// The raw close result carries a nested session with Date fields; handing
// that straight back fails on the wire, so the RPC flattens it.
t.eq('sessionId is lifted out of the nested session', returned.sessionId, 'SES1');
t.ok('no nested session object', returned.session === undefined);
const json = JSON.stringify(returned);
t.ok('the whole reply round-trips through JSON', typeof json === 'string');
t.eq('and survives it unchanged', JSON.parse(json), returned);
// Walk the whole reply, not just its top level: a Date nested one object down
// still serializes as a string the client then has to guess the shape of.
function datePaths(value, trail) {
  if (value instanceof Date) return [trail || '(root)'];
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value).reduce(
    (acc, k) => acc.concat(datePaths(value[k], (trail ? trail + '.' : '') + k)), []);
}
t.eq('no Date anywhere in the reply', datePaths(returned), []);
Object.keys(returned).forEach(k => {
  t.ok(k + ' is a primitive, not an object', typeof returned[k] !== 'object' || returned[k] === null);
});
t.eq('variance is forwarded', returned.variance, -10);
t.eq('the lotto shortfall is forwarded', returned.lottoReserveShort, 0);

t.section('Opening a shift is bound to the caller too');
function callOpen(input, session) {
  captured = null;
  H.sheets({ config: {} });
  H.load(['Util.gs', 'WebApp.gs'], {
    Auth: { validate: () => session },
    Staff: { getAll: () => [] },
    TillSessions: {
      open: arg => {
        captured = arg;
        return { sessionId: 'SES2', company: arg.company, staffId: arg.staffId,
                 status: 'open', openingFloat: arg.openingCount,
                 startTime: new Date('2026-09-15T08:00:00Z') };
      },
    },
    Sales: {}, CashHandling: {}, Reconcile: {}, Notifier: {},
  });
  return rpcOpenShift('tok', input);
}
const opened = callOpen({ company: 'cstore', openingCount: '250', openingNote: 'float ok' },
                        { staffId: 'S1', name: 'Ash', role: 'cashier' });
t.eq('the opener is the session, not the payload', captured.staffId, 'S1');
t.eq('the count is coerced to a number', captured.openingCount, 250);
t.eq('the note is carried', captured.openingNote, 'float ok');
t.eq('startTime leaves as an ISO string', opened.startTime, '2026-09-15T08:00:00.000Z');
t.ok('no Date escapes the RPC', !(opened.startTime instanceof Date));

// The RPC logs the refusal before rethrowing; that is the right behaviour in
// production and only noise here, so mute the console for this one call.
t.throws('a cashier cannot open someone else\'s shift', () => {
  const err = console.error;
  console.error = () => {};
  try {
    callOpen({ staffId: 'S9', company: 'cstore', openingCount: 250 },
             { staffId: 'S1', name: 'Ash', role: 'cashier' });
  } finally { console.error = err; }
}, 'FORBIDDEN');
const byAdmin = callOpen({ staffId: 'S9', company: 'cstore', openingCount: 250 },
                         { staffId: 'S0', name: 'Boss', role: 'admin' });
t.eq('an admin can', captured.staffId, 'S9');
t.eq('but the audit still names the admin', captured.actorId, 'S0');

t.done();
