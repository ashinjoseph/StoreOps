// Running a case: both sides, every step, then the comparison.
//
//   const r = await runCase(parityCase("rpcGetCashPosition", { as: "manager" }));
//   r.status   "pass" | "fail" | "not_ported"
//   r.diffs    every listed difference: { where: "call 1 rpcGetCashPosition", path: "$.holders[0].total", old, new }
//
// Order: sign in every caller the case names (both sides), fingerprint both
// sides, run the steps (each one: old, then new, on the same clock), fingerprint
// again, then normalise and compare the answers and the outbound requests each
// side made (http.ts), then the declared tables.
import { handlers as registry } from "../src/rpc/registry";
import type { RpcHandler, RpcHandlers } from "../src/rpc/types";
import { callersOf, resolveRefs, type ColumnExemption, type ParityCase, type ResultExemption, type Side } from "./case";
import { MAX_DIFFS, Normaliser, diffOutcomes, pathMatcher, type Diff } from "./compare";
import { dayOnly } from "./day-only";
import { hasHandler } from "./gate";
import { Outbound, diffOutbound, redact, type RequestView } from "./http";
import type { Outcome, TransportFinding } from "./old-world";
import { compareTables, snapshotNew, snapshotOld, undeclaredChanges, type SideSnapshot } from "./writes";
import { contract, createWorlds, dropTemplates, type Worlds } from "./worlds";

export interface CallResult {
  step: number;
  rpc: string;
  /** At most MAX_DIFFS. */
  diffs: Diff[];
  /** How many differences there were in all. */
  total: number;
  old: Outcome;
  new: Outcome;
  /** What each side sent out during this call, as compared (the secret shown as <secret>). */
  outbound: { old: RequestView[]; new: RequestView[] };
}

export interface CaseResult {
  title: string;
  status: "pass" | "fail" | "not_ported";
  calls: CallResult[];
  /** Every listed difference, calls first, then tables. */
  diffs: Diff[];
  /** Differences beyond the ones listed (per call or table, after MAX_DIFFS). */
  hidden: number;
  /** Tables that changed without being declared: "config (new side)". */
  undeclared: string[];
  exemptions: { where: string; path: string; reason: string }[];
  /** Values in an old answer JSON (and google.script.run) cannot carry. */
  findings: (TransportFinding & { step: number; rpc: string })[];
  /** RPCs of this case with no handler on the new side. */
  notPorted: string[];
  /** Declared tables with no counterpart on one side. */
  notCompared: string[];
  /** Router fault log entries (a SERVER_ERROR's class and message). */
  faults: object[];
  /** Probes that stood in for an unported RPC. */
  probesUsed: string[];
  /** Milliseconds to make this case's fresh pair (null: it shared one). */
  freshPairMs: number | null;
}

let shared: Promise<Worlds> | null = null;
/** The pair read-only cases share. */
function sharedWorlds(): Promise<Worlds> {
  shared ??= createWorlds();
  return shared;
}

/** Drop the shared pair and every template database. Call once, in afterAll. */
export async function closeWorlds(): Promise<void> {
  const s = shared;
  shared = null;
  if (s) await (await s.catch(() => null))?.close();
  await dropTemplates();
}

/**
 * Two equal refusals compare nothing. Stated once, here; printed with every run.
 * A step called as a fixture person (`as: "manager"`, `as: "S_003"`), whom the harness signed in,
 * and answered NOT_LOGGED_IN on BOTH sides, fails the case: the caller's sign-in had run out
 * (the clock was moved past it), so the answers the case was written to compare were never
 * produced. A step that is about exactly that says `expect: "signed_out"`, and then both sides
 * MUST answer NOT_LOGGED_IN. Steps with no token (`as: null`) or a token from an earlier step
 * (`as: { token }`) are not touched: there the refusal is the answer under test.
 */
export const SIGNED_OUT_RULE =
  'a step called as a fixture person and answered NOT_LOGGED_IN on both sides fails the case unless it says expect: "signed_out" (and with that, both sides must answer NOT_LOGGED_IN)';
const signedOut = (o: Outcome): boolean => o.kind === "error" && /(^|: )NOT_LOGGED_IN$/.test(o.message);

const isResultExemption = (e: ResultExemption | ColumnExemption): e is ResultExemption => "path" in e;

/** Strings under a key named `token`, walking keys in sorted order. */
function tokensIn(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => tokensIn(x, out));
  else if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (k === "token" && typeof x === "string") out.push(x);
      else tokensIn(x, out);
    }
  }
  return out;
}

interface Executed {
  worlds: Worlds;
  fresh: boolean;
  freshPairMs: number | null;
  /** Both sides, after the callers signed in and before the first step. */
  before: { old: SideSnapshot; new: SideSnapshot };
  steps: { rpc: string; old: Outcome; new: Outcome; findings: TransportFinding[]; faults: object[]; outbound: { old: Outbound; new: Outbound }; secret: string | null }[];
}

