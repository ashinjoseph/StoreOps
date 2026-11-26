// How a parity case is written.
//
//   parityCase("rpcGetCashPosition", { as: "manager" })
//   parityCase("rpcRecordCashHandover", { as: "S_003", args: [{ ... }], writes: ["cash_handovers", "cash_handover_items", "audit_log"] })
//   paritySequence("a handover shows in the history", { as: "S_003", writes: [...] }, [
//     step("rpcRecordCashHandover", { args: [{ ... }] }),
//     step("rpcGetCashHandoverHistory", { args: [20, "S_003"] }),
//     step("rpcVoidCashHandover", { args: [resultOf(1, "$.handoverId")], advance: { minutes: 5 } }),
//   ])
//
// `as` says who calls: a role ("manager": the harness picks the first active
// fixture person with that role) or a staff id ("S_003"). The harness signs
// them in on both sides and puts each side's own token in front of the
// arguments. Never a token in a case: `as: { token: resultOf(1, "$.token") }`
// uses the token a step handed out (each side its own), `as: null` sends no
// token. For an RPC without a session (rpcLogin, rpcLogout), `as` is not used;
// tokenOf(who), nameOf(who) and codeOf(who) put fixture values into `args`.
//
// Outbound HTTP and settings (card P3-08):
//
//   parityCase("rpcCheckWhatsApp", { as: "admin",
//     settings: { notifier_enabled: "TRUE", whatsapp_api_token: "test-token-1" },
//     http: [{ status: 200, body: { verified_name: "Fictional Mart" } }] })
//
// `http` scripts the replies to the call's outbound requests (see http.ts): the
// same replies, in order, for both sides. `settings` sets config rows on BOTH sides
// from this one declaration, before the pair is used: the old `config` tab's row
// and the new `config` table's row. A secret key (whatsapp_api_token) is set in
// the old tab only, and mirrored into the new side's binding (SECRETS_RULE). A case
// with `settings` gets a pair of its own. A phone number must be fictional (555-01xx).
//
// A module function with no RPC of its own is compared with directCase/directStep:
//
//   directCase("Notifier.sendOp", { old: "Notifier.sendOp", new: (deps, ...a) => sendOp(deps, ...a) }, { args: [...], http: [...] })
//
// the old side calls `api.Notifier.sendOp(...args)`; the new side is called with the
// dependencies a handler would be given (config, env, fetch, db, now), inside a
// transaction, as the router would. These never count towards the gate's coverage.
//
// `writes` absent: the case only reads, and may share a pair of worlds with
// other read cases. `writes` present (even []): the case gets a fresh pair,
// and those tables are compared row by row after the last step. Either way,
// any other table that changes on either side fails the case.
import { readFileSync } from "node:fs";
import { parseRpcContract } from "../src/rpc/contract";
import type { Tx } from "../src/db/tx";
import type { Config } from "../src/lib/config";
import { configKeySpec } from "../src/lib/config-keys";
import type { RpcHandlers } from "../src/rpc/types";
import type { Duration } from "./clock";
import type { HttpReply } from "./http";
import { schema } from "./writes";

