// A reader for .xlsx workbooks, with nothing but Node built-ins (card P4-01).
//
// What it reads is what Google Sheets writes for File > Download > .xlsx, and
// what Excel writes if the owner opens and re-saves that file. It reads the zip
// itself (central directory, stored and deflated entries, data descriptors) and
// the XML itself. It is a reader for ONE job: turn a workbook into the cells a
// Sheet's getValues() would have given, tab by tab, so that an archive of them
// is the Sheet as it was.
//
// The rules it keeps:
//   - Nothing is guessed or repaired. Anything it cannot read, or does not
//     understand, is an XlsxError that names the part or the cell; it never
//     returns a partial workbook. Error messages carry places (tab, cell
//     reference), never a cell's contents: the values are pay and takings.
//   - A blank cell is "" (the getValues spelling), never 0 and never null
//     (ADR-0004). A missing <row> or <c> is a blank. Cells are placed by their
//     r="B7" reference, never by their position in the XML.
//   - A number cell whose style is a date or time format is a Date (see
//     isDateFormat for the rule). A serial is a wall-clock time in the Sheet's
//     zone, America/Toronto, and becomes the instant it names there.
//   - Numbers are Number(text), unrounded.
//
// Not supported, and refused rather than skipped: zip64, encryption, split
// archives, compression other than stored and deflate, a DOCTYPE, an encoding
// other than UTF-8, chart and dialog sheets, a formula with no cached value.
import { inflateRawSync } from "node:zlib";
import { wallClock } from "../lib/dates.ts";

export const SHEET_ZONE = "America/Toronto";

/** A cell as getValues() gives it ("" for a blank, a Date for a date or time cell), plus the error cells it gives as text. */
export type SheetCell = "" | number | boolean | string | Date | { error: string };

export interface XlsxSheet {
  /** 1-based position in the workbook. */
  index: number;
  name: string;
  state: "visible" | "hidden" | "veryHidden";
  hidden: boolean;
  /** Rows 1..last row holding a value, each `columns` wide. */
  cells: SheetCell[][];
  /** Width of the used range: the last column holding a value in any row. 0 when the tab is empty. */
  columns: number;
  /** Cells that hold a formula (their cached value is what is in `cells`). */
  formulaCells: number;
  mergedRanges: number;
}

export interface XlsxWorkbook {
  date1904: boolean;
  sheets: XlsxSheet[];
}

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XlsxError";
  }
}
const fail = (message: string): never => {
  throw new XlsxError(message);
};

// ── Zip ──────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Every entry of a zip archive, decompressed and checked against its CRC-32. Directories are left out. */
export function readZip(bytes: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const notZip = "not a zip archive (no end-of-central-directory record: this is not an .xlsx file, or it was cut short)";
  if (buf.length < 22) return fail(buf.length === 0 ? "the file is empty" : notZip);

  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD && i + 22 + buf.readUInt16LE(i + 20) <= buf.length) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return fail(notZip);

  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === SIG_ZIP64_LOCATOR) return fail("the archive uses zip64, which this reader does not support");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return fail("the archive uses zip64, which this reader does not support");
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) return fail("the archive is split over several files, which this reader does not support");
  if (cdOffset + cdSize > eocd) return fail("the archive's central directory is damaged or the file is truncated");

  const out = new Map<string, Buffer>();
  let pos = cdOffset;
  for (let n = 0; n < total; n++) {
    if (pos + 46 > eocd || buf.readUInt32LE(pos) !== SIG_CENTRAL) return fail("the archive's central directory is damaged or the file is truncated");
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const csize = buf.readUInt32LE(pos + 20);
    const usize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const offset = buf.readUInt32LE(pos + 42);
    if (pos + 46 + nameLen + extraLen + commentLen > eocd) return fail("the archive's central directory is damaged or the file is truncated");
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x0001 || flags & 0x0040) return fail(`the archive is encrypted (entry ${name}); save the workbook without a password`);
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) return fail("the archive uses zip64, which this reader does not support");
    if (method !== 0 && method !== 8) return fail(`entry ${name} uses compression method ${method}, which this reader does not support`);
    if (name.endsWith("/")) continue;
    if (out.has(name)) return fail(`the archive holds two entries named ${name}`);
    if (usize > MAX_ENTRY_BYTES) return fail(`entry ${name} is larger than ${MAX_ENTRY_BYTES} bytes`);

    if (offset + 30 > cdOffset || buf.readUInt32LE(offset) !== SIG_LOCAL) return fail(`entry ${name} cannot be found in the archive (damaged or truncated)`);
    const dataStart = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    if (dataStart + csize > cdOffset) return fail(`entry ${name} runs past the end of the archive (damaged or truncated)`);
    const packed = buf.subarray(dataStart, dataStart + csize);
    let data: Buffer;
    if (method === 0) {
      if (csize !== usize) return fail(`entry ${name} is corrupt (stored sizes disagree)`);
      data = packed;
    } else {
      try {
        data = inflateRawSync(packed, { maxOutputLength: Math.max(usize, 1) });
      } catch {
        return fail(`entry ${name} is corrupt (it cannot be decompressed)`);
      }
    }
    if (data.length !== usize) return fail(`entry ${name} is corrupt (its size is not what the archive says)`);
    if (crc32(data) !== crc) return fail(`entry ${name} is corrupt (CRC mismatch)`);
    out.set(name, data);
  }
  return out;
}

