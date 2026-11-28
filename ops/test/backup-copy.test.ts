// The nightly copy (card P4-06a), against a real database loaded with the repo's fictional fixture and an
// in-memory bucket: the round trip into a second, empty, migrated database (the point of the card), one
// consistent picture, the table list, parts, the manifest, failures, and that a copy only reads.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setPin } from "../src/auth/pin";
import { MANIFEST_NAME, runBackup, type Manifest } from "../src/backup/nightly";
import { restoreNightly } from "../src/backup/restore";
import { EXCLUDED, planCopy, readCatalogue } from "../src/backup/snapshot";
import { backupStorage, memoryBackupBucket, type BackupBucketLike } from "../src/backup/storage";
import { connect } from "../src/db/client";
import { readContract } from "../src/import/load";
import { readDatabase } from "../src/cutover/read-db";
import worker from "../src/index";
import * as audit from "../src/lib/audit";
import { createTestDb, type TestDb } from "./helpers/db";
import { bootFixture, loadFixture } from "./helpers/fixture";
import { copyNow, counts, downloadFolder, dumpAll, manifestOf, nightlyDeps, owner, PEPPER, sha256, type MemoryBucket } from "./helpers/backup";

let src: TestDb;
let target: TestDb;
const live: TestDb[] = [];

const CODEC_DDL = `create table ops.zz_codec (
  id bigint generated always as identity (start with 9007199254740993) primary key,
  note text, amount numeric(12,2), rate numeric(10,4), huge numeric, at timestamptz, day date,
  blob bytea, doc jsonb, flag boolean, n integer, tag uuid)`;

/** One row of every kind of value the copy has to carry, including the awkward ones. */
const CODEC_ROWS = `insert into ops.zz_codec (note, amount, rate, huge, at, day, blob, doc, flag, n, tag) values
  (null, null, null, null, null, null, null, null, null, null, null),
  ('', 12.50, 17.6000, 123456789012345678901234567890.123456, '2026-03-08 00:00:00-05', '2026-03-08', '\\x00ff0a', '{"a": {"b": [1, 2, {"c": null}]}, "d": "x"}', true, 42, '3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
  ('null', -3.25, 0.0000, -0.5, '2026-11-01 00:00:00-04', '2026-11-01', '\\x', 'null', false, -7, null),
  (E'line one\\nline "two"\\r\\n\\\\ back\\\\slash\\ttab \\u2028 \\u2029 and x\\\\u0000y', 0.00, 1.5, 0, '2026-03-08 07:30:15.123457+00', '2026-12-31', null, '{"$json": 1}', null, 0, null)`;

async function ddl(db: TestDb, sql: string): Promise<void> {
  await owner(db, sql);
}

beforeAll(async () => {
  src = await createTestDb();
  target = await createTestDb();
  live.push(src, target);
  await loadFixture(src, bootFixture());
  const conn = await connect(src.appUrl);
  await setPin(conn, "S_001", "1111", PEPPER);
  await conn.close();
  // A table a later migration might add: neither database's code knows it.
  for (const db of [src, target]) await ddl(db, CODEC_DDL);
  await ddl(src, CODEC_ROWS);
  // Card P5-13: emails an assistant has dealt with, one of each outcome, with text the copy has to carry exactly.
  await ddl(src, `insert into ops.assistant_keys (key_id, staff_id, label, key_right, key_hash, created_by, created_at, expires_at)
    values ('ak0000000000000001', 'S_001', 'Fictional Muse', 'propose', decode(repeat('cd', 32), 'hex'), 'S_001', now(), now() + interval '90 days')`);
  await ddl(src, `insert into ops.receipt_emails (email_id, message_id, sender, email_date, subject, outcome, originals, note, key_id, staff_id, first_seen_at, recorded_at) values
    ('re000000000000000000000001', 'inv-1@mail.example.org', 'Fictional Supply <billing@example.org>', '2026-11-26 14:14:00+00', 'Invoice 1042: <b>Nov</b> "quoted" \u2028 x', 'filed', 2, null, 'ak0000000000000001', 'S_001', '2026-11-27 13:00:00+00', '2026-11-27 13:00:00+00'),
    ('re000000000000000000000002', 'promo-9@mail.example.org', 'Fictional Shop <news@example.org>', '2026-11-25 10:00:00+00', null, 'nothing_to_file', 0, 'marketing', 'ak0000000000000001', 'S_001', '2026-11-27 13:01:00+00', '2026-11-27 13:02:00+00'),
    ('re000000000000000000000003', 'bad-3@mail.example.org', 'Fictional Wholesale <ar@example.org>', '2026-11-24 09:00:00+00', 'Statement', 'could_not_read', 0, 'the PDF is password protected', 'ak0000000000000001', 'S_001', '2026-11-27 13:03:00+00', '2026-11-27 13:03:00+00')`);
}, 240_000);

