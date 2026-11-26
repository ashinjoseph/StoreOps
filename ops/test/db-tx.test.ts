import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, DbError, type Db } from "../src/db/client";
import { lockRow, withTransaction, type LockTable } from "../src/db/tx";
import { createTestDb, superuserUrl, type TestDb } from "./helpers/db";

type Conn = Db & { close(): Promise<void> };
let testDb: TestDb;
let db: Conn;
let other: Conn;
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

let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;
const insertStaff = (d: Db, id: string) =>
  d.query("insert into ops.staff (staff_id, name, active, role) values ($1, 'Fictional Person', true, 'employee')", [id]);
const exists = async (d: Db, id: string) => (await d.maybeOne("select 1 as x from ops.staff where staff_id = $1", [id])) !== null;

/** A Db that records the SQL text it is asked to run. */
function spyOn(inner: Db): { spy: Db; sent: string[] } {
  const sent: string[] = [];
  const spy: Db = {
    query: (t, p) => (sent.push(t), inner.query(t, p)),
    one: (t, p) => (sent.push(t), inner.one(t, p)),
    maybeOne: (t, p) => (sent.push(t), inner.maybeOne(t, p)),
  };
  return { spy, sent };
}

describe("withTransaction", () => {
  it("commits when fn resolves, returns its value, and a second connection sees the rows", async () => {
    const id = nextId("tx");
    const result = await withTransaction(db, async (tx) => {
      await insertStaff(tx, id);
      expect(await exists(other, id)).toBe(false); // not visible before commit
      return "done";
    });
    expect(result).toBe("done");
    expect(await exists(other, id)).toBe(true);
  });

  it("rolls everything back when fn throws, and the same error object reaches the caller", async () => {
    const id = nextId("tx");
    const boom = new Error("boom");
    const caught = await withTransaction(db, async (tx) => {
      await insertStaff(tx, id);
      throw boom;
    }).catch((e: unknown) => e);
    expect(caught).toBe(boom);
    expect(await exists(other, id)).toBe(false);
    expect(await exists(db, id)).toBe(false);
    // the connection is usable again afterwards, outside any transaction
    await insertStaff(db, id);
    expect(await exists(other, id)).toBe(true);
  });

  it("a non-Error throw is passed through unchanged too", async () => {
    const thrown = { not: "an error" };
    const caught = await withTransaction(db, async () => {
      throw thrown;
    }).catch((e: unknown) => e);
    expect(caught).toBe(thrown);
  });

  it("nesting throws immediately without sending SQL, and the outer unit is rolled back", async () => {
    const id = nextId("tx");
    const { spy, sent } = spyOn(db);
    let nestedMessage = "";
    const outer = await withTransaction(spy, async (tx) => {
      await insertStaff(tx, id);
      const before = sent.length;
      try {
        await withTransaction(tx, async () => "never");
      } catch (e) {
        nestedMessage = (e as Error).message;
        expect(sent.length).toBe(before);
        throw e;
      }
    }).catch((e: unknown) => e);
    expect(nestedMessage).toMatch(/nest/i);
    expect(outer).toBeInstanceOf(Error);
    expect(await exists(other, id)).toBe(false);
  });

  it("after a failed statement the whole unit is rolled back, even if fn swallows the error", async () => {
    const good = nextId("tx");
    const caught = await withTransaction(db, async (tx) => {
      await insertStaff(tx, good);
      await tx
        .query("insert into ops.staff (staff_id, name, active, role) values ($1, null, true, 'employee')", [nextId("tx")])
        .catch(() => undefined);
      return "swallowed";
    }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/rolled back/);
    expect(((caught as Error).cause as DbError).kind).toBe("not_null");
    expect(await exists(other, good)).toBe(false);
    expect(await exists(db, good)).toBe(false);
  });

  it("a failed statement that fn does not catch surfaces as the DbError itself", async () => {
    const good = nextId("tx");
    const caught = await withTransaction(db, async (tx) => {
      await insertStaff(tx, good);
      await insertStaff(tx, good);
    }).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(DbError);
    expect((caught as DbError).kind).toBe("unique");
    expect(await exists(other, good)).toBe(false);
  });

  it("if the commit itself fails, the error surfaces and nothing is kept", async () => {
    // No constraint here is deferred, so make COMMIT fail by terminating the backend first.
    const victim = await connect(testDb.appUrl);
    const id = nextId("tx");
    const pid = (await victim.one<{ pid: number }>("select pg_backend_pid() as pid")).pid;
    let killed = false;
    const caught = await withTransaction(victim, async (tx) => {
      await insertStaff(tx, id);
      const killer = new pg.Client({ connectionString: superuserUrl() });
      await killer.connect();
      await killer.query("select pg_terminate_backend($1)", [pid]);
      await killer.end();
      killed = true;
      await new Promise((r) => setTimeout(r, 200));
    }).catch((e: unknown) => e);
    expect(killed).toBe(true); // fn ran to the end, so the failure is the commit's
    expect(caught).toBeInstanceOf(DbError);
    expect(await exists(other, id)).toBe(false);
    await victim.close().catch(() => undefined);
  });

  it("the tx handle stops working once the unit is finished", async () => {
    let leaked: Db | undefined;
    await withTransaction(db, async (tx) => {
      leaked = tx;
    });
    await expect(leaked!.query("select 1")).rejects.toThrow(/finished/);
  });

  it("one and maybeOne work on the tx handle", async () => {
    const id = nextId("tx");
    await withTransaction(db, async (tx) => {
      await insertStaff(tx, id);
      expect((await tx.one<{ staff_id: string }>("select staff_id from ops.staff where staff_id = $1", [id])).staff_id).toBe(id);
      expect(await tx.maybeOne("select 1 where false")).toBeNull();
    });
  });
});

