// Parity cases for the Notifier (card P3-08): the one RPC it moves (rpcCheckWhatsApp), and
// sendOp and notify, which have no RPC of their own yet and are compared directly.
//
// How a case talks to "Meta": `http: [...]` scripts the replies to the outbound requests, in
// order, for BOTH sides (http.ts). A reply is { status, body } or { throws: "message" }. The
// harness compares what each side sent (URL, method, body, headers) as well as what it answered,
// and fails a request the case did not script. Nothing reaches a real host.
//
// How a case sets a setting: `settings: { notifier_enabled: "false" }` sets that row on both
// sides, in the old `config` tab and the new `config` table, from the one declaration. The
// token is a secret: `whatsapp_api_token` goes in the old tab and is mirrored into the new
// side's WHATSAPP_API_TOKEN binding (SECRETS_RULE). Every number is fictional (555-01xx).
//
// The fixture's own settings (scripts/docs/fixtures.js): the notifier is on, the URL is
// .../v21.0/100000000000001/messages, there are two recipients, and shift_open,
// shift_close_cstore and shift_close_vape have templates. shift_close has none (it is the
// fallback), so a case that sends it sets one.
//
// ONE KNOWN DIFFERENCE (card P3-08: "drop shopping_list from the list diagnose checks"): the old
// setup check's "templates" detail lists shopping_list among the templates that are not set. The new
// module does not know the shopping list, so every rpcCheckWhatsApp case differs from the old one
// at $.checks[4].detail and nowhere else: see TEMPLATES_SENTENCE below.
import { directCase, parityCase, type DirectCall, type ParityCase } from "../case";
import type { HttpReply } from "../http";
import { notify, sendOp, type NotifyPayload, type OpKey } from "../../src/modules/notifier";

const ROLES = ["admin", "manager", "employee", "payroll_admin"] as const;

// ── What Meta says ─────────────────────────────────────────

const SENT: HttpReply = { status: 200, body: { messaging_product: "whatsapp", messages: [{ id: "wamid.TEST" }] } };
const NOT_REGISTERED: HttpReply = { status: 400, body: { error: { message: "(#133010) Account not registered", code: 133010, type: "OAuthException" } } };
const WRONG_COUNT: HttpReply = {
  status: 400,
  body: {
    error: {
      message: "(#132000) Number of parameters does not match the expected number of params",
      code: 132000,
      error_data: { messaging_product: "whatsapp", details: "body: number of localizable_params (11) does not match the expected number of params (13)" },
    },
  },
};
const EXPIRED: HttpReply = { status: 401, body: { error: { message: "Error validating access token: Session has expired on Sunday, 19-Oct-26.", code: 190 } } };
const GATEWAY: HttpReply = { status: 502, body: "<html>502 Bad Gateway</html>" };
const NETWORK: HttpReply = { throws: "Address unavailable: https://graph.facebook.com/v21.0/100000000000001/messages" };
const TIMEOUT: HttpReply = { throws: "timeout" };
const HEALTHY: HttpReply = { status: 200, body: { verified_name: "Fictional Mart", display_phone_number: "+1 416-555-0199", quality_rating: "GREEN", id: "100000000000001" } };

// ── rpcCheckWhatsApp ───────────────────────────────────────

/** An admin runs the check against the fixture's own settings, with Meta answering `reply`. */
/**
 * The one agreed difference in this area (orchestrator, review of P3-08). The old setup check's
 * "templates" sentence lists the shopping_list template among those not set; the shopping list is
 * not being moved, so the new sentence does not mention it. Every other check, and every other
 * field of this one, is still compared; ops/test/notifier.test.ts pins the new sentence's wording.
 */
const TEMPLATES_SENTENCE = [{ path: "$.checks[4].detail", reason: "the old sentence names the shopping_list template, which is not being moved (decision: Not migrated, Nov 21)" }];

const check = (title: string, reply: HttpReply[], settings?: Record<string, string>): ParityCase =>
  parityCase("rpcCheckWhatsApp", { as: "admin", title: `rpcCheckWhatsApp: ${title}`, http: reply, exempt: TEMPLATES_SENTENCE, ...(settings ? { settings } : {}) });

