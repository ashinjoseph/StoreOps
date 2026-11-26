// The audit log writer, checked against the REAL old src/AuditLog.gs (the oracle):
// the old code is loaded in Node with its Apps Script globals stubbed, and its
// toRow_ output is compared with what the port stores in ops.audit_log.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, DbError, type Db } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { recent, write, writeMany, type AuditDeps, type AuditEntry } from "../src/lib/audit";
import { createTestDb, type TestDb } from "./helpers/db";
import { loadOldUtil } from "./_old-util";

const AUDIT_SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/AuditLog.gs");
const RealDate = Date;
const NOW_MS = RealDate.UTC(2026, 5, 15, 16, 0, 0); // 12:00 in Toronto (EDT)
const NOW = new RealDate(NOW_MS);
const RANDOM = 0.123456789;
const PINNED: AuditDeps = { now: NOW, random: () => RANDOM };

// ---- the old code, loaded for real ----------------------------------------------

const OLD = loadOldUtil();

/** `new Date()` inside AuditLog.gs returns the pinned instant; a Date with arguments is a Date. */
class OldDate {
  constructor(...a: unknown[]) {
    return a.length ? new RealDate(...(a as [number])) : new RealDate(NOW_MS);
  }
}

/** Run the old AuditLog.write once and return the row it hands to setValues (the 9 cells). */
function oldRowFor(entry: Record<string, unknown>): unknown[] {
  const rows: unknown[][] = [];
  const sheet = {
    getLastRow: () => 2,
    getRange: () => ({ setValues: (r: unknown[][]) => void rows.push(...r) }),
  };
  const spreadsheet = { getSheetByName: () => sheet };
  const AuditLog = new Function(
    "Util",
    "SHEETS",
    "SpreadsheetApp",
    "Date",
    readFileSync(AUDIT_SRC, "utf8") + "\n;return AuditLog;",
  )(OLD.Util, { AUDIT_LOG: "audit_log" }, { getActiveSpreadsheet: () => spreadsheet }, OldDate) as {
    write: (e: Record<string, unknown>) => void;
  };
  AuditLog.write(entry);
  const row = rows[0];
  if (!row || row.length !== 9) throw new Error("the old write did not produce one 9-cell row");
  return row;
}

/** What a blank cell reads back as in the sheet is "", and the port stores that as NULL. */
const cellAsText = (v: unknown): string | null => (v === "" ? null : String(v));

// ---- database ---------------------------------------------------------------------

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let other: Db & { close(): Promise<void> };
beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  other = await connect(testDb.appUrl);
});
afterAll(async () => {
  await db?.close();
  await other?.close();
  await testDb?.drop();
});

// Each write that is not pinned to NOW gets its own minute, so ids never collide.
let tick = 0;
const nextDeps = (): AuditDeps => ({ now: new RealDate(NOW_MS + 60_000 * ++tick), random: () => RANDOM });

interface StoredRow {
  log_id: string;
  timestamp: Date;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  before: string | null;
  after: string | null;
  details: string | null;
}
const rowOf = (d: Db, id: string) => d.one<StoredRow>('select * from ops.audit_log where log_id = $1', [id]);

// ---- the samples the card names -----------------------------------------------------

const SAMPLES: ReadonlyArray<{ label: string; value: unknown; json: string | null; text: string | null }> = [
  { label: "object", value: { qty: 2, name: "Fictional Item" }, json: '{"qty":2,"name":"Fictional Item"}', text: "[object Object]" },
  { label: "array", value: [1, "two", null], json: '[1,"two",null]', text: "1,two," },
  { label: "string", value: "plain text", json: '"plain text"', text: "plain text" },
  { label: "number", value: 42, json: "42", text: "42" },
  { label: "zero", value: 0, json: null, text: null },
  { label: "false", value: false, json: null, text: null },
  { label: "empty string", value: "", json: null, text: null },
  { label: "null", value: null, json: null, text: null },
  { label: "undefined", value: undefined, json: null, text: null },
];

type Field = "before" | "after" | "details";
const FIELDS: readonly Field[] = ["before", "after", "details"];

