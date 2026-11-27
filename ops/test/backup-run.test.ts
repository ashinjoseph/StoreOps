// The nightly copy as a job and as a button (card P4-06a): what happens when it fails, the scheduled handler
// driven with each cron expression, who may press "Make a copy now", one at a time, and the line the Settings
// screen shows in each state. Small database, invented people.
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setPin } from "../src/auth/pin";
import { AUDIT_FAILED, AUDIT_OK, BACKUP_SCHEDULES, isBackupCron, MANIFEST_NAME, runBackup, runScheduledBackup } from "../src/backup/nightly";
import { lastBackup, STALE_HOURS } from "../src/backup/status";
import { backupStorage, memoryBackupBucket, type BackupBucketLike } from "../src/backup/storage";
import { CRON_SCHEDULES } from "../src/cron";
import { connect, type Db } from "../src/db/client";
import worker from "../src/index";
import { BUSY_MESSAGE } from "../src/rpc/handlers/backup";
import { createTestDb, superuserUrl, type TestDb } from "./helpers/db";
import { nightlyDeps, owner, PEPPER } from "./helpers/backup";

let db: TestDb;
let conn: Db & { close(): Promise<void> };

const STAFF: Array<[string, string, string, string]> = [
  ["S_001", "Ada Quill", "admin", "1111"],
  ["S_002", "Bram Hale", "manager", "2222"],
  ["S_003", "Cleo Marsh", "employee", "3333"],
  ["S_004", "Dara Vance", "payroll_admin", "4444"],
];

beforeAll(async () => {
  db = await createTestDb();
  conn = await connect(db.appUrl);
  for (const [id, name, role, pin] of STAFF) {
    await owner(db, "insert into ops.staff (staff_id, name, active, role, companies_authorized, hourly_rate) values ($1, $2, true, $3, 'cstore,vape', 18.5)", [id, name, role]);
    await setPin(conn, id, pin, PEPPER);
  }
});
afterAll(async () => {
  await conn?.close();
  await db?.drop();
});
beforeEach(async () => {
  await owner(db, "delete from ops.audit_log where action like 'backup.%' or action like 'commissions.%'");
  await owner(db, "delete from ops.sessions");
});

const audits = (like = "backup.%") => owner<{ action: string; actor_id: string | null; target_id: string | null; after: string | null; details: string | null; timestamp: Date }>(db, `select action, actor_id, target_id, after, details, "timestamp" from ops.audit_log where action like $1 order by seq`, [like]);

/** Every connection the app role has open to this database is ended (the database "drops" mid-read). */
async function dropAppConnections(): Promise<void> {
  const u = new URL(superuserUrl());
  u.pathname = `/${db.name}`;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    await c.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and usename = 'ops_app' and pid <> pg_backend_pid()", [db.name]);
  } finally {
    await c.end();
  }
}

const NAMES = STAFF.map((s) => s[1]);

