// A small .xlsx WRITER, for tests only (card P4-01). It builds the workbooks the
// export tool is tested on. It shares no code with src/export/xlsx.ts (the
// reader), except that it asks ops/src/lib/dates.ts for Toronto wall-clock
// fields: a Date cell is written the way Google Sheets stores one, as the
// serial number of its wall-clock time in the Sheet's zone.
//
// Not a general writer: it writes what the tests need, and a few things the
// tests need that are odd on purpose (a styled blank cell, a time-only cell,
// an error cell, a `t="d"` cell, a rich-text shared string, a formula with no
// cached value, a date1904 workbook, stored or deflated entries, data
// descriptors, absolute or relative relationship targets).
import { crc32, deflateRawSync } from "node:zlib";
import { wallClock } from "../../src/lib/dates";

// ── Cells ────────────────────────────────────────────────────

export type WCell =
  | null
  | undefined // no <c> element at all
  | string // a shared string
  | number
  | boolean
  | Date // a styled serial: the Toronto wall-clock time of the instant
  | { inline: string } // t="inlineStr"
  | { rich: string[]; phonetic?: string } // a shared string made of runs
  | { formula: string; value: number | string | boolean | null } // a cached value (null: none)
  | { error: string } // t="e"
  | { isoDate: string } // t="d"
  | { serial: number; fmt?: number | string } // a number with a number format (id or code)
  | { blank: number | string }; // a styled cell with no value

export interface WSheet {
  name: string;
  hidden?: boolean | "veryHidden";
  /** grid[i][j] is the cell at row i+1, column j+1. */
  grid?: WCell[][];
  /** Extra cells by reference ("B7"), added to the grid's. */
  at?: Record<string, WCell>;
  /** true (default): the computed range. false: no <dimension>. A string: that text. */
  dimension?: boolean | string;
  merges?: string[];
}

export interface WBook {
  sheets: WSheet[];
  date1904?: boolean;
  /** Entries deflated (default) or stored. */
  deflate?: boolean;
  /** Write sizes after the data, as Google's writer does (flag bit 3). */
  dataDescriptor?: boolean;
  /** Relationship targets as "/xl/worksheets/sheet1.xml" instead of "worksheets/sheet1.xml". */
  absoluteTargets?: boolean;
  /** Entry names to leave out of the archive. */
  omit?: string[];
}

export const DATE_FORMAT = "yyyy\\-mm\\-dd\\ hh:mm:ss.000";

// ── Zip ──────────────────────────────────────────────────────

export interface ZipEntry {
  name: string;
  data: Buffer | string;
  method?: 0 | 8;
  dataDescriptor?: boolean;
}