// ── XML ──────────────────────────────────────────────────────

interface XNode {
  /** Local name: no namespace prefix. */
  name: string;
  /** Qualified name as written, to match the closing tag. */
  q: string;
  /** Attributes by their full name (r:id keeps its prefix); namespace declarations left out. */
  attrs: Record<string, string>;
  children: XNode[];
  /** The element's own text, entities decoded and line ends normalised. */
  text: string;
}

const ENTITY = /&(?:#x([0-9A-Fa-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));|&/g;
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string, part: string): string {
  if (!s.includes("&")) return s;
  return s.replace(ENTITY, (m, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
    if (named !== undefined) return NAMED[named] as string;
    if (hex === undefined && dec === undefined) return fail(`${part}: unknown or malformed entity in the XML`);
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec as string, 10);
    if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return fail(`${part}: a character reference in the XML is not a valid character`);
    return String.fromCodePoint(cp);
  });
}

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE|<(\/)?([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/)?>|([^<]+)/y;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function decodeUtf8(bytes: Buffer, part: string): string {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return fail(`${part} is UTF-16; only UTF-8 is supported`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return fail(`${part} is not valid UTF-8`);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parseXml(bytes: Buffer, part: string): XNode {
  const src = decodeUtf8(bytes, part);
  const decl = /^<\?xml[^?]*\?>/.exec(src);
  if (decl) {
    const enc = /encoding\s*=\s*["']([^"']+)["']/.exec(decl[0]);
    if (enc && !/^utf-?8$/i.test(enc[1] as string)) return fail(`${part} declares the encoding ${enc[1]}; only UTF-8 is supported`);
  }
  const stack: XNode[] = [];
  let root: XNode | undefined;
  let pos = 0;
  TOKEN.lastIndex = 0;
  while (pos < src.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(src);
    if (m === null) return fail(`${part} is not well-formed XML (cannot read at character ${pos})`);
    pos = TOKEN.lastIndex;
    const [whole, cdata, closing, qname, attrText, selfClose, text] = m;
    const top = stack[stack.length - 1];
    if (whole === "<!DOCTYPE") return fail(`${part} has a DOCTYPE, which is not allowed`);
    if (cdata !== undefined) {
      if (!top) return fail(`${part} is not well-formed XML (text outside the root element)`);
      top.text += cdata.replace(/\r\n?/g, "\n");
    } else if (text !== undefined) {
      const t = text.replace(/\r\n?/g, "\n");
      if (!top) {
        if (t.trim() !== "") return fail(`${part} is not well-formed XML (text outside the root element)`);
      } else top.text += decodeEntities(t, part);
    } else if (qname !== undefined) {
      const local = qname.slice(qname.indexOf(":") + 1);
      if (closing) {
        const open = stack.pop();
        if (!open || open.q !== qname) return fail(`${part} is not well-formed XML (a closing tag does not match its opening tag)`);
        continue;
      }
      const node: XNode = { name: local, q: qname, attrs: {}, children: [], text: "" };
      if (attrText) {
        ATTR.lastIndex = 0;
        let a: RegExpExecArray | null;
        while ((a = ATTR.exec(attrText))) {
          const key = a[1] as string;
          if (key === "xmlns" || key.startsWith("xmlns:")) continue;
          node.attrs[key] = decodeEntities((a[2] ?? a[3]) as string, part);
        }
      }
      if (top) top.children.push(node);
      else if (root) return fail(`${part} is not well-formed XML (more than one root element)`);
      else root = node;
      if (!selfClose) stack.push(node);
    }
  }
  if (stack.length > 0 || !root) return fail(`${part} is not well-formed XML (it ends inside an element, or has no element)`);
  return root;
}

const child = (n: XNode, name: string): XNode | undefined => n.children.find((c) => c.name === name);
const kids = (n: XNode, name: string): XNode[] => n.children.filter((c) => c.name === name);

/** Excel's _xHHHH_ escape: the character with that code unit. (A literal "_xHHHH_" is stored as "_x005F_xHHHH_".) */
const unescapeX = (s: string): string => (s.includes("_x") ? s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))) : s);

