// The reconcile RPC gives the module a clock that measures how long this call has run, so the
// module's time budget for Clover applies to real calls (card P3-07b). No database: the module's
// reconcileDay is replaced, and what the handler hands it is looked at.
import { describe, expect, it, vi } from "vitest";

const seen: { deps?: Record<string, unknown>; actor?: unknown; mode?: unknown } = {};
vi.mock("../src/modules/reconcile", async (original) => ({
  ...(await original<typeof import("../src/modules/reconcile")>()),
  reconcileDay: vi.fn(async (_db: unknown, deps: Record<string, unknown>, actor: unknown, mode: unknown) => {
    seen.deps = deps;
    seen.actor = actor;
    seen.mode = mode;
    return { ready: true, empty: true };
  }),
}));

describe("rpcReconcileDay hands the module an elapsed-time clock", () => {
  it("starting near zero and moving forward", async () => {
    const { rpcReconcileDay } = await import("../src/rpc/handlers/reconcile");
    const ctx = {
      db: {} as never,
      session: { staffId: "S_004", name: "Jordan Reyes", role: "employee", companiesAuthorized: ["vape"], expiresAt: 0 },
      config: async () => ({}) as never,
      env: {},
      fetch,
      now: new Date("2026-11-21T22:00:00Z"),
    };
    await rpcReconcileDay(ctx as never, true);
    expect(seen.actor).toBe("S_004");
    expect(seen.mode).toBe("manual");
    const elapsed = seen.deps?.["elapsedMs"] as () => number;
    expect(typeof elapsed).toBe("function");
    const first = elapsed();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(5_000);
    await new Promise((r) => setTimeout(r, 30));
    expect(elapsed()).toBeGreaterThan(first);
  });
});
