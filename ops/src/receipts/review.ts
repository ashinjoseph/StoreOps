// Reviewing a receipt draft: correct, confirm, void (card P5-05b; ADR-0029). NEW in the Operations app
// (ADR-0023); ops/test/receipt-review.test.ts is the specification.
//
// A person (admin or manager) looks at an original beside the figures read off it, corrects what is wrong,
// settles the business and the supplier, and CONFIRMS: the receipt is then a line in one business's books.
// The rules:
//   - A correction never changes a row: it is a new reading by the person that supersedes the live draft
//     (drafts.writeReading, mode correct), and the checks and the business decision are run again by the
//     same pure functions. As often as the person likes before confirming.
//   - Confirm needs a total, a receipt date that is a real day, a kind, a business and an active supplier.
//     The checks are re-run on the figures confirmed; when any fails, a reason (3 to 300 characters, one
//     line) is stored with the ids of the failing checks. A duplicate of a receipt already CONFIRMED (the
//     same supplier and invoice number, either business) is confirmed only by an admin.
//   - A confirmed receipt is final (the database role cannot change it: column grants and a trigger, 0014).
//     Its original is confirmed and leaves the review. A mistake is VOIDED (admin or manager, a reason):
//     kept, marked, in every list; its original goes back to review with a new draft copied from it.
//   - Learning: at confirm, each piece of buyer evidence printed and not yet a sign is OFFERED, unticked,
//     and added only by an admin's tick, through the Businesses card's own addSign (learnt_from
//     confirmed_receipt). The printed supplier name is offered (ticked) as a spelling of the chosen
//     supplier. Nothing learnt is removed by a void: the void lists it.
//   - What was changed: the confirmed reading compared field by field with the FIRST reading of the
//     original (compareReadings, pure), stored on the receipt.
//   - The books: one business at a time, never both; totals in exact decimals by the database.
// Identity and role come from the caller (the session); time is the caller's `now`; SQL takes values as
// parameters only; nothing is removed; every write is audited (figures, never the original's bytes).
// Locks: every reading, confirm and void takes the drafts' advisory lock, then the original's row (or the
// receipt's row); supplier and spelling writes take the suppliers' advisory lock; signs the Businesses one.
import type { Db } from "../db/client";
import type { Tx } from "../db/tx";
import * as audit from "../lib/audit";
import type { Config } from "../lib/config";
import { type Business, type SignKind, type SignView, SIGN_KINDS, addSign, checkHst, checkLine, checkNotes, checkSign, describeSign, displayName, isBusiness, normalise, signKey } from "./businesses";
import * as costs from "./costs";
import * as drafts from "./drafts";

export const REVIEW_ROLES: readonly string[] = ["admin", "manager"];
export const READ_ROLES: readonly string[] = ["admin", "manager", "payroll_admin"];
export const REASON_MIN = 3;
export const REASON_MAX = 300;
export const PAGE_MAX = 50;
export const PAGE_DEFAULT = 20;
export const SUPPLIER_NAME_MAX = 120;

export interface Actor {
  staffId: string;
  role: string;
}

const ORIGINAL_ID = /^ro[0-9a-f]{24}$/;
const PURCHASE_ID = /^pr[0-9a-f]{24}$/;
const SUPPLIER_ID = /^sp[0-9a-f]{20}$/;
export const SUPPLIER_LOCK = "select pg_advisory_xact_lock(hashtextextended('ops.suppliers', 0))";
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// eslint-disable-next-line no-control-regex
const DIRECTION = /[\u202a-\u202e\u2066-\u2069]/g;

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const newSupplierId = (): string => "sp" + hex(crypto.getRandomValues(new Uint8Array(10)));
const newNameId = (): string => "sn" + hex(crypto.getRandomValues(new Uint8Array(10)));
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const and = (parts: string[]): string => (parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);
const not = (what: string) => (message: string): Error => new Error(`${message} Nothing was ${what}.`);
const notConfirmed = not("confirmed");
const notVoided = not("voided");

function mayReview(actor: Actor): void {
  if (!REVIEW_ROLES.includes(actor.role)) throw new Error("Only an admin or a manager can review, confirm or void a receipt.");
}

/** A reason a person gives: one line, 3 to 300 characters, white space made single. */
function cleanReason(raw: unknown, tooShort: string, fail: (m: string) => Error): string {
  const text = typeof raw === "string" ? raw : "";
  if (CONTROL.test(text)) throw fail("The reason cannot contain a line break or other control character.");
  const reason = text.replace(DIRECTION, "").trim().replace(/\s+/g, " ");
  const n = [...reason].length;
  if (n < REASON_MIN || n > REASON_MAX) throw fail(tooShort);
  return reason;
}

// ── What was changed (decision 8; pure) ───────────────────

/**
 * The fields compared, in this order, with the names the input uses. Money and the line's quantity and
 * unit price are compared as numbers (12.5 is 12.50); text exactly as stored (cleaned); a blank is null:
 * blank to a value is a change, a value to the same value is not. The note and the where-read phrases
 * are the reader's own words and are not compared.
 */
export const COMPARED_FIELDS = [
  "supplier.name",
  "supplier.hst_number",
  "invoice_number",
  "date",
  "paid.how",
  "paid.card_last4",
  "amounts.subtotal",
  "amounts.hst",
  "amounts.other",
  "amounts.total",
  "kind",
  "buyer.name",
  "buyer.hst_number",
  "buyer.account_number",
  "buyer.card_last4",
  "business",
  "supplier",
] as const;
const MONEY_FIELDS: readonly string[] = ["amounts.subtotal", "amounts.hst", "amounts.total"];

export interface Changes {
  /** The reading compared with: the first reading of the original. */
  comparedWith: string;
  fields: Array<{ field: string; before: string | null; after: string | null }>;
  lines: { added: number; removed: number; changed: number };
  /** fields + lines added + removed + changed. */
  count: number;
}

const moneyOut = (v: string | null): string | null => {
  if (v === null) return null;
  const c = drafts.parseMoney(v);
  return c === null ? v : drafts.centsText(c);
};

