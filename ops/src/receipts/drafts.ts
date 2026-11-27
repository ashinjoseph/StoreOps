// Receipt drafts: what was read off one receipt original, checked by the app (card P5-05a; ADR-0027).
// NEW in the Operations app (ADR-0023); ops/test/receipt-drafts.test.ts is the specification.
//
// A draft is a READING of one stored original: the figures an assistant proposed through the tool
// receipt_propose, or a person typed by hand (rpcEnterReceiptDraft), both through `propose` below. It
// counts for nothing until a person confirms it (card P5-05b, review.ts: a correction is a new reading written here too). The rules:
//   - The reader reports what is printed; the APP decides the business, from the live signs
//     (`decideBusiness`, pure). A reader's own guess is stored as a suggestion and decides nothing; a
//     business a person set at upload is kept beside as "a person said", and a disagreement is flagged.
//   - Money is exact: every amount is a JSON number or a decimal string with at most two decimals,
//     held here as integer cents (`parseMoney`), stored as numeric(12,2) from text. No float sums.
//   - Blank is not zero (ADR-0004): every field but the original's id and the total may be left out,
//     and is then stored NULL and answered null.
//   - The checks are arithmetic and FLAG (needs attention, in plain words with the numbers); they never
//     refuse. A draft is refused only when it is no draft at all (`isRefusal`): no such original, one set
//     aside, one a person is working on, no total, an amount that is not money, more than 300 lines,
//     text over its limit. A refusal writes nothing.
//   - A draft's figures never change: a new reading of the same original supersedes the live one (kept,
//     marked superseded, linked both ways) while no person has touched it. A person's draft (typed by
//     hand, or later edited) is never replaced by a proposal.
//   - Text from the reader (names, notes, where-read phrases, line descriptions) is data: control and
//     direction characters removed, white space made single spaces, capped; shown with esc() on the
//     page and through asData to an assistant.
// Identity comes from the caller (the session or the key); time is the caller's `now`; SQL takes values
// as parameters only; nothing is removed; every draft made, replaced, taken out and restored is audited
// (the audit row holds the figures, never the original's bytes).
import { z } from "zod";
import type { Db } from "../db/client";
import type { Tx } from "../db/tx";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import { formatDate } from "../lib/dates";
import { type Business, type SignKind, HST_MESSAGE, SIGN_KINDS, checkHst, describeSign, isBusiness, normalise, signKey } from "./businesses";

// ── Limits and names ──────────────────────────────────────

export const DRAFT_STATUSES = ["draft", "confirmed", "voided", "superseded"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];
export const KINDS = ["stock", "supplies", "equipment", "licences_fees", "other"] as const;
export const PAID_HOW = ["cash", "card", "account", "other"] as const;
export const WHERE_FIELDS = ["supplier", "supplier_hst_number", "invoice_number", "date", "paid", "subtotal", "hst", "other", "total", "kind", "buyer", "lines"] as const;
export const LINES_MAX = 300;
export const OTHER_MAX = 20;
export const LIMITS = {
  supplierName: 120,
  supplierHst: 40,
  invoice: 60,
  dateText: 40,
  buyerName: 120,
  buyerHst: 40,
  account: 60,
  label: 80,
  description: 300,
  code: 60,
  whereRead: 200,
  note: 500,
} as const;
/** The HST allowance: a computed HST within 2 cents of the one printed passes (rounding per line or on the total). */
export const HST_ALLOWANCE_CENTS = 2;
/** A receipt dated more than this many years before today (Toronto) is flagged. */
export const DATE_MAX_YEARS = 7;
/** The HST rate when the setting is blank or out of range: 13% (Ontario), in thousandths of a percent. */
export const DEFAULT_RATE_MILLI = 13000;
export const RATE_MAX_MILLI = 30000;

const ORIGINAL_ID = /^ro[0-9a-f]{24}$/;
const LOCK = "select pg_advisory_xact_lock(hashtextextended('ops.purchase_receipts', 0))";
/** C0 and C1 controls, U+2028/2029, and the bidirectional embeddings, overrides and isolates. */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
// eslint-disable-next-line no-control-regex
const BREAKS = /[\t\n\v\f\r\u2028\u2029]+/g;

// ── Refusals ──────────────────────────────────────────────

const REFUSED: unique symbol = Symbol("ops.receipt_draft.refused");
/** A plain Error (the router shows its message as it is), marked as a refusal of the draft. Nothing is written. */
export function refuse(message: string): Error {
  const err = new Error(`${message} Nothing was kept.`);
  (err as Error & { [REFUSED]?: true })[REFUSED] = true;
  return err;
}
export const isRefusal = (err: unknown): err is Error => err instanceof Error && (err as Error & { [REFUSED]?: true })[REFUSED] === true;

// ── Money and quantities: exact decimals as integers ──────

/**
 * A decimal with at most `places` decimals and `whole` integer digits, as an integer count of its
 * smallest unit, or null. A JSON number is read through its own shortest spelling (String(n)), so 12.5
 * is "12.5" and 0.1 + 0.2 is "0.30000000000000004" (refused): nothing is computed in floating point.
 * No exponent, no thousands separator, no sign but a leading minus, no currency sign; a string may have
 * white space around it.
 */
function parseDecimal(v: unknown, places: number, whole: number): number | null {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    s = String(v);
  } else if (typeof v === "string") s = v.trim();
  else return null;
  const m = new RegExp(`^(-?)(\\d{1,${whole}})(?:\\.(\\d{1,${places}}))?$`).exec(s);
  if (m === null) return null;
  const scale = 10 ** places;
  const units = Number(m[2]) * scale + Number((m[3] ?? "").padEnd(places, "0"));
  return m[1] === "-" && units !== 0 ? -units : units;
}

/** An amount of money as integer cents, or null when it is not money (see parseDecimal: two decimals, at most 9,999,999,999.99). */
export const parseMoney = (v: unknown): number | null => parseDecimal(v, 2, 10);
/** A quantity as integer thousandths (three decimals, at most 999,999,999.999), or null. */
export const parseQuantity = (v: unknown): number | null => parseDecimal(v, 3, 9);
/**
 * A line's unit price as integer ten-thousandths (up to four decimals, at most 9,999,999,999.9999), or
 * null: fuel is priced at 1.459 a litre, a wholesale item at 0.3333 each. Every other amount is money
 * (two decimals). Nothing is computed from it in this card.
 */
export const parseUnitPrice = (v: unknown): number | null => parseDecimal(v, 4, 10);
/**
 * A stored unit price (numeric(14,4) text, "1.4590") as it is answered and shown: at least two decimals,
 * trailing zeros past the second removed ("1.459", "6.00", "0.3333", "2.50"). Exact: text only.
 */
export function unitPriceText(stored: string): string {
  const m = /^(-?\d+)\.(\d{4})$/.exec(stored);
  if (m === null) return stored;
  const frac = (m[2] as string).replace(/0+$/, "");
  return `${m[1]}.${frac.length >= 2 ? frac : frac.padEnd(2, "0")}`;
}

/** An integer count of 1/10^places as its decimal text, exactly: 1250 → "12.50", -5 → "-0.05". */
function unitsText(units: number, places: number): string {
  const scale = 10 ** places;
  const a = Math.abs(units);
  const frac = a % scale;
  const wholePart = (a - frac) / scale;
  return `${units < 0 ? "-" : ""}${wholePart}${places > 0 ? "." + String(frac).padStart(places, "0") : ""}`;
}
/** Cents as stored and answered: "12.50". */
export const centsText = (cents: number): string => unitsText(cents, 2);
/** Cents in words: "$12.50", "-$3.10". */
export const moneyText = (cents: number): string => (cents < 0 ? `-$${centsText(-cents)}` : `$${centsText(cents)}`);
/** A quantity in thousandths, without trailing zeros: 10000 → "10", 1500 → "1.5". */
const quantityText = (milli: number): string => unitsText(milli, 3).replace(/\.?0+$/, "");
/** A rate in thousandths of a percent: 13000 → "13", 14975 → "14.975". */
const rateText = (milli: number): string => quantityText(milli);

