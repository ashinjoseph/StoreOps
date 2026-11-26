// Parity cases for the commission engine (card P3-10b): rpcGetCommissionRuns and rpcRunCommissionEngine.
//
// The fixture (frozen at Friday 20 November 2026, cases start at 10:30 that day) holds three rules
// (CR_001 cstore 3% over 6,000, CR_002 vape 5% over 1,200, CR_003 a 120 fee for S_002 at cstore, all
// from 2026-09-11 with no end) and four runs the real engine wrote for the weeks starting 19 October,
// 26 October, 2 November and 9 November. So "last week" (9 to 15 November) has a run already: a plain
// run is skipped. S_001 admin, S_002 manager, S_003 to S_005 employees, S_006 payroll admin, S_007 inactive.
//
// To make the engine do something a case moves the clock to another Monday. A sign-in lasts 24 hours
// and a call in its second half renews it, so a jump of days is made as a walk: each caller still in
// use calls rpcGetMe an hour before their sign-in would run out (Plan, below). The renewals are why
// "sessions" is declared.
//
// Every run case declares commission_runs, bonuses and audit_log (and sessions, and the tables its
// other steps write): any other table that changes on either side fails the case.
import { parityCase, paritySequence, resultOf, step, type ParityCase, type Step } from "../case";
import { durationMs } from "../clock";

const RUN_W = ["commission_runs", "bonuses", "audit_log", "sessions"];
const RULE_W = [...RUN_W, "commission_rules"];
const TILL_W = [...RUN_W, "till_sessions", "attendance", "sales"];

const START = Date.parse("2026-11-20T15:30:00Z");
const HOUR = 3_600_000;

/**
 * A sequence whose clock moves: the callers named in `keep` stay signed in on the way.
 * A sign-in lasts 24 hours and a call in its second half renews it for 24 more. The plan follows
 * each kept caller's expiry and, before a step that would find one signed out, has them call
 * rpcGetMe an hour before their sign-in runs out. Every step gets an absolute time.
 * (SIGNED_OUT_RULE in ops/parity/run.ts fails the case if a caller is signed out all the same.)
 */
class Plan {
  private readonly steps: Step[] = [];
  private cur = START;
  private readonly expiry = new Map<string, number>();
  constructor(private readonly keep: readonly string[]) {
    for (const who of keep) this.expiry.set(who, START + 24 * HOUR);
  }
  /** Add a step. `to` (an instant) sets the clock; otherwise the step's own `advance`, or five minutes, after the last one. */
  add(s: Step, to?: string): this {
    const at = to !== undefined ? Date.parse(to) : this.cur + (s.advance !== undefined ? durationMs(s.advance) : 5 * 60_000);
    const iso = (ms: number): string => new Date(ms).toISOString();
    for (;;) {
      const due = this.keep.filter((w) => (this.expiry.get(w) as number) - at < 5 * 60_000).sort((x, y) => (this.expiry.get(x) as number) - (this.expiry.get(y) as number))[0];
      if (due === undefined) break;
      const ends = this.expiry.get(due) as number;
      const t = Math.max(this.cur, ends - HOUR);
      if (t >= ends) throw new Error(`commission cases: ${due} would already be signed out at ${iso(t)}`);
      this.steps.push(step("rpcGetMe", { as: due, at: iso(t) }));
      this.expiry.set(due, t + 24 * HOUR);
      this.cur = t;
    }
    const { advance: _relative, ...rest } = s;
    this.steps.push({ ...rest, at: iso(at) });
    this.cur = at;
    // The step itself renews its caller when it falls in the second half of their sign-in.
    const who = typeof s.as === "string" ? s.as : undefined;
    const ends = who === undefined ? undefined : this.expiry.get(who);
    if (who !== undefined && ends !== undefined && ends - at < 12 * HOUR) this.expiry.set(who, at + 24 * HOUR);
    return this;
  }
  /** The number of the last step added, counting from 1. */
  get n(): number {
    return this.steps.length;
  }
  seq(title: string, writes: readonly string[]): ParityCase {
    return paritySequence(title, { writes }, this.steps);
  }
}