describe("write: the pinned row", () => {
  it("stores every column exactly, with the log id and timestamp pinned", async () => {
    const id = await write(
      db,
      { actorId: "S1", action: "till.open", targetType: "session", targetId: "T1", before: { float: 150 }, after: null, details: "opened" },
      PINNED,
    );
    expect(id).toBe("LOG_20260615_120000_4fzzzxjylr");
    expect(await rowOf(other, id)).toEqual({
      log_id: "LOG_20260615_120000_4fzzzxjylr",
      timestamp: NOW,
      actor_id: "S1",
      action: "till.open",
      target_type: "session",
      target_id: "T1",
      before: '{"float":150}',
      after: null,
      details: "opened",
    });
  });

  it("stores blanks (falsy values) as NULL, and a numeric 0 target id as NULL, as the old code wrote ''", async () => {
    const entry: AuditEntry = { actorId: "", action: "x.blank", targetType: "", targetId: 0, before: "", after: 0, details: false };
    const id = await write(db, entry, nextDeps());
    const row = await rowOf(db, id);
    expect(row).toMatchObject({ actor_id: null, target_type: null, target_id: null, before: null, after: null, details: null });
    expect(oldRowFor(entry as unknown as Record<string, unknown>)).toEqual(expect.arrayContaining(["", ""]));
  });
});

describe("write: before, after and details match the old toRow_", () => {
  for (const field of FIELDS) {
    for (const sample of SAMPLES) {
      it(`${field} = ${sample.label}`, async () => {
        const entry = { actorId: "S1", action: "sample.action", [field]: sample.value };
        const old = oldRowFor(entry);
        const id = await write(db, entry as AuditEntry, nextDeps());
        const stored = (await rowOf(db, id))[field === "before" ? "before" : field === "after" ? "after" : "details"];

        // Compare with the old code's own cell, read back as text.
        const oldCell = old[field === "before" ? 6 : field === "after" ? 7 : 8];
        expect(stored).toBe(cellAsText(oldCell));
        // And with the expected text worked out from the old code by hand.
        const expected = field === "details" ? sample.text : sample.json;
        expect(stored).toBe(expected);
      });
    }
  }
});

describe("missing action", () => {
  it("is written as '' (the old code wrote a blank cell and did not fail); the column is NOT NULL", async () => {
    const entry = { actorId: "S1", targetType: "session", targetId: "T9" };
    const old = oldRowFor(entry);
    expect(old[3]).toBe("");
    const id = await write(db, { ...entry, action: undefined } as unknown as AuditEntry, nextDeps());
    expect(await rowOf(db, id)).toMatchObject({ action: "", target_id: "T9" });
  });
});

