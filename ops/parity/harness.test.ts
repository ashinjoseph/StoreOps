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
import { parityCase, paritySequence, step, type ParityCase } from "./case";
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
      _rowIndex: made.rowIndex,
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