afterAll(async () => {
  await Promise.all(live.map((d) => d.drop()));
});

let first: { bucket: MemoryBucket; folder: string };
async function theFirstCopy(): Promise<{ bucket: MemoryBucket; folder: string }> {
  if (!first) {
    const bucket = memoryBackupBucket();
    const res = await copyNow(src, bucket);
    first = { bucket, folder: res.folder };
  }
  return first;
}

/** Every file of a folder as text, by name. */
function filesOf(bucket: MemoryBucket, folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of bucket.keys()) if (key.startsWith(`${folder}/`)) out[key.slice(folder.length + 1)] = new TextDecoder().decode(bucket.bytes(key) as Uint8Array);
  return out;
}

/** Clone the first row of a table with new values for some columns (never the identity or generated ones). */
async function cloneRow(db: TestDb, table: string, set: Record<string, string>): Promise<void> {
  const c = new pg.Client({ connectionString: db.ownerUrl });
  await c.connect();
  try {
    const cols = (await c.query<{ column_name: string }>(`select column_name from information_schema.columns where table_schema = 'ops' and table_name = $1 and is_identity = 'NO' and is_generated = 'NEVER' order by ordinal_position`, [table])).rows.map((r) => r.column_name);
    const select = cols.map((n) => (n in set ? c.escapeLiteral(set[n] as string) : `"${n}"`)).join(", ");
    await c.query(`insert into ops.${table} (${cols.map((n) => `"${n}"`).join(", ")}) select ${select} from ops.${table} order by 1 limit 1`);
  } finally {
    await c.end();
  }
}

