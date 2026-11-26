// The .xlsx reader (card P4-01): every cell exactly as stored.
//
// Workbooks come from two places: test/helpers/xlsx-write.ts, and one that is
// assembled byte by byte in this file in the form Google Sheets writes, so the
// reader is not only tested against its own author's idea of the format.
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { wallClock } from "../src/lib/dates";
import { isDateFormat, readWorkbook, serialToDate, XlsxError, type SheetCell } from "../src/export/xlsx";
import { buildWorkbook, zip, type WBook, type WCell, type WSheet } from "./helpers/xlsx-write";

const iso = (c: unknown): string => (c instanceof Date ? c.toISOString() : `not a date: ${String(c)}`);
const sheetOf = (grid: WCell[][], more: Partial<WSheet> = {}, book: Partial<WBook> = {}) =>
  readWorkbook(buildWorkbook({ ...book, sheets: [{ name: "T", grid, ...more }] })).sheets[0]!;
const cellsOf = (grid: WCell[][], more: Partial<WSheet> = {}, book: Partial<WBook> = {}): SheetCell[][] => sheetOf(grid, more, book).cells;
/** One cell: put it at A1 and read it back. */
const one = (c: WCell, book: Partial<WBook> = {}): SheetCell => cellsOf([[c]], {}, book)[0]![0]!;
const wall = (d: Date) => {
  const w = wallClock(d);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}:${String(w.second).padStart(2, "0")}`;
};

describe("blank is not zero (ADR-0004)", () => {
  it("tells a blank, a 0, the text '0', an empty string and a missing row apart", () => {
    const cells = cellsOf([
      ["title"],
      ["a", "b", "c", "d", "e", "f"],
      [0, "0", { inline: "" }, undefined, { blank: 0 }, 1],
      [], // no <row> at all
      ["", undefined, undefined, undefined, undefined, "last"],
    ]);
    expect(cells[2]).toEqual([0, "0", "", "", "", 1]);
    expect(cells[2]![0]).not.toBe("");
    expect(cells[2]![1]).toBe("0");
    expect(cells[3]).toEqual(["", "", "", "", "", ""]); // the missing row: all blank, not 0
    expect(cells[4]).toEqual(["", "", "", "", "", "last"]);
    expect(cells).toHaveLength(5);
  });

  it("a missing cell is '' (not 0, not null, not 'null')", () => {
    const cells = cellsOf([["x", undefined, "z"]]);
    expect(cells[0]![1]).toBe("");
    expect(typeof cells[0]![1]).toBe("string");
  });

  it("keeps every digit of a number: 0.1+0.2 stays as stored, no rounding", () => {
    expect(one(0.1 + 0.2)).toBe(0.30000000000000004);
    expect(one(1234567890123.4567)).toBe(1234567890123.4567);
    expect(one(-0.005)).toBe(-0.005);
    expect(one(1e21)).toBe(1e21);
    expect(one(5e-324)).toBe(5e-324);
  });
});

describe("dates", () => {
  // Serials, worked by hand: 2026-01-01 is 46023 (2025-01-01 is 45658, plus 365);
  // 2026-03-08 is 46023 + 31 + 28 + 7 = 46089; 2026-11-01 is 46023 + 304 = 46327.
  const MAR8 = 46089;
  const NOV1 = 46327;
  const min = (n: number) => n / 1440;
  const at = (serial: number, fmt: number | string = 14, book: Partial<WBook> = {}) => iso(one({ serial, fmt }, book));

  it("spring forward (2026-03-08, 02:00 -> 03:00): either side, and the skipped hour", () => {
    expect(at(MAR8)).toBe("2026-03-08T05:00:00.000Z"); // midnight, still EST (UTC-5)
    expect(at(MAR8 + min(90), 22)).toBe("2026-03-08T06:30:00.000Z"); // 01:30 EST
    expect(at(MAR8 + min(180), 22)).toBe("2026-03-08T07:00:00.000Z"); // 03:00 EDT, one hour after 01:59:59
    expect(at(MAR8 + 1)).toBe("2026-03-09T04:00:00.000Z"); // next midnight is EDT (UTC-4)
    // 02:30 does not exist on that night. It is read with the offset from before
    // the jump (EST), so it is 07:30Z = 03:30 EDT, the way ops/src/lib/dates.ts
    // and a V8 local Date resolve it.
    expect(at(MAR8 + min(150), 22)).toBe("2026-03-08T07:30:00.000Z");
  });

  it("fall back (2026-11-01, 02:00 -> 01:00): either side, and the repeated hour takes its first occurrence", () => {
    expect(at(NOV1)).toBe("2026-11-01T04:00:00.000Z"); // midnight EDT (UTC-4)
    expect(at(NOV1 + min(30), 22)).toBe("2026-11-01T04:30:00.000Z"); // 00:30 EDT
    // 01:30 happens twice (05:30Z as EDT, 06:30Z as EST). A Sheet stores only the
    // wall time, so the cell cannot say which; the first occurrence is chosen,
    // because that is what a V8 local Date and ops/src/lib/dates.ts do.
    expect(at(NOV1 + min(90), 22)).toBe("2026-11-01T05:30:00.000Z");
    expect(at(NOV1 + min(150), 22)).toBe("2026-11-01T07:30:00.000Z"); // 02:30 EST
    expect(at(NOV1 + 1)).toBe("2026-11-02T05:00:00.000Z");
  });

  it("midnight is Toronto midnight, summer and winter", () => {
    expect(iso(one(new Date("2026-07-01T04:00:00.000Z")))).toBe("2026-07-01T04:00:00.000Z");
    expect(iso(one(new Date("2026-01-15T05:00:00.000Z")))).toBe("2026-01-15T05:00:00.000Z");
  });

  it("a time-only cell is dated 1899-12-30 in Toronto, as Apps Script returns it", () => {
    const d = at(0.5, 18);
    const v = one({ serial: 0.5, fmt: 18 }) as Date;
    expect(v).toBeInstanceOf(Date);
    expect(wall(v)).toBe("1899-12-30 12:00:00");
    expect(d).toBe(iso(v));
    expect(wall(one({ serial: 0.75 + 30 / 86400, fmt: "h:mm:ss" }) as Date)).toBe("1899-12-30 18:00:30");
    expect(wall(one({ serial: 0, fmt: 21 }) as Date)).toBe("1899-12-30 00:00:00");
  });

  it("1900 date system: 28 Feb and 1 Mar 1900, and the fake 29 Feb 1900 is refused", () => {
    expect(wall(one({ serial: 59, fmt: 14 }) as Date)).toBe("1900-02-28 00:00:00");
    expect(wall(one({ serial: 61, fmt: 14 }) as Date)).toBe("1900-03-01 00:00:00");
    expect(wall(one({ serial: 1, fmt: 14 }) as Date)).toBe("1900-01-01 00:00:00");
    expect(() => serialToDate(60, false)).toThrow(/29 Feb 1900/);
    expect(() => cellsOf([[{ serial: 60, fmt: 14 }]])).toThrow(/A1/);
  });

  it("date1904 workbook: serial 0 is 1904-01-01 and nothing is skipped", () => {
    expect(at(44627, 14, { date1904: true })).toBe("2026-03-08T05:00:00.000Z"); // 46089 - 1462
    expect(at(1, 14, { date1904: true })).toBe(iso(serialToDate(1, true)));
    expect(wall(serialToDate(1, true))).toBe("1904-01-02 00:00:00");
    expect(wall(serialToDate(0.5, true))).toBe("1899-12-30 12:00:00"); // a time-only cell, as in the 1900 system
    // the same wall time written by the 1904 writer reads back
    const d = new Date("2026-11-21T14:00:00.000Z");
    expect(iso(one(d, { date1904: true }))).toBe(d.toISOString());
    expect(readWorkbook(buildWorkbook({ date1904: true, sheets: [{ name: "x" }] })).date1904).toBe(true);
    expect(readWorkbook(buildWorkbook({ sheets: [{ name: "x" }] })).date1904).toBe(false);
  });

  it("t='d' cells: a wall-clock ISO date, a date alone, and one with an offset", () => {
    expect(iso(one({ isoDate: "2026-03-08T01:30:00" }))).toBe("2026-03-08T06:30:00.000Z");
    expect(iso(one({ isoDate: "2026-07-01" }))).toBe("2026-07-01T04:00:00.000Z");
    expect(iso(one({ isoDate: "2026-07-01T10:00:00.250Z" }))).toBe("2026-07-01T10:00:00.250Z");
    expect(iso(one({ isoDate: "2026-07-01T10:00:00-04:00" }))).toBe("2026-07-01T14:00:00.000Z");
    expect(() => one({ isoDate: "yesterday" })).toThrow(/A1/);
  });

  it("is a date because of the style, not the value: the same number is a number under General", () => {
    expect(one({ serial: 46089.5 })).toBe(46089.5);
    expect(one({ serial: 46089.5, fmt: 0 })).toBe(46089.5);
    expect(one({ serial: 46089.5, fmt: 22 })).toBeInstanceOf(Date);
    expect(one({ serial: 46089.5, fmt: "yyyy-mm-dd hh:mm" })).toBeInstanceOf(Date);
  });

  it("a number whose format only mentions d inside quotes or brackets stays a number", () => {
    for (const fmt of ['0.00 "d"', "0.0\\d", "[Red]0.0", '0 "days"', '"yyyy"', "0.00E+00", "General", "#,##0.00", "0%"]) {
      expect(one({ serial: 46089.5, fmt }), fmt).toBe(46089.5);
    }
  });

  it("built-in format ids 14-22, 27-36, 45-47 and 50-58 are dates; the others are numbers", () => {
    const dates = [14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58];
    for (let id = 0; id <= 58; id++) {
      const v = one({ serial: 46089.5, fmt: id });
      if (dates.includes(id)) expect(v, `numFmtId ${id}`).toBeInstanceOf(Date);
      else expect(v, `numFmtId ${id}`).toBe(46089.5);
    }
  });

  it("a negative serial, or one past year 9999, is refused", () => {
    expect(() => cellsOf([[{ serial: -1, fmt: 14 }]])).toThrow(/A1/);
    expect(() => cellsOf([[{ serial: 3_000_000, fmt: 14 }]])).toThrow(/A1/);
  });

  it("isDateFormat: the rule, case by case", () => {
    const yes = [
      "yyyy-mm-dd", "dd/mm/yyyy;@", "h:mm AM/PM", "[$-409]d-mmm-yy", "[h]:mm", "[mm]:ss", "mm:ss.0", "yyyy\\-mm\\-dd",
      'yyyy"-"mm"-"dd', "[Red]dd/mm", "m/d/yy", "d\\ mmm", "hh:mm:ss.000", '"Due "d', "mmmm yyyy", "ddd", "[Blue][>100]0;yyyy",
      'yyyy"-"mm"-"dd" "hh":"mm":"ss', "[$-F800]dddd, mmmm dd, yyyy", "HH:MM:SS", "[hh]:mm:ss",
    ];
    const no = [
      "General", "0.00", "0.00E+00", "0.0E+0", "#,##0.00", "0%", '0.00 "d"', "0.0\\d", "[Red]0.0", '"yyyy"', "[$$-409]#,##0.00",
      '0.0 "days"', "@", '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', "[Blue]#,##0;[Red]-#,##0", '0.00"s"',
      "[Green]General", '#,##0 "hrs"', "0\\h", "[$€-2] #,##0.00", 'General "d"', "", "0.00_d", "*d0", '"$"#,##0.00', "0.0%;[Red]-0.0%",
    ];
    for (const f of yes) expect(isDateFormat(f), `date: ${f}`).toBe(true);
    for (const f of no) expect(isDateFormat(f), `not a date: ${f}`).toBe(false);
  });

  it("serialToDate rounds to the millisecond, so a stored time-of-day survives the double", () => {
    const d = new Date("2026-06-15T15:34:56.789Z"); // 11:34:56.789 EDT
    const back = one(d) as Date;
    expect(back.getTime()).toBe(d.getTime());
  });
});

describe("text", () => {
  const strings: [string, string][] = [
    ["leading zeros", "00123"],
    ["leading and trailing spaces", "  padded  "],
    ["a newline", "line one\nline two"],
    ["a tab", "a\tb"],
    ["markup", "<b>Tom & Jerry's \"quote\"</b> > 1"],
    ["emoji", "till \u{1F4B5} ok \u{1F600}"],
    ["accents and CJK", "café 日本語"],
    ["a carriage return", "a\r\nb\rc"],
    ["looks like a number", "1234.50"],
    ["looks like a date", "2026-03-08"],
    ["looks like a formula", "=SUM(A1:A2)"],
    ["a literal escape", "_x0041_ and _x005F_x0041_"],
    ["NUL-ish control characters", "a\u0001b\u001Fc"],
    ["null the word", "null"],
    ["undefined the word", "undefined"],
  ];
  for (const [label, s] of strings) {
    it(`shared string: ${label}`, () => {
      expect(one(s)).toBe(s);
    });
    it(`inline string: ${label}`, () => {
      expect(one({ inline: s })).toBe(s);
    });
  }

  it("a string of 40,000 characters", () => {
    const s = "ab\u00E9\u{1F600}xyz\nq".repeat(4000);
    expect(s.length).toBe(40000);
    expect(one(s)).toBe(s);
  });

  it("a rich-text shared string is its runs joined; phonetic text is ignored", () => {
    expect(one({ rich: ["Hello", ", ", " world "] })).toBe("Hello,  world ");
    expect(one({ rich: ["漢字"], phonetic: "kanji" })).toBe("漢字");
    expect(one({ rich: ["a", "b"], phonetic: "zzz" })).toBe("ab");
  });

  it("a formula's string result (t='str') is its text", () => {
    expect(one({ formula: 'A2&"x"', value: " 00123 " })).toBe(" 00123 ");
    expect(cellsOf([[{ formula: '""', value: "" }, "x"]])[0]).toEqual(["", "x"]);
  });

  it("entities and escapes in a hand-written part", () => {
    const wb = readWorkbook(
      handBook({
        sst: `<si><t>a&amp;b&lt;c&gt;d&quot;e&apos;f&#10;g&#xA;h&#x1F600;i</t></si><si><t>x_x000D_y_x0009_z_xD83D__xDE00_</t></si>`,
        sheet1: `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`,
      }),
    );
    expect(wb.sheets[0]!.cells[0]).toEqual([`a&b<c>d"e'f\ng\nh\u{1F600}i`, "x\ry\tz\u{1F600}"]);
  });

  it("an unknown entity is refused, not passed through", () => {
    expect(() => readWorkbook(handBook({ sst: `<si><t>a&nbsp;b</t></si>`, sheet1: `<row r="1"><c r="A1" t="s"><v>0</v></c></row>` }))).toThrow(/entity/i);
  });
});

