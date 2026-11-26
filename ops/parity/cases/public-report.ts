// Parity cases for PublicReport (card P3-12): the payloads of the two public pages, ?v=recon
// (PublicReport.build) and ?v=sales (PublicReport.buildSales).
//
// The pages have no RPC (ADR-0003: their data is inlined), and the harness calls RPCs and module
// functions, not routes. So the payloads are compared here, directly (old: `api.PublicReport.build(days)`;
// new: `build(db, days, { config, now })`), and the route itself (how `days` is read from the query
// string and clamped, the inlining, the headers, the fallback page) is unit-tested in
// ops/test/public-pages.test.ts. A direct step has no session: the pages have none either.
//
// The fixture (frozen at Friday 20 November 2026, cases start at 10:30 that day): three closed shifts
// a day up to Thursday the 19th, two reconciliations a day (vape checked against Clover, cstore not
// verified: its cardMeasured is null, never 0), weekly drops to the cash manager (S_002), the latest
// shifts still out with their cashiers, the lotto pot counted at every cstore close.
//
// `days` at the module is NOT clamped (the page clamps it: 1-31 for recon, 1-365 for sales); these
// cases call the module with the values the card names, including ones the page never passes on
// (0, a negative, a string, a large number). A negative recon window has no first day: the old
// code throws there (`window[0].key`), so both sides must throw the same message.
import { directCase, directStep, paritySequence, resultOf, step, type DirectCall, type ParityCase, type Step } from "../case";
import type { HttpReply } from "../http";
import { build, buildSales } from "../../src/modules/public-report";

const BUILD: DirectCall = {
  old: "PublicReport.build",
  new: (deps, days) => build(deps.db, days, { config: deps.config, now: deps.now }),
};
const BUILD_SALES: DirectCall = {
  old: "PublicReport.buildSales",
  new: (deps, days) => buildSales(deps.db, days, { config: deps.config, now: deps.now }),
};

/** The values of `days` the card names. A large number is 10000 days (27 years): the module has no bound. */
const DAYS: ReadonlyArray<readonly [string, readonly unknown[]]> = [
  ["the default (no argument)", []],
  ["1", [1]],
  ["7", [7]],
  ["14", [14]],
  ["30", [30]],
  ["0 (the default)", [0]],
  ["-3 (a negative)", [-3]],
  ["'14' (a string)", ["14"]],
  ["'abc' (the default)", ["abc"]],
  ["null (the default)", [null]],
  ["10000 (a large number)", [10000]],
];
const SALES_DAYS: ReadonlyArray<readonly [string, readonly unknown[]]> = [...DAYS, ["60", [60]], ["365", [365]]];

const recon = (what: string, args: readonly unknown[], spec: Record<string, unknown> = {}): ParityCase =>
  directCase("PublicReport.build", BUILD, { title: `PublicReport.build: ${what}`, args, ...spec });
const sales = (what: string, args: readonly unknown[], spec: Record<string, unknown> = {}): ParityCase =>
  directCase("PublicReport.buildSales", BUILD_SALES, { title: `PublicReport.buildSales: ${what}`, args, ...spec });

// ── The day, as the reconcile cases run it ────────────────

const WRITES = ["till_sessions", "attendance", "sales", "audit_log", "sessions", "validation_results", "cash_handovers", "cash_handover_items"];
const VCLOSE_AT = "2026-11-21T01:00:00Z"; // Friday 20th, 20:00 Toronto
const CCLOSE_AT = "2026-11-21T03:00:00Z"; // Friday 20th, 22:00 Toronto
const RECON_AT = "2026-11-21T03:05:00Z"; // Friday 20th, 22:05 Toronto
const CST3 = "CST-20261120-S_003";
const VAP4 = "VAP-20261120-S_004";

const SENT: HttpReply = { status: 200, body: { messaging_product: "whatsapp", messages: [{ id: "wamid.TEST" }] } };
const TWO = [SENT, SENT];
const FOUR = [...TWO, ...TWO];

const VOPEN: Step = step("rpcOpenShift", { as: "S_004", args: [{ company: "vape", openingCount: 100 }] });
const VCLOSE: Step = step("rpcCloseShift", {
  as: "S_004",
  at: VCLOSE_AT,
  args: [{ sessionId: VAP4, cashSales: 150, creditCardSales: 60, debitCardSales: 40, physicalCount: 250 }],
});
const cclose = (lottoNote: string, lottoCounted = 450): Step =>
  step("rpcCloseShift", {
    as: "S_003",
    at: CCLOSE_AT,
    args: [{ sessionId: CST3, cashSales: 600, cardTotalSales: 900, miscCashSales: 0, physicalCount: 850, lottoCounted, lottoNote }],
  });
