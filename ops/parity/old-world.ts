// The old world: the real StoreOps server (src/*.gs) booted in Node over its
// in-memory spreadsheet and seeded with the fictional fixture, exactly as
// ops/test/helpers/fixture.ts bootFixture() does it.
//
// The old runtime keeps its state in process globals: runtime.js installs
// SpreadsheetApp, PropertiesService, CacheService... on `global`, and the old
// modules look them up at call time. So two booted runtimes in one process
// would read each other's spreadsheet. Each OldWorld captures the globals its
// boot installed, and `run` puts them back (with the frozen Date and a pinned
// Math.random) for the length of one synchronous call, then restores whatever
// was there before.
import { createHash } from "node:crypto";
import type { SheetTab } from "../src/import/sheet-to-db";
import { bootFixture } from "../test/helpers/fixture";
import { FrozenClock, frozenDate } from "./clock";

/** The page's view of an answer: an answer, a thrown message, or (new side only) no handler. */
export type Outcome = { kind: "ok"; value: unknown } | { kind: "error"; message: string } | { kind: "not_ported" };

/** Something an old answer held that JSON (and google.script.run) cannot carry. */
export interface TransportFinding {
  path: string;
  kind: "Date" | "NaN" | "Infinity" | "undefined in an array" | "function";
}

/** A fixture person, as the old staff tab holds them. */
export interface FixturePerson {
  staffId: string;
  name: string;
  role: string;
  active: boolean;
  code: string;
}

// The Apps Script services runtime.js installs on `global` (installServices).
const SERVICE_GLOBALS = [
  "SpreadsheetApp",
  "PropertiesService",
  "CacheService",
  "LockService",
  "ScriptApp",
  "UrlFetchApp",
  "HtmlService",
  "Session",
  "Utilities",
  "Logger",
] as const;

// `any`: the boundary with the old CommonJS runtime, whose functions are untyped JavaScript
// taking whatever the page sends. Used only to call them.
type OldFn = (...args: any[]) => any;
interface OldSpreadsheet {
  getSheets(): OldSheet[];
  getSheetByName(name: string): OldSheet | null;
}
interface OldSheet {
  getName(): string;
  getLastRow(): number;
  getLastColumn(): number;
  getRange(row: number, col: number, rows: number, cols: number): { getValues(): unknown[][] };
}
interface OldProperties {
  getProperties(): Record<string, string>;
}

const g = globalThis as unknown as Record<string, unknown>;

let worldSeq = 0;

export class OldWorld {
  /** The old server's globals: modules and rpc* functions. */
  readonly api: Record<string, unknown>;
  private readonly globals: Record<string, unknown>;
  private readonly frozen: DateConstructor;
  private draw: number;
  private readonly tokens = new Map<string, string>();

  private constructor(api: Record<string, unknown>, globals: Record<string, unknown>, readonly clock: FrozenClock) {
    this.api = api;
    this.globals = globals;
    this.frozen = frozenDate(clock);
    // Old ids end in Math.random().toString(36).substring(2, 5): 46,656 values. bootFixture drew
    // from the start of a sequence that never repeats within 46,656 draws; the cases draw from its
    // second half, so an id made in a case can never repeat one the fixture made.
    this.draw = 23_328;
  }