// Mondays, 09:00 Toronto (14:00Z while it is winter time, 13:00Z in summer time)
const MON_SEP14 = "2026-09-14T13:00:00Z"; // last week 7 to 13 Sep: the rules start on the 11th, after the week's first day
const MON_SEP21 = "2026-09-21T13:00:00Z"; // 14 to 20 Sep: every rule applies
const MON_OCT05 = "2026-10-05T13:00:00Z"; // 28 Sep to 4 Oct: the week crosses a month end
const MON_NOV23 = "2026-11-23T14:00:00Z"; // 16 to 22 Nov: no run yet; sales up to Friday 20th
const MON_NOV30 = "2026-11-30T14:00:00Z"; // 23 to 29 Nov: nothing sold
const MON_DEC07 = "2026-12-07T14:00:00Z"; // 30 Nov to 6 Dec: crosses a month end, nothing sold
const SAT21 = "2026-11-21T14:00:00Z"; // Saturday 21st, 09:00

const runs = (as = "admin", ...limit: unknown[]) => step("rpcGetCommissionRuns", { as, args: limit });
const run = (as = "admin", ...force: unknown[]) => step("rpcRunCommissionEngine", { as, args: force });
const proposed = (as = "admin") => step("rpcGetProposedBonuses", { as });
const rules = () => step("rpcGetCommissionRules", { as: "admin" });
const create = (input: unknown) => step("rpcCreateCommissionRule", { as: "admin", args: [input] });
const update = (input: unknown) => step("rpcUpdateCommissionRule", { as: "admin", args: [input] });
const approve = (id: unknown) => step("rpcApproveBonus", { as: "admin", args: [id] });
const cancel = (id: unknown, reason = "Parity") => step("rpcCancelBonus", { as: "admin", args: [id, reason] });

const pct = (extra: Record<string, unknown> = {}) => ({ name: "Parity percentage", appliesTo: "all_staff", company: "cstore", threshold: 1000, percentage: 4, effectiveFrom: "2026-11-09", ...extra });
const fixed = (extra: Record<string, unknown> = {}) => ({ name: "Parity fee", appliesTo: "specific_staff", staffId: "S_003", company: "vape", threshold: 0, ruleType: "fixed", fixedAmount: 75, effectiveFrom: "2026-11-09", ...extra });

/** The three fixture rules' thresholds, lifted out of reach of any week's sales. */
const LIFT = [
  update({ ruleId: "CR_001", threshold: 90000 }),
  update({ ruleId: "CR_002", threshold: 90000 }),
  update({ ruleId: "CR_003", threshold: 90000 }),
];

/** One run on a Monday, then what the page shows afterwards. */
function weekOf(title: string, monday: string, as = "admin", writes: readonly string[] = RUN_W): ParityCase {
  return new Plan([as])
    .add(run(as), monday)
    .add(runs(as))
    .add(proposed(as))
    .add(run(as))
    .add(run(as, true))
    .add(runs(as))
    .add(proposed(as))
    .seq(title, writes);
}

