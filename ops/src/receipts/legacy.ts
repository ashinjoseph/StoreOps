// The old purchase list, brought in as history (card P5-16). NEW in the Operations app (ADR-0023);
// ops/test/legacy-purchases.test.ts is the specification.
//
// Until now the owner kept purchases as a list in a workbook: a date, a supplier typed by hand, an amount
// and a note. It comes in as HISTORY, with the little it has, marked "no original on file". It is NOT
// turned into receipts (no document, no tax figure, no invoice number, and for most rows nothing that says
// which business bought it): it has tables of its own (0015) and is never part of "On the books", never in
// the books' totals and never offered to an assistant (nothing in ops/src/mcp reads it).
// The rules:
//   - A row is kept EXACTLY as it was: the date, the supplier as typed (odd spacing included), the amount
//     to the cent, the note as typed, and the row number as a person sees it in the spreadsheet. Nothing is
//     corrected, merged, re-spelled or dropped. Exact repeats are all kept.
//   - A row that cannot be history at all is rejected and listed, never guessed: no date, a date that is
//     not a date, before 2000 or after the day of the import; no amount, an amount that is not a number,
//     with fractions of a cent, or too large. A blank supplier is kept (blank). A zero or negative amount
//     (a refund) is kept as it is.
//   - The business is NOT known and is never guessed. Every row arrives with none. A person (admin or
//     manager) may set it for one row or for every row of one spelling, and clear it again. Nothing sets it
//     on its own: not a linked supplier, not a supplier that only one business uses.
//   - A supplier is LINKED, not rewritten: a person says a spelling means a supplier on the app's list; the
//     rows keep the text as typed, and the spelling becomes one of the supplier's known spellings
//     (learnt_from old_list), so a future receipt printed that way is matched.
//   - One file at a time: the same file (SHA-256) again adds nothing; a changed file is refused unless told
//     which old file it replaces, and then the old rows are marked superseded (never removed) and their
//     business and supplier links carry over to the new rows that match.
// Identity and role come from the caller (the session, or --as in the owner's tool); time is the caller's
// `now`; SQL takes values as parameters only; one insert holds every row; nothing is removed; every write
// is audited with counts and the spelling's key, never one entry a row.
import type { Db } from "../db/client";
import type { Tx } from "../db/tx";
import * as audit from "../lib/audit";
import { formatDate } from "../lib/dates";
import { isBusiness, normalise, type Business } from "./businesses";
import { realDay } from "./drafts";
import { addSpelling, READ_ROLES, REVIEW_ROLES, SUPPLIER_LOCK, type Actor } from "./review";
import type { SheetCell } from "../export/xlsx";

export const LEGACY_READ_ROLES: readonly string[] = READ_ROLES;
export const LEGACY_EDIT_ROLES: readonly string[] = REVIEW_ROLES;
export const PAGE_MAX = 100;
export const PAGE_DEFAULT = 50;
export const FIRST_YEAR = 2000;
export const SPELLINGS_MAX = 1000;
export const SUPPLIER_NAME_MAX = 120;
/** The words every screen and every answer uses for these rows. */
export const NO_ORIGINAL = "from the old list: no original on file";

const ROW_ID = /^lp[0-9a-f]{24}$/;
const SUPPLIER_ID = /^sp[0-9a-f]{20}$/;
const LEGACY_LOCK = "select pg_advisory_xact_lock(hashtextextended('ops.legacy_purchases', 0))";
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const newFileId = (): string => "lf" + hex(crypto.getRandomValues(new Uint8Array(10)));
const newRowId = (): string => "lp" + hex(crypto.getRandomValues(new Uint8Array(12)));

/** A refusal the person should read: nothing was written. */
export class LegacyRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyRefused";
  }
}

// ── The row rules (pure) ──────────────────────────────────

export interface Columns {
  date: number;
  supplier: number;
  amount: number;
  item: number;
}
/** The four headings the workbook has, in the form they are compared in (see headingKey). */
export const HEADINGS: Readonly<Record<keyof Columns, string>> = { date: "date", supplier: "supplier name", amount: "amount", item: "item" };

/** A heading as compared: white space around it ignored, runs of it made one, capitals ignored. */
export const headingKey = (cell: SheetCell): string => (typeof cell === "string" ? cell.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase() : "");

/**
 * The columns of the four headings, whatever their order, found by what they say and never by position.
 * Refuses, in plain words and without quoting anything the tab holds, when one is missing or two have the same heading.
 */
