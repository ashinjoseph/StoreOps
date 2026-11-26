// Sheet rows into rows of the Operations schema (card P2-09a).
//
// Pure functions: no database, no file system. The schema is not duplicated
// here; it is read from ops/contracts/schema.sql by parseContract (the text
// is handed in; load.ts reads the file). Everything this file knows about a
// column (its type, its scale, its allowed values, whether it may be blank)
// comes from that file, and table and column names written into SQL come
// only from it, never from a Sheet header.
//
// The rule is "copy what the Sheet holds". A cell is converted to the
// column's type or the row is rejected; nothing is repaired, defaulted or
// rounded. A blank is NULL, never 0 (ADR-0004).
import { formatDate } from "../lib/dates";

// ── The contract, parsed ─────────────────────────────────────

export type ColumnType = "text" | "numeric" | "integer" | "bigint" | "boolean" | "date" | "timestamptz" | "bytea";

export interface Column {
  name: string;
  type: ColumnType;
  /** numeric(p,s): p. Absent for other types. */
  precision?: number;
  /** numeric(p,s): s. 0 for integer. */
  scale?: number;
  notNull: boolean;
  primaryKey: boolean;
  identity: boolean;
  /** The literal of a text default, e.g. 'percentage'. Absent when there is none or it is not a text literal. */
  defaultText?: string;
  hasDefault: boolean;
  /** The values of a `check (col in (...))`, in the contract's own casing. */
  enumValues?: string[];
  /** The table a foreign key points at. */
  references?: string;
  deferrable: boolean;
}

export interface Table {
  name: string;
  columns: Column[];
}

export interface Contract {
  tables: Record<string, Table>;
  /** Tabs the contract leaves out, with its reason. */
  leftTabs: Map<string, string>;
  /** "tab.column" the contract leaves out, with its reason. */
  leftColumns: Map<string, string>;
}

/** Split `body` at commas that are not inside parentheses or a quoted string. */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const ch of body) {
    if (ch === "'") quoted = !quoted;
    if (!quoted) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

/** The text between the parenthesis that opens at `open` and its match. */
function balanced(code: string, open: number): string {
  let depth = 0;
  let quoted = false;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === "'") quoted = !quoted;
    if (quoted) continue;
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return code.slice(open + 1, i);
  }
  throw new Error("schema.sql: unbalanced parenthesis in a create table");
}

