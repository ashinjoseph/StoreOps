// Read the database for the cutover reconcile (card P4-03): every table of the contract, one
// query per table, inside ONE read-only transaction at repeatable-read isolation, so all the
// tables are of the same instant even while the app is running.
//
// It needs only SELECT (the ops_read role). Table and column names come only from the parsed
// contract and the database's own catalogue, checked against a plain-name pattern, and every
// value is selected as text: a date as "YYYY-MM-DD", an instant as UTC with microseconds, a
// figure as the exact decimal text, so nothing passes through a JavaScript number or Date.
//
// Rows are ordered by `seq` where the table has one (the order the import loaded them in), else
// by primary key. This file imports no translation: only the contract's TYPES.
import type pg from "pg";
import type { Column, Contract } from "../import/sheet-to-db";
import { DB_ONLY_READ, OPS_ONLY_TABLES, type DbSnapshot, type DbTableIn } from "./compare";

const IDENT = /^[a-z_][a-z0-9_]*$/;
const quote = (name: string): string => {
  if (!IDENT.test(name)) throw new Error(`unsafe name: ${name.slice(0, 40)}`);
  return `"${name}"`;
};

/** The select expression that gives a column as text, exactly. */
function selectExpr(col: Column): string | null {
  const q = quote(col.name);
  switch (col.type) {
    case "date":
      return `to_char(${q}, 'YYYY-MM-DD') as ${q}`;
    case "timestamptz":
      return `to_char(${q} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${q}`;
    case "numeric":
    case "integer":
    case "bigint":
    case "boolean":
      return `${q}::text as ${q}`;
    case "text":
      return q;
    case "bytea":
      return null;
  }
}

/** Read the snapshot. The caller owns the connection; the transaction is begun and ended here. */
export async function readDatabase(db: pg.Client, contract: Contract): Promise<DbSnapshot> {
  await db.query("begin isolation level repeatable read read only");
  try {
    const cat = await db.query<{ t: string; c: string }>(
      `select c.relname as t, a.attname as c
         from pg_catalog.pg_attribute a
         join pg_catalog.pg_class c on c.oid = a.attrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'ops' and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped`,
    );
    const columnsOf = new Map<string, string[]>();
    for (const r of cat.rows) {
      if (!columnsOf.has(r.t)) columnsOf.set(r.t, []);
      columnsOf.get(r.t)?.push(r.c);
    }

    const tables: Record<string, DbTableIn> = {};
    for (const table of Object.values(contract.tables)) {
      if (OPS_ONLY_TABLES.includes(table.name)) continue;
      const have = columnsOf.get(table.name);
      if (!have) {
        tables[table.name] = { present: false, columns: [], hasSeq: false, rows: [] };
        continue;
      }
      const pk = table.columns.find((c) => c.primaryKey);
      if (!pk) throw new Error(`${table.name}: the contract has no primary key`);
      const exprs: string[] = [];
      for (const c of table.columns) {
        if (!have.includes(c.name)) continue;
        const e = selectExpr(c);
        if (e) exprs.push(e);
      }
      for (const extra of DB_ONLY_READ[table.name] ?? []) if (have.includes(extra)) exprs.push(`${quote(extra)}::text as ${quote(extra)}`);
      const hasSeq = have.includes("seq");
      const res = await db.query<Record<string, string | null>>(`select ${exprs.join(", ")} from ops.${quote(table.name)} order by ${quote(hasSeq ? "seq" : pk.name)}`);
      tables[table.name] = { present: true, columns: have, hasSeq, rows: res.rows };
    }

    const opsOnlyCounts: Record<string, number> = {};
    for (const name of OPS_ONLY_TABLES) {
      if (!contract.tables[name] || !columnsOf.has(name)) continue;
      const r = await db.query<{ n: string }>(`select count(*)::text as n from ops.${quote(name)}`);
      opsOnlyCounts[name] = Number(r.rows[0]?.n ?? 0);
    }
    const allTables = [...columnsOf.keys()].filter((t) => t !== "schema_migrations").sort();
    return { tables, allTables, opsOnlyCounts };
  } finally {
    await db.query("rollback").catch(() => undefined); // read only: nothing to keep
  }
}
