// The gate: a handler may not exist without a parity case.
//
// From ops/contracts/rpc.json, for the RPCs it marks `migrate: true` (the
// `migrate: false` ones are ignored):
//   covered      a handler in the registry, and at least one parity case
//   missingCase  a handler, and no case        -> the run fails
//   notPorted    no handler yet                -> informational
import type { RpcContract } from "../src/rpc/contract";
import type { RpcHandlers } from "../src/rpc/types";

export interface GateResult {
  covered: string[];
  missingCase: string[];
  notPorted: string[];
  /** Not-ported RPCs that already have a case waiting for them. */
  casedButNotPorted: string[];
  ok: boolean;
}

export const hasHandler = (handlers: RpcHandlers, name: string): boolean => Object.hasOwn(handlers, name) && typeof handlers[name] === "function";

export function gate(opts: { contract: RpcContract; handlers: RpcHandlers; cased: readonly string[] }): GateResult {
  const unknown = opts.cased.filter((n) => opts.contract.get(n) === undefined);
  if (unknown.length > 0) throw new Error(`parity gate: cases call RPCs that are not in the contract: ${unknown.join(", ")}`);
  const cased = new Set(opts.cased);
  const out: GateResult = { covered: [], missingCase: [], notPorted: [], casedButNotPorted: [], ok: true };
  for (const e of opts.contract.entries) {
    if (!e.migrate) continue;
    if (!hasHandler(opts.handlers, e.name)) {
      out.notPorted.push(e.name);
      if (cased.has(e.name)) out.casedButNotPorted.push(e.name);
    } else if (cased.has(e.name)) out.covered.push(e.name);
    else out.missingCase.push(e.name);
  }
  out.ok = out.missingCase.length === 0;
  return out;
}