function valueOf(d: drafts.DraftView, field: (typeof COMPARED_FIELDS)[number]): string | null {
  switch (field) {
    case "supplier.name":
      return d.supplier.name;
    case "supplier.hst_number":
      return d.supplier.hstNumber;
    case "invoice_number":
      return d.invoiceNumber;
    case "date":
      return d.dateAsRead;
    case "paid.how":
      return d.paid?.how ?? null;
    case "paid.card_last4":
      return d.paid?.cardLast4 ?? null;
    case "amounts.subtotal":
      return moneyOut(d.amounts.subtotal);
    case "amounts.hst":
      return moneyOut(d.amounts.hst);
    case "amounts.other":
      return d.amounts.other.length === 0 ? null : d.amounts.other.map((o) => `${o.label} ${moneyOut(o.amount)}`).join("; ");
    case "amounts.total":
      return moneyOut(d.amounts.total);
    case "kind":
      return d.kind;
    case "buyer.name":
      return d.buyer.name;
    case "buyer.hst_number":
      return d.buyer.hstNumber;
    case "buyer.account_number":
      return d.buyer.accountNumber;
    case "buyer.card_last4":
      return d.buyer.cardLast4;
    case "business":
      return d.business.key;
    case "supplier":
      return d.supplier.id;
  }
}

const sameNumber = (a: string | null, b: string | null, parse: (v: unknown) => number | null): boolean => (a === null || b === null ? a === b : parse(a) === parse(b));

/** What differs between the first reading and the last (pure): field by field for the header, a count for the lines. */
export function compareReadings(first: drafts.DraftView, last: drafts.DraftView): Changes {
  const fields: Changes["fields"] = [];
  for (const f of COMPARED_FIELDS) {
    const before = valueOf(first, f);
    const after = valueOf(last, f);
    const same = MONEY_FIELDS.includes(f) ? sameNumber(before, after, drafts.parseMoney) : before === after;
    if (!same) fields.push({ field: f, before, after });
  }
  const a = first.lines;
  const b = last.lines;
  let changed = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i] as drafts.DraftView["lines"][number];
    const y = b[i] as drafts.DraftView["lines"][number];
    const same =
      x.description === y.description &&
      x.code === y.code &&
      x.taxed === y.taxed &&
      sameNumber(x.quantity, y.quantity, drafts.parseQuantity) &&
      sameNumber(x.unitPrice, y.unitPrice, drafts.parseUnitPrice) &&
      sameNumber(x.total, y.total, drafts.parseMoney);
    if (!same) changed++;
  }
  const lines = { added: Math.max(b.length - a.length, 0), removed: Math.max(a.length - b.length, 0), changed };
  return { comparedWith: first.id, fields, lines, count: fields.length + lines.added + lines.removed + lines.changed };
}

// ── Suppliers ─────────────────────────────────────────────

export interface SupplierView {
  id: string;
  displayName: string;
  hstNumber: string | null;
  notes: string | null;
  active: boolean;
  spellings: Array<{ name: string; learntFrom: string }>;
  /** How many receipts on the books (confirmed) name it. */
  receipts: number;
}

async function supplierViews(db: Db, ids: readonly string[]): Promise<SupplierView[]> {
  if (ids.length === 0) return [];
  const rows = await db.query<{ supplier_id: string; display_name: string; hst_number: string | null; notes: string | null; active: boolean; receipts: number }>(
    `select s.supplier_id, s.display_name, s.hst_number, s.notes, s.active,
            (select count(*)::int from ops.purchase_receipts p where p.supplier_id = s.supplier_id and p.status = 'confirmed') as receipts
       from ops.suppliers s where s.supplier_id = any($1::text[])`,
    [ids],
  );
  const names = await db.query<{ supplier_id: string; name: string; learnt_from: string }>(
    "select supplier_id, name, learnt_from from ops.supplier_names where supplier_id = any($1::text[]) and removed_at is null order by added_at, name_id",
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.supplier_id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (r === undefined) return [];
    return [{ id, displayName: r.display_name, hstNumber: r.hst_number, notes: r.notes, active: r.active, spellings: names.filter((n) => n.supplier_id === id).map((n) => ({ name: n.name, learntFrom: n.learnt_from })), receipts: r.receipts }];
  });
}