export const commissionCases: ParityCase[] = [
  // ── rpcGetCommissionRuns ────────────────────────────────
  parityCase("rpcGetCommissionRuns", { as: "admin" }),
  parityCase("rpcGetCommissionRuns", { as: "manager" }),
  parityCase("rpcGetCommissionRuns", { as: "payroll_admin" }),
  parityCase("rpcGetCommissionRuns", { as: "employee" }),
  parityCase("rpcGetCommissionRuns", { as: null, title: "rpcGetCommissionRuns: no token is refused" }),
  ...([1, 2, 0, -1, "2", "abc", 2.5, 100, null, true, "", " 3 ", [2], { n: 1 }] as unknown[]).map((limit) =>
    parityCase("rpcGetCommissionRuns", { as: "admin", args: [limit], title: `rpcGetCommissionRuns: limit ${JSON.stringify(limit)}` }),
  ),
  parityCase("rpcGetCommissionRuns", { as: "manager", args: [1], title: "rpcGetCommissionRuns: a manager with limit 1" }),

  // ── rpcRunCommissionEngine: who may call, and last week (already run by the fixture) ──
  parityCase("rpcRunCommissionEngine", { as: "admin", writes: RUN_W, title: "rpcRunCommissionEngine: an admin runs last week, which the fixture already ran: skipped" }),
  parityCase("rpcRunCommissionEngine", { as: "payroll_admin", writes: RUN_W, title: "rpcRunCommissionEngine: a payroll admin runs last week: skipped" }),
  parityCase("rpcRunCommissionEngine", { as: "manager", writes: RUN_W, title: "rpcRunCommissionEngine: a manager is refused" }),
  parityCase("rpcRunCommissionEngine", { as: "employee", writes: RUN_W, title: "rpcRunCommissionEngine: an employee is refused" }),
  parityCase("rpcRunCommissionEngine", { as: null, writes: RUN_W, title: "rpcRunCommissionEngine: no token is refused" }),
  parityCase("rpcRunCommissionEngine", { as: "manager", args: [true], writes: RUN_W, title: "rpcRunCommissionEngine: a manager forcing is refused" }),

  paritySequence("rpcRunCommissionEngine: last week is skipped, forced it runs again but proposes nothing new", { as: "admin", writes: RUN_W }, [
    run(),
    run("admin", false),
    run("admin", true),
    runs(),
    proposed(),
    run("admin", true),
    runs(),
  ]),
  paritySequence("rpcRunCommissionEngine: only the boolean true forces", { as: "admin", writes: RUN_W }, [
    run("admin", "true"),
    run("admin", 1),
    run("admin", "yes"),
    run("admin", null),
    run("admin", [true]),
    run("admin", { force: true }),
    runs(),
    run("admin", true),
    runs(),
  ]),

  // ── Other weeks ─────────────────────────────────────────
  weekOf("rpcRunCommissionEngine: a week nobody has run (16 to 22 Nov): proposals, skip, forced re-run", MON_NOV23),
  weekOf("rpcRunCommissionEngine: a payroll admin runs 16 to 22 Nov", MON_NOV23, "payroll_admin"),
  weekOf("rpcRunCommissionEngine: a week with no sales (23 to 29 Nov): only the fee", MON_NOV30),
  weekOf("rpcRunCommissionEngine: a week that crosses a month end with no sales (30 Nov to 6 Dec)", MON_DEC07),
  weekOf("rpcRunCommissionEngine: a week that crosses a month end with sales (28 Sep to 4 Oct)", MON_OCT05),
  weekOf("rpcRunCommissionEngine: every rule applies (14 to 20 Sep)", MON_SEP21),
  weekOf("rpcRunCommissionEngine: the rules start after the week's first day (7 to 13 Sep): no active rule, a run row with a note", MON_SEP14),

  new Plan(["admin"])
    .add(run(), MON_SEP14)
    .add(run(), MON_SEP21)
    .add(run(), MON_OCT05)
    .add(run(), MON_NOV23)
    .add(run(), MON_NOV30)
    .add(runs("admin", 20))
    .add(proposed())
    .seq("rpcRunCommissionEngine: week after week, then the history and the proposed list", RUN_W),

  new Plan(["admin"])
    .add(run(), MON_NOV23)
    .add(run("admin", true), "2026-11-23T20:00:00Z")
    .add(run("admin", true))
    .add(runs("admin", 3))
    .add(runs("admin", 1))
    .seq("rpcRunCommissionEngine: two forced re-runs of one week; the first run is the one named as previous", RUN_W),

  // ── Sales below every threshold ─────────────────────────
  (() => {
    const p = new Plan(["admin"]);
    for (const u of LIFT) p.add(u);
    return p
      .add(run(), MON_NOV23)
      .add(runs())
      .add(proposed())
      .add(rules())
      .seq("rpcRunCommissionEngine: sales below every threshold: no proposals, still a run row", RULE_W);
  })(),

  // ── What force does to the earlier run's bonuses ────────
  new Plan(["admin"])
    .add(run(), MON_NOV23)
    .add(proposed())
    .add(cancel(resultOf(1, "$.bonusesProposed[0].bonusId")))
    .add(run("admin", true))
    .add(proposed())
    .add(runs())
    .seq("rpcRunCommissionEngine: force re-proposes a bonus that was cancelled, and only that one", RUN_W),
  new Plan(["admin"])
    .add(run(), MON_NOV23)
    .add(approve(resultOf(1, "$.bonusesProposed[0].bonusId")))
    .add(approve(resultOf(1, "$.bonusesProposed[1].bonusId")))
    .add(cancel(resultOf(1, "$.bonusesProposed[2].bonusId")))
    .add(run("admin", true))
    .add(proposed())
    .add(runs())
    .seq("rpcRunCommissionEngine: force leaves approved and proposed bonuses alone, and fills in the cancelled one", RUN_W),
  new Plan(["admin", "payroll_admin"])
    .add(run(), MON_NOV23)
    .add(approve(resultOf(1, "$.bonusesProposed[0].bonusId")))
    .add(run("payroll_admin", true))
    .add(runs("payroll_admin"))
    .add(proposed("payroll_admin"))
    .seq("rpcRunCommissionEngine: an admin runs, a payroll admin forces", RUN_W),
];

