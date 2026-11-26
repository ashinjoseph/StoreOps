// Parity cases for Clover and Reconcile (card P3-07): rpcReconcileDay and rpcGetReconciliation.
//
// The fixture (frozen at Friday 20 November 2026, cases start at 10:30 that day):
//   - S_001 admin, S_002 manager, S_003..S_005 employees, S_006 payroll admin, S_007 inactive.
//   - history: three closed shifts a day and two validation_results rows a day (vape checked against
//     Clover, cstore "not verified") up to Thursday 19 November.
//   - today: CST-20261120-S_003 is OPEN (since 08:02). Nothing else has been opened today.
//   - Clover is OFF (clover_enabled is not set: its default is false). WhatsApp is ON: two recipients,
//     templates for shift_close_cstore (11 parameters) and shift_close_vape (12); none for the shared
//     shift_close (so a group of both tills falls back to plain text). Every reconcile that finds a
//     group therefore sends two requests per group, and each case scripts them.
//
// Every case stays on Friday the 20th (the callers were signed in at 10:30, so their sign-in lasts
// until 10:30 on the 21st; nothing here moves the clock past that). The day's timeline:
//   10:30  S_004 opens vape (VOPEN)         20:00  S_004 closes vape (VCLOSE)
//   22:00  S_003 closes cstore (CCLOSE)     22:05  someone reconciles (RECON_AT)
//
// Clover ON. The new app reads the Clover tokens only from Worker bindings (CLOVER_CSTORE_TOKEN,
// CLOVER_VAPE_TOKEN). The harness mirrors ONE secret into the new side's bindings, the WhatsApp
// token (SECRETS_RULE in ../http.ts); it does not mirror the Clover tokens. So:
//   - the Clover matrix runs as DIRECT steps (Reconcile.reconcileDay on both sides, then
//     rpcGetReconciliation over the rows it wrote): the new side is called with the same Clover
//     tokens bound that the old side holds in its config tab (`mirrorClover`, below: by hand, what
//     the harness does for the WhatsApp token). The direct answer goes through `pageView` on the new
//     side as it does on the old (a Date becomes null on both; the RPC itself sends ISO strings).
//   - three RPC cases ("… through the RPC") are the same scenarios as the page calls them. The
//     harness mirrors the Clover tokens to the new side's bindings (SECRETS_RULE in ../http.ts), so
//     both sides ask Clover; `mirrorClover` in the direct steps is now the same thing done twice.
//
// Not here, by design (deliberate differences, unit-tested in ops/test/clover.test.ts): a
// clover_base_url whose host is not Clover's (the new app treats Clover as not set up and sends
// nothing; the old app sent the token there); a Clover request that does not answer in 10 seconds.
import { directStep, parityCase, paritySequence, step, type CaseOptions, type DirectCall, type ParityCase, type Step } from "../case";
import type { HttpReply } from "../http";
import { pageView } from "../old-world";
import { reconcileDay } from "../../src/modules/reconcile";

// ── The day ────────────────────────────────────────────────

const WRITES = ["till_sessions", "attendance", "sales", "audit_log", "sessions", "validation_results"];
const VCLOSE_AT = "2026-11-21T01:00:00Z"; // Friday 20th, 20:00 Toronto
const CCLOSE_AT = "2026-11-21T03:00:00Z"; // Friday 20th, 22:00 Toronto
const RECON_AT = "2026-11-21T03:05:00Z"; // Friday 20th, 22:05 Toronto

const CST3 = "CST-20261120-S_003";
const VAP4 = "VAP-20261120-S_004";

const VOPEN: Step = step("rpcOpenShift", { as: "S_004", args: [{ company: "vape", openingCount: 100 }] });
const vclose = (fields: Record<string, unknown>): Step => step("rpcCloseShift", { as: "S_004", at: VCLOSE_AT, args: [{ sessionId: VAP4, ...fields }] });
const cclose = (fields: Record<string, unknown>): Step => step("rpcCloseShift", { as: "S_003", at: CCLOSE_AT, args: [{ sessionId: CST3, ...fields }] });

