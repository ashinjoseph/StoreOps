// Parity cases for Bonuses (card P3-09a): rpcGetProposedBonuses, rpcApproveBonus,
// rpcCancelBonus and rpcCreateBonus.
//
// The fixture (frozen at Friday 20 November 2026, cases start at 10:30 that day) holds 23 bonuses,
// all commissions written by the real engine for the last four weeks, all dated the boot instant:
//   - proposed: z6p (S_003), ben (S_004), nml (S_005), zuj (S_003), c2h (S_004), oaf (S_002 fee)
//   - pending:  ofw, 0nu, cvs, ... (every older week's proposals, approved); 4mu is the fee, pending
//   - paid:     djm and x77 (S_002's management fee for the two oldest weeks)
//   - cancelled: none. A cancelled bonus is made inside a case (cancel one, then use it).
// S_001 admin, S_002 manager, S_003 to S_005 employees, S_006 payroll admin, S_007 inactive.
//
// Every write case declares bonuses and audit_log: any other table that changes on either side
// fails the case.
import { parityCase, paritySequence, resultOf, step, type ParityCase } from "../case";

const ROLES = ["admin", "manager", "employee", "payroll_admin"] as const;
const WRITES = ["bonuses", "audit_log"];

const PROPOSED = "B_20261120_093000_z6p"; // S_003, proposed
const PROPOSED_2 = "B_20261120_093000_ben";
const PROPOSED_3 = "B_20261120_093000_nml";
const PROPOSED_FEE = "B_20261120_093000_oaf"; // S_002, proposed
const PENDING = "B_20261120_093000_ofw"; // approved already
const PAID = "B_20261120_093000_djm"; // paid
const UNKNOWN = "B_19990101_000000_nop";

const list = (as = "admin") => step("rpcGetProposedBonuses", { as });
const create = (input: unknown, as = "admin") => step("rpcCreateBonus", { as, args: [input] });
const approve = (id: unknown, as = "admin") => step("rpcApproveBonus", { as, args: [id] });
const cancel = (id: unknown, reason?: unknown, as = "admin") => step("rpcCancelBonus", { as, args: reason === undefined ? [id] : [id, reason] });
const input = (extra: Record<string, unknown> = {}) => ({ staffId: "S_003", type: "bonus", amount: 25.5, reason: "Parity", date: "2026-11-19", ...extra });

