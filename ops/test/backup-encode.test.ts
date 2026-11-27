// The nightly copy's file format (src/backup/encode.ts), as a table, in both directions: what the database
// gives, what is written in a file, and what goes back to the database. Pure: no database.
import { describe, expect, it } from "vitest";
import { decodeLine, decodeValue, encodeLine, encodeValue, EncodeError, joinLines, kindOfType, quoteIdent, selectExpression, splitLines, type ColumnKind, type FileColumn, type Raw } from "../src/backup/encode";

interface Case {
  name: string;
  kind: ColumnKind;
  raw: Raw;
  /** What is written in the file for this value, as JSON text. */
  written: string;
  /** What goes back to the database. */
  param: string | boolean | null;
}

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

const CASES: Case[] = [
  { name: "money with trailing zeros stays a string", kind: "numeric", raw: "12.50", written: '"12.50"', param: "12.50" },
  { name: "zero money with its zeros", kind: "numeric", raw: "0.00", written: '"0.00"', param: "0.00" },
  { name: "a 4-decimal rate", kind: "numeric", raw: "17.6000", written: '"17.6000"', param: "17.6000" },
  { name: "a negative", kind: "numeric", raw: "-3.25", written: '"-3.25"', param: "-3.25" },
  { name: "a very large numeric keeps every digit", kind: "numeric", raw: "123456789012345678901234567890.123456", written: '"123456789012345678901234567890.123456"', param: "123456789012345678901234567890.123456" },
  { name: "NULL is null", kind: "text", raw: null, written: "null", param: null },
  { name: "an empty text is an empty string", kind: "text", raw: "", written: '""', param: "" },
  { name: "the text null is the string null, not NULL", kind: "text", raw: "null", written: '"null"', param: "null" },
  { name: "NULL money is null (blank is not zero)", kind: "numeric", raw: null, written: "null", param: null },
  { name: "newlines, quotes, backslashes and tabs", kind: "text", raw: 'line one\nline "two"\r\n\\ back\\slash\ttab', written: JSON.stringify('line one\nline "two"\r\n\\ back\\slash\ttab'), param: 'line one\nline "two"\r\n\\ back\\slash\ttab' },
  { name: "U+2028 and U+2029 are written escaped", kind: "text", raw: `a${LS}b${PS}c`, written: '"a\\u2028b\\u2029c"', param: `a${LS}b${PS}c` },
  { name: "the six characters of a NUL escape stay six characters", kind: "text", raw: "x\\u0000y", written: '"x\\\\u0000y"', param: "x\\u0000y" },
  { name: "an instant at midnight Toronto, the spring clock change day (EST)", kind: "instant", raw: "2026-03-08T05:00:00.000000Z", written: '"2026-03-08T05:00:00.000000Z"', param: "2026-03-08T05:00:00.000000Z" },
  { name: "an instant at midnight Toronto, the autumn clock change day (EDT)", kind: "instant", raw: "2026-11-01T04:00:00.000000Z", written: '"2026-11-01T04:00:00.000000Z"', param: "2026-11-01T04:00:00.000000Z" },
  { name: "an instant keeps its microseconds", kind: "instant", raw: "2026-03-08T07:30:15.123457Z", written: '"2026-03-08T07:30:15.123457Z"', param: "2026-03-08T07:30:15.123457Z" },
  { name: "a date", kind: "date", raw: "2026-03-08", written: '"2026-03-08"', param: "2026-03-08" },
  { name: "bytea as hex with a marker", kind: "bytea", raw: "00ff0a", written: '{"$hex":"00ff0a"}', param: "\\x00ff0a" },
  { name: "empty bytea", kind: "bytea", raw: "", written: '{"$hex":""}', param: "\\x" },
  { name: "a JSON column with nested objects", kind: "json", raw: '{"a": {"b": [1, 2, {"c": null}]}, "d": "x"}', written: '{"a":{"b":[1,2,{"c":null}]},"d":"x"}', param: '{"a":{"b":[1,2,{"c":null}]},"d":"x"}' },
  { name: "a JSON null is wrapped so it is not SQL NULL", kind: "json", raw: "null", written: '{"$json":null}', param: "null" },
  { name: "a JSON object that has the key $json is wrapped too", kind: "json", raw: '{"$json": 1}', written: '{"$json":{"$json":1}}', param: '{"$json":1}' },
  { name: "a boolean true", kind: "boolean", raw: true, written: "true", param: true },
  { name: "a boolean false", kind: "boolean", raw: false, written: "false", param: false },
  { name: "a bigint identity past 2^53 stays exact", kind: "bigint", raw: "9007199254740993", written: '"9007199254740993"', param: "9007199254740993" },
  { name: "the largest bigint", kind: "bigint", raw: "9223372036854775807", written: '"9223372036854775807"', param: "9223372036854775807" },
  { name: "a negative bigint", kind: "bigint", raw: "-9223372036854775808", written: '"-9223372036854775808"', param: "-9223372036854775808" },
  { name: "an integer is a JSON number", kind: "integer", raw: "42", written: "42", param: "42" },
  { name: "a negative integer", kind: "integer", raw: "-7", written: "-7", param: "-7" },
  { name: "any other type is its text", kind: "other", raw: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", written: '"3f2504e0-4f89-11d3-9a0c-0305e82c3301"', param: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" },
];

