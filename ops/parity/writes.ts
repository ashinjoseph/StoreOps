// What each side stored.
//
// Two checks, both after every case:
//   1. Nothing changed that the case did not declare. Every table on both sides
//      is fingerprinted before and after (its full contents, so an UPDATE counts,
//      not only a changed row count). A change on either side to a table not in
//      `writes` fails the case.
//   2. Every declared table holds the same rows on both sides. The old side's
//      sheet rows go through translateTab, the same translation that loaded the
//      fixture into Postgres, and are compared with the rows now in Postgres,
//      keyed by primary key after id normalisation, column by column.
//
// The old app keeps sessions and login failure counts in script properties, not
// in a tab. For those two tables the old side's view is read from the properties
// (session:<token> and loginFails:<name>), and both sides are reduced to what the
// old app records: a session's person and expiry; a name's failure count and its
// first and last failure. stores and staff_stores have no old counterpart at all:
// a case may declare them, and the report says they were not compared.
import { createHash } from "node:crypto";
import { connect } from "../src/db/client";
import { readContract } from "../src/import/load";
import { translateTab, type Contract } from "../src/import/sheet-to-db";
import { MAX_DIFFS, MISSING, Normaliser, diffValues, idsIn, render, type Diff } from "./compare";
import type { OldWorld } from "./old-world";

export const schema: Contract = readContract();

/**
 * Columns that exist only in the new schema, never compared. Stated once, here.
 * (The sessions and login_failures views below are built from the columns the
 * old app has, so their new-only columns never enter the comparison either.)
 */
export const NEW_ONLY_COLUMNS: readonly { table: string; column: string; reason: string }[] = [
  { table: "*", column: "store_id", reason: "a store is a new-schema concept (decision D4); the Sheet has no such column" },
  { table: "staff", column: "pin_hash", reason: "the new app's PIN hash; the Sheet's plain login_code is deliberately not loaded" },
  { table: "sessions", column: "token_hash, created_at, last_seen_at", reason: "the old session (a script property) records only the person and the expiry; rows are keyed by the token instead" },
  { table: "login_failures", column: "failure_id, failed_at (per row)", reason: "the old app keeps one {count, firstFailAt, lastFailAt} per name; both sides are compared in that form" },
  { table: "audit_log, payments, sales, cash_handovers, commission_runs", column: "seq", reason: "the order rows were written in, numbered by the database (migrations 0004 to 0007); the Sheet has it as the row's position, which the comparison does not use either" },
  { table: "payments", column: "voided_at, voided_by, void_reason", reason: "the new app voids a payment where the old one deleted it (VOIDED_PAYMENTS_RULE); the Sheet has no such columns" },
];

/**
 * A session past its end is the same as no session, on both sides. Stated once, here.
 * Neither app will accept it. The old app happens to delete it when it is next
 * looked at; the new one refuses it and leaves the row for `purgeExpired` (a
 * delete followed by NOT_LOGGED_IN would be rolled back with the rest of the
 * call). So the comparison drops expired sessions from both sides before it
 * compares, using the case's clock. This is printed with every run.
 */
export const EXPIRED_SESSIONS_RULE = "sessions past their expiry are left out on both sides: neither app accepts one; the old deletes it when next looked at, the new leaves it for purgeExpired";
const live = (now: Date) => (r: { expires_at: unknown }): boolean => typeof r.expires_at !== "string" || Date.parse(r.expires_at) >= now.getTime();

/**
 * An undone payment is the same as no payment, on both sides. Stated once, here.
 * The old app deletes the payment row and its item rows; the new one may not delete
 * money (AGENTS.md hard rule 9), so it sets voided_at / voided_by / void_reason and
 * keeps the rows, and every read leaves them out. So the comparison leaves out, on
 * the new side only, every payment with a voided_at and every item of such a
 * payment, before it compares; a payment the old side deleted and the new side did
 * not void, or one the new side voided and the old side kept, is still a
 * difference. This is printed with every run.
 */
export const VOIDED_PAYMENTS_RULE =
  "a payment voided on the new side, and every item of a voided payment, are left out of the new side's payments and payment_items: the old app deletes them on undo; the void columns are new-only";
const VOID_COLUMNS = new Set(["voided_at", "voided_by", "void_reason"]);
/** Tables with a `seq` column (migration 0004): new-only, never compared. */
const WRITTEN_ORDER = new Set(["audit_log", "payments", "sales", "cash_handovers", "commission_runs"]);

