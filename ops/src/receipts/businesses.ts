// The two businesses and the signs that identify them on a receipt (card P5-12a). NEW in the Operations
// app (ADR-0023): nothing to port, nothing to compare; ops/test/businesses.test.ts is the specification.
//
// The store is two separate companies (cstore and vape), with separate HST numbers and separate books.
// Each has a legal name, an HST number and a list of SIGNS: what printed on a document says the
// document is that business's.
//
//   name              a trading or billing name as a supplier prints it ("YV Vape Shop Inc.")
//   hst_number        the buyer's HST number as printed (nine digits, RT, four digits)
//   supplier_account  an account or membership number with one supplier (the supplier's name as text)
//   card_last4        the last four digits of a card the business pays with (never more of the number)
//
// A sign is marked removed and kept. One live sign belongs to one business: the same spelling, however it
// is spaced, dashed or cased, cannot be added to the other one (normalise below; the database's partial
// unique index on (kind, value_key) holds it too). Every write takes one advisory lock first, so two
// admins adding the same card to the two businesses at once cannot both succeed, and every write is
// audited. Time is the caller's `now`; ids are random from crypto; SQL takes values as parameters only.
import type { Db } from "../db/client";
import type { Tx } from "../db/tx";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";

export const BUSINESSES = ["cstore", "vape"] as const;
export type Business = (typeof BUSINESSES)[number];
export const SIGN_KINDS = ["name", "hst_number", "supplier_account", "card_last4"] as const;
export type SignKind = (typeof SIGN_KINDS)[number];

export const LEGAL_NAME_MAX = 120;
export const NOTES_MAX = 500;
export const NAME_SIGN_MIN = 2;
export const NAME_SIGN_MAX = 120;
export const ACCOUNT_MAX = 60;
export const SUPPLIER_MIN = 2;
export const SUPPLIER_MAX = 80;

const LOCK = "select pg_advisory_xact_lock(hashtextextended('ops.businesses', 0))";
/** C0 and C1 controls (line breaks and tabs included), U+2028/2029, and the bidirectional overrides and isolates. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** Every dash a keyboard or a PDF may give, and the minus sign. */
const DASHES = /[-‐-―−﹘﹣－]/g;

export const isBusiness = (v: unknown): v is Business => typeof v === "string" && (BUSINESSES as readonly string[]).includes(v);

/**
 * The form two spellings of a sign are compared in: Unicode NFKC (full-width digits become digits), lower
 * case, every white space and every dash removed. "YV Vape-Shop" and "yv vapeshop" are the same name;
 * "1234-5678" and "1234 5678" the same account number. For an account number the supplier counts too:
 * the key is the supplier's key, a bar, then the number's key, so the same number at two suppliers is
 * two signs.
 */
export function normalise(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "").replace(DASHES, "");
}

export function signKey(kind: SignKind, value: string, supplier: string | null): string {
  return kind === "supplier_account" ? `${normalise(supplier ?? "")}|${normalise(value)}` : normalise(value);
}

const HST = /^[0-9]{9}RT[0-9]{4}$/;
export const HST_MESSAGE = "An HST number is nine digits, RT, then four digits, such as 123456789 RT 0001.";

/** Spaces and dashes allowed and dropped, rt in any case: "123456789 rt 0001" is 123456789RT0001. Blank is null. */
export function checkHst(v: unknown): string | null {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  if (typeof v !== "string") throw new Error(HST_MESSAGE);
  const text = v.normalize("NFKC").replace(/\s+/g, "").replace(DASHES, "").toUpperCase();
  if (!HST.test(text)) throw new Error(HST_MESSAGE);
  return text;
}