export const bonusesCases: ParityCase[] = [
  // ── rpcGetProposedBonuses ───────────────────────────────
  ...ROLES.map((role) => parityCase("rpcGetProposedBonuses", { as: role })),
  parityCase("rpcGetProposedBonuses", { as: null, title: "rpcGetProposedBonuses: no token is refused" }),

  // ── rpcCreateBonus ──────────────────────────────────────
  paritySequence("rpcCreateBonus: an admin creates one of every type, and none shows as proposed", { writes: WRITES }, [
    create(input({ type: "bonus", amount: 25.5, reason: "Holiday bonus" })),
    create(input({ type: "commission", amount: 10, reason: "Manual commission" })),
    create(input({ type: "incentive", amount: 15.25, reason: "Upsell incentive" })),
    create(input({ type: "deduction", amount: -12.4, reason: "Till shortage" })),
    create(input({ type: "tip", amount: 8, reason: "Shared tips" })),
    create(input({ type: "adjustment", amount: -3.33, reason: "Correction" })),
    list(),
  ]),
  paritySequence("rpcCreateBonus: a created bonus is already pending, so approving it is refused", { writes: WRITES }, [
    create(input()),
    approve(resultOf(1, "$.bonusId")),
    list(),
  ]),
  paritySequence("rpcCreateBonus: with a company and notes, and with neither", { writes: WRITES }, [
    create(input({ company: "vape", notes: "Quarter end" })),
    create(input({ company: "cstore", notes: "" })),
    create(input({ company: "", notes: "only notes" })),
    create({ staffId: "S_004", type: "tip", amount: 5, reason: "No optional fields" }),
  ]),
  paritySequence("rpcCreateBonus: with no date it is dated now; a date that is today", { writes: WRITES }, [
    create({ staffId: "S_003", type: "bonus", amount: 5, reason: "No date" }),
    create(input({ date: "2026-11-20" })),
    create(input({ date: "2026-01-01" })),
    create(input({ date: "" })),
  ]),
  paritySequence("rpcCreateBonus: amounts are rounded to cents, a negative one is kept, a tiny one rounds to zero", { writes: WRITES }, [
    create(input({ amount: 10.005 })),
    create(input({ amount: 1.005 })), // 1.005 * 100 is 100.49999999999999: rounds to 1, where a database would say 1.01
    create(input({ amount: 1.255 })),
    create(input({ amount: 10.004 })),
    create(input({ amount: 0.004 })),
    create(input({ amount: -0.004 })),
    create(input({ amount: "12.349" })),
    create(input({ amount: 1234567.891 })),
    create(input({ amount: -250 })),
  ]),
  paritySequence("rpcCreateBonus: zero and non-numeric amounts", { writes: WRITES }, [
    create(input({ amount: 0 })),
    create(input({ amount: "0" })),
    create(input({ amount: "" })),
    create(input({ amount: null })),
    create(input({ amount: "abc" })),
    create(input({ amount: undefined })),
    create({ staffId: "S_003", type: "bonus", reason: "no amount key" }),
    create(input({ amount: true })),
    create(input({ amount: [7] })),
  ]),
  paritySequence("rpcCreateBonus: a missing or unknown person, and the inactive one", { writes: WRITES }, [
    create(input({ staffId: "" })),
    create(input({ staffId: undefined })),
    create(input({ staffId: "S_999" })),
    create(input({ staffId: "s_003" })),
    create(input({ staffId: " S_003 " })),
    create(input({ staffId: 3 })),
    create(input({ staffId: "S_007" })),
    list(),
  ]),
  paritySequence("rpcCreateBonus: a missing or unknown type, a missing reason", { writes: WRITES }, [
    create(input({ type: "" })),
    create(input({ type: undefined })),
    create(input({ type: "Bonus" })),
    create(input({ type: "gift" })),
    create(input({ type: "paid" })),
    create(input({ reason: "" })),
    create(input({ reason: undefined })),
  ]),
  paritySequence("rpcCreateBonus: a long reason, a reason with punctuation, padded text", { writes: WRITES }, [
    create(input({ reason: "x".repeat(150) })),
    create(input({ reason: "  Padded reason  ", notes: "  padded notes  " })),
    create(input({ reason: "Quotes \" ' and ünïcode — and <b>html</b>" })),
  ]),
  paritySequence("rpcCreateBonus: an input that is not an object", { writes: WRITES }, [
    step("rpcCreateBonus", { as: "admin", args: [] }),
    step("rpcCreateBonus", { as: "admin", args: [null] }),
    step("rpcCreateBonus", { as: "admin", args: ["text"] }),
  ]),
  // No parity case for an unreadable date or a company outside cstore / vape. The Sheet stored
  // both (an invalid date cell; any text); the new schema refuses them, so the new app answers
  // "Invalid date" / "Invalid company: …" and writes nothing. The page sends neither.
  // ops/test/bonuses.test.ts covers the refusals. (Orchestrator's decision, review of P3-09a.)
  paritySequence("rpcCreateBonus: an actorId in the input is ignored; the session decides", { writes: WRITES }, [
    create(input({ actorId: "S_003", createdBy: "S_003" })),
  ]),
  paritySequence("rpcCreateBonus: two in the same second get two rows", { writes: WRITES }, [create(input()), create(input()), create(input({ amount: 9 }))]),
  parityCase("rpcCreateBonus", { as: "payroll_admin", args: [input()], writes: WRITES, title: "rpcCreateBonus: a payroll admin is refused" }),
  parityCase("rpcCreateBonus", { as: "manager", args: [input()], writes: WRITES, title: "rpcCreateBonus: a manager is refused" }),
  parityCase("rpcCreateBonus", { as: "employee", args: [input()], writes: WRITES, title: "rpcCreateBonus: an employee is refused" }),
  parityCase("rpcCreateBonus", { as: null, args: [input()], writes: WRITES, title: "rpcCreateBonus: no token is refused" }),

  // ── rpcApproveBonus ─────────────────────────────────────
  paritySequence("rpcApproveBonus: a proposed bonus becomes pending and leaves the proposed list", { writes: WRITES }, [list(), approve(PROPOSED), list()]),
  paritySequence("rpcApproveBonus: a payroll admin approves", { writes: WRITES }, [approve(PROPOSED_2, "payroll_admin"), list("payroll_admin")]),
  paritySequence("rpcApproveBonus: the fee, and several in a row", { writes: WRITES }, [approve(PROPOSED_FEE), approve(PROPOSED_3), approve(PROPOSED), list()]),
  paritySequence("rpcApproveBonus: twice in a row, the second is refused", { writes: WRITES }, [approve(PROPOSED), approve(PROPOSED), list()]),
  paritySequence("rpcApproveBonus: one that is already pending is refused", { writes: WRITES }, [approve(PENDING)]),
  paritySequence("rpcApproveBonus: one that is paid is refused", { writes: WRITES }, [approve(PAID)]),
  paritySequence("rpcApproveBonus: one that was cancelled is refused", { writes: WRITES }, [cancel(PROPOSED, "Wrong rule"), approve(PROPOSED), list()]),
  paritySequence("rpcApproveBonus: an unknown, a blank and an odd id", { writes: WRITES }, [
    approve(UNKNOWN),
    approve(""),
    approve(null),
    step("rpcApproveBonus", { as: "admin", args: [] }),
    approve(0),
    approve(12),
    approve(` ${PROPOSED} `),
    approve(PROPOSED.toLowerCase()),
    approve({ bonusId: PROPOSED }),
    list(),
  ]),
  parityCase("rpcApproveBonus", { as: "manager", args: [PROPOSED], writes: WRITES, title: "rpcApproveBonus: a manager is refused" }),
  parityCase("rpcApproveBonus", { as: "employee", args: [PROPOSED], writes: WRITES, title: "rpcApproveBonus: an employee is refused" }),
  parityCase("rpcApproveBonus", { as: null, args: [PROPOSED], writes: WRITES, title: "rpcApproveBonus: no token is refused" }),

  // ── rpcCancelBonus ──────────────────────────────────────
  paritySequence("rpcCancelBonus: a proposed bonus, with a reason", { writes: WRITES }, [cancel(PROPOSED, "Rule was wrong"), list()]),
  paritySequence("rpcCancelBonus: a proposed bonus, with no reason", { writes: WRITES }, [cancel(PROPOSED), list()]),
  paritySequence("rpcCancelBonus: a pending bonus, with a reason, by a payroll admin", { writes: WRITES }, [cancel(PENDING, "Left the company", "payroll_admin")]),
  paritySequence("rpcCancelBonus: a pending bonus, with no reason and with an empty one", { writes: WRITES }, [cancel(PENDING), cancel("B_20261120_093000_0nu", "")]),
  paritySequence("rpcCancelBonus: a paid bonus is refused", { writes: WRITES }, [cancel(PAID, "Mistake"), cancel(PAID)]),
  paritySequence("rpcCancelBonus: an already cancelled bonus is answered as it is, nothing written", { writes: WRITES }, [
    cancel(PROPOSED, "First"),
    cancel(PROPOSED, "Second"),
    cancel(PROPOSED),
    list(),
  ]),
  paritySequence("rpcCancelBonus: a reason that is not text, a long one, one with a separator", { writes: WRITES }, [
    cancel(PROPOSED, 42),
    cancel(PROPOSED_2, "a | b"),
    cancel(PROPOSED_3, "y".repeat(300)),
    cancel(PENDING, null),
    cancel("B_20261120_093000_0nu", false),
  ]),
  paritySequence("rpcCancelBonus: a note already on the bonus is kept before the reason", { writes: WRITES }, [
    create(input({ notes: "Original note" })),
    cancel(resultOf(1, "$.bonusId"), "No longer owed"),
    cancel(resultOf(1, "$.bonusId"), "Again"),
  ]),
  paritySequence("rpcCancelBonus: an unknown, a blank and an odd id", { writes: WRITES }, [
    cancel(UNKNOWN, "x"),
    cancel("", "x"),
    cancel(null, "x"),
    step("rpcCancelBonus", { as: "admin", args: [] }),
    cancel(0, "x"),
    cancel(` ${PROPOSED} `, "x"),
    list(),
  ]),
  parityCase("rpcCancelBonus", { as: "manager", args: [PROPOSED, "x"], writes: WRITES, title: "rpcCancelBonus: a manager is refused" }),
  parityCase("rpcCancelBonus", { as: "employee", args: [PROPOSED, "x"], writes: WRITES, title: "rpcCancelBonus: an employee is refused" }),
  parityCase("rpcCancelBonus", { as: null, args: [PROPOSED, "x"], writes: WRITES, title: "rpcCancelBonus: no token is refused" }),

  // ── Sequences ───────────────────────────────────────────
  paritySequence("a bonus is created, approved (refused: already pending), cancelled, approved again (refused)", { writes: WRITES }, [
    create(input({ type: "incentive", amount: 40, reason: "Sequence", company: "vape", notes: "n" })),
    approve(resultOf(1, "$.bonusId")),
    cancel(resultOf(1, "$.bonusId"), "Changed our minds"),
    approve(resultOf(1, "$.bonusId")),
    cancel(resultOf(1, "$.bonusId"), "again"),
    list(),
  ]),
  paritySequence("a proposed bonus goes through approve, cancel, approve, with the clock moving", { writes: WRITES }, [
    approve(PROPOSED),
    step("rpcCancelBonus", { as: "payroll_admin", args: [PROPOSED, "Paid by cash instead"], advance: { minutes: 20 } }),
    step("rpcApproveBonus", { as: "admin", args: [PROPOSED], advance: { hours: 2 } }),
    list(),
  ]),
  paritySequence("two people work the same list", { writes: WRITES }, [
    approve(PROPOSED, "admin"),
    cancel(PROPOSED_2, "Not owed", "payroll_admin"),
    list("payroll_admin"),
    approve(PROPOSED_2, "admin"),
    list("admin"),
  ]),
];