export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : e.data;
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const name = Buffer.from(e.name, "utf8");
    const dd = e.dataDescriptor === true;
    const flags = 0x0800 | (dd ? 0x0008 : 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(dd ? 0 : crc, 14);
    local.writeUInt32LE(dd ? 0 : body.length, 18);
    local.writeUInt32LE(dd ? 0 : raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const parts = [local, name, body];
    if (dd) {
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc, 4);
      desc.writeUInt32LE(body.length, 8);
      desc.writeUInt32LE(raw.length, 12);
      parts.push(desc);
    }
    const chunk = Buffer.concat(parts);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    locals.push(chunk);
    offset += chunk.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ── Text and references ──────────────────────────────────────

/** XML text with Excel's _xHHHH_ escapes: control characters, and a literal "_xHHHH_" protected. */
export function xmlText(s: string): string {
  return s
    .replace(/_(?=x[0-9A-Fa-f]{4}_)/g, "_x005F_")
    .replace(/[\u0000-\u0008\u000B\u000C\r\u000E-\u001F]/g, (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
const attr = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

export function colName(n: number): string {
  let s = "";
  for (let c = n; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
}
export const ref = (row: number, col: number): string => `${colName(col)}${row}`;
function parseRef(r: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/.exec(r);
  if (!m) throw new Error(`bad reference ${r}`);
  let col = 0;
  for (const ch of m[1] as string) col = col * 26 + ch.charCodeAt(0) - 64;
  return { row: Number(m[2]), col };
}

const DAY_MS = 86_400_000;

/**
 * The serial of an instant: its Toronto wall-clock time as a spreadsheet serial.
 * A wall date of 1899-12-30 is a time-only cell (the serial is the fraction).
 * An instant in the repeated hour of a fall-back night cannot be told from its
 * first occurrence: the wall time is all a Sheet stores.
 */
export function serialOf(d: Date, date1904: boolean): number {
  const w = wallClock(d);
  const frac = (w.hour * 3_600_000 + w.minute * 60_000 + w.second * 1000 + w.ms) / DAY_MS;
  const day = (Date.UTC(w.year, w.month - 1, w.day) - Date.UTC(1899, 11, 30)) / DAY_MS;
  if (day === 0) return frac;
  if (date1904) {
    const n = (Date.UTC(w.year, w.month - 1, w.day) - Date.UTC(1904, 0, 1)) / DAY_MS;
    if (n <= 0) throw new Error("date before 1904-01-02 cannot be written in a 1904 workbook");
    return n + frac;
  }
  if (day === 1) throw new Error("1899-12-31 has no serial");
  if (day <= 60) return day - 1 + frac; // 1900-01-01 (day 2) is serial 1; Excel's fake 29 Feb 1900 is serial 60
  return day + frac;
}

// ── Workbook ─────────────────────────────────────────────────

export function buildWorkbook(book: WBook): Buffer {
  const date1904 = book.date1904 === true;
  const strings: string[] = []; // si xml
  const stringIndex = new Map<string, number>();
  let stringRefs = 0;
  const shared = (key: string, xml: string): number => {
    stringRefs++;
    let i = stringIndex.get(key);
    if (i === undefined) {
      i = strings.length;
      strings.push(xml);
      stringIndex.set(key, i);
    }
    return i;
  };
  const t = (s: string): string => `<t xml:space="preserve">${xmlText(s)}</t>`;

  // number formats: style 0 General, style 1 the date format; more on demand
  const customFormats: string[] = [DATE_FORMAT];
  const xfs: number[] = [0, 164];
  const styleOf = (fmt: number | string): number => {
    let id: number;
    if (typeof fmt === "number") id = fmt;
    else {
      let i = customFormats.indexOf(fmt);
      if (i < 0) i = customFormats.push(fmt) - 1;
      id = 164 + i;
    }
    let s = xfs.indexOf(id);
    if (s < 0) s = xfs.push(id) - 1;
    return s;
  };

  const cellXml = (r: string, c: WCell): string | null => {
    if (c === null || c === undefined) return null;
    if (typeof c === "string") return `<c r="${r}" t="s"><v>${shared("s:" + c, `<si>${t(c)}</si>`)}</v></c>`;
    if (typeof c === "number") {
      if (!Number.isFinite(c)) throw new Error("cannot write a non-finite number");
      return `<c r="${r}"><v>${String(c)}</v></c>`;
    }
    if (typeof c === "boolean") return `<c r="${r}" t="b"><v>${c ? 1 : 0}</v></c>`;
    if (c instanceof Date) return `<c r="${r}" s="1"><v>${String(serialOf(c, date1904))}</v></c>`;
    if ("inline" in c) return `<c r="${r}" t="inlineStr"><is>${t(c.inline)}</is></c>`;
    if ("rich" in c) {
      const runs = c.rich.map((x, i) => `<r><rPr>${i % 2 ? "<b/>" : "<i/>"}<sz val="11"/></rPr>${t(x)}</r>`).join("");
      const ph = c.phonetic === undefined ? "" : `<rPh sb="0" eb="1">${t(c.phonetic)}</rPh><phoneticPr fontId="1"/>`;
      return `<c r="${r}" t="s"><v>${shared("r:" + JSON.stringify(c), `<si>${runs}${ph}</si>`)}</v></c>`;
    }
    if ("formula" in c) {
      const f = `<f>${xmlText(c.formula)}</f>`;
      const v = c.value;
      if (v === null) return `<c r="${r}">${f}</c>`;
      if (typeof v === "number") return `<c r="${r}">${f}<v>${String(v)}</v></c>`;
      if (typeof v === "boolean") return `<c r="${r}" t="b">${f}<v>${v ? 1 : 0}</v></c>`;
      return `<c r="${r}" t="str">${f}<v>${xmlText(v)}</v></c>`;
    }
    if ("error" in c) return `<c r="${r}" t="e"><v>${xmlText(c.error)}</v></c>`;
    if ("isoDate" in c) return `<c r="${r}" t="d"><v>${c.isoDate}</v></c>`;
    if ("serial" in c) return `<c r="${r}" s="${styleOf(c.fmt ?? 0)}"><v>${String(c.serial)}</v></c>`;
    return `<c r="${r}" s="${styleOf(c.blank)}"/>`;
  };

  const sheetXml = (sh: WSheet): string => {
    const cells = new Map<number, Map<number, WCell>>();
    const put = (row: number, col: number, c: WCell): void => {
      if (!cells.has(row)) cells.set(row, new Map());
      (cells.get(row) as Map<number, WCell>).set(col, c);
    };
    (sh.grid ?? []).forEach((r, i) => r.forEach((c, j) => put(i + 1, j + 1, c)));
    for (const [k, c] of Object.entries(sh.at ?? {})) {
      const p = parseRef(k);
      put(p.row, p.col, c);
    }
    let minR = Infinity, maxR = 0, maxC = 0;
    let body = "";
    for (const row of [...cells.keys()].sort((a, b) => a - b)) {
      const parts: string[] = [];
      for (const col of [...(cells.get(row) as Map<number, WCell>).keys()].sort((a, b) => a - b)) {
        const x = cellXml(ref(row, col), (cells.get(row) as Map<number, WCell>).get(col));
        if (x !== null) {
          parts.push(x);
          minR = Math.min(minR, row);
          maxR = Math.max(maxR, row);
          maxC = Math.max(maxC, col);
        }
      }
      if (parts.length > 0) body += `<row r="${row}">${parts.join("")}</row>`;
    }
    const dim = sh.dimension === false ? "" : `<dimension ref="${typeof sh.dimension === "string" ? sh.dimension : maxR === 0 ? "A1" : `A1:${ref(maxR, maxC)}`}"/>`;
    const merges = sh.merges?.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${dim}<sheetData>${body}</sheetData>${merges}</worksheet>`;
  };

  const sheetParts = book.sheets.map(sheetXml); // first: styles and strings fill up while these are built
  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<workbookPr${date1904 ? ' date1904="1"' : ""}/><sheets>` +
    book.sheets
      .map((s, i) => `<sheet name="${attr(s.name)}" sheetId="${i + 1}"${s.hidden === true ? ' state="hidden"' : s.hidden === "veryHidden" ? ' state="veryHidden"' : ""} r:id="rId${i + 1}"/>`)
      .join("") +
    `</sheets></workbook>`;
  const target = (i: number): string => (book.absoluteTargets ? `/xl/worksheets/sheet${i + 1}.xml` : `worksheets/sheet${i + 1}.xml`);
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    book.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target(i)}"/>`).join("") +
    `<Relationship Id="rId${book.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId${book.sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const stylesXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="${customFormats.length}">${customFormats.map((f, i) => `<numFmt numFmtId="${164 + i}" formatCode="${attr(f)}"/>`).join("")}</numFmts>` +
    `<fonts count="1"><font><sz val="11"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="${xfs.length}">${xfs.map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"${id ? ' applyNumberFormat="1"' : ""}/>`).join("")}</cellXfs>` +
    `</styleSheet>`;
  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${stringRefs}" uniqueCount="${strings.length}">${strings.join("")}</sst>`;
  const types =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const method = book.deflate === false ? 0 : 8;
  const all: [string, string][] = [
    ["[Content_Types].xml", types],
    ["_rels/.rels", rootRels],
    ["xl/workbook.xml", workbookXml],
    ["xl/_rels/workbook.xml.rels", rels],
    ["xl/styles.xml", stylesXml],
    ["xl/sharedStrings.xml", sstXml],
    ...sheetParts.map((x, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, x]),
  ];
  const omit = new Set(book.omit ?? []);
  return zip(all.filter(([n]) => !omit.has(n)).map(([name, data]) => ({ name, data, method, dataDescriptor: book.dataDescriptor === true })));
}
