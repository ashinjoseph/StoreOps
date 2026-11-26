// The parity harness, tested against itself.
//
// Each test puts a FAKE handler on the new side and runs it against the REAL
// old server over the fixture. A fake that returns or stores exactly what the
// old code does must pass; every way of being slightly wrong must be reported,
// at the path where it is wrong. If one of these ever passes for the wrong
// reason, every phase-3 "parity passes" means nothing.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as audit from "../src/lib/audit";
import { newId } from "../src/lib/ids";
import { parseRpcContract } from "../src/rpc/contract";
import type { RpcContext, RpcHandler, RpcHandlers } from "../src/rpc/types";
import { readContract } from "../src/import/load";
import { translateTab } from "../src/import/sheet-to-db";
import { maybeSecret, secret } from "../src/lib/config";
import { directCase, parityCase, paritySequence, step, type CaseOptions, type DirectFn, type ParityCase } from "./case";
import { casedRpcs } from "./covered";
import { DAY_ONLY_KEYS, dayOnly } from "./day-only";
import { Outbound, redact, viewOf } from "./http";
import { takeNetworkLeaks } from "./network";
import { formatCalls, formatResult, formatSummary } from "./report";
import { PROBES } from "./probes";
import { gate } from "./gate";
import { closeWorlds, recordOld, runCase, type CaseResult } from "./run";
import { PARITY_EXTRA_PEOPLE } from "./old-world";
import { createWorlds } from "./worlds";

