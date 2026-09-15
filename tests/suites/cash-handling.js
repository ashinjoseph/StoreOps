// ============================================================
//  cash-handling — who is holding the takings, and settling it
// ============================================================
//  Cash leaves the drawer with a cashier at close and stays theirs until they
//  hand it on. The invariant that matters: settlement walks EVERY company's
//  unsettled sessions oldest-first. A company filter is a reporting view — if
//  it ever became a settlement filter, cash would silently age in whichever
//  till nobody was looking at.
// ============================================================
const H = require('./_lib/harness');
const t = H.suite('cash handling');

const TS_HEADERS = ['session_id','attendance_id','staff_id','company','date','status',
  'start_time','end_time','expected_opening','opening_float','opening_note',
  'closing_cash_counted','cash_left_in_till','cash_removed_at_close','expected_cash',
  'closing_variance','variance_status','notes',
  'lotto_reserve_counted','lotto_topup_from_till','lotto_reserve_note'];
const HO_HEADERS = ['handover_id','from_staff_id','to_staff_id','amount','handed_on',
  'recorded_by','recorded_at','method','status','notes','voided_by','voided_at'];
const IT_HEADERS = ['item_id','handover_id','session_id','amount','notes'];

// A closed session that sent `removed` out of the door with `staff`.
function closed(id, staff, dateStr, removed, company) {
  const r = new Array(21).fill('');
  r[0] = id; r[2] = staff; r[3] = company || 'cstore';
  r[4] = new Date(dateStr + 'T00:00:00'); r[5] = 'closed';
  r[7] = new Date(dateStr + 'T20:00:00');
  r[11] = removed + 250; r[12] = 250; r[13] = removed;
  return r;
}

let M;
function scenario(sessions, handovers, items) {
  H.sheets({
    till_sessions: { headers: TS_HEADERS, rows: sessions || [] },
    cash_handovers: { headers: HO_HEADERS, rows: handovers || [] },
    cash_handover_items: { headers: IT_HEADERS, rows: items || [] },
    config: { cash_handover_stale_days: 3 },
  });
  M = H.load(['Util.gs', 'TillSessions.gs', 'CashHandling.gs'], {
    Staff: {
      getById: id => ({ staffId: id, name: { S_ASH: 'Ashin', S_MEE: 'Meera' }[id] || id,
                        role: 'employee', companiesAuthorized: ['cstore', 'vape'] }),
      getAll: () => [
        { staffId: 'S_ASH', name: 'Ashin', active: true, role: 'employee' },
        { staffId: 'S_MEE', name: 'Meera', active: true, role: 'manager' },
      ],
    },
    Attendance: { openOrPromote: () => ({ attendanceId: 'A_1' }), complete: () => {} },
    Sales: { write: () => ({}), getForSession: () => null },
    Notifier: { notify: () => {} },
  });
  return M.CashHandling;
}

t.section('Balance is the sum of what left the drawer');
let CH = scenario([
  closed('S1', 'S_ASH', '2026-08-10', 520),
  closed('S2', 'S_ASH', '2026-08-12', 420),
  closed('S3', 'S_MEE', '2026-08-12', 300),
]);
let ash = CH.getOutstandingForStaff('S_ASH');
t.eq('Ashin holds both of his', ash.totalOutstanding, 940);
t.eq('two unsettled sessions', ash.unsettledSessions.length, 2);
t.eq('Meera holds only hers', CH.getOutstandingForStaff('S_MEE').totalOutstanding, 300);

t.section('Sessions that removed nothing are not owed');
CH = scenario([
  closed('S1', 'S_ASH', '2026-08-10', 520),
  closed('S2', 'S_ASH', '2026-08-11', 0),
  closed('S3', 'S_ASH', '2026-08-12', -250),   // closed below float
]);
ash = CH.getOutstandingForStaff('S_ASH');
t.eq('only the positive one counts', ash.totalOutstanding, 520);
t.eq('and only it is listed', ash.unsettledSessions.length, 1);