export function findColumns(header: readonly SheetCell[]): Columns {
  const keys = header.map(headingKey);
  const found: Partial<Columns> = {};
  const missing: string[] = [];
  const twice: string[] = [];
  for (const name of Object.keys(HEADINGS) as Array<keyof Columns>) {
    const at = keys.flatMap((k, i) => (k === HEADINGS[name] ? [i] : []));
    if (at.length === 0) missing.push(`"${HEADINGS[name]}"`);
    else if (at.length > 1) twice.push(`"${HEADINGS[name]}"`);
    else found[name] = at[0] as number;
  }
  if (missing.length > 0) throw new LegacyRefused(`Row 1 of the tab has no column headed ${missing.join(", ")}. The four headings are Date, Supplier Name, Amount and Item, in any order, in capitals or not, with or without spaces around them. Nothing was written.`);
  if (twice.length > 0) throw new LegacyRefused(`More than one column is headed ${twice.join(", ")}: it cannot be told which to read. Nothing was written.`);
  return found as Columns;
}

export interface LegacyRow {
  /** The row number as a person sees it in the spreadsheet. */
  sheetRow: number;
  /** The business day, YYYY-MM-DD. */
  date: string;
  /** As typed ('' when the cell was blank). */
  supplier: string;
  /** The supplier's normal form: what groups the spellings. */
  key: string;
  /** Exact, in cents. */
  cents: number;
  note: string;
}
export interface Reject {
  sheetRow: number;
  /** The column's heading as the rules name it: date, supplier name, amount or item. */
  column: string;
  reason: string;
}
export type RowResult = { kind: "empty" } | { kind: "kept"; row: LegacyRow } | { kind: "rejected"; rejects: Reject[] };

// eslint-disable-next-line no-control-regex
const NUL = /\u0000/;
// Control characters, line and paragraph separators and direction marks: none belongs in a file name.
// eslint-disable-next-line no-control-regex
const CONTROLS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]", "g");
const MAX_CENTS = 1_000_000_000_000; // numeric(12, 2): up to 9,999,999,999.99

