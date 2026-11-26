// The Monday cron (src/Commissions.gs commissionsTriggerHandler) as a plain function, with a real database,
// a clock that is handed in and a recorded log. No Worker is started.
//
// What it must do: run only on Monday at 09:00 in Toronto (the two UTC hours Cloudflare is scheduled for
// cover summer and winter time; exactly one of them is 09:00 there on any Monday), run the week before as
// SYSTEM_TRIGGER and never force, in ONE transaction on ONE connection that is always closed, and on failure
// log one line and throw so the platform records the failure.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connect, type Db } from "../src/db/client";
import { CRON_SCHEDULES, RUN_HOUR, runWeeklyCommissions, type CronDeps } from "../src/cron";
import worker from "../src/index";
import { wallClock } from "../src/lib/dates";
import { createTestDb, type TestDb } from "./helpers/db";

let testDb: TestDb;
let db: Db & { close(): Promise<void> };
let owner: Db & { close(): Promise<void> };

beforeAll(async () => {
  testDb = await createTestDb();
  db = await connect(testDb.appUrl);
  owner = await connect(testDb.ownerUrl);
});
afterAll(async () => {
  await db?.close();
  await owner?.close();
  await testDb?.drop();
});

beforeEach(async () => {
  for (const t of ["audit_log", "bonuses", "commission_runs", "commission_rules", "sales", "till_sessions", "attendance", "staff"]) await owner.query(`delete from ops.${t}`);
  await owner.query("insert into ops.staff (staff_id, name, active, role, companies_authorized) values ('S_ASH', 'Ashin Quill', true, 'employee', 'cstore,vape')");
  await owner.query(
    `insert into ops.commission_rules (rule_id, name, applies_to, staff_id, company, threshold, percentage, active, effective_from, rule_type, fixed_amount)
     values ('CR_001', 'Fee', 'specific_staff', 'S_ASH', 'cstore', 0, 0, true, '2026-01-01', 'fixed', 120)`,
  );
});

// Monday 28 September 2026, 09:00 in Toronto (summer time: 13:00Z).
const MONDAY_9 = new Date("2026-09-28T13:00:00Z");

interface Spy {
  deps: CronDeps;
  logs: object[];
  opened: number;
  closed: number;
  statements: string[];
}

function spy(now: Date, over: Partial<CronDeps> = {}, wrap?: (db: Db) => Db): Spy {
  const s: Spy = { deps: undefined as never, logs: [], opened: 0, closed: 0, statements: [] };
  s.deps = {
    openDb: async () => {
      s.opened++;
      const conn = await connect(testDb.appUrl);
      const record = (t: string): void => void s.statements.push(t.trim().split(/\s+/).slice(0, 3).join(" "));
      const base: Db = {
        query: async (t, p) => (record(t), conn.query(t, p)),
        one: async (t, p) => (record(t), conn.one(t, p)),
        maybeOne: async (t, p) => (record(t), conn.maybeOne(t, p)),
      };
      return { ...(wrap ? wrap(base) : base), close: async () => (s.closed++, conn.close()) };
    },
    now: () => now,
    env: {},
    fetch,
    log: (e) => void s.logs.push(e),
    ...over,
  };
  return s;
}

const runRows = () => db.query<any>("select * from ops.commission_runs order by run_id");
const bonusRows = () => db.query<any>("select * from ops.bonuses order by bonus_id");

