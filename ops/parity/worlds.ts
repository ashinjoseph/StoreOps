// A pair of worlds: the old server and the new app over the same rows, on one clock.
//
//   const w = await createWorlds();      // fresh old runtime + fresh database
//   w.clock.advance({ minutes: 5 });     // both sides see it
//   w.old.call("rpcGetMe", [w.signIn("manager").old]);
//   await w.callNew(handlers, "rpcGetMe", [(await w.signIn("manager")).new]);
//   await w.close();
//
// The new side is a database copied from a template that was loaded, once per
// process, from an old world booted at the same instant: loadFixture (the
// tested P2-09a translation) put the old sheets' rows into it, and every
// fixture person's login code was hashed into staff.pin_hash with setPin. Each
// fresh pair boots its own old runtime and checks that its sheets are the ones
// the template was loaded from (a fingerprint of every tab); if not, it loads a
// template of its own. So "the same rows on both sides" is checked, not assumed.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { setPin } from "../src/auth/pin";
import { connect } from "../src/db/client";
import { withTransaction } from "../src/db/tx";
import { loadConfig } from "../src/lib/config";
import { configKeySpec } from "../src/lib/config-keys";
import type { SheetTab } from "../src/import/sheet-to-db";
import { parseRpcContract, type RpcContract } from "../src/rpc/contract";
import { handlers as registryHandlers, resolveSession } from "../src/rpc/registry";
import { createRpcRouter } from "../src/rpc/router";
import type { RpcHandlers } from "../src/rpc/types";
import { createTestDb, superuserUrl, TEST_PASSWORDS } from "../test/helpers/db";
import { loadFixture } from "../test/helpers/fixture";
import type { DirectFn } from "./case";
import { CASE_START_AT, FIXTURE_BOOT_AT, FrozenClock } from "./clock";
import type { Outbound } from "./http";
import { guardedFetch } from "./network";
import { OldWorld, type FixturePerson, type Outcome } from "./old-world";
import { snapshotNew, snapshotOld } from "./writes";

/** The PIN pepper of the new world. A test value, not a secret. */
export const PARITY_PEPPER = "parity-pepper-not-a-secret";

export const contract: RpcContract = parseRpcContract(JSON.parse(readFileSync(new URL("../contracts/rpc.json", import.meta.url), "utf8")));

export interface WorldOptions {
  /** When the fixture is seeded. Default FIXTURE_BOOT_AT. */
  bootAt?: Date;
  /** Where the clock stands when a case starts. Default CASE_START_AT. */
  startAt?: Date;
  /** Config rows to set on both sides, from this one declaration, before the pair is used (see case.ts, `settings`). */
  settings?: Readonly<Record<string, string>> | null;
}

export interface SignedIn {
  person: FixturePerson;
  old: string;
  new: string;
}

export interface NewCall {
  outcome: Outcome;
  /** What the router logged for a fault (SERVER_ERROR): the error class and message, for the report. */
  faults: object[];
}

