// Parity cases for Payments (card P3-09b): rpcGetPayrollOverview, rpcGetOwedSummary,
// rpcGetMyOwedSummary, rpcPayShifts, rpcPayBonus, rpcUndoPayment and rpcGetPaymentHistory.
//
// The fixture (frozen at Friday 20 November 2026; cases start at 10:30 that day) holds 5 payments,
// all made by the fixture's seed at its boot instant (09:30:00), in this order:
//   P_..._8lu  S_003, shifts 2026-07-23 to 2026-11-09 (110 items)   15,615.60
//   P_..._f2p  S_004, the same days                                  15,668.40
//   P_..._ljk  S_005, the same days                                  15,308.00
//   P_..._s0f  S_002, bonus djm (management fee), paid in full          120.00
//   P_..._mka  S_002, bonus x77 (management fee), paid in full          120.00
// So S_003, S_004 and S_005 are each owed 10 shifts (2026-11-10 to 2026-11-19): S_003 1,456.40
// (oldest: 176.00, 123.20, 127.60), S_004 1,403.60, S_005 1,376.00. S_002 is owed one pending
// bonus (4mu, 120) and no shifts. S_001 (admin, rate 0), S_006 (payroll admin) and S_007
// (inactive) are owed nothing. No fixture shift has a fraction of a cent in hours x rate; a case
// below makes some with rpcEditAttendanceTimes (an unpaid day's times, admin only).
//
// The old rpcPayShifts and rpcPayBonus pass no paidOn to Payments: a payment is always dated now,
// whatever the page sends. The cases send one anyway, to prove it is ignored on both sides.
//
// Every write case declares the tables it changes; any other table that changes on either side
// fails the case. An undo deletes the payment and its items on the old side and voids the payment
// on the new one (the void rule, ops/parity/writes.ts VOIDED_PAYMENTS_RULE).
import { parityCase, paritySequence, resultOf, step, type ParityCase } from "../case";

const ROLES = ["admin", "manager", "employee", "payroll_admin"] as const;
const PEOPLE = ["S_001", "S_002", "S_003", "S_004", "S_005", "S_006"] as const;
const WRITES = ["payments", "payment_items", "audit_log"];
const WRITES_BONUS = ["payments", "payment_items", "audit_log", "bonuses"];

const FIXTURE_PAY_3 = "P_20261120_093000_8lu"; // S_003's shifts up to 2026-11-09
const FIXTURE_PAY_BONUS = "P_20261120_093000_s0f"; // S_002's management fee djm
const PENDING = "B_20261120_093000_ofw"; // S_003, pending, 52.32
const PENDING_SMALL = "B_20261120_093000_p3q"; // S_003, pending, 1.54
const PENDING_FEE = "B_20261120_093000_4mu"; // S_002, pending, 120
const PROPOSED = "B_20261120_093000_z6p"; // S_003, proposed
const PAID = "B_20261120_093000_djm"; // S_002, paid (by FIXTURE_PAY_BONUS)

const pay = (input: unknown, as = "admin", extra: { advance?: { minutes?: number; seconds?: number } } = {}) => step("rpcPayShifts", { as, args: [input], ...extra });
const payBonus = (input: unknown, as = "admin", extra: { advance?: { minutes?: number; seconds?: number } } = {}) => step("rpcPayBonus", { as, args: [input], ...extra });
const undo = (id: unknown, as = "admin") => step("rpcUndoPayment", { as, args: [id] });
const owed = (staffId: unknown, as = "admin") => step("rpcGetOwedSummary", { as, args: [staffId] });
const mine = (as: string) => step("rpcGetMyOwedSummary", { as });
const history = (as = "admin", limit: unknown = 50) => step("rpcGetPaymentHistory", { as, args: [limit] });
const overview = (as = "admin") => step("rpcGetPayrollOverview", { as });
const shifts = (staffId: string, amount: unknown, extra: Record<string, unknown> = {}) => ({ staffId, amount, method: "cash", ...extra });
const bonus = (bonusId: unknown, amount: unknown, extra: Record<string, unknown> = {}) => ({ bonusId, amount, method: "cash", ...extra });
const edit = (attendanceId: string, actualStart: string, actualEnd: string) => step("rpcEditAttendanceTimes", { as: "admin", args: [{ attendanceId, actualStart, actualEnd }] });

