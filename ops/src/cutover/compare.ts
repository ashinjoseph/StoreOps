// The cutover reconcile (card P4-03): what the Sheet held (the export directory) against what
// the database holds (what the import loaded), every difference reported.
//
// PURE: no database, no file system. The caller reads the export directory, the import report and
// the database, and hands them in.
//
// INDEPENDENT OF THE IMPORTER. If this file asked the importer what the Sheet's cells mean, a bug in
// that translation would be on both sides of the comparison and cancel out. So the Sheet side is
// computed here, from the raw exported cells, by the small rules below (each is the *documented
// effect* of the importer, written again, plainly):
//
//   a blank          "" (or nothing); in an id, actor or enum column also a whitespace-only text
//   a figure         a number, or text of digits with an optional sign and point ("12.5"); read
//                    EXACTLY, as a count of the column's smallest unit (cents for numeric(.,2)); a
//                    figure with more decimals than the column has is not readable
//   a text           as it is; an id column (key, *_id, *_by) trimmed; an enum column trimmed and
//                    matched without case to the contract's spelling
//   a date column    a date cell becomes its America/Toronto day; text "YYYY-MM-DD" stays
//   a timestamptz    the exact instant; an ISO text with an offset is that instant
//   a boolean        TRUE/FALSE (or the text "true"/"false"); blank is false only in staff.active and
//                    commission_rules.active
//   a required blank in a column with a text default (rule_type) is that default
//
// From src/import this file takes TYPES only (the contract's shape, which is what parseContract returns).
// It imports nothing that transforms a value.
//
// Money is added in integer units (cents), never as floating point; a sum is a BigInt.
//
// What it never puts in its result: a cell value of a text, name, pay-rate, login or phone column
// (those say "differs"), a login code, a PIN hash, a URL. A money difference is a size in cents.
// Money SUMS per month are in the result: that is the point of it.
import { SECRET_KEYS } from "../lib/config-keys";
import type { Column, Contract, Table } from "../import/sheet-to-db";

export const REPORT_FORMAT = "storeops-reconcile-report/1";
/** The import report's format this tool reads. */
export const IMPORT_REPORT_FORMAT = "storeops-import-report/1";
export const LIST_CAP = 50;

/** Tables that only the new app has: no tab feeds them. Listed with their counts, never compared. */
export const OPS_ONLY_TABLES: readonly string[] = ["stores", "staff_stores", "sessions", "login_failures"];
/**
 * Operations-only tables that later migrations add, outside the frozen contract (schema.sql is 0001):
 * no tab feeds them, so they are never loaded, read or compared, and they are not "a table the contract
 * does not have". Each later card that adds such a table adds its name here.
 */
export const LATER_OPS_TABLES: readonly string[] = [
  // card P5-11, the MCP door (0009_assistant_keys.sql)
  "assistant_keys",
  "assistant_calls",
  // card P5-12a, the two businesses and the receipt inbox (0010_receipt_inbox.sql)
  "businesses",
  "business_signs",
  "receipt_originals",
  // card P5-02b, the till link's matches (0011_till_links.sql)
  "till_stores",
  "till_staff_links",
  // card P5-12b, the assistant's upload tickets for the receipt inbox (0012_receipt_upload_tickets.sql)
  "receipt_upload_tickets",
];

/** The column each table's rows are grouped by, per month (America/Toronto). null: the table has no date. */
export const DATE_COLUMN: Readonly<Record<string, string | null>> = {
  config: null,
  staff: "start_date",
  attendance: "date",
  till_sessions: "date",
  sales: "date",
  validation_results: "business_date",
  cash_handovers: "handed_on",
  cash_handover_items: null,
  commission_rules: "effective_from",
  commission_runs: "week_start",
  bonuses: "date",
  payments: "paid_on",
  payment_items: null,
  audit_log: "timestamp",
};

/** Numeric columns that hold a person's pay rate: compared, but never shown, never summed. */
const RATE_COLUMNS = new Set(["staff.hourly_rate", "attendance.rate_at_attendance"]);
const BLANK_IS_FALSE = new Set(["staff.active", "commission_rules.active"]);
/** Columns the database has beyond the contract that this tool reads (by table). */
export const DB_ONLY_READ: Readonly<Record<string, readonly string[]>> = { staff: ["pin_hash"], payments: ["voided_at"] };
/** What the importer (default) writes into store_id. */
const STORE_ID = "store_main";
const SHEET_FIRST_ROW = 3;
const TZ = "America/Toronto";

export class ReconcileRefused extends Error {}

// ── The inputs ───────────────────────────────────────────────

/** One exported tab: its header row and data rows (the first data row is Sheet row 3). */
export interface SheetTabIn {
  name: string;
  header: unknown[];
  rows: unknown[][];
}

/** What the database holds of one table. Every value is text (or null), as read-db.ts selects it. */
export interface DbTableIn {
  /** false: the table does not exist. */
  present: boolean;
  /** The columns the table has (all of them, by name). */
  columns: string[];
  hasSeq: boolean;
  /** In `seq` order where there is one, else primary-key order. */
  rows: Record<string, string | null>[];
}
export interface DbSnapshot {
  tables: Record<string, DbTableIn>;
  /** Every table in schema ops (the migration bookkeeping table excluded). */
  allTables: string[];
  /** Row counts of the tables only the new app has. */
  opsOnlyCounts: Record<string, number>;
}