describe("writeMany", () => {
  it("writes three rows, with three ids, in one statement", async () => {
    const randoms = [0.1, 0.5, 0.9];
    let r = 0;
    const deps: AuditDeps = { now: new RealDate(NOW_MS + 3_600_000), random: () => randoms[r++] ?? 0 };
    const sent: string[] = [];
    const counting: Db = {
      query: (t, p) => (sent.push(t), db.query(t, p)),
      one: (t, p) => (sent.push(t), db.one(t, p)),
      maybeOne: (t, p) => (sent.push(t), db.maybeOne(t, p)),
    };
    const ids = await writeMany(
      counting,
      [
        { actorId: "S1", action: "product.import", targetType: "product", targetId: "P-1" },
        { actorId: "S1", action: "product.import", targetType: "product", targetId: "P-2" },
        { actorId: "S1", action: "product.import", targetType: "product", targetId: "P-3" },
      ],
      deps,
    );
    expect(sent).toHaveLength(1);
    expect(new Set(ids).size).toBe(3);
    const rows = await other.query<StoredRow>(
      "select * from ops.audit_log where log_id = any($1::text[]) order by target_id",
      [ids],
    );
    expect(rows.map((x) => x.target_id)).toEqual(["P-1", "P-2", "P-3"]);
    expect(new Set(rows.map((x) => x.log_id)).size).toBe(3);
  });

  it("with an empty list sends nothing", async () => {
    let calls = 0;
    const counting: Db = {
      query: async () => (calls++, []),
      one: async () => (calls++, null as never),
      maybeOne: async () => (calls++, null),
    };
    expect(await writeMany(counting, [])).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe("transactions", () => {
  it("an audit row written inside a unit that then throws is rolled back with it", async () => {
    const deps = nextDeps();
    let id = "";
    const caught = await withTransaction(db, async (tx) => {
      id = await write(tx, { actorId: "S1", action: "tx.fails", targetType: "payment", targetId: "PM-1" }, deps);
      throw new Error("the money change failed");
    }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect(await other.maybeOne("select 1 as found from ops.audit_log where log_id = $1", [id])).toBeNull();
  });

  it("without the error the row is there after commit", async () => {
    const deps = nextDeps();
    const id = await withTransaction(db, (tx) =>
      write(tx, { actorId: "S1", action: "tx.ok", targetType: "payment", targetId: "PM-2" }, deps),
    );
    expect(await other.maybeOne("select 1 as found from ops.audit_log where log_id = $1", [id])).not.toBeNull();
  });
});

describe("ops_app cannot change the log", () => {
  it("UPDATE is refused with kind permission", async () => {
    const id = await write(db, { actorId: "S1", action: "immutable.check" }, nextDeps());
    const err = await db.query("update ops.audit_log set action = 'changed' where log_id = $1", [id]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).kind).toBe("permission");
  });

  it("DELETE is refused with kind permission", async () => {
    const id = await write(db, { actorId: "S1", action: "immutable.check" }, nextDeps());
    const err = await db.query("delete from ops.audit_log where log_id = $1", [id]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DbError);
    expect((err as DbError).kind).toBe("permission");
  });
});

describe("recent", () => {
  let rdb: TestDb;
  let r: Db & { close(): Promise<void> };
  beforeAll(async () => {
    rdb = await createTestDb();
    r = await connect(rdb.appUrl);
    // Six rows, oldest first. Each has a distinct target id so results are easy to read.
    const rows: AuditEntry[] = [
      { actorId: "S1", action: "till.open", targetType: "session", targetId: "T1" },
      { actorId: "S2", action: "till.close", targetType: "session", targetId: "T2" },
      { actorId: "S1", action: "payment.undo", targetType: "payment", targetId: "P1" },
      { actorId: "S2", action: "till.open", targetType: "session", targetId: "T3" },
      { actorId: "S1", action: "till.open", targetType: "session", targetId: "T4" },
      { actorId: "S3", action: "product.change", targetType: "product", targetId: "X1" },
    ];
    for (const [i, row] of rows.entries()) {
      await write(r, row, { now: new RealDate(NOW_MS + i * 1000), random: () => RANDOM });
    }
  });
  afterAll(async () => {
    await r?.close();
    await rdb?.drop();
  });

  const ids = (list: { targetId: string | null }[]) => list.map((x) => x.targetId);

  it("returns newest first and the limit applies", async () => {
    expect(ids(await recent(r, 3))).toEqual(["X1", "T4", "T3"]);
  });

  it("with no limit, returns up to 50 newest first", async () => {
    expect(ids(await recent(r))).toEqual(["X1", "T4", "T3", "P1", "T2", "T1"]);
  });

  it("filters by actorId", async () => {
    expect(ids(await recent(r, 10, { actorId: "S1" }))).toEqual(["T4", "P1", "T1"]);
  });

  it("filters by action", async () => {
    expect(ids(await recent(r, 10, { action: "till.open" }))).toEqual(["T4", "T3", "T1"]);
  });

  it("filters by targetType", async () => {
    expect(ids(await recent(r, 10, { targetType: "payment" }))).toEqual(["P1"]);
  });

  it("filters by targetId", async () => {
    expect(ids(await recent(r, 10, { targetId: "T2" }))).toEqual(["T2"]);
  });

  it("combines filters with AND", async () => {
    expect(ids(await recent(r, 10, { actorId: "S2", action: "till.open" }))).toEqual(["T3"]);
  });

  it("an empty filter value is ignored, as the old truthy check did", async () => {
    expect(ids(await recent(r, 2, { actorId: "" }))).toEqual(["X1", "T4"]);
  });

  it("filters apply only to the newest limit x 4 rows, as the old code read a window", async () => {
    // limit 1 reads 4 rows (X1, T4, T3, P1). T1 is older than that, so it is not found.
    expect(ids(await recent(r, 1, { targetId: "T1" }))).toEqual([]);
    expect(ids(await recent(r, 1, { actorId: "S1" }))).toEqual(["T4"]);
  });
});

describe("log ids cannot collide (the old three random characters could)", () => {
  it("5,000 rows written in the same second all get different ids, in three statements", async () => {
    const calls: string[] = [];
    const counting: Db = {
      query: (t, p) => {
        calls.push(t);
        return db.query(t, p);
      },
      one: (t, p) => db.one(t, p),
      maybeOne: (t, p) => db.maybeOne(t, p),
    };
    const sameSecond = new RealDate(NOW_MS + 7 * 86_400_000);
    const entries = Array.from({ length: 5000 }, (_, i) => ({ action: "bulk.test", targetId: `N${i}` }));
    const ids = await writeMany(counting, entries, { now: sameSecond });
    expect(new Set(ids).size).toBe(5000);
    expect(calls.length).toBe(3);
    const stored = await other.one<{ n: number }>("select count(*)::int as n from ops.audit_log where action = 'bulk.test'");
    expect(stored.n).toBe(5000);
    expect(ids[0]).toMatch(/^LOG_\d{8}_\d{6}_[0-9a-z]{8,10}$/);
  });
});