const later = { advance: { minutes: 1 } };
/** The day reconciled (auto); two WhatsApp messages per till group closed. */
const reconcile = (as: string, http: HttpReply[]): Step => step("rpcReconcileDay", { as, at: RECON_AT, args: [false], http });
const payload = (days: unknown): Step => directStep("PublicReport.build", BUILD, { args: [days] });
const salesPayload = (days: unknown): Step => directStep("PublicReport.buildSales", BUILD_SALES, { args: [days] });

const sequences: ParityCase[] = [
  paritySequence("PublicReport: both tills closed, a handover recorded and one voided, the day reconciled", { writes: WRITES }, [
    VOPEN,
    VCLOSE,
    cclose("paid a winning ticket"),
    step("rpcRecordCashHandover", { as: "S_003", args: [{ amount: 100, notes: "evening drop" }], ...later }), // 4
    step("rpcRecordCashHandover", { as: "S_004", args: [{ amount: 50, notes: "part of it" }], ...later }), // 5
    step("rpcVoidCashHandover", { as: "S_002", args: [resultOf(5, "$.handoverId")], ...later }),
    reconcile("S_003", FOUR),
    payload(7),
    payload(1),
    payload(31),
    salesPayload(60),
    salesPayload(1),
  ]),
  paritySequence("PublicReport: the payloads before and after a close, a handover and a reconcile", { writes: WRITES }, [
    payload(7),
    salesPayload(60),
    cclose("short: paid out $50", 450),
    payload(7),
    step("rpcRecordCashHandover", { as: "S_003", args: [{ amount: 200, notes: "to the safe" }], ...later }),
    payload(7),
    reconcile("S_002", TWO), // only cstore closed: one group
    payload(7),
    salesPayload(7),
  ]),
  // The note a cashier types reaches the payload as typed: the inlining (not the payload) is what keeps it inside the script.
  paritySequence("PublicReport: a hostile lotto note and handover note arrive as typed", { writes: WRITES }, [
    cclose("</script><script>alert(1)</script><!-- ]]>     end"),
    step("rpcRecordCashHandover", { as: "S_003", args: [{ amount: 25, notes: "</script><!--" }], ...later }),
    payload(7),
  ]),
];

// ── The clock ─────────────────────────────────────────────
// Direct steps only (no session to keep alive): the window moves with "today" in Toronto.

const clockCases: ParityCase[] = [
  recon("Saturday 21st, 09:00 (the window moves a day)", [7], { at: "2026-11-21T14:00:00Z" }),
  recon("Friday 20th, 23:59 Toronto (still the 20th)", [7], { at: "2026-11-21T04:59:00Z" }),
  recon("Friday 20th, 00:30 Toronto (05:30 UTC)", [7], { at: "2026-11-20T05:30:00Z" }),
  recon("a week later: the shifts still out are stale", [7], { at: "2026-11-27T15:00:00Z" }),
  sales("a week later", [60], { at: "2026-11-27T15:00:00Z" }),
  recon("across the November clock change (Sunday 1st)", [30], { at: "2026-11-02T15:00:00Z" }),
];

// ── Settings that change the payload ──────────────────────

const settingCases: ParityCase[] = [
  recon("no cash manager set", [7], { settings: { cash_manager_staff_id: "" } }),
  recon("a cash manager that matches nobody", [7], { settings: { cash_manager_staff_id: "S_999" } }),
  recon("the cash manager is S_003", [7], { settings: { cash_manager_staff_id: "S_003" } }),
  recon("stale after 2 days", [7], { settings: { cash_handover_stale_days: "2" } }),
  recon("stale after 0 days (the default 7)", [7], { settings: { cash_handover_stale_days: "0" } }),
  recon("a lotto reserve of 650 (every count is short)", [7], { settings: { lotto_reserve_default: "650" } }),
  recon("a lotto reserve of 300 (every count is over)", [7], { settings: { lotto_reserve_default: "300" } }),
  recon("a blank lotto reserve (the default 500)", [7], { settings: { lotto_reserve_default: "" } }),
  recon("a lotto reserve that is not a number (0)", [7], { settings: { lotto_reserve_default: "lots" } }),
];

export const publicReportCases: ParityCase[] = [
  ...DAYS.map(([what, args]) => recon(`days ${what}`, args)),
  ...SALES_DAYS.map(([what, args]) => sales(`days ${what}`, args)),
  ...clockCases,
  ...settingCases,
  ...sequences,
];