export interface ImportTableLine {
  table: string;
  tabRows: number;
  loaded: number;
  rejected: number;
  reKeyed: number;
  blankKey: number;
  leftOut: number;
}
export interface ImportEvidence {
  mode: string;
  outcome: string;
  workbookSha256: string;
  manifestSha256: string;
  tabSha256: Record<string, string>;
  acceptRejects: number | null;
  openSessionsBlank: boolean;
  rowsWithClosingFigures: number;
  tables: ImportTableLine[];
  rejects: { tab: string; row: number; column: string; reason: string }[];
  rekeyed: { table: string; originalId: string; newId: string; row: number }[];
  leftOutRows: { table: string; id: string; row: number }[];
  configKeysLeftOut: { row: number; key: string }[];
  pinsHashed: number;
  pinsBlank: { staffId: string; row: number }[];
  skippedTabs: { tab: string; rows: number }[];
  rejectCount: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const whole = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const SAFE_TEXT = /^[A-Za-z0-9 _.,;:()'/<>=-]{1,160}$/;

/** A mini CSV reader for rejects.csv: quoted fields, doubled quotes, \n or \r\n. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Read import-report.json (parsed) and rejects.csv (its text) into the evidence. Throws ReconcileRefused when they are not what the importer writes. */
export function parseImportReport(report: unknown, rejectsCsv: string): ImportEvidence {
  const bad = (what: string): never => {
    throw new ReconcileRefused(`the import report is not in the shape tools/import.ts writes (${what}).`);
  };
  if (!isObject(report) || report["format"] !== IMPORT_REPORT_FORMAT) return bad(`its format is not ${IMPORT_REPORT_FORMAT}`);
  const exp = report["export"];
  if (!isObject(exp) || !isObject(exp["workbook"]) || typeof exp["workbook"]["sha256"] !== "string" || typeof exp["manifestSha256"] !== "string" || !Array.isArray(exp["tabs"])) return bad("export");
  const tabSha256: Record<string, string> = {};
  for (const t of exp["tabs"] as unknown[]) {
    if (!isObject(t) || typeof t["name"] !== "string" || typeof t["sha256"] !== "string") return bad("export.tabs");
    tabSha256[t["name"]] = t["sha256"];
  }
  const options = isObject(report["options"]) ? report["options"] : {};
  const tablesRaw = report["tables"];
  if (!Array.isArray(tablesRaw)) return bad("tables");
  const tables: ImportTableLine[] = [];
  for (const t of tablesRaw as unknown[]) {
    if (!isObject(t) || typeof t["table"] !== "string") return bad("tables");
    const n = (k: string): number => (whole(t[k]) ? (t[k] as number) : (bad(`tables.${k}`) as never));
    tables.push({ table: t["table"], tabRows: n("tabRows"), loaded: n("loaded"), rejected: n("rejected"), reKeyed: n("reKeyed"), blankKey: n("blankKey"), leftOut: n("leftOut") });
  }
  const rules = report["rules"];
  if (!isObject(rules)) return bad("rules");
  const dup = isObject(rules["duplicateKeys"]) ? rules["duplicateKeys"] : {};
  const placeholders = isObject(rules["placeholders"]) ? rules["placeholders"] : {};
  const pins = isObject(rules["pins"]) ? rules["pins"] : {};
  const open = isObject(rules["openSessions"]) ? rules["openSessions"] : {};
  const list = (v: unknown, what: string): Record<string, unknown>[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every(isObject)) return bad(what);
    return v as Record<string, unknown>[];
  };
  const rekeyed = list(dup["reKeyed"], "reKeyed").map((r) => {
    if (typeof r["table"] !== "string" || typeof r["originalId"] !== "string" || typeof r["newId"] !== "string" || !whole(r["row"])) return bad("reKeyed entry");
    return { table: r["table"], originalId: r["originalId"], newId: r["newId"], row: r["row"] as number };
  });
  const leftOutRows = list(placeholders["leftOut"], "placeholders").map((r) => {
    if (typeof r["table"] !== "string" || typeof r["id"] !== "string" || !whole(r["row"])) return bad("placeholder entry");
    return { table: r["table"], id: r["id"], row: r["row"] as number };
  });
  const configKeysLeftOut = list(rules["configKeysLeftOut"], "configKeysLeftOut").map((r) => {
    if (typeof r["key"] !== "string" || !whole(r["row"])) return bad("configKeysLeftOut entry");
    return { row: r["row"] as number, key: r["key"] };
  });
  const pinsBlank = list(pins["blank"], "pins.blank").map((r) => {
    if (typeof r["staffId"] !== "string" || !whole(r["row"])) return bad("pins.blank entry");
    return { staffId: r["staffId"], row: r["row"] as number };
  });
  const skippedTabs = (Array.isArray(report["skippedTabs"]) ? (report["skippedTabs"] as unknown[]) : []).map((s) => {
    if (!isObject(s) || typeof s["tab"] !== "string" || !whole(s["rows"])) return bad("skippedTabs entry");
    return { tab: s["tab"], rows: s["rows"] as number };
  });
  const rejectsInfo = report["rejects"];
  if (!isObject(rejectsInfo) || !whole(rejectsInfo["count"])) return bad("rejects");

  const csv = parseCsv(rejectsCsv);
  const head = csv[0] ?? [];
  if (head.join(",") !== "tab,row,column,reason") throw new ReconcileRefused("rejects.csv does not start with the header line tab,row,column,reason.");
  const rejects = csv.slice(1).map((f, i) => {
    if (f.length !== 4 || !/^[1-9][0-9]{0,8}$/.test(f[1] as string)) throw new ReconcileRefused(`rejects.csv line ${i + 2} is not tab,row,column,reason.`);
    return { tab: f[0] as string, row: Number(f[1]), column: f[2] as string, reason: SAFE_TEXT.test(f[3] as string) ? (f[3] as string) : "(unusual text)" };
  });

  return {
    mode: String(report["mode"] ?? ""),
    outcome: String(report["outcome"] ?? ""),
    workbookSha256: exp["workbook"]["sha256"],
    manifestSha256: exp["manifestSha256"],
    tabSha256,
    acceptRejects: whole(options["acceptRejects"]) ? (options["acceptRejects"] as number) : null,
    openSessionsBlank: open["flag"] === true,
    rowsWithClosingFigures: whole(open["rowsWithClosingFigures"]) ? (open["rowsWithClosingFigures"] as number) : 0,
    tables,
    rejects,
    rekeyed,
    leftOutRows,
    configKeysLeftOut,
    pinsHashed: whole(pins["hashed"]) ? (pins["hashed"] as number) : 0,
    pinsBlank,
    skippedTabs,
    rejectCount: rejectsInfo["count"] as number,
  };
}

/** Why this import report cannot be the one for this export (empty when it can). */
export function reportBelongsToExport(evidence: ImportEvidence, manifest: { workbookSha256: string; manifestSha256: string; tabSha256: Record<string, string> }): string[] {
  const problems: string[] = [];
  if (evidence.workbookSha256 !== manifest.workbookSha256) problems.push("the import report was made from a different workbook (its SHA-256 is not the one in the export's manifest)");
  if (evidence.manifestSha256 !== manifest.manifestSha256) problems.push("the import report was made from a different export (manifest.json differs)");
  for (const [name, sha] of Object.entries(manifest.tabSha256)) {
    if (evidence.tabSha256[name] !== sha) problems.push(`the import report knows tab "${name}" with a different checksum`);
  }
  for (const name of Object.keys(evidence.tabSha256)) if (!(name in manifest.tabSha256)) problems.push(`the import report lists a tab "${name}" that this export does not have`);
  if (evidence.mode !== "import") problems.push(`the import report is of a "${evidence.mode}" run, not a real import`);
  else if (evidence.outcome !== "committed") problems.push("the import report says the import was not committed: there is nothing to reconcile");
  return problems;
}

// ── Exact arithmetic ─────────────────────────────────────────

/** "12.5" / "-3" / "1e-7" as a whole number of units of 10^-scale, or null: not a plain decimal, or more decimals than `scale`. */
export function toUnits(text: string, scale: number): bigint | null {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!m) return null;
  const frac = m[3] ?? "";
  const exp = (m[4] !== undefined ? Number(m[4]) : 0) - frac.length + scale;
  if (Math.abs(exp) > 400) return null;
  let n = BigInt((m[2] as string) + frac);
  if (exp >= 0) n *= 10n ** BigInt(exp);
  else {
    const d = 10n ** BigInt(-exp);
    if (n % d !== 0n) return null;
    n /= d;
  }
  return m[1] === "-" ? -n : n;
}

export function formatUnits(n: bigint, scale: number): string {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(scale + 1, "0");
  const body = scale === 0 ? s : `${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`;
  return neg ? `-${body}` : body;
}

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

const DAY_PARTS = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
/** The America/Toronto day of an instant, "YYYY-MM-DD". */
export function torontoDay(d: Date): string {
  const v: Record<string, string> = {};
  for (const p of DAY_PARTS.formatToParts(d)) v[p.type] = p.value;
  return `${v["year"]}-${v["month"]}-${v["day"]}`;
}

/** An instant as the database side spells it: UTC, microseconds. */
const instantText = (d: Date): string => `${d.toISOString().slice(0, 23)}000Z`;

// ── Reading a Sheet cell ─────────────────────────────────────

/** What a Sheet cell should have become: nothing (NULL), a value, or "cannot be read as this column's type". */
type Expected = { k: "null" } | { k: "val"; v: string; n?: bigint } | { k: "bad"; why: string };
const NULL: Expected = { k: "null" };

const isBlankCell = (c: unknown): boolean => c === "" || c === null || c === undefined;
const isIdColumn = (c: Column): boolean => c.primaryKey || c.name.endsWith("_id") || c.name.endsWith("_by");
const NUMERIC_TEXT = /^[+-]?\d+(\.\d+)?$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Text columns where the app wrote a day as text and Google Sheets turned it into a date cell
 * (every reconcile entry in the audit log has the business day as its target). The expected
 * database value is that day in text, and only when the cell is exactly midnight in Toronto.
 * This check's own statement of the rule: nothing is taken from the importer.
 */
const DAY_AS_TEXT: ReadonlySet<string> = new Set(["audit_log.target_id"]);
const OFFSET_PARTS = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
/** The instant of 00:00:00.000 in Toronto on the day "YYYY-MM-DD" (the offset is read at a guess near it, then applied). */
function midnightOf(day: string): number {
  const utc = Date.parse(`${day}T00:00:00.000Z`);
  for (const guess of [utc + 4 * 3600_000, utc + 5 * 3600_000]) {
    const p: Record<string, string> = {};
    for (const x of OFFSET_PARTS.formatToParts(new Date(guess))) p[x.type] = x.value;
    if (`${p["year"]}-${p["month"]}-${p["day"]}` === day && p["hour"] === "00" && p["minute"] === "00" && p["second"] === "00") return guess;
  }
  return Number.NaN;
}