/** The setting hst_rate_percent in thousandths of a percent: 0 to 30, up to three decimals; else 13. Read as text, so 0 is 0. */
export function hstRateMilli(config: Config): number {
  const v = parseDecimal(config.value("hst_rate_percent", ""), 3, 2);
  return v === null || v < 0 || v > RATE_MAX_MILLI ? DEFAULT_RATE_MILLI : v;
}

/** `rateMilli` thousandths of a percent of `baseCents`, in cents, rounded half away from zero. Integer arithmetic only. */
export function expectedHst(baseCents: number, rateMilli: number): number {
  const n = BigInt(baseCents) * BigInt(rateMilli);
  const d = 100000n;
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (a + d / 2n) / d;
  return Number(neg ? -q : q);
}

// ── Text from the reader ──────────────────────────────────

/** One line of the reader's text: controls and direction marks removed, white space single, trimmed; null when blank. Refused past `max`. */
function cleanText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw refuse(`${field} must be text.`);
  const text = v.replace(BREAKS, " ").replace(UNSAFE, "").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  if ([...text].length > max) throw refuse(`${field} can be at most ${max} characters.`);
  return text;
}

function cleanLast4(v: unknown, field: string): string | null {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  const text = typeof v === "string" ? v.normalize("NFKC").trim() : "";
  if (!/^[0-9]{4}$/.test(text)) throw refuse(`${field} must be exactly four digits: the last four of the card, never more of its number.`);
  return text;
}

function money(v: unknown, field: string): number | null {
  if (v === undefined || v === null) return null;
  const c = parseMoney(v);
  if (c === null) throw refuse(`${field} is not an amount: write it as printed, such as 12.50 or -3.10 (at most two decimals, no thousands separators or currency sign).`);
  return c;
}

function unitPrice(v: unknown, field: string): number | null {
  if (v === undefined || v === null) return null;
  const u = parseUnitPrice(v);
  if (u === null) throw refuse(`${field} is not a unit price: write it as printed, such as 1.459 or 6.00 (at most four decimals, no thousands separators or currency sign).`);
  return u;
}

// ── The input: one shape for the tool and the page ─────────

const AMOUNT = z.union([z.number(), z.string().max(200)]).nullable().optional();
const TEXT = z.string().max(5000).nullable().optional();

/**
 * The fields of a draft, as the tool receive_propose and rpcEnterReceiptDraft take them. Strict for the
 * tool (an unknown field is bad input); for the page, unknown fields are dropped (a planted role or
 * business is ignored). Values are checked again, with readable refusals, by `propose`.
 */
export function draftInputSchema(strict: boolean) {
  const obj = <S extends z.ZodRawShape>(shape: S) => (strict ? z.object(shape).strict() : z.object(shape));
  return obj({
    original_id: z.string().max(200),
    supplier: obj({ name: TEXT, hst_number: TEXT }).nullable().optional(),
    invoice_number: TEXT,
    date: TEXT,
    paid: obj({ how: z.enum(PAID_HOW), card_last4: TEXT }).nullable().optional(),
    amounts: obj({ subtotal: AMOUNT, hst: AMOUNT, total: AMOUNT, other: z.array(obj({ label: TEXT, amount: AMOUNT })).max(OTHER_MAX).nullable().optional() }).nullable().optional(),
    kind: z.enum(KINDS).nullable().optional(),
    buyer: obj({ name: TEXT, hst_number: TEXT, account_number: TEXT, card_last4: TEXT }).nullable().optional(),
    suggested_business: z.enum(["cstore", "vape"]).nullable().optional(),
    lines: z
      .array(obj({ description: TEXT, code: TEXT, quantity: AMOUNT, unit_price: AMOUNT, total: AMOUNT, taxed: z.boolean().nullable().optional() }))
      .max(2000)
      .nullable()
      .optional(),
    where_read: obj(Object.fromEntries(WHERE_FIELDS.map((f) => [f, TEXT])) as Record<(typeof WHERE_FIELDS)[number], typeof TEXT>).nullable().optional(),
    note: TEXT,
  });
}

/** The page's input: unknown fields dropped; a shape problem is a refusal naming the field. */
export function parsePageInput(raw: unknown): Record<string, unknown> {
  const parsed = draftInputSchema(false).safeParse(raw ?? {});
  if (parsed.success) return parsed.data as Record<string, unknown>;
  const parts = parsed.error.issues.slice(0, 3).map((i) => `${i.path.length > 0 ? i.path.join(".") : "input"}: ${i.message}`);
  throw refuse(`Bad input: ${parts.join("; ")}.`);
}

export interface Line {
  description: string;
  code: string | null;
  quantity: number | null;
  /** Ten-thousandths (four decimals), not cents. */
  unitPrice: number | null;
  total: number | null;
  taxed: boolean | null;
}

export interface Fields {
  originalId: string;
  supplierName: string | null;
  supplierHst: string | null;
  invoiceNumber: string | null;
  dateText: string | null;
  paidHow: (typeof PAID_HOW)[number] | null;
  paidCard: string | null;
  subtotal: number | null;
  hst: number | null;
  total: number;
  other: Array<{ label: string; amount: number }>;
  kind: (typeof KINDS)[number] | null;
  buyer: { name: string | null; hstNumber: string | null; accountNumber: string | null; cardLast4: string | null };
  suggested: Business | null;
  lines: Line[];
  whereRead: Record<string, string> | null;
  note: string | null;
}

const objOf = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The reader's fields, cleaned and checked (pure). Throws a refusal for what makes it no draft at all. */
export function readFields(input: Record<string, unknown>): Fields {
  const supplier = objOf(input["supplier"]);
  const paid = objOf(input["paid"]);
  const amounts = objOf(input["amounts"]);
  const buyer = objOf(input["buyer"]);
  const rawLines = Array.isArray(input["lines"]) ? (input["lines"] as unknown[]) : [];
  if (rawLines.length > LINES_MAX) throw refuse(`At most ${LINES_MAX} lines can be kept with one receipt; this has ${rawLines.length}.`);

  const total = money(amounts["total"], "amounts.total");
  if (total === null) throw refuse("The total is required: the amount the receipt says was paid, exactly as printed.");
  const howRaw = paid["how"];
  const paidHow = typeof howRaw === "string" && (PAID_HOW as readonly string[]).includes(howRaw) ? (howRaw as (typeof PAID_HOW)[number]) : null;
  const paidCard = cleanLast4(paid["card_last4"], "paid.card_last4");
  if (paidCard !== null && paidHow !== "card") throw refuse("paid.card_last4 is only for a card payment.");

  const otherRaw = Array.isArray(amounts["other"]) ? (amounts["other"] as unknown[]) : [];
  const other = otherRaw.map((o, i) => {
    const r = objOf(o);
    const amount = money(r["amount"], `amounts.other.${i}.amount`);
    if (amount === null) throw refuse(`amounts.other.${i}.amount is required: each other charge has its amount.`);
    return { label: cleanText(r["label"], `amounts.other.${i}.label`, LIMITS.label) ?? "Other charge", amount };
  });

  const lines: Line[] = rawLines.map((l, i) => {
    const r = objOf(l);
    const description = cleanText(r["description"], `lines.${i}.description`, LIMITS.description);
    if (description === null) throw refuse(`lines.${i}.description is required: what the line says.`);
    let quantity: number | null = null;
    if (r["quantity"] !== undefined && r["quantity"] !== null) {
      quantity = parseQuantity(r["quantity"]);
      if (quantity === null) throw refuse(`lines.${i}.quantity is not a quantity: write it as printed, such as 2 or 1.5 (at most three decimals).`);
    }
    const taxed = r["taxed"];
    return {
      description,
      code: cleanText(r["code"], `lines.${i}.code`, LIMITS.code),
      quantity,
      unitPrice: unitPrice(r["unit_price"], `lines.${i}.unit_price`),
      total: money(r["total"], `lines.${i}.total`),
      taxed: typeof taxed === "boolean" ? taxed : null,
    };
  });

  const whereRaw = objOf(input["where_read"]);
  const whereRead: Record<string, string> = {};
  for (const f of WHERE_FIELDS) {
    const t = cleanText(whereRaw[f], `where_read.${f}`, LIMITS.whereRead);
    if (t !== null) whereRead[f] = t;
  }
  const kindRaw = input["kind"];
  return {
    originalId: typeof input["original_id"] === "string" ? input["original_id"].trim() : "",
    supplierName: cleanText(supplier["name"], "supplier.name", LIMITS.supplierName),
    supplierHst: cleanText(supplier["hst_number"], "supplier.hst_number", LIMITS.supplierHst),
    invoiceNumber: cleanText(input["invoice_number"], "invoice_number", LIMITS.invoice),
    dateText: cleanText(input["date"], "date", LIMITS.dateText),
    paidHow,
    paidCard,
    subtotal: money(amounts["subtotal"], "amounts.subtotal"),
    hst: money(amounts["hst"], "amounts.hst"),
    total,
    other,
    kind: typeof kindRaw === "string" && (KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as (typeof KINDS)[number]) : null,
    buyer: {
      name: cleanText(buyer["name"], "buyer.name", LIMITS.buyerName),
      hstNumber: cleanText(buyer["hst_number"], "buyer.hst_number", LIMITS.buyerHst),
      accountNumber: cleanText(buyer["account_number"], "buyer.account_number", LIMITS.account),
      cardLast4: cleanLast4(buyer["card_last4"], "buyer.card_last4"),
    },
    suggested: isBusiness(input["suggested_business"]) ? input["suggested_business"] : null,
    lines,
    whereRead: Object.keys(whereRead).length > 0 ? whereRead : null,
    note: cleanText(input["note"], "note", LIMITS.note),
  };
}

