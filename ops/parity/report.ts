// What the parity run prints.
import { render } from "./compare";
import type { GateResult } from "./gate";
import type { CaseResult } from "./run";
import { EXPIRED_SESSIONS_RULE, NEW_ONLY_COLUMNS } from "./writes";
import { pairTimings } from "./worlds";

/** Every call of a case with both sides' (normalised) answers: PARITY_VERBOSE=1. */
export function formatCalls(r: CaseResult): string {
  const show = (o: CaseResult["calls"][number]["old"]): string => (o.kind === "ok" ? render(o.value) : o.kind === "error" ? `(error) ${JSON.stringify(o.message)}` : "(not ported)");
  return [`${r.status.toUpperCase()}  ${r.title}`, ...r.calls.map((c) => `  ${c.step}. ${c.rpc}\n      old: ${show(c.old)}\n      new: ${show(c.new)}`)].join("\n");
}

/** One case, for a failing assertion's message. */
export function formatResult(r: CaseResult): string {
  const lines = [`${r.status.toUpperCase()}  ${r.title}`];
  for (const d of r.diffs) lines.push(`  ${d.where}  ${d.path}\n      old: ${d.old}\n      new: ${d.new}`);
  if (r.hidden > 0) lines.push(`  ... and ${r.hidden} more difference(s) not listed`);
  for (const u of r.undeclared) lines.push(`  changed but not declared in writes: ${u}`);
  for (const n of r.notCompared) lines.push(`  not compared: ${n}`);
  for (const f of r.faults) lines.push(`  new-side fault: ${JSON.stringify(f)}`);
  if (r.notPorted.length > 0) lines.push(`  not ported: ${r.notPorted.join(", ")}`);
  return lines.join("\n");
}

export function formatGate(g: GateResult): string {
  const list = (xs: readonly string[]): string => (xs.length === 0 ? "    (none)" : xs.map((x) => `    ${x}`).join("\n"));
  return [
    "parity gate (ops/contracts/rpc.json, migrate: true)",
    `  ported, with a parity case (${g.covered.length}):`,
    list(g.covered),
    `  ported, with NO parity case (${g.missingCase.length})${g.missingCase.length > 0 ? "  <- FAILS: a handler may not exist without a parity case" : ""}:`,
    list(g.missingCase),
    `  not ported yet (${g.notPorted.length}):`,
    list(g.notPorted.map((n) => (g.casedButNotPorted.includes(n) ? `${n}  (a case is waiting)` : n))),
  ].join("\n");
}

const ms = (xs: readonly number[]): string => {
  if (xs.length === 0) return "none made";
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return `${xs.length} made: mean ${(mean / 1000).toFixed(2)} s, fastest ${((sorted[0] as number) / 1000).toFixed(2)} s, slowest ${((sorted[sorted.length - 1] as number) / 1000).toFixed(2)} s (the first includes loading the template)`;
};

/** The run's summary: outcomes, every exemption with its reason, the by-rule exclusions, transport findings, timing. */
export function formatSummary(results: readonly CaseResult[]): string {
  const count = (s: CaseResult["status"]): number => results.filter((r) => r.status === s).length;
  const lines = [`parity: ${count("pass")} passed, ${count("fail")} failed, ${count("not_ported")} not ported (${results.length} cases)`];
  for (const r of results.filter((x) => x.status !== "pass")) lines.push(formatResult(r));

  const exemptions = results.flatMap((r) => r.exemptions.map((e) => `  ${r.title}: ${e.where} ${e.path} — ${e.reason}`));
  lines.push(`exemptions declared by cases (${exemptions.length}):`, ...(exemptions.length ? exemptions : ["  (none)"]));
  lines.push("never compared, by rule (ops/parity/writes.ts NEW_ONLY_COLUMNS):", ...NEW_ONLY_COLUMNS.map((c) => `  ${c.table}.${c.column} — ${c.reason}`));
  lines.push(`equivalent, by rule (ops/parity/writes.ts EXPIRED_SESSIONS_RULE): ${EXPIRED_SESSIONS_RULE}`);
  lines.push("normalised, by rule (ops/parity/compare.ts): session tokens; ids generated during a case (prefix and stamp kept, random part numbered)");

  const probes = [...new Set(results.flatMap((r) => r.probesUsed))];
  if (probes.length) lines.push(`probes standing in for unported RPCs (ops/parity/probes.ts): ${probes.join(", ")}`);

  const findings = [...new Set(results.flatMap((r) => r.findings.map((f) => `  ${f.rpc} ${f.path.replace(/\[\d+\]/g, "[*]")}: ${f.kind} (the page receives null)`)))];
  if (findings.length) lines.push("old answers holding values google.script.run cannot carry:", ...findings);

  const notCompared = [...new Set(results.flatMap((r) => r.notCompared))];
  if (notCompared.length) lines.push("declared but not compared:", ...notCompared.map((n) => `  ${n}`));

  lines.push(`fresh pairs of worlds: ${ms(pairTimings)}`);
  return lines.join("\n");
}