/** Vape: float 100, cash 150, so 250 expected; credit 60 + debit 40. */
const VSPLIT = { cashSales: 150, creditCardSales: 60, debitCardSales: 40, physicalCount: 250 };
/** Cstore: cash 600, one card total of 900, the pot still at 500 (expected 850). */
const CTOTAL = { cashSales: 600, cardTotalSales: 900, miscCashSales: 0, physicalCount: 850, lottoCounted: 500 };

const recon = (force: unknown, spec: { as?: string | null; http?: HttpReply[]; at?: string; advance?: { minutes: number } } = {}): Step =>
  step("rpcReconcileDay", { at: RECON_AT, ...spec, args: force === undefined ? [] : [force] });
const history = (limit: unknown = 5, as = "manager"): Step => step("rpcGetReconciliation", { as, args: [limit] });

// ── What Meta says ─────────────────────────────────────────

const SENT: HttpReply = { status: 200, body: { messaging_product: "whatsapp", messages: [{ id: "wamid.TEST" }] } };
const NOT_REGISTERED: HttpReply = { status: 400, body: { error: { message: "(#133010) Account not registered", code: 133010, type: "OAuthException" } } };
const WRONG_COUNT: HttpReply = {
  status: 400,
  body: { error: { message: "(#132000) Number of parameters does not match the expected number of params", code: 132000, error_data: { messaging_product: "whatsapp", details: "body: number of localizable_params (11) does not match the expected number of params (13)" } } },
};
const NETWORK: HttpReply = { throws: "Address unavailable: https://graph.facebook.com/v21.0/100000000000001/messages" };
const TWO = [SENT, SENT];
const FOUR = [SENT, SENT, SENT, SENT];

// ── Clover off (the fixture's own settings) ────────────────

const ROLES = ["admin", "manager", "payroll_admin", "S_006", "employee"] as const;

const readCases: ParityCase[] = [
  ...ROLES.map((who) => parityCase("rpcGetReconciliation", { as: who, title: `rpcGetReconciliation as ${who}` })),
  parityCase("rpcGetReconciliation", { as: null, title: "rpcGetReconciliation: no token is refused" }),
  ...([
    ["no limit (60)", []],
    ["limit 1", [1]],
    ["limit 0 (60)", [0]],
    ["limit -1 (every row but the oldest)", [-1]],
    ["limit -239 (one row left)", [-239]],
    ["limit '5' (a string)", ["5"]],
    ["limit 'abc' (60)", ["abc"]],
    ["limit 2.5 (2)", [2.5]],
    ["limit 0.5 (none)", [0.5]],
    ["limit 1000 (every row)", [1000]],
    ["limit null (60)", [null]],
  ] as const).map(([what, args]) => parityCase("rpcGetReconciliation", { as: "manager", args: [...args], title: `rpcGetReconciliation: ${what}` })),
];

const seq = (title: string, steps: Step[], opts: CaseOptions = {}): ParityCase => paritySequence(`rpcReconcileDay: ${title}`, { writes: WRITES, ...opts }, steps);