describe("cell shapes", () => {
  it("booleans", () => {
    expect(cellsOf([[true, false]])[0]).toEqual([true, false]);
    expect(one({ formula: "1>0", value: true })).toBe(true);
  });

  it("each error type, as an error cell and not as text", () => {
    for (const e of ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A"]) expect(one({ error: e }), e).toEqual({ error: e });
    expect(one("#REF!")).toBe("#REF!"); // text that looks like an error stays text
    expect(() => one({ error: "boom" })).toThrow(/A1/);
  });

  it("a formula: its cached value is exported, and formula cells are counted", () => {
    const s = sheetOf([["t"], [{ formula: "SUM(1,2)", value: 3 }, { formula: 'A1&"!"', value: "t!" }]]);
    expect(s.cells[1]).toEqual([3, "t!"]);
    expect(s.formulaCells).toBe(2);
  });

  it("a formula without a cached value is refused: there would be nothing to export", () => {
    expect(() => cellsOf([[{ formula: "A2", value: null }]])).toThrow(/A1.*formula|formula.*A1/);
  });

  it("a formula that returns an error exports the error", () => {
    const s = sheetOf([[{ error: "#DIV/0!" }]]);
    expect(s.cells[0]![0]).toEqual({ error: "#DIV/0!" });
  });

  it("merged cells: the value is in the first cell, the rest are blank", () => {
    const s = sheetOf([["Banner", "ghost", "ghost2"], ["a", "b", "c"]], { merges: ["A1:C1"] });
    expect(s.cells[0]).toEqual(["Banner", "", ""]);
    expect(s.cells[1]).toEqual(["a", "b", "c"]);
    expect(s.mergedRanges).toBe(1);
  });

  it("a merge down a column too", () => {
    const s = sheetOf([["a", "x"], ["junk", "y"], ["junk2", "z"]], { merges: ["A1:A3"] });
    expect(s.cells.map((r) => r[0])).toEqual(["a", "", ""]);
    expect(s.cells.map((r) => r[1])).toEqual(["x", "y", "z"]);
  });

  it("sparse rows and cells are placed by their reference, never by position", () => {
    const s = sheetOf([], { at: { B7: "b7", D3: "d3", A3: 1, C9: true } });
    expect(s.cells).toHaveLength(9);
    expect(s.cells[2]).toEqual([1, "", "", "d3"]);
    expect(s.cells[6]).toEqual(["", "b7", "", ""]);
    expect(s.cells[8]).toEqual(["", "", true, ""]);
    expect(s.cells[0]).toEqual(["", "", "", ""]);
    expect(s.columns).toBe(4);
  });

  it("a sheet with no <dimension> is read the same", () => {
    const grid: WCell[][] = [["t"], ["a", "b"], [1, undefined, 3]];
    expect(sheetOf(grid, { dimension: false }).cells).toEqual(sheetOf(grid).cells);
    expect(sheetOf(grid, { dimension: false }).cells[2]).toEqual([1, "", 3]);
  });

  it("a <dimension> larger than the data does not add blank rows or columns; the data range is what holds a value", () => {
    const s = sheetOf([["t"], ["a", "b"]], { dimension: "A1:Z500" });
    expect(s.cells).toHaveLength(2);
    expect(s.columns).toBe(2);
  });

  it("trailing blank rows and columns are dropped; blank rows in the middle stay", () => {
    const s = sheetOf([["t", "", ""], ["a", { blank: 0 }, { inline: "" }], [], ["x"], [undefined, undefined, undefined, { blank: 14 }], []]);
    expect(s.cells).toEqual([["t"], ["a"], [""], ["x"]]);
    expect(s.columns).toBe(1);
  });

  it("a completely empty tab has no rows and no columns", () => {
    const s = sheetOf([]);
    expect(s.cells).toEqual([]);
    expect(s.columns).toBe(0);
  });

  it("a tab with only the title and header", () => {
    const s = sheetOf([["Title"], ["a", "b", "c"]]);
    expect(s.cells).toEqual([["Title", "", ""], ["a", "b", "c"]]);
  });
});

describe("workbook structure", () => {
  const book = (over: Partial<WBook> = {}): Buffer =>
    buildWorkbook({
      sheets: [
        { name: "first", grid: [["1"]] },
        { name: "second/tab Ünïcøde 日本 & <co>'s", hidden: true, grid: [["2"]] },
        { name: "third", hidden: "veryHidden", grid: [["3"]] },
        { name: "fourth", grid: [["4"]] },
      ],
      ...over,
    });

  it("sheet names, order and hidden state; hidden tabs are read too", () => {
    const wb = readWorkbook(book());
    expect(wb.sheets.map((s) => s.name)).toEqual(["first", "second/tab Ünïcøde 日本 & <co>'s", "third", "fourth"]);
    expect(wb.sheets.map((s) => s.index)).toEqual([1, 2, 3, 4]);
    expect(wb.sheets.map((s) => s.hidden)).toEqual([false, true, true, false]);
    expect(wb.sheets.map((s) => s.state)).toEqual(["visible", "hidden", "veryHidden", "visible"]);
    expect(wb.sheets.map((s) => s.cells[0]![0])).toEqual(["1", "2", "3", "4"]);
  });

  it("stored and deflated entries, with or without data descriptors, relative or absolute targets", () => {
    const want = readWorkbook(book()).sheets.map((s) => [s.name, s.cells]);
    for (const deflate of [true, false])
      for (const dataDescriptor of [true, false])
        for (const absoluteTargets of [true, false]) {
          const got = readWorkbook(book({ deflate, dataDescriptor, absoluteTargets })).sheets.map((s) => [s.name, s.cells]);
          expect(got, JSON.stringify({ deflate, dataDescriptor, absoluteTargets })).toEqual(want);
        }
  });

  it("the sheets come in workbook order even when their parts are stored in another order", () => {
    // sheet1.xml holds the SECOND tab here: the relationships, not the file names, decide
    const wb = readWorkbook(handBook({ swapRels: true, sheet1: `<row r="1"><c r="A1" t="inlineStr"><is><t>from part 1</t></is></c></row>`, sheet2: `<row r="1"><c r="A1" t="inlineStr"><is><t>from part 2</t></is></c></row>` }));
    expect(wb.sheets.map((s) => [s.name, s.cells[0]![0]])).toEqual([["One", "from part 2"], ["Two", "from part 1"]]);
  });

  it("the Excel form: a prefixed namespace on every element, and CRLF between them", () => {
    const parts = excelParts();
    const wb = readWorkbook(zip(parts));
    expect(wb.sheets.map((s) => s.name)).toEqual(["Prefixed"]);
    expect(wb.sheets[0]!.cells).toEqual([["x\ny", 7]]);
  });
});

describe("refusals: a readable message, never a partial result", () => {
  const good = (): Buffer => buildWorkbook({ sheets: [{ name: "a", grid: [["x", 1, 2, 3]] }, { name: "b", grid: [["y"]] }] });
  const centralHeaders = (b: Buffer): number[] => {
    const out: number[] = [];
    for (let i = 0; i + 4 <= b.length; i++) if (b.readUInt32LE(i) === 0x02014b50) out.push(i);
    return out;
  };

  it("not a zip", () => {
    expect(() => readWorkbook(Buffer.from("this is not an excel file"))).toThrow(/not a zip/i);
    expect(() => readWorkbook(Buffer.alloc(0))).toThrow(/not a zip|empty/i);
    expect(() => readWorkbook(Buffer.from("a,b,c\n1,2,3\n"))).toThrow(XlsxError);
  });

  it("a truncated file", () => {
    const b = good();
    expect(() => readWorkbook(b.subarray(0, b.length - 30))).toThrow(/zip|truncated|central directory/i);
    expect(() => readWorkbook(b.subarray(0, Math.floor(b.length / 2)))).toThrow(/zip|truncated|central directory/i);
  });

  it("a damaged entry (bytes changed inside the compressed data)", () => {
    const b = Buffer.from(good());
    const start = 30 + "[Content_Types].xml".length + 5; // inside the first entry's data
    b[start] = (b[start] as number) ^ 0xff;
    expect(() => readWorkbook(b)).toThrow(/corrupt|decompress|CRC/i);
  });

  it("a stored entry whose bytes were changed fails its CRC", () => {
    const b = Buffer.from(buildWorkbook({ deflate: false, sheets: [{ name: "a", grid: [["hello"]] }] }));
    const at = b.indexOf("<sheetData>");
    expect(at).toBeGreaterThan(0);
    b[at + 3] = (b[at + 3] as number) ^ 0x01;
    expect(() => readWorkbook(b)).toThrow(/CRC|corrupt/i);
  });

  it("an encrypted archive", () => {
    const b = Buffer.from(good());
    const c = centralHeaders(b)[0] as number;
    b.writeUInt16LE(b.readUInt16LE(c + 8) | 0x0001, c + 8);
    expect(() => readWorkbook(b)).toThrow(/encrypted/i);
  });

  it("zip64: marker values in the end record, in an entry, or a zip64 locator", () => {
    const a = Buffer.from(good());
    a.writeUInt16LE(0xffff, a.length - 22 + 10);
    expect(() => readWorkbook(a)).toThrow(/zip64/i);

    const b = Buffer.from(good());
    b.writeUInt32LE(0xffffffff, (centralHeaders(b)[0] as number) + 24);
    expect(() => readWorkbook(b)).toThrow(/zip64/i);

    const c = good();
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    const withLocator = Buffer.concat([c.subarray(0, c.length - 22), locator, c.subarray(c.length - 22)]);
    expect(() => readWorkbook(withLocator)).toThrow(/zip64/i);
  });

  it("an unsupported compression method", () => {
    const b = Buffer.from(good());
    const c = centralHeaders(b)[0] as number;
    b.writeUInt16LE(9, c + 10);
    expect(() => readWorkbook(b)).toThrow(/compression method 9/i);
  });

  it("a missing xl/workbook.xml", () => {
    expect(() => readWorkbook(buildWorkbook({ sheets: [{ name: "a" }], omit: ["xl/workbook.xml"] }))).toThrow(/xl\/workbook\.xml/);
  });

  it("a sheet part that is missing, naming the tab", () => {
    expect(() => readWorkbook(buildWorkbook({ sheets: [{ name: "kept" }, { name: "lost tab" }], omit: ["xl/worksheets/sheet2.xml"] }))).toThrow(/lost tab/);
  });

  it("a missing relationships part, shared strings index out of range, mismatched XML", () => {
    expect(() => readWorkbook(buildWorkbook({ sheets: [{ name: "a" }], omit: ["xl/_rels/workbook.xml.rels"] }))).toThrow(/workbook\.xml\.rels/);
    expect(() => readWorkbook(handBook({ sst: `<si><t>only</t></si>`, sheet1: `<row r="1"><c r="A1" t="s"><v>5</v></c></row>` }))).toThrow(/A1.*shared string|shared string.*A1/i);
    expect(() => readWorkbook(handBook({ sst: ``, sheet1: `<row r="1"><c r="A1"><v>1</v></row>` }))).toThrow(/xml|tag/i);
  });

  it("a number that is not a number, and a cell type it does not know", () => {
    expect(() => readWorkbook(handBook({ sst: ``, sheet1: `<row r="1"><c r="A1"><v>12abc</v></c></row>` }))).toThrow(/A1.*number/);
    expect(() => readWorkbook(handBook({ sst: ``, sheet1: `<row r="1"><c r="A1" t="zz"><v>1</v></c></row>` }))).toThrow(/A1.*type/);
    expect(() => readWorkbook(handBook({ sst: ``, sheet1: `<row r="1"><c r="A1"><v>NaN</v></c></row>` }))).toThrow(/A1/);
    expect(() => readWorkbook(handBook({ sst: ``, sheet1: `<row r="1"><c r="A1"><v>Infinity</v></c></row>` }))).toThrow(/A1/);
  });

  it("a cell with no reference, or a duplicate cell", () => {
    expect(() => readWorkbook(handBook({ sst: ``, sheet1: `<row r="1"><c><v>1</v></c></row>` }))).toThrow(/reference/i);
    expect(() => readWorkbook(handBook({ sst: ``, sheet1: `<row r="1"><c r="A1"><v>1</v></c><c r="A1"><v>2</v></c></row>` }))).toThrow(/A1.*twice|duplicate/i);
  });

  it("a chart sheet cannot be exported as a table", () => {
    expect(() => readWorkbook(handBook({ chartsheet: true, sst: ``, sheet1: `` }))).toThrow(/worksheet|chart/i);
  });

  it("error messages never contain a cell's text", () => {
    const secret = "SECRET-PAY-98765";
    let msg = "";
    try {
      readWorkbook(handBook({ sst: ``, sheet1: `<row r="1"><c r="A1"><v>${secret}</v></c></row>` }));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toBe("");
    expect(msg).not.toContain(secret);
  });
});

// ── A workbook assembled byte by byte, in the form Google Sheets writes ──

const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const u32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

interface RawEntry {
  name: string;
  content: string;
  deflate: boolean;
  /** a data descriptor after the data: flag bit 3 and zeros in the local header */
  descriptor: boolean;
  /** bytes of "extra field" in the LOCAL header only (the central directory says 0) */
  localExtra?: number;
}

/** A zip written with explicit bytes: local headers, data, descriptors, central directory, end record with a comment. */
function rawZip(entries: RawEntry[]): Buffer {
  const out: number[] = [];
  const central: number[] = [];
  for (const e of entries) {
    const raw = Buffer.from(e.content, "utf8");
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const name = [...Buffer.from(e.name, "utf8")];
    const crc = crc32(raw);
    const flag = 0x0800 | (e.descriptor ? 0x0008 : 0);
    const offset = out.length;
    const extra = e.localExtra ?? 0;
    out.push(...u32(0x04034b50), ...u16(20), ...u16(flag), ...u16(e.deflate ? 8 : 0), ...u16(0), ...u16(0x5821));
    out.push(...u32(e.descriptor ? 0 : crc), ...u32(e.descriptor ? 0 : body.length), ...u32(e.descriptor ? 0 : raw.length));
    out.push(...u16(name.length), ...u16(extra), ...name, ...new Array<number>(extra).fill(0x55));
    out.push(...body);
    if (e.descriptor) out.push(...u32(0x08074b50), ...u32(crc), ...u32(body.length), ...u32(raw.length));
    central.push(...u32(0x02014b50), ...u16(0x0314), ...u16(20), ...u16(flag), ...u16(e.deflate ? 8 : 0), ...u16(0), ...u16(0x5821));
    central.push(...u32(crc), ...u32(body.length), ...u32(raw.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name);
  }
  const cdOffset = out.length;
  const comment = [...Buffer.from("made by hand")];
  out.push(...central);
  out.push(...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(central.length), ...u32(cdOffset), ...u16(comment.length), ...comment);
  return Buffer.from(out);
}

const NS = `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`;
const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

interface HandOptions {
  sst?: string;
  sheet1: string;
  sheet2?: string;
  swapRels?: boolean;
  chartsheet?: boolean;
}
/** A small two-tab workbook with caller-supplied shared strings and sheet rows, as Google writes the parts around them. */
function handBook(o: HandOptions): Buffer {
  const sheet = (rows: string): string =>
    `${XML}<worksheet ${NS} xmlns:r="${REL}"><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr customHeight="1" defaultColWidth="12.63" defaultRowHeight="15.75"/><sheetData>${rows}</sheetData></worksheet>`;
  const type = o.chartsheet ? "chartsheet" : "worksheet";
  const rels = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="styles.xml" Type="${REL}/styles"/><Relationship Id="rId2" Target="${o.swapRels ? "worksheets/sheet2.xml" : "worksheets/sheet1.xml"}" Type="${REL}/${type}"/><Relationship Id="rId3" Target="sharedStrings.xml" Type="${REL}/sharedStrings"/>${o.sheet2 !== undefined ? `<Relationship Id="rId4" Target="${o.swapRels ? "worksheets/sheet1.xml" : "worksheets/sheet2.xml"}" Type="${REL}/worksheet"/>` : ""}</Relationships>`;
  const sheets = `<sheet state="visible" name="One" sheetId="1" r:id="rId2"/>${o.sheet2 !== undefined ? `<sheet state="visible" name="Two" sheetId="2" r:id="rId4"/>` : ""}`;
  const entries: RawEntry[] = [
    { name: "[Content_Types].xml", content: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default ContentType="application/xml" Extension="xml"/></Types>`, deflate: true, descriptor: true },
    { name: "_rels/.rels", content: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="xl/workbook.xml" Type="${REL}/officeDocument"/></Relationships>`, deflate: true, descriptor: true },
    { name: "xl/", content: "", deflate: false, descriptor: false },
    { name: "xl/workbook.xml", content: `${XML}<workbook ${NS} xmlns:r="${REL}"><workbookPr/><sheets>${sheets}</sheets><definedNames/><calcPr/></workbook>`, deflate: true, descriptor: true, localExtra: 8 },
    { name: "xl/_rels/workbook.xml.rels", content: rels, deflate: true, descriptor: true },
    { name: "xl/styles.xml", content: `${XML}<styleSheet ${NS}><cellXfs count="1"><xf borderId="0" fillId="0" fontId="0" numFmtId="0" xfId="0"/></cellXfs></styleSheet>`, deflate: true, descriptor: true },
    { name: "xl/sharedStrings.xml", content: `${XML}<sst ${NS} count="2" uniqueCount="2">${o.sst ?? ""}</sst>`, deflate: false, descriptor: false },
    { name: "xl/worksheets/sheet1.xml", content: sheet(o.sheet1), deflate: true, descriptor: true },
  ];
  if (o.sheet2 !== undefined) entries.push({ name: "xl/worksheets/sheet2.xml", content: sheet(o.sheet2), deflate: true, descriptor: true });
  return rawZip(entries);
}

describe("a workbook in the exact form Google Sheets writes", () => {
  // Google writes no <dimension>, quotes the separators in its date formats,
  // orders attributes its own way, puts Target before Type in the relationships,
  // writes sizes after the data (flag bit 3) and leaves empty styled cells.
  const styles =
    `${XML}<styleSheet ${NS}><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy&quot;-&quot;mm&quot;-&quot;dd&quot; &quot;hh&quot;:&quot;mm&quot;:&quot;ss"/><numFmt numFmtId="165" formatCode="&quot;$&quot;#,##0.00"/></numFmts>` +
    `<fonts count="1"><font><sz val="10.0"/><color rgb="FF000000"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="lightGray"/></fill></fills><borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf borderId="0" fillId="0" fontId="0" numFmtId="0" xfId="0" applyAlignment="1"><alignment/></xf></cellStyleXfs>` +
    `<cellXfs count="4">` +
    `<xf borderId="0" fillId="0" fontId="0" numFmtId="0" xfId="0" applyAlignment="1"><alignment readingOrder="0" shrinkToFit="0" vertical="bottom" wrapText="0"/></xf>` +
    `<xf borderId="0" fillId="0" fontId="0" numFmtId="164" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment readingOrder="0"/></xf>` +
    `<xf borderId="0" fillId="0" fontId="0" numFmtId="165" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment readingOrder="0"/></xf>` +
    `<xf borderId="0" fillId="0" fontId="0" numFmtId="14" xfId="0" applyAlignment="1" applyNumberFormat="1"><alignment readingOrder="0"/></xf>` +
    `</cellXfs><cellStyles count="1"><cellStyle xfId="0" name="Normal" builtinId="0"/></cellStyles><dxfs count="0"/></styleSheet>`;

  const sst =
    `${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="9" uniqueCount="8">` +
    `<si><t>sales log</t></si><si><t>id</t></si><si><t>amount</t></si><si><t>when</t></si><si><t>ok</t></si>` +
    `<si><t>00123</t></si><si><t>x</t></si><si><t xml:space="preserve"> two  spaces </t></si></sst>`;

  const sheet1 =
    `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetPr><outlinePr summaryBelow="0" summaryRight="0"/></sheetPr><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr customHeight="1" defaultColWidth="12.63" defaultRowHeight="15.75"/>` +
    `<cols><col customWidth="1" min="1" max="1" width="14.0"/></cols><sheetData>` +
    `<row r="1"><c r="A1" s="0" t="s"><v>0</v></c></row>` +
    `<row r="2"><c r="A2" s="0" t="s"><v>1</v></c><c r="B2" s="0" t="s"><v>2</v></c><c r="C2" s="0" t="s"><v>3</v></c><c r="D2" s="0" t="s"><v>4</v></c></row>` +
    `<row r="3"><c r="A3" s="0" t="s"><v>5</v></c><c r="B3" s="2"><v>12.5</v></c><c r="C3" s="1"><v>46327.0625</v></c><c r="D3" s="0" t="b"><v>1</v></c></row>` +
    `<row r="4"><c r="A4" s="0" t="s"><v>6</v></c><c r="B4" s="2"/><c r="D4" s="0"><f>SUM(B3:B3)-5.5</f><v>7</v></c></row>` +
    `<row r="6"><c r="A6" s="0" t="s"><v>7</v></c><c r="C6" s="3"><v>46089</v></c><c r="E6" s="0" t="s"><v>6</v></c></row>` +
    `</sheetData><drawing r:id="rId1"/></worksheet>`;
  const sheet2 = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" s="0" t="s"><v>0</v></c></row><row r="2"><c r="A2" s="0" t="s"><v>1</v></c></row></sheetData></worksheet>`;
  const workbook =
    `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><sheets>` +
    `<sheet state="visible" name="sales" sheetId="1" r:id="rId4"/><sheet state="hidden" name="old/tab" sheetId="2" r:id="rId5"/></sheets><definedNames/><calcPr/></workbook>`;
  const rels =
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Target="styles.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"/>` +
    `<Relationship Id="rId2" Target="sharedStrings.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings"/>` +
    `<Relationship Id="rId4" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>` +
    `<Relationship Id="rId5" Target="worksheets/sheet2.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>`;

  const file = rawZip([
    { name: "[Content_Types].xml", content: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default ContentType="application/xml" Extension="xml"/></Types>`, deflate: false, descriptor: false },
    { name: "_rels/.rels", content: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="xl/workbook.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/></Relationships>`, deflate: true, descriptor: true },
    { name: "xl/", content: "", deflate: false, descriptor: false },
    { name: "xl/workbook.xml", content: workbook, deflate: true, descriptor: true },
    { name: "xl/_rels/workbook.xml.rels", content: rels, deflate: true, descriptor: true },
    { name: "xl/styles.xml", content: styles, deflate: true, descriptor: true },
    { name: "xl/sharedStrings.xml", content: sst, deflate: true, descriptor: true, localExtra: 12 },
    { name: "xl/worksheets/", content: "", deflate: false, descriptor: false },
    { name: "xl/worksheets/sheet1.xml", content: sheet1, deflate: true, descriptor: true },
    { name: "xl/worksheets/sheet2.xml", content: sheet2, deflate: true, descriptor: true },
  ]);

  it("is really laid out the way the comment says (flag bit 3, zeros in the local header)", () => {
    expect(file.readUInt16LE(6) & 0x0008).toBe(0); // the first entry is stored, no descriptor
    const second = file.indexOf(Buffer.from(u32(0x04034b50)), 4);
    expect(file.readUInt16LE(second + 6) & 0x0008).toBe(0x0008);
    expect(file.readUInt32LE(second + 18)).toBe(0); // compressed size is not in the local header
    expect(file.includes(Buffer.from(u32(0x08074b50)))).toBe(true);
  });

  it("reads back to the cells it holds", () => {
    const wb = readWorkbook(file);
    expect(wb.date1904).toBe(false);
    expect(wb.sheets.map((s) => [s.index, s.name, s.hidden])).toEqual([[1, "sales", false], [2, "old/tab", true]]);
    const s = wb.sheets[0]!;
    expect(s.columns).toBe(5);
    expect(s.cells).toHaveLength(6);
    expect(s.cells[0]).toEqual(["sales log", "", "", "", ""]);
    expect(s.cells[1]).toEqual(["id", "amount", "when", "ok", ""]);
    // 01:30 on the repeated hour of 2026-11-01: the first occurrence, 05:30Z
    expect(s.cells[2]).toEqual(["00123", 12.5, new Date("2026-11-01T05:30:00.000Z"), true, ""]);
    expect(s.cells[3]).toEqual(["x", "", "", 7, ""]);
    expect(s.cells[4]).toEqual(["", "", "", "", ""]); // row 5 was never written
    expect(s.cells[5]).toEqual([" two  spaces ", "", new Date("2026-03-08T05:00:00.000Z"), "", "x"]);
    expect(s.formulaCells).toBe(1);
    expect(wb.sheets[1]!.cells).toEqual([["sales log"], ["id"]]);
  });
});

// ── What Excel writes if the owner re-saves the file ──

function excelParts(): { name: string; data: string; method: 0 | 8 }[] {
  const crlf = "\r\n";
  return [
    { name: "[Content_Types].xml", method: 8, data: `${XML}${crlf}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>` },
    { name: "_rels/.rels", method: 8, data: `${XML}${crlf}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    {
      name: "xl/workbook.xml",
      method: 8,
      data: `${XML}${crlf}<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><x:fileVersion appName="xl"/>${crlf}<x:workbookPr defaultThemeVersion="124226"/>${crlf}<x:sheets>${crlf}<x:sheet name="Prefixed" sheetId="1" r:id="rId1"/>${crlf}</x:sheets></x:workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      method: 8,
      data: `${XML}${crlf}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/sharedStrings" Target="/xl/sharedStrings.xml"/></Relationships>`,
    },
    { name: "xl/sharedStrings.xml", method: 8, data: `${XML}${crlf}<x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">${crlf}<x:si>${crlf}<x:t>x\ny</x:t>${crlf}</x:si>${crlf}</x:sst>` },
    {
      name: "xl/worksheets/sheet1.xml",
      method: 8,
      data: `${XML}${crlf}<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${crlf}<x:dimension ref="A1:B1"/>${crlf}<x:sheetData>${crlf}<x:row r="1" spans="1:2">${crlf}<x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1"><x:v>7</x:v></x:c>${crlf}</x:row>${crlf}</x:sheetData></x:worksheet>`,
    },
  ];
}