/** The other charges added up, or null when there are none (blank, not 0). */
export const otherTotalOf = (other: ReadonlyArray<{ amount: number }>): number | null => (other.length === 0 ? null : other.reduce((n, o) => n + o.amount, 0));

// ── The business, decided from the signs (pure) ───────────

export interface Evidence {
  name: string | null;
  hstNumber: string | null;
  accountNumber: string | null;
  cardLast4: string | null;
  /** The card the receipt says it was paid with (paid.card_last4): the buyer's card too. */
  paidCardLast4?: string | null;
  /** The supplier's name as printed: an account number is a sign only at that supplier. */
  supplierName: string | null;
}

export interface LiveSign {
  signId: string;
  business: Business;
  kind: SignKind;
  value: string;
  valueKey: string;
  supplier: string | null;
}

export interface BusinessDecision {
  business: Business | null;
  /** The kinds of sign that decided it, in SIGN_KINDS order; or ["conflict"] or ["not_known"]. */
  decidedBy: string[];
  why: string;
  matched: Array<{ signId: string; business: Business; kind: SignKind; value: string; supplier: string | null }>;
  personSaid: Business | null;
  /** null when no person said, or the signs did not decide. */
  agreesWithPerson: boolean | null;
}

const and = (parts: string[]): string => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);

/**
 * The business, from what the document prints about the BUYER and the live signs: each piece of
 * evidence is compared with the signs of its kind in the Businesses card's normal form. One business
 * matched: that business. Both: conflict. None: not known. Nothing else is used: not the supplier, not
 * the reader's guess, not what a person said (that is kept beside, and compared).
 */
export function decideBusiness(evidence: Evidence, signs: readonly LiveSign[], personSaid: Business | null): BusinessDecision {
  const keys: Record<SignKind, string[]> = { name: [], hst_number: [], supplier_account: [], card_last4: [] };
  if (evidence.name !== null) keys.name.push(signKey("name", evidence.name, null));
  if (evidence.hstNumber !== null) keys.hst_number.push(signKey("hst_number", evidence.hstNumber, null));
  for (const card of [evidence.cardLast4, evidence.paidCardLast4 ?? null]) if (card !== null) keys.card_last4.push(signKey("card_last4", card, null));
  if (evidence.accountNumber !== null && evidence.supplierName !== null) keys.supplier_account.push(signKey("supplier_account", evidence.accountNumber, evidence.supplierName));
  const matched: BusinessDecision["matched"] = [];
  for (const kind of SIGN_KINDS) {
    const wanted = new Set(keys[kind].filter((k) => k !== "" && k !== "|"));
    for (const s of signs) if (s.kind === kind && wanted.has(s.valueKey)) matched.push({ signId: s.signId, business: s.business, kind: s.kind, value: s.value, supplier: s.supplier });
  }
  const found = [...new Set(matched.map((m) => m.business))];
  if (found.length === 1) {
    const business = found[0] as Business;
    return {
      business,
      decidedBy: SIGN_KINDS.filter((k) => matched.some((m) => m.kind === k)),
      why: `decided by ${and(matched.map((m) => describeSign(m.kind, m.value, m.supplier)))}`,
      matched,
      personSaid,
      agreesWithPerson: personSaid === null ? null : personSaid === business,
    };
  }
  if (found.length > 1) return { business: null, decidedBy: ["conflict"], why: "the signs point at both businesses", matched, personSaid, agreesWithPerson: null };
  return { business: null, decidedBy: ["not_known"], why: "not known: nothing printed matched", matched, personSaid, agreesWithPerson: null };
}

// ── The checks (pure; review.ts reruns them through runChecks when a person corrects or confirms) ──

export type CheckId = "lines_add_up" | "parts_add_up" | "hst_plausible" | "date" | "duplicate" | "supplier_hst_number" | "business";
export const CHECK_ORDER: readonly CheckId[] = ["lines_add_up", "parts_add_up", "hst_plausible", "date", "duplicate", "supplier_hst_number", "business"];
export interface CheckResult {
  check: CheckId;
  /** true passed, false failed (needs attention), null not checked (nothing to check). */
  passed: boolean | null;
  words: string;
}
const result = (check: CheckId, passed: boolean | null, words: string): CheckResult => ({ check, passed, words });
const apart = (a: number, b: number): string => moneyText(Math.abs(a - b));

/** The lines' totals add up to the subtotal, to the cent. Only when there are lines, every one has a total, and there is a subtotal. */
export function checkLinesAddUp(lines: ReadonlyArray<{ total: number | null }>, subtotal: number | null): CheckResult {
  if (lines.length === 0) return result("lines_add_up", null, "No lines: nothing to add up.");
  if (lines.some((l) => l.total === null)) return result("lines_add_up", null, "Not every line has a total, so the lines cannot be added up.");
  if (subtotal === null) return result("lines_add_up", null, "No subtotal on the receipt to add the lines up to.");
  const sum = lines.reduce((n, l) => n + (l.total as number), 0);
  const n = `${lines.length} line${lines.length === 1 ? "" : "s"}`;
  if (sum === subtotal) return result("lines_add_up", true, `The ${n} add${lines.length === 1 ? "s" : ""} up to ${moneyText(sum)}, the subtotal.`);
  return result("lines_add_up", false, `The ${n} add${lines.length === 1 ? "s" : ""} up to ${moneyText(sum)}, but the subtotal is ${moneyText(subtotal)} (${apart(sum, subtotal)} apart).`);
}

/** subtotal + HST + other charges = total, to the cent. Only with a subtotal; a blank HST or other charges count as nothing, and the words say so. */
export function checkPartsAddUp(a: { subtotal: number | null; hst: number | null; otherTotal: number | null; total: number }): CheckResult {
  if (a.subtotal === null) return result("parts_add_up", null, "No subtotal on the receipt, so the total cannot be checked against its parts.");
  const sum = a.subtotal + (a.hst ?? 0) + (a.otherTotal ?? 0);
  const said = `Subtotal ${moneyText(a.subtotal)}${a.hst === null ? " (no HST on the receipt)" : ` + HST ${moneyText(a.hst)}`}${a.otherTotal === null ? "" : ` + other charges ${moneyText(a.otherTotal)}`} = ${moneyText(sum)}`;
  if (sum === a.total) return result("parts_add_up", true, `${said}, the total.`);
  return result("parts_add_up", false, `${said}, but the total is ${moneyText(a.total)} (${apart(sum, a.total)} apart).`);
}

/**
 * The HST is plausible. When every line has a total and a taxed/not-taxed mark: HST = rate × the taxed
 * lines, within HST_ALLOWANCE_CENTS either way. Otherwise, with a subtotal: 0 ≤ HST ≤ rate × subtotal +
 * HST_ALLOWANCE_CENTS. A blank HST is not checked; an HST of 0 is.
 */