/** The text of a shared or inline string item: its <t>, or its runs' <t>s joined; phonetic runs ignored. */
function stringItem(si: XNode): string {
  let s = "";
  for (const c of si.children) {
    if (c.name === "t") s += c.text;
    else if (c.name === "r") for (const t of kids(c, "t")) s += t.text;
  }
  return unescapeX(s);
}

// ── Dates ────────────────────────────────────────────────────

/**
 * Is this number format a date or time? The rule, in one place:
 *
 *  1. Read the format code left to right. Skip text in "double quotes", a
 *     character after a backslash (\d), and the character after _ or * (padding
 *     and fill: _) and *d are not letters).
 *  2. A [bracket] is dropped (colours [Red], conditions [>100], locale and
 *     currency [$-409] [$EUR-2]) except the elapsed-time forms [h] [hh] [m] [mm]
 *     [s] [ss], which are time letters.
 *  3. What is left is a date or time format if it holds any of y m d h s
 *     (either case). General, 0.00, #,##0, 0%, 0.00E+00 and @ hold none.
 *  4. All sections count: "0;[Red]yyyy" is a date format.
 *
 * Elapsed-time cells ([h]:mm) count: Sheets gives a Date for a duration cell too.
 */
export function isDateFormat(code: string): boolean {
  for (let i = 0; i < code.length; i++) {
    const ch = code[i] as string;
    if (ch === '"') {
      const end = code.indexOf('"', i + 1);
      if (end < 0) return false; // an unclosed quote swallows the rest
      i = end;
    } else if (ch === "\\" || ch === "_" || ch === "*") i++;
    else if (ch === "[") {
      const end = code.indexOf("]", i + 1);
      if (end < 0) return false;
      if (/^(?:h+|m+|s+)$/i.test(code.slice(i + 1, end))) return true;
      i = end;
    } else if ("ymdhsYMDHS".includes(ch)) return true;
  }
  return false;
}

/** The built-in number formats that are dates or times: 14-22, 27-36, 45-47, 50-58 (27-36 and 50-58 are locale dates). */
export function isBuiltinDateId(id: number): boolean {
  return (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58);
}

const DAY_MS = 86_400_000;
const utcMs = (y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number): number => {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  dt.setUTCHours(h, mi, s, ms);
  return dt.getTime();
};
/** Toronto's offset from UTC at an instant, in ms. */
function offsetAt(t: number): number {
  const w = wallClock(new Date(t));
  return utcMs(w.year, w.month, w.day, w.hour, w.minute, w.second, 0) - Math.floor(t / 1000) * 1000;
}
/**
 * The instant at which Toronto's wall clock reads these fields (month 1-12). The same
 * resolution as ops/src/lib/dates.ts and a V8 local Date, which the old code ran on:
 * a repeated wall time (fall back) is its FIRST occurrence; a skipped one (spring
 * forward) is read with the offset from before the jump, so 02:30 is 03:30.
 */
export function torontoWallToInstant(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number): Date {
  const guess = utcMs(y, mo, d, h, mi, s, ms);
  const before = offsetAt(guess - DAY_MS);
  const after = offsetAt(guess + DAY_MS);
  const valid: number[] = [];
  for (const off of new Set([before, after])) {
    const t = guess - off;
    if (offsetAt(t) === off) valid.push(t);
  }
  return new Date(valid.length > 0 ? Math.min(...valid) : guess - before);
}

/**
 * A spreadsheet serial, as the Toronto wall-clock time it names, as an instant.
 * Excel's 1900 system: serial 1 is 1900-01-01, serial 60 is the 29 Feb 1900 that
 * never existed (refused), serial 61 is 1900-03-01. The 1904 system counts from
 * 1904-01-01 (serial 0) with no such day. A serial below 1 is a time of day with
 * no date: it is dated 1899-12-30, as Apps Script dates a time-only cell.
 */