const offCases: ParityCase[] = [
  // Who may reconcile: anyone signed in (the old body checks no role). With cstore still open, auto waits.
  ...(["admin", "manager", "employee", "payroll_admin"] as const).map((who) => seq(`auto with cstore still open, as ${who} (not ready)`, [recon(false, { as: who })])),
  parityCase("rpcReconcileDay", { as: null, args: [false], title: "rpcReconcileDay: no token is refused" }),
  seq("no argument is auto", [recon(undefined, { as: "S_003" })]),
  seq("force 'true' (a string) is auto", [recon("true", { as: "S_003" })]),
  seq("force 1 is auto", [recon(1, { as: "S_003" })]),
  seq("force with nothing closed today (empty)", [recon(true, { as: "manager" })]),

  // The cstore till closes; the day is reconciled; the history shows it.
  seq("cstore closes, auto reconciles it (single card total, not verified)", [cclose(CTOTAL), recon(false, { as: "S_003", http: TWO }), history()]),
  seq("as an employee who did not work the till", [cclose(CTOTAL), recon(false, { as: "S_005", http: TWO }), history()]),
  seq("both tills closed: two groups, two messages", [VOPEN, vclose(VSPLIT), cclose(CTOTAL), recon(false, { as: "S_004", http: FOUR }), history(4)]),
  seq("vape closed, cstore still open: auto waits", [VOPEN, vclose(VSPLIT), recon(false, { as: "S_004" }), history(2)]),
  seq("vape closed, cstore still open: force reconciles vape alone", [VOPEN, vclose(VSPLIT), recon(true, { as: "manager", http: TWO }), history(2)]),
  seq("run twice: the second auto run finds nothing new", [cclose(CTOTAL), recon(false, { as: "S_003", http: TWO }), recon(false, { as: "S_003", advance: { minutes: 1 } }), history(3)]),
  seq("auto, then force: the manual run re-checks the whole day", [cclose(CTOTAL), recon(false, { as: "S_003", http: TWO }), recon(true, { as: "manager", advance: { minutes: 1 }, http: TWO }), history(3)]),
  seq("auto per shift: vape first (cstore open), then cstore", [
    VOPEN,
    vclose(VSPLIT),
    recon(true, { as: "manager", http: TWO, at: "2026-11-21T01:05:00Z" }),
    cclose(CTOTAL),
    recon(false, { as: "S_003", http: TWO }),
    history(4),
  ]),

  // Card shapes (ADR-0005): split, single total, with the misc three.
  seq("vape split with misc credit and debit", [VOPEN, vclose({ cashSales: 150, creditCardSales: 60, debitCardSales: 40, miscCashSales: 10, miscCreditSales: 5, miscDebitSales: 2.5, physicalCount: 260 }), recon(true, { as: "manager", http: TWO }), history(1)]),
  seq("vape with a single card total (no split)", [VOPEN, vclose({ cashSales: 150, cardTotalSales: 100, physicalCount: 250 }), recon(true, { as: "manager", http: TWO }), history(1)]),
  seq("vape with a single total and a misc card figure", [VOPEN, vclose({ cashSales: 150, cardTotalSales: 100, miscCardSales: 7.25, physicalCount: 250 }), recon(true, { as: "manager", http: TWO }), history(1)]),
  seq("cstore with a misc card figure", [cclose({ ...CTOTAL, miscCashSales: 15, miscCardSales: 30.3, physicalCount: 865 }), recon(false, { as: "S_003", http: TWO }), history(1)]),
  seq("vape with no card figures at all", [VOPEN, vclose({ cashSales: 150, physicalCount: 250 }), recon(true, { as: "manager", http: TWO }), history(1)]),

  // Cash variance bands (expected 250): the roll-up uses variance_ok_threshold only.
  seq("vape cash OK", [VOPEN, vclose(VSPLIT), recon(true, { as: "manager", http: TWO }), history(1)]),
  seq("vape cash over $1 exactly (OK)", [VOPEN, vclose({ ...VSPLIT, physicalCount: 251 }), recon(true, { as: "manager", http: TWO }), history(1)]),
  seq("vape cash over $12.40 (minor at the close, investigate here)", [VOPEN, vclose({ ...VSPLIT, physicalCount: 262.4 }), recon(true, { as: "manager", http: TWO }), history(1)]),
  seq("vape cash short $40 (investigate)", [VOPEN, vclose({ ...VSPLIT, physicalCount: 210 }), recon(true, { as: "manager", http: TWO }), history(1)]),
  seq("cstore cash short $40 (investigate)", [cclose({ ...CTOTAL, physicalCount: 810 }), recon(false, { as: "S_003", http: TWO }), history(1)]),

  // Lotto and the drawer.
  seq("cstore lotto shortfall with a note", [cclose({ ...CTOTAL, lottoCounted: 450, lottoNote: "paid a winning ticket" }), recon(false, { as: "S_003", http: TWO }), history(1)]),
  seq("cstore top-up from the till into the pot", [cclose({ cashSales: -100, cardTotalSales: 500, physicalCount: 350, lottoCounted: 400, lottoTopupFromTill: 100, lottoNote: "paid $200, topped up $100" }), recon(false, { as: "S_003", http: TWO }), history(1)]),
  seq("cstore negative cash day: the drawer below its float", [cclose({ cashSales: -300, cardTotalSales: 100, physicalCount: 0, lottoCounted: 450, lottoNote: "paid out" }), recon(false, { as: "S_003", http: TWO }), history(1)]),

  // WhatsApp outcomes (ADR-0007: reported, never swallowed).
  seq("Meta refuses both recipients (#133010)", [cclose(CTOTAL), recon(false, { as: "S_003", http: [NOT_REGISTERED, NOT_REGISTERED] }), history(1)]),
  seq("Meta says the parameter count is wrong", [cclose(CTOTAL), recon(false, { as: "S_003", http: [WRONG_COUNT, WRONG_COUNT] }), history(1)]),
  seq("a network failure on the first recipient", [cclose(CTOTAL), recon(false, { as: "S_003", http: [NETWORK, SENT] }), history(1)]),
  seq("one group sent, the other refused", [VOPEN, vclose(VSPLIT), cclose(CTOTAL), recon(false, { as: "S_004", http: [SENT, SENT, NOT_REGISTERED, NOT_REGISTERED] }), history(2)]),
  seq("no recipients configured (nothing sent)", [cclose(CTOTAL), recon(false, { as: "S_003" }), history(1)], { settings: { whatsapp_target_number: "" } }),
  seq("the notifier switched off (nothing sent)", [cclose(CTOTAL), recon(false, { as: "S_003" }), history(1)], { settings: { notifier_enabled: "false" } }),
  seq("the WhatsApp token blank (nothing sent)", [cclose(CTOTAL), recon(false, { as: "S_003" }), history(1)], { settings: { whatsapp_api_token: "" } }),
  seq("the cstore template key blank: plain text", [cclose(CTOTAL), recon(false, { as: "S_003", http: TWO }), history(1)], { settings: { whatsapp_template_shift_close_cstore: "" } }),
  seq("the cstore template key blank, the shared one set: 13 parameters", [cclose(CTOTAL), recon(false, { as: "S_003", http: TWO }), history(1)], {
    settings: { whatsapp_template_shift_close_cstore: "", whatsapp_template_shift_close: "shift_close_v2" },
  }),
  seq("the vape template key blank, the shared one set: 13 parameters with the lotto slot", [VOPEN, vclose(VSPLIT), recon(true, { as: "manager", http: TWO }), history(1)], {
    settings: { whatsapp_template_shift_close_vape: "", whatsapp_template_shift_close: "shift_close_v2" },
  }),
  seq("a generic template carries the whole text", [cclose(CTOTAL), recon(false, { as: "S_003", http: TWO }), history(1)], { settings: { whatsapp_template_shift_close_cstore: "", whatsapp_template_name: "generic_message" } }),
  seq("no report link configured", [cclose(CTOTAL), recon(false, { as: "S_003", http: TWO }), history(1)], { settings: { public_report_url: "", whatsapp_template_shift_close_cstore: "" } }),
  seq("a report link with a query string", [cclose(CTOTAL), recon(false, { as: "S_003", http: TWO }), history(1)], {
    settings: { public_report_url: "  https://script.google.com/macros/s/EXAMPLE/exec?x=1  ", whatsapp_template_shift_close_cstore: "" },
  }),
  seq("a card threshold of 0 and a cash threshold of 5", [VOPEN, vclose({ ...VSPLIT, physicalCount: 254 }), recon(true, { as: "manager", http: TWO }), history(1)], {
    settings: { card_variance_threshold: "0", variance_ok_threshold: "5" },
  }),
];