  /** Boot and seed a fresh old server with `clock` reading `bootAt`. */
  static boot(clock: FrozenClock, bootAt: Date): OldWorld {
    const saved = snapshotGlobals();
    const realDate = g["Date"];
    const caseTime = clock.now();
    clock.set(bootAt);
    g["Date"] = frozenDate(clock);
    let api: Record<string, unknown>;
    let globals: Record<string, unknown>;
    try {
      api = bootFixture().api;
      globals = snapshotGlobals();
    } finally {
      g["Date"] = realDate;
      restoreGlobals(saved);
      clock.set(caseTime);
    }
    for (const k of Object.keys(api)) if (api[k] !== undefined) globals[k] = api[k];
    // runtime.js's getUuid stub counts 1, 2, 3... across the whole process, so every old token
    // starts "00000000" and the audit row of a logout (token.substring(0, 8) + "...") could not
    // tell two sessions apart. Apps Script's real getUuid is random; this one is distinct per
    // world and per call (and repeatable), so a token prefix names one session, as it does live.
    const world = ++worldSeq;
    let uuids = 0;
    const utilities = globals["Utilities"] as Record<string, unknown>;
    globals["Utilities"] = {
      ...utilities,
      getUuid: () => {
        const h = createHash("sha256").update(`parity-world-${world}-uuid-${++uuids}`).digest("hex");
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
      },
    };
    // Sessions and login failure counts are not migrated: people sign in again on the new app,
    // which starts with none. The fixture signs someone in while seeding; that session (and any
    // failure count) is removed here so both worlds start without them, as a migration would.
    const props = (globals["PropertiesService"] as { getScriptProperties(): OldProperties & { deleteProperty(k: string): void } }).getScriptProperties();
    for (const k of Object.keys(props.getProperties())) if (k.startsWith("session:") || k.startsWith("loginFails:")) props.deleteProperty(k);
    return new OldWorld(api, globals, clock);
  }

  /** Run `fn` synchronously as this world: its services, the frozen Date, its random sequence. */
  run<T>(fn: () => T): T {
    const saved = snapshotGlobals(Object.keys(this.globals));
    const realDate = g["Date"];
    const realRandom = Math.random;
    for (const [k, v] of Object.entries(this.globals)) g[k] = v;
    g["Date"] = this.frozen;
    Math.random = () => (((this.draw++ * 7919) % 46656) + 0.5) / 46656;
    try {
      const out = fn();
      if (out instanceof Promise) throw new Error("OldWorld.run: the old code is synchronous; got a Promise");
      return out;
    } finally {
      Math.random = realRandom;
      g["Date"] = realDate;
      restoreGlobals(saved);
    }
  }

