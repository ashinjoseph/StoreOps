// The parity run: every case in cases/, then the gate.
//
//   npm --prefix ops run parity                          every case, the harness self-tests, the gate
//   npm --prefix ops run parity -- rpcLogin rpcGetMe      only the cases that call those RPCs, and the gate
//   PARITY_VERBOSE=1 npm --prefix ops run parity ...       also print every call's two answers
//
// (cli.mjs turns the RPC names into PARITY_RPCS for this file.)
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { parseRpcContract } from "../src/rpc/contract";
import { handlers } from "../src/rpc/registry";
import { allCases } from "./cases/index";
import { casedRpcs } from "./covered";
import { gate } from "./gate";
import { takeNetworkLeaks } from "./network";
import { formatCalls, formatGate, formatResult, formatSummary } from "./report";
import { closeWorlds, runCase, type CaseResult } from "./run";

const contract = parseRpcContract(JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")));
const only = (process.env["PARITY_RPCS"] ?? "").split(",").filter(Boolean);
const selected = only.length === 0 ? allCases : allCases.filter((c) => c.steps.some((s) => only.includes(s.rpc)));
const results: CaseResult[] = [];

afterAll(async () => {
  await closeWorlds();
  process.stdout.write("\n" + formatSummary(results) + "\n");
});

describe("parity: old and new answer the same", () => {
  if (only.length > 0 && selected.length === 0) {
    it(`a case for ${only.join(", ")}`, () => {
      throw new Error(`no parity case calls ${only.join(", ")}`);
    });
  }
  for (const c of selected) {
    it(c.title, async (ctx) => {
      const r = await runCase(c);
      results.push(r);
      if (process.env["PARITY_VERBOSE"]) process.stdout.write(formatCalls(r) + "\n");
      if (r.status === "not_ported") ctx.skip(`not ported: ${r.notPorted.join(", ")} has no handler yet`);
      expect(r.status, formatResult(r)).toBe("pass");
    });
  }
});

describe("parity: nothing left the process", () => {
  it("neither the real fetch nor the old runtime's own UrlFetchApp was reached by any case", () => {
    expect(takeNetworkLeaks()).toEqual([]);
  });
});

describe("parity: the gate", () => {
  it("every migrated RPC with a handler has a parity case", () => {
    const g = gate({ contract, handlers, cased: casedRpcs(allCases) });
    process.stdout.write("\n" + formatGate(g) + "\n");
    expect(g.missingCase, "a handler may not exist without a parity case").toEqual([]);
  });
});