describe("the round trip: copy the fixture database, restore it into an empty one", () => {
  it("every copied table is equal, row for row and value for value, in a second database", async () => {
    const { bucket, folder } = await theFirstCopy();
    const dir = downloadFolder(bucket, folder);
    const lines: string[] = [];
    const report = await restoreNightly({ dir, databaseUrl: target.ownerUrl, out: (l) => lines.push(l) });
    expect(report.outcome).toBe("committed");
    expect(report.finalLine).toMatch(/^every table matches: \d+ tables, \d+ rows, restored and kept\.$/);
    expect(lines[lines.length - 1]).toBe(report.finalLine);

    const manifest = manifestOf(bucket, folder) as Manifest;
    const a = await dumpAll(src.appUrl);
    const b = await dumpAll(target.appUrl);
    // The source has since gained the audit row the copy itself wrote (after its snapshot): it is not in the copy.
    a["audit_log"] = (a["audit_log"] ?? []).filter((r) => !r.includes("\"action\": \"backup."));
    for (const t of manifest.tables) expect(b[t.name], t.name).toEqual(a[t.name]);
    // The tables left out are left empty (the migrations' own seed rows aside).
    for (const e of manifest.excluded) if (e.table !== "schema_migrations") expect(b[e.table]).toEqual([]);
    expect(manifest.tables.find((t) => t.name === "audit_log")?.rows).toBeGreaterThan(100);
    expect(manifest.tables.find((t) => t.name === "sales")?.rows).toBeGreaterThan(20);
  });

  it("the emails an assistant has dealt with (card P5-13) are in the copy and come back exactly: three rows, one of each outcome, awkward text included", async () => {
    const a = await dumpAll(src.appUrl, ["receipt_emails"]);
    const b = await dumpAll(target.appUrl, ["receipt_emails"]);
    expect(a["receipt_emails"]).toHaveLength(3);
    expect(b["receipt_emails"]).toEqual(a["receipt_emails"]);
    const { bucket, folder } = await theFirstCopy();
    const m = manifestOf(bucket, folder) as Manifest;
    expect(m.tables.find((t) => t.name === "receipt_emails")?.rows).toBe(3);
    expect(m.excluded.map((e) => e.table)).not.toContain("receipt_emails");
    const rows = await owner<{ subject: string | null }>(target, "select subject from ops.receipt_emails order by email_id");
    expect(rows[0]?.subject).toBe('Invoice 1042: <b>Nov</b> "quoted" \u2028 x');
  });

  it("the awkward values in the codec table came through exactly (NULL, '', 'null', newlines, U+2028, NUL-like, midnights of both clock changes, bytea, nested JSON, a bigint past 2^53)", async () => {
    const a = await dumpAll(src.appUrl, ["zz_codec"]);
    const b = await dumpAll(target.appUrl, ["zz_codec"]);
    expect(b["zz_codec"]).toEqual(a["zz_codec"]);
    expect(a["zz_codec"]).toHaveLength(4);
    const rows = await owner<{ id: string; note: string | null; at: Date | null }>(target, "select id::text, note, at from ops.zz_codec order by id");
    expect(rows.map((r) => r.id)).toEqual(["9007199254740993", "9007199254740994", "9007199254740995", "9007199254740996"]);
    expect(rows.map((r) => r.note === null ? "NULL" : r.note === "" ? "EMPTY" : r.note === "null" ? "TEXT-NULL" : "TEXT")).toEqual(["NULL", "EMPTY", "TEXT-NULL", "TEXT"]);
    expect(rows[3]?.note).toContain(" ");
    expect(rows[3]?.note).toContain("x\\u0000y");
    expect(rows[1]?.at?.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(rows[2]?.at?.toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });

  it("the cutover comparison's reading of both databases is the same: row counts and every money value", async () => {
    const contract = readContract();
    const read = async (url: string) => {
      const c = new pg.Client({ connectionString: url });
      await c.connect();
      try {
        return await readDatabase(c, contract);
      } finally {
        await c.end();
      }
    };
    const a = await read(src.readUrl);
    const b = await read(target.readUrl);
    expect(Object.keys(b.tables).sort()).toEqual(Object.keys(a.tables).sort());
    const own = a.tables["audit_log"] as { rows: Record<string, string | null>[] };
    own.rows = own.rows.filter((r) => !String(r["action"]).startsWith("backup."));
    for (const name of Object.keys(a.tables)) {
      expect(b.tables[name]?.rows.length, `${name} row count`).toBe(a.tables[name]?.rows.length);
      expect(b.tables[name]?.rows, name).toEqual(a.tables[name]?.rows);
    }
    expect(b.opsOnlyCounts["stores"]).toBe(a.opsOnlyCounts["stores"]);
    expect(b.opsOnlyCounts["staff_stores"]).toBe(a.opsOnlyCounts["staff_stores"]);
    expect(a.tables["sales"]?.rows.length).toBeGreaterThan(20);
  });

  it("identity columns continue after the highest restored one: a new audit row, a new sale and a new codec row get fresh numbers", async () => {
    const maxOf = async (db: TestDb, table: string, col: string): Promise<bigint> => BigInt((await owner<{ m: string }>(db, `select max(${col})::text as m from ops.${table}`))[0]?.m ?? "0");
    const auditMax = await maxOf(target, "audit_log", "seq");
    const salesMax = await maxOf(target, "sales", "seq");
    const codecMax = await maxOf(target, "zz_codec", "id");
    expect(auditMax).toBeGreaterThan(100n);

    const conn = await connect(target.appUrl);
    try {
      await audit.write(conn, { actorId: "SYSTEM", action: "test.after_restore", details: "after the restore" }, { now: new Date("2026-11-28T10:00:00Z") });
    } finally {
      await conn.close();
    }
    await cloneRow(target, "attendance", { attendance_id: "A_AFTER_RESTORE", date: "2099-01-01" });
    await cloneRow(target, "till_sessions", { session_id: "CST-AFTER-RESTORE", attendance_id: "A_AFTER_RESTORE", date: "2099-01-01" });
    await cloneRow(target, "sales", { sales_id: "SALE_AFTER_RESTORE", session_id: "CST-AFTER-RESTORE", date: "2099-01-01" });
    await owner(target, "insert into ops.zz_codec (note) values ('after')");

    expect(BigInt((await owner<{ seq: string }>(target, "select seq::text from ops.audit_log where action = 'test.after_restore'"))[0]?.seq ?? "0")).toBe(auditMax + 1n);
    expect(BigInt((await owner<{ seq: string }>(target, "select seq::text from ops.sales where sales_id = 'SALE_AFTER_RESTORE'"))[0]?.seq ?? "0")).toBe(salesMax + 1n);
    expect(BigInt((await owner<{ id: string }>(target, "select id::text from ops.zz_codec where note = 'after'"))[0]?.id ?? "0")).toBe(codecMax + 1n);
  });

  it("a person can sign in to the restored database with their PIN, through the real sign-in call", async () => {
    const env = { OPS_DB_APP_URL: target.appUrl, PIN_PEPPER: PEPPER };
    const call = (name: string, args: unknown[]) => worker.fetch(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }), env);
    const good = (await (await call("rpcLogin", ["Priya Nair", "1111"])).json()) as { ok: boolean; result: { success: boolean; staffId: string; token: string } };
    expect(good.result, JSON.stringify(good)).toMatchObject({ success: true, staffId: "S_001" });
    const bad = (await (await call("rpcLogin", ["Priya Nair", "9999"])).json()) as { result: { success: boolean } };
    expect(bad.result.success).toBe(false);
    const me = (await (await call("rpcGetMe", [good.result.token])).json()) as { ok: boolean; result: { role: string } };
    expect(me.result.role).toBe("admin");
  });
});