const COLUMN_RE = /^"?([a-z_]+)"?\s+(text|boolean|date|timestamptz|integer|bigint|bytea|numeric(?:\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?)(?![a-z_])\s*(.*)$/is;

/**
 * Read the tables, columns and "left out" lists from the text of
 * ops/contracts/schema.sql. It understands what that file uses (one
 * `create table ops.x (...)` per table, column types text, numeric(p,s),
 * integer, bigint, boolean, date, timestamptz, bytea) and throws on anything
 * else rather than guess.
 */
export function parseContract(sql: string): Contract {
  const leftTabs = new Map<string, string>();
  const leftColumns = new Map<string, string>();
  const start = sql.indexOf("Left out, and why");
  if (start !== -1) {
    const block = sql.slice(start).split(/\n(?!--)/)[0] ?? "";
    for (const line of block.split("\n")) {
      const tab = /^--\s+tab\s+([a-z_]+)\s+(.*)$/.exec(line);
      if (tab) leftTabs.set(tab[1] as string, (tab[2] as string).trim());
      const col = /^--\s+column\s+([a-z_]+\.[a-z_]+)\s+(.*)$/.exec(line);
      if (col) leftColumns.set(col[1] as string, (col[2] as string).trim());
    }
  }

  const code = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
  const tables: Record<string, Table> = {};
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:ops\.)?([a-z_]+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const name = m[1] as string;
    const body = balanced(code, m.index + m[0].length - 1);
    const columns: Column[] = [];
    for (const piece of splitTopLevel(body)) {
      const text = piece.replace(/\s+/g, " ").trim();
      if (/^(constraint|primary|unique|check|foreign|exclude)\b/i.test(text)) continue;
      const c = COLUMN_RE.exec(text);
      if (!c) throw new Error(`schema.sql: cannot read a column of ${name}: "${text.slice(0, 40)}"`);
      const colName = c[1] as string;
      const typeText = (c[2] as string).toLowerCase();
      const rest = c[5] ?? "";
      const column: Column = {
        name: colName,
        type: typeText.startsWith("numeric") ? "numeric" : (typeText as ColumnType),
        notNull: /\bnot\s+null\b/i.test(rest),
        primaryKey: /\bprimary\s+key\b/i.test(rest),
        identity: /generated\s+always\s+as\s+identity/i.test(rest),
        hasDefault: /\bdefault\b/i.test(rest),
        deferrable: /\bdeferrable\b/i.test(rest),
      };
      if (column.primaryKey) column.notNull = true;
      if (column.type === "numeric") {
        if (c[3] !== undefined) column.precision = Number(c[3]);
        column.scale = c[4] !== undefined ? Number(c[4]) : 0;
      }
      if (column.type === "integer") column.scale = 0;
      const def = /\bdefault\s+'([^']*)'/i.exec(rest);
      if (def) column.defaultText = def[1] as string;
      const ref = /\breferences\s+(?:ops\.)?([a-z_]+)/i.exec(rest);
      if (ref) column.references = ref[1] as string;
      const en = new RegExp(`check\\s*\\(\\s*"?${colName}"?\\s+in\\s*\\(([^)]*)\\)\\s*\\)`, "i").exec(rest);
      if (en) column.enumValues = [...(en[1] as string).matchAll(/'([^']*)'/g)].map((x) => x[1] as string);
      columns.push(column);
    }
    tables[name] = { name, columns };
  }
  return { tables, leftTabs, leftColumns };
}

/** One Sheet tab as read from the Sheet: its header row (row 2) and data rows (from row 3). */
export interface SheetTab {
  tab: string;
  header: unknown[];
  rows: unknown[][];
}

// ── Results ──────────────────────────────────────────────────

/** A cell that could not be translated. It never carries the cell's value: a value can be pay or personal data. */
export interface Reject {
  tab: string;
  /** The row as a person sees it in the Sheet (1-based; the first data row is 3). */
  row: number;
  column: string;
  reason: string;
}

/** A difference between the Sheet's header row and the contract, reported once per tab. */
export interface HeaderIssue {
  tab: string;
  kind: "unknown_header" | "missing_column" | "duplicate_header";
  column: string;
}

export type Value = string | number | boolean | Date | null;

export interface TranslatedTab {
  status: "ok";
  tab: string;
  rows: Record<string, Value>[];
  /** For each of `rows`: its row number in the Sheet. */
  rowNumbers: number[];
  rejects: Reject[];
  headerIssues: HeaderIssue[];
  /** Rows handed in. read = rows.length + skipped + rejectedRows + leftOut. */
  read: number;
  /** Rows with a blank primary key (empty trailing rows). */
  skipped: number;
  /** Rows left out because of at least one reject. */
  rejectedRows: number;
  /** Rows the contract leaves out (config secrets). */
  leftOut: number;
}

export interface NotMigrated {
  status: "not_migrated";
  tab: string;
  reason: string;
  rows: [];
  rejects: [];
  read: number;
}

export type TranslateResult = TranslatedTab | NotMigrated;

export interface TranslateOptions {
  contract: Contract;
  /** Fills store_id on tables that have it. Default 'store_main'. */
  storeId?: string;
  /** Copy what the Sheet holds. The only mode there is; false is refused. Default true. */
  faithful?: boolean;
  /** The Sheet row number of rows[0]. Default 3 (row 1 is a banner, row 2 the header). */
  firstRow?: number;
}

// ── Cells ────────────────────────────────────────────────────

const isBlank = (v: unknown): boolean => v === "" || v === null || v === undefined;

/** Blank reads as "not active" in the old code (Staff.gs, CommissionRules.gs), and the contract says so. */
const BLANK_IS_FALSE = new Set(["staff.active", "commission_rules.active"]);