// ── Rules made in the same sequence ──────────────────────────
function withRules(title: string, made: readonly Step[], monday = MON_NOV23): ParityCase {
  const p = new Plan(["admin"]);
  for (const m of made) p.add(m);
  return p.add(run(), monday).add(runs()).add(proposed()).add(run()).seq(title, RULE_W);
}

commissionCases.push(
  withRules("a fixed amount for one person at vape is proposed alongside the fixture's rules", [create(fixed())]),
  withRules("a fixed amount for all staff at vape is proposed for each active person, none for the inactive one", [create(fixed({ appliesTo: "all_staff", staffId: undefined, name: "Everyone's fee" }))]),
  withRules("a fixed amount with a threshold pays only people whose sales clear it", [
    create(fixed({ appliesTo: "all_staff", staffId: undefined, threshold: 1100, fixedAmount: 33.333, name: "Vape bonus over 1,100" })),
  ]),
  withRules("a fixed amount for a person with no sales at that company and a threshold pays nothing", [create(fixed({ staffId: "S_002", threshold: 1, company: "vape" }))]),
  withRules("a rule for the inactive person pays nothing", [create(fixed({ staffId: "S_007" })), create(pct({ appliesTo: "specific_staff", staffId: "S_007", threshold: 0 }))]),
  withRules("a rule switched off pays nothing", [create(fixed({ active: false })), create(pct({ active: false, threshold: 0 }))]),
  withRules("a rule that ended before the week pays nothing", [create(fixed({ effectiveTo: "2026-11-10" })), create(pct({ effectiveTo: "2026-11-15", threshold: 0 }))]),
  withRules("a rule ending on the first day of the week still applies; one starting the day after does not", [
    create(fixed({ effectiveFrom: "2026-11-01", effectiveTo: "2026-11-16", name: "Ends on the Monday" })),
    create(pct({ effectiveFrom: "2026-11-17", threshold: 0, name: "Starts on the Tuesday" })),
    create(pct({ effectiveFrom: "2026-11-16", threshold: 0, company: "vape", percentage: 1, name: "Starts on the Monday" })),
  ]),
  withRules("a rule that starts after the week pays nothing", [create(pct({ effectiveFrom: "2026-11-30", threshold: 0 }))]),
  withRules("several percentage rules for one person at one till: the first pays, the rest are blocked", [
    create(pct({ threshold: 100, percentage: 10, name: "Second cstore rule" })),
    create(pct({ threshold: 0, percentage: 50, name: "Third cstore rule", appliesTo: "specific_staff", staffId: "S_003" })),
  ]),
  withRules("two fees for one person at one till both pay: each asks only whether it has paid", [create(fixed({ staffId: "S_003", company: "cstore", name: "First fee" })), create(fixed({ staffId: "S_003", company: "cstore", fixedAmount: 20, name: "Second fee" }))]),
  withRules("a fee and a percentage rule for the same person both pay", [create(fixed({ staffId: "S_003", company: "cstore", fixedAmount: 50 })), create(pct({ threshold: 0, percentage: 1 }))]),
  withRules("a person with sales at both tills earns at each", [create(pct({ company: "vape", threshold: 100, percentage: 2.5 }))]),
  withRules("amounts are rounded to cents; a threshold with cents", [
    create(pct({ threshold: 6000.005, percentage: 3.333, company: "cstore", name: "Odd cents" })),
    create(fixed({ fixedAmount: 20.456, staffId: "S_004", company: "cstore", name: "Odd fee" })),
    create(fixed({ fixedAmount: 0.004 + 0.002, staffId: "S_005", company: "vape", name: "Tiny fee" })),
  ]),
  withRules("a percentage so small it rounds to nothing is not proposed; one that rounds to a cent is", [
    create(pct({ threshold: 0, percentage: 0.0001, company: "vape", name: "Hair" })),
    create(pct({ threshold: 0, percentage: 0.0001, company: "cstore", name: "Almost nothing" })),
  ]),
  withRules("a percentage of 0 and a percentage of 100", [create(pct({ percentage: 0, threshold: 0, company: "vape" })), create(pct({ percentage: 100, threshold: 7000, company: "cstore", name: "All of it" }))]),
  withRules("a rule with a name full of punctuation", [create(fixed({ name: "Quotes \" ' and ünïcode — <b>html</b>", notes: "n" }))]),
  withRules("a new fee for the manager at both tills", [create(fixed({ staffId: "S_002", company: "vape", fixedAmount: 10 })), create(fixed({ staffId: "S_002", company: "cstore", fixedAmount: 11, name: "Second" }))]),
  withRules("the same rules in a week with no sales: a fee pays, a percentage rule does not", [create(fixed({ fixedAmount: 90, staffId: "S_004", company: "cstore" })), create(pct({ threshold: 0 }))], MON_NOV30),
  withRules("a rule changed before the run: a lifted threshold, a lowered one", [
    update({ ruleId: "CR_001", threshold: 7500 }),
    update({ ruleId: "CR_002", threshold: 0, percentage: 1 }),
    update({ ruleId: "CR_003", fixedAmount: 130.555 }),
  ]),
  withRules("a rule switched off and another ended before the run", [update({ ruleId: "CR_001", active: false }), update({ ruleId: "CR_002", effectiveTo: "2026-11-15" })]),
);

