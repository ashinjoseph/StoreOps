// ============================================================
//  rpc-guards — privilege comes from the SESSION, never the client
// ============================================================
//  Every RPC resolves the caller from the token. A client that sends
//  `fromStaffId` for someone else, or claims a role, must be refused — the
//  guard has to read the server-side session and nothing else.
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('RPC permission guards');

const SESSIONS = {
  'tok-cashier': { staffId: 'S_ASH', name: 'Ashin', role: 'employee',
                   companiesAuthorized: ['cstore', 'vape'] },
  'tok-manager': { staffId: 'S_MEE', name: 'Meera', role: 'manager',
                   companiesAuthorized: ['cstore', 'vape'] },
  'tok-admin':   { staffId: 'S_ADM', name: 'Root', role: 'admin',
                   companiesAuthorized: ['cstore', 'vape'] },
};

/**
 * The product RPCs log the refusal before rethrowing — right in production,
 * pure noise here, and loud enough to bury the rest of the run. Wrap the call
 * so the assertion still sees the throw.
 */
function quiet(fn) {
  return () => {
    const err = console.error;
    console.error = () => {};
    try { return fn(); } finally { console.error = err; }
  };
}

let calls;
function load() {
  calls = [];
  H.sheets({ config: { cash_manager_staff_id: 'S_MEE' } });
  return H.load(['Util.gs', 'WebApp.gs'], {
    Auth: {
      validate: tok => {
        const s = SESSIONS[tok];
        if (!s) throw new Error('NOT_LOGGED_IN');
        return s;
      },
      // Mirrors Auth.require_ exactly. A stub that merely returned would let
      // a role check pass for the wrong reason, which is the one thing this
      // suite exists to catch.
      require: (session, allowedRoles) => {
        if (!session) throw new Error('NOT_LOGGED_IN');
        if (!Array.isArray(allowedRoles)) allowedRoles = [allowedRoles];
        if (allowedRoles.indexOf(session.role) === -1) {
          throw new Error('FORBIDDEN: requires ' + allowedRoles.join(' or ') +
                          ', got ' + session.role);
        }
      },
    },
    Staff: { getAll: () => Object.keys(SESSIONS).map(k => SESSIONS[k]),
             getById: id => ({ staffId: id, name: id }) },
    CashHandling: {
      sheetsExist: () => true,
      // Returns a RECORD, not an id — and privilege is admin OR this person.
      // The 'manager' role alone buys nothing here.
      cashManager: () => ({ staffId: 'S_MEE', name: 'Meera' }),
      record: i => { calls.push(['record', i]); return { handoverId: 'H1' }; },
      voidHandover: (id, by) => { calls.push(['void', id, by]); return { ok: true }; },
      getOutstandingForStaff: id => { calls.push(['outstanding', id]); return { staffId: id }; },
      getAllOutstanding: () => ({ holders: [] }),
      getPosition: () => ({}),
      getHistory: () => ([]),
    },
    TillSessions: { getAll: () => [], getForDateRange: () => [] },
    Sales: { cardSplitFor: () => true, getDashboard: () => ({}) },
    Reconcile: { getRecent: () => [] },
    ProductMaster: {
      create: i => { calls.push(['create', i]); return { productId: 'PM_1' }; },
      update: (id, patch, actor) => { calls.push(['update', id, patch, actor]); },
      deactivate: (id, actor) => { calls.push(['deactivate', id, actor]); return { productId: id }; },
      reactivate: (id, actor) => { calls.push(['reactivate', id, actor]); return { productId: id }; },
      getWithDetail: id => ({ productId: id, productName: 'X', category: 'vape', active: true }),
      importFromStaging: () => { calls.push(['import']); return { imported: 0 }; },
    },
    ProductTypes: { has: () => true },
  });
}

t.section('An invalid token gets nowhere');
load();
t.throws('no token', () => rpcRecordCashHandover(null, {}), 'NOT_LOGGED_IN');
t.throws('junk token', () => rpcRecordCashHandover('nope', {}), 'NOT_LOGGED_IN');
t.throws('void needs a session', () => rpcVoidCashHandover('nope', 'H1'), 'NOT_LOGGED_IN');

t.section('A cashier may hand over their OWN cash');
load();
rpcRecordCashHandover('tok-cashier', { amount: 100 });
t.eq('one record call', calls.length, 1);
t.eq('from is taken from the session, not the client', calls[0][1].fromStaffId, 'S_ASH');
t.eq('actor is the session too', calls[0][1].actorId, 'S_ASH');

t.section('A cashier may NOT hand over someone else\'s');
load();
t.throws('spoofed fromStaffId refused',
  () => rpcRecordCashHandover('tok-cashier', { fromStaffId: 'S_MEE', amount: 100 }),
  'FORBIDDEN');
t.eq('and nothing reached the sheet', calls.length, 0);

t.section('The configured cash manager may record for anyone');
load();
rpcRecordCashHandover('tok-manager', { fromStaffId: 'S_ASH', amount: 100 });
t.eq('allowed', calls.length, 1);
t.eq('for the named cashier', calls[0][1].fromStaffId, 'S_ASH');
t.eq('but the actor stays the manager', calls[0][1].actorId, 'S_MEE');

