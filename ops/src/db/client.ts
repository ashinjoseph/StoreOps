// The database client every module uses: a small wrapper over one `pg` client.
//
// How values cross the boundary (decided once, here; ADR-0004 "blank is not zero"):
//   numeric      -> number      (NULL -> null, never 0, never a string)
//   date         -> "YYYY-MM-DD" exactly as stored, whatever the process time zone
//   timestamptz  -> Date (the same instant)
//   bigint       -> number, or an error beyond Number.MAX_SAFE_INTEGER
//   boolean, text -> as the driver gives them ('' stays '', NULL stays null)
// Parameters: undefined, NaN, +-Infinity and an invalid Date are refused before
// anything is sent; a Date goes out as an instant (ISO, UTC).
//
// The parsers are passed on every query, never registered on the driver's global
// `types` object: other code (and other tests) in the process keep the defaults.
//
// This file takes a connection string or a connected client and never reads the
// environment. It imports nothing local, so Node can run it directly.
import pg from "pg";

export interface Db {
  /** All rows. Parameters are the only way to put a value into the SQL. */
  query<T>(text: string, params?: readonly unknown[]): Promise<T[]>;
  /** Exactly one row, else an error. */
  one<T>(text: string, params?: readonly unknown[]): Promise<T>;
  /** One row or null; more than one is an error. */
  maybeOne<T>(text: string, params?: readonly unknown[]): Promise<T | null>;
}

export type DbErrorKind = "permission" | "unique" | "foreign_key" | "check" | "not_null" | "deadlock" | "serialization" | "other";

const KIND_BY_CODE: Readonly<Record<string, DbErrorKind>> = {
  "42501": "permission",
  "23505": "unique",
  "23503": "foreign_key",
  "23514": "check",
  "23502": "not_null",
  "40P01": "deadlock",
  "40001": "serialization",
};

const KIND_TEXT: Readonly<Record<DbErrorKind, string>> = {
  permission: "permission denied",
  unique: "unique constraint violated",
  foreign_key: "foreign key constraint violated",
  check: "check constraint violated",
  not_null: "null value in a not-null column",
  deadlock: "deadlock detected",
  serialization: "serialization failure",
  other: "database error",
};

/**
 * A driver error, kept to what is safe to log. The Postgres message and detail
 * are NOT copied: they can quote the values that were sent (a key, a bad
 * number, a name), which may be personal or money data. What stays: the SQLSTATE
 * code, the constraint, table and column names, and a coarse `kind`.
 */
export class DbError extends Error {
  readonly kind: DbErrorKind;
  /** The five-character SQLSTATE (or a Node code such as ECONNREFUSED) when there is one. */
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;

  constructor(kind: DbErrorKind, fields: { code?: string | undefined; constraint?: string | undefined; table?: string | undefined; column?: string | undefined }) {
    const where = [fields.table && `table ${fields.table}`, fields.constraint && `constraint ${fields.constraint}`, fields.column && `column ${fields.column}`]
      .filter(Boolean)
      .join(", ");
    super(`${KIND_TEXT[kind]}${fields.code ? ` (${fields.code})` : ""}${where ? `: ${where}` : ""}`);
    this.name = "DbError";
    this.kind = kind;
    this.code = fields.code;
    this.constraint = fields.constraint;
    this.table = fields.table;
    this.column = fields.column;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Wrap a driver error. Anything that is already a DbError, or not an object, is handled safely. */
export function toDbError(err: unknown): DbError {
  if (err instanceof DbError) return err;
  const e = (typeof err === "object" && err !== null ? err : {}) as Record<string, unknown>;
  const code = str(e["code"]);
  const kind = (code !== undefined ? KIND_BY_CODE[code] : undefined) ?? "other";
  return new DbError(kind, { code, constraint: str(e["constraint"]), table: str(e["table"]), column: str(e["column"]) });
}

// ---- how values come back -------------------------------------------------

const OID = { int8: 20, bool: 16, date: 1082, timestamptz: 1184, numeric: 1700 } as const;

/** A value from the database that cannot be a JavaScript number. Its message holds no data. */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

function parseNumeric(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new ValueError("numeric value is not a finite number");
  return n;
}

function parseInt8(s: string): number {
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new ValueError("bigint value is beyond Number.MAX_SAFE_INTEGER (not a safe integer)");
  return n;
}

const defaults = pg.types;

/** Per-query type parsers: our rules for four types, the driver's own for everything else. */
const TYPES = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (format === "binary") return defaults.getTypeParser(oid, "binary");
    switch (oid) {
      case OID.numeric:
        return parseNumeric;
      case OID.date:
        return (s: string) => s;
      case OID.int8:
        return parseInt8;
      default:
        return defaults.getTypeParser(oid, "text");
    }
  },
} as pg.CustomTypesConfig;

// ---- what goes in -----------------------------------------------------------

function checkParam(value: unknown, label: string): unknown {
  if (value === undefined) throw new TypeError(`parameter ${label} is undefined (it would silently become NULL; pass null)`);
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError(`parameter ${label} is ${Number.isNaN(value) ? "NaN" : "Infinity"}, not a finite number`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`parameter ${label} is an invalid Date`);
    return value.toISOString(); // an instant, whatever the process time zone
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v, i) => checkParam(v, `${label}[${i}]`));
  return value;
}

function checkParams(params: readonly unknown[]): unknown[] {
  return params.map((v, i) => checkParam(v, `$${i + 1}`));
}

// ---- the client -------------------------------------------------------------

/** Wrap an already-connected `pg` client. The caller still owns it (and closes it). */
export function fromClient(client: pg.Client): Db {
  async function query<T>(text: string, params?: readonly unknown[]): Promise<T[]> {
    const values = params === undefined ? undefined : checkParams(params);
    try {
      const res = await client.query({ text, values, types: TYPES });
      return res.rows as T[];
    } catch (err) {
      throw err instanceof ValueError ? err : toDbError(err);
    }
  }
  async function one<T>(text: string, params?: readonly unknown[]): Promise<T> {
    const rows = await query<T>(text, params);
    if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
    return rows[0] as T;
  }
  async function maybeOne<T>(text: string, params?: readonly unknown[]): Promise<T | null> {
    const rows = await query<T>(text, params);
    if (rows.length > 1) throw new Error(`expected at most one row, got more than one row (${rows.length})`);
    return rows.length === 1 ? (rows[0] as T) : null;
  }
  return { query, one, maybeOne };
}

/** Open one connection. The caller closes it. */
export async function connect(connectionString: string): Promise<Db & { close(): Promise<void> }> {
  const client = new pg.Client({ connectionString, types: TYPES });
  try {
    await client.connect();
  } catch (err) {
    throw toDbError(err);
  }
  // An idle connection the server drops would otherwise crash the process on an unhandled 'error'.
  client.on("error", () => undefined);
  return {
    ...fromClient(client),
    async close() {
      await client.end();
    },
  };
}
