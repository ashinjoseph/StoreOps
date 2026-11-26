// Parity cases for the two reads the page makes first on every load (card P3-05c):
// rpcGetBootstrap and rpcGetMyShiftState.
//
// The fixture (frozen at Friday 20 November 2026, cases start at 10:30 that day; see shifts.ts):
// S_003 has the cstore till open since 08:02, nobody has vape open, history of three closed shifts a
// day to Thursday 19th, the lotto pot last counted at 500, S_002 is the cash manager. Cases that
// open and close tills do it on Saturday 21st (09:00 Toronto) and move the clock, so they list
// "sessions" among their writes (the caller's sign-in is renewed on both sides).
//
// What the old answers hold that is easy to get wrong, each covered below:
//   - open_by_me / open_by_other / closed per till, with detail only for the first two;
//   - todaySummary only when today's attendance row exists (a scheduled day has one, with no times);
//   - recentTill: my closed sessions of the last 7 days, newest first, at most 10;
//   - lotto: the pot's expected balance, last count, and the log (names, not ids);
//   - cashInHand: what I still carry, how many shifts, the oldest day, the cash manager's name;
//   - the settings that move it: the two opening floats, the two card-split flags, lotto_reserve_default
//     and cash_manager_staff_id.
import { parityCase, paritySequence, resultOf, step, type ParityCase, type Step } from "../case";

const ROLES = ["admin", "manager", "employee", "payroll_admin"] as const;
const PEOPLE = ["S_003", "S_004", "S_005", "S_006"] as const;
const RPCS = ["rpcGetBootstrap", "rpcGetMyShiftState"] as const;

const OPEN_W = ["till_sessions", "attendance", "audit_log", "sessions"];
const CLOSE_W = ["till_sessions", "attendance", "sales", "audit_log", "sessions"];
const HANDOVER_W = ["cash_handovers", "cash_handover_items", "audit_log"];

const EVE20 = "2026-11-21T03:00:00Z"; // Friday 20th, 22:00 Toronto
const D21 = "2026-11-21T14:00:00Z"; // Saturday 21st, 09:00 Toronto
const D22 = "2026-11-22T14:00:00Z"; // Sunday 22nd, 09:00 Toronto
const LATE = { hours: 8 };
const LATER = { minutes: 5 };

const shift = (as?: string, spec: Record<string, unknown> = {}): Step => step("rpcGetMyShiftState", { ...(as ? { as } : {}), ...spec });
const boot = (as?: string, spec: Record<string, unknown> = {}): Step => step("rpcGetBootstrap", { ...(as ? { as } : {}), ...spec });
/** Both reads, one after the other, as the page's first two loads. */
const both = (as?: string, spec: Record<string, unknown> = {}): Step[] => [boot(as, spec), shift(as)];

const open = (company: string, count: number, spec: Record<string, unknown> = {}): Step => step("rpcOpenShift", { args: [{ company, openingCount: count }], ...spec });
const close = (sessionId: string, fields: Record<string, unknown>, spec: Record<string, unknown> = { advance: LATE }): Step => step("rpcCloseShift", { args: [{ sessionId, ...fields }], ...spec });

/** S_003 closes the fixture's open cstore session on its own evening. */
const CLEAR_CSTORE = close("CST-20261120-S_003", { cashSales: 600, cardTotalSales: 900, miscCashSales: 0, physicalCount: 850, lottoCounted: 500 }, { as: "S_003", at: EVE20 });
const VAPE4 = "VAP-20261121-S_004";
const CST4 = "CST-20261121-S_004";
const VAPE5 = "VAP-20261121-S_005";
const CLOSE_VAPE4 = close(VAPE4, { cashSales: 150, creditCardSales: 60, debitCardSales: 40, physicalCount: 250 });

const seq = (title: string, who: string, writes: string[], steps: Step[], settings?: Record<string, string>): ParityCase =>
  paritySequence(title, { as: who, writes, ...(settings ? { settings } : {}) }, steps);

const schedule = (staffId: string, date: string, as = "manager"): Step => step("rpcScheduleShift", { as, args: [{ staffId, date, scheduledStart: "09:00", scheduledEnd: "17:00" }] });

