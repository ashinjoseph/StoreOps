// The restore tool (card P4-06a): what it refuses before it writes anything, that a refusal leaves the database
// exactly as it was (one transaction), that a difference is reported and nothing is kept, and the tool's own
// exit codes and last line. A small database with invented people; the fixture round trip is in backup-copy.test.ts.
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setPin } from "../src/auth/pin";
import { MANIFEST_NAME, type Manifest } from "../src/backup/nightly";
import { isLocalUrl, parseManifest, restoreNightly, RestoreRefused } from "../src/backup/restore";
import { memoryBackupBucket } from "../src/backup/storage";
import { connect } from "../src/db/client";
import { main, parseArgs, REMOTE_FLAG } from "../tools/restore-nightly";
import { createTestDb, type TestDb } from "./helpers/db";
import { copyNow, downloadFolder, dumpAll, owner, PEPPER, sha256 } from "./helpers/backup";

let src: TestDb;
let folder: string;
const live: TestDb[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  src = await createTestDb();
  live.push(src);
  const c = await connect(src.appUrl);
  for (const [id, name, role, pin, rate] of [["S_001", "Ada Quill", "admin", "1111", "0"], ["S_002", "Bram Hale", "employee", "2222", "17.6000"]] as const) {
    await owner(src, "insert into ops.staff (staff_id, name, active, role, companies_authorized, hourly_rate) values ($1, $2, true, $3, 'cstore,vape', $4)", [id, name, role, rate]);
    await setPin(c, id, pin, PEPPER);
  }
  await c.close();
  await owner(src, "insert into ops.attendance (attendance_id, staff_id, date, status, hours_worked, rate_at_attendance) values ('A_1', 'S_002', '2026-11-02', 'worked', 7.50, 17.6000), ('A_2', 'S_002', '2026-11-03', 'worked', 8.25, 17.6000)");
  const bucket = memoryBackupBucket();
  const res = await copyNow(src, bucket);
  folder = downloadFolder(bucket, res.folder);
  dirs.push(folder);
}, 60_000);