describe("failures", () => {
  it("the bucket refusing a write: backup.failed with a reason and no row content; no manifest; nothing thrown", async () => {
    const inner = memoryBackupBucket();
    let n = 0;
    const refusing: BackupBucketLike = {
      list: (o) => inner.list(o),
      put: async (k, v, o) => {
        if (++n === 3) throw new Error("R2 said no to Ada Quill and 18.50 (10001)");
        return inner.put(k, v, o);
      },
    };
    const logs: object[] = [];
    const res = await runBackup({ ...nightlyDeps(db, null, { log: (e) => void logs.push(e) }), storage: backupStorage(refusing) });
    expect(res).toMatchObject({ ok: false, busy: false });
    expect(inner.keys().some((k) => k.endsWith(MANIFEST_NAME))).toBe(false);
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual([AUDIT_FAILED]);
    expect(rows[0]?.actor_id).toBe("SYSTEM");
    expect(rows[0]?.details).toMatch(/^the bucket refused nightly\/2026-11-27\/[a-z_]+\.0001\.ndjson: Error \(10001\)$/);
    for (const text of [rows[0]?.after, rows[0]?.details, JSON.stringify(logs)]) for (const bit of [...NAMES, "18.50", "18.5", "pin_hash"]) expect(String(text), bit).not.toContain(bit);
  });

  it("the database dropping mid-read: backup.failed is written (on a fresh connection), no manifest, nothing thrown", async () => {
    const bucket = memoryBackupBucket();
    const res = await runBackup(nightlyDeps(db, bucket, { hooks: { afterTable: () => dropAppConnections() } }));
    expect(res).toMatchObject({ ok: false, busy: false });
    expect(bucket.keys().some((k) => k.endsWith(MANIFEST_NAME))).toBe(false);
    const rows = await audits();
    expect(rows.map((r) => r.action)).toEqual([AUDIT_FAILED]);
    expect(rows[0]?.details).toMatch(/^database error/);
  });

  it("the bucket binding missing: backup.failed names the binding, nothing else happens", async () => {
    const res = await runBackup(nightlyDeps(db, null));
    expect(res).toMatchObject({ ok: false, busy: false });
    expect((res as { reason: string }).reason).toContain("BACKUPS");
    expect((await audits()).map((r) => r.action)).toEqual([AUDIT_FAILED]);
  });

  it("a database that cannot be reached at all: failed, returned, never thrown (and nothing to write it to)", async () => {
    const logs: object[] = [];
    const res = await runBackup({ ...nightlyDeps(db, memoryBackupBucket()), openDb: async () => connect(db.appUrl.replace(/:\d+\//, ":1/")), log: (e) => void logs.push(e) });
    expect(res).toMatchObject({ ok: false, busy: false });
    expect(JSON.stringify(logs)).toContain("backup.failed.unrecorded");
  });
});

describe("the scheduled handler", () => {
  const crons = [...BACKUP_SCHEDULES];
  const envWith = (bucket: BackupBucketLike | undefined) => ({ OPS_DB_APP_URL: db.appUrl, PIN_PEPPER: PEPPER, ...(bucket ? { BACKUPS: bucket } : {}) });
  const fire = (cron: string, at: string, env: Record<string, unknown>) => worker.scheduled({ scheduledTime: new Date(at).getTime(), cron }, env as never);

  it("the two nightly crons are the two UTC hours of 03:00 in Toronto, and wrangler.toml lists them with the Monday ones", async () => {
    expect(crons).toEqual(["0 7 * * *", "0 8 * * *"]);
    const { readFileSync } = await import("node:fs");
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const listed = /^crons = \[(.*)\]$/m.exec(toml)?.[1]?.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
    expect(listed).toEqual([...CRON_SCHEDULES, ...BACKUP_SCHEDULES]);
    expect(crons.map((c) => isBackupCron(c))).toEqual([true, true]);
    expect(CRON_SCHEDULES.map((c) => isBackupCron(c))).toEqual([false, false]);
    expect(isBackupCron(undefined)).toBe(false);
  });

  it("exactly one of the two firings is 03:00 in Toronto, every day of two years, clock-change days included", async () => {
    let fired = 0;
    for (let day = Date.UTC(2026, 0, 1); day < Date.UTC(2028, 0, 1); day += 86_400_000) {
      const dueCrons: string[] = [];
      for (const [i, cron] of crons.entries()) {
        let opened = false;
        const out = await runScheduledBackup({ ...nightlyDeps(db, null, { now: () => new Date(day + (7 + i) * 3_600_000) }), openDb: async () => ((opened = true), Promise.reject(new Error("probe"))) });
        if (opened) dueCrons.push(cron);
        else expect(out).toMatchObject({ ran: false });
      }
      expect(dueCrons, new Date(day).toISOString().slice(0, 10)).toHaveLength(1);
      fired++;
    }
    expect(fired).toBe(730);
    await owner(db, "delete from ops.audit_log where action = 'backup.failed'");
  });

  it("summer and winter: 07:00Z is 03:00 in July and 08:00Z is 03:00 in December; the other firing makes no copy and opens no connection", async () => {
    const bucket = memoryBackupBucket();
    await fire("0 8 * * *", "2026-07-15T08:00:00Z", { PIN_PEPPER: PEPPER }); // 04:00 EDT: not due: no database needed
    await fire("0 7 * * *", "2026-12-15T07:00:00Z", { PIN_PEPPER: PEPPER }); // 02:00 EST: not due
    expect(bucket.keys()).toEqual([]);
    await fire("0 7 * * *", "2026-07-15T07:00:00Z", envWith(bucket));
    expect(bucket.keys().filter((k) => k.endsWith(MANIFEST_NAME))).toEqual(["nightly/2026-07-15/manifest.json"]);
    await fire("0 8 * * *", "2026-12-15T08:00:00Z", envWith(bucket));
    expect(bucket.keys().filter((k) => k.endsWith(MANIFEST_NAME))).toEqual(["nightly/2026-07-15/manifest.json", "nightly/2026-12-15/manifest.json"]);
    const rows = await audits(`${AUDIT_OK}`);
    expect(rows.map((r) => [r.actor_id, r.target_id])).toEqual([["SYSTEM", "nightly/2026-07-15"], ["SYSTEM", "nightly/2026-12-15"]]);
  });

  it("a failing copy never throws out of the handler, is audited, and the Monday commission job still runs when its own cron fires", async () => {
    await owner(db, "insert into ops.config (key, value) values ('commission_run_paused', 'true') on conflict (key) do update set value = 'true'");
    try {
      // The copy fails (no bucket bound): the handler resolves.
      await expect(fire(crons[0] as string, "2026-09-28T07:00:00Z", envWith(undefined))).resolves.toBeUndefined();
      expect((await audits()).map((r) => r.action)).toEqual([AUDIT_FAILED]);
      expect(await audits("commissions.%")).toEqual([]);
      // A broken bucket too.
      const broken: BackupBucketLike = { list: async () => Promise.reject(new Error("down")), put: async () => Promise.reject(new Error("down")) };
      await expect(fire(crons[0] as string, "2026-09-28T07:00:00Z", envWith(broken))).resolves.toBeUndefined();
      // Then Monday 09:00 Toronto (13:00Z in September): its own cron runs its own job, and not the copy.
      await fire(CRON_SCHEDULES[0] as string, "2026-09-28T13:00:00Z", envWith(undefined));
      expect((await audits("commissions.%")).map((r) => r.action)).toEqual(["commissions.run_skipped"]);
      expect((await audits()).map((r) => r.action)).toEqual([AUDIT_FAILED, AUDIT_FAILED]);
      // The winter Monday cron, and a firing with no cron name (as before), are the Monday job as well.
      await fire(CRON_SCHEDULES[1] as string, "2026-12-07T14:00:00Z", envWith(undefined));
      await worker.scheduled({ scheduledTime: new Date("2026-12-14T14:00:00Z").getTime() }, envWith(undefined) as never);
      expect((await audits("commissions.%")).map((r) => r.action)).toEqual(["commissions.run_skipped", "commissions.run_skipped", "commissions.run_skipped"]);
    } finally {
      await owner(db, "delete from ops.config where key = 'commission_run_paused'");
    }
  });
});

describe("who may press \"Make a copy now\"", () => {
  const bucket = memoryBackupBucket();
  const env = () => ({ OPS_DB_APP_URL: db.appUrl, PIN_PEPPER: PEPPER, BACKUPS: bucket });
  const rpc = async (name: string, args: unknown[], e: Record<string, unknown> = env()) => {
    const res = await worker.fetch(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }), e);
    return (await res.json()) as { ok: boolean; result?: any; error?: { message: string } };
  };
  const token = async (name: string, pin: string): Promise<string> => ((await rpc("rpcLogin", [name, pin])).result.token as string);

  it("the contract: admin only, with a session", async () => {
    const { readFileSync } = await import("node:fs");
    const ops = JSON.parse(readFileSync(new URL("../contracts/rpc-ops.json", import.meta.url), "utf8")) as { rpcs: { name: string; params: string[]; roles: string[]; needs_session: boolean }[] };
    expect(ops.rpcs.find((r) => r.name === "rpcRunBackupNow")).toEqual({ name: "rpcRunBackupNow", params: ["token"], roles: ["admin"], needs_session: true });
  });

  it("an admin gets a copy and is told in words; a manager, a payroll admin, an employee and no token get nothing", async () => {
    const before = bucket.puts();
    for (const [name, pin, role] of [["Bram Hale", "2222", "manager"], ["Dara Vance", "4444", "payroll_admin"], ["Cleo Marsh", "3333", "employee"]]) {
      const t = await token(name as string, pin as string);
      const res = await rpc("rpcRunBackupNow", [t]);
      expect(res, role).toEqual({ ok: false, error: { message: `FORBIDDEN: requires admin, got ${role}` } });
    }
    expect(await rpc("rpcRunBackupNow", [])).toEqual({ ok: false, error: { message: "NOT_LOGGED_IN" } });
    expect(await rpc("rpcRunBackupNow", ["not-a-token"])).toEqual({ ok: false, error: { message: "NOT_LOGGED_IN" } });
    expect(bucket.puts()).toBe(before);
    expect(await audits()).toEqual([]);

    const admin = await token("Ada Quill", "1111");
    const ok = await rpc("rpcRunBackupNow", [admin]);
    expect(ok.ok).toBe(true);
    expect(ok.result).toMatchObject({ tables: expect.any(Number), rows: expect.any(Number), message: expect.stringMatching(/^Copy made: \d+ tables, \d+ rows, in the folder nightly\/\d{4}-\d{2}-\d{2}/) });
    expect(bucket.keys().some((k) => k.endsWith(MANIFEST_NAME))).toBe(true);
    const rows = await audits();
    expect(rows.map((r) => [r.action, r.actor_id])).toEqual([[AUDIT_OK, "S_001"]]);
  });

  it("an admin whose copy fails is told why in words, and it is audited as failed", async () => {
    const admin = await token("Ada Quill", "1111");
    const res = await rpc("rpcRunBackupNow", [admin], { OPS_DB_APP_URL: db.appUrl, PIN_PEPPER: PEPPER });
    expect(res.ok).toBe(false);
    expect(res.error?.message).toMatch(/^The copy did not finish: the Worker has no BACKUPS bucket bound/);
    expect((await audits()).map((r) => [r.action, r.actor_id])).toEqual([[AUDIT_FAILED, "S_001"]]);
  });

  it("two at once: one runs, the other is refused with words, and the refusal is not a failure", async () => {
    const admin = await token("Ada Quill", "1111");
    const inner = memoryBackupBucket();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let reached: () => void = () => undefined;
    const atGate = new Promise<void>((r) => (reached = r));
    let first = true;
    const slow: BackupBucketLike = {
      list: (o) => inner.list(o),
      put: async (k, v, o) => {
        if (first) {
          first = false;
          reached();
          await gate;
        }
        return inner.put(k, v, o);
      },
    };
    const e = { OPS_DB_APP_URL: db.appUrl, PIN_PEPPER: PEPPER, BACKUPS: slow };
    const one = rpc("rpcRunBackupNow", [admin], e);
    await atGate;
    const two = await rpc("rpcRunBackupNow", [admin], e);
    expect(two).toEqual({ ok: false, error: { message: BUSY_MESSAGE } });
    expect(BUSY_MESSAGE).toMatch(/already being made/);
    release();
    expect((await one).ok).toBe(true);
    expect((await audits()).map((r) => r.action)).toEqual([AUDIT_OK]);
    // And afterwards another may run.
    expect((await rpc("rpcRunBackupNow", [admin], e)).ok).toBe(true);
  });
});

describe("the line on the Settings screen: lastBackup in rpcGetSettings", () => {
  const bucket = memoryBackupBucket();
  const settings = async (env: Record<string, unknown>) => {
    const call = async (name: string, args: unknown[]) =>
      (await (await worker.fetch(new Request(`https://ops.test/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) }), env)).json()) as { ok: boolean; result?: any; error?: { message: string } };
    const t = (await call("rpcLogin", ["Ada Quill", "1111"])).result.token as string;
    return { call, t, get: async () => (await call("rpcGetSettings", [t])).result.lastBackup as Record<string, any> };
  };

  it("a fresh database: never run, a warning, in words", async () => {
    const s = await settings({ OPS_DB_APP_URL: db.appUrl, PIN_PEPPER: PEPPER, BACKUPS: bucket });
    const l = await s.get();
    expect(l).toMatchObject({ state: "never", warn: true, lastGood: null, lastFailure: null });
    expect(l["message"]).toContain("no copy yet");
  });

  it("after a good run: Last copy: <when>, <n> tables, <rows> rows", async () => {
    const s = await settings({ OPS_DB_APP_URL: db.appUrl, PIN_PEPPER: PEPPER, BACKUPS: bucket });
    const run = (await s.call("rpcRunBackupNow", [s.t])).result;
    const l = await s.get();
    expect(l).toMatchObject({ state: "ok", warn: false, lastFailure: null });
    expect(l["lastGood"]).toMatchObject({ tables: run.tables, rows: run.rows, folder: run.folder });
    expect(l["message"]).toMatch(new RegExp(`^Last copy: \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}, ${run.tables} tables, ${run.rows} rows$`));
  });

  it("after a failed run (newer than the good one): a warning with the reason and the good copy's date", async () => {
    const s = await settings({ OPS_DB_APP_URL: db.appUrl, PIN_PEPPER: PEPPER, BACKUPS: bucket });
    await s.call("rpcRunBackupNow", [s.t]);
    const s2 = await settings({ OPS_DB_APP_URL: db.appUrl, PIN_PEPPER: PEPPER });
    const failed = await s2.call("rpcRunBackupNow", [s2.t]);
    expect(failed.ok).toBe(false);
    const l = await s.get();
    expect(l).toMatchObject({ state: "failed", warn: true });
    expect(l["lastFailure"].reason).toContain("BACKUPS");
    expect(l["message"]).toMatch(/^The last copy failed on .*no BACKUPS bucket/);
    expect(l["message"]).toContain("The newest good copy is from");
    // A good copy after it clears the warning.
    await s.call("rpcRunBackupNow", [s.t]);
    expect((await s.get())["state"]).toBe("ok");
  });

  it("37 hours after a good run it is a warning; 36 hours is not yet", async () => {
    const s = await settings({ OPS_DB_APP_URL: db.appUrl, PIN_PEPPER: PEPPER, BACKUPS: bucket });
    await s.call("rpcRunBackupNow", [s.t]);
    const good = (await audits(AUDIT_OK)).at(-1)?.timestamp as Date;
    const c = await connect(db.appUrl);
    const at = (hours: number) => lastBackup(c, new Date(good.getTime() + hours * 3_600_000));
    expect(STALE_HOURS).toBe(36);
    expect((await at(35.9)).state).toBe("ok");
    expect((await at(36)).state).toBe("ok");
    const stale = await at(37);
    expect(stale).toMatchObject({ state: "stale", warn: true });
    expect(stale.message).toMatch(/^The newest good copy is more than 36 hours old \(/);
    await c.close();
  });

  it("the line says nothing about any row: only counts, a folder name and a reason", async () => {
    const c = await connect(db.appUrl);
    const l = await lastBackup(c, new Date());
    await c.close();
    for (const n of NAMES) expect(JSON.stringify(l)).not.toContain(n);
  });
});