export const bootstrapCases: ParityCase[] = [
  // ── Every role, every fixture person, nobody ────────────
  ...RPCS.flatMap((rpc) => ROLES.map((role) => parityCase(rpc, { as: role }))),
  ...RPCS.flatMap((rpc) => PEOPLE.map((id) => parityCase(rpc, { as: id, title: `${rpc} as ${id}` }))),
  ...RPCS.map((rpc) => parityCase(rpc, { as: null, title: `${rpc}: no token is refused` })),
  ...RPCS.map((rpc) => parityCase(rpc, { as: "S_004", args: [{ staffId: "S_003" }], title: `${rpc}: a staff id in the arguments is ignored` })),

  // ── Where each till stands ──────────────────────────────
  parityCase("rpcGetMyShiftState", { as: "S_004", title: "rpcGetMyShiftState: someone else has cstore open, I have nothing" }),
  seq("shift state: nothing open anywhere", "S_004", CLOSE_W, [CLEAR_CSTORE, ...both("S_004", { at: D21 })]),
  seq("shift state: my vape till open", "S_004", OPEN_W, [open("vape", 100, { at: D21 }), ...both()]),
  seq("shift state: my cstore till open", "S_004", CLOSE_W, [CLEAR_CSTORE, open("cstore", 250, { at: D21 }), ...both()]),
  seq("shift state: both tills open, mine", "S_004", CLOSE_W, [CLEAR_CSTORE, open("vape", 100, { at: D21 }), open("cstore", 250, { advance: LATER }), ...both()]),
  seq("shift state: someone else has vape open, and S_003 sees S_005's till", "S_005", OPEN_W, [
    open("vape", 100, { at: D21 }),
    step("rpcGetMyShiftState", { as: "S_003" }),
    step("rpcGetMyShiftState", { as: "S_004" }),
    ...both("S_005"),
  ]),
  seq("shift state: a float counted off the expected one is shown as counted", "S_004", OPEN_W, [open("vape", 92.5, { at: D21, args: [{ company: "vape", openingCount: 92.5, openingNote: "short last night" }] }), ...both()]),

  // ── Closed: today's summary and the recent list ─────────
  seq("shift state: just closed vape (today's summary, one recent session)", "S_004", CLOSE_W, [open("vape", 100, { at: D21 }), CLOSE_VAPE4, ...both()]),
  seq("shift state: closed with a variance (investigate)", "S_004", CLOSE_W, [
    open("vape", 100, { at: D21 }),
    close(VAPE4, { cashSales: 150, creditCardSales: 60, debitCardSales: 40, physicalCount: 200 }),
    ...both(),
  ]),
  seq("shift state: one of two tills closed, the day still in progress", "S_004", CLOSE_W, [
    CLEAR_CSTORE,
    open("vape", 100, { at: D21 }),
    open("cstore", 250, { advance: LATER }),
    CLOSE_VAPE4,
    ...both(),
  ]),
  seq("shift state: both closed, the day complete, two recent sessions", "S_004", CLOSE_W, [
    CLEAR_CSTORE,
    open("vape", 100, { at: D21 }),
    open("cstore", 250, { advance: LATER }),
    CLOSE_VAPE4,
    close(CST4, { cashSales: 300, cardTotalSales: 700, physicalCount: 550, lottoCounted: 450, lottoNote: "paid a ticket" }, { advance: { hours: 2 } }),
    ...both(),
  ]),
  seq("shift state: the day after a close (today has no attendance, the closed shift is recent)", "S_004", CLOSE_W, [
    open("vape", 100, { at: D21 }),
    CLOSE_VAPE4,
    ...both("S_004", { at: D22 }),
  ]),
  seq("shift state: seven days after a close the shift is still listed, eight days after it is not", "S_004", CLOSE_W, [
    open("vape", 100, { at: D21 }),
    CLOSE_VAPE4,
    ...[22, 23, 24, 25, 26, 27].map((d) => step("rpcGetMe", { at: `2026-11-${d}T14:00:00Z` })),
    shift("S_004", { at: "2026-11-28T14:00:00Z" }),
    shift("S_004", { at: "2026-11-29T14:00:00Z" }),
  ]),
  seq("shift state: someone closed cstore, I see the lotto log and who counted", "S_004", CLOSE_W, [CLEAR_CSTORE, shift("S_004", { at: D21 })]),
  seq("shift state: the pot counted short, with a top-up and a note", "S_004", CLOSE_W, [
    CLEAR_CSTORE,
    open("cstore", 250, { at: D21 }),
    close(CST4, { cashSales: 300, cardTotalSales: 700, physicalCount: 650, lottoCounted: 380, lottoTopupFromTill: 100, lottoNote: "winner paid" }),
    ...both(),
  ]),

  // ── A scheduled shift today, and a cancelled one ────────
  seq("shift state: a shift scheduled for today shows a summary with no times", "manager", ["attendance", "audit_log", "sessions"], [
    schedule("S_004", "2026-11-20"),
    ...both("S_004"),
  ]),
  seq("shift state: a shift scheduled for tomorrow is not today's summary", "manager", ["attendance", "audit_log", "sessions"], [
    schedule("S_004", "2026-11-21"),
    shift("S_004"),
    shift("S_004", { at: D21 }),
  ]),
  seq("shift state: a scheduled shift that was then cancelled", "manager", ["attendance", "audit_log", "sessions"], [
    schedule("S_004", "2026-11-20"),
    step("rpcCancelScheduledShift", { args: [resultOf(1, "$.attendanceId"), "Sick"], advance: LATER }),
    ...both("S_004"),
  ]),
  seq("shift state: a scheduled day, then I open vape on it (promoted to in progress)", "manager", OPEN_W, [
    schedule("S_004", "2026-11-21"),
    open("vape", 100, { as: "S_004", at: D21 }),
    ...both("S_004"),
  ]),
  seq("bootstrap: before and after a staff member's schedule changes", "manager", ["attendance", "audit_log"], [
    boot("S_004"),
    schedule("S_004", "2026-11-20"),
    boot("S_004"),
    step("rpcCancelScheduledShift", { args: [resultOf(2, "$.attendanceId"), "Changed"], advance: LATER }),
    boot("S_004"),
  ]),

  // ── Cash in hand: a handover recorded, then voided ──────
  seq("shift state: a handover recorded, then voided (cash in hand follows)", "S_001", HANDOVER_W, [
    shift("S_003"),
    step("rpcRecordCashHandover", { args: [{ fromStaffId: "S_003", amount: 300, notes: "partial" }], advance: LATER }),
    shift("S_003"),
    step("rpcRecordCashHandover", { args: [{ fromStaffId: "S_003", amount: 100.5 }], advance: LATER }),
    shift("S_003"),
    step("rpcVoidCashHandover", { args: [resultOf(2, "$.handoverId")], advance: LATER }),
    shift("S_003"),
    step("rpcVoidCashHandover", { args: [resultOf(4, "$.handoverId")], advance: LATER }),
    shift("S_003"),
  ]),
  seq("shift state: everything handed over, nothing in hand", "S_001", HANDOVER_W, [
    step("rpcGetCashOutstandingFor", { args: ["S_004"] }),
    step("rpcRecordCashHandover", { args: [{ fromStaffId: "S_004", amount: resultOf(1, "$.totalOutstanding") }], advance: LATER }),
    shift("S_004"),
    boot("S_004"),
  ]),
  seq("shift state: a closed vape shift adds to what I carry", "S_004", CLOSE_W, [open("vape", 100, { at: D21 }), CLOSE_VAPE4, shift()]),

  // ── Bootstrap around payments, bonuses, schedules ───────
  seq("bootstrap: before and after a payment", "admin", ["payments", "payment_items", "audit_log"], [
    boot("S_003"),
    step("rpcPayShifts", { args: [{ staffId: "S_003", amount: 300, method: "cash" }], advance: LATER }),
    boot("S_003"),
    shift("S_003"),
  ]),
  seq("bootstrap: after a bonus is created and approved", "admin", ["bonuses", "audit_log"], [
    boot("S_003"),
    step("rpcCreateBonus", { args: [{ staffId: "S_003", type: "bonus", amount: 25.5, reason: "Parity", date: "2026-11-19" }], advance: LATER }),
    step("rpcApproveBonus", { args: ["B_20261120_093000_z6p"], advance: LATER }),
    boot("S_003"),
  ]),

  // ── Settings that change what comes back ────────────────
  ...RPCS.flatMap((rpc) => [
    parityCase(rpc, { as: "S_004", settings: { cstore_default_opening_float: "300", vape_default_opening_float: "75.5" }, title: `${rpc}: other float settings` }),
    parityCase(rpc, { as: "S_004", settings: { cstore_default_opening_float: "0", vape_default_opening_float: "0" }, title: `${rpc}: float settings of 0` }),
    parityCase(rpc, { as: "S_004", settings: { cstore_default_opening_float: "", vape_default_opening_float: "" }, title: `${rpc}: blank float settings use the defaults` }),
    parityCase(rpc, { as: "S_004", settings: { cstore_default_opening_float: "lots", vape_default_opening_float: "-20" }, title: `${rpc}: unreadable and negative floats` }),
    parityCase(rpc, { as: "S_004", settings: { cstore_card_split: "true", vape_card_split: "false" }, title: `${rpc}: the card split flags the other way round` }),
    parityCase(rpc, { as: "S_004", settings: { cstore_card_split: " FALSE ", vape_card_split: "" }, title: `${rpc}: card split flags padded, upper-case and blank` }),
    parityCase(rpc, { as: "S_004", settings: { lotto_reserve_default: "750" }, title: `${rpc}: another lotto reserve default` }),
    parityCase(rpc, { as: "S_004", settings: { lotto_reserve_default: "" }, title: `${rpc}: a blank lotto reserve default` }),
    parityCase(rpc, { as: "S_003", settings: { cash_manager_staff_id: "S_001" }, title: `${rpc}: another cash manager` }),
    parityCase(rpc, { as: "S_003", settings: { cash_manager_staff_id: "" }, title: `${rpc}: no cash manager` }),
    parityCase(rpc, { as: "S_003", settings: { cash_manager_staff_id: "S_999" }, title: `${rpc}: a cash manager who is not on the staff list` }),
    parityCase(rpc, { as: "S_003", settings: { cash_manager_staff_id: " S_002 " }, title: `${rpc}: a cash manager id with spaces around it` }),
  ]),
  seq("shift state: a float setting changes what a closed shift's till is expected to hold", "S_004", OPEN_W, [open("vape", 75, { at: D21 }), ...both()], { vape_default_opening_float: "75" }),
];