const contract = parseRpcContract(JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")));

/** What a reference needs to become a value on one side. */
export interface Side {
  readonly side: "old" | "new";
  /** The page's view of each earlier step's answer on this side (null for an error). */
  readonly results: readonly unknown[];
  /** This side's token for a fixture person (the harness has already signed them in). */
  token(who: string): string;
  person(who: string): { staffId: string; name: string; code: string };
}

/** A value that is different on each side, or comes from the fixture; resolved when the step runs. */
export class Ref {
  constructor(
    readonly label: string,
    readonly resolve: (side: Side) => unknown,
    /** Fixture people the harness must sign in before the case starts. */
    readonly signs: readonly string[] = [],
  ) {}
}

export type Caller = string | null | { token: unknown };

export interface StepSpec {
  as?: Caller;
  /** The page's arguments, without the token. May hold Refs at any depth. */
  args?: readonly unknown[];
  /** Set the clock before this step. */
  at?: Date | string;
  /** Move the clock forward before this step. */
  advance?: Duration;
  /** The replies to this step's outbound requests, in order, the same on both sides. Absent: any outbound request fails the case. */
  http?: readonly HttpReply[];
}

/** What a module function is given on the new side: what a handler gets from its context. */
export interface DirectDeps {
  config: Config;
  env: Readonly<Record<string, unknown>>;
  fetch: typeof fetch;
  db: Tx;
  now: Date;
}
export type DirectFn = (deps: DirectDeps, ...args: unknown[]) => unknown;

/** A function of the old app and its port, called with no RPC and no session. */
export interface DirectCall {
  /** A dotted path into the old server's globals: "Notifier.sendOp". */
  old: string;
  new: DirectFn;
}

export interface Step extends StepSpec {
  /** The RPC's name, or for a direct step the label shown in reports. */
  readonly rpc: string;
  readonly direct?: DirectCall;
}

/** A path in each result that may differ, and why. */
export interface ResultExemption {
  path: string;
  reason: string;
}
/** A stored column that may differ, and why. */
export interface ColumnExemption {
  table: string;
  column: string;
  reason: string;
}
export type Exemption = ResultExemption | ColumnExemption;

export interface CaseOptions extends StepSpec {
  title?: string;
  /** Config rows to set on both sides before the case (see the header). */
  settings?: Readonly<Record<string, string>>;
  /** The tables this case changes (see the header). Absent: read-only. */
  writes?: readonly string[];
  exempt?: readonly Exemption[];
  /**
   * New-side stand-ins for RPCs that are not ported yet, used only where the
   * registry has no handler (see probes.ts). Their calls are still compared.
   */
  probes?: RpcHandlers;
}

export interface ParityCase {
  readonly title: string;
  readonly steps: readonly Step[];
  /** Null: read-only. */
  readonly writes: readonly string[] | null;
  readonly exempt: readonly Exemption[];
  readonly probes: RpcHandlers;
  /** Null: the fixture's own settings. */
  readonly settings: Readonly<Record<string, string>> | null;
}

// ── References ─────────────────────────────────────────────

/** This side's token for a fixture person. */
export const tokenOf = (who: string): Ref => new Ref(`tokenOf(${who})`, (s) => s.token(who), [who]);
/** A fixture person's name as the staff tab holds it. `pad` surrounds it with spaces; `upper` upper-cases it. */
export const nameOf = (who: string, o: { pad?: boolean; upper?: boolean } = {}): Ref =>
  new Ref(`nameOf(${who})`, (s) => {
    const name = s.person(who).name;
    const cased = o.upper ? name.toUpperCase() : name;
    return o.pad ? `  ${cased}  ` : cased;
  });
/** A fixture person's login code (their PIN on the new side). */
export const codeOf = (who: string): Ref => new Ref(`codeOf(${who})`, (s) => s.person(who).code);
/** A value from an earlier step's answer on the same side: resultOf(1, "$.token"). Steps count from 1. */
export const resultOf = (stepNo: number, path: string): Ref =>
  new Ref(`resultOf(${stepNo}, ${path})`, (s) => {
    if (stepNo < 1 || stepNo > s.results.length) throw new Error(`resultOf(${stepNo}): only ${s.results.length} earlier step(s)`);
    return at(s.results[stepNo - 1], path);
  });

/** The value at a simple path ($.a.b[0]) or undefined. */
function at(value: unknown, path: string): unknown {
  if (!path.startsWith("$")) throw new Error(`a path starts with $: ${path}`);
  const parts = path.slice(1).match(/\.[^.[\]]+|\[\d+\]/g) ?? [];
  let v: unknown = value;
  for (const p of parts) {
    if (v === null || typeof v !== "object") return undefined;
    v = p.startsWith("[") ? (v as unknown[])[Number(p.slice(1, -1))] : (v as Record<string, unknown>)[p.slice(1)];
  }
  return v;
}

/** Replace every Ref in `v` (at any depth) with its value on `side`. */
export function resolveRefs(v: unknown, side: Side): unknown {
  if (v instanceof Ref) return v.resolve(side);
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, side));
  if (v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x, side)]));
  }
  return v;
}

/** Every fixture person a step needs signed in. */
export function callersOf(s: Step): string[] {
  const out: string[] = [];
  if (typeof s.as === "string") out.push(s.as);
  const scan = (v: unknown): void => {
    if (v instanceof Ref) out.push(...v.signs);
    else if (Array.isArray(v)) v.forEach(scan);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(scan);
  };
  scan(s.args ?? []);
  if (s.as !== null && typeof s.as === "object") scan(s.as.token);
  return out;
}

// ── Cases ──────────────────────────────────────────────────

export function step(rpc: string, spec: StepSpec = {}): Step {
  return { rpc, ...spec };
}

function checkExemptions(list: readonly Exemption[]): void {
  for (const e of list) {
    const reason = (e as { reason?: unknown }).reason;
    if (typeof reason !== "string" || reason.trim() === "") {
      throw new Error(`parity: an exemption needs a reason (why may this differ?): ${JSON.stringify(e)}`);
    }
    if ("path" in e) {
      if (typeof e.path !== "string" || !e.path.startsWith("$")) throw new Error(`parity: an exemption path starts with $: ${JSON.stringify(e)}`);
    } else if (!("table" in e) || !schema.tables[e.table] || typeof e.column !== "string") {
      throw new Error(`parity: an exemption names a result path or a table and column: ${JSON.stringify(e)}`);
    }
  }
}