describe("when it runs", () => {
  it("the schedule in wrangler.toml is the schedule the code expects: Mondays, both UTC hours that can be 09:00 in Toronto", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const m = /^\[triggers\]\s*\ncrons\s*=\s*\[([^\]]*)\]/m.exec(toml);
    expect(m).not.toBeNull();
    const listed = [...(m?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(listed).toEqual([...CRON_SCHEDULES]);
    expect(CRON_SCHEDULES).toEqual(["0 13 * * 1", "0 14 * * 1"]);
    expect(RUN_HOUR).toBe(9);
  });

  it("every Monday of the year: exactly one of the two firings is the Toronto hour, and it is 09:00 there", async () => {
    // All 52 Mondays of 2026, both firings, whichever side of a clock change.
    for (let week = 0; week < 52; week++) {
      const day = new Date(Date.UTC(2026, 0, 5 + 7 * week));
      const hits: number[] = [];
      for (const cron of CRON_SCHEDULES) {
        const utcHour = Number(cron.split(" ")[1]);
        const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), utcHour));
        const s = spy(at);
        const r = await runWeeklyCommissions(s.deps);
        if (r.ran) {
          hits.push(utcHour);
          const w = wallClock(at);
          expect([w.dow, w.hour]).toEqual([1, 9]);
        } else {
          expect(s.opened).toBe(0); // no connection is made for a firing that does nothing
        }
        await owner.query("delete from ops.bonuses");
        await owner.query("delete from ops.commission_runs");
      }
      expect(hits).toHaveLength(1);
    }
  });

  it("the clock changes: Monday 9 March 2026 (summer time began the day before) runs at 13:00Z, Monday 2 November 2026 (it ended the day before) at 14:00Z", async () => {
    expect((await runWeeklyCommissions(spy(new Date("2026-03-09T13:00:00Z")).deps)).ran).toBe(true);
    await owner.query("delete from ops.bonuses");
    await owner.query("delete from ops.commission_runs");
    expect((await runWeeklyCommissions(spy(new Date("2026-03-09T14:00:00Z")).deps)).ran).toBe(false);
    expect((await runWeeklyCommissions(spy(new Date("2026-11-02T13:00:00Z")).deps)).ran).toBe(false);
    expect((await runWeeklyCommissions(spy(new Date("2026-11-02T14:00:00Z")).deps)).ran).toBe(true);
  });

  it("any other hour, any other day: nothing, and no connection", async () => {
    for (const at of ["2026-09-28T12:59:00Z", "2026-09-28T14:00:00Z", "2026-09-29T13:00:00Z", "2026-09-27T13:00:00Z", "2026-09-28T01:00:00Z"]) {
      const s = spy(new Date(at));
      const r = await runWeeklyCommissions(s.deps);
      expect(r.ran).toBe(false);
      expect(s.opened).toBe(0);
    }
    expect(await runRows()).toEqual([]);
  });

  it("any minute of the hour counts (the platform may start a little late)", async () => {
    expect((await runWeeklyCommissions(spy(new Date("2026-09-28T13:47:30Z")).deps)).ran).toBe(true);
  });
});

describe("what it does", () => {
  it("runs the week before as SYSTEM_TRIGGER: proposed bonuses and a run row for 21 to 27 September", async () => {
    const s = spy(MONDAY_9);
    const r = await runWeeklyCommissions(s.deps);
    expect(r).toMatchObject({ ran: true, result: { skipped: false, totalAmount: 120, staffCount: 1 } });
    expect(await runRows()).toEqual([expect.objectContaining({ week_start: "2026-09-21", week_end: "2026-09-27", computed_by: "SYSTEM_TRIGGER", bonuses_created: 1, notes: null })]);
    expect(await bonusRows()).toEqual([expect.objectContaining({ status: "proposed", type: "commission", created_by: "SYSTEM_TRIGGER", amount: 120, period_start: "2026-09-21", period_end: "2026-09-27" })]);
    expect(s.logs).toEqual([]);
  });

  it("uses one connection, closed once, and one transaction (one begin, one commit)", async () => {
    const s = spy(MONDAY_9);
    await runWeeklyCommissions(s.deps);
    expect(s.opened).toBe(1);
    expect(s.closed).toBe(1);
    expect(s.statements.filter((x) => x.toLowerCase() === "begin")).toHaveLength(1);
    expect(s.statements.filter((x) => x.toLowerCase() === "commit")).toHaveLength(1);
    expect(s.statements.filter((x) => x.toLowerCase() === "rollback")).toHaveLength(0);
  });

  it("never forces: a second firing the same Monday (a retry) finds the run and proposes nothing", async () => {
    await runWeeklyCommissions(spy(MONDAY_9).deps);
    const s = spy(new Date(MONDAY_9.getTime() + 60_000));
    const r = await runWeeklyCommissions(s.deps);
    expect(r).toMatchObject({ ran: true, result: { skipped: true } });
    expect(await runRows()).toHaveLength(1);
    expect(await bonusRows()).toHaveLength(1);
  });

  it("two firings at once make one run", async () => {
    const [a, b] = await Promise.all([runWeeklyCommissions(spy(MONDAY_9).deps), runWeeklyCommissions(spy(MONDAY_9).deps)]);
    expect([a, b].filter((r) => r.ran && "skipped" in r.result && r.result.skipped).length).toBe(1);
    expect(await runRows()).toHaveLength(1);
    expect(await bonusRows()).toHaveLength(1);
  });
});