const contract = parseRpcContract(JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")));

afterAll(closeWorlds);

/** A handler that answers with a copy of `value`, whatever it is asked. */
const returning =
  (value: unknown): RpcHandler =>
  () =>
    structuredClone(value);

const throwing =
  (message: string): RpcHandler =>
  () => {
    throw new Error(message);
  };

const pathsOf = (r: CaseResult) => r.diffs.map((d) => `${d.where} ${d.path}`);

// ── Reads ──────────────────────────────────────────────────

/** A genuine port of rpcGetActiveStaffForLogin (Staff.getActive in staff-id order, as the fixture's sheet is). */
const loginList: RpcHandler = async (ctx: RpcContext) => {
  const rows = await ctx.db.query<{ staff_id: string; name: string }>("select staff_id, name from ops.staff where active order by staff_id");
  return { success: true, staff: rows.map((r) => ({ staffId: r.staff_id, name: r.name })) };
};

describe("reads: the comparison", () => {
  const cashCase = parityCase("rpcGetCashPosition", { as: "manager" });
  const shiftCase = parityCase("rpcGetMyShiftState", { as: "manager" });
  let cash: Record<string, unknown>;
  let shift: Record<string, unknown>;

  beforeAll(async () => {
    cash = (await recordOld(cashCase))[0] as Record<string, unknown>;
    shift = (await recordOld(shiftCase))[0] as Record<string, unknown>;
    // The subjects must have what the tests below mutate.
    expect(Array.isArray(cash["holders"]) && (cash["holders"] as unknown[]).length).toBeGreaterThan(1);
    expect(shift["todaySummary"]).toBeNull();
  });

  it("a real port of the login name list passes", async () => {
    const r = await runCase(parityCase("rpcGetActiveStaffForLogin", {}), { handlers: { rpcGetActiveStaffForLogin: loginList } });
    expect(r.diffs).toEqual([]);
    expect(r.status).toBe("pass");
  });

  it("a handler returning exactly the old answer passes", async () => {
    const r = await runCase(cashCase, { handlers: { rpcGetCashPosition: returning(cash) } });
    expect(r.diffs).toEqual([]);
    expect(r.status).toBe("pass");
  });

  it("a cent off in a money field is a difference at that path", async () => {
    const off = structuredClone(cash) as { holders: { total: number }[] };
    (off.holders[0] as { total: number }).total = Math.round(((off.holders[0] as { total: number }).total + 0.01) * 100) / 100;
    const r = await runCase(cashCase, { handlers: { rpcGetCashPosition: returning(off) } });
    expect(r.status).toBe("fail");
    expect(pathsOf(r)).toEqual(["call 1 rpcGetCashPosition $.holders[0].total"]);
  });

  it("0 where the old answer has null is a difference", async () => {
    const r = await runCase(shiftCase, { handlers: { rpcGetMyShiftState: returning({ ...shift, todaySummary: 0 }) } });
    expect(r.status).toBe("fail");
    expect(pathsOf(r)).toEqual(["call 1 rpcGetMyShiftState $.todaySummary"]);
    expect(r.diffs[0]).toMatchObject({ old: "null", new: "0" });
  });

  it("'' where the old answer has null is a difference", async () => {
    const r = await runCase(shiftCase, { handlers: { rpcGetMyShiftState: returning({ ...shift, todaySummary: "" }) } });
    expect(pathsOf(r)).toEqual(["call 1 rpcGetMyShiftState $.todaySummary"]);
    expect(r.diffs[0]).toMatchObject({ old: "null", new: '""' });
  });

  it("false where the old answer has a missing key is a difference", async () => {
    const r = await runCase(shiftCase, { handlers: { rpcGetMyShiftState: returning({ ...shift, notThere: false }) } });
    expect(r.diffs[0]).toMatchObject({ path: "$.notThere", old: "(missing)", new: "false" });
  });

  it("a dropped key is a difference", async () => {
    const dropped = structuredClone(cash);
    delete dropped["enabled"];
    const r = await runCase(cashCase, { handlers: { rpcGetCashPosition: returning(dropped) } });
    expect(pathsOf(r)).toEqual(["call 1 rpcGetCashPosition $.enabled"]);
    expect(r.diffs[0]).toMatchObject({ old: "true", new: "(missing)" });
  });

  it("an added key is a difference", async () => {
    const r = await runCase(cashCase, { handlers: { rpcGetCashPosition: returning({ ...cash, extra: 1 }) } });
    expect(pathsOf(r)).toEqual(["call 1 rpcGetCashPosition $.extra"]);
  });

  it("key order in an object does not matter", async () => {
    const reordered = Object.fromEntries(Object.entries(cash).reverse());
    const r = await runCase(cashCase, { handlers: { rpcGetCashPosition: returning(reordered) } });
    expect(r.status).toBe("pass");
  });

  it("a reordered array is a difference", async () => {
    const reordered = { ...cash, holders: [...(cash["holders"] as unknown[])].reverse() };
    const r = await runCase(cashCase, { handlers: { rpcGetCashPosition: returning(reordered) } });
    expect(r.status).toBe("fail");
    expect(r.diffs.some((d) => d.path.startsWith("$.holders[0]."))).toBe(true);
  });

  it("at most 20 differences are listed per call, then a count", async () => {
    const r = await runCase(cashCase, { handlers: { rpcGetCashPosition: returning({ holders: [] }) } });
    expect(r.status).toBe("fail");
    const call = r.calls[0];
    expect(call?.diffs.length).toBeLessThanOrEqual(20);
    expect(call?.total).toBeGreaterThanOrEqual(call?.diffs.length ?? 0);
  });

  it("a different error message is a difference", async () => {
    const zero = parityCase("rpcCreateBonus", { as: "admin", args: [{ staffId: "S_003", type: "bonus", amount: 0, reason: "x" }], writes: [] });
    const same = await runCase(zero, { handlers: { rpcCreateBonus: throwing("amount cannot be zero") } });
    expect(same.status).toBe("pass");
    const r = await runCase(zero, { handlers: { rpcCreateBonus: throwing("Amount cannot be zero.") } });
    expect(r.status).toBe("fail");
    expect(r.diffs[0]).toMatchObject({ path: "$", old: '(error) "amount cannot be zero"', new: '(error) "Amount cannot be zero."' });
  });

  it("a throw where the old code answers is a difference", async () => {
    const r = await runCase(parityCase("rpcGetActiveStaffForLogin", {}), { handlers: { rpcGetActiveStaffForLogin: throwing("boom") } });
    expect(r.status).toBe("fail");
    expect(pathsOf(r)).toEqual(["call 1 rpcGetActiveStaffForLogin $"]);
    expect(r.diffs[0]?.new).toBe('(error) "boom"');
  });

  it("a fault on the new side (not a plain Error) is a difference, never a pass", async () => {
    const r = await runCase(parityCase("rpcGetActiveStaffForLogin", {}), {
      handlers: {
        rpcGetActiveStaffForLogin: () => {
          throw new TypeError("x is undefined");
        },
      },
    });
    expect(r.status).toBe("fail");
    expect(r.diffs[0]?.new).toBe('(error) "SERVER_ERROR"');
  });

  it("an RPC with no handler is 'not ported', never a pass", async () => {
    const r = await runCase(cashCase, { handlers: {} });
    expect(r.status).toBe("not_ported");
  });

  it("a read-only case that writes is caught", async () => {
    const sneaky: RpcHandler = async (ctx) => {
      await ctx.db.query("update ops.config set description = 'touched' where key = 'session_hours'");
      return loginList(ctx);
    };
    const r = await runCase(parityCase("rpcGetActiveStaffForLogin", {}), { handlers: { rpcGetActiveStaffForLogin: sneaky } });
    expect(r.status).toBe("fail");
    expect(r.undeclared).toEqual(["config (new side)"]);
  });
});

// SIGNED_OUT_RULE (run.ts). Found Nov 26: cases that moved the clock a day on and then asked for the
// dashboard "as manager" compared NOT_LOGGED_IN with NOT_LOGGED_IN and passed, comparing nothing.
describe("a caller whose sign-in has run out is never a silent pass", () => {
  const answered = { rpcGetCashPosition: returning({ holders: [] }) };
  const late = (spec: object) => paritySequence("the cash position a day and a half later", { writes: ["sessions"] }, [step("rpcGetCashPosition", { as: "manager", advance: { hours: 36 }, ...spec })]);

  it("both sides refusing a signed-in fixture person as NOT_LOGGED_IN fails the case and says why", async () => {
    const r = await runCase(late({}), { handlers: answered });
    expect(r.calls[0]!.old).toEqual({ kind: "error", message: "NOT_LOGGED_IN" });
    expect(r.calls[0]!.new).toEqual({ kind: "error", message: "NOT_LOGGED_IN" });
    expect(r.status).toBe("fail");
    expect(r.diffs).toHaveLength(1);
    expect(r.diffs[0]).toMatchObject({ where: "call 1 rpcGetCashPosition", path: "(caller)" });
    expect(r.diffs[0]!.old).toMatch(/sign-in had run out/);
  });

  it("the same step marked expect: \"signed_out\" passes: the case is about being signed out", async () => {
    const r = await runCase(late({ expect: "signed_out" }), { handlers: answered });
    expect(r.diffs).toEqual([]);
    expect(r.status).toBe("pass");
  });

  it("a step marked expect: \"signed_out\" that is answered fails", async () => {
    const old = (await recordOld(parityCase("rpcGetCashPosition", { as: "manager" })))[0];
    const r = await runCase(paritySequence("answered", {}, [step("rpcGetCashPosition", { as: "manager", expect: "signed_out" })]), { handlers: { rpcGetCashPosition: returning(old) } });
    expect(r.status).toBe("fail");
    expect(r.diffs[0]).toMatchObject({ path: "(caller)" });
  });

  it("a call with no token (as: null) refused on both sides is an ordinary pass", async () => {
    const r = await runCase(parityCase("rpcGetCashPosition", { as: null }), { handlers: answered });
    expect(r.diffs).toEqual([]);
    expect(r.status).toBe("pass");
  });
});

describe("exemptions", () => {
  it("an exemption without a reason is refused when the case is written", () => {
    expect(() => parityCase("rpcGetMe", { as: "manager", exempt: [{ path: "$.name", reason: "" }] })).toThrow(/reason/);
    expect(() => parityCase("rpcGetMe", { as: "manager", exempt: [{ path: "$.name" } as never] })).toThrow(/reason/);
  });

  it("an exemption with a reason applies, and is listed in the result", async () => {
    const c = parityCase("rpcGetActiveStaffForLogin", { exempt: [{ path: "$.staff[*].name", reason: "harness self-test" }] });
    const renamed: RpcHandler = async (ctx) => {
      const r = (await loginList(ctx)) as { staff: { name: string }[] };
      r.staff.forEach((s) => (s.name = s.name.toUpperCase()));
      return r;
    };
    const r = await runCase(c, { handlers: { rpcGetActiveStaffForLogin: renamed } });
    expect(r.status).toBe("pass");
    expect(r.exemptions).toEqual([{ where: "result", path: "$.staff[*].name", reason: "harness self-test" }]);
  });

  it("an exempt path still has to be present on both sides", async () => {
    const c = parityCase("rpcGetActiveStaffForLogin", { exempt: [{ path: "$.staff[*].name", reason: "harness self-test" }] });
    const dropped: RpcHandler = async (ctx) => {
      const r = (await loginList(ctx)) as { staff: { name?: string }[] };
      r.staff.forEach((s) => delete s.name);
      return r;
    };
    const r = await runCase(c, { handlers: { rpcGetActiveStaffForLogin: dropped } });
    expect(r.status).toBe("fail");
  });
});

// ── Writes ─────────────────────────────────────────────────

const BONUS_INPUT = { staffId: "S_003", type: "bonus", amount: 25.5, reason: "Parity self-test", date: "2026-11-19" };

interface BonusFakeOptions {
  /** Stored amount, when it should differ from the input. */
  storedAmount?: number;
  extraRow?: boolean;
  skipAudit?: boolean;
  touchUndeclared?: boolean;
  /** Random characters for the ids, in order of use. */
  random?: () => number;
  /** Answer with this id instead of the new one. */
  answerId?: () => string | undefined;
}

/**
 * A port of rpcCreateBonus (Bonuses.create_ + writeRow_ + getById_) that is
 * exactly right unless told otherwise. It exists only here, to give the
 * harness a real write to be wrong about.
 */
function bonusFake(o: BonusFakeOptions = {}): RpcHandler {
  return async (ctx, raw) => {
    const input = raw as typeof BONUS_INPUT;
    const actorId = ctx.session?.staffId as string;
    const amount = Math.round(Number(input.amount) * 100) / 100;
    if (amount === 0) throw new Error("amount cannot be zero");
    const insert = async (): Promise<{ id: string; rowIndex: number }> => {
      const id = newId("B", { now: ctx.now, chars: 10, ...(o.random ? { random: o.random } : {}) });
      const n = await ctx.db.one<{ n: number }>("select count(*)::int as n from ops.bonuses");
      await ctx.db.query(
        `insert into ops.bonuses (bonus_id, staff_id, date, type, amount, reason, status, period_start, period_end, company,
                                  source_run_id, created_by, created_at, notes, source_rule_id)
         values ($1, $2, $3, $4, $5, $6, 'pending', null, null, null, null, $7, $8, null, null)`,
        [id, input.staffId, input.date, input.type, o.storedAmount ?? amount, input.reason, actorId, ctx.now],
      );
      return { id, rowIndex: n.n + 3 };
    };
    const made = await insert();
    if (o.extraRow) await insert();
    if (!o.skipAudit) {
      await audit.write(
        ctx.db,
        {
          actorId,
          action: "bonus.created",
          targetType: "bonuses",
          targetId: made.id,
          after: { staffId: input.staffId, type: input.type, amount, status: "pending", reason: input.reason.substring(0, 100) },
        },
        { now: ctx.now },
      );
    }
    if (o.touchUndeclared) await ctx.db.query("update ops.config set description = 'touched' where key = 'session_hours'");
    return {
      bonusId: o.answerId?.() ?? made.id,
      staffId: input.staffId,
      date: null, // a Date in the old answer: the page receives null
      type: input.type,
      amount,
      reason: input.reason,
      status: "pending",
      periodStart: null,
      periodEnd: null,
      company: "",
      sourceRunId: "",
      sourceRuleId: "",
      createdBy: actorId,
      createdAt: null, // a Date in the old answer
      notes: "",
      // No _rowIndex: the old record's Sheet row number is dropped from the old side by rule (SHEET_ROW_RULE).
    };
  };
}

const createBonus = (extra: Partial<Pick<ParityCase, "title">> = {}) =>
  parityCase("rpcCreateBonus", { as: "admin", args: [BONUS_INPUT], writes: ["bonuses", "audit_log"], ...extra });
const withBonus = (h: RpcHandler): { handlers: RpcHandlers } => ({ handlers: { rpcCreateBonus: h } });

describe("writes: what each side stored", () => {
  it("an exact port of a write passes, results and rows", async () => {
    const r = await runCase(createBonus(), withBonus(bonusFake()));
    expect(r.diffs).toEqual([]);
    expect(r.status).toBe("pass");
    expect(r.findings.map((f) => f.path)).toEqual(expect.arrayContaining(["$.date", "$.createdAt"]));
  });

  it("one extra row is caught", async () => {
    const r = await runCase(createBonus(), withBonus(bonusFake({ extraRow: true })));
    expect(r.status).toBe("fail");
    expect(r.diffs.filter((d) => d.where === "table bonuses")).toHaveLength(1);
    expect(r.diffs.find((d) => d.where === "table bonuses")).toMatchObject({ old: "(missing)" });
  });

  it("a wrong amount is caught at its column", async () => {
    const r = await runCase(createBonus(), withBonus(bonusFake({ storedAmount: 25.51 })));
    expect(r.status).toBe("fail");
    expect(r.diffs).toHaveLength(1);
    expect(r.diffs[0]).toMatchObject({ where: "table bonuses", old: "25.5", new: "25.51" });
    expect(r.diffs[0]?.path).toMatch(/^\[B_\d{8}_\d{6}_<id:1>\]\.amount$/);
  });

  it("a write to a table the case did not declare is caught", async () => {
    const r = await runCase(createBonus(), withBonus(bonusFake({ touchUndeclared: true })));
    expect(r.status).toBe("fail");
    expect(r.undeclared).toEqual(["config (new side)"]);
  });

  it("a missing audit row is caught", async () => {
    const r = await runCase(createBonus(), withBonus(bonusFake({ skipAudit: true })));
    expect(r.status).toBe("fail");
    const a = r.diffs.filter((d) => d.where === "table audit_log");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ new: "(missing)" });
  });

  it("a declared table that only the old side wrote is caught", async () => {
    const r = await runCase(createBonus(), withBonus(async () => ({})));
    expect(r.status).toBe("fail");
    expect(r.diffs.some((d) => d.where === "table bonuses" && d.new === "(missing)")).toBe(true);
  });
});

