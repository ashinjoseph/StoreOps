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
import type { Outbound } from "./http";
import { guardedUrlFetchApp } from "./network";

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

/**
 * Two people the parity worlds add to the old `staff` tab, after the docs
 * fixture has seeded it and before the sheets are copied into Postgres.
 *
 * Why: the docs fixture (scripts/docs/fixtures.js) has one admin, one manager
 * and three employees, all active. Nobody is a payroll admin and nobody is
 * inactive, so the rules that depend on either (the role gates, "Account is
 * inactive", a staff list that filters on `active`) could not be compared. The
 * docs fixture is deliberately NOT touched: it also feeds the screenshots, and
 * they must not change. Both sides get these two from the same source, the old
 * sheet, written through the old app's own Staff.create.
 *
 * Neither owns a shift, a sale, a payment or a bonus: only a staff row. The
 * ids continue the fixture's sequence (S_001..S_005); Staff.create picks the
 * next one, and the boot checks it picked these. A case names them by role
 * (`payroll_admin`) or, for the inactive person, by id (a role means "an
 * active person with that role").
 */
export const PARITY_EXTRA_PEOPLE: readonly (FixturePerson & { hourlyRate: number; startDaysBeforeBoot: number; notes: string })[] = Object.freeze([
  { staffId: "S_006", name: "Amara Whitfield", role: "payroll_admin", active: true, code: "6666", hourlyRate: 21.5, startDaysBeforeBoot: 90, notes: "Payroll administrator" },
  { staffId: "S_007", name: "Lucas Bergstrom", role: "employee", active: false, code: "7777", hourlyRate: 17.2, startDaysBeforeBoot: 60, notes: "Left the store" },
]);

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
    // The runtime's own UrlFetchApp answers 200 to anything. A parity run must never get an answer
    // it did not script: outside a case step this is a guard that throws and counts (http.ts), and
    // a step swaps in the case's scripted one (run(), below).
    globals["UrlFetchApp"] = guardedUrlFetchApp;
    // runtime.js's getUuid stub counts 1, 2, 3... across the whole process, so every old token
    // starts "00000000" and the audit row of a logout (token.substring(0, 8) + "...") could not
    // tell two sessions apart. Apps Script's real getUuid is random; this one is distinct per
    // world and per call (and repeatable), so a token prefix names one session, as it does live.
    const worldNo = ++worldSeq;
    let uuids = 0;
    const utilities = globals["Utilities"] as Record<string, unknown>;
    globals["Utilities"] = {
      ...utilities,
      getUuid: () => {
        const h = createHash("sha256").update(`parity-world-${worldNo}-uuid-${++uuids}`).digest("hex");
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
      },
    };
    // Sessions and login failure counts are not migrated: people sign in again on the new app,
    // which starts with none. The fixture signs someone in while seeding; that session (and any
    // failure count) is removed here so both worlds start without them, as a migration would.
    const props = (globals["PropertiesService"] as { getScriptProperties(): OldProperties & { deleteProperty(k: string): void } }).getScriptProperties();
    for (const k of Object.keys(props.getProperties())) if (k.startsWith("session:") || k.startsWith("loginFails:")) props.deleteProperty(k);
    const world = new OldWorld(api, globals, clock);
    world.addExtraPeople(bootAt);
    return world;
  }

  /** Append PARITY_EXTRA_PEOPLE to the staff tab through Staff.create, as the old app would, at the boot instant. */
  private addExtraPeople(bootAt: Date): void {
    const caseTime = this.clock.now();
    this.clock.set(bootAt);
    try {
      this.run(() => {
        const staff = this.api["Staff"] as { create(input: Record<string, unknown>): { staffId: string } };
        for (const p of PARITY_EXTRA_PEOPLE) {
          const start = new Date();
          start.setDate(start.getDate() - p.startDaysBeforeBoot);
          start.setHours(0, 0, 0, 0);
          const made = staff.create({ name: p.name, hourlyRate: p.hourlyRate, active: p.active, role: p.role, loginCode: p.code, companiesAuthorized: ["cstore", "vape"], startDate: start, notes: p.notes });
          if (made.staffId !== p.staffId) throw new Error(`harness: Staff.create gave ${p.name} ${made.staffId}, expected ${p.staffId}`);
        }
      });
    } finally {
      this.clock.set(caseTime);
    }
  }

  /**
   * Run `fn` synchronously as this world: its services, the frozen Date, its random sequence.
   * `outbound` is what UrlFetchApp records and answers from for this run; without it, any
   * outbound request reaches the guard and fails loudly.
   */
  run<T>(fn: () => T, outbound?: Outbound): T {
    const saved = snapshotGlobals(Object.keys(this.globals));
    const realDate = g["Date"];
    const realRandom = Math.random;
    for (const [k, v] of Object.entries(this.globals)) g[k] = v;
    if (outbound) g["UrlFetchApp"] = { fetch: outbound.oldFetch };
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
  call(rpc: string, args: readonly unknown[], findings: TransportFinding[] = [], outbound?: Outbound): Outcome {
    const fn = this.api[rpc];
    if (typeof fn !== "function") return { kind: "error", message: `the old server has no function ${rpc}` };
    let value: unknown;
    try {
      value = this.run(() => (fn as OldFn)(...args), outbound);
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    return { kind: "ok", value: pageView(value, findings) };
  }

  /** A module function with no RPC ("Notifier.sendOp"), called as `api.Notifier.sendOp(...args)`; answered as `call` answers. */
  callPath(path: string, args: readonly unknown[], findings: TransportFinding[] = [], outbound?: Outbound): Outcome {
    const parts = path.split(".");
    let owner: unknown = this.api;
    for (const part of parts.slice(0, -1)) owner = owner !== null && typeof owner === "object" ? (owner as Record<string, unknown>)[part] : undefined;
    const fn = owner !== null && typeof owner === "object" ? (owner as Record<string, unknown>)[parts[parts.length - 1] as string] : undefined;
    if (typeof fn !== "function") return { kind: "error", message: `the old server has no function ${path}` };
    let value: unknown;
    try {
      value = this.run(() => (fn as OldFn).apply(owner, [...args]), outbound);
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : String(err) };
    }
    return { kind: "ok", value: pageView(value, findings) };
  }

  /** What the `config` tab holds for a key, as text ("" for a blank cell), or null when there is no such row. */
  configValue(key: string): string | null {
    const row = this.rows("config").find((r) => r[0] === key);
    return row === undefined ? null : String(row[1] ?? "");
  }

  /** Set a row of the `config` tab (appended when the key has none), as the fixture's own setConfig does. */
  setConfig(key: string, value: string): void {
    interface Writable {
      getRange(row: number, col: number, rows: number, cols: number): { getValues(): unknown[][]; setValue(v: unknown): void; setValues(v: unknown[][]): void };
      getLastRow(): number;
      getLastColumn(): number;
    }
    this.run(() => {
      const sh = this.spreadsheet().getSheetByName("config") as unknown as Writable | null;
      if (!sh) throw new Error("harness: the old spreadsheet has no config tab");
      const last = sh.getLastRow();
      const vals = last >= 3 ? sh.getRange(3, 1, last - 2, 2).getValues() : [];
      const at = vals.findIndex((r) => r[0] === key);
      if (at >= 0) {
        sh.getRange(3 + at, 2, 1, 1).setValue(value);
        return;
      }
      const header = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0] ?? [];
      const row = header.map((h) => (h === "key" ? key : h === "value" ? value : h === "description" ? "parity settings" : ""));
      sh.getRange(Math.max(last, 2) + 1, 1, 1, row.length).setValues([row]);
    });
  }

  /** The old token for a fixture person, signing them in on first use (with their own login code). */
  signIn(who: string | FixturePerson): string {
    const person = typeof who === "string" ? this.person(who) : who;
    if (!person.active) {
      throw new Error(`harness: ${person.staffId} (${person.name}) is inactive and cannot be signed in as a caller; call rpcLogin as a step instead (nameOf/codeOf name them)`);
    }
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
   * A role ("manager": the first ACTIVE person with that role and a login code,
   * in staff-id order; an inactive person is never picked by a role) or a staff
   * id ("S_003"; any person, active or not).
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
 * `_rowIndex` is the Sheet row an old record was read from. Several old write
 * RPCs return the whole record, so it leaks into their answers. It has no
 * meaning outside a Sheet, nothing in the page reads it (src/Index.html never
 * mentions it), and the new app has no such thing. Stated once, here, and
 * printed with every run: the old side's `_rowIndex` keys are dropped before
 * comparing. A new-side answer that contains one still fails, as an added key.
 */
export const SHEET_ROW_KEY = "_rowIndex";
export const SHEET_ROW_RULE = "`_rowIndex` (the Sheet row number some old records carry) is dropped from the old side's answers: the page never reads it and the new app has no Sheet rows";

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
      for (const [k, x] of Object.entries(v)) {
        if (k === SHEET_ROW_KEY) continue; // see SHEET_ROW_RULE
        out[k] = walk(x, `${path}${keyPath(k)}`, false);
      }
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