/** One line of text: trimmed, inner white space kept as single spaces, no control characters, within the limits. */
function checkLine(v: unknown, what: string, min: number, max: number, required: boolean): string | null {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) {
    if (required) throw new Error(`${what} is required.`);
    return null;
  }
  if (typeof v !== "string") throw new Error(`${what} must be text.`);
  if (CONTROL.test(v)) throw new Error(`${what} cannot contain a line break or other control character.`);
  const text = v.trim().replace(/ {2,}/g, " ");
  const n = [...text].length;
  if (n < min) throw new Error(`${what} must be at least ${min} characters.`);
  if (n > max) throw new Error(`${what} can be at most ${max} characters.`);
  return text;
}

function checkNotes(v: unknown): string | null {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return null;
  if (typeof v !== "string") throw new Error("Notes must be text.");
  // Notes may have line breaks; nothing else that is a control character.
  if (/[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/.test(v)) throw new Error("Notes cannot contain control characters.");
  const text = v.trim();
  if ([...text].length > NOTES_MAX) throw new Error(`Notes can be at most ${NOTES_MAX} characters.`);
  return text;
}

function checkBusiness(v: unknown): Business {
  if (!isBusiness(v)) throw new Error("Business must be cstore or vape.");
  return v;
}

const newSignId = (): string => "bs" + Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => b.toString(16).padStart(2, "0")).join("");

// ── Reading ────────────────────────────────────────────────

export interface SignView {
  id: string;
  kind: SignKind;
  value: string;
  supplier: string | null;
  learntFrom: string;
  addedBy: string;
  addedAt: string;
}
export interface BusinessView {
  key: Business;
  /** The setting cstore_business_name / vape_business_name: what the screens call it. */
  displayName: string;
  /** Null until an admin types it. */
  legalName: string | null;
  hstNumber: string | null;
  notes: string | null;
  modifiedBy: string | null;
  modifiedAt: string | null;
  signs: SignView[];
}

interface BusinessRow {
  business: Business;
  legal_name: string | null;
  hst_number: string | null;
  notes: string | null;
  modified_by: string | null;
  modified_by_name: string | null;
  modified_at: Date | null;
}
interface SignRow {
  sign_id: string;
  business: Business;
  kind: SignKind;
  value: string;
  value_key: string;
  supplier: string | null;
  learnt_from: string;
  added_by: string;
  added_by_name: string | null;
  added_at: Date;
  removed_at: Date | null;
}

export const displayName = (config: Config, b: Business): string => config.value(b === "cstore" ? "cstore_business_name" : "vape_business_name");

const SIGN_SELECT = `select g.sign_id, g.business, g.kind, g.value, g.value_key, g.supplier, g.learnt_from, g.added_by, s.name as added_by_name, g.added_at, g.removed_at
                       from ops.business_signs g left join ops.staff s on s.staff_id = g.added_by`;

const signView = (r: SignRow): SignView => ({
  id: r.sign_id,
  kind: r.kind,
  value: r.value,
  supplier: r.supplier,
  learntFrom: r.learnt_from,
  addedBy: (r.added_by_name ?? r.added_by).trim(),
  addedAt: r.added_at.toISOString(),
});

/** Both businesses, cstore first, each with its live signs (oldest first). Two queries. */
export async function list(db: Db, config: Config): Promise<BusinessView[]> {
  const rows = await db.query<BusinessRow>(
    `select b.business, b.legal_name, b.hst_number, b.notes, b.modified_by, s.name as modified_by_name, b.modified_at
       from ops.businesses b left join ops.staff s on s.staff_id = b.modified_by
      order by case b.business when 'cstore' then 0 else 1 end`,
  );
  const signs = await db.query<SignRow>(`${SIGN_SELECT} where g.removed_at is null order by g.added_at, g.sign_id`);
  return rows.map((r) => ({
    key: r.business,
    displayName: displayName(config, r.business),
    legalName: r.legal_name,
    hstNumber: r.hst_number,
    notes: r.notes,
    modifiedBy: r.modified_by === null ? null : (r.modified_by_name ?? r.modified_by).trim(),
    modifiedAt: r.modified_at === null ? null : r.modified_at.toISOString(),
    signs: signs.filter((g) => g.business === r.business).map(signView),
  }));
}

