// Parity cases for CashHandling (card P3-06): rpcGetCashPosition, rpcRecordCashHandover,
// rpcVoidCashHandover, rpcGetCashOutstandingFor and rpcGetCashHandoverHistory.
//
// The fixture (frozen at Friday 20 November 2026, cases start at 10:30 that day):
//   - S_001 admin, S_002 manager (the configured cash manager: cash_manager_staff_id), S_003 to
//     S_005 employees, S_006 payroll admin (NOT the cash manager: no privilege here), S_007 inactive.
//   - history: closed shifts up to Thursday 19 November; each cashier's older weeks were handed over
//     by "Weekly drop" handovers recorded by S_002, the latest shifts are still out.
//   - today: CST-20261120-S_003 is open (it holds no cash until it is closed).
// Cases that close a till run on Saturday 21 November (D21, 09:00 Toronto), like cases/shifts.ts.
//
// Who may do what (the old code decides, inside the RPC bodies and the module):
//   privileged  = an admin, or the person named in cash_manager_staff_id (a plain manager, or a
//                 payroll admin, is NOT privileged);
//   position    = anyone signed in (the roster only for the privileged);
//   outstanding = your own, or anyone's if privileged;
//   history     = your own rows, or anyone's / all if privileged;
//   record      = for yourself, or for anyone if privileged; the module then also needs the actor to
//                 be the cashier, the recipient or an admin;
//   void        = privileged only.
//
// Not here, by ruling, because the old code accepted what the new schema cannot hold (the new app
// refuses it with a plain message; ops/test/cash-handling.test.ts covers each): a method that is not
// cash / bank / etransfer / other, a note with a NUL character, a handedOn the database cannot store.
//
// Known, not closable here: the old record keeps the time of day of handedOn (the fixture's drops are
// Mondays at 10:00, and a handover with no handedOn is dated "now"); the new table holds the date
// only. `handedOn` in a history answer is the instant as an ISO string, so those differ.
import { parityCase, paritySequence, resultOf, step, type ParityCase, type Step } from "../case";

const ROLES = ["admin", "manager", "payroll_admin", "S_003"] as const;
const WRITES = ["cash_handovers", "cash_handover_items", "audit_log"];
// Closing a till writes these too; the day changes, so the caller's sign-in is renewed on both sides.
const TILL_WRITES = ["till_sessions", "attendance", "sales", "sessions", ...WRITES];

const D21 = "2026-11-21T14:00:00Z"; // Saturday 21st, 09:00 Toronto
const EVE20 = "2026-11-21T03:00:00Z"; // Friday 20th, 22:00 Toronto
const LATE = { hours: 8 };

const position = (as?: string, spec: Record<string, unknown> = {}): Step => step("rpcGetCashPosition", { ...(as ? { as } : {}), ...spec });
const owed = (staffId: unknown, as?: string): Step => step("rpcGetCashOutstandingFor", { ...(as ? { as } : {}), args: [staffId] });
const history = (args: unknown[], as?: string): Step => step("rpcGetCashHandoverHistory", { ...(as ? { as } : {}), args });
const record = (input: unknown, as?: string, spec: Record<string, unknown> = {}): Step => step("rpcRecordCashHandover", { ...(as ? { as } : {}), args: [input], ...spec });
const voidIt = (id: unknown, as?: string, spec: Record<string, unknown> = {}): Step => step("rpcVoidCashHandover", { ...(as ? { as } : {}), args: [id], ...spec });
const later = { advance: { minutes: 5 } };
// A sign-in lasts 24 hours from the case's start (the afternoon of the 20th). Someone who acts
// after a close on the evening of the 21st calls this on the morning of the 21st, which renews
// their sign-in (SIGNED_OUT_RULE in ops/parity/run.ts fails a case whose caller had been signed out).
const alive = (as: string): Step => step("rpcGetMe", { as });

