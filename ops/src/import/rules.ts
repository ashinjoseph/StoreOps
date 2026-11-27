// The rules the import tool applies on top of the plain Sheet-to-database translation
// (card P4-02). sheet-to-db.ts stays pure and knows only the contract; this file knows
// the Sheet's history: what the old app wrote that the new schema does not take as it is.
//
//   duplicate item ids   never rejected (it is money): re-keyed <id>-d2, -d3 ... and listed
//   any other duplicate  the later row is rejected
//   placeholders         CR_001 (inactive, no bonus refers to it) and CRN_PLACEHOLDER_*
//   open tills           an open session holds 0 in its closing columns: optional NULL (flag)
//   staff.login_code     never written; hashed into staff.pin_hash with P2-06's hashing
//   secret config rows   already left out by the translation; here, listed by key name only
//
// Everything here works on TranslatedTab objects (rows already converted to the column
// types) and changes them in place. Nothing here touches the database, and nothing here
// ever puts a cell value into a report: ids and names of tables, columns and keys only.
import { hashPin } from "../auth/pin";
import { ImportRefused } from "./errors";
import type { PrepareContext } from "./load";
import { configKeyLeftOut, type Contract, type SheetTab, type TranslatedTab, type Value } from "./sheet-to-db";

/** Tables of the contract that exist only in Operations: no tab of the Sheet feeds them. */
export const OPS_ONLY_TABLES: readonly string[] = ["stores", "staff_stores", "sessions", "login_failures"];

/**
 * Tables whose ids were a one-second stamp plus three random characters and that are written many
 * rows at a time: a repeat is re-keyed, not rejected. The two item tables are money; the audit log
 * is the record of who did what (a close writes four rows at once), and nothing refers to its rows.
 * A repeat in any other table is a reject of the later row: those rows have children, and which
 * child belongs to which of two parents with one id cannot be known.
 */
export const ITEM_TABLES: readonly string[] = ["payment_items", "cash_handover_items", "audit_log"];

/**
 * What the old app writes as 0 when a till is opened (TillSessions.gs: `0, 0, 0, 0, 0` after
 * the opening note). Only these five; the two lotto columns are also seeded 0 on a cstore
 * open, and are left as they are until the owner says otherwise.
 */
export const OPEN_SESSION_CLOSING_COLUMNS: readonly string[] = ["closing_cash_counted", "cash_left_in_till", "cash_removed_at_close", "expected_cash", "closing_variance"];

/**
 * Columns the database has that schema.sql does not: added by migrations. The importer
 * writes these (a hash); every other added column (the `seq` order columns, the payment void
 * columns) is left to its own default. run.ts checks the live database against both lists.
 */
export const EXTRA_COLUMNS: Readonly<Record<string, readonly string[]>> = { staff: ["pin_hash"] };

export const PLACEHOLDER_RULE_ID = "CR_001";
export const PLACEHOLDER_RUN_PREFIX = "CRN_PLACEHOLDER";

/** A pepper shorter than this is not a secret anyone chose on purpose. */
export const MIN_PEPPER_LENGTH = 16;

export function checkPepper(pepper: string | undefined): string {
  if (pepper === undefined || pepper === "") {
    throw new ImportRefused("PIN_PEPPER is not set. PINs are never hashed without it, and it must be the same value as the Worker's PIN_PEPPER secret, or nobody can sign in.");
  }
  if (pepper.length < MIN_PEPPER_LENGTH) {
    throw new ImportRefused(`PIN_PEPPER is shorter than ${MIN_PEPPER_LENGTH} characters. Use the Worker's real PIN_PEPPER secret.`);
  }
  return pepper;
}

const pkOf = (contract: Contract, table: string): string => {
  const pk = contract.tables[table]?.columns.find((c) => c.primaryKey);
  if (!pk) throw new Error(`${table}: the contract has no primary key`);
  return pk.name;
};

function removeAt(tab: TranslatedTab, drop: ReadonlySet<number>): void {
  tab.rows = tab.rows.filter((_r, i) => !drop.has(i));
  tab.rowNumbers = tab.rowNumbers.filter((_r, i) => !drop.has(i));
}

// ── Duplicate ids ────────────────────────────────────────────

export interface RekeyedId {
  table: string;
  originalId: string;
  newId: string;
  /** The row's number in the Sheet, as a person sees it. */
  row: number;
}

/**
 * Give every repeat of an id a new one: the first row keeps it, the second becomes `<id>-d2`,
 * the third `<id>-d3`. A new id that some row already has is skipped (`-d2` taken: `-d3`).
 */
export function rekeyDuplicateItems(tab: TranslatedTab, pk: string): RekeyedId[] {
  const used = new Set(tab.rows.map((r) => String(r[pk])));
  const seen = new Set<string>();
  const nth = new Map<string, number>();
  const out: RekeyedId[] = [];
  tab.rows.forEach((row, i) => {
    const id = String(row[pk]);
    if (!seen.has(id)) {
      seen.add(id);
      return;
    }
    let n = nth.get(id) ?? 1;
    let next: string;
    do next = `${id}-d${++n}`;
    while (used.has(next));
    nth.set(id, n);
    used.add(next);
    row[pk] = next;
    out.push({ table: tab.tab, originalId: id, newId: next, row: tab.rowNumbers[i] as number });
  });
  return out;
}

