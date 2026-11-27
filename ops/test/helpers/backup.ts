// Shared by the nightly-copy tests (card P4-06a): a copy made against a test database into an in-memory bucket,
// a bucket's folder written to a directory (as a person downloads it), and a way to compare two databases
// table by table, value by value, by asking the database for each row as text.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { connect } from "../../src/db/client";
import { backupStorage, memoryBackupBucket, type BackupBucketLike } from "../../src/backup/storage";
import { runBackup, type NightlyDeps, type NightlyResult } from "../../src/backup/nightly";
import type { TestDb } from "./db";

export const PEPPER = "test-pepper-not-a-secret";

export type MemoryBucket = ReturnType<typeof memoryBackupBucket>;

/** The nightly copy's dependencies against a test database (as the app role, like the Worker) and a bucket. */
export function nightlyDeps(db: TestDb, bucket: BackupBucketLike | null, over: Partial<NightlyDeps> = {}): NightlyDeps {
  return {
    openDb: async () => connect(db.appUrl),
    storage: bucket === null ? null : backupStorage(bucket),
    now: () => new Date("2026-11-27T08:00:00Z"),
    log: () => undefined,
    actorId: "SYSTEM",
    ...over,
  };
}

export async function copyNow(db: TestDb, bucket: BackupBucketLike, over: Partial<NightlyDeps> = {}): Promise<Extract<NightlyResult, { ok: true }>> {
  const res = await runBackup(nightlyDeps(db, bucket, over));
  if (!res.ok) throw new Error(`the copy failed: ${"reason" in res ? res.reason : "busy"}`);
  return res;
}

/** Write one folder of the bucket into a new directory, as a person downloads it. Returns the directory. */
export function downloadFolder(bucket: MemoryBucket, folder: string): string {
  const dir = mkdtempSync(join(tmpdir(), "storeops-copy-"));
  mkdirSync(dir, { recursive: true });
  for (const key of bucket.keys()) {
    if (!key.startsWith(`${folder}/`)) continue;
    writeFileSync(join(dir, key.slice(folder.length + 1)), bucket.bytes(key) as Uint8Array);
  }
  return dir;
}

/** SHA-256 by Node's own crypto: independent of the code under test, which uses the platform's. */
export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Every table of schema ops in the database, with its rows as JSON text, ordered by that text. Same server settings on both sides. */
export async function dumpAll(url: string, only?: readonly string[]): Promise<Record<string, string[]>> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("set timezone = 'UTC'");
    const names = (await c.query<{ relname: string }>(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'ops' and c.relkind = 'r' order by 1`)).rows.map((r) => r.relname);
    const out: Record<string, string[]> = {};
    for (const name of names) {
      if (only && !only.includes(name)) continue;
      const rows = await c.query<{ j: string }>(`select to_jsonb(t)::text as j from ops."${name}" t`);
      out[name] = rows.rows.map((r) => r.j).sort();
    }
    return out;
  } finally {
    await c.end();
  }
}

/** Row counts of every table of schema ops. */
export async function counts(url: string): Promise<Record<string, number>> {
  const dump = await dumpAll(url);
  return Object.fromEntries(Object.entries(dump).map(([k, v]) => [k, v.length]));
}

/** Run SQL as a superuser-ish role (the owner) on a test database. */
export async function owner<T = Record<string, unknown>>(db: TestDb, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: db.ownerUrl });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** The text of a manifest in a bucket. */
export function manifestOf(bucket: MemoryBucket, folder: string): ReturnType<typeof JSON.parse> {
  return JSON.parse(new TextDecoder().decode(bucket.bytes(`${folder}/manifest.json`) as Uint8Array));
}