describe("generated ids", () => {
  const twice = paritySequence("two bonuses", { as: "admin", writes: ["bonuses", "audit_log"] }, [
    step("rpcCreateBonus", { args: [BONUS_INPUT] }),
    step("rpcCreateBonus", { args: [{ ...BONUS_INPUT, amount: 30 }] }),
  ]);

  it("ids the new side makes in a different order, used consistently, pass", async () => {
    // The new side's random characters run backwards, so its ids sort the other way round.
    let n = 0;
    const draws = [0.99, 0.98, 0.97, 0.96, 0.95, 0.94];
    const r = await runCase(twice, withBonus(bonusFake({ random: () => draws[n++ % draws.length] as number })));
    expect(r.diffs).toEqual([]);
    expect(r.status).toBe("pass");
  });

  it("one id used where the old side has two different ids fails", async () => {
    let first: string | undefined;
    const fake = bonusFake({ answerId: () => first });
    const remember: RpcHandler = async (ctx, ...args) => {
      const out = (await fake(ctx, ...args)) as { bonusId: string };
      first ??= out.bonusId;
      return { ...out, bonusId: first };
    };
    const r = await runCase(twice, withBonus(remember));
    expect(r.status).toBe("fail");
    expect(pathsOf(r)).toContain("call 2 rpcCreateBonus $.bonusId");
  });
});