t.section('Settlement is oldest-first, across every company');
CH = scenario([
  closed('S1', 'S_ASH', '2026-08-10', 500, 'cstore'),
  closed('S2', 'S_ASH', '2026-08-11', 300, 'vape'),
  closed('S3', 'S_ASH', '2026-08-12', 200, 'cstore'),
]);
// Leaving cash behind needs a reason — that guard is real and stays.
let rec = CH.record({ fromStaffId: 'S_ASH', toStaffId: 'S_MEE', amount: 700,
                      actorId: 'S_MEE', method: 'cash', notes: 'rest tomorrow' });
let settled = rec.itemsCreated.map(i => i.sessionId);
// 700 against 500 + 300 + 200 consumes S1 whole and 200 of S2.
t.eq('two sessions touched, oldest first', settled, ['S1', 'S2']);
t.ok('the VAPE session was settled too — not filtered out by company',
     settled.indexOf('S2') !== -1);
t.eq('the first is consumed whole', rec.itemsCreated[0].amount, 500);
t.eq('the second is part-settled', rec.itemsCreated[1].amount, 200);
t.eq('the newest is untouched', settled.indexOf('S3'), -1);

t.section('A handover cannot exceed what is held');
CH = scenario([closed('S1', 'S_ASH', '2026-08-10', 500)]);
t.throws('overpayment rejected',
  () => CH.record({ fromStaffId: 'S_ASH', toStaffId: 'S_MEE', amount: 600,
                    actorId: 'S_MEE', method: 'cash' }), 'cannot be handed over');

t.section('The preview and the write agree');
CH = scenario([
  closed('S1', 'S_ASH', '2026-08-10', 500),
  closed('S2', 'S_ASH', '2026-08-11', 300),
]);
const before = CH.getOutstandingForStaff('S_ASH');
t.eq('holding 800 before', before.totalOutstanding, 800);
CH.record({ fromStaffId: 'S_ASH', toStaffId: 'S_MEE', amount: 500,
            actorId: 'S_MEE', method: 'cash', notes: 'rest tomorrow' });
t.eq('holding 300 after', CH.getOutstandingForStaff('S_ASH').totalOutstanding, 300);

t.section('Per-company split reconciles with the consolidated figure');
CH = scenario([
  closed('S1', 'S_ASH', '2026-08-10', 500, 'cstore'),
  closed('S2', 'S_ASH', '2026-08-11', 300, 'vape'),
  closed('S3', 'S_MEE', '2026-08-11', 120, 'vape'),
]);
const all = CH.getAllOutstanding();
t.ok('a byCompany block is published', !!all.grandByCompany);
const g = all.grandByCompany;
t.near('cstore slice', g.cstore, 500);
t.near('vape slice', g.vape, 420);
t.near('slices sum to the grand total', (g.cstore || 0) + (g.vape || 0), all.grandTotal);
all.holders.forEach(h => {
  const bc = h.byCompany || {};
  const sum = Object.keys(bc).reduce((s, k) => s + bc[k], 0);
  t.near(h.staffId + ': company split equals their total', sum, h.total);
});

t.section('Voiding a handover returns the cash to the holder');
CH = scenario([closed('S1', 'S_ASH', '2026-08-10', 500)]);
const h = CH.record({ fromStaffId: 'S_ASH', toStaffId: 'S_MEE', amount: 500,
                      actorId: 'S_MEE', method: 'cash' });
t.eq('settled to zero', CH.getOutstandingForStaff('S_ASH').totalOutstanding, 0);
CH.voidHandover(h.handoverId, 'S_MEE', 'miscount');
t.eq('void puts it back', CH.getOutstandingForStaff('S_ASH').totalOutstanding, 500);

t.section('Missing tables degrade rather than throw');
H.sheets({ till_sessions: { headers: TS_HEADERS, rows: [] }, config: {} });
M = H.load(['Util.gs', 'TillSessions.gs', 'CashHandling.gs'], {
  Staff: { getById: () => null, getAll: () => [] },
  Attendance: { openOrPromote: () => ({}), complete: () => {} },
  Sales: { write: () => ({}), getForSession: () => null },
  Notifier: { notify: () => {} },
});
t.eq('sheetsExist reports false', M.CashHandling.sheetsExist(), false);

t.done();
