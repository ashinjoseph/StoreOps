// The nightly copy's file format (card P4-06a; docs/components/backups.md), as pure functions and their
// inverses. A copy file is newline-delimited JSON: one row per line, one JSON object per row, the keys
// in the table's column order (the order the database lists them in).
//
// What a value looks like in a file, by the column's type. Every value is exact: nothing passes through
// a JavaScript float or Date, because the database is asked for text and the text is what is kept.
//
//   text                     a JSON string
//   smallint, integer        a JSON number
//   bigint                   a JSON string of digits (a number past 2^53 would lose digits in JavaScript)
//   numeric (money, hours, rates)
//                            a JSON string, exactly as the database prints it: "12.50", "-0.5000"
//   boolean                  true or false
//   date                     "YYYY-MM-DD"
//   timestamptz              "YYYY-MM-DDTHH:MM:SS.ffffffZ" (UTC, six decimals: the database's own precision)
//   bytea                    { "$hex": "0a0b..." }   (hex, with the marker so a person can see it is bytes)
//   json, jsonb              the JSON value itself; a JSON null, or an object with the key "$json", is
//                            wrapped as { "$json": value } so it can never be mistaken for SQL NULL
//   any other type           the database's text form, as a JSON string
//   NULL                     null          (never "", never "null": those are texts)
//
// A line never holds a raw U+2028 or U+2029 (they are written as the six-character escapes), so any tool that
// treats them as line breaks still sees one row per line.
//
// What goes into the SQL is `selectExpression`: it asks the database for exactly the "raw" form each
// function here takes, so the reading side and the writing side cannot drift apart. No file system, no
// database, no clock in this file.

export type ColumnKind = "text" | "integer" | "bigint" | "numeric" | "boolean" | "date" | "instant" | "bytea" | "json" | "other";

/** What the database gives for one value before encoding: text, a boolean, or null. */
export type Raw = string | boolean | null;

/** A value as it is written in a file (any JSON value). */
export type Encoded = unknown;

/** A value as it goes to the database: always text (or a boolean, or null), cast by the column's type. */
export type Param = string | boolean | null;

export class EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodeError";
  }
}

const TYPE_KINDS: Readonly<Record<string, ColumnKind>> = {
  text: "text",
  varchar: "text",
  bpchar: "text",
  name: "text",
  citext: "text",
  int2: "integer",
  int4: "integer",
  int8: "bigint",
  numeric: "numeric",
  bool: "boolean",
  date: "date",
  timestamptz: "instant",
  bytea: "bytea",
  json: "json",
  jsonb: "json",
};

/** The kind of a column, from its Postgres type name (pg_type.typname). An unlisted type is kept as its text form. */
export function kindOfType(typname: string): ColumnKind {
  return TYPE_KINDS[typname] ?? "other";
}

/** A name from the catalogue, quoted so that whatever it holds stays one identifier. */
export function quoteIdent(name: string): string {
  if (name === "" || name.includes("\u0000")) throw new EncodeError("an identifier is empty or holds a NUL");
  return `"${name.replace(/"/g, '""')}"`;
}

/** The SQL that gives one column in the raw form `encodeValue` takes. `name` is the column's name; the result is aliased to it. */
export function selectExpression(kind: ColumnKind, name: string): string {
  const q = quoteIdent(name);
  switch (kind) {
    case "text":
    case "boolean":
      return q;
    case "date":
      return `to_char(${q}, 'YYYY-MM-DD') as ${q}`;
    case "instant":
      return `to_char(${q} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${q}`;
    case "bytea":
      return `encode(${q}, 'hex') as ${q}`;
    case "integer":
    case "bigint":
    case "numeric":
    case "json":
    case "other":
      return `${q}::text as ${q}`;
  }
}

const NUMERIC = /^(?:-?\d+(?:\.\d+)?|NaN)$/;
const DIGITS = /^-?\d+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const HEX = /^(?:[0-9a-f]{2})*$/;

const isWrapper = (v: unknown): v is { $json: unknown } =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && Object.prototype.hasOwnProperty.call(v, "$json");

function expectString(kind: ColumnKind, v: unknown): string {
  if (typeof v !== "string") throw new EncodeError(`a ${kind} value did not arrive as text`);
  return v;
}

