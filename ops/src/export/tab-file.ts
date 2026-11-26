// The file the export tool writes for one tab, and the reader the import tool
// uses (card P4-01). One JSON file per tab:
//
//   {
//   "format": "storeops-sheet-export/1",
//   "tab": "sales",              the tab's name in the Sheet
//   "index": 4,                  its position in the workbook, from 1
//   "hidden": false,
//   "title": [...],              row 1 of the tab (the banner)
//   "header": [...],             row 2: what SheetTab.header is
//   "rows": [                    row 3 on, one array per line: what SheetTab.rows is
//   ["a1",4417.25,""],
//   ...
//   ],
//   "counts": { "rows": N, "columns": N, "formulaCells": N, "dates": N, "errors": N }
//   }
//
// A cell is  ""  (a blank, and the empty string: getValues cannot tell them apart),
// a JSON number, true or false, a string, {"$date": "2026-11-21T14:00:00.000Z"}
// for a date or time cell, or {"$error": "#REF!"} for an error cell. A string
// that looks like a number or a date stays a string; only the tagged object is
// a date. Every row, the title and the header are the same width.
//
// readTabFile checks all of this and nothing else is accepted: an unknown format
// version, a missing or extra key, a ragged row, an unknown cell shape, a count
// that disagrees with the cells. Read back, a date is a real Date and an error
// cell is its text ("#REF!"), as Apps Script's getValues returns them.
import type { SheetCell } from "./xlsx.ts";

export const FORMAT = "storeops-sheet-export/1";

export interface TabInput {
  tab: string;
  index: number;
  hidden: boolean;
  title: SheetCell[];
  header: SheetCell[];
  rows: SheetCell[][];
  formulaCells: number;
}

export interface TabCounts {
  rows: number;
  columns: number;
  formulaCells: number;
  /** Date and time cells (title, header and rows). */
  dates: number;
  /** Error cells (#REF!, #N/A...), title, header and rows. */
  errors: number;
}

/** A tab read back: a SheetTab (tab, header, rows) plus what the file also carries. */
export interface TabFile {
  tab: string;
  index: number;
  hidden: boolean;
  title: unknown[];
  header: unknown[];
  rows: unknown[][];
  counts: TabCounts;
}

const KEYS = ["format", "tab", "index", "hidden", "title", "header", "rows", "counts"];
const COUNT_KEYS: (keyof TabCounts)[] = ["rows", "columns", "formulaCells", "dates", "errors"];
const ERROR_CODE = /^#[A-Z0-9/!?_]+$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ── Write ────────────────────────────────────────────────────

function encodeCell(c: unknown, where: string): unknown {
  if (typeof c === "string" || typeof c === "boolean") return c;
  if (typeof c === "number") {
    if (!Number.isFinite(c)) throw new Error(`${where}: a number cell is not finite (NaN and infinity have no JSON spelling)`);
    return c === 0 ? 0 : c; // -0 is written as 0
  }
  if (c instanceof Date) {
    if (Number.isNaN(c.getTime())) throw new Error(`${where}: a date cell is an invalid date`);
    return { $date: c.toISOString() };
  }
  if (isObject(c) && Object.keys(c).length === 1 && typeof c["error"] === "string" && ERROR_CODE.test(c["error"])) return { $error: c["error"] };
  throw new Error(`${where}: not a valid cell (expected a string, number, boolean, Date or error cell)`);
}

/** The text of the file for one tab. Throws on a ragged row, a non-finite number, an invalid date or an unknown cell. */
export function writeTabFile(input: TabInput): string {
  if (typeof input.tab !== "string" || input.tab === "") throw new Error("the tab needs a name");
  if (!Number.isInteger(input.index) || input.index < 1) throw new Error("the tab's index must be a whole number from 1");
  if (!Number.isInteger(input.formulaCells) || input.formulaCells < 0) throw new Error("formulaCells must be a whole number, 0 or more");
  const width = input.header.length;
  if (width < 1) throw new Error("the header has no columns");
  if (input.title.length !== width) throw new Error(`the title has ${input.title.length} columns, the header ${width}`);
  const stats = { dates: 0, errors: 0 };
  const line = (cells: readonly unknown[], where: string): string =>
    JSON.stringify(
      cells.map((c, j) => {
        const e = encodeCell(c, `${where}, column ${j + 1}`);
        if (isObject(e)) "$date" in e ? stats.dates++ : stats.errors++;
        return e;
      }),
    );
  const title = line(input.title, "title");
  const header = line(input.header, "header");
  const rows = input.rows.map((r, i) => {
    if (r.length !== width) throw new Error(`row ${i + 1} has ${r.length} columns, the header ${width}`);
    return line(r, `row ${i + 1}`);
  });
  const total = (input.rows.length + 2) * width;
  if (input.formulaCells > total) throw new Error("formulaCells is more than the tab's cells");
  const counts: TabCounts = { rows: input.rows.length, columns: width, formulaCells: input.formulaCells, dates: stats.dates, errors: stats.errors };
  return [
    "{",
    `"format": ${JSON.stringify(FORMAT)},`,
    `"tab": ${JSON.stringify(input.tab)},`,
    `"index": ${input.index},`,
    `"hidden": ${input.hidden === true ? "true" : "false"},`,
    `"title": ${title},`,
    `"header": ${header},`,
    rows.length === 0 ? `"rows": [],` : `"rows": [\n${rows.join(",\n")}\n],`,
    `"counts": ${JSON.stringify(counts)}`,
    "}",
    "",
  ].join("\n");
}