// ── Writing ────────────────────────────────────────────────

export interface Actor {
  staffId: string;
}

interface Stored {
  legalName: string | null;
  hstNumber: string | null;
  notes: string | null;
}

const owner = (config: Config, b: Business): string => `${b} (${displayName(config, b)})`;

/** Who else already uses this HST number: the other business's own number, or a live hst_number sign of it. */
async function hstHolder(tx: Tx, hst: string, besides: Business): Promise<Business | null> {
  const row = await tx.maybeOne<{ business: Business }>(
    `select business from ops.businesses where hst_number = $1 and business <> $2
     union
     select business from ops.business_signs where kind = 'hst_number' and value_key = $3 and removed_at is null and business <> $2
     limit 1`,
    [hst, besides, normalise(hst)],
  );
  return row?.business ?? null;
}

export interface UpdateInput {
  business: unknown;
  legalName?: unknown;
  hstNumber?: unknown;
  notes?: unknown;
}

/** Change a business's legal name, HST number or notes. A field left out is kept. Answers the business and whether anything changed. */
export async function update(tx: Tx, input: UpdateInput, actor: Actor, config: Config, now: Date): Promise<{ business: BusinessView; changed: boolean }> {
  const b = checkBusiness(input.business);
  await tx.query(LOCK);
  const row = await tx.one<{ legal_name: string | null; hst_number: string | null; notes: string | null }>(
    "select legal_name, hst_number, notes from ops.businesses where business = $1 for update",
    [b],
  );
  const before: Stored = { legalName: row.legal_name, hstNumber: row.hst_number, notes: row.notes };
  const after: Stored = {
    legalName: input.legalName === undefined ? before.legalName : checkLine(input.legalName, "The legal name", 2, LEGAL_NAME_MAX, false),
    hstNumber: input.hstNumber === undefined ? before.hstNumber : checkHst(input.hstNumber),
    notes: input.notes === undefined ? before.notes : checkNotes(input.notes),
  };
  if (after.hstNumber !== null && after.hstNumber !== before.hstNumber) {
    const other = await hstHolder(tx, after.hstNumber, b);
    if (other !== null) throw new Error(`That HST number already belongs to ${owner(config, other)}. The two businesses have separate HST numbers.`);
  }
  const changed = after.legalName !== before.legalName || after.hstNumber !== before.hstNumber || after.notes !== before.notes;
  if (changed) {
    await tx.query("update ops.businesses set legal_name = $2, hst_number = $3, notes = $4, modified_by = $5, modified_at = $6 where business = $1", [
      b,
      after.legalName,
      after.hstNumber,
      after.notes,
      actor.staffId,
      now,
    ]);
    await audit.write(tx, { actorId: actor.staffId, action: "business.update", targetType: "businesses", targetId: b, before, after }, { now });
  }
  const view = (await list(tx, config)).find((x) => x.key === b) as BusinessView;
  return { business: view, changed };
}

export interface AddSignInput {
  business: unknown;
  kind: unknown;
  value: unknown;
  supplier?: unknown;
}

/** The sign as a person reads it: "the card ending 1234". */
export function describeSign(kind: SignKind, value: string, supplier: string | null): string {
  if (kind === "card_last4") return `the card ending ${value}`;
  if (kind === "hst_number") return `the HST number ${value}`;
  if (kind === "supplier_account") return `account ${value} at ${supplier ?? ""}`;
  return `the name "${value}"`;
}