export function serialToDate(serial: number, date1904: boolean): Date {
  if (!Number.isFinite(serial) || serial < 0) return fail("a date cell holds a negative or non-finite serial");
  if (serial >= 2_958_466) return fail("a date cell holds a serial past 31 December 9999");
  let day = Math.floor(serial);
  let ms = Math.round((serial - day) * DAY_MS);
  if (ms >= DAY_MS) {
    day += 1;
    ms = 0;
  }
  let base: number;
  if (day < 1) base = Date.UTC(1899, 11, 30);
  else if (date1904) base = Date.UTC(1904, 0, 1) + day * DAY_MS;
  else if (day === 60) return fail("a date cell holds the 29 Feb 1900 that Excel's 1900 system invents; it is not a date");
  else if (day < 60) base = Date.UTC(1899, 11, 31) + day * DAY_MS;
  else base = Date.UTC(1899, 11, 30) + day * DAY_MS;
  const b = new Date(base);
  return torontoWallToInstant(b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate(), Math.floor(ms / 3_600_000), Math.floor(ms / 60_000) % 60, Math.floor(ms / 1000) % 60, ms % 1000);
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
/** A t="d" cell: an ISO 8601 date or date-time. Without a zone it is Toronto wall-clock time, like a serial. */
function isoToDate(text: string): Date {
  const m = ISO.exec(text.trim());
  if (!m) return fail("a t=\"d\" cell does not hold an ISO 8601 date");
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] ?? "0", m[5] ?? "0", m[6] ?? "0"].map(Number) as [number, number, number, number, number, number];
  const ms = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return fail("a t=\"d\" cell holds an impossible date");
  const msInt = Math.round(ms);
  if (m[8] === undefined) return torontoWallToInstant(y, mo, d, h, mi, s, msInt);
  const off = m[8] === "Z" ? 0 : (m[8].startsWith("-") ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(-2)));
  return new Date(utcMs(y, mo, d, h, mi, s, msInt) - off * 60_000);
}

// ── Workbook ─────────────────────────────────────────────────

const ERRORS = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA", "#SPILL!", "#CALC!", "#FIELD!", "#BLOCKED!", "#CONNECT!", "#BUSY!", "#UNKNOWN!"]);
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const REF = /^([A-Z]{1,3})(\d{1,7})$/;
const MAX_CELLS = 30_000_000;

function parseRef(ref: string): { row: number; col: number } | null {
  const m = REF.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1] as string) col = col * 26 + ch.charCodeAt(0) - 64;
  const row = Number(m[2]);
  return col >= 1 && col <= 16384 && row >= 1 && row <= 1_048_576 ? { row, col } : null;
}