describe("when it fails", () => {
  it("the engine fails: one log line (what failed, never a connection string), the error is thrown, the connection is closed, nothing is kept but the failure's audit row", async () => {
    const wrap = (base: Db): Db => ({
      query: async (t, p) => (/insert into ops\.commission_runs/.test(t) ? Promise.reject(new Error("the run row could not be written")) : base.query(t, p)),
      one: base.one,
      maybeOne: base.maybeOne,
    });
    const s = spy(MONDAY_9, {}, wrap);
    await expect(runWeeklyCommissions(s.deps)).rejects.toThrow("the run row could not be written");
    expect(s.logs).toHaveLength(1);
    expect(JSON.stringify(s.logs[0])).toContain("the run row could not be written");
    expect(JSON.stringify(s.logs[0])).not.toContain(testDb.appUrl);
    expect(s.closed).toBe(1);
    expect(await runRows()).toEqual([]);
    expect(await bonusRows()).toEqual([]);
    const audit = await db.query<any>("select actor_id, action, target_type, target_id, details from ops.audit_log");
    expect(audit).toEqual([{ actor_id: "SYSTEM", action: "commission.trigger_error", target_type: "trigger", target_id: "commissionsTriggerHandler", details: "the run row could not be written" }]);
    expect(s.statements.filter((x) => x.toLowerCase() === "rollback")).toHaveLength(1);
  });

  it("the database cannot be opened: one log line, the error is thrown, nothing to close", async () => {
    const s = spy(MONDAY_9, { openDb: async () => Promise.reject(new Error("no database configured")) });
    await expect(runWeeklyCommissions(s.deps)).rejects.toThrow("no database configured");
    expect(s.logs).toHaveLength(1);
  });

  it("a failing logger does not hide the failure", async () => {
    const wrap = (base: Db): Db => ({ query: async (t, p) => (/from ops\.commission_runs/.test(t) ? Promise.reject(new Error("read failed")) : base.query(t, p)), one: base.one, maybeOne: base.maybeOne });
    const s = spy(MONDAY_9, { log: () => {
      throw new Error("log down");
    } }, wrap);
    await expect(runWeeklyCommissions(s.deps)).rejects.toThrow("read failed");
    expect(s.closed).toBe(1);
  });
});

describe("the Worker's scheduled handler", () => {
  it("is wired: a firing at the right hour runs the week before against the Worker's own database", async () => {
    const env = { OPS_DB_APP_URL: testDb.appUrl };
    const scheduled = (worker as unknown as { scheduled: (c: { scheduledTime: number; cron: string }, env: unknown, ctx: unknown) => Promise<void> }).scheduled;
    expect(typeof scheduled).toBe("function");
    await scheduled({ scheduledTime: MONDAY_9.getTime(), cron: "0 13 * * 1" }, env, { waitUntil: () => undefined });
    expect(await runRows()).toHaveLength(1);
    await scheduled({ scheduledTime: MONDAY_9.getTime() + 3_600_000, cron: "0 14 * * 1" }, env, { waitUntil: () => undefined });
    expect(await runRows()).toHaveLength(1);
  });
});