function readCell(table: string, col: Column, cell: unknown): Expected {
  const whiteBlank = (isIdColumn(col) || col.enumValues !== undefined) && typeof cell === "string" && cell.trim() === "";
  if (isBlankCell(cell) || whiteBlank) {
    if (col.type === "boolean" && BLANK_IS_FALSE.has(`${table}.${col.name}`)) return { k: "val", v: "false" };
    if (col.notNull) {
      if (col.type === "text" && col.defaultText !== undefined) return { k: "val", v: col.defaultText };
      return { k: "bad", why: "blank in a required column" };
    }
    return NULL;
  }
  switch (col.type) {
    case "numeric":
    case "integer":
    case "bigint": {
      let text: string;
      if (typeof cell === "number" && Number.isFinite(cell)) text = String(cell);
      else if (typeof cell === "string" && NUMERIC_TEXT.test(cell.trim())) text = cell.trim();
      else return { k: "bad", why: "not a figure" };
      const n = toUnits(text, col.scale ?? 0);
      if (n === null) return { k: "bad", why: "more decimals than the column holds" };
      return { k: "val", v: n.toString(), n };
    }
    case "date": {
      if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? { k: "bad", why: "invalid date" } : { k: "val", v: torontoDay(cell) };
      if (typeof cell === "string") {
        const m = ISO_DAY.exec(cell);
        if (m) {
          const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
          const t = new Date(Date.UTC(y, mo - 1, d));
          if (t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d) return { k: "val", v: cell };
        }
      }
      return { k: "bad", why: "not a date" };
    }
    case "timestamptz": {
      if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? { k: "bad", why: "invalid date" } : { k: "val", v: instantText(cell) };
      if (typeof cell === "string" && ISO_INSTANT.test(cell.trim())) {
        const t = new Date(cell.trim());
        if (!Number.isNaN(t.getTime())) return { k: "val", v: instantText(t) };
      }
      return { k: "bad", why: "not a timestamp" };
    }
    case "boolean": {
      if (typeof cell === "boolean") return { k: "val", v: String(cell) };
      if (typeof cell === "string") {
        const s = cell.trim().toLowerCase();
        if (s === "true" || s === "false") return { k: "val", v: s };
      }
      return { k: "bad", why: "not TRUE or FALSE" };
    }
    case "text": {
      let s: string;
      if (typeof cell === "string") s = cell;
      else if (typeof cell === "number" && Number.isFinite(cell)) s = String(cell);
      else if (typeof cell === "boolean") s = String(cell);
      else if (cell instanceof Date && !Number.isNaN(cell.getTime()) && DAY_AS_TEXT.has(`${table}.${col.name}`) && cell.getTime() === midnightOf(torontoDay(cell))) s = torontoDay(cell);
      else return { k: "bad", why: "not text" };
      if (isIdColumn(col)) s = s.trim();
      if (col.enumValues) {
        s = s.trim();
        const hit = col.enumValues.find((v) => v.toLowerCase() === s.toLowerCase());
        return hit === undefined ? { k: "bad", why: "not one of the allowed words" } : { k: "val", v: hit };
      }
      return { k: "val", v: s };
    }
    case "bytea":
      return { k: "bad", why: "binary" };
  }
}

/** What the database holds in a cell, in the same terms. `text` is as read-db.ts selected it. */
function readDbCell(col: Column, text: string | null | undefined): Expected {
  if (text === null || text === undefined) return NULL;
  if (col.type === "numeric" || col.type === "integer" || col.type === "bigint") {
    const n = toUnits(text, col.scale ?? 0);
    return n === null ? { k: "bad", why: "the database figure is not a plain decimal" } : { k: "val", v: n.toString(), n };
  }
  return { k: "val", v: text };
}

// ── Result types ─────────────────────────────────────────────

export type DiffKind =
  | "row_count"
  | "missing_from_database"
  | "extra_in_database"
  | "value"
  | "blank_count"
  | "month_rows"
  | "month_sum"
  | "month_blank"
  | "order"
  | "secret_config"
  | "pin_hash"
  | "report_integrity"
  | "schema"
  | "sheet_id"
  | "database_only";

export interface Diff {
  table: string;
  kind: DiffKind;
  /** The Sheet row number, where one row is meant. */
  row?: number;
  /** The name of the table's key column (never a key value). */
  keyColumn?: string;
  column?: string;
  /** Human text. Never a text, name, pay-rate, login or phone value. */
  message: string;
}

export interface ColumnMonth {
  sheetSum: string;
  dbSum: string;
  /** database minus Sheet, in the column's own units ("0.01"); "0.00" when equal. */
  diff: string;
  sheetBlank: number;
  dbBlank: number;
}
export interface MonthLine {
  /** "YYYY-MM", "no date" or "unreadable date". */
  month: string;
  sheetRows: number;
  dbRows: number;
  columns: Record<string, ColumnMonth>;
}
export interface NotComparedColumn {
  column: string;
  reason: string;
}
export interface TableResult {
  table: string;
  dateColumn: string | null;
  /** The columns summed per month (every numeric and integer column except pay rates). */
  sumColumns: string[];
  comparedColumns: string[];
  notCompared: NotComparedColumn[];
  rows: {
    /** Rows of the tab (all). */
    tab: number;
    withId: number;
    empty: number;
    keylessWithValues: number;
    inDatabase: number;
    rejected: number;
    leftOut: number;
    reKeyed: number;
  };
  notLoaded: {
    rejected: { row: number; columns: string[]; reasons: string[] }[];
    leftOut: { row: number; why: string }[];
    /** Per money column: the Sheet's sum over the rows not loaded. */
    sums: Record<string, string>;
    /** Cells in those rows that cannot be read as a figure (not summed). */
    unreadableFigures: number;
  };
  /** open till rows whose closing columns --open-sessions-blank deliberately blanked (explained). */
  openBlanked: { rows: number; cellsByColumn: Record<string, number> } | null;
  months: MonthLine[];
  blanks: { column: string; sheet: number; db: number }[];
  differenceCount: number;
  differences: Diff[];
}