  /**
   * Call an old RPC the way the page does, `api.rpcX(token, ...args)`, and give
   * back what the page would receive: a thrown error as its message, an answer
   * as google.script.run delivers it (see pageView).
   */
  call(rpc: string, args: readonly unknown[], findings: TransportFinding[] = []): Outcome {
    const fn = this.api[rpc];
    if (typeof fn !== "function") return { kind: "error", message: `the old server has no function ${rpc}` };
    let value: unknown;
    try {
      value = this.run(() => (fn as OldFn)(...args));
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    return { kind: "ok", value: pageView(value, findings) };
  }

  /** The old token for a fixture person, signing them in on first use (with their own login code). */
  signIn(who: string | FixturePerson): string {
    const person = typeof who === "string" ? this.person(who) : who;
    const have = this.tokens.get(person.staffId);
    if (have !== undefined) return have;
    const out = this.call("rpcLogin", [person.name, person.code]);
    const token = out.kind === "ok" ? (out.value as { token?: unknown } | null)?.token : undefined;
    if (typeof token !== "string") throw new Error(`harness: the old side would not sign in ${person.staffId}: ${JSON.stringify(out)}`);
    this.tokens.set(person.staffId, token);
    return token;
  }

  /** Every token the harness itself was given, by staff id. */
  harnessTokens(): ReadonlyMap<string, string> {
    return this.tokens;
  }

  /** The fixture's people, in the staff tab's order. */
  people(): FixturePerson[] {
    const tab = this.tab("staff");
    const at = (name: string): number => tab.header.findIndex((h) => String(h).trim() === name);
    const [id, name, role, active, code] = ["staff_id", "name", "role", "active", "login_code"].map(at) as [number, number, number, number, number];
    return tab.rows
      .filter((r) => String(r[id] ?? "").trim() !== "")
      .map((r) => ({
        staffId: String(r[id]).trim(),
        name: String(r[name] ?? "").trim(),
        role: String(r[role] ?? "").trim(),
        active: r[active] === true || String(r[active]).toUpperCase() === "TRUE",
        code: String(r[code] ?? "").trim(),
      }));
  }

  /**
   * A role ("manager": the first active person with that role and a login code,
   * in staff-id order) or a staff id ("S_003").
   */
  person(who: string): FixturePerson {
    const all = this.people();
    const byId = all.find((p) => p.staffId === who);
    if (byId) return byId;
    const byRole = all.filter((p) => p.role === who && p.active && p.code !== "").sort((a, b) => (a.staffId < b.staffId ? -1 : 1))[0];
    if (byRole) return byRole;
    throw new Error(`harness: the fixture has no staff id ${who} and no active ${who} with a login code`);
  }

  private spreadsheet(): OldSpreadsheet {
    const app = this.globals["SpreadsheetApp"] as { getActiveSpreadsheet(): OldSpreadsheet };
    return app.getActiveSpreadsheet();
  }

  /** The tab names, in the spreadsheet's order. */
  tabNames(): string[] {
    return this.spreadsheet()
      .getSheets()
      .map((s) => s.getName());
  }

  /** One tab as the Sheet holds it: header (row 2) and data rows (row 3 on). */
  tab(name: string): SheetTab {
    const s = this.spreadsheet().getSheetByName(name);
    if (!s) return { tab: name, header: [], rows: [] };
    return readTab(s);
  }

  /** The data rows of a tab whose first cell is not blank. */
  rows(name: string): unknown[][] {
    return this.tab(name).rows.filter((r) => r[0] !== "" && r[0] !== null && r[0] !== undefined);
  }

  /** The script properties (sessions and login failure counts live here in the old app). */
  properties(): Record<string, string> {
    const svc = this.globals["PropertiesService"] as { getScriptProperties(): OldProperties };
    return { ...svc.getScriptProperties().getProperties() };
  }
}

function readTab(s: OldSheet): SheetTab {
  const lastRow = s.getLastRow();
  const lastCol = Math.max(s.getLastColumn(), 1);
  const header = s.getRange(2, 1, 1, lastCol).getValues()[0] ?? [];
  const rows = lastRow >= 3 ? s.getRange(3, 1, lastRow - 2, lastCol).getValues() : [];
  return { tab: s.getName(), header, rows };
}

function snapshotGlobals(extra: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [...SERVICE_GLOBALS, ...extra]) out[k] = g[k];
  return out;
}

function restoreGlobals(saved: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
}

/**
 * What the page receives from an old RPC. google.script.run cannot carry a
 * Date (AGENTS.md, "Gotchas": it arrives as null), so a Date becomes null here
 * and is recorded as a finding; then the value goes through
 * JSON.parse(JSON.stringify(x)), as the new side's answer does over HTTP
 * (NaN and Infinity become null, undefined in an array becomes null, an
 * undefined property disappears). Each of those is recorded too.
 */
export function pageView(value: unknown, findings: TransportFinding[] = []): unknown {
  const walk = (v: unknown, path: string, inArray: boolean): unknown => {
    if (v instanceof Date) {
      findings.push({ path, kind: "Date" });
      return null;
    }
    if (typeof v === "number" && !Number.isFinite(v)) findings.push({ path, kind: Number.isNaN(v) ? "NaN" : "Infinity" });
    if (v === undefined && inArray) findings.push({ path, kind: "undefined in an array" });
    if (typeof v === "function") findings.push({ path, kind: "function" });
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${path}[${i}]`, true));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, `${path}${keyPath(k)}`, false);
      return out;
    }
    return v;
  };
  const text = JSON.stringify(walk(value, "$", false));
  return text === undefined ? null : JSON.parse(text);
}

/** `.key` for an identifier, `["key"]` for anything else. */
export function keyPath(k: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`;
}