/** Resolve a relationship target, written relative to `baseDir` or absolute ("/xl/..."). */
function resolveTarget(baseDir: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `${baseDir}${target}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

interface Context {
  strings: string[];
  /** For each cellXfs index: is its number format a date or time? */
  dateXf: boolean[];
  date1904: boolean;
}

function readStyles(parts: Map<string, Buffer>, path: string | undefined): boolean[] {
  if (path === undefined || !parts.has(path)) return [];
  const root = parseXml(parts.get(path) as Buffer, path);
  const custom = new Map<number, string>();
  const numFmts = child(root, "numFmts");
  for (const nf of numFmts ? kids(numFmts, "numFmt") : []) custom.set(Number(nf.attrs["numFmtId"]), nf.attrs["formatCode"] ?? "");
  const xfs = child(root, "cellXfs");
  return (xfs ? kids(xfs, "xf") : []).map((xf) => {
    const id = Number(xf.attrs["numFmtId"] ?? 0);
    if (!Number.isInteger(id)) return fail(`${path}: a cell format has no number format id`);
    const code = custom.get(id);
    return code !== undefined ? isDateFormat(code) : isBuiltinDateId(id);
  });
}

function readSharedStrings(parts: Map<string, Buffer>, path: string | undefined): string[] {
  if (path === undefined || !parts.has(path)) return [];
  const root = parseXml(parts.get(path) as Buffer, path);
  return kids(root, "si").map(stringItem);
}

type Grid = Map<number, Map<number, SheetCell>>;

function readCell(c: XNode, ctx: Context): { value: SheetCell; formula: boolean } {
  const type = c.attrs["t"] ?? "n";
  const f = child(c, "f");
  const v = child(c, "v");
  const is = child(c, "is");
  const formula = f !== undefined;
  if (v === undefined && is === undefined) {
    if (formula) return fail("a formula cell has no cached value, so there is nothing to export");
    return { value: "", formula };
  }
  const text = v?.text ?? "";
  switch (type) {
    case "s": {
      if (!/^\d+$/.test(text.trim())) return fail("a shared-string cell has no valid string index");
      const s = ctx.strings[Number(text.trim())];
      if (s === undefined) return fail("a cell points at a shared string that does not exist");
      return { value: s, formula };
    }
    case "inlineStr":
      if (is === undefined) return fail("an inline-string cell has no string");
      return { value: stringItem(is), formula };
    case "str":
      return { value: unescapeX(text), formula };
    case "b":
      if (text.trim() !== "0" && text.trim() !== "1") return fail("a boolean cell holds something other than 0 or 1");
      return { value: text.trim() === "1", formula };
    case "e":
      if (!ERRORS.has(text.trim())) return fail("an error cell holds an error code this reader does not know");
      return { value: { error: text.trim() }, formula };
    case "d":
      return { value: isoToDate(text), formula };
    case "n": {
      const t = text.trim();
      if (t === "") {
        if (formula) return fail("a formula cell has no cached value, so there is nothing to export");
        return { value: "", formula };
      }
      if (!NUMBER.test(t)) return fail("a number cell does not hold a number");
      let n = Number(t);
      if (!Number.isFinite(n)) return fail("a number cell holds a number too large to read");
      if (n === 0) n = 0; // -0 is not kept (JSON cannot hold it, and a sheet cannot show it)
      const s = Number(c.attrs["s"] ?? 0);
      if (!Number.isInteger(s) || s < 0) return fail("a cell has an invalid style index");
      if (s > 0 && ctx.dateXf[s] === undefined) return fail("a cell points at a style that does not exist");
      return { value: ctx.dateXf[s] === true ? serialToDate(n, ctx.date1904) : n, formula };
    }
    default:
      return fail(`a cell has a type this reader does not know (t="${type.slice(0, 12)}")`);
  }
}

function readSheet(root: XNode, ctx: Context, tab: string): Pick<XlsxSheet, "cells" | "columns" | "formulaCells" | "mergedRanges"> {
  if (root.name !== "worksheet") return fail(`tab "${tab}" is not a worksheet`);
  const dim = child(root, "dimension")?.attrs["ref"];
  if (dim !== undefined && !/^[A-Z]{1,3}\d+(?::[A-Z]{1,3}\d+)?$/.test(dim)) return fail(`tab "${tab}" has a damaged <dimension>`);
  const data = child(root, "sheetData");
  const grid: Grid = new Map();
  let formulaCells = 0;
  let lastRowSeen = 0;
  for (const row of data ? kids(data, "row") : []) {
    const rAttr = row.attrs["r"];
    const rowNo = rAttr === undefined ? lastRowSeen + 1 : Number(rAttr);
    if (!Number.isInteger(rowNo) || rowNo < 1 || rowNo > 1_048_576) return fail(`tab "${tab}" has a row with an invalid number`);
    lastRowSeen = rowNo;
    for (const c of kids(row, "c")) {
      const ref = c.attrs["r"];
      if (ref === undefined) return fail(`tab "${tab}" row ${rowNo} has a cell with no reference`);
      const at = parseRef(ref);
      if (!at) return fail(`tab "${tab}" has a cell with an invalid reference (${ref.slice(0, 12)})`);
      if (at.row !== rowNo) return fail(`tab "${tab}" cell ${ref} sits in row ${rowNo}`);
      let r = grid.get(at.row);
      if (!r) grid.set(at.row, (r = new Map()));
      if (r.has(at.col)) return fail(`tab "${tab}" cell ${ref} appears twice`);
      let got: { value: SheetCell; formula: boolean };
      try {
        got = readCell(c, ctx);
      } catch (e) {
        if (e instanceof XlsxError) return fail(`tab "${tab}" cell ${ref}: ${e.message}`);
        throw e;
      }
      if (got.formula) formulaCells++;
      r.set(at.col, got.value);
    }
  }

  // merged cells: the value is in the first cell, the rest are blank
  let merged = 0;
  const mc = child(root, "mergeCells");
  for (const m of mc ? kids(mc, "mergeCell") : []) {
    const parts = (m.attrs["ref"] ?? "").split(":");
    const a = parseRef(parts[0] ?? "");
    const b = parseRef(parts[1] ?? parts[0] ?? "");
    if (!a || !b || parts.length > 2) return fail(`tab "${tab}" has a damaged merged range`);
    merged++;
    for (const [rowNo, r] of grid) {
      if (rowNo < a.row || rowNo > b.row) continue;
      for (const col of r.keys()) if (col >= a.col && col <= b.col && !(rowNo === a.row && col === a.col)) r.set(col, "");
    }
  }

  let lastRow = 0;
  let lastCol = 0;
  for (const [rowNo, r] of grid)
    for (const [col, v] of r)
      if (v !== "") {
        if (rowNo > lastRow) lastRow = rowNo;
        if (col > lastCol) lastCol = col;
      }
  if (lastRow * lastCol > MAX_CELLS) return fail(`tab "${tab}" is too large to read`);
  const cells: SheetCell[][] = [];
  for (let i = 1; i <= lastRow; i++) {
    const r = grid.get(i);
    const line: SheetCell[] = new Array<SheetCell>(lastCol).fill("");
    if (r) for (const [col, v] of r) if (col <= lastCol) line[col - 1] = v;
    cells.push(line);
  }
  return { cells, columns: lastCol, formulaCells, mergedRanges: merged };
}

/** Read every tab of an .xlsx file, hidden ones too. Throws XlsxError on anything it cannot read. */
export function readWorkbook(bytes: Uint8Array): XlsxWorkbook {
  const parts = readZip(bytes);
  const WB = "xl/workbook.xml";
  const RELS = "xl/_rels/workbook.xml.rels";
  if (!parts.has(WB)) return fail(`the file has no ${WB}: it is not an Excel workbook`);
  if (!parts.has(RELS)) return fail(`the file has no ${RELS}, so the tabs cannot be found`);
  const wb = parseXml(parts.get(WB) as Buffer, WB);
  if (wb.name !== "workbook") return fail(`${WB} is not a workbook`);
  const rels = parseXml(parts.get(RELS) as Buffer, RELS);
  const relById = new Map<string, { type: string; path: string }>();
  for (const r of kids(rels, "Relationship")) {
    const id = r.attrs["Id"];
    const target = r.attrs["Target"];
    if (id === undefined || target === undefined) return fail(`${RELS} has a relationship with no Id or Target`);
    if (r.attrs["TargetMode"] === "External") continue;
    relById.set(id, { type: r.attrs["Type"] ?? "", path: resolveTarget("xl/", target) });
  }
  const byType = (suffix: string, fallback: string): string | undefined => {
    for (const r of relById.values()) if (r.type.endsWith(suffix)) return r.path;
    return parts.has(fallback) ? fallback : undefined;
  };

  const pr = child(wb, "workbookPr")?.attrs["date1904"];
  const date1904 = pr === "1" || pr === "true";
  const ctx: Context = { strings: readSharedStrings(parts, byType("/sharedStrings", "xl/sharedStrings.xml")), dateXf: readStyles(parts, byType("/styles", "xl/styles.xml")), date1904 };

  const sheetsNode = child(wb, "sheets");
  if (!sheetsNode) return fail(`${WB} lists no tabs`);
  const seen = new Set<string>();
  const sheets: XlsxSheet[] = [];
  for (const [i, s] of kids(sheetsNode, "sheet").entries()) {
    const name = s.attrs["name"];
    if (name === undefined || name === "") return fail(`tab ${i + 1} of ${WB} has no name`);
    if (seen.has(name.toLowerCase())) return fail(`two tabs are named "${name}"`);
    seen.add(name.toLowerCase());
    const stateText = s.attrs["state"] ?? "visible";
    if (stateText !== "visible" && stateText !== "hidden" && stateText !== "veryHidden") return fail(`tab "${name}" has an unknown state`);
    const rid = Object.entries(s.attrs).find(([k]) => k === "id" || k.endsWith(":id"))?.[1];
    const rel = rid === undefined ? undefined : relById.get(rid);
    if (!rel) return fail(`tab "${name}" has no relationship in ${RELS}`);
    if (!rel.type.endsWith("/worksheet")) return fail(`tab "${name}" is not a worksheet (it is a ${rel.type.split("/").pop()}); it holds no cells to export`);
    const part = parts.get(rel.path);
    if (!part) return fail(`tab "${name}" refers to ${rel.path}, which is not in the file`);
    const body = readSheet(parseXml(part, rel.path), ctx, name);
    sheets.push({ index: i + 1, name, state: stateText, hidden: stateText !== "visible", ...body });
  }
  return { date1904, sheets };
}