/** Reject every row whose key an earlier row of the tab already has. Returns how many. */
export function rejectDuplicateKeys(tab: TranslatedTab, pk: string): number {
  const first = new Map<string, number>();
  const drop = new Set<number>();
  tab.rows.forEach((row, i) => {
    const key = String(row[pk]);
    const at = first.get(key);
    const rowNo = tab.rowNumbers[i] as number;
    if (at === undefined) {
      first.set(key, rowNo);
      return;
    }
    drop.add(i);
    tab.rejects.push({ tab: tab.tab, row: rowNo, column: pk, reason: `has the same key as row ${at}; the later row is rejected` });
  });
  removeAt(tab, drop);
  tab.rejectedRows += drop.size;
  return drop.size;
}

// ── Placeholders ─────────────────────────────────────────────

export interface LeftOutRow {
  table: string;
  id: string;
  row: number;
  why: string;
}

/**
 * Setup.gs seeds one placeholder rule (CR_001, inactive) and one placeholder run
 * (CRN_PLACEHOLDER_001). They are left out unless something refers to them: a rule that is
 * active, or that a bonus's source_rule_id names, is data and is kept; likewise a run.
 */
export function dropPlaceholders(translated: ReadonlyMap<string, TranslatedTab>): LeftOutRow[] {
  const bonuses = translated.get("bonuses");
  const ruleRefs = new Set(bonuses?.rows.map((r) => r["source_rule_id"]).filter((v): v is string => typeof v === "string"));
  const runRefs = new Set(bonuses?.rows.map((r) => r["source_run_id"]).filter((v): v is string => typeof v === "string"));
  const out: LeftOutRow[] = [];

  const rules = translated.get("commission_rules");
  if (rules) {
    const drop = new Set<number>();
    rules.rows.forEach((r, i) => {
      if (r["rule_id"] === PLACEHOLDER_RULE_ID && r["active"] === false && !ruleRefs.has(PLACEHOLDER_RULE_ID)) {
        drop.add(i);
        out.push({ table: "commission_rules", id: PLACEHOLDER_RULE_ID, row: rules.rowNumbers[i] as number, why: "the seeded placeholder rule: inactive, and no bonus refers to it" });
      }
    });
    removeAt(rules, drop);
    rules.leftOut += drop.size;
  }
  const runs = translated.get("commission_runs");
  if (runs) {
    const drop = new Set<number>();
    runs.rows.forEach((r, i) => {
      const id = r["run_id"];
      if (typeof id === "string" && id.startsWith(PLACEHOLDER_RUN_PREFIX) && !runRefs.has(id)) {
        drop.add(i);
        out.push({ table: "commission_runs", id, row: runs.rowNumbers[i] as number, why: "the seeded placeholder run: no bonus refers to it" });
      }
    });
    removeAt(runs, drop);
    runs.leftOut += drop.size;
  }
  return out;
}

// ── Open tills ───────────────────────────────────────────────

export interface OpenSessionsReport {
  /** Whether --open-sessions-blank was given. */
  flag: boolean;
  /** Rows whose status is open. */
  openRows: number;
  /** Rows that hold a figure in at least one closing column: the ones the flag changes (or would change). */
  rowsWithClosingFigures: number;
  /** The columns the flag blanks. */
  columns: string[];
}

/** With `apply`, set the closing columns of every open session to NULL. Counts either way. */
export function blankOpenSessionClosing(tab: TranslatedTab | undefined, apply: boolean): OpenSessionsReport {
  const report: OpenSessionsReport = { flag: apply, openRows: 0, rowsWithClosingFigures: 0, columns: [...OPEN_SESSION_CLOSING_COLUMNS] };
  if (!tab) return report;
  for (const row of tab.rows) {
    if (row["status"] !== "open") continue;
    report.openRows++;
    const held = OPEN_SESSION_CLOSING_COLUMNS.filter((c) => c in row && row[c] !== null);
    if (held.length > 0) report.rowsWithClosingFigures++;
    if (apply) for (const c of held) row[c] = null;
  }
  return report;
}

// ── Config secrets ───────────────────────────────────────────

export interface LeftOutKey {
  row: number;
  /** The key's name; "(unusual name)" when the cell is not a plain key name, so that nothing odd is echoed. */
  key: string;
}

/** The config rows the translation leaves out, by key name and row. Never the value. */
export function leftOutConfigKeys(raw: SheetTab): LeftOutKey[] {
  const at = raw.header.findIndex((h) => String(h ?? "").trim() === "key");
  if (at < 0) return [];
  const out: LeftOutKey[] = [];
  raw.rows.forEach((cells, i) => {
    const key = String(cells[at] ?? "").trim();
    if (key === "" || !configKeyLeftOut(key)) return;
    out.push({ row: 3 + i, key: /^[A-Za-z0-9_.-]{1,80}$/.test(key) ? key : "(unusual name)" });
  });
  return out;
}