function checkSign(input: AddSignInput): { kind: SignKind; value: string; supplier: string | null } {
  const kind = input.kind;
  if (typeof kind !== "string" || !(SIGN_KINDS as readonly string[]).includes(kind)) throw new Error("The kind of sign must be name, hst_number, supplier_account or card_last4.");
  switch (kind as SignKind) {
    case "name":
      return { kind: "name", value: checkLine(input.value, "The name", NAME_SIGN_MIN, NAME_SIGN_MAX, true) as string, supplier: null };
    case "hst_number": {
      const v = checkHst(input.value);
      if (v === null) throw new Error(HST_MESSAGE);
      return { kind: "hst_number", value: v, supplier: null };
    }
    case "card_last4": {
      const v = typeof input.value === "string" ? input.value.trim() : typeof input.value === "number" ? String(input.value) : "";
      if (!/^[0-9]{4}$/.test(v)) throw new Error("A card is given by its last four digits only: exactly four digits, such as 4821.");
      return { kind: "card_last4", value: v, supplier: null };
    }
    case "supplier_account": {
      const value = checkLine(input.value, "The account number", 1, ACCOUNT_MAX, true) as string;
      const supplier = checkLine(input.supplier, "The supplier's name", SUPPLIER_MIN, SUPPLIER_MAX, true) as string;
      return { kind: "supplier_account", value, supplier };
    }
  }
}

/** Add a sign to a business. Refused, naming the other business, when that sign is already the other one's. */
export async function addSign(tx: Tx, input: AddSignInput, actor: Actor, config: Config, now: Date): Promise<{ sign: SignView; business: BusinessView }> {
  const b = checkBusiness(input.business);
  const sign = checkSign(input);
  const key = signKey(sign.kind, sign.value, sign.supplier);
  if (key === "" || key === "|") throw new Error("That sign has nothing in it to compare.");
  await tx.query(LOCK);
  const taken = await tx.maybeOne<{ business: Business }>("select business from ops.business_signs where kind = $1 and value_key = $2 and removed_at is null", [sign.kind, key]);
  const what = describeSign(sign.kind, sign.value, sign.supplier);
  if (taken !== null && taken.business !== b) throw new Error(`${capital(what)} already belongs to ${owner(config, taken.business)}. A sign can belong to one business only: remove it there first.`);
  if (taken !== null) throw new Error(`${capital(what)} is already listed for ${b}.`);
  if (sign.kind === "hst_number") {
    const other = await hstHolder(tx, sign.value, b);
    if (other !== null) throw new Error(`${capital(what)} already belongs to ${owner(config, other)}. A sign can belong to one business only.`);
  }
  const id = newSignId();
  await tx.query(
    `insert into ops.business_signs (sign_id, business, kind, value, value_key, supplier, learnt_from, added_by, added_at)
     values ($1, $2, $3, $4, $5, $6, 'typed', $7, $8)`,
    [id, b, sign.kind, sign.value, key, sign.supplier, actor.staffId, now],
  );
  await audit.write(tx, { actorId: actor.staffId, action: "business_sign.add", targetType: "business_signs", targetId: id, after: { business: b, kind: sign.kind, value: sign.value, supplier: sign.supplier } }, { now });
  const view = (await list(tx, config)).find((x) => x.key === b) as BusinessView;
  return { sign: view.signs.find((s) => s.id === id) as SignView, business: view };
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Remove a sign (it stays in the table, marked removed). Removing it again changes nothing. */
export async function removeSign(tx: Tx, input: { id: unknown }, actor: Actor, config: Config, now: Date): Promise<{ removed: boolean; business: BusinessView }> {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  await tx.query(LOCK);
  const row = id === "" ? null : await tx.maybeOne<SignRow>(`${SIGN_SELECT} where g.sign_id = $1 for update of g`, [id]);
  if (row === null) throw new Error("No such sign.");
  let removed = false;
  if (row.removed_at === null) {
    await tx.query("update ops.business_signs set removed_by = $2, removed_at = $3 where sign_id = $1", [id, actor.staffId, now]);
    await audit.write(tx, { actorId: actor.staffId, action: "business_sign.remove", targetType: "business_signs", targetId: id, before: { business: row.business, kind: row.kind, value: row.value, supplier: row.supplier } }, { now });
    removed = true;
  }
  const view = (await list(tx, config)).find((x) => x.key === row.business) as BusinessView;
  return { removed, business: view };
}