/** A recipient is fictional: 1 + area code + 555-01xx. */
const FICTIONAL_NUMBER = /^1\d{3}55501\d\d$/;

function checkSettings(settings: Readonly<Record<string, string>>, title: string): void {
  for (const [key, value] of Object.entries(settings)) {
    const spec = configKeySpec(key);
    if (!spec) throw new Error(`parity case "${title}": settings names ${key}, which is not a config key (ops/src/lib/config-keys.ts)`);
    if (typeof value !== "string") throw new Error(`parity case "${title}": settings ${key} must be text (a blank is "")`);
    if (key === "whatsapp_target_number") {
      for (const n of value.split(/[,;\s]+/).filter(Boolean)) {
        if (!FICTIONAL_NUMBER.test(n)) throw new Error(`parity case "${title}": ${n} is not a fictional number (use 1 + an area code + 55501xx, e.g. 14165550100)`);
      }
    }
    if (spec.kind === "secret" && value !== "" && !/^(test|fictional)-/.test(value)) {
      throw new Error(`parity case "${title}": a secret in settings must look invented: start it with "test-" or "fictional-"`);
    }
  }
}

function checkStep(s: Step, title: string): void {
  if (s.direct) {
    if (s.as !== undefined) throw new Error(`parity case "${title}": ${s.rpc} is a direct call; it has no session, so no \`as\``);
    return;
  }
  const entry = contract.get(s.rpc);
  if (!entry) throw new Error(`parity case "${title}": ${s.rpc} is not in ops/contracts/rpc.json`);
  if (!entry.migrate) throw new Error(`parity case "${title}": ${s.rpc} is marked migrate: false`);
  if (entry.needs_session && s.as === undefined) {
    throw new Error(`parity case "${title}": ${s.rpc} needs a session; say who calls (as: "manager", as: "S_003", as: { token: ... } or as: null)`);
  }
  if (!entry.needs_session && s.as !== undefined) {
    throw new Error(`parity case "${title}": ${s.rpc} takes no session token; pass tokenOf(...) or resultOf(...) in args instead of as`);
  }
}

function make(title: string, spec: CaseOptions, steps: readonly Step[]): ParityCase {
  if (steps.length === 0) throw new Error(`parity case "${title}": no steps`);
  const exempt = spec.exempt ?? [];
  checkExemptions(exempt);
  if (spec.settings) checkSettings(spec.settings, title);
  for (const t of spec.writes ?? []) {
    if (!schema.tables[t] && !schema.leftTabs.has(t)) throw new Error(`parity case "${title}": writes names ${t}, which is neither a table of the schema nor a tab of the old app`);
  }
  const full = steps.map((s) => {
    const merged: Step = { ...s, ...(s.as === undefined && spec.as !== undefined && !s.direct && contract.get(s.rpc)?.needs_session ? { as: spec.as } : {}) };
    checkStep(merged, title);
    return merged;
  });
  return Object.freeze({ title, steps: full, writes: spec.writes === undefined ? null : [...spec.writes], exempt: [...exempt], probes: spec.probes ?? {}, settings: spec.settings ? { ...spec.settings } : null });
}

/** One call, compared. */
export function parityCase(rpc: string, spec: CaseOptions = {}): ParityCase {
  const { title, writes, exempt, probes, settings, ...stepSpec } = spec;
  const who = typeof spec.as === "string" ? ` as ${spec.as}` : "";
  return make(title ?? `${rpc}${who}`, { ...(writes !== undefined ? { writes } : {}), ...(exempt ? { exempt } : {}), ...(probes ? { probes } : {}), ...(settings ? { settings } : {}) }, [step(rpc, stepSpec)]);
}

/** One step that calls a module function directly on both sides (see the header). */
export function directStep(label: string, call: DirectCall, spec: StepSpec = {}): Step {
  return { rpc: label, direct: call, ...spec };
}

/** One direct call, compared. */
export function directCase(label: string, call: DirectCall, spec: CaseOptions = {}): ParityCase {
  const { title, writes, exempt, probes, settings, ...stepSpec } = spec;
  return make(title ?? label, { ...(writes !== undefined ? { writes } : {}), ...(exempt ? { exempt } : {}), ...(probes ? { probes } : {}), ...(settings ? { settings } : {}) }, [directStep(label, call, stepSpec)]);
}

/** Several calls in order on the same pair, each compared. `spec.as` is the default caller for steps that need one. */
export function paritySequence(title: string, spec: CaseOptions, steps: readonly Step[]): ParityCase {
  return make(title, spec, steps);
}
