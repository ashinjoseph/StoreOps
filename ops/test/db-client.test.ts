import { execFileSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, DbError, fromClient, type Db } from "../src/db/client";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
});
afterAll(async () => {
  await db?.close();
  await testDb?.drop();
});

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

async function addStaff(
  fields: { rate?: number | null; notes?: string | null; active?: boolean; start?: string | null; created?: Date | null } = {},
) {
  const id = nextId("st");
  await db.query(
    `insert into ops.staff (staff_id, name, active, role, hourly_rate, notes, start_date, created_at)
     values ($1, 'Fictional Person', $2, 'employee', $3, $4, $5, $6)`,
    [id, fields.active ?? true, fields.rate ?? null, fields.notes ?? null, fields.start ?? null, fields.created ?? null],
  );
  return id;
}

async function addPayment(staffId: string, amount: number, paidOn = "2026-01-02") {
  const id = nextId("pay");
  await db.query(
    "insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method) values ($1, $2, $3, $4, 'cash')",
    [id, staffId, paidOn, amount],
  );
  return id;
}

describe("numeric becomes a number, NULL stays null", () => {
  const cases: number[] = [0, 0.01, -0.01, 1234567.89, 9999999999.99, Math.round((0.1 + 0.2) * 100) / 100];
  it.each(cases)("money %s round-trips to the cent", async (amount) => {
    const staff = await addStaff();
    const id = await addPayment(staff, amount);
    const row = await db.one<{ total_amount: number }>("select total_amount from ops.payments where payment_id = $1", [id]);
    expect(typeof row.total_amount).toBe("number");
    expect(row.total_amount).toBe(amount);
  });

  it("the stored text of a big amount is exactly what the number prints", async () => {
    const staff = await addStaff();
    const id = await addPayment(staff, 9999999999.99);
    const row = await db.one<{ t: string }>("select total_amount::text as t from ops.payments where payment_id = $1", [id]);
    expect(row.t).toBe("9999999999.99");
  });

  it("a numeric(10,4) rate keeps its four decimals", async () => {
    const staff = await addStaff({ rate: 17.3333 });
    const row = await db.one<{ hourly_rate: number }>("select hourly_rate from ops.staff where staff_id = $1", [staff]);
    expect(row.hourly_rate).toBe(17.3333);
  });

  it("a NULL numeric is null, not 0 and not a string; a stored 0 is 0", async () => {
    const none = await addStaff({ rate: null });
    const zero = await addStaff({ rate: 0 });
    const rows = await db.query<{ staff_id: string; hourly_rate: number | null }>(
      "select staff_id, hourly_rate from ops.staff where staff_id in ($1, $2) order by staff_id",
      [none, zero],
    );
    const byId = new Map(rows.map((r) => [r.staff_id, r.hourly_rate]));
    expect(byId.get(none)).toBeNull();
    expect(byId.get(zero)).toBe(0);
  });

  it("computed numerics (sum) also arrive as numbers; an empty sum is null", async () => {
    const staff = await addStaff();
    await addPayment(staff, 10.1);
    await addPayment(staff, 20.2);
    const r = await db.one<{ s: number }>("select sum(total_amount) as s from ops.payments where staff_id = $1", [staff]);
    expect(r.s).toBeCloseTo(30.3, 10);
    const e = await db.one<{ s: number | null }>("select sum(total_amount) as s from ops.payments where staff_id = $1", ["nobody"]);
    expect(e.s).toBeNull();
  });

  it("a numeric NaN from the database is refused rather than handed on", async () => {
    await expect(db.query("select 'NaN'::numeric as v")).rejects.toThrow(/numeric/i);
  });
});