/** A pay-shifts sequence: the payments, then what the person is owed and the history. */
const payAndRead = (title: string, staffId: string, payments: ReturnType<typeof pay>[]) =>
  paritySequence(title, { writes: WRITES }, [...payments, owed(staffId), history()]);

export const paymentsCases: ParityCase[] = [
  // ── rpcGetPayrollOverview ───────────────────────────────
  ...ROLES.map((role) => parityCase("rpcGetPayrollOverview", { as: role })),
  parityCase("rpcGetPayrollOverview", { as: null, title: "rpcGetPayrollOverview: no token is refused" }),

  // ── rpcGetOwedSummary ───────────────────────────────────
  ...[...PEOPLE, "S_007"].map((id) => parityCase("rpcGetOwedSummary", { as: "admin", args: [id], title: `rpcGetOwedSummary: ${id}` })),
  parityCase("rpcGetOwedSummary", { as: "payroll_admin", args: ["S_004"], title: "rpcGetOwedSummary: as a payroll admin" }),
  parityCase("rpcGetOwedSummary", { as: "admin", args: ["S_999"], title: "rpcGetOwedSummary: an unknown person is owed nothing" }),
  parityCase("rpcGetOwedSummary", { as: "admin", args: [], title: "rpcGetOwedSummary: no id" }),
  parityCase("rpcGetOwedSummary", { as: "admin", args: [""], title: "rpcGetOwedSummary: a blank id" }),
  parityCase("rpcGetOwedSummary", { as: "admin", args: [null], title: "rpcGetOwedSummary: a null id" }),
  parityCase("rpcGetOwedSummary", { as: "admin", args: [3], title: "rpcGetOwedSummary: an id that is not text" }),
  parityCase("rpcGetOwedSummary", { as: "admin", args: [" S_003 "], title: "rpcGetOwedSummary: a padded id is not trimmed" }),
  parityCase("rpcGetOwedSummary", { as: "manager", args: ["S_003"], title: "rpcGetOwedSummary: a manager is refused" }),
  parityCase("rpcGetOwedSummary", { as: "employee", args: ["S_003"], title: "rpcGetOwedSummary: an employee is refused, even for their own id" }),
  parityCase("rpcGetOwedSummary", { as: null, args: ["S_003"], title: "rpcGetOwedSummary: no token is refused" }),

  // ── rpcGetMyOwedSummary ─────────────────────────────────
  ...PEOPLE.map((id) => parityCase("rpcGetMyOwedSummary", { as: id, title: `rpcGetMyOwedSummary as ${id}` })),
  parityCase("rpcGetMyOwedSummary", { as: "S_003", args: ["S_004"], title: "rpcGetMyOwedSummary: an employee naming someone else still gets their own" }),
  parityCase("rpcGetMyOwedSummary", { as: null, title: "rpcGetMyOwedSummary: no token is refused" }),

  // ── rpcGetPaymentHistory ────────────────────────────────
  ...ROLES.map((role) => parityCase("rpcGetPaymentHistory", { as: role, title: `rpcGetPaymentHistory: no limit, as ${role}` })),
  ...[2, 0, 100000, "abc", "3", -1, -4, 2.7, null, true, [2]].map((limit) =>
    parityCase("rpcGetPaymentHistory", { as: "admin", args: [limit], title: `rpcGetPaymentHistory: limit ${JSON.stringify(limit)}` }),
  ),
  parityCase("rpcGetPaymentHistory", { as: "S_003", args: [1], title: "rpcGetPaymentHistory: an employee, limit 1" }),
  parityCase("rpcGetPaymentHistory", { as: "S_003", args: [25, "S_004"], title: "rpcGetPaymentHistory: an employee naming someone else gets only their own" }),
  parityCase("rpcGetPaymentHistory", { as: "S_002", args: [10], title: "rpcGetPaymentHistory: a manager sees everyone's" }),
  parityCase("rpcGetPaymentHistory", { as: null, title: "rpcGetPaymentHistory: no token is refused" }),

  // ── rpcPayShifts ────────────────────────────────────────
  payAndRead("rpcPayShifts: the full amount owed", "S_003", [pay(shifts("S_003", 1456.4))]),
  payAndRead("rpcPayShifts: part of it, oldest first, the remainder on the next shift, then more", "S_003", [
    pay(shifts("S_003", 300)),
    owed("S_003"),
    pay(shifts("S_003", 200), "admin", { advance: { minutes: 1 } }),
  ]),
  payAndRead("rpcPayShifts: a cent", "S_004", [pay(shifts("S_004", 0.01))]),
  payAndRead("rpcPayShifts: exactly one shift", "S_005", [pay(shifts("S_005", 124.7))]),
  payAndRead("rpcPayShifts: more than is owed is refused, by a cent and by a lot", "S_003", [pay(shifts("S_003", 1456.41)), pay(shifts("S_003", 5000)), pay(shifts("S_002", 1))]),
  payAndRead("rpcPayShifts: zero, negative and non-numeric amounts", "S_003", [
    pay(shifts("S_003", 0)),
    pay(shifts("S_003", -5)),
    pay(shifts("S_003", "")),
    pay(shifts("S_003", null)),
    pay(shifts("S_003", "abc"), "admin", { advance: { seconds: 1 } }),
    pay({ staffId: "S_003", method: "cash" }, "admin", { advance: { seconds: 1 } }),
    pay(shifts("S_003", "12.5"), "admin", { advance: { seconds: 1 } }),
    pay(shifts("S_003", true), "admin", { advance: { seconds: 1 } }),
  ]),
  payAndRead("rpcPayShifts: an amount that rounds to nothing, and amounts with three decimals", "S_003", [
    pay(shifts("S_003", 0.004)),
    pay(shifts("S_003", 1.005), "admin", { advance: { seconds: 1 } }), // 1.005 * 100 is 100.49999999999999: 1, where a database would say 1.01
    pay(shifts("S_003", 10.005), "admin", { advance: { seconds: 1 } }),
    pay(shifts("S_003", 175.996), "admin", { advance: { seconds: 1 } }),
  ]),
  payAndRead("rpcPayShifts: each method, a blank one, and refused ones", "S_003", [
    pay(shifts("S_003", 1, { method: "cash" })),
    pay(shifts("S_003", 2, { method: "bank" }), "admin", { advance: { seconds: 1 } }),
    pay(shifts("S_003", 3, { method: "etransfer" }), "admin", { advance: { seconds: 1 } }),
    pay(shifts("S_003", 4, { method: "other" }), "admin", { advance: { seconds: 1 } }),
    pay(shifts("S_003", 5, { method: "" }), "admin", { advance: { seconds: 1 } }),
    pay({ staffId: "S_003", amount: 6 }, "admin", { advance: { seconds: 1 } }),
    pay(shifts("S_003", 7, { method: "Cash" })),
    pay(shifts("S_003", 8, { method: "crypto" })),
    pay(shifts("S_003", 9, { method: 5 })),
  ]),
  payAndRead("rpcPayShifts: a paidOn in the past, today, blank or unreadable is ignored (dated now)", "S_004", [
    pay(shifts("S_004", 10, { paidOn: "2026-01-01" })),
    pay(shifts("S_004", 11, { paidOn: "2026-11-20" }), "admin", { advance: { seconds: 1 } }),
    pay(shifts("S_004", 12, { paidOn: "" }), "admin", { advance: { seconds: 1 } }),
    pay(shifts("S_004", 13, { paidOn: "not a date" }), "admin", { advance: { seconds: 1 } }),
  ]),
  payAndRead("rpcPayShifts: notes, an override flag, and an actorId in the input (ignored: the session decides)", "S_005", [
    pay(shifts("S_005", 50, { notes: "November, part one", overrideMismatch: true, actorId: "S_003", recordedBy: "S_003" })),
    pay(shifts("S_005", 25, { notes: "  padded  ", overrideMismatch: "yes" }), "admin", { advance: { seconds: 1 } }),
  ]),
  paritySequence("rpcPayShifts: people owed nothing", { writes: WRITES }, [
    pay(shifts("S_001", 10)),
    pay(shifts("S_006", 10)),
    pay(shifts("S_007", 10)),
    pay(shifts("S_002", 10)),
    history(),
  ]),
  paritySequence("rpcPayShifts: an unknown, blank, missing or odd person", { writes: WRITES }, [
    pay(shifts("S_999", 10)),
    pay(shifts("", 10)),
    pay({ amount: 10 }),
    pay(shifts(" S_003 ", 10)),
    pay({ staffId: 3, amount: 10 }),
    pay({ staffId: "s_003", amount: 10 }),
    history(),
  ]),
  paritySequence("rpcPayShifts: an input that is not an object", { writes: WRITES }, [
    step("rpcPayShifts", { as: "admin", args: [] }),
    step("rpcPayShifts", { as: "admin", args: [null] }),
    step("rpcPayShifts", { as: "admin", args: ["text"] }),
  ]),
  payAndRead("rpcPayShifts: two payments in a row that together clear the debt, then nothing is owed", "S_003", [
    pay(shifts("S_003", 1000)),
    pay(shifts("S_003", 456.4), "admin", { advance: { minutes: 2 } }),
    pay(shifts("S_003", 1), "admin", { advance: { minutes: 2 } }),
  ]),
  payAndRead("rpcPayShifts: two payments in the same second, then the history", "S_004", [pay(shifts("S_004", 100)), pay(shifts("S_004", 100))]),
  paritySequence("rpcPayShifts: a payroll admin pays; the overview and the person's own view follow", { writes: WRITES }, [
    pay(shifts("S_005", 400), "payroll_admin"),
    overview("payroll_admin"),
    mine("S_005"),
    history("S_005"),
  ]),
  parityCase("rpcPayShifts", { as: "manager", args: [shifts("S_003", 10)], writes: WRITES, title: "rpcPayShifts: a manager is refused (with the rpcPayShifts: prefix)" }),
  parityCase("rpcPayShifts", { as: "employee", args: [shifts("S_003", 10)], writes: WRITES, title: "rpcPayShifts: an employee is refused, even for themselves" }),
  parityCase("rpcPayShifts", { as: null, args: [shifts("S_003", 10)], writes: WRITES, title: "rpcPayShifts: no token is refused" }),
  paritySequence("rpcPayShifts: shifts whose pay needs rounding (times edited), paid in part and in full", { writes: [...WRITES, "attendance"] }, [
    edit("A_20261110_S_003", "2026-11-10T08:00:00", "2026-11-10T15:07:00"), // 7.12 h x 17.6 = 125.312
    edit("A_20261111_S_003", "2026-11-11T15:00:00", "2026-11-11T22:22:00"), // 7.37 h x 17.6 = 129.712
    edit("A_20261112_S_003", "2026-11-12T10:00:00", "2026-11-12T19:53:00"), // 9.88 h x 17.6 = 173.888
    owed("S_003"),
    overview(),
    pay(shifts("S_003", 125.315)),
    owed("S_003"),
    pay(shifts("S_003", 303.6), "admin", { advance: { minutes: 1 } }),
    owed("S_003"),
    history(),
  ]),

  // ── rpcPayBonus ─────────────────────────────────────────
  paritySequence("rpcPayBonus: a pending bonus in full becomes paid", { writes: WRITES_BONUS }, [payBonus(bonus(PENDING, 52.32)), owed("S_003"), mine("S_003"), history()]),
  paritySequence("rpcPayBonus: in two parts; the second makes it paid", { writes: WRITES_BONUS }, [
    payBonus(bonus(PENDING, 20)),
    owed("S_003"),
    payBonus(bonus(PENDING, 32.32), "admin", { advance: { minutes: 1 } }),
    owed("S_003"),
    payBonus(bonus(PENDING, 0.01), "admin", { advance: { minutes: 1 } }),
    history(),
  ]),
  paritySequence("rpcPayBonus: more than its amount, or than what is left, is refused", { writes: WRITES_BONUS }, [
    payBonus(bonus(PENDING, 52.33)),
    payBonus(bonus(PENDING, 50)),
    payBonus(bonus(PENDING, 2.33), "admin", { advance: { minutes: 1 } }),
    owed("S_003"),
  ]),
  paritySequence("rpcPayBonus: a proposed, a paid and a cancelled bonus are refused", { writes: WRITES_BONUS }, [
    payBonus(bonus(PROPOSED, 10)),
    payBonus(bonus(PAID, 120)),
    step("rpcCancelBonus", { as: "admin", args: [PENDING_SMALL, "Not owed"] }),
    payBonus(bonus(PENDING_SMALL, 1.54)),
    owed("S_003"),
  ]),
  paritySequence("rpcPayBonus: a deduction (negative) cannot be paid", { writes: WRITES_BONUS }, [
    step("rpcCreateBonus", { as: "admin", args: [{ staffId: "S_003", type: "deduction", amount: -12.4, reason: "Till shortage", date: "2026-11-19" }] }),
    payBonus(bonus(resultOf(1, "$.bonusId"), 12.4)),
    payBonus(bonus(resultOf(1, "$.bonusId"), -12.4)),
    owed("S_003"),
  ]),
  paritySequence("rpcPayBonus: an unknown, blank, missing or odd id", { writes: WRITES_BONUS }, [
    payBonus(bonus("B_19990101_000000_nop", 10)),
    payBonus(bonus("", 10)),
    payBonus({ amount: 10 }),
    payBonus(bonus(` ${PENDING} `, 10)),
    payBonus({ bonusId: 7, amount: 10 }),
    step("rpcPayBonus", { as: "admin", args: [] }),
    step("rpcPayBonus", { as: "admin", args: [null] }),
  ]),
  paritySequence("rpcPayBonus: zero, negative, non-numeric and rounding-to-nothing amounts", { writes: WRITES_BONUS }, [
    payBonus(bonus(PENDING, 0)),
    payBonus(bonus(PENDING, -1)),
    payBonus(bonus(PENDING, "abc")),
    payBonus(bonus(PENDING, 0.004), "admin", { advance: { seconds: 1 } }),
    payBonus(bonus(PENDING, 1.005), "admin", { advance: { seconds: 1 } }),
    owed("S_003"),
    history(),
  ]),
  paritySequence("rpcPayBonus: each method, notes given or defaulted, a refused method", { writes: WRITES_BONUS }, [
    payBonus(bonus(PENDING, 1, { method: "bank", notes: "Paid with wages" })),
    payBonus(bonus(PENDING, 1, { method: "etransfer" }), "admin", { advance: { seconds: 1 } }),
    payBonus(bonus(PENDING, 1, { method: "other", paidOn: "2026-01-01" }), "admin", { advance: { seconds: 1 } }),
    payBonus({ bonusId: PENDING, amount: 1 }, "admin", { advance: { seconds: 1 } }),
    payBonus(bonus(PENDING, 1, { method: "cheque" })),
    history(),
  ]),
  paritySequence("rpcPayBonus: a payroll admin pays a manager's fee", { writes: WRITES_BONUS }, [payBonus(bonus(PENDING_FEE, 120), "payroll_admin"), owed("S_002", "payroll_admin"), overview("payroll_admin")]),
  parityCase("rpcPayBonus", { as: "manager", args: [bonus(PENDING_FEE, 120)], writes: WRITES_BONUS, title: "rpcPayBonus: a manager is refused, even for their own fee" }),
  parityCase("rpcPayBonus", { as: "employee", args: [bonus(PENDING, 52.32)], writes: WRITES_BONUS, title: "rpcPayBonus: an employee is refused" }),
  parityCase("rpcPayBonus", { as: null, args: [bonus(PENDING, 52.32)], writes: WRITES_BONUS, title: "rpcPayBonus: no token is refused" }),

  // ── rpcUndoPayment ──────────────────────────────────────
  paritySequence("rpcUndoPayment: a shift payment; owed goes back to exactly what it was", { writes: WRITES }, [
    owed("S_003"),
    pay(shifts("S_003", 300.5)),
    owed("S_003"),
    undo(resultOf(2, "$.paymentId")),
    owed("S_003"),
    history(),
    overview(),
  ]),
  paritySequence("rpcUndoPayment: a bonus payment; the bonus is pending again", { writes: WRITES_BONUS }, [
    payBonus(bonus(PENDING, 52.32)),
    undo(resultOf(1, "$.paymentId")),
    owed("S_003"),
    payBonus(bonus(PENDING, 52.32), "admin", { advance: { minutes: 1 } }),
  ]),
  paritySequence("rpcUndoPayment: a part payment of a bonus leaves it pending", { writes: WRITES_BONUS }, [payBonus(bonus(PENDING, 20)), undo(resultOf(1, "$.paymentId")), owed("S_003")]),
  paritySequence("rpcUndoPayment: the first of two part payments of a bonus that is now paid", { writes: WRITES_BONUS }, [
    payBonus(bonus(PENDING, 20)),
    payBonus(bonus(PENDING, 32.32), "admin", { advance: { minutes: 1 } }),
    undo(resultOf(1, "$.paymentId")),
    owed("S_003"),
    history(),
  ]),
  paritySequence("rpcUndoPayment: twice; the second is not found", { writes: WRITES }, [pay(shifts("S_004", 50)), undo(resultOf(1, "$.paymentId")), undo(resultOf(1, "$.paymentId")), history()]),
  paritySequence("rpcUndoPayment: an unknown, blank, missing or odd id", { writes: WRITES }, [
    undo("P_19990101_000000_nop"),
    undo(""),
    undo(null),
    step("rpcUndoPayment", { as: "admin", args: [] }),
    undo(7),
    undo(` ${FIXTURE_PAY_3} `),
    undo(FIXTURE_PAY_3.toLowerCase()),
  ]),
  paritySequence("rpcUndoPayment: a fixture shift payment from months ago (110 items)", { writes: WRITES }, [undo(FIXTURE_PAY_3), owed("S_003"), mine("S_003"), history("S_003"), overview()]),
  paritySequence("rpcUndoPayment: a fixture bonus payment from months ago", { writes: WRITES_BONUS }, [undo(FIXTURE_PAY_BONUS, "payroll_admin"), owed("S_002"), history()]),
  paritySequence("rpcUndoPayment: pay, undo, pay again", { writes: WRITES }, [
    pay(shifts("S_005", 200)),
    undo(resultOf(1, "$.paymentId")),
    pay(shifts("S_005", 200), "admin", { advance: { minutes: 1 } }),
    owed("S_005"),
    history(),
  ]),
  paritySequence("rpcUndoPayment: the first of two payments to the same person", { writes: WRITES }, [
    pay(shifts("S_003", 100)),
    pay(shifts("S_003", 100), "admin", { advance: { minutes: 1 } }),
    undo(resultOf(1, "$.paymentId")),
    owed("S_003"),
    history(),
    pay(shifts("S_003", 1356.4), "admin", { advance: { minutes: 1 } }),
    owed("S_003"),
  ]),
  paritySequence("rpcUndoPayment: an undone payment's id is not found to a second undo after other payments", { writes: WRITES }, [
    pay(shifts("S_004", 10)),
    undo(resultOf(1, "$.paymentId")),
    pay(shifts("S_004", 20), "admin", { advance: { minutes: 1 } }),
    undo(resultOf(1, "$.paymentId")),
    history("admin", 3),
  ]),
  parityCase("rpcUndoPayment", { as: "manager", args: [FIXTURE_PAY_3], writes: WRITES, title: "rpcUndoPayment: a manager is refused" }),
  parityCase("rpcUndoPayment", { as: "employee", args: [FIXTURE_PAY_3], writes: WRITES, title: "rpcUndoPayment: an employee is refused" }),
  parityCase("rpcUndoPayment", { as: null, args: [FIXTURE_PAY_3], writes: WRITES, title: "rpcUndoPayment: no token is refused" }),
];