// A till S_004 opens and closes on the 21st: vape, $150 of cash removed (count 250, float 100).
const open = (company: string, count: number, spec: Record<string, unknown> = {}): Step => step("rpcOpenShift", { args: [{ company, openingCount: count }], ...spec });
const close = (sessionId: string, fields: Record<string, unknown>, spec: Record<string, unknown> = { advance: LATE }): Step => step("rpcCloseShift", { args: [{ sessionId, ...fields }], ...spec });
const CLEAR_CSTORE = close("CST-20261120-S_003", { cashSales: 600, cardTotalSales: 900, miscCashSales: 0, physicalCount: 850, lottoCounted: 500 }, { as: "S_003", at: EVE20 });
const VAPE4 = "VAP-20261121-S_004";
const CST4 = "CST-20261121-S_004";
const CLOSE_VAPE = (count = 250): Step => close(VAPE4, { cashSales: 150, creditCardSales: 60, debitCardSales: 40, physicalCount: count });
/** S_004 opens and closes vape on the 21st, so S_004 holds the fixture's cash and $150 more. */
const VAPE_DAY: Step[] = [open("vape", 100, { as: "S_004", at: D21 }), CLOSE_VAPE()];

/** What S_004 holds, asked first, so a later step can hand it all over. */
const ALL4 = resultOf(1, "$.mine.totalOutstanding");

const sequence = (title: string, who: string, steps: Step[], writes = WRITES, settings?: Record<string, string>): ParityCase =>
  paritySequence(title, { as: who, writes, ...(settings ? { settings } : {}) }, steps);