async function execute(c: ParityCase, handlers: RpcHandlers, newSide: boolean): Promise<Executed> {
  // A case that writes, sets settings or moves the clock has a pair of its own. The clock: a
  // sign-in that runs out is deleted by the old app when next looked at, and the harness signs
  // each person in once per pair, so on the shared pair every later case would meet a caller the
  // old side no longer knows.
  const fresh = c.writes !== null || c.settings !== null || c.steps.some((s) => s.at !== undefined || s.advance !== undefined);
  const t0 = performance.now();
  const worlds = fresh ? await createWorlds({ settings: c.settings }) : await sharedWorlds();
  const freshPairMs = fresh ? performance.now() - t0 : null;
  try {
    return await steps(c, handlers, newSide, worlds, fresh, freshPairMs);
  } catch (err) {
    if (fresh) await worlds.close();
    throw err;
  }
}

async function steps(c: ParityCase, handlers: RpcHandlers, newSide: boolean, worlds: Worlds, fresh: boolean, freshPairMs: number | null): Promise<Executed> {
  worlds.clock.set(worlds.startAt);
  for (const who of [...new Set(c.steps.flatMap(callersOf))]) await worlds.signIn(who);
  const before = { old: snapshotOld(worlds.old), new: await snapshotNew(worlds.appUrl) };

  const results = { old: [] as unknown[], new: [] as unknown[] };
  const side = (name: "old" | "new"): Side => ({
    side: name,
    results: results[name],
    person: (who) => worlds.old.person(who),
    token: (who) => {
      const p = worlds.old.person(who);
      const t = name === "old" ? worlds.old.harnessTokens().get(p.staffId) : worlds.newTokens().get(p.staffId);
      if (t === undefined) throw new Error(`harness: ${who} was not signed in before the case`);
      return t;
    },
  });
  const sides = { old: side("old"), new: side("new") };
  const ran: Executed["steps"] = [];
  for (const s of c.steps) {
    if (s.at !== undefined) worlds.clock.set(s.at);
    if (s.advance !== undefined) worlds.clock.advance(s.advance);
    const needsSession = s.direct === undefined && contract.get(s.rpc)?.needs_session === true;
    const argsFor = (x: Side): unknown[] => {
      const rest = resolveRefs(s.args ?? [], x) as unknown[];
      let all = rest;
      if (needsSession) {
        const token = s.as === null || s.as === undefined ? null : typeof s.as === "string" ? x.token(s.as) : resolveRefs(s.as.token, x);
        all = [token, ...rest];
      }
      // What google.script.run and HTTP both do to the page's arguments.
      return JSON.parse(JSON.stringify(all)) as unknown[];
    };
    const findings: TransportFinding[] = [];
    // The same script for both sides; each side records what it sends and gets the replies in order.
    const outbound = { old: new Outbound(s.http ?? []), new: new Outbound(s.http ?? []) };
    const o = s.direct ? worlds.old.callPath(s.direct.old, argsFor(sides.old), findings, outbound.old) : worlds.old.call(s.rpc, argsFor(sides.old), findings, outbound.old);
    const n = !newSide
      ? { outcome: { kind: "not_ported" } as Outcome, faults: [] }
      : s.direct
        ? await worlds.callNewDirect(s.direct.new, argsFor(sides.new), outbound.new)
        : await worlds.callNew(handlers, s.rpc, argsFor(sides.new), outbound.new);
    results.old.push(o.kind === "ok" ? o.value : null);
    results.new.push(n.outcome.kind === "ok" ? n.outcome.value : null);
    ran.push({ rpc: s.rpc, old: o, new: n.outcome, findings, faults: n.faults, outbound, secret: worlds.mirroredToken() });
  }
  return { worlds, fresh, freshPairMs, before, steps: ran };
}

/** The old side's answers only (the page's view of each step), e.g. to build a fake that returns them. */
export async function recordOld(c: ParityCase): Promise<unknown[]> {
  const ran = await execute(c, {}, false);
  try {
    return ran.steps.map((s, i) => {
      if (s.old.kind !== "ok") throw new Error(`recordOld: step ${i + 1} ${s.rpc} answered ${JSON.stringify(s.old)}`);
      return s.old.value;
    });
  } finally {
    if (ran.fresh) await ran.worlds.close();
  }
}

/**
 * Run a case on both sides and compare. `handlers` replaces the registry (the
 * harness's own tests use it for fakes); otherwise the registry's handlers
 * answer, with the case's probes only where the registry has none.
 */