describe("date is the string as stored", () => {
  it("returns YYYY-MM-DD, never a Date", async () => {
    const staff = await addStaff({ start: "2026-03-08" });
    const row = await db.one<{ start_date: unknown }>("select start_date from ops.staff where staff_id = $1", [staff]);
    expect(row.start_date).toBe("2026-03-08");
  });

  it("a NULL date is null", async () => {
    const staff = await addStaff({ start: null });
    const row = await db.one<{ start_date: unknown }>("select start_date from ops.staff where staff_id = $1", [staff]);
    expect(row.start_date).toBeNull();
  });

  // Vitest cannot change process.env.TZ mid-process, so each zone gets a real
  // child process (Node 22, TypeScript stripped) that uses the client.
  it("is the same string under three process time zones, including the clock-change days", async () => {
    const staff = await addStaff();
    const days = ["2026-03-08", "2026-11-01", "2026-12-31", "2026-01-01"];
    const ids: string[] = [];
    for (const d of days) ids.push(await addPayment(staff, 1.5, d));
    const clientUrl = new URL("../src/db/client.ts", import.meta.url).href;
    const script = `
      const { connect } = await import(${JSON.stringify(clientUrl)});
      const db = await connect(process.env.URL);
      const rows = await db.query("select paid_on from ops.payments where payment_id = any($1) order by paid_on", [JSON.parse(process.env.IDS)]);
      const lit = await db.one("select date '2026-03-08' as a, date '2026-11-01' as b, $1::date as c", ["2026-03-08"]);
      const ts = await db.one("select '2026-03-08 06:30:00+00'::timestamptz as t");
      console.log(JSON.stringify({ offset: new Date(2026, 2, 8, 12).getTimezoneOffset(), days: rows.map(r => r.paid_on), types: rows.map(r => typeof r.paid_on), lit, t: ts.t instanceof Date ? ts.t.toISOString() : String(ts.t) }));
      await db.close();
    `;
    const results = new Map<string, { offset: number; days: unknown; types: unknown; lit: unknown; t: unknown }>();
    for (const tz of ["America/Toronto", "UTC", "Asia/Tokyo"]) {
      const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], {
        env: { ...process.env, TZ: tz, URL: testDb.appUrl, IDS: JSON.stringify(ids) },
        encoding: "utf8",
      });
      results.set(tz, JSON.parse(out.trim().split("\n").pop() ?? ""));
    }
    // the zones really differed
    expect(new Set([...results.values()].map((r) => r.offset)).size).toBe(3);
    for (const [tz, r] of results) {
      expect(r.days, tz).toEqual([...days].sort());
      expect(r.types, tz).toEqual(days.map(() => "string"));
      expect(r.lit, tz).toEqual({ a: "2026-03-08", b: "2026-11-01", c: "2026-03-08" });
      expect(r.t, tz).toBe("2026-03-08T06:30:00.000Z");
    }
  }, 60000);
});

describe("other types", () => {
  it("timestamptz is a Date for the same instant, and a Date parameter is sent as an instant", async () => {
    const instant = new Date("2026-03-08T06:30:15.123Z");
    const staff = await addStaff({ created: instant });
    const row = await db.one<{ created_at: Date }>("select created_at from ops.staff where staff_id = $1", [staff]);
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.created_at.getTime()).toBe(instant.getTime());
    const echoed = await db.one<{ t: string }>("select ($1::timestamptz at time zone 'UTC')::text as t", [instant]);
    expect(echoed.t).toBe("2026-03-08 06:30:15.123");
  });

  it("a NULL timestamptz is null", async () => {
    const staff = await addStaff({ created: null });
    expect((await db.one<{ created_at: unknown }>("select created_at from ops.staff where staff_id = $1", [staff])).created_at).toBeNull();
  });

  it("boolean is boolean", async () => {
    const a = await addStaff({ active: true });
    const b = await addStaff({ active: false });
    const rows = await db.query<{ staff_id: string; active: boolean }>("select staff_id, active from ops.staff where staff_id in ($1, $2)", [a, b]);
    expect(rows.find((r) => r.staff_id === a)?.active).toBe(true);
    expect(rows.find((r) => r.staff_id === b)?.active).toBe(false);
  });

  it("bigint is a number, and throws beyond Number.MAX_SAFE_INTEGER", async () => {
    await addStaff();
    const c = await db.one<{ n: number }>("select count(*) as n from ops.staff");
    expect(typeof c.n).toBe("number");
    expect(c.n).toBeGreaterThan(0);
    expect((await db.one<{ n: number }>("select 9007199254740991::bigint as n")).n).toBe(Number.MAX_SAFE_INTEGER);
    expect((await db.one<{ n: number }>("select (-9007199254740991)::bigint as n")).n).toBe(-Number.MAX_SAFE_INTEGER);
    await expect(db.query("select 9007199254740992::bigint as n")).rejects.toThrow(/safe integer/i);
    await expect(db.query("select (-9007199254740992)::bigint as n")).rejects.toThrow(/safe integer/i);
  });

  it("text keeps '' and NULL apart, in both directions", async () => {
    const empty = await addStaff({ notes: "" });
    const nul = await addStaff({ notes: null });
    const text = await addStaff({ notes: "hello" });
    const rows = await db.query<{ staff_id: string; notes: string | null }>(
      "select staff_id, notes from ops.staff where staff_id in ($1, $2, $3)",
      [empty, nul, text],
    );
    const notes = new Map(rows.map((r) => [r.staff_id, r.notes]));
    expect(notes.get(empty)).toBe("");
    expect(notes.get(nul)).toBeNull();
    expect(notes.get(text)).toBe("hello");
    // and the database itself agrees they differ
    expect((await db.one<{ n: number }>("select count(*) as n from ops.staff where staff_id = $1 and notes is null", [empty])).n).toBe(0);
    expect((await db.one<{ n: number }>("select count(*) as n from ops.staff where staff_id = $1 and notes = ''", [nul])).n).toBe(0);
  });
});

