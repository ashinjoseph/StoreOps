import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/db";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.drop();
});

async function connect(url: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  return c;
}
async function as<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await connect(url);
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const denied = (c: pg.Client, sql: string) =>
  expect(c.query(sql)).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/permission denied/) });

const addStaff = (c: pg.Client, id: string, rate: string | null = null) =>
  c.query(
    "insert into ops.staff (staff_id, name, active, role, hourly_rate) values ($1, 'Fictional Person', true, 'employee', $2)",
    [id, rate],
  );

describe("ops_app", () => {
  it("can insert and read audit_log but not update or delete it", () =>
    as(db.appUrl, async (c) => {
      await c.query("insert into ops.audit_log (log_id, actor_id, action) values ('L1', 'SYSTEM', 'test.insert')");
      expect((await c.query("select action from ops.audit_log where log_id = 'L1'")).rows).toEqual([
        { action: "test.insert" },
      ]);
      await denied(c, "update ops.audit_log set action = 'x' where log_id = 'L1'");
      await denied(c, "delete from ops.audit_log where log_id = 'L1'");
    }));

  it("cannot delete payments", () =>
    as(db.appUrl, async (c) => {
      await addStaff(c, "pay-1");
      await c.query(
        "insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method) values ('P1', 'pay-1', '2026-01-02', 10.00, 'cash')",
      );
      await denied(c, "delete from ops.payments where payment_id = 'P1'");
      expect((await c.query("select 1 from ops.payments where payment_id = 'P1'")).rowCount).toBe(1);
    }));

  it("can delete sessions", () =>
    as(db.appUrl, async (c) => {
      await addStaff(c, "sess-1");
      await c.query(
        "insert into ops.sessions (token_hash, staff_id, expires_at) values (decode(repeat('ab', 32), 'hex'), 'sess-1', now() + interval '1 day')",
      );
      const del = await c.query("delete from ops.sessions where staff_id = 'sess-1'");
      expect(del.rowCount).toBe(1);
    }));

  it("cannot create tables in public or in ops", () =>
    as(db.appUrl, async (c) => {
      await denied(c, "create table public.sneaky (id int)");
      await denied(c, "create table ops.sneaky (id int)");
    }));

  it("can read schema_migrations but not write it", () =>
    as(db.appUrl, async (c) => {
      expect((await c.query("select version from ops.schema_migrations")).rowCount).toBe(1);
      await denied(c, "insert into ops.schema_migrations (version, name, checksum) values (99, 'x', 'y')");
      await denied(c, "update ops.schema_migrations set name = 'x'");
      await denied(c, "delete from ops.schema_migrations");
    }));
});

describe("ops_read", () => {
  it("can select but not insert", () =>
    as(db.readUrl, async (c) => {
      expect((await c.query("select count(*) from ops.staff")).rowCount).toBe(1);
      expect((await c.query("select version from ops.schema_migrations")).rowCount).toBe(1);
      await denied(c, "insert into ops.config (key, value) values ('k', 'v')");
    }));
});

describe("Postgres behaviour the app relies on", () => {
  it("a second FOR UPDATE on the same row waits for the first to commit", async () => {
    await as(db.appUrl, (c) => addStaff(c, "lock-1"));
    const a = await connect(db.appUrl);
    const b = await connect(db.appUrl);
    try {
      await a.query("begin");
      await a.query("select staff_id from ops.staff where staff_id = 'lock-1' for update");
      await b.query("begin");
      let bDone = false;
      const bQuery = b.query("select staff_id from ops.staff where staff_id = 'lock-1' for update").then((r) => {
        bDone = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(bDone).toBe(false);
      await a.query("commit");
      const res = await bQuery;
      expect(res.rows).toEqual([{ staff_id: "lock-1" }]);
      expect(bDone).toBe(true);
      await b.query("commit");
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("a NULL numeric comes back as null, never 0 or '0'", () =>
    as(db.appUrl, async (c) => {
      await addStaff(c, "null-rate", null);
      await addStaff(c, "zero-rate", "0");
      const r = await c.query(
        "select staff_id, hourly_rate from ops.staff where staff_id in ('null-rate', 'zero-rate') order by 1",
      );
      expect(r.rows[0]).toEqual({ staff_id: "null-rate", hourly_rate: null });
      expect(r.rows[1]!.hourly_rate).toBe("0.0000");
    }));
});