const excluded = (table: string, column: string): boolean => column === "store_id" || (table === "staff" && column === "pin_hash") || (table === "payments" && VOID_COLUMNS.has(column)) || (WRITTEN_ORDER.has(table) && column === "seq");

const SESSION_PREFIX = "session:";
const FAIL_PREFIX = "loginFails:";
/** Tables whose old side lives in script properties. */
const FROM_PROPERTIES = new Set(["sessions", "login_failures"]);

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");

// ── Fingerprints ───────────────────────────────────────────

export interface SideSnapshot {
  /** Table (or tab) name -> fingerprint of its contents. */
  hashes: Map<string, string>;
  /** Every id-shaped value anywhere on this side. */
  ids: Set<string>;
}

function propertiesWith(props: Record<string, string>, prefix: string): string {
  return JSON.stringify(
    Object.keys(props)
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((k) => [k, props[k]]),
  );
}

export function snapshotOld(old: OldWorld): SideSnapshot {
  const hashes = new Map<string, string>();
  const ids = new Set<string>();
  for (const name of old.tabNames()) {
    const text = JSON.stringify(old.tab(name));
    hashes.set(name, hash(text));
    for (const id of idsIn(text)) ids.add(id);
  }
  const props = old.properties();
  hashes.set("sessions", hash(propertiesWith(props, SESSION_PREFIX)));
  hashes.set("login_failures", hash(propertiesWith(props, FAIL_PREFIX)));
  for (const id of idsIn(JSON.stringify(props))) ids.add(id);
  return { hashes, ids };
}

export async function snapshotNew(appUrl: string): Promise<SideSnapshot> {
  const tables = Object.keys(schema.tables).sort();
  const sql = tables
    .map((t) => `select '${t}'::text as name, coalesce(string_agg(r::text, E'\\n' order by r::text), '') as body from ops."${t}" r`)
    .join(" union all ");
  const db = await connect(appUrl);
  try {
    const rows = await db.query<{ name: string; body: string }>(sql);
    const hashes = new Map<string, string>();
    const ids = new Set<string>();
    for (const r of rows) {
      hashes.set(r.name, hash(r.body));
      for (const id of idsIn(r.body)) ids.add(id);
    }
    return { hashes, ids };
  } finally {
    await db.close();
  }
}

/** Tables that changed on a side without being declared: "config (new side)". */
export function undeclaredChanges(before: { old: SideSnapshot; new: SideSnapshot }, after: { old: SideSnapshot; new: SideSnapshot }, declared: readonly string[]): string[] {
  const out: string[] = [];
  for (const side of ["old", "new"] as const) {
    const names = [...new Set([...before[side].hashes.keys(), ...after[side].hashes.keys()])].sort();
    for (const n of names) {
      if (before[side].hashes.get(n) === after[side].hashes.get(n) || declared.includes(n)) continue;
      const note = side === "old" && !schema.tables[n] ? ", a tab the new schema does not have" : "";
      out.push(`${n} (${side} side${note})`);
    }
  }
  return out;
}

// ── Rows ───────────────────────────────────────────────────

interface View {
  key: string;
  rows: Record<string, unknown>[];
  /** Rows of the old sheet translateTab refused, as diffs. */
  problems: string[];
}

function oldView(old: OldWorld, table: string, now: Date): View | null {
  if (table === "sessions") {
    const props = old.properties();
    const rows = Object.keys(props)
      .filter((k) => k.startsWith(SESSION_PREFIX))
      .map((k) => {
        const s = JSON.parse(props[k] as string) as { staffId?: unknown; expiresAt?: unknown };
        return { token: k.slice(SESSION_PREFIX.length), staff_id: s.staffId ?? null, expires_at: typeof s.expiresAt === "number" ? new Date(s.expiresAt).toISOString() : null };
      })
      .filter(live(now));
    return { key: "token", rows, problems: [] };
  }
  if (table === "login_failures") {
    const props = old.properties();
    const rows = Object.keys(props)
      .filter((k) => k.startsWith(FAIL_PREFIX))
      .map((k) => {
        const f = JSON.parse(props[k] as string) as { count?: unknown; firstFailAt?: unknown; lastFailAt?: unknown };
        const iso = (v: unknown): string | null => (typeof v === "number" ? new Date(v).toISOString() : null);
        return { name_key: k.slice(FAIL_PREFIX.length), count: f.count ?? null, first_failed_at: iso(f.firstFailAt), last_failed_at: iso(f.lastFailAt) };
      });
    return { key: "name_key", rows, problems: [] };
  }
  const t = schema.tables[table];
  if (!t || !old.tabNames().includes(table)) return null;
  const tab = old.tab(table);
  const r = translateTab(table, tab.header, tab.rows, { contract: schema });
  if (r.status !== "ok") return null;
  const pk = t.columns.find((c) => c.primaryKey)?.name as string;
  return { key: pk, rows: r.rows, problems: r.rejects.map((x) => `sheet row ${x.row}, ${x.column}: ${x.reason}`) };
}