describe("parameters are checked before anything is sent", () => {
  it.each([
    ["undefined", undefined, /undefined/],
    ["NaN", Number.NaN, /NaN|finite/],
    ["Infinity", Number.POSITIVE_INFINITY, /finite|Infinity/],
    ["-Infinity", Number.NEGATIVE_INFINITY, /finite|Infinity/],
    ["an invalid Date", new Date(Number.NaN), /Date/],
    ["undefined inside an array", [1, undefined], /undefined/],
  ])("rejects %s", async (_label, value, message) => {
    const sent: unknown[] = [];
    const fake = { query: async (q: unknown) => (sent.push(q), { rows: [] }) } as unknown as pg.Client;
    const guarded = fromClient(fake);
    await expect(guarded.query("select $1", [value])).rejects.toThrow(message);
    expect(sent).toEqual([]);
  });

  it("the real client rejects them too, and names the parameter without printing the others", async () => {
    const err = await db.query("select $1, $2, $3", ["secret-value-xyz", 1, undefined]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/\$3/);
    expect((err as Error).message).not.toContain("secret-value-xyz");
    await expect(db.query("select $1::numeric", [Number.NaN])).rejects.toThrow(/\$1/);
  });
});

describe("one and maybeOne", () => {
  it("one returns the row, and throws on 0 or 2+", async () => {
    const staff = await addStaff();
    expect((await db.one<{ staff_id: string }>("select staff_id from ops.staff where staff_id = $1", [staff])).staff_id).toBe(staff);
    await expect(db.one("select 1 where false")).rejects.toThrow(/exactly one row.*0/);
    await expect(db.one("select 1 union all select 2")).rejects.toThrow(/exactly one row.*2/);
  });

  it("maybeOne returns the row or null, and throws on 2+", async () => {
    const staff = await addStaff();
    expect((await db.maybeOne<{ staff_id: string }>("select staff_id from ops.staff where staff_id = $1", [staff]))?.staff_id).toBe(staff);
    expect(await db.maybeOne("select 1 where false")).toBeNull();
    await expect(db.maybeOne("select 1 union all select 2")).rejects.toThrow(/more than one row/);
  });

  it("query returns an array, empty when nothing matches", async () => {
    expect(await db.query("select 1 where false")).toEqual([]);
  });
});