export async function runCase(c: ParityCase, opts: { handlers?: RpcHandlers } = {}): Promise<CaseResult> {
  const base = opts.handlers ?? registry;
  const probesUsed = Object.keys(c.probes).filter((k) => !hasHandler(base, k));
  const handlers: Record<string, RpcHandler> = { ...base };
  for (const k of probesUsed) handlers[k] = c.probes[k] as RpcHandler;
  const result: CaseResult = {
    title: c.title,
    status: "pass",
    calls: [],
    diffs: [],
    hidden: 0,
    undeclared: [],
    exemptions: c.exempt.map((e) => (isResultExemption(e) ? { where: "result", path: e.path, reason: e.reason } : { where: `table ${e.table}`, path: e.column, reason: e.reason })),
    findings: [],
    notPorted: [...new Set(c.steps.filter((s) => !s.direct).map((s) => s.rpc).filter((r) => !hasHandler(handlers, r)))],
    notCompared: [],
    faults: [],
    probesUsed,
    freshPairMs: null,
  };
  // Never run (or pass) a case whose RPC the new side cannot answer.
  if (result.notPorted.length > 0) {
    result.status = "not_ported";
    return result;
  }

  const ran = await execute(c, handlers, true);
  const w = ran.worlds;
  try {
    result.freshPairMs = ran.freshPairMs;
    const after = { old: snapshotOld(w.old), new: await snapshotNew(w.appUrl) };

    // Normalise. Tokens first (harness sign-ins, then those the answers hand out, step by step,
    // the same walk on both sides), then the answers in step order, then the tables.
    const norms = { old: new Normaliser(w.baseIds.old, w.old.harnessTokens()), new: new Normaliser(w.baseIds.new, w.newTokens()) };
    const newTokens = [...w.newTokens().values()];
    for (const s of ran.steps) {
      if (s.old.kind === "ok") norms.old.learnTokens(s.old.value);
      if (s.new.kind === "ok") {
        norms.new.learnTokens(s.new.value);
        newTokens.push(...tokensIn(s.new.value));
      }
    }
    const matchers = c.exempt.filter(isResultExemption).map((e) => pathMatcher(e.path));
    const exempt = (p: string): boolean => matchers.some((m) => m(p));
    ran.steps.forEach((s, i) => {
      // The secret is never printed, wherever a side put it (SECRETS_RULE in http.ts).
      // DAY_ONLY_RULE (day-only.ts): fields stored as a day are compared as that day.
      const o = dayOnly(redact(norms.old.outcome(s.old), s.secret));
      const n = dayOnly(redact(norms.new.outcome(s.new), s.secret));
      const sent = diffOutbound(s.outbound.old, s.outbound.new, s.secret);
      const found = [...diffOutcomes(o, n, exempt), ...sent.diffs];
      // SIGNED_OUT_RULE.
      const spec = c.steps[i]!;
      const bothOut = signedOut(s.old) && signedOut(s.new);
      if (spec.expect === "signed_out" && !bothOut) {
        found.push({ path: "(caller)", old: `expected NOT_LOGGED_IN (expect: "signed_out"); answered ${s.old.kind}`, new: `expected NOT_LOGGED_IN; answered ${s.new.kind}` });
      } else if (spec.expect !== "signed_out" && bothOut && typeof spec.as === "string") {
        const why = `NOT_LOGGED_IN: ${spec.as}'s sign-in had run out before this step, so nothing was compared (sign in again in the case, or say expect: "signed_out")`;
        found.push({ path: "(caller)", old: why, new: why });
      }
      const where = `call ${i + 1} ${s.rpc}`;
      const listed = found.slice(0, MAX_DIFFS).map((d) => ({ where, ...d }));
      result.calls.push({ step: i + 1, rpc: s.rpc, diffs: listed, total: found.length, old: o, new: n, outbound: { old: sent.old, new: sent.new } });
      result.diffs.push(...listed);
      result.hidden += found.length - listed.length;
      result.findings.push(...s.findings.map((f) => ({ ...f, step: i + 1, rpc: s.rpc })));
      result.faults.push(...redact(s.faults, s.secret));
      if (s.new.kind === "not_ported" && !result.notPorted.includes(s.rpc)) result.notPorted.push(s.rpc);
    });

    if (c.writes !== null && c.writes.length > 0) {
      const columnExempt = c.exempt.filter((e): e is ColumnExemption => !isResultExemption(e));
      const tables = await compareTables({
        tables: c.writes,
        old: w.old,
        appUrl: w.appUrl,
        norms,
        newTokens,
        now: w.clock.now(),
        exempt: (table, column) => columnExempt.some((e) => e.table === table && e.column === column),
      });
      result.diffs.push(...tables.diffs);
      result.hidden += tables.hidden;
      result.notCompared = tables.notCompared;
    }
    result.undeclared = undeclaredChanges(ran.before, after, c.writes ?? []);
    if (result.notPorted.length > 0) result.status = "not_ported";
    else if (result.diffs.length > 0 || result.hidden > 0 || result.undeclared.length > 0) result.status = "fail";
    return result;
  } finally {
    if (ran.fresh) await w.close();
  }
}