export function checkHstPlausible(a: { lines: ReadonlyArray<{ total: number | null; taxed: boolean | null }>; subtotal: number | null; hst: number | null }, rateMilli: number): CheckResult {
  if (a.hst === null) return result("hst_plausible", null, "No HST on the receipt: nothing to check.");
  const rate = `${rateText(rateMilli)}%`;
  const allow = moneyText(HST_ALLOWANCE_CENTS);
  const marked = a.lines.length > 0 && a.lines.every((l) => l.taxed !== null && l.total !== null);
  if (marked) {
    const base = a.lines.filter((l) => l.taxed === true).reduce((n, l) => n + (l.total as number), 0);
    const expected = expectedHst(base, rateMilli);
    const said = `${rate} of the taxed lines (${moneyText(base)}) = ${moneyText(expected)}, within ${allow}`;
    if (Math.abs(a.hst - expected) <= HST_ALLOWANCE_CENTS) return result("hst_plausible", true, `HST ${moneyText(a.hst)} is ${said}.`);
    return result("hst_plausible", false, `HST ${moneyText(a.hst)} should be ${said}; it is ${apart(a.hst, expected)} ${a.hst > expected ? "more" : "less"}.`);
  }
  if (a.subtotal === null) return result("hst_plausible", null, "No subtotal and no marked lines to check the HST against.");
  if (a.hst < 0) return result("hst_plausible", false, `HST ${moneyText(a.hst)} is less than nothing.`);
  const most = expectedHst(a.subtotal, rateMilli);
  const said = `${rate} of the subtotal (${moneyText(a.subtotal)}) = ${moneyText(most)}, plus ${allow} for rounding`;
  if (a.hst <= most + HST_ALLOWANCE_CENTS) return result("hst_plausible", true, `HST ${moneyText(a.hst)} is between $0.00 and ${said}.`);
  return result("hst_plausible", false, `HST ${moneyText(a.hst)} is more than ${said}.`);
}