/** Dollars-and-cents text of whole cents: -1234 is "-12.34". Integer arithmetic only. */
export function centsText(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const isBlank = (c: SheetCell | undefined): boolean => c === undefined || c === "";

/** A text cell as typed. A number is its own digits; a date, a true/false or an error is not text, and is refused rather than guessed. */
function textOf(c: SheetCell | undefined): string | null {
  if (c === undefined || c === "") return "";
  if (typeof c === "string") return c;
  if (typeof c === "number") return String(c);
  return null;
}

/**
 * One data row under rules 1 to 3. `today` is the Toronto day of the import (YYYY-MM-DD). A row whose four cells
 * are all blank is not a row of the list (`empty`). Every reason a row is rejected is listed, so a person can
 * fix them all in one go; a reason never quotes the cell.
 */
export function judgeRow(cells: readonly SheetCell[], cols: Columns, sheetRow: number, today: string): RowResult {
  const date = cells[cols.date];
  const supplier = cells[cols.supplier];
  const amount = cells[cols.amount];
  const item = cells[cols.item];
  if (isBlank(date) && isBlank(supplier) && isBlank(amount) && isBlank(item)) return { kind: "empty" };
  const rejects: Reject[] = [];
  const no = (column: string, reason: string): void => void rejects.push({ sheetRow, column, reason });

  let day = "";
  if (isBlank(date)) no("date", "no date");
  else if (!(date instanceof Date)) no("date", typeof date === "string" ? "the date is text, not a date" : "the date is not a date");
  else {
    day = formatDate(date);
    if (day < `${FIRST_YEAR}-01-01`) no("date", `the date is before ${FIRST_YEAR}`);
    else if (day > today) no("date", "the date is after the day of the import");
  }

  let cents = 0;
  if (isBlank(amount)) no("amount", "no amount");
  else if (typeof amount !== "number") no("amount", "the amount is not a number");
  else {
    const scaled = amount * 100;
    cents = Math.round(scaled);
    if (Math.abs(scaled - cents) > 1e-6 + Math.abs(scaled) * 1e-15) no("amount", "the amount has fractions of a cent");
    else if (Math.abs(cents) >= MAX_CENTS) no("amount", "the amount is too large");
  }

  const supplierText = textOf(supplier);
  if (supplierText === null) no("supplier name", "the supplier is not text");
  else if (NUL.test(supplierText)) no("supplier name", "the supplier holds a character the database cannot keep");
  const note = textOf(item);
  if (note === null) no("item", "the item is not text");
  else if (NUL.test(note)) no("item", "the item holds a character the database cannot keep");

  if (rejects.length > 0 || supplierText === null || note === null) return { kind: "rejected", rejects };
  return { kind: "kept", row: { sheetRow, date: day, supplier: supplierText, key: normalise(supplierText), cents, note } };
}

export interface ReadCounts {
  /** Rows with something in any of the four columns. */
  read: number;
  kept: number;
  rejected: number;
  /** Rows with nothing in the four columns: not rows of the list. */
  empty: number;
  /** Kept rows with a blank supplier. */
  noSupplier: number;
  /** Kept rows with a blank note. */
  noNote: number;
  /** Kept rows with an amount of zero, and below zero (refunds). */
  zero: number;
  negative: number;
  /** Kept rows that repeat an earlier kept row (the same date, supplier text and amount). All are kept. */
  repeats: number;
  spellings: number;
}
export interface ReadResult {
  rows: LegacyRow[];
  rejects: Reject[];
  counts: ReadCounts;
}

/** Every data row of a tab under the rules, in the spreadsheet's own order. Pure. */
export function readRows(table: ReadonlyArray<{ row: number; cells: readonly SheetCell[] }>, cols: Columns, today: string): ReadResult {
  const rows: LegacyRow[] = [];
  const rejects: Reject[] = [];
  const seen = new Set<string>();
  const keys = new Set<string>();
  const c: ReadCounts = { read: 0, kept: 0, rejected: 0, empty: 0, noSupplier: 0, noNote: 0, zero: 0, negative: 0, repeats: 0, spellings: 0 };
  for (const r of table) {
    const j = judgeRow(r.cells, cols, r.row, today);
    if (j.kind === "empty") {
      c.empty++;
      continue;
    }
    c.read++;
    if (j.kind === "rejected") {
      c.rejected++;
      rejects.push(...j.rejects);
      continue;
    }
    const x = j.row;
    c.kept++;
    rows.push(x);
    if (x.supplier === "") c.noSupplier++;
    if (x.note === "") c.noNote++;
    if (x.cents === 0) c.zero++;
    if (x.cents < 0) c.negative++;
    const same = JSON.stringify([x.date, x.supplier, x.cents]);
    if (seen.has(same)) c.repeats++;
    seen.add(same);
    keys.add(x.key);
  }
  c.spellings = keys.size;
  return { rows, rejects, counts: c };
}

// ── The load ──────────────────────────────────────────────

export interface LoadInput {
  /** The workbook's SHA-256, as 64 hex characters. */
  sha256: string;
  /** The file's name as given, cleaned. */
  fileName: string;
  tab: string;
  result: ReadResult;
  /** The admin the owner's tool was told to act as (--as). */
  staffId: string;
  /** The old file this one replaces (its SHA-256), or null. */
  replaces: string | null;
  now: Date;
}
export type LoadOutcome =
  | { outcome: "imported"; fileId: string; rows: number; replaced: { fileId: string; oldRows: number; carriedOver: number; notCarried: number } | null }
  | { outcome: "already"; fileId: string; supersededBy: string | null };

/** A file name as stored: the last part of the path, control characters and direction marks removed, at most 200 characters. */
export function cleanFileName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const base = (raw.split(/[\\/]/).pop() ?? "").replace(CONTROLS, "").trim();
  const cut = Array.from(base).slice(0, 200).join("");
  return cut === "" ? "workbook.xlsx" : cut;
}

/** The staff member must be an active admin: the tool is run by the owner on their own computer. */
export async function requireActiveAdmin(db: Db, staffId: string): Promise<void> {
  const row = await db.maybeOne<{ role: string; active: boolean }>("select role, active from ops.staff where staff_id = $1", [staffId]);
  if (row === null || !row.active || row.role !== "admin") throw new LegacyRefused("--as must be the staff id of an active admin. Nothing was written.");
}

/**
 * Write one file and all its rows, in the caller's transaction. The same file again (the same SHA-256) adds nothing.
 * A different file is refused while another is live, unless `replaces` names that live file: its rows are then
 * marked superseded (never removed) and their business and supplier links carry over to the new rows that match
 * on row number, date, amount and supplier text.
 */