/** Config rows the contract does not import: secrets, and the shopping list's template (the shopping list is deprecated). */
export function configKeyLeftOut(key: string): boolean {
  const k = key.trim().toLowerCase();
  return /_token$|_secret$|_api_key$|password/.test(k) || k === "whatsapp_template_shopping_list";
}

/** An id: a primary key, a *_id column, or an actor column (*_by). Trimmed of surrounding spaces, nothing else. */
const isIdColumn = (c: Column): boolean => c.primaryKey || c.name.endsWith("_id") || c.name.endsWith("_by");

type Cell = { ok: true; value: Value } | { ok: false; reason: string };
const ok = (value: Value): Cell => ({ ok: true, value });
const bad = (reason: string): Cell => ({ ok: false, reason });

const NUMERIC_STRING = /^[+-]?\d+(\.\d+)?$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

function numberCell(col: Column, cell: unknown): Cell {
  let n: number;
  if (typeof cell === "number") n = cell;
  else if (typeof cell === "string" && NUMERIC_STRING.test(cell.trim())) n = Number(cell.trim());
  else return bad("not a number");
  if (!Number.isFinite(n)) return bad("not a finite number");
  const scale = col.scale ?? 0;
  const where = col.type === "integer" ? "integer" : `numeric(${col.precision ?? "?"},${scale})`;
  const limit = col.type === "integer" ? 2 ** 31 : col.precision !== undefined ? 10 ** (col.precision - scale) : Infinity;
  if (Math.abs(n) >= limit) return bad(`too large for ${where}`);
  const f = 10 ** scale;
  if (Math.round(n * f) / f !== n) return bad(scale === 0 ? "not a whole number" : `has more than ${scale} decimal places`);
  return ok(n === 0 ? 0 : n); // never -0
}

function dateCell(cell: unknown): Cell {
  if (cell instanceof Date) {
    if (Number.isNaN(cell.getTime())) return bad("invalid date");
    return ok(formatDate(cell));
  }
  if (typeof cell === "string") {
    const m = ISO_DAY.exec(cell);
    if (m) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const t = new Date(Date.UTC(y, mo - 1, d));
      if (t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d) return ok(cell);
    }
  }
  return bad("not a date (expected a date cell or YYYY-MM-DD)");
}

function instantCell(cell: unknown): Cell {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? bad("invalid date") : ok(new Date(cell.getTime()));
  if (typeof cell === "string" && ISO_INSTANT.test(cell.trim())) {
    const t = new Date(cell.trim());
    if (!Number.isNaN(t.getTime())) return ok(t);
  }
  return bad("not a timestamp (expected a date cell or an ISO string with an offset)");
}

function booleanCell(cell: unknown): Cell {
  if (typeof cell === "boolean") return ok(cell);
  if (typeof cell === "string") {
    const s = cell.trim().toLowerCase();
    if (s === "true") return ok(true);
    if (s === "false") return ok(false);
  }
  return bad("not TRUE or FALSE");
}

function textCell(col: Column, cell: unknown): Cell {
  let s: string;
  if (typeof cell === "string") s = cell;
  else if (typeof cell === "number" && Number.isFinite(cell)) s = String(cell);
  else if (typeof cell === "boolean") s = String(cell);
  else return bad("not text");
  if (isIdColumn(col)) s = s.trim();
  if (col.enumValues) {
    const hit = col.enumValues.find((v) => v.toLowerCase() === s.toLowerCase());
    if (hit === undefined) return bad(`not one of: ${col.enumValues.join(", ")}`);
    return ok(hit);
  }
  return ok(s);
}

function translateCell(table: Table, col: Column, cell: unknown): Cell {
  const isBlankCell = isBlank(cell) || (isIdColumn(col) && typeof cell === "string" && cell.trim() === "");
  if (isBlankCell) {
    if (col.type === "boolean" && BLANK_IS_FALSE.has(`${table.name}.${col.name}`)) return ok(false);
    if (col.notNull) {
      // The contract's own reading of a blank in a column that has a text default (rule_type).
      if (col.defaultText !== undefined && col.type === "text") return ok(col.defaultText);
      return bad("blank in a required column");
    }
    return ok(null);
  }
  switch (col.type) {
    case "numeric":
    case "integer":
    case "bigint":
      return numberCell(col, cell);
    case "date":
      return dateCell(cell);
    case "timestamptz":
      return instantCell(cell);
    case "boolean":
      return booleanCell(cell);
    case "text":
      return textCell(col, cell);
    case "bytea":
      return bad("binary columns are not imported");
  }
}

