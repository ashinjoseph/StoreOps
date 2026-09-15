// ============================================================
//  routing — what a URL serves, and what it must never serve
// ============================================================
//  The public views run with no session at all, so what they publish is the
//  whole of their access control. An unknown ?v= must land on the app rather
//  than an error, and neither public page may carry staff names, session rows
//  or anything that identifies who worked when.
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('doGet routing and public payloads');

let served;
function load(salesPayload, reconPayload) {
  served = [];
  H.sheets({ config: { public_report_url: 'https://example.test/exec' } });
  return H.load(['Util.gs', 'WebApp.gs'], {
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
      createHtmlOutputFromFile: name => {
        served.push({ kind: 'file', name });
        return { setTitle() { return this; }, setXFrameOptionsMode() { return this; },
                 addMetaTag() { return this; } };
      },
      createTemplateFromFile: name => {
        const tpl = { payload: null };
        tpl.evaluate = () => {
          served.push({ kind: 'template', name, payload: tpl.payload });
          return { setTitle() { return this; }, setXFrameOptionsMode() { return this; },
                   addMetaTag() { return this; } };
        };
        return tpl;
      },
    },
    PublicReport: {
      build: () => reconPayload || { rows: [] },
      buildSales: days => Object.assign({ days: days }, salesPayload || {}),
    },
    Auth: { validate: () => { throw new Error('NOT_LOGGED_IN'); } },
    Staff: { getAll: () => [], getActive: () => [] },
    Sales: { cardSplitFor: () => true },
    CashHandling: { sheetsExist: () => false },
    TillSessions: { getExpectedFloat: () => 250, getLottoLog: () => ({ enabled: false }) },
  });
}

t.section('Each view serves its own page');
load();
doGet({ parameter: { v: 'sales' } });
t.eq('?v=sales serves the sales template', served[0].name, 'PublicSales');
load();
doGet({ parameter: { v: 'recon' } });
t.eq('?v=recon serves the reconcile template', served[0].name, 'Public');
load();
doGet({ parameter: {} });
t.eq('no v serves the app', served[0].name, 'Index');
t.eq('as a file, not a template', served[0].kind, 'file');

t.section('A mangled link lands somewhere useful');
load(); doGet({ parameter: { v: 'Sales' } });
t.eq('case-sensitive — falls through to the app', served[0].name, 'Index');
load(); doGet({ parameter: { v: 'nonsense' } });
t.eq('unknown view falls through', served[0].name, 'Index');
load(); doGet(null);
t.eq('no event object at all still serves the app', served[0].name, 'Index');
load(); doGet({});
t.eq('no parameter bag either', served[0].name, 'Index');

t.section('The day window is clamped, not trusted');
// Report a regression rather than exploding on it: if ?v=sales stops serving a
// template at all, every clamp assertion below should fail with the window it
// got, not abort the suite on a JSON.parse of `undefined`.
function daysServed(days) {
  load();
  doGet({ parameter: days === undefined ? { v: 'sales' } : { v: 'sales', days: days } });
  const raw = served[0] && served[0].payload;
  if (typeof raw !== 'string') return 'no sales payload served';
  try { return JSON.parse(raw).days; } catch (err) { return 'unparseable payload'; }
}
t.eq('clamped to a year', daysServed('9999'), 365);
t.eq('at least one day', daysServed('0'), 1);
t.eq('negatives clamped up', daysServed('-5'), 1);
t.eq('junk falls back to the default', daysServed('abc'), 60);
t.eq('absent means 60', daysServed(undefined), 60);

t.section('A failing report degrades to a message, not a stack trace');
H.sheets({ config: {} });
H.load(['Util.gs', 'WebApp.gs'], {
  HtmlService: {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL' },
    createTemplateFromFile: () => {
      const tpl = { payload: null };
      tpl.evaluate = () => { served.push({ payload: tpl.payload });
        return { setTitle() { return this; }, setXFrameOptionsMode() { return this; },
                 addMetaTag() { return this; } }; };
      return tpl;
    },
    createHtmlOutputFromFile: () => ({ setTitle() { return this; },
      setXFrameOptionsMode() { return this; }, addMetaTag() { return this; } }),
  },
  PublicReport: { buildSales: () => { throw new Error('sheet exploded'); },
                  build: () => { throw new Error('sheet exploded'); } },
  Auth: { validate: () => { throw new Error('NOT_LOGGED_IN'); } },
  Staff: { getAll: () => [] }, Sales: {}, CashHandling: { sheetsExist: () => false },
  TillSessions: {},
});
served = [];
// The whole point is that a broken report never reaches the reader as a throw,
// so catch it here too — a regression is a failed assertion, not a dead suite.
let failed = null, threw = null;
try { doGet({ parameter: { v: 'sales' } }); } catch (err) { threw = err; }
if (!threw && served[0] && typeof served[0].payload === 'string') {
  try { failed = JSON.parse(served[0].payload); } catch (err) { failed = null; }
}
t.ok('the page is served, not thrown out of', !threw);
t.ok('an unavailable message is published', !!(failed && failed.unavailable));
t.ok('and the internal error is not leaked',
     !!failed && !/exploded/.test(String(failed.unavailable)));

t.section('The sales page publishes aggregates only');
load({
  fromStr: '2026-07-15', toStr: '2026-09-12',
  totals: { total: 9000, cash: 3000, cardAll: 6000 },
  daily: [{ dateStr: '2026-09-01', total: 1800, byCompany: { cstore: 1600, vape: 200 } }],
  companies: ['cstore', 'vape'], sessionCount: 120,
});
doGet({ parameter: { v: 'sales' } });
const blob = String((served[0] && served[0].payload) || '');
t.ok('no staffName anywhere', !/staffName/.test(blob));
t.ok('no staffId anywhere', !/staffId/.test(blob));
t.ok('no sessionId anywhere', !/sessionId/.test(blob));
t.ok('no salesId anywhere', !/salesId/.test(blob));
t.ok('no cashier-typed notes', !/miscNotes/.test(blob));
t.ok('but the aggregates are there', /"total":9000/.test(blob));

t.done();