describe("one consistent picture", () => {
  it("a till close committed by another connection while the copy is being read is in the copy completely or not at all (here: not at all)", async () => {
    const db = await createTestDb();
    live.push(db);
    await loadFixture(db, bootFixture());
    const salesBefore = (await owner<{ n: string }>(db, "select count(*)::text as n from ops.sales"))[0]?.n;
    const bucket = memoryBackupBucket();
    let committed = false;
    await copyNow(db, bucket, {
      hooks: {
        // After the very first table is read and written, the store closes a till on another connection.
        afterTable: async () => {
          if (committed) return;
          committed = true;
          await cloneRow(db, "attendance", { attendance_id: "A_MID_COPY", date: "2099-02-02" });
          await cloneRow(db, "till_sessions", { session_id: "CST-MID-COPY", attendance_id: "A_MID_COPY", date: "2099-02-02" });
          await cloneRow(db, "sales", { sales_id: "SALE_MID_COPY", session_id: "CST-MID-COPY", date: "2099-02-02" });
        },
      },
    });
    expect(committed).toBe(true);
    // It did commit: the database has it now.
    expect((await owner<{ n: string }>(db, "select count(*)::text as n from ops.sales"))[0]?.n).toBe(String(Number(salesBefore) + 1));
    // The copy has none of it: the session, the sale or the attendance row.
    const all = Object.values(filesOf(bucket, "nightly/2026-11-27")).join("\n");
    for (const id of ["A_MID_COPY", "CST-MID-COPY", "SALE_MID_COPY"]) expect(all, id).not.toContain(id);
    const m = manifestOf(bucket, "nightly/2026-11-27") as Manifest;
    expect(m.tables.find((t) => t.name === "sales")?.rows).toBe(Number(salesBefore));
  });

  it("the whole copy is one repeatable-read, read-only transaction, and nothing but one audit row is written", async () => {
    const statements: string[] = [];
    const bucket = memoryBackupBucket();
    const before = await dumpAll(src.appUrl);
    const res = await copyNow(src, bucket, {
      openDb: async () => {
        const c = await connect(src.appUrl);
        const rec = (t: string): void => void statements.push(t.trim().replace(/\s+/g, " ").slice(0, 70));
        return {
          query: async (t, p) => (rec(t), c.query(t, p)),
          one: async (t, p) => (rec(t), c.one(t, p)),
          maybeOne: async (t, p) => (rec(t), c.maybeOne(t, p)),
          close: () => c.close(),
        };
      },
    });
    expect(res.ok).toBe(true);
    const begins = statements.map((s, i) => [s, i] as const).filter(([s]) => s === "begin");
    expect(begins).toHaveLength(2); // the copy, then the audit row's own transaction
    expect(statements[(begins[0] as readonly [string, number])[1] + 1]).toBe("set transaction isolation level repeatable read read only");
    const writes = statements.filter((s) => /^(insert|update|delete|truncate|create|alter|drop|grant)/i.test(s));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^insert into ops\.audit_log/);
    // Nothing else moved: the tables are identical, apart from that one audit row.
    const after = await dumpAll(src.appUrl);
    for (const t of Object.keys(before)) {
      if (t === "audit_log") expect(after[t]?.length).toBe((before[t]?.length ?? 0) + 1);
      else expect(after[t], t).toEqual(before[t]);
    }
    const added = (after["audit_log"] ?? []).filter((r) => !(before["audit_log"] ?? []).includes(r));
    expect(added).toHaveLength(1);
    expect(JSON.parse(added[0] as string)).toMatchObject({ action: "backup.nightly", actor_id: "SYSTEM", target_type: "backup", target_id: bucketFolder(bucket) });
  });
});