describe("the worlds", () => {
  it("both sides read one frozen clock, settable and advanceable; the real Date is back afterwards", async () => {
    const w = await createWorlds();
    try {
      w.clock.set(new Date("2026-11-20T15:30:00Z"));
      expect(w.old.run(() => [new Date().toISOString(), Date.now()])).toEqual(["2026-11-20T15:30:00.000Z", Date.parse("2026-11-20T15:30:00Z")]);
      w.clock.advance({ minutes: 61 });
      expect(w.old.run(() => new Date().toISOString())).toBe("2026-11-20T16:31:00.000Z");
      expect(w.clock.now().toISOString()).toBe("2026-11-20T16:31:00.000Z");
      expect(Math.abs(Date.now() - new Date().getTime())).toBeLessThan(1000);
      expect(new Date().getFullYear()).toBeGreaterThanOrEqual(2026);
    } finally {
      await w.close();
    }
  });

  it("two pairs never see each other's writes (old globals are swapped per world)", async () => {
    const a = await createWorlds();
    const b = await createWorlds();
    try {
      const before = b.old.rows("bonuses").length;
      const out = await runCase(createBonus(), withBonus(bonusFake()));
      expect(out.status).toBe("pass");
      const token = a.old.signIn("admin");
      a.old.call("rpcCreateBonus", [token, BONUS_INPUT]);
      expect(a.old.rows("bonuses").length).toBe(before + 1);
      expect(b.old.rows("bonuses").length).toBe(before);
      expect((await b.newRows("bonuses")).length).toBe(before);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("the fixture people", () => {
  let w: Awaited<ReturnType<typeof createWorlds>>;
  beforeAll(async () => {
    w = await createWorlds();
  });
  afterAll(async () => {
    await w.close();
  });

  it("each of the four roles resolves to an active person with that role and a login code", () => {
    for (const role of ["admin", "manager", "employee", "payroll_admin"]) {
      const p = w.old.person(role);
      expect({ role: p.role, active: p.active, hasCode: p.code !== "" }).toEqual({ role, active: true, hasCode: true });
    }
    expect(w.old.person("payroll_admin").staffId).toBe(PARITY_EXTRA_PEOPLE[0]?.staffId);
  });

  it("an inactive person is never picked by role, but can be named by id", () => {
    const inactive = PARITY_EXTRA_PEOPLE.find((p) => !p.active);
    expect(inactive).toBeDefined();
    expect(w.old.person("employee").staffId).not.toBe(inactive?.staffId);
    const byId = w.old.person(inactive?.staffId ?? "");
    expect(byId).toMatchObject({ role: "employee", active: false, name: inactive?.name });
    expect(byId.code).not.toBe("");
  });

  it("an unknown role or id is a clear error", () => {
    expect(() => w.old.person("owner")).toThrow(/no staff id owner and no active owner/);
    expect(() => w.old.person("S_999")).toThrow(/no staff id S_999/);
  });

  it("as: <an inactive id> is refused by the harness, saying to call rpcLogin as a step", async () => {
    const id = PARITY_EXTRA_PEOPLE.find((p) => !p.active)?.staffId ?? "";
    const c = parityCase("rpcGetMe", { as: id, writes: [], probes: { rpcGetMe: PROBES.rpcGetMe } });
    await expect(runCase(c)).rejects.toThrow(/inactive.*rpcLogin/s);
    await expect(w.signIn(id)).rejects.toThrow(/inactive.*rpcLogin/s);
  });

  it("the two added people are on both sides with equal rows", async () => {
    const tab = w.old.tab("staff");
    const translated = translateTab("staff", tab.header, tab.rows, { contract: readContract() });
    if (translated.status !== "ok") throw new Error("staff tab did not translate");
    const plain = (k: string, v: unknown): unknown => (v instanceof Date ? v.toISOString() : k === "hourly_rate" && v !== null ? Number(v) : v);
    const newRows = await w.newRows("staff");
    for (const person of PARITY_EXTRA_PEOPLE) {
      const o = translated.rows.find((r) => r["staff_id"] === person.staffId);
      const n = newRows.find((r) => r["staff_id"] === person.staffId);
      expect(o, `old ${person.staffId}`).toBeDefined();
      expect(n, `new ${person.staffId}`).toBeDefined();
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) expect(plain(k, (n as Record<string, unknown>)[k]), `${person.staffId}.${k}`).toEqual(plain(k, v));
      expect(o).toMatchObject({ name: person.name, role: person.role, active: person.active });
    }
    expect(translated.rows.length).toBe(newRows.length);
  });

  it("the extra people own no shifts, sales, payments or bonuses", () => {
    const ids = PARITY_EXTRA_PEOPLE.map((p) => p.staffId);
    for (const tabName of w.old.tabNames()) {
      if (tabName === "staff") continue;
      const tab = w.old.tab(tabName);
      const cols = tab.header.map((h, i) => (/staff_id|created_by|recorded_by|actor_id|paid_to/.test(String(h)) ? i : -1)).filter((i) => i >= 0);
      for (const r of tab.rows) for (const i of cols) expect(ids, `${tabName} mentions an extra person`).not.toContain(String(r[i] ?? "").trim());
    }
  });
});

describe("the gate", () => {
  const handlers: RpcHandlers = { rpcLogin: () => null, rpcLogout: () => null, rpcGetMe: () => null };

  it("lists covered, missing and not-ported RPCs, and fails on a handler with no case", () => {
    const g = gate({ contract, handlers, cased: ["rpcLogin", "rpcGetMe", "rpcGetCashPosition"] });
    expect(g.covered).toEqual(["rpcLogin", "rpcGetMe"]);
    expect(g.missingCase).toEqual(["rpcLogout"]);
    expect(g.notPorted).toContain("rpcGetCashPosition");
    expect(g.notPorted).not.toContain("rpcLogout");
    expect(g.notPorted).not.toContain("rpcGetSuppliers"); // migrate: false is ignored
    expect(g.ok).toBe(false);
  });

  it("passes when every handler has a case", () => {
    expect(gate({ contract, handlers, cased: ["rpcLogin", "rpcLogout", "rpcGetMe"] }).ok).toBe(true);
  });

  it("ignores handlers for RPCs the contract does not migrate, and rejects a case for an unknown RPC", () => {
    expect(() => gate({ contract, handlers, cased: ["rpcNoSuchThing"] })).toThrow(/rpcNoSuchThing/);
  });
});

// ── Outbound HTTP, settings and secrets (card P3-08) ───────
//
// The real old Notifier.sendOp is the old side; the new side is a FAKE that sends the same two
// requests the old one does (it reads its URL, recipients, template and token the way a port
// would, so it is also a test that settings and the secret reach the new side). Each test makes
// the fake wrong in one way and says where the harness must say so.

const SECRET = "test-secret-one-0451";
const WRONG = "test-wrong-token-9999";
const SENT = { status: 200, body: { messages: [{ id: "wamid.TEST" }] } } as const;
const OPEN_ARGS = ["shift_open", ["a", "b", "c"], "plain"];
/** What the old sendOp answers for two recipients that both accepted. */
const BOTH_SENT = { sent: true, sentCount: 2, total: 2, results: [{ to: "14165550100", sent: true }, { to: "14165550101", sent: true }] };

interface Wrong {
  /** The first request goes to this URL. */
  url?: string;
  /** The first request's second parameter says this. */
  text?: string;
  /** Post this many extra requests. */
  extra?: number;
  /** Leave out this many requests. */
  fewer?: number;
  /** The first request carries this token. */
  token?: string;
  noAuth?: boolean;
  noContentType?: boolean;
  method?: string;
  /** Put the real token in the answer (a leak the report must not print). */
  leak?: boolean;
}

/** A port of sendOp's request that is exactly right unless told to be wrong. */
function sender(w: Wrong = {}): DirectFn {
  return async (deps) => {
    const url = deps.config.value("whatsapp_api_url");
    const token = secret(deps.env, "whatsapp_api_token");
    const lang = deps.config.value("whatsapp_template_lang", "en");
    const name = deps.config.value("whatsapp_template_shift_open");
    const to = deps.config.list("whatsapp_target_number");
    const plan = [...to.slice(0, to.length - (w.fewer ?? 0)), ...Array.from({ length: w.extra ?? 0 }, () => to[0] as string)];
    for (const [i, t] of plan.entries()) {
      const first = i === 0;
      const headers: Record<string, string> = {};
      if (!(first && w.noAuth)) headers["Authorization"] = `Bearer ${first && w.token ? w.token : token}`;
      if (!(first && w.noContentType)) headers["Content-Type"] = "application/json";
      const texts = ["a", first && w.text ? w.text : "b", "c"];
      // An unscripted request makes fetch throw; a real port would report it, this one carries on so only the request is judged.
      await deps.fetch(first && w.url ? w.url : url, {
        method: first && w.method ? w.method : "POST",
        headers,
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: t,
          type: "template",
          template: { name, language: { code: lang }, components: [{ type: "body", parameters: texts.map((text) => ({ type: "text", text })) }] },
        }),
      }).catch(() => undefined);
    }
    return w.leak ? { ...BOTH_SENT, leaked: token } : BOTH_SENT;
  };
}

const sendCase = (fn: DirectFn, extra: CaseOptions = {}): ParityCase =>
  directCase("Notifier.sendOp", { old: "Notifier.sendOp", new: fn }, { args: OPEN_ARGS, http: [SENT, SENT], settings: { whatsapp_api_token: SECRET }, ...extra });

describe("outbound HTTP: what each side sends is compared", () => {
  it("a new side that sends exactly what the old one sends passes (and the harness saw both sides' two requests)", async () => {
    const r = await runCase(sendCase(sender()));
    expect(r.diffs).toEqual([]);
    expect(r.status).toBe("pass");
    const call = r.calls[0];
    expect(call?.outbound.old.length).toBe(2);
    expect(call?.outbound.new).toEqual(call?.outbound.old);
    expect(call?.outbound.old[0]).toMatchObject({ method: "POST", authorization: "Bearer <secret>", contentType: "application/json" });
  });

  it.each([
    ["a different URL", { url: "https://graph.facebook.com/v21.0/999999999999999/messages" }, ["call 1 Notifier.sendOp outbound[0].url"]],
    ["a different body", { text: "B" }, ["call 1 Notifier.sendOp outbound[0].body.template.components[0].parameters[1].text"]],
    ["a different method", { method: "PUT" }, ["call 1 Notifier.sendOp outbound[0].method"]],
    ["one request too many", { extra: 1 }, ["call 1 Notifier.sendOp outbound[2]", "call 1 Notifier.sendOp outbound[2] (unscripted)"]],
    ["one request too few", { fewer: 1 }, ["call 1 Notifier.sendOp outbound[1]"]],
    ["the wrong token", { token: WRONG }, ["call 1 Notifier.sendOp outbound[0].authorization"]],
    ["no Authorization header", { noAuth: true }, ["call 1 Notifier.sendOp outbound[0].authorization"]],
    ["no content-type", { noContentType: true }, ["call 1 Notifier.sendOp outbound[0].contentType"]],
  ] as [string, Wrong, string[]][])("%s is a difference at its own path", async (_name, wrong, paths) => {
    const r = await runCase(sendCase(sender(wrong)));
    expect(r.status).toBe("fail");
    expect(pathsOf(r)).toEqual(paths);
  });

  it("shows the two sides of an authorization difference without printing either token", async () => {
    const wrong = await runCase(sendCase(sender({ token: WRONG })));
    expect(wrong.diffs[0]).toMatchObject({ old: '"Bearer <secret>"', new: '"Bearer <a different value>"' });
    const none = await runCase(sendCase(sender({ noAuth: true })));
    expect(none.diffs[0]).toMatchObject({ old: '"Bearer <secret>"', new: '"(none)"' });
  });

  it("an extra request is shown whole, at its index", async () => {
    const r = await runCase(sendCase(sender({ extra: 1 })));
    const extra = r.diffs.find((d) => d.path === "outbound[2]");
    expect(extra).toMatchObject({ old: "(missing)" });
    expect(extra?.new).toContain('"url":"https://graph.facebook.com/v21.0/100000000000001/messages"');
  });

  it("a request the case did not script fails the case, on both sides", async () => {
    const r = await runCase(sendCase(sender(), { http: [SENT] }));
    expect(r.status).toBe("fail");
    const paths = r.diffs.map((d) => d.path);
    expect(paths).toContain("outbound[1] (unscripted)");
    expect(r.diffs.filter((d) => d.path === "outbound[1] (unscripted)").length).toBe(2); // one per side
  });

  it("a case with no script at all fails any request", async () => {
    const r = await runCase(directCase("Notifier.sendOp", { old: "Notifier.sendOp", new: sender() }, { args: OPEN_ARGS, settings: { whatsapp_api_token: SECRET } }));
    expect(r.status).toBe("fail");
    expect(r.diffs.some((d) => d.path === "outbound[0] (unscripted)")).toBe(true);
  });

  it("a scripted reply the old side never asked for fails the case (the case is wrong)", async () => {
    const r = await runCase(sendCase(sender(), { http: [SENT, SENT, SENT] }));
    expect(r.status).toBe("fail");
    expect(r.diffs.map((d) => d.path)).toEqual(["outbound (scripted replies)"]);
    expect(r.diffs[0]?.old).toBe("1 scripted reply the old side never asked for");
  });

  it("a scripted failure is delivered to both sides: a thrown message, and an error status", async () => {
    // The old sendOp reports each; a new side that sends the same requests and answers the same text passes.
    const old = await recordOld(sendCase(sender(), { http: [{ throws: "Address unavailable" }, { status: 400, body: { error: { message: "(#133010) Account not registered" } } }] }));
    expect(old[0]).toEqual({
      sent: false,
      sentCount: 0,
      total: 2,
      results: [
        { to: "14165550100", sent: false, reason: "exception", detail: "Address unavailable" },
        { to: "14165550101", sent: false, reason: "http_400", detail: "(#133010) Account not registered" },
      ],
    });
    // The new side gets the same two replies: the first request throws, the second answers 400.
    const seen: DirectFn = async (deps) => {
      const out: unknown[] = [];
      for (const t of deps.config.list("whatsapp_target_number")) {
        try {
          out.push((await deps.fetch(deps.config.value("whatsapp_api_url"), { method: "POST", body: JSON.stringify({ to: t }) })).status);
        } catch (e) {
          out.push((e as Error).message);
        }
      }
      return out;
    };
    const r = await runCase(sendCase(seen, { http: [{ throws: "Address unavailable" }, { status: 400, body: { error: { message: "x" } } }] }));
    expect(r.calls[0]?.new).toEqual({ kind: "ok", value: ["Address unavailable", 400] });
  });

  it("the RPC path is compared too: a handler's ctx.fetch is the new side's outbound", async () => {
    const c = parityCase("rpcCheckWhatsApp", { as: "admin", http: [{ status: 200, body: {} }] });
    const [answer] = await recordOld(c);
    const handler = (url: string): RpcHandler => async (ctx) => {
      await ctx.fetch(url, { method: "GET", headers: { Authorization: `Bearer ${secret(ctx.env, "whatsapp_api_token")}` } });
      return structuredClone(answer);
    };
    const right = "https://graph.facebook.com/v21.0/100000000000001?fields=verified_name,display_phone_number,quality_rating";
    expect((await runCase(c, { handlers: { rpcCheckWhatsApp: handler(right) } })).status).toBe("pass");
    const r = await runCase(c, { handlers: { rpcCheckWhatsApp: handler(right.replace("v21.0", "v22.0")) } });
    expect(pathsOf(r)).toEqual(["call 1 rpcCheckWhatsApp outbound[0].url"]);
  });
});

describe("the secret is mirrored, and never printed", () => {
  it("the new side holds the token the old config tab holds (the fake reads it from env); a blank one gives the new side none", async () => {
    expect((await runCase(sendCase(sender()))).status).toBe("pass"); // would throw MissingSecretError if env were not mirrored
    const blank = directCase("Notifier.sendOp", { old: "Notifier.sendOp", new: (deps) => (maybeSecret(deps.env, "whatsapp_api_token") === null ? { sent: false, reason: "not_configured" } : "a token was mirrored") }, { args: OPEN_ARGS, settings: { whatsapp_api_token: "" } });
    const r = await runCase(blank);
    expect(r.diffs).toEqual([]);
    expect(r.status).toBe("pass");
  });

  it("a setting is set on both sides from one declaration", async () => {
    const c = sendCase(sender(), { settings: { whatsapp_api_token: SECRET, whatsapp_template_shift_open: "custom_open", whatsapp_target_number: "14165550102", whatsapp_template_lang: "en_GB" }, http: [SENT] });
    const r = await runCase(c);
    expect(r.diffs.every((d) => d.path.startsWith("$"))).toBe(true); // only the fake's ANSWER (the two-recipient one) differs: the requests agree
    expect(r.calls[0]?.outbound.old.length).toBe(1);
    expect(r.calls[0]?.outbound.new).toEqual(r.calls[0]?.outbound.old);
    expect(r.calls[0]?.outbound.old[0]).toMatchObject({ body: { to: "14165550102", template: { name: "custom_open", language: { code: "en_GB" } } } });
  });

  it("settings are refused when they name no config key, a real-looking number, or a real-looking secret", () => {
    expect(() => directCase("x", { old: "x", new: () => null }, { settings: { not_a_key: "1" } })).toThrow(/not a config key/);
    expect(() => directCase("x", { old: "x", new: () => null }, { settings: { whatsapp_target_number: "14165551234" } })).toThrow(/not a fictional number/);
    expect(() => directCase("x", { old: "x", new: () => null }, { settings: { whatsapp_api_token: "EAAG-looks-real" } })).toThrow(/invented/);
    expect(() => directCase("x", { old: "x", new: () => null }, { settings: { whatsapp_target_number: "14165550100, 14165550199", whatsapp_api_token: "fictional-x" } })).not.toThrow();
  });

  it("the secret appears nowhere in any report text, even when the new side leaks it or sends the wrong one", async () => {
    const results = [
      await runCase(sendCase(sender({ leak: true }))),
      await runCase(sendCase(sender({ token: WRONG }))),
      await runCase(sendCase(sender({ noAuth: true, extra: 1 }))),
      await runCase(sendCase(() => {
        throw new Error(`boom ${SECRET}`);
      })),
      await runCase(sendCase(sender(), { http: [SENT] })),
    ];
    // The leak is a difference (the old answer has no `leaked`), shown with the secret replaced.
    expect(results[0]?.diffs[0]).toMatchObject({ path: "$.leaked", new: '"<secret>"' });
    const text = [...results.map((r) => formatResult(r) + formatCalls(r) + JSON.stringify(r)), formatSummary(results)].join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(WRONG);
    expect(text).toContain("<secret>");
  });

  it("the run's rules say how outbound HTTP is compared and how secrets are mirrored, once each", async () => {
    const lines = formatSummary([await runCase(sendCase(sender()))]).split("\n");
    expect(lines.filter((l) => l.startsWith("outbound HTTP, by rule")).length).toBe(1);
    const secrets = lines.filter((l) => l.startsWith("secrets, by rule"));
    expect(secrets.length).toBe(1);
    expect(secrets[0]).toContain("WHATSAPP_API_TOKEN");
    expect(secrets[0]).toContain("whatsapp_api_token");
    expect(lines).toContain("exemptions declared by cases (0):");
  });
});

describe("nothing reaches a real network", () => {
  it("a new side that calls the global fetch is caught (and the guard answers for it)", async () => {
    takeNetworkLeaks();
    const r = await runCase(
      sendCase(async () => {
        await fetch("https://graph.facebook.com/v21.0/100000000000001/messages", { method: "POST" });
        return BOTH_SENT;
      }),
    );
    expect(r.status).toBe("fail"); // the fetch threw inside the fake: an error where the old side answered
    const leaks = takeNetworkLeaks();
    expect(leaks.length).toBe(1);
    expect(leaks[0]).toContain("global fetch(https://graph.facebook.com/v21.0/100000000000001/messages)");
  });

  it("the old runtime's own UrlFetchApp is never reached by a step (outside a step it is a guard that counts)", async () => {
    takeNetworkLeaks();
    const w = await createWorlds();
    try {
      const reach = (): unknown => w.old.run(() => (globalThis as unknown as { UrlFetchApp: { fetch(u: string): unknown } }).UrlFetchApp.fetch("https://graph.facebook.com/x"));
      expect(reach).toThrow(/UrlFetchApp was reached/);
      expect(takeNetworkLeaks()).toEqual(["old UrlFetchApp.fetch(https://graph.facebook.com/x)"]);
      // A call made with a script is answered from it and leaves nothing.
      const o = new Outbound([SENT]);
      w.old.run(() => (globalThis as unknown as { UrlFetchApp: { fetch(u: string): unknown } }).UrlFetchApp.fetch("https://graph.facebook.com/x"), o);
      expect(o.requests.length).toBe(1);
      expect(takeNetworkLeaks()).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it("every step of every case above made no real request", () => {
    expect(takeNetworkLeaks()).toEqual([]);
  });
});

describe("direct calls", () => {
  it("count towards no RPC's coverage", () => {
    expect(casedRpcs([sendCase(sender())], {})).toEqual([]);
  });

  it("have no session: `as` is refused", () => {
    expect(() => directCase("x", { old: "x", new: () => null }, { as: "admin" })).toThrow(/direct call/);
    expect(() => paritySequence("t", {}, [{ ...step("x", { as: "admin" }), direct: { old: "x", new: () => null } }])).toThrow(/direct call/);
  });

  it("an old function that does not exist is an error answer, not a crash", async () => {
    const r = await runCase(directCase("Notifier.nope", { old: "Notifier.nope", new: () => null }));
    expect(r.status).toBe("fail");
    expect(r.diffs[0]?.old).toContain("the old server has no function Notifier.nope");
  });

  it("a new side that throws is that message, compared like an RPC's", async () => {
    const r = await runCase(directCase("Notifier.sendOp", { old: "Notifier.sendOp", new: () => { throw new Error("nope"); } }, { args: ["shift_open", [], ""], http: [SENT, SENT] }));
    expect(r.diffs[0]?.new).toContain('(error) "nope"');
  });
});

// ── Undo: a void on the new side is a delete on the old (VOIDED_PAYMENTS_RULE) ──

const OLD_PAYMENT = "P_20261120_093000_8lu"; // the fixture's payment of S_003's shifts up to 2026-11-09: 110 items

/**
 * A port of rpcUndoPayment for one shift payment (no bonus items), exactly right unless told
 * otherwise: it voids the payment, keeps it and its items, and writes the old audit row.
 */
function undoFake(o: { skipVoid?: boolean } = {}): RpcHandler {
  return async (ctx, paymentId) => {
    const actorId = ctx.session?.staffId as string;
    const p = await ctx.db.maybeOne<{ staff_id: string; total_amount: number }>("select staff_id, total_amount from ops.payments where payment_id = $1 and voided_at is null", [paymentId]);
    if (!p) throw new Error("Payment not found: " + String(paymentId));
    const n = await ctx.db.one<{ n: number }>("select count(*)::int as n from ops.payment_items where payment_id = $1", [paymentId]);
    if (!o.skipVoid) await ctx.db.query("update ops.payments set voided_at = $2, voided_by = $3 where payment_id = $1", [paymentId, ctx.now, actorId]);
    await audit.write(ctx.db, { actorId, action: "payment.undo", targetType: "payments", targetId: paymentId as string, before: { staffId: p.staff_id, amount: p.total_amount, itemCount: n.n } }, { now: ctx.now });
    return { success: true, removedPaymentId: paymentId, removedItemCount: n.n };
  };
}

describe("undo: a voided payment on the new side equals a deleted one on the old", () => {
  const undoCase = parityCase("rpcUndoPayment", { as: "admin", args: [OLD_PAYMENT], writes: ["payments", "payment_items", "audit_log"] });

  it("(a) voiding the payment the old side deleted passes: the payment, its 110 items and the void columns are left out", async () => {
    const r = await runCase(undoCase, { handlers: { rpcUndoPayment: undoFake() } });
    expect(r.diffs).toEqual([]);
    expect(r.status).toBe("pass");
  });

  it("(b) a payment that should have been voided and was not still fails, with its items", async () => {
    const r = await runCase(undoCase, { handlers: { rpcUndoPayment: undoFake({ skipVoid: true }) } });
    expect(r.status).toBe("fail");
    expect(r.diffs.filter((d) => d.where === "table payments")).toEqual([expect.objectContaining({ path: `[${OLD_PAYMENT}]`, old: "(missing)" })]);
    expect(r.diffs.filter((d) => d.where === "table payment_items").length + r.hidden).toBeGreaterThanOrEqual(110);
  });

  it("(c) a payment voided when the old side kept it fails", async () => {
    const c = parityCase("rpcCreateBonus", { as: "admin", args: [BONUS_INPUT], writes: ["bonuses", "audit_log", "payments", "payment_items"] });
    const voidsToo: RpcHandler = async (ctx, ...args) => {
      const out = await bonusFake()(ctx, ...args);
      await ctx.db.query("update ops.payments set voided_at = $2, voided_by = $3 where payment_id = $1", [OLD_PAYMENT, ctx.now, "S_001"]);
      return out;
    };
    const r = await runCase(c, withBonus(voidsToo));
    expect(r.status).toBe("fail");
    const pays = r.diffs.filter((d) => d.where === "table payments");
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ path: `[${OLD_PAYMENT}]`, new: "(missing)" });
    expect(r.diffs.some((d) => d.where === "table payment_items" && d.new === "(missing)")).toBe(true);
  });

  it("the run's rules state the void rule once, and the void columns as new-only", async () => {
    const lines = formatSummary([await runCase(undoCase, { handlers: { rpcUndoPayment: undoFake() } })]).split("\n");
    const rule = lines.filter((l) => l.startsWith("equivalent, by rule (ops/parity/writes.ts VOIDED_PAYMENTS_RULE)"));
    expect(rule).toHaveLength(1);
    expect(rule[0]).toContain("deletes them on undo");
    expect(lines.filter((l) => l.includes("payments.voided_at, voided_by, void_reason"))).toHaveLength(1);
  });
});

// DAY_ONLY_RULE (day-only.ts): fields whose column holds a day, not an instant.
describe("fields stored as a day are compared as that day in Toronto", () => {
  it("the same day at different times of day is equal; the rule names its fields", () => {
    const old = { handovers: [{ handedOn: "2026-11-16T15:00:00.000Z", recordedAt: "2026-11-16T15:00:00.000Z" }] };
    const neu = { handovers: [{ handedOn: "2026-11-16T05:00:00.000Z", recordedAt: "2026-11-16T15:00:00.000Z" }] };
    expect(dayOnly(old)).toEqual(dayOnly(neu));
    expect(dayOnly(old)).toEqual({ handovers: [{ handedOn: "<day 2026-11-16>", recordedAt: "2026-11-16T15:00:00.000Z" }] });
    expect(DAY_ONLY_KEYS.map((k) => k.key)).toContain("handedOn");
    for (const k of DAY_ONLY_KEYS) expect(k.reason.trim()).not.toBe("");
  });
  it("a different day is still a difference, and the day is Toronto's, not UTC's", () => {
    // 03:00Z on the 17th is 22:00 on the 16th in Toronto.
    expect(dayOnly({ handedOn: "2026-11-17T03:00:00.000Z" })).toEqual({ handedOn: "<day 2026-11-16>" });
    expect(dayOnly({ handedOn: "2026-11-17T05:00:00.000Z" })).toEqual({ handedOn: "<day 2026-11-17>" });
  });
  it("a field the rule does not name keeps its time of day", () => {
    expect(dayOnly({ recordedAt: "2026-11-16T15:00:00.000Z", when: "2026-11-16T05:00:00.000Z" })).toEqual({ recordedAt: "2026-11-16T15:00:00.000Z", when: "2026-11-16T05:00:00.000Z" });
  });
  it("null, a blank, a plain day and anything that is not an instant are left as they are (so null against a date is a difference)", () => {
    const v = { handedOn: null, a: { handedOn: "" }, b: { handedOn: "2026-11-16" }, c: { handedOn: 5 }, d: { handedOn: "soon" } };
    expect(dayOnly(v)).toEqual(v);
  });
  it("a case where the new side answers another day fails; the same day passes", async () => {
    const c = parityCase("rpcGetCashHandoverHistory", { as: "admin", args: [3] });
    const old = (await recordOld(c))[0] as { handovers: { handedOn: string }[] };
    expect(old.handovers[0]!.handedOn).toMatch(/T15:00:00\.000Z$/); // the fixture's drops are at 10:00 Toronto
    const at = (hoursOn: number) => ({ ...old, handovers: old.handovers.map((h) => ({ ...h, handedOn: new Date(Date.parse(h.handedOn) + hoursOn * 3600_000).toISOString() })) });
    expect((await runCase(c, { handlers: { rpcGetCashHandoverHistory: returning(at(-10)) } })).status).toBe("pass"); // Toronto midnight
    const r = await runCase(c, { handlers: { rpcGetCashHandoverHistory: returning(at(24)) } });
    expect(r.status).toBe("fail");
    expect(r.diffs[0]).toMatchObject({ path: "$.handovers[0].handedOn", old: '"<day 2026-11-16>"', new: '"<day 2026-11-17>"' });
  });
});

// SECRETS_RULE (http.ts), widened Nov 26 for Clover: the reconcile's three "through the RPC" cases
// failed because only the WhatsApp token reached the new side.
describe("every secret the old app keeps in its config tab is mirrored to the new side's bindings, each under its own label", () => {
  it("the two Clover tokens reach the new side, and each is shown by name, never printed", async () => {
    const w = await createWorlds({ settings: { clover_cstore_token: "tok-cstore-000111", clover_vape_token: "tok-vape-000222", whatsapp_api_token: "tok-wa-000333" } });
    try {
      const r = await w.callNewDirect((deps) => ({ c: deps.env["CLOVER_CSTORE_TOKEN"], v: deps.env["CLOVER_VAPE_TOKEN"], wa: deps.env["WHATSAPP_API_TOKEN"] }), []);
      expect(r.outcome).toEqual({ kind: "ok", value: { c: "tok-cstore-000111", v: "tok-vape-000222", wa: "tok-wa-000333" } });
      const shown = redact({ a: "Bearer tok-cstore-000111", b: ["x tok-vape-000222 y"], "tok-wa-000333": 1 }, w.mirroredSecrets());
      expect(shown).toEqual({ a: "Bearer <secret:clover_cstore_token>", b: ["x <secret:clover_vape_token> y"], "<secret>": 1 });
      const view = (token: string) => viewOf({ method: "GET", url: "https://api.clover.com/v3/x", headers: { authorization: `Bearer ${token}` }, body: undefined } as never, w.mirroredSecrets()).authorization;
      // The wrong till's token is a visible difference, not "a secret is a secret".
      expect(view("tok-cstore-000111")).toBe("Bearer <secret:clover_cstore_token>");
      expect(view("tok-vape-000222")).toBe("Bearer <secret:clover_vape_token>");
      expect(view("tok-wa-000333")).toBe("Bearer <secret>");
      expect(view("something-else")).toBe("Bearer <a different value>");
    } finally {
      await w.close();
    }
  });
  it("a blank token is not bound", async () => {
    const w = await createWorlds({ settings: { clover_cstore_token: "", clover_vape_token: "tok-vape-000222" } });
    try {
      const r = await w.callNewDirect((deps) => Object.keys(deps.env).filter((k) => k.startsWith("CLOVER_")), []);
      expect(r.outcome).toEqual({ kind: "ok", value: ["CLOVER_VAPE_TOKEN"] });
    } finally {
      await w.close();
    }
  });
});
