// Reading the database for the nightly copy (card P4-06a): which tables, and one table at a time in parts.
//
// WHICH TABLES. Every table of schema ops, found by asking the database's catalogue at run time, so a table
// a later migration adds is copied without anyone remembering to list it. The only tables left out are the
// ones in EXCLUDED below, each with the reason; a test fails if a table exists that is neither copied nor
// named here, and if a copied table points (by foreign key) at an excluded one, because a restore of that
// copy could not load.
//
// WHAT IS COPIED THAT LOOKS SENSITIVE ON PURPOSE: the hashes of PINs (staff.pin_hash) and of assistants' keys
// (assistant_keys.key_hash). A restore must let people sign in again, and a hash is not the secret.
//
// HOW A TABLE IS READ. Inside the caller's one read-only repeatable-read transaction, through a server-side
// cursor, in the table's stable order: `seq` where the table has one (the order rows were written in),
// otherwise the primary key; text keys are ordered with the "C" collation so the order is the same on every
// server. The ORDER BY names the table's own columns (t."seq"), never the output ones: the output holds the same
// names as text, and a bare name in ORDER BY would sort that text ("10" before "9"). A table with neither is refused (the copy fails, loudly) rather than copied in an unstable order.
// Rows come back in small fetches and are cut into parts of at most MAX_PART_ROWS rows or, once a part has
// reached MAX_PART_BYTES, at the next row end: so what is held in memory at one time is one part, never a
// table. Each part is handed to `sink` as soon as it is full.
//
// Values are asked of the database as text (encode.ts selectExpression), so nothing passes through a
// JavaScript number or Date. Identifiers come from the catalogue and are quoted; values are never put into
// SQL text (the one number in it, the fetch size, is this file's own constant).
import type { Db } from "../db/client";
import { encodeLine, encodedValues, kindOfType, quoteIdent, selectExpression, type FileColumn, type Raw } from "./encode";
import { TotalsBuilder, type TableTotals } from "./totals";

/** Tables that are NOT copied, and why. Anything not named here is copied. */
export const EXCLUDED: Readonly<Record<string, string>> = {
  sessions: "live sign-ins last hours: a restored copy would revive sign-ins nobody means to keep; people sign in again with their PIN",
  login_failures: "counts of recent wrong PINs: a restore starts with nobody locked out",
  receipt_upload_tickets: "one-time tickets for an assistant's upload that last minutes: nothing to recover",
  assistant_calls: "the record of assistant calls (no arguments, no answers): large, and it starts again as assistants call",
  schema_migrations: "the migration tool's own bookkeeping: a restore needs a database that tool has just made (it keeps its own); the manifest records the newest migration instead",
};

/** Most rows in one part file. Chosen so a part stays a few MB for this app's widest table (audit_log) and one part is one R2 put. */
export const MAX_PART_ROWS = 5000;
/** A part is closed at the first row end after it has reached this many bytes. */
export const MAX_PART_BYTES = 2 * 1024 * 1024;
/** Rows fetched from the cursor at a time. */
export const FETCH_ROWS = 200;

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export interface ColumnInfo extends FileColumn {
  /** The type as the database prints it ("numeric(12,2)", "timestamp with time zone"). */
  type: string;
  /** "a" (generated always), "d" (by default) or "" (not an identity column). */
  identity: "" | "a" | "d";
  /** A generated (computed) column: it is copied, and not loaded again by a restore. */
  generated: boolean;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  /** The columns the table is read in the order of: `seq`, or the primary key. */
  orderBy: string[];
  /** Foreign keys to other tables of schema ops. */
  references: { table: string; deferrable: boolean }[];
}

interface ColumnRow {
  table_name: string;
  attname: string;
  type: string;
  typname: string;
  attidentity: string;
  attgenerated: string;
}