export interface Worlds {
  readonly clock: FrozenClock;
  readonly old: OldWorld;
  readonly startAt: Date;
  /** The new side's database (a copy of the template). */
  readonly appUrl: string;
  /** Rows of the fixture the new database refused when the template was loaded (should be none). */
  readonly loadRejects: number;
  /**
   * Every id-shaped value on each side when the pair was made, before anyone
   * signed in: the fixture's own ids, the same on both sides. Any other id is
   * one this pair generated (a harness sign-in's audit row, or a case's write)
   * and is normalised.
   */
  readonly baseIds: { old: ReadonlySet<string>; new: ReadonlySet<string> };
  /** Sign a fixture person in on both sides (once per pair; later calls reuse the tokens). */
  signIn(who: string): Promise<SignedIn>;
  /** Every token the harness was given on the new side, by staff id. */
  newTokens(): ReadonlyMap<string, string>;
  /**
   * POST /rpc/<rpc> through the real router, on this pair's clock and database.
   * `outbound` is what ctx.fetch records and answers from; without it, any outbound request reaches the guard.
   */
  callNew(handlers: RpcHandlers, rpc: string, args: readonly unknown[], outbound?: Outbound): Promise<NewCall>;
  /**
   * A module function with no RPC, called inside a transaction with what a handler would be
   * given (settings, env, fetch, db, now), as the router would. A throw is the outcome's message.
   */
  callNewDirect(fn: DirectFn, args: readonly unknown[], outbound?: Outbound): Promise<NewCall>;
  /** The secret both sides hold (SECRETS_RULE in http.ts): the old config tab's whatsapp_api_token, or null when blank. */
  mirroredToken(): string | null;
  /** Every row of a table on the new side. */
  newRows(table: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

// ── Databases ──────────────────────────────────────────────

const quoteIdent = (name: string): string => {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe database name: ${name}`);
  return `"${name}"`;
};

function urlFor(db: string, user?: string, password?: string): string {
  const u = new URL(superuserUrl());
  u.pathname = `/${encodeURIComponent(db)}`;
  if (user !== undefined) u.username = user;
  if (password !== undefined) u.password = password;
  return u.toString();
}

async function asSuperuser<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: superuserUrl() });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function copyDatabase(template: string): Promise<string> {
  const name = `ops_p_${randomBytes(6).toString("hex")}`;
  await asSuperuser(async (c) => {
    for (let attempt = 0; ; attempt++) {
      try {
        await c.query(`create database ${quoteIdent(name)} template ${quoteIdent(template)}`);
        return;
      } catch (err) {
        if ((err as { code?: string }).code === "55006" && attempt < 50) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        throw err;
      }
    }
  });
  return name;
}

const dropDatabase = (name: string): Promise<unknown> => asSuperuser((c) => c.query(`drop database if exists ${quoteIdent(name)} with (force)`));

/** A fingerprint of every tab: header and rows (a Date as its instant). */
function fingerprint(tabs: readonly SheetTab[]): string {
  return createHash("sha256").update(JSON.stringify(tabs)).digest("hex");
}

interface Template {
  name: string;
  loadRejects: number;
}
const templates = new Map<string, Promise<Template>>();

/**
 * Load `old`'s sheets into a new database, give every fixture person with a
 * login code that code as their PIN, and leave the database closed so it can be
 * copied. setPin writes a `staff.pin_set` audit row per person; the old app has
 * no such step and no such rows, so they are removed (as the owner role): the
 * harness's own setup must not make audit_log differ.
 */
async function buildTemplate(old: OldWorld, tabs: SheetTab[]): Promise<Template> {
  const db = await createTestDb();
  const loaded = await loadFixture(db, { api: old.api, tabs });
  const app = await connect(db.appUrl);
  let pins = 0;
  try {
    for (const p of old.people()) {
      if (p.code === "") continue;
      await setPin(app, p.staffId, p.code, PARITY_PEPPER);
      pins++;
    }
  } finally {
    await app.close();
  }
  const owner = await connect(db.ownerUrl);
  try {
    const gone = await owner.query("delete from ops.audit_log where action = 'staff.pin_set' returning log_id");
    if (gone.length !== pins) throw new Error(`harness: expected ${pins} staff.pin_set audit rows to remove, found ${gone.length}`);
  } finally {
    await owner.close();
  }
  return { name: db.name, loadRejects: loaded.rejects.length };
}

/** Drop every template this process made. */
export async function dropTemplates(): Promise<void> {
  const all = [...templates.values()];
  templates.clear();
  for (const t of all) {
    const tpl = await t.catch(() => null);
    if (tpl) await dropDatabase(tpl.name);
  }
}

// ── Settings ───────────────────────────────────────────────

/**
 * Set each key on both sides: the old `config` tab's row and the new `config` table's row
 * (the same text; a blank is a blank cell on one side and NULL on the other, as the import
 * translates it). A secret goes to the old tab only: the table can never hold one, and the
 * new side reads it from a binding the harness mirrors from that tab on every call.
 * The new side is written as the database's owner: this is the harness's own setup.
 */
async function applySettings(old: OldWorld, dbName: string, settings: Readonly<Record<string, string>>): Promise<void> {
  const entries = Object.entries(settings);
  for (const [key, value] of entries) old.setConfig(key, value);
  const rows = entries.filter(([key]) => configKeySpec(key)?.kind !== "secret");
  if (rows.length === 0) return;
  const db = await connect(urlFor(dbName));
  try {
    for (const [key, value] of rows) {
      await db.query(
        "insert into ops.config (key, value, description) values ($1, $2, 'parity settings') on conflict (key) do update set value = excluded.value",
        [key, value === "" ? null : value],
      );
    }
  } finally {
    await db.close();
  }
}

// ── A pair ─────────────────────────────────────────────────

/** Milliseconds each fresh pair took to make, for the report. */
export const pairTimings: number[] = [];

export async function createWorlds(options: WorldOptions = {}): Promise<Worlds> {
  const started = performance.now();
  const startAt = options.startAt ?? CASE_START_AT;
  const bootAt = options.bootAt ?? FIXTURE_BOOT_AT;
  const clock = new FrozenClock(startAt);
  const old = OldWorld.boot(clock, bootAt);
  const tabs = old.tabNames().map((n) => old.tab(n));
  const key = `${bootAt.toISOString()} ${fingerprint(tabs)}`;
  let tpl = templates.get(key);
  if (tpl === undefined) {
    tpl = buildTemplate(old, tabs);
    templates.set(key, tpl);
  }
  const template = await tpl;
  const dbName = await copyDatabase(template.name);
  const appUrl = urlFor(dbName, "ops_app", TEST_PASSWORDS.app);
  const baseIds = { old: snapshotOld(old).ids, new: (await snapshotNew(appUrl)).ids };
  // After the template is chosen (a setting must not change which template a pair copies) and
  // before anything is fingerprinted by a case, so a setting is part of the pair, not a change a case made.
  if (options.settings) await applySettings(old, dbName, options.settings);
  pairTimings.push(performance.now() - started);

  const newTokens = new Map<string, string>();

  /** See SECRETS_RULE (http.ts): the one place the new side's secret comes from. */
  const mirroredToken = (): string | null => {
    const v = old.configValue("whatsapp_api_token");
    return v === null || v === "" ? null : v;
  };
  const newEnv = (): Record<string, unknown> => {
    const token = mirroredToken();
    return { PIN_PEPPER: PARITY_PEPPER, ...(token !== null ? { WHATSAPP_API_TOKEN: token } : {}) };
  };

  /** Run `fn` with the real global fetch replaced by the guard (a handler that uses it instead of ctx.fetch is caught). */
  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    const real = globalThis.fetch;
    globalThis.fetch = guardedFetch;
    try {
      return await fn();
    } finally {
      globalThis.fetch = real;
    }
  }

  async function callNewDirect(fn: DirectFn, args: readonly unknown[], outbound?: Outbound): Promise<NewCall> {
    const conn = await connect(appUrl);
    try {
      const value = await guarded(() =>
        withTransaction(conn, async (tx) => {
          const config = await loadConfig(tx);
          return fn({ config, env: newEnv(), fetch: outbound ? outbound.newFetch : guardedFetch, db: tx, now: clock.now() }, ...args);
        }),
      );
      const text = JSON.stringify(value === undefined ? null : value);
      return { outcome: { kind: "ok", value: JSON.parse(text) as unknown }, faults: [] };
    } catch (err) {
      return { outcome: { kind: "error", message: err instanceof Error ? err.message : String(err) }, faults: [] };
    } finally {
      await conn.close().catch(() => undefined);
    }
  }

  async function callNew(handlers: RpcHandlers, rpc: string, args: readonly unknown[], outbound?: Outbound): Promise<NewCall> {
    const faults: object[] = [];
    const router = createRpcRouter({
      contract,
      handlers,
      openDb: () => connect(appUrl),
      resolveSession,
      env: newEnv(),
      fetch: outbound ? outbound.newFetch : guardedFetch,
      now: () => clock.now(),
      log: (e) => faults.push(e),
    });
    const res = await guarded(() =>
      router(new Request(`https://parity.test/rpc/${rpc}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ args }) })),
    );
    const body = (await res.json()) as { ok?: boolean; result?: unknown; error?: { message?: unknown } };
    if (res.status === 501 && body.error?.message === "NOT_PORTED") return { outcome: { kind: "not_ported" }, faults };
    if (body.ok === true) return { outcome: { kind: "ok", value: body.result ?? null }, faults };
    return { outcome: { kind: "error", message: String(body.error?.message ?? `HTTP ${res.status}`) }, faults };
  }