async function newView(appUrl: string, table: string, tokens: readonly string[], now: Date): Promise<View | null> {
  const t = schema.tables[table];
  if (!t) return null;
  const db = await connect(appUrl);
  try {
    if (table === "sessions") {
      const byHash = new Map(tokens.map((tok) => [createHash("sha256").update(tok).digest("hex"), tok]));
      const rows = await db.query<{ token_hash: Uint8Array; staff_id: string; expires_at: Date }>("select token_hash, staff_id, expires_at from ops.sessions");
      return {
        key: "token",
        rows: rows
          .map((r) => {
            const hex = Buffer.from(r.token_hash).toString("hex");
            return { token: byHash.get(hex) ?? `(a session whose token the harness never saw: ${hex.slice(0, 8)})`, staff_id: r.staff_id, expires_at: r.expires_at.toISOString() };
          })
          .filter(live(now)),
        problems: [],
      };
    }
    if (table === "login_failures") {
      const rows = await db.query<{ name_key: string; count: number; first_failed_at: Date; last_failed_at: Date }>(
        "select name_key, count(*)::int as count, min(failed_at) as first_failed_at, max(failed_at) as last_failed_at from ops.login_failures group by name_key",
      );
      return {
        key: "name_key",
        rows: rows.map((r) => ({ ...r, first_failed_at: r.first_failed_at.toISOString(), last_failed_at: r.last_failed_at.toISOString() })),
        problems: [],
      };
    }
    if (table === "stores" || table === "staff_stores") return null;
    const pk = t.columns.find((c) => c.primaryKey)?.name as string;
    // VOIDED_PAYMENTS_RULE: what the old side deleted is left out here.
    if (table === "payments") return { key: pk, rows: await db.query<Record<string, unknown>>("select * from ops.payments where voided_at is null"), problems: [] };
    if (table === "payment_items") {
      const rows = await db.query<Record<string, unknown>>("select i.* from ops.payment_items i join ops.payments p on p.payment_id = i.payment_id where p.voided_at is null");
      return { key: pk, rows, problems: [] };
    }
    return { key: pk, rows: await db.query<Record<string, unknown>>(`select * from ops."${table}"`), problems: [] };
  } finally {
    await db.close();
  }
}

/**
 * Both sides' rows of one table, normalised and keyed by primary key.
 *
 * Rows whose key existed before the case are walked first, in key order (the
 * same keys on both sides). Rows keyed by an id generated in this pair are
 * then matched ACROSS the sides by their content with unnumbered ids blanked:
 * a matched pair gets the same number on both sides, so one missing or extra
 * row shows as one difference, not as every later row renumbered. Rows left
 * unmatched are numbered last and show as present on one side only.
 */