function bucketFolder(bucket: MemoryBucket): string {
  return bucket.keys()[0]?.split("/").slice(0, 2).join("/") as string;
}

describe("the table list", () => {
  it("every table of schema ops is either copied or on the exceptions list (read from the catalogue)", async () => {
    const { bucket, folder } = await theFirstCopy();
    const conn = await connect(src.appUrl);
    const catalogue = await readCatalogue(conn);
    await conn.close();
    const manifest = manifestOf(bucket, folder) as Manifest;
    const copied = new Set(manifest.tables.map((t) => t.name));
    const excluded = new Set(Object.keys(EXCLUDED));
    for (const t of catalogue) expect(copied.has(t.name) || excluded.has(t.name), `${t.name} is neither copied nor an exception`).toBe(true);
    // An exception names a table that exists, and says why; and the manifest lists exactly them.
    for (const [name, why] of Object.entries(EXCLUDED)) {
      expect(catalogue.some((t) => t.name === name), `exception ${name} is not a table`).toBe(true);
      expect(why.length).toBeGreaterThan(20);
    }
    expect(new Set(manifest.excluded.map((e) => e.table))).toEqual(excluded);
    expect([...copied].sort()).toEqual(catalogue.map((t) => t.name).filter((n) => !excluded.has(n)).sort());
  });

  it("the exceptions are the throwaway ones, and the hashes of PINs and of assistants' keys ARE copied", async () => {
    expect(Object.keys(EXCLUDED).sort()).toEqual(["assistant_calls", "login_failures", "receipt_upload_tickets", "schema_migrations", "sessions"]);
    const { bucket, folder } = await theFirstCopy();
    const files = filesOf(bucket, folder);
    expect(Object.keys(files).some((f) => f.startsWith("staff."))).toBe(true);
    expect(files["staff.0001.ndjson"]).toContain('"pin_hash":"');
    const m = manifestOf(bucket, folder) as Manifest;
    expect(m.tables.find((t) => t.name === "assistant_keys")?.columns.map((c) => c.name)).toContain("key_hash");
  });

  it("no copied table points by foreign key at an excluded one (a restore could not load it)", async () => {
    const conn = await connect(src.appUrl);
    const { copy } = planCopy(await readCatalogue(conn));
    await conn.close();
    for (const t of copy) for (const r of t.references) expect(Object.keys(EXCLUDED), `${t.name} -> ${r.table}`).not.toContain(r.table);
  });

  it("the excepted tables are absent from the files, even when they hold rows", async () => {
    await owner(src, "insert into ops.login_failures (name_key) values ('someone')");
    await owner(src, "insert into ops.sessions (token_hash, staff_id, created_at, expires_at) values (decode(repeat('ab', 32), 'hex'), 'S_001', now(), now() + interval '1 day')");
    try {
      const bucket = memoryBackupBucket();
      const res = await copyNow(src, bucket);
      const names = bucket.keys().map((k) => k.slice(res.folder.length + 1));
      for (const t of Object.keys(EXCLUDED)) expect(names.filter((n) => n.startsWith(`${t}.`)), t).toEqual([]);
      expect(Object.values(filesOf(bucket, res.folder)).join("\n")).not.toContain("someone");
    } finally {
      await owner(src, "delete from ops.login_failures");
      await owner(src, "delete from ops.sessions");
    }
  });

  it("a table created in the database is picked up with no change to the code", async () => {
    const first1 = await theFirstCopy();
    expect((manifestOf(first1.bucket, first1.folder) as Manifest).tables.map((t) => t.name)).toContain("zz_codec");
    await ddl(src, "create table ops.zz_later (k text primary key, v numeric(12,2))");
    await owner(src, "insert into ops.zz_later values ('a', 1.10), ('b', 2.20)");
    try {
      const bucket = memoryBackupBucket();
      const res = await copyNow(src, bucket);
      const m = manifestOf(bucket, res.folder) as Manifest;
      const t = m.tables.find((x) => x.name === "zz_later");
      expect(t?.rows).toBe(2);
      expect(t?.totals.sums).toEqual({ v: "3.30" });
      expect(filesOf(bucket, res.folder)["zz_later.0001.ndjson"]).toBe('{"k":"a","v":"1.10"}\n{"k":"b","v":"2.20"}\n');
    } finally {
      await ddl(src, "drop table ops.zz_later");
    }
  });

  it("a table with no primary key and no seq makes the copy fail loudly, not copy in an unstable order", async () => {
    await ddl(src, "create table ops.zz_nokey (v text)");
    try {
      const bucket = memoryBackupBucket();
      const res = await runBackup(nightlyDeps(src, bucket));
      expect(res).toMatchObject({ ok: false, busy: false });
      expect((res as { reason: string }).reason).toContain("zz_nokey");
      expect(bucket.keys().some((k) => k.endsWith(MANIFEST_NAME))).toBe(false);
    } finally {
      await ddl(src, "drop table ops.zz_nokey");
    }
  });
});