afterAll(async () => {
  await Promise.all(live.map((d) => d.drop()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

let target: TestDb;
let fresh: Record<string, string[]>;
beforeEach(async () => {
  target = await createTestDb();
  live.push(target);
  fresh = await dumpAll(target.ownerUrl);
});

/** A copy of the folder to damage. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "storeops-damaged-"));
  dirs.push(dir);
  for (const f of readdirSync(folder)) copyFileSync(join(folder, f), join(dir, f));
  return dir;
}
const manifestIn = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, MANIFEST_NAME), "utf8")) as Manifest;
const writeManifest = (dir: string, m: Manifest): void => writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify(m, null, 2));

async function refused(dir: string, message: RegExp, url = target.ownerUrl): Promise<void> {
  await expect(restoreNightly({ dir, databaseUrl: url })).rejects.toThrow(RestoreRefused);
  await expect(restoreNightly({ dir, databaseUrl: url })).rejects.toThrow(message);
  // One transaction: the database is exactly as it was, empty but for what the migrations put there.
  expect(await dumpAll(target.ownerUrl)).toEqual(fresh);
}

describe("it refuses, and leaves the database exactly as it was", () => {
  it("a folder with no manifest (an incomplete copy)", async () => {
    const dir = scratch();
    rmSync(join(dir, MANIFEST_NAME));
    await refused(dir, /no manifest\.json: it is an incomplete copy/);
  });

  it("a file missing", async () => {
    const dir = scratch();
    const gone = manifestIn(dir).files[0] as Manifest["files"][number];
    rmSync(join(dir, gone.file));
    await refused(dir, new RegExp(`${gone.file.replace(".", "\\.")} is missing`));
  });

  it("a file one byte different (same length, one character changed)", async () => {
    const dir = scratch();
    const f = manifestIn(dir).files.find((x) => x.table === "staff") as Manifest["files"][number];
    const bytes = Buffer.from(readFileSync(join(dir, f.file)));
    const at = bytes.indexOf("Ada Quill");
    bytes[at] = bytes[at] === 0x41 ? 0x42 : 0x41;
    writeFileSync(join(dir, f.file), bytes);
    expect(readFileSync(join(dir, f.file)).byteLength).toBe(f.bytes);
    await refused(dir, /right length but its SHA-256 is not the manifest's/);
  });

  it("a file shorter than the manifest says", async () => {
    const dir = scratch();
    const f = manifestIn(dir).files.find((x) => x.table === "staff") as Manifest["files"][number];
    writeFileSync(join(dir, f.file), readFileSync(join(dir, f.file)).subarray(0, f.bytes - 5));
    await refused(dir, /the manifest says/);
  });

  it("an extra file, and an extra folder", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "notes.txt"), "hello");
    await refused(dir, /holds notes\.txt, which the manifest does not list/);
    rmSync(join(dir, "notes.txt"));
    const other = scratch();
    writeFileSync(join(other, "staff.0002.ndjson"), "");
    await refused(other, /holds staff\.0002\.ndjson, which the manifest does not list/);
  });

  it("a manifest that is not one", async () => {
    const dir = scratch();
    writeFileSync(join(dir, MANIFEST_NAME), "{ not json");
    await refused(dir, /not valid JSON/);
    writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify({ format: "something-else/1" }));
    await refused(dir, /not a nightly copy's manifest/);
    expect(() => parseManifest(JSON.stringify({ ...manifestIn(folder), files: [{ file: "../x.0001.ndjson", table: "x", part: 1, rows: 0, bytes: 0, sha256: "0".repeat(64) }] }))).toThrow(RestoreRefused);
  });

  it("a database that is not empty", async () => {
    await owner(target, "insert into ops.staff (staff_id, name, active, role, companies_authorized) values ('S_X', 'Someone Else', true, 'employee', 'cstore')");
    const before = await dumpAll(target.ownerUrl);
    await expect(restoreNightly({ dir: folder, databaseUrl: target.ownerUrl })).rejects.toThrow(/not empty \(staff hold rows\)/);
    expect(await dumpAll(target.ownerUrl)).toEqual(before);
  });

  it("a database that has only a seeded table changed is still refused when another table holds a row; seed rows alone are fine", async () => {
    await owner(target, "insert into ops.stores (id, code, name, active) values ('store_2', 'S2', 'Second', true)");
    await expect(restoreNightly({ dir: folder, databaseUrl: target.ownerUrl })).rejects.toThrow(/not empty \(stores hold rows\)/);
  });

  it("a database on an older migration than the copy's, and one with a different migration file", async () => {
    const dir = scratch();
    const m = manifestIn(dir);
    const here = m.database.newestMigration.version;
    m.database.newestMigration.version += 1;
    writeManifest(dir, m);
    await refused(dir, new RegExp(`newest migration is ${here}, older than the copy's ${here + 1}`));

    const dir2 = scratch();
    const m2 = manifestIn(dir2);
    m2.database.newestMigration.checksum = "0".repeat(64);
    writeManifest(dir2, m2);
    await refused(dir2, new RegExp(`migration ${here} is not the same file as the copy's`));

    await owner(target, `delete from ops.schema_migrations where version = ${here}`);
    fresh = await dumpAll(target.ownerUrl);
    await refused(folder, new RegExp(`newest migration is ${here - 1}, older than the copy's ${here}`));
  });

  it("a database that has not been migrated at all", async () => {
    await owner(target, "drop table ops.schema_migrations");
    fresh = await dumpAll(target.ownerUrl);
    await refused(folder, /has not been migrated/);
  });

  it("a database whose table is not the copy's (a column of another type)", async () => {
    await owner(target, "alter table ops.staff alter column notes type varchar(10)");
    fresh = await dumpAll(target.ownerUrl);
    await refused(folder, /staff\.notes is character varying\(10\), the copy's is text/);
  });

  it("a database that is not on this computer, unless the flag with the warning for a name is given", async () => {
    expect(isLocalUrl("postgres://u:p@127.0.0.1:5432/db")).toBe(true);
    expect(isLocalUrl("postgres://u:p@localhost/db")).toBe(true);
    expect(isLocalUrl("postgres://u:p@db.example.com/db")).toBe(false);
    expect(isLocalUrl("postgres:///db?host=/var/run/postgresql")).toBe(false);
    await expect(restoreNightly({ dir: folder, databaseUrl: "postgres://u:p@db.example.com/db" })).rejects.toThrow(/not on this computer/);
  });
});

describe("what a good restore does", () => {
  it("loads, prints a line per table and ends with one line; the tables are equal; and a second restore into it is refused (it is no longer empty)", async () => {
    const lines: string[] = [];
    const report = await restoreNightly({ dir: folder, databaseUrl: target.ownerUrl, out: (l) => lines.push(l) });
    expect(report.outcome).toBe("committed");
    expect(lines[lines.length - 1]).toMatch(/^every table matches: \d+ tables, \d+ rows, restored and kept\.$/);
    expect(lines.some((l) => /^staff\s+rows\s+2 of 2\s+ok$/.test(l))).toBe(true);
    // The sums are printed as restored against the copy's: 7.50 + 8.25 hours.
    expect(lines.some((l) => /^\s+hours_worked\s+15\.75\s+copy 15\.75$/.test(l))).toBe(true);
    // Nothing a row held is printed.
    for (const l of lines) for (const v of ["Ada Quill", "Bram Hale", "pin_hash"]) expect(l).not.toContain(v);
    const a = await dumpAll(src.appUrl);
    const b = await dumpAll(target.appUrl);
    a["audit_log"] = (a["audit_log"] ?? []).filter((r) => !r.includes('"action": "backup.'));
    for (const t of manifestIn(folder).tables) expect(b[t.name], t.name).toEqual(a[t.name]);
    await expect(restoreNightly({ dir: folder, databaseUrl: target.ownerUrl })).rejects.toThrow(/not empty/);
  });

  it("a dry run does everything and keeps nothing", async () => {
    const lines: string[] = [];
    const report = await restoreNightly({ dir: folder, databaseUrl: target.ownerUrl, dryRun: true, out: (l) => lines.push(l) });
    expect(report.outcome).toBe("dry-run");
    expect(lines[lines.length - 1]).toMatch(/^dry run: every table matches \(\d+ tables, \d+ rows\); everything was done and rolled back, nothing was kept\.$/);
    expect(await dumpAll(target.ownerUrl)).toEqual(fresh);
  });

  it("a copy whose rows do not add up to its own totals is reported, with what differs, and nothing is kept", async () => {
    // Change a figure in a file and make the manifest agree with the file (length and SHA-256), but leave the totals
    // the copy recorded when it was made: the files are internally consistent, the totals are not.
    const dir = scratch();
    const m = manifestIn(dir);
    const f = m.files.find((x) => x.table === "attendance") as Manifest["files"][number];
    const text = readFileSync(join(dir, f.file), "utf8");
    const changed = text.replace(/"hours_worked":"\d+\.\d+"/, '"hours_worked":"99.00"');
    expect(changed).not.toBe(text);
    writeFileSync(join(dir, f.file), changed);
    f.bytes = Buffer.byteLength(changed);
    f.sha256 = sha256(Buffer.from(changed));
    writeManifest(dir, m);
    const lines: string[] = [];
    const report = await restoreNightly({ dir, databaseUrl: target.ownerUrl, out: (l) => lines.push(l) });
    expect(report.outcome).toBe("not-restored");
    expect(report.differences.join(" ")).toContain("attendance: sums differ in hours_worked");
    expect(lines[lines.length - 1]).toMatch(/^NOT RESTORED: .*attendance: sums differ in hours_worked.*Nothing was kept\.$/);
    expect(await dumpAll(target.ownerUrl)).toEqual(fresh);
  });
});

describe("the tool", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) } };
  };

  it("arguments: one folder, --dry-run, the warning flag; anything else is wrong usage", () => {
    expect(parseArgs(["x"])).toEqual({ dir: "x", dryRun: false, allowRemote: false });
    expect(parseArgs(["x", "--dry-run"])).toEqual({ dir: "x", dryRun: true, allowRemote: false });
    expect(parseArgs(["x", REMOTE_FLAG])).toMatchObject({ allowRemote: true });
    expect(typeof parseArgs([])).toBe("string");
    expect(typeof parseArgs(["a", "b"])).toBe("string");
    expect(typeof parseArgs(["a", "--force"])).toBe("string");
    expect(REMOTE_FLAG).toMatch(/not-on-this-computer/);
  });

  it("exit 2 with no database set or no folder; exit 1 for a database that is not local, before anything is read", async () => {
    const a = io();
    expect(await main([folder], {}, a.io)).toBe(2);
    expect(a.err.join("\n")).toContain("OPS_DB_OWNER_URL");
    const b = io();
    expect(await main([], { OPS_DB_OWNER_URL: target.ownerUrl }, b.io)).toBe(2);
    const c = io();
    expect(await main([folder], { OPS_DB_OWNER_URL: "postgres://u:p@db.example.com:5432/x" }, c.io)).toBe(1);
    expect(c.err.join("\n")).toContain("not on this computer");
    expect(c.out).toEqual([]);
  });

  it("exit 1 and the reason, with no value in it, when the folder is refused; the owner URL or the superuser URL both work", async () => {
    const dir = scratch();
    rmSync(join(dir, MANIFEST_NAME));
    const a = io();
    expect(await main([dir], { OPS_DB_OWNER_URL: target.ownerUrl }, a.io)).toBe(1);
    expect(a.err.join("\n")).toMatch(/^restore-nightly: this folder has no manifest\.json.*Nothing was written\.$/);
    expect(a.err.join("\n")).not.toContain(target.ownerUrl);
  });

  it("exit 0 and the last line on a good restore (a dry run first, then for real, with the superuser's URL)", async () => {
    const dry = io();
    expect(await main([folder, "--dry-run"], { OPS_DB_OWNER_URL: target.ownerUrl }, dry.io)).toBe(0);
    expect(dry.out[dry.out.length - 1]).toMatch(/^dry run: every table matches/);
    const real = io();
    expect(await main([folder], { OPS_DB_SUPERUSER_URL: target.ownerUrl }, real.io)).toBe(0);
    expect(real.out[real.out.length - 1]).toMatch(/^every table matches: \d+ tables, \d+ rows, restored and kept\.$/);
    expect(real.err).toEqual([]);
  });

  it("exit 1 when a table does not match", async () => {
    const dir = scratch();
    const m = manifestIn(dir);
    const f = m.files.find((x) => x.table === "attendance") as Manifest["files"][number];
    const text = readFileSync(join(dir, f.file), "utf8").replace(/"hours_worked":"\d+\.\d+"/, '"hours_worked":"98.00"');
    writeFileSync(join(dir, f.file), text);
    f.bytes = Buffer.byteLength(text);
    f.sha256 = sha256(Buffer.from(text));
    writeManifest(dir, m);
    const a = io();
    expect(await main([dir], { OPS_DB_OWNER_URL: target.ownerUrl }, a.io)).toBe(1);
    expect(a.out[a.out.length - 1]).toMatch(/^NOT RESTORED: /);
  });
});