const checkCases: ParityCase[] = [
  // Who may ask (the contract: admin, manager, payroll_admin), with Meta healthy; the refusal text is compared.
  ...ROLES.map((role) => parityCase("rpcCheckWhatsApp", { as: role, title: `rpcCheckWhatsApp as ${role}: Meta healthy`, exempt: TEMPLATES_SENTENCE, ...(role === "employee" ? {} : { http: [HEALTHY] }) })),
  parityCase("rpcCheckWhatsApp", { as: null, title: "rpcCheckWhatsApp: no token is refused" }),

  // The states a person meets.
  check("notifier switched off (Meta is still asked)", [HEALTHY], { notifier_enabled: "false" }),
  check("enabled, no token (Meta is not asked)", [], { whatsapp_api_token: "" }),
  check("enabled, token set, Meta healthy", [HEALTHY], { whatsapp_api_token: "test-token-check-1" }),
  check("Meta answers #133010 Account not registered", [NOT_REGISTERED]),
  check("Meta answers 401 (token expired)", [EXPIRED]),
  check("a network failure", [NETWORK]),
  check("a timeout", [TIMEOUT]),

  // Other shapes of answer and setup.
  check("Meta answers 200 with a body that is not JSON", [{ status: 200, body: "OK" }]),
  check("Meta answers 200 with nothing to show", [{ status: 200, body: {} }]),
  check("Meta answers 404 (wrong phone number id)", [{ status: 404, body: { error: { message: "Unsupported get request. Object with ID '100000000000001' does not exist", code: 100 } } }]),
  check("Meta answers 403 mentioning the token", [{ status: 403, body: { error: { message: "(#200) Token lacks permission whatsapp_business_messaging" } } }]),
  check("Meta answers 502 with an HTML page", [GATEWAY]),
  check("Meta answers 500 with nothing", [{ status: 500 }]),
  check("a very long error is cut at 400 characters", [{ status: 400, body: { error: { message: "x".repeat(900) } } }]),
  check("the URL is blank (no request)", [], { whatsapp_api_url: "" }),
  check("the URL is not a /messages URL (no request)", [], { whatsapp_api_url: "https://graph.facebook.com/v21.0/" }),
  check("the URL has another host (no request)", [], { whatsapp_api_url: "https://example.test/v21.0/100000000000001/messages" }),
  check("no recipients (Meta is still asked)", [HEALTHY], { whatsapp_target_number: "" }),
  check("one recipient", [HEALTHY], { whatsapp_target_number: "14165550100" }),
  check("no templates set", [HEALTHY], { whatsapp_template_shift_open: "", whatsapp_template_shift_close_cstore: "", whatsapp_template_shift_close_vape: "" }),
  check("every template set", [HEALTHY], { whatsapp_template_shift_close: "shift_close_v2" }),
  check("nothing set up at all", [], { notifier_enabled: "false", whatsapp_api_url: "", whatsapp_api_token: "", whatsapp_target_number: "", whatsapp_template_shift_open: "", whatsapp_template_shift_close_cstore: "", whatsapp_template_shift_close_vape: "" }),
];

// ── sendOp ─────────────────────────────────────────────────

