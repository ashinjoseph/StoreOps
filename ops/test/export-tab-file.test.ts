// The one-file-per-tab format (card P4-01): what is written reads back as the
// same SheetTab, and anything that is not exactly this format is refused.
import { describe, expect, it } from "vitest";
import { readTabFile, writeTabFile, FORMAT, type TabInput } from "../src/export/tab-file";
import type { SheetTab } from "../src/import/sheet-to-db";

const input = (over: Partial<TabInput> = {}): TabInput => ({
  tab: "sales",
  index: 4,
  hidden: false,
  title: ["Sales log", ""],
  header: ["id", "amount"],
  rows: [["a", 1]],
  formulaCells: 0,
  ...over,
});
const text = (over: Partial<TabInput> = {}): string => writeTabFile(input(over));
/** The file as an object, to break one thing at a time. */
const parsed = (over: Partial<TabInput> = {}): Record<string, unknown> => JSON.parse(text(over)) as Record<string, unknown>;
const bad = (o: unknown): string => JSON.stringify(o);

describe("writing and reading", () => {
  it("round-trips every kind of cell, as a SheetTab with real Dates", () => {
    const d = new Date("2026-11-21T14:00:00.000Z");
    const t = input({
      title: ["Title", "", ""],
      header: ["a", "b", "c"],
      rows: [
        [0, "0", ""],
        [-1.5e-7, 1e21, 0.1 + 0.2],
        [true, false, "00123"],
        [d, new Date("1899-12-30T17:17:32.000Z"), { error: "#REF!" }],
        ["  padded\n", "<&>\u{1F600}", "2026-11-21T14:00:00.000Z"],
        ["1234.50", "true", "null"],
      ],
      formulaCells: 3,
    });
    const back = readTabFile(writeTabFile(t));
    expect(back.tab).toBe("sales");
    expect(back.header).toEqual(["a", "b", "c"]);
    expect(back.title).toEqual(["Title", "", ""]);
    expect(back.index).toBe(4);
    expect(back.hidden).toBe(false);
    expect(back.rows[0]).toEqual([0, "0", ""]);
    expect(back.rows[0]![0]).not.toBe("");
    expect(back.rows[1]).toEqual([-1.5e-7, 1e21, 0.30000000000000004]);
    expect(back.rows[2]).toEqual([true, false, "00123"]);
    expect(back.rows[3]![0]).toBeInstanceOf(Date);
    expect((back.rows[3]![0] as Date).getTime()).toBe(d.getTime());
    expect(back.rows[3]![1]).toEqual(new Date("1899-12-30T17:17:32.000Z"));
    expect(back.rows[3]![2]).toBe("#REF!"); // as Apps Script's getValues gives an error cell
    expect(back.rows[4]).toEqual(["  padded\n", "<&>\u{1F600}", "2026-11-21T14:00:00.000Z"]); // a string that looks like a date stays a string
    expect(back.rows[5]).toEqual(["1234.50", "true", "null"]);
    expect(back.counts).toEqual({ rows: 6, columns: 3, formulaCells: 3, dates: 2, errors: 1 });
    // what the importer takes
    const asTab: SheetTab = back;
    expect(asTab.tab).toBe("sales");
  });

  it("is JSON, with a version, and dates and errors are tagged objects", () => {
    const raw = text({ rows: [[new Date("2026-03-08T07:30:00.000Z"), { error: "#N/A" }]], header: ["a", "b"], title: ["", ""] });
    const o = JSON.parse(raw) as { format: string; rows: unknown[][] };
    expect(o.format).toBe(FORMAT);
    expect(FORMAT).toBe("storeops-sheet-export/1");
    expect(o.rows[0]).toEqual([{ $date: "2026-03-08T07:30:00.000Z" }, { $error: "#N/A" }]);
  });

  it("a tab with no rows, a hidden tab, a tab name with a slash and unicode", () => {
    const back = readTabFile(text({ tab: "a/b Ünï 日本", hidden: true, rows: [] }));
    expect(back.tab).toBe("a/b Ünï 日本");
    expect(back.hidden).toBe(true);
    expect(back.rows).toEqual([]);
    expect(back.counts.rows).toBe(0);
  });

  it("a string of 40,000 characters, and lone surrogates, survive", () => {
    const long = "abé\u{1F600}\n".repeat(10000).slice(0, 40000);
    expect(readTabFile(text({ rows: [[long, "\uD800x"]] })).rows[0]).toEqual([long, "\uD800x"]);
  });

  it("refuses to write a non-finite number, an invalid date, or a ragged row", () => {
    for (const n of [NaN, Infinity, -Infinity]) expect(() => text({ rows: [["a", n]] })).toThrow(/finite/i);
    expect(() => text({ rows: [["a", new Date(NaN)]] })).toThrow(/date/i);
    expect(() => text({ rows: [["a"]] })).toThrow(/column/i);
    expect(() => text({ header: ["a", "b", "c"] })).toThrow(/column/i);
    expect(() => text({ rows: [["a", undefined as unknown as string]] })).toThrow(/cell/i);
    expect(() => text({ rows: [["a", null as unknown as string]] })).toThrow(/cell/i);
    expect(() => text({ rows: [["a", {} as unknown as string]] })).toThrow(/cell/i);
    expect(() => text({ index: 0 })).toThrow(/index/i);
  });

  it("negative zero is written as 0, and is read back as 0", () => {
    expect(Object.is(readTabFile(text({ rows: [["a", -0]] })).rows[0]![1], 0)).toBe(true);
  });
});