// ── Fresh sales in the same sequence ─────────────────────────
// S_004 opens the vape till on Saturday 21 November and closes it with takings of 1,400, which falls in the
// week of 16 to 22 November. (Cstore is not used: S_003's cstore session is open until its close.)
const VAPE4 = "VAP-20261121-S_004";
const sellVape = (cash: number, credit: number, debit: number): Step[] => [
  step("rpcOpenShift", { as: "S_004", args: [{ company: "vape", openingCount: 100 }] }),
  step("rpcCloseShift", { as: "S_004", args: [{ sessionId: VAPE4, cashSales: cash, creditCardSales: credit, debitCardSales: debit, physicalCount: 100 + cash }], advance: { hours: 8 } }),
];

(function freshSales(): void {
  const build = (title: string, cash: number, credit: number, debit: number): ParityCase => {
    const [open, close] = sellVape(cash, credit, debit);
    return new Plan(["admin", "S_004"]).add(open as Step, SAT21).add(close as Step).add(run(), MON_NOV23).add(proposed()).add(runs()).add(run("admin", true)).add(proposed()).seq(title, TILL_W);
  };
  commissionCases.push(
    build("rpcRunCommissionEngine: a till closed this week adds its sales to the week", 900, 300, 200),
    build("rpcRunCommissionEngine: a till closed with small takings changes nothing", 10, 5, 5),
  );
})();