t.section('Voiding is the cash manager or an admin only');
load();
t.throws('cashier refused', () => rpcVoidCashHandover('tok-cashier', 'H1'), 'FORBIDDEN');
t.eq('nothing voided', calls.length, 0);
// A plain manager who is NOT the cash manager is also refused — the role
// name is not the permission.
SESSIONS['tok-other-mgr'] = { staffId: 'S_OTH', name: 'Other', role: 'manager',
                              companiesAuthorized: ['cstore'] };
load();
t.throws('a manager who is not the cash manager is refused',
  () => rpcVoidCashHandover('tok-other-mgr', 'H1'), 'FORBIDDEN');
load(); rpcVoidCashHandover('tok-manager', 'H1');
t.eq('the cash manager is allowed', calls[0][0], 'void');
load(); rpcVoidCashHandover('tok-admin', 'H1');
t.eq('admin allowed', calls[0][0], 'void');

t.section('Reading another cashier\'s balance is privileged');
load();
t.throws('cashier cannot read another', () => rpcGetCashOutstandingFor('tok-cashier', 'S_MEE'), 'FORBIDDEN');
load(); rpcGetCashOutstandingFor('tok-cashier', 'S_ASH');
t.eq('but can read their own', calls[0][1], 'S_ASH');
load(); rpcGetCashOutstandingFor('tok-manager', 'S_ASH');
t.eq('and the cash manager can read anyone', calls[0][1], 'S_ASH');

t.section('Anyone signed in can add a product');
// Cashiers meet a new product first — one that arrives on a delivery, or a
// sample a rep leaves. A catalogue only a manager can extend falls behind the
// shelf, and the shopping list is only as good as the catalogue.
// A role gate creeping back in must read as a failed assertion, not as the
// suite dying on an uncaught FORBIDDEN.
function attempt(fn) {
  const err = console.error;
  console.error = () => {};
  try { fn(); return null; } catch (e) { return e.message; } finally { console.error = err; }
}
load();
t.eq('a cashier is not refused',
     attempt(() => rpcCreateProduct('tok-cashier',
       { productName: 'Bazooka X3 90K Banff Mint', category: 'vape' })), null);
t.eq('the create went through', (calls[0] || [])[0], 'create');
t.eq('recorded against the caller', (calls[0] || [])[1].actorId, 'S_ASH');
load();
t.eq('and a manager still can',
     attempt(() => rpcCreateProduct('tok-manager', { productName: 'Thing', category: 'vape' })), null);
t.eq('their create landed too', (calls[0] || [])[0], 'create');

t.section('Anyone signed in can correct one');
// The picker sends whoever hits an incomplete row straight to the edit form;
// that only works if they are allowed to save it.
load();
t.eq('a cashier is not refused',
     attempt(() => rpcUpdateProduct('tok-cashier', 'PM_1',
       { productName: 'Fixed', needsDetail: false })), null);
t.eq('the update went through', (calls[0] || [])[0], 'update');
t.eq('on the right product', (calls[0] || [])[1], 'PM_1');
t.eq('audited as the caller, not as a manager', (calls[0] || [])[3], 'S_ASH');

t.section('…but not remove one');
// Correcting a record is not the same as taking it out of circulation.
load();
t.throws('a cashier cannot deactivate',
  quiet(() => rpcDeactivateProduct('tok-cashier', 'PM_1')), 'FORBIDDEN');
t.throws('nor reactivate',
  quiet(() => rpcReactivateProduct('tok-cashier', 'PM_1')), 'FORBIDDEN');
t.eq('and nothing reached the module', calls.length, 0);
load();
rpcDeactivateProduct('tok-manager', 'PM_1');
t.eq('a manager can', calls[0][0], 'deactivate');

t.section('Bulk import stays admin-only');
// It rewrites the master from a sheet nobody reviews row by row.
load();
t.throws('a cashier cannot run it',
  quiet(() => rpcImportProductMasterFromStaging('tok-cashier', { type: 'vape' })), 'FORBIDDEN');
t.throws('nor a manager',
  quiet(() => rpcImportProductMasterFromStaging('tok-manager', { type: 'vape' })), 'FORBIDDEN');
load();
rpcImportProductMasterFromStaging('tok-admin', { type: 'vape' });
t.eq('an admin can', calls[0][0], 'import');

t.section('Still nobody gets in without a session');
load();
t.throws('create needs a token', quiet(() => rpcCreateProduct('nope', { productName: 'X', category: 'vape' })), 'NOT_LOGGED_IN');
t.throws('update needs a token', quiet(() => rpcUpdateProduct('nope', 'PM_1', {})), 'NOT_LOGGED_IN');

t.section('A client-claimed role is ignored');
load();
t.throws('role in the payload buys nothing',
  () => rpcVoidCashHandover('tok-cashier', 'H1', { role: 'admin' }), 'FORBIDDEN');

t.done();