describe("DbError", () => {
  const fail = async (p: Promise<unknown>): Promise<DbError> => {
    const e = await p.then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(DbError);
    return e as DbError;
  };

  it("permission: ops_app cannot delete payments", async () => {
    const staff = await addStaff();
    const id = await addPayment(staff, 5);
    const e = await fail(db.query("delete from ops.payments where payment_id = $1", [id]));
    expect(e.kind).toBe("permission");
    expect(e.code).toBe("42501");
    expect(e.message).not.toContain(id);
  });

  it("unique: duplicate primary key, with the constraint and table", async () => {
    const staff = await addStaff();
    const e = await fail(
      db.query("insert into ops.staff (staff_id, name, active, role) values ($1, 'Fictional Person', true, 'employee')", [staff]),
    );
    expect(e.kind).toBe("unique");
    expect(e.code).toBe("23505");
    expect(e.constraint).toBe("staff_pkey");
    expect(e.table).toBe("staff");
  });

  it("foreign_key: payment for a staff member that does not exist", async () => {
    const e = await fail(
      db.query(
        "insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method) values ($1, 'no-such-staff', '2026-01-02', 1, 'cash')",
        [nextId("pay")],
      ),
    );
    expect(e.kind).toBe("foreign_key");
    expect(e.code).toBe("23503");
    expect(e.constraint).toMatch(/staff_id_fkey/);
    expect(e.table).toBe("payments");
  });

  it("check: a role outside the list", async () => {
    const e = await fail(
      db.query("insert into ops.staff (staff_id, name, active, role) values ($1, 'Fictional Person', true, 'wizard')", [nextId("st")]),
    );
    expect(e.kind).toBe("check");
    expect(e.code).toBe("23514");
    expect(e.constraint).toMatch(/role/);
  });

  it("not_null: a staff row without a name", async () => {
    const e = await fail(db.query("insert into ops.staff (staff_id, name, active, role) values ($1, null, true, 'employee')", [nextId("st")]));
    expect(e.kind).toBe("not_null");
    expect(e.code).toBe("23502");
    expect(e.table).toBe("staff");
  });

  it("other: a syntax error keeps its code", async () => {
    const e = await fail(db.query("selct 1"));
    expect(e.kind).toBe("other");
    expect(e.code).toBe("42601");
  });

  it("deadlock (40P01) maps to kind deadlock", async () => {
    const a = await connect(testDb.appUrl);
    const b = await connect(testDb.appUrl);
    try {
      const s1 = await addStaff();
      const s2 = await addStaff();
      await a.query("begin");
      await b.query("begin");
      await a.query("update ops.staff set notes = 'a' where staff_id = $1", [s1]);
      await b.query("update ops.staff set notes = 'b' where staff_id = $1", [s2]);
      const pa = a.query("update ops.staff set notes = 'a' where staff_id = $1", [s2]).then(() => null, (x: unknown) => x);
      await new Promise((r) => setTimeout(r, 200));
      const pb = b.query("update ops.staff set notes = 'b' where staff_id = $1", [s1]).then(() => null, (x: unknown) => x);
      const errs = (await Promise.all([pa, pb])).filter((x) => x !== null);
      expect(errs).toHaveLength(1);
      expect(errs[0]).toBeInstanceOf(DbError);
      expect((errs[0] as DbError).kind).toBe("deadlock");
      expect((errs[0] as DbError).code).toBe("40P01");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      await a.close();
      await b.close();
    }
  });

  it("serialization (40001) maps to kind serialization", async () => {
    const a = await connect(testDb.appUrl);
    const b = await connect(testDb.appUrl);
    try {
      const s = await addStaff();
      await a.query("begin isolation level repeatable read");
      await a.query("select notes from ops.staff where staff_id = $1", [s]);
      await b.query("update ops.staff set notes = 'changed' where staff_id = $1", [s]);
      const err = await a.query("update ops.staff set notes = 'mine' where staff_id = $1", [s]).then(() => null, (x: unknown) => x);
      expect(err).toBeInstanceOf(DbError);
      expect((err as DbError).kind).toBe("serialization");
      expect((err as DbError).code).toBe("40001");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await a.close();
      await b.close();
    }
  });

  it("never puts a parameter value in the message", async () => {
    const distinctive = "ZXQ-9876-distinctive";
    const staff = await addStaff();
    await db.query("insert into ops.staff (staff_id, name, active, role) values ($1, 'Fictional Person', true, 'employee')", [distinctive]);
    const attempts: (() => Promise<unknown>)[] = [
      // unique violation: Postgres's own detail would quote the key
      () => db.query("insert into ops.staff (staff_id, name, active, role) values ($1, 'Fictional Person', true, 'employee')", [distinctive]),
      // bad input: Postgres's own message quotes the value
      () => db.query("select $1::numeric", [distinctive]),
      () => db.query("insert into ops.staff (staff_id, name, active, role) values ($1, $2, true, 'wizard')", [distinctive, distinctive]),
      () => db.query(
        "insert into ops.payments (payment_id, staff_id, paid_on, total_amount, method) values ($1, $2, '2026-01-02', 1, 'cash')",
        [nextId("pay"), distinctive + "-nobody"],
      ),
    ];
    for (const p of attempts) {
      const e = await fail(p());
      expect(e.message).not.toContain(distinctive);
      expect(e.message).not.toContain(staff);
      expect(JSON.stringify(e)).not.toContain(distinctive);
      expect(String(e.stack)).not.toContain(distinctive);
    }
  });
});

describe("the client's parsers stay with the client", () => {
  it("a plain pg.Client in the same process still gets the driver's defaults", async () => {
    const staff = await addStaff({ rate: 1.5, start: "2026-03-08" });
    const plain = new pg.Client({ connectionString: testDb.appUrl });
    await plain.connect();
    try {
      const r = await plain.query("select hourly_rate, start_date, 1::bigint as n from ops.staff where staff_id = $1", [staff]);
      expect(r.rows[0].hourly_rate).toBe("1.5000");
      expect(r.rows[0].start_date).toBeInstanceOf(Date);
      expect(r.rows[0].n).toBe("1");
    } finally {
      await plain.end();
    }
  });

  it("fromClient applies the same rules to an already-connected client, and does not close it", async () => {
    const raw = new pg.Client({ connectionString: testDb.appUrl });
    await raw.connect();
    try {
      const wrapped = fromClient(raw);
      const r = await wrapped.one<{ n: number; d: string; x: number | null }>(
        "select 5::bigint as n, date '2026-11-01' as d, null::numeric as x",
      );
      expect(r).toEqual({ n: 5, d: "2026-11-01", x: null });
      expect((await raw.query("select 1 as one")).rows[0].one).toBe(1);
    } finally {
      await raw.end();
    }
  });
});