describe("the validator is strict", () => {
  const ok = (o: unknown) => readTabFile(bad(o));

  it("accepts what it writes", () => {
    expect(() => ok(parsed())).not.toThrow();
  });

  it("not JSON, not an object", () => {
    expect(() => readTabFile("{nope")).toThrow(/JSON/);
    expect(() => readTabFile("[]")).toThrow(/object/i);
    expect(() => readTabFile("null")).toThrow(/object/i);
    expect(() => readTabFile("")).toThrow(/JSON/);
  });

  it("an unknown or missing format version", () => {
    expect(() => ok({ ...parsed(), format: "storeops-sheet-export/2" })).toThrow(/format/);
    expect(() => ok({ ...parsed(), format: undefined })).toThrow(/format/);
    expect(() => ok({ ...parsed(), format: 1 })).toThrow(/format/);
  });

  it("a ragged row", () => {
    const o = parsed({ rows: [["a", 1], ["b", 2]] }) as { rows: unknown[][] };
    o.rows[1] = ["b"];
    expect(() => ok(o)).toThrow(/row 2.*(column|cells)|ragged/i);
    o.rows[1] = ["b", 2, 3];
    expect(() => ok(o)).toThrow(/row 2/i);
  });

  it("a header or title of another width than the rows", () => {
    expect(() => ok({ ...parsed(), header: ["a"] })).toThrow(/title has 2 columns, expected 1/);
    expect(() => ok({ ...parsed(), title: ["a", "b", "c"] })).toThrow(/title/);
  });

  it("an unknown cell shape", () => {
    const withCell = (cell: unknown) => ok({ ...parsed(), rows: [["a", cell]] });
    for (const cell of [null, [], [1], { x: 1 }, { $date: "2026-01-01T00:00:00.000Z", extra: 1 }, { $error: "#REF!", extra: 1 }, { $date: 5 }, { $error: 5 }, { $date: "2026-01-01" }, { $date: "2026-01-01T00:00:00Z" }, { $date: "not a date" }, { $date: "2026-02-30T00:00:00.000Z" }, { $error: "boom" }, { $error: "" }]) {
      expect(() => withCell(cell), JSON.stringify(cell)).toThrow(/cell|row 1/i);
    }
  });

  it("a number cell cannot be non-finite (JSON has no spelling for it, and 1e999 is one)", () => {
    expect(() => readTabFile(text().replace(",1]", ",1e999]"))).toThrow(/finite|number/i);
  });

  it("keys that are not part of the format, missing keys, wrong types", () => {
    expect(() => ok({ ...parsed(), surprise: 1 })).toThrow(/surprise|unknown/i);
    for (const k of ["tab", "index", "hidden", "title", "header", "rows", "counts"]) {
      const o = parsed();
      delete o[k];
      expect(() => ok(o), k).toThrow(new RegExp(k));
    }
    expect(() => ok({ ...parsed(), tab: "" })).toThrow(/tab/);
    expect(() => ok({ ...parsed(), tab: 7 })).toThrow(/tab/);
    expect(() => ok({ ...parsed(), index: 1.5 })).toThrow(/index/);
    expect(() => ok({ ...parsed(), hidden: "no" })).toThrow(/hidden/);
    expect(() => ok({ ...parsed(), rows: {} })).toThrow(/rows/);
    expect(() => ok({ ...parsed(), rows: [7] })).toThrow(/row 1/);
  });

  it("counts that do not agree with the cells are refused: the file was edited or damaged", () => {
    const c = (parsed() as { counts: Record<string, number> }).counts;
    for (const k of ["rows", "columns", "formulaCells", "dates", "errors"]) {
      expect(() => ok({ ...parsed(), counts: { ...c, [k]: 99 } }), k).toThrow(/count/i);
      const missing = { ...c };
      delete missing[k];
      expect(() => ok({ ...parsed(), counts: missing }), k).toThrow(new RegExp(k));
    }
    expect(() => ok({ ...parsed(), counts: { ...c, extra: 1 } })).toThrow(/extra|unknown/i);
  });

  it("a duplicate key is not hidden by JSON.parse (last wins) - the file is one object per line the tool wrote, so a hand edit shows in the hash instead", () => {
    // documented limit: JSON.parse keeps the last of two equal keys; the manifest's SHA-256 is what catches a hand edit
    const raw = text().replace('"hidden": false', '"hidden": false, "hidden": true');
    expect(readTabFile(raw).hidden).toBe(true);
  });
});