const sendOpCall: DirectCall = {
  old: "Notifier.sendOp",
  new: (deps, opKey, params, plain) => sendOp(deps, opKey as OpKey, params as unknown[], plain as string),
};
const params = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i + 1}`);
const PLAIN = "🟢 Fictional opened the Cstore till\n🕐 Thu 26 Nov, 10:00";
/** Two recipients in the fixture: one reply each. */
const BOTH = [SENT, SENT];

/** Each op key with its template's parameter count: the right number, one too few, one too many. */
const OPS: readonly { op: OpKey; count: number; settings?: Record<string, string> }[] = [
  { op: "shift_open", count: 3 },
  { op: "shift_close", count: 13, settings: { whatsapp_template_shift_close: "shift_close_v2" } },
  { op: "shift_close_cstore", count: 11 },
  { op: "shift_close_vape", count: 12 },
];

const counts = OPS.flatMap(({ op, count, settings }) =>
  ([["the right number", count], ["one too few", count - 1], ["one too many", count + 1]] as const).map(([what, n]) =>
    directCase(`Notifier.sendOp`, sendOpCall, {
      title: `Notifier.sendOp ${op}: ${n} parameters (${what}; the template takes ${count})`,
      args: [op, params(n), PLAIN],
      http: BOTH,
      ...(settings ? { settings } : {}),
    }),
  ),
);

const send = (title: string, args: unknown[], http: HttpReply[], settings?: Record<string, string>): ParityCase =>
  directCase("Notifier.sendOp", sendOpCall, { title: `Notifier.sendOp: ${title}`, args, http, ...(settings ? { settings } : {}) });

const OPEN = ["shift_open", ["Maya Okafor", "Cstore", "Thu 26 Nov, 10:00"], PLAIN];

const sendCases: ParityCase[] = [
  ...counts,
  send("a success to both recipients", OPEN, BOTH),
  send("three recipients, split on commas, semicolons and spaces", OPEN, [SENT, SENT, SENT], { whatsapp_target_number: "14165550100;14165550101 , 14165550102" }),
  send("Meta rejects the first recipient, accepts the second", OPEN, [NOT_REGISTERED, SENT]),
  send("Meta rejects both (#133010)", OPEN, [NOT_REGISTERED, NOT_REGISTERED]),
  send("Meta says the parameter counts differ", ["shift_close_cstore", params(11), PLAIN], [WRONG_COUNT, WRONG_COUNT]),
  send("Meta answers 401", OPEN, [EXPIRED, EXPIRED]),
  send("Meta answers 502 with a page, not JSON", OPEN, [GATEWAY, SENT]),
  send("a network failure on the first recipient", OPEN, [NETWORK, SENT]),
  send("a timeout on both", OPEN, [TIMEOUT, TIMEOUT]),
  send("a long error is cut at 400 characters", OPEN, [{ status: 400, body: "y".repeat(900) }, SENT]),
  send("the token is blank (nothing is sent)", OPEN, [], { whatsapp_api_token: "" }),
  send("the notifier is switched off (nothing is sent)", OPEN, [], { notifier_enabled: "false" }),
  send("the URL is blank (nothing is sent)", OPEN, [], { whatsapp_api_url: "" }),
  send("there are no recipients (nothing is sent)", OPEN, [], { whatsapp_target_number: "" }),
  send("the token is set to another value", OPEN, BOTH, { whatsapp_api_token: "test-token-send-2" }),

  // Where the template comes from, and the fallbacks.
  send("shift_close has no template: plain text", ["shift_close", params(13), PLAIN], BOTH),
  send("shift_close has no template but a generic one is set: the whole text in {{1}}", ["shift_close", params(13), PLAIN], BOTH, { whatsapp_template_name: "generic_message", whatsapp_template_lang: "fr" }),
  send("an unknown op key falls back to plain text", ["shift_close_nosuch", params(2), PLAIN], BOTH),
  send("the language setting is used", OPEN, BOTH, { whatsapp_template_lang: "en_GB" }),

  // What a parameter may hold.
  send("hostile text (quotes, angle brackets, a newline, a tab, an emoji, markdown) arrives unchanged in the JSON body", ["shift_open", [`He said "hi" <script>alert(1)</script> \\ 'x' & {{1}}`, "line one\nline two\ttabbed 😀", "*bold* _italic_ ~x~ `y`"], PLAIN], BOTH),
  send("a parameter with runs of spaces", ["shift_open", ["a      b", "  padded  ", "c"], PLAIN], BOTH),
  send("empty, zero and false parameters become a dash (as before)", ["shift_open", ["", 0, false], PLAIN], BOTH),
  send("hostile text in the plain-text fallback is sent as typed, newlines included", ["shift_close", [], `He said "hi" <b>x</b>\nsecond line 😀 *not stripped*`], BOTH),
  send("hostile text in the generic template is flattened", ["shift_close", [], `He said "hi" <b>x</b>\nsecond line 😀 *stripped*`], BOTH, { whatsapp_template_name: "generic_message" }),
  send("no parameters at all sends a template with no components", ["shift_open", [], PLAIN], BOTH),
];

// ── notify ─────────────────────────────────────────────────

const notifyCall: DirectCall = { old: "Notifier.notify", new: (deps, event, payload) => notify(deps, event as string, payload as NotifyPayload) };
const note = (title: string, event: string, payload: NotifyPayload | undefined, settings?: Record<string, string>): ParityCase =>
  directCase("Notifier.notify", notifyCall, { title: `Notifier.notify: ${title}`, args: payload === undefined ? [event] : [event, payload], writes: ["audit_log"], ...(settings ? { settings } : {}) });

const notifyCases: ParityCase[] = [
  note("shift.opened with a float (notifier on: logged, nothing sent)", "shift.opened", { staffName: "Maya Okafor", company: "cstore", openingFloat: 250, actorId: "S_003", targetType: "session", targetId: "TS_001" }),
  note("shift.opened with no float, named by id", "shift.opened", { staffId: "S_003", company: "vape" }),
  note("shift.opened, notifier off", "shift.opened", { staffName: "Maya Okafor", company: "cstore", openingFloat: 0 }, { notifier_enabled: "false" }),
  note("shift.closed, no variance", "shift.closed", { staffName: "Maya Okafor", company: "cstore", variance: 0 }),
  note("shift.closed, over", "shift.closed", { staffName: "Maya Okafor", company: "cstore", variance: 2.5 }),
  note("shift.closed, short", "shift.closed", { staffName: "Sam Reyes", company: "vape", variance: -3.456 }),
  note("shift.closed with a lotto reserve, a top-up and cash in hand", "shift.closed", { staffName: "Maya Okafor", company: "cstore", variance: 0, lottoReserveCounted: 500, lottoTopupFromTill: 300, cashInHand: 302.5 }),
  note("shift.closed with a reserve and a top-up too small to mention", "shift.closed", { staffName: "Maya Okafor", company: "cstore", variance: 0, lottoReserveCounted: 500, lottoTopupFromTill: 0.01, cashInHand: 0.01 }),
  note("shift.closed, a vape close (reserve null)", "shift.closed", { staffName: "Sam Reyes", company: "vape", variance: 1, lottoReserveCounted: null, cashInHand: null }),
  note("payment.recorded", "payment.recorded", { staffId: "S_003", amount: 123.456 }),
  note("payment.recorded with no amount", "payment.recorded", { staffName: "Maya Okafor" }),
  note("commission.computed", "commission.computed", { bonusesCreated: 3, totalAmount: 41.5 }),
  note("commission.computed with nothing", "commission.computed", {}),
  note("an event the module does not know", "inventory.counted", { actorId: "S_001" }),
  note("no payload at all", "shift.opened", undefined),
];

export const notifierCases: ParityCase[] = [...checkCases, ...sendCases, ...notifyCases];