/** Every table of schema ops, with its columns, its read order and its foreign keys. Names are those of the catalogue. */
export async function readCatalogue(db: Db): Promise<TableInfo[]> {
  const cols = await db.query<ColumnRow>(
    `select c.relname as table_name, a.attname, format_type(a.atttypid, a.atttypmod) as type, t.typname,
            a.attidentity::text as attidentity, a.attgenerated::text as attgenerated
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_attribute a on a.attrelid = c.oid
       join pg_catalog.pg_type t on t.oid = a.atttypid
      where n.nspname = 'ops' and c.relkind in ('r', 'p') and not c.relispartition and a.attnum > 0 and not a.attisdropped
      order by c.relname, a.attnum`,
  );
  const keys = await db.query<{ table_name: string; attname: string }>(
    `select c.relname as table_name, a.attname
       from pg_catalog.pg_index i
       join pg_catalog.pg_class c on c.oid = i.indrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = any (i.indkey)
      where n.nspname = 'ops' and i.indisprimary
      order by c.relname, array_position(i.indkey::int2[], a.attnum)`,
  );
  const fks = await db.query<{ table_name: string; target: string; deferrable: boolean }>(
    `select c.relname as table_name, t.relname as target, k.condeferrable as deferrable
       from pg_catalog.pg_constraint k
       join pg_catalog.pg_class c on c.oid = k.conrelid
       join pg_catalog.pg_class t on t.oid = k.confrelid
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
       join pg_catalog.pg_namespace nt on nt.oid = t.relnamespace
      where k.contype = 'f' and n.nspname = 'ops' and nt.nspname = 'ops'
      order by c.relname, t.relname`,
  );
  const tables = new Map<string, TableInfo>();
  for (const r of cols) {
    let t = tables.get(r.table_name);
    if (t === undefined) {
      t = { name: r.table_name, columns: [], orderBy: [], references: [] };
      tables.set(r.table_name, t);
    }
    t.columns.push({
      name: r.attname,
      kind: kindOfType(r.typname),
      type: r.type,
      identity: r.attidentity === "a" || r.attidentity === "d" ? r.attidentity : "",
      generated: r.attgenerated !== "",
    });
  }
  const pk = new Map<string, string[]>();
  for (const r of keys) pk.set(r.table_name, [...(pk.get(r.table_name) ?? []), r.attname]);
  for (const t of tables.values()) {
    const seq = t.columns.find((c) => c.name === "seq" && c.identity !== "");
    t.orderBy = seq ? ["seq"] : (pk.get(t.name) ?? []);
  }
  for (const r of fks) {
    const t = tables.get(r.table_name);
    if (t && r.target !== r.table_name && !t.references.some((x) => x.table === r.target)) t.references.push({ table: r.target, deferrable: r.deferrable });
  }
  return [...tables.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The tables to copy, and the names left out (with the reason). */
export function planCopy(all: readonly TableInfo[]): { copy: TableInfo[]; excluded: { table: string; reason: string }[] } {
  const copy: TableInfo[] = [];
  const excluded: { table: string; reason: string }[] = [];
  for (const t of all) {
    const reason = Object.prototype.hasOwnProperty.call(EXCLUDED, t.name) ? (EXCLUDED[t.name] as string) : undefined;
    if (reason !== undefined) excluded.push({ table: t.name, reason });
    else copy.push(t);
  }
  return { copy, excluded };
}

/** The order the tables must be loaded in: a table after every table it points at (deferrable keys do not count). Throws on a cycle. */
export function loadOrder(tables: readonly TableInfo[]): TableInfo[] {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const out: TableInfo[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (t: TableInfo): void => {
    const s = state.get(t.name);
    if (s === "done") return;
    if (s === "visiting") throw new BackupError(`tables point at each other through foreign keys that cannot be deferred (around ${t.name})`);
    state.set(t.name, "visiting");
    for (const ref of t.references) {
      const target = byName.get(ref.table);
      if (target !== undefined && !ref.deferrable) visit(target);
    }
    state.set(t.name, "done");
    out.push(t);
  };
  for (const t of tables) visit(t);
  return out;
}

/** One part file, ready to be written. */
export interface Part {
  /** 1-based. */
  number: number;
  rows: number;
  bytes: Uint8Array;
  sha256: string;
}

const encoder = new TextEncoder();

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PartLimits {
  maxRows: number;
  maxBytes: number;
}
export const DEFAULT_LIMITS: PartLimits = { maxRows: MAX_PART_ROWS, maxBytes: MAX_PART_BYTES };

export interface TableRead {
  rows: number;
  parts: number;
  bytes: number;
  totals: TableTotals;
}

const CURSOR = "backup_cursor";

/**
 * Read one table, in order, in parts. `columns` are the columns to read (all of the table's for a copy; the
 * manifest's for a restore's check). Each full part goes to `sink` before the next row is read.
 */
export async function readTableInParts(
  db: Db,
  table: TableInfo,
  columns: readonly ColumnInfo[],
  sink: (part: Part) => Promise<void>,
  limits: PartLimits = DEFAULT_LIMITS,
): Promise<TableRead> {
  if (table.orderBy.length === 0) throw new BackupError(`table ${table.name} has no primary key and no seq column, so it cannot be copied in a stable order`);
  const totals = new TotalsBuilder(table.name, columns);
  const select = columns.map((c) => selectExpression(c.kind, c.name)).join(", ");
  const order = table.orderBy
    .map((name) => {
      const col = table.columns.find((c) => c.name === name);
      return `t.${quoteIdent(name)}${col?.kind === "text" ? ' collate "C"' : ""}`;
    })
    .join(", ");
  await db.query(`declare ${CURSOR} no scroll cursor for select ${select} from ops.${quoteIdent(table.name)} as t order by ${order}`);

  let pieces: Uint8Array[] = [];
  let bytes = 0;
  let rows = 0;
  let parts = 0;
  let total = 0;
  const flush = async (): Promise<void> => {
    if (pieces.length === 0) return;
    const body = new Uint8Array(bytes);
    let at = 0;
    for (const p of pieces) {
      body.set(p, at);
      at += p.byteLength;
    }
    parts++;
    total += body.byteLength;
    const part: Part = { number: parts, rows: pieces.length, bytes: body, sha256: await sha256Hex(body) };
    pieces = [];
    bytes = 0;
    await sink(part);
  };
  try {
    for (;;) {
      const batch = await db.query<Record<string, Raw>>(`fetch forward ${FETCH_ROWS} from ${CURSOR}`);
      if (batch.length === 0) break;
      for (const row of batch) {
        const raws = columns.map((c) => row[c.name]);
        const line = encodeLine(columns, raws);
        totals.add(encodedValues(columns, raws));
        const piece = encoder.encode(`${line}\n`);
        pieces.push(piece);
        bytes += piece.byteLength;
        rows++;
        if (pieces.length >= limits.maxRows || bytes >= limits.maxBytes) await flush();
      }
    }
    await flush();
  } finally {
    await db.query(`close ${CURSOR}`).catch(() => undefined);
  }
  return { rows, parts, bytes: total, totals: totals.result() };
}