  return {
    clock,
    old,
    startAt,
    appUrl,
    loadRejects: template.loadRejects,
    baseIds,
    async signIn(who) {
      const person = old.person(who);
      const oldToken = old.signIn(person);
      let newToken = newTokens.get(person.staffId);
      if (newToken === undefined) {
        // Always the real rpcLogin: the harness's own sign-in is not the thing under test.
        const login = registryHandlers["rpcLogin"];
        if (!login) throw new Error("harness: the registry has no rpcLogin to sign callers in with");
        const r = await callNew({ rpcLogin: login }, "rpcLogin", [person.name, person.code]);
        const token = r.outcome.kind === "ok" ? (r.outcome.value as { token?: unknown } | null)?.token : undefined;
        if (typeof token !== "string") throw new Error(`harness: the new side would not sign in ${person.staffId}: ${JSON.stringify(r)}`);
        newToken = token;
        newTokens.set(person.staffId, newToken);
      }
      return { person, old: oldToken, new: newToken };
    },
    newTokens: () => newTokens,
    callNew,
    callNewDirect,
    mirroredToken,
    async newRows(table) {
      if (!/^[a-z_]+$/.test(table)) throw new Error(`unsafe table name: ${table}`);
      const db = await connect(appUrl);
      try {
        return await db.query<Record<string, unknown>>(`select * from ops."${table}"`);
      } finally {
        await db.close();
      }
    },
    close: () => dropDatabase(dbName).then(() => undefined),
  };
}