describe("parts", () => {
  it("a table larger than the bound is written in several files that concatenate to the same rows in order", async () => {
    const base = await theFirstCopy();
    const baseFiles = filesOf(base.bucket, base.folder);
    const bucket = memoryBackupBucket();
    const res = await copyNow(src, bucket, { limits: { maxRows: 40, maxBytes: 1 << 30 } });
    const small = filesOf(bucket, res.folder);
    const partsOf = (files: Record<string, string>, table: string) => Object.keys(files).filter((f) => f.startsWith(`${table}.`)).sort();
    const audit1 = partsOf(baseFiles, "audit_log");
    const audit2 = partsOf(small, "audit_log");
    expect(audit1).toHaveLength(1);
    expect(audit2.length).toBeGreaterThan(3);
    expect(audit2.map((f) => f.split(".")[1])).toEqual(audit2.map((_, i) => String(i + 1).padStart(4, "0")));
    // The copies made in between add audit rows at the end: the single-part file is the start of the many-part one.
    const joined = audit2.map((f) => small[f]).join("");
    const baseText = baseFiles[audit1[0] as string] as string;
    let at = 0;
    while (at < baseText.length && joined[at] === baseText[at]) at++;
    expect(at, joined.slice(Math.max(0, at - 80), at + 80) + " <<<>>> " + baseText.slice(Math.max(0, at - 80), at + 80)).toBe(baseText.length);
    for (const f of audit2.slice(0, -1)) expect((small[f] as string).split("\n").length - 1, f).toBe(40);
    // Every table's rows, concatenated, are the same whatever the part size.
    for (const t of (manifestOf(base.bucket, base.folder) as Manifest).tables) {
      if (t.name === "audit_log") continue;
      expect(partsOf(small, t.name).map((f) => small[f]).join(""), t.name).toBe(partsOf(baseFiles, t.name).map((f) => baseFiles[f]).join(""));
    }
  });

  it("memory is bounded by the part: no body put to the bucket is larger than the byte bound plus one row", async () => {
    const bound = 4096;
    const bucket = memoryBackupBucket();
    const res = await copyNow(src, bucket, { limits: { maxRows: 1_000_000, maxBytes: bound } });
    const longestLine = Math.max(...Object.values(filesOf(bucket, res.folder)).flatMap((t) => t.split("\n").map((l) => l.length + 1)));
    // A part closes at the first row end after it has reached the bound, so it can pass it by at most one row.
    const bodies = bucket.keys().filter((k) => !k.endsWith(MANIFEST_NAME)).map((k) => (bucket.bytes(k) as Uint8Array).byteLength);
    expect(Math.max(...bodies)).toBeLessThan(bound + 3 * longestLine);
    expect(Math.max(...bodies)).toBeGreaterThan(bound);
    expect(bodies.length).toBeGreaterThan(40);
    const m = manifestOf(bucket, res.folder) as Manifest;
    for (const f of m.files) expect(f.bytes).toBeLessThan(bound + 3 * longestLine);
    expect(m.partLimits).toEqual({ maxRows: 1_000_000, maxBytes: bound });
  });

  it("with the real bound no part has more than 5000 rows or about 2 MB, and the fixture fits one part per table", async () => {
    const { bucket, folder } = await theFirstCopy();
    const m = manifestOf(bucket, folder) as Manifest;
    expect(m.partLimits).toEqual({ maxRows: 5000, maxBytes: 2 * 1024 * 1024 });
    for (const f of m.files) {
      expect(f.rows).toBeLessThanOrEqual(5000);
      expect(f.bytes).toBeLessThan(2 * 1024 * 1024 + 100_000);
    }
  });
});