export interface CheckLine {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ReconcileResult {
  format: string;
  tables: TableResult[];
  opsOnly: { table: string; rows: number }[];
  deprecated: { tab: string; sheetRows: number; tableInDatabase: boolean }[];
  checks: CheckLine[];
  /** Differences that belong to no table, or to a check. */
  otherDifferences: Diff[];
  /** Every difference counted: the number the exit code is made from. */
  unexplained: number;
  explained: { rejectedRows: number; leftOutRows: number; reKeyed: number; openBlankedRows: number };
}

// ── One table ────────────────────────────────────────────────

const colCategory = (table: string, col: Column): "money" | "number" | "rate" | "enum" | "temporal" | "boolean" | "text" => {
  if (RATE_COLUMNS.has(`${table}.${col.name}`)) return "rate";
  if (col.type === "numeric" || col.type === "integer" || col.type === "bigint") return col.type === "numeric" && col.scale === 2 ? "money" : "number";
  if (col.type === "date" || col.type === "timestamptz") return "temporal";
  if (col.type === "boolean") return "boolean";
  if (col.enumValues) return "enum";
  return "text";
};

const showExp = (e: Expected, col: Column): string => (e.k === "null" ? "blank" : e.k === "val" ? (col.type === "numeric" ? e.v : e.v) : "unreadable");
const unitName = (col: Column): string => (col.scale === 2 ? "cent" : col.scale === 0 ? "unit" : `1/${10 ** (col.scale ?? 0)}`);

/** How two readings of one cell differ, as text safe to print; null when they are the same. */
function describeCellDifference(table: string, col: Column, sheet: Expected, db: Expected): string | null {
  if (sheet.k === "bad") return `the Sheet cell cannot be read as ${col.type} (${sheet.why}), yet the row was loaded`;
  if (db.k === "bad") return db.why;
  if (sheet.k === "null" && db.k === "null") return null;
  const cat = colCategory(table, col);
  if (sheet.k === "null") return cat === "text" || cat === "rate" ? "the Sheet cell is blank, the database holds a value" : cat === "money" || cat === "number" ? "the Sheet cell is blank, the database holds a figure (blank became a figure)" : `Sheet blank, database ${showExp(db, col)}`;
  if (db.k === "null") return cat === "text" || cat === "rate" ? "the Sheet holds a value, the database is blank" : cat === "money" || cat === "number" ? "the Sheet holds a figure, the database is blank (figure became blank)" : `Sheet ${showExp(sheet, col)}, database blank`;
  if (sheet.k !== "val" || db.k !== "val") return null;
  if (sheet.n !== undefined && db.n !== undefined) {
    if (sheet.n === db.n) return null;
    if (cat === "rate") return "differs";
    const d = abs(db.n - sheet.n);
    const unit = unitName(col);
    return `differs by ${d} ${unit}${d === 1n ? "" : "s"}`;
  }
  if (sheet.v === db.v) return null;
  if (cat === "enum" || cat === "temporal" || cat === "boolean") return `Sheet ${sheet.v}, database ${db.v}`;
  return "differs";
}

const monthOfExpected = (col: Column | undefined, e: Expected | undefined): string => {
  if (!col) return "all";
  if (!e || e.k === "null") return "no date";
  if (e.k === "bad") return "unreadable date";
  if (col.type === "date") return e.v.slice(0, 7);
  // an instant: its Toronto month
  return torontoDay(new Date(`${e.v.slice(0, 23)}Z`)).slice(0, 7);
};

const trimmedKey = (cell: unknown): string | null => {
  if (isBlankCell(cell)) return null;
  if (typeof cell === "string") return cell.trim() === "" ? null : cell.trim();
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  return null;
};

interface PinRow {
  staffId: string;
  sheetRow: number;
  expectHash: boolean;
  /** the code as text; used only to prove it is not in the hash, never printed */
  code: string | null;
  pinHash: string | null;
}

function configKeyIsSecret(key: string): boolean {
  const k = key.trim().toLowerCase();
  return /token|secret|password|api_key|_key$|credential/.test(k) || (SECRET_KEYS as readonly string[]).includes(k) || k === "whatsapp_template_shopping_list";
}

interface TableOutput {
  result: TableResult;
  pins?: PinRow[];
  matchedKeys: Set<string>;
}

function compareTable(contract: Contract, table: Table, tab: SheetTabIn | undefined, dbT: DbTableIn | undefined, ev: ImportEvidence, tabs: Map<string, SheetTabIn>, openBlank: boolean): TableOutput {
  const name = table.name;
  const pk = table.columns.find((c) => c.primaryKey) as Column;
  const diffs: Diff[] = [];
  const add = (d: Omit<Diff, "table">): void => void diffs.push({ table: name, ...d });
  const dateName = DATE_COLUMN[name] ?? null;
  const result: TableResult = {
    table: name,
    dateColumn: dateName,
    sumColumns: [],
    comparedColumns: [],
    notCompared: [],
    rows: { tab: 0, withId: 0, empty: 0, keylessWithValues: 0, inDatabase: 0, rejected: 0, leftOut: 0, reKeyed: 0 },
    notLoaded: { rejected: [], leftOut: [], sums: {}, unreadableFigures: 0 },
    openBlanked: null,
    months: [],
    blanks: [],
    differenceCount: 0,
    differences: [],
  };
  const finish = (): TableOutput => {
    result.differenceCount = diffs.length;
    result.differences = diffs;
    return { result, matchedKeys: new Set() };
  };
  if (!tab) {
    add({ kind: "schema", message: `the export has no tab "${name}"` });
    return finish();
  }
  if (!dbT || !dbT.present) {
    add({ kind: "schema", message: `the database has no table ${name}` });
    result.rows.tab = tab.rows.length;
    return finish();
  }

  // Header: name -> position, first occurrence wins.
  const at = new Map<string, number>();
  tab.header.forEach((h, i) => {
    const n = String(h ?? "").trim();
    if (n !== "" && !at.has(n)) at.set(n, i);
  });
  const known = new Set(table.columns.map((c) => c.name));
  const dbCols = new Set(dbT.columns);
  const present = table.columns.filter((c) => c.name !== "store_id" && at.has(c.name));
  const pkAt = at.get(pk.name);
  if (pkAt === undefined) {
    add({ kind: "schema", keyColumn: pk.name, message: `the tab has no "${pk.name}" column: its rows cannot be matched` });
    result.rows.tab = tab.rows.length;
    return finish();
  }
  for (const c of table.columns) {
    if (c.name === "store_id") continue;
    if (!at.has(c.name)) result.notCompared.push({ column: c.name, reason: "not in the Sheet's header (nothing to compare)" });
    else if (!dbCols.has(c.name)) {
      result.notCompared.push({ column: c.name, reason: "the database table lacks this column" });
      add({ kind: "schema", column: c.name, message: `the database table ${name} has no column ${c.name}` });
    }
  }
  for (const h of at.keys()) if (!known.has(h)) result.notCompared.push({ column: h, reason: h === "store_id" ? "set by the importer, not a Sheet value" : contract.leftColumns.has(`${name}.${h}`) ? "left out by the contract: never imported" : "a Sheet column that is not in the contract (not imported)" });
  for (const extra of DB_ONLY_READ[name] ?? []) result.notCompared.push({ column: extra, reason: extra === "pin_hash" ? "database only; checked separately (never compared with a Sheet value)" : "database only: must be empty after an import" });
  if (dbT.hasSeq) result.notCompared.push({ column: "seq", reason: "database only; the ORDER of rows by seq is checked against the tab's order" });
  const compared = present.filter((c) => dbCols.has(c.name));
  result.comparedColumns = [...compared.map((c) => c.name), ...(dbCols.has("store_id") && table.columns.some((c) => c.name === "store_id") ? ["store_id"] : [])];
  const sumCols = compared.filter((c) => (c.type === "numeric" || c.type === "integer" || c.type === "bigint") && !RATE_COLUMNS.has(`${name}.${c.name}`));
  result.sumColumns = sumCols.map((c) => c.name);
  const dateCol = dateName ? compared.find((c) => c.name === dateName) : undefined;

  // The import report's claims about this tab, checked against the tab itself as we go.
  const rejectsHere = new Map<number, { columns: string[]; reasons: string[] }>();
  for (const r of ev.rejects) {
    if (r.tab !== name) continue;
    const e = rejectsHere.get(r.row) ?? { columns: [], reasons: [] };
    e.columns.push(r.column);
    e.reasons.push(r.reason);
    rejectsHere.set(r.row, e);
  }
  const leftOutHere = new Map<number, string>();
  for (const p of ev.leftOutRows) if (p.table === name) leftOutHere.set(p.row, `placeholder ${p.id}`);
  if (name === "config") for (const k of ev.configKeysLeftOut) leftOutHere.set(k.row, `secret key ${k.key}`);
  const rekeyHere = new Map<number, string>();
  for (const k of ev.rekeyed) if (k.table === name) rekeyHere.set(k.row, k.newId);

  const nRows = tab.rows.length;
  const lastRow = SHEET_FIRST_ROW + nRows - 1;
  const rowKey = (i: number): string | null => trimmedKey((tab.rows[i] as unknown[])[pkAt]);
  const rowIsEmpty = (i: number): boolean => (tab.rows[i] as unknown[]).every((c) => isBlankCell(c) || (typeof c === "string" && c.trim() === ""));

  for (const [row] of rejectsHere) {
    const i = row - SHEET_FIRST_ROW;
    if (i < 0 || i >= nRows) add({ kind: "report_integrity", row, keyColumn: pk.name, message: `the import report lists a rejected row ${row}, but the tab's rows end at ${lastRow}` });
    else if (rowIsEmpty(i)) add({ kind: "report_integrity", row, keyColumn: pk.name, message: `the import report lists row ${row} as rejected, but that Sheet row is empty` });
  }
  for (const [row, why] of leftOutHere) {
    const i = row - SHEET_FIRST_ROW;
    if (i < 0 || i >= nRows) add({ kind: "report_integrity", row, keyColumn: pk.name, message: `the import report lists a left-out row ${row} (${why}), but the tab's rows end at ${lastRow}` });
    else if (rowKey(i) === null) add({ kind: "report_integrity", row, keyColumn: pk.name, message: `the import report lists row ${row} as left out (${why}), but that Sheet row has no id` });
  }

  // Walk the tab.
  interface Keyed {
    row: number;
    i: number;
    key: string;
  }
  const expectedRows: Keyed[] = [];
  const seenKeys = new Map<string, number>();
  const firstById = new Map<string, number>();
  let rejectedKeyed = 0;
  let leftOutKeyed = 0;
  for (let i = 0; i < nRows; i++) {
    const row = SHEET_FIRST_ROW + i;
    const key = rowKey(i);
    result.rows.tab++;
    if (key === null) {
      if (rowIsEmpty(i)) result.rows.empty++;
      else {
        result.rows.keylessWithValues++;
        const listed = rejectsHere.get(row);
        if (!listed) add({ kind: "report_integrity", row, keyColumn: pk.name, message: `row ${row} has no id but holds values, and the import report does not list it as rejected` });
        else result.notLoaded.rejected.push({ row, columns: [...new Set(listed.columns)], reasons: [...new Set(listed.reasons)] });
      }
      continue;
    }
    result.rows.withId++;
    const rejected = rejectsHere.get(row);
    const leftOut = leftOutHere.get(row);
    if (rejected) {
      rejectedKeyed++;
      result.notLoaded.rejected.push({ row, columns: [...new Set(rejected.columns)], reasons: [...new Set(rejected.reasons)] });
      if (leftOut) add({ kind: "report_integrity", row, keyColumn: pk.name, message: `row ${row} is listed both as rejected and as left out` });
      continue;
    }
    if (leftOut) {
      leftOutKeyed++;
      result.notLoaded.leftOut.push({ row, why: leftOut });
      continue;
    }
    if (!firstById.has(key)) firstById.set(key, row);
    expectedRows.push({ row, i, key: rekeyHere.get(row) ?? key });
  }
  result.rows.rejected = rejectedKeyed + result.rows.keylessWithValues;
  result.rows.leftOut = leftOutKeyed;
  result.rows.reKeyed = rekeyHere.size;

  // The re-key list must be true: each entry is a later repeat of an id.
  for (const k of ev.rekeyed) {
    if (k.table !== name) continue;
    const i = k.row - SHEET_FIRST_ROW;
    const own = i >= 0 && i < nRows ? rowKey(i) : null;
    const earlier = own === null ? undefined : firstById.get(own);
    if (own === null || own !== k.originalId || earlier === undefined || earlier >= k.row || !k.newId.startsWith(`${k.originalId}-d`)) {
      add({ kind: "report_integrity", row: k.row, keyColumn: pk.name, message: `the import report re-keys row ${k.row}, but that Sheet row is not a later repeat of the id it names` });
    }
  }

  // Placeholders and secrets the report left out must be what it says.
  if (name === "commission_rules" || name === "commission_runs") {
    const bonuses = tabs.get("bonuses");
    const bAt = (n: string): number => (bonuses ? bonuses.header.findIndex((h) => String(h ?? "").trim() === n) : -1);
    const refAt = bAt(name === "commission_rules" ? "source_rule_id" : "source_run_id");
    const activeAt = at.get("active");
    for (const p of ev.leftOutRows) {
      if (p.table !== name) continue;
      const i = p.row - SHEET_FIRST_ROW;
      const own = i >= 0 && i < nRows ? rowKey(i) : null;
      if (own === null) continue; // already reported above
      const placeholderId = name === "commission_rules" ? own === "CR_001" : own.startsWith("CRN_PLACEHOLDER");
      const referenced = bonuses !== undefined && refAt >= 0 && bonuses.rows.some((r) => trimmedKey(r[refAt]) === own);
      const activeCol = table.columns.find((c) => c.name === "active");
      const active = name === "commission_rules" && activeAt !== undefined && activeCol ? readCell(name, activeCol, (tab.rows[i] as unknown[])[activeAt]) : undefined;
      if (own !== p.id || !placeholderId) add({ kind: "report_integrity", row: p.row, keyColumn: pk.name, message: `the import report leaves out row ${p.row} as a placeholder, but its id is not a seeded placeholder` });
      else if (referenced) add({ kind: "report_integrity", row: p.row, keyColumn: pk.name, message: `the import report leaves out row ${p.row} as an unused placeholder, but a bonus refers to it` });
      else if (active && !(active.k === "val" && active.v === "false")) add({ kind: "report_integrity", row: p.row, keyColumn: pk.name, message: `the import report leaves out row ${p.row} as an inactive placeholder, but that rule is not inactive in the Sheet` });
    }
  }
  if (name === "config") {
    for (const k of ev.configKeysLeftOut) {
      const i = k.row - SHEET_FIRST_ROW;
      const own = i >= 0 && i < nRows ? rowKey(i) : null;
      if (own === null) continue;
      if (k.key !== "(unusual name)" && own !== k.key) add({ kind: "report_integrity", row: k.row, keyColumn: pk.name, message: `the import report leaves out config row ${k.row} as secret key ${k.key}, but that row's key is not that name` });
      else if (!configKeyIsSecret(own)) add({ kind: "report_integrity", row: k.row, keyColumn: pk.name, message: `the import report leaves out config row ${k.row} as a secret, but its key does not look like one` });
    }
  }

  // Index the database rows by key.
  const dbByKey = new Map<string, Record<string, string | null>>();
  for (const r of dbT.rows) dbByKey.set(String(r[pk.name]), r);
  result.rows.inDatabase = dbT.rows.length;

  // Row counts: the tab's rows with an id = rows in the table + rejected + left out.
  const keyedRejected = rejectedKeyed;
  if (result.rows.withId !== dbT.rows.length + keyedRejected + leftOutKeyed) {
    add({
      kind: "row_count",
      keyColumn: pk.name,
      message: `row count: the tab has ${result.rows.withId} rows with an id; the database has ${dbT.rows.length}, the import report explains ${keyedRejected} rejected and ${leftOutKeyed} left out: ${result.rows.withId - dbT.rows.length - keyedRejected - leftOutKeyed} row(s) unexplained`,
    });
  }

  // Expected values, row by row.
  const sheetCells = new Map<number, Map<string, Expected>>();
  const openRows: number[] = [];
  const openCols = ["closing_cash_counted", "cash_left_in_till", "cash_removed_at_close", "expected_cash", "closing_variance"];
  const cellsByColumn: Record<string, number> = {};
  const used = new Map<string, Keyed>();
  const matched = new Set<string>();
  const unmatchedKeys: Keyed[] = [];
  for (const er of expectedRows) {
    if (used.has(er.key)) {
      const first = used.get(er.key) as Keyed;
      add({ kind: "sheet_id", row: er.row, keyColumn: pk.name, message: `row ${er.row} has the same id as row ${first.row}; the import report neither rejected nor re-keyed it` });
      continue;
    }
    used.set(er.key, er);
    const cells = tab.rows[er.i] as unknown[];
    const m = new Map<string, Expected>();
    for (const c of present) m.set(c.name, readCell(name, c, cells[at.get(c.name) as number]));
    m.set(pk.name, { k: "val", v: er.key }); // a re-keyed row is expected under its new id
    if (openBlank && name === "till_sessions") {
      const st = m.get("status");
      if (st && st.k === "val" && st.v === "open") {
        let any = false;
        for (const cn of openCols) {
          const e = m.get(cn);
          if (e && e.k === "val") {
            m.set(cn, NULL);
            cellsByColumn[cn] = (cellsByColumn[cn] ?? 0) + 1;
            any = true;
          }
        }
        if (any) openRows.push(er.row);
      }
    }
    sheetCells.set(er.row, m);
    const dbRow = dbByKey.get(er.key);
    if (!dbRow) {
      unmatchedKeys.push(er);
      add({ kind: "missing_from_database", row: er.row, keyColumn: pk.name, message: `row ${er.row} is in the Sheet, was not rejected or left out by the import report, and is not in the database` });
      continue;
    }
    matched.add(er.key);
  }
  if (openBlank && name === "till_sessions") {
    result.openBlanked = { rows: openRows.length, cellsByColumn };
    if (openRows.length !== ev.rowsWithClosingFigures) {
      add({ kind: "report_integrity", keyColumn: pk.name, message: `the import report says --open-sessions-blank changed ${ev.rowsWithClosingFigures} open till row(s); the Sheet has ${openRows.length}` });
    }
  }

  // Row by row, every compared column.
  const colsToCompare = compared;
  for (const er of expectedRows) {
    const dbRow = matched.has(er.key) && used.get(er.key) === er ? dbByKey.get(er.key) : undefined;
    if (!dbRow) continue;
    const m = sheetCells.get(er.row) as Map<string, Expected>;
    for (const c of colsToCompare) {
      const msg = describeCellDifference(name, c, m.get(c.name) as Expected, readDbCell(c, dbRow[c.name]));
      if (msg !== null) add({ kind: "value", row: er.row, keyColumn: pk.name, column: c.name, message: msg });
    }
    if (table.columns.some((c) => c.name === "store_id") && dbCols.has("store_id") && dbRow["store_id"] !== STORE_ID) {
      add({ kind: "value", row: er.row, keyColumn: pk.name, column: "store_id", message: `Sheet ${STORE_ID}, database ${dbRow["store_id"] === null ? "blank" : String(dbRow["store_id"]).slice(0, 40)}` });
    }
  }

  // Extra rows.
  const rejectedKeys = new Set<string>();
  for (const [row] of rejectsHere) {
    const i = row - SHEET_FIRST_ROW;
    const k = i >= 0 && i < nRows ? rowKey(i) : null;
    if (k !== null) rejectedKeys.add(k);
  }
  for (const r of dbT.rows) {
    const key = String(r[pk.name]);
    if (matched.has(key)) continue;
    add({
      kind: "extra_in_database",
      keyColumn: pk.name,
      message: `the database has a row (${pk.name} ${key.slice(0, 60)}) that no Sheet row accounts for${rejectedKeys.has(key) ? "; the import report says the Sheet row with that id was rejected" : ""}`,
    });
  }

  // Order.
  if (dbT.hasSeq) {
    const sheetOrder = expectedRows.filter((e) => matched.has(e.key) && used.get(e.key) === e).map((e) => e.key);
    const dbOrder = dbT.rows.map((r) => String(r[pk.name])).filter((k) => matched.has(k));
    let first = -1;
    let n = 0;
    for (let i = 0; i < Math.max(sheetOrder.length, dbOrder.length); i++) {
      if (sheetOrder[i] !== dbOrder[i]) {
        if (first < 0) first = i;
        n++;
      }
    }
    if (n > 0) {
      const rowOf = new Map(expectedRows.map((e) => [e.key, e.row]));
      add({
        kind: "order",
        keyColumn: pk.name,
        message: `order: the database's seq order is not the tab's row order (${n} of ${sheetOrder.length} positions differ; first at position ${first + 1}: the Sheet has row ${rowOf.get(sheetOrder[first] as string)} there, the database has row ${rowOf.get(dbOrder[first] as string)})`,
      });
    }
  }

  // Not-loaded sums (Sheet side).
  const nlSums = new Map<string, bigint>(sumCols.map((c) => [c.name, 0n]));
  for (const list of [result.notLoaded.rejected.map((r) => r.row), result.notLoaded.leftOut.map((r) => r.row)]) {
    for (const row of list) {
      const i = row - SHEET_FIRST_ROW;
      if (i < 0 || i >= nRows) continue;
      for (const c of sumCols) {
        const e = readCell(name, c, (tab.rows[i] as unknown[])[at.get(c.name) as number]);
        if (e.k === "val" && e.n !== undefined) nlSums.set(c.name, (nlSums.get(c.name) as bigint) + e.n);
        else if (e.k === "bad") result.notLoaded.unreadableFigures++;
      }
    }
  }
  for (const c of sumCols) result.notLoaded.sums[c.name] = formatUnits(nlSums.get(c.name) as bigint, c.scale ?? 0);

  // Per month: rows, sums (exact), blanks. Sheet side: the rows the import should have loaded.
  type Acc = { sheetRows: number; dbRows: number; s: Map<string, bigint>; d: Map<string, bigint>; sb: Map<string, number>; db: Map<string, number> };
  const months = new Map<string, Acc>();
  const acc = (month: string): Acc => {
    let a = months.get(month);
    if (!a) {
      a = { sheetRows: 0, dbRows: 0, s: new Map(), d: new Map(), sb: new Map(), db: new Map() };
      months.set(month, a);
    }
    return a;
  };
  for (const er of expectedRows) {
    if (used.get(er.key) !== er) continue;
    const m = sheetCells.get(er.row) as Map<string, Expected>;
    const a = acc(monthOfExpected(dateCol, dateCol ? m.get(dateCol.name) : undefined));
    a.sheetRows++;
    for (const c of sumCols) {
      const e = m.get(c.name) as Expected;
      if (e.k === "val" && e.n !== undefined) a.s.set(c.name, (a.s.get(c.name) ?? 0n) + e.n);
      else if (e.k === "null") a.sb.set(c.name, (a.sb.get(c.name) ?? 0) + 1);
    }
  }
  for (const r of dbT.rows) {
    const a = acc(monthOfExpected(dateCol, dateCol ? readDbCell(dateCol, r[dateCol.name]) : undefined));
    a.dbRows++;
    for (const c of sumCols) {
      const e = readDbCell(c, r[c.name]);
      if (e.k === "val" && e.n !== undefined) a.d.set(c.name, (a.d.get(c.name) ?? 0n) + e.n);
      else if (e.k === "null") a.db.set(c.name, (a.db.get(c.name) ?? 0) + 1);
    }
  }
  const monthNames = [...months.keys()].sort((x, y) => (x === y ? 0 : x === "no date" ? 1 : y === "no date" ? -1 : x < y ? -1 : 1));
  for (const month of monthNames) {
    const a = months.get(month) as Acc;
    const line: MonthLine = { month, sheetRows: a.sheetRows, dbRows: a.dbRows, columns: {} };
    if (a.sheetRows !== a.dbRows) add({ kind: "month_rows", message: `${month}: the Sheet has ${a.sheetRows} rows to load, the database ${a.dbRows}` });
    for (const c of sumCols) {
      const s = a.s.get(c.name) ?? 0n;
      const d = a.d.get(c.name) ?? 0n;
      const scale = c.scale ?? 0;
      const sb = a.sb.get(c.name) ?? 0;
      const db = a.db.get(c.name) ?? 0;
      line.columns[c.name] = { sheetSum: formatUnits(s, scale), dbSum: formatUnits(d, scale), diff: formatUnits(d - s, scale), sheetBlank: sb, dbBlank: db };
      if (s !== d) {
        const diff = abs(d - s);
        add({ kind: "month_sum", column: c.name, message: `${month}: the sum of ${c.name} differs by ${diff} ${unitName(c)}${diff === 1n ? "" : "s"} (Sheet ${formatUnits(s, scale)}, database ${formatUnits(d, scale)})` });
      }
      if (sb !== db) add({ kind: "month_blank", column: c.name, message: `${month}: ${c.name} is blank in ${sb} Sheet row(s) but NULL in ${db} database row(s)` });
    }
    result.months.push(line);
  }

  // Blanks per column, whole table, all compared columns.
  for (const c of colsToCompare) {
    let sheet = 0;
    for (const er of expectedRows) {
      if (used.get(er.key) !== er) continue;
      if ((sheetCells.get(er.row) as Map<string, Expected>).get(c.name)?.k === "null") sheet++;
    }
    const db = dbT.rows.filter((r) => r[c.name] === null || r[c.name] === undefined).length;
    result.blanks.push({ column: c.name, sheet, db });
    if (sheet !== db) add({ kind: "blank_count", column: c.name, message: `${c.name}: blank in ${sheet} Sheet row(s) but NULL in ${db} database row(s)` });
  }

  // Database-only columns that must be empty after an import.
  if (name === "payments" && dbCols.has("voided_at")) {
    const n = dbT.rows.filter((r) => r["voided_at"] !== null && r["voided_at"] !== undefined).length;
    if (n > 0) add({ kind: "database_only", column: "voided_at", message: `${n} payment(s) are voided in the database; the Sheet has no voided payments` });
  }

  // The import report's own numbers for this table, checked, not trusted.
  const line = ev.tables.find((t) => t.table === name);
  if (!line) add({ kind: "report_integrity", message: `the import report has no line for ${name}` });
  else {
    const want: [string, number, number][] = [
      ["tab rows", line.tabRows, nRows],
      ["rows with no id and nothing else", line.blankKey, result.rows.empty],
      ["rejected rows", line.rejected, result.rows.rejected],
      ["left-out rows", line.leftOut, leftOutKeyed],
      ["re-keyed rows", line.reKeyed, rekeyHere.size],
      ["loaded rows", line.loaded, dbT.rows.length],
    ];
    for (const [what, claimed, mine] of want) {
      if (claimed !== mine) add({ kind: "report_integrity", keyColumn: pk.name, message: `the import report says ${claimed} ${what}; this check finds ${mine}` });
    }
    if (line.loaded + line.rejected + line.leftOut + line.blankKey !== line.tabRows) {
      add({ kind: "report_integrity", keyColumn: pk.name, message: `the import report's own totals do not add up for ${name} (loaded + rejected + left out + empty is not the tab's rows)` });
    }
  }

  // Pins (staff only): collect, the caller checks.
  let pins: PinRow[] | undefined;
  if (name === "staff") {
    const codeAt = at.get("login_code");
    pins = [];
    for (const er of expectedRows) {
      if (used.get(er.key) !== er) continue;
      const cell = codeAt === undefined ? "" : (tab.rows[er.i] as unknown[])[codeAt];
      let code: string | null = null;
      if (typeof cell === "string") code = cell.trim() === "" ? null : cell.trim();
      else if (typeof cell === "number" && Number.isFinite(cell)) code = String(cell);
      else if (typeof cell === "boolean") code = String(cell);
      const dbRow = dbByKey.get(er.key);
      pins.push({ staffId: er.key, sheetRow: er.row, expectHash: code !== null, code, pinHash: dbRow ? (dbRow["pin_hash"] ?? null) : null });
    }
  }

  result.differenceCount = diffs.length;
  result.differences = diffs;
  const out: TableOutput = { result, matchedKeys: matched };
  if (pins) out.pins = pins;
  return out;
}

// ── The whole comparison ─────────────────────────────────────

const HASH_FORMAT = /^pbkdf2-sha256\$([1-9][0-9]{0,8})\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

export interface CompareInput {
  contract: Contract;
  tabs: SheetTabIn[];
  db: DbSnapshot;
  evidence: ImportEvidence;
}

export function compareExportToDatabase(input: CompareInput): ReconcileResult {
  const { contract, db, evidence } = input;
  const tabs = new Map(input.tabs.map((t) => [t.name, t]));
  const tableNames = Object.keys(contract.tables).filter((t) => !OPS_ONLY_TABLES.includes(t));
  const results: TableResult[] = [];
  const other: Diff[] = [];
  const checks: CheckLine[] = [];
  let pins: PinRow[] = [];

  // rejects naming a tab that cannot have been rejected from
  for (const r of evidence.rejects) {
    if (!tableNames.includes(r.tab)) other.push({ table: r.tab.slice(0, 40), kind: "report_integrity", row: r.row, message: `the import report lists a reject in "${r.tab.slice(0, 40)}", which is not a tab the import loads` });
  }
  for (const t of [...evidence.rekeyed.map((k) => k.table), ...evidence.leftOutRows.map((k) => k.table)]) {
    if (!tableNames.includes(t)) other.push({ table: t.slice(0, 40), kind: "report_integrity", message: `the import report lists a re-keyed or left-out row in "${t.slice(0, 40)}", which is not a table the import loads` });
  }
  if (evidence.rejectCount !== evidence.rejects.length) {
    other.push({ table: "(import report)", kind: "report_integrity", message: `the import report says ${evidence.rejectCount} reject(s); rejects.csv lists ${evidence.rejects.length}` });
  }
  if (evidence.acceptRejects !== null && evidence.acceptRejects !== evidence.rejects.length) {
    other.push({ table: "(import report)", kind: "report_integrity", message: `the import accepted ${evidence.acceptRejects} reject(s); rejects.csv lists ${evidence.rejects.length}` });
  }

  for (const name of tableNames) {
    const table = contract.tables[name] as Table;
    const out = compareTable(contract, table, tabs.get(name), db.tables[name], evidence, tabs, evidence.openSessionsBlank);
    results.push(out.result);
    if (out.pins) pins = out.pins;
  }

  // Secret config keys in the database.
  const configRows = db.tables["config"]?.rows ?? [];
  const secretKeys = configRows.map((r) => String(r["key"])).filter(configKeyIsSecret);
  checks.push({ name: "no secret config key was loaded", ok: secretKeys.length === 0, detail: secretKeys.length === 0 ? "none of the config keys looks like a secret" : `${secretKeys.length} secret-looking key(s) are in ops.config` });
  for (const k of secretKeys) other.push({ table: "config", kind: "secret_config", column: "key", message: `ops.config holds the secret-looking key ${k.slice(0, 60)}` });

  // PIN hashes.
  const hashedInDb = pins.filter((p) => p.pinHash !== null).length;
  const pinProblems: string[] = [];
  for (const p of pins) {
    if (p.pinHash === null) {
      if (p.expectHash) pinProblems.push(`staff row ${p.sheetRow}: the Sheet has a login code, but pin_hash is not set`);
      continue;
    }
    if (!p.expectHash) {
      pinProblems.push(`staff row ${p.sheetRow}: the Sheet has no login code, but pin_hash is set`);
      continue;
    }
    const m = HASH_FORMAT.exec(p.pinHash);
    const salt = m ? Buffer.from(m[2] as string, "base64") : null;
    const hash = m ? Buffer.from(m[3] as string, "base64") : null;
    if (!m || !salt || !hash || salt.length < 8 || hash.length !== 32) pinProblems.push(`staff row ${p.sheetRow}: pin_hash is not in the form pbkdf2-sha256$iterations$salt$hash with a 32-byte hash (it may be a plain code)`);
    else if (p.pinHash === p.code) pinProblems.push(`staff row ${p.sheetRow}: pin_hash is the login code itself`);
  }
  // against the import report's own list
  const reportBlank = new Set(evidence.pinsBlank.map((b) => b.staffId));
  const dbBlank = new Set(pins.filter((p) => p.pinHash === null).map((p) => p.staffId));
  for (const id of reportBlank) if (!dbBlank.has(id) && pins.some((p) => p.staffId === id)) pinProblems.push(`the import report says a person has no PIN (staff row ${pins.find((p) => p.staffId === id)?.sheetRow}), but pin_hash is set`);
  for (const id of dbBlank) if (!reportBlank.has(id)) pinProblems.push(`staff row ${pins.find((p) => p.staffId === id)?.sheetRow}: pin_hash is not set, and the import report does not list this person as having no PIN`);
  if (pins.length > 0 && evidence.pinsHashed !== hashedInDb) pinProblems.push(`the import report says ${evidence.pinsHashed} PIN(s) were hashed; ${hashedInDb} staff rows have pin_hash set`);
  checks.push({
    name: "pin_hash is set for exactly the people the import report says, and is never the code",
    ok: pinProblems.length === 0,
    detail: pinProblems.length === 0 ? `${hashedInDb} hashed, ${pins.length - hashedInDb} without a PIN; every hash is pbkdf2-sha256 with a 32-byte hash and none is its code` : `${pinProblems.length} problem(s)`,
  });
  for (const m of pinProblems) other.push({ table: "staff", kind: "pin_hash", column: "pin_hash", message: m });

  // Deprecated tabs have no table.
  const deprecated: ReconcileResult["deprecated"] = [];
  for (const tabName of contract.leftTabs.keys()) {
    const t = tabs.get(tabName);
    const inDb = db.allTables.includes(tabName);
    deprecated.push({ tab: tabName, sheetRows: t ? t.rows.length : 0, tableInDatabase: inDb });
    if (inDb) other.push({ table: tabName, kind: "schema", message: `the Sheet's deprecated tab ${tabName} has a table in the database` });
  }
  const expectedTables = new Set([...Object.keys(contract.tables)]);
  const unknownTables = db.allTables.filter((t) => !expectedTables.has(t) && !LATER_OPS_TABLES.includes(t));
  for (const t of unknownTables) if (!contract.leftTabs.has(t)) other.push({ table: t, kind: "schema", message: `the database has a table ${t} that the contract does not have` });
  checks.push({
    name: "the deprecated tabs have no table",
    ok: !deprecated.some((d) => d.tableInDatabase),
    detail: deprecated.some((d) => d.tableInDatabase) ? "a deprecated tab has a table in the database" : `${deprecated.length} deprecated tab(s), none with a table`,
  });
  for (const s of evidence.skippedTabs) {
    const t = tabs.get(s.tab);
    if (!contract.leftTabs.has(s.tab)) other.push({ table: s.tab.slice(0, 40), kind: "report_integrity", message: `the import report skipped the tab "${s.tab.slice(0, 40)}" as deprecated, but the contract does not list it as deprecated` });
    else if (!t || t.rows.length !== s.rows) other.push({ table: s.tab.slice(0, 40), kind: "report_integrity", message: `the import report says the deprecated tab ${s.tab} has ${s.rows} row(s); the export has ${t ? t.rows.length : "no such tab"}` });
  }
  for (const tabName of contract.leftTabs.keys()) {
    if (tabs.has(tabName) && !evidence.skippedTabs.some((s) => s.tab === tabName)) other.push({ table: tabName, kind: "report_integrity", message: `the export has the deprecated tab ${tabName}, which the import report does not list as skipped` });
  }

  // Export tabs the contract knows nothing about.
  for (const t of input.tabs) {
    if (!contract.tables[t.name] && !contract.leftTabs.has(t.name)) other.push({ table: t.name.slice(0, 40), kind: "schema", message: `the export has a tab "${t.name.slice(0, 40)}" that is neither loaded nor listed as deprecated` });
  }

  const opsOnly = OPS_ONLY_TABLES.filter((t) => contract.tables[t]).map((t) => ({ table: t, rows: db.opsOnlyCounts[t] ?? 0 }));

  const unexplained = results.reduce((n, r) => n + r.differenceCount, 0) + other.length;
  const explained = {
    rejectedRows: results.reduce((n, r) => n + r.rows.rejected, 0),
    leftOutRows: results.reduce((n, r) => n + r.rows.leftOut, 0),
    reKeyed: results.reduce((n, r) => n + r.rows.reKeyed, 0),
    openBlankedRows: results.reduce((n, r) => n + (r.openBlanked?.rows ?? 0), 0),
  };
  return { format: REPORT_FORMAT, tables: results, opsOnly, deprecated, checks, otherDifferences: other, unexplained, explained };
}

// ── Writing it down ──────────────────────────────────────────

export interface RunFacts {
  startedAt: string;
  workbookSha256: string;
  manifestSha256: string;
}

/** The JSON report: the result, with each table's differences capped at LIST_CAP (the count is whole). */
export function reportJson(result: ReconcileResult, facts: RunFacts): Record<string, unknown> {
  return {
    format: result.format,
    generatedAt: facts.startedAt,
    export: { workbookSha256: facts.workbookSha256, manifestSha256: facts.manifestSha256 },
    outcome: result.unexplained === 0 ? "no unexplained difference" : `${result.unexplained} unexplained difference(s)`,
    unexplainedDifferences: result.unexplained,
    explained: result.explained,
    tables: result.tables.map((t) => ({ ...t, differences: t.differences.slice(0, LIST_CAP), differencesNotListed: Math.max(0, t.differences.length - LIST_CAP) })),
    opsOnlyTables: result.opsOnly,
    deprecatedTabs: result.deprecated,
    checks: result.checks,
    otherDifferences: result.otherDifferences,
    notes: NOTES,
  };
}

const NOTES = [
  "The Sheet side is computed from the exported cells by this tool's own rules, not by the importer's translation.",
  "Sums are exact: integer cents (or the column's own smallest unit), never floating point.",
  "A blank is not a zero: blanks are counted on both sides, and a blank that became 0 is a difference even though the sum is unchanged.",
  "Text, name, pay-rate, login and phone values are never shown; a difference there says \"differs\". A money difference is a size in cents.",
  "This report compares the export directory with the database. It cannot show that the export is the live Sheet, and it cannot verify a PIN hash (that needs the pepper).",
];

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The summary table the command prints, and the head of the Markdown report. */
export function summaryLines(result: ReconcileResult): string[] {
  const w = Math.max(5, ...result.tables.map((t) => t.table.length));
  const head = ["tab rows", "in db", "rejected", "left out", "differences"];
  const widths = head.map((h) => Math.max(h.length, 8));
  const row = (name: string, cells: (string | number)[]): string => `${name.padEnd(w)}  ${cells.map((c, i) => String(c).padStart(widths[i] as number)).join("  ")}`;
  const lines = [row("table", head)];
  for (const t of result.tables) lines.push(row(t.table, [t.rows.tab, t.rows.inDatabase, t.rows.rejected, t.rows.leftOut, t.differenceCount]));
  lines.push(row("total", [0, 1, 2, 3, 4].map((i) => result.tables.reduce((n, t) => n + [t.rows.tab, t.rows.inDatabase, t.rows.rejected, t.rows.leftOut, t.differenceCount][i]!, 0))));
  lines.push("");
  for (const c of result.checks) lines.push(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  lines.push(`tables only the new app has (not compared): ${result.opsOnly.map((o) => `${o.table} ${o.rows}`).join(", ")}`);
  lines.push(`not loaded, per the import report: ${plural(result.explained.rejectedRows, "rejected row")}, ${plural(result.explained.leftOutRows, "left-out row")}; ${plural(result.explained.reKeyed, "re-keyed id")}`);
  if (result.explained.openBlankedRows > 0) lines.push(`open till rows blanked by --open-sessions-blank: ${result.explained.openBlankedRows}`);
  lines.push(result.unexplained === 0 ? "RESULT: no unexplained difference." : `RESULT: ${plural(result.unexplained, "unexplained difference")}.`);
  return lines;
}

const mdCell = (s: string): string => s.replace(/\|/g, "\\|");

/** The report for a person. */
export function reportMarkdown(result: ReconcileResult, facts: RunFacts): string {
  const out: string[] = [];
  out.push("# Reconcile report: Sheet against database", "");
  out.push(`Generated ${facts.startedAt}. Export: workbook SHA-256 \`${facts.workbookSha256}\`, manifest SHA-256 \`${facts.manifestSha256}\`.`, "");
  out.push(result.unexplained === 0 ? "**Result: no unexplained difference.**" : `**Result: ${plural(result.unexplained, "unexplained difference")}.** Every one is listed below.`, "");
  out.push("```", ...summaryLines(result), "```", "");

  out.push("## Checks", "");
  for (const c of result.checks) out.push(`- ${c.ok ? "ok" : "**FAILED**"}: ${c.name}. ${c.detail}.`);
  out.push("");

  if (result.otherDifferences.length > 0) {
    out.push("## Differences outside the tables", "");
    for (const d of result.otherDifferences) out.push(`- ${d.table}${d.row ? ` row ${d.row}` : ""}: ${d.message}`);
    out.push("");
  }

  out.push("## Not loaded, per the import report", "");
  out.push("These rows were rejected or left out on purpose. They are not differences; each is counted here from the Sheet, with the money it carries.", "");
  let any = false;
  for (const t of result.tables) {
    if (t.notLoaded.rejected.length === 0 && t.notLoaded.leftOut.length === 0) continue;
    any = true;
    out.push(`### ${t.table}`, "");
    if (t.notLoaded.rejected.length > 0) {
      out.push(`${plural(t.notLoaded.rejected.length, "rejected row")}: ${t.notLoaded.rejected.map((r) => `row ${r.row} (${r.columns.join(", ")}: ${r.reasons.join("; ")})`).join("; ")}.`, "");
    }
    if (t.notLoaded.leftOut.length > 0) out.push(`${plural(t.notLoaded.leftOut.length, "left-out row")}: ${t.notLoaded.leftOut.map((r) => `row ${r.row} (${r.why})`).join("; ")}.`, "");
    const money = Object.entries(t.notLoaded.sums).filter(([, v]) => !/^-?0(\.0+)?$/.test(v));
    out.push(money.length > 0 ? `The Sheet money in those rows: ${money.map(([c, v]) => `${c} ${v}`).join(", ")}.` : "No money in those rows.", "");
    if (t.notLoaded.unreadableFigures > 0) out.push(`${plural(t.notLoaded.unreadableFigures, "cell")} in those rows cannot be read as a figure and are not in the sums.`, "");
  }
  if (!any) out.push("None.", "");
  const rekeyed = result.tables.filter((t) => t.rows.reKeyed > 0);
  if (rekeyed.length > 0) {
    out.push("### Re-keyed ids", "");
    for (const t of rekeyed) out.push(`- ${t.table}: ${plural(t.rows.reKeyed, "row")} loaded under a new id (-d2, -d3 ...); each matched to its Sheet row below.`);
    out.push("");
  }
  const opens = result.tables.filter((t) => t.openBlanked && t.openBlanked.rows > 0);
  for (const t of opens) {
    out.push("### Open till rows blanked on purpose (--open-sessions-blank)", "");
    out.push(`${t.table}: ${plural(t.openBlanked?.rows ?? 0, "row")}; cells blanked: ${Object.entries(t.openBlanked?.cellsByColumn ?? {}).map(([c, n]) => `${c} ${n}`).join(", ")}.`, "");
  }

  out.push("## Tables only the new app has (counted, not compared)", "");
  for (const o of result.opsOnly) out.push(`- ${o.table}: ${o.rows} row(s)`);
  out.push("", "## Deprecated tabs (no table, by design)", "");
  for (const d of result.deprecated) out.push(`- ${d.tab}: ${d.sheetRows} Sheet row(s), ${d.tableInDatabase ? "**a table exists in the database**" : "no table"}`);
  out.push("");

  for (const t of result.tables) {
    out.push(`## ${t.table}`, "");
    out.push(
      `Rows: tab ${t.rows.tab} (${t.rows.withId} with an id, ${t.rows.empty} empty, ${t.rows.keylessWithValues} with values but no id); in the database ${t.rows.inDatabase}; rejected ${t.rows.rejected}; left out ${t.rows.leftOut}; re-keyed ${t.rows.reKeyed}.`,
      "",
    );
    out.push(`Grouped by month of: ${t.dateColumn ? `\`${t.table}.${t.dateColumn}\` (America/Toronto)` : "nothing (the table has no date column: one group)"}. Compared row by row: ${t.comparedColumns.map((c) => `\`${c}\``).join(", ") || "none"}.`, "");
    if (t.notCompared.length > 0) out.push(`Not compared: ${t.notCompared.map((c) => `\`${c.column}\` (${c.reason})`).join("; ")}.`, "");
    if (t.differenceCount === 0) out.push("**No differences.**", "");
    else {
      out.push(`**${plural(t.differenceCount, "difference")}.**`, "");
      for (const d of t.differences.slice(0, LIST_CAP)) {
        const where = [d.row !== undefined ? `Sheet row ${d.row}` : "", d.keyColumn ? `key column ${d.keyColumn}` : "", d.column ? `column ${d.column}` : ""].filter((s) => s !== "").join(", ");
        out.push(`- ${d.kind}${where ? ` (${where})` : ""}: ${d.message}`);
      }
      if (t.differences.length > LIST_CAP) out.push(`- ... and ${t.differences.length - LIST_CAP} more (not listed).`);
      out.push("");
    }
    if (t.sumColumns.length > 0 && t.months.length > 0) {
      out.push(`Per month: rows, and the sum of each figure column (exact; Sheet / database / database minus Sheet), with blank counts (Sheet blanks / database NULLs).`, "");
      out.push(`| month | rows Sheet | rows db | column | sum Sheet | sum db | diff | blanks Sheet | blanks db |`, `|---|---:|---:|---|---:|---:|---:|---:|---:|`);
      for (const m of t.months) {
        for (const c of t.sumColumns) {
          const x = m.columns[c];
          if (!x) continue;
          out.push(`| ${m.month} | ${m.sheetRows} | ${m.dbRows} | ${mdCell(c)} | ${x.sheetSum} | ${x.dbSum} | ${x.diff} | ${x.sheetBlank} | ${x.dbBlank} |`);
        }
      }
      out.push("");
    } else if (t.months.length > 0) {
      out.push(`| month | rows Sheet | rows db |`, `|---|---:|---:|`);
      for (const m of t.months) out.push(`| ${m.month} | ${m.sheetRows} | ${m.dbRows} |`);
      out.push("");
    }
  }
  out.push("## Notes", "");
  for (const n of NOTES) out.push(`- ${n}`);
  out.push("");
  return out.join("\n");
}