describe("lockRow", () => {
  it("a second connection's lock waits (300 ms) and resolves after the first commits", async () => {
    const id = nextId("lock");
    await insertStaff(db, id);
    const first = await connect(testDb.appUrl);
    const second = await connect(testDb.appUrl);
    try {
      let releaseFirst!: () => void;
      const hold = new Promise<void>((r) => (releaseFirst = r));
      let firstLocked!: () => void;
      const locked = new Promise<void>((r) => (firstLocked = r));
      const a = withTransaction(first, async (tx) => {
        expect(await lockRow(tx, "staff", id)).toBe(true);
        firstLocked();
        await hold;
      });
      await locked;
      let secondDone = false;
      const b = withTransaction(second, async (tx) => {
        const got = await lockRow(tx, "staff", id);
        secondDone = true;
        return got;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(secondDone).toBe(false);
      releaseFirst();
      await a;
      expect(await b).toBe(true);
      expect(secondDone).toBe(true);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("returns false for a missing row, true for a present one", async () => {
    const id = nextId("lock");
    await insertStaff(db, id);
    await withTransaction(db, async (tx) => {
      expect(await lockRow(tx, "staff", "nobody-here")).toBe(false);
      expect(await lockRow(tx, "staff", id)).toBe(true);
    });
  });

  it("every listed table is locked by its own key", async () => {
    const tables: LockTable[] = ["staff", "till_sessions", "attendance", "bonuses", "payments", "cash_handovers"];
    await withTransaction(db, async (tx) => {
      for (const t of tables) expect(await lockRow(tx, t, "no-such-id")).toBe(false);
    });
  });

  it("throws outside a transaction, before sending any SQL", async () => {
    const { spy, sent } = spyOn(db);
    await expect(lockRow(spy, "staff", "x")).rejects.toThrow(/transaction/i);
    expect(sent).toEqual([]);
  });

  it("an unknown table (forced past the type) throws without running SQL", async () => {
    const { spy, sent } = spyOn(db);
    await withTransaction(spy, async (tx) => {
      const before = sent.length;
      for (const bad of ["audit_log", "staff; drop table ops.staff", "constructor", "__proto__", "toString", ""]) {
        await expect(lockRow(tx, bad as unknown as LockTable, "x")).rejects.toThrow(/cannot lock/i);
      }
      expect(sent.length).toBe(before);
    });
  });
});