// ── Clover on ──────────────────────────────────────────────

const VAPE_MERCHANT = "MVAPE0001";
const CLOVER_VAPE = { clover_enabled: "true", clover_base_url: "https://api.clover.com", clover_vape_merchant_id: VAPE_MERCHANT, clover_vape_token: "test-clover-vape-1" };

/** The Clover tokens a case's settings put in the old config tab, as the Worker bindings the new side reads them from. */
function mirrorClover(settings: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["clover_cstore_token", "clover_vape_token"] as const) {
    const v = settings[key];
    if (v) env[key.toUpperCase()] = v;
  }
  return env;
}

const reconcileDirect = (settings: Readonly<Record<string, string>>): DirectCall => ({
  old: "Reconcile.reconcileDay",
  new: async (deps, actorId, mode) =>
    pageView(await reconcileDay(deps.db, { config: deps.config, env: { ...deps.env, ...mirrorClover(settings) }, fetch: deps.fetch, now: deps.now }, actorId as string, mode as string)),
});

const card = (amount: number, kind: "credit" | "debit", extra: Record<string, unknown> = {}) => ({
  id: `PAY${amount}${kind}`,
  amount,
  result: "SUCCESS",
  cardTransaction: { type: kind === "debit" ? "DEBIT" : "CREDIT" },
  tender: kind === "debit" ? { labelKey: "com.clover.tender.debit_card", label: "Debit Card" } : { labelKey: "com.clover.tender.credit_card", label: "Credit Card" },
  ...extra,
});
const clover = (elements: unknown[]): HttpReply => ({ status: 200, body: { elements, href: "https://api.clover.com/v3/merchants/x/payments" } });
/** What the vape till reported (VSPLIT): credit 60, debit 40. */
const MATCH = clover([card(6000, "credit"), card(4000, "debit")]);