const likeOf = (key: string): string => `%${key.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Suppliers, by name, a page at a time; `q` matches any live spelling or the display name, in the normal form. Active ones only unless `includeInactive`. */
export async function listSuppliers(db: Db, input: { q?: unknown; after?: unknown; limit?: unknown; includeInactive?: unknown }): Promise<{ suppliers: SupplierView[]; next: string | null }> {
  const q = typeof input.q === "string" ? normalise(input.q.slice(0, 200)) : "";
  const limitIn = typeof input.limit === "number" && Number.isInteger(input.limit) ? input.limit : PAGE_DEFAULT;
  const limit = Math.min(Math.max(limitIn, 1), PAGE_MAX);
  const after = typeof input.after === "string" && SUPPLIER_ID.test(input.after) ? input.after : null;
  const rows = await db.query<{ supplier_id: string }>(
    `select s.supplier_id from ops.suppliers s
      where ($1::boolean or s.active)
        and ($2::text = '' or coalesce(s.display_key, lower(s.display_name)) like $3 escape '\\'
             or exists (select 1 from ops.supplier_names n where n.supplier_id = s.supplier_id and n.removed_at is null and n.name_key like $3 escape '\\'))
        and ($4::text is null or (lower(s.display_name), s.supplier_id) > (select lower(display_name), supplier_id from ops.suppliers where supplier_id = $4))
      order by lower(s.display_name), s.supplier_id
      limit $5`,
    [input.includeInactive === true, q, likeOf(q), after, limit + 1],
  );
  const page = rows.slice(0, limit).map((r) => r.supplier_id);
  return { suppliers: await supplierViews(db, page), next: rows.length > limit ? (page[page.length - 1] ?? null) : null };
}

async function activeWithKey(tx: Tx, key: string, besides: string | null): Promise<string | null> {
  const rows = await tx.query<{ supplier_id: string; display_name: string; display_key: string | null }>("select supplier_id, display_name, display_key from ops.suppliers where active and supplier_id is distinct from $1", [besides]);
  const hit = rows.find((r) => (r.display_key ?? normalise(r.display_name)) === key);
  return hit?.display_name ?? null;
}

/** Add a spelling to a supplier, unless it is one already. Refused, naming the other, when it is another supplier's. */
export async function addSpelling(tx: Tx, supplier: { id: string; displayName: string }, name: string, actor: Actor, now: Date, receiptId: string | null, fail: (m: string) => Error, learntFrom?: "old_list"): Promise<boolean> {
  const key = normalise(name);
  if (key === "") return false;
  await tx.query(SUPPLIER_LOCK);
  const taken = await tx.maybeOne<{ supplier_id: string; display_name: string }>(
    "select n.supplier_id, s.display_name from ops.supplier_names n join ops.suppliers s on s.supplier_id = n.supplier_id where n.name_key = $1 and n.removed_at is null",
    [key],
  );
  if (taken !== null && taken.supplier_id === supplier.id) return false;
  if (taken !== null) throw fail(`"${name}" is already a spelling of ${taken.display_name}: a spelling belongs to one supplier. Untick it.`);
  const id = newNameId();
  const learnt = learntFrom ?? (receiptId === null ? "typed" : "confirmed_receipt");
  await tx.query(
    "insert into ops.supplier_names (name_id, supplier_id, name, name_key, learnt_from, added_by, added_at, learnt_from_receipt) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [id, supplier.id, name, key, learnt, actor.staffId, now, receiptId],
  );
  await audit.write(tx, { actorId: actor.staffId, action: "supplier_name.add", targetType: "supplier_names", targetId: id, after: { supplierId: supplier.id, name, learntFrom: learnt, receiptId } }, { now });
  return true;
}

const supplierName = (v: unknown): string => checkLine(v, "The supplier's name", 2, SUPPLIER_NAME_MAX, true) as string;

/** A new supplier (admin or manager): a display name unique among active suppliers (case and spaces ignored), an optional HST number and notes. Its name is its first spelling when free. */
export async function createSupplier(tx: Tx, input: { displayName?: unknown; hstNumber?: unknown; notes?: unknown }, actor: Actor, now: Date): Promise<{ supplier: SupplierView }> {
  mayReview(actor);
  const name = supplierName(input.displayName);
  const hstNumber = checkHst(input.hstNumber);
  const notes = checkNotes(input.notes);
  const key = normalise(name);
  await tx.query(SUPPLIER_LOCK);
  const clash = await activeWithKey(tx, key, null);
  if (clash !== null) throw new Error(`There is already an active supplier called "${clash}".`);
  const id = newSupplierId();
  await tx.query("insert into ops.suppliers (supplier_id, display_name, display_key, hst_number, notes, active, created_by, created_at) values ($1, $2, $3, $4, $5, true, $6, $7)", [id, name, key, hstNumber, notes, actor.staffId, now]);
  await audit.write(tx, { actorId: actor.staffId, action: "supplier.create", targetType: "suppliers", targetId: id, after: { displayName: name, hstNumber, notes } }, { now });
  const free = (await tx.maybeOne<{ n: number }>("select 1 as n from ops.supplier_names where name_key = $1 and removed_at is null", [key])) === null;
  if (free) await addSpelling(tx, { id, displayName: name }, name, actor, now, null, (m) => new Error(m));
  return { supplier: (await supplierViews(tx, [id]))[0] as SupplierView };
}

/** Change a supplier's name, HST number, notes or whether it is active (admin or manager). Never removed: a supplier no longer used is made inactive. */
export async function updateSupplier(tx: Tx, input: { id?: unknown; displayName?: unknown; hstNumber?: unknown; notes?: unknown; active?: unknown }, actor: Actor, now: Date): Promise<{ supplier: SupplierView; changed: boolean }> {
  mayReview(actor);
  await tx.query(SUPPLIER_LOCK);
  const row =
    typeof input.id === "string" && SUPPLIER_ID.test(input.id)
      ? await tx.maybeOne<{ supplier_id: string; display_name: string; hst_number: string | null; notes: string | null; active: boolean }>("select supplier_id, display_name, hst_number, notes, active from ops.suppliers where supplier_id = $1 for update", [input.id])
      : null;
  if (row === null) throw new Error("No such supplier.");
  if (input.active !== undefined && typeof input.active !== "boolean") throw new Error("active must be true or false.");
  const before = { displayName: row.display_name, hstNumber: row.hst_number, notes: row.notes, active: row.active };
  const after = {
    displayName: input.displayName === undefined ? before.displayName : supplierName(input.displayName),
    hstNumber: input.hstNumber === undefined ? before.hstNumber : checkHst(input.hstNumber),
    notes: input.notes === undefined ? before.notes : checkNotes(input.notes),
    active: input.active === undefined ? before.active : (input.active as boolean),
  };
  if (after.active && (after.displayName !== before.displayName || !before.active)) {
    const clash = await activeWithKey(tx, normalise(after.displayName), row.supplier_id);
    if (clash !== null) throw new Error(`There is already an active supplier called "${clash}".`);
  }
  const changed = after.displayName !== before.displayName || after.hstNumber !== before.hstNumber || after.notes !== before.notes || after.active !== before.active;
  if (changed) {
    await tx.query("update ops.suppliers set display_name = $2, display_key = $3, hst_number = $4, notes = $5, active = $6 where supplier_id = $1", [row.supplier_id, after.displayName, normalise(after.displayName), after.hstNumber, after.notes, after.active]);
    await audit.write(tx, { actorId: actor.staffId, action: "supplier.update", targetType: "suppliers", targetId: row.supplier_id, before, after }, { now });
  }
  return { supplier: (await supplierViews(tx, [row.supplier_id]))[0] as SupplierView, changed };
}

// ── What the review offers to learn (decision 5, 6) ───────

export interface SignOffer {
  /** kind:value_key, what the page sends back when ticked. */
  id: string;
  kind: SignKind;
  value: string;
  supplier: string | null;
  words: string;
  /** Never ticked by default. */
  ticked: false;
}
export interface SignOffers {
  business: Business | null;
  offers: SignOffer[];
  /** Evidence that is already a sign of the OTHER business: never offered. */
  warnings: Array<{ kind: SignKind; value: string; supplier: string | null; business: Business; words: string }>;
  /** Evidence that is already a sign of this business. */
  known: Array<{ kind: SignKind; value: string; supplier: string | null; words: string }>;
}

/** The buyer evidence printed on a reading, as candidate signs (the Businesses card's own rules), in SIGN_KINDS order. */
function evidenceOf(d: drafts.DraftView): Array<{ kind: SignKind; value: string; supplier: string | null; key: string }> {
  const raw: Array<{ kind: SignKind; value: string | null; supplier: string | null }> = [
    { kind: "name", value: d.buyer.name, supplier: null },
    { kind: "hst_number", value: d.buyer.hstNumber, supplier: null },
    { kind: "supplier_account", value: d.buyer.accountNumber, supplier: d.supplier.name },
    { kind: "card_last4", value: d.buyer.cardLast4, supplier: null },
    { kind: "card_last4", value: d.paid?.cardLast4 ?? null, supplier: null },
  ];
  const out: Array<{ kind: SignKind; value: string; supplier: string | null; key: string }> = [];
  for (const kind of SIGN_KINDS) {
    for (const e of raw.filter((r) => r.kind === kind && r.value !== null)) {
      let sign: { kind: SignKind; value: string; supplier: string | null };
      try {
        sign = checkSign({ business: "cstore", kind: e.kind, value: e.value, supplier: e.supplier });
      } catch {
        continue;
      }
      const key = signKey(sign.kind, sign.value, sign.supplier);
      if (key === "" || key === "|" || out.some((o) => o.kind === sign.kind && o.key === key)) continue;
      out.push({ ...sign, key });
    }
  }
  return out;
}

export async function signOffers(db: Db, d: drafts.DraftView, business: Business | null): Promise<SignOffers> {
  const result: SignOffers = { business, offers: [], warnings: [], known: [] };
  if (business === null) return result;
  const live = await drafts.liveSigns(db);
  for (const e of evidenceOf(d)) {
    const what = describeSign(e.kind, e.value, e.supplier);
    const sign = live.find((s) => s.kind === e.kind && s.valueKey === e.key);
    if (sign !== undefined && sign.business === business) result.known.push({ kind: e.kind, value: e.value, supplier: e.supplier, words: `${capital(what)} is already a sign of ${business}.` });
    else if (sign !== undefined) result.warnings.push({ kind: e.kind, value: e.value, supplier: e.supplier, business: sign.business, words: `${capital(what)} is a sign of ${sign.business}: it cannot be added to ${business}.` });
    else result.offers.push({ id: `${e.kind}:${e.key}`, kind: e.kind, value: e.value, supplier: e.supplier, words: `Remember ${what} as a sign of ${business}`, ticked: false });
  }
  return result;
}

export interface SpellingOffer {
  name: string;
  /** Offered (and ticked by default) when the printed name is not yet a spelling of anyone. */
  offered: boolean;
  ticked: boolean;
  /** The other supplier it is a spelling of already, if any. */
  belongsTo: { id: string; displayName: string } | null;
  words: string;
}

export async function spellingOffer(db: Db, d: drafts.DraftView): Promise<SpellingOffer | null> {
  if (d.supplier.name === null || d.supplier.id === null) return null;
  const key = normalise(d.supplier.name);
  if (key === "") return null;
  const listed = d.supplier.listedName ?? d.supplier.id;
  const taken = await db.maybeOne<{ supplier_id: string; display_name: string }>(
    "select n.supplier_id, s.display_name from ops.supplier_names n join ops.suppliers s on s.supplier_id = n.supplier_id where n.name_key = $1 and n.removed_at is null",
    [key],
  );
  if (taken !== null && taken.supplier_id === d.supplier.id) return { name: d.supplier.name, offered: false, ticked: false, belongsTo: null, words: `"${d.supplier.name}" is already a known spelling of ${listed}.` };
  if (taken !== null) return { name: d.supplier.name, offered: false, ticked: false, belongsTo: { id: taken.supplier_id, displayName: taken.display_name }, words: `"${d.supplier.name}" is a spelling of ${taken.display_name}: a spelling belongs to one supplier.` };
  return { name: d.supplier.name, offered: true, ticked: true, belongsTo: null, words: `Remember "${d.supplier.name}" as a spelling of ${listed}` };
}

// ── Preparing a confirm: the checks re-run, what is missing, who may ──

export interface ConfirmState {
  allowed: boolean;
  /** Why this caller may not confirm it now (besides what is missing). */
  why: string[];
  /** Decision 3: what must be settled first, in words. */
  missing: string[];
  checks: drafts.CheckResult[];
  failed: drafts.CheckResult[];
  reasonNeeded: boolean;
  /** A duplicate of a receipt on the books: only an admin may confirm it. */
  adminOnly: boolean;
}

interface Prepared {
  state: ConfirmState;
  checked: drafts.Checked;
  offers: SignOffers;
  spelling: SpellingOffer | null;
  supplier: drafts.SupplierRef | null;
}

const DUPLICATE_WHY = "It duplicates a receipt already on the books: only an admin can confirm it, with a reason.";
const DRIFT = "A sign changed since this draft was saved, so the business would be decided differently: save the corrections again.";

async function prepare(db: Db, d: drafts.DraftView, actor: Actor, config: Config, now: Date): Promise<Prepared> {
  const f = drafts.readFields(drafts.inputOf(d));
  const chosen = d.business.decidedBy[0] === "person" ? d.business.key : null;
  const supplier = d.supplier.id === null ? null : await drafts.supplierById(db, d.supplier.id);
  const checked = await drafts.runChecks(db, f, d.originalId ?? "", d.business.personSaid, chosen, supplier, config, now);
  const missing: string[] = [];
  if (checked.day === null) missing.push("the receipt date");
  if (d.kind === null) missing.push("the kind of purchase");
  if (d.business.key === null) missing.push("the business");
  if (supplier === null) missing.push("the supplier");
  const why: string[] = [];
  if (!REVIEW_ROLES.includes(actor.role)) why.push("Only an admin or a manager can confirm.");
  if (supplier !== null && !supplier.active) why.push(`${supplier.displayName} is no longer an active supplier: choose another, or make it active again on the supplier list.`);
  if (d.business.key !== null && checked.business !== d.business.key) why.push(DRIFT);
  const failed = checked.checks.filter((c) => c.passed === false);
  const adminOnly = failed.some((c) => c.check === "duplicate") && checked.duplicates.some((m) => m.sameInvoice && m.status === "confirmed");
  if (adminOnly && actor.role !== "admin") why.push(DUPLICATE_WHY);
  const state: ConfirmState = { allowed: missing.length === 0 && why.length === 0, why, missing, checks: checked.checks, failed, reasonNeeded: failed.length > 0, adminOnly };
  return { state, checked, offers: await signOffers(db, d, d.business.key), spelling: await spellingOffer(db, d), supplier };
}

// ── The review sheet ──────────────────────────────────────

async function firstReading(db: Db, originalId: string): Promise<drafts.DraftView | null> {
  const row = await db.maybeOne<{ purchase_id: string }>("select purchase_id from ops.purchase_receipts where original_id = $1 order by read_at, purchase_id limit 1", [originalId]);
  return row === null ? null : drafts.loadDraft(db, row.purchase_id);
}

async function readingsOf(db: Db, originalId: string): Promise<Array<{ id: string; status: string; readBy: { kind: string; name: string; keyLabel: string | null }; readAt: string }>> {
  const rows = await db.query<{ purchase_id: string; status: string; read_by_kind: string; name: string | null; read_by: string; label: string | null; read_at: Date }>(
    `select p.purchase_id, p.status, p.read_by_kind, st.name, p.read_by, ak.label, p.read_at
       from ops.purchase_receipts p left join ops.staff st on st.staff_id = p.read_by left join ops.assistant_keys ak on ak.key_id = p.read_by_key
      where p.original_id = $1 order by p.read_at, p.purchase_id`,
    [originalId],
  );
  return rows.map((r) => ({ id: r.purchase_id, status: r.status, readBy: { kind: r.read_by_kind, name: (r.name ?? r.read_by).trim(), keyLabel: r.read_by_kind === "assistant" ? (r.label ?? null) : null }, readAt: r.read_at.toISOString() }));
}

export interface ReviewView {
  original: { id: string; status: string; business: Business | null; contentType: string; fileName: string | null; addedBy: string; addedAt: string };
  draft: drafts.DraftView | null;
  first: drafts.DraftView | null;
  changes: Changes | null;
  readings: Awaited<ReturnType<typeof readingsOf>>;
  supplierCandidates: SupplierView[];
  signOffers: SignOffers | null;
  spelling: SpellingOffer | null;
  confirm: ConfirmState | null;
  canEdit: boolean;
  canLearnSigns: boolean;
  /** The receipt on the books of a confirmed original. */
  onBooks: { id: string; business: Business | null } | null;
  businessNames: Record<Business, string>;
}

const businessNames = (config: Config): Record<Business, string> => ({ cstore: displayName(config, "cstore"), vape: displayName(config, "vape") });

/** Everything the review sheet shows for one original (admin, manager, payroll admin). */
export async function getReview(db: Db, originalId: unknown, actor: Actor, config: Config, now: Date): Promise<ReviewView> {
  if (!READ_ROLES.includes(actor.role)) throw new Error("Only an admin, a manager or a payroll admin can see a receipt's review.");
  const id = typeof originalId === "string" && ORIGINAL_ID.test(originalId) ? originalId : null;
  const o =
    id === null
      ? null
      : await db.maybeOne<{ receipt_id: string; status: string; business: Business | null; content_type: string; file_name: string | null; added_by: string; name: string | null; added_at: Date }>(
          "select o.receipt_id, o.status, o.business, o.content_type, o.file_name, o.added_by, st.name, o.added_at from ops.receipt_originals o left join ops.staff st on st.staff_id = o.added_by where o.receipt_id = $1",
          [id],
        );
  if (o === null) throw new Error("No such receipt original.");
  const draft = await drafts.getDraft(db, o.receipt_id);
  const first = await firstReading(db, o.receipt_id);
  const onBooks = await db.maybeOne<{ purchase_id: string; business: Business | null }>("select purchase_id, business from ops.purchase_receipts where original_id = $1 and status = 'confirmed'", [o.receipt_id]);
  const p = draft === null ? null : await prepare(db, draft, actor, config, now);
  const candidates: string[] = [];
  if (draft?.supplier.id) candidates.push(draft.supplier.id);
  if (draft?.supplier.name) for (const s of (await listSuppliers(db, { q: draft.supplier.name, limit: 8 })).suppliers) if (!candidates.includes(s.id)) candidates.push(s.id);
  return {
    original: { id: o.receipt_id, status: o.status, business: o.business, contentType: o.content_type, fileName: o.file_name, addedBy: (o.name ?? o.added_by).trim(), addedAt: o.added_at.toISOString() },
    draft,
    first,
    changes: draft !== null && first !== null ? compareReadings(first, draft) : null,
    readings: await readingsOf(db, o.receipt_id),
    supplierCandidates: await supplierViews(db, candidates),
    signOffers: p?.offers ?? null,
    spelling: p?.spelling ?? null,
    confirm: p?.state ?? null,
    canEdit: REVIEW_ROLES.includes(actor.role) && draft !== null,
    canLearnSigns: actor.role === "admin",
    onBooks: onBooks === null ? null : { id: onBooks.purchase_id, business: onBooks.business },
    businessNames: businessNames(config),
  };
}

// ── Saving a correction (decision 2) ───────────────────────

/**
 * A person's correction: the draft's fields (the same names as rpcEnterReceiptDraft), plus `draft_id` (the
 * live draft the person was looking at), `business` (cstore, vape, or null: the signs decide) and
 * `supplier_id` (a supplier on the list, or null: matched by the printed name). A new reading that
 * supersedes the live draft; nothing of the old row changes.
 */
export async function saveCorrection(tx: Tx, raw: unknown, actor: Actor, config: Config, now: Date): Promise<{ replaced: string | null; review: ReviewView }> {
  mayReview(actor);
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const f = drafts.readFields(drafts.parsePageInput(o));
  const b = o["business"];
  if (!(b === undefined || b === null || b === "" || isBusiness(b))) throw drafts.refuse("The business must be cstore, vape, or not chosen (null).");
  const s = o["supplier_id"];
  if (!(s === undefined || s === null || s === "" || typeof s === "string")) throw drafts.refuse("supplier_id must be a supplier's id, or null.");
  const d = o["draft_id"];
  const made = await drafts.writeReading(
    tx,
    f,
    { kind: "person", staffId: actor.staffId },
    { mode: "correct", draftId: typeof d === "string" && d !== "" ? d : null, business: isBusiness(b) ? b : null, supplierId: typeof s === "string" && s !== "" ? s : null },
    config,
    now,
  );
  return { replaced: made.replaced, review: await getReview(tx, f.originalId, actor, config, now) };
}

// ── A receipt on the books ────────────────────────────────

export interface ReceiptDetail extends drafts.DraftView {
  businessName: string | null;
  confirmed: { by: string; at: string; reason: string | null; failed: string[]; checks: drafts.CheckResult[] } | null;
  voided: { by: string; at: string; reason: string } | null;
  changes: Changes | null;
  readings: Array<{ id: string; status: string; readBy: { kind: string; name: string; keyLabel: string | null }; readAt: string }>;
  learnt: { signs: Array<{ kind: string; value: string; supplier: string | null; business: Business; removed: boolean }>; spellings: string[] };
  /** The draft a void made from it, when voided. */
  redo: string | null;
}

async function learntFrom(db: Db, receiptId: string): Promise<ReceiptDetail["learnt"]> {
  const signs = await db.query<{ kind: string; value: string; supplier: string | null; business: Business; removed: boolean }>(
    "select kind, value, supplier, business, removed_at is not null as removed from ops.business_signs where learnt_from_receipt = $1 order by added_at, sign_id",
    [receiptId],
  );
  const spellings = await db.query<{ name: string }>("select name from ops.supplier_names where learnt_from_receipt = $1 order by added_at, name_id", [receiptId]);
  return { signs, spellings: spellings.map((s) => s.name) };
}

/** One receipt (confirmed or voided, or any reading) read only, with its confirm and void record, what was changed, its readings and what was learnt from it. */
export async function receiptDetail(db: Db, purchaseId: string, config: Config): Promise<ReceiptDetail> {
  const view = await drafts.loadDraft(db, purchaseId);
  const r = await db.one<{
    confirmed_by: string | null;
    confirmed_name: string | null;
    confirmed_at: Date | null;
    confirm_reason: string | null;
    confirm_failed: string[] | null;
    confirm_checks: drafts.CheckResult[] | null;
    review_changes: Changes | null;
    voided_by: string | null;
    voided_name: string | null;
    voided_at: Date | null;
    void_reason: string | null;
    redo: string | null;
  }>(
    `select p.confirmed_by, c.name as confirmed_name, p.confirmed_at, p.confirm_reason, p.confirm_failed, p.confirm_checks, p.review_changes,
            p.voided_by, v.name as voided_name, p.voided_at, p.void_reason,
            (select r.purchase_id from ops.purchase_receipts r where r.redo_of = p.purchase_id) as redo
       from ops.purchase_receipts p left join ops.staff c on c.staff_id = p.confirmed_by left join ops.staff v on v.staff_id = p.voided_by
      where p.purchase_id = $1`,
    [purchaseId],
  );
  const chain = await db.query<{ purchase_id: string }>(
    `with recursive back (id, depth) as (select $1::text, 0 union all select p.supersedes, b.depth + 1 from back b join ops.purchase_receipts p on p.purchase_id = b.id where p.supersedes is not null and b.depth < 1000)
     select id as purchase_id from back order by depth desc`,
    [purchaseId],
  );
  const all = view.originalId === null ? [] : await readingsOf(db, view.originalId);
  const ids = chain.map((c) => c.purchase_id);
  return {
    ...view,
    businessName: view.business.key === null ? null : displayName(config, view.business.key),
    confirmed: r.confirmed_at === null ? null : { by: (r.confirmed_name ?? r.confirmed_by ?? "").trim(), at: r.confirmed_at.toISOString(), reason: r.confirm_reason, failed: r.confirm_failed ?? [], checks: r.confirm_checks ?? [] },
    voided: r.voided_at === null ? null : { by: (r.voided_name ?? r.voided_by ?? "").trim(), at: r.voided_at.toISOString(), reason: r.void_reason ?? "" },
    changes: r.review_changes,
    readings: all.filter((x) => ids.includes(x.id)),
    learnt: await learntFrom(db, purchaseId),
    redo: r.redo,
  };
}

// ── Confirming (decisions 3 to 9) ──────────────────────────

export interface ConfirmInput {
  originalId?: unknown;
  draftId?: unknown;
  reason?: unknown;
  learnSigns?: unknown;
  rememberSpelling?: unknown;
}

/** Confirm the live draft of an original: it goes on the books of its business and is final. */
export async function confirm(tx: Tx, input: ConfirmInput, actor: Actor, config: Config, now: Date): Promise<{ receipt: ReceiptDetail; message: string; learnt: { signs: SignView[]; spelling: string | null }; next: { originalId: string } | null; costs: costs.CostSummary }> {
  mayReview(actor);
  const originalId = typeof input.originalId === "string" && ORIGINAL_ID.test(input.originalId) ? input.originalId : null;
  if (originalId === null) throw notConfirmed("No such receipt original.");
  const learn = input.learnSigns === undefined || input.learnSigns === null ? [] : input.learnSigns;
  if (!Array.isArray(learn) || learn.length > 10 || learn.some((x) => typeof x !== "string")) throw notConfirmed("learnSigns must be a list of the offered signs' ids.");
  const remember = input.rememberSpelling === true;

  await drafts.takeReadingsLock(tx);
  const orig = await tx.maybeOne<{ status: string }>("select status from ops.receipt_originals where receipt_id = $1 for update", [originalId]);
  if (orig === null) throw notConfirmed("No such receipt original.");
  if (orig.status === "confirmed") {
    const c = await tx.one<{ business: Business; name: string | null; confirmed_by: string }>(
      "select p.business, st.name, p.confirmed_by from ops.purchase_receipts p left join ops.staff st on st.staff_id = p.confirmed_by where p.original_id = $1 and p.status = 'confirmed'",
      [originalId],
    );
    throw notConfirmed(`This receipt is already on the books of ${displayName(config, c.business)} (confirmed by ${(c.name ?? c.confirmed_by).trim()}).`);
  }
  if (orig.status === "set_aside") throw notConfirmed("That receipt original is set aside (it is not a receipt). A person can put it back first.");
  const live = await tx.maybeOne<{ purchase_id: string }>("select purchase_id from ops.purchase_receipts where original_id = $1 and status = 'draft' for update", [originalId]);
  if (live === null) throw notConfirmed("There is no draft of this original to confirm.");
  if (live.purchase_id !== input.draftId) throw notConfirmed(`This draft was replaced by a newer reading (by ${await drafts.whoRead(tx, live.purchase_id)}) since you opened it: open it again.`);

  const draft = await drafts.loadDraft(tx, live.purchase_id);
  const p = await prepare(tx, draft, actor, config, now);
  if (p.state.missing.length > 0) throw notConfirmed(`To confirm, settle ${and(p.state.missing)}.`);
  if (p.supplier !== null && !p.supplier.active) throw notConfirmed(`${p.supplier.displayName} is no longer an active supplier: choose another, or make it active again on the supplier list.`);
  if (p.state.why.includes(DRIFT)) throw notConfirmed(DRIFT);
  if (p.state.adminOnly && actor.role !== "admin") throw notConfirmed("It duplicates a receipt already on the books (the same supplier and invoice number): only an admin can confirm it, with a reason.");
  const reason = p.state.reasonNeeded ? cleanReason(input.reason, `A check failed: say why it is right to confirm it anyway, in ${REASON_MIN} to ${REASON_MAX} characters.`, notConfirmed) : null;
  if (learn.length > 0 && actor.role !== "admin") throw notConfirmed("Only an admin can add a sign (as on the Businesses screen): untick it, or ask an admin to confirm.");
  const business = draft.business.key as Business;
  const toLearn = (learn as string[]).map((id) => {
    const offer = p.offers.offers.find((o) => o.id === id);
    if (offer === undefined) throw notConfirmed(`That sign is not offered for this receipt (it is printed on it and not yet a sign of ${business}).`);
    return offer;
  });
  if (remember && p.spelling?.belongsTo) throw notConfirmed(`"${p.spelling.name}" is already a spelling of ${p.spelling.belongsTo.displayName}: a spelling belongs to one supplier. Untick it.`);

  const first = (await firstReading(tx, originalId)) as drafts.DraftView;
  const changes = compareReadings(first, draft);
  const failed = p.state.failed.map((c) => c.check);
  await tx.query(
    `update ops.purchase_receipts set status = 'confirmed', confirmed_by = $2, confirmed_at = $3, confirm_checks = $4, confirm_failed = $5, confirm_reason = $6, review_changes = $7, compared_with = $8
      where purchase_id = $1`,
    [draft.id, actor.staffId, now, JSON.stringify(p.state.checks), failed, reason, JSON.stringify(changes), changes.comparedWith],
  );
  await tx.query("update ops.receipt_originals set status = 'confirmed' where receipt_id = $1", [originalId]);
  const signs: SignView[] = [];
  for (const o of toLearn) signs.push((await addSign(tx, { business, kind: o.kind, value: o.value, supplier: o.supplier }, { staffId: actor.staffId }, config, now, { receiptId: draft.id })).sign);
  let spelling: string | null = null;
  if (remember && p.spelling?.offered && p.supplier !== null && (await addSpelling(tx, p.supplier, p.spelling.name, actor, now, draft.id, notConfirmed))) spelling = p.spelling.name;
  await audit.write(
    tx,
    {
      actorId: actor.staffId,
      action: "receipt.confirm",
      targetType: "purchase_receipts",
      targetId: draft.id,
      before: { status: "draft" },
      after: {
        status: "confirmed",
        originalId,
        business,
        supplierId: p.supplier?.id ?? null,
        invoiceNumber: draft.invoiceNumber,
        date: draft.date,
        kind: draft.kind,
        subtotal: draft.amounts.subtotal,
        hst: draft.amounts.hst,
        otherTotal: draft.amounts.otherTotal,
        total: draft.amounts.total,
        lines: draft.lines.length,
        decidedBy: draft.business.decidedBy,
        reason,
        failed,
        changed: changes.count,
        learntSigns: signs.map((s) => s.id),
        spellingLearnt: spelling,
      },
    },
    { now },
  );
  const observed = await costs.observeReceipt(tx, draft.id, actor, config, now);
  const next = await tx.maybeOne<{ receipt_id: string }>("select receipt_id from ops.receipt_originals where status = 'drafted' order by added_at, receipt_id limit 1");
  return { receipt: await receiptDetail(tx, draft.id, config), message: `On the books of ${displayName(config, business)}.`, learnt: { signs, spelling }, next: next === null ? null : { originalId: next.receipt_id }, costs: observed };
}

// ── Voiding (decision 10) ─────────────────────────────────

/** Void a confirmed receipt with a reason: kept and marked; its original goes back to review with a new draft copied from it. */
export async function voidReceipt(tx: Tx, input: { receiptId?: unknown; reason?: unknown }, actor: Actor, config: Config, now: Date): Promise<{ receipt: ReceiptDetail; redo: drafts.DraftView; learnt: ReceiptDetail["learnt"] & { words: string }; message: string; costs: costs.CostSummary }> {
  mayReview(actor);
  const reason = cleanReason(input.reason, `Say why it is voided, in ${REASON_MIN} to ${REASON_MAX} characters.`, notVoided);
  const id = typeof input.receiptId === "string" && PURCHASE_ID.test(input.receiptId) ? input.receiptId : null;
  await drafts.takeReadingsLock(tx);
  const row = id === null ? null : await tx.maybeOne<{ status: string; original_id: string | null; voided_by: string | null; name: string | null }>(
    "select p.status, p.original_id, p.voided_by, st.name from ops.purchase_receipts p left join ops.staff st on st.staff_id = p.voided_by where p.purchase_id = $1 for update of p",
    [id],
  );
  if (id === null || row === null) throw notVoided("No such receipt.");
  if (row.status === "voided") throw notVoided(`That receipt is already voided (by ${(row.name ?? row.voided_by ?? "").trim()}).`);
  if (row.status !== "confirmed") throw notVoided("Only a receipt on the books can be voided.");
  const view = await drafts.loadDraft(tx, id);
  await tx.query("update ops.purchase_receipts set status = 'voided', voided_by = $2, voided_at = $3, void_reason = $4 where purchase_id = $1", [id, actor.staffId, now, reason]);
  if (row.original_id !== null) {
    await tx.query("select 1 from ops.receipt_originals where receipt_id = $1 for update", [row.original_id]);
    await tx.query("update ops.receipt_originals set status = 'drafted' where receipt_id = $1", [row.original_id]);
  }
  const redo = await drafts.writeReading(tx, drafts.readFields(drafts.inputOf(view)), { kind: "person", staffId: actor.staffId }, { mode: "redo", voidedId: id, business: view.business.key, supplierId: view.supplier.id }, config, now);
  const learnt = await learntFrom(tx, id);
  const parts = [...learnt.signs.filter((s) => !s.removed).map((s) => `${describeSign(s.kind as SignKind, s.value, s.supplier)} (${s.business})`), ...learnt.spellings.map((n) => `the spelling "${n}" of ${view.supplier.listedName ?? "its supplier"}`)];
  const words = parts.length === 0 ? "Nothing was learnt from this receipt." : `Learnt from this receipt and NOT removed: ${parts.join("; ")}. Remove them by hand if they were wrong.`;
  await audit.write(
    tx,
    { actorId: actor.staffId, action: "receipt.void", targetType: "purchase_receipts", targetId: id, before: { status: "confirmed" }, after: { status: "voided", reason, originalId: row.original_id, total: view.amounts.total, business: view.business.key, redo: redo.draft.id, learntSigns: learnt.signs.length, learntSpellings: learnt.spellings } },
    { now },
  );
  const unobserved = await costs.unobserveReceipt(tx, id, actor, now);
  return {
    receipt: await receiptDetail(tx, id, config),
    redo: redo.draft,
    learnt: { ...learnt, words },
    costs: unobserved,
    message: "Voided. It stays on file, marked voided; the original is back in Read, waiting for review, with a copy of its figures to correct.",
  };
}

// ── The books (decision 11) ───────────────────────────────

export interface BooksRow {
  id: string;
  originalId: string | null;
  business: Business;
  status: "confirmed" | "voided";
  date: string | null;
  invoiceNumber: string | null;
  supplier: string | null;
  supplierId: string | null;
  supplierActive: boolean;
  supplierPrinted: string | null;
  kind: string | null;
  subtotal: string | null;
  hst: string | null;
  total: string;
  confirmedBy: string;
  confirmedAt: string;
  reason: string | null;
  failedAtConfirm: number;
  fieldsChanged: number;
  voided: { by: string; at: string; reason: string } | null;
}

export interface Books {
  business: Business;
  businessName: string;
  items: BooksRow[];
  next: string | null;
  /** For the whole filter, every page: confirmed receipts only (voided ones are counted apart). Exact decimals. */
  totals: { count: number; subtotal: string; hst: string; total: string; voided: number; noSubtotal: number; noHst: number };
  canVoid: boolean;
}

const dayOrNull = (v: unknown, what: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  const d = typeof v === "string" ? drafts.realDay(v) : null;
  if (d === null) throw new Error(`${what} must be a day written YYYY-MM-DD.`);
  return d;
};

/** One business's books, newest on the books first, a page at a time, with the totals of the filter; or, with `receiptId`, one receipt. */
export async function books(db: Db, input: Record<string, unknown>, actor: Actor, config: Config): Promise<Books | { receipt: ReceiptDetail }> {
  if (!READ_ROLES.includes(actor.role)) throw new Error("Only an admin, a manager or a payroll admin can see the books.");
  if (input["receiptId"] !== undefined) {
    const rid = input["receiptId"];
    const ok = typeof rid === "string" && PURCHASE_ID.test(rid) ? await db.maybeOne<{ n: number }>("select 1 as n from ops.purchase_receipts where purchase_id = $1 and status in ('confirmed', 'voided')", [rid]) : null;
    if (ok === null) throw new Error("No such receipt on the books.");
    return { receipt: await receiptDetail(db, rid as string, config) };
  }
  const business = input["business"];
  if (!isBusiness(business)) throw new Error("Choose one business: cstore or vape. The two are never listed together.");
  const from = dayOrNull(input["from"], "from");
  const to = dayOrNull(input["to"], "to");
  const sid = input["supplierId"];
  const supplierId = sid === undefined || sid === null || sid === "" ? null : typeof sid === "string" && SUPPLIER_ID.test(sid) ? sid : "";
  if (supplierId === "") throw new Error("No such supplier.");
  const k = input["kind"];
  const kind = k === undefined || k === null || k === "" ? null : typeof k === "string" && (drafts.KINDS as readonly string[]).includes(k) ? k : "";
  if (kind === "") throw new Error(`kind must be one of ${drafts.KINDS.join(", ")}.`);
  const limitIn = typeof input["limit"] === "number" && Number.isInteger(input["limit"]) ? (input["limit"] as number) : PAGE_DEFAULT;
  const limit = Math.min(Math.max(limitIn, 1), PAGE_MAX);
  const before = typeof input["before"] === "string" && PURCHASE_ID.test(input["before"] as string) ? (input["before"] as string) : null;
  const filter = `p.business = $1 and p.status in ('confirmed', 'voided')
        and ($2::date is null or p.receipt_date >= $2::date) and ($3::date is null or p.receipt_date <= $3::date)
        and ($4::text is null or p.supplier_id = $4) and ($5::text is null or p.kind = $5)`;
  const rows = await db.query<{
    purchase_id: string;
    original_id: string | null;
    status: "confirmed" | "voided";
    receipt_date: string | null;
    invoice_number: string | null;
    display_name: string | null;
    supplier_id: string | null;
    active: boolean | null;
    supplier_name: string | null;
    kind: string | null;
    subtotal: string | null;
    hst: string | null;
    total: string;
    confirmed_name: string | null;
    confirmed_by: string;
    confirmed_at: Date;
    confirm_reason: string | null;
    failed: number;
    changed: number;
    voided_name: string | null;
    voided_by: string | null;
    voided_at: Date | null;
    void_reason: string | null;
  }>(
    `select p.purchase_id, p.original_id, p.status, p.receipt_date, p.invoice_number, s.display_name, p.supplier_id, s.active, p.supplier_name, p.kind,
            p.subtotal::text as subtotal, p.hst::text as hst, p.total::text as total,
            c.name as confirmed_name, p.confirmed_by, p.confirmed_at, p.confirm_reason, coalesce(cardinality(p.confirm_failed), 0) as failed,
            coalesce((p.review_changes->>'count')::int, 0) as changed, v.name as voided_name, p.voided_by, p.voided_at, p.void_reason
       from ops.purchase_receipts p
       left join ops.suppliers s on s.supplier_id = p.supplier_id
       left join ops.staff c on c.staff_id = p.confirmed_by
       left join ops.staff v on v.staff_id = p.voided_by
      where ${filter}
        and ($6::text is null or (p.confirmed_at, p.purchase_id) < (select confirmed_at, purchase_id from ops.purchase_receipts where purchase_id = $6))
      order by p.confirmed_at desc, p.purchase_id desc
      limit $7`,
    [business, from, to, supplierId, kind, before, limit + 1],
  );
  const t = await db.one<{ count: number; subtotal: string; hst: string; total: string; voided: number; no_subtotal: number; no_hst: number }>(
    `select count(*) filter (where p.status = 'confirmed')::int as count,
            coalesce(sum(p.subtotal) filter (where p.status = 'confirmed'), 0)::numeric(14, 2)::text as subtotal,
            coalesce(sum(p.hst) filter (where p.status = 'confirmed'), 0)::numeric(14, 2)::text as hst,
            coalesce(sum(p.total) filter (where p.status = 'confirmed'), 0)::numeric(14, 2)::text as total,
            count(*) filter (where p.status = 'voided')::int as voided,
            count(*) filter (where p.status = 'confirmed' and p.subtotal is null)::int as no_subtotal,
            count(*) filter (where p.status = 'confirmed' and p.hst is null)::int as no_hst
       from ops.purchase_receipts p where ${filter}`,
    [business, from, to, supplierId, kind],
  );
  const page = rows.slice(0, limit);
  return {
    business,
    businessName: displayName(config, business),
    items: page.map((r) => ({
      id: r.purchase_id,
      originalId: r.original_id,
      business,
      status: r.status,
      date: r.receipt_date,
      invoiceNumber: r.invoice_number,
      supplier: r.display_name,
      supplierId: r.supplier_id,
      supplierActive: r.active === true,
      supplierPrinted: r.supplier_name,
      kind: r.kind,
      subtotal: r.subtotal,
      hst: r.hst,
      total: r.total,
      confirmedBy: (r.confirmed_name ?? r.confirmed_by).trim(),
      confirmedAt: r.confirmed_at.toISOString(),
      reason: r.confirm_reason,
      failedAtConfirm: r.failed,
      fieldsChanged: r.changed,
      voided: r.voided_at === null ? null : { by: (r.voided_name ?? r.voided_by ?? "").trim(), at: r.voided_at.toISOString(), reason: r.void_reason ?? "" },
    })),
    next: rows.length > limit ? (page[page.length - 1]?.purchase_id ?? null) : null,
    totals: { count: t.count, subtotal: t.subtotal, hst: t.hst, total: t.total, voided: t.voided, noSubtotal: t.no_subtotal, noHst: t.no_hst },
    canVoid: REVIEW_ROLES.includes(actor.role),
  };
}