describe("the manifest", () => {
  it("is written last, after every file it lists", async () => {
    const order: string[] = [];
    const inner = memoryBackupBucket();
    const recording: BackupBucketLike = { list: (o) => inner.list(o), put: async (k, v, o) => (order.push(k), inner.put(k, v, o)) };
    const res = await runBackup({ ...nightlyDeps(src, null), storage: backupStorage(recording) });
    expect(res.ok).toBe(true);
    expect(order[order.length - 1]).toMatch(/\/manifest\.json$/);
    expect(order.filter((k) => k.endsWith("manifest.json"))).toHaveLength(1);
    expect(order.length).toBeGreaterThan(10);
  });

  it("lists every file with its table, part, rows, byte length and SHA-256, all recomputed here independently", async () => {
    const { bucket, folder } = await theFirstCopy();
    const m = manifestOf(bucket, folder) as Manifest;
    expect(m.format).toBe("storeops-nightly-copy/1");
    expect(m.folder).toBe(folder);
    expect(m.businessDay).toBe("2026-11-27");
    const keys = bucket.keys().filter((k) => k.startsWith(`${folder}/`) && !k.endsWith(MANIFEST_NAME));
    expect(m.files.map((f) => `${folder}/${f.file}`).sort()).toEqual(keys);
    for (const f of m.files) {
      const bytes = bucket.bytes(`${folder}/${f.file}`) as Uint8Array;
      expect(f.bytes, f.file).toBe(bytes.byteLength);
      expect(f.sha256, f.file).toBe(sha256(bytes));
      expect(f.rows, f.file).toBe(new TextDecoder().decode(bytes).split("\n").length - 1);
      expect(f.file).toBe(`${f.table}.${String(f.part).padStart(4, "0")}.ndjson`);
    }
    // Per-table totals: the row count is the database's own, and the money sums are the database's own sums.
    const live = await dumpAll(src.appUrl);
    for (const t of m.tables) {
      // audit_log has gained the rows of the copies made since this one; every other table is as it was.
      if (t.name === "audit_log") expect(t.rows).toBeLessThanOrEqual(live[t.name]?.length ?? 0);
      else expect(t.rows, t.name).toBe(live[t.name]?.length);
      expect(t.totals.rows).toBe(t.rows);
      expect(m.files.filter((f) => f.table === t.name).reduce((n, f) => n + f.rows, 0)).toBe(t.rows);
    }
    const sales = m.tables.find((t) => t.name === "sales") as Manifest["tables"][number];
    const sum = (await owner<{ s: string }>(src, "select sum(cash_sales)::text as s from ops.sales"))[0]?.s;
    expect(Number(sales.totals.sums["cash_sales"])).toBeCloseTo(Number(sum), 2);
    expect(sales.totals.months?.length).toBeGreaterThan(2);
    expect(m.totals.tables).toBe(m.tables.length);
    expect(m.totals.rows).toBe(m.tables.reduce((n, t) => n + t.rows, 0));
    // The newest migration in the folder, read here (not a number that goes stale when a migration is added).
    const newest = Math.max(...readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map((f) => Number(f.slice(0, 4))));
    expect(m.database.newestMigration.version).toBe(newest);
  });

  it("a failure injected at any file leaves no manifest", async () => {
    const probe = memoryBackupBucket();
    const ok = await copyNow(src, probe);
    const total = probe.keys().filter((k) => k.startsWith(`${ok.folder}/`)).length;
    expect(total).toBeGreaterThan(10);
    for (let failAt = 1; failAt <= total; failAt++) {
      const inner = memoryBackupBucket();
      let n = 0;
      const flaky: BackupBucketLike = {
        list: (o) => inner.list(o),
        put: async (k, v, o) => {
          if (++n === failAt) throw new Error("the bucket said no");
          return inner.put(k, v, o);
        },
      };
      const res = await runBackup({ ...nightlyDeps(src, null), storage: backupStorage(flaky) });
      expect(res.ok, `put ${failAt}`).toBe(false);
      expect(inner.keys().some((k) => k.endsWith(MANIFEST_NAME)), `put ${failAt}`).toBe(false);
    }
  }, 120_000);

  it("a second copy the same day goes to a new folder, a third to another, and nothing is overwritten", async () => {
    const bucket = memoryBackupBucket();
    const clock = () => new Date("2026-11-27T20:15:30Z"); // 15:15:30 in Toronto
    const one = await copyNow(src, bucket, { now: clock });
    const keysAfterOne = bucket.keys();
    const hashes = new Map(keysAfterOne.map((k) => [k, sha256(bucket.bytes(k) as Uint8Array)]));
    const two = await copyNow(src, bucket, { now: clock });
    const three = await copyNow(src, bucket, { now: clock });
    expect([one.folder, two.folder, three.folder]).toEqual(["nightly/2026-11-27", "nightly/2026-11-27-151530", "nightly/2026-11-27-151530-2"]);
    for (const [k, h] of hashes) expect(sha256(bucket.bytes(k) as Uint8Array), k).toBe(h);
    expect(bucket.keys().filter((k) => k.startsWith("nightly/2026-11-27/"))).toEqual(keysAfterOne.filter((k) => k.startsWith("nightly/2026-11-27/")));
    // The next night is the next folder.
    const next = await copyNow(src, bucket, { now: () => new Date("2026-11-28T08:00:00Z") });
    expect(next.folder).toBe("nightly/2026-11-28");
  });

  it("a folder a failed copy left behind (files, no manifest) is not written into again", async () => {
    const inner = memoryBackupBucket();
    let n = 0;
    const flaky: BackupBucketLike = { list: (o) => inner.list(o), put: async (k, v, o) => (++n === 4 ? Promise.reject(new Error("no")) : inner.put(k, v, o)) };
    expect((await runBackup({ ...nightlyDeps(src, null), storage: backupStorage(flaky) })).ok).toBe(false);
    const res = await runBackup({ ...nightlyDeps(src, null), storage: backupStorage(inner) });
    expect(res.ok && res.folder).toMatch(/^nightly\/2026-11-27-\d{6}$/);
  });

  it("the storage is never asked to delete: its interface has put and anyUnder only, and no source file of the copy calls a delete", async () => {
    const keys = Object.keys(backupStorage(memoryBackupBucket())).sort();
    expect(keys).toEqual(["anyUnder", "put"]);
    const strict = new Proxy(memoryBackupBucket(), {
      get(target, prop, receiver) {
        if (prop !== "list" && prop !== "put" && typeof prop === "string" && !["keys", "bytes", "puts", "largestPut", "then"].includes(prop)) throw new Error(`the copy touched the bucket's ${prop}`);
        return Reflect.get(target, prop, receiver);
      },
    });
    expect((await runBackup({ ...nightlyDeps(src, strict) })).ok).toBe(true);
    const dir = new URL("../src/backup/", import.meta.url).pathname;
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/\.delete\(|\bdelete\s*\(/);
      expect(text, f).not.toMatch(/\bdelete from\b|\btruncate\b/i);
    }
  });
});
