// Parity cases for the open and the close (card P3-05b): rpcOpenShift, rpcCloseShift and
// rpcNotifyShiftOpen.
//
// The fixture (frozen at Friday 20 November 2026, cases start at 10:30 that day):
//   - every active person (S_001 admin, S_002 manager, S_003..S_005 employees, S_006 payroll
//     admin) is authorised for both tills; S_007 is inactive. Nobody is authorised for one till
//     only, so "not authorised" is covered by ops/test/till-sessions.test.ts.
//   - history: three closed shifts a day up to Thursday 19 November; the lotto pot was last
//     counted at $500 (cstore's evening shift of the 19th).
//   - today: CST-20261120-S_003 is OPEN (since 08:02, lotto cells blank) and A_20261120_S_003 is in
//     progress. So cstore cannot be opened by anyone until S_003 closes it: every cstore case
//     starts with CLEAR_CSTORE, S_003 closing it at 22:00 that evening.
//   - the card split settings (cstore_card_split "false", vape_card_split "true") are NOT read by
//     the close: the shape of the sales row follows what the page sent (Sales.write_). They are
//     left as the fixture has them.
//   - thresholds: variance_ok_threshold 1, variance_minor_threshold 30 (the defaults); floats
//     250 (cstore) and 100 (vape); lotto_reserve_default 500.
// Cases run on Saturday 21 November (D21, 09:00 Toronto), after the fixture's history.
//
// Not here, by ruling (orchestrator, P3-05b): a figure the old code would store and the new schema
// cannot hold (an unreadable opening count or physical count stores NaN in the Sheet). The new app
// refuses those with a plain message; ops/test/till-sessions.test.ts covers them.
//
// Known, expected until the router change lands: the old rpcOpenShift and rpcCloseShift prefix
// every error with "rpcOpenShift: " / "rpcCloseShift: "; the new handlers do not (the router will).
import { parityCase, paritySequence, step, type ParityCase, type Step } from "../case";
import type { HttpReply } from "../http";

// "sessions": a case that moves the clock to another day renews (rolls) the caller's sign-in on both sides.
const OPEN_W = ["till_sessions", "attendance", "audit_log", "sessions"];
const CLOSE_W = ["till_sessions", "attendance", "sales", "audit_log", "sessions"];

const EVE20 = "2026-11-21T03:00:00Z"; // Friday 20th, 22:00 Toronto
const D21 = "2026-11-21T14:00:00Z"; // Saturday 21st, 09:00 Toronto
const LATE = { hours: 8 };

type Spec = { as?: string; at?: string; advance?: { hours?: number; minutes?: number } };

const open = (company: unknown, openingCount: unknown, extra: Record<string, unknown> = {}, spec: Spec = {}): Step =>
  step("rpcOpenShift", { args: [{ company, openingCount, ...extra }], ...spec });
const close = (sessionId: string, fields: Record<string, unknown>, spec: Spec = { advance: LATE }): Step =>
  step("rpcCloseShift", { args: [{ sessionId, ...fields }], ...spec });

/** S_003 closes the fixture's open cstore session on its own evening: cash 600, card total 900, the pot still at 500. */
const CLEAR_CSTORE = close("CST-20261120-S_003", { cashSales: 600, cardTotalSales: 900, miscCashSales: 0, physicalCount: 850, lottoCounted: 500 }, { as: "S_003", at: EVE20 });

const VAPE4 = "VAP-20261121-S_004";
const CST4 = "CST-20261121-S_004";
const CST5 = "CST-20261121-S_005";

/** S_004 opens vape at the default float and closes it with cash 150 (expected 250) and `count`. */
const vapeAt = (title: string, count: number): ParityCase =>
  paritySequence(`rpcCloseShift: vape variance — ${title}`, { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 150, creditCardSales: 60, debitCardSales: 40, physicalCount: count }),
  ]);

const SENT: HttpReply = { status: 200, body: { messaging_product: "whatsapp", messages: [{ id: "wamid.TEST" }] } };
const NOT_REGISTERED: HttpReply = { status: 400, body: { error: { message: "(#133010) Account not registered", code: 133010, type: "OAuthException" } } };