function keyedPair(
  views: { old: View; new: View },
  table: string,
  norms: { old: Normaliser; new: Normaliser },
): { old: Map<string, Record<string, unknown>>; new: Map<string, Record<string, unknown>>; duplicates: { side: Side; key: string }[] } {
  const prep = (view: View): Record<string, unknown>[] =>
    view.rows.map((r) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (!excluded(table, k)) o[k] = v;
      return JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
    });
  const out = { old: new Map<string, Record<string, unknown>>(), new: new Map<string, Record<string, unknown>>(), duplicates: [] as { side: Side; key: string }[] };
  const rows = { old: prep(views.old), new: prep(views.new) };
  const keyName = { old: views.old.key, new: views.new.key };
  const keyOf = (side: Side, r: Record<string, unknown>): string => String(r[keyName[side]]);
  const isFresh = (side: Side, r: Record<string, unknown>): boolean => idsIn(keyOf(side, r)).some((id) => norms[side].isGenerated(id));
  const put = (side: Side, r: Record<string, unknown>): void => {
    const n = norms[side].value(r) as Record<string, unknown>;
    const k = String(n[keyName[side]]);
    if (out[side].has(k)) out.duplicates.push({ side, key: k });
    out[side].set(k, n);
  };
  for (const side of SIDES) {
    const fixed = rows[side].filter((x) => !isFresh(side, x));
    fixed.sort((a, b) => (keyOf(side, a) < keyOf(side, b) ? -1 : keyOf(side, a) > keyOf(side, b) ? 1 : 0));
    for (const r of fixed) put(side, r);
  }

  const fresh = { old: new Map<string, Record<string, unknown>[]>(), new: new Map<string, Record<string, unknown>[]>() };
  for (const side of SIDES) {
    for (const r of rows[side].filter((x) => isFresh(side, x))) {
      const sig = JSON.stringify(norms[side].value(r, false));
      fresh[side].set(sig, [...(fresh[side].get(sig) ?? []), r]);
    }
  }
  const leftover: { side: Side; r: Record<string, unknown> }[] = [];
  for (const sig of [...new Set([...fresh.old.keys(), ...fresh.new.keys()])].sort()) {
    const a = fresh.old.get(sig) ?? [];
    const b = fresh.new.get(sig) ?? [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i];
      const y = b[i];
      if (x === undefined || y === undefined) {
        if (x) leftover.push({ side: "old", r: x });
        if (y) leftover.push({ side: "new", r: y });
        continue;
      }
      put("old", x);
      const placeholders = idsIn(keyOf("old", x)).map((id) => norms.old.placeholderOf(id));
      idsIn(keyOf("new", y)).forEach((id, k) => {
        const p = placeholders[k];
        if (p !== undefined) norms.new.adopt(id, p);
      });
      put("new", y);
    }
  }
  for (const l of leftover) put(l.side, l.r);
  return out;
}

type Side = "old" | "new";
const SIDES = ["old", "new"] as const;

export interface TableComparison {
  diffs: Diff[];
  /** Differences found beyond the MAX_DIFFS listed. */
  hidden: number;
  /** Declared tables with nothing on one side to compare against. */
  notCompared: string[];
}

export async function compareTables(opts: {
  tables: readonly string[];
  old: OldWorld;
  appUrl: string;
  norms: { old: Normaliser; new: Normaliser };
  /** Raw tokens seen on the new side (to key its sessions). */
  newTokens: readonly string[];
  /** The case's clock at comparison time (see EXPIRED_SESSIONS_RULE). */
  now: Date;
  exempt: (table: string, column: string) => boolean;
}): Promise<TableComparison> {
  const out: TableComparison = { diffs: [], hidden: 0, notCompared: [] };
  for (const table of opts.tables) {
    const o = oldView(opts.old, table, opts.now);
    const n = await newView(opts.appUrl, table, opts.newTokens, opts.now);
    if (o === null || n === null) {
      out.notCompared.push(`${table}: ${o === null ? "the old app has no such tab" : "the new schema has no such table"}`);
      continue;
    }
    const where = `table ${table}`;
    const found: { path: string; old: string; new: string }[] = [];
    for (const p of o.problems) found.push({ path: "(translation)", old: p, new: "" });
    const pair = keyedPair({ old: o, new: n }, table, opts.norms);
    for (const d of pair.duplicates) found.push({ path: `[${d.key}]`, old: d.side === "old" ? "(this key twice)" : "", new: d.side === "new" ? "(this key twice)" : "" });
    const keys = [...new Set([...pair.old.keys(), ...pair.new.keys()])].sort();
    for (const k of keys) {
      const x = pair.old.get(k);
      const y = pair.new.get(k);
      if (x === undefined || y === undefined) {
        found.push({ path: `[${k}]`, old: x === undefined ? render(MISSING) : render(x), new: y === undefined ? render(MISSING) : render(y) });
        continue;
      }
      const cols = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
      for (const c of cols) {
        if (opts.exempt(table, c) && Object.hasOwn(x, c) && Object.hasOwn(y, c)) continue;
        const sub: { path: string; old: string; new: string }[] = [];
        diffValues(Object.hasOwn(x, c) ? x[c] : MISSING, Object.hasOwn(y, c) ? y[c] : MISSING, "$", sub);
        for (const d of sub) found.push({ ...d, path: `[${k}].${c}` });
      }
    }
    out.diffs.push(...found.slice(0, MAX_DIFFS).map((d) => ({ where, ...d })));
    out.hidden += Math.max(0, found.length - MAX_DIFFS);
  }
  return out;
}