/** One value from the database, as it is written in a file. Throws EncodeError (never quoting the value) when it is not what the column's kind allows. */
export function encodeValue(kind: ColumnKind, raw: Raw | undefined): Encoded {
  if (raw === null) return null;
  if (raw === undefined) throw new EncodeError("a value is missing (undefined)");
  switch (kind) {
    case "text":
    case "other":
      return expectString(kind, raw);
    case "boolean":
      if (typeof raw !== "boolean") throw new EncodeError("a boolean value did not arrive as a boolean");
      return raw;
    case "integer": {
      const s = expectString(kind, raw);
      const n = Number(s);
      if (!DIGITS.test(s) || !Number.isSafeInteger(n)) throw new EncodeError("an integer value is not a safe whole number");
      return n;
    }
    case "bigint": {
      const s = expectString(kind, raw);
      if (!DIGITS.test(s)) throw new EncodeError("a bigint value is not digits");
      return s;
    }
    case "numeric": {
      const s = expectString(kind, raw);
      if (!NUMERIC.test(s)) throw new EncodeError("a numeric value is not a plain decimal");
      return s;
    }
    case "date": {
      const s = expectString(kind, raw);
      if (!DAY.test(s)) throw new EncodeError("a date value is not YYYY-MM-DD");
      return s;
    }
    case "instant": {
      const s = expectString(kind, raw);
      if (!INSTANT.test(s)) throw new EncodeError("an instant value is not an ISO UTC time with microseconds");
      return s;
    }
    case "bytea": {
      const s = expectString(kind, raw);
      if (!HEX.test(s)) throw new EncodeError("a bytea value is not hex");
      return { $hex: s };
    }
    case "json": {
      const s = expectString(kind, raw);
      let parsed: unknown;
      try {
        parsed = JSON.parse(s);
      } catch {
        throw new EncodeError("a json value is not valid JSON");
      }
      return parsed === null || isWrapper(parsed) ? { $json: parsed } : parsed;
    }
  }
}

/** The inverse of `encodeValue`: what to send the database (as a text parameter cast to the column's type). */
export function decodeValue(kind: ColumnKind, enc: Encoded): Param {
  if (enc === null) return null;
  if (enc === undefined) throw new EncodeError("a value is missing (undefined)");
  switch (kind) {
    case "text":
    case "other":
    case "bigint":
    case "numeric":
    case "date":
    case "instant": {
      if (typeof enc !== "string") throw new EncodeError(`a ${kind} value is not a string in the file`);
      if (kind === "bigint" && !DIGITS.test(enc)) throw new EncodeError("a bigint value is not digits");
      if (kind === "numeric" && !NUMERIC.test(enc)) throw new EncodeError("a numeric value is not a plain decimal");
      if (kind === "date" && !DAY.test(enc)) throw new EncodeError("a date value is not YYYY-MM-DD");
      if (kind === "instant" && !INSTANT.test(enc)) throw new EncodeError("an instant value is not an ISO UTC time with microseconds");
      return enc;
    }
    case "boolean":
      if (typeof enc !== "boolean") throw new EncodeError("a boolean value is not true or false in the file");
      return enc;
    case "integer":
      if (typeof enc !== "number" || !Number.isSafeInteger(enc)) throw new EncodeError("an integer value is not a whole number in the file");
      return String(enc);
    case "bytea": {
      const hex = typeof enc === "object" && enc !== null && !Array.isArray(enc) ? (enc as Record<string, unknown>)["$hex"] : undefined;
      if (typeof hex !== "string" || !HEX.test(hex) || Object.keys(enc as object).length !== 1) throw new EncodeError("a bytea value is not { \"$hex\": ... } in the file");
      return `\\x${hex}`;
    }
    case "json":
      return JSON.stringify(isWrapper(enc) ? enc.$json : enc);
  }
}

/** A column as the files and the manifest know it. */
export interface FileColumn {
  name: string;
  kind: ColumnKind;
}

/** U+2028 and U+2029 are legal inside a JSON string but break a line for some readers: write them escaped. */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const escapeSeparators = (s: string): string => s.split(LS).join("\\u2028").split(PS).join("\\u2029");

/** One row as one line (no line end): the keys in `columns` order, built by hand so the order can never change. */
export function encodeLine(columns: readonly FileColumn[], raws: readonly (Raw | undefined)[]): string {
  if (raws.length !== columns.length) throw new EncodeError("a row has a different number of values than the table has columns");
  const parts = columns.map((c, i) => `${JSON.stringify(c.name)}:${JSON.stringify(encodeValue(c.kind, raws[i]))}`);
  return escapeSeparators(`{${parts.join(",")}}`);
}

/** One line back to the values to send the database, in column order. Throws EncodeError when the keys are not exactly the columns. */
export function decodeLine(columns: readonly FileColumn[], line: string): Param[] {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    throw new EncodeError("a line is not valid JSON");
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) throw new EncodeError("a line is not a JSON object");
  const rec = obj as Record<string, unknown>;
  if (Object.keys(rec).length !== columns.length || !columns.every((c) => Object.prototype.hasOwnProperty.call(rec, c.name))) {
    throw new EncodeError("a line's keys are not the table's columns");
  }
  return columns.map((c) => decodeValue(c.kind, rec[c.name]));
}

/** The values of one line as they are written, in column order (for the totals). */
export function encodedValues(columns: readonly FileColumn[], raws: readonly (Raw | undefined)[]): Encoded[] {
  return columns.map((c, i) => encodeValue(c.kind, raws[i]));
}

/** A part file's text: each line followed by a line end. */
export function joinLines(lines: readonly string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** A part file's lines back; the last line must end with a line end (a file cut short is not read). */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  if (!text.endsWith("\n")) throw new EncodeError("a file does not end with a line end (it was cut short)");
  return text.slice(0, -1).split("\n");
}