// ── A tab ────────────────────────────────────────────────────

/**
 * Translate one Sheet tab. `header` is the Sheet's header row (row 2), `rows`
 * the data rows from row 3. Columns are matched by name, never by position.
 */
export function translateTab(tab: string, header: readonly unknown[], rows: readonly (readonly unknown[])[], options: TranslateOptions): TranslateResult {
  if (options.faithful === false) throw new Error("only the faithful copy is implemented: zeros stay zeros and blanks stay NULL");
  const { contract } = options;
  const storeId = options.storeId ?? "store_main";
  const firstRow = options.firstRow ?? 3;

  const leftReason = contract.leftTabs.get(tab);
  if (leftReason !== undefined) return { status: "not_migrated", tab, reason: leftReason, rows: [], rejects: [], read: rows.length };
  const table = contract.tables[tab];
  if (!table) return { status: "not_migrated", tab, reason: "the contract has no table for this tab", rows: [], rejects: [], read: rows.length };

  // Header: name -> position, first occurrence wins.
  const at = new Map<string, number>();
  const headerIssues: HeaderIssue[] = [];
  header.forEach((h, i) => {
    const name = String(h ?? "").trim();
    if (name === "") return;
    if (at.has(name)) headerIssues.push({ tab, kind: "duplicate_header", column: name });
    else at.set(name, i);
  });
  const known = new Map(table.columns.map((c) => [c.name, c]));
  for (const name of at.keys()) {
    if (name === "store_id" || !known.has(name)) {
      if (!contract.leftColumns.has(`${tab}.${name}`)) headerIssues.push({ tab, kind: "unknown_header", column: name });
    }
  }
  const present = table.columns.filter((c) => c.name !== "store_id" && at.has(c.name));
  for (const c of table.columns) {
    if (c.name === "store_id" || at.has(c.name) || contract.leftColumns.has(`${tab}.${c.name}`)) continue;
    headerIssues.push({ tab, kind: "missing_column", column: c.name });
  }

  const pk = table.columns.find((c) => c.primaryKey);
  if (!pk || !at.has(pk.name)) throw new Error(`${tab}: the primary key column "${pk?.name ?? "?"}" is not in the Sheet header`);
  const pkAt = at.get(pk.name) as number;
  const keyAt = at.get("key");

  const out: Record<string, Value>[] = [];
  const rowNumbers: number[] = [];
  const rejects: Reject[] = [];
  let skipped = 0;
  let rejectedRows = 0;
  let leftOut = 0;

  rows.forEach((cells, i) => {
    const rowNo = firstRow + i;
    const key = cells[pkAt];
    if (isBlank(key) || (typeof key === "string" && key.trim() === "")) {
      skipped++;
      return;
    }
    if (tab === "config" && keyAt !== undefined && configKeyLeftOut(String(cells[keyAt] ?? ""))) {
      leftOut++;
      return;
    }
    const row: Record<string, Value> = {};
    let rowRejected = false;
    for (const col of present) {
      const r = translateCell(table, col, cells[at.get(col.name) as number]);
      if (r.ok) row[col.name] = r.value;
      else {
        rowRejected = true;
        rejects.push({ tab, row: rowNo, column: col.name, reason: r.reason });
      }
    }
    if (rowRejected) {
      rejectedRows++;
      return;
    }
    if (known.has("store_id")) row["store_id"] = storeId;
    out.push(row);
    rowNumbers.push(rowNo);
  });

  return { status: "ok", tab, rows: out, rowNumbers, rejects, headerIssues, read: rows.length, skipped, rejectedRows, leftOut };
}