// ── PINs ─────────────────────────────────────────────────────

export interface PinReport {
  /** People whose login code was hashed into pin_hash. */
  hashed: number;
  /** People with no login code: pin_hash stays NULL, they cannot sign in until a PIN is set. */
  blank: { staffId: string; row: number }[];
  /** People whose login-code cell could not be read as text or a number (a date, say): treated as blank. */
  unreadable: number;
  /** Hashed codes that are not 4 to 8 digits (the PIN screen takes only those). Counted, never shown. */
  notFourToEightDigits: number;
}

/** The code as the old login read it: `(code || '').toString().trim()`. */
function codeText(cell: unknown): string | null | undefined {
  if (cell === "" || cell === null || cell === undefined) return null;
  if (typeof cell === "string") return cell.trim() === "" ? null : cell.trim();
  if (typeof cell === "number" && Number.isFinite(cell)) return String(cell);
  if (typeof cell === "boolean") return String(cell);
  return undefined;
}

/**
 * Add `pin_hash` to every translated staff row: the hash of the row's login_code, or NULL.
 * The plaintext lives only in this function's local variables.
 */
export async function addPinHashes(staff: TranslatedTab, raw: SheetTab, pepper: string): Promise<PinReport> {
  checkPepper(pepper);
  const at = raw.header.findIndex((h) => String(h ?? "").trim() === "login_code");
  const report: PinReport = { hashed: 0, blank: [], unreadable: 0, notFourToEightDigits: 0 };
  for (let i = 0; i < staff.rows.length; i++) {
    const row = staff.rows[i] as Record<string, Value>;
    const rowNo = staff.rowNumbers[i] as number;
    const cell = at < 0 ? "" : (raw.rows[rowNo - 3] ?? [])[at];
    const code = codeText(cell);
    if (code === undefined) report.unreadable++;
    if (code === null || code === undefined) {
      row["pin_hash"] = null;
      report.blank.push({ staffId: String(row["staff_id"]), row: rowNo });
      continue;
    }
    if (!/^[0-9]{4,8}$/.test(code)) report.notFourToEightDigits++;
    row["pin_hash"] = await hashPin(code, pepper);
    report.hashed++;
  }
  return report;
}

// ── All of it ────────────────────────────────────────────────

export interface RulesReport {
  rekeyed: RekeyedId[];
  /** Rows rejected for repeating another row's key, per table. */
  duplicateKeyRejects: Record<string, number>;
  leftOut: LeftOutRow[];
  openSessions: OpenSessionsReport;
  pins: PinReport;
  configKeysLeftOut: LeftOutKey[];
  /** Cells Google Sheets had turned from text into a date, read back as the day: count per "table.column". */
  retypedBySheets: Record<string, number>;
}

export interface RulesOptions {
  /** --open-sessions-blank. */
  openSessionsBlank: boolean;
  pepper: string;
}

/** The rules as a `prepare` hook for loadTabs, and the report they fill in as they run. */
export function createRules(options: RulesOptions): { report: RulesReport; prepare: (ctx: PrepareContext) => Promise<void> } {
  checkPepper(options.pepper);
  const report: RulesReport = {
    rekeyed: [],
    duplicateKeyRejects: {},
    leftOut: [],
    openSessions: { flag: options.openSessionsBlank, openRows: 0, rowsWithClosingFigures: 0, columns: [...OPEN_SESSION_CLOSING_COLUMNS] },
    pins: { hashed: 0, blank: [], unreadable: 0, notFourToEightDigits: 0 },
    retypedBySheets: {},
    configKeysLeftOut: [],
  };
  const prepare = async ({ translated, tabs, contract }: PrepareContext): Promise<void> => {
    for (const [name, tab] of translated) {
      for (const cell of tab.retyped) report.retypedBySheets[`${name}.${cell.column}`] = (report.retypedBySheets[`${name}.${cell.column}`] ?? 0) + 1;
    }
    for (const [name, tab] of translated) {
      const pk = pkOf(contract, name);
      if (ITEM_TABLES.includes(name)) report.rekeyed.push(...rekeyDuplicateItems(tab, pk));
      else {
        const n = rejectDuplicateKeys(tab, pk);
        if (n > 0) report.duplicateKeyRejects[name] = n;
      }
    }
    report.leftOut.push(...dropPlaceholders(translated));
    report.openSessions = blankOpenSessionClosing(translated.get("till_sessions"), options.openSessionsBlank);
    const rawOf = (name: string): SheetTab | undefined => tabs.find((t) => t.tab === name);
    const staff = translated.get("staff");
    const rawStaff = rawOf("staff");
    if (staff && rawStaff) report.pins = await addPinHashes(staff, rawStaff, options.pepper);
    const rawConfig = rawOf("config");
    if (rawConfig && translated.has("config")) report.configKeysLeftOut = leftOutConfigKeys(rawConfig);
  };
  return { report, prepare };
}

