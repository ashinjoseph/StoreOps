// The record of which RPCs have parity cases: derived from the cases themselves
// (cases/index.ts), so it cannot drift from them. An RPC counts when some case
// compares a call to it that the REAL registry answers; a call answered by a
// probe (probes.ts) does not count. Every case must pass for the run to pass,
// so in a green run "has a case" means "has a passing case".
import { handlers as registry } from "../src/rpc/registry";
import type { RpcHandlers } from "../src/rpc/types";
import type { ParityCase } from "./case";
import { hasHandler } from "./gate";

export function casedRpcs(cases: readonly ParityCase[], handlers: RpcHandlers = registry): string[] {
  const out = new Set<string>();
  for (const c of cases) {
    for (const s of c.steps) {
      const byProbe = !hasHandler(handlers, s.rpc) && hasHandler(c.probes, s.rpc);
      if (!byProbe) out.add(s.rpc);
    }
  }
  return [...out].sort();
}
