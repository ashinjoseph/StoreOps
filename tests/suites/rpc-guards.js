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

t.section('A client-claimed role is ignored');
load();
t.throws('role in the payload buys nothing',
  () => rpcVoidCashHandover('tok-cashier', 'H1', { role: 'admin' }), 'FORBIDDEN');

t.done();