export async function loadFile(tx: Tx, input: LoadInput): Promise<LoadOutcome> {
  await requireActiveAdmin(tx, input.staffId);
  await tx.query(LEGACY_LOCK);
  const same = await tx.maybeOne<{ file_id: string; superseded_by: string | null }>("select file_id, superseded_by from ops.legacy_purchase_files where file_sha256 = decode($1, 'hex')", [input.sha256]);
  if (same !== null) return { outcome: "already", fileId: same.file_id, supersededBy: same.superseded_by };

  const live = await tx.query<{ file_id: string; sha: string; file_name: string; rows_kept: number }>(
    "select file_id, encode(file_sha256, 'hex') as sha, file_name, rows_kept from ops.legacy_purchase_files where superseded_at is null order by imported_at, file_id",
  );
  let old: { file_id: string; rows_kept: number } | null = null;
  if (input.replaces === null) {
    if (live.length > 0) {
      const f = live[0] as (typeof live)[number];
      throw new LegacyRefused(
        `A different file is already in the app: "${f.file_name}" (SHA-256 ${f.sha}), ${f.rows_kept} rows. If this is the same list, corrected and exported again, run the same command with --replace-file ${f.sha}: the old rows are then marked replaced and kept. Nothing was written.`,
      );
    }
  } else {
    const named = await tx.maybeOne<{ file_id: string; rows_kept: number; superseded_at: Date | null }>("select file_id, rows_kept, superseded_at from ops.legacy_purchase_files where file_sha256 = decode($1, 'hex')", [input.replaces]);
    if (named === null) throw new LegacyRefused("--replace-file names a file that was never imported here. Nothing was written.");
    if (named.superseded_at !== null) throw new LegacyRefused("--replace-file names a file that has already been replaced by a newer one. Nothing was written.");
    old = named;
  }

  const fileId = newFileId();
  const c = input.result.counts;
  await tx.query(
    `insert into ops.legacy_purchase_files (file_id, file_sha256, file_name, tab, rows_read, rows_kept, rows_rejected, imported_by, imported_at)
     values ($1, decode($2, 'hex'), $3, $4, $5, $6, $7, $8, $9)`,
    [fileId, input.sha256, cleanFileName(input.fileName), input.tab, c.read, c.kept, c.rejected, input.staffId, input.now],
  );
  const rows = input.result.rows;
  if (rows.length > 0) {
    // ONE statement for every row: the values travel as seven arrays, never in the SQL text.
    await tx.query(
      `insert into ops.legacy_purchases (row_id, file_id, sheet_row, purchase_date, supplier_text, spelling_key, amount, note)
       select r.row_id, $1, r.sheet_row, r.purchase_date::date, r.supplier_text, r.spelling_key, r.cents::numeric / 100, r.note
         from unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::bigint[], $8::text[])
              as r(row_id, sheet_row, purchase_date, supplier_text, spelling_key, cents, note)`,
      [fileId, rows.map(newRowId), rows.map((r) => r.sheetRow), rows.map((r) => r.date), rows.map((r) => r.supplier), rows.map((r) => r.key), rows.map((r) => String(r.cents)), rows.map((r) => r.note)],
    );
  }

  let replaced: { fileId: string; oldRows: number; carriedOver: number; notCarried: number } | null = null;
  if (old !== null) {
    const owed = await tx.one<{ n: number }>("select count(*)::int as n from ops.legacy_purchases where file_id = $1 and superseded_at is null and (business is not null or supplier_id is not null)", [old.file_id]);
    const carried = await tx.one<{ n: number }>(
      `with moved as (
         update ops.legacy_purchases np
            set business = o.business, business_set_by = o.business_set_by, business_set_at = o.business_set_at,
                supplier_id = o.supplier_id, linked_by = o.linked_by, linked_at = o.linked_at
           from ops.legacy_purchases o
          where np.file_id = $1 and o.file_id = $2 and o.superseded_at is null
            and (o.business is not null or o.supplier_id is not null)
            and np.sheet_row = o.sheet_row and np.purchase_date = o.purchase_date and np.amount = o.amount and np.supplier_text = o.supplier_text
        returning 1)
       select count(*)::int as n from moved`,
      [fileId, old.file_id],
    );
    await tx.query("update ops.legacy_purchases set superseded_at = $2 where file_id = $1 and superseded_at is null", [old.file_id, input.now]);
    await tx.query("update ops.legacy_purchase_files set superseded_by = $2, superseded_at = $3 where file_id = $1", [old.file_id, fileId, input.now]);
    replaced = { fileId: old.file_id, oldRows: old.rows_kept, carriedOver: carried.n, notCarried: owed.n - carried.n };
  }
  await audit.write(
    tx,
    {
      actorId: input.staffId,
      action: replaced === null ? "legacy_purchases.import" : "legacy_purchases.replace",
      targetType: "legacy_purchase_files",
      targetId: fileId,
      after: { tab: input.tab, rowsRead: c.read, rowsKept: c.kept, rowsRejected: c.rejected, replaces: replaced === null ? null : replaced.fileId, carriedOver: replaced?.carriedOver ?? null, notCarried: replaced?.notCarried ?? null },
      details: "Run with the owner's local import tool (import:purchases) on their own computer; the staff id is the one given with --as. Counts only: no cell value is kept here.",
    },
    { now: input.now },
  );
  return { outcome: "imported", fileId, rows: rows.length, replaced };
}