// ── Read ─────────────────────────────────────────────────────

interface Tally {
  dates: number;
  errors: number;
}

function decodeCell(c: unknown, where: string, tally: Tally): unknown {
  if (typeof c === "string" || typeof c === "boolean") return c;
  if (typeof c === "number") {
    if (!Number.isFinite(c)) throw new Error(`${where}: a number cell is not finite`);
    return c;
  }
  if (isObject(c)) {
    const keys = Object.keys(c);
    if (keys.length === 1 && keys[0] === "$date" && typeof c["$date"] === "string") {
      const s = c["$date"];
      let canonical = false;
      try {
        canonical = new Date(s).toISOString() === s;
      } catch {
        canonical = false;
      }
      if (!canonical) throw new Error(`${where}: not a valid cell (a $date must be an ISO instant ending in Z, as toISOString writes it)`);
      tally.dates++;
      return new Date(s);
    }
    if (keys.length === 1 && keys[0] === "$error" && typeof c["$error"] === "string" && ERROR_CODE.test(c["$error"])) {
      tally.errors++;
      return c["$error"];
    }
  }
  throw new Error(`${where}: not a valid cell`);
}

function decodeLine(v: unknown, label: string, width: number | undefined, tally: Tally): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${label} is not an array`);
  if (width !== undefined && v.length !== width) throw new Error(`${label} has ${v.length} columns, expected ${width} (ragged row)`);
  return v.map((c, j) => decodeCell(c, `${label}, column ${j + 1}`, tally));
}

/** Parse and validate the text of a tab file. Throws an Error that says what is wrong, and where, but never quotes a cell. */
export function readTabFile(text: string): TabFile {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error("the tab file is not valid JSON");
  }
  if (!isObject(o)) throw new Error("the tab file is not a JSON object");
  if (!("format" in o)) throw new Error('the tab file has no "format"');
  if (o["format"] !== FORMAT) throw new Error(`the tab file's format is not ${FORMAT} (this reader knows only that version)`);
  for (const k of KEYS) if (!(k in o)) throw new Error(`the tab file has no "${k}"`);
  for (const k of Object.keys(o)) if (!KEYS.includes(k)) throw new Error(`the tab file has an unknown key "${k.slice(0, 40)}"`);

  const tab = o["tab"];
  if (typeof tab !== "string" || tab === "") throw new Error('"tab" must be a non-empty string');
  const index = o["index"];
  if (typeof index !== "number" || !Number.isInteger(index) || index < 1) throw new Error('"index" must be a whole number from 1');
  if (typeof o["hidden"] !== "boolean") throw new Error('"hidden" must be true or false');

  const tally: Tally = { dates: 0, errors: 0 };
  const rawHeader = o["header"];
  if (!Array.isArray(rawHeader) || rawHeader.length < 1) throw new Error('"header" must be an array of at least one column');
  const width = rawHeader.length;
  const header = decodeLine(rawHeader, "header", undefined, tally);
  const title = decodeLine(o["title"], "title", width, tally);
  const rawRows = o["rows"];
  if (!Array.isArray(rawRows)) throw new Error('"rows" must be an array');
  const rows = rawRows.map((r, i) => decodeLine(r, `row ${i + 1}`, width, tally));

  const c = o["counts"];
  if (!isObject(c)) throw new Error('"counts" must be an object');
  for (const k of Object.keys(c)) if (!(COUNT_KEYS as string[]).includes(k)) throw new Error(`counts has an unknown key "${k.slice(0, 40)}"`);
  for (const k of COUNT_KEYS) {
    const n = c[k];
    if (n === undefined) throw new Error(`counts.${k} is missing`);
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) throw new Error(`counts.${k} must be a whole number, 0 or more`);
  }
  const counts = c as unknown as TabCounts;
  const want: Omit<TabCounts, "formulaCells"> = { rows: rows.length, columns: width, dates: tally.dates, errors: tally.errors };
  for (const k of ["rows", "columns", "dates", "errors"] as const)
    if (counts[k] !== want[k]) throw new Error(`counts.${k} says ${counts[k]} but the file holds ${want[k]}: the file was changed or damaged`);
  if (counts.formulaCells > (rows.length + 2) * width) throw new Error("counts.formulaCells is more than the tab's cells: the file was changed or damaged");

  return { tab, index, hidden: o["hidden"], title, header, rows, counts: { ...counts } };
}