/** S_004's vape day, reconciled by the manager with `force` (cstore is still open), with Clover answering `reply`. */
const cloverCase = (title: string, reply: HttpReply[], opts: { settings?: Record<string, string>; vape?: Record<string, unknown>; both?: boolean; sends?: HttpReply[] } = {}): ParityCase => {
  const settings = opts.settings ?? CLOVER_VAPE;
  const days: Step[] = [VOPEN, vclose(opts.vape ?? VSPLIT), ...(opts.both ? [cclose(CTOTAL)] : [])];
  return paritySequence(`Clover on: ${title}`, { writes: WRITES, settings }, [
    ...days,
    directStep("Reconcile.reconcileDay", reconcileDirect(settings), { at: RECON_AT, args: ["S_002", "manual"], http: [...reply, ...(opts.sends ?? (opts.both ? FOUR : TWO))] }),
    history(3),
  ]);
};

const pageOf = (n: number, amountCents: number) => Array.from({ length: n }, (_, i) => card(amountCents, i % 2 ? "debit" : "credit", { id: `P${i}` }));

const cloverCases: ParityCase[] = [
  cloverCase("the totals match the sales rows", [MATCH]),
  cloverCase("credit is off", [clover([card(5500, "credit"), card(4000, "debit")])]),
  cloverCase("debit is off", [clover([card(6000, "credit"), card(3750, "debit")])]),
  cloverCase("the total is off (an extra payment)", [clover([card(6000, "credit"), card(4000, "debit"), card(1234, "credit")])]),
  cloverCase("within the card threshold ($1)", [clover([card(6050, "credit"), card(4000, "debit")])]),
  cloverCase("an empty result", [clover([])]),
  cloverCase("an answer with no elements at all", [{ status: 200, body: {} }]),
  cloverCase("voided, failed and cash payments are skipped", [
    clover([card(6000, "credit"), card(4000, "debit"), card(999, "credit", { result: "VOIDED" }), card(500, "debit", { result: "FAIL" }), { id: "CASH1", amount: 2000, result: "SUCCESS", tender: { label: "Cash" } }]),
  ]),
  cloverCase("a payment with no result counts; one with no amount counts as $0", [clover([card(6000, "credit", { result: undefined }), card(4000, "debit"), card(0, "credit", { amount: undefined })])]),
  cloverCase("an unknown card type counts as credit", [clover([card(6000, "credit", { tender: { label: "Gift" }, cardTransaction: { type: "AUTH" } }), card(4000, "debit", { tender: null, cardTransaction: { entryType: "debit swipe" } })])]),
  cloverCase("two pages (1000, then 1)", [clover(pageOf(1000, 10)), clover([card(1, "credit")])]),
  cloverCase("HTTP 401", [{ status: 401, body: { message: "401 Unauthorized" } }]),
  cloverCase("HTTP 500", [{ status: 500, body: "Internal Server Error" }]),
  cloverCase("a malformed body", [{ status: 200, body: "<html>not json</html>" }]),
  cloverCase("a network failure", [{ throws: "Address unavailable: https://api.clover.com/v3/merchants" }]),
  cloverCase("a merchant id that needs encoding", [MATCH], { settings: { ...CLOVER_VAPE, clover_vape_merchant_id: "M V/01?&x=1" } }),
  cloverCase("the sandbox host, with a trailing slash", [MATCH], { settings: { ...CLOVER_VAPE, clover_base_url: "https://apisandbox.dev.clover.com/" } }),
  cloverCase("a cash shortfall with the cards matching", [MATCH], { vape: { ...VSPLIT, physicalCount: 210 } }),
  cloverCase("a vape till with a single card total, checked against Clover", [MATCH], { vape: { cashSales: 150, cardTotalSales: 100, physicalCount: 250 } }),
  cloverCase("misc card figures count towards the comparison", [clover([card(6500, "credit"), card(4250, "debit")])], { vape: { ...VSPLIT, miscCreditSales: 5, miscDebitSales: 2.5 } }),
  cloverCase("both tills closed: cstore has no merchant (not configured), vape is checked", [MATCH], { both: true }),
  cloverCase("both tills on one merchant: one group, one request, plain text", [clover([card(6000, "credit"), card(4000, "debit"), card(90000, "credit")])], {
    both: true,
    sends: TWO,
    settings: { ...CLOVER_VAPE, clover_cstore_merchant_id: VAPE_MERCHANT, clover_cstore_token: "test-clover-cstore-1" },
  }),
  cloverCase("a merchant id with no token is not configured (no request)", [], { settings: { ...CLOVER_VAPE, clover_vape_token: "" } }),
  cloverCase("Clover enabled with nothing configured (no request)", [], { settings: { clover_enabled: "true" } }),
  cloverCase("Clover switched off with everything configured (no request)", [], { settings: { ...CLOVER_VAPE, clover_enabled: "false" } }),
  cloverCase("Clover down and WhatsApp refused", [{ status: 503, body: "busy" }], { sends: [NOT_REGISTERED, NOT_REGISTERED] }),
];

/** The same as the page calls it. FAILS until the harness mirrors the Clover tokens (see the header). */
const cloverRpc = (title: string, reply: HttpReply[], both = false): ParityCase =>
  paritySequence(`Clover on: ${title} — through the RPC`, { writes: WRITES, settings: CLOVER_VAPE }, [
    VOPEN,
    vclose(VSPLIT),
    ...(both ? [cclose(CTOTAL)] : []),
    recon(true, { as: "manager", http: [...reply, ...(both ? FOUR : TWO)] }),
    history(3),
  ]);

const cloverRpcCases: ParityCase[] = [
  cloverRpc("the totals match the sales rows", [MATCH]),
  cloverRpc("HTTP 401", [{ status: 401, body: { message: "401 Unauthorized" } }]),
  cloverRpc("one merchant configured, the other not", [MATCH], true),
];

export const reconcileCases: ParityCase[] = [...readCases, ...offCases, ...cloverCases, ...cloverRpcCases];