// ── The readers ───────────────────────────────────────────

export type View = "cstore" | "vape" | "unsorted";
const isView = (v: unknown): v is View => v === "unsorted" || isBusiness(v);

export interface PurchaseRow {
  id: string;
  /** The row number in the spreadsheet it came from. */
  sheetRow: number;
  date: string;
  /** As typed. */
  supplier: string;
  spellingKey: string;
  note: string;
  /** Exact decimals as text, and in cents. */
  amount: string;
  amountCents: number;
  business: Business | null;
  linked: { id: string; name: string } | null;
}
export interface PurchasesPage {
  view: View;
  items: PurchaseRow[];
  next: string | null;
  /** For the whole filter, every page. */
  totals: { count: number; totalCents: number };
  /** Rows of the whole list by where they stand, whatever the filter. */
  counts: { unsorted: number; cstore: number; vape: number };
  imported: boolean;
  canEdit: boolean;
  label: string;
}

const dayOrNull = (v: unknown, what: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  const d = typeof v === "string" ? realDay(v) : null;
  if (d === null) throw new Error(`${what} must be a day written YYYY-MM-DD.`);
  return d;
};
const likeOf = (text: string): string => `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

function mayRead(actor: Actor): void {
  if (!LEGACY_READ_ROLES.includes(actor.role)) throw new Error("Only an admin, a manager or a payroll admin can see the old purchase list.");
}
function mayEdit(actor: Actor): void {
  if (!LEGACY_EDIT_ROLES.includes(actor.role)) throw new Error("Only an admin or a manager can change the old purchase list.");
}

/** The rows of the old list for one view (a business, or not sorted yet), newest date first, a page at a time, with the totals of the filter. */
export async function getPurchases(db: Db, input: Record<string, unknown>, actor: Actor): Promise<PurchasesPage> {
  mayRead(actor);
  const view = input["business"];
  if (!isView(view)) throw new Error("Choose cstore, vape or not sorted: the old list is shown one at a time.");
  const from = dayOrNull(input["from"], "from");
  const to = dayOrNull(input["to"], "to");
  const key = typeof input["spellingKey"] === "string" ? input["spellingKey"] : null;
  if (input["spellingKey"] !== undefined && input["spellingKey"] !== null && key === null) throw new Error("spellingKey must be text.");
  const q = typeof input["text"] === "string" ? input["text"].trim().slice(0, 100) : "";
  const limitIn = typeof input["limit"] === "number" && Number.isInteger(input["limit"]) ? (input["limit"] as number) : PAGE_DEFAULT;
  const limit = Math.min(Math.max(limitIn, 1), PAGE_MAX);
  const before = typeof input["before"] === "string" && ROW_ID.test(input["before"]) ? input["before"] : null;
  if (input["before"] !== undefined && input["before"] !== null && before === null) throw new Error("That page cannot be found.");
  if (before !== null && (await db.maybeOne<{ n: number }>("select 1 as n from ops.legacy_purchases where row_id = $1", [before])) === null) throw new Error("That page cannot be found.");

  const filter = `p.superseded_at is null and (($1::text = 'unsorted' and p.business is null) or p.business = $1::text)
        and ($2::date is null or p.purchase_date >= $2::date) and ($3::date is null or p.purchase_date <= $3::date)
        and ($4::text is null or p.spelling_key = $4::text)
        and ($5::text = '' or p.supplier_text ilike $6 escape '\\' or p.note ilike $6 escape '\\')`;
  const params = [view, from, to, key, q, likeOf(q)];
  const rows = await db.query<{ row_id: string; sheet_row: number; purchase_date: string; supplier_text: string; spelling_key: string; note: string; amount: string; cents: string; business: Business | null; supplier_id: string | null; display_name: string | null }>(
    `select p.row_id, p.sheet_row, p.purchase_date::text as purchase_date, p.supplier_text, p.spelling_key, p.note, p.amount::text as amount,
            round(p.amount * 100)::bigint::text as cents, p.business, p.supplier_id, s.display_name
       from ops.legacy_purchases p left join ops.suppliers s on s.supplier_id = p.supplier_id
      where ${filter}
        and ($7::text is null or (p.purchase_date, p.row_id) < (select purchase_date, row_id from ops.legacy_purchases where row_id = $7))
      order by p.purchase_date desc, p.row_id desc
      limit $8`,
    [...params, before, limit + 1],
  );
  const t = await db.one<{ count: number; cents: string }>(`select count(*)::int as count, coalesce(sum(round(p.amount * 100)), 0)::bigint::text as cents from ops.legacy_purchases p where ${filter}`, params);
  const c = await db.one<{ unsorted: number; cstore: number; vape: number; files: number }>(
    `select count(*) filter (where business is null)::int as unsorted, count(*) filter (where business = 'cstore')::int as cstore, count(*) filter (where business = 'vape')::int as vape,
            (select count(*)::int from ops.legacy_purchase_files) as files
       from ops.legacy_purchases where superseded_at is null`,
  );
  const page = rows.slice(0, limit);
  return {
    view,
    items: page.map((r) => ({
      id: r.row_id,
      sheetRow: r.sheet_row,
      date: r.purchase_date,
      supplier: r.supplier_text,
      spellingKey: r.spelling_key,
      note: r.note,
      amount: r.amount,
      amountCents: Number(r.cents),
      business: r.business,
      linked: r.supplier_id === null ? null : { id: r.supplier_id, name: r.display_name ?? "" },
    })),
    next: rows.length > limit ? (page[page.length - 1]?.row_id ?? null) : null,
    totals: { count: t.count, totalCents: Number(t.cents) },
    counts: { unsorted: c.unsorted, cstore: c.cstore, vape: c.vape },
    imported: c.files > 0,
    canEdit: LEGACY_EDIT_ROLES.includes(actor.role),
    label: NO_ORIGINAL,
  };
}

export interface SpellingRow {
  key: string;
  /** The text as typed that most rows have (a tie goes to the first in sort order). */
  text: string;
  /** How many different texts normalise to this spelling. */
  variants: number;
  rows: number;
  totalCents: number;
  cstore: number;
  vape: number;
  unsorted: number;
  /** The supplier every row of the spelling is linked to; null when none, or when the rows are not all linked to one. */
  supplier: { id: string; name: string } | null;
  partlyLinked: boolean;
}
export interface SpellingsView {
  spellings: SpellingRow[];
  files: Array<{ name: string; tab: string; rowsKept: number; rowsRejected: number; importedAt: string }>;
  imported: boolean;
  canEdit: boolean;
  label: string;
}

/** Every supplier spelling in the old list: how many rows, their total, how they are sorted, who they are linked to. Most rows first. */
export async function getSpellings(db: Db, actor: Actor): Promise<SpellingsView> {
  mayRead(actor);
  const rows = await db.query<{ key: string; text: string; variants: number; rows: number; cents: string; cstore: number; vape: number; unsorted: number; linked_rows: number; linked_suppliers: number; supplier_id: string | null; display_name: string | null }>(
    `select g.*, s.display_name
       from (select p.spelling_key as key, mode() within group (order by p.supplier_text) as text, count(distinct p.supplier_text)::int as variants, count(*)::int as rows,
                    coalesce(sum(round(p.amount * 100)), 0)::bigint::text as cents,
                    count(*) filter (where p.business = 'cstore')::int as cstore, count(*) filter (where p.business = 'vape')::int as vape, count(*) filter (where p.business is null)::int as unsorted,
                    count(p.supplier_id)::int as linked_rows, count(distinct p.supplier_id)::int as linked_suppliers, min(p.supplier_id) as supplier_id,
                    sum(p.amount) as total
               from ops.legacy_purchases p where p.superseded_at is null group by p.spelling_key) g
       left join ops.suppliers s on s.supplier_id = g.supplier_id and g.linked_suppliers = 1
      order by g.rows desc, abs(g.total) desc, g.key
      limit $1`,
    [SPELLINGS_MAX],
  );
  const files = await db.query<{ file_name: string; tab: string; rows_kept: number; rows_rejected: number; imported_at: Date }>(
    "select file_name, tab, rows_kept, rows_rejected, imported_at from ops.legacy_purchase_files where superseded_at is null order by imported_at, file_id",
  );
  const any = await db.one<{ n: number }>("select count(*)::int as n from ops.legacy_purchase_files");
  return {
    spellings: rows.map((r) => {
      const whole = r.linked_rows === r.rows && r.linked_suppliers === 1 && r.supplier_id !== null;
      return {
        key: r.key,
        text: r.text,
        variants: r.variants,
        rows: r.rows,
        totalCents: Number(r.cents),
        cstore: r.cstore,
        vape: r.vape,
        unsorted: r.unsorted,
        supplier: whole ? { id: r.supplier_id as string, name: r.display_name ?? "" } : null,
        partlyLinked: r.linked_rows > 0 && !whole,
      };
    }),
    files: files.map((f) => ({ name: f.file_name, tab: f.tab, rowsKept: f.rows_kept, rowsRejected: f.rows_rejected, importedAt: f.imported_at.toISOString() })),
    imported: any.n > 0,
    canEdit: LEGACY_EDIT_ROLES.includes(actor.role),
    label: NO_ORIGINAL,
  };
}

// ── Setting a business, linking a supplier ────────────────

export interface SetBusinessResult {
  /** Rows the choice covered, and how many of them it changed. */
  rows: number;
  changed: number;
  business: Business | null;
  message: string;
}

const businessWord = (b: Business | null): string => (b === null ? "not sorted" : b);

/**
 * Set (or, with null, clear) the business of one row (`rowId`) or of every live row written with one spelling
 * (`spellingKey`): exactly one of the two. Admin or manager. Nothing else ever sets it.
 */
export async function setBusiness(tx: Tx, input: { rowId?: unknown; spellingKey?: unknown; business?: unknown }, actor: Actor, now: Date): Promise<SetBusinessResult> {
  mayEdit(actor);
  const one = input.rowId !== undefined && input.rowId !== null;
  const many = input.spellingKey !== undefined && input.spellingKey !== null;
  if (one === many) throw new Error("Say which: one row (rowId) or every row written one way (spellingKey), not both and not neither. Nothing was changed.");
  const business = input.business === undefined || input.business === null ? null : isBusiness(input.business) ? input.business : "bad";
  if (business === "bad") throw new Error("Business must be cstore, vape, or null to clear it. Nothing was changed.");
  if (one) {
    const id = typeof input.rowId === "string" && ROW_ID.test(input.rowId) ? input.rowId : null;
    const row = id === null ? null : await tx.maybeOne<{ business: Business | null; superseded_at: Date | null }>("select business, superseded_at from ops.legacy_purchases where row_id = $1 for update", [id]);
    if (row === null) throw new Error("No such row in the old list. Nothing was changed.");
    if (row.superseded_at !== null) throw new Error("That row belongs to a file that has been replaced by a newer one. Nothing was changed.");
    const changed = row.business !== business;
    if (changed) {
      await tx.query("update ops.legacy_purchases set business = $2, business_set_by = $3, business_set_at = $4 where row_id = $1", [id, business, actor.staffId, now]);
      await audit.write(tx, { actorId: actor.staffId, action: "legacy_purchase.set_business", targetType: "legacy_purchases", targetId: id, before: { business: row.business }, after: { business } }, { now });
    }
    return { rows: 1, changed: changed ? 1 : 0, business, message: changed ? `Set to ${businessWord(business)}.` : `It was already ${businessWord(business)}.` };
  }
  if (typeof input.spellingKey !== "string") throw new Error("spellingKey must be text. Nothing was changed.");
  const key = input.spellingKey;
  const total = await tx.one<{ n: number }>("select count(*)::int as n from ops.legacy_purchases where spelling_key = $1 and superseded_at is null", [key]);
  if (total.n === 0) throw new Error("No row in the old list is written that way. Nothing was changed.");
  const moved = await tx.one<{ n: number }>(
    `with moved as (update ops.legacy_purchases set business = $2, business_set_by = $3, business_set_at = $4
                     where spelling_key = $1 and superseded_at is null and business is distinct from $2::text returning 1)
     select count(*)::int as n from moved`,
    [key, business, actor.staffId, now],
  );
  if (moved.n > 0) await audit.write(tx, { actorId: actor.staffId, action: "legacy_purchase.set_business", targetType: "legacy_purchase_spellings", targetId: key, after: { business, rows: total.n, changed: moved.n } }, { now });
  const words = `${total.n} row${total.n === 1 ? "" : "s"} written this way ${total.n === 1 ? "is" : "are"} now ${businessWord(business)}`;
  return { rows: total.n, changed: moved.n, business, message: moved.n === total.n ? `${words}.` : `${words} (${moved.n} changed; the rest already were).` };
}

export interface LinkResult {
  rows: number;
  supplier: { id: string; name: string } | null;
  /** True when this link added the spelling to the supplier's known spellings. */
  spellingAdded: boolean;
  message: string;
}

/**
 * Say that one spelling of the old list means a supplier on the app's list (admin or manager), or, with null,
 * take the link off. Linking sets the supplier on every live row of the spelling AND records the spelling as one of
 * the supplier's known spellings, so a future receipt printed that way is matched; the text as typed stays on
 * every row. Unlinking leaves the learnt spelling where it is, and says so. A spelling that already belongs to
 * another supplier is refused with the Receipts card's own words.
 */
export async function linkSupplier(tx: Tx, input: { spellingKey?: unknown; supplierId?: unknown }, actor: Actor, now: Date): Promise<LinkResult> {
  mayEdit(actor);
  if (typeof input.spellingKey !== "string") throw new Error("spellingKey must be text. Nothing was linked.");
  const key = input.spellingKey;
  if (key === "") throw new Error("A row with no supplier written has nothing to link. Nothing was linked.");
  await tx.query(SUPPLIER_LOCK);
  const forms = await tx.query<{ text: string }>(
    "select supplier_text as text from ops.legacy_purchases where spelling_key = $1 and superseded_at is null group by supplier_text order by count(*) desc, supplier_text",
    [key],
  );
  if (forms.length === 0) throw new Error("No row in the old list is written that way. Nothing was linked.");
  const rows = await tx.one<{ n: number }>("select count(*)::int as n from ops.legacy_purchases where spelling_key = $1 and superseded_at is null", [key]);
  if (input.supplierId === undefined || input.supplierId === null) {
    const was = await tx.maybeOne<{ supplier_id: string; display_name: string }>(
      `select s.supplier_id, s.display_name from ops.legacy_purchases p join ops.suppliers s on s.supplier_id = p.supplier_id
        where p.spelling_key = $1 and p.superseded_at is null order by p.row_id limit 1`,
      [key],
    );
    const n = await tx.one<{ n: number }>(
      `with moved as (update ops.legacy_purchases set supplier_id = null, linked_by = $2, linked_at = $3
                       where spelling_key = $1 and superseded_at is null and supplier_id is not null returning 1)
       select count(*)::int as n from moved`,
      [key, actor.staffId, now],
    );
    if (n.n > 0) await audit.write(tx, { actorId: actor.staffId, action: "legacy_purchase.unlink_supplier", targetType: "legacy_purchase_spellings", targetId: key, before: { supplierId: was?.supplier_id ?? null }, after: { supplierId: null, rows: n.n } }, { now });
    return {
      rows: rows.n,
      supplier: null,
      spellingAdded: false,
      message: n.n === 0 ? "It was not linked to a supplier." : `${n.n} row${n.n === 1 ? "" : "s"} unlinked. The spelling stays a known spelling of ${was?.display_name ?? "the supplier"}, so receipts printed that way are still matched to it.`,
    };
  }
  const sid = typeof input.supplierId === "string" && SUPPLIER_ID.test(input.supplierId) ? input.supplierId : null;
  const sup = sid === null ? null : await tx.maybeOne<{ supplier_id: string; display_name: string; active: boolean }>("select supplier_id, display_name, active from ops.suppliers where supplier_id = $1", [sid]);
  if (sup === null) throw new Error("No such supplier. Nothing was linked.");
  if (!sup.active) throw new Error(`${sup.display_name} is not an active supplier. Nothing was linked.`);
  const text = (forms[0] as (typeof forms)[number]).text;
  if (Array.from(text).length > SUPPLIER_NAME_MAX) throw new Error(`This spelling is longer than ${SUPPLIER_NAME_MAX} characters, so it cannot be a supplier's spelling. Nothing was linked.`);
  const spellingAdded = await addSpelling(tx, { id: sup.supplier_id, displayName: sup.display_name }, text, actor, now, null, (m) => new Error(`${m.replace(/ Untick it\.$/, " Link this spelling to that supplier instead, or leave it unlinked.")} Nothing was linked.`), "old_list");
  const n = await tx.one<{ n: number }>(
    `with moved as (update ops.legacy_purchases set supplier_id = $2, linked_by = $3, linked_at = $4
                     where spelling_key = $1 and superseded_at is null and supplier_id is distinct from $2::text returning 1)
     select count(*)::int as n from moved`,
    [key, sup.supplier_id, actor.staffId, now],
  );
  await audit.write(tx, { actorId: actor.staffId, action: "legacy_purchase.link_supplier", targetType: "legacy_purchase_spellings", targetId: key, after: { supplierId: sup.supplier_id, rows: rows.n, changed: n.n, spellingAdded } }, { now });
  return {
    rows: rows.n,
    supplier: { id: sup.supplier_id, name: sup.display_name },
    spellingAdded,
    message: `${rows.n} row${rows.n === 1 ? "" : "s"} written this way ${rows.n === 1 ? "is" : "are"} linked to ${sup.display_name}.${spellingAdded ? " A receipt printed that way will now be matched to it." : ""} The text as typed stays on each row.`,
  };
}