export const cashHandlingCases: ParityCase[] = [
  // ── rpcGetCashPosition ──────────────────────────────────
  ...ROLES.map((who) => parityCase("rpcGetCashPosition", { as: who })),
  parityCase("rpcGetCashPosition", { as: "S_005" }),
  parityCase("rpcGetCashPosition", { as: "S_002", title: "rpcGetCashPosition as S_002 (the cash manager)" }),
  // No case "as an inactive person": the harness cannot sign one in, and the new app signs a
  // deactivated person out on their next call (plan, "Built differently").
  parityCase("rpcGetCashPosition", { as: null, title: "rpcGetCashPosition: no token" }),
  parityCase("rpcGetCashPosition", { as: "S_001", settings: { cash_handover_stale_days: "1" }, title: "rpcGetCashPosition: stale after 1 day (admin)" }),
  parityCase("rpcGetCashPosition", { as: "S_001", settings: { cash_handover_stale_days: "3" }, title: "rpcGetCashPosition: stale after 3 days (admin)" }),
  parityCase("rpcGetCashPosition", { as: "S_001", settings: { cash_handover_stale_days: "0" }, title: "rpcGetCashPosition: a stale limit of 0 is 7" }),
  parityCase("rpcGetCashPosition", { as: "S_001", settings: { cash_handover_stale_days: "-3" }, title: "rpcGetCashPosition: a negative stale limit is 7" }),
  parityCase("rpcGetCashPosition", { as: "S_001", settings: { cash_handover_stale_days: "soon" }, title: "rpcGetCashPosition: an unreadable stale limit is 7" }),
  parityCase("rpcGetCashPosition", { as: "S_001", settings: { cash_handover_stale_days: "" }, title: "rpcGetCashPosition: a blank stale limit is 7" }),
  parityCase("rpcGetCashPosition", { as: "S_001", settings: { cash_handover_stale_days: "1.5" }, title: "rpcGetCashPosition: a fractional stale limit is kept" }),
  parityCase("rpcGetCashPosition", { as: "S_003", settings: { cash_manager_staff_id: "" }, title: "rpcGetCashPosition: no cash manager configured (employee)" }),
  parityCase("rpcGetCashPosition", { as: "S_001", settings: { cash_manager_staff_id: "S_999" }, title: "rpcGetCashPosition: the cash manager names someone who is not on the staff list" }),
  parityCase("rpcGetCashPosition", { as: "S_006", settings: { cash_manager_staff_id: "S_006" }, title: "rpcGetCashPosition: the payroll admin made the cash manager sees the roster" }),
  parityCase("rpcGetCashPosition", { as: "S_002", settings: { cash_manager_staff_id: " S_002 " }, title: "rpcGetCashPosition: a cash manager id with spaces around it is trimmed" }),
  parityCase("rpcGetCashPosition", { as: "S_002", settings: { cash_manager_staff_id: "S_003" }, title: "rpcGetCashPosition: S_002 is no longer the cash manager" }),

  // ── rpcGetCashOutstandingFor ────────────────────────────
  ...ROLES.map((who) => parityCase("rpcGetCashOutstandingFor", { as: who, args: ["S_003"], title: `rpcGetCashOutstandingFor S_003 as ${who}` })),
  ...ROLES.map((who) => parityCase("rpcGetCashOutstandingFor", { as: who, args: ["S_004"], title: `rpcGetCashOutstandingFor S_004 as ${who}` })),
  parityCase("rpcGetCashOutstandingFor", { as: "S_004", args: ["S_004"], title: "rpcGetCashOutstandingFor: your own" }),
  parityCase("rpcGetCashOutstandingFor", { as: "S_006", args: ["S_006"], title: "rpcGetCashOutstandingFor: your own, holding nothing" }),
  parityCase("rpcGetCashOutstandingFor", { as: "S_001", args: ["S_001"], title: "rpcGetCashOutstandingFor: the admin's own, holding nothing" }),
  parityCase("rpcGetCashOutstandingFor", { as: "S_001", args: ["S_999"], title: "rpcGetCashOutstandingFor: an admin asks about someone who does not exist" }),
  parityCase("rpcGetCashOutstandingFor", { as: "S_001", args: ["S_007"], title: "rpcGetCashOutstandingFor: an admin asks about an inactive person" }),
  parityCase("rpcGetCashOutstandingFor", { as: "S_001", args: [], title: "rpcGetCashOutstandingFor: an admin gives no staff id" }),
  parityCase("rpcGetCashOutstandingFor", { as: "S_001", args: [""], title: "rpcGetCashOutstandingFor: an admin gives a blank staff id" }),
  parityCase("rpcGetCashOutstandingFor", { as: "S_001", args: [null], title: "rpcGetCashOutstandingFor: an admin gives null" }),
  parityCase("rpcGetCashOutstandingFor", { as: "S_001", args: [42], title: "rpcGetCashOutstandingFor: an admin gives a number" }),
  parityCase("rpcGetCashOutstandingFor", { as: "S_003", args: [], title: "rpcGetCashOutstandingFor: an employee gives no staff id" }),
  parityCase("rpcGetCashOutstandingFor", { as: "S_003", args: ["S_004"], title: "rpcGetCashOutstandingFor: an employee asks about someone else" }),
  parityCase("rpcGetCashOutstandingFor", { as: "S_003", args: [{ staffId: "S_003" }], title: "rpcGetCashOutstandingFor: an employee gives an object" }),
  parityCase("rpcGetCashOutstandingFor", { as: "S_006", args: ["S_003"], title: "rpcGetCashOutstandingFor: a payroll admin asks about someone else" }),
  parityCase("rpcGetCashOutstandingFor", { as: "S_003", args: ["S_004"], settings: { cash_manager_staff_id: "S_003" }, title: "rpcGetCashOutstandingFor: an employee who is the cash manager asks about someone else" }),
  parityCase("rpcGetCashOutstandingFor", { as: null, args: ["S_003"], title: "rpcGetCashOutstandingFor: no token" }),

  // ── rpcGetCashHandoverHistory ───────────────────────────
  ...ROLES.map((who) => parityCase("rpcGetCashHandoverHistory", { as: who })),
  ...ROLES.map((who) => parityCase("rpcGetCashHandoverHistory", { as: who, args: [5, "S_004"], title: `rpcGetCashHandoverHistory 5 rows of S_004 as ${who}` })),
  parityCase("rpcGetCashHandoverHistory", { as: null, title: "rpcGetCashHandoverHistory: no token" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: [1], title: "rpcGetCashHandoverHistory: limit 1" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: [0], title: "rpcGetCashHandoverHistory: limit 0 is 25" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: [-1], title: "rpcGetCashHandoverHistory: limit -1 drops the last row" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: [-100], title: "rpcGetCashHandoverHistory: limit -100 is empty" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: [1.5], title: "rpcGetCashHandoverHistory: limit 1.5 is 1" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: ["3"], title: "rpcGetCashHandoverHistory: limit as a string" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: ["abc"], title: "rpcGetCashHandoverHistory: limit that is not a number is 25" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: [null], title: "rpcGetCashHandoverHistory: limit null is 25" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: [1000], title: "rpcGetCashHandoverHistory: limit 1000" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: [100, "S_003"], title: "rpcGetCashHandoverHistory: everything of S_003" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: [100, "S_002"], title: "rpcGetCashHandoverHistory: everything received by S_002" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: [100, "S_999"], title: "rpcGetCashHandoverHistory: someone who does not exist" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: [100, ""], title: "rpcGetCashHandoverHistory: a blank staff id means everyone" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: [100, 7], title: "rpcGetCashHandoverHistory: a staff id that is a number" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_003", args: [100, "S_004"], title: "rpcGetCashHandoverHistory: an employee is pinned to their own rows whatever they ask" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_003", args: [2, null], title: "rpcGetCashHandoverHistory: an employee, limit 2" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_006", args: [100, "S_003"], title: "rpcGetCashHandoverHistory: a payroll admin is pinned to their own rows" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_003", args: [100, "S_004"], settings: { cash_manager_staff_id: "S_003" }, title: "rpcGetCashHandoverHistory: an employee who is the cash manager sees anyone's" }),
  parityCase("rpcGetCashHandoverHistory", { as: "S_001", args: [100], settings: { cash_manager_staff_id: "" }, title: "rpcGetCashHandoverHistory: no cash manager configured" }),

  // ── rpcRecordCashHandover: who, and how much ────────────
  sequence("rpcRecordCashHandover: a cashier hands over everything they hold, to the cash manager", "S_004", [
    position(),
    record({ amount: ALL4 }),
    position(),
    owed("S_004"),
    history([10]),
  ]),
  // The same writes with no history in the answers (history carries handedOn: see the header), so the
  // allocation, the balances and every stored row are compared on their own.
  sequence("rpcRecordCashHandover: everything handed over, then what is owed (no history in the answers)", "S_004", [
    owed("S_004"),
    record({ amount: resultOf(1, "$.totalOutstanding") }),
    owed("S_004"),
  ]),
  sequence("rpcRecordCashHandover: a partial handover, a second one, and what is owed after each (no history in the answers)", "S_003", [
    owed("S_003"),
    record({ amount: 500, notes: "first part" }),
    owed("S_003"),
    record({ amount: 150.25, notes: "second part" }, "S_003", later),
    owed("S_003"),
  ]),
  sequence("rpcVoidCashHandover: record, void, and what is owed after each (no history in the answers)", "S_001", [
    record({ fromStaffId: "S_003", amount: 300, notes: "partial" }),
    owed("S_003"),
    voidIt(resultOf(1, "$.handoverId"), undefined, later),
    owed("S_003"),
    voidIt(resultOf(1, "$.handoverId"), undefined, later),
  ]),
  sequence("rpcRecordCashHandover: a partial handover with a reason (the oldest shift first, the next one part-settled)", "S_004", [
    position(),
    record({ amount: 100, notes: "rest on Monday" }),
    position(),
    owed("S_004"),
    history([3]),
  ]),
  sequence("rpcRecordCashHandover: a partial handover that spans two shifts, then another that takes the rest of the first", "S_003", [
    owed("S_003"),
    record({ amount: 500, notes: "first part" }),
    record({ amount: 150.25, notes: "second part" }, "S_003", later),
    owed("S_003"),
    history([5, "S_003"]),
  ]),
  sequence("rpcRecordCashHandover: a partial handover with no reason is refused", "S_004", [record({ amount: 100 }), owed("S_004")]),
  sequence("rpcRecordCashHandover: a reason of only spaces is no reason", "S_004", [record({ amount: 100, notes: "   " })]),
  sequence("rpcRecordCashHandover: a reason is trimmed and kept", "S_004", [record({ amount: 100, notes: "  rest on Monday  " }), history([1])]),
  sequence("rpcRecordCashHandover: a reason that is not text", "S_004", [record({ amount: 100, notes: 12 }), history([1])]),
  sequence("rpcRecordCashHandover: a note on a full handover is kept too", "S_004", [position(), record({ amount: ALL4, notes: "all of it" }), history([1])]),
  sequence("rpcRecordCashHandover: the cash manager records a cashier's handover", "S_002", [
    owed("S_005"),
    record({ fromStaffId: "S_005", amount: 100, notes: "partial" }),
    history([3, "S_005"]),
  ]),
  sequence("rpcRecordCashHandover: the cash manager hands over their own (nothing held)", "S_002", [record({ amount: 10 })]),
  sequence("rpcRecordCashHandover: an admin records for a cashier", "S_001", [
    owed("S_003"),
    record({ fromStaffId: "S_003", amount: 200, notes: "owner collected part" }),
    position(),
  ]),
  sequence("rpcRecordCashHandover: an admin records for a cashier and names the recipient", "S_001", [
    record({ fromStaffId: "S_003", toStaffId: "S_001", amount: 200, notes: "to the owner" }),
    history([2, "S_001"]),
  ]),
  sequence("rpcRecordCashHandover: a cashier names themselves as the recipient (the old code allows it)", "S_003", [record({ toStaffId: "S_003", amount: 50, notes: "to self" })]),
  sequence("rpcRecordCashHandover: a cashier names another recipient (not the cash manager)", "S_003", [record({ toStaffId: "S_005", amount: 50, notes: "to a colleague" })]),
  sequence("rpcRecordCashHandover: the cash manager records between two cashiers (not a party, not admin)", "S_002", [
    record({ fromStaffId: "S_003", toStaffId: "S_004", amount: 50, notes: "between cashiers" }),
  ]),
  sequence("rpcRecordCashHandover: the recipient records a handover to themselves", "S_005", [record({ fromStaffId: "S_003", toStaffId: "S_005", amount: 50, notes: "taking it" })]),
  sequence("rpcRecordCashHandover: an employee cannot record someone else's", "S_003", [record({ fromStaffId: "S_004", amount: 50, notes: "x" })]),
  sequence("rpcRecordCashHandover: a payroll admin cannot record someone else's", "S_006", [record({ fromStaffId: "S_004", amount: 50, notes: "x" })]),
  sequence("rpcRecordCashHandover: a payroll admin hands over their own (nothing held)", "S_006", [record({ amount: 50, notes: "x" })]),
  sequence("rpcRecordCashHandover: an employee who is the cash manager may record for someone else", "S_003", [record({ fromStaffId: "S_004", amount: 50, notes: "x" })], WRITES, { cash_manager_staff_id: "S_003" }),
  sequence("rpcRecordCashHandover: an actorId and recordedBy in the input are ignored", "S_004", [
    record({ amount: 100, notes: "x", actorId: "S_001", recordedBy: "S_001" }),
    history([1]),
  ]),
  sequence("rpcRecordCashHandover: no token", "S_004", [record({ amount: 100, notes: "x" }, undefined, { as: null })]),
  sequence("rpcRecordCashHandover: a junk token", "S_004", [record({ amount: 100, notes: "x" }, undefined, { as: { token: "junk" } })]),

  // ── rpcRecordCashHandover: what is refused ──────────────
  sequence("rpcRecordCashHandover: no amount", "S_004", [record({ notes: "x" })]),
  sequence("rpcRecordCashHandover: no input at all", "S_004", [step("rpcRecordCashHandover", { args: [] })]),
  sequence("rpcRecordCashHandover: a null input", "S_004", [step("rpcRecordCashHandover", { args: [null] })]),
  sequence("rpcRecordCashHandover: an amount of 0", "S_004", [record({ amount: 0, notes: "x" })]),
  sequence("rpcRecordCashHandover: a negative amount", "S_004", [record({ amount: -20, notes: "x" })]),
  sequence("rpcRecordCashHandover: an amount that is not a number", "S_004", [record({ amount: "abc", notes: "x" })]),
  sequence("rpcRecordCashHandover: an amount of a fraction of a cent", "S_004", [record({ amount: 0.004, notes: "x" })]),
  sequence("rpcRecordCashHandover: an amount of half a cent", "S_004", [record({ amount: 0.005, notes: "x" }), history([1])]),
  sequence("rpcRecordCashHandover: an amount of one cent", "S_004", [record({ amount: 0.01, notes: "x" }), owed("S_004")]),
  sequence("rpcRecordCashHandover: an amount in the page's string form", "S_004", [record({ amount: "75.50", notes: "x" }), owed("S_004")]),
  sequence("rpcRecordCashHandover: an amount with three decimals is rounded", "S_004", [record({ amount: 12.345, notes: "x" }), history([1])]),
  sequence("rpcRecordCashHandover: an amount that is infinity", "S_004", [record({ amount: "Infinity", notes: "x" })]),
  sequence("rpcRecordCashHandover: an amount that is a thousand times what is held", "S_004", [record({ amount: 1000000, notes: "x" })]),
  sequence("rpcRecordCashHandover: a person who holds nothing", "S_005", [record({ fromStaffId: "S_001", amount: 5, notes: "x" })]),
  sequence("rpcRecordCashHandover: an unknown cashier", "S_001", [record({ fromStaffId: "S_999", amount: 5, notes: "x" })]),
  sequence("rpcRecordCashHandover: a cashier id with a space in front is not found", "S_001", [record({ fromStaffId: " S_003", amount: 5, notes: "x" })]),
  sequence("rpcRecordCashHandover: an unknown recipient", "S_003", [record({ toStaffId: "S_999", amount: 5, notes: "x" })]),
  sequence("rpcRecordCashHandover: an inactive recipient is accepted", "S_001", [record({ fromStaffId: "S_003", toStaffId: "S_007", amount: 5, notes: "x" }), history([1, "S_007"])]),
  sequence("rpcRecordCashHandover: no recipient and no cash manager configured", "S_003", [record({ amount: 5, notes: "x" })], WRITES, { cash_manager_staff_id: "" }),
  sequence("rpcRecordCashHandover: the cash manager names someone who does not exist", "S_003", [record({ amount: 5, notes: "x" })], WRITES, { cash_manager_staff_id: "S_999" }),
  sequence("rpcRecordCashHandover: no cash manager, but a recipient is named", "S_003", [record({ toStaffId: "S_001", amount: 5, notes: "x" }), history([1])], WRITES, { cash_manager_staff_id: "" }),
  sequence("rpcRecordCashHandover: a different cash manager is the default recipient", "S_003", [record({ amount: 5, notes: "x" }), history([1])], WRITES, { cash_manager_staff_id: "S_001" }),
  sequence("rpcRecordCashHandover: a fromStaffId that is a number", "S_001", [record({ fromStaffId: 3, amount: 5, notes: "x" })]),
  sequence("rpcRecordCashHandover: a toStaffId that is a number", "S_003", [record({ toStaffId: 2, amount: 5, notes: "x" })]),

  // ── rpcRecordCashHandover: method and date ──────────────
  ...["cash", "bank", "etransfer", "other"].map((method) =>
    sequence(`rpcRecordCashHandover: method ${method}`, "S_003", [record({ method, amount: 20, notes: "x" }), history([1, "S_003"])]),
  ),
  sequence("rpcRecordCashHandover: an empty method is cash", "S_003", [record({ method: "", amount: 20, notes: "x" }), history([1, "S_003"])]),
  sequence("rpcRecordCashHandover: a null method is cash", "S_003", [record({ method: null, amount: 20, notes: "x" }), history([1, "S_003"])]),
  sequence("rpcRecordCashHandover: handed over on a given day", "S_003", [record({ handedOn: "2026-11-18", amount: 20, notes: "x" }), history([1, "S_003"])]),
  sequence("rpcRecordCashHandover: handed over today, as the page sends it", "S_003", [record({ handedOn: "2026-11-20", amount: 20, notes: "x" }), history([1, "S_003"])]),
  sequence("rpcRecordCashHandover: handed over in the future", "S_003", [record({ handedOn: "2027-01-05", amount: 20, notes: "x" }), history([1, "S_003"])]),
  sequence("rpcRecordCashHandover: a date with a day that rolls over", "S_003", [record({ handedOn: "2026-02-30", amount: 20, notes: "x" }), history([1, "S_003"])]),
  sequence("rpcRecordCashHandover: a blank date is today", "S_003", [record({ handedOn: "", amount: 20, notes: "x" })]),
  sequence("rpcRecordCashHandover: a date that is not a date is today", "S_003", [record({ handedOn: "last Tuesday", amount: 20, notes: "x" })]),
  sequence("rpcRecordCashHandover: a date as a number is today", "S_003", [record({ handedOn: 20261118, amount: 20, notes: "x" })]),
  sequence("rpcRecordCashHandover: no date is today", "S_003", [record({ amount: 20, notes: "x" })]),
  sequence("rpcRecordCashHandover: a date with a time and a zone", "S_003", [record({ handedOn: "2026-11-18T23:30:00-05:00", amount: 20, notes: "x" })]),
  sequence("rpcRecordCashHandover: a date with a time and no zone", "S_003", [record({ handedOn: "2026-11-18T23:30:00", amount: 20, notes: "x" })]),

  // ── rpcVoidCashHandover ─────────────────────────────────
  sequence("rpcVoidCashHandover: void one just recorded; the cash comes back (position, owed, history)", "S_002", [
    position("S_004"),
    record({ fromStaffId: "S_004", amount: ALL4 }),
    position("S_004", later),
    voidIt(resultOf(2, "$.handoverId"), undefined, later),
    position("S_004", later),
    owed("S_004"),
    history([3, "S_004"]),
  ]),
  sequence("rpcVoidCashHandover: void a partial one; the allocation is released", "S_001", [
    record({ fromStaffId: "S_003", amount: 300, notes: "partial" }),
    owed("S_003", "S_003"),
    voidIt(resultOf(1, "$.handoverId"), undefined, later),
    owed("S_003", "S_003"),
    history([2, "S_003"], "S_003"),
  ]),
  sequence("rpcVoidCashHandover: void it twice", "S_001", [
    record({ fromStaffId: "S_003", amount: 300, notes: "partial" }),
    voidIt(resultOf(1, "$.handoverId"), undefined, later),
    voidIt(resultOf(1, "$.handoverId"), undefined, later),
  ]),
  sequence("rpcVoidCashHandover: record again after a void (the freed cash is handed over again)", "S_001", [
    owed("S_003"),
    record({ fromStaffId: "S_003", amount: resultOf(1, "$.totalOutstanding") }),
    voidIt(resultOf(2, "$.handoverId"), undefined, later),
    record({ fromStaffId: "S_003", amount: resultOf(1, "$.totalOutstanding") }, undefined, later),
    owed("S_003"),
  ]),
  sequence("rpcVoidCashHandover: void a handover the fixture already holds", "S_002", [
    history([100, "S_003"], "S_001"),
    voidIt(resultOf(1, "$.handovers[0].handoverId")),
    owed("S_003", "S_001"),
  ]),
  sequence("rpcVoidCashHandover: an unknown id", "S_001", [voidIt("H_19990101_000000_nop")]),
  sequence("rpcVoidCashHandover: no id", "S_001", [step("rpcVoidCashHandover", { args: [] })]),
  sequence("rpcVoidCashHandover: a blank id", "S_001", [voidIt("")]),
  sequence("rpcVoidCashHandover: a null id", "S_001", [voidIt(null)]),
  sequence("rpcVoidCashHandover: an id that is a number", "S_001", [voidIt(12)]),
  sequence("rpcVoidCashHandover: an id that is an object", "S_001", [voidIt({ handoverId: "x" })]),
  sequence("rpcVoidCashHandover: a cashier cannot void their own handover", "S_003", [
    record({ amount: 20, notes: "x" }),
    voidIt(resultOf(1, "$.handoverId"), undefined, later),
    history([2, "S_003"]),
  ]),
  sequence("rpcVoidCashHandover: a manager who is not the cash manager cannot void (S_002 is not it here)", "S_002", [voidIt("H_19990101_000000_nop")], WRITES, { cash_manager_staff_id: "S_003" }),
  sequence("rpcVoidCashHandover: a payroll admin cannot void", "S_006", [voidIt("H_19990101_000000_nop")]),
  sequence("rpcVoidCashHandover: an employee cannot void, even naming no id", "S_003", [step("rpcVoidCashHandover", { args: [] })]),
  sequence("rpcVoidCashHandover: a payroll admin who is the cash manager may void", "S_006", [
    record({ fromStaffId: "S_005", amount: 25, notes: "x" }, "S_001"),
    voidIt(resultOf(1, "$.handoverId"), undefined, later),
    history([2, "S_005"]),
  ], WRITES, { cash_manager_staff_id: "S_006" }),
  sequence("rpcVoidCashHandover: no token", "S_001", [voidIt("H_19990101_000000_nop", undefined, { as: null })]),
  sequence("rpcVoidCashHandover: a void is shown with who voided it", "S_002", [
    record({ fromStaffId: "S_005", amount: 25, notes: "x" }),
    voidIt(resultOf(1, "$.handoverId"), undefined, later),
    history([2, "S_005"], "S_001"),
    position("S_002"),
  ]),

  // ── A till closed, then handed over, then voided ────────
  sequence("close a till; the position shows the cash held; record; position; void; position", "S_004", [
    position(),
    VAPE_DAY[0]!,
    alive("S_002"),
    VAPE_DAY[1]!,
    position(undefined, { advance: { minutes: 1 } }),
    owed("S_004"),
    record({ amount: 150, notes: "only the new shift" }),
    position(),
    voidIt(resultOf(7, "$.handoverId"), "S_002", later),
    position(),
    history([3]),
  ], TILL_WRITES),
  sequence("close a till; the whole balance (the fixture's cash and the new shift) handed over, oldest shift first", "S_004", [
    ...VAPE_DAY,
    position(undefined, { advance: { minutes: 1 } }),
    record({ amount: resultOf(3, "$.mine.totalOutstanding") }),
    position(),
    history([2]),
  ], TILL_WRITES),
  sequence("close both tills; the roster shows each company's share; a handover of the new cash", "S_004", [
    CLEAR_CSTORE,
    open("vape", 100, { as: "S_004", at: D21 }),
    alive("S_001"),
    open("cstore", 250, { advance: { minutes: 5 } }),
    close(VAPE4, { cashSales: 100, creditCardSales: 50, debitCardSales: 25, physicalCount: 200 }, { advance: { hours: 6 } }),
    close(CST4, { cashSales: 300, cardTotalSales: 700, physicalCount: 550, lottoCounted: 500 }, { advance: { hours: 2 } }),
    position("S_001"),
    record({ amount: 400, notes: "partial" }, "S_004"),
    position("S_001"),
  ], TILL_WRITES),
  sequence("a close below the float leaves a negative cash removed, which is not held", "S_004", [
    CLEAR_CSTORE,
    open("cstore", 250, { as: "S_004", at: D21 }),
    alive("S_001"),
    close(CST4, { cashSales: -300, cardTotalSales: 100, physicalCount: 0, lottoCounted: 450, lottoNote: "paid out" }),
    owed("S_004", "S_004"),
    position("S_001"),
  ], TILL_WRITES),
  sequence("a till closed with nothing removed (the drawer equals the float) is not held", "S_004", [
    open("vape", 100, { as: "S_004", at: D21 }),
    close(VAPE4, { cashSales: 0, creditCardSales: 0, debitCardSales: 0, physicalCount: 100 }),
    owed("S_004", "S_004"),
  ], TILL_WRITES),
  sequence("a session still open holds nothing (S_003's open cstore till)", "S_003", [owed("S_003"), position()]),
  sequence("the open till, once closed, is held and handed over (the day after)", "S_003", [
    CLEAR_CSTORE,
    owed("S_003"),
    record({ amount: 100, notes: "partial" }, undefined, { at: D21 }),
    owed("S_003"),
  ], TILL_WRITES),
];
