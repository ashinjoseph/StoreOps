// npm --prefix ops run parity [-- rpcName ...]
//
// Runs the parity cases (all of them, or only those that call the named RPCs)
// with parity/vitest.config.ts. The names are checked against the contract,
// so a typo is an error rather than an empty run that passes.
//
// Why beside `npm --prefix ops test` and not inside it: the parity run is the
// gate every phase-3 card ends with, run on its own and filtered by RPC name
// (`npm run parity -- rpcX`), which vitest's file filters cannot express. It
// boots a fresh old runtime and copies a database for every write case, so it
// is the slow part, and its failures mean "old and new disagree", not "a unit
// is broken". CI runs it as its own step in the ops job, after the unit tests.
//
// (This file is cli.mjs, not run.mjs: the tests import ./run, and Vite would
// resolve that to run.mjs before run.ts.)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ops = fileURLToPath(new URL("..", import.meta.url));
const names = process.argv.slice(2);
const contract = JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8"));
const known = new Set(contract.rpcs.map((r) => r.name));
const unknown = names.filter((n) => !known.has(n));
if (unknown.length > 0) {
  console.error(`parity: not in ops/contracts/rpc.json: ${unknown.join(", ")}`);
  process.exit(2);
}

// With names, only parity.test.ts runs (the cases and the gate); without, the harness self-tests too.
const files = names.length > 0 ? ["parity/parity.test.ts"] : [];
const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const res = spawnSync(process.execPath, [vitest, "run", "--config", "parity/vitest.config.ts", ...files], {
  cwd: ops,
  stdio: "inherit",
  env: { ...process.env, PARITY_RPCS: names.join(",") },
});
process.exit(res.status ?? 1);