describe("encodeValue / decodeValue, as a table", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const enc = encodeValue(c.kind, c.raw);
      // What is written is the JSON text expected (key order and all), once the line escapes are applied.
      expect(JSON.stringify(enc).split(LS).join("\\u2028").split(PS).join("\\u2029")).toBe(c.written);
      // Through a real file line and back: the value is the same.
      const back = JSON.parse(JSON.stringify(enc)) as unknown;
      expect(decodeValue(c.kind, back)).toEqual(c.param);
    });
  }

  it("NULL, an empty text and the text \"null\" are three different things in a file", () => {
    const written = [null, "", "null"].map((v) => JSON.stringify(encodeValue("text", v)));
    expect(written).toEqual(["null", '""', '"null"']);
    expect(decodeValue("text", null)).toBeNull();
    expect(decodeValue("text", "")).toBe("");
    expect(decodeValue("text", "null")).toBe("null");
  });

  it("money is never a JSON number", () => {
    for (const raw of ["12.50", "0.1", "-0.30", "9999999999.99"]) expect(typeof encodeValue("numeric", raw)).toBe("string");
  });
});

describe("a line", () => {
  const columns: FileColumn[] = [
    { name: "id", kind: "bigint" },
    { name: "note", kind: "text" },
    { name: "amount", kind: "numeric" },
    { name: "at", kind: "instant" },
    { name: "digest", kind: "bytea" },
    { name: "extra", kind: "json" },
    { name: "ok", kind: "boolean" },
    { name: "n", kind: "integer" },
  ];
  const raws: Raw[] = ["9007199254740993", `two${LS}lines\nand "quotes"`, "1200.50", "2026-03-08T05:00:00.000000Z", "0a0b", '{"k": [1, {"z": null}]}', true, "5"];

  it("is one line, with the keys in the column order, and no raw line separators", () => {
    const line = encodeLine(columns, raws);
    expect(line).not.toMatch(/[\n\r]/);
    expect(line.includes(LS) || line.includes(PS)).toBe(false);
    expect(Object.keys(JSON.parse(line) as object)).toEqual(columns.map((c) => c.name));
    expect(line.startsWith('{"id":"9007199254740993","note":')).toBe(true);
  });

  it("decodes back to the values to send the database", () => {
    expect(decodeLine(columns, encodeLine(columns, raws))).toEqual(["9007199254740993", `two${LS}lines\nand "quotes"`, "1200.50", "2026-03-08T05:00:00.000000Z", "\\x0a0b", '{"k":[1,{"z":null}]}', true, "5"]);
  });

  it("a part file is its lines each followed by a line end, and a file cut short is refused", () => {
    const text = joinLines(["{}", '{"a":1}']);
    expect(text).toBe('{}\n{"a":1}\n');
    expect(splitLines(text)).toEqual(["{}", '{"a":1}']);
    expect(splitLines("")).toEqual([]);
    expect(() => splitLines('{"a":1}')).toThrow(EncodeError);
  });

  it("refuses a line whose keys are not the columns, a wrong number of values, and a value that is not the kind's", () => {
    expect(() => decodeLine(columns, '{"id":"1"}')).toThrow(EncodeError);
    expect(() => decodeLine([{ name: "a", kind: "text" }], '{"b":"x"}')).toThrow(EncodeError);
    expect(() => decodeLine([{ name: "a", kind: "text" }], "[1]")).toThrow(EncodeError);
    expect(() => decodeLine([{ name: "a", kind: "text" }], "not json")).toThrow(EncodeError);
    expect(() => encodeLine(columns, raws.slice(1))).toThrow(EncodeError);
    expect(() => encodeValue("numeric", "1e5")).toThrow(EncodeError);
    expect(() => encodeValue("instant", "2026-03-08 05:00:00+00")).toThrow(EncodeError);
    expect(() => decodeValue("integer", "5")).toThrow(EncodeError);
    expect(() => decodeValue("bytea", "00ff")).toThrow(EncodeError);
    expect(() => decodeValue("boolean", "true")).toThrow(EncodeError);
  });

  it("an error never quotes the value", () => {
    try {
      encodeValue("numeric", "SECRET-VALUE");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("SECRET-VALUE");
    }
  });
});

describe("types and SQL", () => {
  it("kinds from Postgres type names", () => {
    expect(["text", "varchar", "int2", "int4", "int8", "numeric", "bool", "date", "timestamptz", "bytea", "jsonb", "uuid", "float8", "timestamp"].map(kindOfType)).toEqual([
      "text", "text", "integer", "integer", "bigint", "numeric", "boolean", "date", "instant", "bytea", "json", "other", "other", "other",
    ]);
  });

  it("identifiers are quoted, and a quote inside a name cannot end the identifier", () => {
    expect(quoteIdent("audit_log")).toBe('"audit_log"');
    expect(quoteIdent('a"b')).toBe('"a""b"');
    expect(selectExpression("numeric", 'x"y')).toBe('"x""y"::text as "x""y"');
    expect(() => quoteIdent("")).toThrow();
  });
});