/** "YYYY-MM-DD" when it is a real day, else null. */
export function realDay(text: string | null): string | null {
  if (text === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  return text;
}

/** The date is a real day, not after today in Toronto, and not before the same day DATE_MAX_YEARS years ago (29 February: the 28th). */
export function checkDate(text: string | null, now: Date): CheckResult {
  if (text === null) return result("date", null, "No date on the receipt.");
  const day = realDay(text);
  if (day === null) return result("date", false, `The date "${text}" is not a real day (written YYYY-MM-DD).`);
  const today = formatDate(now);
  if (day > today) return result("date", false, `The date ${day} is in the future (today is ${today} in Toronto).`);
  const oldest = `${String(Number(today.slice(0, 4)) - DATE_MAX_YEARS).padStart(4, "0")}${today.slice(4) === "-02-29" ? "-02-28" : today.slice(4)}`;
  if (day < oldest) return result("date", false, `The date ${day} is more than ${DATE_MAX_YEARS} years old (the oldest accepted is ${oldest}).`);
  return result("date", true, `The date ${day} is a real day, not in the future and not more than ${DATE_MAX_YEARS} years old.`);
}

/** The supplier's HST number, when printed, has the Canadian shape (the Businesses card's checkHst). */
export function checkSupplierHst(text: string | null): CheckResult {
  if (text === null) return result("supplier_hst_number", null, "No supplier HST number on the receipt.");
  try {
    checkHst(text);
  } catch {
    return result("supplier_hst_number", false, `The supplier's HST number "${text}" is not the Canadian shape: ${HST_MESSAGE.replace(/^An HST number is /, "")}`);
  }
  return result("supplier_hst_number", true, "The supplier's HST number has the Canadian shape.");
}

const owns = (m: { kind: SignKind; value: string; supplier: string | null; business: Business }): string => `${describeSign(m.kind, m.value, m.supplier)} is ${m.business}'s`;

/** Flagged: the business not known, the signs pointing at both, or the signs disagreeing with what a person said at upload. */
export function checkBusiness(d: BusinessDecision): CheckResult {
  const person = d.personSaid === null ? "" : ` A person said ${d.personSaid} when it was added.`;
  if (d.decidedBy[0] === "conflict") return result("business", false, `The signs point at both businesses: ${d.matched.map(owns).join("; ")}.${person}`);
  if (d.business === null) return result("business", false, `Business not known: nothing printed matched a sign of either business.${person}`);
  const signs = and(d.matched.map((m) => describeSign(m.kind, m.value, m.supplier)));
  if (d.agreesWithPerson === false) return result("business", false, `A person said ${d.personSaid} when it was added, but the signs say ${d.business} (${signs}).`);
  const words = `Decided by ${signs}`;
  return result("business", true, d.agreesWithPerson === true ? `${words}; a person said ${d.personSaid} when it was added, and they agree.` : `${words}.`);
}

export interface DuplicateMatch {
  purchaseId: string;
  originalId: string | null;
  business: Business | null;
  supplierName: string | null;
  invoiceNumber: string | null;
  date: string | null;
  total: number;
  sameInvoice: boolean;
  /** draft or confirmed (card P5-05b: a duplicate of a confirmed receipt needs an admin to confirm). */
  status: DraftStatus;
}

/**
 * Another live reading (a draft or a confirmed receipt, of EITHER business, whose original is not set
 * aside, of another original) from the same supplier: with the same invoice number, a duplicate; with
 * the same date and total and no invoice number on one of the two, a possible duplicate.
 */
export function checkDuplicates(f: { supplierName: string | null; invoiceNumber: string | null; date: string | null; total: number; supplierKnown: boolean }, matches: readonly DuplicateMatch[]): CheckResult {
  if (!f.supplierKnown) return result("duplicate", null, "No supplier name to compare with the receipts on file.");
  if (f.invoiceNumber === null && f.date === null) return result("duplicate", null, "No invoice number and no date to compare with the receipts on file.");
  const where = (m: DuplicateMatch) => `draft ${m.purchaseId}, ${m.business ?? "business not known"}${m.originalId === null ? "" : `, receipt original ${m.originalId}`}`;
  const same = matches.find((m) => m.sameInvoice);
  if (same !== undefined) return result("duplicate", false, `Duplicate: invoice ${f.invoiceNumber} from ${f.supplierName ?? same.supplierName ?? "this supplier"} is already on file (${where(same)}).`);
  const possible = matches[0];
  if (possible !== undefined) {
    return result("duplicate", false, `Possible duplicate: ${f.supplierName ?? possible.supplierName ?? "this supplier"}, ${f.date}, ${moneyText(f.total)} is already on file with no invoice number to tell them apart (${where(possible)}).`);
  }
  return result("duplicate", true, "No other receipt on file from this supplier with the same invoice number, or the same date and total.");
}

// ── Reading the database ──────────────────────────────────

/** The live signs of both businesses (removed ones never count). */
export async function liveSigns(db: Db): Promise<LiveSign[]> {
  const rows = await db.query<{ sign_id: string; business: Business; kind: SignKind; value: string; value_key: string; supplier: string | null }>(
    "select sign_id, business, kind, value, value_key, supplier from ops.business_signs where removed_at is null order by added_at, sign_id",
  );
  return rows.map((r) => ({ signId: r.sign_id, business: r.business, kind: r.kind, value: r.value, valueKey: r.value_key, supplier: r.supplier }));
}

/** The active supplier one live spelling of which is `name` in normal form, or null. Never creates one. */
export async function matchSupplier(db: Db, name: string | null): Promise<{ id: string; displayName: string } | null> {
  if (name === null) return null;
  const key = normalise(name);
  if (key === "") return null;
  const row = await db.maybeOne<{ supplier_id: string; display_name: string }>(
    `select s.supplier_id, s.display_name
       from ops.supplier_names n join ops.suppliers s on s.supplier_id = n.supplier_id
      where n.name_key = $1 and n.removed_at is null and s.active`,
    [key],
  );
  return row === null ? null : { id: row.supplier_id, displayName: row.display_name };
}

export async function findDuplicates(db: Db, f: { originalId: string; supplierKey: string | null; supplierId: string | null; invoiceKey: string | null; date: string | null; total: number }): Promise<DuplicateMatch[]> {
  if (f.supplierKey === null && f.supplierId === null) return [];
  const rows = await db.query<{ purchase_id: string; original_id: string | null; business: Business | null; supplier_name: string | null; invoice_number: string | null; receipt_date: string | null; total: string; same_invoice: boolean; status: DraftStatus }>(
    `select p.purchase_id, p.original_id, p.business, p.supplier_name, p.invoice_number, p.receipt_date, p.total::text as total, p.status,
            ($3::text is not null and p.invoice_key = $3) as same_invoice
       from ops.purchase_receipts p
       left join ops.receipt_originals o on o.receipt_id = p.original_id
      where p.status in ('draft', 'confirmed')
        and (o.status is null or o.status <> 'set_aside')
        and p.original_id is distinct from $1
        and ((p.supplier_name_key is not null and p.supplier_name_key = $2) or ($4::text is not null and p.supplier_id = $4))
        and (($3::text is not null and p.invoice_key = $3)
             or ($5::date is not null and p.receipt_date = $5::date and p.total = $6::numeric and (p.invoice_key is null or $3::text is null)))
      order by ($3::text is not null and p.invoice_key = $3) desc, p.read_at, p.purchase_id
      limit 5`,
    [f.originalId, f.supplierKey, f.invoiceKey, f.supplierId, f.date, centsText(f.total)],
  );
  return rows.map((r) => ({
    purchaseId: r.purchase_id,
    originalId: r.original_id,
    business: r.business,
    supplierName: r.supplier_name,
    invoiceNumber: r.invoice_number,
    date: r.receipt_date,
    total: parseMoney(r.total) as number,
    sameInvoice: r.same_invoice,
    status: r.status,
  }));
}

// ── The draft as it is answered ───────────────────────────

export interface DraftView {
  id: string;
  originalId: string | null;
  status: DraftStatus;
  readBy: { kind: "assistant" | "person"; name: string; keyLabel: string | null };
  readAt: string;
  supplier: { id: string | null; name: string | null; hstNumber: string | null; onList: boolean; listedName: string | null };
  invoiceNumber: string | null;
  date: string | null;
  dateAsRead: string | null;
  paid: { how: string; cardLast4: string | null } | null;
  amounts: { subtotal: string | null; hst: string | null; otherTotal: string | null; other: Array<{ label: string; amount: string }>; total: string };
  kind: string | null;
  buyer: { name: string | null; hstNumber: string | null; accountNumber: string | null; cardLast4: string | null };
  suggestedBusiness: Business | null;
  business: {
    key: Business | null;
    decidedBy: string[];
    why: string;
    signs: Array<{ kind: string; value: string; supplier: string | null; business: Business }>;
    personSaid: Business | null;
    agreesWithPerson: boolean | null;
    /** Card P5-05b: when a person chose the business, what the signs said (else null). */
    signsSaid: { business: Business | null; decidedBy: string[] } | null;
  };
  lines: Array<{ line: number; description: string; code: string | null; quantity: string | null; unitPrice: string | null; total: string | null; taxed: boolean | null }>;
  needsAttention: boolean;
  checks: CheckResult[];
  failed: number;
  whereRead: Record<string, string> | null;
  note: string | null;
  supersedes: string | null;
  /** Card P5-05b: the voided receipt this draft was copied from, or null. */
  redoOf: string | null;
  hstRatePercent: string;
}

interface DraftRow {
  purchase_id: string;
  original_id: string | null;
  status: DraftStatus;
  read_by_kind: "assistant" | "person";
  read_by_key: string | null;
  read_by: string;
  read_by_name: string | null;
  key_label: string | null;
  read_at: Date;
  business: Business | null;
  business_decided_by: string[];
  business_signs: Array<{ sign_id: string; business: Business; kind: string; value: string; supplier: string | null }>;
  business_person_said: Business | null;
  buyer_name: string | null;
  buyer_hst_number: string | null;
  buyer_account_number: string | null;
  buyer_card_last4: string | null;
  suggested_business: Business | null;
  supplier_id: string | null;
  supplier_display_name: string | null;
  supplier_name: string | null;
  supplier_hst_number: string | null;
  invoice_number: string | null;
  receipt_date: string | null;
  receipt_date_text: string | null;
  paid_how: string | null;
  paid_card_last4: string | null;
  subtotal: string | null;
  hst: string | null;
  total: string;
  other_total: string | null;
  other_charges: Array<{ label: string; amount: string }> | null;
  hst_rate_percent: string;
  kind: string | null;
  needs_attention: boolean;
  checks: CheckResult[];
  where_read: Record<string, string> | null;
  reader_note: string | null;
  supersedes: string | null;
  signs_business: Business | null;
  signs_decided_by: string[] | null;
  redo_of: string | null;
}

const DRAFT_SELECT = `select p.purchase_id, p.original_id, p.status, p.read_by_kind, p.read_by_key, p.read_by, st.name as read_by_name, ak.label as key_label, p.read_at,
                             p.business, p.business_decided_by, p.business_signs, p.business_person_said,
                             p.buyer_name, p.buyer_hst_number, p.buyer_account_number, p.buyer_card_last4, p.suggested_business,
                             p.supplier_id, sp.display_name as supplier_display_name, p.supplier_name, p.supplier_hst_number, p.invoice_number,
                             p.receipt_date, p.receipt_date_text, p.paid_how, p.paid_card_last4,
                             p.subtotal::text as subtotal, p.hst::text as hst, p.total::text as total, p.other_total::text as other_total, p.other_charges,
                             p.hst_rate_percent::text as hst_rate_percent, p.kind, p.needs_attention, p.checks, p.where_read, p.reader_note, p.supersedes,
                             p.signs_business, p.signs_decided_by, p.redo_of
                        from ops.purchase_receipts p
                        left join ops.staff st on st.staff_id = p.read_by
                        left join ops.assistant_keys ak on ak.key_id = p.read_by_key
                        left join ops.suppliers sp on sp.supplier_id = p.supplier_id`;

interface LineRow {
  line_no: number;
  description: string;
  item_code: string | null;
  quantity: string | null;
  unit_price: string | null;
  line_total: string | null;
  taxed: boolean | null;
}

const quantityOut = (q: string | null): string | null => (q === null ? null : quantityText(parseQuantity(q) as number));

function draftView(r: DraftRow, lines: LineRow[]): DraftView {
  const decidedBy = r.business_decided_by;
  const signs = r.business_signs.map((s) => ({ kind: s.kind, value: s.value, supplier: s.supplier, business: s.business }));
  const decision: BusinessDecision = {
    business: r.business,
    decidedBy,
    why: "",
    matched: r.business_signs.map((s) => ({ signId: s.sign_id, business: s.business, kind: s.kind as SignKind, value: s.value, supplier: s.supplier })),
    personSaid: r.business_person_said,
    agreesWithPerson: r.business === null || r.business_person_said === null ? null : r.business === r.business_person_said,
  };
  const why =
    decidedBy[0] === "conflict" ? "the signs point at both businesses" : decidedBy[0] === "not_known" ? "not known: nothing printed matched" : decidedBy[0] === "person" ? `chosen by a person; the signs said ${r.signs_business ?? (r.signs_decided_by?.[0] === "conflict" ? "both businesses" : "not known")}` : `decided by ${and(decision.matched.map((m) => describeSign(m.kind, m.value, m.supplier)))}`;
  return {
    id: r.purchase_id,
    originalId: r.original_id,
    status: r.status,
    readBy: { kind: r.read_by_kind, name: (r.read_by_name ?? r.read_by).trim(), keyLabel: r.read_by_key === null ? null : (r.key_label ?? r.read_by_key) },
    readAt: r.read_at.toISOString(),
    supplier: { id: r.supplier_id, name: r.supplier_name, hstNumber: r.supplier_hst_number, onList: r.supplier_id !== null, listedName: r.supplier_display_name },
    invoiceNumber: r.invoice_number,
    date: r.receipt_date,
    dateAsRead: r.receipt_date_text,
    paid: r.paid_how === null ? null : { how: r.paid_how, cardLast4: r.paid_card_last4 },
    amounts: { subtotal: r.subtotal, hst: r.hst, otherTotal: r.other_total, other: r.other_charges ?? [], total: r.total },
    kind: r.kind,
    buyer: { name: r.buyer_name, hstNumber: r.buyer_hst_number, accountNumber: r.buyer_account_number, cardLast4: r.buyer_card_last4 },
    suggestedBusiness: r.suggested_business,
    business: { key: r.business, decidedBy, why, signs, personSaid: r.business_person_said, agreesWithPerson: decision.agreesWithPerson, signsSaid: r.signs_decided_by === null ? null : { business: r.signs_business, decidedBy: r.signs_decided_by } },
    lines: lines.map((l) => ({ line: l.line_no, description: l.description, code: l.item_code, quantity: quantityOut(l.quantity), unitPrice: l.unit_price === null ? null : unitPriceText(l.unit_price), total: l.line_total, taxed: l.taxed })),
    needsAttention: r.needs_attention,
    checks: r.checks,
    failed: r.checks.filter((c) => c.passed === false).length,
    whereRead: r.where_read,
    note: r.reader_note,
    supersedes: r.supersedes,
    redoOf: r.redo_of,
    hstRatePercent: quantityOut(r.hst_rate_percent) ?? "13",
  };
}

export async function loadDraft(db: Db, purchaseId: string): Promise<DraftView> {
  const row = await db.one<DraftRow>(`${DRAFT_SELECT} where p.purchase_id = $1`, [purchaseId]);
  const lines = await db.query<LineRow>(
    "select line_no, description, item_code, quantity::text as quantity, unit_price::text as unit_price, line_total::text as line_total, taxed from ops.purchase_receipt_lines where purchase_id = $1 order by line_no",
    [purchaseId],
  );
  return draftView(row, lines);
}

/** The live draft of an original (not superseded, its original not set aside), with its lines; null when there is none or the id is not one. */
export async function getDraft(db: Db, originalId: unknown): Promise<DraftView | null> {
  if (typeof originalId !== "string" || !ORIGINAL_ID.test(originalId)) return null;
  const row = await db.maybeOne<{ purchase_id: string }>(
    `select p.purchase_id from ops.purchase_receipts p join ops.receipt_originals o on o.receipt_id = p.original_id
      where p.original_id = $1 and p.status = 'draft' and o.status <> 'set_aside'`,
    [originalId],
  );
  return row === null ? null : loadDraft(db, row.purchase_id);
}

// ── Proposing, correcting, redoing: one way to write a reading ──

export type Reader = { kind: "assistant"; keyId: string; staffId: string } | { kind: "person"; staffId: string };

export interface ProposeResult {
  draft: DraftView;
  /** The draft this one superseded, or null. */
  replaced: string | null;
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const newPurchaseId = (): string => "pr" + hex(crypto.getRandomValues(new Uint8Array(12)));
const textOrNull = (c: number | null): string | null => (c === null ? null : centsText(c));

/** The refusal for any write to an original whose receipt is on the books (card P5-05b). */
export const ON_THE_BOOKS = "That receipt is on the books (confirmed): it cannot be changed. To correct it, void it first.";

/**
 * How a reading is written. `propose`: an assistant's proposal or a person's figures by hand (card
 * P5-05a: never over a person's draft). `correct` (card P5-05b): a person's correction of the live draft,
 * which it supersedes, with the business and the supplier the person chose. `redo` (card P5-05b): the
 * draft a void makes, copied from the voided receipt; it supersedes nothing.
 */
export type WriteMode =
  | { mode: "propose" }
  | { mode: "correct"; draftId: string | null; business: Business | null; supplierId: string | null }
  | { mode: "redo"; voidedId: string; business: Business | null; supplierId: string | null };

export interface SupplierRef {
  id: string;
  displayName: string;
  active: boolean;
}

/** What the checks were run with: how the business and the supplier were settled, and the results. */
export interface Checked {
  decision: BusinessDecision;
  /** The business the reading is written with: the signs', or the person's choice. */
  business: Business | null;
  decidedBy: string[];
  /** When a person chose a business the signs did not decide: what the signs said. */
  signsSaid: { business: Business | null; decidedBy: string[] } | null;
  supplier: SupplierRef | null;
  supplierKey: string | null;
  invoiceKey: string | null;
  day: string | null;
  otherTotal: number | null;
  duplicates: DuplicateMatch[];
  rateMilli: number;
  checks: CheckResult[];
}

/**
 * The business when a person chose it and the signs did not decide that one (card P5-05b). Not known or a
 * conflict, settled by the person: passes. The signs deciding the other business, overruled by the
 * person: fails (a reason is then needed to confirm), naming what the signs said. Pure.
 */
export function checkChosenBusiness(chosen: Business, signs: BusinessDecision): CheckResult {
  if (signs.business !== null && signs.business !== chosen) {
    const said = and(signs.matched.map((m) => describeSign(m.kind, m.value, m.supplier)));
    return result("business", false, `A person chose ${chosen}, overruling the signs, which say ${signs.business} (${said}).`);
  }
  const was = signs.decidedBy[0] === "conflict" ? "the signs pointed at both businesses" : "nothing printed matched a sign";
  return result("business", true, `Chosen by a person: ${chosen} (${was}).`);
}

/** A supplier by id with its display name and whether it is active, or null. */
export async function supplierById(db: Db, id: unknown): Promise<SupplierRef | null> {
  if (typeof id !== "string" || !/^sp[0-9a-f]{20}$/.test(id)) return null;
  const row = await db.maybeOne<{ supplier_id: string; display_name: string; active: boolean }>("select supplier_id, display_name, active from ops.suppliers where supplier_id = $1", [id]);
  return row === null ? null : { id: row.supplier_id, displayName: row.display_name, active: row.active };
}

/**
 * Settle the business and the supplier and run every check on the fields `f` of `originalId`. `chosen`:
 * the business a person chose (null: the signs decide); `supplier`: the supplier a person chose (null:
 * matched by the printed name). Used when a reading is written and again when it is confirmed.
 */
export async function runChecks(db: Db, f: Fields, originalId: string, personSaid: Business | null, chosen: Business | null, supplier: SupplierRef | null, config: Config, now: Date): Promise<Checked> {
  const decision = decideBusiness({ ...f.buyer, paidCardLast4: f.paidCard, supplierName: f.supplierName }, await liveSigns(db), personSaid);
  const overrule = chosen !== null && chosen !== decision.business;
  const m = supplier === null ? await matchSupplier(db, f.supplierName) : null;
  const matched: SupplierRef | null = supplier ?? (m === null ? null : { id: m.id, displayName: m.displayName, active: true });
  const supplierKey = f.supplierName === null ? null : normalise(f.supplierName) || null;
  const invoiceKey = f.invoiceNumber === null ? null : normalise(f.invoiceNumber) || null;
  const day = realDay(f.dateText);
  const otherTotal = otherTotalOf(f.other);
  const duplicates = await findDuplicates(db, { originalId, supplierKey, supplierId: matched?.id ?? null, invoiceKey, date: day, total: f.total });
  const rateMilli = hstRateMilli(config);
  const checks: CheckResult[] = [
    checkLinesAddUp(f.lines, f.subtotal),
    checkPartsAddUp({ subtotal: f.subtotal, hst: f.hst, otherTotal, total: f.total }),
    checkHstPlausible({ lines: f.lines, subtotal: f.subtotal, hst: f.hst }, rateMilli),
    checkDate(f.dateText, now),
    checkDuplicates({ supplierName: f.supplierName, invoiceNumber: f.invoiceNumber, date: day, total: f.total, supplierKnown: supplierKey !== null || matched !== null }, duplicates),
    checkSupplierHst(f.supplierHst),
    overrule ? checkChosenBusiness(chosen, decision) : checkBusiness(decision),
  ];
  return {
    decision,
    business: overrule ? chosen : decision.business,
    decidedBy: overrule ? ["person"] : decision.decidedBy,
    signsSaid: overrule ? { business: decision.business, decidedBy: decision.decidedBy } : null,
    supplier: matched,
    supplierKey,
    invoiceKey,
    day,
    otherTotal,
    duplicates,
    rateMilli,
    checks,
  };
}

/**
 * Make the draft of one original, in `tx` (decisions 1 to 13 of card P5-05a): read and check the fields,
 * take the drafts' lock, lock the original, decide the business, match the supplier, look for
 * duplicates, run the checks, supersede the live draft (unless a person made it: refused), write the
 * draft and its lines, mark the original drafted, audit. Refusals write nothing.
 */
export async function propose(tx: Tx, input: Record<string, unknown>, reader: Reader, config: Config, now: Date): Promise<ProposeResult> {
  return writeReading(tx, readFields(input), reader, { mode: "propose" }, config, now);
}

/** Who made a reading, as a person reads it. */
export async function whoRead(db: Db, purchaseId: string): Promise<string> {
  const r = await db.maybeOne<{ read_by_kind: string; name: string | null; read_by: string; label: string | null }>(
    "select p.read_by_kind, st.name, p.read_by, ak.label from ops.purchase_receipts p left join ops.staff st on st.staff_id = p.read_by left join ops.assistant_keys ak on ak.key_id = p.read_by_key where p.purchase_id = $1",
    [purchaseId],
  );
  if (r === null) return "someone";
  const name = (r.name ?? r.read_by).trim();
  return r.read_by_kind === "assistant" ? `${name}'s assistant (${r.label ?? "a key"})` : name;
}

/** The drafts' lock: every reading, confirm and void takes it first, then the original's row (card P5-05b). */
export const takeReadingsLock = async (tx: Tx): Promise<void> => {
  await tx.query(LOCK);
};

/** Write one reading of an original (see WriteMode): the one path for proposals, corrections and the draft a void makes. */
export async function writeReading(tx: Tx, f: Fields, reader: Reader, how: WriteMode, config: Config, now: Date): Promise<ProposeResult> {
  if (!ORIGINAL_ID.test(f.originalId)) throw refuse("No receipt original with that id.");
  // One reading at a time, for every original: two readings of one original at once are taken one
  // after the other (the second supersedes the first), and the duplicate check sees the other's row.
  // Confirming and voiding (review.ts) take the same lock first, then the original's row.
  await tx.query(LOCK);
  const orig = await tx.maybeOne<{ status: string; business: Business | null }>("select status, business from ops.receipt_originals where receipt_id = $1 for update", [f.originalId]);
  if (orig === null) throw refuse("No receipt original with that id.");
  if (orig.status === "set_aside") throw refuse("That receipt original is set aside (it is not a receipt). A person can put it back first.");
  if (orig.status === "confirmed") throw refuse(ON_THE_BOOKS);
  const current = await tx.maybeOne<{ purchase_id: string; read_by_kind: string }>("select purchase_id, read_by_kind from ops.purchase_receipts where original_id = $1 and status = 'draft' for update", [f.originalId]);
  if (how.mode === "propose" && current !== null && current.read_by_kind === "person") throw refuse("A person is working on this one: its draft was typed or changed by a person, so it cannot be replaced by a proposal.");
  if (how.mode === "correct") {
    if (current === null) throw refuse("There is no draft of this original to correct.");
    if (how.draftId !== null && how.draftId !== current.purchase_id) throw refuse(`This draft was replaced by a newer reading (by ${await whoRead(tx, current.purchase_id)}) since you opened it: open it again.`);
  }
  if (how.mode === "redo" && current !== null) throw refuse("This original already has a live draft.");

  let chosenSupplier: SupplierRef | null = null;
  if (how.mode !== "propose" && how.supplierId !== null) {
    chosenSupplier = await supplierById(tx, how.supplierId);
    if (chosenSupplier === null) throw refuse("No supplier with that id.");
    if (!chosenSupplier.active && how.mode === "correct") throw refuse(`${chosenSupplier.displayName} is no longer an active supplier: choose another, or make it active again on the supplier list.`);
  }
  const chosenBusiness = how.mode === "propose" ? null : how.business;
  const c = await runChecks(tx, f, f.originalId, orig.business, chosenBusiness, chosenSupplier, config, now);
  const needsAttention = c.checks.some((x) => x.passed === false);
  const supersedes = how.mode === "redo" ? null : (current?.purchase_id ?? null);

  const id = newPurchaseId();
  if (supersedes !== null) {
    // The older reading first (the one-live-reading index); superseded_by is checked at commit.
    await tx.query("update ops.purchase_receipts set status = 'superseded', superseded_by = $2, superseded_at = $3 where purchase_id = $1", [supersedes, id, now]);
  }
  await tx.query(
    `insert into ops.purchase_receipts (
       purchase_id, original_id, status, read_by_kind, read_by_key, read_by, read_at,
       business, business_decided_by, business_signs, business_person_said,
       buyer_name, buyer_hst_number, buyer_account_number, buyer_card_last4, suggested_business,
       supplier_id, supplier_name, supplier_name_key, supplier_hst_number, invoice_number, invoice_key,
       receipt_date, receipt_date_text, paid_how, paid_card_last4,
       subtotal, hst, total, other_total, other_charges, hst_rate_percent, kind,
       needs_attention, checks, where_read, reader_note, supersedes, signs_business, signs_decided_by, redo_of)
     values ($1, $2, 'draft', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
             $22::date, $23, $24, $25, $26::numeric, $27::numeric, $28::numeric, $29::numeric, $30, $31::numeric, $32, $33, $34, $35, $36, $37, $38, $39, $40)`,
    [
      id,
      f.originalId,
      reader.kind,
      reader.kind === "assistant" ? reader.keyId : null,
      reader.staffId,
      now,
      c.business,
      c.decidedBy,
      JSON.stringify(c.decision.matched.map((m) => ({ sign_id: m.signId, business: m.business, kind: m.kind, value: m.value, supplier: m.supplier }))),
      orig.business,
      f.buyer.name,
      f.buyer.hstNumber,
      f.buyer.accountNumber,
      f.buyer.cardLast4,
      f.suggested,
      c.supplier?.id ?? null,
      f.supplierName,
      c.supplierKey,
      f.supplierHst,
      f.invoiceNumber,
      c.invoiceKey,
      c.day,
      f.dateText,
      f.paidHow,
      f.paidCard,
      textOrNull(f.subtotal),
      textOrNull(f.hst),
      centsText(f.total),
      textOrNull(c.otherTotal),
      f.other.length === 0 ? null : JSON.stringify(f.other.map((o) => ({ label: o.label, amount: centsText(o.amount) }))),
      quantityText(c.rateMilli),
      f.kind,
      needsAttention,
      JSON.stringify(c.checks),
      f.whereRead === null ? null : JSON.stringify(f.whereRead),
      f.note,
      supersedes,
      c.signsSaid?.business ?? null,
      c.signsSaid?.decidedBy ?? null,
      how.mode === "redo" ? how.voidedId : null,
    ],
  );
  if (f.lines.length > 0) {
    const params: unknown[] = [];
    const values = f.lines.map((l, i) => {
      const at = params.length;
      params.push(id, i + 1, l.description, l.code, l.quantity === null ? null : unitsText(l.quantity, 3), l.unitPrice === null ? null : unitsText(l.unitPrice, 4), textOrNull(l.total), l.taxed);
      return `($${at + 1}, $${at + 2}, $${at + 3}, $${at + 4}, $${at + 5}::numeric, $${at + 6}::numeric, $${at + 7}::numeric, $${at + 8})`;
    });
    await tx.query(`insert into ops.purchase_receipt_lines (purchase_id, line_no, description, item_code, quantity, unit_price, line_total, taxed) values ${values.join(", ")}`, params);
  }
  if (orig.status !== "drafted") await tx.query("update ops.receipt_originals set status = 'drafted' where receipt_id = $1", [f.originalId]);

  const readBy = reader.kind === "assistant" ? { kind: "assistant", keyId: reader.keyId, staffId: reader.staffId } : { kind: "person", staffId: reader.staffId };
  if (supersedes !== null) {
    await audit.write(tx, { actorId: reader.staffId, action: "receipt_draft.supersede", targetType: "purchase_receipts", targetId: supersedes, before: { status: "draft" }, after: { status: "superseded", supersededBy: id } }, { now });
  }
  const action = how.mode === "propose" ? "receipt_draft.create" : how.mode === "correct" ? "receipt_draft.correct" : "receipt_draft.redo";
  await audit.write(
    tx,
    {
      actorId: reader.staffId,
      action,
      targetType: "purchase_receipts",
      targetId: id,
      after: {
        originalId: f.originalId,
        readBy,
        supersedes,
        ...(how.mode === "redo" ? { redoOf: how.voidedId } : {}),
        supplierName: f.supplierName,
        supplierId: c.supplier?.id ?? null,
        invoiceNumber: f.invoiceNumber,
        date: f.dateText,
        subtotal: textOrNull(f.subtotal),
        hst: textOrNull(f.hst),
        otherTotal: textOrNull(c.otherTotal),
        total: centsText(f.total),
        lines: f.lines.length,
        business: c.business,
        decidedBy: c.decidedBy,
        ...(c.signsSaid !== null ? { signsSaid: c.signsSaid } : {}),
        suggestedBusiness: f.suggested,
        needsAttention,
        failed: c.checks.filter((x) => x.passed === false).map((x) => x.check),
        originalStatus: "drafted",
      },
    },
    { now },
  );
  return { draft: await loadDraft(tx, id), replaced: supersedes };
}

/** A stored reading as the input `readFields` takes: to re-run the checks on it, or to copy it (a void's redo). */
export function inputOf(d: DraftView): Record<string, unknown> {
  return {
    original_id: d.originalId ?? "",
    supplier: { name: d.supplier.name, hst_number: d.supplier.hstNumber },
    invoice_number: d.invoiceNumber,
    date: d.dateAsRead,
    paid: d.paid === null ? null : { how: d.paid.how, card_last4: d.paid.cardLast4 },
    amounts: { subtotal: d.amounts.subtotal, hst: d.amounts.hst, total: d.amounts.total, other: d.amounts.other.map((o) => ({ label: o.label, amount: o.amount })) },
    kind: d.kind,
    buyer: { name: d.buyer.name, hst_number: d.buyer.hstNumber, account_number: d.buyer.accountNumber, card_last4: d.buyer.cardLast4 },
    suggested_business: d.suggestedBusiness,
    lines: d.lines.map((l) => ({ description: l.description, code: l.code, quantity: l.quantity, unit_price: l.unitPrice, total: l.total, taxed: l.taxed })),
    where_read: d.whereRead,
    note: d.note,
  };
}

// ── Set aside and put back (called by originals.setAside) ──

/** An original was set aside: its live draft leaves the live list (kept, unchanged), audited. */
export async function takenOut(tx: Tx, originalId: string, actorId: string, now: Date): Promise<void> {
  const d = await tx.maybeOne<{ purchase_id: string }>("select purchase_id from ops.purchase_receipts where original_id = $1 and status = 'draft'", [originalId]);
  if (d === null) return;
  await audit.write(tx, { actorId, action: "receipt_draft.taken_out", targetType: "purchase_receipts", targetId: d.purchase_id, before: { originalStatus: "drafted" }, after: { originalStatus: "set_aside" } }, { now });
}

/** Whether an original being put back has a draft to return to (it is then drafted again), audited. */
export async function restore(tx: Tx, originalId: string, actorId: string, now: Date): Promise<boolean> {
  const d = await tx.maybeOne<{ purchase_id: string }>("select purchase_id from ops.purchase_receipts where original_id = $1 and status = 'draft'", [originalId]);
  if (d === null) return false;
  await audit.write(tx, { actorId, action: "receipt_draft.restored", targetType: "purchase_receipts", targetId: d.purchase_id, before: { originalStatus: "set_aside" }, after: { originalStatus: "drafted" } }, { now });
  return true;
}

// ── What a key's drafts became (my_proposals) ─────────────

export type ProposalStatus = "waiting" | "confirmed" | "refused";
export interface DraftProposal {
  id: string;
  kind: "receipt_draft";
  status: ProposalStatus;
  made_at: string;
  decided_at: string | null;
  note: string;
  /** Only when confirmed (card P5-05b): how many fields the reviewer changed. A number, never the values. */
  fields_changed?: number;
}

/**
 * A key's drafts as proposals, newest first. A draft's fate follows its chain of readings: replaced by
 * another proposal (this key's or another assistant's), it is refused; corrected by a person (card
 * P5-05b: a correction is a new reading that supersedes), it shares the fate of the last reading:
 * waiting for review, confirmed (with how many fields the reviewer changed, compared with the first
 * reading of the original), voided (refused), or its original set aside (refused).
 */
export async function proposals(db: Db, keyId: string, opts: { status?: ProposalStatus | undefined; limit: number }): Promise<DraftProposal[]> {
  const rows = await db.query<{
    purchase_id: string;
    original_id: string | null;
    read_at: Date;
    status: DraftStatus;
    superseded_by: string | null;
    superseded_at: Date | null;
    failed: number;
    original_status: string | null;
    set_aside_at: Date | null;
    new_kind: string | null;
    new_key: string | null;
    last_id: string;
    last_status: DraftStatus;
    last_failed: number;
    confirmed_at: Date | null;
    voided_at: Date | null;
    last_business: Business | null;
    changed: number | null;
    shown: ProposalStatus;
  }>(
    `with recursive walk (start_id, cur_id, depth) as (
         select purchase_id, purchase_id, 0 from ops.purchase_receipts where read_by_key = $1
         union all
         select w.start_id, p.superseded_by, w.depth + 1
           from walk w join ops.purchase_receipts p on p.purchase_id = w.cur_id
          where p.superseded_by is not null and w.depth < 1000),
       last as (select distinct on (start_id) start_id, cur_id from walk order by start_id, depth desc)
     select * from (
       select p.purchase_id, p.original_id, p.read_at, p.status, p.superseded_by, p.superseded_at,
              (select count(*)::int from jsonb_array_elements(p.checks) c where c->>'passed' = 'false') as failed,
              o.status as original_status, o.set_aside_at, n.read_by_kind as new_kind, n.read_by_key as new_key,
              t.purchase_id as last_id, t.status as last_status,
              (select count(*)::int from jsonb_array_elements(t.checks) c where c->>'passed' = 'false') as last_failed,
              t.confirmed_at, t.voided_at, t.business as last_business, (t.review_changes->>'count')::int as changed,
              case when n.read_by_kind = 'assistant' then 'refused'
                   when t.status = 'draft' and o.status = 'set_aside' then 'refused'
                   when t.status = 'draft' then 'waiting'
                   when t.status = 'confirmed' then 'confirmed'
                   else 'refused' end as shown
         from ops.purchase_receipts p
         join last l on l.start_id = p.purchase_id
         join ops.purchase_receipts t on t.purchase_id = l.cur_id
         left join ops.receipt_originals o on o.receipt_id = p.original_id
         left join ops.purchase_receipts n on n.purchase_id = p.superseded_by
        where p.read_by_key = $1) x
      where ($2::text is null or shown = $2)
      order by read_at desc, purchase_id desc
      limit $3`,
    [keyId, opts.status ?? null, opts.limit],
  );
  return rows.map((r) => {
    const base = { id: r.purchase_id, kind: "receipt_draft" as const, status: r.shown, made_at: r.read_at.toISOString() };
    const of = `receipt original ${r.original_id ?? "(none)"}`;
    if (r.status === "superseded" && r.new_kind === "assistant") {
      const by = r.new_key === keyId ? `this key's own later proposal ${r.superseded_by}` : `another assistant's later proposal (${r.superseded_by})`;
      return { ...base, decided_at: r.superseded_at?.toISOString() ?? null, note: `Replaced by ${by}.` };
    }
    const corrected = r.last_id !== r.purchase_id ? ` A person corrected it (${r.last_id}).` : "";
    if (r.shown === "refused" && r.last_status === "draft" && r.original_status === "set_aside") {
      return { ...base, decided_at: r.set_aside_at?.toISOString() ?? null, note: `Its ${of} was set aside by a person (not a receipt): the draft is out of the live list.${corrected}` };
    }
    if (r.last_status === "confirmed") {
      const n = r.changed ?? 0;
      return {
        ...base,
        decided_at: r.confirmed_at?.toISOString() ?? null,
        fields_changed: n,
        note: `Confirmed by a person onto the books of ${r.last_business ?? "(none)"}, from ${of}: ${n === 0 ? "nothing was changed" : `${n} field${n === 1 ? " was" : "s were"} changed`} at review, compared with the first reading of the original.`,
      };
    }
    if (r.last_status === "voided") return { ...base, decided_at: r.voided_at?.toISOString() ?? null, note: `Confirmed, then voided by a person (a mistake found later), from ${of}: it is no longer on the books.` };
    const checks = r.last_failed === 0 ? "All checks passed." : `Needs attention: ${r.last_failed} check${r.last_failed === 1 ? "" : "s"} failed.`;
    return { ...base, decided_at: null, note: `A draft of ${of}, waiting for a person to review it.${corrected} ${checks}` };
  });
}