export const shiftCases: ParityCase[] = [
  // ── The two shapes ──────────────────────────────────────
  paritySequence("open cstore, close cstore with a single card total", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, {}, { at: D21 }),
    close(CST4, { cashSales: 512.4, cardTotalSales: 1033.65, cashbackPaid: 0, miscCashSales: 0, miscCardSales: 0, miscNotes: "", physicalCount: 762.4, lottoCounted: 500, lottoTopupFromTill: 0, lottoNote: "", closingNote: "quiet day" }),
  ]),
  paritySequence("open vape, close vape with credit + debit", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 143.25, creditCardSales: 210.1, debitCardSales: 99.9, cashbackPaid: 0, miscCashSales: 0, miscCreditSales: 0, miscDebitSales: 0, miscNotes: "", physicalCount: 243.25 }),
  ]),
  paritySequence("closing the fixture's open cstore session the next morning (a close for an earlier date)", { as: "S_003", writes: CLOSE_W }, [
    close("CST-20261120-S_003", { cashSales: 600, cardTotalSales: 900, physicalCount: 850, lottoCounted: 500 }, { at: D21 }),
  ]),

  // ── The open ────────────────────────────────────────────
  paritySequence("rpcOpenShift: the default float, as a string", { as: "S_004", writes: OPEN_W }, [open("vape", "100", {}, { at: D21 })]),
  paritySequence("rpcOpenShift: a counted float that differs, with a note", { as: "S_004", writes: OPEN_W }, [open("vape", 92.5, { openingNote: "short $7.50 from last night" }, { at: D21 })]),
  paritySequence("rpcOpenShift: a counted float that differs, with no note, is refused", { as: "S_004", writes: OPEN_W }, [open("vape", 92.5, {}, { at: D21 })]),
  paritySequence("rpcOpenShift: a float one cent off still needs a note (100.01 − 100 is just over 0.01 in floating point)", { as: "S_004", writes: OPEN_W }, [open("vape", 100.01, {}, { at: D21 })]),
  paritySequence("rpcOpenShift: a float two cents off needs a note", { as: "S_004", writes: OPEN_W }, [open("vape", 100.02, {}, { at: D21 })]),
  paritySequence("rpcOpenShift: a note on a matching float is kept", { as: "S_004", writes: OPEN_W }, [open("vape", 100, { openingNote: "all good" }, { at: D21 })]),
  paritySequence("rpcOpenShift: cstore after the fixture's session is closed (attendance created, lotto cells 0)", { as: "S_005", writes: CLOSE_W }, [CLEAR_CSTORE, open("cstore", 250, {}, { at: D21 })]),
  paritySequence("rpcOpenShift: cstore is refused while S_003 has it open", { as: "S_004", writes: OPEN_W }, [open("cstore", 250)]),
  paritySequence("rpcOpenShift: vape on the fixture's day, by someone who is already in (attendance unchanged)", { as: "S_003", writes: OPEN_W }, [open("vape", 100)]),
  paritySequence("rpcOpenShift: on a scheduled day the attendance is promoted", { as: "manager", writes: OPEN_W }, [
    step("rpcScheduleShift", { args: [{ staffId: "S_004", date: "2026-11-21", scheduledStart: "09:00", scheduledEnd: "17:00" }] }),
    open("vape", 100, {}, { as: "S_004", at: D21 }),
  ]),
  paritySequence("rpcOpenShift: both tills at once; the first close leaves the day in progress, the second completes it", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("vape", 100, {}, { at: D21 }),
    open("cstore", 250, {}, { advance: { minutes: 5 } }),
    close(VAPE4, { cashSales: 100, creditCardSales: 50, debitCardSales: 25, physicalCount: 200 }, { advance: { hours: 6 } }),
    close(CST4, { cashSales: 300, cardTotalSales: 700, physicalCount: 550, lottoCounted: 500 }, { advance: { hours: 2 } }),
  ]),
  paritySequence("rpcOpenShift: opening twice the same day on the same till", { as: "S_004", writes: OPEN_W }, [
    open("vape", 100, {}, { at: D21 }),
    open("vape", 100, {}, { advance: { minutes: 1 } }),
  ]),
  paritySequence("rpcOpenShift: reopening a till closed earlier the same day", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 0, creditCardSales: 0, debitCardSales: 0, physicalCount: 100 }, { advance: { hours: 1 } }),
    open("vape", 100, {}, { advance: { minutes: 1 } }),
  ]),
  paritySequence("rpcOpenShift: the other till after the day is complete is refused (attendance worked)", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 0, creditCardSales: 0, debitCardSales: 0, physicalCount: 100 }, { advance: { hours: 1 } }),
    open("cstore", 250, {}, { advance: { minutes: 1 } }),
  ]),
  paritySequence("rpcOpenShift: a second person on vape while it is open", { writes: OPEN_W }, [open("vape", 100, {}, { as: "S_004", at: D21 }), open("vape", 100, {}, { as: "S_005" })]),
  parityCase("rpcOpenShift", { as: "S_004", args: [{ company: "grocery", openingCount: 100 }], title: "rpcOpenShift: an unknown company" }),
  parityCase("rpcOpenShift", { as: "S_004", args: [{ openingCount: 100 }], title: "rpcOpenShift: no company" }),
  parityCase("rpcOpenShift", { as: "S_004", args: [{ company: "vape", openingCount: -1 }], title: "rpcOpenShift: a negative count" }),
  parityCase("rpcOpenShift", { as: "S_004", args: [], title: "rpcOpenShift: no input object" }),
  parityCase("rpcOpenShift", { as: "S_004", args: [null], title: "rpcOpenShift: a null input object" }),
  parityCase("rpcOpenShift", { as: null, args: [{ company: "vape", openingCount: 100 }], title: "rpcOpenShift: no token" }),
  paritySequence("rpcOpenShift: an admin opens for someone else", { as: "admin", writes: OPEN_W }, [open("vape", 100, { staffId: "S_004" }, { at: D21 })]),
  paritySequence("rpcOpenShift: an admin naming an unknown person", { as: "admin", writes: OPEN_W }, [open("vape", 100, { staffId: "S_999" }, { at: D21 })]),
  paritySequence("rpcOpenShift: a manager may not open for someone else", { as: "manager", writes: OPEN_W }, [open("vape", 100, { staffId: "S_004" }, { at: D21 })]),
  paritySequence("rpcOpenShift: an employee may not open for someone else", { as: "S_005", writes: OPEN_W }, [open("vape", 100, { staffId: "S_004" }, { at: D21 })]),
  paritySequence("rpcOpenShift: naming yourself is the same as naming nobody", { as: "S_004", writes: OPEN_W }, [open("vape", 100, { staffId: "S_004" }, { at: D21 })]),
  paritySequence("rpcOpenShift: a payroll admin opens their own till", { as: "payroll_admin", writes: OPEN_W }, [open("vape", 100, {}, { at: D21 })]),

  // ── Variance and its bands (expected 250 on every one) ──
  vapeAt("balances to the cent", 250),
  vapeAt("over by $12.40", 262.4),
  vapeAt("over by exactly $1 (OK)", 251),
  vapeAt("over by $1.01 (minor)", 251.01),
  vapeAt("short by exactly $1 (OK)", 249),
  vapeAt("short by $0.99 (OK)", 249.01),
  vapeAt("short by $1.01 (minor)", 248.99),
  vapeAt("short by $12 (minor)", 238),
  vapeAt("short by $29.99 (minor)", 220.01),
  vapeAt("short by exactly $30 (minor)", 220),
  vapeAt("short by $30.01 (investigate)", 219.99),
  vapeAt("over by exactly $30 (minor)", 280),
  vapeAt("over by $30.01 (investigate)", 280.01),
  vapeAt("an empty drawer (investigate)", 0),

  // ── Lotto (cstore) ──────────────────────────────────────
  paritySequence("cstore: a payout larger than cash sales, funded by the pot", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, {}, { at: D21 }),
    close(CST4, { cashSales: -300, cardTotalSales: 640, physicalCount: 250, lottoCounted: 200, lottoNote: "Paid $500 winning ticket" }),
  ]),
  paritySequence("cstore: a top-up from the till, and the next shift starts from it", { writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, {}, { as: "S_004", at: D21 }),
    close(CST4, { cashSales: -100, cardTotalSales: 500, physicalCount: 350, lottoCounted: 400, lottoTopupFromTill: 100, lottoNote: "paid $200, topped up $100" }, { as: "S_004", advance: { minutes: 30 } }),
    open("cstore", 250, {}, { as: "S_005", advance: { minutes: 10 } }),
    close(CST5, { cashSales: 420, cardTotalSales: 800, physicalCount: 670, lottoCounted: 400, lottoNote: "still 400" }, { as: "S_005", advance: { hours: 5 } }),
  ]),
  paritySequence("cstore: no lotto figures at all means the pot is at its expected balance", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, {}, { at: D21 }),
    close(CST4, { cashSales: 300, cardTotalSales: 700, physicalCount: 550 }),
  ]),
  paritySequence("cstore: a pot below its balance with no reason is refused, and nothing is written", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, {}, { at: D21 }),
    close(CST4, { cashSales: 300, cardTotalSales: 700, physicalCount: 550, lottoCounted: 450 }),
  ]),
  paritySequence("cstore: an emptied lotto field counts as 0 (and needs a reason)", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, {}, { at: D21 }),
    close(CST4, { cashSales: 300, cardTotalSales: 700, physicalCount: 1050, lottoCounted: "", lottoNote: "pot taken to the bank" }),
  ]),
  paritySequence("cstore: a negative top-up is read as none", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, {}, { at: D21 }),
    close(CST4, { cashSales: 300, cardTotalSales: 700, physicalCount: 550, lottoCounted: 500, lottoTopupFromTill: -40 }),
  ]),
  paritySequence("cstore: an expected cash below zero is refused", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, {}, { at: D21 }),
    close(CST4, { cashSales: -900, cardTotalSales: 100, physicalCount: 0, lottoCounted: 500 }),
  ]),
  paritySequence("cstore: the drawer below the float leaves a negative cash removed", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, {}, { at: D21 }),
    close(CST4, { cashSales: -300, cardTotalSales: 100, physicalCount: 0, lottoCounted: 450, lottoNote: "paid out" }),
  ]),
  paritySequence("vape: lotto fields are ignored", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 150, creditCardSales: 60, debitCardSales: 40, physicalCount: 250, lottoCounted: 120, lottoTopupFromTill: 30, lottoNote: "not a thing here" }),
  ]),
  paritySequence("vape: negative cash sales are refused, and nothing is written", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: -50, creditCardSales: 60, debitCardSales: 40, physicalCount: 50 }),
  ]),

  // ── Blank and zero ──────────────────────────────────────
  paritySequence("vape: every optional figure left out (the row is a split with zeros)", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { physicalCount: 100 }),
  ]),
  paritySequence("vape: every optional figure sent as 0", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 0, creditCardSales: 0, debitCardSales: 0, cashbackPaid: 0, miscCashSales: 0, miscCreditSales: 0, miscDebitSales: 0, miscNotes: "", physicalCount: 100, closingNote: "" }),
  ]),
  paritySequence("vape: every optional figure sent as an empty string", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: "", creditCardSales: "", debitCardSales: "", cashbackPaid: "", miscCashSales: "", miscCreditSales: "", miscDebitSales: "", physicalCount: 100 }),
  ]),
  paritySequence("vape: a card total of 0 makes the row a single-total row", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 0, cardTotalSales: 0, physicalCount: 100 }),
  ]),
  paritySequence("vape: only a misc card figure makes the row a single-total row", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 10, miscCardSales: 5, physicalCount: 110 }),
  ]),
  paritySequence("vape: both shapes at once are refused", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 10, creditCardSales: 5, cardTotalSales: 5, physicalCount: 110 }),
  ]),
  paritySequence("vape: a misc credit with a misc card total is refused", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 10, miscCreditSales: 5, miscCardSales: 5, physicalCount: 110 }),
  ]),

  // ── Misc, cashback, HST, bottle deposit, round-off ──────
  paritySequence("vape: misc sales in the split shape, cashback and notes", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 180.55, creditCardSales: 120, debitCardSales: 80.4, cashbackPaid: 40, miscCashSales: 22.5, miscCreditSales: 12.25, miscDebitSales: 7.75, miscNotes: "two coil packs, hand-written", physicalCount: 263.05, closingNote: "card machine slow" }),
  ]),
  paritySequence("cstore: misc sales in the single-total shape", { as: "S_004", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, {}, { at: D21 }),
    close(CST4, { cashSales: 400, cardTotalSales: 900, miscCashSales: 15, miscCardSales: 30.3, miscNotes: "phone cards", physicalCount: 665, lottoCounted: 500 }),
  ]),
  paritySequence("vape: HST, bottle deposit and round-off are not forwarded by the RPC (stored 0)", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 150, creditCardSales: 60, debitCardSales: 40, hstCollected: 32.5, bottleDeposit: 1.2, roundOff: -0.02, physicalCount: 250 }),
  ]),
  paritySequence("vape: figures with three decimals are rounded to the cent where the old code rounds", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 150.005, creditCardSales: 60.004, debitCardSales: 40.015, cashbackPaid: 1.005, miscCashSales: 0.125, physicalCount: 249.25 }),
  ]),
  paritySequence("vape: a non-numeric cash figure is read as 0", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: "abc", creditCardSales: "12x", debitCardSales: 40, physicalCount: 100 }),
  ]),
  paritySequence("vape: the physical count as a string", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 150, creditCardSales: 60, debitCardSales: 40, physicalCount: "250.5" }),
  ]),

  // ── Bad input to the close ──────────────────────────────
  parityCase("rpcCloseShift", { as: "S_004", args: [{ sessionId: "VAP-20261121-S_004", physicalCount: 100 }], title: "rpcCloseShift: no such session" }),
  parityCase("rpcCloseShift", { as: "S_004", args: [{ physicalCount: 100 }], title: "rpcCloseShift: no session id" }),
  parityCase("rpcCloseShift", { as: "S_004", args: [], title: "rpcCloseShift: no input object" }),
  parityCase("rpcCloseShift", { as: "S_004", args: [null], title: "rpcCloseShift: a null input object" }),
  parityCase("rpcCloseShift", { as: null, args: [{ sessionId: "CST-20261120-S_003", physicalCount: 100 }], title: "rpcCloseShift: no token" }),
  paritySequence("rpcCloseShift: closing twice", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 150, creditCardSales: 60, debitCardSales: 40, physicalCount: 250 }),
    close(VAPE4, { cashSales: 150, creditCardSales: 60, debitCardSales: 40, physicalCount: 250 }, { advance: { minutes: 1 } }),
  ]),
  paritySequence("rpcCloseShift: a negative count is refused", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 150, physicalCount: -5 }),
  ]),

  // ── Who may close ───────────────────────────────────────
  paritySequence("rpcCloseShift: an employee may not close someone else's till", { writes: CLOSE_W }, [
    open("vape", 100, {}, { as: "S_004", at: D21 }),
    close(VAPE4, { cashSales: 150, creditCardSales: 60, debitCardSales: 40, physicalCount: 250 }, { as: "S_005", advance: { minutes: 45 } }),
  ]),
  parityCase("rpcCloseShift", { as: "payroll_admin", args: [{ sessionId: "CST-20261120-S_003", cashSales: 1, cardTotalSales: 1, physicalCount: 251 }], title: "rpcCloseShift: a payroll admin may not close someone else's till" }),
  paritySequence("rpcCloseShift: a manager closes someone else's till (the day completes, the actor is the manager)", { writes: CLOSE_W }, [
    open("vape", 100, {}, { as: "S_004", at: D21 }),
    close(VAPE4, { cashSales: 150, creditCardSales: 60, debitCardSales: 40, physicalCount: 250 }, { as: "manager", advance: { minutes: 45 } }),
  ]),
  paritySequence("rpcCloseShift: an admin closes the fixture's open cstore session", { as: "admin", writes: CLOSE_W }, [
    close("CST-20261120-S_003", { cashSales: 600, cardTotalSales: 900, physicalCount: 845.5, lottoCounted: 500, closingNote: "closed by the owner" }, { at: EVE20 }),
  ]),
  paritySequence("rpcCloseShift: an actorId in the input is ignored", { as: "S_004", writes: CLOSE_W }, [
    open("vape", 100, {}, { at: D21 }),
    close(VAPE4, { cashSales: 150, creditCardSales: 60, debitCardSales: 40, physicalCount: 250, actorId: "S_001", staffId: "S_001" }),
  ]),

  // ── rpcNotifyShiftOpen ──────────────────────────────────
  paritySequence("rpcNotifyShiftOpen: after an open, Meta accepts both recipients", { as: "S_004", writes: OPEN_W }, [
    open("vape", 100, {}, { at: D21 }),
    step("rpcNotifyShiftOpen", { args: ["vape"], http: [SENT, SENT] }),
  ]),
  paritySequence("rpcNotifyShiftOpen: after an open, Meta refuses both (#133010): audited and returned", { as: "S_004", writes: OPEN_W }, [
    open("vape", 100, {}, { at: D21 }),
    step("rpcNotifyShiftOpen", { args: ["vape"], http: [NOT_REGISTERED, NOT_REGISTERED] }),
  ]),
  paritySequence("rpcNotifyShiftOpen: one recipient refused, one accepted: sent, nothing audited", { as: "S_004", writes: OPEN_W }, [
    open("vape", 100, {}, { at: D21 }),
    step("rpcNotifyShiftOpen", { args: ["vape"], http: [NOT_REGISTERED, SENT] }),
  ]),
  paritySequence("rpcNotifyShiftOpen: a cstore open", { as: "S_005", writes: CLOSE_W }, [
    CLEAR_CSTORE,
    open("cstore", 250, {}, { at: D21 }),
    step("rpcNotifyShiftOpen", { args: ["cstore"], http: [SENT, SENT] }),
  ]),
  paritySequence("rpcNotifyShiftOpen: the notifier switched off (not audited)", { as: "S_004", writes: OPEN_W, settings: { notifier_enabled: "false" } }, [
    open("vape", 100, {}, { at: D21 }),
    step("rpcNotifyShiftOpen", { args: ["vape"] }),
  ]),
  paritySequence("rpcNotifyShiftOpen: no token (audited as not configured)", { as: "S_004", writes: OPEN_W, settings: { whatsapp_api_token: "" } }, [
    open("vape", 100, {}, { at: D21 }),
    step("rpcNotifyShiftOpen", { args: ["vape"] }),
  ]),
  paritySequence("rpcNotifyShiftOpen: no template for shift_open falls back to plain text", { as: "S_004", writes: OPEN_W, settings: { whatsapp_template_shift_open: "" } }, [
    open("vape", 100, {}, { at: D21 }),
    step("rpcNotifyShiftOpen", { args: ["vape"], http: [SENT, SENT] }),
  ]),
  parityCase("rpcNotifyShiftOpen", { as: "S_004", args: ["vape"], http: [SENT, SENT], writes: ["audit_log"], title: "rpcNotifyShiftOpen: with no open session (the old code does not check)" }),
  parityCase("rpcNotifyShiftOpen", { as: "S_004", args: [], http: [SENT, SENT], writes: ["audit_log"], title: "rpcNotifyShiftOpen: no company" }),
  parityCase("rpcNotifyShiftOpen", { as: "S_004", args: ["grocery"], http: [NOT_REGISTERED, NOT_REGISTERED], writes: ["audit_log"], title: "rpcNotifyShiftOpen: an unknown company, refused by Meta" }),
  parityCase("rpcNotifyShiftOpen", { as: null, args: ["vape"], title: "rpcNotifyShiftOpen: no token" }),
];
